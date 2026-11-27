// Part 2 of 4 of the land tests (#2208); the shared setup is in land-setup.ts.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { land, git, setup, landAsync, ci, quietProc } from './land-fixture.ts';
import { until } from './wait.ts';
import { landText } from './land-files.ts';
import { timings, stopped, cancels, hubHas, waits, procAt, once, RERUNNING, windowed, killer, landLog } from './land-setup.ts';

test('a stopped ship whose run GitHub never lists ends within its cap, scratch branches gone (#1894)', async () => {
  const s = await stopped({ LAND_CI_LATE: '3', LAND_CI_LATE_POLL: '0.2' }, waits);
  assert.deepEqual(cancels(s.calls), []);
  assert.ok(!hubHas(s.r, 'land/ticket/1-x'));
});

test('a ship stopped before it pushed asks GitHub nothing on its way out (#1894)', async () => {
  const s = await stopped(
    (r) => {
      spawnSync('mkfifo', [join(r.dir, 'runners')]); // nothing is ever written to it, so the question before the push never ends
      return { FAKE_RUNNERS_FILE: join(r.dir, 'runners') };
    },
    (c) => c.calls().includes('/actions/runners '),
  );
  assert.deepEqual(s.after, []);
});

test('a landing that gives up in line leaves a timing line too', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  mkdirSync(state, { recursive: true });
  const holder = spawn('bash', ['-c', 'exec 9>"$0"; flock 9; exec sleep 600', join(state, 'lock')], { stdio: 'ignore' });
  try {
    while (spawnSync('flock', ['-n', join(state, 'lock'), 'true']).status === 0) spawnSync('sleep', ['0.05']);
    const shared = join(r.dir, 'shared');
    const res = r.run({ COORDINATOR_SHARED_DIR: shared, DEPLOY_QUEUE_STALL: '1' });
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /nothing has moved/);
    assert.match(timings(shared).join('\n'), /^- \S+ · timing · ticket\/1-x · line \d+ · rebase - · ci-queue - · ci-run - · fallback - · deploy - · live - · refused at line$/);
  } finally {
    holder.kill('SIGKILL');
  }
});

test("a retro log that can't be written changes neither a landing's output nor its exit code", () => {
  const runs = ['', 'blocker'].map((shared) => {
    const r = setup();
    r.commit(r.wt, 'b.txt', 'mine\n');
    const blocker = join(r.dir, 'blocker');
    writeFileSync(blocker, 'a file, not a folder\n');
    const res = r.run({ COORDINATOR_SHARED_DIR: shared && blocker });
    assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
    return {
      status: res.status,
      stderr: res.stderr
        .replace(/\b[0-9a-f]{7,40}\b/g, 'H')
        .replace(/\d\d:\d\d/g, 'T')
        .replace(/\/\d+\//g, '/N/')
        .replace(/(passed in) \d+ s/g, '$1 N s')
        .replace(/its last \d+ run/g, 'its last N run'), // this file's ships share one history, so the second counts one more
    };
  });
  assert.deepEqual(runs[1], runs[0]);
  assert.equal(runs[0].status, 0);
});

// #1912: judged and logged as a ship joins the line, never acted on (tools/quick-train.ts).
test('a ship logs whether it would ride the quick train, and ships the same either way', () => {
  const r = setup();
  r.commit(r.source, 'tools/pipeline-files.txt', 'p.txt\n');
  r.commit(r.source, 'tools/affected-map.txt', '*.txt: test/a.test.ts\n');
  const lines = (dir: string) => landLog(dir).match(/quick train · .*/g);
  const go = (n: number, file: string, risk: string) => {
    r.commit(r.wt, file, `${n}\n`);
    const shared = join(r.dir, `shared-${n}`);
    const res = r.run({ COORDINATOR_SHARED_DIR: shared, LAND_RISK: risk });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
    assert.doesNotMatch(res.stdout + res.stderr, /quick train/, 'nothing of it reaches the landing itself');
    return lines(shared);
  };
  // The branch starts behind main and rebases onto it: the judge runs once, not again in the rebased copy.
  assert.deepEqual(go(1, 'b.txt', 'low'), ['quick train · ticket/1-x · would qualify']);
  assert.deepEqual(go(2, 'p.txt', 'low'), ['quick train · ticket/1-x · not: sensitive: pipeline (p.txt)']);
  assert.deepEqual(go(3, 'b.txt', ''), ['quick train · ticket/1-x · not: no risk label']);
  // A map that can't be read: the ship goes on, and the line says it wasn't judged.
  r.commit(r.source, 'tools/affected-map.txt', 'no colon here\n');
  assert.deepEqual(go(4, 'b.txt', 'low'), ['quick train · ticket/1-x · not: could not be judged']);
});

test('a run of this very commit that is already green lands at once; one that was red is run again', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  let res = c.run({ FAKE_OLD_RUN: `${tip} completed success`, FAKE_RUNNERS: '0' });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /CI FALLBACK/);
  assert.doesNotMatch(c.calls(), /runners/, 'no new run was asked for');
  assert.equal(c.localRuns(), 0);

  const r2 = setup();
  const c2 = ci(r2);
  r2.commit(r2.wt, 'b.txt', 'mine\n');
  // GitHub takes a moment to list the new run: until then it still answers with the old red one, which is no verdict.
  res = c2.run({ FAKE_OLD_RUN: `${git(r2.wt, 'rev-parse', 'HEAD')} completed failure`, FAKE_LAG: '2' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI passed on .*ci\/7/);
  assert.equal(c2.localRuns(), 0);
  assert.ok(
    c2
      .calls()
      .split('\n')
      .filter((l) => l.includes('head_sha')).length >= 4,
    'it polled past the old run',
  );
});

test('red CI refuses with main untouched, shows the failed log, and never falls back to a run here', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  const res = c.run({ FAKE_CI: 'red', COORDINATOR_SHARED_DIR: shared }); // a flake and a real failure
  assert.equal(res.status, 1);
  assert.match(landLog(shared), /· flake · test\/slow\.test\.ts · load 31\.5 · ticket\/1-x · in CI$/m, 'a flake CI labelled reaches the retro log');
  assert.match(landLog(shared), /· timing · ticket\/1-x · line \d+ · rebase \d+ · ci-queue \d+ · ci-run \d+ · fallback - · deploy - · live - · refused at ci$/m);
  assert.match(res.stderr, /the red test's output \(run 7\)\n.*real\.test\.ts: failed again alone.*\nland: tests failed on the rebased branch in CI \(https:\/\/ci\/7\), so main is untouched\n$/s);
  assert.doesNotMatch(res.stderr, /CI FALLBACK|once more/);
  assert.doesNotMatch(landLog(shared), /· flake rerun ·/, 'a real failure gets no fresh run');
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    1,
    'one run only',
  );
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.equal(c.localRuns(), 0);
  assert.equal(c.refs(), '');
  assert.equal(r.note(), null);
});

// #1240: a ship's CI run stops rerunning files alone when its answer is due, so a file left unrerun has no "passed
// alone" label: the run is a real red, refused at once, with no fresh run and no fallback to the suite here.
test("a red whose reruns alone were cut at CI's deadline is a real red: refused, not run again, not run here", () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  const res = c.run({ FAKE_CI: 'red', FAKE_CI_RERUN: 'green', FAKE_LOG: 'due', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /busy\.test\.ts: not rerun: CI's answer is due.*\nland: tests failed on the rebased branch in CI \(https:\/\/ci\/7\), so main is untouched\n$/s);
  assert.doesNotMatch(res.stderr, /CI FALLBACK|once more/);
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    1,
    'one run only',
  );
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.equal(c.localRuns(), 0);
});

// #769 (Cara, 2026-11-15, #767's card: "2 Rerun CI on flake-only red"): a red in which every failed file passed alone
// gets one fresh run of the same commit, and only a fully green one lands.
test('a red of flakes only gets one fresh CI run, and lands when that run is green', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const res = c.run({ FAKE_CI: 'red', FAKE_CI_RERUN: 'green', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /failed in the full run but passed alone \(test\/busy\.test\.ts, test\/slow\.test\.ts\); running CI once more on \w+, the land needs a fully green run\n.*CI passed on \w+ in \d+s \(https:\/\/ci\/8\)/s);
  assert.doesNotMatch(res.stderr, /CI FALLBACK/);
  // src/flakes.ts parses these lines (a pipeline test can't import it; test/flakes.test.ts pins the same format).
  assert.match(res.stderr, /^land: flake: test\/busy\.test\.ts · in CI$/m);
  assert.match(res.stderr, /^land: flake: test\/slow\.test\.ts · in CI$/m);
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    2,
    'a second push, so a new run',
  );
  assert.match(landLog(shared), /· flake rerun · ticket\/1-x · test\/busy\.test\.ts, test\/slow\.test\.ts · green$/m);
  assert.match(landLog(shared), /· timing · ticket\/1-x · line \d+ · rebase \d+ · ci-queue \d+ · ci-run \d+ · fallback - · deploy \d+ · live \d+ · landed$/m);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  assert.equal(c.localRuns(), 0);
  assert.equal(c.refs(), '', 'nothing is left on GitHub');
});

test('a red of flakes only whose fresh run is red again refuses, whatever its labels say, and is not run a third time', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  // Both runs red, both of flakes only, on a hand-off that already kept its place twice (#1419 part 2: before that it would
  // keep its place again; test/land-known-flakes.test.ts has those).
  const res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared, LAND_FLAKE_KEPT: '2' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /running CI once more.*the red test's output \(run 8\).*tests failed on the rebased branch in CI again \(https:\/\/ci\/8\), on the one fresh run after a red whose files all passed alone \(test\/busy\.test\.ts, test\/slow\.test\.ts\), so main is untouched/s);
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    2,
    'two runs, never three',
  );
  assert.equal(res.stderr.match(/once more/g)!.length, 1);
  assert.match(landLog(shared), /· flake rerun · ticket\/1-x · test\/busy\.test\.ts, test\/slow\.test\.ts · red$/m);
  assert.doesNotMatch(res.stderr, /CI FALLBACK/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.equal(c.localRuns(), 0);
  assert.equal(c.refs(), '');
});

test("a red of flakes only stays red when the scratch branch can't be deleted for the fresh run, rather than wait on a run never started", () => {
  const r = setup();
  const c = ci(r);
  // GitHub refuses the delete: pushing the same commit again would start no run.
  writeFileSync(join(r.dir, 'hub.git', 'hooks', 'pre-receive'), '#!/bin/sh\nwhile read -r old new ref; do case $new in *[!0]*) ;; *) echo "deletes refused" >&2; exit 1 ;; esac; done\n', { mode: 0o755 });
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const res = c.run({ FAKE_CI: 'red', FAKE_CI_RERUN: 'green', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  assert.match(
    res.stderr,
    /failed in the full run but passed alone \(test\/busy\.test\.ts, test\/slow\.test\.ts\), but deleting land\/ticket\/1-x on GitHub to start a fresh run failed \(.*deletes refused.*\), so this stays red\nland: tests failed on the rebased branch in CI \(https:\/\/ci\/7\), so main is untouched\n$/s,
  );
  assert.doesNotMatch(res.stderr, /CI FALLBACK|once more/);
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    1,
    'no second run asked for',
  );
  assert.match(landLog(shared), /· flake rerun · ticket\/1-x · .* · not started$/m);
  assert.equal(c.localRuns(), 0);
});

test('a red with no rerun labels (too many files failed) refuses at once, and a fresh run that gets no answer falls back to the run here', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  let res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'many' });
  assert.equal(res.status, 1);
  assert.doesNotMatch(res.stderr, /once more/);
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    1,
  );

  const r2 = setup();
  const c2 = ci(r2);
  r2.commit(r2.wt, 'b.txt', 'mine\n');
  const shared = join(r2.dir, 'shared');
  res = c2.run({ FAKE_CI: 'red', FAKE_CI_RERUN: 'queued', LAND_CI_START: '1', FAKE_RUNNERS_WAIT: '0', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /running CI once more.*CI FALLBACK: no runner started the job within 1s/s);
  assert.match(landLog(shared), /· flake rerun · ticket\/1-x · .* · no answer$/m);
  assert.equal(c2.localRuns(), 1, 'the fallback suite here had to pass');
});

// #1377 (#1372's report: run 44859457680 was interrupted at 55 s with no failing test, and a bisect refused #1302 for
// it): a run cut off from outside says nothing about the commit. It gets one fresh run; cut off again, it is no answer.
test('a run cut off before any test failed is no verdict: one fresh run decides, and a second cut-off is no answer', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  let res = c.run({ FAKE_CUT: '0 1', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /the CI run on \w+ was cut off before any test failed \(https:\/\/ci\/7\), so it says nothing about this commit: running CI once more\n.*CI passed on \w+ in \d+s \(https:\/\/ci\/8\)/s);
  assert.doesNotMatch(res.stderr, /CI FALLBACK|tests failed/);
  assert.match(landLog(shared), /· cut-off rerun · ticket\/1-x · https:\/\/ci\/7 · green$/m);
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    2,
  );
  assert.equal(c.localRuns(), 0);
  assert.equal(c.refs(), '');

  // Both cut off: no answer, so it falls back to the suite here, as for any CI that can't answer.
  const r2 = setup();
  const c2 = ci(r2);
  r2.commit(r2.wt, 'b.txt', 'mine\n');
  const shared2 = join(r2.dir, 'shared');
  res = c2.run({ FAKE_CUT: '0 2', COORDINATOR_SHARED_DIR: shared2 });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI FALLBACK: CI was cut off twice before any test failed \(https:\/\/ci\/7, https:\/\/ci\/8\)/);
  assert.doesNotMatch(res.stderr, /tests failed/);
  assert.match(landLog(shared2), /· cut-off rerun · ticket\/1-x · https:\/\/ci\/7 · no answer$/m);
  assert.equal(
    c2
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    2,
    'never a third run',
  );
  assert.equal(c2.localRuns(), 1, 'the fallback suite here had to pass');
});

test('a hang run-tests.sh stopped prints the same interrupt but is a real red: refused, not run again', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'hung' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /a test hung.*\nland: tests failed on the rebased branch in CI \(https:\/\/ci\/7\), so main is untouched\n$/s);
  assert.doesNotMatch(res.stderr, /cut off|once more|CI FALLBACK/);
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    1,
  );
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

// #1393: a run killed from outside (exit 137, the desktop's out-of-memory killer) before any test failed is a lost run,
// as #1377's cut-off one: run-tests.sh's killed line, or only GitHub's exit 137 line when the whole step was killed.
test('a CI run killed from outside before any test failed is no verdict: one fresh run decides', () => {
  for (const kind of ['killed', 'bare']) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const shared = join(r.dir, 'shared');
    const res = c.run({ FAKE_CUT: '0 1', FAKE_CUT_KIND: kind, COORDINATOR_SHARED_DIR: shared });
    assert.equal(res.status, 0, `${kind}: ${res.stderr}`);
    assert.match(res.stderr, /the CI run on \w+ was cut off before any test failed \(https:\/\/ci\/7\), so it says nothing about this commit: running CI once more\n.*CI passed on \w+ in \d+s \(https:\/\/ci\/8\)/s, kind);
    assert.doesNotMatch(res.stderr, /CI FALLBACK|tests failed|a test hung/, kind);
    assert.match(landLog(shared), /· cut-off rerun · ticket\/1-x · https:\/\/ci\/7 · green$/m, kind);
  }
});

// #1864 (DR1): a runner that went away fails its job with no step of it failed, so the red says nothing about the commit.
test('a CI run that lost its runner is no verdict: one fresh run decides, and a second lost one is no answer', () => {
  for (const [cut, result, fallback] of [
    ['0 1', 'green', 0],
    ['0 2', 'no answer', 1],
  ] as const) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const shared = join(r.dir, 'shared');
    const res = c.run({ FAKE_CUT: cut, FAKE_CUT_KIND: 'lost', COORDINATOR_SHARED_DIR: shared });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /the CI run on \w+ lost its runner before any step failed \(https:\/\/ci\/7\), so it says nothing about this commit: running CI once more/);
    assert.doesNotMatch(res.stderr, /tests failed/);
    if (fallback) assert.match(res.stderr, /CI FALLBACK: CI's one fresh run lost its runner before any step failed \(https:\/\/ci\/8\), after one that lost its runner before any step failed \(https:\/\/ci\/7\)/);
    assert.match(landLog(shared), new RegExp(`· cut-off rerun · ticket/1-x · https://ci/7 · ${result}$`, 'm'));
    assert.equal(c.localRuns(), fallback);
  }
});

test("a question about a red run that GitHub misses is asked again: the run's own step still decides", () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = c.run({ FAKE_CI: 'red', FAKE_STEP: "the runner user's systemd", FAKE_STEP_MISS: '2' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /failed in its setup step "the runner user's systemd"/);
});

// #1864 (LB6): the Windows port check runs after a green suite and measures the PC, not the change.
test("a run red only in the check of the PC's own ports counts as green, and says so", () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const res = c.run({ FAKE_CI: 'red', FAKE_STEP: 'Windows ports left behind', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI's full suite passed on \w+, and then its check of the PC's own ports went red .*it counts as green \(https:\/\/ci\/7\)/);
  assert.doesNotMatch(res.stderr, /CI FALLBACK|tests failed/);
  assert.match(landLog(shared), /· CI ports red · ticket\/1-x · counted as green · https:\/\/ci\/7$/m);
  assert.equal(c.localRuns(), 0);
});

// The step's name in land.sh is the workflow's.
test('the ports step land.sh counts as green is the one tests.yml runs after a green suite', () => {
  const name = (text: string) => /^ *(?:CITADEL_)?CI_PORTS_STEP='([^']+)'/m.exec(text)?.[1];
  const step = name(landText())!;
  assert.match(readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'tests.yml'), 'utf8'), new RegExp(`- name: ${step}\n {8}if: \\$\\{\\{ success\\(\\) \\}\\}`));
});

test('a CI run killed from outside after a test had failed is a real red: refused, not run again', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'killed-red' });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /land: tests failed on the rebased branch in CI \(https:\/\/ci\/7\), so main is untouched\n$/);
  assert.doesNotMatch(res.stderr, /cut off|once more|CI FALLBACK/);
  assert.equal(
    c
      .calls()
      .split('\n')
      .filter((l) => l.includes('/actions/runners ')).length,
    1,
  );
});

test('when CI cannot answer, it says so loudly, logs it, runs the suite here and lands', async (t) => {
  const cases: [string, Record<string, string>, RegExp][] = [
    ['no runner online', { FAKE_RUNNERS: '0' }, /no citadel-ci-linux runner is online/],
    ['GitHub down', { FAKE_CI: 'down' }, /GitHub didn't answer/],
    ['GitHub down, and it says nothing of the hour either (#1722)', { FAKE_CI: 'down', FAKE_QUOTA: 'down' }, /GitHub didn't answer/],
    ['the runner list fails', { FAKE_RUNNERS: 'down' }, /didn't say which runners are online/],
    ['no runner starts the job, and none is online', { FAKE_CI: 'queued', LAND_CI_START: '1', FAKE_RUNNERS_WAIT: '0' }, /no runner started the job within 1s, and no citadel-ci-linux runner is online/],
    ['a runner is online but starts no job in the longer bound', { FAKE_CI: 'queued', LAND_CI_START: '1', LAND_CI_START_ONLINE: '2' }, /no runner started the job within 2s, though a citadel-ci-linux runner is online/],
    ['the run never finishes', { FAKE_CI: 'running', LAND_CI_TIMEOUT: '1' }, /CI didn't finish within 1s of starting/],
    ['GitHub stops answering while CI runs (#1655)', { FAKE_CI: 'running', FAKE_CI_FAIL_AFTER: '2', LAND_CI_TIMEOUT: '4' }, /CI FALLBACK: GitHub didn't answer since \d\d:\d\d \(\d+ polls failed in a row\) \(gh: API rate limit exceeded.*, so it isn't known whether CI finished/],
    ['the run was cancelled', { FAKE_CI: 'cancelled' }, /ended as cancelled/],
    ['the run failed before the tests', { FAKE_CI: 'red', FAKE_STEP: "the runner user's systemd" }, /failed in its setup step "the runner user's systemd", before any test ran/],
    ["GitHub doesn't say which step failed (#1864)", { FAKE_CI: 'red', FAKE_STEP: 'down' }, /CI FALLBACK: GitHub didn't say which step of the red CI run failed \(https:\/\/ci\/7\), so it isn't known whether its tests are red/],
    ["GitHub doesn't send the red run's log (#1864)", { FAKE_CI: 'red', FAKE_LOG: 'down' }, /CI FALLBACK: GitHub didn't send the red CI run's log \(https:\/\/ci\/7\)/],
    ["the runner's clock stayed skewed", { FAKE_CI: 'red', FAKE_STEP: "the runner's clock" }, /CI FALLBACK: runner clock: the CI runner's clock stayed skewed for 2 min, so no test ran/],
    ['LAND_CI=0', { LAND_CI: '0' }, /LAND_CI=0 was set/],
  ];
  for (const [name, extra, why] of cases) {
    await t.test(name, () => {
      const r = setup();
      const c = ci(r);
      r.commit(r.wt, 'b.txt', 'mine\n');
      const shared = join(r.dir, 'shared');
      const res = c.run({ COORDINATOR_SHARED_DIR: shared, ...extra });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, /={20,}\nland: CI FALLBACK: .*Running the full suite on perigee instead\.\nland: BURN-IN SKIPPED: new and changed tests were not run as 10 copies at once, since that runs only on CI, never on perigee \(#1443\)\nland: ={20,}\nland: running the tests/);
      assert.match(res.stderr, why);
      assert.match(res.stderr.trimEnd().split('\n').at(-1)!, /landed on perigee's own test run, not CI: /, 'the last line says it again');
      assert.match(landLog(shared), /^- \d\d:\d\d:\d\dZ · ci fallback · ticket\/1-x · /m);
      // #1722: once GitHub was asked at all, the fallback line ends with what was left of the hour.
      const left = extra.FAKE_QUOTA === 'down' ? 'unknown' : '4321/5000, resets in 25 min';
      if (extra.LAND_CI !== '0')
        assert.ok(
          landLog(shared)
            .split('\n')
            .some((l) => l.includes(' · ci fallback · ticket/1-x · ') && l.endsWith(` · GitHub calls left: ${left}`)),
          landLog(shared),
        );
      assert.match(landLog(shared), /· timing · ticket\/1-x · line \d+ · rebase \d+ · ci-queue - · ci-run - · fallback \d+\+\d+ · deploy \d+ · live \d+ · landed$/m);
      assert.equal(c.localRuns(), 1);
      assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
      assert.equal(c.refs(), '', 'nothing is left on GitHub');
      // A run nobody waits for any more is cancelled, so it doesn't keep the one runner from the next landing.
      if (extra.FAKE_CI === 'queued' || extra.FAKE_CI === 'running') assert.match(c.calls(), /-X POST repos\/.*\/actions\/runs\/7\/cancel/);
      if (extra.LAND_CI === '0') assert.equal(c.calls(), '', 'GitHub is never asked');
      if (extra.FAKE_CI_FAIL_AFTER) assert.match(readFileSync(join(r.live, '.git', 'cc-deploy', 'gh-calls'), 'utf8'), /^\d+ ticket\/1-x api repos\/\S+\/actions\/runs/m, 'each gh call is counted with its landing (#1655)');
    });
  }
});

// F12d: CI's own reason reaches the landing: a rate limit, an error page or a rejected push all read "GitHub didn't answer"
// or "no runner started the job" before, and an error page waited out the full 90 s.
test("when CI can't answer, the fallback says what gh or git said, at once", async (t) => {
  const cases: [string, Record<string, string>, RegExp][] = [
    ['a rate limit', { FAKE_CI: 'rate' }, /CI FALLBACK: GitHub didn't answer \(gh: API rate limit exceeded for installation ID 1\. \(HTTP 403\)\)/],
    ['an error page for the runs', { FAKE_CI: 'garbage' }, /CI FALLBACK: GitHub didn't answer \(it sent something that isn't a run: <html><body>Bad gateway/],
    ['an error page for the runners', { FAKE_CI: 'queued', FAKE_RUNNERS: 'garbage' }, /CI FALLBACK: GitHub didn't say which runners are online \(it sent: <html>Bad gateway<\/html>\)/],
    ['a rejected push', { FAKE_CI: 'queued', REJECT: '1' }, /CI FALLBACK: pushing \w+ to GitHub failed \(remote: denied by the test hook; .*\)/],
  ];
  for (const [name, extra, why] of cases) {
    await t.test(name, () => {
      const r = setup();
      const c = ci(r);
      if (extra.REJECT) writeFileSync(join(r.dir, 'hub.git', 'hooks', 'pre-receive'), "#!/bin/sh\necho 'denied by the test hook' >&2\nexit 1\n", { mode: 0o755 });
      r.commit(r.wt, 'b.txt', 'mine\n');
      const t0 = Date.now();
      const res = c.run(extra);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, why);
      assert.ok(Date.now() - t0 < 60_000, 'it does not wait out the 90 s for a runner');
      assert.equal(c.localRuns(), 1);
    });
  }
});

// M14: after a refusal, cancelling the CI run and deleting land/<branch> ran before the landing left the line, so a
// hung gh or push held the deploy lock up to 60 s more.
test('a refused landing lets go of the deploy lock before it cleans up on GitHub', { timeout: 60_000 }, async (t) => {
  const r = setup();
  const c = ci(r);
  // Deleting the scratch branch hangs until the test opens the gate, once it has seen the lock free (a fixed 8 s, twice, before #1615).
  const gate = join(r.dir, 'cleanup-go');
  writeFileSync(join(r.dir, 'hub.git', 'hooks', 'pre-receive'), `#!/bin/sh\nwhile read old new ref; do [ "$new" != 0000000000000000000000000000000000000000 ] || until [ -e '${gate}' ]; do sleep 0.05; done; done\n`, { mode: 0o755 });
  r.commit(r.wt, 'b.txt', 'mine\n');
  const lock = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'lock');
  let stderr = '';
  let ended = false;
  const landing = landAsync(r.wt, { DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), PATH: `${join(r.dir, 'bin')}:${process.env.PATH}`, LAND_CI: '1', LAND_CI_POLL: '0.1', FAKE_CI: 'red' }, 50_000, (e) => (stderr = e)).finally(() => (ended = true));
  t.after(async () => {
    writeFileSync(gate, '');
    await landing;
  }); // a failed wait below still lets the hook, and the landing, end
  await until(
    'the refusal',
    () => /tests failed on the rebased branch in CI/.test(stderr),
    30_000,
    () => stderr,
  );
  await until(
    'the lock to be free',
    () => spawnSync('flock', ['-n', lock, 'true']).status === 0,
    4_000,
    () => stderr,
  );
  assert.ok(!ended, 'freed while the cleanup still runs');
  writeFileSync(gate, '');
  const res = await landing;
  assert.equal(res.status, 1, res.stderr);
  assert.equal(c.refs(), '', 'the scratch branch still goes');
});

// F11: with CI stuck, every landing in line waited its own 90 s (or 6 min) to learn the same thing.
test('after CI gave no answer in time, the landings of the next minutes skip the wait and say why; past that CI is asked again, and a green run clears it', () => {
  const r = setup();
  const c = ci(r);
  const down = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'ci-down');
  r.commit(r.wt, 'b.txt', 'one\n');
  let res = c.run({ FAKE_CI: 'queued', LAND_CI_START: '1', FAKE_RUNNERS_WAIT: '0' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(down), 'the first landing leaves a note');
  const asked = c.calls();
  r.commit(r.wt, 'b.txt', 'two\n');
  res = c.run({ FAKE_CI: 'queued', LAND_CI_START: '30' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI FALLBACK: CI gave no answer to a landing \d+ s ago \(no runner started the job within 1s, and no citadel-ci-linux runner is online .*\), so this one doesn't wait for it \(it is asked again from \d\d:\d\d\)/);
  assert.equal(c.calls(), asked, 'GitHub is not asked');
  assert.equal(c.localRuns(), 2);
  r.commit(r.wt, 'b.txt', 'three\n');
  res = c.run({ LAND_CI_DOWN: '0' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI passed/);
  assert.ok(!existsSync(down), 'a green run takes the note away');
  assert.equal(c.localRuns(), 2);
});

test("on a quiet perigee the fallback runs the suite in citadel-heavy's slot, named, and lands", () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const p = procAt(r);
  const seen = join(r.dir, 'seen');
  const res = c.run({ FAKE_CI: 'queued', LAND_CI_START: '1', FAKE_RUNNERS_WAIT: '0', TEST_SEEN: seen, ...p });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI FALLBACK: no runner started the job within 1s/);
  const cores = Number(spawnSync('nproc', { encoding: 'utf8' }).stdout.trim());
  // nice 19, and half run-tests.sh's usual (cores + 1) / 2 files at once (the fixture's empty CPU weight makes no scope).
  assert.equal(readFileSync(seen, 'utf8'), `nice 19 concurrency ${Math.floor((Math.floor((cores + 1) / 2) + 1) / 2)}\n`);
  assert.doesNotMatch(res.stderr, /perigee is busy/);
  assert.equal(c.localRuns(), 1);
  assert.match(readFileSync(join(p.CITADEL_HEAVY_DIR, 'history'), 'utf8'), /\tland\.sh's suite for ticket\/1-x \(CI fallback\)\t/, 'the run held the heavy slot');
});

test('on a busy perigee the ship keeps waiting for CI, and lands on its answer without running the suite here', async () => {
  for (const [name, o] of [
    ['CPU pressure', { psi: 60 }],
    ['load', { load: 999 }],
    ['memory', { freePct: 5 }],
  ] as const) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const gate = join(r.dir, 'ci-gate');
    const res = await c.runAsync(
      { FAKE_CI: 'green', FAKE_CI_GATE: gate, LAND_CI_TIMEOUT: '1', LAND_QUIET_POLL: '0.2', ...procAt(r, o) },
      once(() => writeFileSync(gate, '')),
    );
    assert.equal(res.status, 0, `${name}: ${res.stderr}`);
    assert.match(res.stderr, /waiting for CI or a quiet perigee: CI: CI didn't finish within 1s of starting, but perigee is busy \(.+\), so this keeps asking CI/, name);
    assert.match(res.stderr, /CI passed/, name);
    assert.doesNotMatch(res.stderr, /CI FALLBACK/, name);
    assert.equal(c.localRuns(), 0, name);
  }
});

test("a run rerunning its failed files alone at CI's limit gets the reruns' window, and a red of flakes only lands on its fresh run", async () => {
  // Reruns that ended in the moment between the gate's two looks count too: the next look reads the run's verdict.
  for (const steps of [RERUNNING, 'the full suite\tcompleted\tfailure\nrerun failed files alone\tcompleted\tsuccess\n']) await windowed(steps);
});

test("a run still in its full suite at CI's limit falls back then, as before: the reruns' window is only for reruns under way", () => {
  for (const steps of ['the full suite\tin_progress\t-\nrerun failed files alone\tqueued\t-\n', '']) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const res = c.run({ FAKE_CI: 'running', FAKE_STEPS: steps, LAND_CI_TIMEOUT: '1', LAND_CI_RERUN: '600', ...procAt(r) });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /CI FALLBACK: CI didn't finish within 1s/);
    assert.doesNotMatch(res.stderr, /rerunning the failed files alone/);
    assert.equal(c.localRuns(), 1);
  }
});

test('reruns alone that outlast their window fall back at its end, once: the window is never extended again', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = c.run({ FAKE_CI: 'running', FAKE_STEPS: RERUNNING, LAND_CI_TIMEOUT: '1', LAND_CI_RERUN: '1', ...procAt(r) });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr.match(/rerunning the failed files alone/g)?.length, 1, res.stderr);
  assert.match(res.stderr, /CI FALLBACK: CI didn't finish within \d+s of starting, its reruns alone included/);
  assert.equal(c.localRuns(), 1);
});

test('with no runner online and a busy perigee, the ship asks CI again until a runner is back, and lands on CI', async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const runners = join(r.dir, 'runners');
  writeFileSync(runners, '0');
  const res = await c.runAsync(
    { FAKE_RUNNERS_FILE: runners, LAND_QUIET_POLL: '0.2', ...procAt(r, { load: 999 }) },
    once(() => writeFileSync(runners, '1')),
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI: no citadel-ci-linux runner is online.*but perigee is busy/);
  assert.match(res.stderr, /CI passed/);
  assert.doesNotMatch(res.stderr, /CI FALLBACK/);
  assert.equal(c.localRuns(), 0);
});

test('a busy perigee that turns quiet runs the suite then, whether CI was waited on or never asked', async () => {
  for (const extra of [{ FAKE_CI: 'queued', LAND_CI_START: '1', FAKE_RUNNERS_WAIT: '0' }, { LAND_CI: '0' }]) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const p = procAt(r, { psi: 60 });
    const res = await c.runAsync(
      { ...extra, ...p, LAND_QUIET_POLL: '0.2' },
      once(() => quietProc(p.LAND_QUIET_PROC)),
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /but perigee is busy \(CPU pressure 60% \(quiet is under 20%\)\).*CI FALLBACK/s);
    assert.equal(c.localRuns(), 1);
    assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  }
});

// quiet() reads the load to the hundredth, and a reading it can't take counts as busy.
test('quiet is under half the cores to the hundredth of a load, and a missing reading is busy', () => {
  const cores = Number(spawnSync('nproc', { encoding: 'utf8' }).stdout.trim());
  for (const [name, load, gone, busy] of [
    ['just under half', cores / 2 - 0.01, '', null],
    ['exactly half', cores / 2, '', new RegExp(`load ${(cores / 2).toFixed(2)} on ${cores} cores`)],
    ['no pressure file', 0, 'pressure/cpu', /no CPU pressure reading/],
    ['no meminfo', 0, 'meminfo', /no memory reading/],
  ] as const) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const p = procAt(r, { load });
    if (gone) rmSync(join(p.LAND_QUIET_PROC, gone));
    const res = c.run({ LAND_CI: '0', LAND_QUIET_LIMIT: '0', ...p });
    if (busy) {
      assert.equal(res.status, 1, `${name}: ${res.stderr}`);
      assert.match(res.stderr, busy, name);
      assert.equal(c.localRuns(), 0, name);
    } else {
      assert.equal(res.status, 0, `${name}: ${res.stderr}`);
      assert.equal(c.localRuns(), 1, name);
    }
  }
});
