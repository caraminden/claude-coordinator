// Drill 5 (#1326): the server killed at two named points (src/fault-points.ts) between a step and its mark, then booted
// again: a schedule between its minion's start and the slot's "ran" mark, a ship between its shipped line and the rename
// of handoff.json. Each step is done once.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../../src/db.ts';
import { until } from '../helpers.ts';
import { Drill, gap } from './harness.ts';

const d = new Drill('kill-points');
after(() => d.cleanup());

// C3: the slot's skip guard reads the "ran" mark, so a kill before it lets the next server start the slot's minion again.
test("a kill between a schedule's minion start and its ran mark starts one minion for the slot", async () => {
  await d.boot();
  const p = await d.project('Scheduled');
  await d.srv!.stop({ keepTurns: true });
  d.srv = null;
  const store = new Store(join(d.data, 'coordinator.db'));
  // Due since two minutes ago: the next runDue (every 30 s) starts it.
  store.schedules.create({ project_id: p.id, name: 'Drill schedule', cron: '* * * * *', brief: 'Check the drill.', type: 'chore', created_by: 'Cara' }, Date.now() - 120_000);
  store.db.close();
  await d.boot({ CITADEL_FAULT_POINT: 'schedule-started' });
  await d.died('schedule-started');
  const started = () => d.rows("SELECT id FROM tickets WHERE title = 'Drill schedule'").length;
  const next = () => d.rows<{ at: number }>("SELECT next_run_at AS at FROM schedules WHERE name = 'Drill schedule'")[0].at;
  assert.equal(started(), 1, 'the first server started the minion before its kill');
  const slot = next();
  await d.boot();
  // The slot counts as handled once its next run moves on, whoever moves it (the next runDue, or a fix at boot).
  await until('the slot handled', () => next() > slot, 45_000);
  assert.equal(started(), 1, `C3: the slot started ${started()} minions`);
});

// C2: settling a hand-off isn't safe to repeat: a kill after the shipped line and before the rename says it again.
test("a kill between a ship's shipped line and its rename reports the ship once", gap('C2'), async () => {
  if (d.srv) {
    await d.srv.stop({ keepTurns: true });
    d.srv = null;
  }
  await d.boot({ CITADEL_FAULT_POINT: 'ship-noted' });
  const p = await d.project('Shipping');
  const ship = await d.handOff(p.id);
  writeFileSync(ship.go, '');
  await d.died('ship-noted');
  assert.equal(d.shipped(ship.id).length, 1, 'the first server said it shipped before its kill');
  assert.ok(existsSync(join(d.landing(ship.id), 'handoff.json')), 'and was killed before the rename');
  await d.boot();
  await until('the hand-off settled', () => existsSync(join(d.landing(ship.id), 'handoff.done.json')), 30_000);
  assert.equal(d.shipped(ship.id).length, 1, `C2: the ship was reported ${d.shipped(ship.id).length} times`);
});
