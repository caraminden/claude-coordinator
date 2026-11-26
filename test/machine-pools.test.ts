import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { Store } from '../src/db.ts';
import { MachinePools, type MachinePoolsDeps } from '../src/machine-pools.ts';
import type { WorkerInfo } from '../src/machine-turn.ts';
import { hostLoad } from '../public/machine-worker.mjs';

// Build 7 T4: what each connected machine lends, what holds it, and which turns it may run (Josh, 2026-11-25: "owner's turns only").
const root = mkdtempSync(join(tmpdir(), 'machine-pools-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir
const MIN = 60_000;
const T = Date.UTC(2026, 10, 25, 22, 14); // 2:14 PM PST
let n = 0;

function setup() {
  const store = new Store(join(root, `${++n}.db`));
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const cara = store.createUser({ name: 'Cara', login: 'cara' });
  const project = store.createProject('P', null);
  store.addMember(project.id, josh.id);
  store.addMember(project.id, cara.id);
  const m = store.createMachine('desk', 'h', 'Josh', josh.id);
  store.setMachineProjects(m.id, [project.id]);
  store.setMachineRole(m.id, 'turns', { on: true, projects: [project.id] }); // its Minion turns role (Build 7 M1): what `lends` stands for
  const s = { online: true, lends: true, ships: false, claude: '2.1.0' as string | null, now: T, info: { claude: '2.1.0 (Claude Code)', max: 4, at: T, load: { cpu: 12, mem: 1, freeGb: 20 }, signedIn: true } as WorkerInfo | null, hold: null as string | null, changed: 0 };
  const build = (extra: Partial<MachinePoolsDeps> = {}) =>
    new MachinePools({ ...extra, store, online: () => s.online, lends: () => s.lends, info: () => s.info, ships: () => s.ships, hold: () => s.hold, claude: () => Promise.resolve(s.claude && `${s.claude} (Claude Code)`), changed: () => void s.changed++, now: () => s.now });
  const pools = build();
  return { store, josh, cara, project, m, s, build, pools, why: () => pools.machines()[0].block?.why ?? null };
}
let t: ReturnType<typeof setup>;
beforeEach(async () => {
  t = setup();
  t.pools.machines();
  await Promise.resolve(); // its claude's version
});

test('a machine that lends workers is a place, with its owner, cap and load', () => {
  assert.deepEqual(t.pools.machines(), [{ id: t.m.id, name: 'desk', owner: t.josh.id, cap: 4, block: null, away: null, load: { reading: { cpu: 12, mem: 1 }, box: { freeGb: 20, level: 'ok' }, at: T }, priority: null, room: null }]);
  // Build 7 M6: its owner's order, from its row, and the balancer's target.
  t.store.updateMachine(t.m.id, { priority: 2 });
  const withRoom = new MachinePools({ store: t.store, online: () => true, lends: () => true, info: () => t.s.info, ships: () => false, claude: () => Promise.resolve(null), changed: () => {}, now: () => T, room: () => ({ workers: 1, why: '1 CI job waiting' }) });
  assert.deepEqual(
    withRoom.machines().map((m) => [m.priority, m.room]),
    [[2, { workers: 1, why: '1 CI job waiting' }]],
  );
  t.store.updateMachine(t.m.id, { priority: null });
  t.s.lends = false;
  assert.deepEqual(t.pools.machines(), [], 'its switch off: no place at all');
});

test('what the worker itself holds turns for (its disk cap, its self-test) is the reason', () => {
  t.s.hold = 'its self-test failed';
  assert.equal(t.why(), 'its self-test failed');
});

test('an agent from before its load was said has none, never zero', () => {
  t.s.info = { claude: '2.1.0 (Claude Code)', max: 4, at: T };
  assert.equal(t.pools.machines()[0].load, null);
  assert.equal(t.pools.refuses(t.m.id, { project_id: t.project.id }, t.josh.id), null, 'and an unknown sign-in is no refusal');
});

test('a ship, another Claude, no worker agent and no link each hold it', () => {
  t.s.ships = true;
  assert.equal(t.why(), "a ship's tests are running there");
  t.s.ships = false;
  t.s.info!.claude = '2.0.9 (Claude Code)';
  assert.equal(t.why(), "its Claude is 2.0.9 (Claude Code), and this server's is 2.1.0 (Claude Code)");
  t.s.info = null;
  assert.equal(t.why(), 'its agent has not said it can run turns');
  t.s.online = false;
  t.s.now = T + 5 * MIN;
  assert.equal(t.why(), 'away since Nov 25, 2:14 PM PST');
});

test("with the PC's other agent still connected, a silent worker's away time grows", () => {
  t.s.online = false;
  t.s.now = T + 30 * MIN;
  t.store.updateMachine(t.m.id, { last_seen_at: t.s.now });
  assert.equal(t.why(), 'away since Nov 25, 2:14 PM PST');
  t.s.info = null;
  t.store.setSetting('worker-seen' as never, {} as never);
  const fresh = t.build();
  t.s.now += 2 * MIN;
  assert.equal(fresh.machines()[0].away, T + 30 * MIN, 'before any sync, its agent dates it');
});

test("this server's Claude is asked first, then nothing waits on the next tick, and asked again as it ages", async () => {
  const fresh = t.build();
  assert.equal(fresh.machines()[0].block?.why, 'checking its Claude');
  const was = t.s.changed;
  await Promise.resolve();
  assert.equal(t.s.changed, was + 1);
  assert.equal(fresh.machines()[0].block, null);
  t.s.claude = '2.2.0';
  t.s.now += 11 * MIN;
  fresh.machines();
  await Promise.resolve();
  assert.match(fresh.machines()[0].block!.why, /this server's is 2\.2\.0/);
});

test('a link gone for a moment is coming back, not away: after a restart its syncs are there before its link', () => {
  t.s.online = false;
  t.s.now = T + 30_000;
  assert.deepEqual([t.why(), t.pools.machines()[0].away], ['reconnecting', null]);
  t.s.now = T + 10 * MIN;
  const restarted = t.build();
  assert.deepEqual([restarted.machines()[0].block?.why, restarted.machines()[0].away], ['reconnecting', null], 'a server that just started has seen no link yet');
  t.s.now += 2 * MIN;
  assert.deepEqual([restarted.machines()[0].block, restarted.machines()[0].away], [{ why: 'away since Nov 25, 2:14 PM PST', since: T }, T], 'and it keeps when the machine was last here');
});

test("a turn there runs only on its owner's account signed in there: none never, none ready waits (#2061)", () => {
  const turn = { project_id: t.project.id };
  const there = { linked: [1, 2], usable: [2], ready: true };
  const asked: unknown[] = [];
  const pools = t.build({ accountsThere: (person, slots) => (asked.push([person, slots]), there) });
  t.s.info!.accounts = [{ n: 2, org: 'org-two' }];
  assert.equal(pools.refuses(t.m.id, turn, t.josh.id), null);
  assert.deepEqual(pools.accountsAt(t.m.id, t.josh.id), [2], 'the pick there is among what it holds and he has linked');
  assert.deepEqual(asked[0], [t.josh.id, [{ n: 2, org: 'org-two' }]]);
  there.ready = false;
  assert.deepEqual(pools.refuses(t.m.id, turn, t.josh.id), { why: "Josh's Claude accounts signed in there are at their usage limit or need linking again" }, 'a limit passes: it waits, never a never');
  there.usable = [];
  assert.deepEqual(pools.refuses(t.m.id, turn, t.josh.id), { why: "none of Josh's linked Claude accounts is signed in there", never: true });
  // An agent from before says only whether it holds a sign-in: account 1's.
  delete t.s.info!.accounts;
  asked.length = 0;
  pools.accountsAt(t.m.id, t.josh.id);
  assert.deepEqual(asked[0], [t.josh.id, [{ n: 1, org: null }]]);
  assert.equal(pools.accountsAt(t.m.id, null), undefined);
  t.s.info = null;
  assert.equal(pools.accountsAt(t.m.id, t.josh.id), undefined, 'no worker facts: nothing to restrict by (and no turn goes there)');
});

test('each reason a turn can never run there', () => {
  const turn = { project_id: t.project.id };
  const why = (person: number | null = t.josh.id, id = t.m.id, name?: string) => t.pools.refuses(id, turn, person, name);
  assert.equal(why(), null);
  assert.deepEqual(why(t.cara.id), { why: "it runs only Josh's turns, and this one is Cara's", never: true });
  assert.deepEqual(why(null), { why: "it runs only Josh's turns, and this one is nobody's", never: true });
  t.s.info!.signedIn = false;
  assert.deepEqual(why(), { why: 'Josh is not signed in to Claude there', never: true });
  t.s.info!.signedIn = null;
  assert.equal(why(), null, 'not known is not a no');
  t.store.setMachineProjects(t.m.id, []);
  assert.deepEqual(why(), { why: 'it is not lent to this scheme', never: true });
  t.s.lends = false;
  assert.deepEqual(why(), { why: 'Josh has switched Minion turns off there', never: true });
  assert.deepEqual(why(t.josh.id, t.m.id, 'desk-before'), { why: 'that computer was removed', never: true }, 'another machine with its number');
  t.store.deleteMachine(t.m.id);
  assert.deepEqual(why(), { why: 'that computer was removed', never: true });
});

test("a server whose Claude can't be read any more places nothing until it can", async () => {
  t.s.claude = null;
  t.s.now += 60 * MIN;
  t.s.info!.at = t.s.now;
  t.why();
  await Promise.resolve();
  assert.equal(t.why(), 'checking its Claude');
});

test('a launch gets the machine, or why not any more', () => {
  const turn = { project_id: t.project.id };
  assert.deepEqual(t.pools.launch(t.m.id, turn, t.josh.id), { id: t.m.id, name: 'desk' });
  t.s.ships = true;
  assert.deepEqual(t.pools.launch(t.m.id, turn, t.josh.id), { why: "a ship's tests are running there" });
  assert.equal((t.pools.launch(t.m.id, turn, t.cara.id) as { never?: true }).never, true);
});

test('a person picks their own machines only, and sees why one cannot be picked', () => {
  assert.deepEqual(t.pools.choices(t.project.id, t.josh.id), [{ id: t.m.id, name: 'desk', why: null }]);
  assert.deepEqual(t.pools.choices(t.project.id, t.cara.id), [{ id: t.m.id, name: 'desk', why: 'only Josh can pick it' }]);
  t.store.setMachineProjects(t.m.id, []);
  assert.deepEqual(t.pools.choices(t.project.id, t.josh.id)[0].why, 'it is not lent to this scheme');
  t.s.lends = false;
  assert.deepEqual(t.pools.choices(t.project.id, t.cara.id), [], "a machine that lends none is its owner's to see");
});

test("the agent reads its computer's pressure and free memory, and says null for what it can't read", () => {
  const files: Record<string, string> = {
    '/proc/pressure/cpu': 'some avg10=50.00 avg60=38.61 avg300=1.00 total=1\n',
    '/proc/pressure/memory': 'some avg10=0.00 avg60=2.40 avg300=0.00 total=1\nfull avg10=0.00 avg60=9.00 avg300=0.00 total=1\n',
    '/proc/meminfo': 'MemTotal: 100 kB\nMemAvailable:   20971520 kB\n',
  };
  const read = (f: string) => {
    if (!(f in files)) throw new Error('ENOENT');
    return files[f];
  };
  assert.deepEqual(hostLoad(read), { cpu: 39, mem: 2, freeGb: 20 });
  delete files['/proc/pressure/cpu'];
  delete files['/proc/pressure/memory'];
  assert.deepEqual(hostLoad(read), { cpu: null, mem: null, freeGb: 20 });
});
