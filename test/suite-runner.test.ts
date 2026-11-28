import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { expand, mergeTimes, order, readTimes, shard } from '../tools/suite-runner.ts';
import { tempRoot } from './helpers.ts';

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

// A ship's run on GitHub, split 20 ways (#2209, ADR 0043): each shard works out the same split and runs its own part.
test('the shards split the files between them, each file once, longest first onto the emptiest, with no time as the median', () => {
  const cwd = '/r';
  const secs = [200, 190, 180, 60, 50, 40, 30, 20, 10, 5, 5, 1];
  const files = secs.map((_, i) => `/r/test/f${String(i).padStart(2, '0')}.test.ts`);
  const times = new Map(secs.map((s, i) => [`test/f${String(i).padStart(2, '0')}.test.ts`, s]));
  const parts = [0, 1, 2, 3].map((i) => shard(files, times, i, 4, cwd));
  assert.deepEqual(parts.flat().sort(), files, 'every file in exactly one shard');
  const load = parts.map((p) => p.reduce((n, f) => n + times.get(f.slice(3))!, 0));
  assert.deepEqual(load, [200, 196, 200, 195], 'each next-longest file onto the emptiest shard, ties to the lowest');
  // A new file counts as the median (the 6th of 11 known: 40 s with f11 unknown), not first or last.
  const fresh = new Map(times);
  fresh.delete('test/f11.test.ts');
  const withNew = [0, 1, 2, 3].map((i) => shard(files, fresh, i, 4, cwd));
  assert.deepEqual(withNew.flat().sort(), files);
  // More shards than files: the rest are empty.
  assert.deepEqual(shard(files.slice(0, 2), times, 3, 4, cwd), []);
});

test('a shard run runs only its own files and keeps only their times; --merge-times puts the shards together', async () => {
  const cwd = join(scratch.dir, 'shard');
  mkdirSync(join(cwd, 'test'), { recursive: true });
  for (const n of ['a', 'b', 'c', 'd']) writeFileSync(join(cwd, 'test', `${n}.test.mjs`), `import test from 'node:test';\nimport { appendFileSync } from 'node:fs';\ntest('${n}', () => { appendFileSync('started', '${n}' + (process.env.CITADEL_TEST_SHARD ? ' saw the shard' : '') + '\\n'); });\n`);
  const old = join(cwd, 'old.tsv');
  writeFileSync(old, '9\ttest/a.test.mjs\n7\ttest/b.test.mjs\n3\ttest/c.test.mjs\n1\ttest/d.test.mjs\n4\ttest/gone.test.mjs\n');
  const runShard = (i: number) => {
    const times = join(cwd, `times-${i}.tsv`);
    writeFileSync(times, readFileSync(old));
    return new Promise<{ code: number | null; out: string; times: string }>((res) =>
      execFile(process.execPath, [runner, '--concurrency', '1', '--timeout', '30000', '--', 'test/'], { cwd, env: { ...process.env, NODE_TEST_CONTEXT: undefined, CITADEL_TEST_PROGRESS_TO: undefined, CITADEL_TEST_TIMES: times, CITADEL_TEST_SHARD: `${i}/2` } }, (e, out) =>
        res({ code: e ? (e.code as number) : 0, out, times }),
      ),
    );
  };
  const one = await runShard(1);
  assert.equal(one.code, 0, one.out);
  assert.match(one.out, /^suite-runner: shard 1 of 2: 2 test file\(s\)$/m);
  assert.equal(readFileSync(join(cwd, 'started'), 'utf8'), 'b\nc\n', 'shard 1 of 2 is b (7 s) and c (3 s), and its tests never see the shard');
  assert.deepEqual([...readTimes(one.times).keys()].sort(), ['test/b.test.mjs', 'test/c.test.mjs'], "only this shard's times");
  const zero = await runShard(0);
  assert.equal(zero.code, 0, zero.out);
  const merged = await new Promise<string>((res) => execFile(process.execPath, [runner, '--merge-times', old, zero.times, one.times], { cwd }, (_e, out) => res(out)));
  writeFileSync(join(cwd, 'merged.tsv'), merged);
  assert.deepEqual([...readTimes(join(cwd, 'merged.tsv')).keys()], ['test/a.test.mjs', 'test/b.test.mjs', 'test/c.test.mjs', 'test/d.test.mjs'], "every shard's files, and none deleted");
  assert.ok(
    [...readTimes(join(cwd, 'merged.tsv')).values()].every((s) => s < 1),
    "the shards' new times, not the old ones",
  );
});

test('a shard setting that does not read stops the run before any test', async () => {
  const r = await new Promise<{ code: number | null; err: string }>((res) =>
    execFile(process.execPath, [runner, '--concurrency', '1', '--', 'test/'], { cwd: scratch.dir, env: { ...process.env, NODE_TEST_CONTEXT: undefined, CITADEL_TEST_SHARD: '20/20' } }, (e, _o, err) => res({ code: e ? (e.code as number) : 0, err })),
  );
  assert.equal(r.code, 1);
  assert.match(r.err, /CITADEL_TEST_SHARD is <index>\/<total> from 0, not 20\/20/);
});
