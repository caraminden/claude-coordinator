// Drill 1 (#1326): the server SIGKILLed 5 times in a minute with turns and a ship running, as on Nov 20 (eleven kills in
// 3 minutes). What was running carries on; the last server takes each turn's reply once and the ship's result once.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { until } from '../helpers.ts';
import { Drill, gap, timedOut } from './harness.ts';

const d = new Drill('kill-storm');
const minions: number[] = [];
let ship: { id: number; go: string };
let stormStart = 0;
let stormEnd = 0;
after(() => d.cleanup());

before(async () => {
  await d.boot();
  const p = await d.project();
  for (let i = 0; i < 3; i++) minions.push(await d.minion(p.id, `turn ${i}`));
  ship = await d.handOff(p.id);
  await until('every turn and the ship started', () => minions.every((id) => d.turnDir(id)) && existsSync(join(d.landing(ship.id), 'output.log')), 30_000);
  for (let kill = 0; kill < 5; kill++) {
    await d.crash();
    // The window is first kill to fifth: a slow last recovery isn't part of it.
    if (kill === 0) stormStart = Date.now();
    else stormEnd = Date.now();
    await d.boot();
    // Each server has taken the running turns back before the next kill.
    await until('the turns taken back', () => minions.every((id) => d.logged(new RegExp(`^Ticket ${id}: re-attached`)) > kill));
  }
  d.fake.setRelease('ok');
  writeFileSync(ship.go, '');
  await until('every turn ended and the ship settled', () => minions.every((id) => d.status(id) === 'idle') && existsSync(join(d.landing(ship.id), 'handoff.done.json')), 60_000);
});

test('5 kills in under a minute: each turn finishes once, none is resumed or written off', () => {
  assert.ok(stormEnd - stormStart < 60_000, `the storm took ${stormEnd - stormStart} ms`);
  for (const id of minions) {
    assert.equal(d.stream(id, 'result').length, 1, `#${id} took its reply once`);
    assert.deepEqual(d.notes(id).filter((n) => /Resumed|interrupted|killed/.test(n)), [], `#${id}'s chat`);
  }
  assert.equal(d.fake.turnsRun(), 3, 'three turns ran, no resumes beside them');
});

test("5 kills in under a minute: the ship's result is reported once", () => {
  assert.equal(d.shipped(ship.id).length, 1, d.notes(ship.id).join('\n'));
});

// A5: an incident opens only for 5 minutes down, so a storm of short kills opens none.
test('5 kills in under a minute open an incident', gap('A5'), async () => {
  // The recorder's first tick (a minute after boot) writes its state; a fix may open the incident sooner.
  const s = await until('the incident recorder ticked', () => d.setting('incidents'), 90_000).catch((e) => {
    if (timedOut(e)) assert.fail(`A5: no incident state was written in 90 s after 5 kills`);
    throw e;
  });
  assert.ok(s.open || s.done?.length, `A5: 5 kills in ${Math.round((stormEnd - stormStart) / 1000)} s opened no incident`);
});
