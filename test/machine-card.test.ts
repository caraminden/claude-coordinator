import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUID, sharedFlip, threadParts } from '../public/machine-card.js';
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

test("a bare GUID guest (WSL's utility VM) gets no VM chip, a named one does", () => {
  assert.equal(GUID.test('FF1FA8C6-38C1-4937-B549-C53049221F41'), true);
  assert.equal(GUID.test('citadel-test-box'), false);
});

// #2250: why a PC's pool is held under its caps, and the one-click size for a worker still on the old fixed caps.
type Pool = Parameters<typeof import('../public/machine-card.js').poolHeld>[0];
const poolOf = (over: Partial<Pool> & { why?: string }): Pool => {
  const { why, ...rest } = over;
  return { id: 7, name: 'desk', owner: 'Cara', mine: true, used: 1, size: 1, cap: 6, pool: { size: 1, at: 1, why }, min: 1, max: 12, waiting: 2, block: null, priority: null, balanced: null, away: null, pressed: null, limits: [], ...rest } as Pool;
};

test("the For me tile says in plain words why a PC's pool runs fewer minions than its caps, and nothing when it doesn't", async () => {
  const { poolHeld } = await import('../public/machine-card.js');
  assert.equal(poolHeld(poolOf({ size: 6 })), null, 'at its caps');
  assert.equal(poolHeld(poolOf({ block: 'its worker is away' })), null, 'a blocked PC says its block instead');
  assert.match(poolHeld(poolOf({ why: 'CPU pressure 50% there' }))!, /50% pressure/);
  assert.match(poolHeld(poolOf({ why: 'CPU pressure 50% there', pressed: 'CPU pressure 61%' }))!, /61% pressure/);
  assert.match(poolHeld(poolOf({ why: 'memory is tight there' }))!, /memory was tight/);
  assert.match(poolHeld(poolOf({ why: '1.5 GB free there' }))!, /1\.5 GB/);
  assert.match(poolHeld(poolOf({ balanced: '2 CI jobs waiting' }))!, /2 CI jobs waiting/);
  assert.match(poolHeld(poolOf({ size: 2, pool: { size: 2, at: 1, fixed: { size: 2, by: 'Josh' } } }))!, /set to 2 by Josh/);
  assert.equal(poolHeld(poolOf({ size: 2, balanced: '1 CI job waiting', pool: { size: 4, at: 1, fixed: { size: 4, by: 'Josh' } } })), '2 now, of its 6: 1 CI job waiting', 'what holds it under the fixed size wins');
  assert.match(poolHeld(poolOf({ size: 3, max: 3 }))!, /most is set to 3/);
  assert.match(poolHeld(poolOf({ size: 2, why: 'desk is calm and turns wait' }))!, /calm/);
});

test("a worker still on the old fixed caps, none set on the page, is offered its PC's size; one set by hand, or someone else's, is not", async () => {
  const { setAccount } = await import('../public/base.js');
  const { sizeOffer } = await import('../public/machine-role-cards.js');
  setAccount(JSON.parse('{"id":1,"name":"Cara","login":"cara"}'));
  const old = { workers: 6, threads: 8, memory_gb: 24, disk_gb: 60 };
  type Row = Parameters<typeof sizeOffer>[0];
  // Only the fields the offer reads; the rest of a row doesn't matter to it.
  const row = (caps: Record<string, number>, page: Record<string, number> = {}, over: Record<string, unknown> = {}): Row => JSON.parse(JSON.stringify({ id: 7, owner_id: 1, roles: [{ role: 'turns', on: true, caps: page }], worker: { here: true, caps, pc: { threads: 32, memory_gb: 31 }, ...over } }));
  assert.deepEqual(sizeOffer(row(old)), { workers: 7, threads: 24, memory_gb: 24 });
  assert.equal(sizeOffer(row({ ...old, threads: 12 })), null, 'its owner changed them on that PC');
  assert.equal(sizeOffer(row(old, { threads: 16 })), null, 'its owner set them on the page');
  assert.deepEqual(sizeOffer(row(old, { disk_gb: 80 })), { workers: 7, threads: 24, memory_gb: 24 }, 'a disk cap alone on the page leaves the rest to offer');
  assert.equal(sizeOffer(row(old, {}, { pc: { threads: 8, memory_gb: 16 } })), null, 'a PC no bigger than the old caps has nothing better to offer');
  assert.deepEqual(sizeOffer(row(old, {}, { pc: { threads: 16, memory_gb: 32 } })), { workers: 6, threads: 12, memory_gb: 24 }, 'it never offers less than a cap has: 16 threads size to 5 minions, so it keeps 6');
  assert.equal(sizeOffer(row(old, {}, { pc: null })), null, 'an older worker that does not say its size');
  assert.equal(sizeOffer(row(old, {}, { here: false })), null, 'away');
  assert.equal(sizeOffer({ ...row(old), owner_id: 2 }), null, "someone else's PC");
  setAccount(null);
});
