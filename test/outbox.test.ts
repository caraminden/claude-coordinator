// The one outbox (ADR 0021, #1385): the deliveries table and its dispatcher, proved on wake_at. A fake runner stands in
// for the real one here (sends are recorded, its lane runs a step at once); test/restart-anywhere.test.ts runs the kind on
// a real Runner, killed at each saved step.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Outbox, type OutboxRunner, RETRY_MINUTES } from '../src/outbox.ts';
import { pacificTime, TimedWakes } from '../src/wake.ts';
import { testPins } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'outbox-'));
after(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.UTC(2026, 10, 14, 20, 0); // 12:00 PST
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let store: Store;
let project: { id: number };
let n = 0;
let boxes: Outbox[] = [];
beforeEach(() => {
  store = new Store(join(root, `test${++n}.db`));
  project = store.createProject('P', null);
});
afterEach(() => {
  for (const b of boxes) b.stop();
  boxes = [];
});

const minion = () => {
  const id = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' }).id;
  store.updateTicket(id, { status: 'idle' });
  return id;
};

type Sent = { id: number; text: string; event: number };
/** A runner that records each send and hands back an event id. `holding`: the events its queues still hold (a restored
 * queue, a usage-limit wait); `stall` keeps lane steps from running (a minion's turn holds its lane); `failOn` throws on
 * a send whose text matches. */
function fakeRunner(firstEvent = 0) {
  let events = firstEvent;
  const r = {
    sent: [] as Sent[],
    holding: new Set<number>(),
    stall: false,
    failOn: null as RegExp | null,
    refuse: null as string | null,
    send(ticketId: number, _author: string, text: string) {
      if (r.failOn?.test(text)) throw new Error('send failed');
      const event = { id: ++events };
      r.sent.push({ id: ticketId, text, event: event.id });
      return { event };
    },
    holds: (_ticketId: number, eventId: number) => r.holding.has(eventId),
    onLane(_id: number, _what: string, step: () => unknown) {
      return r.stall ? new Promise(() => {}) : Promise.resolve().then(step);
    },
    refuseTurn: () => r.refuse,
  };
  return r;
}

/** A server: an outbox on the store with wake_at registered, at the clock `now`. */
function server(runner: ReturnType<typeof fakeRunner>, now: { t: number }) {
  const outbox = new Outbox(store, runner as unknown as OutboxRunner, { author: 'Citadel', now: () => now.t });
  boxes.push(outbox);
  const wakes = new TimedWakes(store, outbox);
  return { outbox, wakes };
}

const rows = (ticket: number) => store.listDeliveries({ kind: 'wake_at', to: ticket });

test('a server killed between sending and sent sends the wake again once, marked as a possible repeat', async () => {
  const id = minion();
  const now = { t: T0 };
  const first = fakeRunner();
  const a = server(first, now);
  await a.outbox.boot();
  const w = a.wakes.add(id, T0 + HOUR, 'check the deploy', `minion:${id}`);
  now.t += HOUR;
  await a.outbox.poke({ type: 'tick' });
  // Handed to the runner, but its turn hasn't started: in memory only, so the row stays sending.
  assert.equal(first.sent.length, 1);
  assert.equal(rows(id)[0].state, 'sending');
  a.outbox.stop(); // killed here

  // Killed again at once, before the minion's lane let the resend through: still sending, so the next boot marks it too.
  const stalled = fakeRunner();
  stalled.stall = true;
  const s = server(stalled, now);
  void s.outbox.boot();
  await new Promise((done) => setImmediate(done));
  assert.equal(stalled.sent.length, 0);
  s.outbox.stop();

  const second = fakeRunner(100);
  const b = server(second, now);
  await b.outbox.boot();
  assert.equal(second.sent.length, 1, 'sent again at boot');
  assert.match(second.sent[0].text, /check the deploy/);
  assert.match(second.sent[0].text, new RegExp(`may repeat delivery #${w.id}\\b`));
  b.outbox.turnStarted(id, [second.sent[0].event]);
  assert.equal(rows(id)[0].state, 'sent');
  b.outbox.stop();

  const third = fakeRunner();
  await server(third, now).outbox.boot();
  assert.equal(third.sent.length, 0, 'once sent, never again');
});

test('a wake missed while the server was down is sent at boot, saying how late', async () => {
  const id = minion();
  const now = { t: T0 };
  const a = server(fakeRunner(), now);
  await a.outbox.boot();
  a.wakes.add(id, T0 + HOUR, 'start the retire minion', `minion:${id}`);
  a.outbox.stop();
  now.t = T0 + HOUR + 2 * HOUR + 5 * 60_000; // down from before its time until 2 h 5 min after it
  const r = fakeRunner();
  await server(r, now).outbox.boot();
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].text, new RegExp(`Wake you set for ${pacificTime(T0 + HOUR)}`));
  assert.match(r.sent[0].text, /2 h 5 min late: the server was down when it came due/);
  assert.match(r.sent[0].text, /start the retire minion/);
});

test('a dismissed minion\'s wake is held: delivered on a reopen on day 2, dropped on day 4', async () => {
  const now = { t: T0 };
  const r = fakeRunner();
  const { outbox, wakes } = server(r, now);
  await outbox.boot();

  const kept = minion();
  wakes.add(kept, T0 + HOUR, 'kept for the reopen', `minion:${kept}`);
  const lost = minion();
  wakes.add(lost, T0 + HOUR, 'dropped after 3 days', `minion:${lost}`);
  for (const id of [kept, lost]) {
    store.updateTicket(id, { status: 'closed' });
    await outbox.poke({ type: 'closed', ticket: id });
  }
  now.t += HOUR;
  await outbox.poke({ type: 'tick' });
  assert.deepEqual(r.sent, [], 'nothing goes to a dismissed minion');
  assert.deepEqual([rows(kept)[0].state, rows(lost)[0].state], ['held', 'held']);

  now.t = T0 + 2 * DAY;
  store.updateTicket(kept, { status: 'idle' });
  await outbox.poke({ type: 'reopened', ticket: kept });
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].id, kept);
  assert.match(r.sent[0].text, /kept for the reopen/);
  assert.match(r.sent[0].text, /came due while this minion was dismissed/);

  now.t = T0 + 4 * DAY;
  await outbox.poke({ type: 'tick' });
  const [gone] = rows(lost);
  assert.equal(gone.state, 'dropped');
  assert.equal(gone.reason, 'minion dismissed');
  store.updateTicket(lost, { status: 'idle' });
  await outbox.poke({ type: 'reopened', ticket: lost });
  assert.equal(r.sent.length, 1, 'a dropped wake stays dropped');

  // Dismissed and reopened before its time: it says nothing about a dismissal when it comes due.
  const back = minion();
  wakes.add(back, now.t + DAY, 'after a short dismissal', `minion:${back}`);
  store.updateTicket(back, { status: 'closed' });
  await outbox.poke({ type: 'closed', ticket: back });
  store.updateTicket(back, { status: 'idle' });
  await outbox.poke({ type: 'reopened', ticket: back });
  now.t += DAY;
  await outbox.poke({ type: 'tick' });
  assert.equal(r.sent.at(-1)!.id, back);
  assert.doesNotMatch(r.sent.at(-1)!.text, /dismissed/);
});

test('a far-off wake outlives a dismissal until 3 days past its own time', async () => {
  const now = { t: T0 };
  const r = fakeRunner();
  const { outbox, wakes } = server(r, now);
  await outbox.boot();
  const back = minion();
  wakes.add(back, T0 + 10 * DAY, 'reopened on day 5', `minion:${back}`);
  const gone = minion();
  wakes.add(gone, T0 + 10 * DAY, 'never reopened', `minion:${gone}`);
  for (const id of [back, gone]) {
    store.updateTicket(id, { status: 'closed' });
    await outbox.poke({ type: 'closed', ticket: id });
  }
  now.t = T0 + 5 * DAY;
  await outbox.poke({ type: 'tick' });
  assert.deepEqual([rows(back)[0].state, rows(gone)[0].state], ['held', 'held'], 'not dropped 3 days after the dismissal');
  store.updateTicket(back, { status: 'idle' });
  await outbox.poke({ type: 'reopened', ticket: back });
  assert.deepEqual(r.sent, [], 'it waits for its own time');
  now.t = T0 + 10 * DAY;
  await outbox.poke({ type: 'tick' });
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].id, back);
  assert.doesNotMatch(r.sent[0].text, /dismissed/);
  now.t = T0 + 12 * DAY;
  await outbox.poke({ type: 'tick' });
  assert.equal(rows(gone)[0].state, 'held', 'still held 2 days past its time');
  now.t = T0 + 13 * DAY + 1;
  await outbox.poke({ type: 'tick' });
  assert.equal(rows(gone)[0].state, 'dropped');
});

test('a send that fails is retried 1, 5, 30, 120 and 360 minutes on, then fails and wakes the setter\'s Taskmaster', async () => {
  const id = minion();
  const tm = store.createTicket({ project_id: project.id, title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara', kind: 'coordinator' } as any).id;
  const now = { t: T0 };
  const r = fakeRunner();
  const { outbox, wakes } = server(r, now);
  await outbox.boot();
  wakes.add(id, T0 + HOUR, 'retry me', `minion:${id}`);
  r.refuse = 'No Claude login';
  now.t += HOUR;
  await outbox.poke({ type: 'tick' });
  for (const m of RETRY_MINUTES) {
    const [row] = rows(id);
    assert.equal(row.state, 'waiting');
    assert.equal(row.due, now.t + m * 60_000);
    assert.ok(row.met_at, 'its time came: retried by due alone');
    now.t = row.due!;
    await outbox.poke({ type: 'tick' });
  }
  const [row] = rows(id);
  assert.equal(row.state, 'failed');
  assert.match(row.last_error ?? '', /No Claude login/);
  assert.equal(r.sent.length, 1, 'only the Taskmaster heard');
  assert.equal(r.sent[0].id, tm);
  assert.match(r.sent[0].text, /retry me/);
});

test('a handed wake the runner still holds (a usage-limit wait) is never sent twice, across restarts; one it dropped is retried, unmarked', async () => {
  const id = minion();
  const now = { t: T0 };
  const a = fakeRunner();
  const first = server(a, now);
  await first.outbox.boot();
  first.wakes.add(id, T0 + HOUR, 'held by the limit', `minion:${id}`);
  now.t += HOUR;
  await first.outbox.poke({ type: 'tick' });
  const event = a.sent[0].event;
  a.holding.add(event); // saved in limit-resumes until the limit resets
  assert.equal(rows(id)[0].event_id, event, 'the event is saved on the row');
  for (let i = 0; i < 3; i++) {
    now.t += 10 * 60_000;
    await first.outbox.poke({ type: 'tick' });
  }
  assert.equal(a.sent.length, 1, 'rechecked, not resent');
  first.outbox.stop();
  for (let boot = 0; boot < 3; boot++) {
    const r = fakeRunner(100);
    r.holding.add(event); // recover() restored it
    await server(r, now).outbox.boot();
    assert.equal(r.sent.length, 0, `restart ${boot + 1}: the runner still holds it`);
    now.t += HOUR;
  }
  const last = fakeRunner(100);
  last.holding.add(event);
  const c = server(last, now);
  await c.outbox.boot();
  c.outbox.turnStarted(id, [event]); // the limit reset and its turn started
  assert.equal(rows(id)[0].state, 'sent');

  // The runner dropped one (its turn was refused when it came to run): retried after the check, without a repeat line.
  c.wakes.add(id, now.t + HOUR, 'dropped by the runner', `minion:${id}`);
  now.t += HOUR;
  await c.outbox.poke({ type: 'tick' });
  assert.equal(last.sent.length, 1);
  now.t += 5 * 60_000;
  await c.outbox.poke({ type: 'tick' });
  const [, row] = rows(id);
  assert.equal(row.state, 'waiting');
  assert.equal(row.attempts, 1);
  now.t = row.due!;
  await c.outbox.poke({ type: 'tick' });
  assert.equal(last.sent.length, 2);
  assert.match(last.sent[1].text, new RegExp(`\\(delivery #${row.id}\\)$`));
});

test('a send that throws retries only its own row; the others in the batch stay handed', async () => {
  const id = minion();
  const now = { t: T0 };
  const r = fakeRunner();
  const { outbox, wakes } = server(r, now);
  await outbox.boot();
  wakes.add(id, T0 + HOUR, 'goes', `minion:${id}`);
  wakes.add(id, T0 + HOUR, 'throws', `minion:${id}`);
  r.failOn = /throws/;
  now.t += HOUR;
  await outbox.poke({ type: 'tick' });
  const [ok, bad] = rows(id);
  assert.deepEqual([ok.state, ok.event_id], ['sending', r.sent[0].event]);
  assert.deepEqual([bad.state, bad.attempts, bad.last_error], ['waiting', 1, 'send failed']);
});

test('the old timed-wakes key moves into the table on boot in one go, keeping ids; one turning up later moves too', async () => {
  const a = minion();
  const b = minion();
  store.updateTicket(b, { status: 'closed' });
  const old = [
    { id: 3, ticket: a, at: T0 + HOUR, note: 'one', setBy: 'Minion' },
    { id: 7, ticket: a, at: T0 + 2 * HOUR, note: 'two', setBy: 'Minion' },
    { id: 4, ticket: b, at: T0 + HOUR, note: 'closed one', setBy: 'Minion' },
  ];
  store.setSetting('timed-wakes', old);
  const now = { t: T0 };
  const r = fakeRunner();
  const { outbox, wakes } = server(r, now);
  await outbox.boot();
  assert.equal(store.getSetting('timed-wakes'), null, 'the old key is emptied');
  assert.deepEqual(wakes.list(a).map((w) => [w.id, w.note, w.at]), [[3, 'one', T0 + HOUR], [7, 'two', T0 + 2 * HOUR]]);
  assert.equal(rows(b)[0].state, 'held', 'a closed minion\'s migrated wake is held, not dropped');
  assert.ok(rows(a).every((d) => d.origin?.startsWith('timed-wakes:')));
  // An older release after a rollback writes the old key again: the next poke moves it, once.
  store.setSetting('timed-wakes', [{ id: 1, ticket: a, at: T0 + 3 * HOUR, note: 'from the rollback', setBy: 'Minion' }]);
  await outbox.poke({ type: 'tick' });
  await outbox.poke({ type: 'tick' });
  assert.equal(store.getSetting('timed-wakes'), null);
  const later = wakes.list(a).find((w) => w.note === 'from the rollback')!;
  assert.ok(later.id > 7, 'an id the table already used is not reused');
  assert.equal(wakes.list(a).length, 3);
});

test('limits still hold, cancel works only in its own chat, and sent rows are pruned after a day', async () => {
  const a = minion();
  const b = minion();
  const now = { t: T0 };
  const r = fakeRunner();
  const { outbox, wakes } = server(r, now);
  await outbox.boot();
  assert.throws(() => wakes.add(a, T0 - 1, 'x', 'm'), /already past/);
  assert.throws(() => wakes.add(a, T0 + 91 * DAY, 'x', 'm'), /90 days/);
  assert.throws(() => wakes.add(a, NaN, 'x', 'm'), /not a time/);
  for (let i = 0; i < 20; i++) wakes.add(a, T0 + 1000 + i, 'x', 'm');
  assert.throws(() => wakes.add(a, T0 + 5000, 'x', 'm'), /20 wakes/);
  const w = wakes.add(b, T0 + HOUR, 'mine', 'm');
  assert.equal(wakes.cancel(a, w.id), false);
  assert.equal(wakes.cancel(b, w.id), true);
  assert.equal(wakes.cancel(b, w.id), false);
  assert.equal(wakes.list(b).length, 0);
  now.t += 10_000;
  await outbox.poke({ type: 'tick' });
  assert.equal(r.sent.length, 20);
  outbox.turnStarted(a, r.sent.map((m) => m.event));
  assert.equal(wakes.list(a).length, 0);
  now.t += DAY + 1;
  await outbox.poke({ type: 'tick' });
  assert.equal(rows(a).length, 0, 'sent rows go after a day');
  assert.equal(rows(b)[0].state, 'dropped', 'a cancelled row stays, greyed, for 7 days');
  now.t += 7 * DAY;
  await outbox.poke({ type: 'tick' });
  assert.equal(rows(b).length, 0);
});
