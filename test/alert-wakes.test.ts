import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AlertWakes, BATCH_MS, MAX_WAIT_MS, quietUntil, type AlertWakeDeps } from '../src/alert-wakes.ts';
import { Store } from '../src/db.ts';
import { Outbox, type OutboxRunner } from '../src/outbox.ts';

// A Mandate alert also wakes the Taskmaster it's about, to explain it unasked (#869; Cara, 2026-11-17: "there should be
// some callback to the relevant taskmaster so it can explain to me what happened without me asking").
const root = mkdtempSync(join(tmpdir(), 'alert-wakes-'));
after(() => rmSync(root, { recursive: true, force: true }));
// 2026-11-17 13:00 PST (21:00 UTC): outside the 2-9 AM hold.
const NOON = Date.UTC(2026, 10, 17, 21, 0);
const SEC = 1000;
const MIN = 60 * SEC;

let n = 0;
const outboxes: Outbox[] = [];
after(() => outboxes.forEach((o) => o.stop()));
const runner = { send: () => ({ event: { id: 1 } }), holds: () => false, onLane: (_i: number, _w: string, step: () => unknown) => Promise.resolve().then(step), leaveMail: () => {} } as unknown as OutboxRunner;
/** A server on `store`: its outbox (booted, on a clock the test moves) with the alert kind registered. */
async function server(store: Store, deps: AlertWakeDeps, clock = { now: NOON }) {
  const outbox = new Outbox(store, runner, { author: 'Citadel', now: () => clock.now });
  outboxes.push(outbox);
  const wakes = new AlertWakes(store, outbox, deps);
  await outbox.boot();
  /** The outbox's timer firing at `t`. */
  const tick = async (t: number) => {
    clock.now = t;
    await outbox.poke({ type: 'tick' });
  };
  return { outbox, wakes, tick, clock };
}
async function world() {
  const store = new Store(join(root, `db-${n++}.db`));
  const woken: [number, string][] = [];
  const deps = { wake: (scheme: number, text: string) => (woken.push([scheme, text]), true) };
  return { store, woken, deps, ...(await server(store, deps)) };
}
const ci = { id: 0, name: 'CI health' };
const peek = { id: 4, name: 'Peek Auras' };

test('one wake per alert, not per recipient, after the burst settles, naming who got it and its link', async () => {
  const w = await world();
  w.wakes.raise({ from: peek, key: 'fallback.ab', title: 'Turn for #12 ran inside the server', link: '/c/#/p/4/t/12', person: 'Cara' }, NOON);
  w.wakes.raise({ from: peek, key: 'fallback.ab', title: 'Turn for #12 ran inside the server', link: '/c/#/p/4/t/12', person: 'Josh' }, NOON + SEC);
  await w.tick(NOON + 30 * SEC);
  assert.deepEqual(w.woken, [], 'still inside the batch window');
  await w.tick(NOON + SEC + BATCH_MS);
  assert.equal(w.woken.length, 1);
  const [scheme, text] = w.woken[0];
  assert.equal(scheme, 4);
  assert.match(text, /Turn for #12 ran inside the server/);
  assert.match(text, /Cara and Josh/);
  assert.match(text, /\/c\/#\/p\/4\/t\/12/);
  assert.match(text, /what happened/);
  // Puts of the same alert again (a retry, a new admin) don't wake it twice.
  w.wakes.raise({ from: peek, key: 'fallback.ab', title: 'Turn for #12 ran inside the server', link: '/c/#/p/4/t/12', person: 'Rachel' }, NOON + 5 * MIN);
  await w.tick(NOON + 10 * MIN);
  assert.equal(w.woken.length, 1);
});

test('alerts in a burst are one wake per scheme; Citadel-wide ones go out as scheme 0', async () => {
  const w = await world();
  w.wakes.raise({ from: peek, key: 'fallback.a', title: 'A failed', link: '/l', person: 'Cara' }, NOON);
  w.wakes.raise({ from: peek, key: 'timer.b', title: 'B failed', link: '/l', person: 'Cara' }, NOON + 40 * SEC);
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'CI: runner X offline', link: '/l', person: 'Cara' }, NOON + 50 * SEC);
  await w.tick(NOON + 50 * SEC + BATCH_MS);
  assert.deepEqual(w.woken.map(([s]) => s).sort(), [0, 4]);
  const peekText = w.woken.find(([s]) => s === 4)![1];
  assert.match(peekText, /A failed/);
  assert.match(peekText, /B failed/);
});

test('a burst that keeps going still goes out after the longest wait', async () => {
  const w = await world();
  for (let t = 0; t <= MAX_WAIT_MS; t += 50 * SEC) {
    w.wakes.raise({ from: peek, key: `timer.${t}`, title: `job ${t} failed`, link: '/l', person: 'Cara' }, NOON + t);
    await w.tick(NOON + t);
  }
  assert.equal(w.woken.length, 1);
});

test('only new problems inside an open alert wake again; rewording, a problem leaving and the clear do not', async () => {
  const w = await world();
  const runnerX = { id: '1:runner:X', title: 'runner X offline' };
  const runnerY = { id: '9:runner:Y', title: 'runner Y offline', facts: 'host DESKTOP-Y' };
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'CI: runner X offline since 09:00', link: '/l', person: 'Cara', parts: [runnerX] }, NOON);
  await w.tick(NOON + BATCH_MS);
  assert.equal(w.woken.length, 1);
  // Reworded, same problems.
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'CI: runner X offline since 09:00 (1 scheme)', link: '/l', person: 'Cara', parts: [runnerX] }, NOON + 5 * MIN);
  await w.tick(NOON + 10 * MIN);
  assert.equal(w.woken.length, 1, 'rewording is not news');
  // Y joins: one wake naming Y, with its facts, and not X again as new.
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'CI: 2 runners offline', link: '/l', person: 'Cara', parts: [runnerX, runnerY] }, NOON + 11 * MIN);
  await w.tick(NOON + 11 * MIN + BATCH_MS);
  assert.equal(w.woken.length, 2);
  assert.match(w.woken[1][1], /runner Y offline/);
  assert.match(w.woken[1][1], /host DESKTOP-Y/);
  assert.doesNotMatch(w.woken[1][1], /New in it:[^\n]*runner X/);
  // X leaves, then the whole alert clears: no wakes.
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'CI: runner Y offline', link: '/l', person: 'Cara', parts: [runnerY] }, NOON + 20 * MIN);
  w.wakes.clear(ci, 'ci.open');
  await w.tick(NOON + 30 * MIN);
  assert.equal(w.woken.length, 2);
  // Open again later: news again.
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'CI: runner Y offline', link: '/l', person: 'Cara', parts: [runnerY] }, NOON + 40 * MIN);
  await w.tick(NOON + 40 * MIN + BATCH_MS);
  assert.equal(w.woken.length, 3);
});

test('an alert that clears inside the batch window never wakes anyone, nor a problem that leaves before it goes', async () => {
  const w = await world();
  w.wakes.raise({ from: peek, key: 'fallback.a', title: 'A failed', link: '/l', person: 'Cara' }, NOON);
  w.wakes.clear(peek, 'fallback.a');
  await w.tick(NOON + 10 * MIN);
  assert.deepEqual(w.woken, []);
  const x = { id: 'x', title: 'X down' };
  const y = { id: 'y', title: 'Y down' };
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'X and Y down', link: '/l', person: 'Cara', parts: [x, y] }, NOON + 20 * MIN);
  w.wakes.raise({ from: ci, key: 'ci.open', title: 'Y down', link: '/l', person: 'Cara', parts: [y] }, NOON + 20 * MIN + SEC);
  await w.tick(NOON + 20 * MIN + SEC + BATCH_MS);
  assert.equal(w.woken.length, 1);
  assert.doesNotMatch(w.woken[0][1], /X down/);
  assert.match(w.woken[0][1], /Y down/);
});

test('2-9 AM Pacific holds the wake until 9 (Cara, 2026-11-17: "Hold overnight ... between 2am and 9am"), across a restart', async () => {
  const w = await world();
  // 3:00 AM PST on Nov 18 = 11:00 UTC.
  const three = Date.UTC(2026, 10, 18, 11, 0);
  const nine = Date.UTC(2026, 10, 18, 17, 0);
  assert.equal(quietUntil(three), nine);
  assert.equal(quietUntil(NOON), null);
  assert.equal(quietUntil(Date.UTC(2026, 10, 18, 9, 59)), null, '1:59 AM is not held');
  w.wakes.raise({ from: peek, key: 'fallback.a', title: 'A failed', link: '/l', person: 'Cara' }, three);
  await w.tick(three + BATCH_MS);
  await w.tick(nine - SEC);
  assert.deepEqual(w.woken, []);
  // A restart before 9 keeps it.
  w.outbox.stop();
  const again = await server(w.store, w.deps, { now: nine - SEC });
  await again.tick(nine);
  assert.equal(w.woken.length, 1);
  assert.match(w.woken[0][1], /held overnight/);
  // PDT too: 2:30 AM on Jul 1 is 09:30 UTC; 9 AM PDT is 16:00 UTC.
  assert.equal(quietUntil(Date.UTC(2026, 6, 1, 9, 30)), Date.UTC(2026, 6, 1, 16, 0));
});

test('a scheme with no Taskmaster drops its batch rather than retrying forever', async () => {
  const w = await world();
  w.outbox.stop();
  const s = await server(w.store, { wake: (sc, t) => (w.woken.push([sc, t]), false) });
  s.wakes.raise({ from: peek, key: 'fallback.a', title: 'A failed', link: '/l', person: 'Cara' }, NOON);
  await s.tick(NOON + BATCH_MS);
  await s.tick(NOON + 2 * BATCH_MS);
  assert.equal(w.woken.length, 1);
  // Nothing was explained, so the row is not counted as sent (ADR 0021: a send that delivered nothing is not accepted).
  const [row] = w.store.listDeliveries({ kind: 'alert' });
  assert.equal(row.state, 'dropped');
  assert.match(row.reason ?? '', /no Taskmaster/);
});

// ADR 0021 step 6 (#1392): the batch is an outbox row, one per scheme, that new alerts merge into; the 20 s tick is gone.
test('three alerts in 40 s are one waiting row and one wake, due 60 s after the last', async () => {
  const w = await world();
  w.wakes.raise({ from: peek, key: 'a', title: 'A failed', link: '/l', person: 'Cara' }, NOON);
  w.wakes.raise({ from: peek, key: 'b', title: 'B failed', link: '/l', person: 'Cara' }, NOON + 20 * SEC);
  w.wakes.raise({ from: peek, key: 'c', title: 'C failed', link: '/l', person: 'Cara' }, NOON + 40 * SEC);
  const rows = w.store.listDeliveries({ kind: 'alert', states: ['waiting'] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].to_kind, 'taskmaster');
  assert.equal(rows[0].to_id, 4);
  assert.equal(rows[0].due, NOON + 40 * SEC + BATCH_MS);
  await w.tick(NOON + 40 * SEC + BATCH_MS - 1);
  assert.equal(w.woken.length, 0);
  await w.tick(NOON + 40 * SEC + BATCH_MS);
  assert.equal(w.woken.length, 1);
  assert.match(w.woken[0][1], /3 Mandate alerts/);
  assert.equal(w.store.listDeliveries({ kind: 'alert' })[0].state, 'sent');
});

test('an alert at 03:00 PST is due at 09:00 PST, and its row says so', async () => {
  const w = await world();
  const three = Date.UTC(2026, 10, 18, 11, 0);
  const nine = Date.UTC(2026, 10, 18, 17, 0);
  w.wakes.raise({ from: peek, key: 'a', title: 'A failed', link: '/l', person: 'Cara' }, three);
  assert.equal(w.store.listDeliveries({ kind: 'alert' })[0].due, nine);
  // 1:59:30 AM: its 60 s would end at 2:00:30, inside the hold, so it waits too.
  const late = Date.UTC(2026, 10, 18, 9, 59, 30);
  w.wakes.raise({ from: ci, key: 'x', title: 'X down', link: '/l', person: 'Cara' }, late);
  assert.equal(w.store.listDeliveries({ kind: 'alert', dedupe: '0' })[0].due, nine);
});

test('an alert that clears trims its row, and the last one out drops it', async () => {
  const w = await world();
  w.wakes.raise({ from: peek, key: 'a', title: 'A failed', link: '/l', person: 'Cara' }, NOON);
  w.wakes.raise({ from: peek, key: 'b', title: 'B failed', link: '/l', person: 'Cara' }, NOON + SEC);
  w.wakes.clear(peek, 'a');
  const [row] = w.store.listDeliveries({ kind: 'alert', states: ['waiting'] });
  assert.deepEqual(Object.keys(row.payload.alerts), ['4:b']);
  w.wakes.clear(peek, 'b');
  assert.deepEqual(w.store.listDeliveries({ kind: 'alert', states: ['waiting'] }), []);
  await w.tick(NOON + 10 * MIN);
  assert.deepEqual(w.woken, []);
});

test('what was told is saved with the row: a row that fails to save leaves told as it was', async () => {
  const w = await world();
  const add = w.store.addDelivery;
  w.store.addDelivery = () => {
    throw new Error('disk full');
  };
  assert.throws(() => w.wakes.raise({ from: peek, key: 'a', title: 'A failed', link: '/l', person: 'Cara' }, NOON), /disk full/);
  w.store.addDelivery = add;
  assert.equal(w.store.getSetting('alert-told'), null);
  // So the next put of the same alert is still news.
  w.wakes.raise({ from: peek, key: 'a', title: 'A failed', link: '/l', person: 'Cara' }, NOON + SEC);
  await w.tick(NOON + SEC + BATCH_MS);
  assert.equal(w.woken.length, 1);
});

test('saved batches move into the table on first boot with the old key emptied in the same step; none dropped', async () => {
  const store = new Store(join(root, `db-${n++}.db`));
  store.setSetting('alert-wakes', {
    told: { '4:a': ['a'], '0:ci.open': ['x'] },
    batches: {
      '4': { first: NOON - 30 * SEC, last: NOON - 30 * SEC, alerts: { '4:a': { sender: 'Peek Auras', title: 'A failed', link: '/l', to: ['Cara'], parts: null } } },
      '0': { first: NOON - 10 * MIN, last: NOON - 10 * MIN, alerts: { '0:ci.open': { sender: 'CI health', title: 'X down', link: '/l', to: ['Josh'], parts: [{ id: 'x', title: 'X down' }] } } },
    },
  });
  const woken: [number, string][] = [];
  const s = await server(store, { wake: (sc, t) => (woken.push([sc, t]), true) });
  assert.equal(store.getSetting('alert-wakes'), null, 'the old key is emptied');
  assert.deepEqual(store.getSetting('alert-told'), { '4:a': ['a'], '0:ci.open': ['x'] });
  // The overdue one went at boot; the other keeps its time.
  assert.deepEqual(woken.map(([sc]) => sc), [0]);
  assert.match(woken[0][1], /X down/);
  const [peekRow] = store.listDeliveries({ kind: 'alert', dedupe: '4', states: ['waiting'] });
  assert.equal(peekRow.due, NOON + 30 * SEC);
  await s.tick(NOON + 30 * SEC);
  assert.deepEqual(woken.map(([sc]) => sc), [0, 4]);
  // Told came along: the same alert again is not news.
  s.wakes.raise({ from: peek, key: 'a', title: 'A failed', link: '/l', person: 'Cara' }, NOON + MIN);
  assert.deepEqual(store.listDeliveries({ kind: 'alert', states: ['waiting'] }), []);
});

test('an old key written after boot (the dual read) merges into the waiting row', async () => {
  const w = await world();
  w.wakes.raise({ from: peek, key: 'b', title: 'B failed', link: '/l', person: 'Cara' }, NOON);
  w.store.setSetting('alert-wakes', { told: { '4:a': ['4:a'] }, batches: { '4': { first: NOON - 20 * SEC, last: NOON - 20 * SEC, alerts: { '4:a': { sender: 'Peek Auras', title: 'A failed', link: '/l', to: ['Cara'], parts: null } } } } });
  await w.tick(NOON + 10 * SEC);
  const rows = w.store.listDeliveries({ kind: 'alert', states: ['waiting'] });
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0].payload.alerts).sort(), ['4:a', '4:b']);
  assert.equal(rows[0].due, NOON + BATCH_MS, 'the earlier of 60 s after the last and 5 min after the first');
  assert.equal(w.store.getSetting('alert-wakes'), null);
  assert.deepEqual(Object.keys(w.store.getSetting<Record<string, string[]>>('alert-told')!).sort(), ['4:a', '4:b']);
});

test('a row due at 01:59 that a late boot reaches at 02:00 waits until 09:00, and says it was held', async () => {
  const w = await world();
  const early = Date.UTC(2026, 10, 18, 9, 58, 30); // 1:58:30 AM PST: due 1:59:30
  w.wakes.raise({ from: peek, key: 'a', title: 'A failed', link: '/l', person: 'Cara' }, early);
  assert.equal(w.store.listDeliveries({ kind: 'alert' })[0].due, early + BATCH_MS);
  // The server was down from 1:59 to 2:00:10.
  w.outbox.stop();
  const two = Date.UTC(2026, 10, 18, 10, 0, 10);
  const nine = Date.UTC(2026, 10, 18, 17, 0);
  const again = await server(w.store, w.deps, { now: two });
  assert.deepEqual(w.woken, []);
  const [row] = w.store.listDeliveries({ kind: 'alert', states: ['waiting'] });
  assert.equal(row.due, nine);
  // An alert in the hold merges into it rather than making a second row.
  again.wakes.raise({ from: peek, key: 'b', title: 'B failed', link: '/l', person: 'Cara' }, two + MIN);
  assert.equal(w.store.listDeliveries({ kind: 'alert', states: ['waiting'] }).length, 1);
  await again.tick(nine);
  assert.equal(w.woken.length, 1);
  assert.match(w.woken[0][1], /held overnight/);
  assert.match(w.woken[0][1], /A failed[\s\S]*B failed/);
});

test('a wake a killed server left mid-send goes again, marked as a possible repeat', async () => {
  const w = await world();
  w.wakes.raise({ from: peek, key: 'a', title: 'A failed', link: '/l', person: 'Cara' }, NOON);
  const [row] = w.store.listDeliveries({ kind: 'alert' });
  w.store.updateDelivery(row.id, { state: 'sending' });
  w.outbox.stop();
  await server(w.store, w.deps, { now: NOON + 2 * MIN });
  assert.equal(w.woken.length, 1);
  assert.match(w.woken[0][1], /may repeat/);
});
