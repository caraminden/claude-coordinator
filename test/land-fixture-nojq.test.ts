// CI's desktop runner (the WSL citadel-ci distro) has no jq, and main went red on it (#2326): the fake gh the land tests
// share must answer every --jq shape in bash, so no land test needs a jq on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the land fixture never shells out to jq', () => {
  const src = readFileSync(new URL('./land-fixture.ts', import.meta.url), 'utf8');
  const calls = src.split('\n').filter((l) => /(^|[\s;&|("'])jq(\s|$)/.test(l) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('#'));
  assert.deepEqual(calls, []);
});
