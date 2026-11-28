// Build 11 P4: a machine's owner pauses CI on it, and the pool starts nothing new there while they're busy (src/owner-busy.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSY, BusyWatch, OwnerBusy, offWords, ownerCpu, pauseEnd, pauseWords, type BusyLook } from '../src/owner-busy.ts';
import type { Sample } from '../src/ci-load.ts';
import { place } from '../src/runner-pool.ts';

const MIN = 60_000;
const GB = 1024 ** 3;
const T0 = Date.UTC(2026, 10, 27, 20, 0); // Nov 27, 12:00 PM PST
const quiet = (now: number, over: Partial<BusyLook> = {}): BusyLook => ({ now, front: null, ownerCpu: 10, memFree: 16 * GB, memNeed: 4 * GB, ...over });

/** Feeds the watch a look every 30 seconds from `from` to `to` (ms), as the pool passes do, and returns the last state. */
function run(w: BusyWatch, from: number, to: number, over: Partial<BusyLook>) {
  let s = null;
  for (let t = from; t <= to; t += 30_000) s = w.see(quiet(t, over), 'Cara');
  return s;
}

test('a game or a full-screen app in front is busy at once, named for the card and the line', () => {
  assert.equal(new BusyWatch().see(quiet(T0, { front: 'game' }), 'Cara')?.why, 'Cara is in a game');
  assert.equal(new BusyWatch().see(quiet(T0, { front: 'fullscreen' }), 'Cara')?.why, 'a full-screen app is running');
  assert.equal(new BusyWatch().see(quiet(T0, { front: 'presenting' }), 'Cara')?.why, 'Cara is presenting');
  assert.equal(new BusyWatch().see(quiet(T0), 'Cara'), null);
});

test("the owner's own programs over half the CPU are busy only once it has lasted 2 minutes", () => {
  const w = new BusyWatch();
  assert.equal(run(w, T0, T0 + BUSY.cpuForMs - 30_000, { ownerCpu: 80 }), null, 'not yet at 1.5 minutes');
  assert.equal(w.see(quiet(T0 + BUSY.cpuForMs, { ownerCpu: 80 }), 'Cara')?.why, "Cara's own programs are using 80% of the CPU");
  // A dip resets the 2 minutes: half the CPU exactly isn't over half.
  const v = new BusyWatch();
  run(v, T0, T0 + 90_000, { ownerCpu: 90 });
  v.see(quiet(T0 + 2 * MIN, { ownerCpu: 50 }), 'Cara');
  assert.equal(run(v, T0 + 2.5 * MIN, T0 + 4 * MIN, { ownerCpu: 90 }), null, 'the streak began again after the dip');
  // No fresh sample says nothing either way.
  assert.equal(run(new BusyWatch(), T0, T0 + 5 * MIN, { ownerCpu: null }), null);
});

test("free memory under the next job's need is busy at once; unknown memory is not", () => {
  assert.equal(new BusyWatch().see(quiet(T0, { memFree: 3 * GB, memNeed: 8 * GB }), 'Cara')?.why, 'only 3 GB of memory free, and the next job needs 8 GB');
  assert.equal(new BusyWatch().see(quiet(T0, { memFree: 8 * GB, memNeed: 8 * GB }), 'Cara'), null, 'exactly enough is enough');
  assert.equal(new BusyWatch().see(quiet(T0, { memFree: null }), 'Cara'), null);
});

test('it clears only after 5 quiet minutes, and anything busy in them starts the quiet over (no flicker)', () => {
  const w = new BusyWatch();
  const since = w.see(quiet(T0, { front: 'game' }), 'Cara')!.since;
  assert.equal(since, T0);
  // Out of the game at T0 + 1 min: still stepping back, with the same reason, until 5 minutes have passed.
  assert.equal(run(w, T0 + MIN, T0 + MIN + BUSY.quietMs - 30_000, {})?.why, 'Cara is in a game');
  // Back in for one look: the spell goes on (same since) and the 5 minutes start again.
  assert.equal(w.see(quiet(T0 + 7 * MIN, { front: 'game' }), 'Cara')?.since, since);
  assert.ok(run(w, T0 + 7.5 * MIN, T0 + 7.5 * MIN + BUSY.quietMs - 30_000, {}), 'still busy just short of 5 quiet minutes');
  assert.equal(w.see(quiet(T0 + 7.5 * MIN + BUSY.quietMs), 'Cara'), null, 'clear at 5 quiet minutes');
});

test('"Run CI anyway" holds for this spell only: a new spell after it clears steps back again', () => {
  const w = new BusyWatch();
  assert.equal(w.anyway(), false, 'nothing to set aside when it is not busy');
  w.see(quiet(T0, { front: 'game' }), 'Cara');
  assert.equal(w.anyway(), true);
  assert.equal(w.see(quiet(T0 + MIN, { front: 'game' }), 'Cara')?.anyway, true);
  assert.equal(offWords({ pause: null, busy: w.state() }), null, 'jobs start while it runs anyway');
  run(w, T0 + 2 * MIN, T0 + 2 * MIN + BUSY.quietMs, {});
  assert.equal(w.state(), null);
  assert.equal(w.see(quiet(T0 + 30 * MIN, { front: 'game' }), 'Cara')?.anyway, false);
});

test("the owner's CPU is the PC's less its CI runners'", () => {
  const runner = (cpu: number) => ({ name: 'r', repo: 'a/b', dir: 'C:\\r', cpu, mem: 0 });
  assert.equal(ownerCpu({ cpu: 90, runners: [runner(30), runner(10)] }), 50);
  assert.equal(ownerCpu({ cpu: 20, runners: [runner(30)] }), 0);
});

test('a pause ends in an hour, at 8 AM Pacific the next morning (across a DST change too), or when resumed', () => {
  assert.equal(pauseEnd('hour', T0), T0 + 60 * MIN);
  assert.equal(pauseEnd('resumed', T0), null);
  assert.equal(pauseEnd('tomorrow', T0), Date.UTC(2026, 10, 28, 16), 'Nov 28, 8:00 AM PST');
  assert.equal(pauseEnd('tomorrow', Date.UTC(2026, 10, 28, 7, 30)), Date.UTC(2026, 10, 28, 16), 'at 11:30 PM PST, tomorrow is the next morning');
  // Nov 1, 2026 falls back at 2 AM: pressed on Oct 31 at 9 PM PDT, it ends at 8 AM PST.
  assert.equal(pauseEnd('tomorrow', Date.UTC(2026, 10, 1, 4)), Date.UTC(2026, 10, 1, 16));
  // Mar 8, 2026 springs forward: pressed Mar 7 at 9 PM PST, it ends at 8 AM PDT.
  assert.equal(pauseEnd('tomorrow', Date.UTC(2026, 2, 8, 5)), Date.UTC(2026, 2, 8, 15));
  assert.equal(pauseWords({ until: T0 + 60 * MIN }, T0), 'until 1:00 PM PST');
  assert.equal(pauseWords({ until: Date.UTC(2026, 10, 28, 16) }, T0), 'until tomorrow, 8:00 AM PST');
  assert.equal(pauseWords({ until: null }, T0), 'until resumed');
});

test("a waiting job's reason names the machine and why it holds back, and nothing starts there", () => {
  const off = offWords({ pause: null, busy: new BusyWatch().see(quiet(T0, { front: 'game' }), 'Cara') });
  const job = { repo: 'r/5', id: 1, run: 1, name: 'tests', ship: false, first: false, since: T0, needs: { os: 'windows' as const, session: false, size: 4 } };
  const pc = { id: 1, name: 'cara-desktop', priority: null, os: ['windows' as const], session: true, schemes: [5], limit: 16, free: 16, off };
  const [p] = place({ jobs: [{ ...job, scheme: 5 }], machines: [pc], now: T0, lastStart: new Map(), warm: new Map() });
  assert.equal(p.machine, null);
  assert.equal(p.why, 'cara-desktop is stepping back: Cara is in a game');
});

/** An OwnerBusy on a fake clock and settings, with one machine's newest sample. */
function world() {
  let now = T0;
  const settings = new Map<string, unknown>();
  let sample: Sample | null = null;
  const busy = new OwnerBusy({
    store: { getSetting: <T>(k: string) => (settings.get(k) as T) ?? null, setSetting: (k, v) => settings.set(k, v), deleteSetting: (k) => settings.delete(k) },
    now: () => now,
    sample: () => sample,
    owner: () => 'Cara',
  });
  const at = (cpu: number, memFreeGb: number): Sample => ({ at: now, host: 'cara-desktop', os: 'windows', cores: 16, cpu, mem_total: 32 * GB, mem_free: memFreeGb * GB, disk_total: null, disk_free: null, queue: null, pressure: null, idle_sec: 0, temp: null, hv: null, runners: [], restarts: [] });
  return { busy, settings, tick: (ms: number) => (now += ms), setSample: (cpu: number, mem: number) => (sample = at(cpu, mem)) };
}

test('a pause holds new jobs back until it ends, and names when', () => {
  const w = world();
  const use = w.busy.pause(7, 'hour', 'Cara');
  assert.equal(offWords(use), 'is paused until 1:00 PM PST');
  w.tick(59 * MIN);
  assert.ok(w.busy.look(7, 4).pause);
  w.tick(MIN);
  assert.equal(w.busy.look(7, 4).pause, null, 'an hour on, it ended by itself');
  w.busy.pause(7, 'resumed', 'Cara');
  assert.equal(offWords(w.busy.use(7)), 'is paused until resumed');
  assert.equal(w.busy.resume(7).pause, null);
});

test("a look reads the machine agent's front and the runner agent's sample, and forgets stale ones", () => {
  const w = world();
  w.busy.front(7, 'game');
  assert.equal(offWords(w.busy.look(7, 4)), 'is stepping back: Cara is in a game');
  // The machine agent went quiet: its word is stale after BUSY.frontStaleMs, then 5 quiet minutes clear it.
  w.tick(BUSY.frontStaleMs);
  w.busy.look(7, 4);
  w.tick(BUSY.quietMs);
  assert.equal(w.busy.look(7, 4).busy, null);
  // Memory: 3 GB free is short of an 8-thread job's 8 GB but enough for none at all.
  w.setSample(10, 3);
  assert.equal(offWords(w.busy.look(7, 8)), 'is stepping back: only 3 GB of memory free, and the next job needs 8 GB');
  w.tick(BUSY.sampleStaleMs);
  w.busy.look(7, 8);
  w.tick(BUSY.quietMs);
  assert.equal(w.busy.look(7, 8).busy, null, 'a stale sample says nothing');
  // "Run CI anyway" while busy: the machine takes jobs again.
  w.busy.front(7, 'fullscreen');
  w.busy.look(7, 4);
  assert.equal(w.busy.anyway(7), true);
  assert.equal(offWords(w.busy.look(7, 4)), null);
  assert.equal(w.busy.anyway(8), false, 'a machine never seen is not busy');
});

test("/api/ci/pool shows a pause pressed since the pool's last pass, and leaves a machine lending no pool scheme alone", async () => {
  const { ciPoolRoutes } = await import('../src/routes/ci-pool.ts');
  const w = world();
  const machine = (id: number, use: unknown) => ({ id, name: `pc${id}`, limit: 16, used: 0, free: 16, off: null, use, standing: [], running: [] });
  const view = { at: T0, watching: false, line: [], machines: [machine(7, { pause: null, busy: null }), machine(8, null)] };
  w.busy.pause(7, 'hour', 'Cara');
  w.busy.pause(8, 'hour', 'Cara');
  let body = '';
  const res = { headersSent: false, setHeader() {}, writeHead: () => res, end: (b?: string) => (body = b ?? '') };
  const store = { canSee: () => true, listProjects: () => [], getSetting: () => null, getMachine: (id: number) => ({ id, owner_id: 1 }) };
  await ciPoolRoutes[0].handler({ res, app: { pool: { view: () => view }, ownerBusy: w.busy, store }, session: { name: 'Cara', uid: 1, admin: false } } as never);
  const [seven, eight] = JSON.parse(body).machines;
  assert.equal(seven.off, 'is paused until 1:00 PM PST');
  assert.equal(seven.use.pause.by, 'Cara');
  assert.equal(eight.use, null, 'its schemes run on standing runners, which a pause does not hold');
  assert.equal(eight.off, null);
});

test("the machine agent reads Windows' notification state as what is in front, and keeps its watcher up", async () => {
  const { frontOf, watchFront } = await import('../public/machine-agent.mjs');
  assert.deepEqual(['3', '2', '7', '4', '5', '1', '6', '?', ''].map(frontOf), ['game', 'fullscreen', 'fullscreen', 'presenting', null, null, null, undefined, undefined]);
  const { EventEmitter } = await import('node:events');
  const sent: unknown[] = [];
  type Child = InstanceType<typeof EventEmitter> & { stdout: InstanceType<typeof EventEmitter>; kill(): void };
  const children: Child[] = [];
  const start = (): Child => {
    const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => {} });
    children.push(c);
    return c;
  };
  const stop = watchFront({ send: (f: unknown) => sent.push(f), log: () => {}, start, again: 0 });
  // A line split over two reads is read once whole; a line it can't read sends nothing.
  children[0].stdout.emit('data', '3\r\n5\r');
  children[0].stdout.emit('data', '\n?\r\n2');
  assert.deepEqual(sent, ['game', null]);
  children[0].emit('close');
  const { until } = await import('./wait.ts');
  await until('the watcher started again', () => children.length === 2);
  stop();
});
