// The throwaway repos and helpers land.test.ts, land-deploy.test.ts, land-queue.test.ts and land-handoff.test.ts share.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after } from 'node:test';
import { scriptEnv } from './script-env.ts';
import { git } from './git.ts';
import { quietProc } from './quiet-proc.ts';
export { git, quietProc };

// tools/land.sh on throwaway repos: a scheme repo on main, a minion worktree, and a live clone. The
// worktree's tools/deploy.sh is a stand-in that notes whether it got the lock, and fails on request. FAKE_DEPLOY_LOG gets
// main's commit for each deploy. FAKE_RESTART_GATE acts out deploy.sh's queued restart: it lets go of the line but not
// the restart lock, then waits for that file before the restart goes live (or, with FAKE_ROLLED_BACK, is rolled back and fails).
export const land = join(import.meta.dirname, '..', 'tools', 'land.sh');
export const root = mkdtempSync(join(tmpdir(), 'land-'));
after(() => rmSync(root, { recursive: true, force: true }));
// NODE_TEST_CONTEXT would make land.sh's own `node --test` report to this runner instead of exiting red;
// COORDINATOR_* would have the real deploy.sh report to the live server; CITADEL_HEAVY_* would queue it in the host's slots;
// The variables the scripts export (test/script-env.ts), set when a real land runs these tests, would have a test's deploy.sh skip its own lock
// ("flock: 9: Bad file descriptor") or its tests; an empty DEPLOY_TEST_CPU_WEIGHT makes no real systemd scope.
const quiet = quietProc(join(root, 'proc'));
export const env = { ...scriptEnv(), COORDINATOR_CONTAINER: undefined, COORDINATOR_SHARED_DIR: undefined, CITADEL_HEAVY_DIR: join(root, 'heavy'), LAND_QUIET_PROC: quiet, CITADEL_HEAVY_PRESSURE: join(quiet, 'pressure', 'cpu'), DEPLOY_TEST_CPU_WEIGHT: '', NODE_TEST_CONTEXT: undefined, COORDINATOR_TICKET: undefined, COORDINATOR_TOKEN: undefined, COORDINATOR_API: undefined, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };

let n = 0;
export function setup() {
  const dir = join(root, String(++n));
  const source = join(dir, 'repo');
  mkdirSync(join(source, 'tools'), { recursive: true });
  mkdirSync(join(source, 'test'));
  git(source, 'init', '-q', '-b', 'main');
  // TEST_RUNS: a file that gets a line per test run, naming the checkout it ran in; TEST_SEEN: its niceness and how many files run at once.
  writeFileSync(join(source, 'test', 'ok.test.mjs'), "import { appendFileSync } from 'node:fs';\nif (process.env.TEST_RUNS) appendFileSync(process.env.TEST_RUNS, process.cwd() + '\\n');\nif (process.env.TEST_SEEN) appendFileSync(process.env.TEST_SEEN, `nice ${(await import('node:os')).getPriority()} concurrency ${process.env.CITADEL_TEST_CONCURRENCY}\\n`);\nif (process.env.FAIL_TESTS) throw new Error('red');\n");
  writeFileSync(join(source, 'tools', 'deploy.sh'), `#!/usr/bin/env bash
lock=$(git -C "$DEPLOY_LIVE" rev-parse --absolute-git-dir)/cc-deploy/lock
flock -n "$lock" true && held=no || held=yes
echo "locked=$DEPLOY_LOCKED held=$held" >"$DEPLOY_NOTE"
until [ -z "\${FAKE_DEPLOY_GATE:-}" ] || [ -e "\$FAKE_DEPLOY_GATE" ]; do sleep 0.05; done
[ -z "\${FAKE_DEPLOY_LOG:-}" ] || git -C "$DEPLOY_SOURCE" rev-parse main >>"\$FAKE_DEPLOY_LOG"
if [ -n "\${FAKE_RESTART_GATE:-}" ]; then
  echo "queued \$(date +%s)" >>"\$DEPLOY_TIMES"
  rm -f "\$DEPLOY_QUEUE_TICKET"
  flock -u 9 # fd 7, the restart lock, stays held, as the restart unit holds it until its verdict
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
// after the push; FAKE_STEP is the step a red run failed in; FAKE_LOG which run-tests.sh lines a red run's log has (mixed, flakes, many, due: one file left unrerun at CI's deadline, or swap: the first red as mixed, later reds a new real failure with test/real.test.ts not rerun); FAKE_LEAK: it also has the leak guard's line (#1419); FAKE_LOG_RERUN: the log of every run after the first, when set
// (mixed: a flake and a real failure; flakes: two flakes and nothing else; many: too many files to rerun; after-real: mixed, then a
// file not rerun because a real failure already made the run red; two-real: mixed, and test/other.test.ts a second real failure, #1478).
// FAKE_REAL_FILE: the file the mixed log's real failure names (default test/real.test.ts); FAKE_RED_NAMES: a line the red's output adds, naming the file behind a guard's failure (a train's suspects, #1451);
// FAKE_RED_PATH: a run is red when its commit has that file, green otherwise (the ship train's bisect, #1166); FAKE_RED_TEXT: the same for
// a commit with that text in any file (#1403); FAKE_FLAKY_PATH:
// a commit with that file is red until a red run's log is read, then green (a train's flake-only red, #1346);
// FAKE_STEPS: the run's full suite and rerun steps as land.sh asks at its CI limit (#1374), "<name><tab><status><tab><conclusion>" lines;
// FAKE_BURN: the burn-in step as land.sh asks at its CI limit (#1443), "<status><tab><started_at><tab><completed_at>";
// FAKE_REAL: "<test file>=<path> ...": a run is red when its commit has any of the paths, and its log names each such test file
// a real failure (failed again alone), or with FAKE_LOG=burn a burn-in failure: a train with several bad ships (#1564);
// FAKE_LOG=burn: a red's log is the burn-in's: test/real.test.ts failed 3 of 10 copies at once (with a quoted run-tests.sh line);
// FAKE_CUT="<skip> <count>": of the finished runs GitHub lists, each commit and run id counted once in order, the <count>
// after the first <skip> are red with a log cut off before any test failed (#1377); FAKE_LOG=hung: a red whose log is a
// hang run-tests.sh stopped (the same interrupt, but a verdict); FAKE_CUT_KIND: how those runs were cut off, interrupt
// (default), killed (#1393: run-tests.sh's line for an outside SIGKILL, exit 137) or bare (the whole step killed, only
// GitHub's exit 137 line); FAKE_LOG=killed-red: killed from outside, but after a test had failed (a verdict);
// FAKE_LOG=killed-rerun: as after-real, but test/busy.test.ts's rerun alone was killed from outside (no label, #1393);
// FAKE_CI_GATE: every run stays in progress until that file exists; FAKE_RUNNERS_FILE: how many runners are online, read at each ask, or GitHub's runners
// JSON, which the --jq filter is run on.
// FAKE_CI_FILE: the run's state (as FAKE_CI) read from that file at each ask; FAKE_CI_DOWN_AT: GitHub doesn't answer for the
// Nth commit it is asked about and any after it, until the file FAKE_CI_UP exists. The wait's own runner checks (runners?per_page=,
// #1361) start no run, and answer FAKE_RUNNERS_WAIT when it is set, else as the check before a push.
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
    [ -z "\${FAKE_CI_FILE:-}" ] || FAKE_CI=$(cat "\$FAKE_CI_FILE")
    [ "\${FAKE_CI:-}" != down ] || exit 1
    [ "\${FAKE_CI:-}" != rate ] || { echo 'gh: API rate limit exceeded for installation ID 1. (HTTP 403)' >&2; exit 1; }
    [ "\${FAKE_CI:-}" != garbage ] || { echo '<html><body>Bad gateway</body></html>'; exit 0; }
    lag=0
    if [ -n "\${FAKE_LAG:-}" ] && [ "$(grep -c head_sha "${calls}")" -le "\$((FAKE_LAG + 1))" ]; then lag=1; fi
    n=$(grep -c '/actions/runners ' "${calls}") id=$((6 + n)) st=\${FAKE_CI:-green}
    if [ -n "\${FAKE_CI_DOWN_AT:-}" ] && [ ! -e "\$FAKE_CI_UP" ]; then
      grep -qx "$sha" "${calls}.shas" 2>/dev/null || echo "$sha" >>"${calls}.shas"
      [ "$(grep -nx "$sha" "${calls}.shas" | cut -d: -f1)" -lt "\$FAKE_CI_DOWN_AT" ] || exit 1
    fi
    [ "$n" -lt 2 ] || st=\${FAKE_CI_RERUN:-$st}
    # (a commit GitHub hasn't got yet has no run)
    if [ -n "\${FAKE_RED_PATH:-}" ]; then git -C "${hub}" cat-file -e "$sha^{commit}" 2>/dev/null || exit 0; git -C "${hub}" cat-file -e "$sha:\$FAKE_RED_PATH" 2>/dev/null && st=red || st=green; fi
    if [ -n "\${FAKE_RED_TEXT:-}" ]; then git -C "${hub}" cat-file -e "$sha^{commit}" 2>/dev/null || exit 0; git -C "${hub}" grep -qF "\$FAKE_RED_TEXT" "$sha" 2>/dev/null && st=red || st=green; fi
    if [ -n "\${FAKE_REAL:-}" ]; then git -C "${hub}" cat-file -e "$sha^{commit}" 2>/dev/null || exit 0; st=green; for e in \$FAKE_REAL; do git -C "${hub}" cat-file -e "$sha:\${e#*=}" 2>/dev/null && st=red; done; fi
    if [ -n "\${FAKE_FLAKY_PATH:-}" ]; then git -C "${hub}" cat-file -e "$sha^{commit}" 2>/dev/null || exit 0; git -C "${hub}" cat-file -e "$sha:\$FAKE_FLAKY_PATH" 2>/dev/null && [ ! -e "${calls}.flaky" ] && st=red; fi
    [ -z "\${FAKE_CI_GATE:-}" ] || [ -e "\$FAKE_CI_GATE" ] || st=running
    if [ "$lag" = 0 ] && [ "$n" -gt 0 ] && { [ -n "$(git -C "${hub}" for-each-ref --points-at "$sha" refs/heads/land/ 2>/dev/null)" ] || [ -z "\${FAKE_OLD_RUN:-}" ]; }; then
      if [ -n "\${FAKE_CUT:-}" ] && { [ "$st" = green ] || [ "$st" = red ]; }; then
        grep -qxF "$sha $id" "${calls}.seen" 2>/dev/null || echo "$sha $id" >>"${calls}.seen"
        k=$(grep -nxF "$sha $id" "${calls}.seen" | cut -d: -f1)
        read -r cs cn <<<"\$FAKE_CUT"
        [ "$k" -le "$cs" ] || [ "$k" -gt "$((cs + cn))" ] || st=red
      fi
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
  *"/actions/runners?"*) [ -z "\${FAKE_RUNNERS_WAIT:-}" ] || { echo "\$FAKE_RUNNERS_WAIT"; exit 0; }; [ "\${FAKE_RUNNERS:-1}" != down ] || exit 1; if [ -n "\${FAKE_RUNNERS_FILE:-}" ]; then cat "\$FAKE_RUNNERS_FILE"; else echo "\${FAKE_RUNNERS:-1}"; fi ;;
  *"/actions/runners "*) [ "\${FAKE_RUNNERS:-1}" != down ] || exit 1; [ "\${FAKE_RUNNERS:-1}" != garbage ] || { echo '<html>Bad gateway</html>'; exit 0; }; if [ -n "\${FAKE_RUNNERS_FILE:-}" ]; then if [ "$(head -c1 "\$FAKE_RUNNERS_FILE")" = '{' ]; then jq "$4" "\$FAKE_RUNNERS_FILE"; else cat "\$FAKE_RUNNERS_FILE"; fi; else echo "\${FAKE_RUNNERS:-1}"; fi ;;
  *"/actions/runs/"[0-9]*"/jobs "*"rerun failed files alone"*) printf '%b' "\${FAKE_STEPS:-}" ;;
  *"/actions/runs/"[0-9]*"/jobs "*"burn in new and changed tests"*) printf '%b' "\${FAKE_BURN:-}" ;;
  *"/actions/runs/"[0-9]*"/jobs "*) echo "\${FAKE_STEP:-the full suite}" ;;
  "run view "*)
    [ -z "\${FAKE_FLAKY_PATH:-}" ] || : >"${calls}.flaky"
    p='test\\tthe full suite\\t2026'
    # Cut off from outside (#1377, run 44859457680's log): Node's interrupt and the files it never ran, no failing test.
    sha=$(grep -o 'head_sha=[0-9a-f]*' "${calls}" | tail -n 1) sha=\${sha#head_sha=}
    k=$(grep -nxF "$sha $3" "${calls}.seen" 2>/dev/null | cut -d: -f1)
    read -r cs cn <<<"\${FAKE_CUT:-0 0}"
    if [ -n "$k" ] && [ "$k" -gt "$cs" ] && [ "$k" -le "$((cs + cn))" ]; then
      case \${FAKE_CUT_KIND:-interrupt} in
        killed) printf '%b ✔ fine (1.2ms)\\n%b run-tests: the tests were killed (exit 137) after 55s, before the 600s limit: stopped from outside (the out-of-memory killer?), not a hang, so this run says nothing about the change\\n%b ##[error]Process completed with exit code 137.\\n' "$p" "$p" "$p" ;;
        bare) printf '%b ✔ fine (1.2ms)\\n%b ##[error]Process completed with exit code 137.\\n' "$p" "$p" ;;
        *) printf '%b Interrupted while running:\\n%b ⚠ test/a.test.ts (test/a.test.ts:1:1)\\n%b ##[error]Process completed with exit code 1.\\n' "$p" "$p" "$p" ;;
      esac
      exit 0
    fi
    if [ "\${FAKE_LOG:-}" = killed-red ]; then # killed from outside after a test had failed: that failure is a verdict
      printf '%b ✖ broken (3.1ms)\\n%b run-tests: the tests were killed (exit 137) after 55s, before the 600s limit: stopped from outside (the out-of-memory killer?), not a hang, so this run says nothing about the change\\n%b ##[error]Process completed with exit code 137.\\n' "$p" "$p" "$p"
      exit 0
    fi
    if [ "\${FAKE_LOG:-}" = hung ]; then # run-tests.sh's timeout stopped a hung test: Node prints the same interrupt
      printf '%b Interrupted while running:\\n%b ⚠ test/a.test.ts (test/a.test.ts:1:1)\\n%b run-tests: the tests ran past 300s and were stopped: a test hung (the hung file is the one with no results above).\\n' "$p" "$p" "$p"
      exit 0
    fi
    [ "$3" = 7 ] || [ -z "\${FAKE_LOG_RERUN:-}" ] || FAKE_LOG=\$FAKE_LOG_RERUN
    if [ -n "\${FAKE_REAL:-}" ]; then # each test file whose path the run's commit has failed for real (#1564)
      rl=''; for e in \$FAKE_REAL; do git -C "${hub}" cat-file -e "$sha:\${e#*=}" 2>/dev/null && rl="$rl \${e%%=*}"; done
      echo "not ok 1 - the red test's output (run $3)"
      if [ "\${FAKE_LOG:-}" = burn ]; then
        for f in $rl; do printf '%b burn-in: %s: failed in 3 of 10 copies at once (copies 2 5 9), in 14 s\n' "$p" "$f"; done
      else
        printf '%b run-tests: %s test file(s) failed; rerunning each alone once to tell load from a real failure (the run fails either way; output in /tmp/tests-rerun.log)\n' "$p" "$(wc -w <<<"$rl")"
        for f in $rl; do printf '%b run-tests: %s: failed again alone: a real failure\n' "$p" "$f"; done
      fi
      exit 0
    fi
    if [ "\${FAKE_LOG:-}" = burn ]; then # the burn-in step's log: a land test burned in quotes run-tests.sh's lines
      printf '%b burn-in: test/real.test.ts, copy 2 of 10 (its output from the failing tests on):\n' "$p"
      echo "not ok 1 - the red test's output (run $3)"
      printf '%b land: run-tests: test/slow.test.ts: failed in the full run, passed alone: likely load, not your change (1-minute load 31.5)\n' "$p"
      printf '%b burn-in: test/real.test.ts: failed in 3 of 10 copies at once (copies 2 5 9), in 14 s\n' "$p"
      printf '%b burn-in: refused: a copy of test/real.test.ts failed when run 10 at once, so it is racy (its output is above); fix the race, not the wait\n' "$p"
      exit 0
    fi
    echo "not ok 1 - the red test's output (run $3)"
    [ -z "\${FAKE_RED_NAMES:-}" ] || echo "\$FAKE_RED_NAMES"
    p="$p run-tests:"
    lg=\${FAKE_LOG:-mixed}
    if [ "$lg" = swap ]; then [ -e "${calls}.swap" ] || echo "$3" >"${calls}.swap"; [ "$(cat "${calls}.swap")" = "$3" ] || lg=swapped; fi
    case $lg in
      many) printf '%b 7 test files failed: too many for load, so none is rerun\\n' "$p" ;;
      *)
        printf '%b %s test file(s) failed; rerunning each alone once to tell load from a real failure (the run fails either way; output in /tmp/tests-rerun.log)\\n' "$p" "$(case $lg in after-real | killed-rerun | swapped | two-real) echo 3 ;; *) echo 2 ;; esac)"
        printf '%b test/slow.test.ts: failed in the full run, passed alone: likely load, not your change (1-minute load 31.5)\\n' "$p"
        if [ "\${FAKE_LOG:-mixed}" = flakes ]; then
          printf '%b test/busy.test.ts: failed in the full run, passed alone: likely load, not your change (1-minute load 31.5)\\n' "$p"
        elif [ "\${FAKE_LOG:-mixed}" = due ]; then
          printf "%b test/busy.test.ts: not rerun: CI's answer is due (land.sh stops waiting then), so the run counts as a real red\\n" "$p"
        elif [ "$lg" = swapped ]; then # a later red: a new real failure first, so test/real.test.ts isn't rerun
          printf '%b test/other.test.ts: failed again alone: a real failure\\n' "$p"
          printf '%b test/real.test.ts: not rerun: a real failure already makes this run red\\n' "$p"
        else
          printf '%b %s: failed again alone: a real failure\\n' "$p" "\${FAKE_REAL_FILE:-test/real.test.ts}"
          [ "\${FAKE_LOG:-mixed}" != two-real ] || printf '%b test/other.test.ts: failed again alone: a real failure\\n' "$p"
          [ "\${FAKE_LOG:-mixed}" != after-real ] || printf '%b test/busy.test.ts: not rerun: a real failure already makes this run red\\n' "$p"
          [ "\${FAKE_LOG:-mixed}" != killed-rerun ] || printf '%b test/busy.test.ts: killed (exit 137) when rerun alone after 2s, before its 120s limit: stopped from outside, so it has no label (an unlabelled file keeps the run red)\\n' "$p"
        fi ;;
    esac
    [ -z "\${FAKE_LEAK:-}" ] || printf 'The tests left 1 process(es) running (now killed). Stop what a test starts before deleting its folder\\n'
    printf '%b the run still fails\\n' "$p" ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const testRuns = join(r.dir, 'test-runs');
  return {
    run: (extra: Record<string, string> = {}, args: string[] = [], cwd = r.wt) => r.run({ PATH: `${bin}:${process.env.PATH}`, LAND_CI: '1', LAND_CI_POLL: '0.1', TEST_RUNS: testRuns, ...extra }, args, cwd),
    // run, but asynchronous: seen(stderr so far) acts on what land.sh has said (#1254's busy perigee turns quiet).
    runAsync: (extra: Record<string, string>, seen: (stderr: string) => void) => landAsync(r.wt, { DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), PATH: `${bin}:${process.env.PATH}`, LAND_CI: '1', LAND_CI_POLL: '0.1', TEST_RUNS: testRuns, ...extra }, 90_000, seen),
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : ''),
    localRuns: () => (existsSync(testRuns) ? readFileSync(testRuns, 'utf8').trim().split('\n').length : 0),
    refs: () => git(hub, 'for-each-ref', '--format=%(refname)'),
  };
}

// The real deploy.sh and run-tests.sh on main, a boot check that passes, and stand-ins for systemd: the
// queued "restart" waits for the lock, then counts as live and checked (it tags last-good, and a roll back's writes its
// verdict, as the real one does; systemctl calls the unit active meanwhile). run() runs a script with them; runs() lists
// where the tests ran.
// health: more for /api/health to say, a function asked on each request with whether a SIGHUP came yet (reload: 'sighup'
// has the systemctl stand-in take one, noting it in <dir>/sighups; after it the stand-in reports the live checkout's HEAD,
// as the real server does).
export async function withRealDeploy(body: (r: ReturnType<typeof setup>, run: (script: string, cwd: string, extra?: Record<string, string>, args?: string[]) => Promise<{ stderr: string }>, runs: () => string[]) => Promise<void>, health: (hup: boolean) => Record<string, unknown> = () => ({})) {
  const r = setup();
  for (const f of ['deploy.sh', 'deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'suite-runner.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(import.meta.dirname, '..', 'tools', f), join(r.source, 'tools', f));
  writeFileSync(join(r.source, 'tools', 'boot-check.ts'), "console.log('v1');\n");
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'real deploy.sh');
  git(r.live, 'pull', '-q', '--ff-only');
  git(r.wt, 'rebase', '-q', 'main');
  const base = git(r.source, 'rev-parse', 'main');
  const bin = join(r.dir, 'bin');
  const restarted = join(r.dir, 'restarted');
  const testRuns = join(r.dir, 'test-runs');
  mkdirSync(bin);
  const active = JSON.stringify(join(r.dir, 'unit-active'));
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\ncase "$*" in *' kill -s HUP '*) echo "$*" >>${JSON.stringify(join(r.dir, 'sighups'))}; exit 0 ;;\n*'is-active -q cc-restart-when-idle'*) [ -e ${active} ]; exit ;; esac\nexit 1\n`);
  writeFileSync(join(bin, 'systemd-run'), `#!/usr/bin/env bash
state=$(git -C "$DEPLOY_LIVE" rev-parse --absolute-git-dir)/cc-deploy
echo "$*" >>${JSON.stringify(join(r.dir, 'systemd-run.args'))}
want=$(grep -o -- '--setenv=DEPLOY_TARGET=[0-9a-f]*' <<<"$*" | cut -d= -f3)
touch ${active}
(flock -w 20 "$state/restart.lock" true && echo got >${JSON.stringify(restarted)} && git -C "$DEPLOY_LIVE" tag -f last-good HEAD && { [ -z "$want" ] || echo "$want" >"$state/rolled-back"; }; rm -f ${active}) 7>&- >/dev/null 2>&1 &
`);
  for (const f of ['systemctl', 'systemd-run']) chmodSync(join(bin, f), 0o755);
  const sighups = join(r.dir, 'sighups');
  const server = createServer((_, res) => {
    const hup = existsSync(sighups);
    res.end(JSON.stringify({ ok: true, commit: existsSync(restarted) ? git(r.source, 'rev-parse', 'main') : hup ? git(r.live, 'rev-parse', 'HEAD') : base, ...health(hup) }));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const run = (script: string, cwd: string, extra: Record<string, string> = {}, args: string[] = []) => promisify(execFile)('bash', [script, ...args], {
      cwd, encoding: 'utf8',
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_URL: url, DEPLOY_DB: join(r.dir, 'none.db'), DEPLOY_REMOTE: '', TEST_RUNS: testRuns, ...extra },
    });
    const runs = () => (existsSync(testRuns) ? readFileSync(testRuns, 'utf8').trim().split('\n') : []);
    await body(r, run, runs);
  } finally {
    server.close();
  }
}

/** #1419: sightings of `files` on another branch, as land.sh's ci_failed writes them, in today's retro log (tools/known-flakes.ts reads them). */
export function seen(shared: string, files: string[], branch = 'ticket/7-other') {
  const now = new Date().toISOString();
  const dir = join(shared, 'retro-log', now.slice(0, 10));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'land.md'), files.map((f) => `- ${now.slice(11, 19)}Z · flake · ${f} · load 20.5 · ${branch} · in CI\n`).join(''), { flag: 'a' });
}
