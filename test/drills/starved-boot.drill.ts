// Drill 3 (#1326): a boot with the CPU held to a fifth of a core and 18 turns running, as when the box is thrashing.
// Every turn is taken back and finishes once. The time to the first answer is printed, not asserted: it is the
// number the reliability lens wants watched, and a timing assert would fail for the runner's load, not the code.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { until } from '../helpers.ts';
import { canThrottle, Drill } from './harness.ts';

const TURNS = 18;
const d = new Drill('starved-boot');
const minions: number[] = [];
let firstAnswerMs = 0;
after(() => d.cleanup());

before(async () => {
  // Not a skip: the runners and perigee have a user systemd with the cpu controller, so its absence is a broken runner.
  assert.ok(canThrottle(), 'systemd-run --user --scope -p CPUQuota= fails here: no user systemd with the cpu controller');
  await d.boot();
  const p = await d.project();
  for (let i = 0; i < TURNS; i++) minions.push(await d.minion(p.id, `turn ${i}`));
  await until('all 18 turns started', () => minions.every((id) => d.turnDir(id)), 120_000);
  await d.crash();
  const t0 = Date.now();
  // systemd-run --scope execs the server in place, in a scope of its own limited to 20% of one core.
  await d.boot({}, ['systemd-run', '--user', '--scope', '--quiet', '-p', 'CPUQuota=20%', '--']);
  firstAnswerMs = Date.now() - t0;
  console.log(`# starved boot: first answer ${firstAnswerMs} ms after the start, with ${TURNS} turns to take back at 20% of a core`);
});

test(`a boot at a fifth of a core takes all ${TURNS} running turns back, and each finishes once`, async () => {
  await until('every turn taken back', () => minions.every((id) => d.logged(new RegExp(`^Ticket ${id}: re-attached`)) > 0), 120_000);
  d.fake.setRelease('ok');
  await until('every turn ended', () => minions.every((id) => d.status(id) === 'idle'), 180_000);
  for (const id of minions) {
    assert.equal(d.stream(id, 'result').length, 1, `#${id} took its reply once`);
    assert.deepEqual(
      d.notes(id).filter((n) => /Resumed|interrupted|killed/.test(n)),
      [],
      `#${id}'s chat`,
    );
  }
  assert.equal(d.fake.turnsRun(), TURNS);
  assert.ok(firstAnswerMs > 0);
});
