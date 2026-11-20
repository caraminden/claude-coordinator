import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciState, ciVerdict, type CiState } from '../src/ci-verdict.ts';
import { greenShas } from '../src/last-green.ts';
import { verdict, check } from '../src/github.ts';

test('every conclusion has one answer', () => {
  const table: [string, string | null, CiState][] = [
    ['completed', 'success', 'pass'], ['completed', 'skipped', 'skip'], ['completed', 'neutral', 'skip'],
    ['completed', 'stale', 'skip'], ['completed', 'cancelled', 'cancelled'], ['completed', 'failure', 'fail'],
    ['completed', 'timed_out', 'fail'], ['completed', 'action_required', 'fail'], ['completed', 'startup_failure', 'fail'],
    ['completed', null, 'fail'], ['in_progress', null, 'running'], ['queued', null, 'running'],
    ['COMPLETED', 'SUCCESS', 'pass'], ['IN_PROGRESS', null, 'running'],
  ];
  for (const [s, c, want] of table) assert.equal(ciState(s, c), want, `${s}/${c}`);
});

test('verdicts over a set of results', () => {
  assert.equal(ciVerdict([]), 'unknown');
  assert.equal(ciVerdict(['pass']), 'green');
  assert.equal(ciVerdict(['pass', 'skip']), 'green');
  assert.equal(ciVerdict(['skip', 'skip']), 'unknown');
  assert.equal(ciVerdict(['pass', 'running']), 'running');
  assert.equal(ciVerdict(['running', 'fail']), 'red');
  assert.equal(ciVerdict(['pass', 'cancelled']), 'red');
  assert.equal(ciVerdict(['pass', 'skip'], { skipBlocks: true }), 'unknown');
  assert.equal(ciVerdict(['pass', 'pass'], { skipBlocks: true }), 'green');
  assert.equal(ciVerdict(['pass', 'fail'], { skipBlocks: true }), 'red');
});

test('last green and a PR agree with it', () => {
  const run = (conclusion: string | null, status = 'completed') => ({ head_sha: 'a', workflow_id: 1, status, conclusion, created_at: '2026-01-01T00:00:00Z', file: 'x.yml' });
  assert.deepEqual(greenShas([run('success')]), ['a']);
  assert.deepEqual(greenShas([run('skipped')]), []);
  assert.deepEqual(greenShas([run('cancelled')]), []);
  assert.deepEqual(greenShas([run(null, 'in_progress')]), []);
  assert.equal(verdict([check({ name: 'a', status: 'COMPLETED', conclusion: 'STALE' }), check({ name: 'b', status: 'COMPLETED', conclusion: 'SUCCESS' })]), 'passed');
  assert.equal(verdict([check({ name: 'a', status: 'COMPLETED', conclusion: 'CANCELLED' })]), 'failed');
  assert.equal(verdict([]), null);
});
