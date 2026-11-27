import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharedFlip, threadParts } from '../public/machine-card.js';
import { pickRoles } from '../public/machine-connect.js';

// The Machines page, take B (Build 10 H3, specs/one-kind-of-machine.md section 4): the For my schemes switch, the
// thread split bar and the Connect wizard's role pick.

type Role = { role: string; on: boolean };
const roles = (on: Record<string, boolean>): Role[] => Object.entries(on).map(([role, v]) => ({ role, on: v }));

test('For my schemes: any shared role on switches every one that is on off, and leaves the rest alone', () => {
  const flip = sharedFlip(roles({ ci: true, builds: false, screen: true, gpu: false, tools: false }), () => true);
  assert.deepEqual(flip, { on: false, roles: ['ci', 'screen'] });
});

test('For my schemes: none on switches on only the roles this PC can do', () => {
  const flip = sharedFlip(roles({ ci: false, builds: false, screen: false, gpu: false, tools: false }), (r) => r !== 'gpu' && r !== 'screen');
  assert.deepEqual(flip, { on: true, roles: ['ci', 'builds', 'tools'] });
});

test('For my schemes: a PC that can do nothing it could share has nothing to switch on', () => {
  assert.deepEqual(
    sharedFlip(roles({ ci: false }), () => false),
    { on: true, roles: [] },
  );
});

test('the split bar: schemes and me from their live shares, other for the rest of what is busy, free for what is idle', () => {
  assert.deepEqual(threadParts({ total: 32, busy: 20, me: 6, us: 10, meOn: true, usOn: true }), [
    { part: 'me', n: 6 },
    { part: 'us', n: 10 },
    { part: 'other', n: 4 },
    { part: 'free', n: 12 },
  ]);
});

test('the split bar: a side that is off takes no part, and its use counts as other, never as free', () => {
  assert.deepEqual(threadParts({ total: 16, busy: 10, me: 8, us: 6, meOn: false, usOn: true }), [
    { part: 'us', n: 6 },
    { part: 'other', n: 4 },
    { part: 'free', n: 6 },
  ]);
});

test('the split bar: a side that is on with no live number is left out, never guessed: its use is other', () => {
  // Turns on a PC whose turns don't run in WSL: no number for me, so what they use shows as busy, not as free.
  assert.deepEqual(threadParts({ total: 32, busy: 12, me: null, us: 4, meOn: true, usOn: true }), [
    { part: 'us', n: 4 },
    { part: 'other', n: 8 },
    { part: 'free', n: 20 },
  ]);
});

test('the split bar: no thread count or no CPU sample, no bar; parts never add up past what is busy or the total', () => {
  assert.deepEqual(threadParts({ total: null, busy: 8, me: 8, us: 4, meOn: true, usOn: true }), []);
  assert.deepEqual(threadParts({ total: 32, busy: null, me: 8, us: 4, meOn: true, usOn: true }), []);
  // WSL's share overlaps the runners inside it: schemes take theirs first, me gets what is left of busy.
  assert.deepEqual(threadParts({ total: 8, busy: 8, me: 6, us: 6, meOn: true, usOn: true }), [
    { part: 'me', n: 2 },
    { part: 'us', n: 6 },
  ]);
  assert.deepEqual(threadParts({ total: 8, busy: 12, me: 0, us: 0, meOn: true, usOn: true }), [{ part: 'other', n: 8 }]);
});

test('Connect, what it is for: Both, Just me and My schemes pick their roles, less any this PC cannot do', () => {
  const all = ['tools', 'screen', 'ci', 'turns', 'gpu', 'builds'].map((role) => ({ role, on: false }));
  const why = (r: { role: string }) => (r.role === 'gpu' ? 'That PC reported no GPU.' : null);
  const names = (use: 'both' | 'me' | 'us') => pickRoles({ roles: all }, use, why).map((r) => r.role);
  assert.deepEqual(names('both'), ['turns', 'ci', 'builds', 'screen', 'tools']);
  assert.deepEqual(names('me'), ['turns']);
  assert.deepEqual(names('us'), ['ci', 'builds', 'screen', 'tools']);
});

test("a shared role its owner switches lends it to every turn in its schemes, and off takes that back; an admin's switch and Minion turns never do (Build 10, ask 1)", async () => {
  const { roleFields } = await import('../public/machine-card.js');
  assert.deepEqual(roleFields('screen', true, true), { on: true, everyone: true });
  assert.deepEqual(roleFields('tools', false, true), { on: false, everyone: false });
  assert.deepEqual(roleFields('screen', true, false), { on: true });
  assert.deepEqual(roleFields('turns', true, true), { on: true });
});
