import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Contraptions } from '../src/contraptions.ts';
import { pacificDay } from '../src/pacific.ts';
import { HEALTH_KEEP_MS, HOST_SAMPLE_KEEP_MS, Store } from '../src/db.ts';
import { APP_ERRORS_WARN, STORM_WARN_S, StatusPage, rateTone, lastDays, recordBoot, stallSeconds } from '../src/status-page.ts';
import type { Storm } from '../src/memory-storms.ts';

const root = mkdtempSync(join(tmpdir(), 'status-page-'));
// A database backup that is never stale for these tests' clocks, so the backups line stays out of their verdicts.
mkdirSync(join(root, 'backups'));
writeFileSync(join(root, 'backups', 'coordinator-2026-11-19.db'), 'x');
utimesSync(join(root, 'backups', 'coordinator-2026-11-19.db'), new Date('2100-01-01'), new Date('2100-01-01'));
after(() => rmSync(root, { recursive: true, force: true }));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Now, pushed past 1:30 AM Pacific when earlier, so readings up to an hour old fall in today (CI ran this at 00:23 and they didn't).
function sameDayNow() {
  const t = Date.now();
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t).split(':').map(Number);
  return t + Math.max(0, 90 - (h * 60 + m)) * 60_000;
}

function setup(name: string) {
  const store = new Store(join(root, `${name}.db`));
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const mia = store.createUser({ name: 'Mia', login: 'mia' });
  const other = store.createProject('Other', null, josh.id);
  // Scheme 2 is Citadel's (GLOBAL_OWNER: its members see every scheme).
  const citadel = store.createProject('Citadel', null, josh.id);
  // A scheme that isn't Citadel's, with its own app: Mia is only in it.
  const peekScheme = store.createProject('Peek Auras', null, josh.id);
  store.addMember(peekScheme.id, mia.id);
  const c = new Contraptions(store, 's'.repeat(40), join(root, `${name}-keys`));
  const reg = (n: string, home: number | null) => c.register({ name: n, title: n.toUpperCase(), port: 9200 + n.length, icon: null, home_scheme: home, open_paths: '[]', default_model: null, turn_cap: null });
  const peek = reg('peek-auras', peekScheme.id);
  reg('calm', other.id);
  reg('orphan', null);
  return { store, josh, mia, citadel, peekScheme, other, peek };
}

const viewer = (store: Store, uid: number, admin = false) => ({ canSee: (id: number) => store.canSee({ uid, admin }, id), admin, key: String(uid) });

test('lastDays: the 8 Pacific days ending today, oldest first', () => {
  const now = Date.parse('2026-11-19T20:00:00Z');
  const days = lastDays(now);
  assert.equal(days.length, 8);
  assert.equal(days.at(-1), '2026-11-19');
  assert.equal(days[0], '2026-11-12');
  // Across the November DST change, still 8 different days ending today.
  const dst = lastDays(Date.parse('2026-11-03T07:30:00Z'));
  assert.equal(new Set(dst).size, 8);
  assert.equal(dst.at(-1), pacificDay(Date.parse('2026-11-03T07:30:00Z')));
});

test('stallSeconds reads the stall line', () => {
  assert.equal(stallSeconds('The event loop was held for 2.3 s: sqlite'), 2.3);
  assert.equal(stallSeconds('The event loop was held for 750 ms'), 0.75);
  assert.equal(stallSeconds('something else'), null);
});

test('a member of another scheme sees only their own apps; an admin sees all, the homeless one too', async () => {
  const { store, josh, mia } = setup('scope');
  const page = new StatusPage({ store, dataDir: root, bootAt: Date.now(), commit: 'abc', ownScheme: () => null });
  const mine = await page.build(viewer(store, mia.id));
  assert.deepEqual(mine.apps.map((a) => a.name), ['peek-auras']);
  const all = await page.build(viewer(store, josh.id, true));
  assert.deepEqual(all.apps.map((a) => a.name).sort(), ['calm', 'orphan', 'peek-auras']);
});

test("an app's week: deploys, errors, turns and who ran them, per day, and its verdict", async () => {
  const { store, mia, peek } = setup('vitals');
  const now = sameDayNow();
  const today = pacificDay(now);
  store.addContraptionDeploy({ name: 'peek-auras', from_sha: null, to_sha: 'a'.repeat(40), by: 'Mia', started_at: now - 2 * DAY, finished_at: now - 2 * DAY + 60_000, outcome: 'deployed', stages: '{}', changes: '[]' });
  store.addContraptionDeploy({ name: 'peek-auras', from_sha: null, to_sha: 'b'.repeat(40), by: 'Mia', started_at: now - HOUR, finished_at: now - HOUR + 120_000, outcome: 'failed', stages: '{}', changes: '[]' });
  store.addContraptionDeploy({ name: 'peek-auras', from_sha: null, to_sha: 'c'.repeat(40), by: 'Mia', started_at: now - 30 * DAY, finished_at: now - 30 * DAY + 1000, outcome: 'deployed', stages: '{}', changes: '[]' });
  for (let i = 0; i < APP_ERRORS_WARN; i++) store.addContraptionError(peek.id, today, 'http 5xx', 'GET /x', 'boom', now - 60_000);
  store.addContraptionError(peek.id, today, 'tool', 'search', 'no tool', now - 60_000);
  const t = store.startContraptionTurn(peek.id, mia.id, 's1');
  store.endContraptionTurn(t, 'done', { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 });
  const page = new StatusPage({ store, dataDir: root, bootAt: now, commit: 'abc', ownScheme: () => null, now: () => now,
    unitStates: async (units) => units.map((unit) => ({ unit, load: 'loaded', active: 'active', sub: 'running', enabled: 'enabled' })) });
  const app = (await page.build(viewer(store, mia.id))).apps[0];
  assert.equal(app.deploys.counts.at(-1), 1);
  assert.equal(app.deploys.counts.reduce((x, y) => x + y), 2, 'the deploy a month ago is outside the week');
  assert.equal(app.deploys.failed.at(-1), 1);
  assert.equal(app.deploys.median, 90);
  assert.equal(app.deploys.longest, 120);
  assert.equal(app.deploys.last?.outcome, 'failed');
  assert.equal(app.errors.counts.at(-1), APP_ERRORS_WARN + 1);
  assert.deepEqual(app.errors.kinds, { 'http 5xx': APP_ERRORS_WARN, tool: 1 });
  assert.equal(app.errors.top[0].count, APP_ERRORS_WARN);
  assert.equal(app.turns.counts.at(-1), 1);
  assert.equal(app.turns.tokens.at(-1), 115);
  assert.deepEqual(app.turns.people, [{ name: 'Mia', turns: 1 }]);
  assert.equal(app.verdict.tone, 'bad');
  assert.deepEqual(app.verdict.reasons, ['its last deploy failed', `${APP_ERRORS_WARN + 1} errors in the last day`]);
});

test("an app whose service stopped is bad; a quiet one is ok", async () => {
  const { store, mia } = setup('service');
  const page = new StatusPage({ store, dataDir: root, bootAt: Date.now(), commit: 'abc', ownScheme: () => null,
    unitStates: async (units) => units.map((unit) => ({ unit, load: 'loaded', active: unit.includes('peek') ? 'failed' : 'active', sub: '', enabled: '' })) });
  const app = (await page.build(viewer(store, mia.id))).apps[0];
  assert.equal(app.verdict.tone, 'bad');
  assert.deepEqual(app.verdict.reasons, ['its service is failed']);
  const fine = new StatusPage({ store, dataDir: root, bootAt: Date.now(), commit: 'abc', ownScheme: () => null });
  assert.equal((await fine.build(viewer(store, mia.id))).apps[0].verdict.tone, 'ok');
});

test('boots say why: a ship when the code changed, else a restart on the same code, which warns', async () => {
  const { store, josh, citadel } = setup('boots');
  const now = Date.now();
  assert.equal(recordBoot(store, 'aaaa1111', now - 3 * HOUR), 'first start on record');
  assert.match(recordBoot(store, 'bbbb2222', now - 2 * HOUR), /^a ship: new code bbbb2222/);
  assert.match(recordBoot(store, 'bbbb2222', now - HOUR), /^a restart on the same code/);
  const page = new StatusPage({ store, dataDir: root, bootAt: now - HOUR, commit: 'bbbb2222', ownScheme: () => citadel.id, now: () => now });
  const c = (await page.build(viewer(store, josh.id, true))).citadel;
  assert.match(c.uptime.reason ?? '', /^a restart on the same code/);
  assert.equal(c.uptime.restarts.at(-1) + c.uptime.restarts.at(-2)!, 3);
  assert.equal(c.verdict.tone, 'warn');
  assert.deepEqual(c.verdict.reasons, ['1 restart without a ship in the last day']);
});

test("Citadel's stalls per day with the longest, ships per day with their median, memory and disk hourly", async () => {
  const { store, josh, citadel } = setup('citadel');
  const now = sameDayNow();
  store.addHealthEvent('loop-lag', now - 10 * 60_000, 'x', 'The event loop was held for 6.2 s: sqlite');
  store.addHealthEvent('loop-lag', now - 20 * 60_000, 'x', 'The event loop was held for 1.5 s: json');
  store.addHealthEvent('client-error', now - 20 * 60_000, 'x', 'not a stall');
  store.addRelease({ project_id: citadel.id, target: 'citadel-server', version: 'v2'.padEnd(40, '0'), changes: '[]', started_at: now - 20 * 60_000, live_at: now - 16 * 60_000, outcome: 'live', stages: '{}' });
  store.addRelease({ project_id: citadel.id, target: 'citadel-server', version: 'v1'.padEnd(40, '0'), changes: '[{"number":12,"title":"A fix"}]', started_at: now - 30 * 60_000, live_at: now - 28 * 60_000, outcome: 'live', stages: '{}' });
  store.addRelease({ project_id: citadel.id, target: 'citadel-server', version: 'v3'.padEnd(40, '0'), changes: '[]', started_at: now - 5 * 60_000, live_at: null, outcome: 'failed', stages: '{}' });
  let mem = { total: 100, avail: 50 };
  const page = new StatusPage({ store, dataDir: root, bootAt: now - DAY, commit: 'c', ownScheme: () => citadel.id, now: () => now,
    mem: async () => mem, disk: async () => ({ total: 1000, free: 50 }),
    unitStates: async (units) => units.map((unit) => ({ unit, load: unit === 'citadel-android-adb.service' ? 'not-found' : 'loaded', active: unit === 'claude-coordinator-prune.timer' ? 'failed' : 'active', sub: '', enabled: '' })) });
  await page.sample();
  mem = { total: 100, avail: 5 };
  await page.sample(); // same `at`: replaces the first
  const c = (await page.build(viewer(store, josh.id, true))).citadel;
  assert.equal(c.stalls.counts.at(-1), 2);
  assert.equal(c.stalls.longest.at(-1), 6.2);
  assert.match(c.stalls.last?.detail ?? '', /6\.2 s/);
  assert.equal(c.ships.counts.at(-1), 2, 'the failed release is no ship');
  assert.equal(c.ships.median.at(-1), 180);
  assert.equal(c.ships.last?.version, 'v2000000', 'the last ship is the newest live one, not the newest row');
  assert.equal(c.host.series.length, 1);
  assert.deepEqual(c.host.series[0].slice(1), [95, 95]);
  assert.equal(c.verdict.tone, 'bad');
  assert.deepEqual(c.verdict.reasons, ['claude-coordinator-prune.timer failed', 'a 6.2 s stall in the last day', 'under 10% of memory free', 'under 10% of disk free']);
  assert.ok(c.slots.some((s) => s.key === 'line') && !c.slots.some((s) => s.key === 'backups'), 'the backups slot became the real tile');
  assert.deepEqual(c.backup.problems, []);
});

test('memory-limit storms (#1280): per day with their stalled seconds, the last one, those going now, and a warn past STORM_WARN_S', async () => {
  const { store, josh, citadel } = setup('storms');
  const now = sameDayNow();
  const storm = (stalled: number) => JSON.stringify({ group: 'citadel-turns.slice', seconds: 120, stalled, highs: 9000, peak: 0.8, limit: 10_737_418_240, unit: 'citadel-land-a-1.service', unitBytes: 2.4e9 });
  store.addHealthEvent('memory-high', now - 30 * 60_000, 'x', storm(20));
  store.addHealthEvent('memory-high', now - 10 * 60_000, 'x', storm(25));
  store.addHealthEvent('memory-high', now - 9 * 60_000, 'x', 'not json');
  let going: Storm[] = [];
  const page = new StatusPage({ store, dataDir: root, bootAt: now - DAY, commit: 'c', ownScheme: () => citadel.id, now: () => now, storms: () => going });
  let c = (await page.build(viewer(store, josh.id, true))).citadel;
  assert.equal(c.storms.counts.at(-1), 2);
  assert.equal(c.storms.stalled.at(-1), 45);
  assert.equal(c.storms.last?.unit, 'citadel-land-a-1.service');
  assert.deepEqual(c.verdict.reasons, [], '45 s is under the line');
  going = [{ ...JSON.parse(storm(30)) }];
  c = (await page.build(viewer(store, josh.id, true), now + 1)).citadel;
  assert.equal(c.storms.now.length, 1);
  assert.deepEqual(c.verdict.reasons, [`75 s stalled at a memory limit in the last day`], `a storm going now counts toward ${STORM_WARN_S} s`);
});

test('a viewer outside Citadel sees its health but not its CI', async () => {
  const { store, mia, citadel } = setup('ci');
  const view = { at: 1, slug: 'o/r', branch: 'main', runners: null, waiting: [], workflows: [{ name: 'tests', file: 't.yml', verdict: { id: 1, name: 'tests', branch: 'main', status: 'completed', conclusion: 'failure', at: '', url: 'u' }, skipped: [] }], runs: [] };
  const page = new StatusPage({ store, dataDir: root, bootAt: Date.now(), commit: 'c', ownScheme: () => citadel.id,
    ciSnapshot: (canSee) => (canSee(citadel.id) ? [{ id: citadel.id, view: view as any }] : []) });
  store.addRelease({ project_id: citadel.id, target: 'citadel-server', version: 'v1'.padEnd(40, '0'), changes: '[{"number":12,"title":"A private fix"}]', started_at: Date.now() - 60_000, live_at: Date.now() - 30_000, outcome: 'live', stages: '{}' });
  const outside = (await page.build(viewer(store, mia.id))).citadel;
  assert.deepEqual(outside.ships.last?.changes, [], 'what shipped is only for people who can see Citadel\'s scheme');
  assert.equal(outside.ci, null);
  assert.equal(outside.ciVisible, false, 'the page says "not yours to see", not "no reading yet"');
  const admin = (await page.build({ canSee: () => true, admin: true, key: 'a' })).citadel;
  assert.equal(admin.ci?.workflows[0].conclusion, 'failure');
  assert.equal(admin.ciVisible, true);
  assert.equal(admin.ships.last?.changes.length, 1);
  assert.deepEqual(admin.verdict.reasons, ['CI red on main: tests'], 'too few main runs to rate: main\'s newest red verdict is yellow, as it was');
  assert.equal(admin.ci?.tone, 'warn');
});

test('the CI share counts only main\'s runs of workflows that ring, not other branches or quiet workflows', async () => {
  const { store, citadel } = setup('cishare');
  const run = (id: number, branch: string, conclusion: string, name = 'tests') => ({ id, name, branch, status: 'completed', conclusion, at: '', url: 'u' });
  const verdict = (conclusion: string) => ({ id: 1, name: 'tests', branch: 'main', status: 'completed', conclusion, at: '', url: 'u' });
  const build = async (workflows: any[], runs: any[]) => {
    const view = { at: 1, slug: 'o/r', branch: 'main', runners: null, waiting: [], workflows, runs };
    const page = new StatusPage({ store, dataDir: root, bootAt: Date.now(), commit: 'c', ownScheme: () => citadel.id, ciSnapshot: () => [{ id: citadel.id, view: view as any }] });
    return (await page.build({ canSee: () => true, admin: true, key: 'a' })).citadel;
  };
  const tests = { name: 'tests', file: 't.yml', skipped: [] };
  const lands = Array.from({ length: 9 }, (_, i) => run(10 + i, `land/b${i}`, 'failure'));
  const green = await build([{ ...tests, verdict: verdict('success') }], [...lands, ...[1, 2, 3, 4, 5].map((i) => run(i, 'main', 'success'))]);
  assert.equal(green.ci?.tone, 'ok');
  assert.equal(green.ci?.runs, 5, 'only main\'s runs');
  assert.equal(green.verdict.tone, 'ok');
  const quiet = await build([{ ...tests, verdict: verdict('success') }, { name: 'nightly', file: 'n.yml', skipped: [], quiet: true, verdict: null }],
    [...[1, 2, 3, 4, 5].map((i) => run(i, 'main', 'success')), ...[6, 7, 8, 9, 10].map((i) => run(i, 'main', 'failure', 'nightly'))]);
  assert.equal(quiet.ci?.runs, 5, 'a quiet workflow\'s runs are left out');
  assert.equal(quiet.ci?.tone, 'ok');
  const few = await build([{ ...tests, verdict: verdict('failure') }], [run(1, 'main', 'failure'), run(2, 'main', 'success'), ...lands]);
  assert.equal(few.ci?.tone, 'warn', 'under 5 main runs, newest red: yellow');
  const many = await build([{ ...tests, verdict: verdict('success') }], [1, 2, 3, 4, 5, 6, 7].map((i) => run(i, 'main', i <= 3 ? 'failure' : 'success')));
  assert.equal(many.ci?.tone, 'bad', '3 of 7 is over 30%');
});

test('health readings and host samples are kept a week and a day', () => {
  assert.equal(HEALTH_KEEP_MS, 8 * DAY);
  assert.equal(HOST_SAMPLE_KEEP_MS, 8 * DAY);
  const { store } = setup('keep');
  const s = { mem_total: 1, mem_avail: 1, disk_total: 1, disk_free: 1, load1: 0, rss: 1 };
  store.addHostSample({ at: 1000, ...s });
  store.addHostSample({ at: 1000 + 9 * DAY, ...s });
  assert.deepEqual(store.hostSamples(0).map((r) => r.at), [1000 + 9 * DAY]);
});

test('a failed read of the units warns and is asked again, not cached as "none running"', async () => {
  const { store, josh, citadel } = setup('units');
  let fail = true;
  let now = Date.now();
  const page = new StatusPage({ store, dataDir: root, bootAt: now - DAY, commit: 'c', ownScheme: () => citadel.id, now: () => now,
    unitStates: async (units) => { if (fail) throw new Error('systemctl: no bus'); return units.map((unit) => ({ unit, load: 'loaded', active: 'failed', sub: 'failed', enabled: '' })); } });
  const first = (await page.build(viewer(store, josh.id, true))).citadel;
  assert.equal(first.unitsFailed, true);
  assert.ok(first.verdict.reasons.includes("its services couldn't be read"));
  fail = false;
  now += 1000;
  const second = (await page.build(viewer(store, josh.id, true))).citadel;
  assert.equal(second.unitsFailed, false);
  assert.equal(second.verdict.tone, 'bad', 'the next read, inside the cache minute, asks again and sees the failed units');
});

test('boot rows outlive the row cap: only the time keep drops them', () => {
  const { store } = setup('cap');
  const now = Date.now();
  store.addHealthEvent('boot', now - DAY, 'a', 'a ship: new code a');
  for (let i = 0; i < 5100; i++) store.addHealthEvent('client-error', now - 1000 + (i % 100), 'a', 'x');
  assert.equal(store.healthEventsSince(['boot'], 0).length, 1);
});

test('time to ship (#1132): per-day median and p90 per target, for Citadel and for an app, and a viewer sees only theirs', async () => {
  const { store, citadel, mia, josh } = setup('shiptime');
  const now = Date.parse('2026-11-19T20:00:00Z');
  const rel = (took: number, ago: number) => store.addRelease({ project_id: citadel.id, target: 'citadel-server', version: 'v'.padEnd(40, '1'), changes: '[]', started_at: now - ago - took * 1000, live_at: now - ago, outcome: 'live', stages: '{"line":10,"test":50}' });
  for (const t of [60, 120, 180, 240, 300, 360, 420, 480, 540, 5000]) rel(t, 1000 * t);
  rel(100, 2 * DAY);
  store.addContraptionDeploy({ name: 'peek-auras', from_sha: null, to_sha: 'a'.repeat(40), by: 'Mia', started_at: now - 3 * HOUR, finished_at: now - 3 * HOUR + 90_000, outcome: 'deployed', stages: '{"build":30,"restart":60}', changes: '[]' });
  const page = new StatusPage({ store, dataDir: root, bootAt: now, commit: 'abc', ownScheme: () => citadel.id, now: () => now });
  const all = await page.build(viewer(store, josh.id, true));
  const main = all.shipTimes.find((t) => t.key === `release:${citadel.id}:citadel-server`)!;
  assert.equal(main.counts.at(-2) + main.counts.at(-1) >= 10, true);
  assert.equal(main.p90.at(-1), 540, 'nearest-rank p90 of 10 ships: the 9th');
  assert.equal(main.ships.some((s) => s.took === 5000), true, 'the slow one is in the ships a click opens');
  assert.deepEqual(main.ships.at(-1)!.stages, { line: 10, test: 50 });
  const peek = all.shipTimes.find((t) => t.key === 'app:peek-auras')!;
  assert.equal(peek.median.at(-1), 90);
  assert.deepEqual(peek.ships[0].stages, { build: 30, restart: 60 });
  const mine = await page.build(viewer(store, mia.id));
  assert.deepEqual(mine.shipTimes.map((t) => t.key).filter((k) => k.startsWith('app:')), ['app:peek-auras']);
});

test('time to ship (#1132): a slow day sends exactly one nudge per target per day, none for a quick one', async () => {
  const { store, citadel, peek } = setup('shipnudge');
  let now = Date.parse('2026-11-19T20:00:00Z');
  const told: [number, string][] = [];
  const page = new StatusPage({ store, dataDir: root, bootAt: now, commit: 'abc', ownScheme: () => citadel.id, now: () => now, tell: (id, text) => told.push([id, text]) });
  store.addRelease({ project_id: citadel.id, target: 'citadel-server', version: 'q'.repeat(40), changes: '[]', started_at: now - 400_000, live_at: now - 100_000, outcome: 'live', stages: '{}' });
  assert.equal(page.nudgeSlowShips(), 0, 'a 5 minute ship is fine');
  store.addRelease({ project_id: citadel.id, target: 'citadel-server', version: 's'.repeat(40), changes: '[]', started_at: now - 4_000_000, live_at: now - 1_000_000, outcome: 'live', stages: '{}' });
  store.addContraptionDeploy({ name: 'peek-auras', from_sha: null, to_sha: 'a'.repeat(40), by: 'Mia', started_at: now - 2_000_000, finished_at: now - 1_000_000, outcome: 'deployed', stages: '{}', changes: '[]' });
  assert.equal(page.nudgeSlowShips(), 2, 'Citadel main and the app, one each');
  assert.deepEqual(told.map(([id]) => id).sort(), [citadel.id, peek.home_scheme!].sort());
  now += 5 * 60_000;
  assert.equal(page.nudgeSlowShips(), 0, 'the same day again: nothing');
  store.addRelease({ project_id: citadel.id, target: 'citadel-server', version: 't'.repeat(40), changes: '[]', started_at: now - 5_000_000, live_at: now - 10_000, outcome: 'live', stages: '{}' });
  assert.equal(page.nudgeSlowShips(), 0, 'one more slow ship that day: still nothing');
  now += DAY;
  assert.equal(page.nudgeSlowShips(), 0, 'tomorrow has no slow ship yet');
});

test('a missed night turns the Citadel verdict red and names what is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-backup-'));
  const { store } = setup('backup');
  const page = new StatusPage({ store, dataDir: dir, home: dir, bootAt: Date.now(), commit: 'abc', ownScheme: () => null });
  const data = await page.build({ canSee: () => true, admin: true, key: 'k' });
  assert.equal(data.citadel.verdict.tone, 'bad');
  assert.ok(data.citadel.verdict.reasons.includes('backups: no database backup on disk'));
  rmSync(dir, { recursive: true, force: true });
});

test('failure share sets the colour: one failure in many stays green, then yellow, then red', () => {
  assert.equal(rateTone(1, 20), 'ok', '1 in 20 is green');
  assert.equal(rateTone(1, 2), 'ok', 'a single failure never colours, however small the window');
  assert.equal(rateTone(2, 4), 'ok', 'under the minimum count of runs');
  assert.equal(rateTone(2, 20), 'warn', '10% is yellow');
  assert.equal(rateTone(5, 20), 'warn');
  assert.equal(rateTone(6, 20), 'bad', '30% is red');
  assert.equal(rateTone(0, 0), 'ok');
});

test('CI with one failed run in twenty leaves the verdict green; six in twenty is red', async () => {
  const { store, citadel } = setup('cirate');
  const mk = (bad: number) => ({ at: 1, slug: 'o/r', branch: 'main', runners: null, waiting: [], workflows: [], runs: Array.from({ length: 20 }, (_, i) => ({ name: 'tests', branch: 'main', status: 'completed', conclusion: i < bad ? 'failure' : 'success' })) });
  let bad = 1;
  const page = new StatusPage({ store, dataDir: root, bootAt: Date.now(), commit: 'c', ownScheme: () => citadel.id, now: () => Date.now() + bad * 60_000,
    ciSnapshot: () => [{ id: citadel.id, view: mk(bad) as any }] });
  const admin = { canSee: () => true, admin: true, key: 'a' };
  assert.equal((await page.build(admin)).citadel.verdict.tone, 'ok');
  bad = 6;
  const c = (await page.build(admin)).citadel;
  assert.equal(c.verdict.tone, 'bad');
  assert.deepEqual(c.verdict.reasons, ['6 of the last 20 CI runs failed']);
});
