// The Chains page's reader (#1679): every wait on another minion, each claim's queue and build feeders, joined into chains.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chainsOf, type ChainInput, type WaitLink } from '../src/chains.ts';
import type { Ticket } from '../src/db.ts';

const T = (id: number, number: number, extra: Partial<Ticket> = {}) => ({ id, number, project_id: 7, title: `Minion ${number}`, status: 'idle', state: null, kind: 'ticket', build: null, ...extra }) as unknown as Ticket;
const wait = (number: number, kind = 'wake_when_live', state = 'waiting'): WaitLink => ({ kind, state, chip: `⇢ #${number}`, link: { project: 7, number } });

function input(tickets: Ticket[], waits: Record<number, WaitLink[]>, more: Partial<ChainInput> = {}): ChainInput {
  return {
    tickets, waitsOf: (t) => waits[t.id] ?? [],
    find: (p, n) => tickets.find((t) => t.project_id === p && t.number === n), get: (id) => tickets.find((t) => t.id === id),
    claims: [], builds: [], ...more,
  };
}

test('a minion waiting on another makes a chain, left to right from the one waited on; others make none', () => {
  const ts = [T(1, 10), T(2, 11), T(3, 12), T(4, 13)];
  const chains = chainsOf(input(ts, { 2: [wait(10, 'chain')], 3: [wait(11)] }));
  assert.equal(chains.length, 1);
  const [c] = chains;
  assert.deepEqual(c.nodes.map((n) => [n.number, n.col]), [[10, 0], [11, 1], [12, 2]]);
  assert.deepEqual(c.edges.map((e) => [e.from, e.to, e.kind]), [['2', '1', 'start_after'], ['3', '2', 'wait']]);
  assert.equal(c.title, 'Starts after #10');
});

test('a dismissed waiter, a dropped wait, a wait on nobody and a Taskmaster count for nothing; a dismissed leader still shows', () => {
  const ts = [T(1, 10, { status: 'closed' }), T(2, 11, { status: 'closed' }), T(3, 12), T(4, 13), T(5, 1, { kind: 'coordinator' })];
  const chains = chainsOf(input(ts, {
    2: [wait(10, 'chain')], 3: [wait(13, 'wake_when_live', 'dropped'), { kind: 'at', state: 'waiting', chip: '⏱ 06:00', link: null }, wait(1)], 4: [wait(10)],
  }));
  assert.deepEqual(chains.map((c) => c.nodes.map((n) => n.number)), [[10, 13]]);
  assert.equal(chains[0].nodes[0].status, 'closed');
});

test('a claim queue chains its holder to each waiting minion in order, titled by the claim', () => {
  const ts = [T(1, 1416), T(2, 1417), T(3, 1418)];
  const [c] = chainsOf(input(ts, {}, { claims: [{ name: 'pipeline-lane', holder: 1, waiting: [3, 2] }, { name: 'empty', holder: 2, waiting: [] }] }));
  assert.equal(c.title, 'Pipeline lane');
  assert.deepEqual(c.nodes.map((n) => [n.number, n.col]), [[1416, 0], [1418, 1], [1417, 2]]);
});

test('build feeders fan into the build minion, or into the build itself when none was named', () => {
  const ts = [T(1, 857, { build: 4 }), T(2, 884, { build: 4 }), T(3, 870, { build: 4 }), T(4, 20, { build: 5 }), T(5, 21, { build: 6 })];
  const chains = chainsOf(input(ts, {}, { builds: [{ build: 4, owner: 1 }, { build: 5, owner: null }] }));
  assert.equal(chains.length, 2, 'build 6 has no build branch, so it is no chain');
  const b4 = chains.find((c) => c.title === 'Build 4')!;
  assert.deepEqual(b4.nodes.map((n) => [n.number, n.col]), [[870, 0], [884, 0], [857, 1]]);
  const b5 = chains.find((c) => c.title === 'Build 5')!;
  assert.deepEqual(b5.nodes.map((n) => [n.key, n.col]), [['4', 0], ['build:5', 1]]);
});

test('kinds that meet join one chain; claims and builds sort first; two minions waiting on each other still draw', () => {
  const ts = [T(1, 1), T(2, 2), T(3, 3), T(4, 4), T(5, 5), T(6, 6)];
  const chains = chainsOf(input(ts, { 3: [wait(2)], 5: [wait(6)], 6: [wait(5)] }, { claims: [{ name: 'pipeline-lane', holder: 1, waiting: [2] }] }));
  assert.equal(chains[0].title, 'Pipeline lane');
  assert.deepEqual(chains[0].kinds, ['claim', 'wait']);
  assert.deepEqual(chains[0].nodes.map((n) => n.number), [1, 2, 3]);
  assert.deepEqual(chains[1].nodes.map((n) => [n.number, n.col]), [[6, 0], [5, 1]], 'a loop takes one column per minion, from 0');
});

test('a loop beside an unrelated chain still starts at column 0', () => {
  const ts = [T(1, 1), T(2, 2), T(3, 3), T(4, 4), T(5, 5)];
  const chains = chainsOf(input(ts, { 1: [wait(2)], 2: [wait(1)], 3: [wait(4)], 5: [wait(4)] }));
  const loop = chains.find((c) => c.nodes.some((n) => n.number === 1))!;
  assert.deepEqual(loop.nodes.map((n) => n.col).sort(), [0, 1]);
});

test('a minion that both starts after another and queues behind it keeps both, so the queue still names the chain', () => {
  const ts = [T(11, 11), T(12, 12)];
  const [c] = chainsOf(input(ts, { 12: [wait(11, 'chain')] }, { claims: [{ name: 'pipeline-lane', holder: 11, waiting: [12] }] }));
  assert.equal(c.title, 'Pipeline lane');
  assert.deepEqual(c.kinds, ['claim', 'start_after']);
  assert.deepEqual(c.edges.map((e) => e.kind).sort(), ['claim', 'start_after']);
});
