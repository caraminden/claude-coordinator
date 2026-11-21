import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFlakes } from '../src/flakes.ts';

// #1063 (383b9e84): a flake's detail is the output's other lines naming the file, so a run-tests flake (which has
// no failing lines) still carries its "passed alone: likely load" line, and land.sh's own marker line is not detail.
test('a run-tests flake keeps its "passed alone" line as detail; a land.sh marker line is not detail', () => {
  const out = [
    'land: flake: test/a.test.ts · in CI',
    'run-tests: test/b.test.ts: failed in the full run, passed alone: likely load (1-minute load 9.1)',
  ].join('\n');
  const [a, b] = parseFlakes(out);
  assert.equal(a.file, 'test/a.test.ts');
  assert.equal(a.detail, '', `land.sh's marker line is not detail: ${a.detail}`);
  assert.equal(b.file, 'test/b.test.ts');
  assert.match(b.detail, /passed alone: likely load/);
});
