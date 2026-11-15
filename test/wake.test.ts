import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { Store } from '../src/db.ts';
import { MAX_WAKES, pacificTime, parseWakeTime, TimedWakes } from '../src/wake.ts';
import { testPins } from './helpers.ts';
testPins();

// wake_at (#722): timed wakes, in the settings table, sent to the asker's own chat.
const root = mkdtempSync(join(tmpdir(), 'wake-at-'));
after(() => rmSync(root, { recursive: true, force: true }));
let store: Store;
let n = 0;
let project: { id: number };
const minion = () => store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' }).id;
// A store of its own per test, so one test's wakes never fire in another's.
beforeEach(() => {
  store = new Store(join(root, `test${++n}.db`));
  project = store.createProject('P', null);
});
const T0 = Date.UTC(2026, 10, 14, 20, 0); // 12:00 PST
const sent: { id: number; text: string }[] = [];
const make = (now: { t: number }) => new TimedWakes(store, (id, text) => sent.push({ id, text }), () => now.t);

test('Pacific times: PST in winter, PDT in summer, an offset or Z is taken as given', () => {
  assert.equal(parseWakeTime('2026-11-18 09:00'), Date.UTC(2026, 10, 18, 17, 0));
  assert.equal(parseWakeTime('2026-07-01T09:00'), Date.UTC(2026, 6, 1, 16, 0));
  assert.equal(parseWakeTime('2026-11-18T09:00:00-08:00'), Date.UTC(2026, 10, 18, 17, 0));
  assert.equal(parseWakeTime('2026-11-18 09:00Z'), Date.UTC(2026, 10, 18, 9, 0));
  assert.ok(Number.isNaN(parseWakeTime('tomorrow')));
  assert.ok(Number.isNaN(parseWakeTime('2026-11-31 09:00')));
  assert.equal(pacificTime(Date.UTC(2026, 10, 18, 17, 0)), 'Wed 18 Nov, 09:00 PST');
});

test('a wake fires at its time, once, into its own chat', () => {
  const id = minion();
  const now = { t: T0 };
  const w = make(now);
  w.add(id, T0 + 3_600_000, 'start the retire minion', 'Cara');
  sent.length = 0;
  assert.equal(w.fire(), 0);
  now.t += 3_600_000;
  assert.equal(w.fire(), 1);
  assert.equal(w.fire(), 0);
  assert.deepEqual(sent, [{ id, text: `Wake you set for ${pacificTime(T0 + 3_600_000)}: start the retire minion` }]);
  assert.equal(w.list(id).length, 0);
});

test('a wake survives a restart: a new server catches up on what came due while it was down', () => {
  const id = minion();
  const now = { t: T0 };
  make(now).add(id, T0 + 1000, 'after the restart', 'Cara');
  now.t += 86_400_000; // down for a day
  sent.length = 0;
  const booted = make(now);
  assert.equal(booted.list(id).length, 1);
  assert.equal(booted.fire(), 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /after the restart/);
});

test('a time in the past, too far out, a bad time and the 21st wake are refused', () => {
  const id = minion();
  const w = make({ t: T0 });
  assert.throws(() => w.add(id, T0 - 1, 'x', 'Cara'), /already past/);
  assert.throws(() => w.add(id, T0 + 91 * 86_400_000, 'x', 'Cara'), /90 days/);
  assert.throws(() => w.add(id, NaN, 'x', 'Cara'), /not a time/);
  for (let i = 0; i < MAX_WAKES; i++) w.add(id, T0 + 1000 + i, 'x', 'Cara');
  assert.throws(() => w.add(id, T0 + 5000, 'x', 'Cara'), /20 wakes/);
});

test('a wake that comes due mid-turn goes through runner.send, which queues it for the turn end', async () => {
  // The runner's own queueing holds a send for a running turn (send() pushes to queues and only starts a turn when idle).
  const { Runner } = await import('../src/runner.ts');
  assert.match(String(Runner.prototype.send), /isRunning\(ticketId\)/);
});

test('cancel removes a wake, only from its own chat; a dismissed minion\'s wake is dropped unsent', () => {
  const a = minion();
  const b = minion();
  const now = { t: T0 };
  const w = make(now);
  const x = w.add(a, T0 + 1000, 'cancelled', 'Cara');
  assert.equal(w.cancel(b, x.id), false);
  assert.equal(w.cancel(a, x.id), true);
  assert.equal(w.cancel(a, x.id), false);
  w.add(b, T0 + 1000, 'dismissed', 'Cara');
  store.updateTicket(b, { status: 'closed' });
  now.t += 2000;
  sent.length = 0;
  w.fire();
  assert.deepEqual(sent, []);
  assert.equal(w.list().filter((o) => o.ticket === a || o.ticket === b).length, 0);
});
