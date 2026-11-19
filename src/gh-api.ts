// GitHub through the gh CLI.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { asEnv, type GithubEnv } from './scheme-repo.ts';

const run = promisify(execFile);

export interface GhAnswer {
  status: number;
  etag: string | null;
  body: any;
}
export type GhGet = (path: string, etag: string | null, as: GithubEnv) => Promise<GhAnswer>;

/** One REST GET through the gh CLI, conditional on `etag`; any HTTP status comes back, only a failure to ask throws. */
export async function ghGet(path: string, etag: string | null, as: GithubEnv): Promise<GhAnswer> {
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
  return { status, etag: /^etag:\s*(.+?)\s*$/im.exec(head)?.[1] ?? null, body };
}

/** One REST POST through the gh CLI; the status of the answer, 0 when gh printed none. */
export async function ghPost(path: string, as: GithubEnv): Promise<{ status: number }> {
  try {
    const { stdout } = await run('gh', ['api', '-i', '-X', 'POST', path], { env: asEnv(as), timeout: 30_000 });
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
