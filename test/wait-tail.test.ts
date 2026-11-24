import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { readTail } from '../src/wait-tail.ts';
import { tempRoot } from './helpers.ts';

// A waiting job's newest output lines (#1681): what src/wait-tail.ts reads from the tail of an output file.
const tmp = tempRoot('wait-tail-');
after(async () => tmp.teardown());
const file = (name: string, text: string) => {
  const f = join(tmp.dir, name);
  writeFileSync(f, text);
  return f;
};

test('the last lines, newest last, a trailing newline adds none', async () => {
  assert.deepEqual(await readTail(file('a', 'one\ntwo\nthree\n'), 2), ['two', 'three']);
});

test('a \\r progress line keeps only its latest state', async () => {
  assert.deepEqual(await readTail(file('b', 'start\n10%\r50%\r100%\ndone\n'), 20), ['start', '100%', 'done']);
});

test('an empty or missing file has no lines', async () => {
  assert.deepEqual(await readTail(file('c', ''), 20), []);
  assert.deepEqual(await readTail(join(tmp.dir, 'nope'), 20), []);
});

test('a huge line is cut short and reading it stays cheap', async () => {
  const [line] = await readTail(file('d', `${'x'.repeat(5_000_000)}\n`), 20);
  assert.ok(line.length <= 300);
});

test('secrets are hidden, colour codes dropped', async () => {
  assert.deepEqual(await readTail(file('e', '\x1b[32mok\x1b[0m token=abc123secret\n'), 20), ['ok token=[hidden]']);
});
