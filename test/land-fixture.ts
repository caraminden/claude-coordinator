// The throwaway repos and helpers land.test.ts, land-deploy.test.ts and land-queue.test.ts share.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { scriptEnv } from './script-env.ts';
import { git } from './git.ts';
export { git };

// tools/land.sh on throwaway repos: a scheme repo on main, a minion worktree, and a live clone. The
// worktree's tools/deploy.sh is a stand-in that notes whether it got the lock, and fails on request. FAKE_DEPLOY_LOG gets
// main's commit for each deploy. FAKE_RESTART_GATE acts out deploy.sh's queued restart: it lets go of the line, then
// waits for that file before the restart goes live (or, with FAKE_ROLLED_BACK, is rolled back and fails).
export const land = join(import.meta.dirname, '..', 'tools', 'land.sh');
export const root = mkdtempSync(join(tmpdir(), 'land-'));
after(() => rmSync(root, { recursive: true, force: true }));
// NODE_TEST_CONTEXT would make land.sh's own `node --test` report to this runner instead of exiting red;
// COORDINATOR_* would have the real deploy.sh report to the live server; CITADEL_HEAVY_* would queue it in the host's slots;
// The variables the scripts export (test/script-env.ts), set when a real land runs these tests, would have a test's deploy.sh skip its own lock
// ("flock: 9: Bad file descriptor") or its tests; an empty DEPLOY_TEST_CPU_WEIGHT makes no real systemd scope.
export const env = { ...scriptEnv(), COORDINATOR_CONTAINER: undefined, COORDINATOR_SHARED_DIR: undefined, CITADEL_HEAVY_DIR: join(root, 'heavy'), DEPLOY_TEST_CPU_WEIGHT: '', NODE_TEST_CONTEXT: undefined, COORDINATOR_TICKET: undefined, COORDINATOR_TOKEN: undefined, COORDINATOR_API: undefined, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };

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
[ -z "\${FAKE_DEPLOY_LOG:-}" ] || git -C "$DEPLOY_SOURCE" rev-parse main >>"\$FAKE_DEPLOY_LOG"
if [ -n "\${FAKE_RESTART_GATE:-}" ]; then
  echo "queued \$(date +%s)" >>"\$DEPLOY_TIMES"
  rm -f "\$DEPLOY_QUEUE_TICKET"
  flock -u 9
  until [ -e "\$FAKE_RESTART_GATE" ]; do sleep 0.05; done
  [ -z "\${FAKE_ROLLED_BACK:-}" ] || exit 1
  echo "live \$(date +%s)" >>"\$DEPLOY_TIMES"
  exit 0
fi
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

// The CI gate (#523): GitHub is a bare repo as origin and a stand-in gh. Each push of land/<branch> starts a run (one
// per runners check, which comes before each push): id 7 in the state FAKE_CI names, a second one (#769's fresh run),
// id 8, in FAKE_CI_RERUN's. The newest run stays listed for the commit once the branch is gone, as on GitHub.
// FAKE_OLD_RUN is an earlier run, "<sha> <status> <conclusion>", which GitHub still answers with for FAKE_LAG polls
// after the push; FAKE_STEP is the step a red run failed in; FAKE_LOG which run-tests.sh lines a red run's log has (mixed, flakes, many, or due: one file left unrerun at CI's deadline)
// (mixed: a flake and a real failure; flakes: two flakes and nothing else; many: too many files to rerun).
// FAKE_RED_PATH: a run is red when its commit has that file, green otherwise (the ship train's bisect, #1166);
// FAKE_CI_GATE: every run stays in progress until that file exists.
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
    n=$(grep -c '/actions/runners ' "${calls}") id=$((6 + n)) st=\${FAKE_CI:-green}
    [ "$n" -lt 2 ] || st=\${FAKE_CI_RERUN:-$st}
    # (a commit GitHub hasn't got yet has no run)
    if [ -n "\${FAKE_RED_PATH:-}" ]; then git -C "${hub}" cat-file -e "$sha^{commit}" 2>/dev/null || exit 0; git -C "${hub}" cat-file -e "$sha:\$FAKE_RED_PATH" 2>/dev/null && st=red || st=green; fi
    [ -z "\${FAKE_CI_GATE:-}" ] || [ -e "\$FAKE_CI_GATE" ] || st=running
    if [ "$lag" = 0 ] && [ "$n" -gt 0 ] && { [ -n "$(git -C "${hub}" for-each-ref --points-at "$sha" refs/heads/land/ 2>/dev/null)" ] || [ -z "\${FAKE_OLD_RUN:-}" ]; }; then
      case $st in
        green) printf '%s\\tcompleted\\tsuccess\\thttps://ci/%s\\n' $id $id ;;
        red) printf '%s\\tcompleted\\tfailure\\thttps://ci/%s\\n' $id $id ;;
        cancelled) printf '%s\\tcompleted\\tcancelled\\thttps://ci/%s\\n' $id $id ;;
        queued) printf '%s\\tqueued\\t-\\thttps://ci/%s\\n' $id $id ;;
        running) printf '%s\\tin_progress\\t-\\thttps://ci/%s\\n' $id $id ;;
      esac
    elif [ "\${FAKE_OLD_RUN%% *}" = "$sha" ]; then
      set -- \$FAKE_OLD_RUN; printf '3\\t%s\\t%s\\thttps://ci/3\\n' "$2" "$3"
    fi ;;
  *"/actions/runners "*) [ "\${FAKE_RUNNERS:-1}" != down ] || exit 1; [ "\${FAKE_RUNNERS:-1}" != garbage ] || { echo '<html>Bad gateway</html>'; exit 0; }; echo "\${FAKE_RUNNERS:-1}" ;;
  *"/actions/runs/"[0-9]*"/jobs "*) echo "\${FAKE_STEP:-the full suite}" ;;
  "run view "*)
    echo "not ok 1 - the red test's output (run $3)"
    p='test\\tthe full suite\\t2026 run-tests:'
    case \${FAKE_LOG:-mixed} in
      many) printf '%b 7 test files failed: too many for load, so none is rerun\\n' "$p" ;;
      *)
        printf '%b 2 test file(s) failed; rerunning each alone once to tell load from a real failure (the run fails either way; output in /tmp/tests-rerun.log)\\n' "$p"
        printf '%b test/slow.test.ts: failed in the full run, passed alone: likely load, not your change (1-minute load 31.5)\\n' "$p"
        if [ "\${FAKE_LOG:-mixed}" = flakes ]; then
          printf '%b test/busy.test.ts: failed in the full run, passed alone: likely load, not your change (1-minute load 31.5)\\n' "$p"
        elif [ "\${FAKE_LOG:-mixed}" = due ]; then
          printf "%b test/busy.test.ts: not rerun: CI's answer is due (land.sh stops waiting then), so the run counts as a real red\\n" "$p"
        else
          printf '%b test/real.test.ts: failed again alone: a real failure\\n' "$p"
        fi ;;
    esac
    printf '%b the run still fails\\n' "$p" ;;
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
