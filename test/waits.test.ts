import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import type { Ship } from '../src/branch.ts';
import { flockedInodes, landPhase, median, moveIn, procAlive, ridingOf, slotHeld, trainLabel, Waits } from '../src/waits.ts';
import { tempRoot } from './helpers.ts';

// src/waits.ts (#544): what a minion waits on, read from the land line's and citadel-heavy's files.
const tmp = tempRoot('waits-');
const root = tmp.dir;
after(() => tmp.teardown());
const store = new Store(join(root, 'test.db'));
const citadel = store.createProject('Citadel', null);

function minion(status: 'running' | 'idle' = 'running') {
  const t = store.createTicket({ project_id: citadel.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, `ticket/${t.number}-x`);
  store.updateTicket(t.id, { status });
  return { id: t.id, number: t.number!, branch: `ticket/${t.number}-x` };
}

let now = 1_800_000_000_000;
const ships = new Map<number, Ship['stage']>();
let dirs = 0;
function setup() {
  const state = join(root, `state-${++dirs}`), heavy = join(root, `heavy-${dirs}`);
  mkdirSync(join(state, 'queue'), { recursive: true });
  mkdirSync(heavy, { recursive: true });
  const changed: number[] = [];
  const dead = new Set<string>(), free = new Set<string>();
  const waits = new Waits({
    store, deployState: state, heavyDir: heavy, interruptible: () => 2, changed: (id) => changed.push(id), now: () => now,
    ship: (id) => (ships.has(id) ? { stage: ships.get(id)!, text: '', commit: 'abc1234' } : null),
    alive: (proc) => !dead.has(proc), held: (f) => !free.has(f),
  });
  /** A land-line ticket as tools/deploy-queue.sh writes it, last written `ago` s before now; `orders` false: from a branch before #1002. */
  const ticket = (seq: number, label: string, got: number, phase: string, ago: number, orders = true) => {
    const f = join(state, 'queue', String(seq).padStart(10, '0'));
    writeFileSync(f, `${seq}00 77\n${got}\n${label}\n${phase}\n${orders ? 'order\n' : ''}`);
    utimesSync(f, (now - ago * 1000) / 1000, (now - ago * 1000) / 1000);
    return `${seq}00 77`;
  };
  /** A citadel-heavy waiter's file, last freshened `ago` s before now. */
  const waiter = (name: string, who: string, since: number, reason: string, ago = 0) => {
    const f = join(heavy, name);
    writeFileSync(f, `${who}\ncargo test\n${since}\n${reason}\n`);
    utimesSync(f, (now - ago * 1000) / 1000, (now - ago * 1000) / 1000);
  };
  return { state, heavy, waits, changed, dead, free, ticket, waiter };
}

test('the land line: the holder by its phase, each waiter by its place and who is ahead, with an estimate', () => {
  const { state, waits, changed, dead, ticket } = setup();
  const a = minion(), b = minion(), c = minion(), d = minion();
  writeFileSync(join(state, 'queue', '.took'), '100\n200\n150\n');
  ticket(1, a.branch, now / 1000 - 40, 'running the tests since 14:02', 30);
  ticket(2, b.branch, 0, 'waiting', 60);
  ticket(3, c.branch, 0, 'waiting', 10);
  dead.add(ticket(4, d.branch, 0, 'waiting', 5)); // its process is gone
  waits.poll();

  assert.deepEqual(waits.wait(a.id), { kind: 'land', stage: 'test', chip: 'ship · tests', text: 'CI fell back: running the full suite on perigee', brief: 'full suite on perigee', since: now - 30_000, usual: null });
  const wb = waits.wait(b.id)!;
  assert.equal(wb.chip, 'line · next train');
  assert.equal(wb.text, `Releasing next: 2nd in line, behind #${a.number} (testing)`);
  // B joined before A took the lock, so a whole landing (the median of 100, 200, 150) is ahead of it.
  assert.equal(wb.usual, 150);
  assert.equal(waits.wait(c.id)!.text, `Releasing next: 3rd in line, behind #${a.number} (testing) and 1 more`);
  // C joined 30 s into A's hold: 120 s of it were left, then B's whole landing.
  assert.equal(waits.wait(c.id)!.usual, 120 + 150);
  assert.equal(waits.wait(d.id), null);
  assert.deepEqual(changed.sort(), [a.id, b.id, c.id].sort(), "a minion whose process is gone has no wait to send");

  changed.length = 0;
  waits.poll();
  assert.deepEqual(changed, [], 'nothing changed, nothing re-sent');
  // A holder running long doesn't stretch the estimate, so the waiter's bar turns amber.
  now += 600_000;
  waits.poll();
  assert.equal(waits.wait(b.id)!.usual, 150);
  now -= 600_000;
});

test('a stage that moves on counts toward its usual; a landing that leaves the line early does not', () => {
  const { state, waits, ticket } = setup();
  const a = minion(), b = minion();
  ticket(1, a.branch, now / 1000, 'rebasing onto main', 0);
  ticket(2, b.branch, now / 1000, 'waiting for CI since 14:00', 0);
  waits.poll();
  now += 12_000;
  ticket(1, a.branch, now / 1000 - 12, 'deploying: boot check since 14:01', 0);
  rmSync(join(state, 'queue', '0000000002')); // B's CI went red
  waits.poll();
  assert.equal(waits.usual('land:rebase'), 12);
  assert.equal(waits.usual('land:ci'), null);
  assert.deepEqual({ ...waits.wait(a.id)!, since: 0 }, { kind: 'land', stage: 'deploy', chip: 'ship · deploy', text: 'boot check', since: 0, usual: null });
  now += 30_000;
  rmSync(join(state, 'queue', '0000000001'));
  waits.poll();
  assert.equal(waits.usual('land:deploy'), 30, 'a deploy that ends is a landing done');
  assert.equal(waits.wait(a.id), null);
});

test('heavy slots: the holder runs, the waiters line up behind it, and only a running minion shows one', () => {
  const { heavy, waits, free, waiter } = setup();
  const a = minion(), b = minion(), idle = minion('idle'), killed = minion(), gone = minion();
  writeFileSync(join(heavy, 'slot-0.who'), `Citadel #${a.number} (cara): npm test (since 14:00, pid 4242)\n`);
  waiter('wait-99-1', `Citadel #${b.number} (cara)`, now / 1000 - 20, 'slots');
  waiter('wait-98-1', `Citadel #${idle.number} (cara)`, now / 1000 - 90, 'line');
  // Killed past their traps: a waiter's file no longer freshened, and a .who whose slot nobody holds.
  waiter('wait-97-1', `Citadel #${killed.number} (cara)`, now / 1000 - 300, 'line', 61);
  writeFileSync(join(heavy, 'slot-1.who'), `Citadel #${gone.number} (cara): npm test (since 13:00, pid 1)\n`);
  free.add(join(heavy, 'slot-1'));
  waits.poll();
  assert.equal(waits.wait(killed.id), null);
  assert.equal(waits.wait(gone.id), null);
  assert.equal(waits.wait(a.id)!.text, 'running in heavy slot 1: npm test');
  // The idle minion's file is older, so B is second; its own wait still isn't shown.
  assert.deepEqual(waits.wait(b.id), { kind: 'heavy', stage: 'slot', chip: 'slot · 2nd', text: `2nd in line for a heavy slot, all held (#${a.number})`, since: now - 20_000, usual: null });
  assert.equal(waits.wait(idle.id), null);
  waiter('wait-99-1', `Citadel #${b.number} (cara)`, now / 1000 - 20, 'load');
  waits.poll();
  assert.equal(waits.wait(b.id)!.chip, 'slot · busy box');
  // A's run cut off by its minion stopping says nothing of how long npm test takes; B's wait that ended does.
  store.updateTicket(a.id, { status: 'idle' });
  rmSync(join(heavy, 'slot-0.who'));
  rmSync(join(heavy, 'wait-99-1'));
  now += 5000;
  waits.poll();
  assert.equal(waits.usual('heavy:run:npm test'), null);
  assert.equal(waits.usual('heavy:slot'), 25);
  now -= 5000;
});

test('the restart: while the ship line says deploying, with the turns it waits for; its length counts once live', () => {
  const { waits } = setup();
  const a = minion('idle');
  ships.set(a.id, 'deploying');
  const w = waits.wait(a.id)!;
  assert.deepEqual(w, { kind: 'restart', stage: 'restart', chip: 'restart · 2 turns', text: 'the restart waits for 2 running turns to end', since: now, usual: null });
  now += 45_000;
  assert.equal(waits.wait(a.id)!.since, w.since, 'it keeps its start');
  // The restart it waits for restarts the server: the next one still knows when it began.
  const { waits: after } = setup();
  ships.set(a.id, 'live');
  assert.equal(after.wait(a.id), null);
  assert.equal(after.usual('restart'), 45);
});

test('median, and a live process told apart from a reused pid', () => {
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 3);
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const start = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
  assert.ok(procAlive(`${process.pid} ${start}`));
  assert.ok(!procAlive(`${process.pid} 1`));
  assert.ok(!procAlive(''));
});

test('the lock list counts holders, not waiters or other lock kinds, and none to read trusts every slot (#1562)', () => {
  const list = [
    '1: FLOCK  ADVISORY  WRITE 767318 00:23:231177942 0 EOF',
    '1: -> FLOCK  ADVISORY  WRITE 767400 00:23:555 0 EOF',
    '2: POSIX  ADVISORY  WRITE 1234 00:23:777 0 EOF',
    '3: OFDLCK ADVISORY  READ  -1 00:05:888 0 EOF',
    '4: FLOCK  ADVISORY  READ  99 fd:01:42 0 EOF',
  ].join('\n');
  assert.deepEqual([...flockedInodes(list)!].sort(), [231177942, 42].sort());
  assert.equal(flockedInodes(null), null);
  assert.equal(slotHeld(join(root, 'no-such-slot'), null), true);
  assert.equal(slotHeld(join(root, 'no-such-slot'), new Set([1])), false);
});

test('a heavy slot reads as held only while someone holds its lock', async () => {
  const slot = join(root, 'slot-0');
  writeFileSync(slot, '');
  assert.equal(slotHeld(slot), false);
  const holder = tmp.spawn('flock', [slot, 'sh', '-c', 'echo held; sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  try {
    await new Promise((r) => holder.stdout!.once('data', r));
    assert.equal(slotHeld(slot), true);
  } finally {
    process.kill(-holder.pid!, 'SIGKILL'); // its sleep too
    await new Promise((r) => holder.once('exit', r));
  }
});

test("a test run's counts (#545): the landing's run and a heavy Node suite show files done of total; other runs show none", () => {
  const { state, heavy, waits, ticket } = setup();
  const a = minion(), b = minion(), c = minion(), d = minion();
  const progress = (f: string, text: string, ago?: number) => {
    writeFileSync(f, text);
    if (ago != null) utimesSync(f, (now - ago * 1000) / 1000, (now - ago * 1000) / 1000);
  };
  ticket(1, a.branch, now / 1000 - 40, 'running the tests since 14:02', 30);
  progress(join(state, 'land-test.progress'), '5\n200\ntest/old.test.ts\n', 31);
  waits.poll();
  assert.equal(waits.wait(a.id)!.chip, 'ship · tests', "counts from before this phase are an earlier run's");
  progress(join(state, 'land-test.progress'), '96\n212\ntest/runner.test.ts\n', 1);
  waits.poll();
  assert.deepEqual(waits.wait(a.id), {
    kind: 'land', stage: 'test', chip: 'ship · 96/212', text: 'CI fell back: running the full suite on perigee: 96 of 212 files · test/runner.test.ts', brief: 'full suite on perigee',
    since: now - 30_000, usual: null, done: 96, total: 212,
  });
  // deploy.sh's own run logs to test.log, so its counts are in test.progress.
  ticket(1, a.branch, now / 1000 - 40, 'deploying: running the tests since 14:05', 10);
  progress(join(state, 'test.progress'), '212\n212\n\n', 1);
  waits.poll();
  assert.equal(waits.wait(a.id)!.chip, 'ship · 212/212');
  assert.equal(waits.wait(a.id)!.text, 'running the tests: 212 of 212 files');

  writeFileSync(join(heavy, 'slot-0.who'), `Citadel #${b.number} (cara): npm test (since 14:00, pid 4242)\n`);
  progress(join(heavy, 'slot-0.progress'), '3\n212\ntest/db.test.ts\n');
  writeFileSync(join(heavy, 'slot-1.who'), `Citadel #${c.number} (cara): cargo test (since 14:00, pid 4243)\n`);
  progress(join(heavy, 'slot-1.progress'), '9\n3\n'); // more done than there are: not counts
  writeFileSync(join(heavy, 'slot-2.who'), `Citadel #${d.number} (cara): npm test (since 14:00, pid 4244)\n`);
  waits.poll();
  const wb = waits.wait(b.id)!;
  assert.equal(wb.chip, 'tests 3/212');
  assert.equal(wb.text, 'running in heavy slot 1: npm test: 3 of 212 files · test/db.test.ts');
  assert.deepEqual([wb.done, wb.total], [3, 212]);
  assert.deepEqual(waits.wait(c.id), { ...waits.wait(c.id)!, chip: 'heavy run', text: 'running in heavy slot 2: cargo test' });
  assert.equal(waits.wait(c.id)!.done, undefined);
  assert.equal(waits.wait(d.id)!.chip, 'heavy run');
});

test('every poll hands the land line to the land alarm (#561): each landing by its minion, phase and gate run', () => {
  const { state, heavy, ticket } = setup();
  const seen: unknown[] = [];
  const views = new Map<number, string>();
  const a = minion(), b = minion();
  const ci = { view: (id: number) => (views.has(id) ? { stage: views.get(id), short: 'step 3/8', text: 'test-linux step 3 of 8', since: now, what: '', usual: null } : null), runOf: (id: number) => (views.has(id) ? 4308 : null), landings: () => {} } as any;
  const waits = new Waits({
    store, deployState: state, heavyDir: heavy, interruptible: () => 0, changed: () => {}, now: () => now, ship: () => null,
    alive: () => true, held: () => true, ci, landLine: (line, at) => seen.push([line, at]),
  });
  views.set(a.id, 'jobs');
  ticket(1, a.branch, now / 1000 - 60, 'waiting for CI since 14:00', 30);
  ticket(2, b.branch, 0, 'waiting', 10);
  ticket(3, 'tools/deploy.sh', 0, 'waiting', 5);
  waits.poll();
  assert.deepEqual(seen, [[[
    { seq: 1, name: `#${a.number}`, phase: 'ci', ci: 'jobs', run: 4308 },
    { seq: 2, name: `#${b.number}`, phase: 'line', ci: null, run: null },
    { seq: 3, name: 'tools/deploy.sh', phase: 'line', ci: null, run: null },
  ], now]]);
});

test('the land line in the order set on the Releases page (#1002): the holder first, then .order, then the rest by arrival', () => {
  const { state, waits, ticket, dead } = setup();
  const a = minion(), b = minion(), c = minion(), d = minion(), e = minion();
  ticket(1, a.branch, now / 1000 - 40, 'waiting for CI since 14:02', 30);
  ticket(2, b.branch, 0, 'waiting', 60);
  ticket(3, c.branch, 0, 'waiting', 50);
  ticket(4, d.branch, 0, 'waiting', 40);
  waits.poll();
  // Land next on d: the order names every waiter, d first; the holder isn't one of them.
  assert.deepEqual(waits.setOrder([4, 1, 2, 4, 99], 'Cara moved #4 to land next'), [4, 2, 3]);
  assert.equal(readFileSync(join(state, 'queue', '.order'), 'utf8'), '# Cara moved #4 to land next\n0000000004\n0000000002\n0000000003\n');
  ticket(5, e.branch, 0, 'waiting', 1); // joined after: the back
  waits.poll();
  assert.deepEqual(waits.line.map((t) => t.seq), [1, 4, 2, 3, 5]);
  assert.equal(waits.wait(d.id)!.text, `Releasing next: 2nd in line, behind #${a.number} (waiting for CI)`);
  assert.equal(waits.wait(b.id)!.chip, 'line · next train');
  // Only part of the line named (a stale page): those first, the rest keep their order behind.
  assert.deepEqual(waits.setOrder([3], 'Josh moved #3 to land next'), [3, 4, 2, 5]);
  // A landing from a branch before #1002 runs the old queue_lock (it waits for every lower ticket): never put in the
  // order, so it can't be ranked ahead of one that waits for it. It lands after the ordered ones.
  const f = minion();
  ticket(6, f.branch, 0, 'waiting', 1, false);
  waits.poll();
  assert.equal(waits.line.find((t) => t.seq === 6)!.orders, false);
  assert.deepEqual(waits.setOrder([6, 5], 'Josh moved #6 to land next'), [5, 3, 4, 2]);
  assert.deepEqual(waits.line.map((t) => t.seq), [1, 5, 3, 4, 2, 6]);
  for (const seq of [2, 3, 4, 5]) dead.add(`${seq}00 77`);
  assert.throws(() => waits.setOrder([3], 'Josh'), /nothing is waiting in line/i, 'all shipped or gone meanwhile');
});

// The Trans Agenda #76: one from before #1002 that arrived first waits only for the lower tickets, so nobody behind it
// goes ahead of it, whatever .order says: the line shows it where it lands.
test('the land line keeps a landing from before .order ahead of the ones behind it that .order names', () => {
  const { state, waits, ticket } = setup();
  const [a, b, c, d] = [minion(), minion(), minion(), minion()];
  ticket(1, a.branch, now / 1000 - 40, 'checking', 30);
  ticket(2, b.branch, 0, 'waiting', 60);
  ticket(3, c.branch, 0, 'waiting', 50, false);
  ticket(4, d.branch, 0, 'waiting', 40);
  writeFileSync(join(state, 'queue', '.order'), '# Cara moved #4 to land next\n0000000004\n0000000002\n');
  waits.poll();
  assert.deepEqual(waits.line.map((t) => t.seq), [1, 2, 3, 4]);
  // A move leaves #4 unranked: a deploy-queue.sh from before #1020 would put a ranked #4 ahead of #3.
  assert.deepEqual(waits.setOrder([4, 2], 'Cara moved #4 to land next', 4), [2]);
  assert.equal(readFileSync(join(state, 'queue', '.order'), 'utf8'), '# Cara moved #4 to land next\n0000000002\n');
});

test('a move on a target that shows part of the line moves only that landing (#1007)', () => {
  // The line waits 5, 6, 7, 8; a target shows 6, 7 and 8 (5 ships elsewhere).
  assert.deepEqual(moveIn([5, 6, 7, 8], [8, 6, 7], 8), [8, 5, 6, 7], 'Land next: the front of the whole line');
  assert.deepEqual(moveIn([5, 6, 7, 8], [6, 8, 7], 8), [5, 6, 8, 7], 'dragged up one: just ahead of the one it now goes before');
  assert.deepEqual(moveIn([5, 6, 7, 8], [7, 8, 6], 6), [5, 7, 8, 6], 'dragged to the back: just behind the one it goes after');
  assert.deepEqual(moveIn([5, 6, 7, 8], [6, 7, 8], 7), [5, 6, 7, 8], 'dropped where it was');
  assert.deepEqual(moveIn([5, 6], [9, 6], 6), [5, 6], 'the rest of what it names is gone: it keeps its place');
});

test("a ship waiting for CI or a quiet perigee shows that wait, how long so far included, not a plain CI wait (#1254)", () => {
  assert.deepEqual(landPhase('waiting for CI or a quiet perigee, 5 min so far'), { stage: 'test', word: 'CI', key: 'ci', text: 'waiting for CI or a quiet perigee, 5 min so far' });
  assert.equal(landPhase('waiting for CI since 14:02').text, 'waiting for CI on the rebased commit');
});

test('a ship train (#1303): the front reads "Train of N", a rider reads riding in its front, a sent-back rider and a plain waiter read as waiting, by which train they will be in', () => {
  const { waits, ticket } = setup();
  const f = minion(), r1 = minion(), r2 = minion(), w = minion(), back = minion();
  ticket(1, f.branch, now / 1000 - 40, 'waiting for CI since 14:02', 30);
  ticket(2, r1.branch, 0, `riding in ${f.branch}'s ship train`, 20);
  ticket(3, r2.branch, 0, `riding in ${f.branch}'s ship train`, 19);
  ticket(4, back.branch, 0, 'waiting', 18); // the train went without it
  ticket(5, w.branch, 0, `riding in ticket/9-gone's ship train`, 17); // its front is gone: waiting in line again
  waits.poll();
  const front = waits.wait(f.id)!;
  assert.equal(front.train?.role, 'front');
  assert.equal(front.train?.size, 3);
  assert.match(front.brief!, /^train of 3 · CI: starting$/);
  const rider = waits.wait(r1.id)!;
  assert.equal(rider.train?.role, 'rider');
  assert.equal(rider.stage, 'test', "a rider is in the front's CI, not in line");
  assert.equal(rider.brief, `riding in #${f.number}'s train`);
  assert.doesNotMatch(rider.text, /in line/);
  assert.equal(waits.wait(back.id)!.train?.label, 'Releasing next');
  assert.equal(waits.wait(back.id)!.chip, 'line · next train');
  assert.equal(waits.wait(w.id)!.train?.role, 'waiting');
});

test('a red train under bisect reads as the front bisecting; later trains say how many are ahead', () => {
  assert.equal(landPhase('finding the ship that turned the train red').key, 'bisect');
  assert.equal(trainLabel(0), 'Releasing next');
  assert.equal(trainLabel(1), 'Train 3, after 2 ahead');
  assert.equal(ridingOf("riding in ticket/1-x's ship train since 14:05"), 'ticket/1-x');
  assert.equal(ridingOf('waiting'), null);
});
