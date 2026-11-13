import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { DeployView } from '../src/app-services.ts';
import { Store } from '../src/db.ts';
import type { Job, Run } from '../src/ci-health.ts';
import type { PrSnapshot } from '../src/github.ts';
import { ApkReader, CiPackageReader, ContraptionReader, gradleVersion, lengths, MainReader, TestCopyReader, type Actions } from '../src/release-readers.ts';
import { copySources, detect, jobName, shipsOn, TargetFinder, type Found, type SchemeFacts } from '../src/release-targets.ts';

// src/release-targets.ts and src/release-readers.ts (#627): every scheme's targets found from what it has, and a reader per kind.
const root = mkdtempSync(join(tmpdir(), 'release-targets-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const git = (cwd: string, args: string[], date?: number) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...(date && { GIT_COMMITTER_DATE: `@${Math.floor(date / 1000)} +0000`, GIT_AUTHOR_DATE: `@${Math.floor(date / 1000)} +0000` }) },
}).trim();

// Shaped like Mandate's android-release.yml, Peek Auras' windows.yml and Mandate's android.yml (a debug APK: a test copy, not a target).
const APK = `name: android-release
on:
  workflow_dispatch:
jobs:
  release:
    runs-on: [self-hosted, mandate-ci]
    steps:
      - run: ./gradlew assembleRelease
      - uses: actions/upload-artifact@v7
`;
const WINDOWS = `name: windows
on:
  push:
    branches: [main, 'land/**']
  workflow_dispatch:
jobs:
  build:
    runs-on: [self-hosted, windows]
    steps:
      - run: cargo test
  release:
    needs: build
    runs-on: [self-hosted, windows]
    steps:
      - run: cargo build --release
      - uses: actions/upload-artifact@v7
        with:
          name: peek-auras-\${{ github.sha }}
`;
const DEBUG = `name: android
on:
  push:
    branches: [main, 'land/**']
jobs:
  debug:
    runs-on: ubuntu-latest
    steps:
      - run: ./gradlew assembleDebug
      - uses: actions/upload-artifact@v7
`;

const facts = (over: Partial<SchemeFacts> = {}): SchemeFacts => ({
  project: { id: 5, repo_url: 'https://github.com/o/mandate' }, own: false, branch: 'main', contraptions: [], apkFeeds: [], workflows: [], overrides: [], ...over,
});
const ids = (f: SchemeFacts) => detect(f).map((t) => `${t.kind} ${t.id} ${t.name}`);

test('a contraption, an APK workflow and a Windows release job are three targets; a debug build and a test job are none', () => {
  const found = detect(facts({
    contraptions: [{ name: 'mandate', title: 'Mandate' }], apkFeeds: ['mandate'],
    workflows: [{ path: '.github/workflows/android-release.yml', text: APK }, { path: '.github/workflows/windows.yml', text: WINDOWS }, { path: '.github/workflows/android.yml', text: DEBUG }],
  }));
  assert.deepEqual(found.map((t) => `${t.kind} ${t.id} ${t.name}`), ['contraption app:mandate App', 'apk apk:android-release Android', 'ci ci:windows:release Windows']);
  assert.equal(found[1].link, '/apps/mandate/android/', 'the APK the app serves');
  assert.equal(found[1].contraption, 'mandate');
  assert.equal(found[2].link, 'https://github.com/o/mandate/actions/workflows/windows.yml');
  assert.equal(found[2].job, 'release');
});

test('a scheme with nothing that ships gets Main; one whose server is its target (Citadel) or with no repo and nothing gets none', () => {
  assert.deepEqual(ids(facts()), ['main main Main']);
  assert.deepEqual(ids(facts({ workflows: [{ path: '.github/workflows/android.yml', text: DEBUG }] })), ['main main Main'], 'a debug build is a test copy');
  assert.deepEqual(ids(facts({ own: true })), []);
  assert.deepEqual(ids(facts({ contraptions: [{ name: 'a', title: 'Alpha' }, { name: 'b', title: 'Beta' }] })), ['contraption app:a Alpha', 'contraption app:b Beta'], 'two apps go by their names; no Main');
});

test('citadel-app.json targets rename, relink and hide a found target', () => {
  const overrides = [{ id: 'app:mandate', name: 'Web', link: '/apps/mandate/inbox' }, { id: 'ci:windows:release', hidden: true }];
  const found = detect(facts({ contraptions: [{ name: 'mandate', title: 'Mandate' }], workflows: [{ path: '.github/workflows/windows.yml', text: WINDOWS }], overrides }));
  assert.deepEqual(found.map((t) => [t.id, t.name, t.link]), [['app:mandate', 'Web', '/apps/mandate/inbox']]);
  assert.deepEqual(ids(facts({ overrides: [{ id: 'main', hidden: true }] })), [], 'Main hidden too');
});

test('shipsOn: a push to the default branch, a tag or a release ships; another branch or a PR does not; dispatch alone is by hand', () => {
  const on = (o: string) => shipsOn(`name: x\non:\n${o}\njobs:\n  a:\n    runs-on: x\n`, 'main');
  assert.equal(on('  push:\n    branches: [main]'), 'push');
  assert.equal(on('  push:\n    branches:\n      - "main"\n      - dev'), 'push');
  assert.equal(on('  push:\n    tags: ["v*"]'), 'push');
  assert.equal(on('  push:'), 'push', 'no filter: every push');
  assert.equal(on('  release:\n    types: [published]'), 'push');
  assert.equal(on('  push:\n    branches: [maintenance]\n  pull_request:'), null);
  assert.equal(on('  pull_request:'), null);
  assert.equal(on('  workflow_dispatch:'), 'dispatch');
  assert.equal(shipsOn('on: [push, pull_request]\njobs: {}\n', 'main'), 'push');
  assert.equal(shipsOn('on: pull_request\n', 'main'), null);
  assert.equal(on('  push:\n    branches-ignore: [main]'), null);
  assert.equal(on('  push:\n    branches-ignore: [dev]'), 'push');
  assert.equal(shipsOn('on:\n  push:\n    branches: [v2x]\n', 'v2.x'), null, 'the branch is a name, not a pattern');
  // Any indent width, the way some editors write YAML.
  const wide = 'on:\n    push:\n        branches: [main]\njobs:\n    release:\n        runs-on: windows-latest\n        steps:\n            - run: gh release create v1\n';
  assert.equal(shipsOn(wide, 'main'), 'push');
  assert.deepEqual(ids(facts({ workflows: [{ path: '.github/workflows/ship.yml', text: wide }] })), ['ci ci:ship:release Windows']);
});

test('the finder reads a scheme clone: a new scheme whose repo has a release workflow gets its row with no other step', async () => {
  const store = new Store(join(root, `f-${++n}.db`));
  const repo = join(root, `repo-${n}`);
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, '.github/workflows/windows.yml'), WINDOWS);
  writeFileSync(join(repo, 'citadel-app.json'), JSON.stringify({ start: ['x'], targets: [{ id: 'ci:windows:release', name: 'PC' }] }));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'ci']);
  const finder = new TargetFinder({ store, own: () => null, apkFeed: (name) => join(root, 'feeds', name) });
  await finder.scan();
  assert.deepEqual(finder.list(), []);
  const p = store.createProject('Peek', 'https://github.com/o/peek');
  store.setProjectRepoDir(p.id, repo);
  const empty = store.createProject('Notes', null);
  await finder.scan();
  assert.deepEqual(finder.list().map((t) => [t.projectId, t.id, t.name, t.branch]), [[p.id, 'ci:windows:release', 'PC', 'main']]);
  assert.ok(!finder.list().some((t) => t.projectId === empty.id), 'no repo and no contraption: nothing');
  // A clone git can't read keeps what it had.
  rmSync(join(repo, '.git'), { recursive: true, force: true });
  await finder.scan();
  assert.equal(finder.list().length, 1);
  store.deleteProject(p.id);
  await finder.scan();
  assert.deepEqual(finder.list(), []);
});

test('lengths: each stage up to the next, the last up to the end', () => {
  assert.deepEqual(lengths({ restart: 30_000, build: 0, drain: 20_000 }, 45_000), { build: 20, drain: 10, restart: 15 });
});

test('the contraption reader: the deployed commit, main ahead waiting on a deploy call, a running deploy, and its row once done', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const repo = join(root, `app-repo-${n}`), folder = join(root, `app-folder-${n}`);
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'base'], Date.now() - 7_200_000);
  const base = git(repo, ['rev-parse', 'HEAD']);
  git(root, ['clone', '-q', repo, folder]);
  const p = store.createProject('Mandate', 'https://github.com/o/mandate');
  store.setProjectRepoDir(p.id, repo);
  store.createContraption({ name: 'mandate', title: 'Mandate', icon: null, port: 9, home_scheme: p.id, open_paths: '[]', relay_paths: '[]', repo: 'o/mandate', branch: null, folder, default_model: null, turn_cap: null, identity_public: 'x', identity_private: 'x', key_hash: 'h', keys_at: 0 });
  const finder = new TargetFinder({ store, own: () => null, apkFeed: (name) => join(root, 'feeds', name) });
  await finder.scan();
  let running: DeployView | null = null;
  const now = Date.now();
  const reader = new ContraptionReader({ store, finder, folder: (row) => row.folder!, running: () => running, now: () => now });

  await reader.refresh();
  let [v] = reader.read();
  assert.deepEqual(v.target, { id: 'app:mandate', projectId: p.id, name: 'App', kind: 'contraption', link: '/apps/mandate/' });
  assert.equal(v.current?.version, base, 'what the folder has checked out, with no deploy recorded yet');
  assert.equal(v.next, null, 'main is where it is: nothing on its way');

  // A minion lands two commits; its branch tip is main's.
  const t = store.createTicket({ project_id: p.id, title: 'Snooze', permission_mode: 'default', created_by: 'Josh' });
  store.setTicketDir(t.id, root, 'ticket/1-snooze');
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'one'], Date.now() - 3_600_000);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'two'], Date.now());
  const tip = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['branch', 'ticket/1-snooze', tip]);
  await reader.refresh();
  [v] = reader.read();
  assert.equal(v.next?.stage, 'call');
  assert.equal(v.next?.waitingOn, 'main is 2 commits ahead, waiting for a deploy call');
  assert.equal(v.next?.eta, null);
  assert.deepEqual(v.next?.stages.map((s) => s.name), ['call', 'build', 'drain', 'restart', 'live']);
  assert.deepEqual(v.next?.changes.map((c) => c.title), ['Snooze']);
  assert.ok(Math.abs(v.next!.since - (Date.now() - 3_600_000)) < 2000, 'since the oldest undeployed commit');

  // Two earlier deploys give the usual times, and six failed ones after them don't hide those.
  for (const s of [{ build: 60, drain: 5, restart: 20 }, { build: 80, drain: 5, restart: 30 }]) {
    store.addContraptionDeploy({ name: 'mandate', from_sha: 'old', to_sha: base, by: 'Cara', started_at: now - 9e6, finished_at: now - 9e6 + 1e5, outcome: 'deployed', stages: JSON.stringify(s), changes: '[]' });
  }
  for (let i = 0; i < 6; i++) store.addContraptionDeploy({ name: 'mandate', from_sha: base, to_sha: 'bad', by: 'Cara', started_at: now - 8e6, finished_at: now - 8e6, outcome: 'rolled back', stages: '{}', changes: '[]' });
  // A deploy starts and fast-forwards the folder before it builds: the old commit still serves, and main's changes stay its.
  running = { name: 'mandate', state: 'running', by: '#12', repo: 'o/mandate', branch: 'main', from: base, to: tip, started_at: now - 70_000, finished_at: null, said: ['Build: npm ci'], todo: [], log: '', stages: { build: now - 70_000 } };
  git(folder, ['pull', '-q', '--ff-only']);
  await reader.refresh();
  [v] = reader.read();
  assert.equal(v.current?.version, base);
  assert.equal(v.current?.live, now - 9e6 + 1e5, 'the newest deployed row of that commit');
  assert.equal(v.next?.stage, 'build');
  assert.equal(v.next?.usual, 70, 'the median build');
  assert.deepEqual(v.next?.changes.map((c) => c.title), ['Snooze']);
  // Its drain waits for the app's agent turns: no estimate.
  running.stages.drain = now - 2_000;
  [v] = reader.read();
  assert.deepEqual([v.next?.stage, v.next?.waitingOn, v.next?.eta], ['drain', 'its running agent turns to end', null]);
  running.stages.restart = now - 1_000;
  [v] = reader.read();
  assert.equal(v.next?.eta, now - 1_000 + 25 * 1000, 'the median restart, then live');

  // It ends: its row has the stage lengths and the minion whose work went live.
  const done = { ...running, state: 'deployed' as const, finished_at: now + 25_000 };
  running = null;
  await reader.record(done);
  const row = store.listContraptionDeploys('mandate', 1)[0];
  assert.deepEqual([row.from_sha, row.to_sha, row.by, row.outcome], [base, tip, '#12', 'deployed']);
  assert.deepEqual(JSON.parse(row.stages), { build: 68, drain: 1, restart: 26 });
  assert.deepEqual(JSON.parse(row.changes).map((c: { title: string }) => c.title), ['Snooze']);
  await reader.refresh();
  [v] = reader.read();
  assert.equal(v.next, null);
  assert.equal(v.current?.version, tip);
  assert.deepEqual(v.current?.changes.map((c) => c.title), ['Snooze']);
  assert.equal(v.current?.link, `https://github.com/o/mandate/commit/${tip}`);
  assert.equal(v.recent.length, 5);
  assert.equal(v.recent[0].outcome, 'rolled back');
});

// A workflow's runs and jobs as GitHub's API gives them, newest first, counting the reads.
const iso = (ms: number) => new Date(ms).toISOString();
function fakeActions(runs: Run[], jobs: Record<number, Job[]>) {
  const reads = { runs: 0, jobs: 0 };
  const actions: Actions = {
    async workflowRuns() { reads.runs++; return runs; },
    async runJobs(_p, run) { reads.jobs++; return jobs[run.id] ?? []; },
  };
  return { actions, reads };
}
const run = (id: number, status: string, conclusion: string | null, created: number, updated?: number): Run => ({
  id, name: 'windows', workflow_id: 1, head_branch: 'main', head_sha: `sha${id}`, status, conclusion, created_at: iso(created),
  ...(updated != null && { updated_at: iso(updated) }), run_number: id, html_url: `https://github.com/o/r/actions/runs/${id}`,
});
const job = (runId: number, name: string, status: string, conclusion: string | null, started: number | null, completed: number | null): Job => ({
  id: runId * 10, run_id: runId, name, status, conclusion, created_at: iso(started ?? 0), started_at: started == null ? null : iso(started),
  completed_at: completed == null ? null : iso(completed), runner_name: null, labels: [],
});
const finderOf = (targets: Found[]) => ({ list: (kind?: string) => targets.filter((t) => !kind || t.kind === kind) });

test('the CI package reader: the newest run whose job passed is the release, a run in flight is the next, a skipped job shipped nothing', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Peek Auras', 'https://github.com/o/r');
  const t: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', workflow: '.github/workflows/windows.yml', job: 'release' };
  const now = Date.now(), m = 60_000;
  // Newest first: one in flight (its release job running), one whose release job was skipped, two that shipped, one that failed.
  const runs = [run(5, 'in_progress', null, now - 6 * m), run(4, 'completed', 'success', now - 30 * m, now - 25 * m), run(3, 'completed', 'success', now - 60 * m, now - 40 * m), run(2, 'completed', 'success', now - 120 * m, now - 100 * m), run(1, 'completed', 'failure', now - 200 * m, now - 190 * m)];
  const jobs = {
    5: [job(5, 'test', 'completed', 'success', now - 5 * m, now - 3 * m), job(5, 'release', 'in_progress', null, now - 2 * m, null)],
    4: [job(4, 'release', 'completed', 'skipped', null, null)],
    3: [job(3, 'release', 'completed', 'success', now - 50 * m, now - 40 * m)],
    2: [job(2, 'Release (windows-latest)', 'completed', 'success', now - 110 * m, now - 100 * m)],
    1: [job(1, 'release', 'completed', 'failure', now - 195 * m, now - 190 * m)],
  };
  const { actions, reads } = fakeActions(runs, jobs);
  const reader = new CiPackageReader({ store, finder: finderOf([t]), actions, now: () => now });
  await reader.refresh();
  const [v] = reader.read();
  assert.deepEqual(v.target, { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null });
  assert.equal(v.current?.version, 'build 3', 'run 4 skipped its release job, so run 3 is what people have');
  assert.equal(v.current?.link, 'https://github.com/o/r/actions/runs/3');
  assert.deepEqual(v.current?.stages, { ci: 600, package: 600 });
  assert.deepEqual(v.recent.map((r) => [r.version, r.outcome]), [['build 2', 'live'], ['build 1', 'failed']]);
  assert.equal(v.next?.stage, 'package');
  assert.equal(v.next?.usual, 600, 'the median package time of the shipped runs');
  assert.equal(v.next?.eta, now - 2 * m + 600_000);
  assert.deepEqual(v.next?.stages.map((s) => s.name), ['ci', 'package', 'live']);

  // While a run moves, every refresh reads again; once all are done, the next read waits for the idle interval.
  await reader.refresh();
  assert.equal(reads.runs, 2);
  runs[0] = run(5, 'completed', 'success', now - 6 * m, now);
  jobs[5][1] = job(5, 'release', 'completed', 'success', now - 2 * m, now);
  await reader.refresh();
  await reader.refresh();
  assert.equal(reads.runs, 3, 'nothing moving: no read until the idle interval passes');
  const [done] = reader.read();
  assert.equal(done.current?.version, 'build 5');
  assert.equal(done.next, null);
});

test('the CI package reader: a run waiting for a runner waits, with no estimate', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Peek Auras', 'https://github.com/o/r');
  const t: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', workflow: '.github/workflows/windows.yml', job: 'release' };
  const now = Date.now();
  const { actions } = fakeActions([run(2, 'queued', null, now - 60_000)], { 2: [] });
  const reader = new CiPackageReader({ store, finder: finderOf([t]), actions, now: () => now });
  await reader.refresh();
  const [v] = reader.read();
  assert.equal(v.current, null);
  assert.deepEqual([v.next?.stage, v.next?.waitingOn, v.next?.eta], ['ci', 'waiting for a CI runner', null]);
});

test('gradleVersion reads Groovy and Kotlin build files', () => {
  assert.deepEqual(gradleVersion('defaultConfig {\n  versionCode 5\n  versionName "1.4"\n}'), { code: 5, name: '1.4' });
  assert.deepEqual(gradleVersion('defaultConfig {\n  versionCode = 12\n  versionName = "2.0.1"\n}'), { code: 12, name: '2.0.1' });
  assert.equal(gradleVersion('android {}'), null);
});

test('the APK reader: what latest.json serves is the release; a bump on main waits for a release run, signs, then waits to be published', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const repo = join(root, `apk-repo-${n}`);
  mkdirSync(join(repo, 'android/app'), { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'android/app/build.gradle'), 'defaultConfig {\n  versionCode 5\n  versionName "1.4"\n}\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'v5']);
  const p = store.createProject('Mandate', 'https://github.com/o/mandate');
  store.setProjectRepoDir(p.id, repo);
  const t: Found = { id: 'apk:android-release', projectId: p.id, name: 'Android', kind: 'apk', link: '/apps/mandate/android/', branch: 'main', workflow: '.github/workflows/android-release.yml', contraption: 'mandate' };
  const now = Date.now(), m = 60_000;
  const feedAt = now - 100 * m;
  const runs: Run[] = [run(7, 'completed', 'success', now - 120 * m, now - 112 * m), run(6, 'completed', 'success', now - 300 * m, now - 290 * m)];
  const { actions } = fakeActions(runs, {});
  let clock = now;
  const reader = new ApkReader({ store, finder: finderOf([t]), actions, now: () => clock, feed: async () => ({ versionCode: 5, apk: 'mandate-5.apk', at: feedAt }) });
  await reader.refresh();
  let [v] = reader.read();
  assert.deepEqual([v.current?.version, v.current?.link, v.current?.live], ['1.4', '/apps/mandate/android/mandate-5.apk', feedAt], "main's versionName names the build it serves");
  assert.equal(v.next, null);
  assert.deepEqual(v.recent.map((r) => [r.version, r.outcome, r.stages.sign]), [['build 7', 'signed', 480], ['build 6', 'signed', 600]]);

  // A minion bumps the version on main: nobody has started a release run yet.
  writeFileSync(join(repo, 'android/app/build.gradle'), 'defaultConfig {\n  versionCode 6\n  versionName "1.5"\n}\n');
  git(repo, ['commit', '-q', '-am', 'v6']);
  await reader.refresh();
  [v] = reader.read();
  assert.deepEqual([v.next?.stage, v.next?.waitingOn, v.next?.eta], ['sign', '1.5 is on main: waiting for someone to start a release run', null]);

  // Someone starts one: with nothing moving, the runs are read again once the idle interval has passed; it signs on CI.
  runs.unshift(run(8, 'in_progress', null, now - 2 * m));
  await reader.refresh();
  [v] = reader.read();
  assert.equal(v.next?.waitingOn, '1.5 is on main: waiting for someone to start a release run', 'not read again yet');
  clock += 5 * m;
  await reader.refresh();
  [v] = reader.read();
  assert.deepEqual([v.next?.stage, v.next?.waitingOn, v.next?.usual], ['sign', null, 540]);
  assert.equal(v.next?.eta, null, 'publishing is a person\'s step, so no estimate');

  // Signed: waiting for someone to publish it.
  runs[0] = run(8, 'completed', 'success', now - 2 * m, now);
  await reader.refresh();
  [v] = reader.read();
  assert.deepEqual([v.next?.stage, v.next?.waitingOn], ['publish', '1.5 is signed: waiting for someone to publish it']);
});

test('the APK reader with no latest.json: the newest signed run is the release', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Mandate', 'https://github.com/o/mandate');
  const t: Found = { id: 'apk:android-release', projectId: p.id, name: 'Android', kind: 'apk', link: null, branch: 'main', workflow: '.github/workflows/android-release.yml' };
  const now = Date.now();
  const { actions } = fakeActions([run(3, 'completed', 'failure', now - 60_000, now - 30_000), run(2, 'completed', 'success', now - 600_000, now - 300_000)], {});
  const reader = new ApkReader({ store, finder: finderOf([t]), actions, now: () => now, feed: async () => null });
  await reader.refresh();
  const [v] = reader.read();
  assert.deepEqual([v.current?.version, v.current?.outcome, v.current?.stages.sign], ['build 2', 'live', 300]);
  assert.deepEqual(v.recent.map((r) => [r.version, r.outcome]), [['build 3', 'failed']]);
});

test('the Main reader: each head of main is a release with the minions it took in; open PRs are the next, by checks then a go to merge', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const repo = join(root, `main-repo-${n}`);
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'base'], Date.now() - 7_200_000);
  const base = git(repo, ['rev-parse', 'HEAD']);
  const p = store.createProject('Delve', 'https://github.com/o/delve');
  store.setProjectRepoDir(p.id, repo);
  const t: Found = { id: 'main', projectId: p.id, name: 'Main', kind: 'main', link: null, branch: 'main' };
  const now = Date.now();
  const prs = new Map<number, PrSnapshot>();
  const ci = new Map<number, { since: number; usual: number | null; text: string }>();
  const reader = new MainReader({ store, finder: finderOf([t]), pr: (id) => prs.get(id) ?? null, ci: (id) => ci.get(id) ?? null, now: () => now });
  await reader.refresh();
  let [v] = reader.read();
  assert.equal(v.current?.version, base);
  assert.equal(v.current?.link, `https://github.com/o/delve/commit/${base}`);
  assert.equal(v.next, null);
  await reader.refresh();
  assert.equal(store.listReleases(p.id, 'main', 10).length, 1, 'the same head writes no second row');

  // Two minions with open PRs: one's checks run, the other's passed and waits for a go.
  const a = store.createTicket({ project_id: p.id, title: 'Fog of war', permission_mode: 'default', created_by: 'Josh' });
  const b = store.createTicket({ project_id: p.id, title: 'Torches', permission_mode: 'default', created_by: 'Josh' });
  store.setTicketDir(a.id, root, 'ticket/1-fog');
  store.setTicketDir(b.id, root, 'ticket/2-torches');
  const pr = (number: number, status: 'pending' | 'passed'): PrSnapshot => ({ number, url: '', state: 'OPEN', headSha: 'x', closedAt: null, closedBy: null, checks: [{ name: 'test', status, url: null }], remarks: [] });
  prs.set(a.id, pr(11, 'pending'));
  prs.set(b.id, pr(12, 'passed'));
  ci.set(a.id, { since: now - 60_000, usual: 300, text: 'test step 3 of 8' });
  [v] = reader.read();
  assert.deepEqual(v.next?.changes.map((c) => [c.title, c.stage]), [['Torches', 'merge'], ['Fog of war', 'checks']], 'the one furthest along leads');
  assert.deepEqual([v.next?.stage, v.next?.waitingOn, v.next?.eta], ['merge', 'PR #12 waits for a go to merge', null]);
  assert.deepEqual(v.next?.stages.map((s) => [s.name, s.usual]), [['checks', null], ['merge', null], ['live', 0]]);

  // Torches merges: main moves, and its row takes in the minion whose tip is on it.
  prs.delete(b.id);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'torches']);
  const tip = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['branch', 'ticket/2-torches', tip]);
  await reader.refresh();
  [v] = reader.read();
  assert.equal(v.current?.version, tip);
  assert.deepEqual(v.current?.changes.map((c) => c.title), ['Torches']);
  assert.deepEqual(v.recent.map((r) => r.version), [base]);
  assert.deepEqual([v.next?.stage, v.next?.text, v.next?.usual], ['checks', 'test step 3 of 8', 300]);
  assert.equal(v.next?.eta, null, 'merge waits on a person, so no estimate');
});

test("a job's own name, not a step's or an input's, is what its runs are matched by", async () => {
  const text = `
    name: "Build Windows package"
    runs-on: windows-latest
    steps:
      - name: Upload
        uses: actions/upload-artifact@v4
        with:
          name: peek-installer
`;
  assert.equal(jobName(text), 'Build Windows package');
  assert.equal(jobName('\n    runs-on: x\n    steps:\n      - uses: actions/upload-artifact@v4\n        with:\n          name: release-zip\n'), null, "an artifact's name is not the job's");
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Peek Auras', 'https://github.com/o/r');
  const t: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', workflow: '.github/workflows/windows.yml', job: 'release', jobName: 'Build ${{ matrix.os }} package' };
  const now = Date.now();
  const { actions } = fakeActions([run(2, 'completed', 'success', now - 600_000, now)], { 2: [job_('test'), job_('Build windows-latest package')] });
  function job_(name: string) { return job(2, name, 'completed', 'success', now - 300_000, now); }
  const reader = new CiPackageReader({ store, finder: finderOf([t]), actions, now: () => now });
  await reader.refresh();
  assert.equal(reader.read()[0].current?.version, 'build 2');
});

// Shaped like poe2's deploy/preview.sh.
const PREVIEW = 'RUN=${RUN:-$HOME/.local/share/x}\nPORT=${PORT:-8116}\n';

test('test-copy sources: a debug APK workflow sits under the Android target, and a preview script is a site on its port', () => {
  const f = facts({ workflows: [{ path: '.github/workflows/android-release.yml', text: APK }, { path: '.github/workflows/android.yml', text: DEBUG }], scripts: [{ path: 'deploy/preview.sh', text: PREVIEW }, { path: 'tools/preview-notes.sh', text: 'echo hi' }] });
  const found = detect(f);
  const src = copySources(f, found);
  assert.deepEqual(src.map((s) => (s.kind === 'site' ? [s.kind, s.port] : [s.kind, s.target, s.run.id, s.run.workflow])), [
    ['debug-apk', 'apk:android-release', 'debug:android', '.github/workflows/android.yml'],
    ['site', 8116],
  ]);
  assert.ok(!found.some((t) => t.id.startsWith('debug')), 'a debug build is no target');
  assert.deepEqual(copySources(facts({ workflows: [{ path: '.github/workflows/android.yml', text: DEBUG }] }), []).map((s) => s.kind === 'debug-apk' && s.target), [null], 'with no Android target it sits in the scheme\'s list');
});

test('the test-copy reader: builds open minions left in their files, a preview site up or down, and CI\'s newest debug APK', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Delve', 'https://github.com/o/delve');
  const open = store.createTicket({ project_id: p.id, title: 'Windows exe', permission_mode: 'default', created_by: 'Josh' });
  const closed = store.createTicket({ project_id: p.id, title: 'Old build', permission_mode: 'default', created_by: 'Josh' });
  store.updateTicket(closed.id, { status: 'closed' });
  const dir = (id: number) => join(root, `shared-${n}`, String(id));
  for (const [id, names] of [[open.id, ['Delve-ticket-70-exe-e889baa9-windows.zip', 'notes.md', 'art-pack.zip', 'Game.exe']], [closed.id, ['Delve-old-1234567-windows.zip']]] as const) {
    mkdirSync(dir(id), { recursive: true });
    for (const name of names) writeFileSync(join(dir(id), name), 'x');
  }
  const now = Date.now();
  const debugRun: Found = { id: 'debug:android', projectId: p.id, name: 'Debug APK', kind: 'apk', link: null, branch: 'main', workflow: '.github/workflows/android.yml' };
  const { actions } = fakeActions([run(9, 'in_progress', null, now - 60_000), run(8, 'completed', 'success', now - 600_000, now - 300_000)], {});
  const reader = new TestCopyReader({
    store, actions, now: () => now, sharedDir: (t) => dir(t.id), listening: async (port) => port === 8116,
    finder: { list: () => [], copySources: () => [{ kind: 'site', projectId: p.id, name: 'Preview site', port: 8116 }, { kind: 'site', projectId: p.id, name: 'Preview site', port: 9000 }, { kind: 'debug-apk', projectId: p.id, target: 'apk:android-release', run: debugRun }] },
  });
  await reader.scan();
  const copies = reader.list().get(p.id)!;
  assert.deepEqual(copies.filter((c) => c.kind === 'download').map((c) => [c.name, c.commit, c.number]).sort(), [['Delve-ticket-70-exe-e889baa9-windows.zip', 'e889baa9', open.number], ['Game.exe', null, open.number]], "a closed minion's files and a zip not named like a build don't count");
  assert.deepEqual(copies.filter((c) => c.kind === 'site').map((c) => [c.port, c.running]), [[8116, true], [9000, false]]);
  assert.deepEqual(copies.filter((c) => c.kind === 'debug-apk').map((c) => [c.target, c.name, c.commit, c.link]), [['apk:android-release', 'build 8', 'sha8', 'https://github.com/o/r/actions/runs/8']], 'the newest run that passed, not the one running');
});
