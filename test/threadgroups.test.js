import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadSections } from '../public/threadgroups.js';

const TYPES = ['feature', 'bug', 'design', 'art', 'research', 'chore', 'other', 'ideation'];
const shape = (open, groups) => threadSections(open, TYPES, groups).map((s) => [s.key, s.current ?? false, s.rows.map((t) => t.n)]);
/** A minion numbered n of a type, with any other properties and fields. */
const m = (n, type, rest = {}, props = {}) => ({ n, properties: { ...(type && { type }), ...props }, ...rest });

test('no builds: grouped by type only, a missing or unknown type under Other', () => {
  assert.deepEqual(shape([m(1, 'bug'), m(2, 'feature'), m(3, null), m(4, 'odd'), m(5, 'other'), m(6, 'art'), m(7, 'research')]),
    [['feature', false, [2]], ['bug', false, [1]], ['art', false, [6]], ['research', false, [7]], ['other', false, [3, 4, 5]]]);
});

test('lowest build on top as current, later builds at the bottom ascending, any type', () => {
  assert.deepEqual(shape([
    m(1, 'ideation', { build: 9 }), m(2, 'chore', { build: 8 }), m(3, 'feature', { build: 8 }),
    m(4, 'bug'), m(5, 'ideation'), m(6, 'feature', { build: 10 }), m(7, 'chore'),
  ]), [['build-8', true, [2, 3]], ['bug', false, [4]], ['chore', false, [7]], ['ideation', false, [5]], ['build-9', false, [1]], ['build-10', false, [6]]]);
});

test('only the build field counts, not a build named in the title', () => {
  assert.deepEqual(shape([
    m(1, 'feature', { title: 'Major Build #7' }), m(2, 'design', { title: 'Lair Strip · Build #8' }),
    m(3, 'feature', { title: 'Workshop · Build #7', build: 9 }),
  ]), [['build-9', true, [3]], ['feature', false, [1]], ['design', false, [2]]]);
});

test('parked minions leave their type for a Parked section at the bottom, but stay in their build after the active rows (Cara, 2026-11-17)', () => {
  assert.deepEqual(shape([
    m(1, 'bug', { state: 'parked', status: 'idle' }), m(2, 'bug'), m(3, 'feature', { build: 7, state: 'parked' }),
    m(4, 'feature', { build: 8 }), m(5, 'ideation', { build: 9 }), m(6, 'ideation', { state: 'parked', status: 'running' }),
    m(7, 'design', { state: 'parked', approvals: 1 }),
  ]), [['build-7', true, [3]], ['bug', false, [2]], ['design', false, [7]], ['ideation', false, [6]], ['build-8', false, [4]], ['build-9', false, [5]], ['parked', false, [1]]]);
  // Parked rows follow the active ones; a build of only parked minions still gets its section.
  assert.deepEqual(shape([m(1, 'feature', { build: 3, state: 'parked' }), m(2, 'feature', { build: 3 }), m(3, 'chore', { build: 4, state: 'parked', wakes_on: 'x' })]),
    [['build-3', true, [2, 1]], ['build-4', false, [3]]]);
});

test('a minion parked on start_after rests (under Waiting) before it ever runs; a new one without a chain does not (#261)', () => {
  assert.deepEqual(shape([
    m(1, 'bug', { state: 'parked', status: 'new', parked_for: "#3 Leader's work is merged", wakes_on: "#3 Leader's work is merged" }), m(2, 'bug', { state: 'parked', status: 'new' }),
    // Held: its leader was dismissed unshipped, so nothing starts it by itself.
    m(3, 'bug', { state: 'parked', status: 'new', parked_for: '#4 L was dismissed without it, so only Unpark starts you' }),
  ]), [['bug', false, [2]], ['waiting', false, [1]], ['parked', false, [3]]]);
});

test('Deploying sits on top; Waiting (something wakes it by itself) sits above Parked (#718)', () => {
  assert.deepEqual(shape([
    m(1, 'bug', { state: 'parked', status: 'idle' }),
    m(2, 'bug', { state: 'parked', status: 'idle', wakes_on: 'Waiting on #9 going live' }),
    m(3, 'feature', { state: 'pending-deploy', status: 'idle', build: 7 }),
    m(4, 'feature', { build: 7 }),
    m(5, 'chore', { state: 'parked', status: 'new', parked_for: "#4 T's work is merged", wakes_on: "#4 T's work is merged" }),
    // Running again (or stuck) after its deploy: back in its own section until it rests.
    m(6, 'chore', { state: 'pending-deploy', status: 'running' }),
    m(7, 'design', { state: 'pending-deploy', status: 'idle' }),
    // CI and other outside waits stay in their type or build: only deploying moved.
    m(8, 'bug', { state: 'outside', status: 'idle' }),
    // The server landing it again (#727, #1003): still handed off to land, so in Deploying.
    m(9, 'chore', { state: 'pending-deploy', status: 'idle', server_work: { kind: 'land' } }),
  ]), [['deploying', false, [3, 7, 9]], ['build-7', true, [4]], ['bug', false, [8]], ['chore', false, [6]], ['waiting', false, [2, 5]], ['parked', false, [1]]]);
});

test("promoted groups come after the current build, in the scheme's order, the first match winning", () => {
  const groups = ['area: balance', 'area: ui'];
  assert.deepEqual(shape([
    m(1, 'feature', {}, { area: ['town', 'balance'] }), // balance: leaves Features
    m(2, 'bug', {}, { area: ['ui', 'balance'] }), // both: the first group in the scheme's list wins
    m(3, 'design', {}, { area: 'ui' }),
    m(4, 'feature', { build: 7 }, { area: ['balance'] }), // in a build: stays there
    m(5, 'feature', { build: 8 }, { area: ['ui'] }),
    m(6, 'chore', {}, { area: ['town'] }),
    m(7, 'feature', { state: 'parked' }, { area: ['balance'] }), // parked: stays parked
  ], groups), [['build-7', true, [4]], ['group-0', false, [1, 2]], ['group-1', false, [3]], ['chore', false, [6]], ['build-8', false, [5]], ['parked', false, [7]]]);
  const [, balance] = threadSections([m(1, 'bug', { build: 3 }), m(2, 'bug', {}, { area: 'balance' })], TYPES, groups);
  assert.equal(balance.group, 'area: balance');
});

test('search matches title, exact number and property values, not anything else', async () => {
  const { threadMatches } = await import('../public/threadgroups.js');
  const t = { number: 78, title: 'Minion search', created_by: 'Cara', last_activity: 'Ran the tests', note: 'needs a pick',
    properties: { type: 'feature', area: ['ui', 'town'], stage: 'in-progress' } };
  for (const q of ['search', 'MINION', '78', '#78', 'feature', 'town', 'type: feature', 'area: ui']) assert.ok(threadMatches(t, q), q);
  for (const q of ['7', '#7', '780', 'cara', 'tests', 'pick', 'type', 'type: bug', 'area: feature']) assert.ok(!threadMatches(t, q), q);
  assert.ok(threadMatches({ number: 3, title: 'x' }, '3'), 'no properties');
});

test('recap sections: changed minions only, newest first, by what they need', async () => {
  const { recapSections } = await import('../public/threadgroups.js');
  const stateOf = (t) => ({ rank: t.rank, fam: t.fam });
  const t = (id, updated_at, rest) => ({ id, updated_at, status: 'idle', rank: 2, fam: 'wait', ...rest });
  const tickets = [
    t(1, 50), // unchanged since 100
    t(2, 120, { rank: 0, fam: 'you' }),
    t(3, 150, { rank: 0, fam: 'you' }),
    t(4, 90, { status: 'running', rank: 1, fam: 'work' }), // a turn finished, still running
    t(5, 130, { status: 'closed', rank: 5, fam: 'idle' }),
    t(6, 110, { state: 'parked', rank: 4, fam: 'idle' }),
  ];
  assert.deepEqual(recapSections(tickets, 100, { 4: 1 }, stateOf).map((s) => [s.key, s.rows.map((r) => r.id)]),
    [['you', [3, 2]], ['work', [4]], ['wait', [6]], ['closed', [5]]]);
  assert.deepEqual(recapSections(tickets, 200, {}, stateOf), []);
});

test('a dismissed minion whose change is still on its way stays under Deploying until live (#764)', () => {
  const release = { name: 'Build 997', target: 'Peek for Windows', stage: 'CI' };
  assert.deepEqual(shape([m(1, 'bug', { status: 'closed', release }), m(2, 'bug'), m(3, 'feature', { status: 'closed', release, server_work: { kind: 'land' } })]),
    [['deploying', false, [1]], ['feature', false, [3]], ['bug', false, [2]]]);
});

test('a minion the server is landing (line, rebase, tests, deploy) sits in Deploying; a failed land or a running turn sends it back (#1003)', () => {
  const land = { kind: 'land' };
  assert.deepEqual(shape([m(1, 'feature', { status: 'idle', server_work: land, ship: { stage: 'main' } }), m(2, 'feature', { status: 'idle', server_work: land, ship: { stage: 'branch' } }),
    m(3, 'feature', { status: 'idle', server_work: land }), m(4, 'feature', { status: 'running', server_work: land, ship: { stage: 'main' } }), m(5, 'bug', { status: 'idle', server_work: land, ship: { stage: 'live' } }),
    m(6, 'bug', { status: 'idle', server_work: land, ship: { stage: 'failed' } }), m(7, 'bug', { status: 'idle', server_work: land, approvals: 1 }), m(8, 'bug', { status: 'idle', ship: { stage: 'branch' } })]),
    [['deploying', false, [1, 2, 3]], ['feature', false, [4]], ['bug', false, [5, 6, 7, 8]]]);
});

test('Deploying rows follow the Releases page order; ones it does not list go after, in list order (#1003)', () => {
  const place = { 1: 2, 2: 0, 3: 1 }; // minion n -> its place in the Releases order
  const order = (t) => place[t.n];
  const land = { kind: 'land' };
  const rows = threadSections([m(4, 'bug', { status: 'closed', release: {} }), m(1, 'bug', { server_work: land, status: 'idle' }), m(5, 'bug', { state: 'pending-deploy', status: 'idle' }),
    m(2, 'bug', { server_work: land, status: 'idle' }), m(3, 'bug', { server_work: land, status: 'idle' })], TYPES, [], order)[0].rows.map((t) => t.n);
  assert.deepEqual(rows, [2, 3, 1, 4, 5]);
});
