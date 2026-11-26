// The ship-script lane's skip and ship-together (#1985; Josh, 2026-11-25), on the real Claims and real git worktrees.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { Claims, type Claim } from '../src/claims.ts';
import type { Ticket } from '../src/db.ts';
import { sharedPipelineFiles, ShipLane, SHIP_LANE, SKIP_AFTER_MS, type ShipLaneDeps } from '../src/ship-lane.ts';
import { tempRoot } from './helpers.ts';

const tmp = tempRoot('ship-lane-');
after(() => tmp.teardown());
const START = 1_000_000;
const LATE = START + SKIP_AFTER_MS;
let n = 0;

/** A lane with minion 1 holding it since START and the rest waiting, each with a branch changing its files. */
function lane(files: Record<number, string[]>) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON; CREATE TABLE projects (id INTEGER PRIMARY KEY); INSERT INTO projects (id) VALUES (1);');
  const claims = new Claims(db);
  const dir = join(tmp.dir, String(++n));
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' });
  const write = (cwd: string, f: string, text = 'x\n') => {
    mkdirSync(join(cwd, f, '..'), { recursive: true });
    writeFileSync(join(cwd, f), text);
  };
  const tickets = new Map<number, Ticket>();
  for (const [id, changed] of Object.entries(files)) {
    const cwd = join(dir, id);
    mkdirSync(cwd, { recursive: true });
    git(cwd, 'init', '-q', '-b', 'main');
    write(cwd, 'tools/pipeline-files.txt', 'tools/land.sh\nsrc/pipe/\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'init');
    git(cwd, 'checkout', '-qb', 'work');
    for (const f of changed) write(cwd, f);
    if (changed.length) {
      git(cwd, 'add', '.');
      git(cwd, 'commit', '-qm', 'change');
    }
    tickets.set(Number(id), { id: Number(id), number: Number(id), project_id: 1, kind: 'ticket', title: `M${id}`, status: 'idle', state: 'parked', cwd } as Ticket);
  }
  const ids = [...tickets.keys()];
  claims.take(1, SHIP_LANE, ids[0], 'TM', '', START);
  claims.setQueue(1, SHIP_LANE, ids.slice(1), 'TM', START);
  for (const id of ids.slice(1)) claims.setReady(1, SHIP_LANE, id);
  const busy = new Set<number>();
  const shipping = new Set<number>();
  const cards = new Set<number>();
  const held = new Set<number>();
  const woke: [number, string][] = [];
  const mail: [number, string][] = [];
  const passed: { from: Claim; to: Claim }[] = [];
  /** Armed hand-offs (#2046): null ships, a string is why it can't. */
  const armed = new Map<number, string | null>();
  const fired: [number, string][] = [];
  const deps: ShipLaneDeps = {
    store: { claims, listProjects: () => [{ id: 1 }], getTicket: (id) => tickets.get(id), openCardAt: (id) => (cards.has(id) ? 1 : null) },
    busy: (id) => busy.has(id),
    heldFor: (id) => (held.has(id) ? 'its leader' : null),
    shipping: (id) => shipping.has(id),
    claimPassed: (_p, list) => void passed.push(...list),
    wake: (id, text) => void woke.push([id, text]),
    leaveMail: (id, _a, text) => void mail.push([id, text]),
    broadcast: () => {},
    armed: (id, fallback, started) => {
      if (!armed.has(id)) return false;
      const why = armed.get(id);
      fired.push([id, started]);
      if (why) fallback(why);
      return true;
    },
  };
  const it = new ShipLane(deps);
  return { claims, tickets, busy, shipping, cards, held, woke, mail, passed, armed, fired, sweep: (now: number) => it.sweep(now), claim: () => claims.get(1, SHIP_LANE), waiting: () => claims.waiting(1, SHIP_LANE), write };
}

test('a holder with nothing handed off in 10 min is skipped for the next ready one, and waits first', async () => {
  const l = lane({ 1: ['tools/land.sh'], 2: ['src/pipe/a.ts'], 3: ['src/pipe/b.ts'] });
  l.busy.add(2); // at work: not ready
  await l.sweep(LATE - 1);
  assert.equal(l.claim()!.holder, 1, 'not before its 10 min');
  await l.sweep(LATE);
  assert.equal(l.claim()!.holder, 3);
  assert.equal(l.claim()!.since, LATE);
  assert.deepEqual(l.waiting(), [1, 2], 'it waits first, the rest in their order');
  assert.deepEqual([l.passed[0].from.holder, l.passed[0].to.holder], [1, 3]);
  assert.match(l.mail[0][1], /went to #3 M3.*first in its queue/);
  assert.equal(l.mail[0][0], 1, 'an idle holder is told on its next turn');
  // 3 goes live: the lane is 1's again.
  l.claims.shipped(3, 'c');
  assert.equal(l.claims.holderLive(l.claim()!, ['c'])!.to!.holder, 1);
});

test('a skipped holder at work is told now', async () => {
  const l = lane({ 1: [], 2: ['src/pipe/a.ts'] });
  l.busy.add(1);
  await l.sweep(LATE);
  assert.equal(l.claim()!.holder, 2);
  assert.equal(l.woke[0][0], 1);
});

test('nobody is skipped for one that is not ready', async () => {
  const cases: [string, (l: ReturnType<typeof lane>) => void, string[]?][] = [
    ['at work', (l) => l.busy.add(2)],
    ['not said it is ready', (l) => l.claims.setQueue(1, SHIP_LANE, [], 'TM') ?? l.claims.setQueue(1, SHIP_LANE, [2], 'TM')],
    ['waiting on a card', (l) => l.cards.add(2)],
    ['shipping already', (l) => l.shipping.add(2)],
    ['waiting on its start', (l) => l.held.add(2)],
    ['uncommitted work', (l) => l.write(l.tickets.get(2)!.cwd!, 'src/pipe/a.ts', 'more\n')],
    ['its last turn failed', (l) => void l.tickets.set(2, { ...l.tickets.get(2)!, status: 'error' })],
    ['nothing built', () => {}, []],
    ['no ship-script file changed', () => {}, ['src/a.ts']],
  ];
  for (const [why, change, files] of cases) {
    const l = lane({ 1: [], 2: files ?? ['src/pipe/a.ts'] });
    change(l);
    await l.sweep(LATE);
    assert.equal(l.claim()!.holder, 1, why);
  }
});

test('a holder that handed off, shipped, is kept, or is a Taskmaster is not skipped', async () => {
  const cases: [string, (l: ReturnType<typeof lane>) => void][] = [
    ['handed off', (l) => l.claims.handedOff(1)],
    ['shipped', (l) => l.claims.shipped(1, 'c')],
    ['kept', (l) => void l.claims.take(1, SHIP_LANE, 1, 'TM', '', START, true)],
    ['a Taskmaster', (l) => void l.tickets.set(1, { ...l.tickets.get(1)!, kind: 'coordinator' })],
    ['in line', (l) => l.shipping.add(1)],
  ];
  for (const [why, change] of cases) {
    const l = lane({ 1: ['tools/land.sh'], 2: ['tools/land.sh'] });
    change(l);
    await l.sweep(LATE);
    assert.equal(l.claim()!.holder, 1, why);
  }
});

test('the next ready one ships beside a holder in line when they share no ship-script file, one at a time', async () => {
  const l = lane({ 1: ['tools/land.sh', 'README.md'], 2: ['src/pipe/a.ts', 'README.md'], 3: ['src/pipe/b.ts'] });
  await l.sweep(START + 1);
  assert.equal(l.claim()!.beside, 0, 'nothing handed off yet');
  l.shipping.add(1);
  await l.sweep(START + 2);
  assert.equal(l.claim()!.beside, 2);
  assert.match(l.woke[0][1], /You may ship now, beside #1/);
  assert.equal(l.woke[0][0], 2);
  await l.sweep(START + 3);
  assert.equal(l.woke.length, 1, 'one at a time, told once');
  assert.deepEqual([l.claim()!.holder, l.waiting()], [1, [2, 3]]);
});

test('the next ready one that shares a ship-script file is not let in, nor one behind it', async () => {
  const l = lane({ 1: ['tools/land.sh'], 2: ['tools/land.sh'], 3: ['src/pipe/b.ts'] });
  l.shipping.add(1);
  await l.sweep(START + 1);
  assert.equal(l.claim()!.beside, 0);
  assert.deepEqual(l.woke, []);
});

test("a file either branch's own list names counts as shared", async () => {
  // 1 drops tools/land.sh from its list and changes it.
  const l = lane({ 1: ['tools/land.sh', 'src/pipe/a.ts'], 2: ['tools/land.sh'] });
  l.write(l.tickets.get(1)!.cwd!, 'tools/pipeline-files.txt', 'src/pipe/\n');
  l.shipping.add(1);
  await l.sweep(START + 1);
  assert.equal(l.claim()!.beside, 0);
  // Once the holder is on main its branch changes nothing, and one let in before that isn't refused for it.
  const done = lane({ 1: [], 2: ['tools/land.sh'] });
  assert.deepEqual(await sharedPipelineFiles(done.tickets.get(2)!.cwd!, done.tickets.get(1)!.cwd!), []);
});

test('one taken out of the queue while it ships keeps the next from being let in', async () => {
  const l = lane({ 1: ['tools/land.sh'], 2: ['src/pipe/a.ts'], 3: ['src/pipe/b.ts'] });
  l.shipping.add(1);
  await l.sweep(START + 1);
  l.shipping.add(2);
  l.claims.setQueue(1, SHIP_LANE, [3], 'TM');
  await l.sweep(START + 2);
  assert.deepEqual([l.claim()!.beside, l.woke.length], [0, 1]);
  l.shipping.delete(2);
  await l.sweep(START + 3);
  assert.equal(l.claim()!.beside, 3);
});

test('a holder whose branch changes no ship-script file ships alone: nothing to compare', async () => {
  const l = lane({ 1: ['README.md'], 2: ['src/pipe/a.ts'] });
  l.shipping.add(1);
  await l.sweep(START + 1);
  assert.equal(l.claim()!.beside, 0);
});

test('one let in beside with an armed hand-off ships with no wake; one whose ship is ruled out is woken with why (#2046)', async () => {
  const l = lane({ 1: ['tools/land.sh'], 2: ['src/pipe/a.ts'] });
  l.armed.set(2, null);
  l.shipping.add(1);
  await l.sweep(START + 1);
  assert.equal(l.claim()!.beside, 2);
  assert.deepEqual(l.woke, [], 'no turn');
  assert.match(l.fired[0][1], /^Citadel let you ship beside #1 M1, which holds the pipeline-lane claim .*started your armed hand-off with no turn\.$/);

  const r = lane({ 1: ['tools/land.sh'], 2: ['src/pipe/a.ts'] });
  r.armed.set(2, 'your branch moved since you armed it');
  r.shipping.add(1);
  await r.sweep(START + 1);
  assert.equal(r.woke.length, 1);
  assert.match(r.woke[0][1], /^You may ship now, beside #1[^]*\n\nYour armed hand-off didn't ship by itself: your branch moved since you armed it\. Hand it off again once it's ready\.$/);
});
