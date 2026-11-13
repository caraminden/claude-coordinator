// GitHub artifact sweep (#657): the Actions artifact quota is per account, and Peek's CI alone filled the whole
// of Cara's (6.6 GB, 1,452 artifacts, all kept the 90-day default). Once a week, for every scheme's repo, whoever
// owns it (the scheme owner's linked GitHub does the asking, as CI health does), keep the newest KEEP artifacts of each
// kind and delete older ones that are also past MIN_AGE_MS. "Kind" is the artifact's name without its commit hash or
// run number (`overlay-shots-<sha>` is `overlay-shots`), so the latest build of each target always survives. Repo
// settings can't do this: the retention endpoint answers 404 on personal repos (#657's report).
// Josh, 2026-11-13: "we need the system to work without manual work and for repos not owned by cara".
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Project, Store } from './db.ts';
import { ghGet, type GhGet } from './ci-health.ts';
import { repoSlug } from './prlinks.ts';
import { asEnv, type GithubEnv } from './scheme-repo.ts';

const run = promisify(execFile);

export const KEEP = 3;
/** Younger than this is never deleted, so a burst of landings can't evict an artifact a run is still about to read. */
export const MIN_AGE_MS = 2 * 24 * 3600_000;
export const SWEEP_EVERY_MS = 7 * 24 * 3600_000;
/** The most one repo loses in a round: a rule gone wrong stops at this, and the next week continues. */
export const MAX_DELETES = 2000;
const LAST = 'artifact-sweep:last';

export interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  created_at: string;
  expired?: boolean;
}

/** `overlay-shots-<40 hex>` → `overlay-shots`; `desktop-1794352990-2430038` → `desktop`; `stress-logs-4310617` → `stress-logs`. */
export function kindOf(name: string): string {
  return name.replace(/-[0-9a-f]{40}.*$/, '').replace(/(-\d+)+$/, '') || name;
}

/** The artifacts to delete: all but the newest `keep` of each kind, and only those older than `minAge`. */
export function plan(all: Artifact[], now: number, keep = KEEP, minAge = MIN_AGE_MS): Artifact[] {
  const kinds = new Map<string, Artifact[]>();
  for (const a of all) {
    if (a.expired) continue;
    const k = kindOf(a.name);
    kinds.set(k, [...(kinds.get(k) ?? []), a]);
  }
  const out: Artifact[] = [];
  for (const list of kinds.values()) {
    list.sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at));
    for (const a of list.slice(keep)) if (now - Date.parse(a.created_at) >= minAge) out.push(a);
  }
  return out;
}

/** One REST DELETE through the gh CLI; the status of the answer, 0 when gh printed none. */
export async function ghDelete(path: string, as: GithubEnv): Promise<{ status: number }> {
  try {
    const { stdout } = await run('gh', ['api', '-i', '-X', 'DELETE', path], { env: asEnv(as), timeout: 30_000 });
    return { status: Number(/^HTTP\/\S+ (\d+)/.exec(stdout)?.[1] ?? 0) };
  } catch (err: any) {
    const out = typeof err?.stdout === 'string' ? err.stdout : '';
    if (!/^HTTP\/\S+ \d+/.test(out)) throw err;
    return { status: Number(/^HTTP\/\S+ (\d+)/.exec(out)![1]) };
  }
}

export interface SweepDeps {
  as: (project: Project) => GithubEnv;
  get?: GhGet;
  del?: (path: string, as: GithubEnv) => Promise<{ status: number }>;
  log?: (line: string) => void;
}

export interface SweepResult {
  repo: string;
  deleted: number;
  bytes: number;
  failed: number;
  error?: string;
}

export class ArtifactSweep {
  private store: Store;
  private deps: SweepDeps;
  private busy = false;

  constructor(store: Store, deps: SweepDeps) {
    this.store = store;
    this.deps = deps;
  }

  /** Called every hour by the timer in server.ts; the round itself runs once a week, the first a week after the setting's first read. */
  async tick(now = Date.now()): Promise<SweepResult[] | null> {
    const last = this.store.getSetting<number>(LAST);
    if (last == null) {
      this.store.setSetting(LAST, now);
      return null;
    }
    if (now - last < SWEEP_EVERY_MS) return null;
    this.store.setSetting(LAST, now);
    return this.sweepAll(now);
  }

  async sweepAll(now = Date.now()): Promise<SweepResult[]> {
    if (this.busy) return [];
    this.busy = true;
    const results: SweepResult[] = [];
    try {
      const seen = new Set<string>();
      for (const p of this.store.listProjects()) {
        const slug = repoSlug(p.repo_url);
        if (!slug || seen.has(slug.toLowerCase())) continue;
        seen.add(slug.toLowerCase());
        results.push(await this.sweepRepo(p, slug, now));
      }
    } finally {
      this.busy = false;
    }
    const total = results.reduce((s, r) => s + r.bytes, 0);
    this.deps.log?.(`Artifact sweep: ${results.map((r) => `${r.repo} ${r.deleted}${r.failed ? ` (+${r.failed} failed)` : ''}${r.error ? ` (${r.error})` : ''}`).join(', ') || 'no repos'}; ${(total / 1048576).toFixed(0)} MB freed`);
    return results;
  }

  async sweepRepo(p: Project, slug: string, now: number): Promise<SweepResult> {
    const res: SweepResult = { repo: slug, deleted: 0, bytes: 0, failed: 0 };
    const as = this.deps.as(p);
    const get = this.deps.get ?? ghGet;
    const del = this.deps.del ?? ghDelete;
    try {
      const all: Artifact[] = [];
      for (let page = 1; page <= 50; page++) {
        const a = await get(`repos/${slug}/actions/artifacts?per_page=100&page=${page}`, null, as);
        if (a.status !== 200) {
          // 403/404: no Actions access for this login; nothing to sweep, not a failure to shout about.
          if (page === 1) return { ...res, error: `GitHub answered ${a.status}` };
          break;
        }
        const batch: Artifact[] = a.body?.artifacts ?? [];
        all.push(...batch);
        if (batch.length < 100) break;
      }
      for (const a of plan(all, now).slice(0, MAX_DELETES)) {
        const r = await del(`repos/${slug}/actions/artifacts/${a.id}`, as);
        if (r.status === 204 || r.status === 404) {
          res.deleted++;
          res.bytes += a.size_in_bytes;
        } else res.failed++;
      }
    } catch (err: any) {
      res.error = String(err?.message ?? err).slice(0, 120);
    }
    return res;
  }
}
