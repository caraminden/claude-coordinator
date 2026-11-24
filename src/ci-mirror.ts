// Mirrors a shipped run's GitHub artifact into Citadel's CI store (#673; Cara, 2026-11-14: "Can we just fix the releases
// so everything is on perigee?"), for schemes whose workflows still upload only to GitHub: the Releases page then links
// a file on perigee that every member can open, where a GitHub link would need access to the repo.
import { execFile } from 'node:child_process';
import { mkdir, readdir, rename, statfs } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { Run } from './ci-health.ts';
import type { CiStore, Kind } from './ci-store.ts';
import type { Project } from './db.ts';
import type { Artifact } from './release-readers.ts';
import { asEnv, type GithubEnv } from './scheme-repo.ts';

const exec = promisify(execFile);

/** A failed mirror is tried again after this long, not on every refresh. */
const RETRY_MS = 60 * 60_000;
/** Free disk a download needs, in times the artifact's zipped size: it is unpacked before the store sees its real size. */
// shortcut: a guess at how far a build unpacks, not a bound on it; stream the zip with a byte limit if one ever fills the disk.
const ROOM = 10;

export interface Want {
  project: Project;
  slug: string;
  run: Run;
  artifact: Artifact;
  /** The workflow's file name, "windows.yml", as the store files it. */
  workflow: string;
  kind: Kind;
  target: string;
  /** Told once the file is in the store. */
  done: () => void;
}

/** Writes the artifact's files, unpacked, into `dir`. */
export type Download = (w: Want, dir: string) => Promise<void>;

/** `gh run download` of one artifact, as the scheme's linked GitHub login: the access the release monitor reads runs with. */
export const ghDownload = (as: (p: Project) => GithubEnv): Download => async (w, dir) => {
  await exec('gh', ['run', 'download', String(w.run.id), '--repo', w.slug, '--name', w.artifact.name, '--dir', dir], { env: asEnv(as(w.project)), timeout: 30 * 60_000 });
};

/** A name the store takes (ci-store.ts NAME): runs of anything else become a dash. */
export const storeName = (s: string, max = 150) => s.replace(/[^A-Za-z0-9._+-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, max) || 'artifact';

export class CiMirror {
  private ci: Pick<CiStore, 'refusal' | 'fetched' | 'dir'>;
  private download: Download;
  private now: () => number;
  /** One download at a time, behind the poll rather than in it. */
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = new Set<string>();
  private failed = new Map<string, number>();
  /** Artifacts already kept: never downloaded again, even once the store has swept them (until a restart). */
  private kept = new Set<string>();

  constructor(ci: Pick<CiStore, 'refusal' | 'fetched' | 'dir'>, download: Download, now: () => number = Date.now) {
    this.ci = ci;
    this.download = download;
    this.now = now;
  }

  /** Mirror an artifact, behind any already queued, unless it is queued now or failed within RETRY_MS. Returns at once. */
  want(w: Want): void {
    const key = `${w.project.id}:${w.run.id}:${w.artifact.id}`;
    if (this.waiting.has(key) || this.kept.has(key) || this.now() - (this.failed.get(key) ?? -Infinity) < RETRY_MS) return;
    this.waiting.add(key);
    this.queue = this.queue
      .then(() => this.mirror(w))
      .catch((err: any) => {
        console.warn(`CI mirror: ${what(w)} failed: ${(err?.stderr || err?.message || String(err)).toString().trim().slice(0, 300)}`);
        return false;
      })
      .then((ok) => {
        if (!ok) return void this.failed.set(key, this.now());
        this.kept.add(key);
        w.done();
      })
      .finally(() => this.waiting.delete(key));
  }

  /** Every queued mirror ended (tests). */
  idle(): Promise<unknown> {
    return this.queue;
  }

  private async mirror(w: Want): Promise<boolean> {
    const run = { project_id: w.project.id, workflow: w.workflow, run_id: w.run.id, run_attempt: w.run.run_attempt ?? 1 };
    // Filed at the run's own time, so the store's rules see the runs in the order they ran, not the order mirrored.
    const meta = { kind: w.kind, target: w.target, sha: w.run.head_sha, ref: `refs/heads/${w.run.head_branch}`, created_at: Date.parse(w.run.updated_at ?? w.run.created_at) || this.now() };
    const size = w.artifact.size_in_bytes ?? 0;
    const no = this.ci.refusal(run, { ...meta, size });
    if (no) {
      console.warn(`CI mirror: not mirroring ${what(w)} (${w.artifact.size_in_bytes ?? '?'} bytes): ${no}`);
      return false;
    }
    const dir = this.ci.dir(w.project.id);
    await mkdir(dir, { recursive: true });
    const disk = await statfs(dir);
    if (disk.bavail * disk.bsize < ROOM * size) {
      console.warn(`CI mirror: not mirroring ${what(w)} (${size} bytes): the disk has ${disk.bavail * disk.bsize} bytes free, under ${ROOM} times its size`);
      return false;
    }
    const row = await this.ci.fetched(run, meta, async (dir) => {
      const into = join(dir, '.a'); // no store name starts with a dot, so the kept file can't collide with it
      await this.download(w, into);
      const files = (await readdir(into, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
      if (!files.length) throw new Error('it held no files');
      // One file is kept as itself (an APK, an installer); several as one .tar.gz, as ci-upload.sh sends a folder.
      if (files.length === 1) {
        const file = join(dir, storeName(files[0].name));
        await rename(join(files[0].parentPath, files[0].name), file);
        return file;
      }
      const file = join(dir, `${storeName(w.artifact.name, 143)}.tar.gz`);
      await exec('tar', ['-czf', file, '-C', into, '.'], { timeout: 30 * 60_000 });
      return file;
    });
    if (typeof row === 'string') {
      console.warn(`CI mirror: not keeping ${what(w)} once downloaded: ${row}`);
      return false;
    }
    console.log(`CI mirror: kept ${what(w)} as ${basename(row.name)} (${row.size} bytes)`);
    return true;
  }
}

const what = (w: Want) => `${w.slug} run ${w.run.id}'s artifact ${w.artifact.name}`;
