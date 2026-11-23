// GitHub through the gh CLI, and reads through a helper per login that stays up (src/gh-helper.ts, #1542).
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { asEnv, type GithubEnv } from './scheme-repo.ts';

const run = promisify(execFile);

export interface GhAnswer {
  status: number;
  etag: string | null;
  body: any;
}
export type GhGet = (path: string, etag: string | null, as: GithubEnv) => Promise<GhAnswer>;

/** After a helper couldn't start (no login), reads for that login go through gh this long before it is tried again. */
const NO_HELPER_MS = 10 * 60_000;

/**
 * The GitHub readers that stay up, one per login (the token, or for none, gh's own config folder). The server sets `dir`
 * (its run folder); until then, and in tests and tools, every read goes through gh. A read never waits for a helper to
 * start: it goes through gh while one starts, and through gh again whenever the helper fails, which drops it so the next
 * read starts another.
 */
export class GhHelpers {
  dir: string | null = null;
  /** GitHub's API address, for tests. */
  api: string | undefined;
  idleMs: number | undefined;
  private live = new Map<string, { proc: ChildProcess; socket: string; nonce: string; ready: boolean }>();
  private off = new Map<string, number>();
  private starting = new Set<string>();

  /** The helper's answer, or null to read through gh instead. Never throws. */
  async get(path: string, etag: string | null, as: GithubEnv): Promise<GhAnswer | null> {
    if (!this.dir) return null;
    const env = { ...(asEnv(as) ?? process.env) };
    const token = env.GH_TOKEN || env.GITHUB_TOKEN || null;
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    const key = createHash('sha256').update(`${token ?? ''}\0${env.GH_CONFIG_DIR ?? ''}`).digest('hex').slice(0, 16);
    const h = this.live.get(key);
    if (!h) {
      if ((this.off.get(key) ?? 0) < Date.now() && !this.starting.has(key)) {
        this.starting.add(key);
        void this.start(key, token, env).finally(() => this.starting.delete(key));
      }
      return null;
    }
    if (!h.ready) return null;
    let got: GhAnswer | null;
    try {
      got = await ask(h.socket, h.nonce, path, etag);
    } catch {
      this.drop(key, h.proc);
      return null;
    }
    // A token GitHub no longer takes (a new `gh auth login`, a revoked link): gh reads it fresh, and the helper rests a while.
    if (got?.status === 401) {
      this.off.set(key, Date.now() + NO_HELPER_MS);
      this.drop(key, h.proc);
      return null;
    }
    return got;
  }

  private async start(key: string, token: string | null, env: NodeJS.ProcessEnv) {
    const socket = join(this.dir!, `${key}.sock`);
    if (Buffer.byteLength(socket) > 107) return; // past a unix socket path's limit (a dev copy's long DATA_DIR): reads go through gh
    if (!(await mkdir(this.dir!, { recursive: true, mode: 0o700 }).then(() => true, () => false))) return;
    const nonce = randomBytes(24).toString('hex');
    // argv0 is not node: ananicy runs anything named node at idle priority (deploy/priority.md).
    const proc = spawn(process.execPath, [join(import.meta.dirname, 'gh-helper.ts')], { argv0: 'citadel-gh', env, stdio: ['pipe', 'pipe', 'ignore'] });
    const h = { proc, socket, nonce, ready: false };
    this.live.set(key, h);
    proc.on('error', () => this.drop(key, proc));
    proc.stdin!.on('error', () => {});
    proc.stdout!.setEncoding('utf8').on('data', (d: string) => {
      if (d.includes('ready')) h.ready = true;
    });
    proc.on('exit', (code) => {
      if (code === 3) this.off.set(key, Date.now() + NO_HELPER_MS);
      this.drop(key, proc);
    });
    proc.stdin!.write(`${JSON.stringify({ socket, nonce, token, api: this.api, idleMs: this.idleMs })}\n`);
    // Unref'd: an idle helper never keeps the server's process from exiting; its stdin closing then ends it.
    proc.unref();
    (proc.stdin as any).unref?.();
    (proc.stdout as any).unref?.();
  }

  private drop(key: string, proc: ChildProcess) {
    if (this.live.get(key)?.proc !== proc) return;
    this.live.delete(key);
    proc.kill();
  }

  /** Stop every helper (tests). */
  stop() {
    for (const [key, h] of this.live) this.drop(key, h.proc);
  }
}

/**
 * One GET through a helper's socket: a header line, then the body to the end. Null when the helper says GitHub itself
 * failed (unreachable, timed out, too big): the helper is fine and gh tries. Throws when the helper doesn't answer right.
 */
function ask(socket: string, nonce: string, path: string, etag: string | null): Promise<GhAnswer | null> {
  return new Promise((done, fail) => {
    const conn = connect(socket);
    const chunks: Buffer[] = [];
    conn.setTimeout(35_000, () => conn.destroy(new Error('helper timed out')));
    conn.on('error', fail);
    conn.on('data', (d: Buffer) => chunks.push(d));
    conn.on('end', () => {
      const all = Buffer.concat(chunks);
      const nl = all.indexOf(10);
      try {
        const head = JSON.parse(all.subarray(0, nl < 0 ? all.length : nl).toString('utf8'));
        if (typeof head.error === 'string') return done(null);
        if (typeof head.status !== 'number') throw new Error('helper gave no status');
        const rest = nl < 0 ? '' : all.subarray(nl + 1).toString('utf8');
        let body: any = null;
        try {
          body = rest.trim() ? JSON.parse(rest) : null;
        } catch {}
        done({ status: head.status, etag: typeof head.etag === 'string' ? head.etag : null, body });
      } catch (err) {
        fail(err);
      }
    });
    conn.end(`${JSON.stringify({ nonce, path, etag })}\n`);
  });
}

export const ghHelpers = new GhHelpers();

/** A REST path as a poller's name: run and issue numbers become N, a commit sha SHA, a query keeps its names only. */
export function pathShape(path: string): string {
  const [p, q] = path.replace(/^\//, '').split('?', 2);
  const shape = p.split('/').map((s) => (/^\d+$/.test(s) ? 'N' : /^[0-9a-f]{40}$/i.test(s) ? 'SHA' : s)).join('/');
  return q ? `${shape}?${q.split('&').map((kv) => kv.split('=')[0]).join('&')}` : shape;
}

/**
 * The server's GitHub calls by path shape since the last report (#1722): every login's calls draw on one hour of
 * quota, and a 304 is the only answer GitHub doesn't count, so the next "API rate limit exceeded" names who spent it.
 */
export class GhTally {
  #paths = new Map<string, { counted: number; free: number }>();
  add(path: string, status: number): void {
    const shape = pathShape(path);
    const n = this.#paths.get(shape) ?? { counted: 0, free: 0 };
    if (status === 304) n.free++;
    else n.counted++;
    this.#paths.set(shape, n);
  }
  /** "<counted> counted, <free> free (304): <busiest paths>", or null when nothing was asked; starts the next one afresh. */
  report(top = 8): string | null {
    if (!this.#paths.size) return null;
    const rows = [...this.#paths].sort(([, a], [, b]) => b.counted - a.counted || b.free - a.free);
    this.#paths = new Map();
    const sum = (rs: typeof rows, k: 'counted' | 'free') => rs.reduce((t, [, n]) => t + n[k], 0);
    const shown = rows.slice(0, top).map(([s, n]) => `${s} ${n.counted}${n.free ? `+${n.free} free` : ''}`);
    const rest = rows.slice(top);
    if (rest.length) shown.push(`and ${rest.length} more paths ${sum(rest, 'counted')}`);
    return `${sum(rows, 'counted')} counted, ${sum(rows, 'free')} free (304): ${shown.join(', ')}`;
  }
}

export const ghTally = new GhTally();

/** One REST GET, conditional on `etag`, through the login's helper when it is up, else the gh CLI; any HTTP status comes back, only a failure to ask throws. */
export async function ghGet(path: string, etag: string | null, as: GithubEnv): Promise<GhAnswer> {
  const helped = await ghHelpers.get(path, etag, as);
  if (helped) {
    ghTally.add(path, helped.status);
    return helped;
  }
  let out: string;
  try {
    ({ stdout: out } = await run('gh', ['api', '-i', path, ...(etag ? ['-H', `If-None-Match: ${etag}`] : [])], { env: asEnv(as), timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }));
  } catch (err: any) {
    // gh exits 1 on a 304 or an error status, but still prints the answer.
    out = typeof err?.stdout === 'string' ? err.stdout : '';
    if (!/^HTTP\/\S+ \d+/.test(out)) throw err;
  }
  const split = /\r?\n\r?\n/.exec(out);
  const head = split ? out.slice(0, split.index) : out;
  const rest = split ? out.slice(split.index + split[0].length) : '';
  const status = Number(/^HTTP\/\S+ (\d+)/.exec(head)?.[1] ?? 0);
  let body: any = null;
  try {
    body = rest.trim() ? JSON.parse(rest) : null;
  } catch {}
  ghTally.add(path, status);
  return { status, etag: /^etag:\s*(.+?)\s*$/im.exec(head)?.[1] ?? null, body };
}

/** One REST POST through the gh CLI; the status of the answer, 0 when gh printed none. */
export async function ghPost(path: string, as: GithubEnv, fields: Record<string, string> = {}): Promise<{ status: number }> {
  ghTally.add(path, 0);
  try {
    const { stdout } = await run('gh', ['api', '-i', '-X', 'POST', path, ...Object.entries(fields).flatMap(([k, v]) => ['-f', `${k}=${v}`])], { env: asEnv(as), timeout: 30_000 });
    return { status: Number(/^HTTP\/\S+ (\d+)/.exec(stdout)?.[1] ?? 0) };
  } catch (err: any) {
    const out = typeof err?.stdout === 'string' ? err.stdout : '';
    if (!/^HTTP\/\S+ \d+/.test(out)) throw err;
    return { status: Number(/^HTTP\/\S+ (\d+)/.exec(out)![1]) };
  }
}

export class RateLimited extends Error {}

/** A status GitHub answered that skips the scheme's round. */
export class GhError extends Error {
  status: number;
  constructor(status: number, path: string) {
    super(`GitHub answered ${status} for ${path}`);
    this.status = status;
  }
}
