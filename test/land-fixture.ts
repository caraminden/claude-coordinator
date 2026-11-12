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
  // args: land.sh's own (--into build/<n> ..., --build); cwd: another worktree of the repo.
  const run = (extra: Record<string, string> = {}, args: string[] = [], cwd = wt) =>
    // A time limit, so a land.sh whose test run hangs fails this test instead of hanging it (#377).
    spawnSync('bash', [land, ...args], { cwd, encoding: 'utf8', timeout: 90_000, env: { ...env, DEPLOY_LIVE: live, DEPLOY_SOURCE: source, DEPLOY_NOTE: join(dir, 'note'), ...extra } });
  const commit = (where: string, file: string, text: string) => {
    writeFileSync(join(where, file), text);
    git(where, 'add', '-A');
    git(where, 'commit', '-qm', `${file}: ${text.trim()}`);
  };
  const note = () => (existsSync(join(dir, 'note')) ? readFileSync(join(dir, 'note'), 'utf8').trim() : null);
  return { dir, source, live, wt, run, commit, note };
}


// Run land.sh in its own process group, so a run that hangs can be stopped with everything it started.
export function landAsync(cwd: string, extra: Record<string, string>, limit: number, seen?: (stderr: string) => void, args: string[] = []): Promise<{ status: number | null; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t = Date.now();
    const child = spawn('bash', [land, ...args], { cwd, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, ...extra } });
    let stderr = '';
    child.stderr!.on('data', (d) => seen?.((stderr += d)));
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, limit);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stderr, ms: Date.now() - t }); });
  });
}
export const tickets = (state: string) => (existsSync(join(state, 'queue')) ? readdirSync(join(state, 'queue')).filter((f) => /^\d+$/.test(f)).sort() : []);
export const issued = (state: string) => (existsSync(join(state, 'queue', '.seq')) ? Number(readFileSync(join(state, 'queue', '.seq'), 'utf8')) : 0);

// The CI gate (#523): GitHub is a bare repo as origin and a stand-in gh. The stand-in knows one run, id 7, of whatever
// commit a land/<branch> points at there, in the state FAKE_CI names; FAKE_OLD_RUN is an earlier run, "<sha> <status> <conclusion>",
// which GitHub still answers with for FAKE_LAG polls after the push; FAKE_STEP is the step a red run failed in.
export function ci(r: ReturnType<typeof setup>) {
  const hub = join(r.dir, 'hub.git');
  git(r.dir, 'init', '-q', '--bare', hub);
  git(r.source, 'remote', 'add', 'origin', hub);
  const bin = join(r.dir, 'bin');
  mkdirSync(bin);
  const calls = join(r.dir, 'gh-calls');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
echo "$*" >>"${calls}"
case "$*" in
  *"/actions/runs?head_sha="*)
    sha=\${2#*head_sha=} sha=\${sha%%&*}
    [ "\${FAKE_CI:-}" != down ] || exit 1
    [ "\${FAKE_CI:-}" != rate ] || { echo 'gh: API rate limit exceeded for installation ID 1. (HTTP 403)' >&2; exit 1; }
    [ "\${FAKE_CI:-}" != garbage ] || { echo '<html><body>Bad gateway</body></html>'; exit 0; }
    lag=0
    if [ -n "\${FAKE_LAG:-}" ] && [ "$(grep -c head_sha "${calls}")" -le "\$((FAKE_LAG + 1))" ]; then lag=1; fi
    if [ "$lag" = 0 ] && [ -n "$(git -C "${hub}" for-each-ref --points-at "$sha" refs/heads/land/ 2>/dev/null)" ]; then
      case \${FAKE_CI:-green} in
        green) printf '7\\tcompleted\\tsuccess\\thttps://ci/7\\n' ;;
        red) printf '7\\tcompleted\\tfailure\\thttps://ci/7\\n' ;;
        cancelled) printf '7\\tcompleted\\tcancelled\\thttps://ci/7\\n' ;;
        queued) printf '7\\tqueued\\t-\\thttps://ci/7\\n' ;;
        running) printf '7\\tin_progress\\t-\\thttps://ci/7\\n' ;;
      esac
    elif [ "\${FAKE_OLD_RUN%% *}" = "$sha" ]; then
      set -- \$FAKE_OLD_RUN; printf '3\\t%s\\t%s\\thttps://ci/3\\n' "$2" "$3"
    fi ;;
  *"/actions/runners "*) [ "\${FAKE_RUNNERS:-1}" != down ] || exit 1; [ "\${FAKE_RUNNERS:-1}" != garbage ] || { echo '<html>Bad gateway</html>'; exit 0; }; echo "\${FAKE_RUNNERS:-1}" ;;
  *"/actions/runs/7/jobs "*) echo "\${FAKE_STEP:-the full suite}" ;;
  "run view "*) printf 'test\\tthe full suite\\t2026 run-tests: test/slow.test.ts: failed in the full run, passed alone: likely load, not your change (1-minute load 31.5)\\n'; echo "not ok 1 - the red test's output" ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const testRuns = join(r.dir, 'test-runs');
  return {
    run: (extra: Record<string, string> = {}, args: string[] = [], cwd = r.wt) => r.run({ PATH: `${bin}:${process.env.PATH}`, LAND_CI: '1', LAND_CI_POLL: '0.1', TEST_RUNS: testRuns, ...extra }, args, cwd),
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : ''),
    localRuns: () => (existsSync(testRuns) ? readFileSync(testRuns, 'utf8').trim().split('\n').length : 0),
    refs: () => git(hub, 'for-each-ref', '--format=%(refname)'),
  };
}
