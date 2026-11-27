import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CLOUD_SOURCE, cloudCostUsd, keepNights, nightSightings, readNight, SWEEP, sweepsKey, type SweepNight } from '../src/cloud-flakes.ts';
import { Store } from '../src/db.ts';
import { FlakeFixes } from '../src/flake-fixes.ts';
import { projectRoutes } from '../src/routes/projects.ts';
import { batchStep, fits, readBatches, sessionText } from '../tools/cloud-flake.ts';

// Flake repeat-runs in cloud sessions (#2187): a night's results as a minion posts them, the cloud sightings they make, which
// the Test health tab shows as cloud-only and the fix-minion count never sees, and the VM script's verdicts.
const root = mkdtempSync(join(tmpdir(), 'cloud-flakes-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir
const store = new Store(join(root, 'coordinator.db'));
const row = (file: string, verdict: string, failed = 0) => ({ file, copies: 10, failed, verdict, seconds: 60, detail: verdict === 'clean' ? '' : 'boom' });

test("a night is checked as it comes in, and costed at about $0.50 for each 20 minutes, never under a session's start", () => {
  const n = readNight({ sha: 'a'.repeat(40), sessions: 1, minutes: 40, files: [row('test/a.test.ts', 'flaky', 3), row('test/b.test.ts', 'clean')] }, 7, 123) as SweepNight;
  assert.equal(n.costUsd, 1);
  assert.equal(cloudCostUsd(20), 0.5);
  assert.equal(cloudCostUsd(2), 0.4, 'a short session still costs its start');
  assert.equal(cloudCostUsd(2, 0), 0.05);
  assert.deepEqual([n.at, n.minion, n.sessions, n.files.length], [123, 7, 1, 2]);
  for (const [bad, why] of [
    [{ sessions: 1, minutes: 1, files: [row('../etc/passwd', 'clean')] }, /repo path/],
    [{ sessions: 1, minutes: 1, files: [row('test/a.test.ts', 'great')] }, /verdict/],
    [{ sessions: 1, minutes: 1, files: [{ ...row('test/a.test.ts', 'flaky'), failed: 11 }] }, /failed no more/],
    [{ sessions: -1, minutes: 1, files: [] }, /sessions/],
    [null, /JSON object/],
  ] as const)
    assert.match(readNight(bad, null, 0) as string, why);
});

test('only a flaky file makes a sighting, of source cloud; a red one failed alone there too', () => {
  const n = readNight({ sessions: 1, minutes: 5, files: [row('test/a.test.ts', 'flaky', 2), row('test/r.test.ts', 'red', 10), row('test/s.test.ts', 'skipped'), row('test/c.test.ts', 'clean')] }, null, 0) as SweepNight;
  const s = nightSightings(n);
  assert.deepEqual(
    s.map((x) => [x.file, x.source]),
    [['test/a.test.ts', CLOUD_SOURCE]],
  );
  assert.match(s[0].detail, /2 of 10 copies.*cloud VM/);
  const kept = Array.from({ length: SWEEP.keep + 3 }).reduce<SweepNight[]>((all, _, i) => keepNights(all, { ...n, at: i }), []);
  assert.deepEqual([kept.length, kept[0].at], [SWEEP.keep, SWEEP.keep + 2]);
});

test('cloud sightings show on Test health, cloud-only where they are all there is, and never start a fix minion', async () => {
  const project = store.createProject('Other scheme', null);
  const now = Date.now();
  const cloudOnly = 'test/cloudy.test.ts';
  const both = 'test/both.test.ts';
  for (const h of [1, 2, 3, 4]) store.addFlakeEvents(project.id, null, 'abc', now - h * 3_600_000, [{ file: cloudOnly, source: CLOUD_SOURCE, detail: '' }]);
  for (const h of [1, 2, 3]) store.addFlakeEvents(project.id, null, 'abc', now - h * 3_600_000, [{ file: both, source: 'in CI', detail: '' }]);
  store.addFlakeEvents(project.id, null, 'abc', now - 1000, [{ file: both, source: CLOUD_SOURCE, detail: '' }]);
  const counts = Object.fromEntries(store.flakeCounts(project.id, 0).map((f) => [f.file, [f.count, f.cloud]]));
  assert.deepEqual(counts, { [cloudOnly]: [4, 4], [both]: [4, 1] });
  assert.deepEqual(
    store.flakeCounts(project.id, 0, 10, true).map((f) => f.file),
    [both],
    "the sweep's picks leave its own sightings out",
  );
  const started: string[] = [];
  const fx = new FlakeFixes({
    store,
    sharedDir: () => null,
    runs: async () => [],
    jobs: async () => [],
    now: () => now,
    changedAt: async () => null,
    start: async (_p, b) => (started.push(b.title), { id: store.createTicket({ project_id: project.id, title: b.title, permission_mode: 'x', created_by: 'T' }).id }),
  });
  await fx.escalate(project, now);
  assert.deepEqual(started, [`Flaky test: ${both}`], 'four cloud sightings start nothing; three in CI start one');
});

async function call(method: string, path: string, ctx: Record<string, unknown>) {
  const route = projectRoutes.find((r) => r.method === method && r.path === path)!;
  let body = '';
  let status = 200;
  const res = {
    destroyed: false,
    writeHead: (s: number) => (status = s),
    end: (b: Buffer | string) => (body += b),
    setHeader() {},
    on() {},
  };
  try {
    await route.handler({ res, app: { store, dataDir: root, ciHealth: null, fastMode: null }, ...ctx } as never);
  } catch (err) {
    return { status: (err as { status?: number }).status ?? 500, body: { error: (err as Error).message } };
  }
  return { status, body: JSON.parse(body) };
}

test('a minion posts its night; the tab shows it beside the flakes, with its cost', async () => {
  const project = store.createProject('Third scheme', null);
  const t = store.createTicket({ project_id: project.id, title: 'Nightly cloud flake sweep', permission_mode: 'x', created_by: 'T' });
  const night = { sha: 'b'.repeat(40), sessions: 1, minutes: 30, files: [row('test/x.test.ts', 'flaky', 1), row('test/y.test.ts', 'clean')] };
  const req = Object.assign(new (await import('node:stream')).PassThrough(), { headers: { 'content-type': 'application/json' } });
  req.end(JSON.stringify(night));
  const posted = await call('POST', '/api/tickets/:ticket/cloud-sweep', { req, ticket: store.getTicket(t.id) });
  assert.deepEqual([posted.status, posted.body.sightings, posted.body.costUsd], [200, 1, 0.75]);
  const health = await call('GET', '/api/projects/:project/test-health', { project: { ...store.getProject(project.id)!, repo_dir: null, land_mode: 'land' } });
  assert.deepEqual(
    health.body.flakes.map((f: { file: string; cloud: number; count: number }) => [f.file, f.count, f.cloud]),
    [['test/x.test.ts', 1, 1]],
  );
  assert.deepEqual([health.body.sweeps.length, health.body.sweeps[0].costUsd, health.body.sweeps[0].minion], [1, 0.75, t.number]);
  assert.equal(store.getSetting<SweepNight[]>(sweepsKey(project.id))!.length, 1);
  const bad = Object.assign(new (await import('node:stream')).PassThrough(), { headers: { 'content-type': 'application/json' } });
  bad.end(JSON.stringify({ ...night, files: [row('test/x.test.ts', 'nope')] }));
  assert.equal((await call('POST', '/api/tickets/:ticket/cloud-sweep', { req: bad, ticket: store.getTicket(t.id) })).status, 400);
});

test("the tool's session text runs only checked test paths, one batch a step, and a batch that won't fit a step stays home", () => {
  assert.throws(() => batchStep('test/a.test.ts; rm -rf /', 10), /not a test file/);
  assert.throws(() => batchStep('test/../../x.test.ts', 10), /not a test file/);
  const text = sessionText({ ref: 'cloud/src-t1-x', branch: 'cloud/t1-y', steps: [batchStep('test/a.test.ts', 10)] }, '26');
  assert.match(text, /1\. `git fetch -q --depth=1 origin cloud\/src-t1-x/);
  assert.match(text, /3\. `bash tools\/cloud-flake-vm.sh run test\/a.test.ts 10`\n4\. `bash tools\/cloud-flake-vm.sh finish cloud\/t1-y`/);
  assert.equal(fits(null, 10), true, 'no time given: the VM step limit decides');
  assert.equal(fits(200, 10), true);
  assert.equal(fits(400, 10), false, '10 copies of a 400 s file run ~33 minutes');
  assert.throws(() => readBatches(`${JSON.stringify(row('test/a.test.ts', 'odd'))}\n`), /don't read/);
  assert.equal(readBatches(`${JSON.stringify(row('test/a.test.ts', 'clean'))}\nnot json\n`).length, 1);
});

test('the VM script gives each batch its verdict, then commits and pushes its results', () => {
  const dir = mkdtempSync(join(root, 'vm-'));
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', origin);
  git(dir, 'init', '-q', '-b', 'main', work);
  mkdirSync(join(work, 'tools'));
  copyFileSync(join(import.meta.dirname, '..', 'tools', 'cloud-flake-vm.sh'), join(work, 'tools', 'cloud-flake-vm.sh'));
  // A stand-in flake proof: its output, by file name, is what the real one prints in each case.
  writeFileSync(
    join(work, 'tools', 'flake-proof.sh'),
    `case $1 in
  *clean*) echo "flake-proof: $1: $2 clean runs at once under load" ;;
  *flaky*) echo "✖ failing tests:"; echo "boom"; echo "burn-in: $1: failed in 3 of $2 copies at once (copies 1 2 3), in 5 s"; exit 1 ;;
  *race*) echo "burn-in: $1: failed in $2 of $2 copies at once"; echo "burn-in: $1: alone: passed, so it fails only beside its copies: a race"; exit 1 ;;
  *red*) echo "burn-in: $1: failed in $2 of $2 copies at once"; echo "burn-in: $1: alone: failed too, so it is no race"; exit 1 ;;
  *skip*) echo "flake-proof: $1 skipped a test on this runner (the lines with ﹣ above), so it proves nothing"; exit 1 ;;
  *slow*) sleep 30 ;;
esac
`,
  );
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'base');
  git(work, 'remote', 'add', 'origin', origin);
  const env = { ...process.env, CLOUD_FLAKE_STEP: '1', HOME: dir };
  for (const f of ['clean', 'flaky', 'race', 'red', 'skip', 'slow']) {
    const r = spawnSync('bash', ['tools/cloud-flake-vm.sh', 'run', `test/${f}.test.ts`, '10'], { cwd: work, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  const r = spawnSync('bash', ['tools/cloud-flake-vm.sh', 'finish', 'cloud/t1-z'], { cwd: work, env: { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const pushed = readBatches(git(origin, 'show', 'cloud/t1-z:.citadel/out/flake.jsonl'));
  assert.deepEqual(
    pushed.map((b) => [b.file, b.verdict, b.failed]),
    [
      ['test/clean.test.ts', 'clean', 0],
      ['test/flaky.test.ts', 'flaky', 3],
      ['test/race.test.ts', 'flaky', 10],
      ['test/red.test.ts', 'red', 10],
      ['test/skip.test.ts', 'skipped', 0],
      ['test/slow.test.ts', 'stopped', 0],
    ],
  );
  assert.match(pushed[1].detail, /failing tests:\nboom/);
  const result = JSON.parse(git(origin, 'show', 'cloud/t1-z:.citadel/result.json'));
  assert.deepEqual(result.files, ['.citadel/out/flake.jsonl']);
  assert.match(result.reply, /Cloud flake run at [0-9a-f]{40}:\n- test\/clean.test.ts: clean/);
});
