import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import { scriptEnv } from './script-env.ts';

// tools/citadel-test (#641): a minion's own test files, run with the leak guard and a time limit, showing only the
// counts and what failed, with the full output in $TMPDIR/citadel-test.log.
const repo = join(import.meta.dirname, '..');
const bin = join(repo, 'tools', 'citadel-test');
// No NODE_TEST_CONTEXT, which makes a node --test inside a test skip its files. Its own TMPDIR: the log lands there, and the leak guard counts a process as leaked when it names a deleted folder in it.
const tmp = mkdtempSync(join(tmpdir(), 'citadel-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function file(name: string, body: string): string {
  const path = join(tmp, name);
  writeFileSync(path, `import { test, describe } from 'node:test';\nimport assert from 'node:assert/strict';\n${body}\n`);
  return path;
}

const noList = join(tmp, 'none.txt');
writeFileSync(noList, '# no repo-wide files\n');

function run(args: string[], always = noList): Promise<{ code: number | null; out: string; ms: number }> {
  const start = Date.now();
  const child = spawn(bin, args, { cwd: repo, env: scriptEnv({ TMPDIR: tmp, NODE_TEST_CONTEXT: undefined, CITADEL_TEST_ALWAYS: always, CITADEL_TEST_EXTRA: undefined }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (out += b));
  return new Promise((r) => child.on('close', (code) => r({ code, out, ms: Date.now() - start })));
}

test('a passing file gives a line of counts and where the log is', async () => {
  const r = await run([file('pass.test.ts', `test('one', () => {});\ntest('two', () => {});\ntest.skip('later', () => {});`)]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^✔ 2 passed, 0 failed, 1 skipped in [\d.]+ s\nfull output: .*citadel-test\.log\n$/);
  assert.match(readFileSync(join(tmp, 'citadel-test.log'), 'utf8'), /✔ one/, 'the spec output is in the log');
});

test('a failing test shows its file, line, suite path and the expected/actual diff', async () => {
  const f = file(
    'fail.test.ts',
    `test('fine', () => {});\ndescribe('totals', () => {\n  test('adds up', () => { assert.deepEqual({ sum: 3 }, { sum: 4 }); });\n});`,
  );
  const r = await run([f]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^✖ 1 passed, 1 failed in/);
  assert.match(r.out, /✖ .*fail\.test\.ts:5 › totals › adds up\n/);
  assert.match(r.out, /\+ {3}sum: 3\n {2}- {3}sum: 4/);
  assert.match(r.out, /at .*fail\.test\.ts:5:\d+/, 'names the line that threw');
  assert.doesNotMatch(r.out, /✖ .*› totals\n/, 'the suite failing because of it is not listed again');
});

test('a file that throws before its tests run shows what it printed', async () => {
  const r = await run([file('crash.test.ts', `throw new Error('no such fixture');`)]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✖ .*crash\.test\.ts › \(the file itself\)\n[^]*Error: no such fixture/);
});

test('--name keeps only the tests it matches', async () => {
  const r = await run([file('named.test.ts', `test('keep me', () => {});\ntest('not me', () => { throw new Error('ran'); });`), '--name', 'keep']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^✔ 1 passed, 0 failed/);
});

test('a hung test ends at the limit, named, with a line saying so', async () => {
  const f = file('hang.test.ts', `test('quick', () => {});\ntest('waits forever', () => new Promise(() => setInterval(() => {}, 1000)));`);
  const r = await run([f, '--timeout', '3']);
  assert.equal(r.code, 124, r.out);
  assert.ok(r.ms < 15_000, `it stopped at the limit, not later (${r.ms} ms)`);
  assert.match(r.out, /stopped before the end \(1 passed, 0 failed by then\)\. Still running:\n {2}.*hang\.test\.ts:4 › waits forever\n/);
  assert.match(r.out, /✖ stopped at the time limit, 3 s/);
});

test('a process a test leaves running is reported and the run fails', async () => {
  const gone = join(tmp, 'leak');
  mkdirSync(gone);
  const f = file(
    'leak.test.ts',
    `import { spawn } from 'node:child_process';\nimport { rmSync } from 'node:fs';\n` +
      `test('starts and forgets', () => { spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', ${JSON.stringify(join(gone, 'x'))}], { detached: true, stdio: 'ignore' }).unref(); rmSync(${JSON.stringify(gone)}, { recursive: true }); });`,
  );
  const r = await run([f]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✔ 1 passed, 0 failed/);
  assert.match(r.out, /The tests left 1 process\(es\) running \(now killed\)[^]*setTimeout.*leak\/x/);
});

test('no files, or a folder, is refused: the full suite is the land gate\'s', async () => {
  for (const args of [[], ['test/']]) {
    const r = await run(args);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /land gate's job/);
  }
});

// #768: the repo-wide tests ride along, so their failures show before the land.
test('the repo-wide list is added, counted, deduplicated, and a failure in it fails the run', async () => {
  const wide = file('wide.test.ts', `test('wide', () => {});\ntest('wide2', () => {});`);
  const mine = file('mine.test.ts', `test('mine', () => {});`);
  const list = join(tmp, 'list.txt');
  writeFileSync(list, `# comment\n\n${relative(repo, wide)}\n`);
  let r = await run([mine], list);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^✔ 3 passed, 0 failed \(\+1 repo-wide files\) in/);
  r = await run([mine, wide], list);
  assert.match(r.out, /^✔ 3 passed, 0 failed \(\+0 repo-wide|^✔ 3 passed, 0 failed in/, 'a file named twice runs once');
  const bad = file('bad.test.ts', `test('broken', () => { throw new Error('repo-wide break'); });`);
  writeFileSync(list, `${relative(repo, bad)}\n`);
  r = await run([mine], list);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /bad\.test\.ts.*broken/);
});

test('--name filters only the file given; the repo-wide files run apart, unfiltered', async () => {
  const wide = file('wide2.test.ts', `test('alpha', () => {});\ntest('beta', () => {});`);
  const mine = file('mine2.test.ts', `test('keep me', () => {});\ntest('not me', () => { throw new Error('ran'); });`);
  const list = join(tmp, 'list2.txt');
  writeFileSync(list, `${relative(repo, wide)}\n`);
  const r = await run([mine, '--name', 'keep'], list);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^✔ 1 passed, 0 failed in[^]*repo-wide tests[^]*✔ 2 passed, 0 failed in/);
});

test('the real list names files that exist', () => {
  for (const l of readFileSync(join(repo, 'tools', 'always-tests.txt'), 'utf8').split('\n')) {
    if (l && !l.startsWith('#')) assert.ok(existsSync(join(repo, l)), l);
  }
});
