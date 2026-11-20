import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Contraptions } from '../src/contraptions.ts';
import { pacificDay } from '../src/pacific.ts';
import { HEALTH_KEEP_MS, HOST_SAMPLE_KEEP_MS, Store } from '../src/db.ts';
import { APP_ERRORS_WARN, STORM_WARN_S, StatusPage, rateTone, lastDays, recordBoot, stallSeconds, stallCauseOf } from '../src/status-page.ts';
import { BOOT_STALL } from '../src/deploy-watch.ts';
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
  assert.deepEqual(c.host.series[0].slice(1, 3), [95, 95]);
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
  going = [{ ...JSON.parse(storm(940)) }];
  c = (await page.build(viewer(store, josh.id, true), now + 2)).citadel;
  assert.deepEqual(c.verdict.reasons, [`16 min stalled at a memory limit in the last day`], 'a long stall reads in minutes');
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

test('a failed nightly backup run shows (B1): the backup service is read, not only its timer, which stays active', async () => {
  const { store, josh, citadel } = setup('backup-unit');
  const now = Date.now();
  const page = new StatusPage({ store, dataDir: root, bootAt: now - DAY, commit: 'c', ownScheme: () => citadel.id, now: () => now,
    unitStates: async (units) => units.map((unit) => ({ unit, load: 'loaded', active: unit === 'claude-coordinator-backup.service' ? 'failed' : 'active', sub: '', enabled: '' })) });
  const c = (await page.build(viewer(store, josh.id, true))).citadel;
  assert.equal(c.verdict.tone, 'bad');
  assert.ok(c.verdict.reasons.includes('claude-coordinator-backup.service failed'), c.verdict.reasons.join('; '));
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

test('the CPU tile (#1273) reads load1 from host_samples against the cores, and warns only when it stays high', async () => {
  const { store, josh, citadel } = setup('cpu');
  const now = sameDayNow();
  const s = { mem_total: 100, mem_avail: 50, disk_total: 100, disk_free: 50, rss: 1 };
  const page = new StatusPage({ store, dataDir: root, bootAt: now - DAY, commit: 'c', ownScheme: () => citadel.id, now: () => now, cores: 4 });
  store.addHostSample({ at: now - 40 * 60_000, ...s, load1: 12.34 });
  store.addHostSample({ at: now - 10 * 60_000, ...s, load1: 9 });
  store.addHostSample({ at: now - 5 * 60_000, ...s, load1: 3 });
  let c = (await page.build(viewer(store, josh.id, true))).citadel;
  assert.equal(c.host.cores, 4);
  assert.equal(c.host.cpuWarn, 8);
  assert.equal(c.host.latest?.load1, 3);
  assert.deepEqual(c.host.peak, { at: now - 40 * 60_000, load1: 12.3 });
  assert.ok(c.host.series.some((r) => r[3] === 12.3), 'the hour series carries its highest load');
  assert.ok(!c.verdict.tiles.includes('cpu'), 'one high reading in the window is not "stays high"');
  store.addHostSample({ at: now - 60_000, ...s, load1: 9 });
  store.addHostSample({ at: now - 5 * 60_000, ...s, load1: 8.5 });
  c = (await page.build(viewer(store, josh.id, true))).citadel;
  assert.ok(!c.verdict.tiles.includes('cpu'), 'high readings over 10 of the 15 minutes are not "for 15 min"');
  store.addHostSample({ at: now - 14 * 60_000, ...s, load1: 10 });
  c = (await page.build(viewer(store, josh.id, true))).citadel;
  const i = c.verdict.tiles.indexOf('cpu');
  assert.equal(c.verdict.reasons[i], 'load over 8 on 4 cores for 15 min');
  assert.equal(c.verdict.tone, 'warn');
});

test('Investigate (#1273): an app tile goes to its home scheme, and the minion quoting its tag is the one on it', async () => {
  const { store, mia, josh, peekScheme, citadel } = setup('investigate');
  let now = sameDayNow();
  const page = new StatusPage({ store, dataDir: root, bootAt: now - DAY, commit: 'c', ownScheme: () => citadel.id, now: () => now });
  const tile = { target: 'app:peek-auras', tile: 'errors', title: 'Errors', value: '12 today', sub: 'http 5xx', chart: 'errors a day: Thu 12', reasons: ['12 errors today'] };
  // Mia is only in Peek's scheme: Citadel's tiles and an app she can't see are no target of hers.
  assert.equal(page.investigate(viewer(store, mia.id), 'Mia', { ...tile, target: 'app:calm' }), null);
  assert.equal(page.investigate(viewer(store, mia.id), 'Mia', { ...tile, target: 'citadel', tile: 'memory' }), null);
  const sent = page.investigate(viewer(store, mia.id), 'Mia', tile)!;
  assert.equal((await page.build(viewer(store, mia.id))).apps[0].looks.errors, undefined, 'nothing shows until the Taskmaster has it');
  sent.record();
  assert.equal(sent.scheme, peekScheme.id);
  assert.match(sent.text, /Mia pressed Investigate on PEEK-AURAS's Errors tile/);
  assert.match(sent.text, /`status:app:peek-auras\/errors`/);
  assert.match(sent.text, /Chart: errors a day: Thu 12/);
  let app = (await page.build(viewer(store, mia.id))).apps[0];
  assert.equal(app.looks.errors.minion, null);
  assert.equal(app.looks.errors.by, 'Mia');
  // A minion in another scheme quoting the tag doesn't count; one in Peek's scheme quoting it in a message does.
  store.createTicket({ project_id: citadel.id, title: 'status:app:peek-auras/errors', permission_mode: 'default', created_by: josh.id });
  const t = store.createTicket({ project_id: peekScheme.id, title: 'Fix the 5xx', permission_mode: 'default', created_by: josh.id });
  store.addEvent(t.id, 'user_message', { text: 'Brief. Tag: status:app:peek-auras/errors' });
  now += 60_000;
  app = (await page.build(viewer(store, mia.id))).apps[0];
  assert.deepEqual(app.looks.errors.minion, { project: peekScheme.id, number: t.number, title: 'Fix the 5xx', closed: false });
  assert.equal(app.verdict.tone, 'ok', 'a look links a minion; it changes no verdict');
  // A second click adds to the open look and names its minion.
  const again = page.investigate(viewer(store, mia.id), 'Mia', tile)!;
  assert.match(again.text, new RegExp(`More on the open look.*#${t.number} Fix the 5xx is on it`));
  // Once that minion closes, it is shown as having looked, and a new click is a fresh look.
  store.updateTicket(t.id, { status: 'closed' });
  app = (await page.build(viewer(store, mia.id))).apps[0];
  assert.equal(app.looks.errors.minion?.closed, true);
  assert.match(page.investigate(viewer(store, mia.id), 'Mia', tile)!.text, /Quote the tag/);
});

test('Investigate (#1273): a Citadel tile goes to Citadel, its reason carries its tile key, and CI\'s tile adds to the CI page\'s fix minion', async () => {
  const { store, josh, mia, citadel } = setup('investigate-citadel');
  const now = sameDayNow();
  const fixer = store.createTicket({ project_id: citadel.id, title: 'Fix the red tests', permission_mode: 'default', created_by: josh.id });
  const view = { at: 1, slug: 'o/r', branch: 'main', runners: null, waiting: [], workflows: [{ name: 'tests', file: 't.yml', verdict: { id: 1, name: 'tests', branch: 'main', status: 'completed', conclusion: 'failure', at: '', url: 'u' }, skipped: [] }], runs: [] };
  const page = new StatusPage({ store, dataDir: root, bootAt: now - DAY, commit: 'c', ownScheme: () => citadel.id, now: () => now,
    mem: async () => ({ total: 100, avail: 5 }), disk: async () => ({ total: 100, free: 50 }),
    ciSnapshot: (canSee) => (canSee(citadel.id) ? [{ id: citadel.id, view: view as any, problems: [{ fixMinion: { number: fixer.number!, closed: false } }] }] : []) });
  await page.sample();
  const c = (await page.build(viewer(store, josh.id, true))).citadel;
  assert.equal(c.verdict.tiles[c.verdict.reasons.indexOf('under 10% of memory free')], 'memory');
  assert.equal(c.canInvestigate, true);
  assert.deepEqual(c.looks.ci?.minion, { project: citadel.id, number: fixer.number, title: 'Fix the red tests', closed: false });
  const memory = { target: 'citadel', tile: 'memory', title: 'Memory', value: '95% used', sub: '', chart: '', reasons: ['under 10% of memory free'] };
  const sent = page.investigate(viewer(store, josh.id, true), 'Josh', memory)!;
  assert.equal(sent.scheme, citadel.id);
  sent.record();
  // The message for CI's tile names the fix the tile shows, so the Taskmaster adds to it rather than starting another.
  assert.match(page.investigate(viewer(store, josh.id, true), 'Josh', { ...memory, tile: 'ci', title: 'CI on main' })!.text, new RegExp(`its CI fix; #${fixer.number} Fix the red tests is on it`));
  // Someone outside Citadel's scheme sees its health but not who is on it, and gets no button.
  const outside = (await page.build(viewer(store, mia.id))).citadel;
  assert.deepEqual(outside.looks, {});
  assert.equal(outside.canInvestigate, false);
});

test('host samples keep the CPU, memory and IO pressure (#1301, #1325) and swap in use, null when there was none', () => {
  const { store } = setup('psi-samples');
  const base = { mem_total: 1, mem_avail: 1, disk_total: 1, disk_free: 1, load1: 0, rss: 1 };
  store.addHostSample({ ...base, at: 1000, cpu_psi: 63, mem_psi: 4, io_psi: 16, swap_used: 2 ** 33 });
  store.addHostSample({ ...base, at: 2000 });
  const rows = store.hostSamples(0);
  assert.deepEqual(rows.map((r) => [r.cpu_psi, r.mem_psi, r.io_psi, r.swap_used]), [[63, 4, 16, 2 ** 33], [null, null, null, null]]);
});

test('a sample stores the swap the memory reading says is in use (#1325)', async () => {
  const { store, citadel } = setup('swap-sample');
  const page = new StatusPage({ store, dataDir: root, bootAt: 0, commit: 'c', ownScheme: () => citadel.id, now: () => 5000,
    mem: async () => ({ total: 100, avail: 50, swap: 7 }), disk: async () => ({ total: 100, free: 50 }) });
  assert.equal((await page.sample())!.swap_used, 7);
  assert.equal(store.hostSamples(0).at(-1)!.swap_used, 7);
});

test('a boot records why the last process ended (#1325): a ship, by hand, out of memory, or no mark at all', () => {
  const { store } = setup('stops');
  const stops = () => store.healthEventsSince(['stop'], 0).map((e) => [e.at, e.detail.split(':')[0], e.commit_sha]);
  recordBoot(store, 'aaaa1111', 1000, null);
  assert.deepEqual(stops(), [], 'the first start on record has no last process to explain');
  recordBoot(store, 'bbbb2222', 3000, { at: 2000, result: 'success', code: 'exited', status: '0' });
  recordBoot(store, 'bbbb2222', 5000, { at: 4000, result: 'success', code: 'exited', status: '0' });
  recordBoot(store, 'bbbb2222', 7000, { at: 6000, result: 'oom-kill', code: 'killed', status: 'KILL' });
  recordBoot(store, 'bbbb2222', 8000, { at: 6000, result: 'oom-kill', code: 'killed', status: 'KILL' }); // recorded already: this stop left none
  recordBoot(store, 'bbbb2222', 9000, null);
  recordBoot(store, 'bbbb2222', 11000); // a caller that can't read marks (a preview) records no stop
  assert.deepEqual(stops(), [[2000, 'deploy', 'aaaa1111'], [4000, 'by-hand', 'bbbb2222'], [6000, 'out-of-memory', 'bbbb2222'], [8000, 'unknown', 'bbbb2222'], [9000, 'unknown', 'bbbb2222']]);
});

test('the last stall says its cause in words, and a stall just after a boot is shown, marked (P2)', async () => {
  const { store, josh, citadel } = setup('stall-cause');
  const now = sameDayNow();
  store.addHealthEvent('loop-lag', now - 20 * 60_000, 'x', 'The event loop was held for 1.5 s: the server answered nobody meanwhile. Cause: waited for disk (0.1 s on CPU of 1.6 s; 0.0 s for CPU, 1.2 s for disk, 0.0 s for memory; 2 major faults, 3 voluntary and 4 involuntary switches; 5 writes queued on the write worker).');
  store.addHealthEvent(BOOT_STALL, now - 5 * 60_000, 'x', 'The event loop was held for 2.5 s: the server answered nobody meanwhile. Cause: own work (2.4 s on CPU of 2.6 s; ...).');
  const page = new StatusPage({ store, dataDir: root, bootAt: now - DAY, commit: 'c', ownScheme: () => citadel.id, now: () => now });
  const c = (await page.build(viewer(store, josh.id, true))).citadel;
  assert.equal(c.stalls.counts.at(-1), 2, 'the boot stall counts on the page');
  assert.equal(c.stalls.last?.cause, 'own work');
  assert.equal(c.stalls.last?.afterBoot, true);
  assert.equal(stallCauseOf('The event loop was held for 1.5 s: x. Cause: waited for disk (0.1 s on CPU'), 'waited for disk');
  assert.equal(stallCauseOf('The event loop was held for 1.5 s: old line'), null);
});
