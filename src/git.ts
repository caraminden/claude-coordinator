import { execFile } from 'node:child_process';

export interface GitOutOptions {
  /** Trim the output (default). Off for file contents, where a trailing newline is part of them. */
  trim?: boolean;
  timeout?: number;
  maxBuffer?: number;
  /** Added to the process's own environment. */
  env?: NodeJS.ProcessEnv;
  /** A command to run git under (ionice and nice, for a sweep). */
  prefix?: string[];
}

/** git's stdout, or null when it failed or timed out. One copy of the exec options for the modules that read git. */
export function gitOut(args: string[], cwd: string, { trim = true, timeout = 15_000, maxBuffer = 16 * 1024 * 1024, env, prefix = [] }: GitOutOptions = {}): Promise<string | null> {
  const [bin, ...pre] = [...prefix, 'git'];
  return new Promise((done) => execFile(bin, [...pre, ...args], { cwd, timeout, maxBuffer, ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, out) => done(err ? null : trim ? out.trim() : out)));
}
