import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Approvals } from '../src/approvals.ts';
import { Store } from '../src/db.ts';
import { HOME_BUCKETS_MS, HOME_DAYS, HOME_FIRST_LOOK, HOME_VISIT_GAP, HomeBucketCache, homeDays, homeSince, homeView } from '../src/inbox.ts';

const root = mkdtempSync(join(tmpdir(), 'home-'));
after(() => rmSync(root, { recursive: true, force: true }));

// Schemes other than Citadel (every-scheme rule): ids 1 and 2 go to placeholders, so none of these is Citadel's id.
function setup(file: string) {
  const store = new Store(join(root, file));
  store.typedHandlesUpTo = 0;
  store.createProject('Placeholder one', null);
  store.createProject('Placeholder two', null);
  const josh = store.createUser({ name: 'josh', login: 'josh' });
  const scheme = (name: string, member = true) => {
    const p = store.createProject(name, null);
    if (member) store.addMember(p.id, josh.id);
    return p.id;
  };
  const minion = (projectId: number, title: string) => store.createTicket({ project_id: projectId, title, permission_mode: 'bypassPermissions', created_by: 'cara' });
  return { store, josh, scheme, minion, approvals: new Approvals(() => {}) };
}

test("Home lists what waits on a person across their schemes: Taskmasters first, then oldest first; not schemes they hid or aren't in", () => {
  const { store, josh, scheme, minion, approvals } = setup('items.sqlite');
  const peek = scheme('Peek Auras'),
    voice = scheme('VoiceAnalyzer'),
    hid = scheme('Hidden one'),
    outside = scheme('Not theirs', false);
  assert.ok(![peek, voice, hid, outside].includes(2), 'none of them is the Citadel scheme');
  store.setProjectHidden(josh.id, hid, true);
  const old = minion(voice, 'old ask'),
    newer = minion(peek, 'newer ask');
  store.addEvent(old.id, 'question', { id: 'q-old', questions: [] });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // a later millisecond for the newer card
  store.addEvent(newer.id, 'question', { id: 'q-new', questions: [] });
  const tm = store.createTicket({ project_id: peek, title: 'Taskmaster', kind: 'coordinator', permission_mode: 'bypassPermissions', created_by: 'cara' } as never);
  store.addEvent(tm.id, 'plan', { id: 'p-tm', summary: 's', plan: 'p', status: 'pending' });
  store.addEvent(minion(hid, 'hidden ask').id, 'question', { id: 'q-hidden', questions: [] });
  store.addEvent(minion(outside, 'outside ask').id, 'question', { id: 'q-outside', questions: [] });

  const home = homeView(store, approvals, { name: 'josh', uid: josh.id }, () => false, 0);
  assert.deepEqual(
    home.items.map((i) => (i.card as { id: string }).id),
    ['p-tm', 'q-old', 'q-new'],
    "the Taskmaster's card leads though it is newest; then oldest first; hidden and non-member schemes stay out",
  );
  assert.deepEqual(home.items[1].from, { projectId: voice, scheme: 'VoiceAnalyzer', number: old.number, kind: 'ticket', title: 'old ask' });
  assert.deepEqual(
    home.schemes.map((s) => s.name),
    ['Peek Auras', 'VoiceAnalyzer'],
  );
});

test("Home's working minions and what shipped since, only in the person's schemes; build merges and failed pushes aren't ships", () => {
  const { store, josh, scheme, minion, approvals } = setup('shipped.sqlite');
  const peek = scheme('Peek Auras'),
    outside = scheme('Not theirs', false);
  const busy = minion(peek, 'busy one'),
    idle = minion(peek, 'idle one'),
    there = minion(outside, 'theirs');
  const start = Date.now();
  store.addEvent(idle.id, 'note', { text: 'Shipped abc1234: the fix. Risk low: tests. Live now.' });
  store.addEvent(idle.id, 'note', { text: 'Merged abc1235 into build/5: a feeder. Risk low: x.' });
  store.addEvent(idle.id, 'note', { text: 'Shipped abc1237 "x": a push. Risk low. Shipped locally, not pushed to origin: the push failed.' });
  store.addEvent(there.id, 'note', { text: 'Shipped abc1236: elsewhere. Risk low: x.' });

  store.addEvent(busy.id, 'note', { text: 'Shipped abc1238: a first go. Risk low: x.' });
  store.addEvent(busy.id, 'note', { text: 'Shipped abc1239: a second go. Risk low: x.' });

  const home = homeView(store, approvals, { name: 'josh', uid: josh.id }, (t) => t.id === busy.id || t.id === there.id, start - 1000);
  assert.equal(home.schemes.length, 1, "only the person's schemes");
  const s = home.schemes[0];
  assert.deepEqual({ id: s.id, name: s.name, waiting: s.waiting, working: s.working, shipped: s.shipped }, { id: peek, name: 'Peek Auras', waiting: 0, working: 1, shipped: 2 }, "two minions shipped: the build merge and the failed push don't count, and a minion shipped twice counts once");
  assert.equal(home.days.length, 14, 'two weeks of days for the bars');
  assert.equal(s.daily.length, 14);
  assert.equal(
    s.daily.reduce((a, b) => a + b, 0),
    2,
    'the twice-shipped minion counts once in the bars too',
  );
  assert.equal(Math.max(...s.daily), 2, 'both on the same day (today, unless Pacific midnight fell mid-test)');
  assert.equal(homeView(store, approvals, { name: 'josh', uid: josh.id }, () => false, Date.now() + 60_000).schemes[0].shipped, 0, 'nothing shipped after `since`');
});

test('ship notes are read through events_notes, never a walk over every event since (#1251)', () => {
  const { store, josh, scheme, minion, approvals } = setup('plan.sqlite');
  const peek = scheme('Peek Auras');
  store.addEvent(minion(peek, 'one').id, 'note', { text: 'Shipped aaa1111: one. Risk low: x.' });
  const seen: string[] = [];
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = ((sql: string, ...r: []) => {
    seen.push(sql);
    return prepare(sql, ...r);
  }) as typeof store.db.prepare;
  homeView(store, approvals, { name: 'josh', uid: josh.id }, () => false, 0);
  store.shippedSince(0);
  store.shipNotesSince(0);
  const reads = seen.filter((sql) => /kind = 'note'/.test(sql) && /Shipped/.test(sql));
  assert.equal(reads.length, 4, "Home's buckets and since, shippedSince and shipNotesSince");
  for (const sql of reads) {
    const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array((sql.match(/\?/g) ?? []).length).fill(0)) as { detail: string }[]).map((r) => r.detail).join(' | ');
    // Without it every claude row since `since` was read: 13.6 s of the live loop for a visit days back.
    assert.match(plan, /USING INDEX events_notes/, `${sql}\n${plan}`);
  }
});

test("Home's ship buckets are held for everyone, a new ship shows at once, and old ones leave the window", () => {
  const { store, josh, scheme, minion, approvals } = setup('cache.sqlite');
  const peek = scheme('Peek Auras');
  const idle = minion(peek, 'one'),
    other = minion(peek, 'two');
  const cache = new HomeBucketCache();
  const now = Date.now();
  const who = { name: 'josh', uid: josh.id };
  store.addEvent(idle.id, 'note', { text: 'Shipped aaa1111: one. Risk low: x.' });
  const first = homeView(store, approvals, who, () => false, now - 1000, now, cache);
  assert.equal(
    first.schemes[0].daily.reduce((a: number, b: number) => a + b, 0),
    1,
  );
  store.addEvent(other.id, 'note', { text: 'Shipped bbb2222: second. Risk low: x.' });
  const second = homeView(store, approvals, who, () => false, now - 1000, now + 5000, cache);
  assert.equal(second.schemes[0].shipped, 2, 'shipped-since sees the new ship at once');
  assert.equal(
    second.schemes[0].daily.reduce((a: number, b: number) => a + b, 0),
    2,
    'and so do the buckets',
  );
  const gone = now + (HOME_DAYS + 2) * 86_400_000;
  const later = homeView(store, approvals, who, () => false, gone - 1000, gone, cache);
  assert.equal(
    later.schemes[0].daily.reduce((a: number, b: number) => a + b, 0),
    0,
    'past the window they are dropped',
  );
});

test("Home's held ship notes follow a deleted minion, newest events deleted, and a visit older than the window", () => {
  const { store, josh, scheme, minion, approvals } = setup('cache-drift.sqlite');
  const peek = scheme('Peek Auras');
  const one = minion(peek, 'one'),
    two = minion(peek, 'two'),
    three = minion(peek, 'three');
  const cache = new HomeBucketCache();
  const who = { name: 'josh', uid: josh.id };
  const total = (h: ReturnType<typeof homeView>) => h.schemes[0].daily.reduce((a: number, b: number) => a + b, 0);
  const now = Date.now();
  store.addEvent(one.id, 'note', { text: 'Shipped aaa1111: one. Risk low: x.' });
  store.addEvent(two.id, 'note', { text: 'Shipped bbb2222: two. Risk low: x.' });
  assert.equal(total(homeView(store, approvals, who, () => false, now - 1000, now, cache)), 2);
  store.deleteTicket(two.id);
  assert.equal(total(homeView(store, approvals, who, () => false, now - 1000, now + HOME_BUCKETS_MS, cache)), 1, 'a deleted minion drops out within the minute');
  // The newest event deleted outright: its id may come back, so the window is read afresh.
  const extra = store.addEvent(three.id, 'note', { text: 'Shipped ccc3333: three. Risk low: x.' });
  assert.equal(total(homeView(store, approvals, who, () => false, now - 1000, now + HOME_BUCKETS_MS + 1, cache)), 2);
  store.db.prepare('DELETE FROM events WHERE id = ?').run(extra.id);
  assert.equal(total(homeView(store, approvals, who, () => false, now - 1000, now + HOME_BUCKETS_MS + 2, cache)), 1);
  // A visit from before the window counts from the store, not the held notes.
  store.db.prepare('UPDATE events SET created_at = ?').run(now - 30 * 86_400_000);
  const fresh = new HomeBucketCache();
  assert.equal(total(homeView(store, approvals, who, () => false, now - 1000, now, fresh)), 0, 'nothing in the window');
  assert.equal(homeView(store, approvals, who, () => false, now - 40 * 86_400_000, now, fresh).schemes[0].shipped, 1, 'but the visit sees its ship');
});

test("Home's days are the last 14 Pacific dates, oldest first, each once, across both clock changes", () => {
  const fallBack = homeDays(Date.UTC(2026, 10, 2, 12)); // Nov 2, 4 AM PST: the day before was 25 hours
  assert.equal(fallBack.length, 14);
  assert.equal(new Set(fallBack).size, 14);
  assert.deepEqual([fallBack[0], fallBack.at(-1)], ['2026-10-20', '2026-11-02']);
  const springForward = homeDays(Date.UTC(2026, 2, 9, 7, 30)); // Mar 9, 12:30 AM PDT: Mar 8 was 23 hours
  assert.equal(springForward.length, 14);
  assert.ok(springForward.includes('2026-03-08'), 'the short day is kept');
  assert.deepEqual([springForward[0], springForward.at(-1)], ['2026-02-24', '2026-03-09']);
});

test('a visit to Home counts what shipped since the last one ended, and keeps that start through its own refreshes', () => {
  const { store } = setup('visits.sqlite');
  const t0 = 1_800_000_000_000;
  assert.equal(homeSince(store, 'Josh', t0), t0 - HOME_FIRST_LOOK, 'a first visit looks back a day');
  assert.equal(homeSince(store, 'josh', t0 + 60_000), t0 - HOME_FIRST_LOOK, 'a refresh in the same visit keeps its start');
  const back = t0 + 60_000 + HOME_VISIT_GAP + 1;
  assert.equal(homeSince(store, 'josh', back), t0 + 60_000, 'a new visit starts where the last one ended');
  assert.equal(homeSince(store, 'cara', back), back - HOME_FIRST_LOOK, 'kept per person');
});

// #1414: a cold read of 15 days of ship notes in one statement held the live loop 3-10.7 s on Home's first look, and
// again every minute after. The first fill now goes a range of event ids at a time, and refreshes read only new notes.
test("Home's ship cache fills in ranges of event ids, then reads only notes past the last one read", async () => {
  const { store, josh, scheme, minion, approvals } = setup('ranges.sqlite');
  const peek = scheme('Peek Auras');
  const one = minion(peek, 'one'),
    two = minion(peek, 'two');
  store.addEvent(one.id, 'note', { text: 'Shipped aaa1111: one. Risk low: x.' });
  store.db.prepare("INSERT INTO events (id, ticket_id, kind, data, created_at) VALUES (20000, ?, 'note', '{}', ?)").run(one.id, Date.now());
  const reads: unknown[][] = [];
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = ((sql: string, ...r: []) => {
    const st = prepare(sql, ...r);
    if (!/Shipped/.test(sql)) return st;
    const all = st.all.bind(st);
    st.all = ((...a: Parameters<typeof st.all>) => (reads.push(a), all(...a))) as typeof st.all;
    return st;
  }) as typeof store.db.prepare;
  const cache = new HomeBucketCache();
  await cache.ready(store);
  assert.ok(reads.length >= 4, `the first read goes in ranges: ${JSON.stringify(reads)}`);
  for (const [from, to] of reads) assert.ok(Number(to) - Number(from) <= 5_000, `${from}..${to}`);
  const now = Date.now();
  const who = { name: 'josh', uid: josh.id };
  reads.length = 0;
  assert.equal(homeView(store, approvals, who, () => false, now - 60_000, now, cache).schemes[0].shipped, 1);
  assert.equal(reads.length, 0, 'no new events: no read at all, `shipped` included');
  store.addEvent(two.id, 'note', { text: 'Shipped bbb2222: two. Risk low: x.' });
  const later = homeView(store, approvals, who, () => false, now - 60_000, now + HOME_BUCKETS_MS, cache);
  assert.equal(later.schemes[0].shipped, 2);
  assert.equal(
    later.schemes[0].daily.reduce((a: number, b: number) => a + b, 0),
    2,
  );
  assert.equal(reads.length, 1, 'one read, of the notes past the last');
  assert.ok(Number(reads[0][0]) > 20000, 'starting past the last event read');
});
