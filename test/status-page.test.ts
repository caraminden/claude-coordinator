import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Contraptions } from '../src/contraptions.ts';
import { pacificDay } from '../src/contraption-errors.ts';
import { HEALTH_KEEP_MS, HOST_SAMPLE_KEEP_MS, Store } from '../src/db.ts';
import { APP_ERRORS_WARN, StatusPage, lastDays, recordBoot, stallSeconds } from '../src/status-page.ts';

const root = mkdtempSync(join(tmpdir(), 'status-page-'));
after(() => rmSync(root, { recursive: true, force: true }));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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
  const now = Date.now();
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
  const now = Date.now();
  store.addHealthEvent('loop-lag', now - 10 * 60_000, 'x', 'The event loop was held for 6.2 s: sqlite');
  store.addHealthEvent('loop-lag', now - 20 * 60_000, 'x', 'The event loop was held for 1.5 s: json');
  store.addHealthEvent('client-error', now - 20 * 60_000, 'x', 'not a stall');
  store.addRelease({ project_id: citadel.id, target: 'citadel-server', version: 'v1'.padEnd(40, '0'), changes: '[{"number":12,"title":"A fix"}]', started_at: now - 30 * 60_000, live_at: now - 28 * 60_000, outcome: 'live', stages: '{}' });
  store.addRelease({ project_id: citadel.id, target: 'citadel-server', version: 'v2'.padEnd(40, '0'), changes: '[]', started_at: now - 20 * 60_000, live_at: now - 16 * 60_000, outcome: 'live', stages: '{}' });
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
  assert.equal(c.host.series.length, 1);
  assert.deepEqual(c.host.series[0].slice(1), [95, 95]);
  assert.equal(c.verdict.tone, 'bad');
  assert.deepEqual(c.verdict.reasons, ['claude-coordinator-prune.timer failed', 'a 6.2 s stall in the last day', 'under 10% of memory free', 'under 10% of disk free']);
  assert.ok(c.slots.some((s) => s.key === 'backups') && c.slots.some((s) => s.key === 'ship-time') && c.slots.some((s) => s.key === 'line'));
});

test('a viewer outside Citadel sees its health but not its CI', async () => {
  const { store, mia, citadel } = setup('ci');
  const view = { at: 1, slug: 'o/r', branch: 'main', runners: null, waiting: [], workflows: [{ name: 'tests', file: 't.yml', verdict: { id: 1, name: 'tests', branch: 'main', status: 'completed', conclusion: 'failure', at: '', url: 'u' }, skipped: [] }], runs: [] };
  const page = new StatusPage({ store, dataDir: root, bootAt: Date.now(), commit: 'c', ownScheme: () => citadel.id,
    ciSnapshot: (canSee) => (canSee(citadel.id) ? [{ id: citadel.id, view: view as any }] : []) });
  assert.equal((await page.build(viewer(store, mia.id))).citadel.ci, null);
  const admin = (await page.build({ canSee: () => true, admin: true, key: 'a' })).citadel;
  assert.equal(admin.ci?.workflows[0].conclusion, 'failure');
  assert.deepEqual(admin.verdict.reasons, ['CI red on main: tests']);
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
