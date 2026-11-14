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
import type { Want } from '../src/ci-mirror.ts';
import { ApkReader, CiPackageReader, ContraptionReader, FileReader, gradleVersion, lengths, MainReader, PrsInFlight, TestCopyReader, type Actions, type Artifact } from '../src/release-readers.ts';
import { CITADEL_TARGET, Releases, type TargetView } from '../src/releases.ts';
import { buildOf, copySources, detect, jobName, shipsOn, TargetFinder, zipNames, type BuildFile, type Found, type SchemeFacts } from '../src/release-targets.ts';

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
  project: { id: 5, name: 'Mandate', repo_url: 'https://github.com/o/mandate' }, own: false, branch: 'main', contraptions: [], apkFeeds: [], workflows: [], overrides: [], ...over,
});
const ids = (f: SchemeFacts) => detect(f).map((t) => `${t.kind} ${t.id} ${t.name}`);

test('a contraption, an APK workflow and a Windows release job are three targets; a debug build and a test job are none', () => {
  const found = detect(facts({
    contraptions: [{ name: 'mandate', title: 'Mandate' }], apkFeeds: ['mandate'],
    workflows: [{ path: '.github/workflows/android-release.yml', text: APK }, { path: '.github/workflows/windows.yml', text: WINDOWS }, { path: '.github/workflows/android.yml', text: DEBUG }],
  }));
  assert.deepEqual(found.map((t) => `${t.kind} ${t.id} ${t.name}`), ['contraption app:mandate Contraption', 'apk apk:android-release Android', 'ci ci:windows:release Windows']);
  assert.equal(found[1].link, '/apps/mandate/android/', 'the APK the app serves');
  assert.equal(found[1].contraption, 'mandate');
  assert.equal(found[2].link, null, 'nothing on GitHub: members may have no access there (#673)');
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
  assert.deepEqual(v.target, { id: 'app:mandate', projectId: p.id, name: 'Contraption', kind: 'contraption', link: '/apps/mandate/' });
  assert.equal(v.current?.version, base, 'what the folder has checked out, with no deploy recorded yet');
  assert.deepEqual([v.current?.number, v.current?.link], [1, '/apps/mandate/'], 'release 1, linked to the app itself');
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
  assert.equal(v.next?.waitingOn, "2 changes on main aren't live yet: they go out with the next deploy, from the Deploy button or by auto-deploy once main sits still for 5 minutes");
  assert.equal(v.next?.number, 2);
  assert.equal(v.next?.eta, null);
  assert.deepEqual(v.next?.stages.map((s) => s.name), ['call', 'build', 'drain', 'restart', 'live']);
  assert.deepEqual(v.next?.changes.map((c) => c.title), ['Snooze']);
  assert.ok(Math.abs(v.next!.since - (Date.now() - 3_600_000)) < 2000, 'since the oldest undeployed commit');

  // A first deploy that failed leaves the commit it started from serving, still Release 1.
  store.addContraptionDeploy({ name: 'mandate', from_sha: base, to_sha: 'bad', by: 'Cara', started_at: now - 9.5e6, finished_at: now - 9.5e6, outcome: 'rolled back', stages: '{}', changes: '[]' });
  [v] = reader.read();
  assert.deepEqual([v.current?.number, v.next?.number], [1, 2]);

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
  assert.equal(v.current?.number, 3, 'two deploys, after the commit it served before its first');
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
  assert.deepEqual([v.current?.number, v.current?.link], [4, '/apps/mandate/'], 'numbered on from the deploys before it, linked to the app');
  assert.equal(v.recent.length, 9, 'every earlier deploy, failed tries too (up to 10), for Previous releases');
  assert.deepEqual([v.recent[0].outcome, v.recent[0].number, v.recent[0].link], ['rolled back', null, null], "a try that didn't go live has no number, and nothing to open");
});

// A workflow's runs and jobs as GitHub's API gives them, newest first, counting the reads.
const iso = (ms: number) => new Date(ms).toISOString();
function fakeActions(runs: Run[], jobs: Record<number, Job[]>, artifacts: Record<number, Artifact[]> = {}) {
  const reads = { runs: 0, jobs: 0, artifacts: 0 };
  const actions: Actions = {
    async workflowRuns() { reads.runs++; return runs; },
    async runJobs(_p, run) { reads.jobs++; return jobs[run.id] ?? []; },
    async runArtifacts(_p, run) { reads.artifacts++; return artifacts[run.id] ?? []; },
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
  // Run 3 uploaded its package beside a crash dump; run 2's package expired.
  const artifacts = { 3: [{ id: 30, name: 'dumps-windows-sha3', expired: false }, { id: 31, name: 'r-sha3', expired: false, expires_at: new Date(now + 60 * m).toISOString() }], 2: [{ id: 20, name: 'r-sha2', expired: true }] };
  const { actions, reads } = fakeActions(runs, jobs, artifacts);
  const wants: Want[] = [];
  const reader = new CiPackageReader({ store, finder: finderOf([t]), actions, mirror: { want: (w) => void wants.push(w) }, now: () => now });
  await reader.refresh();
  const [v] = reader.read();
  assert.deepEqual(v.target, { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null });
  assert.deepEqual([v.current?.number, v.current?.version], [2, 'sha3'], 'run 4 skipped its release job, so run 3 is what people have: release 2, after run 2 that shipped before it');
  assert.equal(v.current?.link, null, 'nothing of it on perigee yet: no link, never GitHub (#673)');
  assert.deepEqual(wants.map((w) => [w.run.id, w.artifact.id, w.workflow, w.kind, w.target]), [[3, 31, 'windows.yml', 'release', 'release']], 'its package (named for the repo, not the dump) is mirrored into the CI store; run 2\'s expired');
  assert.deepEqual(v.current?.stages, { ci: 600, package: 600 });
  assert.deepEqual(v.recent.map((r) => [r.number, r.outcome, r.link]), [[1, 'live', null], [null, 'failed', null]], 'runs from before counting began are counted in (Cara: "This should say the build number"); a failed one has no number; no file on perigee: no link');
  assert.equal(v.next?.number, 3);
  assert.equal(v.next?.stage, 'package');
  assert.equal(v.next?.usual, 600, 'the median package time of the shipped runs');
  assert.equal(v.next?.eta, now - 2 * m + 600_000);
  assert.deepEqual(v.next?.stages.map((s) => s.name), ['ci', 'package', 'live']);

  // While a run moves, every refresh reads again; once all are done, the next read waits for the idle interval.
  await reader.refresh();
  assert.equal(reads.runs, 2);
  assert.equal(reads.artifacts, 2, "each shipped run's files are read once");
  runs[0] = run(5, 'completed', 'success', now - 6 * m, now);
  jobs[5][1] = job(5, 'release', 'completed', 'success', now - 2 * m, now);
  await reader.refresh();
  await reader.refresh();
  assert.equal(reads.runs, 3, 'nothing moving: no read until the idle interval passes');
  const [done] = reader.read();
  assert.equal(done.current?.number, 3, 'counted on with no gap for the runs that shipped nothing');
  assert.deepEqual(done.recent.map((r) => r.number), [2, 1, null]);
  await reader.refresh();
  assert.equal(store.countReleases(p.id, t.id), 3, 'each run is counted once');
  assert.equal(done.next, null);
});

test('the CI package reader: a target that began counting at its newest run counts its older shipped runs in under it', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Peek Auras', 'https://github.com/o/r');
  const t: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', workflow: '.github/workflows/windows.yml', job: 'release' };
  const now = Date.now(), m = 60_000;
  // Counting began before this change with run 3 alone as Release 1.
  store.addRelease({ project_id: p.id, target: t.id, version: 'run:3', changes: '[]', started_at: now - 60 * m, live_at: now - 40 * m, outcome: 'live', stages: '{}' });
  const runs = [3, 2, 1].map((i) => run(i, 'completed', 'success', now - (100 - i) * m, now - (90 - i) * m));
  const jobs = Object.fromEntries([3, 2, 1].map((i) => [i, [job(i, 'release', 'completed', 'success', now - (95 - i) * m, now - (90 - i) * m)]]));
  const reader = new CiPackageReader({ store, finder: finderOf([t]), actions: fakeActions(runs, jobs).actions, now: () => now });
  await reader.refresh();
  const [v] = reader.read();
  assert.deepEqual([v.current?.number, ...v.recent.map((r) => r.number)], [3, 2, 1], 'numbered by run: the older ones slot in under it, no "Earlier release" left');
  await reader.refresh();
  assert.equal(store.countReleases(p.id, t.id), 3, 'each run is counted once');
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
  assert.deepEqual([v.current?.number, v.current?.version, v.current?.link, v.current?.live], [5, '1.4', '/apps/mandate/android/mandate-5.apk', feedAt], "numbered by its versionCode; main's versionName names it");
  assert.equal(v.next, null);
  assert.deepEqual(v.recent.map((r) => [r.number, r.version, r.outcome, r.stages.sign]), [[null, 'sha7', 'signed', 480], [null, 'sha6', 'signed', 600]], 'signed runs count by run, not versionCode: no release number');
  assert.equal(reader.pending(t), null, 'nothing for auto-deploy to do');

  // A minion bumps the version on main: nobody has started a release run yet.
  writeFileSync(join(repo, 'android/app/build.gradle'), 'defaultConfig {\n  versionCode 6\n  versionName "1.5"\n}\n');
  git(repo, ['commit', '-q', '-am', 'v6']);
  await reader.refresh();
  [v] = reader.read();
  const notStarted = "1.5 is on main, but its release run hasn't started: the Deploy button starts it, or auto-deploy once main sits still for 5 minutes";
  assert.deepEqual([v.next?.stage, v.next?.waitingOn, v.next?.eta, v.next?.number], ['sign', notStarted, null, 6]);
  const bumped = git(repo, ['rev-parse', 'HEAD']).toString().trim();
  assert.deepEqual(reader.pending(t), { step: 'dispatch', head: bumped }, 'runs signed before latest.json was written are not this release');

  // Someone starts one: with nothing moving, the runs are read again once the idle interval has passed; it signs on CI.
  runs.unshift(run(8, 'in_progress', null, now - 2 * m));
  await reader.refresh();
  [v] = reader.read();
  assert.equal(v.next?.waitingOn, notStarted, 'not read again yet');
  clock += 5 * m;
  await reader.refresh();
  [v] = reader.read();
  assert.deepEqual([v.next?.stage, v.next?.waitingOn, v.next?.usual], ['sign', null, 540]);
  assert.equal(reader.pending(t), null, 'a run is moving: nothing to start');
  assert.equal(v.next?.eta, null, 'publishing is a person\'s step, so no estimate');

  // Signed: waiting for someone to publish it.
  runs[0] = run(8, 'completed', 'success', now - 2 * m, now);
  await reader.refresh();
  [v] = reader.read();
  assert.deepEqual([v.next?.stage, v.next?.waitingOn], ['publish', '1.5 is signed: it goes out with the Deploy button, or by auto-deploy within 5 minutes']);
  assert.deepEqual(reader.pending(t), { step: 'publish', run: runs[0], current: 5, main: { code: 6, name: '1.5' } });
  reader.tooOld(8);
  assert.deepEqual(reader.pending(t), { step: 'dispatch', head: bumped }, 'a run signed before the bump waits for a new run');
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
  assert.deepEqual([v.current?.number, v.current?.outcome, v.current?.stages.sign], [1, 'live', 300]);
  assert.deepEqual(v.recent.map((r) => [r.number, r.outcome]), [[null, 'failed']]);
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
  assert.deepEqual([v.current?.number, v.current?.link], [1, null], 'release 1, with no commit link');
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
  assert.deepEqual([v.next?.stage, v.next?.waitingOn, v.next?.eta, v.next?.number], ['merge', 'PR #12 waits for a go to merge', null, 2]);
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
  assert.deepEqual(v.recent.map((r) => [r.version, r.number]), [[base, 1]]);
  assert.equal(v.current?.number, 2);
  assert.deepEqual([v.next?.stage, v.next?.text, v.next?.usual], ['checks', 'test step 3 of 8', 300]);
  assert.equal(v.next?.eta, null, 'merge waits on a person, so no estimate');
});

test('a scheme with a contraption and an APK shows its open PRs on its contraption, ahead of its own stages, once (#655)', () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const mandate = store.createProject('Mandate', 'https://github.com/o/mandate');
  const delve = store.createProject('Delve', 'https://github.com/o/delve');
  const citadel = store.createProject('Citadel', 'https://github.com/o/citadel');
  const now = Date.now();
  const prs = new Map<number, PrSnapshot>();
  const pr = (number: number, status: 'pending' | 'passed', draft = false): PrSnapshot => ({ number, url: '', state: 'OPEN', draft, headSha: 'x', closedAt: null, closedBy: null, checks: [{ name: 'test', status, url: null }], remarks: [] });
  const minion = (projectId: number, title: string, p: PrSnapshot) => {
    const t = store.createTicket({ project_id: projectId, title, permission_mode: 'default', created_by: 'Josh' });
    store.setTicketDir(t.id, root, `ticket/${t.number}-x`);
    prs.set(t.id, p);
    return t.id;
  };
  const stale = minion(mandate.id, 'Stale Today page', pr(85, 'pending'));
  const widget = minion(mandate.id, 'Widget alert', pr(84, 'passed'));
  minion(mandate.id, 'A draft', pr(83, 'pending', true));
  minion(delve.id, 'Torches', pr(12, 'pending'));
  minion(citadel.id, 'Citadel fix', pr(9, 'pending'));
  const view = (projectId: number, id: string, kind: string, number: number | null, next: TargetView['next'] = null): Omit<TargetView, 'testCopies'> => ({
    target: { id, projectId, name: id, kind, link: null }, current: number == null ? null : { version: 'v', number, link: null, changes: [], started: null, live: null, outcome: 'live', stages: {} }, next, line: [], recent: [],
  });
  let views = [
    view(mandate.id, 'app:mandate', 'contraption', 3), view(mandate.id, 'apk:android-release', 'apk', 7),
    view(delve.id, 'main', 'main', 5), view(citadel.id, CITADEL_TARGET, CITADEL_TARGET, 40),
  ];
  const inFlight = new PrsInFlight({ store, pr: (id) => prs.get(id) ?? null, now: () => now });
  const releases = new Releases({ store, readers: [{ read: () => views }], testCopies: () => new Map(), broadcast: () => {}, inFlight: (v) => inFlight.attach(v) });
  const target = (projectId: number, id: string) => releases.read().find((s) => s.projectId === projectId)!.targets.find((t) => t.target.id === id)!;

  let app = target(mandate.id, 'app:mandate');
  assert.deepEqual(app.next?.changes.map((c) => [c.title, c.stage]), [['Widget alert', 'merge'], ['Stale Today page', 'checks']], 'its open PRs, the furthest along first, no draft');
  assert.deepEqual([app.next?.stage, app.next?.waitingOn, app.next?.number, app.next?.eta], ['merge', 'PR #84 waits for a go to merge', 4, null]);
  assert.deepEqual(app.next?.stages.map((s) => s.name), ['checks', 'merge', 'call', 'build', 'drain', 'restart', 'live'], "the PR's stages come before the contraption's own");
  assert.equal(target(mandate.id, 'apk:android-release').next, null, 'one target takes them, so All shows each PR once');
  assert.equal(target(delve.id, 'main').next, null, 'Main reads its own PRs (MainReader), so none are added twice');
  assert.equal(target(citadel.id, CITADEL_TARGET).next, null, "Citadel's server keeps its land line");

  // A deploy in flight still leads; the PRs follow it, and its estimate stands.
  const deploying = { stage: 'build', since: now - 30_000, usual: 60, waitingOn: null, text: 'building', number: 4, link: null, eta: now + 90_000,
    stages: ['call', 'build', 'drain', 'restart', 'live'].map((name) => ({ name, usual: name === 'call' ? null : 30 })),
    changes: [{ ticketId: widget, number: 2, title: 'Widget alert', stage: 'build', since: now - 30_000, usual: 60, waitingOn: null, text: 'building' }] };
  views = [view(mandate.id, 'app:mandate', 'contraption', 3, deploying)];
  app = target(mandate.id, 'app:mandate');
  assert.deepEqual([app.next?.stage, app.next?.eta, app.next?.number], ['build', now + 90_000, 4]);
  assert.deepEqual(app.next?.changes.map((c) => [c.ticketId, c.stage]), [[widget, 'build'], [stale, 'checks']], 'a minion already in the deploy is not listed again for its PR');
  assert.deepEqual(app.next?.stages.map((s) => s.name), ['checks', 'merge', 'call', 'build', 'drain', 'restart', 'live']);
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
  assert.equal(reader.read()[0].current?.number, 1);
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
  for (const [id, names] of [[open.id, ['Delve-ticket-70-exe-e889baa9-windows.zip', 'notes.md', 'art-pack.zip', 'Game.exe', 'Delve-debug.apk']], [closed.id, ['Delve-old-1234567-windows.zip']]] as const) {
    mkdirSync(dir(id), { recursive: true });
    for (const name of names) writeFileSync(join(dir(id), name), 'x');
  }
  const now = Date.now();
  const debugRun: Found = { id: 'debug:android', projectId: p.id, name: 'Debug APK', kind: 'apk', link: null, branch: 'main', workflow: '.github/workflows/android.yml' };
  const { actions } = fakeActions([run(9, 'in_progress', null, now - 60_000), run(8, 'completed', 'success', now - 600_000, now - 300_000)], {});
  const reader = new TestCopyReader({
    store, actions, now: () => now, sharedDir: (t) => dir(t.id), listening: async (port) => port === 8116,
    finder: { list: () => [], releaseFiles: () => new Set<string>(), copySources: () => [{ kind: 'site', projectId: p.id, name: 'Preview site', port: 8116 }, { kind: 'site', projectId: p.id, name: 'Preview site', port: 9000 }, { kind: 'debug-apk', projectId: p.id, target: 'apk:android-release', run: debugRun }] },
  });
  await reader.scan();
  const copies = reader.list().get(p.id)!;
  assert.deepEqual(copies.filter((c) => c.kind === 'download').map((c) => [c.name, c.commit, c.number]).sort(), [['Delve-debug.apk', null, open.number], ['Delve-ticket-70-exe-e889baa9-windows.zip', 'e889baa9', open.number]], "a closed minion's files, a zip not named like a build and a type the file route won't serve (.exe) don't count");
  assert.deepEqual(copies.filter((c) => c.kind === 'site').map((c) => [c.port, c.running]), [[8116, true], [9000, false]]);
  assert.deepEqual(copies.filter((c) => c.kind === 'debug-apk').map((c) => [c.target, c.name, c.commit, c.link]), [['apk:android-release', 'build 8', 'sha8', undefined]], 'the newest run that passed, not the one running; no file of it on perigee, so no link');
});

test('the APK reader keeps each scheme\'s target apart, and holds off a second release run while GitHub lists the first', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const repo = join(root, `apk-repo-${++n}`);
  mkdirSync(join(repo, 'app'), { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'app/build.gradle'), 'versionCode 9\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'v9']);
  const a = store.createProject('A', 'https://github.com/o/a');
  const b = store.createProject('B', 'https://github.com/o/b');
  store.setProjectRepoDir(a.id, repo);
  const t = (p: number, c: string): Found => ({ id: 'apk:android-release', projectId: p, name: 'Android', kind: 'apk', link: null, branch: 'main', workflow: '.github/workflows/android-release.yml', contraption: c });
  const ta = t(a.id, 'a'), tb = t(b.id, 'b');
  let clock = Date.now();
  const { actions } = fakeActions([], {});
  const reader = new ApkReader({ store, finder: finderOf([ta, tb]), actions, now: () => clock, feed: async (c) => ({ versionCode: c === 'a' ? 8 : 9, at: clock - 60_000 }) });
  await reader.refresh();
  assert.equal(reader.pending(ta)?.step, 'dispatch', "A's main is ahead of A's feed");
  assert.equal(reader.pending(tb), null, "B has no clone: A's version on main isn't B's");
  reader.started(ta);
  assert.equal(reader.pending(ta), null, 'just started: not listed yet, but not started again');
  clock += 3 * 60_000;
  assert.equal(reader.pending(ta)?.step, 'dispatch', 'a dispatch GitHub never listed can be tried again');
});

// A zip holding these names, made by Python's zipfile so the reader meets a real central directory.
const zipOf = (file: string, names: string[]) => execFileSync('python3', ['-I', '-c', 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z:\n  [z.writestr(n, "x") for n in sys.argv[2:]]', file, ...names]);

test('buildOf: an APK, a Chrome extension, a Windows build and a zipped APK by what is inside; a debug or branch build is no release', () => {
  assert.deepEqual(buildOf('FuckSpamTexts-0.4.apk', null), { platform: 'Android', release: true, version: '0.4' });
  assert.deepEqual(buildOf('FuckSpamTexts-debug.apk', null), { platform: 'Android', release: false, version: 'FuckSpamTexts-debug' });
  assert.deepEqual(buildOf('fuckspamtexts-messages-web-0.2.0.zip', ['manifest.json', 'popup.js']), { platform: 'Chrome', release: true, version: '0.2.0' });
  assert.deepEqual(buildOf('ext.zip', ['ext/manifest.json']), { platform: 'Chrome', release: true, version: 'ext' }, 'a manifest one folder in');
  assert.deepEqual(buildOf('Delve-b7-final-4336e0a8-windows.zip', ['Delve/Delve.exe', 'Delve/Delve.pck']), { platform: 'Windows', release: true, version: '4336e0a8' });
  assert.equal(buildOf('Delve-ticket-70-exe-e889baa9-windows.zip', ['Delve.exe'])?.release, false, "a minion's branch build is a test copy");
  assert.equal(buildOf('FuckSpamTexts-0.4.zip', ['FuckSpamTexts-0.4.apk'])?.platform, 'Android');
  assert.equal(buildOf('art-pack.zip', ['a.png', 'deep/x/manifest.json']), null, 'a zip of anything else, or a manifest buried deeper, is no build');
  assert.equal(buildOf('notes.md', null), null);
});

test('zipNames reads a real zip\'s file list; a file that is no zip reads as null', async () => {
  const z = join(root, `names-${++n}.zip`);
  zipOf(z, ['manifest.json', 'icons/16.png']);
  assert.deepEqual(await zipNames(z), ['manifest.json', 'icons/16.png']);
  writeFileSync(join(root, 'not.zip'), 'not a zip at all');
  assert.equal(await zipNames(join(root, 'not.zip')), null);
  assert.equal(await zipNames(join(root, 'missing.zip')), null);
});

const build = (name: string, platform: string, version: string, at: number, release = true): BuildFile => ({ ticketId: 1, number: 1, path: `/s/${name}`, abs: `/s/${name}`, name, at, platform, release, version });

test('shared release files are a target per platform; Main goes, a debug build, another scheme\'s build and a platform CI ships add none', () => {
  const files = [
    build('FuckSpamTexts-0.4.apk', 'Android', '0.4', 30), build('FuckSpamTexts-0.4.zip', 'Android', '0.4', 31),
    build('FuckSpamTexts-0.3.apk', 'Android', '0.3', 20), build('FuckSpamTexts-debug.apk', 'Android', 'x', 40, false),
    build('fuckspamtexts-messages-web-0.2.0.zip', 'Chrome', '0.2.0', 10), build('Delve-main-a0c312c-windows.zip', 'Windows', 'a0c312c', 50),
  ];
  const found = detect(facts({ project: { id: 8, name: 'FuckSpamTexts', repo_url: 'https://github.com/o/fuckspamtexts.git' }, files }));
  assert.deepEqual(found.map((t) => `${t.kind} ${t.id} ${t.name}`), ['file file:android Android', 'file file:chrome Chrome']);
  assert.deepEqual(found[0].files!.map((b) => b.name), ['FuckSpamTexts-0.4.apk', 'FuckSpamTexts-0.3.apk'], 'one file per version, the APK over the same APK zipped');
  assert.deepEqual(found[0].shared, ['/s/FuckSpamTexts-0.4.apk', '/s/FuckSpamTexts-0.4.zip', '/s/FuckSpamTexts-0.3.apk'], 'the dropped duplicate is still a release, not a test copy');
  const tie = detect(facts({ files: [build('mandate-1.0-a.zip', 'Windows', '1.0', 5), build('mandate-1.0-b.zip', 'Windows', '1.0', 5)] }));
  assert.deepEqual(tie[0].files!.map((b) => b.name), ['mandate-1.0-a.zip'], 'a tie keeps one');
  assert.deepEqual(ids(facts({ project: { id: 1, name: 'Delve', repo_url: 'https://github.com/o/gamedevtest.git' }, files: [build('Delve-main-a0c312c-windows.zip', 'Windows', 'a0c312c', 50)] })), ['file file:windows Windows'], 'named for the scheme, not its repo');
  assert.deepEqual(ids(facts({ files: [build('mandate-3.apk', 'Android', 'mandate-3', 1)], apkFeeds: ['mandate'] })), ['apk apk:mandate Android'], 'an app that serves its APK is the Android target');
  assert.deepEqual(ids(facts({ project: { id: 3, name: 'Peek Auras', repo_url: 'https://github.com/o/peek-auras' }, files: [build('peek-auras-6cda6fa.zip', 'Windows', '6cda6fa', 1)], workflows: [{ path: '.github/workflows/windows.yml', text: WINDOWS }] })), ['ci ci:windows:release Windows']);
});

test('the file reader: each shared release file is a release, numbered from the first, linked to download; the test copies leave it out', async () => {
  const store = new Store(join(root, `f-${++n}.db`));
  const p = store.createProject('FuckSpamTexts', null);
  const t = store.createTicket({ project_id: p.id, title: 'Release 0.4', permission_mode: 'default', created_by: 'Cara' });
  const dir = join(root, `fst-${n}`);
  mkdirSync(dir, { recursive: true });
  for (const name of ['FuckSpamTexts-0.3.apk', 'FuckSpamTexts-0.4.apk', 'FuckSpamTexts-debug.apk']) writeFileSync(join(dir, name), 'x');
  zipOf(join(dir, 'fst-web-0.2.0.zip'), ['manifest.json']);
  let at = 1000;
  for (const name of ['FuckSpamTexts-0.3.apk', 'FuckSpamTexts-0.4.apk', 'FuckSpamTexts-debug.apk', 'fst-web-0.2.0.zip']) {
    store.syncArtifacts(t, [...(store.listArtifacts(p.id).map((a) => ({ path: a.path, size: a.size, mtime: a.mtime }))), { path: join(dir, name), size: 1, mtime: 1 }]);
    (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db.prepare('UPDATE artifacts SET created_at = ? WHERE path = ?').run(at += 1000, join(dir, name));
  }
  const finder = new TargetFinder({ store, own: () => null, apkFeed: () => join(root, 'none.json') });
  await finder.scan();
  assert.deepEqual(finder.list().map((x) => x.id), ['file:android'], "a Chrome zip not named for the scheme isn't its build");
  const [view] = new FileReader({ finder }).read();
  assert.deepEqual([view.current?.number, view.current?.version, view.current?.live], [2, '0.4', 3000]);
  assert.equal(view.current?.link, `/api/tickets/${t.id}/file?path=${encodeURIComponent(join(dir, 'FuckSpamTexts-0.4.apk'))}&download`);
  assert.deepEqual(view.recent.map((r) => [r.number, r.version]), [[1, '0.3']]);
  assert.deepEqual([...finder.releaseFiles()].sort(), [join(dir, 'FuckSpamTexts-0.3.apk'), join(dir, 'FuckSpamTexts-0.4.apk')]);
  const copies = new TestCopyReader({ store, actions: fakeActions([], {}).actions, now: () => 0, sharedDir: () => dir, listening: async () => false, finder });
  await copies.scan();
  assert.deepEqual((copies.list().get(p.id) ?? []).map((c) => c.name), ['FuckSpamTexts-debug.apk'], 'a release is no test copy; the debug build still is');
});

test('a run\'s file in the CI store is its download, and once the store sweeps it there is no link, never GitHub (#658, #673)', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Peek Auras', 'https://github.com/o/r');
  const t: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', workflow: '.github/workflows/windows.yml', job: 'release' };
  const now = Date.now(), m = 60_000;
  const runs = [run(3, 'in_progress', null, now - 2 * m), run(2, 'completed', 'success', now - 60 * m, now - 40 * m)];
  const jobs = { 3: [job(3, 'release', 'in_progress', null, now - m, null)], 2: [job(2, 'release', 'completed', 'success', now - 50 * m, now - 40 * m)] };
  const reader = new CiPackageReader({ store, finder: finderOf([t]), actions: fakeActions(runs, jobs).actions });
  const file = { project_id: p.id, workflow: 'windows.yml', run_id: 2, run_attempt: 1, sha: 'a'.repeat(40), ref: '', target: '', size: 1, sha256: '', created_at: now };
  store.putCiFile({ ...file, name: 'logs.tar.gz', kind: 'report' });
  const build = store.putCiFile({ ...file, name: 'peek auras.zip', kind: 'build' });
  await reader.refresh();
  assert.equal(reader.read()[0].current?.link, `/api/projects/${p.id}/ci-files/${build.id}/peek%20auras.zip`, 'the build, not the report');
  store.deleteCiFile(build.id);
  await reader.refresh(); // run 3 still moves, so this reads again
  assert.equal(reader.read()[0].current?.link, null);
});

test('a mirrored artifact links once the mirror says it is in the store, though the workflow sits still (#673)', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Peek Auras', 'https://github.com/o/r');
  const t: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', workflow: '.github/workflows/windows.yml', job: 'release' };
  const now = Date.now(), m = 60_000;
  const runs = [run(2, 'completed', 'success', now - 60 * m, now - 40 * m)];
  const jobs = { 2: [job(2, 'release', 'completed', 'success', now - 50 * m, now - 40 * m)] };
  const { actions, reads } = fakeActions(runs, jobs, { 2: [{ id: 21, name: 'r-sha2', expired: false, expires_at: iso(now + 60 * m) }] });
  let row: { id: number; name: string } | null = null;
  // The mirror finishes behind the poll: the file lands, then it tells the reader.
  const wanted: Want[] = [];
  const reader = new CiPackageReader({ store, finder: finderOf([t]), actions, mirror: { want: (w) => void wanted.push(w) }, now: () => now });
  await reader.refresh();
  assert.equal(reader.read()[0].current?.link, null);
  assert.equal(wanted.length, 1);
  row = store.putCiFile({ project_id: p.id, workflow: 'windows.yml', run_id: 2, run_attempt: 1, sha: 'a'.repeat(40), ref: '', target: 'release', size: 1, sha256: '', created_at: now, name: 'r.zip', kind: 'release' });
  await reader.refresh();
  assert.equal(reader.read()[0].current?.link, null, 'idle: not read again until the interval, unless told');
  wanted[0].done();
  await reader.refresh();
  assert.equal(reader.read()[0].current?.link, `/api/projects/${p.id}/ci-files/${row.id}/r.zip`);
  assert.equal(reads.artifacts, 1, 'its artifacts were listed once');
  assert.equal(wanted.length, 1, 'once in the store, not wanted again');
});
