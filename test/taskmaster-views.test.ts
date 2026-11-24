// Mine and Everyone (#920): several Taskmaster sessions paged as one chat by event id.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { mergedPage, mergedAfter } from '../src/history.ts';
import { inMerged, inMine, mergedView } from '../public/mine.js';
import { bootServer, PASSWORD, SECRET } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'tm-views-'));
after(() => rmSync(root, { recursive: true, force: true }));

function setup(name: string) {
  const store = new Store(join(root, `${name}.db`));
  const p = store.createProject(`P-${name}`, null);
  const mk = (title: string) => store.createTicket({ project_id: p.id, title, permission_mode: 'default', created_by: 'Cara' });
  return { store, cara: mk('cara'), alex: mk('alex'), ovl: mk('ovl') };
}

/** A whole turn of `n` work events in a session; returns its ids. */
function turn(store: Store, ticketId: number, n = 1, author = 'Cara') {
  const ids = [store.addEvent(ticketId, 'user_message', { author, text: 'go' }).id];
  ids.push(store.addEvent(ticketId, 'claude', { type: 'system', subtype: 'init', session_id: 's' }).id);
  for (let i = 0; i < n; i++) ids.push(store.addEvent(ticketId, 'claude', { type: 'assistant', message: { content: [{ type: 'text', text: `w${i}` }] } }).id);
  ids.push(store.addEvent(ticketId, 'claude', { type: 'result', subtype: 'success' }).id);
  return ids;
}

const ids = (page: { events: { id: number }[] }) => page.events.map((e) => e.id);

test('Everyone interleaves every session by event id, and paging back never skips or repeats an event', () => {
  const { store, cara, alex, ovl } = setup('everyone');
  const all: number[] = [];
  for (let i = 0; i < 12; i++) all.push(...turn(store, [cara, alex, ovl][i % 3].id, i % 4));
  const parts = [{ id: cara.id }, { id: alex.id }, { id: ovl.id }];
  let page = mergedPage(store, parts, { limit: 10 });
  assert.ok(page.more, 'a long history pages');
  const seen = [...ids(page)];
  assert.deepEqual(
    seen,
    [...seen].sort((a, b) => a - b),
    'one page is in time order',
  );
  while (page.more) {
    page = mergedPage(store, parts, { before: seen[0], limit: 10 });
    assert.ok(page.events.length, 'an earlier page is never empty while there is more');
    seen.unshift(...ids(page));
  }
  assert.deepEqual(seen, all, 'every event once, in order: loading earlier never jumps');
});

test('a quiet session waits behind a busy one until its time comes', () => {
  const { store, cara, alex } = setup('quiet');
  const old = turn(store, alex.id);
  const busy = [turn(store, cara.id, 30), turn(store, cara.id, 30)].flat();
  const page = mergedPage(store, [{ id: cara.id }, { id: alex.id }], { limit: 40 });
  assert.ok(!ids(page).some((id) => old.includes(id)), "Alex's older turn is not pulled into the newest page");
  assert.ok(page.more);
  const rest = mergedPage(store, [{ id: cara.id }, { id: alex.id }], { before: ids(page)[0], limit: 1000 });
  assert.deepEqual([...ids(rest), ...ids(page)], [...old, ...busy]);
});

test("Mine takes only the Overlord's for-everyone items, card answers and card results", () => {
  const { store, cara, ovl } = setup('mine');
  const mineTurn = turn(store, cara.id);
  turn(store, ovl.id, 2, 'Alex'); // Alex talking to the Overlord: not in Cara's Mine
  const card = store.addEvent(ovl.id, 'question', { id: 'q1', everyone: true, questions: [] }).id;
  const alert = store.addEvent(ovl.id, 'user_message', { author: 'Citadel', text: 'CI fell back', everyone: true }).id;
  const answer = store.addEvent(ovl.id, 'user_message', { author: 'Alex', answer: { questionId: 'q1', answers: {} } }).id;
  const settled = store.addEvent(ovl.id, 'question_result', { id: 'q1' }).id;
  const parts = [{ id: cara.id }, { id: ovl.id, mine: true }];
  const page = mergedPage(store, parts, {});
  assert.deepEqual(ids(page), [...mineTurn, card, alert, answer, settled]);
  assert.ok(
    page.events.filter((e) => e.ticket_id === ovl.id).every((e) => inMine(e)),
    "the front end's rule agrees with the query",
  );
  const later = store.addEvent(ovl.id, 'claude', { type: 'assistant', message: { content: [] } }).id;
  const live = store.addEvent(ovl.id, 'note', { text: 'deploy is live', everyone: true }).id;
  assert.deepEqual(ids({ events: mergedAfter(store, parts, settled) }), [live], 'catch-up filters the same way');
  assert.ok(!inMine({ kind: 'claude', data: JSON.stringify({ type: 'assistant' }) }) && later);
});

test("Mine skips past a run of the Overlord's own work instead of paging through it", () => {
  const { store, cara, ovl } = setup('skip');
  const a = turn(store, cara.id);
  const alert = store.addEvent(ovl.id, 'note', { text: 'alert', everyone: true }).id;
  for (let i = 0; i < 5; i++) turn(store, ovl.id, 20, 'Alex');
  const b = turn(store, cara.id);
  const page = mergedPage(store, [{ id: cara.id }, { id: ovl.id, mine: true }], { limit: 50 });
  assert.deepEqual(ids(page), [...a, alert, ...b], 'filtered sessions page by what shows, so 200 hidden events cost no page');
  assert.equal(page.more, false);
});

test('the newest page reaches back to a card still waiting in any session', () => {
  const { store, cara, ovl } = setup('open');
  const card = store.addEvent(ovl.id, 'question', { id: 'q9', everyone: true, questions: [{ question: 'x?', options: [] }] }).id;
  for (let i = 0; i < 6; i++) turn(store, cara.id, 10);
  const parts = [{ id: cara.id }, { id: ovl.id, mine: true }];
  assert.ok(ids(mergedPage(store, parts, { limit: 20 })).includes(card));
  assert.ok(!ids(mergedPage(store, parts, { limit: 20, before: card + 40 })).includes(card), 'only the newest page reaches back');
});

test('the front end merges only when the scheme has split: Mine takes your chat and the Overlord, Everyone takes all, each named', () => {
  const tms = [
    { id: 1, person_id: 7, person_name: 'Cara' },
    { id: 2, person_id: 8, person_name: 'Alex' },
    { id: 3, person_id: null, person_name: null },
  ];
  assert.equal(mergedView(9, 5, [{ id: 5, person_id: null, person_name: null }], 'mine'), null, 'one Taskmaster: a plain chat');
  assert.equal(mergedView(9, 4, tms, 'mine'), null, "a chat that isn't a Taskmaster of this scheme: plain");
  const mine = mergedView(9, 1, tms, 'mine');
  assert.deepEqual(
    mine.parts.map((p) => [p.id, p.label, p.mine]),
    [
      [1, undefined, false],
      [3, 'Overlord', true],
    ],
  );
  const notYet = mergedView(9, 3, tms, 'mine');
  assert.deepEqual(
    notYet.parts.map((p) => [p.id, p.mine]),
    [[3, true]],
    "no Taskmaster of your own yet: Mine is the Overlord's for-everyone items, not its whole chat",
  );
  assert.ok(!inMerged(notYet, { ticket_id: 3, kind: 'claude', data: '{}' }) && inMerged(notYet, { ticket_id: 3, kind: 'note', data: '{"everyone":true}' }));
  assert.ok(!mergedView(9, 3, tms, 'everyone').parts[0].mine);
  assert.equal(mine.src, 'api/projects/9/taskmaster-events?view=mine');
  const all = mergedView(9, 1, tms, 'everyone');
  assert.deepEqual(
    all.parts.map((p) => [p.id, p.label, p.mine]),
    [
      [1, undefined, false],
      [2, "Alex's Taskmaster", false],
      [3, 'Overlord', false],
    ],
  );
  const ev = (ticket_id: number, data: object, kind = 'claude') => ({ ticket_id, kind, data: JSON.stringify(data) });
  assert.ok(inMerged(mine, ev(1, { type: 'assistant' })), 'your own session: everything');
  assert.ok(!inMerged(mine, ev(3, { type: 'assistant' })), "the Overlord's own work stays out of Mine");
  assert.ok(inMerged(mine, ev(3, { text: 'CI fell back', everyone: true }, 'note')));
  assert.ok(!inMerged(mine, ev(2, { type: 'assistant' })), "another person's Taskmaster: only in Everyone");
  assert.ok(inMerged(all, ev(2, { type: 'assistant' })) && inMerged(all, ev(3, { type: 'assistant' })));
  assert.ok(!inMerged(all, ev(4, { type: 'assistant' })) && !inMerged(null, ev(1, {})), "a minion's event never lands in the Taskmaster chat");
});

test("through the server: each person opens their own Taskmaster, Mine adds the Overlord's for-everyone items, Everyone adds the rest", async () => {
  const dir = join(root, 'server');
  mkdirSync(join(dir, 'data'), { recursive: true });
  const store = new Store(join(dir, 'data', 'coordinator.db'));
  const Cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const Alex = store.createUser({ name: 'Alex', login: 'alex' });
  const p = store.createProject('Shared', null, Cara.id);
  const Rachel = store.createUser({ name: 'Rachel', login: 'rachel' });
  for (const u of [Alex, Rachel]) store.addMember(p.id, u.id);
  const first = store.createTicket({ project_id: p.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Taskmaster' });
  const cara = store.addEvent(first.id, 'user_message', { author: 'Cara', text: 'Cara asks hers' }).id;
  const alexTm = store.splitScheme(p.id, Alex.id);
  const ovl = store.getOverlord(p.id)!;
  const alex = store.addEvent(alexTm.id, 'user_message', { author: 'Alex', text: 'Alex asks his' }).id;
  const work = store.addEvent(ovl.id, 'claude', { type: 'assistant', message: { content: [{ type: 'text', text: 'checking CI' }] } }).id;
  const alert = store.addEvent(ovl.id, 'note', { text: 'CI is red', everyone: true }).id;
  store.db.close();
  const srv = await bootServer({ root: dir });
  try {
    const cookie = new Auth(PASSWORD, SECRET).issueCookie(Alex, false).split(';')[0];
    const get = async (path: string) => (await fetch(srv.base + path, { headers: { Cookie: cookie } })).json() as Promise<any>;
    const scheme = await get(`/api/projects/${p.id}`);
    assert.equal(scheme.coordinator.id, alexTm.id, 'the scheme opens on your own Taskmaster');
    assert.deepEqual(
      scheme.taskmasters.map((t: any) => [t.id, t.person_name]),
      [
        [first.id, 'Cara'],
        [ovl.id, null],
        [alexTm.id, 'Alex'],
      ],
    );
    const evs = async (q: string) => (await get(`/api/projects/${p.id}/taskmaster-events?${q}`)).events.map((e: any) => e.id);
    assert.deepEqual(await evs('view=mine'), [alex, alert], "Mine: yours and the Overlord's alert, not its work nor Cara's chat");
    assert.deepEqual(await evs('view=everyone'), [cara, alex, work, alert]);
    assert.deepEqual(await evs(`view=everyone&before=${work}`), [cara, alex], 'one id cursor pages them all');
    assert.deepEqual(
      (await get(`/api/projects/${p.id}/taskmaster-events?view=mine&after=${alex}`)).map((e: any) => e.id),
      [alert],
    );
    // Rachel hasn't written yet, so she has no Taskmaster of her own: the Overlord's work stays out of her Mine.
    const rachel = new Auth(PASSWORD, SECRET).issueCookie(Rachel, false).split(';')[0];
    const hers = (await (await fetch(`${srv.base}/api/projects/${p.id}/taskmaster-events?view=mine`, { headers: { Cookie: rachel } })).json()) as any;
    assert.deepEqual(
      hers.events.map((e: any) => e.id),
      [alert],
    );
  } finally {
    await srv.stop();
  }
});
