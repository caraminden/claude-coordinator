import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import type { Ship } from '../src/branch.ts';
import { median, procAlive, slotHeld, Waits } from '../src/waits.ts';
import { spawn } from 'node:child_process';

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
  const dead = new Set<string>(), free = new Set<string>();
  const waits = new Waits({
    store, deployState: state, heavyDir: heavy, interruptible: () => 2, changed: (id) => changed.push(id), now: () => now,
    ship: (id) => (ships.has(id) ? { stage: ships.get(id)!, text: '', commit: 'abc1234' } : null),
    alive: (proc) => !dead.has(proc), held: (f) => !free.has(f),
  });
  /** A land-line ticket as tools/deploy-queue.sh writes it, last written `ago` s before now. */
  const ticket = (seq: number, label: string, got: number, phase: string, ago: number) => {
    const f = join(state, 'queue', String(seq).padStart(10, '0'));
    writeFileSync(f, `${seq}00 77\n${got}\n${label}\n${phase}\n`);
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

  assert.deepEqual(waits.wait(a.id), { kind: 'land', stage: 'test', chip: 'land · tests', text: 'CI fell back: running the full suite on perigee', since: now - 30_000, usual: null });
  const wb = waits.wait(b.id)!;
  assert.equal(wb.chip, 'line · 2nd');
  assert.equal(wb.text, `2nd in line, behind #${a.number} (testing)`);
  // B joined before A took the lock, so a whole landing (the median of 100, 200, 150) is ahead of it.
  assert.equal(wb.usual, 150);
  assert.equal(waits.wait(c.id)!.text, `3rd in line, behind #${a.number} (testing) and 1 more`);
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
  assert.deepEqual({ ...waits.wait(a.id)!, since: 0 }, { kind: 'land', stage: 'deploy', chip: 'land · deploy', text: 'boot check', since: 0, usual: null });
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

test('a heavy slot reads as held only while someone holds its lock', async () => {
  const slot = join(root, 'slot-0');
  writeFileSync(slot, '');
  assert.equal(slotHeld(slot), false);
  const holder = spawn('flock', [slot, 'sh', '-c', 'echo held; sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  try {
    await new Promise((r) => holder.stdout!.once('data', r));
    assert.equal(slotHeld(slot), true);
  } finally {
    process.kill(-holder.pid!, 'SIGKILL'); // its sleep too
    await new Promise((r) => holder.once('exit', r));
  }
});
