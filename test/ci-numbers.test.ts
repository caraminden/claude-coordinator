// CI numbers kept per commit, and the step-up flag (#1369, src/ci-numbers.ts).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CiNumbers, LIMITS, parseNumbers, stepUp } from '../src/ci-numbers.ts';
import type { RunClaims } from '../src/ci-store.ts';
import { Store } from '../src/db.ts';

const root = mkdtempSync(join(tmpdir(), 'ci-numbers-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('a step up flags only once it has held for three runs, over 5% and past the series\' noise', () => {
  const steady = [100, 101, 99, 100, 102, 98, 100, 101, 99, 100];
  assert.equal(stepUp(steady), null);
  // One noisy run, then two: never three in a row.
  assert.equal(stepUp([...steady, 120]), null);
  assert.equal(stepUp([...steady, 120, 121]), null);
  assert.equal(stepUp([...steady, 120, 99, 121, 122]), null);
  const step = stepUp([...steady, 120, 121, 119]);
  assert.ok(step);
  assert.equal(step.baseline, 100);
  assert.equal(step.level, 120);
  // Under 5% doesn't flag, however steady the series.
  assert.equal(stepUp([...Array(10).fill(100), 104, 104, 104]), null);
  assert.ok(stepUp([...Array(10).fill(100), 106, 106, 106]));
  // A jumpy series (runs ±15 apart) needs more than 5%: 3 × its median wobble.
  const jumpy = [100, 85, 115, 100, 85, 115, 100, 85, 115, 100];
  assert.equal(stepUp([...jumpy, 110, 112, 111]), null);
  assert.ok(stepUp([...jumpy, 150, 152, 151]));
  // The baseline is all 10 runs before: 9 are too few to call anything usual. A step down is never flagged.
  assert.equal(stepUp([100, 100, 100, 130, 130, 130]), null);
  assert.equal(stepUp([...Array(9).fill(100), 130, 130, 130]), null);
  assert.ok(stepUp([...Array(10).fill(100), 130, 130, 130]));
  assert.equal(stepUp([...steady, 80, 80, 80]), null);
});

test('an upload is a few named numbers with units, and big or odd ones are refused', () => {
  assert.deepEqual(parseNumbers({ numbers: [{ name: 'startup', value: 412, unit: 'ms' }, { name: 'apk-size', value: 12.5, unit: 'MB' }, { name: 'tests', value: 3 }] }), [
    { name: 'startup', value: 412, unit: 'ms' },
    { name: 'apk-size', value: 12.5, unit: 'MB' },
    { name: 'tests', value: 3, unit: '' },
  ]);
  const refused = (body: unknown, status: number, why: RegExp) =>
    assert.throws(() => parseNumbers(body), (err: any) => err.status === status && why.test(err.message), String(why));
  refused({}, 400, /numbers/);
  refused({ numbers: [] }, 400, /numbers/);
  refused({ numbers: Array.from({ length: LIMITS.perUpload + 1 }, (_, i) => ({ name: `n${i}`, value: 1 })) }, 413, /at most/);
  refused({ numbers: [{ name: 'a b', value: 1 }] }, 400, /name/);
  refused({ numbers: [{ name: 'x', value: '12' }] }, 400, /value/);
  refused({ numbers: [{ name: 'x', value: Infinity }] }, 400, /value/);
  refused({ numbers: [{ name: 'x', value: 1, unit: 'a very long unit indeed' }] }, 400, /unit/);
  refused({ numbers: [{ name: 'x', value: 1 }, { name: 'x', value: 2 }] }, 400, /twice/);
});

const claims = (runId: number, ref = 'refs/heads/main'): RunClaims => ({ repository: 'caraminden/peek-auras', workflow: 'bench.yml', runId, runAttempt: 1, sha: `${runId}`.padStart(40, 'a'), ref });

test('a deliberate slowdown sent run by run is kept past 7 days, shows as a step, and tells the Taskmaster once', () => {
  const store = new Store(join(root, 'store.db'));
  const peek = store.createProject('Peek Auras', 'https://github.com/caraminden/peek-auras', null);
  let t = Date.UTC(2026, 10, 1);
  const numbers = new CiNumbers(store, () => t);
  const told: string[] = [];
  numbers.onStep = (p, step, words) => told.push(`${p.name} ${step.name}: ${words}`);
  const send = (run: number, frame: number, ref?: string) => {
    t += 6 * 60 * 60_000;
    return numbers.take(peek, claims(run, ref), { numbers: [{ name: 'frame-p95', value: frame, unit: 'ms' }, { name: 'binary', value: 30, unit: 'MB' }] });
  };
  const steady = [16.0, 16.1, 15.9, 16.0, 16.2, 15.8, 16.0, 16.1, 15.9, 16.0];
  steady.forEach((v, i) => send(100 + i, v));
  // A branch's slow runs are their own line: they never count against main's.
  [20, 20, 20].forEach((v, i) => send(200 + i, v, 'refs/heads/try-thing'));
  assert.equal(told.length, 0);
  // One noisy run: nothing.
  send(110, 19);
  send(111, 16);
  assert.equal(told.length, 0);
  // The slowdown: 17.6 ms (+10%) from run 112 on.
  send(112, 17.6);
  send(113, 17.7);
  assert.equal(told.length, 0);
  const third = send(114, 17.6);
  assert.equal(third.steps.length, 1);
  assert.equal(told.length, 1);
  assert.match(told[0], /^Peek Auras frame-p95: .*16 ms → 17\.6 ms \(\+10%\).*3 runs/);
  assert.match(told[0], /https:\/\/github\.com\/caraminden\/peek-auras\/commit\/a+112/);
  // It holds: still one flag, marked at the step's first run.
  send(115, 17.6);
  send(116, 17.7);
  assert.equal(told.length, 1);
  const [step] = store.ciNumberSteps(peek.id, 'frame-p95');
  assert.equal(step.run_id, 112);

  // Kept past the CI store's 7 days; the chart's view has each point's commit, and the step.
  t += 30 * 24 * 60 * 60_000;
  assert.equal(numbers.sweep(), 0);
  const view = numbers.view(peek.id);
  const frame = view.series.find((s) => s.name === 'frame-p95')!;
  assert.equal(frame.unit, 'ms');
  assert.equal(frame.ref, 'refs/heads/main');
  assert.equal(frame.points.length, 17);
  assert.deepEqual(frame.points.at(-1), { value: 17.7, sha: claims(116).sha, run_id: 116, workflow: 'bench.yml', at: frame.points.at(-1)!.at });
  assert.equal(frame.steps.length, 1);
  assert.equal(frame.steps[0].run_id, 112);
  assert.equal(view.repo, 'https://github.com/caraminden/peek-auras');
  assert.equal(view.series.find((s) => s.name === 'binary')!.steps.length, 0);
  // Gone only past the keep.
  t += LIMITS.keepMs;
  assert.equal(numbers.sweep(), 40);
  assert.equal(store.ciNumberSteps(peek.id).length, 0);
});

test('a scheme can only start so many series', () => {
  const store = new Store(join(root, 'cap.db'));
  const p = store.createProject('Busy', 'https://github.com/caraminden/busy', null);
  const numbers = new CiNumbers(store);
  for (let i = 0; i < LIMITS.series; i += LIMITS.perUpload) {
    numbers.take(p, claims(1 + i), { numbers: Array.from({ length: LIMITS.perUpload }, (_, j) => ({ name: `s${i + j}`, value: 1 })) });
  }
  // Old series still take numbers; a new one is refused, and nothing of that upload is kept.
  numbers.take(p, claims(900), { numbers: [{ name: 's0', value: 2 }] });
  assert.throws(() => numbers.take(p, claims(901), { numbers: [{ name: 's1', value: 2 }, { name: 'brand-new', value: 1 }] }), (err: any) => err.status === 413 && /series/.test(err.message));
  assert.equal(store.ciNumbers(p.id, 's1').length, 1);
});

test('a ship\'s land/ run counts as main, a branch line never flags, and a further step flags again', () => {
  const store = new Store(join(root, 'steps.db'));
  const p = store.createProject('Peek', 'https://github.com/caraminden/peek-auras', null);
  let t = Date.UTC(2026, 10, 1);
  const numbers = new CiNumbers(store, () => t);
  const told: string[] = [];
  numbers.onStep = (_p, step) => told.push(`${step.ref} ${step.level}`);
  let run = 1;
  const send = (v: number, ref = 'refs/heads/main') => { t += 60_000; numbers.take(p, claims(run++, ref), { numbers: [{ name: 'boot', value: v, unit: 'ms' }] }); };
  for (let i = 0; i < 14; i++) send(100, i % 2 ? 'refs/heads/land/ticket/9-fast' : 'refs/heads/main');
  assert.deepEqual(store.ciNumbers(p.id, 'boot').map((n) => n.ref), Array(14).fill('refs/heads/main'));
  // A branch's line, fewer runs than main's, is never the charted one, so its step never wakes anyone.
  for (let i = 0; i < 13; i++) send(i < 10 ? 50 : 90, 'refs/heads/try');
  assert.deepEqual(told, []);
  [120, 120, 120].forEach((v) => send(v));
  assert.deepEqual(told, ['refs/heads/main 120']);
  // Holding, or drifting under 5% over the step, is the same step.
  [121, 123, 120].forEach((v) => send(v));
  assert.equal(told.length, 1);
  // A second slowdown on top of the first is news.
  [150, 151, 150].forEach((v) => send(v));
  assert.deepEqual(told, ['refs/heads/main 120', 'refs/heads/main 150']);
});

test('pipeline runs are their own series: 140 s front-end runs then 210-280 s pipeline runs raise no flag (#1700)', () => {
  const store = new Store(join(root, 'pipeline.db'));
  const peek = store.createProject('Citadel', 'https://github.com/caraminden/claude-coordinator', null);
  let t = Date.UTC(2026, 10, 1);
  const numbers = new CiNumbers(store, () => (t += 60_000));
  const told: string[] = [];
  numbers.onStep = (_p, step) => told.push(step.name);
  const front = [140, 141, 139, 140, 142, 140, 139, 141, 140, 140, 140, 141, 139];
  const pipeline = [210, 240, 280, 250, 215, 270, 260];
  let run = 1;
  for (const v of front) numbers.take(peek, claims(run++), { numbers: [{ name: 'suite-time', value: v, unit: 's' }] });
  for (const v of pipeline) numbers.take(peek, claims(run++), { numbers: [{ name: 'suite-time-pipeline', value: v, unit: 's' }] });
  assert.deepEqual(told, []);
  // Under one name the same runs are the step the alert fired on.
  assert.ok(stepUp([...front, 210, 240, 280]));
  const names = numbers.view(peek.id).series.map((s) => s.name);
  assert.deepEqual(names, ['suite-time', 'suite-time-pipeline']);
});

test('tests.yml records a run that ran the pipeline test files as suite-time-pipeline (#1700)', () => {
  const yml = readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');
  assert.match(yml, /grep -q '\^run-tests: tier all' "\$RUNNER_TEMP\/tests\.log" \|\| series=suite-time-pipeline/);
  assert.match(yml, /nums\+=\("\$series=\$\(cat "\$RUNNER_TEMP\/suite-secs"\)s"\)/);
});

test('tests.yml keeps no suite time for a run that overlapped another suite run, and logs its window for the others (#1811)', () => {
  const yml = readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');
  assert.match(yml, /echo "\$wstart 0" >"\$me"/); // an open window is written before the suite starts
  assert.match(yml, /echo "\$wstart \$wend" >"\$me"/); // and closed after it, red or green
  assert.match(yml, /if \[ "\$s" -lt "\$wend" \] && \[ "\$e" -gt "\$wstart" \]; then echo "\$f" >"\$RUNNER_TEMP\/suite-overlap"/);
  assert.match(yml, /\[ -e "\$RUNNER_TEMP\/suite-overlap" \] \|\| nums\+=\("\$series=/);
  assert.match(yml, /nums\+=\("front-end-size=/); // the size still records
});

// The overlap loop from the workflow, run for real on window files.
test('the overlap check flags crossing windows and open recent ones, not disjoint ones (#1811)', () => {
  const yml = readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');
  const loop = yml.match(/( *)for f in "\$win"\/\*; do\n[\s\S]*?\n\1done\n/)![0];
  const run = (others: string[], ageMin = 0) => {
    const d = mkdtempSync(join(root, 'ovl-'));
    const win = join(d, 'w');
    mkdirSync(win);
    writeFileSync(join(win, 'me'), '100 200\n');
    others.forEach((o, i) => {
      writeFileSync(join(win, `o${i}`), `${o}\n`);
      const t = new Date(Date.now() - ageMin * 60000);
      utimesSync(join(win, `o${i}`), t, t);
    });
    const out = spawnSync('bash', ['-c', `win=${win}; me=${win}/me; wstart=100; wend=200; RUNNER_TEMP=${d}\n${loop}`]);
    assert.equal(out.status, 0, String(out.stderr));
    return existsSync(join(d, 'suite-overlap'));
  };
  assert.equal(run([]), false);
  assert.equal(run(['10 90']), false);
  assert.equal(run(['210 300']), false);
  assert.equal(run(['150 300']), true);
  assert.equal(run(['120 150']), true);
  assert.equal(run(['150 0']), true); // still open, file just written
  assert.equal(run(['150 0'], 60), false); // open but untouched for an hour: a killed run, not a live one
});
