// A cabal's card in the minions list (#2092): what the server sends (src/cabal-cards.ts), and which rows leave their
// sections for the card (public/threadgroups.js cabalSplit).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { overseerRow } from '../public/cabal-card.js';
import { cabalSplit, threadSections } from '../public/threadgroups.js';
import { CabalCards, cabalCards, nextUp } from '../src/cabal-cards.ts';
import { Store } from '../src/db.ts';

const root = mkdtempSync(join(tmpdir(), 'cabal-card-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir
const store = new Store(join(root, 'coordinator.db'));
const p = store.createProject('Scheme', null);
const deps = { parked: () => false };
const minion = (title: string, build: number | null = null) => {
  const t = store.createTicket({ project_id: p.id, title, permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(t.id, { build, status: 'idle' });
  return store.getTicket(t.id)!;
};

test('next up: unstarted members whose wait is over or on a member already under way', () => {
  const m = (label: string, state: 'running' | 'sealed' | 'roster', after: string | null = null) => ({ label, number: null, state, after });
  assert.equal(nextUp([m('M1', 'running'), m('M2', 'sealed', 'M1'), m('M3', 'roster', 'M1'), m('M4', 'sealed', 'M2')]), 2);
  assert.equal(nextUp([m('T1', 'roster'), m('T2', 'roster', 'T1')]), 1);
  // A list waits for all of it, and words that name nobody ("everything") keep a row waiting.
  assert.equal(nextUp([m('M1', 'running'), m('M2', 'running'), m('M3', 'roster', 'M1, M2'), m('M4', 'roster', 'M1 and M3'), m('T7', 'roster', 'everything')]), 1);
});

test('one card per open cabal: its Overseer by name, a member a roster row, counts, asks and spend; gone with its lead', async () => {
  const lead = minion('Worker machines', 7);
  const member = minion('Roles in the data', 7);
  store.joinCabal(member.id, lead.id, p.id, member.title);
  store.addCabalRow(lead.id, { label: 'T7', title: 'Pilot' });
  store.addCabalAsk(lead.id, member.id, 'Which helper?', false);
  store.db.prepare('INSERT INTO turns (ticket_id, ended_at, cost_usd, session_cost_usd) VALUES (?, 1, 3, 0)').run(lead.id);
  const [card] = await cabalCards(store, p.id, deps);
  assert.equal(card.overseer, "Build 7's Overseer");
  assert.equal(card.name, 'Build 7', "its section's heading in the list (#2181)");
  assert.deepEqual([card.lead, card.build, card.done, card.finished, card.next, card.asks, card.spend], [lead.id, 7, 'shipped', 0, 1, 1, 3]);
  assert.deepEqual(
    card.members.map((m) => [m.id, m.label, m.state]),
    [
      [member.id, '', 'idle'],
      [null, 'T7', 'roster'],
    ],
  );
  store.updateTicket(lead.id, { status: 'closed' });
  assert.deepEqual(await cabalCards(store, p.id, deps), []);
  store.updateTicket(lead.id, { status: 'idle' });
});

test('the cache broadcasts a change once, and a write during a read is read again', async () => {
  const sent: { cabals: { asks: number }[] }[] = [];
  const cards = new CabalCards({ store, broadcast: (msg) => sent.push(msg as (typeof sent)[number]), parked: () => false });
  const first = cards.refresh(p.id);
  store.addCabalAsk(cards.get(p.id)[0]?.lead ?? store.openCabalLeads(p.id)[0], store.openCabalLeads(p.id)[0], 'One more', false);
  await Promise.all([first, cards.refresh(p.id)]);
  assert.equal(cards.get(p.id)[0].asks, 2);
  const n = sent.length;
  await cards.refresh(p.id);
  assert.equal(sent.length, n, 'nothing changed, nothing sent');
});

test("a cabal's minions leave their sections for its card; Deploying ones don't, and no Overseer means no card", () => {
  const row = (id: number, rest: object = {}) => ({ id, status: 'idle', ...rest });
  const cabal = { lead: 1, build: 7, members: [{ id: 2 }, { id: null }] };
  const open = [row(1, { build: 7 }), row(2), row(3, { build: 7 }), row(4, { build: 7, state: 'pending-deploy' }), row(5, { build: 8 })];
  const { cards, rest } = cabalSplit(open as never, [cabal] as never);
  assert.deepEqual(
    cards.map((c) => [c.rows.map((t) => t.id), c.mine.map((t) => t.id)]),
    [
      [
        [1, 2, 3],
        [1, 2, 3, 4],
      ],
    ],
  );
  assert.deepEqual(
    rest.map((t) => t.id),
    [4, 5],
  );
  const none = cabalSplit(open.slice(1) as never, [cabal] as never);
  assert.deepEqual([none.cards.length, none.rest.length], [0, 4]);
});

test("an Overseer's card keeps its Overseer's row through its own full run and ship, in every resting state", () => {
  const cabal = { lead: 1, build: 10, members: [{ id: 2 }] };
  const states = {
    landing: { server_work: { kind: 'land' }, ship: { stage: 'tests' } },
    pendingDeploy: { state: 'pending-deploy' },
    sealed: { state: 'parked' },
    outside: { state: 'outside' },
    waiting: { state: 'parked', wakes_on: 'x' },
  };
  for (const [name, extra] of Object.entries(states)) {
    const open = [
      { id: 1, build: 10, status: 'idle', ...extra },
      { id: 2, build: 10, status: 'idle', state: 'pending-deploy' },
    ];
    const { cards, rest } = cabalSplit(open as never, [cabal] as never);
    assert.deepEqual(
      cards.map((c) => c.rows.map((t) => t.id)),
      [[1]],
      `${name}: the card lists its Overseer`,
    );
    assert.deepEqual(
      rest.map((t) => t.id),
      [2],
      `${name}: only the member is Deploying`,
    );
  }
});

test('a card never moves the next build up, keeps its goal members, and stays when a filter hides its Overseer', () => {
  const row = (id: number, build: number | null = null) => ({ id, build, status: 'idle', title: `t${id}` });
  const all = [row(1, 7), row(2, 7), row(3, 8), row(4)];
  const cabal = (lead: number, build: number | null, members: number[]) => ({ lead, build, members: members.map((id) => ({ id })) });
  const sevens = cabal(1, 7, []);
  const goal = cabal(4, null, [2]);
  const { cards, rest } = cabalSplit(all as never, [sevens, goal] as never);
  assert.deepEqual(
    cards.map((c) => c.rows.map((t) => t.id)),
    [[1], [2, 4]],
  );
  const sections = threadSections(rest, ['other'], [], () => undefined, [7]);
  assert.deepEqual(
    sections.map((s) => [s.key, s.current]),
    [['build-8', false]],
  );
  // With no card, build 7 is the current build as ever.
  assert.deepEqual(
    threadSections(all as never, ['other'])
      .filter((s) => s.build)
      .map((s) => [s.key, s.current]),
    [
      ['build-7', true],
      ['build-8', false],
    ],
  );
  const filtered = cabalSplit([all[1]] as never, [sevens] as never, all as never);
  assert.deepEqual(
    filtered.cards.map((c) => c.rows.map((t) => t.id)),
    [[2]],
  );
  assert.equal(cabalSplit([all[2]] as never, [sevens] as never, all as never).cards.length, 0);
});

test("a shut card's Overseer row carries its members' waiting cards, oldest first, each still owed by its own person (#2181)", () => {
  const card = (e: number, to?: string) => ({ minion: 1, kind: 'question', what: 'question', label: 'Q', href: `#/p/1/t/1?e=${e}`, ...(to ? { to } : {}) });
  const lead = { id: 1, assignee: 'Cara', open_cards: [card(30)] };
  const josh = { id: 2, assignee: 'Josh', open_cards: [card(10)] };
  const named = { id: 3, assignee: 'Josh', open_cards: [card(20, 'Tess')] };
  const row = overseerRow(lead as never, [lead, josh, named] as never);
  assert.deepEqual(
    row.open_cards?.map((c) => [c.href.split('e=')[1], c.to]),
    [
      ['10', 'Josh'],
      ['20', 'Tess'],
      ['30', undefined],
    ],
    "the chip opens the oldest of them all, and a member's card stays its assignee's, not the lead's",
  );
  assert.equal(overseerRow(lead as never, [lead] as never), lead, 'no member waits: the lead row as it is');
});
