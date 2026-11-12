// The throwaway repos and helpers land.test.ts, land-deploy.test.ts and land-queue.test.ts share.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { scriptEnv } from './script-env.ts';

// tools/land.sh on throwaway repos: a scheme repo on main, a minion worktree, and a live clone. The
// worktree's tools/deploy.sh is a stand-in that notes whether it got the lock, and fails on request.
export const land = join(import.meta.dirname, '..', 'tools', 'land.sh');
export const root = mkdtempSync(join(tmpdir(), 'land-'));
after(() => rmSync(root, { recursive: true, force: true }));
// NODE_TEST_CONTEXT would make land.sh's own `node --test` report to this runner instead of exiting red;
// COORDINATOR_* would have the real deploy.sh report to the live server; CITADEL_HEAVY_* would queue it in the host's slots;
// The variables the scripts export (test/script-env.ts), set when a real land runs these tests, would have a test's deploy.sh skip its own lock
// ("flock: 9: Bad file descriptor") or its tests; an empty DEPLOY_TEST_CPU_WEIGHT makes no real systemd scope.
export const env = { ...scriptEnv(), COORDINATOR_CONTAINER: undefined, COORDINATOR_SHARED_DIR: undefined, CITADEL_HEAVY_DIR: join(root, 'heavy'), DEPLOY_TEST_CPU_WEIGHT: '', NODE_TEST_CONTEXT: undefined, COORDINATOR_TICKET: undefined, COORDINATOR_TOKEN: undefined, COORDINATOR_API: undefined, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
export const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();

let n = 0;
export function setup() {
  const dir = join(root, String(++n));
  const source = join(dir, 'repo');
  mkdirSync(join(source, 'tools'), { recursive: true });
  mkdirSync(join(source, 'test'));
  git(source, 'init', '-q', '-b', 'main');
  // TEST_RUNS: a file that gets a line per test run, naming the checkout it ran in.
  writeFileSync(join(source, 'test', 'ok.test.mjs'), "import { appendFileSync } from 'node:fs';\nif (process.env.TEST_RUNS) appendFileSync(process.env.TEST_RUNS, process.cwd() + '\\n');\nif (process.env.FAIL_TESTS) throw new Error('red');\n");
  writeFileSync(join(source, 'tools', 'deploy.sh'), `#!/usr/bin/env bash
lock=$(git -C "$DEPLOY_LIVE" rev-parse --absolute-git-dir)/cc-deploy/lock
flock -n "$lock" true && held=no || held=yes
echo "locked=$DEPLOY_LOCKED held=$held" >"$DEPLOY_NOTE"
until [ -z "\${FAKE_DEPLOY_GATE:-}" ] || [ -e "\$FAKE_DEPLOY_GATE" ]; do sleep 0.05; done
[ "\${FAKE_DEPLOY_EXIT:-0}" != 0 ] || [ -z "\${DEPLOY_TIMES:-}" ] || echo "queued \$(date +%s)" >>"\$DEPLOY_TIMES"
[ "\${FAKE_DEPLOY_EXIT:-0}" != 0 ] || [ -n "\${FAKE_NOT_LIVE:-}" ] || [ -z "\${DEPLOY_TIMES:-}" ] || echo "live \$(date +%s)" >>"\$DEPLOY_TIMES"
exit "\${FAKE_DEPLOY_EXIT:-0}"
`);
  chmodSync(join(source, 'tools', 'deploy.sh'), 0o755);
  writeFileSync(join(source, 'a.txt'), 'one\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-qm', 'base');
  const live = join(dir, 'live');
  git(dir, 'clone', '-q', source, live);
  const wt = join(dir, 'wt');
  git(source, 'worktree', 'add', '-q', '-b', 'ticket/1-x', wt);
  const run = (extra: Record<string, string> = {}) =>
    // A time limit, so a land.sh whose test run hangs fails this test instead of hanging it (#377).
    spawnSync('bash', [land], { cwd: wt, encoding: 'utf8', timeout: 90_000, env: { ...env, DEPLOY_LIVE: live, DEPLOY_SOURCE: source, DEPLOY_NOTE: join(dir, 'note'), ...extra } });
  const commit = (where: string, file: string, text: string) => {
    writeFileSync(join(where, file), text);
    git(where, 'add', '-A');
    git(where, 'commit', '-qm', `${file}: ${text.trim()}`);
  };
  const note = () => (existsSync(join(dir, 'note')) ? readFileSync(join(dir, 'note'), 'utf8').trim() : null);
  return { dir, source, live, wt, run, commit, note };
}


// Run land.sh in its own process group, so a run that hangs can be stopped with everything it started.
export function landAsync(cwd: string, extra: Record<string, string>, limit: number, seen?: (stderr: string) => void): Promise<{ status: number | null; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t = Date.now();
    const child = spawn('bash', [land], { cwd, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, ...extra } });
    let stderr = '';
    child.stderr!.on('data', (d) => seen?.((stderr += d)));
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, limit);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stderr, ms: Date.now() - t }); });
  });
}
export const tickets = (state: string) => (existsSync(join(state, 'queue')) ? readdirSync(join(state, 'queue')).filter((f) => /^\d+$/.test(f)).sort() : []);
export const issued = (state: string) => (existsSync(join(state, 'queue', '.seq')) ? Number(readFileSync(join(state, 'queue', '.seq'), 'utf8')) : 0);
