import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { Store } from '../src/db.ts';
import { MAX_WAKES, pacificTime, parseWakeTime, TimedWakes } from '../src/wake.ts';
import { stopTurns, testPins } from './helpers.ts';
testPins();

// wake_at (#722): timed wakes, in the settings table, sent to the asker's own chat.
const root = mkdtempSync(join(tmpdir(), 'wake-at-'));
after(async () => {
  await stopTurns(root); // the queued wake's turn may still be running its fake claude (under root)
  rmSync(root, { recursive: true, force: true });
});
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
  assert.ok(Number.isNaN(parseWakeTime('2026-11-18 09:99')));
  assert.ok(Number.isNaN(parseWakeTime('2026-11-18 24:00')));
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

test('the timer itself delivers, and a wake that came due mid-turn is queued behind the turn and read after it', async () => {
  const { Runner } = await import('../src/runner.ts');
  const { chmodSync, writeFileSync } = await import('node:fs');
  const fake = join(root, 'claude-fake');
  writeFileSync(fake, `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).once('line', () => setTimeout(() => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
}, 400));
`);
  chmodSync(fake, 0o755);
  const runner = new Runner(store, () => {}, () => ({}), fake);
  const id = minion();
  store.setTicketDir(id, root, null);
  const wakes = new TimedWakes(store, (t, text) => runner.send(t, 'Citadel', text));
  runner.send(id, 'Cara', 'first');
  assert.ok(runner.isRunning(id));
  wakes.add(id, Date.now() + 100, 'mid-turn wake', 'Cara'); // real clock, real timer: it comes due while the turn runs
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(runner.queued(id), 1);
  while (runner.isRunning(id)) await new Promise((r) => setTimeout(r, 20));
  const said = store.listEvents(id).filter((e) => e.kind === 'user_message').map((e) => JSON.parse(e.data).text);
  assert.equal(said.length, 2);
  assert.match(said[1], /mid-turn wake/);
});

test('boot catches up: arm() sends an overdue wake with no call to fire()', async () => {
  const id = minion();
  const now = { t: T0 };
  make(now).add(id, T0 + 1000, 'overdue', 'Cara');
  now.t += 5000;
  sent.length = 0;
  make(now).arm();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 1);
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
