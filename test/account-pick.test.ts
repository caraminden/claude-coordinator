import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickAccount, windowNow, type Meter, type PickAccount, type PickInput } from '../src/account-pick.ts';

const H = 3600_000;
const NOW = 1_800_000_000_000;
const week = (utilization: number, resetsIn: number, session?: number): Meter => ({
  weekly: { utilization, resetsAt: NOW + resetsIn },
  session: session === undefined ? null : { utilization: session, resetsAt: NOW + 2 * H },
});
/** Account 1 at 40% resetting in 5 days, account 2 at 10% resetting in 1 day, unless a case says otherwise. */
function input(over: Partial<PickInput> & { meters?: Record<number, Meter | null> } = {}): PickInput {
  const meters = over.meters ?? { 1: week(0.4, 120 * H), 2: week(0.1, 24 * H) };
  return { accounts: [{ n: 1 }, { n: 2 }], meter: (n) => meters[n] ?? null, nextUp: 1, now: NOW, ...over };
}
const pick = (over: Parameters<typeof input>[0] = {}) => pickAccount(input(over));

test('a cold turn goes to the account whose week resets soonest and still has room', () => {
  assert.deepEqual(pick(), { n: 2, nextUp: 2, why: 'soonest' });
});

test('a warm session stays on its account, even when another resets sooner', () => {
  assert.deepEqual(pick({ warm: 1 }), { n: 1, nextUp: 2, why: 'warm' }, 'new work still goes to 2');
  assert.equal(pick({ warm: 1, meters: { 1: week(0.99, 120 * H), 2: week(0.1, 24 * H) } })?.n, 1, 'a nearly full week is not a limit: the warm session stays');
});

test('a hard limit moves even a warm session', () => {
  assert.deepEqual(pick({ warm: 2, accounts: [{ n: 1 }, { n: 2, limitedUntil: NOW + H }] }), { n: 1, nextUp: 1, why: 'soonest' });
  assert.equal(pick({ warm: 2, accounts: [{ n: 1 }, { n: 2, expired: NOW - H }] })?.n, 1, 'and so does a failed sign-in');
});

test('an account with no room loses new work: a full week, or a full 5-hour window', () => {
  assert.equal(pick({ meters: { 1: week(0.4, 120 * H), 2: week(0.98, 24 * H) } })?.n, 1);
  assert.equal(pick({ meters: { 1: week(0.4, 120 * H), 2: week(0.1, 24 * H, 0.95) } })?.n, 1);
});

test('the 5-hour window has hysteresis: next-up keeps work below 90%, another takes it only below 70%', () => {
  // 2 resets sooner, but its 5-hour window sits at 80%: it is next-up, so it keeps work...
  assert.equal(pick({ nextUp: 2, meters: { 1: week(0.4, 120 * H), 2: week(0.1, 24 * H, 0.8) } })?.n, 2);
  // ...but once work has moved to 1, 2 doesn't get it back at the same 80%.
  assert.equal(pick({ nextUp: 1, meters: { 1: week(0.4, 120 * H), 2: week(0.1, 24 * H, 0.8) } })?.n, 1);
  assert.equal(pick({ nextUp: 1, meters: { 1: week(0.4, 120 * H), 2: week(0.1, 24 * H, 0.6) } })?.n, 2);
});

test('next-up keeps new work unless another resets at least 6 hours sooner', () => {
  assert.equal(pick({ meters: { 1: week(0.4, 30 * H), 2: week(0.1, 25 * H) } })?.n, 1, '5 hours sooner: no swap');
  assert.equal(pick({ meters: { 1: week(0.4, 32 * H), 2: week(0.1, 25 * H) } })?.n, 2, '7 hours sooner: swap');
});

test('a pin wins for cold turns, but not over a warm session; a limited pin falls over and comes back after its reset', () => {
  assert.deepEqual(pick({ pinned: 1 }), { n: 1, nextUp: 2, why: 'pinned' });
  assert.equal(pick({ pinned: 1, warm: 2 })?.n, 2, 'warm minions move at their next cold moment');
  const limited: PickAccount[] = [{ n: 1, limitedUntil: NOW + H }, { n: 2 }];
  assert.equal(pick({ pinned: 1, accounts: limited })?.n, 2, 'falls over');
  assert.equal(pickAccount({ ...input({ pinned: 1, accounts: limited }), now: NOW + 2 * H })?.n, 1, 'and comes back once it resets');
});

test('a meter past its reset counts as empty, with its next reset a week on', () => {
  assert.deepEqual(windowNow({ utilization: 0.95, resetsAt: NOW - H }, NOW, 168 * H), { utilization: 0, resetsAt: NOW - H + 168 * H });
  // Account 1 read 100% but its week reset an hour ago: it has room again, and its next reset (167 h) is later than 2's.
  assert.equal(pick({ meters: { 1: week(1, -H), 2: week(0.1, 24 * H) } })?.n, 2);
  assert.equal(pick({ meters: { 1: week(1, -H), 2: week(0.99, 24 * H) } })?.n, 1);
});

test('an account with no meter yet takes a cold turn, which reads its meter', () => {
  assert.equal(pick({ meters: { 1: week(0.4, 120 * H), 2: null } })?.n, 2);
});

test('with no room anywhere, it keeps next-up while ready, else the next ready one, else any whose sign-in holds', () => {
  const full = { 1: week(0.99, 120 * H), 2: week(0.99, 24 * H) };
  assert.deepEqual(pick({ meters: full }), { n: 1, nextUp: 1, why: 'full' });
  assert.equal(pick({ meters: full, accounts: [{ n: 1, limitedUntil: NOW + H }, { n: 2 }] })?.n, 2);
  assert.equal(pick({ meters: full, accounts: [{ n: 1, limitedUntil: NOW + H }, { n: 2, limitedUntil: NOW + 2 * H }] })?.n, 1);
  assert.equal(pick({ accounts: [{ n: 1, expired: 1 }, { n: 2, expired: 1 }] }), null);
});
