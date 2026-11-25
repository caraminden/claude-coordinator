import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.ts';
import type { ShipStep } from '../src/db/wait-records.ts';
import { NO_CODE, type Landing } from '../src/land.ts';
import { ShipTrail, type ShipLine } from '../src/ship-trail.ts';
import type { LandTicket } from '../src/waits.ts';

// Where a minion's ship stood, kept as it moves (#1992): its place, its stages and how it ended, in Citadel's line and a
// scheme's on the kit's land.sh.

const t = (label: string, phase = '', got = 0, seq = 1): LandTicket => ({ seq, proc: '1', got, label, phase, mtime: 0 });

function world(kit = false) {
  const store = new Store(':memory:');
  const p = store.createProject('One', null);
  const ids = ['a', 'b', 'c'].map((x) => store.createTicket({ project_id: p.id, title: x, permission_mode: 'default', created_by: 'Cara' }).id);
  const label = (id: number) => `ticket/${ids.indexOf(id) + 1}-x`;
  const w = {
    store,
    ids,
    label,
    line: [] as LandTicket[],
    handed: new Set<number>(),
    runs: new Map<number, Landing>(),
    stops: new Map<number, { by: string }>(),
    now: 1000,
    trail: null as unknown as ShipTrail,
    start: () => {
      w.trail = new ShipTrail({
        store,
        now: () => w.now,
        landings: { pending: async () => [...w.handed], look: async (id) => w.runs.get(id) ?? null, stopped: (id) => w.stops.get(id) ?? null },
        lines: async (): Promise<ShipLine[]> => [{ line: w.line, kit, minion: (l) => ids.find((id) => label(id) === l) ?? null, name: (l) => `#${l.split('/')[1]?.split('-')[0]}` }],
      });
    },
    poll: async (line: LandTicket[] = []) => {
      w.line = line;
      w.now += 5000;
      await w.trail.poll();
    },
    hand: (id: number, output = '', code: number | null = null) => {
      w.handed.add(id);
      w.runs.set(id, { output, code });
    },
    steps: (id: number): ShipStep[] => store.waitRecords(id).ships,
    read: (id: number) => w.steps(id).map((s) => [s.stage, s.label, s.place ?? null, s.behind ?? null, s.outcome ?? null].filter((x) => x !== null).join(' ')),
  };
  w.start();
  return w;
}

test("a ship's check, places, stages and end are kept once each with their times, and the same phase's clock adds nothing", async () => {
  const w = world();
  const [a, b] = w.ids;
  w.hand(a, 'land: own check: waiting for it');
  await w.poll();
  await w.poll([t(w.label(b), 'waiting for CI since 10:00', 5), t(w.label(a))]);
  await w.poll([t(w.label(b), 'waiting for CI since 10:00', 5), t(w.label(a))]);
  await w.poll([t(w.label(a), 'rebasing since 10:05', 6)]);
  await w.poll([t(w.label(a), 'waiting for CI since 10:06', 6)]);
  await w.poll([t(w.label(a), 'waiting for CI since 10:07', 6)]);
  await w.poll([t(w.label(a), 'deploying since 10:09', 6)]);
  w.hand(a, 'land: main is now at abcdef1 "x"\ndeploy: live now: abcdef1', 0);
  await w.poll();
  await w.poll(); // still listed until its report
  assert.deepEqual(w.read(a), ['check Own check', 'line In line 2 #2', 'rebase Rebase', 'test CI', 'deploy Deploy', 'ended Ended shipped']);
  assert.deepEqual(
    w.steps(a).map((s) => s.at),
    [6000, 11000, 21000, 26000, 36000, 41000],
  );
  assert.ok(w.steps(a).every((s) => s.ship === 6000));
  // Reported, then handed off again: a ship of its own.
  w.handed.delete(a);
  w.runs.clear();
  await w.poll();
  w.hand(a, 'queue: 2nd in line for the land lock');
  await w.poll();
  const last = w.steps(a).at(-1)!;
  assert.deepEqual([last.stage, last.ship, last.at], ['line', 56000, 56000]);
});

test('places move as the line does: riders, held and pulled waiters hold nobody up', async () => {
  const w = world();
  const [a, b, c] = w.ids;
  const front = t(w.label(b), 'waiting for CI', 5);
  await w.poll([front, t(w.label(c)), t(w.label(a))]);
  await w.poll([front, t(w.label(c), `riding in ${w.label(b)}'s train`), t(w.label(a))]);
  await w.poll([front, t(w.label(c), 'held: main is broken since 10:00'), t(w.label(a))]);
  assert.deepEqual(w.read(a), ['line In line 3 #2', 'line In line 2 #2']);
});

test('a refused, stopped, cut-off and CI-less ship each say so, one ended before the first look too', async () => {
  const w = world();
  const [a, b, c] = w.ids;
  w.hand(a, 'land: rebase onto main conflicts in src/x.ts', 1);
  w.hand(b, 'queue: next in line for the land lock', 1);
  w.stops.set(b, { by: 'Josh' });
  w.hand(c, `land: rebasing${NO_CODE}`, 1);
  await w.poll();
  assert.equal(w.steps(a).at(-1)!.outcome, 'refused');
  assert.deepEqual([w.steps(b).at(-1)!.outcome, w.steps(b).at(-1)!.why], ['stopped', 'Josh']);
  assert.equal(w.steps(c).at(-1)!.outcome, 'cut off');
  assert.deepEqual(w.read(b), ['line In line', 'ended Ended stopped']);
  w.hand(a, 'land: waiting for CI', null);
  await w.poll();
  w.hand(a, 'land: waiting for CI', 75);
  await w.poll();
  assert.equal(w.steps(a).at(-1)!.outcome, 'no-ci');
});

test("a scheme's ship: its turn's own land.sh is seen in the line, each stage it works at while it waits, and leaves it", async () => {
  const w = world(true);
  const [a, b] = w.ids;
  const ahead = t(w.label(b), 'waiting', 3);
  await w.poll([ahead, t(w.label(a), 'waiting')]);
  await w.poll([ahead, t(w.label(a), 'building the app')]);
  await w.poll([ahead, t(w.label(a), 'waiting for CI')]);
  await w.poll([t(w.label(a), 'deploying', 7)]);
  await w.poll(); // one look without it can be a ticket being rewritten
  assert.equal(w.steps(a).at(-1)!.stage, 'deploy');
  await w.poll();
  assert.deepEqual(w.read(a), ['line In line 2 #2', 'rebase building the app 2 #2', 'test CI 2 #2', 'deploy Deploy', 'ended Ended left']);
});

test('a restart mid-ship carries on with the same ship, and records nothing twice', async () => {
  const w = world();
  const [a, b] = w.ids;
  const line = [t(w.label(b), 'deploying', 5), t(w.label(a))];
  w.hand(a);
  await w.poll(line);
  w.start();
  await w.poll(line);
  assert.equal(w.steps(a).length, 1);
  w.start();
  w.hand(a, 'land: failed', 1);
  await w.poll(line); // its exit code is newer than the line
  w.start();
  await w.poll();
  assert.deepEqual(w.read(a), ['line In line 2 #2', 'ended Ended refused']);
  assert.equal(new Set(w.steps(a).map((s) => s.ship)).size, 1);
});

test('a poll while one runs shares it', async () => {
  const w = world();
  w.hand(w.ids[0]);
  await Promise.all([w.trail.poll(), w.trail.poll()]);
  assert.equal(w.steps(w.ids[0]).length, 1);
});
