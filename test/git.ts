// Git for test fixtures: a pinned identity and no global config, so a person's own settings (signing, hooks,
// init.defaultBranch) never reach a test repo. Output comes back trimmed.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };

/** `git <args>` in `cwd`, as `t <t@t>`, its stdout trimmed. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } }).trim();
}

/** Like `git`, with the author and commit dates at `date` (ms since the epoch). */
export function gitAt(date: number, cwd: string, ...args: string[]): string {
  const when = `@${Math.floor(date / 1000)} +0000`;
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } }).trim();
}

/** An empty repo on `main` at `dir` (made if it isn't there). */
export function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}
