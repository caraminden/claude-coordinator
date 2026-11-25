import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { expand, filesAtOnce, mergeTimes, order, otherSuites, readTimes } from '../tools/suite-runner.ts';
import { tempRoot } from './helpers.ts';
import { until } from './wait.ts';

// tools/suite-runner.ts (#1565): run-tests.sh's `node --test`, with files started longest first.
const scratch = tempRoot('suite-runner-');
after(() => scratch.teardown());
const runner = join(import.meta.dirname, '..', 'tools', 'suite-runner.ts');

test('files start longest first by their last times; a file with no time goes first; no times file keeps name order', () => {
  const cwd = '/r';
  const files = ['/r/test/a.test.ts', '/r/test/b.test.ts', '/r/test/c.test.ts', '/r/test/new.test.ts'];
  const times = new Map([
    ['test/a.test.ts', 1],
    ['test/b.test.ts', 9],
    ['test/c.test.ts', 4],
  ]);
  assert.deepEqual(order(files, times, cwd), ['/r/test/new.test.ts', '/r/test/b.test.ts', '/r/test/c.test.ts', '/r/test/a.test.ts']);
  assert.deepEqual(order([...files].reverse(), new Map(), cwd), files);
});

test('the times file skips lines that do not read; a missing file is no times', () => {
  const p = join(scratch.dir, 'times.tsv');
  writeFileSync(p, '3.5\ttest/a.test.ts\nnope\ttest/b.test.ts\n\ttest/c.test.ts\n-1\ttest/d.test.ts\n2\n7\ttest/e.test.ts\n');
  assert.deepEqual(
    [...readTimes(p)],
    [
      ['test/a.test.ts', 3.5],
      ['test/e.test.ts', 7],
    ],
  );
  assert.equal(readTimes(join(scratch.dir, 'none.tsv')).size, 0);
  assert.equal(readTimes(undefined).size, 0);
});

test('new times replace old ones for files that ran, keep those of files left out, and drop deleted files', () => {
  const cwd = join(scratch.dir, 'merge');
  mkdirSync(join(cwd, 'test'), { recursive: true });
  for (const f of ['a', 'b', 'c']) writeFileSync(join(cwd, 'test', `${f}.test.ts`), '');
  const old = new Map([
    ['test/a.test.ts', 5],
    ['test/b.test.ts', 8],
    ['test/gone.test.ts', 3],
  ]);
  const ran = new Map([
    ['test/a.test.ts', 1.234],
    ['test/c.test.ts', 2],
  ]);
  assert.equal(mergeTimes(old, ran, cwd), '1.2\ttest/a.test.ts\n8\ttest/b.test.ts\n2\ttest/c.test.ts\n');
});

test("a folder expands to the files node's own patterns pick in it, and a file stays itself", () => {
  const cwd = join(scratch.dir, 'expand');
  mkdirSync(join(cwd, 'test', 'sub'), { recursive: true });
  for (const f of ['b.test.ts', 'a.test.mjs', 'helpers.ts', 'sub/c.test.ts', 'x-test.js', 'test-y.ts', 'notes.md']) writeFileSync(join(cwd, 'test', f), '');
  const rel = (fs: string[]) => fs.map((f) => f.slice(cwd.length + 1));
  assert.deepEqual(rel(expand(['test/'], cwd)), ['test/a.test.mjs', 'test/b.test.ts', 'test/sub/c.test.ts', 'test/test-y.ts', 'test/x-test.js']);
  assert.deepEqual(rel(expand(['test/b.test.ts'], cwd)), ['test/b.test.ts']);
});

test('a run starts its files in that order, reports as the CLI did, fails on a failed test, and keeps the new times', async () => {
  const cwd = join(scratch.dir, 'run');
  mkdirSync(join(cwd, 'test'), { recursive: true });
  for (const n of ['a', 'b', 'c']) writeFileSync(join(cwd, 'test', `${n}.test.mjs`), `import test from 'node:test';\nimport { appendFileSync } from 'node:fs';\ntest('${n}', () => { appendFileSync('started', '${n}' + (process.env.CITADEL_TEST_TIMES ? ' saw the times file' : '') + '\\n'); });\n`);
  writeFileSync(join(cwd, 'test', 'red.test.mjs'), "import test from 'node:test';\ntest('red', () => { throw new Error('no'); });\n");
  const times = join(cwd, 'times.tsv');
  writeFileSync(times, '1\ttest/a.test.mjs\n5\ttest/b.test.mjs\n3\ttest/c.test.mjs\n9\ttest/red.test.mjs\n');
  const r = await new Promise<{ code: number | null; out: string }>((res) =>
    execFile(process.execPath, [runner, '--concurrency', '1', '--timeout', '30000', '--failed-to', 'failed', '--', 'test/'], { cwd, env: { ...process.env, NODE_TEST_CONTEXT: undefined, CITADEL_TEST_PROGRESS_TO: undefined, CITADEL_TEST_TIMES: times } }, (e, out) => res({ code: e ? (e.code as number) : 0, out })),
  );
  assert.equal(r.code, 1, r.out);
  assert.equal(readFileSync(join(cwd, 'started'), 'utf8'), 'b\nc\na\n', 'longest first, and the tests never see the times file');
  assert.match(r.out, /^ℹ fail 1$/m);
  assert.match(r.out, /^ℹ skipped 0$/m);
  assert.match(readFileSync(join(cwd, 'failed'), 'utf8'), /^test\/red\.test\.mjs\t\d+\n$/);
  const kept = readTimes(times);
  assert.deepEqual([...kept.keys()].sort(), ['test/a.test.mjs', 'test/b.test.mjs', 'test/c.test.mjs', 'test/red.test.mjs']);
  assert.ok(
    [...kept.values()].every((s) => s < 5),
    "this run's times replaced the old ones",
  );
});

test('a run ends once its tests do, even when a file leaves a handle open (the CLI path had --test-force-exit)', async () => {
  const cwd = join(scratch.dir, 'force-exit');
  mkdirSync(join(cwd, 'test'), { recursive: true });
  writeFileSync(join(cwd, 'test', 'open.test.mjs'), "import test from 'node:test';\nsetInterval(() => {}, 1000);\ntest('passes', () => {});\n");
  const r = await new Promise<{ code: number | null; out: string; killed: boolean }>((res) =>
    execFile(process.execPath, [runner, '--concurrency', '1', '--timeout', '30000', '--', 'test/'], { cwd, timeout: 20_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined, CITADEL_TEST_PROGRESS_TO: undefined, CITADEL_TEST_TIMES: undefined } }, (e, out) =>
      res({ code: e ? (e.code as number) : 0, out, killed: !!e?.killed }),
    ),
  );
  assert.equal(r.killed, false, 'the run hung on the open handle');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^ℹ pass 1$/m);
});

// Overlapping suites (#1871): each suite's window file is in one folder every runner on the machine shares.
test('a suite alone runs all its files at once; overlapping ones split them, never below one', () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((n) => filesAtOnce(16, n)),
    [16, 8, 6, 4],
  );
  assert.deepEqual(
    [0, 1, 2, 9].map((n) => filesAtOnce(8, n)),
    [8, 4, 3, 1],
    "a ship's own check starts from 8",
  );
});

test("other suites are the open windows written in the last minute: not this run's own, an ended one or a killed run's", () => {
  const dir = join(scratch.dir, 'windows');
  mkdirSync(dir);
  const now = Date.now();
  const put = (name: string, text: string, ageS = 0) => {
    writeFileSync(join(dir, name), text);
    utimesSync(join(dir, name), (now - ageS * 1000) / 1000, (now - ageS * 1000) / 1000);
  };
  put('me', '100 0\n');
  assert.equal(otherSuites(join(dir, 'me'), now), 0);
  put('ended', '100 160\n');
  put('killed', '100 0\n', 61);
  put('empty', '');
  assert.equal(otherSuites(join(dir, 'me'), now), 0);
  put('live', '100 0\n', 59);
  put('live2', '100 0\n');
  assert.equal(otherSuites(join(dir, 'me'), now), 2);
  assert.equal(otherSuites(join(dir, 'none', 'me'), now), 0, 'no windows folder: alone');
});

// Runs `files` files of 4 at once, each logging its start and end, with a window folder; `during` changes the windows mid-run.
async function overlapRun(name: string, files: number, during: (win: string, log: () => string[]) => Promise<void>) {
  const cwd = join(scratch.dir, name);
  const win = join(cwd, 'windows');
  mkdirSync(join(cwd, 'test'), { recursive: true });
  mkdirSync(win);
  writeFileSync(join(win, 'me'), '100 0\n');
  const body =
    // timing-ok: each file holds its place long enough to overlap the others
    "import test from 'node:test';\nimport { appendFileSync } from 'node:fs';\nappendFileSync('log', '+\\n');\ntest('t', async () => { await new Promise((r) => setTimeout(r, 600)); if (process.env.CITADEL_SUITE_GATE || process.env.CITADEL_SUITE_WINDOW) throw new Error('the gate leaked'); appendFileSync('log', '-\\n'); });\n";
  for (let i = 0; i < files; i++) writeFileSync(join(cwd, 'test', `f${String(i).padStart(2, '0')}.test.mjs`), body);
  const log = () => {
    try {
      return readFileSync(join(cwd, 'log'), 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  const changes = during(win, log); // its first windows are written before the run starts
  const env = { ...process.env, NODE_TEST_CONTEXT: undefined, CITADEL_TEST_PROGRESS_TO: undefined, CITADEL_TEST_TIMES: undefined, RUNNER_TEMP: cwd, CITADEL_SUITE_WINDOW: join(win, 'me') };
  const child = new Promise<{ code: number | null; out: string }>((res) => execFile(process.execPath, [runner, '--concurrency', '4', '--timeout', '30000', '--', 'test/'], { cwd, env, timeout: 50_000 }, (e, out) => res({ code: e ? ((e.code as number | null) ?? -1) : 0, out })));
  const [r] = await Promise.all([child, changes]);
  // How many ran at once after each start, in order.
  let n = 0;
  const atOnce: number[] = [];
  for (const l of log()) {
    n += l === '+' ? 1 : -1;
    if (l === '+') atOnce.push(n);
  }
  return { ...r, atOnce };
}

test('a run beside another suite holds its files to its share, and nothing a test starts sees the gate', async () => {
  const r = await overlapRun('beside', 8, async (win) => writeFileSync(join(win, 'other'), '100 0\n'));
  assert.equal(r.code, 0, r.out);
  assert.equal(r.atOnce.length, 8);
  assert.ok(Math.max(...r.atOnce) <= 2, `2 of 4 at once beside one other suite, got ${r.atOnce}`);
  assert.match(r.out, /1 other suite\(s\) on this machine, so 2 test files at once \(4 alone\)/);
});

test('a run steps down when another suite starts, and back up once it ends', async () => {
  const r = await overlapRun('steps', 40, async (win, log) => {
    const starts = () => log().filter((l) => l === '+').length;
    await until('the first four files to start', () => starts() >= 4);
    writeFileSync(join(win, 'other'), '100 0\n');
    const beat = setInterval(() => utimesSync(join(win, 'other'), new Date(), new Date()), 500);
    const at = starts();
    try {
      await until('18 more files to start', () => starts() >= at + 18, 40_000);
    } finally {
      clearInterval(beat);
      rmSync(join(win, 'other'));
    }
  });
  assert.equal(r.code, 0, r.out);
  const most = (from: number, to?: number) => Math.max(...r.atOnce.slice(from, to));
  assert.ok(most(0, 5) > 2, `alone at first: ${r.atOnce}`);
  assert.ok(most(18, 22) <= 2, `stepped down: ${r.atOnce}`);
  assert.ok(most(30) > 2, `stepped back up: ${r.atOnce}`);
});
