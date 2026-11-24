import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Outbox } from '../src/outbox.ts';
import { pacificTime, parseWakeTime, TimedWakes } from '../src/wake.ts';
import { FakeClock } from './fake-clock.ts';
import { stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// wake_at (#722): timed wakes, sent to the asker's own chat; since #1385 rows of the one outbox (src/outbox.ts).
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

// The rest of wake_at (fires once, restarts, limits, cancel, the 3-day rule) is in test/outbox.test.ts since #1385.
test('on a real runner the timer delivers, a wake due mid-turn waits behind the turn, and its turn starting marks it sent', async () => {
  const { Runner } = await import('../src/runner.ts');
  const { chmodSync, writeFileSync } = await import('node:fs');
  const fake = join(root, 'claude-fake');
  writeFileSync(
    fake,
    `#!${process.execPath}
const release = ${JSON.stringify(join(root, 'release'))};
require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
  // The turn runs until the test releases it, so "mid-turn" doesn't depend on how long anything takes.
  const poll = setInterval(() => {
    if (!require('node:fs').existsSync(release)) return;
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
    process.exit(0);
  }, 20);
});
`,
  );
  chmodSync(fake, 0o755);
  const runner = new Runner(
    store,
    () => {},
    () => ({}),
    fake,
  );
  let queued = false; // the outbox handed the due wake to the minion's lane
  const onLane = runner.onLane.bind(runner);
  runner.onLane = ((ticket: number, name: string, step: () => Promise<unknown>) => ((queued = queued || name === 'outbox'), onLane(ticket, name, step))) as typeof runner.onLane;
  const id = minion();
  store.setTicketDir(id, root, null);
  const fakeNow = new FakeClock(); // the outbox's clock: the wake comes due when the test says
  const outbox = new Outbox(store, runner, { author: 'Citadel', now: fakeNow.now });
  runner.onTurnStart = (t, ids) => outbox.turnStarted(t, ids);
  await outbox.boot();
  const wakes = new TimedWakes(store, outbox);
  runner.send(id, 'Cara', 'first');
  assert.ok(runner.isRunning(id));
  const w = wakes.add(id, fakeNow.now() + 100, 'mid-turn wake', 'Cara');
  fakeNow.advance(200); // it comes due while the turn is still running
  const poked = outbox.poke({ type: 'tick' }); // ends once the delivery has run, so not awaited until the turn is released
  await until('the due wake to queue on the minion lane', async () => queued);
  assert.equal(store.getDelivery(w.id)!.state, 'waiting', 'its delivery waits on the lane behind the running turn');
  writeFileSync(join(root, 'release'), ''); // the turn ends; the wake, due since, is delivered
  await poked;
  await until('the wake to be sent', async () => store.getDelivery(w.id)!.state === 'sent');
  await until('the turn to stop', async () => !runner.isRunning(id));
  outbox.stop();
  const said = store
    .listEvents(id)
    .filter((e) => e.kind === 'user_message')
    .map((e) => JSON.parse(e.data).text);
  assert.equal(said.length, 2);
  assert.match(said[1], /mid-turn wake/);
  assert.match(said[1], new RegExp(`\\(delivery #${w.id}\\)`));
});
