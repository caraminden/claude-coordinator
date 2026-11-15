import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gitOut } from '../src/git.ts';

test('gitOut trims by default, keeps the output as it came with trim: false, and gives null on failure', async () => {
  assert.equal(await gitOut(['--version'], '.'), (await gitOut(['--version'], '.', { trim: false }))!.trim());
  assert.match((await gitOut(['--version'], '.', { trim: false }))!, /\n$/);
  assert.equal(await gitOut(['rev-parse', '--verify', 'no-such-ref-xyz'], '.'), null);
  assert.equal(await gitOut(['--version'], '/no/such/dir'), null);
});
