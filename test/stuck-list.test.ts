// The stuck list (#1506): which minions and cards a Taskmaster's person-started turn hears about, and when again.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cardHref } from '../src/card-links.ts';
import { Store, type Ticket } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { STUCK_GAP_MS, stuckItems, stuckList } from '../src/stuck-list.ts';
import { jsonLines, stopTurns, testPins, until, fakeClaude } from './helpers.ts';
testPins();

const H = 3_600_000;
const NOW = Date.now() + 1000 * H;

/** A scheme (not Citadel) with its one Taskmaster, and a runner whose views the test sets per minion. */
function world() {
  const store = new Store(':memory:');
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
  const p = store.createProject('Delve', null, cara.id).id;
  const tm = store.createTicket({ project_id: p, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
  const views = new Map<number, object>();
  const runner = { view: (t: Ticket) => ({ queued: 0, open_cards: [], outbox_waits: [], ...views.get(t.id) }) as any };
  /** A minion idle for `idleH` hours, with view fields `view` and ticket fields `fields`. */
  const minion = (title: string, idleH: number, view: object = {}, fields: Partial<Ticket> = {}) => {
    const t = store.createTicket({ project_id: p, title, permission_mode: 'default', created_by: 'Cara' });
    store.updateTicket(t.id, { status: 'idle', ...fields } as any);
    store.db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(NOW - idleH * H, t.id);
    views.set(t.id, view);
    return store.getTicket(t.id)!;
  };
  /** An open question card on `t`, posted `ageH` hours before NOW, shown in its view. */
  const card = (t: Ticket, ageH: number, to?: string) => {
    const e = store.addEvent(t.id, 'question', { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }], ...(to ? { to } : {}) });
    store.db.prepare('UPDATE events SET created_at = ? WHERE id = ?').run(NOW - ageH * H, e.id);
    const link = { minion: t.number, kind: 'question', label: 'Ship it?', href: cardHref(t, e.id), ...(to ? { to } : {}) };
    views.set(t.id, { ...views.get(t.id), open_cards: [link] });
  };
  return { store, tm, runner, minion, card, p };
}

const lines = (w: ReturnType<typeof world>, now = NOW) => stuckItems(w.store, w.runner, w.tm, now).map((i) => i.line);

test('an open minion idle past the threshold with nothing coming is listed with its state, wait and note; a recent one is not', () => {
  const w = world();
  const old = w.minion('Old work', 30, {}, { state: 'ready', note: 'needs a pick' });
  w.minion('Fresh work', 2);
  const got = lines(w);
  assert.equal(got.length, 1);
  assert.match(got[0], new RegExp(`^#${old.number} Old work \\(idle, ready, idle 30 h\\): nothing set to wake it · note: needs a pick$`));
});

test('a park nothing wakes is listed as such, after the idle threshold', () => {
  const w = world();
  w.minion('Shelved', 8, {}, { state: 'parked' });
  assert.match(lines(w)[0], /sealed, nothing wakes it by itself/);
});

test('a park whose own change is live is listed after an hour, first', () => {
  const w = world();
  w.minion('Idle one', 50);
  const shipped = w.minion('Shipped and parked', 2, { ship: { stage: 'live', text: 'Live', commit: 'abc' } }, { state: 'parked' });
  const got = lines(w);
  assert.equal(got.length, 2);
  assert.match(got[0], new RegExp(`^#${shipped.number} Shipped and parked .*: sealed, but its own change is live`));
});

test('a park whose leader was dismissed without its work (a held chain: nothing wakes it) is listed with what it was on', () => {
  const w = world();
  w.minion('Follower', 2, { parked_for: "#4 Leader's work is live, and #4 Leader was dismissed without it, so only Unpark starts you", wakes_on: null }, { state: 'parked' });
  assert.match(lines(w)[0], /sealed on #4 Leader's work is live, and #4 Leader was dismissed without it/);
});

test('a card waiting over a day is listed with who it waits on; a younger one is not, and its minion is not listed as idle', () => {
  const w = world();
  const a = w.minion('Asks Josh', 40, {}, { note: 'waits on Josh' });
  w.card(a, 30, 'Josh');
  const b = w.minion('Asks today', 40);
  w.card(b, 3);
  const got = lines(w);
  assert.equal(got.length, 1);
  assert.match(got[0], new RegExp(`^#${a.number} Asks Josh \\(idle, card waited 30 h on Josh\\): question card for Josh "Ship it\\?": \\[open it\\]\\(.*\\) · note: waits on Josh$`));
});

test("the Taskmaster's own card waiting over a day is listed, a younger one is not", () => {
  const w = world();
  w.card(w.tm, 26, 'Cara');
  assert.match(lines(w)[0] ?? '', /^Your own card, waited 26 h on Cara: question card for Cara "Ship it\?": \[open it\]/);
  const v = world();
  v.card(v.tm, 5, 'Cara');
  assert.deepEqual(lines(v), []);
});

test('something coming leaves a minion out: a wait, a wake, a ship under way, a land wait, a running or queued turn', () => {
  const w = world();
  w.minion('Timed wake', 30, { outbox_waits: [{ kind: 'wake_at', state: 'waiting' }] });
  w.minion('Wakes when live', 30, { wakes_on: 'its deploy is live' }, { state: 'parked' });
  w.minion('On main', 30, { ship: { stage: 'main', text: 'On main', commit: 'abc' } });
  w.minion('In the land line', 30, { wait: { text: 'third in the land line' } });
  w.minion('Queued', 30, { queued: 1 });
  w.minion('Running', 30, {}, { status: 'running' });
  w.minion('Usage limit', 30, { limit_resume_at: NOW + H });
  w.minion('Dismissed', 30, {}, { status: 'closed' });
  // A held chain row is not coming (its leader went), so this one is listed.
  w.minion('Held chain', 30, { outbox_waits: [{ kind: 'chain', state: 'held' }] });
  const got = lines(w);
  assert.equal(got.length, 1, got.join('\n'));
  assert.match(got[0], /Held chain/);
});

test("another person's Taskmaster's minions are not on this one's list", () => {
  const w = world();
  const josh = w.store.createUser({ name: 'Josh', login: 'josh' });
  w.store.addMember(w.p, josh.id);
  const own = w.store.splitScheme(w.p, josh.id);
  const t = w.minion('Josh owns it', 30);
  w.store.props.set('minion', t.id, w.p, { assigned: 'Josh' }, 'Cara');
  assert.equal(w.store.ownerCoordinator(t)?.id, own.id);
  assert.deepEqual(lines(w), []);
  assert.equal(stuckItems(w.store, w.runner, own, NOW).length, 1);
});

test('an item shows again only after the gap; the cap says how many more; nothing stuck gives no block', () => {
  const w = world();
  assert.equal(stuckList(w.store, w.runner, w.tm, NOW), null, 'nothing stuck, no block');
  for (let i = 0; i < 12; i++) w.minion(`Old ${i}`, 30 + i);
  const first = stuckList(w.store, w.runner, w.tm, NOW)!;
  assert.match(first, /^Stuck list, built by the server/);
  assert.equal(first.split('\n').filter((l) => /^- #/.test(l)).length, 10);
  assert.match(first, /- and 2 more$/);
  const second = stuckList(w.store, w.runner, w.tm, NOW + H)!;
  assert.equal(second.split('\n').filter((l) => /^- #/.test(l)).length, 2, 'only the two not shown yet');
  assert.doesNotMatch(second, /and \d+ more/);
  assert.equal(stuckList(w.store, w.runner, w.tm, NOW + 2 * H), null, 'all shown within the gap');
  const again = stuckList(w.store, w.runner, w.tm, NOW + STUCK_GAP_MS + 1)!;
  assert.equal(again.split('\n').filter((l) => /^- #/.test(l)).length, 10, 'past the gap they show again');
});

test("the block rides on a Taskmaster turn a person started, not on one a minion's message started", async () => {
  const root = mkdtempSync(join(tmpdir(), 'stuck-turn-'));
  after(async () => {
    await stopTurns(root);
    rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
  });
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  const prompts = join(root, 'prompts.jsonl');
  const fake = fakeClaude(root, { log: { path: prompts } });
  const store = new Store(join(root, 'stuck.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const p = store.createProject('Delve', null, cara.id).id;
  const tm = store.createTicket({ project_id: p, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(tm.id, root, null);
  const old = store.createTicket({ project_id: p, title: 'Forgotten work', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(old.id, { status: 'idle' });
  store.db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(Date.now() - 30 * H, old.id);
  const runner = new Runner(
    store,
    () => {},
    () => ({}),
    fake,
  );
  const texts = () => jsonLines(prompts).map((l) => l.message.content.map((c: any) => c.text).join('\n'));
  runner.send(tm.id, `#${old.number} Forgotten work`, 'an update', [], { from: old.id });
  await until('the minion-started turn', () => texts().length === 1 && !runner.isRunning(tm.id));
  assert.doesNotMatch(texts()[0], /Stuck list/);
  runner.send(tm.id, 'Cara', 'hello', [], { typed: true });
  await until('the person-started turn', () => texts().length === 2 && !runner.isRunning(tm.id));
  assert.match(texts()[1], new RegExp(`Stuck list[\\s\\S]*- #${old.number} Forgotten work \\(idle, idle 30 h\\): nothing set to wake it[\\s\\S]*hello`));
});
