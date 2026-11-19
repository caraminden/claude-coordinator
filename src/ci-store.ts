// Citadel's own store for CI output (#658; Josh, 2026-11-13: "why are we using githubs artifact stores? can we just
// store artifacts ourselves? either way we should definitely have a cleanup automation"). A job on a scheme's runner
// PUTs a file to the machines listener over the tailnet; the file lands under the scheme's own folder
// (<data dir>/projects/<scheme id>/ci-store/, which a person's container mounts, so every turn can read it) with a
// ci_files row, minions and members read it by URL or as "the latest of kind X for workflow Y", and a sweep keeps it
// bounded ("keeping relevant artifacts in our own database, but also not letting it balloon forever").
//
// Who may upload: the job proves its repo with GitHub's own run token (OIDC), which GitHub signs for each job and
// which names the repo, run, attempt, commit and workflow (Josh's pick, 2026-11-13: "GitHub's run token (no secret)",
// after "we need the system to work without manual work and for repos not owned by cara"). Nothing is made, stored
// or rotated here, and a job can only write to the scheme whose repo it runs in, under its own run.
import { createHash, createPublicKey, verify, randomBytes, type JsonWebKey } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { finished } from 'node:stream/promises';
import { basename, dirname, join } from 'node:path';
import type { CiFile, Project, Store } from './db.ts';
import { HttpError } from './http.ts';
import { repoSlug } from './prlinks.ts';
import { projectDir } from './workspace.ts';

export const KINDS = ['build', 'report', 'release'] as const;
export type Kind = (typeof KINDS)[number];

const DAY = 24 * 60 * 60_000;
const GIB = 1024 ** 3;
/** The starting numbers (the plan Josh approved, 2026-11-13). */
export const RULES = {
  /** Builds: the newest runs kept per workflow and target. */
  buildRuns: 5,
  /** Reports: deleted once this old. */
  reportMs: 7 * DAY,
  /** Releases: the newest runs kept per workflow and target, and any younger than releaseMs. */
  releaseRuns: 10,
  releaseMs: 180 * DAY,
  /** One file, one scheme's files, and every scheme's together. */
  fileBytes: 2 * GIB,
  schemeBytes: 20 * GIB,
  totalBytes: 60 * GIB,
};
export type Rules = typeof RULES;

export const ISSUER = 'https://token.actions.githubusercontent.com';
export const AUDIENCE = 'citadel-ci-store';
/** A file's, target's or workflow file's name: no slash, no leading dot, nothing a shell or a path could misread. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,149}$/;
const KEYS_MS = 60 * 60_000;
const KEYS_RETRY_MS = 60_000;
/** After a failed read: soon enough that the uploader's next try (30 s later, on the 503) gets a fresh one. */
const KEYS_FAILED_RETRY_MS = 5_000;
const CLOCK_SKEW_S = 60;

/** What a run token says about the job that holds it. */
export interface RunClaims {
  /** owner/name. */
  repository: string;
  /** The workflow's file name ("android.yml"), from workflow_ref: what release targets call a workflow. */
  workflow: string;
  runId: number;
  runAttempt: number;
  sha: string;
  ref: string;
}

type Jwk = JsonWebKey & { kid?: string };

/** Checks GitHub's run tokens against GitHub's published keys, fetched at most hourly (and once more for a key id it hasn't seen). */
export class RunTokens {
  private keys = new Map<string, Jwk>();
  private fetched = 0;
  /** Why the last read of the keys failed; '' once one worked. */
  private failed = '';
  private reading: Promise<void> | null = null;
  private fetchKeys: () => Promise<Jwk[]>;
  private now: () => number;

  constructor(fetchKeys: () => Promise<Jwk[]> = githubKeys, now: () => number = Date.now) {
    this.fetchKeys = fetchKeys;
    this.now = now;
  }

  private async key(kid: string): Promise<Jwk | undefined> {
    const age = this.now() - this.fetched;
    if (!this.reading && (age > KEYS_MS || (!this.keys.has(kid) && age > (this.failed ? KEYS_FAILED_RETRY_MS : KEYS_RETRY_MS)))) {
      this.fetched = this.now();
      this.reading = this.fetchKeys()
        .then((keys) => {
          const got = new Map(keys.filter((k) => k.kid && k.kty === 'RSA').map((k) => [k.kid!, k]));
          if (!got.size) throw new Error('GitHub listed no keys');
          this.keys = got;
          this.failed = '';
        })
        // The keys held still verify; a token none of them signed gets a 503 naming this, not a 401 blaming the token.
        .catch((err: any) => {
          this.failed = String(err?.message ?? err);
          console.warn(`CI store: reading GitHub's signing keys failed: ${this.failed}`);
        })
        .finally(() => (this.reading = null));
    }
    // Uploads that arrive while the keys are being read wait for that read, not refused for a key not yet here.
    await this.reading;
    return this.keys.get(kid);
  }

  /** The claims of a run token GitHub signed for this store and that hasn't run out; throws a 401 otherwise. */
  async check(token: string): Promise<RunClaims> {
    const bad = (why: string) => new HttpError(401, `Not a GitHub run token for this store (${why}). The job needs \`permissions: id-token: write\` and a token asked for with audience ${AUDIENCE}`);
    const parts = token.split('.');
    if (parts.length !== 3) throw bad('not a JWT');
    let head: any, claims: any;
    try {
      head = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch {
      throw bad('not a JWT');
    }
    // RS256 only, whatever the token's own header asks for: the header never picks the algorithm.
    if (head?.alg !== 'RS256' || typeof head.kid !== 'string') throw bad('not signed the way GitHub signs');
    const jwk = await this.key(head.kid);
    if (!jwk && this.failed) throw new HttpError(503, `Citadel couldn't read GitHub's signing keys (${this.failed}), so it couldn't check the run token; try again in a minute`);
    if (!jwk) throw bad('signed with a key GitHub doesn\'t list');
    let ok = false;
    try {
      ok = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    } catch {}
    if (!ok) throw bad('the signature doesn\'t match');
    const now = this.now() / 1000;
    if (claims?.iss !== ISSUER) throw bad('not issued by GitHub Actions');
    if (claims.aud !== AUDIENCE) throw bad('asked for with another audience');
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) throw bad('it has run out');
    if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > now) throw bad('not valid yet');
    const workflow = /\/\.github\/workflows\/([^/@]+)@/.exec(String(claims.workflow_ref ?? ''))?.[1] ?? '';
    const runId = Number(claims.run_id);
    const runAttempt = Number(claims.run_attempt);
    if (typeof claims.repository !== 'string' || !NAME.test(workflow) || !Number.isSafeInteger(runId) || runId <= 0 || !Number.isSafeInteger(runAttempt) || runAttempt <= 0 || !/^[0-9a-f]{40,64}$/.test(String(claims.sha))) {
      throw bad('it names no repo, workflow file, run or commit');
    }
    return { repository: claims.repository, workflow, runId, runAttempt, sha: claims.sha, ref: String(claims.ref ?? '').slice(0, 300) };
  }
}

async function githubKeys(): Promise<Jwk[]> {
  // CITADEL_CI_STORE_KEYS: a test server's stand-in for GitHub's key list; never set on the live service.
  const r = await fetch(process.env.CITADEL_CI_STORE_KEYS || `${ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json', 'User-Agent': 'Citadel' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { keys?: Jwk[] }).keys ?? [];
}

type Row = Pick<CiFile, 'id' | 'project_id' | 'workflow' | 'run_id' | 'kind' | 'target' | 'size' | 'created_at' | 'published_to' | 'published_at'>;

/**
 * The files the rules delete, as ids, from every scheme's rows. Never: the file a feed was last published from (the
 * newest published row per scheme and place), nor the newest run's builds and releases of each workflow and target.
 * By rule: reports past reportMs, builds beyond the newest buildRuns runs, releases beyond the newest releaseRuns runs
 * and older than releaseMs. Then, for a scheme over schemeBytes and for all over totalBytes, the oldest unprotected
 * files go first: reports, then builds, then releases. `keep` ("<project id>/<run id>"): runs kept whatever the rules
 * say, a CI package's last green build and the one a roll back holds it at (ADR 0012).
 */
export function sweepPlan(rows: Row[], now: number, rules: Rules = RULES, keep: Set<string> = new Set()): number[] {
  const protect = new Set<number>();
  for (const r of rows) if (r.kind !== 'report' && keep.has(`${r.project_id}/${r.run_id}`)) protect.add(r.id);
  const gone = new Set<number>();
  // The newest published file per scheme and place is what that feed links to now.
  const live = new Map<string, Row>();
  for (const r of rows) {
    if (!r.published_to) continue;
    const k = `${r.project_id}\0${r.published_to}`;
    const was = live.get(k);
    if (!was || (r.published_at ?? 0) > (was.published_at ?? 0)) live.set(k, r);
  }
  for (const r of live.values()) protect.add(r.id);

  // Runs, newest first, per scheme, workflow, kind and target: a run is as new as its newest file.
  const groups = new Map<string, Map<number, Row[]>>();
  for (const r of rows) {
    if (r.kind === 'report') {
      if (now - r.created_at > rules.reportMs) gone.add(r.id);
      continue;
    }
    const k = `${r.project_id}\0${r.workflow}\0${r.kind}\0${r.target}`;
    let runs = groups.get(k);
    if (!runs) groups.set(k, (runs = new Map()));
    runs.set(r.run_id, [...(runs.get(r.run_id) ?? []), r]);
  }
  for (const runs of groups.values()) {
    const newest = [...runs.values()].sort((a, b) => Math.max(...b.map((r) => r.created_at)) - Math.max(...a.map((r) => r.created_at)));
    newest.forEach((files, i) => {
      for (const r of files) {
        if (i === 0) protect.add(r.id);
        else if (r.kind === 'build' ? i >= rules.buildRuns : i >= rules.releaseRuns && now - r.created_at > rules.releaseMs) gone.add(r.id);
      }
    });
  }
  for (const id of protect) gone.delete(id);

  // The caps: the oldest unprotected first, reports before builds before releases.
  const order = (r: Row) => (r.kind === 'report' ? 0 : r.kind === 'build' ? 1 : 2);
  const spare = rows.filter((r) => !protect.has(r.id) && !gone.has(r.id)).sort((a, b) => order(a) - order(b) || a.created_at - b.created_at || a.id - b.id);
  const used = new Map<number, number>();
  let total = 0;
  for (const r of rows) {
    if (gone.has(r.id)) continue;
    used.set(r.project_id, (used.get(r.project_id) ?? 0) + r.size);
    total += r.size;
  }
  const drop = (r: Row) => {
    gone.add(r.id);
    used.set(r.project_id, used.get(r.project_id)! - r.size);
    total -= r.size;
  };
  for (const r of spare) if (used.get(r.project_id)! > rules.schemeBytes) drop(r);
  for (const r of spare) if (total > rules.totalBytes && !gone.has(r.id)) drop(r);
  return [...gone];
}

/** Where a file goes: its scheme, run and name. */
type Key = Pick<CiFile, 'project_id' | 'workflow' | 'run_id' | 'run_attempt' | 'name'>;
/** What its row says about it besides where it is. */
type Meta = Pick<CiFile, 'sha' | 'ref' | 'kind' | 'target' | 'size' | 'sha256'>;

export interface Upload {
  name: string;
  kind: Kind;
  target: string;
}

/** A file on disk with no row, or a part file, is an upload cut off by a restart once it is this old. */
const STRAY_MS = 60 * 60_000;

export class CiStore {
  private store: Store;
  private dataDir: string;
  private tokens: RunTokens;
  rules: Rules;
  /** Runs kept whatever the rules say (sweepPlan's `keep`): server.ts sets it to the CI packages' last green and pinned builds. */
  keep: () => Set<string> = () => new Set();
  /** Told when a scheme's upload is refused for room, at most once a day per scheme: a note for its Taskmaster's chat. */
  onFull: (project: Project, words: string) => void = () => {};
  private toldFull = new Map<number, number>();
  /** Bytes of the uploads streaming in now, as they declared: what the caps can't see yet. */
  private incoming = 0;
  /** One change to the store at a time (an upload's commit, a sweep): each plans from rows the other may change. */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(store: Store, dataDir: string, tokens = new RunTokens(), rules: Rules = RULES) {
    this.store = store;
    this.dataDir = dataDir;
    this.tokens = tokens;
    this.rules = rules;
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.catch(() => {});
    return run;
  }

  /** A scheme's files: in its own folder, which its minions' turns can read wherever they run (a person's container mounts projects/). */
  dir(projectId: number): string {
    return join(projectDir(this.dataDir, projectId), 'ci-store');
  }

  /** Where a row's file is. Every part is a checked name or a number, so it can't climb out of the store. */
  path(f: Pick<CiFile, 'project_id' | 'workflow' | 'run_id' | 'run_attempt' | 'name'>): string {
    return join(this.dir(f.project_id), f.workflow, `${f.run_id}-${f.run_attempt}`, f.name);
  }

  /**
   * A row's file as it really is, or null when it is gone. Turns can write a scheme's folder, so before the server
   * reads or deletes there it checks the file is a plain one reached through no symlink; anything else throws.
   */
  async plain(f: CiFile): Promise<string | null> {
    const file = this.path(f);
    let real: string;
    try {
      real = await realpath(file);
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
    const root = await realpath(this.dir(f.project_id));
    if (real !== join(root, file.slice(this.dir(f.project_id).length)) || !(await lstat(real)).isFile()) throw new Error(`${file} is not a plain file in the CI store`);
    return real;
  }

  /** The scheme a run token's repo belongs to; 403 when no scheme has that repo. */
  private schemeOf(claims: RunClaims): Project {
    const repo = claims.repository.toLowerCase();
    const project = this.store.listProjects().find((p) => repoSlug(p.repo_url)?.toLowerCase() === repo);
    if (!project) throw new HttpError(403, `No scheme has the repo ${claims.repository}`);
    return project;
  }

  /**
   * Take one upload: check the job's run token, stream the body to a part file (never into memory) with its sha256,
   * then, with the store locked, plan the rules with the new file in: if it fits, it replaces the same run's file of
   * that name and what the rules give up for it is deleted; if it doesn't, 507 and nothing else is touched.
   */
  async upload(req: IncomingMessage, u: Upload): Promise<CiFile> {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw new HttpError(401, 'Send the job\'s GitHub run token as Authorization: Bearer');
    const claims = await this.tokens.check(token);
    const project = this.schemeOf(claims);
    const declared = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(declared) || declared <= 0) throw new HttpError(411, 'Send the file with its Content-Length; an empty upload is refused');
    const tooBig = () => new HttpError(413, `A file in the CI store is limited to ${gib(this.rules.fileBytes)}`);
    if (declared > this.rules.fileBytes) throw tooBig();
    // What streams in is on disk before the caps see it: bound it, so jobs uploading together can't fill the disk.
    if (this.incoming + declared > 2 * this.rules.fileBytes) throw new HttpError(503, 'The CI store is taking other uploads; try again in a minute');

    const key = { project_id: project.id, workflow: claims.workflow, run_id: claims.runId, run_attempt: claims.runAttempt, name: u.name };
    const file = this.path(key);
    const part = join(dirname(file), `.${randomBytes(6).toString('hex')}.part`);
    this.incoming += declared;
    try {
      await mkdir(dirname(file), { recursive: true });
      const hash = createHash('sha256');
      let size = 0;
      const out = createWriteStream(part, { flags: 'wx' });
      await new Promise<void>((resolve, reject) => {
        out.on('error', reject);
        req.on('error', reject);
        req.on('aborted', () => reject(new HttpError(400, 'The upload stopped part-way')));
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > declared) return reject(new HttpError(400, 'The upload is longer than its Content-Length'));
          hash.update(chunk);
          if (!out.write(chunk)) {
            req.pause();
            out.once('drain', () => req.resume());
          }
        });
        req.on('end', () => out.end(resolve));
      }).catch(async (err) => {
        out.destroy();
        // A refusal can come before the part file's open has finished: wait for it to close, or the rm below runs
        // first and the open then makes a part file nothing removes until the hourly stray sweep (#691).
        await finished(out).catch(() => {});
        throw err;
      });
      if (declared !== size) throw new HttpError(400, 'The upload stopped part-way');

      const row = await this.commit(key, part, { sha: claims.sha, ref: claims.ref, kind: u.kind, target: u.target, size, sha256: hash.digest('hex') });
      if (row) return row;
      const words = `The CI store refused ${u.name} from ${claims.workflow}: ${project.name}'s files are at its ${gib(this.rules.schemeBytes)} limit (or all schemes' at ${gib(this.rules.totalBytes)}), and what is left is each target's newest build or release and published releases.`;
      const now = Date.now();
      if (now - (this.toldFull.get(project.id) ?? 0) > DAY) {
        this.toldFull.set(project.id, now);
        this.onFull(project, words);
      }
      throw new HttpError(507, words);
    } finally {
      this.incoming -= declared;
      await rm(part, { force: true });
      await rmdir(dirname(file)).catch(() => {}); // only when this upload made it and left it empty
    }
  }

  /**
   * The rules planned with a file of `meta.size` at `key` in: the rows they give up for it, or null when it doesn't fit
   * (too big, dropped by the rules, or over a cap). With `evict` false it only fits in spare room: null if any other
   * file would go for it.
   */
  private plan(rows: CiFile[], key: Key, meta: { kind: string; target: string; size: number; created_at: number }, evict: boolean): { was?: CiFile; gone: Set<number> } | null {
    if (meta.size > this.rules.fileBytes) return null;
    const was = rows.find((r) => r.project_id === key.project_id && r.workflow === key.workflow && r.run_id === key.run_id && r.run_attempt === key.run_attempt && r.name === key.name);
    const mine = { ...key, ...meta, id: was?.id ?? -1, published_to: null, published_at: null };
    const next = [...rows.filter((r) => r !== was), mine];
    const gone = new Set(sweepPlan(next, Date.now(), this.rules, this.keep()));
    const left = next.filter((r) => !gone.has(r.id));
    const sum = (list: { size: number }[]) => list.reduce((n, r) => n + r.size, 0);
    if (gone.has(mine.id) || (!evict && gone.size) || sum(left.filter((r) => r.project_id === key.project_id)) > this.rules.schemeBytes || sum(left) > this.rules.totalBytes) return null;
    return { was, gone };
  }

  /**
   * With the store locked, plan the rules with the file at `part` in: if it fits, it becomes `key`'s file (replacing
   * the same run's file of that name) and what the rules give up for it is deleted; if not, null and nothing is touched.
   */
  private commit(key: Key, part: string, meta: Meta & { created_at?: number }, evict = true): Promise<CiFile | null> {
    return this.locked(async () => {
      const m = { ...meta, created_at: meta.created_at ?? Date.now() };
      const rows = this.store.ciFiles();
      const plan = this.plan(rows, key, m, evict);
      if (!plan) return null;
      await rename(part, this.path(key));
      const row = this.store.putCiFile({ ...key, ...m });
      for (const r of rows) if (r !== plan.was && plan.gone.has(r.id)) await this.remove(r);
      return row;
    });
  }

  /** Whether a fetched file of `size` would fit in `run`'s spare room now: a check before fetching one, which keeping it makes again. */
  fits(run: Omit<Key, 'name'>, meta: { kind: string; target: string; size: number; created_at: number }): boolean {
    return !!this.plan(this.store.ciFiles(), { ...run, name: '' }, meta, false);
  }

  /**
   * Keep a file this server fetched itself, as a run's file (a GitHub artifact mirrored for the Releases page, #673):
   * `fetch` writes it into the part folder it is given (in the run's own folder, so the stray sweep clears what a
   * restart cuts off) and returns its path, named as the store names files. Unlike an upload it only takes spare room:
   * nothing else is deleted for it (#673). Null when it doesn't fit; the part folder goes either way.
   */
  async fetched(run: Omit<Key, 'name'>, meta: Omit<Meta, 'size' | 'sha256'> & { created_at: number }, fetch: (dir: string) => Promise<string>): Promise<CiFile | null> {
    const dir = dirname(this.path({ ...run, name: 'x' }));
    const part = join(dir, `.${randomBytes(6).toString('hex')}.part`);
    await mkdir(part, { recursive: true });
    try {
      const file = await fetch(part);
      const name = basename(file);
      if (!NAME.test(name) || dirname(file) !== part) throw new Error(`${file} isn't a file named as the store names files, in ${part}`);
      const st = await lstat(file);
      if (!st.isFile()) throw new Error(`${file} isn't a plain file`);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      return await this.commit({ ...run, name }, file, { ...meta, size: st.size, sha256: hash.digest('hex') }, false);
    } finally {
      await rm(part, { recursive: true, force: true });
      await rmdir(dir).catch(() => {}); // only when nothing was kept
    }
  }

  /**
   * Delete what the rules say (sweepPlan), files first and then their rows. With `strays`, also what a restart
   * mid-upload left behind: part files and files with no row, once they are an hour old.
   */
  sweep(strays = false): Promise<number> {
    return this.locked(async () => {
      const rows = this.store.ciFiles();
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ids = sweepPlan(rows, Date.now(), this.rules, this.keep());
      for (const id of ids) await this.remove(byId.get(id)!);
      if (strays) {
        const known = new Set(this.store.ciFiles().map((r) => this.path(r)));
        for (const p of this.store.listProjects()) await this.clearStrays(this.dir(p.id), known);
      }
      return ids.length;
    });
  }

  /** Under one scheme's store: delete plain files no row names that are over an hour old, and folders left empty. Follows no symlink. */
  private async clearStrays(dir: string, known: Set<string>) {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const at = join(dir, e.name);
      if (e.isDirectory()) {
        await this.clearStrays(at, known);
        await rmdir(at).catch(() => {});
      } else if (e.isFile() && !known.has(at) && Date.now() - (await lstat(at)).mtimeMs > STRAY_MS) {
        console.warn(`CI store: deleting ${at}, which no upload finished`);
        await rm(at, { force: true });
      }
    }
  }

  /** Delete one file and its row; a file that isn't a plain file in the store (plain) keeps both, for a person to look at. */
  private async remove(f: CiFile) {
    try {
      const real = await this.plain(f);
      if (real) {
        await rm(real);
        await rmdir(dirname(real)).catch(() => {});
        await rmdir(dirname(dirname(real))).catch(() => {});
      }
    } catch (err: any) {
      console.error(`CI store: not deleting ${this.path(f)}:`, err?.message ?? err);
      return;
    }
    this.store.deleteCiFile(f.id);
  }

  /** The signed APK a release run put in the store, for the Releases page's publish step. */
  releaseApk(projectId: number, runId: number): CiFile | undefined {
    return this.store.ciFiles(projectId).find((f) => f.run_id === runId && f.kind === 'release' && f.name.endsWith('.apk'));
  }

  /** Bytes a scheme's files take, and every scheme's. */
  usage(projectId: number): { scheme: number; total: number } {
    let scheme = 0;
    let total = 0;
    for (const r of this.store.ciFiles()) {
      total += r.size;
      if (r.project_id === projectId) scheme += r.size;
    }
    return { scheme, total };
  }
}

const gib = (bytes: number) => `${+(bytes / GIB).toFixed(1)} GiB`;

/** What an upload's query asks for, checked. */
export function uploadAsk(name: string, query: URLSearchParams): Upload {
  if (!NAME.test(name)) throw new HttpError(400, 'A file\'s name is 1 to 150 letters, digits and . _ + -, starting with a letter or digit');
  const kind = query.get('kind') ?? '';
  if (!(KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}`);
  const target = query.get('target') ?? '';
  if (target && !NAME.test(target)) throw new HttpError(400, 'target is 1 to 150 letters, digits and . _ + -');
  return { name, kind: kind as Kind, target };
}
