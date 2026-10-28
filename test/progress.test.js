import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgress, progressLine, withoutCount } from '../public/progress.js';

// A plan of six steps with the given statuses: c(ompleted), i(n progress), p(ending).
const plan = (statuses) => ({
  ...createProgress(),
  tasks: [...statuses].map((s, n) => ({
    id: String(n + 1), subject: `Move turns ${n + 1}`, activeForm: `Moving turns ${n + 1}`, actions: 0,
    status: { c: 'completed', i: 'in_progress', p: 'pending' }[s],
  })),
});

test('the step underway is worded as "Step N of M", not a bare fraction', () => {
  assert.equal(progressLine(plan('ippppp'), true), 'Step 1 of 6: Moving turns 1…');
  assert.equal(progressLine(plan('ccippp'), true), 'Step 3 of 6: Moving turns 3…');
});

test('paused, done and between-steps lines read sensibly', () => {
  assert.equal(progressLine(plan('cipppp'), false), 'Paused at step 2 of 6: Move turns 2');
  assert.equal(progressLine(plan('cccccc'), false), 'Done · 6/6 steps');
  assert.equal(progressLine(plan('ccpppp'), true), 'Working… 2 of 6 done');
  assert.equal(progressLine(plan('pppppp'), true), 'Planning… 0 of 6 done');
  assert.equal(progressLine(plan('ccpppp'), false), 'Paused… 2 of 6 done');
});

test('a finished plan says nothing about a new running turn', () => {
  assert.equal(progressLine({ ...plan('cccccc'), lastAction: 'Read app.js' }, true), 'Working… Read app.js');
});

test('withoutCount drops the count from every form, old and new', () => {
  const cases = {
    'Step 1 of 6: Moving turns into units…': 'Moving turns into units…',
    'Paused at step 2 of 6: Move turns': 'Paused at: Move turns',
    'Working… 2 of 6 done': 'Working…',
    'Done · 6/6 steps': 'Done',
    // The pre-#72 form, still in stored last_activity until the server restarts.
    'Moving turns into units… 1/6': 'Moving turns into units…',
    'Paused at: Move turns 1/6': 'Paused at: Move turns',
    'Working… Read app.js': 'Working… Read app.js',
  };
  for (const [line, want] of Object.entries(cases)) assert.equal(withoutCount(line), want, line);
});
