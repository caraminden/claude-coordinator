/**
 * A new minion's worktree gets its npm dependencies before its first turn (#1649), in every scheme: about 41 red test
 * runs in two weeks were a fresh worktree with no node_modules (#1642's audit). Each tracked package-lock.json (or
 * npm-shrinkwrap.json) whose node_modules git ignores gets `npm ci --prefer-offline`: from the lockfile, never a plain
 * `npm install` that rewrites it. One npm cache for every scheme sits beside the Gradle one (src/build-cache.ts), in
 * the projects folder every container mounts, so a second worktree on the same lockfile unpacks from it in seconds.
 * The daily sweep keeps it under NPM_CACHE_CAP. Only new worktrees: server.ts runs it on the minion's lane after
 * creating it, so the first turn waits for it; a failed or cut-off install leaves the minion held mail saying so.
 * A repo with no lockfile is a no-op; Citadel's own tracks package-lock.json (dev-only fast-check, ADR 0029), so its
 * new minions run `npm ci` before the first turn.
 */
import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { turnEnv } from './turn-launch.ts';

const run = promisify(execFile);
let running = 0;
/** How many installs are under way now: the daily sweep leaves the cache alone while one is. */
export const installsRunning = () => running;

/** The shared npm cache, under the projects folder. */
export const npmCacheDir = (dataDir: string) => join(dataDir, 'projects', '.build-cache', 'npm');
/** Its cap: past it the daily sweep empties it (npm's content store has no oldest-first trim). */
export const NPM_CACHE_CAP = 2 * 2 ** 30;
/** How long the installs may hold up a new minion's first turn, all of them together. */
export const INSTALL_MS = 3 * 60_000;
/** heavy-unit (#1298): the install runs in a scope of its own in citadel-heavy.slice, so running out of memory stops it, never the server. */
const HEAVY_UNIT = join(import.meta.dirname, '..', 'tools', 'heavy-unit');

/** The folders (relative, '' for the root) holding a tracked npm lockfile, whose node_modules git ignores and isn't there yet. */
export async function lockfileDirs(worktree: string): Promise<string[]> {
  const { stdout } = await run('git', ['ls-files', '-z', '--', ':(glob)**/package-lock.json', ':(glob)**/npm-shrinkwrap.json'], { cwd: worktree, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const dirs = [...new Set(stdout.split('\0').filter(Boolean).map((f) => (dirname(f) === '.' ? '' : dirname(f))))].sort();
  const out: string[] = [];
  for (const dir of dirs) {
    const modules = dir ? `${dir}/node_modules` : 'node_modules';
    if (await access(join(worktree, modules)).then(() => true, () => false)) continue;
    // Trailing slash: a `node_modules/` pattern matches only a folder, and this one doesn't exist yet. Not ignored, an install would leave thousands of files to commit.
    const ignored = await run('git', ['check-ignore', '-q', `${modules}/`], { cwd: worktree, timeout: 30_000 }).then(() => true, () => false);
    if (ignored) out.push(dir);
  }
  return out;
}

export type DepsResult = { installed: string[]; failed: { dir: string; why: string }[] };

/**
 * Install each lockfile folder's dependencies with `npm ci`, one after another, within `timeoutMs` in all. Never throws.
 * `npm` is the command before `ci` (tests swap in a fake); the env is a turn's, without Claude's own variables, since
 * the repo's install scripts run in it.
 */
export async function installDeps(worktree: string, cacheDir: string, opts: { npm?: string[]; timeoutMs?: number; graceMs?: number } = {}): Promise<DepsResult> {
  running++;
  try {
    return await install(worktree, cacheDir, opts);
  } finally {
    running--;
  }
}

async function install(worktree: string, cacheDir: string, opts: { npm?: string[]; timeoutMs?: number; graceMs?: number }): Promise<DepsResult> {
  const out: DepsResult = { installed: [], failed: [] };
  let dirs: string[];
  try {
    dirs = await lockfileDirs(worktree);
  } catch (err: any) {
    return { installed: [], failed: [{ dir: '', why: `listing its lockfiles failed: ${firstLine(err)}` }] };
  }
  const npm = opts.npm ?? [HEAVY_UNIT, '--what', 'npm ci', 'npm'];
  const end = Date.now() + (opts.timeoutMs ?? INSTALL_MS);
  const env: Record<string, string> = Object.fromEntries(Object.entries(turnEnv(process.env)).filter(([k]) => !/^(CLAUDE_|ANTHROPIC_)/.test(k)));
  // heavy-unit's own switches (tests run it in place).
  for (const k of ['CITADEL_HEAVY_UNIT', 'CITADEL_HEAVY_SLICE']) if (process.env[k]) env[k] = process.env[k]!;
  Object.assign(env, { npm_config_cache: cacheDir, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' });
  for (const dir of dirs) {
    const left = end - Date.now();
    if (left <= 0) {
      out.failed.push({ dir, why: 'not tried: the time for installs ran out' });
      continue;
    }
    const err = await ci(npm, join(worktree, dir), env, left, opts.graceMs ?? 10_000);
    if (!err) out.installed.push(dir);
    else out.failed.push({ dir, why: err === 'cut' ? `cut off after ${Math.round((opts.timeoutMs ?? INSTALL_MS) / 1000)} s` : firstLine(err) });
  }
  return out;
}

/**
 * One `npm ci` in its own process group: past `ms` the whole group (npm, heavy-unit, the install scripts npm started)
 * gets SIGTERM, and SIGKILL `graceMs` later, so a script that ignores TERM can't hold the minion's lane.
 */
function ci(npm: string[], cwd: string, env: Record<string, string>, ms: number, graceMs: number): Promise<'cut' | Error | null> {
  return new Promise((resolve) => {
    let cut = false;
    let kill: NodeJS.Timeout | undefined;
    // spawn, not execFile: Node 26's execFile leaves `detached` out, so the child would share the server's group.
    const child = spawn(npm[0], [...npm.slice(1), 'ci', '--prefer-offline', '--no-audit', '--no-fund'], { cwd, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => void (stderr = (stderr + d).slice(-64 * 1024)));
    const group = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {} // already gone
    };
    const stop = setTimeout(() => {
      cut = true;
      group('SIGTERM');
      kill = setTimeout(() => group('SIGKILL'), graceMs);
    }, ms);
    const done = (err: Error | null) => {
      clearTimeout(stop);
      clearTimeout(kill);
      resolve(cut ? 'cut' : err);
    };
    child.on('error', (err) => done(Object.assign(err, { stderr })));
    child.on('close', (code, sig) => done(code === 0 ? null : Object.assign(new Error(`npm ci exited ${code ?? sig}`), { stderr })));
  });
}

/** The held-mail note for a minion whose install failed, or null when nothing failed. */
export function depsNote(r: DepsResult): string | null {
  if (!r.failed.length) return null;
  const where = (dir: string) => (dir ? `in ${dir}/` : 'at the root');
  const lines = r.failed.map((f) => `- ${where(f.dir)}: ${f.why}`);
  return `Citadel installs a new worktree's npm dependencies from its lockfile before the first turn (#1649), and this one didn't finish:\n${lines.join('\n')}\nRun \`npm ci\` in each of those folders before your first test run (never a plain \`npm install\`, which rewrites the lockfile).`;
}

/** The last useful line of a failed command: npm's own `npm error` line when it gave one. */
function firstLine(err: any): string {
  const text = String(err?.stderr || err?.message || err).trim().split('\n').filter(Boolean);
  const npmErr = text.find((l) => /^npm (error|ERR!)/.test(l) && !/A complete log|^npm error\s*$/.test(l));
  return (npmErr ?? text[0] ?? 'failed').slice(0, 300);
}
