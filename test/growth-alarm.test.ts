import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store, type HostSample } from '../src/db.ts';
import { Contraptions } from '../src/contraptions.ts';
import { checkGrowth, readGrowth, steadyRise, FLOORS, KIND, LEARN_MS, SUPERVISOR_SLACK } from '../src/growth-alarm.ts';

const root = mkdtempSync(join(tmpdir(), 'growth-alarm-'));
// timing-ok: own temp dir
after(() => rmSync(root, { recursive: true, force: true }));

const H = 3_600_000;
const STEP = 5 * 60_000;
const MB = 1024 ** 2;
/** Noon PST, outside the 2-9 AM hold. */
const NOON = Date.parse('2026-11-20T20:00:00Z');

function setup(name: string) {
  const store = new Store(join(root, `${name}.db`));
  const citadel = store.createProject('Citadel', null, null);
  const cara = store.createUser({ name: 'Cara', login: 'cara' });
  store.createTicket({ project_id: citadel.id, title: 'Taskmaster', permission_mode: 'default', created_by: cara.id, kind: 'coordinator' });
  const told: string[] = [];
  return { store, citadel, told, deps: (bootAt: number, turns = 0) => ({ store, bootAt, turns: () => turns, ownScheme: () => citadel.id, tell: (_: number, t: string) => void told.push(t) }) };
}

const base = (at: number): HostSample => ({ at, mem_total: 16e9, mem_avail: 8e9, disk_total: 1e12, disk_free: 5e11, load1: 1, rss: 600 * MB });

/** Takes a sample every 5 minutes from `from` to `to` and runs the check after each, as the sampler does; returns what rang. */
function run(s: ReturnType<typeof setup>, from: number, to: number, bootAt: (t: number) => number, row: (t: number) => Partial<HostSample>, turns = 0) {
  const rang: string[] = [];
  for (let t = from; t <= to; t += STEP) {
    s.store.addHostSample({ ...base(t), ...row(t) });
    rang.push(...checkGrowth(s.deps(bootAt(t), turns), t).map((g) => g.key));
  }
  return rang;
}

test('a steady rise in the server memory rings once and wakes the Taskmaster once', () => {
  const s = setup('steady');
  const boot = NOON - 12 * H;
  const rang = run(s, boot, NOON, () => boot, (t) => ({ rss: 600 * MB + ((t - boot) / H) * 80 * MB }));
  assert.deepEqual(rang, [`rss@${boot}`]);
  assert.equal(s.store.healthEventsSince([KIND], 0).length, 1);
  assert.equal(s.told.length, 1);
  assert.match(s.told[0], /the server's memory rose steadily for 6 hours/);
});

test('a spike that settles does not ring', () => {
  const s = setup('spike');
  const boot = NOON - 10 * H;
  const rang = run(s, boot, NOON, () => boot, (t) => ({ rss: (t > NOON - 4 * H && t < NOON - 3 * H ? 2500 : 620) * MB, open_fds: t > NOON - 3 * H && t < NOON - 2 * H ? 900 : 180 }));
  assert.deepEqual(rang, []);
  assert.equal(s.told.length, 0);
});

test('one step up that stays flat does not ring', () => {
  const s = setup('step');
  const boot = NOON - 10 * H;
  assert.deepEqual(run(s, boot, NOON, () => boot, (t) => ({ rss: (t > NOON - 3 * H ? 1400 : 600) * MB })), []);
});

test('a restart starts the server series over', () => {
  const s = setup('restart');
  const first = NOON - 14 * H;
  const second = NOON - 5 * H;
  // The same climb all along, but the second run is too young to judge: nothing rings after it starts.
  const climb = (t: number) => ({ rss: 600 * MB + ((t - first) / H) * 80 * MB });
  const before = run(s, first, second - STEP, () => first, climb);
  assert.deepEqual(before, [`rss@${first}`]);
  assert.deepEqual(run(s, second, NOON, () => second, climb), []);
  // A leak in the new run, judged from its own start, rings as a new alarm 7 hours in.
  const r = setup('restart-again');
  assert.deepEqual(run(r, second, NOON + 3 * H, () => second, (t) => ({ rss: 600 * MB + ((t - second) / H) * 80 * MB })), [`rss@${second}`]);
});

test('supervisor units over running turns + 10 and /tmp over 3 GB ring once each, in one wake', () => {
  const s = setup('bounds');
  const boot = NOON - H;
  const rang = run(s, boot, NOON, () => boot, () => ({ supervisors: 3 + SUPERVISOR_SLACK + 1, tmp_used: 3.5 * 1024 ** 3 }), 2);
  assert.deepEqual(rang.sort(), ['bound:supervisors', 'bound:tmp']);
  assert.equal(s.told.length, 1);
  assert.match(s.told[0], /14 citadel-supervisor-\* units are running with 2 turns/);
  assert.match(s.told[0], /\/tmp holds 3\.5 GB/);
  // Under the line it stays quiet.
  const calm = setup('bounds-calm');
  assert.deepEqual(run(calm, boot, NOON, () => boot, () => ({ supervisors: 2 + SUPERVISOR_SLACK, tmp_used: 2 * 1024 ** 3 }), 2), []);
});

test("an app server's rise names the app and its scheme; an app restart starts it over", () => {
  const s = setup('app');
  const peek = s.store.createProject('Peek Auras', null, null);
  new Contraptions(s.store, 's'.repeat(40), join(root, 'app-keys')).register({ name: 'peek-auras', title: 'Peek Auras', port: 9300, icon: null, home_scheme: peek.id, open_paths: '[]', default_model: null, turn_cap: null });
  const boot = NOON - H;
  const started = NOON - 10 * H;
  s.store.setSetting('growth-since', NOON - LEARN_MS - 11 * H);
  const rang = run(s, NOON - 10 * H, NOON, () => boot, (t) => ({ app_mem: JSON.stringify({ 'peek-auras': { mem: 100 * MB + ((t - started) / H) * 50 * MB, since: started }, calm: { mem: 40 * MB, since: started } }) }));
  assert.deepEqual(rang, [`app:peek-auras@${started}`]);
  assert.match(s.told[0], /the app peek-auras \(scheme Peek Auras\): its server rose steadily/);
  // The same climb across a restart of the app's unit doesn't ring.
  const r = setup('app-restart');
  const restart = NOON - 3 * H;
  const younger = NOON - 9 * H;
  assert.deepEqual(run(r, younger, NOON, () => boot, (t) => ({ app_mem: JSON.stringify({ x: { mem: 100 * MB + ((t - younger) / H) * 50 * MB, since: t < restart ? younger : restart } }) })), []);
});

test('an alarm between 2 and 9 AM Pacific is recorded at once and wakes the Taskmaster at 9', () => {
  const s = setup('quiet');
  const four = Date.parse('2026-11-20T12:00:00Z');
  assert.deepEqual(run(s, four - H, four, () => four - H, () => ({ supervisors: 30 })), ['bound:supervisors']);
  assert.equal(s.told.length, 0);
  assert.equal(s.store.healthEventsSince([KIND], 0).length, 1);
  run(s, four + STEP, four + 5 * H + STEP, () => four - H, () => ({ supervisors: 30 }));
  assert.equal(s.told.length, 1);
  assert.equal(s.store.healthEventsSince([KIND], 0).length, 1);
});

test('readGrowth counts fds, supervisor units, /tmp and app servers from the paths it is given', async () => {
  const d = join(root, 'cg');
  const slice = join(d, 'user@1.service', 'citadel.slice');
  mkdirSync(join(slice, 'citadel-taskmasters.slice', 'citadel-supervisor-a-1.service'), { recursive: true });
  mkdirSync(join(slice, 'citadel-taskmasters.slice', 'citadel-supervisor-b-1.service'));
  mkdirSync(join(slice, 'citadel-taskmasters.slice', 'citadel-taskmaster-2.service'));
  const app = join(d, 'user@1.service', 'contraptions.slice', 'citadel-app-mandate.service');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'memory.current'), '82000000\n');
  const fds = join(d, 'fd');
  mkdirSync(fds);
  for (const n of ['0', '1', '2']) writeFileSync(join(fds, n), '');
  const g = await readGrowth({ slice, apps: ['mandate', 'gone'], fdDir: fds, tmp: d });
  assert.equal(g.open_fds, 3);
  assert.equal(g.supervisors, 2);
  assert.ok(g.tmp_used! > 0);
  const apps = JSON.parse(g.app_mem!);
  assert.deepEqual(Object.keys(apps), ['mandate']);
  assert.equal(apps.mandate.mem, 82000000);
  assert.ok(apps.mandate.since > 0);
  // No cgroup to read (a dev box): only fds and /tmp.
  const none = await readGrowth({ slice: null, apps: ['mandate'], fdDir: fds, tmp: d });
  assert.deepEqual([none.supervisors, none.app_mem], [null, null]);
});

test('an overnight alarm that clears before 9 AM still wakes the Taskmaster at 9', () => {
  const s = setup('quiet-clears');
  const twoAm = Date.parse('2026-11-20T10:05:00Z');
  run(s, twoAm, twoAm, () => twoAm - H, () => ({ supervisors: 30 }));
  run(s, twoAm + STEP, twoAm + 7 * H, () => twoAm - H, () => ({ supervisors: 1 }));
  assert.equal(s.told.length, 1);
  assert.match(s.told[0], /30 citadel-supervisor/);
});

test('with no Taskmaster the alarm waits, and wakes one that comes back', () => {
  const store = new Store(join(root, 'no-tm.db'));
  const citadel = store.createProject('Citadel', null, null);
  const told: string[] = [];
  const deps = { store, bootAt: NOON - H, turns: () => 0, ownScheme: () => citadel.id, tell: (_: number, t: string) => void told.push(t) };
  store.addHostSample({ ...base(NOON), supervisors: 30 });
  checkGrowth(deps, NOON);
  assert.equal(told.length, 0);
  store.createTicket({ project_id: citadel.id, title: 'Taskmaster', permission_mode: 'default', created_by: store.createUser({ name: 'Cara', login: 'cara' }).id, kind: 'coordinator' });
  store.addHostSample({ ...base(NOON + STEP), supervisors: 1 });
  checkGrowth(deps, NOON + STEP);
  assert.equal(told.length, 1);
});

test("the server memory's floor is 300 MB between the first and last hours: 55 MB an hour stays quiet, 65 rings", () => {
  const climb = (mbPerHour: number) => Array.from({ length: 72 }, (_, i): [number, number] => [NOON - 6 * H + (i + 1) * STEP, 700 * MB + ((i + 1) * STEP / H) * mbPerHour * MB]);
  assert.equal(steadyRise(climb(55), NOON, FLOORS.rss), null);
  assert.ok(steadyRise(climb(65), NOON, FLOORS.rss));
});

test('in its first 3 days a rise in a new reading is recorded but wakes no one; bounds and server memory still wake', () => {
  const s = setup('learning');
  const boot = NOON - 12 * H;
  const rang = run(s, boot, NOON, () => boot, (t) => ({ open_fds: 200 + ((t - boot) / H) * 60, rss: 600 * MB + ((t - boot) / H) * 80 * MB }));
  assert.deepEqual(rang.sort(), [`fds@${boot}`, `rss@${boot}`]);
  assert.equal(s.told.length, 1);
  assert.doesNotMatch(s.told[0], /open files rose/);
  const fds = s.store.healthEventsSince([KIND], 0).map((e) => JSON.parse(e.detail)).find((g) => g.kind === 'fds');
  assert.equal(fds.learning, true);
});
