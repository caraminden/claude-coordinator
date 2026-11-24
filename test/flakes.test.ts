import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { flakeBrief, parseFlakes } from '../src/flakes.ts';

// Flake events (#1063): land output to rows, the count query behind the Test health tab, and the fix-it brief.
const root = mkdtempSync(join(tmpdir(), 'flakes-'));
after(() => rmSync(root, { recursive: true, force: true }));
const store = new Store(join(root, 'coordinator.db'));
const DAY = 86_400_000;

test('land output names each flake once, from land.sh lines and run-tests lines, with the failing lines as detail', () => {
  const out = [
    '✖ test/apps.test.ts › lists apps (31ms)',
    'land: flake: test/apps.test.ts · in CI',
    'run-tests: test/apps.test.ts: failed in the full run, passed alone: likely load (1-minute load 9.1)',
    'run-tests: test/machines.test.ts: failed in the full run, passed alone: likely load (1-minute load 9.1)',
    'run-tests: test/x.test.ts: failed again alone: a real failure',
    'land: flake: ../etc/passwd · in CI',
  ].join('\n');
  const found = parseFlakes(out);
  assert.deepEqual(
    found.map((f) => f.file),
    ['test/apps.test.ts', 'test/machines.test.ts'],
  );
  assert.equal(found[0].source, 'in CI');
  assert.match(found[0].detail, /lists apps/);
  assert.equal(found[1].source, 'run-tests');
});

test('counts are per scheme, within the window, flakiest first, with the last land that saw each', () => {
  const now = Date.now();
  store.addFlakeEvents(1, 7, 'abc', now - 20 * DAY, [{ file: 'test/old.test.ts', source: 'smoke', detail: '' }]);
  store.addFlakeEvents(1, 7, 'abc', now - 3 * DAY, [{ file: 'test/a.test.ts', source: 'in CI', detail: 'one' }]);
  store.addFlakeEvents(1, 8, 'def', now - 2 * DAY, [
    { file: 'test/a.test.ts', source: 'in CI', detail: 'two' },
    { file: 'test/b.test.ts', source: 'smoke', detail: '' },
  ]);
  store.addFlakeEvents(1, null, 'fed', now - DAY, [{ file: 'test/a.test.ts', source: 'run-tests', detail: 'three' }]);
  store.addFlakeEvents(2, 9, 'zzz', now - DAY, [{ file: 'test/other.test.ts', source: 'smoke', detail: '' }]);
  const rows = store.flakeCounts(1, now - 14 * DAY);
  assert.deepEqual(
    rows.map((r) => [r.file, r.count]),
    [
      ['test/a.test.ts', 3],
      ['test/b.test.ts', 1],
    ],
  );
  assert.equal(rows[0].ticketId, null, 'the newest sighting was a fast-mode run, which has no minion');
  assert.equal(rows[1].ticketId, 8);
  assert.deepEqual(
    store.flakeDetails(1, 'test/a.test.ts', 2).map((d) => d.detail),
    ['three', 'two'],
  );
});

test('the brief names the file, the count, the skill and the failing outputs', () => {
  const b = flakeBrief('test/a.test.ts', 3, [{ at: Date.now(), detail: '✖ test/a.test.ts › boom' }]);
  assert.equal(b.title, 'Flaky test: test/a.test.ts');
  assert.match(b.message, /3 times/);
  assert.match(b.message, /citadel:diagnosing-bugs/);
  assert.match(b.message, /boom/);
});

// A flake fix has to prove it held (#1120).
import { mkdirSync, writeFileSync } from 'node:fs';
import { FlakeFixes } from '../src/flake-fixes.ts';
import { execFileSync } from 'node:child_process';
import { branchShippedAt, cleanRuns, parseRetroFlakes } from '../src/flakes.ts';

test('retro-log lines: each flake line is a sighting, reruns and other lines are not', () => {
  const md = [
    '- 02:45:47Z · flake · test/machine-agent-jobs.test.ts · load 16.43 · ticket/945-x · in CI',
    '- 02:47:38Z · flake rerun · ticket/945-x · test/machine-agent-jobs.test.ts · green',
    '- 03:00:00Z · flake · test/apps.test.ts · load 3.10',
    '- 03:10:00Z · flake · test/b.test.ts · smoke · land 7',
    '- 03:11:00Z · flake · ../x · load 1',
  ].join('\n');
  const got = parseRetroFlakes(md, '2026-11-18');
  assert.deepEqual(
    got.map((g) => [g.file, g.source]),
    [
      ['test/machine-agent-jobs.test.ts', 'in CI'],
      ['test/apps.test.ts', 'run-tests'],
      ['test/b.test.ts', 'smoke'],
    ],
  );
  assert.equal(got[0].at, Date.parse('2026-11-18T02:45:47Z'));
});

test("clean runs come from the proof run's steps: 10 a step, all 50 only when green", () => {
  const steps = [
    { name: "the file's name", conclusion: 'success' },
    { name: '10 clean runs (1 of 5)', conclusion: 'success' },
    { name: '10 clean runs (2 of 5)', conclusion: 'success' },
    { name: '10 clean runs (3 of 5)', conclusion: 'failure' },
  ];
  assert.equal(cleanRuns(steps, null), 20);
  assert.equal(cleanRuns(steps, 'failure'), 20);
  assert.equal(cleanRuns(steps, 'success'), 50);
});

test('a third sighting starts exactly one minion; a held fix reopens on the next; a green proof holds it', async () => {
  const dir = mkdtempSync(join(root, 'sched-'));
  const st = new Store(join(dir, 'c.db'));
  const project = st.createProject('P', null);
  const day = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
  const logDir = join(dir, 'shared', 'retro-log');
  const lines = (file: string, hoursAgo: number[]) => hoursAgo.map((h) => `- ${day(h).slice(11, 19)}Z · flake · ${file} · load 9.0 · ticket/1-x · in CI`);
  const put = (hoursAgo: number[], file: string) => {
    for (const h of hoursAgo) {
      const d = day(h).slice(0, 10);
      mkdirSync(join(logDir, d), { recursive: true });
      writeFileSync(join(logDir, d, 'land.md'), `${lines(file, [h]).join('\n')}\n`, { flag: 'a' });
    }
  };
  put([30, 20, 2], 'test/two.test.ts');
  put([40, 30], 'test/pair.test.ts');
  const started: string[] = [];
  let runs: any[] = [];
  let jobs: any[] = [];
  let n = 100;
  let clock = Date.now();
  const fx = new FlakeFixes({
    store: st,
    sharedDir: () => join(dir, 'shared'),
    start: async (_p, b) => {
      started.push(b.title);
      const t = st.createTicket({ project_id: project.id, title: b.title, permission_mode: 'x', created_by: 'T' });
      st.setTicketDir(t.id, dir, `ticket/${++n}-fix`);
      return { id: t.id };
    },
    runs: async () => runs,
    jobs: async () => jobs,
    now: () => clock,
  });
  await fx.tick([project]);
  await fx.tick([project]);
  assert.deepEqual(started, ['Flaky test: test/two.test.ts'], 'three in 7 days starts one minion, two do not, and a second pass starts no second');
  assert.equal(st.flakeCounts(project.id, 0).find((f) => f.file === 'test/two.test.ts')!.count, 3, 'the log lines are counted once, not on every pass');

  const fix = st.flakeFix(project.id, 'test/two.test.ts')!;
  assert.equal(fix.state, 'open');
  runs = [{ id: 7, display_title: 'flake-proof test/two.test.ts', created_at: new Date(clock + 60_000).toISOString(), status: 'in_progress', conclusion: null }];
  jobs = [
    {
      steps: [
        { name: '10 clean runs (1 of 5)', conclusion: 'success' },
        { name: '10 clean runs (2 of 5)', conclusion: 'success' },
      ],
    },
  ];
  clock += 120_000;
  await fx.tick([project]);
  assert.equal(st.flakeFix(project.id, 'test/two.test.ts')!.clean_runs, 20);
  assert.equal(st.flakeFix(project.id, 'test/two.test.ts')!.state, 'open', 'not held while the run is going');
  runs = [{ ...runs[0], status: 'completed', conclusion: 'success' }];
  await fx.tick([project]);
  const held = st.flakeFix(project.id, 'test/two.test.ts')!;
  assert.deepEqual([held.state, held.clean_runs], ['held', 50]);

  clock += 3_600_000;
  st.updateTicket(fix.ticket_id!, { status: 'closed' }); // its minion shipped; while it is open, no second starts
  st.addFlakeEvents(project.id, null, null, clock - 1000, [{ file: 'test/two.test.ts', source: 'in CI', detail: '' }]);
  await fx.tick([project]);
  const again = st.flakeFix(project.id, 'test/two.test.ts')!;
  assert.deepEqual([again.state, again.reopened, again.clean_runs], ['open', 1, 0], 'a re-sighting reopens it');
  assert.equal(started.length, 2, 'and starts a new minion at once');
});

test('a held fix is reopened only by a sighting after its commit reached main, not one between its proof going green and its ship (#1521, CA1)', async () => {
  const dir = mkdtempSync(join(root, 'shipgap-'));
  const st = new Store(join(dir, 'c.db'));
  const project = st.createProject('S', null);
  const file = 'test/gap.test.ts';
  let clock = Date.now();
  const heldAt = clock - 3_600_000;
  const t = st.createTicket({ project_id: project.id, title: `Flaky test: ${file}`, permission_mode: 'x', created_by: 'T' });
  st.setTicketDir(t.id, dir, 'ticket/9-fix');
  st.updateTicket(t.id, { status: 'closed' }); // shipped and seen: a minion closes only then, well after its ship
  st.addFlakeFix(project.id, file, t.id, heldAt - 3_600_000, { state: 'held', clean_runs: 50, held_at: heldAt });
  let shipped: number | null | undefined = heldAt + 10 * 60_000; // main got the fix 10 min after its proof went green
  const asked: string[] = [];
  const started: string[] = [];
  const fx = new FlakeFixes({
    store: st,
    sharedDir: () => null,
    runs: async () => [],
    jobs: async () => [],
    now: () => clock,
    shippedAt: async (_p, branch) => {
      asked.push(branch);
      return shipped;
    },
    start: async (_p, b) => {
      started.push(b.title);
      return { id: st.createTicket({ project_id: project.id, title: b.title, permission_mode: 'x', created_by: 'T' }).id };
    },
  });
  st.addFlakeEvents(project.id, null, null, heldAt + 5 * 60_000, [{ file, source: 'in CI', detail: '' }]);
  await fx.tick([project]);
  assert.deepEqual(started, [], 'a sighting on a main without the fix yet reopens nothing');
  assert.equal(st.flakeFix(project.id, file)!.state, 'held');
  assert.deepEqual(asked, ['ticket/9-fix'], "asked about the fix minion's own branch");
  st.addFlakeEvents(project.id, null, null, heldAt + 20 * 60_000, [{ file, source: 'in CI', detail: '' }]);
  await fx.tick([project]);
  assert.deepEqual(started, [`Flaky test: ${file}`], 'one after the ship reopens it and starts one minion');
  assert.equal(st.flakeFix(project.id, file)!.reopened, 1);

  // A fix whose minion closed without its commit reaching main never shipped: a sighting after its proof reopens it, as before.
  const f2 = 'test/never.test.ts';
  const t2 = st.createTicket({ project_id: project.id, title: 'closed unshipped', permission_mode: 'x', created_by: 'T' });
  st.setTicketDir(t2.id, dir, 'ticket/10-fix');
  st.updateTicket(t2.id, { status: 'closed' });
  st.addFlakeFix(project.id, f2, t2.id, heldAt - 3_600_000, { state: 'held', clean_runs: 50, held_at: heldAt });
  shipped = null;
  st.addFlakeEvents(project.id, null, null, heldAt + 5 * 60_000, [{ file: f2, source: 'in CI', detail: '' }]);
  clock += 1;
  await fx.tick([project]);
  assert.equal(st.flakeFix(project.id, f2)!.state, 'open', 'not on main: reopened on the sighting after its proof');
});

test("shippedAt reads when main first held a branch's tip from its reflog; null off main, undefined when the branch is gone (#1521)", async () => {
  const repo = mkdtempSync(join(root, 'git-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.logAllRefUpdates=true', ...a], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a'), '1');
  git('add', 'a');
  git('commit', '-qm', 'one');
  git('checkout', '-qb', 'ticket/1-fix');
  writeFileSync(join(repo, 'a'), '2');
  git('commit', '-qam', 'fix', '--date=2020-01-01T00:00:00Z');
  assert.equal(await branchShippedAt(repo, 'ticket/1-fix'), null, 'not on main yet');
  assert.equal(await branchShippedAt(repo, 'ticket/nope'), undefined);
  git('checkout', '-q', 'main');
  const before = Date.now();
  git('merge', '-q', '--ff-only', 'ticket/1-fix');
  const at = await branchShippedAt(repo, 'ticket/1-fix');
  assert.ok(at != null && at >= Math.floor(before / 1000) * 1000 && at <= Date.now(), `the fast-forward's time, not the commit's: ${at}`);
  writeFileSync(join(repo, 'a'), '3');
  git('commit', '-qam', 'later');
  assert.equal(await branchShippedAt(repo, 'ticket/1-fix'), at, 'a later commit on main leaves it');
});

test("a minion already on the file (the tab's button) is the fix: no second one; and one pass starts at most two", async () => {
  const dir = mkdtempSync(join(root, 'cap-'));
  const st = new Store(join(dir, 'c.db'));
  const project = st.createProject('Q', null);
  const now = Date.now();
  for (const f of ['a', 'b', 'c', 'd']) for (let i = 0; i < 3; i++) st.addFlakeEvents(project.id, null, null, now - (i + 1) * 3_600_000, [{ file: `test/${f}.test.ts`, source: 'in CI', detail: '' }]);
  const manual = st.createTicket({ project_id: project.id, title: 'Flaky test: test/a.test.ts', permission_mode: 'x', created_by: 'Cara' });
  const started: string[] = [];
  const fx = new FlakeFixes({
    store: st,
    sharedDir: () => null,
    runs: async () => [],
    jobs: async () => [],
    start: async (_p, b) => {
      started.push(b.title);
      return { id: st.createTicket({ project_id: project.id, title: b.title, permission_mode: 'x', created_by: 'T' }).id };
    },
  });
  await fx.tick([project]);
  assert.equal(st.flakeFix(project.id, 'test/a.test.ts')!.ticket_id, manual.id);
  assert.equal(started.length, 2, 'a is covered by the manual minion; b and c start, d waits');
  await fx.tick([project]);
  assert.equal(started.length, 3);
  assert.equal(new Set(started).size, 3);
});

test("three sightings from before the file's newest commit start no minion; three after it do (#1219)", async () => {
  const dir = mkdtempSync(join(root, 'fixed-'));
  const st = new Store(join(dir, 'c.db'));
  const project = st.createProject('F', null);
  const now = Date.now();
  for (const h of [30, 20, 10]) st.addFlakeEvents(project.id, null, null, now - h * 3_600_000, [{ file: 'test/old.test.ts', source: 'in CI', detail: '' }]);
  const changed: number | null = now - 5 * 3_600_000; // the file was fixed after all three
  const started: string[] = [];
  const fx = new FlakeFixes({
    store: st,
    sharedDir: () => null,
    runs: async () => [],
    jobs: async () => [],
    changedAt: async () => changed,
    start: async (_p, b) => {
      started.push(b.title);
      return { id: st.createTicket({ project_id: project.id, title: b.title, permission_mode: 'x', created_by: 'T' }).id };
    },
  });
  await fx.tick([project]);
  assert.deepEqual(started, [], 'all three sightings were before the commit: already fixed');
  for (const h of [4, 3, 2]) st.addFlakeEvents(project.id, null, null, now - h * 3_600_000, [{ file: 'test/old.test.ts', source: 'in CI', detail: '' }]);
  await fx.tick([project]);
  assert.deepEqual(started, ['Flaky test: test/old.test.ts'], 'three after the commit start one as before');
});

test('a held or closed fix row starts no minion while another open minion names the file, under any title', async () => {
  const dir = mkdtempSync(join(root, 'owner-'));
  const st = new Store(join(dir, 'c.db'));
  const project = st.createProject('O', null);
  const now = Date.now();
  const file = 'test/ov.test.ts';
  const other = st.createTicket({ project_id: project.id, title: 'Flaky test: ov.test.ts', permission_mode: 'x', created_by: 'Cara' });
  const old = st.createTicket({ project_id: project.id, title: 'old', permission_mode: 'x', created_by: 'T' });
  st.updateTicket(old.id, { status: 'closed' }); // so the title match alone is the owner
  st.addFlakeFix(project.id, file, old.id, now - 9e6, { state: 'held', held_at: now - 8e6 });
  for (const h of [3, 2, 1]) st.addFlakeEvents(project.id, null, null, now - h * 1_000_000, [{ file, source: 'in CI', detail: '' }]);
  const started: string[] = [];
  const fx = new FlakeFixes({
    store: st,
    sharedDir: () => null,
    runs: async () => [],
    jobs: async () => [],
    start: async (_p, b) => {
      started.push(b.title);
      return { id: st.createTicket({ project_id: project.id, title: b.title, permission_mode: 'x', created_by: 'T' }).id };
    },
  });
  await fx.tick([project]);
  assert.deepEqual(started, [], 'held row, new sightings, but another minion is open on the file');
  assert.equal(st.flakeFix(project.id, file)!.state, 'held', 'the row is left as it was');
});

test('no fix row yet: an open minion titled with the basename only owns the file', async () => {
  const dir = mkdtempSync(join(root, 'owner2-'));
  const st = new Store(join(dir, 'c.db'));
  const project = st.createProject('O2', null);
  const now = Date.now();
  const file = 'test/ov.test.ts';
  const other = st.createTicket({ project_id: project.id, title: 'Flaky test: ov.test.ts', permission_mode: 'x', created_by: 'Cara' });
  for (const h of [3, 2, 1]) st.addFlakeEvents(project.id, null, null, now - h * 1_000_000, [{ file, source: 'in CI', detail: '' }]);
  const started: string[] = [];
  const fx = new FlakeFixes({
    store: st,
    sharedDir: () => null,
    runs: async () => [],
    jobs: async () => [],
    start: async (_p, b) => {
      started.push(b.title);
      return { id: 1 };
    },
  });
  await fx.tick([project]);
  assert.deepEqual(started, []);
  assert.equal(st.flakeFix(project.id, file)!.ticket_id, other.id);
});
