import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent as apply, createProgress, progressLine } from '../public/progress.js';

const applyEvent = (p: ReturnType<typeof createProgress>, kind: string, data: unknown, at: number) => apply(p, kind, data as never, at);
import { shipTickInput } from '../src/turn-progress.ts';

// #2278: a minion's plan with ship steps still open after its ship went through read "Paused at: …" for good.
const call = (id: string, steps: object[]) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__thread__plan', input: { steps } }] } });
const done = (p: ReturnType<typeof createProgress>) => applyEvent(p, 'claude', { type: 'result', is_error: false }, 9000);

function planned(extra: object[] = []) {
  const p = createProgress();
  applyEvent(
    p,
    'claude',
    call('c1', [
      { n: 1, step: 'Find it', kind: 'read', status: 'done' },
      { n: 2, step: 'Fix it', kind: 'build', status: 'done' },
      { n: 3, step: 'Self-review, ship and release', kind: 'ship', status: 'doing' },
      { n: 4, step: 'Next piece', kind: 'build', status: 'todo' },
      { n: 5, step: 'Ship the next piece', kind: 'ship', status: 'todo' },
      ...extra,
    ]),
    1000,
  );
  done(p);
  return p;
}

test('the server ticks the open ship step and those before it, after the shipped line', () => {
  const p = planned();
  assert.match(progressLine(p, false), /Paused at/, 'before: the bar is stuck on the ship step');
  const input = shipTickInput(p)!;
  assert.deepEqual(
    input.steps.map((s) => s.n),
    [3],
    'only the open step up to the first ship; later pieces stay',
  );
  applyEvent(p, 'claude', call('server-ship-1', input.steps), 2000);
  done(p);
  assert.doesNotMatch(progressLine(p, false), /Paused at: Self-review/);
  assert.equal(p.tasks.find((t) => t.n === 3)!.status, 'completed');
  assert.notEqual(p.tasks.find((t) => t.n === 4)!.status, 'completed', 'the next piece is not ticked');
  assert.deepEqual(shipTickInput(planned()), input, 'replays the same');
});

test('earlier open steps tick with it; a plan with no open ship step ticks nothing', () => {
  const p = createProgress();
  applyEvent(
    p,
    'claude',
    call('c1', [
      { n: 1, step: 'Build', kind: 'build', status: 'doing' },
      { n: 2, step: 'Ship', kind: 'ship', status: 'todo' },
      { n: 3, step: 'Later', kind: 'build', status: 'todo' },
    ]),
    1000,
  );
  assert.deepEqual(
    shipTickInput(p)!.steps.map((s) => s.n),
    [1, 2],
  );
  assert.equal(shipTickInput(createProgress()), null);
  const q = createProgress();
  applyEvent(q, 'claude', call('c2', [{ n: 1, step: 'Read', kind: 'read', status: 'doing' }]), 1000);
  assert.equal(shipTickInput(q), null);
});
