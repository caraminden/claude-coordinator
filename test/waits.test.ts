import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import type { Ship } from '../src/branch.ts';
import { median, procAlive, Waits } from '../src/waits.ts';

// src/waits.ts (#544): what a minion waits on, read from the land line's and citadel-heavy's files.
const root = mkdtempSync(join(tmpdir(), 'waits-'));
after(() => rmSync(root, { recursive: true, force: true }));
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
  const dead = new Set<string>();
  const waits = new Waits({
    store, deployState: state, heavyDir: heavy, interruptible: () => 2, changed: (id) => changed.push(id), now: () => now,
    ship: (id) => (ships.has(id) ? { stage: ships.get(id)!, text: '', commit: 'abc1234' } : null),
    alive: (proc) => !dead.has(proc),
  });
  /** A land-line ticket as tools/deploy-queue.sh writes it, last written `ago` s before now. */
  const ticket = (seq: number, label: string, got: number, phase: string, ago: number) => {
    const f = join(state, 'queue', String(seq).padStart(10, '0'));
    writeFileSync(f, `${seq}00 77\n${got}\n${label}\n${phase}\n`);
    utimesSync(f, (now - ago * 1000) / 1000, (now - ago * 1000) / 1000);
    return `${seq}00 77`;
  };
  return { state, heavy, waits, changed, dead, ticket };
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

  assert.deepEqual(waits.wait(a.id), { kind: 'land', stage: 'test', chip: 'land · tests', text: 'running the tests on the rebased code', since: now - 30_000, usual: null });
  const wb = waits.wait(b.id)!;
  assert.equal(wb.chip, 'line · 2nd');
  assert.equal(wb.text, `2nd in line, behind #${a.number} (testing)`);
  // 60 s in line so far, plus what's left of A's landing: the median of 100, 200, 150 less the 40 s it has held the lock.
  assert.equal(wb.usual, 60 + 110);
  assert.equal(waits.wait(c.id)!.text, `3rd in line, behind #${a.number} (testing) and 1 more`);
  assert.equal(waits.wait(c.id)!.usual, 10 + 110 + 150);
  assert.equal(waits.wait(d.id), null);
  assert.deepEqual(changed.sort(), [a.id, b.id, c.id].sort(), "a minion whose process is gone has no wait to send");

  changed.length = 0;
  waits.poll();
  assert.deepEqual(changed, [], 'nothing changed, nothing re-sent');
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
  assert.deepEqual({ ...waits.wait(a.id)!, since: 0 }, { kind: 'land', stage: 'deploy', chip: 'land · deploy', text: 'boot check', since: 0, usual: null });
  now += 30_000;
  rmSync(join(state, 'queue', '0000000001'));
  waits.poll();
  assert.equal(waits.usual('land:deploy'), 30, 'a deploy that ends is a landing done');
  assert.equal(waits.wait(a.id), null);
});

test('heavy slots: the holder runs, the waiters line up behind it, and only a running minion shows one', () => {
  const { heavy, waits } = setup();
  const a = minion(), b = minion(), idle = minion('idle');
  writeFileSync(join(heavy, 'slot-0.who'), `Citadel #${a.number} (cara): npm test (since 14:00, pid 4242)\n`);
  writeFileSync(join(heavy, 'wait-99'), `Citadel #${b.number} (cara)\ncargo test\n${now / 1000 - 20}\nslots\n`);
  writeFileSync(join(heavy, 'wait-98'), `Citadel #${idle.number} (cara)\ncargo test\n${now / 1000 - 90}\nline\n`);
  waits.poll();
  assert.equal(waits.wait(a.id)!.text, 'running in heavy slot 1: npm test');
  // The idle minion's file is older, so B is second; its own wait still isn't shown.
  assert.deepEqual(waits.wait(b.id), { kind: 'heavy', stage: 'slot', chip: 'slot · 2nd', text: `2nd in line for a heavy slot, all held (#${a.number})`, since: now - 20_000, usual: null });
  assert.equal(waits.wait(idle.id), null);
  writeFileSync(join(heavy, 'wait-99'), `Citadel #${b.number} (cara)\ncargo test\n${now / 1000 - 20}\nload\n`);
  waits.poll();
  assert.equal(waits.wait(b.id)!.chip, 'slot · busy box');
});

test('the restart: while the ship line says deploying, with the turns it waits for; its length counts once live', () => {
  const { waits } = setup();
  const a = minion('idle');
  ships.set(a.id, 'deploying');
  const w = waits.wait(a.id)!;
  assert.deepEqual(w, { kind: 'restart', stage: 'restart', chip: 'restart · 2 turns', text: 'the restart waits for 2 running turns to end', since: now, usual: null });
  now += 45_000;
  assert.equal(waits.wait(a.id)!.since, w.since, 'it keeps its start');
  ships.set(a.id, 'live');
  assert.equal(waits.wait(a.id), null);
  assert.equal(waits.usual('restart'), 45);
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
