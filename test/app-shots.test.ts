import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AppShots, RUN_MS, type Apps } from '../src/app-shots.ts';
import { Store } from '../src/db.ts';
import { problems, type AppNight, type Night, type Shot } from '../src/shot-judge.ts';
import { agreed, compare, prune, tooBusy } from '../tools/app-shots/app-shots.ts';
import { renderPage, writePages } from '../tools/app-shots/page.ts';

// The nightly contraption screenshots (#1783; Cara, 2026-11-24): a run a night, off-peak, and the owning scheme's
// Taskmaster told when a page broke. The run itself is a stand-in here; the scheme is never Citadel's.
const root = mkdtempSync(join(tmpdir(), 'app-shots-'));
after(() => rmSync(root, { recursive: true, force: true }));

const CITADEL = 1;
const MIN = 60_000;
/** A clock time in Pacific standard time. */
const pst = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h + 8, m);
const dayName = (day: number) => `2026-11-${day}`;

const shot = (o: Partial<Shot> = {}): Shot => ({ page: '/', width: 1440, file: null, thumb: null, status: 200, text: 'A page', errors: [], flat: 0.8, moved: 0, was: null, since: null, failed: null, ...o });
const blank = { flat: 1, text: '' };
/** A one-pixel picture. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let n = 0;
function world() {
  const store = new Store(join(root, `db-${n}.db`));
  store.createProject('Citadel', null);
  const delve = store.createProject('Delve', null);
  store.createContraption({
    name: 'demo',
    title: 'Demo',
    icon: null,
    port: 9,
    home_scheme: delve.id,
    open_paths: '[]',
    relay_paths: '[]',
    repo: null,
    branch: null,
    folder: null,
    default_model: null,
    turn_cap: null,
    static_paths: null,
    restart_risk: 'unassessed',
    restart_note: '',
    subdir: null,
    identity_public: 'x',
    identity_private: 'x',
    key_hash: `k${n}`,
    keys_at: 0,
  });
  const dir = join(root, `nights-${n++}`);
  const w = {
    store,
    dir,
    delve: delve.id,
    now: pst(20, 5, 10),
    alive: false,
    said: [] as ['wake' | 'mail' | 'report', number, string][],
    started: [] as string[],
    killed: [] as number[],
    deliver: true,
    watching: false,
    shots: null as unknown as AppShots,
    boot() {
      w.shots = new AppShots(store, {
        dir,
        home: root,
        sharedDir: (id) => join(root, 'shared', String(id)),
        citadel: () => CITADEL,
        wake: (s, t) => w.deliver && (w.said.push(['wake', s, t]), true),
        mail: (s, t) => w.deliver && (w.said.push(['mail', s, t]), true),
        report: (s, t) => w.deliver && (w.said.push(['report', s, t]), true),
        watching: w.watching,
        start: async (o) => (w.started.push(o.day), (w.alive = true), 100 + w.started.length),
        alive: async () => w.alive,
        kill: (pid) => (w.killed.push(pid), (w.alive = false)),
        now: () => w.now,
      });
    },
    async at(t: number) {
      w.now = t;
      await w.shots.tick();
    },
    /** The run of a day ends with these apps. */
    ends(day: number, apps: Partial<AppNight>[], kit = 'k1') {
      w.alive = false;
      const night: Night = { day: dayName(day), startedAt: 0, endedAt: 0, kit, apps: apps.map((a) => ({ app: 'demo', title: 'Demo', scheme: delve.id, head: 'aaa', kit: 'k1', skipped: null, unshot: null, boot: null, once: [], shots: [shot()], found: ['/'], gone: [], goneSince: null, called: [], ...a })) };
      mkdirSync(join(dir, night.day), { recursive: true });
      writeFileSync(join(dir, night.day, 'night.json'), JSON.stringify(night));
    },
    /** A whole night: started at 5:10 AM, in by 5:15, told by 9:05; what was said. */
    async night(day: number, apps: Partial<AppNight>[], kit?: string) {
      const before = w.said.length;
      await w.at(pst(day, 5, 10));
      w.ends(day, apps, kit);
      await w.at(pst(day, 5, 15));
      assert.equal(w.said.length, before, 'nothing is said at 5 AM');
      await w.at(pst(day, 9, 5));
      return w.said.slice(before);
    },
  };
  w.boot();
  return w;
}

test('one run a night, between 5 and 8 AM Pacific, the first one too', async () => {
  const w = world();
  for (const t of [pst(19, 14), pst(20, 4, 59)]) await w.at(t);
  assert.deepEqual(w.started, []);
  await w.at(pst(20, 5, 1));
  assert.deepEqual(w.started, ['2026-11-20']);
  w.ends(20, [{}]);
  for (const t of [pst(20, 14, 5), pst(20, 23), pst(21, 4, 59)]) await w.at(t);
  assert.equal(w.started.length, 1);
  await w.at(pst(21, 5, 1));
  w.ends(21, [{}]);
  for (const t of [pst(21, 5, 6), pst(21, 7), pst(22, 8, 1), pst(22, 15)]) await w.at(t);
  assert.deepEqual(w.started, ['2026-11-20', '2026-11-21']);
});

test('the run is given every contraption, its home scheme and where its page goes', async () => {
  const w = world();
  await w.at(pst(20, 5, 1));
  const apps: Apps = JSON.parse(readFileSync(join(w.dir, 'apps.json'), 'utf8'));
  assert.deepEqual(
    apps.apps.map((a) => [a.app, a.scheme, a.page]),
    [['demo', w.delve, join(root, 'shared', String(w.delve), 'reports/app-shots')]],
  );
  assert.equal(apps.all, join(root, 'shared', String(CITADEL), 'reports/app-shots'));
});

test("a broken page wakes its own scheme's Taskmaster once, after 9 AM, stays quiet while it stays, and is told again if it comes back", async () => {
  const w = world();
  assert.deepEqual(await w.night(20, [{}]), []);
  const broke = [{ shots: [shot(blank), shot({ page: '/list', errors: ['TypeError: boom'] })] }];
  const [first, ...rest] = await w.night(21, broke);
  assert.deepEqual(rest, []);
  assert.deepEqual(first.slice(0, 2), ['wake', w.delve]);
  assert.match(first[2], /Demo \(demo\):\n- Front page \(desktop\): blank\n- \/list \(desktop\): a console error: TypeError: boom/);
  assert.deepEqual(await w.night(22, broke), []);
  assert.deepEqual(await w.night(23, [{}]), []);
  assert.equal((await w.night(24, broke)).length, 1);
});

test('a layout change wakes unless the app shipped since or Citadel UI changed, which is held mail; it is told each time it moves', async () => {
  const w = world();
  await w.night(20, [{}]);
  const moved = (since: Shot['since'], o = {}) => ({ shots: [shot({ moved: 0.7, since })], ...o });
  const [a] = await w.night(21, [moved(null)]);
  assert.equal(a[0], 'wake');
  assert.match(a[2], /70% of what it shows looks different from the night before, and nothing shipped since/);
  const [b] = await w.night(22, [moved('ship', { head: 'bbb0000000' })]);
  assert.equal(b[0], 'mail');
  assert.match(b[2], /it shipped since \(now bbb000000\)/);
  const [c] = await w.night(23, [moved('kit')]);
  assert.equal(c[0], 'mail');
  assert.match(c[2], /Citadel UI's own files changed/);
  // A page whose link is gone is the same.
  const [d] = await w.night(24, [{ gone: ['/plan'] }]);
  assert.equal(d[0], 'wake');
  assert.match(d[2], /- \/plan: its link or button is gone since the night before, and nothing shipped since/);
  assert.equal((await w.night(25, [{ gone: ['/list'], goneSince: 'ship' }]))[0][0], 'mail');
  // A break is a break, ship or not.
  assert.equal((await w.night(26, [{ shots: [shot({ ...blank, since: 'ship' })] }]))[0][0], 'wake');
});

test("an app with no home scheme goes to Citadel's Taskmaster", async () => {
  const w = world();
  const [m] = await w.night(20, [{ scheme: null, boot: 'no module x', shots: [] }]);
  assert.deepEqual(m.slice(0, 2), ['wake', CITADEL]);
  assert.match(m[2], /The app: its copy didn't start: no module x/);
});

test("the run's own failure on an app is Citadel's held mail, and leaves what is open for the app alone", async () => {
  const w = world();
  assert.equal((await w.night(20, [{ shots: [shot(blank)] }])).length, 1);
  const said = await w.night(21, [{ unshot: 'no answer in 4 min', shots: [] }]);
  assert.deepEqual(
    said.map((m) => m.slice(0, 2)),
    [['report', CITADEL]],
  );
  assert.match(said[0][2], /couldn't be shot: no answer in 4 min/);
  assert.deepEqual(await w.night(22, [{ shots: [shot(blank)] }]), []);
});

test('what was only noted while watching is told once the judge acts, if it is still broken, and the run’s own failure is told all along', async () => {
  const w = world();
  w.watching = true;
  w.boot();
  const bad = { app: 'demo', shots: [shot(blank)] };
  const other = { app: 'other', title: 'Other', shots: [shot(blank)] };
  assert.equal((await w.night(20, [bad, other])).length, 1, 'noted once');
  assert.deepEqual(
    (await w.night(21, [bad, { app: 'other' }, { app: 'third', unshot: 'no answer', shots: [] }])).map((m) => m[0]),
    ['report'],
  );
  w.watching = false;
  w.boot();
  await w.at(pst(21, 10));
  const [m, ...more] = w.said.slice(2);
  assert.deepEqual([m.slice(0, 2), more], [['wake', w.delve], []]);
  assert.match(m[2], /Demo/);
  assert.doesNotMatch(m[2], /Other/);
  await w.at(pst(21, 11));
  assert.equal(w.said.length, 3, 'and once only');
});

test('what could not be delivered is owed until it is, and a restart of the server forgets nothing', async () => {
  const w = world();
  w.deliver = false;
  assert.deepEqual(await w.night(20, [{ shots: [shot(blank)] }]), []);
  w.boot();
  w.deliver = true;
  await w.at(pst(20, 9, 10));
  await w.at(pst(20, 9, 15));
  assert.equal(w.said.length, 1);
  assert.equal(w.started.length, 1);
});

test('the mark moves before the run starts: a live run is never doubled, a start that throws counts as a try', async () => {
  const w = world();
  for (const t of [0, 5, 10, 60]) await w.at(pst(20, 5, 10 + t));
  assert.equal(w.started.length, 1);
  w.boot();
  await w.at(pst(20, 6, 30));
  assert.equal(w.started.length, 1, 'nor by a server that restarted');

  const bad = world();
  const start = async () => {
    throw new Error('spawn failed');
  };
  const shots = new AppShots(bad.store, { dir: bad.dir, home: root, sharedDir: () => null, citadel: () => CITADEL, wake: () => true, mail: () => true, report: (s, t) => (bad.said.push(['report', s, t]), true), watching: false, start, alive: async () => false, kill: () => {}, now: () => bad.now });
  for (const m of [0, 5]) {
    bad.now = pst(20, 5, m);
    await assert.rejects(shots.tick(), /spawn failed/);
  }
  for (const m of [10, 15, 20, 260]) {
    bad.now = pst(20, 5, m);
    await shots.tick();
  }
  assert.equal(bad.said.length, 1);
});

test('a run that dies is started once more, then told to Citadel; one that hangs is stopped first; the next night starts afresh', async () => {
  const w = world();
  await w.at(pst(20, 5, 10));
  w.alive = false;
  await w.at(pst(20, 5, 10) + 30_000);
  assert.equal(w.started.length, 1, 'a pid just started is given a moment');
  await w.at(pst(20, 5, 15));
  assert.equal(w.started.length, 2);
  await w.at(pst(20, 5, 15) + RUN_MS + MIN);
  assert.deepEqual(w.killed, [102]);
  for (const t of [pst(20, 9, 5), pst(20, 9, 10), pst(20, 12)]) await w.at(t);
  assert.deepEqual(
    w.said.map((m) => m.slice(0, 2)),
    [['report', CITADEL]],
  );
  assert.match(w.said[0][2], /didn't finish/);
  assert.deepEqual(await w.night(21, [{}]), []);
  assert.equal(w.started.length, 3);
});

test('a run that dies after 8 AM is not started again in the day', async () => {
  const w = world();
  await w.at(pst(20, 7, 50));
  w.alive = false;
  await w.at(pst(20, 8, 5));
  await w.at(pst(20, 9, 5));
  assert.equal(w.started.length, 1);
  assert.deepEqual(
    w.said.map((m) => m.slice(0, 2)),
    [['report', CITADEL]],
  );
});

test('a run the server was down for is not read as tonight: yesterday’s unfinished one is given up, tonight starts', async () => {
  const w = world();
  await w.at(pst(20, 5, 10));
  w.alive = false;
  await w.at(pst(21, 5, 10));
  await w.at(pst(21, 5, 15));
  assert.deepEqual(w.started, ['2026-11-20', '2026-11-21']);
});

/** A one-app folder of nights, and the night that is compared with them. */
function nights(name: string, was: Record<number, Partial<AppNight>>, now: Partial<AppNight> = {}) {
  const dir = join(root, name);
  const full = (o: Partial<AppNight>): AppNight => ({ app: 'demo', title: 'Demo', scheme: 2, head: 'aaa', kit: 'k1', skipped: null, unshot: null, boot: null, once: [], shots: [shot({ file: 'a.png' })], found: ['/'], gone: [], goneSince: null, called: [], ...o });
  for (const [d, o] of Object.entries(was)) {
    mkdirSync(join(dir, dayName(Number(d)), 'demo'), { recursive: true });
    writeFileSync(join(dir, dayName(Number(d)), 'demo', 'a.png'), PNG);
    writeFileSync(join(dir, dayName(Number(d)), 'demo', 'night.json'), JSON.stringify(full(o)));
  }
  const mine = join(dir, 'mine');
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, 'a.png'), PNG);
  const a = full({ shots: [shot({ file: 'a.png', moved: null })], ...now });
  compare(dir, dayName(25), mine, a);
  return a;
}

test('a page is compared with the newest good picture of it, and laid to what changed since that night', () => {
  const bad = { shots: [shot({ file: 'a.png', ...blank })] };
  const same = nights('b1', { 20: {}, 21: {} });
  assert.deepEqual([same.shots[0].was, same.shots[0].moved, same.shots[0].since], ['2026-11-21/demo/a.png', 0, null]);
  assert.equal(nights('b2', { 20: {}, 21: bad }).shots[0].was, '2026-11-20/demo/a.png', 'a broken night is none to compare with');
  // The night between had its own trouble: what changed is asked of the night compared with.
  const ship = nights('b3', { 20: { head: 'old' }, 21: { unshot: 'busy', shots: [], found: [] } });
  assert.deepEqual([ship.shots[0].was, ship.shots[0].since], ['2026-11-20/demo/a.png', 'ship']);
  assert.equal(nights('b4', { 20: { kit: 'k0', head: 'old' } }).shots[0].since, 'kit');
  assert.equal(nights('b7', { 20: { kit: null } }).shots[0].since, null, 'a kit that could not be read lays nothing on it');
  // A page that lost its link leaves the pictures of that night good.
  assert.equal(nights('b5', { 20: {}, 21: { gone: ['/plan'] } }).shots[0].was, '2026-11-21/demo/a.png');
  assert.equal(nights('b6', {}).shots[0].was, null);
});

test('a main page is gone when the newest night that started had it', () => {
  const was = { found: ['/', '/plan'] };
  const a = nights('g1', { 20: { ...was, head: 'old' }, 21: { boot: 'no module x', shots: [], found: [] } });
  assert.deepEqual([a.gone, a.goneSince], [['/plan'], 'ship']);
  assert.deepEqual(nights('g2', { 20: was, 21: {} }).gone, [], 'gone is said once');
  assert.deepEqual(nights('g3', { 20: was }, { boot: 'no module x', shots: [], found: [] }).gone, []);
});

test('what both tries saw is told, what one saw is a flake, and one try alone tells nothing', () => {
  const night = (o: Partial<AppNight>): AppNight => ({ app: 'demo', title: 'Demo', scheme: 2, head: null, kit: null, skipped: null, unshot: null, boot: null, once: [], shots: [shot()], found: ['/'], gone: [], goneSince: null, called: [], ...o });
  const broke = (...errors: string[]) => night({ shots: [shot({ ...blank, errors })] });
  assert.deepEqual(
    problems(agreed([broke('flaky'), broke('other flake')])).map((p) => p.kind),
    ['blank'],
  );
  assert.deepEqual(problems(agreed([broke('boom'), night({})])), []);
  assert.equal(agreed([night({ boot: 'no module x', shots: [] }), broke()]).boot, null, 'one that started is kept');
  assert.equal(problems(agreed([night({ boot: 'a', shots: [] }), night({ boot: 'b', shots: [] })]))[0].kind, 'boot');
  assert.deepEqual(problems(agreed([night({})])), []);
  assert.throws(() => agreed([broke('boom')]), /only one of its two tries/);
});

test('fourteen nights are kept, fewer when they are large, and the two newest always; scratch is cleared', () => {
  const dir = join(root, 'prune');
  for (let d = 1; d <= 16; d++) {
    mkdirSync(join(dir, `2026-11-${String(d).padStart(2, '0')}`, 'demo'), { recursive: true });
    writeFileSync(join(dir, `2026-11-${String(d).padStart(2, '0')}`, 'demo', 'a.png'), 'x'.repeat(100));
  }
  mkdirSync(join(dir, '.demo-aB3dE9'));
  mkdirSync(join(dir, 'other'));
  prune(dir);
  assert.deepEqual([readdirSync(dir).length, existsSync(join(dir, '2026-11-02')), existsSync(join(dir, '2026-11-03')), existsSync(join(dir, 'other'))], [15, false, true, true]);
  prune(dir, 14, 14 * 100); // exactly its files: what a folder itself takes differs by disk
  assert.equal(readdirSync(dir).length, 15);
  prune(dir, 14, 10);
  assert.deepEqual(readdirSync(dir).sort(), ['2026-11-15', '2026-11-16', 'other']);
});

test('each app gets its page, what is broken listed on it, and an app’s own words never become markup', () => {
  const dir = join(root, 'pages');
  mkdirSync(join(dir, '2026-11-20', 'demo'), { recursive: true });
  writeFileSync(join(dir, '2026-11-20', 'demo', 'a.webp'), 'pic');
  const a: AppNight = {
    app: 'demo',
    title: 'Demo <b>',
    scheme: 2,
    head: 'abcdef0123',
    kit: null,
    skipped: null,
    unshot: null,
    boot: null,
    once: [],
    found: ['/'],
    gone: [],
    goneSince: null,
    called: [],
    shots: [shot({ thumb: 'a.webp' }), shot({ page: '> <img src=x onerror=1>', width: 390, errors: ['<script>x</script>'] })],
  };
  const night: Night = { day: '2026-11-20', startedAt: 0, endedAt: pst(20, 5), kit: null, apps: [a] };
  const html = renderPage(dir, night, [a], 'Demo <b>');
  assert.ok(!/<script|<img src=x|Demo <b>/.test(html));
  assert.match(html, /1 broken/);
  assert.match(html, /Taken Nov 20.*PST/);
  assert.ok(html.includes(`data:image/webp;base64,${Buffer.from('pic').toString('base64')}`));
  const page = join(root, 'shared', '2', 'reports/app-shots'),
    all = join(root, 'shared', '1', 'reports/app-shots');
  writePages(dir, night, [{ app: 'demo', title: 'Demo', scheme: 2, folder: '', subdir: null, page }], all);
  assert.deepEqual([readdirSync(page), readdirSync(all)], [['demo.html'], ['all-apps.html']]);
});

test('a box with more than twice its cores runnable is too busy for what it finds to be trusted', () => {
  assert.deepEqual([tooBusy(8, 16), tooBusy(32, 16), tooBusy(33, 16)], [false, false, true]);
});
