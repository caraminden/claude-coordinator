import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { scriptEnv } from './script-env.ts';
import { git } from './git.ts';
import { tempRoot } from './helpers.ts';

// tools/run-tests.sh on throwaway fixture suites. A red full run reruns each failed file alone, once, only to label
// it: "passed alone" is a likely flake with a retro-log line, and the run still fails (Cara, 2026-11-10, "Keep
// failing, log it"). A hang is never rerun.
const tools = join(import.meta.dirname, '..', 'tools');
const scratch = tempRoot('run-tests-');
const root = scratch.dir;
after(() => scratch.teardown());
// NODE_TEST_CONTEXT would make the inner `node --test` report to this runner; COORDINATOR_SHARED_DIR would write
// into the real scheme's retro log; an empty DEPLOY_TEST_CPU_WEIGHT makes no real systemd scope (run-tests-scope.test.ts).
const env = { ...scriptEnv(), NODE_TEST_CONTEXT: undefined, COORDINATOR_SHARED_DIR: undefined, DEPLOY_TEST_CPU_WEIGHT: '', DEPLOY_TEST_TIMEOUT: undefined, DEPLOY_RERUN_TIMEOUT: undefined, DEPLOY_RERUN_DEADLINE: undefined, CITADEL_TEST_TIMEOUT: undefined };

const FIXTURES: Record<string, string> = {
  'ok.test.mjs': "import test from 'node:test';\ntest('fine', () => {});\n",
  // Fails the first time it runs, passes after: a counter file next to the suite.
  'once.test.mjs': `import test from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
test('fails once', () => {
  if (existsSync('ran-once')) return;
  writeFileSync('ran-once', '');
  throw new Error('first run fails');
});
`,
  'always.test.mjs': "import test from 'node:test';\ntest('always red', () => { throw new Error('red'); });\n",
  'hang.test.mjs': "import test from 'node:test';\ntest('hangs', () => new Promise(() => setInterval(() => {}, 1000)));\n",
};
// Fails in the full run, then hangs when run alone; a counter file per copy.
const onceThenHang = (name: string) => `import test from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
test('fails, then hangs', () => {
  if (existsSync('ran-${name}')) return new Promise(() => setInterval(() => {}, 1000));
  writeFileSync('ran-${name}', '');
  throw new Error('first run fails');
});
`;
// Waits until the run's counts (#545) say the first file is done and this one runs, then keeps them in seen-progress.
FIXTURES['progress.test.mjs'] = `import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
test('watch', async () => {
  const f = process.env.CITADEL_TEST_PROGRESS_TO;
  // poll-ok: this runs in a fixture child in a temp dir and can't import ./wait.ts
  for (let i = 0; i < 200 && !(f && existsSync(f) && readFileSync(f, 'utf8').startsWith('1\\n2\\ntest/progress.test.mjs\\n')); i++) await new Promise((r) => setTimeout(r, 25));
  writeFileSync('seen-progress', f && existsSync(f) ? readFileSync(f, 'utf8') : 'none');
});
`;
// Fails in the full run; rerun alone, it keeps the reruns' counts (#1368) in seen-rerun and passes.
FIXTURES['rerun-counts.test.mjs'] = `import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
test('rerun counts', () => {
  if (!existsSync('ran-rerun-counts')) { writeFileSync('ran-rerun-counts', ''); throw new Error('first run fails'); }
  const f = ['reruns.progress', 'land-test.progress'].find((p) => existsSync(p));
  writeFileSync('seen-rerun', f ? f + ':' + readFileSync(f, 'utf8') : 'none');
});
`;
// A long file: 3 s of work in the full run, then fails (first run only); alone it takes 3 s again, and passes or hangs.
const slowOnce = (then: 'pass' | 'hang') => `import test from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
test('slow', async () => {
  const again = existsSync('ran-slow');
  await new Promise((r) => setTimeout(r, 3000));
  if (again) return ${then === 'hang' ? 'new Promise(() => setInterval(() => {}, 1000))' : 'undefined'};
  writeFileSync('ran-slow', '');
  throw new Error('first run fails');
});
`;
FIXTURES['slow-pass.test.mjs'] = slowOnce('pass');
FIXTURES['slow-hang.test.mjs'] = slowOnce('hang');
for (const name of ['once-then-hang', 'once-then-hang2', 'once-then-hang3']) FIXTURES[`${name}.test.mjs`] = onceThenHang(name);
// Killed from outside (#1393: the desktop's out-of-memory killer): the file SIGKILLs the node --test runner that started it,
// before any test fails, then exits itself rather than wait on forever as an orphan (#1763). kill-once does it only when
// rerun alone, after failing in the full run.
FIXTURES['killed.test.mjs'] = "import test from 'node:test';\ntest('killed', () => { process.kill(process.ppid, 'SIGKILL'); process.exit(1); });\n";
FIXTURES['fail-then-killed.test.mjs'] = `import test from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
test('fails, then is killed', () => {
  if (existsSync('ran-killed')) { process.kill(process.ppid, 'SIGKILL'); process.exit(1); }
  writeFileSync('ran-killed', '');
  throw new Error('first run fails');
});
`;

// Four files that each log "+" when they start and "-" when done, 700 ms apart: the log shows how many ran at once.
const OVERLAP = "import { appendFileSync } from 'node:fs';\nimport test from 'node:test';\ntest('t', async () => { appendFileSync(process.env.OVERLAP_LOG, '+'); await new Promise((r) => setTimeout(r, 700)); appendFileSync(process.env.OVERLAP_LOG, '-'); });\n";
for (const i of [1, 2, 3, 4]) FIXTURES[`overlap${i}.test.mjs`] = OVERLAP;

let n = 0;
async function run(files: string[], extra: Record<string, string> = {}, prep?: (dir: string) => void) {
  const dir = join(root, String(++n));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  mkdirSync(join(dir, 'test'));
  for (const f of ['run-tests.sh', 'parse-check.ts', 'deploy-queue.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'suite-runner.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(tools, f), join(dir, 'tools', f));
  // A name with no fixture of its own always fails.
  for (const f of files) writeFileSync(join(dir, 'test', f), FIXTURES[f] ?? FIXTURES['always.test.mjs']);
  prep?.(dir);
  return again(dir, extra);
}

// run-tests.sh again in the same suite (CI's second step, #1374): the counter files remember what ran.
async function again(dir: string, extra: Record<string, string> = {}, logName = 'land-test.log') {
  const shared = join(dir, 'shared');
  const log = join(dir, logName);
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const p = execFile('bash', [join(dir, 'tools', 'run-tests.sh'), log], { cwd: dir, encoding: 'utf8', timeout: 90_000, env: { ...env, COORDINATOR_SHARED_DIR: shared, ...extra } }, (err, _out, se) => resolve({ code: err ? ((err as any).code ?? null) : 0, stderr: se }));
    scratch.track(p).stdin?.end();
  });
  const day = new Date().toISOString().slice(0, 10);
  const retroFile = join(shared, 'retro-log', day, 'land.md');
  const retro = existsSync(retroFile) ? readFileSync(retroFile, 'utf8') : '';
  return { code, stderr, log: readFileSync(log, 'utf8'), retro, dir };
}

const flakeLines = (retro: string) => retro.split('\n').filter((l) => / · flake · /.test(l));

test('a green run passes and reruns nothing', async () => {
  const r = await run(['ok.test.mjs']);
  assert.equal(r.code, 0, r.log);
  assert.doesNotMatch(r.log, /run-tests:/);
  assert.equal(r.retro, '');
});

test('a file that fails in the full run and passes alone is labelled a likely flake and logged, and the run still fails', async () => {
  const r = await run(['ok.test.mjs', 'once.test.mjs']);
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /run-tests: test\/once\.test\.mjs: failed in the full run, passed alone: likely load, not your change/);
  assert.match(r.log, /run-tests: the run still fails/);
  const lines = flakeLines(r.retro);
  assert.equal(lines.length, 1, r.retro);
  assert.match(lines[0], /^- \d\d:\d\d:\d\dZ · flake · test\/once\.test\.mjs · load \d+(\.\d+)?( · |$)/);
  assert.match(r.retro, /^# Retro log: land\.sh/);
});

// The drill's F7 (#553): the full run and its reruns were one phase, about 930 s at worst against the waiters' 900 s stall.
test("the reruns are a phase of their own in the landing's place in line, so the waiters see the line move", async () => {
  const ticket = join(root, 'ticket');
  writeFileSync(ticket, `${process.pid} 1\n1700000000\nticket/1-x\nrunning the tests since 10:00\n`);
  const r = await run(['ok.test.mjs', 'once.test.mjs'], { DEPLOY_QUEUE_TICKET: ticket });
  assert.equal(r.code, 1, r.log);
  const lines = readFileSync(ticket, 'utf8').split('\n');
  assert.deepEqual(lines.slice(0, 3), [`${process.pid} 1`, '1700000000', 'ticket/1-x'], 'the rest of the ticket is as it was');
  assert.match(lines[3], /^rerunning 1 failed test file since \d\d:\d\d$/);
});

test('a file that fails again alone is a real failure: no flake line, the run fails', async () => {
  const r = await run(['ok.test.mjs', 'always.test.mjs']);
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /run-tests: test\/always\.test\.mjs: failed again alone: a real failure/);
  assert.doesNotMatch(r.log, /passed alone/);
  assert.deepEqual(flakeLines(r.retro), []);
});

test('a flake and a real failure in one run: each labelled, one flake line, the run fails', async () => {
  const r = await run(['once.test.mjs', 'always.test.mjs']);
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /test\/once\.test\.mjs: failed in the full run, passed alone/);
  assert.match(r.log, /test\/always\.test\.mjs: failed again alone/);
  assert.equal(flakeLines(r.retro).length, 1, r.retro);
  assert.match(r.retro, /flake · test\/once\.test\.mjs/);
});

test('a hang is never rerun: the time limit fails the run with its line, and nothing is logged as a flake', async () => {
  const r = await run(['ok.test.mjs', 'once.test.mjs', 'hang.test.mjs'], { DEPLOY_TEST_TIMEOUT: '4' });
  assert.equal(r.code, 124, r.log);
  assert.match(r.stderr, /ran past 4s and were stopped: a test hung/);
  assert.match(r.log, /^still running: test\/hang\.test\.mjs \(\d+s\) in test: hangs$/m, r.log);
  assert.doesNotMatch(r.log, /still running: test\/(ok|once)\.test\.mjs/);
  assert.doesNotMatch(r.log, /passed alone|failed again alone/);
  assert.equal(existsSync(join(r.dir, 'land-test-rerun.log')), false, 'nothing was rerun');
  assert.equal(r.retro, '');
});

// #1393: timeout's exit 137 is both its KILL at the limit (a hang) and its child killed from outside. Only the time tells
// them apart, as deploy.sh's boot check does: an outside kill well before the limit is a lost run, not a hang.
test('a run killed from outside before any test failed reads as killed (exit 137), not as a hang, and nothing is rerun', async () => {
  const r = await run(['ok.test.mjs', 'killed.test.mjs'], { DEPLOY_TEST_TIMEOUT: '60' });
  assert.equal(r.code, 137, r.log);
  assert.match(r.stderr, /run-tests: the tests were killed \(exit 137\) after \d+s, before the 60s limit: stopped from outside \(the out-of-memory killer\?\), not a hang/);
  assert.doesNotMatch(r.log, /a test hung|ran past/);
  assert.equal(existsSync(join(r.dir, 'land-test-rerun.log')), false, 'nothing was rerun');
  assert.equal(r.retro, '');
});

test('a file killed from outside when rerun alone is a lost rerun with no label, not a hang', async () => {
  const r = await run(['fail-then-killed.test.mjs'], { DEPLOY_RERUN_TIMEOUT: '60' });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /test\/fail-then-killed\.test\.mjs: killed \(exit 137\) when rerun alone after \d+s, before its 60s limit: stopped from outside, so it has no label/);
  assert.doesNotMatch(r.log, /hung|passed alone|failed again alone/);
  assert.deepEqual(flakeLines(r.retro), []);
});

// #999: one test that hangs (a client waiting on a tool server that died) held the land line for the whole 10 minutes
// and read as CI trouble. Each test now has its own limit, so the hang fails in a minute, by name.
test("a test that hangs fails at its own time limit, by name, long before the whole run's limit", async () => {
  const r = await run(['ok.test.mjs', 'hang.test.mjs'], { CITADEL_TEST_TIMEOUT: '2', DEPLOY_TEST_TIMEOUT: '80' });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /✖ hangs \(\d+(\.\d+)?ms\)[\s\S]*test timed out after 2000ms/);
  assert.match(r.log, /test\/hang\.test\.mjs: failed again alone: a real failure/, 'the rerun has the same limit');
  // exit 1 (not 124) is the proof: the whole run's 80 s limit never fired
});

// #993's three failed lands: a .ts file that didn't parse hung every test that started it. Now it fails the run first.
test('a tracked .ts file that does not parse fails the run before any test runs, and names the file', async () => {
  const r = await run(['ok.test.mjs'], {}, (dir) => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'good.ts'), "import { a, type B } from './b.ts';\nexport const x: number = 1;\n");
    writeFileSync(join(dir, 'src', 'bad.ts'), "export const say = (s: string) => s;\nsay('it's broken');\n");
    writeFileSync(join(dir, 'src', 'types.d.ts'), 'declare module "x" { export = whatever ', 'utf8'); // .d.ts is never run
    writeFileSync(join(dir, 'src', 'untracked.ts'), 'not ( typescript');
    git(dir, 'init', '-q');
    git(dir, 'add', 'src/good.ts', 'src/bad.ts', 'src/types.d.ts');
  });
  assert.equal(r.code, 1, r.log);
  assert.match(r.stderr, /run-tests: src\/bad\.ts does not parse \(.+\), so no test ran/);
  assert.doesNotMatch(r.stderr, /good\.ts|types\.d\.ts|untracked\.ts/);
  assert.doesNotMatch(r.log, /✔ fine/);
});

test('a repo whose tracked .ts files all parse runs its tests as before', async () => {
  const r = await run(['ok.test.mjs'], {}, (dir) => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'good.ts'), 'export const x: number = 1;\n');
    git(dir, 'init', '-q');
    git(dir, 'add', 'src/good.ts');
  });
  assert.equal(r.code, 0, r.log);
  assert.match(r.log, /✔ fine/);
});

test('a file that hangs when rerun alone is stopped and counts as a real failure', async () => {
  const r = await run(['once-then-hang.test.mjs'], { DEPLOY_RERUN_TIMEOUT: '3' });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /test\/once-then-hang\.test\.mjs: hung when rerun alone \(stopped after 3s\): a real failure/);
  assert.deepEqual(flakeLines(r.retro), []);
});

test("a file's rerun limit fits its own length: one that took 3 s in the full run is not stopped at a 2 s flat limit", async () => {
  const r = await run(['slow-pass.test.mjs'], { DEPLOY_RERUN_TIMEOUT: '2' });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /test\/slow-pass\.test\.mjs: failed in the full run, passed alone/);
  assert.equal(flakeLines(r.retro).length, 1, r.retro);
});

test('a long file that really hangs alone is still called a hang, at the limit its length gave it (1.5 times its 3-4 s, more than the 2 s flat limit)', async () => {
  const r = await run(['slow-hang.test.mjs'], { DEPLOY_RERUN_TIMEOUT: '2', DEPLOY_RERUN_BUDGET: '20' });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /test\/slow-hang\.test\.mjs: hung when rerun alone \(stopped after (?:[3-9]|1\d)s\): a real failure/);
  assert.deepEqual(flakeLines(r.retro), []);
});

test('the reruns share one time budget: once it is spent, the files left are not rerun, and the run fails', async () => {
  const r = await run(['once-then-hang.test.mjs', 'once-then-hang2.test.mjs', 'once-then-hang3.test.mjs'], { DEPLOY_RERUN_TIMEOUT: '3', DEPLOY_RERUN_BUDGET: '5' });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /test\/once-then-hang\.test\.mjs: hung when rerun alone \(stopped after 3s\)/);
  assert.match(r.log, /test\/once-then-hang2\.test\.mjs: hung when rerun alone \(stopped after [12]s\)/);
  assert.match(r.log, /test\/once-then-hang3\.test\.mjs: not rerun: the reruns' 5s ran out/);
  assert.equal(existsSync(join(r.dir, 'ran-once-then-hang3')), true, 'the full run did reach the third file');
});

// A ship's CI run sets DEPLOY_RERUN_DEADLINE to when land.sh stops waiting (#1240), so a real red answers red in time.
const inSeconds = (n: number) => String(Math.floor(Date.now() / 1000) + n);

test("with CI's deadline set, once one file fails again alone the rest are not rerun: the run is already a real red", async () => {
  const r = await run(['always1.test.mjs', 'always2.test.mjs'], { DEPLOY_RERUN_DEADLINE: inSeconds(300) });
  assert.equal(r.code, 1, r.log);
  assert.equal(r.log.match(/: failed again alone: a real failure/g)?.length, 1, r.log);
  assert.equal(r.log.match(/: not rerun: a real failure already makes this run red/g)?.length, 1, r.log);
});

test("with CI's deadline passed, a failed file is not rerun and stays unlabelled, so land.sh reads the run as red", async () => {
  const r = await run(['once.test.mjs'], { DEPLOY_RERUN_DEADLINE: inSeconds(-1) });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /test\/once\.test\.mjs: not rerun: CI's answer is due/);
  assert.doesNotMatch(r.log, /passed alone/);
  assert.deepEqual(flakeLines(r.retro), []);
});

test("a rerun alone is cut at CI's deadline, well before its own limit, and counts as a real failure", async () => {
  const r = await run(['once-then-hang.test.mjs'], { DEPLOY_RERUN_TIMEOUT: '60', DEPLOY_RERUN_DEADLINE: inSeconds(10) });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /test\/once-then-hang\.test\.mjs: rerun alone stopped after \d+s, when CI's answer was due: counts as a real failure/);
  assert.doesNotMatch(r.log, /rerun alone hung|hung when rerun alone \(stopped after 60s\)/, 'its own 60 s limit never fired');
  assert.deepEqual(flakeLines(r.retro), []);
});

// A ship's CI run under load (#1374): on Nov 20 the full run itself took 295-351 s and ended past the old deadline
// (creation + 330 s), so every failed file was "not rerun: CI's answer is due" and a flake-only red counted as real.
// In CI the reruns are a step of their own (DEPLOY_RERUN_LATER, then DEPLOY_RERUN_FROM) with a fresh deadline, which
// land.sh sees and waits for.
test('in CI the full run leaves its failed files to the next step and reruns none, whatever the old deadline says', async () => {
  const r = await run(['once.test.mjs', 'ok.test.mjs'], { DEPLOY_RERUN_LATER: 'reruns', DEPLOY_RERUN_DEADLINE: inSeconds(-1) });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /run-tests: 1 test file\(s\) failed; CI reruns each alone in its next step/);
  assert.doesNotMatch(r.log, /rerunning each alone|not rerun|passed alone/);
  assert.match(readFileSync(join(r.dir, 'reruns'), 'utf8'), /^1 \S+\ntest\/once\.test\.mjs\t\d+\n$/);
});

test("CI's rerun step reruns the failed files alone with its own fresh deadline: a flake is labelled, and the run stays red", async () => {
  const r = await run(['once.test.mjs', 'ok.test.mjs'], { DEPLOY_RERUN_LATER: 'reruns', DEPLOY_RERUN_DEADLINE: inSeconds(-1) });
  const r2 = await again(r.dir, { DEPLOY_RERUN_FROM: 'reruns', DEPLOY_RERUN_DEADLINE: inSeconds(150) }, 'reruns.log');
  assert.equal(r2.code, 1, r2.log);
  assert.doesNotMatch(r2.log, /tier |kit lane/, 'the rerun step picks no tests of its own');
  assert.match(r2.log, /run-tests: 1 test file\(s\) failed; rerunning each alone once/, "land.sh's flake_only counts from this line");
  assert.match(r2.log, /test\/once\.test\.mjs: failed in the full run, passed alone: likely load/);
  assert.equal(flakeLines(r2.retro).length, 1, r2.retro);
});

// #1368: the Releases page shows the reruns' progress too (tools/ci-progress.ts sends this file on in CI).
test("the reruns keep counts of their own beside the log: done, of how many, the file rerunning, the full run's failed files, and rerun", async () => {
  const want = 'reruns.progress:0\n2\ntest/rerun-counts.test.mjs\ntest/always.test.mjs\ttest/rerun-counts.test.mjs\nrerun\n';
  const r = await run(['ok.test.mjs', 'always.test.mjs', 'rerun-counts.test.mjs'], { DEPLOY_RERUN_LATER: 'reruns' });
  const order = readFileSync(join(r.dir, 'reruns'), 'utf8')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((l) => l.split('\t')[0]);
  const at = order.indexOf('test/rerun-counts.test.mjs');
  const r2 = await again(r.dir, { DEPLOY_RERUN_FROM: 'reruns' }, 'reruns.log');
  assert.equal(r2.code, 1, r2.log);
  assert.equal(readFileSync(join(r.dir, 'seen-rerun'), 'utf8'), want.replace('0\n', `${at}\n`).replace('test/always.test.mjs\ttest/rerun-counts.test.mjs', order.join('\t')));
  assert.equal(existsSync(join(r.dir, 'reruns.progress')), false, 'gone once the reruns end');
  // On perigee the full run and its reruns are one run-tests.sh: the same file, its full-run counts replaced.
  const p = await run(['ok.test.mjs', 'rerun-counts.test.mjs']);
  assert.equal(p.code, 1, p.log);
  assert.equal(readFileSync(join(p.dir, 'seen-rerun'), 'utf8'), 'land-test.progress:0\n1\ntest/rerun-counts.test.mjs\ntest/rerun-counts.test.mjs\nrerun\n');
  assert.equal(existsSync(join(p.dir, 'land-test.progress')), false);
});

test("CI's rerun step still counts a file that fails again alone as a real red", async () => {
  const r = await run(['always.test.mjs'], { DEPLOY_RERUN_LATER: 'reruns' });
  const r2 = await again(r.dir, { DEPLOY_RERUN_FROM: 'reruns', DEPLOY_RERUN_DEADLINE: inSeconds(150) }, 'reruns.log');
  assert.equal(r2.code, 1, r2.log);
  assert.match(r2.log, /test\/always\.test\.mjs: failed again alone: a real failure/);
});

test('in CI a green full run, or one with too many failures, leaves no reruns for the next step', async () => {
  const g = await run(['ok.test.mjs'], { DEPLOY_RERUN_LATER: 'reruns' });
  assert.equal(g.code, 0, g.log);
  assert.equal(existsSync(join(g.dir, 'reruns')), false);
  const many = await run(
    [1, 2, 3, 4, 5, 6].map((i) => `always${i}.test.mjs`),
    { DEPLOY_RERUN_LATER: 'reruns' },
  );
  assert.equal(many.code, 1, many.log);
  assert.equal(existsSync(join(many.dir, 'reruns')), false);
  const none = await again(many.dir, { DEPLOY_RERUN_FROM: 'reruns' }, 'reruns.log');
  assert.equal(none.code, 0, 'no reruns left: the step adds nothing to the red its first step already is');
  assert.equal(none.log, '');
});

test('more failed files than a load blip explains are not rerun, and the run fails', async () => {
  const files = [1, 2, 3, 4, 5, 6].map((i) => `always${i}.test.mjs`);
  const r = await run(files);
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /run-tests: 6 test files failed: too many for load, so none is rerun/);
  assert.doesNotMatch(r.log, /failed again alone|passed alone/);
  assert.equal(r.retro, '');
});

test('without a shared folder the flake is still labelled in the output, and nothing is written', async () => {
  const r = await run(['once.test.mjs'], { COORDINATOR_SHARED_DIR: '' });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /passed alone: likely load/);
  assert.equal(existsSync(join(r.dir, 'shared')), false);
});

function peakOverlap(marks: string) {
  let now = 0,
    peak = 0;
  for (const c of marks) {
    now += c === '+' ? 1 : -1;
    peak = Math.max(peak, now);
  }
  return peak;
}

test('CITADEL_TEST_CONCURRENCY caps how many test files run at once, and the default is half the cores (#521)', async () => {
  const files = [1, 2, 3, 4].map((i) => `overlap${i}.test.mjs`);
  const one = join(root, 'overlap-one');
  const r1 = await run(files, { CITADEL_TEST_CONCURRENCY: '1', OVERLAP_LOG: one });
  assert.equal(r1.code, 0, r1.log);
  assert.equal(peakOverlap(readFileSync(one, 'utf8')), 1);
  const two = join(root, 'overlap-two');
  const r2 = await run(files, { CITADEL_TEST_CONCURRENCY: '2', OVERLAP_LOG: two });
  assert.equal(r2.code, 0, r2.log);
  assert.equal(peakOverlap(readFileSync(two, 'utf8')), 2);
  // Unset: half the cores (rounded up), never the whole box.
  const cores = Number(execFileSync('nproc', { encoding: 'utf8' }));
  const def = join(root, 'overlap-default');
  const r3 = await run(files, { CITADEL_TEST_CONCURRENCY: '', OVERLAP_LOG: def });
  assert.equal(r3.code, 0, r3.log);
  assert.equal(peakOverlap(readFileSync(def, 'utf8')), Math.min(4, Math.ceil(cores / 2)));
});

test("the full run's file counts sit beside its log while it runs (#545), and go when it ends", async () => {
  const r = await run(['ok.test.mjs', 'progress.test.mjs'], { CITADEL_TEST_CONCURRENCY: '1' });
  assert.equal(r.code, 0, r.log);
  assert.equal(readFileSync(join(r.dir, 'seen-progress'), 'utf8'), `1\n2\ntest/progress.test.mjs\n\n`);
  assert.equal(existsSync(join(r.dir, 'land-test.progress')), false);
});

test('counts that cannot be written never fail or change the run', async () => {
  const r = await run(['ok.test.mjs'], {}, (dir) => mkdirSync(join(dir, 'land-test.progress.tmp')));
  assert.equal(r.code, 0, r.log);
  assert.doesNotMatch(r.log, /run-tests:|Error/);
});

// The gate has npm test's leak guard (ultra review A3): green tests that leave a process running are a red run.
test("a full run whose test file leaves a process running fails that file, naming it, and its rerun alone fails too; the guard's file is the suite's own", async () => {
  const pidFile = join(root, 'leaked-pid');
  const gone = join(tmpdir(), 'run-tests-leak-gone', 'x'); // a scratch folder that was deleted, as the guard looks for
  const leak = `import test from 'node:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
test('leaves a process', () => {
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', ${JSON.stringify(gone)}], { detached: true, stdio: 'ignore' });
  p.unref();
  writeFileSync(${JSON.stringify(pidFile)}, String(p.pid));
});
`;
  try {
    const r = await run(['ok.test.mjs', 'leak.test.mjs'], {}, (dir) => {
      writeFileSync(join(dir, 'test', 'leak.test.mjs'), leak);
      writeFileSync(join(dir, 'test', 'leak-guard.ts'), `export * from ${JSON.stringify(join(import.meta.dirname, 'leak-guard.ts'))};\n`);
    });
    assert.equal(r.code, 1, r.log);
    // The file's own count (test/leak-file.ts, #1763) catches it before the run's guard, and kills it.
    assert.match(r.log, /leak guard: \S*leak\.test\.mjs left these behind[^]*1 process\(es\) still running/);
    assert.match(r.log, /test\/leak\.test\.mjs: failed again alone: a real failure/, 'a leak is no flake');
    assert.doesNotMatch(r.log, /passed alone/);
  } finally {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    } catch {} // the guard killed it
  }
});

// The tiers (#581): a repo whose tools/pipeline-files.txt names test/pipe.test.mjs, on a branch off main (one entry
// with spaces round it and a CRLF, which count for nothing). Each test
// file notes that it ran in a file of its own name, so the test sees which ones the run left out.
const RAN = (name: string) => `import test from 'node:test';\nimport { writeFileSync } from 'node:fs';\ntest('${name}', () => writeFileSync('ran-${name}', ''));\n`;
FIXTURES['pipe.test.mjs'] = RAN('pipe');
FIXTURES['product.test.mjs'] = RAN('product');
const TIER_LIST = '# the pipeline\r\n  tools/land.sh \r\nkit/templates/ # a folder\ntest/pipe.test.mjs\n';
function tierRepo(change?: (dir: string) => void, mainName = 'main', list = TIER_LIST) {
  return (dir: string) => {
    writeFileSync(join(dir, 'tools', 'pipeline-files.txt'), list);
    writeFileSync(join(dir, 'tools', 'land.sh'), 'v1\n');
    mkdirSync(join(dir, 'kit', 'templates'), { recursive: true });
    writeFileSync(join(dir, 'kit', 'templates', 'land.sh'), 'v1\n');
    mkdirSync(join(dir, 'public'));
    writeFileSync(join(dir, 'public', 'app.js'), 'v1\n');
    writeFileSync(join(dir, '.gitignore'), 'ran-*\n*.log\n');
    git(dir, 'init', '-q', '-b', mainName);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    if (!change) return;
    git(dir, 'checkout', '-qb', 'ticket/1-x');
    change(dir);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'change');
  };
}
const ran = (dir: string) => ['pipe', 'product'].filter((n) => existsSync(join(dir, `ran-${n}`)));

// The second row is #1477: the tier was read from the list's last line. Since #1160 put a workflow there (Nov 20),
// every ship ran every test file, with an empty reason in the log.
for (const [what, list] of [
  ['a list that ends in a test file', TIER_LIST],
  ['a list that ends in a file that is not a test (#1477)', `${TIER_LIST}.github/workflows/heavy.yml\n`],
] as const) {
  test(`a change that touches only product files leaves out the pipeline test files, and says so (#581): ${what}`, async () => {
    const r = await run(
      ['pipe.test.mjs', 'product.test.mjs'],
      {},
      tierRepo((dir) => writeFileSync(join(dir, 'public', 'app.js'), 'v2\n'), 'main', list),
    );
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(ran(r.dir), ['product']);
    assert.match(r.log.split('\n')[0], /^run-tests: tier product \(the 1 pipeline test files left out\): this change touches nothing in tools\/pipeline-files\.txt$/);
  });
}

test('a red pipeline test file never fails a product change: it does not run (#581)', async () => {
  const r = await run(['pipe.test.mjs', 'product.test.mjs'], {}, (dir) => {
    writeFileSync(join(dir, 'test', 'pipe.test.mjs'), FIXTURES['always.test.mjs']);
    tierRepo((d) => writeFileSync(join(d, 'public', 'app.js'), 'v2\n'))(dir);
  });
  assert.equal(r.code, 0, r.log);
  assert.deepEqual(ran(r.dir), ['product']);
});

for (const [what, change, why] of [
  ['tools/land.sh', (dir: string) => writeFileSync(join(dir, 'tools', 'land.sh'), 'v2\n'), 'tools/land.sh is a pipeline file'],
  ['a file in a listed folder', (dir: string) => writeFileSync(join(dir, 'kit', 'templates', 'land.sh'), 'v2\n'), 'kit/templates/land.sh is a pipeline file'],
  ['a listed test file', (dir: string) => writeFileSync(join(dir, 'test', 'pipe.test.mjs'), `${FIXTURES['pipe.test.mjs']}// v2\n`), 'test/pipe.test.mjs is a pipeline file'],
  ['the list itself', (dir: string) => writeFileSync(join(dir, 'tools', 'pipeline-files.txt'), 'test/pipe.test.mjs\n'), 'tools/pipeline-files.txt is a pipeline file'],
  ['a pipeline file renamed away', (dir: string) => git(dir, 'mv', 'tools/land.sh', 'tools/land2.sh'), 'tools/land.sh is a pipeline file'],
] as const) {
  test(`a change to ${what} runs every test file, the pipeline's included (#581)`, async () => {
    const r = await run(['pipe.test.mjs', 'product.test.mjs'], {}, tierRepo(change));
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(ran(r.dir), ['pipe', 'product']);
    assert.equal(r.log.split('\n')[0], `run-tests: tier all (pipeline test files included): ${why}`);
  });
}

test('main itself (the nightly, a deploy) and a repo with no main run every test file (#581)', async () => {
  for (const [prep, why] of [
    [tierRepo(), 'nothing changed against main'],
    [tierRepo((dir) => writeFileSync(join(dir, 'public', 'app.js'), 'v2\n'), 'trunk'), 'no main to compare with'],
  ] as const) {
    const r = await run(['pipe.test.mjs', 'product.test.mjs'], {}, prep);
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(ran(r.dir), ['pipe', 'product']);
    assert.equal(r.log.split('\n')[0], `run-tests: tier all (pipeline test files included): ${why}`);
  }
});

test("CI's checkout has origin/main and no main: the tier is decided against origin/main (#581)", async () => {
  const r = await run(['pipe.test.mjs', 'product.test.mjs'], {}, (dir) => {
    tierRepo((d) => writeFileSync(join(d, 'public', 'app.js'), 'v2\n'))(dir);
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
    git(dir, 'branch', '-qD', 'main');
  });
  assert.equal(r.code, 0, r.log);
  assert.deepEqual(ran(r.dir), ['product']);
  assert.match(r.log, /^run-tests: tier product/);
});

// The kit lane (#753): a change to kit/ (and light paths) alone runs only the test files that read the kit, as
// tools/kit-tests.ts finds them: naming kit/ itself, or importing a src/ file that does.
FIXTURES['kitname.test.mjs'] = `${RAN('kitname')}const where = 'kit/skills';\n`;
FIXTURES['viasrc.test.mjs'] = `import { k } from '../src/skills.mjs';\n${RAN('viasrc')}`;
const ranKit = (dir: string) => ['pipe', 'product', 'kitname', 'viasrc'].filter((n) => existsSync(join(dir, `ran-${n}`)));
function kitRepo(change?: (dir: string) => void) {
  return (dir: string) => {
    for (const f of ['lane.sh', 'kit-tests.ts']) copyFileSync(join(tools, f), join(dir, 'tools', f));
    writeFileSync(join(dir, 'tools', 'lanes'), 'full kit/templates/*\nlight docs/*\nkit kit/*\n');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'skills.mjs'), "export const k = ['kit', 'skills'].join('/');\n");
    mkdirSync(join(dir, 'kit', 'skills', 'x'), { recursive: true });
    writeFileSync(join(dir, 'kit', 'skills', 'x', 'SKILL.md'), 'v1\n');
    tierRepo(change)(dir);
  };
}
const FOUR = ['pipe.test.mjs', 'product.test.mjs', 'kitname.test.mjs', 'viasrc.test.mjs'];

test('a kit-only change runs only the test files that read the kit, and says how many (#753)', async () => {
  const r = await run(
    FOUR,
    {},
    kitRepo((dir) => {
      writeFileSync(join(dir, 'kit', 'skills', 'x', 'SKILL.md'), 'v2\n');
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'docs', 'note.md'), 'a light file beside it\n');
    }),
  );
  assert.equal(r.code, 0, r.log);
  assert.deepEqual(ranKit(r.dir), ['kitname', 'viasrc']);
  assert.match(r.log, /^run-tests: kit lane: only the 2 test file\(s\) that read the kit \(tools\/kit-tests\.ts\)$/m);
});

test('a kit change with anything outside the kit lane runs them all (#753)', async () => {
  for (const change of [
    (dir: string) => {
      writeFileSync(join(dir, 'kit', 'skills', 'x', 'SKILL.md'), 'v2\n');
      writeFileSync(join(dir, 'public', 'app.js'), 'v2\n');
    },
    (dir: string) => writeFileSync(join(dir, 'kit', 'templates', 'land.sh'), 'v2\n'), // a pipeline file, and full in the map
  ]) {
    const r = await run(FOUR, {}, kitRepo(change));
    assert.equal(r.code, 0, r.log);
    assert.ok(ranKit(r.dir).includes('product'), r.log);
    assert.doesNotMatch(r.log, /kit lane/);
  }
});

test('main itself (the nightly, a deploy) never takes the kit lane (#753)', async () => {
  const r = await run(FOUR, {}, kitRepo());
  assert.equal(r.code, 0, r.log);
  assert.deepEqual(ranKit(r.dir), ['pipe', 'product', 'kitname', 'viasrc']);
});
