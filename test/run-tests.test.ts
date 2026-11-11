import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { scriptEnv } from './script-env.ts';

// tools/run-tests.sh on throwaway fixture suites. A red full run reruns each failed file alone, once, only to label
// it: "passed alone" is a likely flake with a retro-log line, and the run still fails (Cara, 2026-11-10, "Keep
// failing, log it"). A hang is never rerun.
const tools = join(import.meta.dirname, '..', 'tools');
const root = mkdtempSync(join(tmpdir(), 'run-tests-'));
after(() => rmSync(root, { recursive: true, force: true }));
// NODE_TEST_CONTEXT would make the inner `node --test` report to this runner; COORDINATOR_SHARED_DIR would write
// into the real scheme's retro log; an empty DEPLOY_TEST_CPU_WEIGHT makes no real systemd scope (run-tests-scope.test.ts).
const env = { ...scriptEnv(), NODE_TEST_CONTEXT: undefined, COORDINATOR_SHARED_DIR: undefined, DEPLOY_TEST_CPU_WEIGHT: '', DEPLOY_TEST_TIMEOUT: undefined, DEPLOY_RERUN_TIMEOUT: undefined };

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
// Waits until the run's counts (#545) say the first file is done, then keeps them in seen-progress.
FIXTURES['progress.test.mjs'] = `import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
test('watch', async () => {
  const f = process.env.CITADEL_TEST_PROGRESS_TO;
  for (let i = 0; i < 200 && !(f && existsSync(f) && readFileSync(f, 'utf8').startsWith('1\\n')); i++) await new Promise((r) => setTimeout(r, 25));
  writeFileSync('seen-progress', f && existsSync(f) ? readFileSync(f, 'utf8') : 'none');
});
`;
for (const name of ['once-then-hang', 'once-then-hang2', 'once-then-hang3']) FIXTURES[`${name}.test.mjs`] = onceThenHang(name);

// Four files that each log "+" when they start and "-" when done, 700 ms apart: the log shows how many ran at once.
const OVERLAP = "import { appendFileSync } from 'node:fs';\nimport test from 'node:test';\ntest('t', async () => { appendFileSync(process.env.OVERLAP_LOG, '+'); await new Promise((r) => setTimeout(r, 700)); appendFileSync(process.env.OVERLAP_LOG, '-'); });\n";
for (const i of [1, 2, 3, 4]) FIXTURES[`overlap${i}.test.mjs`] = OVERLAP;

let n = 0;
async function run(files: string[], extra: Record<string, string> = {}, prep?: (dir: string) => void) {
  const dir = join(root, String(++n));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  mkdirSync(join(dir, 'test'));
  for (const f of ['run-tests.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(tools, f), join(dir, 'tools', f));
  // A name with no fixture of its own always fails.
  for (const f of files) writeFileSync(join(dir, 'test', f), FIXTURES[f] ?? FIXTURES['always.test.mjs']);
  prep?.(dir);
  const shared = join(dir, 'shared');
  const log = join(dir, 'land-test.log');
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const p = execFile('bash', [join(dir, 'tools', 'run-tests.sh'), log], { cwd: dir, encoding: 'utf8', timeout: 90_000, env: { ...env, COORDINATOR_SHARED_DIR: shared, ...extra } }, (err, _out, se) =>
      resolve({ code: err ? ((err as any).code ?? null) : 0, stderr: se }),
    );
    p.stdin?.end();
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
  assert.doesNotMatch(r.log, /passed alone|failed again alone/);
  assert.equal(existsSync(join(r.dir, 'land-test-rerun.log')), false, 'nothing was rerun');
  assert.equal(r.retro, '');
});

test('a file that hangs when rerun alone is stopped and counts as a real failure', async () => {
  const r = await run(['once-then-hang.test.mjs'], { DEPLOY_RERUN_TIMEOUT: '3' });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /test\/once-then-hang\.test\.mjs: hung when rerun alone \(stopped after 3s\): a real failure/);
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
  let now = 0, peak = 0;
  for (const c of marks) { now += c === '+' ? 1 : -1; peak = Math.max(peak, now); }
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
  assert.equal(readFileSync(join(r.dir, 'seen-progress'), 'utf8'), `1\n2\ntest/progress.test.mjs\n`);
  assert.equal(existsSync(join(r.dir, 'land-test.progress')), false);
});

test('counts that cannot be written never fail or change the run', async () => {
  const r = await run(['ok.test.mjs'], {}, (dir) => mkdirSync(join(dir, 'land-test.progress.tmp')));
  assert.equal(r.code, 0, r.log);
  assert.doesNotMatch(r.log, /run-tests:|Error/);
});

// The gate has npm test's leak guard (ultra review A3): green tests that leave a process running are a red run.
test("a full run whose tests leave a process running fails, and names it; the guard's file is the suite's own", async () => {
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
    assert.match(r.log, /The tests left 1 process\(es\) running \(now killed\)/);
    assert.doesNotMatch(r.log, /rerunning each alone/, 'no test file failed, so nothing is rerun');
  } finally {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    } catch {} // the guard killed it
  }
});
