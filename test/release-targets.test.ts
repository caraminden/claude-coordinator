import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { DeployView } from '../src/app-services.ts';
import { Store } from '../src/db.ts';
import type { Job, Run } from '../src/ci-health.ts';
import type { PrSnapshot } from '../src/github.ts';
import type { Want } from '../src/ci-mirror.ts';
import type { Pin } from '../src/last-green.ts';
import { ApkReader, buildWait, shipsOnTarget, ROLLBACK_BRANCH, CiPackageReader, ContraptionReader, FileReader, gradleVersion, landProgress, landQueue, LandsInFlight, schemeLine, placeRank, lengths, MainReader, PrsInFlight, TestCopyReader, type Actions, type Artifact } from '../src/release-readers.ts';
import { BEHIND_OLD, CITADEL_TARGET, landedIn, named, OLD_LAND, Releases, type TargetView } from '../src/releases.ts';
import { buildOf, copySources, detect, jobName, pushPaths, shipsOn, shipsTo, TargetFinder, workdirOf, zipNames, type BuildFile, type Found, type SchemeFacts } from '../src/release-targets.ts';
import { git, gitAt } from './git.ts';
import { writeOrder } from '../src/waits.ts';

// src/release-targets.ts and src/release-readers.ts (#627): every scheme's targets found from what it has, and a reader per kind.
const root = mkdtempSync(join(tmpdir(), 'release-targets-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

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
  project: { id: 5, name: 'Mandate', repo_url: 'https://github.com/o/mandate' },
  own: false,
  branch: 'main',
  contraptions: [],
  apkFeeds: [],
  workflows: [],
  overrides: [],
  ...over,
});
const ids = (f: SchemeFacts) => detect(f).map((t) => `${t.kind} ${t.id} ${t.name}`);

test('a contraption, an APK workflow and a Windows release job are three targets; a debug build and a test job are none', () => {
  const found = detect(
    facts({
      contraptions: [{ name: 'mandate', title: 'Mandate' }],
      apkFeeds: ['mandate'],
      workflows: [
        { path: '.github/workflows/android-release.yml', text: APK },
        { path: '.github/workflows/windows.yml', text: WINDOWS },
        { path: '.github/workflows/android.yml', text: DEBUG },
      ],
    }),
  );
  assert.deepEqual(
    found.map((t) => `${t.kind} ${t.id} ${t.name}`),
    ['contraption app:mandate Contraption', 'apk apk:android-release Android', 'ci ci:windows:release Windows'],
  );
  assert.equal(found[1].link, '/apps/mandate/android/', 'the APK the app serves');
  assert.equal(found[1].contraption, 'mandate');
  assert.equal(found[2].link, null, 'nothing on GitHub: members may have no access there (#673)');
  assert.equal(found[2].job, 'release');
});

test('a scheme with nothing that ships gets Main; one whose server is its target (Citadel) or with no repo and nothing gets none', () => {
  assert.deepEqual(ids(facts()), ['main main Main']);
  assert.deepEqual(ids(facts({ workflows: [{ path: '.github/workflows/android.yml', text: DEBUG }] })), ['main main Main'], 'a debug build is a test copy');
  assert.deepEqual(ids(facts({ own: true })), []);
  assert.deepEqual(
    ids(
      facts({
        contraptions: [
          { name: 'a', title: 'Alpha' },
          { name: 'b', title: 'Beta' },
        ],
      }),
    ),
    ['contraption app:a Alpha', 'contraption app:b Beta'],
    'two apps go by their names; no Main',
  );
});

test('citadel-app.json targets rename, relink and hide a found target', () => {
  const overrides = [
    { id: 'app:mandate', name: 'Web', link: '/apps/mandate/inbox' },
    { id: 'ci:windows:release', hidden: true },
  ];
  const found = detect(facts({ contraptions: [{ name: 'mandate', title: 'Mandate' }], workflows: [{ path: '.github/workflows/windows.yml', text: WINDOWS }], overrides }));
  assert.deepEqual(
    found.map((t) => [t.id, t.name, t.link]),
    [['app:mandate', 'Web', '/apps/mandate/inbox']],
  );
  assert.deepEqual(ids(facts({ overrides: [{ id: 'main', hidden: true }] })), [], 'Main hidden too');
});

test('a target owns its folders: a contraption its workdir, an APK its top folder, a CI job its push paths, an override any (#764)', () => {
  const PATHS = WINDOWS.replace("branches: [main, 'land/**']", 'branches: [main]\n    paths:\n      - \'native/**\'\n      - "crates/**" # the shared crates\n      - .github/workflows/windows.yml');
  const found = detect(
    facts({
      contraptions: [{ name: 'mandate', title: 'Mandate', repo: 'o/mandate' }],
      apkFeeds: ['mandate'],
      appDir: 'web/',
      apkDir: 'android/',
      workflows: [
        { path: '.github/workflows/android-release.yml', text: APK },
        { path: '.github/workflows/windows.yml', text: PATHS },
      ],
    }),
  );
  assert.deepEqual(
    found.map((t) => [t.id, t.paths]),
    [
      ['app:mandate', ['web/']],
      ['apk:android-release', ['android/']],
      ['ci:windows:release', ['native/**', 'crates/**', '.github/workflows/windows.yml']],
    ],
  );
  const other = detect(facts({ contraptions: [{ name: 'x', title: 'X', repo: 'o/elsewhere' }], appDir: 'web/' }));
  assert.equal(other[0].paths, undefined, "another repo's contraption: this repo's workdir isn't its folder");
  const over = detect(facts({ workflows: [{ path: '.github/workflows/windows.yml', text: WINDOWS }], overrides: [{ id: 'ci:windows:release', paths: ['native/', 7 as never, ' '], release: { name: 'Build {n}', number: 'run' } }] }));
  assert.deepEqual(over[0].paths, ['native/']);
  assert.deepEqual(over[0].numbering, { name: 'Build {n}', number: 'run' });
  const bad = (release: unknown) => detect(facts({ overrides: [{ id: 'main', release: release as never }] }))[0].numbering;
  assert.equal(bad({ name: 'Build', number: 'sometimes' }), undefined, 'a name with no {n} and an unknown number are both dropped');
  assert.deepEqual(bad({ number: 'count' }), { number: 'count' });
  assert.equal(bad('Build {n}'), undefined);
  const needs = (release: unknown) => detect(facts({ workflows: [{ path: '.github/workflows/windows.yml', text: WINDOWS }], overrides: [{ id: 'ci:windows:release', release: release as never }] }))[0].needs;
  assert.deepEqual(needs({ needs: ['.github/workflows/desktop.yml', 'desktop.yml', 'e2e.yaml', 'x/../../etc', 3] }), ['desktop.yml', 'e2e.yaml'], 'workflow files by name, once each; anything else is dropped (#1019)');
  assert.equal(needs({ name: 'Build {n}' }), undefined);
});

test("an app in a folder of its repo (#1136) owns that folder: only changes there ship on it, even as the scheme's one target", () => {
  const [notes] = detect(facts({ contraptions: [{ name: 'notes', title: 'Notes', subdir: 'apps/notes' }], appDir: 'web/' }));
  assert.deepEqual([notes.id, notes.paths, notes.own], ['app:notes', ['apps/notes/'], true], 'its folder, not the root workdir');
  const on = shipsOnTarget(notes, [notes]);
  assert.equal(on(['apps/notes/server.ts', 'README.md']), true);
  assert.equal(on(['README.md', 'apps/notesy/x.ts']), false, 'the rest of the repo never ships on it');
  assert.equal(on(null), true, 'files unknown: counted, as for every target');
  const root = detect(
    facts({
      contraptions: [
        { name: 'site', title: 'Site' },
        { name: 'notes', title: 'Notes', subdir: 'apps/notes/' },
      ],
    }),
  );
  assert.deepEqual(shipsTo(['apps/notes/a.ts'], root), ['app:notes']);
  assert.deepEqual(shipsTo(['server.ts'], root), ['app:site']);
});

test('a lone CI target with push paths ships only changes there (#1300)', () => {
  const [d] = detect(facts({ workflows: [{ path: '.github/workflows/desktop.yml', text: "on:\n  push:\n    branches: [main]\n    paths:\n      - 'desktop/**'\njobs:\n  release:\n    steps:\n      - uses: actions/upload-artifact@v4\n" }] }));
  assert.deepEqual(d.paths, ['desktop/**']);
  const on = shipsOnTarget(d, [d]);
  assert.equal(on(['src/x.ts']), false, 'a change outside desktop/ is not on it');
  assert.equal(on(['desktop/main.js']), true);
  assert.equal(on(null), true, 'files unknown: counted');
  assert.equal(shipsOnTarget({ ...d, paths: undefined }, [{ ...d, paths: undefined }])(['src/x.ts']), true, 'no paths: takes everything, as before');
});

test('pushPaths and workdirOf read the folder a workflow and a contraption ship from', () => {
  assert.deepEqual(pushPaths('on:\n  push:\n    branches: [main]\n    paths: [\'android/**\', ".github/x.yml"]\njobs: {}\n'), ['android/**', '.github/x.yml']);
  assert.equal(pushPaths('on:\n  push:\n    branches: [main]\n  pull_request:\n    paths: [a/**]\njobs: {}\n'), null, "a PR's filter is not the push's");
  assert.equal(pushPaths('on: push\n'), null);
  assert.equal(workdirOf('{"workdir": "./companion/"}'), 'companion/');
  for (const t of ['{"workdir": "."}', '{"workdir": "../up"}', '{}', 'not json', null]) assert.equal(workdirOf(t), undefined, String(t));
});

test('shipsTo: each file goes to the targets whose folder holds it, the rest to the folderless ones, nothing known to the first', () => {
  // Peek: companion/ is its contraption, the rest builds Windows. Mandate: android/ the APK, the rest the web app.
  const peek = [
    { id: 'app:peek', kind: 'contraption', paths: ['companion/'] },
    { id: 'ci:windows:release', kind: 'ci' },
  ];
  assert.deepEqual(shipsTo(['companion/src/a.ts'], peek), ['app:peek']);
  assert.deepEqual(shipsTo(['crates/x/lib.rs', 'README.md'], peek), ['ci:windows:release']);
  assert.deepEqual(shipsTo(['companion/a.ts', 'crates/x.rs'], peek), ['app:peek', 'ci:windows:release'], 'a change can ship on both');
  assert.deepEqual(shipsTo(['companionship.md'], peek), ['ci:windows:release'], 'a folder, not a name prefix');
  assert.deepEqual(shipsTo([], peek), ['app:peek'], 'no files known: the first target');
  assert.deepEqual(shipsTo(null, peek), ['app:peek']);
  const mandate = [
    { id: 'app:mandate', kind: 'contraption' },
    { id: 'apk:android-release', kind: 'apk', paths: ['android/**'] },
  ];
  assert.deepEqual(shipsTo(['android/app/build.gradle'], mandate), ['apk:android-release']);
  assert.deepEqual(shipsTo(['server.ts'], mandate), ['app:mandate']);
  // Every target has a folder and the file is in none: the first target, so the change never drops out.
  assert.deepEqual(
    shipsTo(
      ['docs/x.md'],
      [
        { id: 'a', kind: 'ci', paths: ['a/'] },
        { id: 'b', kind: 'ci', paths: ['b/'] },
      ],
    ),
    ['a'],
  );
  // A shared release file has no pipeline: it takes changes only when it is all there is.
  assert.deepEqual(
    shipsTo(
      ['x'],
      [
        { id: 'file:windows', kind: 'file' },
        { id: 'main', kind: 'main' },
      ],
    ),
    ['main'],
  );
  assert.deepEqual(shipsTo(['x'], [{ id: 'file:windows', kind: 'file' }]), ['file:windows']);
  assert.deepEqual(shipsTo(['x'], []), []);
  // A `!` pattern excludes, the last match deciding, as GitHub reads a paths filter.
  const split = [
    { id: 'ci', kind: 'ci' as const, paths: ['**', '!android/**'] },
    { id: 'apk', kind: 'apk' as const, paths: ['android/'] },
  ];
  assert.deepEqual(shipsTo(['android/app/A.kt'], split), ['apk']);
  assert.deepEqual(shipsTo(['src/a.rs'], split), ['ci']);
  assert.deepEqual(shipsTo(['android/keep.md'], [{ id: 'ci', kind: 'ci', paths: ['!android/**', 'android/keep.md'] }]), ['ci'], 'a later include wins back');
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

test('a job that keeps its build with ci-upload.sh --kind release ships a package, a build or report upload does not (#1269)', () => {
  const wf = (kind: string) => `on:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: tools/ci-upload.sh --kind ${kind} out.zip\n`;
  assert.deepEqual(ids(facts({ workflows: [{ path: '.github/workflows/desktop.yml', text: wf('release') }] })), ['ci ci:desktop:build Linux']);
  assert.deepEqual(ids(facts({ workflows: [{ path: '.github/workflows/desktop.yml', text: wf('build') }] })), ['main main Main']);
});

test('the finder reads a scheme clone: a new scheme whose repo has a release workflow gets its row with no other step', async () => {
  const store = new Store(join(root, `f-${++n}.db`));
  const repo = join(root, `repo-${n}`);
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.github/workflows/windows.yml'), WINDOWS);
  writeFileSync(join(repo, 'citadel-app.json'), JSON.stringify({ start: ['x'], targets: [{ id: 'ci:windows:release', name: 'PC' }] }));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'ci');
  const finder = new TargetFinder({ store, own: () => null, apkFeed: (name) => join(root, 'feeds', name) });
  await finder.scan();
  assert.deepEqual(finder.list(), []);
  const p = store.createProject('Peek', 'https://github.com/o/peek');
  store.setProjectRepoDir(p.id, repo);
  const empty = store.createProject('Notes', null);
  await finder.scan();
  assert.deepEqual(
    finder.list().map((t) => [t.projectId, t.id, t.name, t.branch]),
    [[p.id, 'ci:windows:release', 'PC', 'main']],
  );
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
  const repo = join(root, `app-repo-${n}`),
    folder = join(root, `app-folder-${n}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  gitAt(Date.now() - 7_200_000, repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(root, 'clone', '-q', repo, folder);
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
  // Committed an hour ago on its own branch, and only now (a kit sync's ff) on main: the card counts from the ff.
  git(repo, 'checkout', '-q', '-b', 'work');
  gitAt(Date.now() - 3_600_000, repo, 'commit', '-q', '--allow-empty', '-m', 'one');
  gitAt(Date.now(), repo, 'commit', '-q', '--allow-empty', '-m', 'two');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--ff-only', 'work');
  const tip = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', 'ticket/1-snooze', tip);
  await reader.refresh();
  [v] = reader.read();
  assert.equal(v.next?.stage, 'call');
  assert.equal(v.next?.waitingOn, "2 changes on main aren't live yet: they go out with the next deploy, from the Deploy button or by auto-deploy, at once unless more ships are coming");
  assert.equal(v.next?.number, 2);
  assert.equal(v.next?.eta, null);
  assert.deepEqual(
    v.next?.stages.map((s) => s.name),
    ['call', 'build', 'drain', 'restart', 'live'],
  );
  assert.deepEqual(
    v.next?.changes.map((c) => c.title),
    ['Snooze'],
  );
  assert.ok(Math.abs(v.next!.since - Date.now()) < 5000, 'since the oldest undeployed commit reached main, not since it was committed');

  // A first deploy that failed leaves the commit it started from serving, still Release 1.
  store.addContraptionDeploy({ name: 'mandate', from_sha: base, to_sha: 'bad', by: 'Cara', started_at: now - 9.5e6, finished_at: now - 9.5e6, outcome: 'rolled back', stages: '{}', changes: '[]' });
  [v] = reader.read();
  assert.deepEqual([v.current?.number, v.next?.number], [1, 2]);

  // Two earlier deploys give the usual times, and six failed ones after them don't hide those.
  for (const s of [
    { build: 60, drain: 5, restart: 20 },
    { build: 80, drain: 5, restart: 30 },
  ]) {
    store.addContraptionDeploy({ name: 'mandate', from_sha: 'old', to_sha: base, by: 'Cara', started_at: now - 9e6, finished_at: now - 9e6 + 1e5, outcome: 'deployed', stages: JSON.stringify(s), changes: '[]' });
  }
  for (let i = 0; i < 6; i++) store.addContraptionDeploy({ name: 'mandate', from_sha: base, to_sha: 'bad', by: 'Cara', started_at: now - 8e6, finished_at: now - 8e6, outcome: 'rolled back', stages: '{}', changes: '[]' });
  // A deploy starts and fast-forwards the folder before it builds: the old commit still serves, and main's changes stay its.
  running = { name: 'mandate', state: 'running', by: '#12', repo: 'o/mandate', branch: 'main', from: base, to: tip, started_at: now - 70_000, finished_at: null, said: ['Build: npm ci'], todo: [], log: '', stages: { build: now - 70_000 } };
  git(folder, 'pull', '-q', '--ff-only');
  await reader.refresh();
  [v] = reader.read();
  assert.equal(v.current?.version, base);
  assert.equal(v.current?.number, 3, 'two deploys, after the commit it served before its first');
  assert.equal(v.current?.live, now - 9e6 + 1e5, 'the newest deployed row of that commit');
  assert.equal(v.next?.stage, 'build');
  assert.equal(v.next?.usual, 70, 'the median build');
  assert.deepEqual(
    v.next?.changes.map((c) => c.title),
    ['Snooze'],
  );
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
  assert.deepEqual(
    JSON.parse(row.changes).map((c: { title: string }) => c.title),
    ['Snooze'],
  );
  await reader.refresh();
  [v] = reader.read();
  assert.equal(v.next, null);
  assert.equal(v.current?.version, tip);
  assert.deepEqual(
    v.current?.changes.map((c) => c.title),
    ['Snooze'],
  );
  assert.deepEqual([v.current?.number, v.current?.link], [4, '/apps/mandate/'], 'numbered on from the deploys before it, linked to the app');
  assert.equal(v.recent.length, 9, 'every earlier deploy, failed tries too (up to 10), for Previous releases');
  assert.deepEqual([v.recent[0].outcome, v.recent[0].number, v.recent[0].link], ['rolled back', null, null], "a try that didn't go live has no number, and nothing to open");
});

// A workflow's runs and jobs as GitHub's API gives them, newest first, counting the reads.
const iso = (ms: number) => new Date(ms).toISOString();
function fakeActions(runs: Run[], jobs: Record<number, Job[]>, artifacts: Record<number, Artifact[]> = {}) {
  const reads = { runs: 0, jobs: 0, artifacts: 0 };
  const actions: Actions = {
    async workflowRuns() {
      reads.runs++;
      return runs;
    },
    async runJobs(_p, run) {
      reads.jobs++;
      return jobs[run.id] ?? [];
    },
    async runArtifacts(_p, run) {
      reads.artifacts++;
      return artifacts[run.id] ?? [];
    },
  };
  return { actions, reads };
}
const run = (id: number, status: string, conclusion: string | null, created: number, updated?: number): Run => ({
  id,
  name: 'windows',
  workflow_id: 1,
  head_branch: 'main',
  head_sha: `sha${id}`,
  status,
  conclusion,
  created_at: iso(created),
  ...(updated != null && { updated_at: iso(updated) }),
  run_number: id,
  html_url: `https://github.com/o/r/actions/runs/${id}`,
});
const job = (runId: number, name: string, status: string, conclusion: string | null, started: number | null, completed: number | null): Job => ({
  id: runId * 10,
  run_id: runId,
  name,
  status,
  conclusion,
  created_at: iso(started ?? 0),
  started_at: started == null ? null : iso(started),
  completed_at: completed == null ? null : iso(completed),
  runner_name: null,
  labels: [],
});
const finderOf = (targets: Found[]) => ({ list: (kind?: string) => targets.filter((t) => !kind || t.kind === kind) });

test('the CI package reader: the newest run whose job passed is the release, a run in flight is the next, a skipped job shipped nothing', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Peek Auras', 'https://github.com/o/r');
  const t: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', workflow: '.github/workflows/windows.yml', job: 'release' };
  const now = Date.now(),
    m = 60_000;
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
  const artifacts = {
    3: [
      { id: 30, name: 'dumps-windows-sha3', expired: false },
      { id: 31, name: 'r-sha3', expired: false, expires_at: new Date(now + 60 * m).toISOString() },
    ],
    2: [{ id: 20, name: 'r-sha2', expired: true }],
  };
  const { actions, reads } = fakeActions(runs, jobs, artifacts);
  const wants: Want[] = [];
  const reader = new CiPackageReader({ store, finder: finderOf([t]), actions, mirror: { want: (w) => void wants.push(w) }, now: () => now });
  await reader.refresh();
  const [v] = reader.read();
  assert.deepEqual(v.target, { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null });
  assert.deepEqual([v.current?.number, v.current?.version], [2, 'sha3'], 'run 4 skipped its release job, so run 3 is what people have: release 2, after run 2 that shipped before it');
  assert.equal(v.current?.link, null, 'nothing of it on perigee yet: no link, never GitHub (#673)');
  assert.deepEqual(
    wants.map((w) => [w.run.id, w.artifact.id, w.workflow, w.kind, w.target]),
    [[3, 31, 'windows.yml', 'release', 'release']],
    "its package (named for the repo, not the dump) is mirrored into the CI store; run 2's expired",
  );
  assert.deepEqual(v.current?.stages, { ci: 600, package: 600 });
  assert.deepEqual(
    v.recent.map((r) => [r.number, r.outcome, r.link]),
    [
      [1, 'live', null],
      [null, 'failed', null],
    ],
    'runs from before counting began are counted in (Cara: "This should say the build number"); a failed one has no number; no file on perigee: no link',
  );
  assert.equal(v.next?.number, 3);
  assert.equal(v.next?.stage, 'package');
  assert.equal(v.next?.usual, 600, 'the median package time of the shipped runs');
  assert.equal(v.next?.eta, now - 2 * m + 600_000);
  assert.deepEqual(
    v.next?.stages.map((s) => s.name),
    ['ci', 'package', 'live'],
  );

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
  assert.deepEqual(
    done.recent.map((r) => r.number),
    [2, 1, null],
  );
  await reader.refresh();
  assert.equal(store.countReleases(p.id, t.id), 3, 'each run is counted once');
  assert.equal(done.next, null);
});

test('the CI package reader: a target that began counting at its newest run counts its older shipped runs in under it', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Peek Auras', 'https://github.com/o/r');
  const t: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', workflow: '.github/workflows/windows.yml', job: 'release' };
  const now = Date.now(),
    m = 60_000;
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

test("the CI package reader: a desktop target's run is live, with its install link, only once its feed has it (#1522)", async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Peek Auras', 'https://github.com/o/r');
  const t: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', workflow: '.github/workflows/windows.yml', job: 'release', desktop: { app: 'peek' } };
  const now = Date.now(),
    m = 60_000;
  const runs = [run(3, 'completed', 'success', now - 30 * m, now - 25 * m), run(2, 'completed', 'success', now - 60 * m, now - 50 * m)];
  const jobs = { 3: [job(3, 'release', 'completed', 'success', now - 28 * m, now - 25 * m)], 2: [job(2, 'release', 'completed', 'success', now - 55 * m, now - 50 * m)] };
  let feed: string[] = ['ci:2'];
  const refused = new Set<number>([3]);
  const published: number[] = [];
  const desktop = Object.assign((_t: unknown, r: { id: number }) => void published.push(r.id), { failed: (_p: number, app: string, r: number) => app === 'peek' && refused.has(r) });
  const feeds = { index: async (_p: number, app: string) => ({ app, current: 1, builds: feed.map((source, i) => ({ build: feed.length - i, exe: 'Peek.exe', started: 'file' as const, zip: `peek-${i}.zip`, sha256: '', size: 0, at: 0, source })) }) };
  const reader = new CiPackageReader({ store, finder: finderOf([t]), actions: fakeActions(runs, jobs).actions, now: () => now, desktop, feeds });
  const install = `/api/desktop/${p.id}/peek/install.zip`;

  // Run 3 shipped in CI, but the feed refused its build: PCs keep run 2's, so that is what is live.
  await reader.refresh();
  assert.deepEqual(published, [3], 'the newest build CI shipped is still what the feed is asked to take');
  let [v] = reader.read();
  assert.deepEqual([v.current?.version, v.current?.outcome, v.current?.link], ['sha2', 'live', install], 'the build on the feed is live, with the install link');
  assert.deepEqual(
    v.recent.map((r) => [r.version, r.outcome, r.number, r.link]),
    [['sha3', 'failed', null, null]],
    'the refused build is a failed try: no number, no link',
  );
  assert.equal(store.countReleases(p.id, t.id), 1, 'a build no PC can get is not counted as a release');

  // Still on its way to the feed (not refused): the next release, at its publish stage.
  refused.clear();
  [v] = reader.read();
  assert.equal(v.current?.version, 'sha2');
  assert.deepEqual(v.recent, []);
  assert.deepEqual([v.next?.stage, v.next?.text, v.next?.stages.map((s) => s.name)], ['publish', 'publishing to the desktop feed', ['ci', 'package', 'publish', 'live']]);

  // Once the feed has it, it is live; the older one stays live in Previous after the feed drops it (it keeps a few).
  feed = ['ci:3'];
  await reader.refresh();
  [v] = reader.read();
  assert.deepEqual([v.current?.version, v.current?.link, v.next], ['sha3', install, null]);
  assert.deepEqual(
    v.recent.map((r) => [r.version, r.outcome]),
    [['sha2', 'live']],
  );
  assert.equal(store.countReleases(p.id, t.id), 2);

  // A server with no publisher (a dev copy, a preview) puts nothing on the feed: CI's release is what's live there.
  const store2 = new Store(join(root, `c-${++n}.db`));
  const bare = new CiPackageReader({ store: store2, finder: finderOf([{ ...t, projectId: store2.createProject('Peek Auras', 'https://github.com/o/r').id }]), actions: fakeActions(runs, jobs).actions, now: () => now, feeds });
  feed = [];
  await bare.refresh();
  [v] = bare.read();
  assert.deepEqual([v.current?.version, v.next], ['sha3', null], 'no publisher: no feed gate, no publish stage');
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
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'android/app/build.gradle'), 'defaultConfig {\n  versionCode 5\n  versionName "1.4"\n}\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'v5');
  const p = store.createProject('Mandate', 'https://github.com/o/mandate');
  store.setProjectRepoDir(p.id, repo);
  const t: Found = { id: 'apk:android-release', projectId: p.id, name: 'Android', kind: 'apk', link: '/apps/mandate/android/', branch: 'main', workflow: '.github/workflows/android-release.yml', contraption: 'mandate' };
  const now = Date.now(),
    m = 60_000;
  const feedAt = now - 100 * m;
  const runs: Run[] = [run(7, 'completed', 'success', now - 120 * m, now - 112 * m), run(6, 'completed', 'success', now - 300 * m, now - 290 * m)];
  const { actions } = fakeActions(runs, {});
  let clock = now;
  const reader = new ApkReader({ store, finder: finderOf([t]), actions, now: () => clock, feed: async () => ({ versionCode: 5, apk: 'mandate-5.apk', at: feedAt }) });
  await reader.refresh();
  let [v] = reader.read();
  assert.deepEqual([v.current?.number, v.current?.version, v.current?.link, v.current?.live], [5, '1.4', '/apps/mandate/android/mandate-5.apk', feedAt], "numbered by its versionCode; main's versionName names it");
  assert.equal(v.next, null);
  assert.deepEqual(
    v.recent.map((r) => [r.number, r.version, r.outcome, r.stages.sign]),
    [
      [null, 'sha7', 'signed', 480],
      [null, 'sha6', 'signed', 600],
    ],
    'signed runs count by run, not versionCode: no release number',
  );
  assert.equal(reader.pending(t), null, 'nothing for auto-deploy to do');

  // A minion bumps the version on main: nobody has started a release run yet.
  writeFileSync(join(repo, 'android/app/build.gradle'), 'defaultConfig {\n  versionCode 6\n  versionName "1.5"\n}\n');
  git(repo, 'commit', '-q', '-am', 'v6');
  await reader.refresh();
  [v] = reader.read();
  const notStarted = "1.5 is on main, but its release run hasn't started: the Deploy button starts it, or auto-deploy, at once unless more ships are coming";
  assert.deepEqual([v.next?.stage, v.next?.waitingOn, v.next?.eta, v.next?.number], ['sign', notStarted, null, 6]);
  const bumped = git(repo, 'rev-parse', 'HEAD').toString().trim();
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
  assert.equal(v.next?.eta, null, "publishing is a person's step, so no estimate");

  // Signed: waiting for someone to publish it.
  runs[0] = run(8, 'completed', 'success', now - 2 * m, now);
  await reader.refresh();
  [v] = reader.read();
  assert.deepEqual([v.next?.stage, v.next?.waitingOn], ['publish', '1.5 is signed: it goes out with the Deploy button, or by auto-deploy, at once unless more ships are coming']);
  assert.deepEqual(reader.pending(t), { step: 'publish', run: runs[0], current: 5, main: { code: 6, name: '1.5' } });
  reader.tooOld(8);
  assert.deepEqual(reader.pending(t), { step: 'dispatch', head: bumped }, 'a run signed before the bump waits for a new run');
});

test("a CI-signed APK's roll back (ADR 0012): its run on the roll back branch signs last green, is handed on once to publish, then is the current build", async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Mandate', 'https://github.com/o/mandate');
  const t: Found = { id: 'apk:android-release', projectId: p.id, name: 'Android', kind: 'apk', link: null, branch: 'main', workflow: '.github/workflows/android-release.yml', contraption: 'mandate' };
  const now = Date.now(),
    m = 60_000;
  const main: Run[] = [run(7, 'completed', 'success', now - 120 * m, now - 112 * m)];
  const back: Run[] = [];
  const branches: string[] = [];
  const actions: Actions = {
    async workflowRuns(_p, _w, branch) {
      branches.push(branch);
      return branch === ROLLBACK_BRANCH ? back : main;
    },
    async runJobs() {
      return [];
    },
  };
  store.recordApkPublish({ projectId: p.id, contraption: 'mandate', versionCode: 5, runId: 7, by: 'Cara', uid: null });
  let feed = { versionCode: 5, at: now - 100 * m };
  let pin: Pin | null = null;
  const handed: [number, number, number][] = [];
  const failed: string[] = [];
  const reader = new ApkReader({
    store,
    finder: finderOf([t]),
    actions,
    now: () => now,
    feed: async () => feed,
    pinned: () => pin,
    rolledBack: (_t, r, current, code) => handed.push([r.id, current, code]),
    rollbackFailed: (_t, why) => failed.push(why),
  });
  await reader.refresh();
  let [v] = reader.read();
  assert.equal(v.current?.commit, 'sha7', 'the published build names the commit it was built from');
  assert.ok(!branches.includes(ROLLBACK_BRANCH), 'the roll back branch is read only while a roll back holds it');

  // Rolled back to last green as build 6: nothing listed yet, then its run signs.
  pin = { sha: 'shaG', from: 'sha7', by: 'Cara', at: now, code: 6 };
  await reader.refresh();
  [v] = reader.read();
  assert.ok(reader.rollingBack(p.id, t.id));
  assert.deepEqual([v.next?.number, v.next?.waitingOn], [6, `Last green's release run on ${ROLLBACK_BRANCH} hasn't started yet`]);
  back.unshift({ ...run(20, 'in_progress', null, now + 1000), head_branch: ROLLBACK_BRANCH, head_sha: 'shaG' });
  await reader.refresh();
  [v] = reader.read();
  assert.deepEqual([v.next?.stage, v.next?.waitingOn, v.next?.number], ['sign', null, 6], 'read again at once, though nothing on main moves');
  assert.deepEqual(handed, []);
  back[0] = { ...back[0], status: 'completed', conclusion: 'success', updated_at: iso(now + 9 * m) };
  await reader.refresh();
  await reader.refresh();
  assert.deepEqual(handed, [[20, 5, 6]], 'handed on to publish once, numbered one past the published build');

  // Published: last green is the current build, and nothing waits.
  store.recordApkPublish({ projectId: p.id, contraption: 'mandate', versionCode: 6, runId: 20, by: 'Cara', uid: null });
  feed = { versionCode: 6, at: now + 10 * m };
  await reader.refresh();
  [v] = reader.read();
  assert.deepEqual([v.current?.number, v.current?.commit, v.next], [6, 'shaG', null]);
  assert.ok(!reader.rollingBack(p.id, t.id));

  // A newer green ends the pin: phones still run the roll back's build, so its card still names last green's commit.
  pin = null;
  await reader.refresh();
  [v] = reader.read();
  assert.deepEqual([v.current?.number, v.current?.commit], [6, 'shaG']);

  // A second roll back whose run fails: said once, nothing handed on.
  pin = { sha: 'shaH', from: 'shaG', by: 'Cara', at: now + 20 * m, code: 7 };
  back.unshift({ ...run(21, 'completed', 'failure', now + 21 * m, now + 25 * m), head_branch: ROLLBACK_BRANCH, head_sha: 'shaH' });
  await reader.refresh();
  await reader.refresh();
  assert.deepEqual(failed, [`its release run on ${ROLLBACK_BRANCH} failure: https://github.com/o/r/actions/runs/21`]);
  assert.deepEqual(handed, [[20, 5, 6]]);
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
  assert.deepEqual(
    v.recent.map((r) => [r.number, r.outcome]),
    [[null, 'failed']],
  );
});

test('the Main reader: each head of main is a release with the minions it took in; open PRs are the next, by checks then a go to merge', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const repo = join(root, `main-repo-${n}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  gitAt(Date.now() - 7_200_000, repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
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
  assert.deepEqual(
    v.next?.changes.map((c) => [c.title, c.stage]),
    [
      ['Torches', 'merge'],
      ['Fog of war', 'checks'],
    ],
    'the one furthest along leads',
  );
  assert.deepEqual([v.next?.stage, v.next?.waitingOn, v.next?.eta, v.next?.number], ['merge', 'PR #12 waits for a go to ship', null, 2]);
  assert.deepEqual(
    v.next?.stages.map((s) => [s.name, s.usual]),
    [
      ['checks', null],
      ['merge', null],
      ['live', 0],
    ],
  );

  // Torches merges: main moves, and its row takes in the minion whose tip is on it.
  prs.delete(b.id);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'torches');
  const tip = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', 'ticket/2-torches', tip);
  await reader.refresh();
  [v] = reader.read();
  assert.equal(v.current?.version, tip);
  assert.deepEqual(
    v.current?.changes.map((c) => c.title),
    ['Torches'],
  );
  assert.deepEqual(
    v.recent.map((r) => [r.version, r.number]),
    [[base, 1]],
  );
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
    target: { id, projectId, name: id, kind, link: null },
    current: number == null ? null : { version: 'v', number, link: null, changes: [], started: null, live: null, outcome: 'live', stages: {} },
    next,
    line: [],
    recent: [],
  });
  let views = [view(mandate.id, 'app:mandate', 'contraption', 3), view(mandate.id, 'apk:android-release', 'apk', 7), view(delve.id, 'main', 'main', 5), view(citadel.id, CITADEL_TARGET, CITADEL_TARGET, 40)];
  const inFlight = new PrsInFlight({ store, pr: (id) => prs.get(id) ?? null, now: () => now });
  const releases = new Releases({ store, readers: [{ read: () => views }], testCopies: () => new Map(), broadcast: () => {}, inFlight: (v) => inFlight.attach(v) });
  const target = (projectId: number, id: string) =>
    releases
      .read()
      .find((s) => s.projectId === projectId)!
      .targets.find((t) => t.target.id === id)!;

  let app = target(mandate.id, 'app:mandate');
  assert.deepEqual(
    app.next?.changes.map((c) => [c.title, c.stage]),
    [
      ['Widget alert', 'merge'],
      ['Stale Today page', 'checks'],
    ],
    'its open PRs, the furthest along first, no draft',
  );
  assert.deepEqual([app.next?.stage, app.next?.waitingOn, app.next?.number, app.next?.eta], ['merge', 'PR #84 waits for a go to ship', 4, null]);
  assert.deepEqual(
    app.next?.stages.map((s) => s.name),
    ['checks', 'merge', 'call', 'build', 'drain', 'restart', 'live'],
    "the PR's stages come before the contraption's own",
  );
  assert.equal(target(mandate.id, 'apk:android-release').next, null, 'one target takes them, so All shows each PR once');
  assert.equal(target(delve.id, 'main').next, null, 'Main reads its own PRs (MainReader), so none are added twice');
  assert.equal(target(citadel.id, CITADEL_TARGET).next, null, "Citadel's server keeps its land line");

  // A deploy in flight still leads; the PRs follow it, and its estimate stands.
  const deploying = {
    stage: 'build',
    since: now - 30_000,
    usual: 60,
    waitingOn: null,
    text: 'building',
    number: 4,
    link: null,
    eta: now + 90_000,
    stages: ['call', 'build', 'drain', 'restart', 'live'].map((name) => ({ name, usual: name === 'call' ? null : 30 })),
    changes: [{ ticketId: widget, number: 2, title: 'Widget alert', stage: 'build', since: now - 30_000, usual: 60, waitingOn: null, text: 'building' }],
  };
  views = [view(mandate.id, 'app:mandate', 'contraption', 3, deploying)];
  app = target(mandate.id, 'app:mandate');
  assert.deepEqual([app.next?.stage, app.next?.eta, app.next?.number], ['build', now + 90_000, 4]);
  assert.deepEqual(
    app.next?.changes.map((c) => [c.ticketId, c.stage]),
    [
      [widget, 'build'],
      [stale, 'checks'],
    ],
    'a minion already in the deploy is not listed again for its PR',
  );
  assert.deepEqual(
    app.next?.stages.map((s) => s.name),
    ['checks', 'merge', 'call', 'build', 'drain', 'restart', 'live'],
  );
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
  function job_(name: string) {
    return job(2, name, 'completed', 'success', now - 300_000, now);
  }
  const reader = new CiPackageReader({ store, finder: finderOf([t]), actions, now: () => now });
  await reader.refresh();
  assert.equal(reader.read()[0].current?.number, 1);
});

// Shaped like poe2's deploy/preview.sh.
const PREVIEW = 'RUN=${RUN:-$HOME/.local/share/x}\nPORT=${PORT:-8116}\n';

test('test-copy sources: a debug APK workflow sits under the Android target, and a preview script is a site on its port', () => {
  const f = facts({
    workflows: [
      { path: '.github/workflows/android-release.yml', text: APK },
      { path: '.github/workflows/android.yml', text: DEBUG },
    ],
    scripts: [
      { path: 'deploy/preview.sh', text: PREVIEW },
      { path: 'tools/preview-notes.sh', text: 'echo hi' },
    ],
  });
  const found = detect(f);
  const src = copySources(f, found);
  assert.deepEqual(
    src.map((s) => (s.kind === 'site' ? [s.kind, s.port] : [s.kind, s.target, s.run.id, s.run.workflow])),
    [
      ['debug-apk', 'apk:android-release', 'debug:android', '.github/workflows/android.yml'],
      ['site', 8116],
    ],
  );
  assert.ok(!found.some((t) => t.id.startsWith('debug')), 'a debug build is no target');
  assert.deepEqual(
    copySources(facts({ workflows: [{ path: '.github/workflows/android.yml', text: DEBUG }] }), []).map((s) => s.kind === 'debug-apk' && s.target),
    [null],
    "with no Android target it sits in the scheme's list",
  );
});

test("the test-copy reader: builds open minions left in their files, a preview site up or down, and CI's newest debug APK", async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Delve', 'https://github.com/o/delve');
  const open = store.createTicket({ project_id: p.id, title: 'Windows exe', permission_mode: 'default', created_by: 'Josh' });
  const closed = store.createTicket({ project_id: p.id, title: 'Old build', permission_mode: 'default', created_by: 'Josh' });
  store.updateTicket(closed.id, { status: 'closed' });
  const dir = (id: number) => join(root, `shared-${n}`, String(id));
  for (const [id, names] of [
    [open.id, ['Delve-ticket-70-exe-e889baa9-windows.zip', 'notes.md', 'art-pack.zip', 'Game.exe', 'Delve-debug.apk']],
    [closed.id, ['Delve-old-1234567-windows.zip']],
  ] as const) {
    mkdirSync(dir(id), { recursive: true });
    for (const name of names) writeFileSync(join(dir(id), name), 'x');
  }
  const now = Date.now();
  const debugRun: Found = { id: 'debug:android', projectId: p.id, name: 'Debug APK', kind: 'apk', link: null, branch: 'main', workflow: '.github/workflows/android.yml' };
  const { actions } = fakeActions([run(9, 'in_progress', null, now - 60_000), run(8, 'completed', 'success', now - 600_000, now - 300_000)], {});
  const reader = new TestCopyReader({
    store,
    actions,
    now: () => now,
    sharedDir: (t) => dir(t.id),
    listening: async (port) => port === 8116,
    finder: {
      list: () => [],
      releaseFiles: () => new Set<string>(),
      copySources: () => [
        { kind: 'site', projectId: p.id, name: 'Preview site', port: 8116 },
        { kind: 'site', projectId: p.id, name: 'Preview site', port: 9000 },
        { kind: 'debug-apk', projectId: p.id, target: 'apk:android-release', run: debugRun },
      ],
    },
  });
  await reader.scan();
  const copies = reader.list().get(p.id)!;
  assert.deepEqual(
    copies
      .filter((c) => c.kind === 'download')
      .map((c) => [c.name, c.commit, c.number])
      .sort(),
    [
      ['Delve-debug.apk', null, open.number],
      ['Delve-ticket-70-exe-e889baa9-windows.zip', 'e889baa9', open.number],
    ],
    "a closed minion's files, a zip not named like a build and a type the file route won't serve (.exe) don't count",
  );
  assert.deepEqual(
    copies.filter((c) => c.kind === 'site').map((c) => [c.port, c.running]),
    [
      [8116, true],
      [9000, false],
    ],
  );
  assert.deepEqual(
    copies.filter((c) => c.kind === 'debug-apk').map((c) => [c.target, c.name, c.commit, c.link]),
    [['apk:android-release', 'build 8', 'sha8', undefined]],
    'the newest run that passed, not the one running; no file of it on perigee, so no link',
  );
});

test("the APK reader keeps each scheme's target apart, and holds off a second release run while GitHub lists the first", async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const repo = join(root, `apk-repo-${++n}`);
  mkdirSync(join(repo, 'app'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'app/build.gradle'), 'versionCode 9\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'v9');
  const a = store.createProject('A', 'https://github.com/o/a');
  const b = store.createProject('B', 'https://github.com/o/b');
  store.setProjectRepoDir(a.id, repo);
  const t = (p: number, c: string): Found => ({ id: 'apk:android-release', projectId: p, name: 'Android', kind: 'apk', link: null, branch: 'main', workflow: '.github/workflows/android-release.yml', contraption: c });
  const ta = t(a.id, 'a'),
    tb = t(b.id, 'b');
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
  assert.deepEqual(buildOf('fuckspamtexts-messages-web-v1.2.xpi', ['manifest.json', 'popup.js']), { platform: 'Firefox', release: true, version: '1.2' });
  assert.equal(buildOf('fuckspamtexts-v1.2.xpi', ['a/b/manifest.json']), null, 'an .xpi has its manifest at the root');
  assert.equal(buildOf('fuckspamtexts-v1.2.xpi', null), null, 'an unreadable .xpi is no build');
  assert.equal(buildOf('fuckspamtexts-debug-v1.2.xpi', ['manifest.json'])?.release, false);
  assert.equal(buildOf('notes.md', null), null);
});

test("zipNames reads a real zip's file list; a file that is no zip reads as null", async () => {
  const z = join(root, `names-${++n}.zip`);
  zipOf(z, ['manifest.json', 'icons/16.png']);
  assert.deepEqual(await zipNames(z), ['manifest.json', 'icons/16.png']);
  writeFileSync(join(root, 'not.zip'), 'not a zip at all');
  assert.equal(await zipNames(join(root, 'not.zip')), null);
  assert.equal(await zipNames(join(root, 'missing.zip')), null);
});

const build = (name: string, platform: string, version: string, at: number, release = true): BuildFile => ({ ticketId: 1, number: 1, path: `/s/${name}`, abs: `/s/${name}`, name, at, platform, release, version });

test("shared release files are a target per platform; Main goes, a debug build, another scheme's build and a platform CI ships add none", () => {
  const files = [
    build('FuckSpamTexts-0.4.apk', 'Android', '0.4', 30),
    build('FuckSpamTexts-0.4.zip', 'Android', '0.4', 31),
    build('FuckSpamTexts-0.3.apk', 'Android', '0.3', 20),
    build('FuckSpamTexts-debug.apk', 'Android', 'x', 40, false),
    build('fuckspamtexts-messages-web-0.2.0.zip', 'Chrome', '0.2.0', 10),
    build('Delve-main-a0c312c-windows.zip', 'Windows', 'a0c312c', 50),
  ];
  const found = detect(facts({ project: { id: 8, name: 'FuckSpamTexts', repo_url: 'https://github.com/o/fuckspamtexts.git' }, files }));
  assert.deepEqual(
    found.map((t) => `${t.kind} ${t.id} ${t.name}`),
    ['file file:android Android', 'file file:chrome Chrome'],
  );
  assert.deepEqual(
    found[0].files!.map((b) => b.name),
    ['FuckSpamTexts-0.4.apk', 'FuckSpamTexts-0.3.apk'],
    'one file per version, the APK over the same APK zipped',
  );
  assert.deepEqual(found[0].shared, ['/s/FuckSpamTexts-0.4.apk', '/s/FuckSpamTexts-0.4.zip', '/s/FuckSpamTexts-0.3.apk'], 'the dropped duplicate is still a release, not a test copy');
  const tie = detect(facts({ files: [build('mandate-1.0-a.zip', 'Windows', '1.0', 5), build('mandate-1.0-b.zip', 'Windows', '1.0', 5)] }));
  assert.deepEqual(
    tie[0].files!.map((b) => b.name),
    ['mandate-1.0-a.zip'],
    'a tie keeps one',
  );
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
    store.syncArtifacts(t, [...store.listArtifacts(p.id).map((a) => ({ path: a.path, size: a.size, mtime: a.mtime })), { path: join(dir, name), size: 1, mtime: 1 }]);
    (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db.prepare('UPDATE artifacts SET created_at = ? WHERE path = ?').run((at += 1000), join(dir, name));
  }
  const finder = new TargetFinder({ store, own: () => null, apkFeed: () => join(root, 'none.json') });
  await finder.scan();
  assert.deepEqual(
    finder.list().map((x) => x.id),
    ['file:android'],
    "a Chrome zip not named for the scheme isn't its build",
  );
  const [view] = new FileReader({ finder }).read();
  assert.deepEqual([view.current?.number, view.current?.version, view.current?.live], [2, '0.4', 3000]);
  assert.equal(view.current?.link, `/api/tickets/${t.id}/file?path=${encodeURIComponent(join(dir, 'FuckSpamTexts-0.4.apk'))}&download`);
  assert.deepEqual(
    view.recent.map((r) => [r.number, r.version]),
    [[1, '0.3']],
  );
  assert.deepEqual([...finder.releaseFiles()].sort(), [join(dir, 'FuckSpamTexts-0.3.apk'), join(dir, 'FuckSpamTexts-0.4.apk')]);
  const copies = new TestCopyReader({ store, actions: fakeActions([], {}).actions, now: () => 0, sharedDir: () => dir, listening: async () => false, finder });
  await copies.scan();
  assert.deepEqual(
    (copies.list().get(p.id) ?? []).map((c) => c.name),
    ['FuckSpamTexts-debug.apk'],
    'a release is no test copy; the debug build still is',
  );
});

test("a run's file in the CI store is its download, and once the store sweeps it there is no link, never GitHub (#658, #673)", async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Peek Auras', 'https://github.com/o/r');
  const t: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', workflow: '.github/workflows/windows.yml', job: 'release' };
  const now = Date.now(),
    m = 60_000;
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
  const now = Date.now(),
    m = 60_000;
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

/** A commit touching `file` at `at`, on a minion's branch named `branch` whose tip it is; its sha. */
function landOne(repo: string, at: number, file: string, branch?: string): string {
  mkdirSync(join(repo, file, '..'), { recursive: true });
  writeFileSync(join(repo, file), `${file} ${at}\n`);
  git(repo, 'add', '-A');
  gitAt(at, repo, 'commit', '-q', '-m', file);
  const sha = git(repo, 'rev-parse', 'HEAD');
  if (branch) git(repo, 'branch', branch, sha);
  return sha;
}

test("a batch member's ship counts by its refs/shipping name until its own branch moves (#1323)", async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const repo = join(root, `ship-repo-${n}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const at = Date.now() + 1000;
  const base = landOne(repo, at - 5000, 'README.md');
  const p = store.createProject('Citadel', null);
  store.setProjectRepoDir(p.id, repo);
  const minion = (branch: string) => {
    const t = store.createTicket({ project_id: p.id, title: branch, permission_mode: 'default', created_by: 'Cara' });
    store.setTicketDir(t.id, root, branch);
    return t.id;
  };
  const [head, member, later] = [minion('ticket/1-head'), minion('ticket/2-member'), minion('ticket/3-later')];
  // The member's branch still sits where it was before the batch rebased it; land_deploy named its batch commit.
  git(repo, 'branch', 'ticket/2-member', base);
  const m = landOne(repo, at, 'b.txt');
  git(repo, 'update-ref', 'refs/shipping/ticket/2-member', m);
  landOne(repo, at + 1000, 'a.txt', 'ticket/1-head');
  // A stale name whose branch's tip is in the range already counts by the branch, not by the name.
  landOne(repo, at + 2000, 'c.txt', 'ticket/3-later');
  git(repo, 'update-ref', 'refs/shipping/ticket/3-later', m);
  const got = await landedIn(store, store.getProject(p.id)!, base, git(repo, 'rev-parse', 'HEAD'));
  assert.deepEqual(
    got!.tickets.map((t) => t.id),
    [head, member, later],
  );
  assert.deepEqual(got!.ticketFiles.get(member), ['b.txt']);
  assert.deepEqual(got!.ticketFiles.get(later), ['c.txt']);
});

test('a CI package numbered by run: what is on main for it waits for CI, a run carries it as "Build <run>", a red run waits on a fix; the app\'s folder stays off it (#764)', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const repo = join(root, `peek-repo-${n}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const now = Date.now(),
    m = 60_000;
  const base = landOne(repo, now - 60 * m, 'README.md');
  const p = store.createProject('Peek Auras', 'https://github.com/o/peek');
  store.setProjectRepoDir(p.id, repo);
  const minion = (title: string, branch: string) => {
    const t = store.createTicket({ project_id: p.id, title, permission_mode: 'default', created_by: 'Cara' });
    store.setTicketDir(t.id, root, branch);
    return t;
  };
  minion('Overlay fix', 'ticket/1-overlay');
  minion('Companion page', 'ticket/2-companion');
  // A minion's work counts once it is newer than the minion (landedIn).
  const at = Date.now() + 1000;
  landOne(repo, at, 'crates/overlay/lib.rs', 'ticket/1-overlay');
  const head = landOne(repo, at + 1000, 'companion/page.ts', 'ticket/2-companion');
  const app: Found = { id: 'app:peek', projectId: p.id, name: 'Companion', kind: 'contraption', link: '/apps/peek/', branch: 'main', contraption: 'peek', paths: ['companion/'] };
  const t: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', workflow: '.github/workflows/windows.yml', job: 'release', numbering: { name: 'Build {n}', number: 'run' } };
  const runs: Run[] = [{ ...run(996, 'completed', 'success', now - 58 * m, now - 50 * m), head_sha: base }];
  const jobs: Record<number, Job[]> = { 996: [job(996, 'release', 'completed', 'success', now - 55 * m, now - 50 * m)] };
  const { actions, reads } = fakeActions(runs, jobs);
  let clock = now;
  const reader = new CiPackageReader({ store, finder: finderOf([app, t]), actions, now: () => clock });
  const view = () => {
    const [v] = reader.read();
    named(v);
    return v;
  };
  await reader.refresh();
  let v = view();
  assert.deepEqual([v.current?.number, v.current?.name], [996, 'Build 996'], 'numbered by its run, named by its template');
  assert.deepEqual(v.target.numbering, { name: 'Build {n}', number: 'run' }, 'served, for the page');
  assert.equal(v.next?.stage, 'ci');
  assert.equal(v.next?.waitingOn, 'on main: it goes out with the next build CI ships');
  assert.deepEqual(
    v.next?.changes.map((c) => c.title),
    ['Overlay fix'],
    "the companion's change ships on the app, not the Windows build",
  );
  assert.deepEqual([v.next?.number, v.next?.name], [null, 'Next build'], 'no run yet: no number');
  assert.ok(Math.abs(v.next!.since - at) < 2000, 'since its oldest commit on main');

  // CI starts a run on main's head: main moved past every run seen, so it's read again 30 s on, not 5 min.
  runs.unshift({ ...run(997, 'in_progress', null, now - 1 * m), head_sha: head });
  jobs[997] = [job(997, 'release', 'in_progress', null, now - 1 * m, null)];
  clock += 10_000;
  await reader.refresh();
  assert.equal(reads.runs, 1, 'not yet: 10 s since the last read');
  clock += 25_000;
  await reader.refresh();
  assert.equal(reads.runs, 2);
  v = view();
  assert.deepEqual([v.next?.stage, v.next?.number, v.next?.name], ['package', 997, 'Build 997']);
  assert.deepEqual(
    v.next?.changes.map((c) => [c.title, c.stage]),
    [['Overlay fix', 'package']],
  );

  // Something lands after run 997 started: its checkout can't hold it, so it's marked for the build after.
  minion('Hotkey fix', 'ticket/3-hotkey');
  const after = landOne(repo, Date.now() + 3000, 'crates/hotkey/lib.rs', 'ticket/3-hotkey');
  clock += 35_000;
  await reader.refresh();
  v = view();
  assert.deepEqual(
    v.next?.changes.map((c) => [c.title, c.stage, !!c.later]),
    [
      ['Overlay fix', 'package', false],
      ['Hotkey fix', 'ci', true],
    ],
  );

  // Its release job fails: what it carried waits on a fix.
  runs[0] = { ...run(997, 'completed', 'failure', now - 1 * m, clock), head_sha: head };
  jobs[997] = [job(997, 'release', 'completed', 'failure', now - 1 * m, clock)];
  await reader.refresh();
  v = view();
  assert.deepEqual([v.next?.stage, v.next?.waitingOn, v.next?.name], ['ci', 'CI failed on main: it waits on a fix', 'Next build']);
  assert.deepEqual(
    v.recent.map((r) => [r.number, r.name, r.outcome]),
    [[997, 'Build 997', 'failed']],
  );

  // Fixed and shipped: the release carries only what ships on Windows, and nothing is left on its way.
  runs.unshift({ ...run(998, 'completed', 'success', clock, clock + m), head_sha: after });
  jobs[998] = [job(998, 'release', 'completed', 'success', clock, clock + m)];
  clock += 6 * m;
  await reader.refresh();
  v = view();
  assert.deepEqual([v.current?.name, v.current?.changes.map((c) => c.title)], ['Build 998', ['Overlay fix', 'Hotkey fix']]);
  assert.equal(v.next, null);
});

test("an APK: changes to its folder on main with no version bump wait on one; the web app's changes stay off it (#764)", async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const repo = join(root, `apk-bump-${n}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const now = Date.now(),
    m = 60_000;
  writeFileSync(join(repo, 'x'), '');
  mkdirSync(join(repo, 'android/app'), { recursive: true });
  writeFileSync(join(repo, 'android/app/build.gradle'), 'defaultConfig {\n  versionCode 5\n  versionName "1.4"\n}\n');
  git(repo, 'add', '-A');
  gitAt(now - 300 * m, repo, 'commit', '-q', '-m', 'v5');
  const built = git(repo, 'rev-parse', 'HEAD');
  const p = store.createProject('Mandate', 'https://github.com/o/mandate');
  store.setProjectRepoDir(p.id, repo);
  for (const [title, branch] of [
    ['Widget', 'ticket/1-widget'],
    ['Inbox', 'ticket/2-inbox'],
  ])
    store.setTicketDir(store.createTicket({ project_id: p.id, title, permission_mode: 'default', created_by: 'Cara' }).id, root, branch);
  landOne(repo, Date.now() + 1000, 'android/app/src/Widget.kt', 'ticket/1-widget');
  landOne(repo, Date.now() + 2000, 'server.ts', 'ticket/2-inbox');
  const web: Found = { id: 'app:mandate', projectId: p.id, name: 'Web', kind: 'contraption', link: '/apps/mandate/', branch: 'main', contraption: 'mandate' };
  const t: Found = { id: 'apk:android-release', projectId: p.id, name: 'Android', kind: 'apk', link: '/apps/mandate/android/', branch: 'main', workflow: '.github/workflows/android-release.yml', contraption: 'mandate', paths: ['android/'] };
  // Run 7 signed main's head before latest.json was written, but Citadel published run 6's APK: the next counts from 6.
  const { actions } = fakeActions(
    [
      { ...run(7, 'completed', 'success', now - 250 * m, now - 240 * m), head_sha: git(repo, 'rev-parse', 'HEAD') },
      { ...run(6, 'completed', 'success', now - 290 * m, now - 280 * m), head_sha: built },
    ],
    {},
  );
  store.recordApkPublish({ projectId: p.id, contraption: 'mandate', versionCode: 5, runId: 6, by: 'Cara', uid: null });
  const reader = new ApkReader({ store, finder: finderOf([web, t]), actions, now: () => now, feed: async () => ({ versionCode: 5, apk: 'mandate-5.apk', at: now - 200 * m }) });
  await reader.refresh();
  const [v] = reader.read();
  assert.equal(v.next?.stage, 'sign');
  assert.equal(v.next?.waitingOn, '1 change to the app on main waits on a version bump: a release needs a higher versionCode');
  assert.deepEqual(
    v.next?.changes.map((c) => c.title),
    ['Widget'],
  );
  assert.equal(v.next?.changes[0].idle, true, 'nothing is running or scheduled for it: a minion row must not call it deploying');
  assert.equal(v.next?.number, null, 'its versionCode is not known before the bump');
  assert.equal(reader.pending(t), null, 'nothing for auto-deploy to start');
});

test('an APK: a change that only edits Markdown in its folder is no change to the app, so nothing waits on a version bump', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const repo = join(root, `apk-md-${n}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const now = Date.now(),
    m = 60_000;
  writeFileSync(join(repo, 'x'), '');
  mkdirSync(join(repo, 'android/app'), { recursive: true });
  writeFileSync(join(repo, 'android/app/build.gradle'), 'defaultConfig {\n  versionCode 5\n  versionName "1.4"\n}\n');
  git(repo, 'add', '-A');
  gitAt(now - 300 * m, repo, 'commit', '-q', '-m', 'v5');
  const built = git(repo, 'rev-parse', 'HEAD');
  const p = store.createProject('Mandate', 'https://github.com/o/mandate');
  store.setProjectRepoDir(p.id, repo);
  store.setTicketDir(store.createTicket({ project_id: p.id, title: 'Docs', permission_mode: 'default', created_by: 'Cara' }).id, root, 'ticket/1-docs');
  landOne(repo, Date.now() + 1000, 'android/README.md', 'ticket/1-docs');
  const web: Found = { id: 'app:mandate', projectId: p.id, name: 'Web', kind: 'contraption', link: '/apps/mandate/', branch: 'main', contraption: 'mandate' };
  const t: Found = { id: 'apk:android-release', projectId: p.id, name: 'Android', kind: 'apk', link: '/apps/mandate/android/', branch: 'main', workflow: '.github/workflows/android-release.yml', contraption: 'mandate', paths: ['android/'] };
  const { actions } = fakeActions([{ ...run(6, 'completed', 'success', now - 290 * m, now - 280 * m), head_sha: built }], {});
  store.recordApkPublish({ projectId: p.id, contraption: 'mandate', versionCode: 5, runId: 6, by: 'Cara', uid: null });
  const reader = new ApkReader({ store, finder: finderOf([web, t]), actions, now: () => now, feed: async () => ({ versionCode: 5, apk: 'mandate-5.apk', at: now - 200 * m }) });
  await reader.refresh();
  assert.equal(reader.read()[0].next, null);
});

test("a CI job's runs are read again early only when main's new head is in its push filter (#764)", async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const repo = join(root, `early-${n}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const now = Date.now(),
    m = 60_000;
  const base = landOne(repo, now - 60 * m, 'README.md');
  const p = store.createProject('Peek Auras', 'https://github.com/o/peek');
  store.setProjectRepoDir(p.id, repo);
  const t: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', workflow: '.github/workflows/windows.yml', job: 'release', paths: ['crates/'] };
  const { actions, reads } = fakeActions([{ ...run(1, 'completed', 'success', now - 58 * m, now - 50 * m), head_sha: base }], { 1: [job(1, 'release', 'completed', 'success', now - 55 * m, now - 50 * m)] });
  let clock = now;
  const reader = new CiPackageReader({ store, finder: finderOf([t]), actions, now: () => clock });
  await reader.refresh();
  landOne(repo, now, 'companion/a.ts');
  clock += 35_000;
  await reader.refresh();
  assert.equal(reads.runs, 1, 'outside its filter: no run will come, so no early read');
  landOne(repo, now, 'crates/a.rs');
  clock += 35_000;
  await reader.refresh();
  assert.equal(reads.runs, 2);
});

test('landProgress: in line for the lock with its place, then landing', () => {
  const line = landProgress('…\nqueue: 2nd in line for the land lock, about 9 min (ahead: ticket/441-x, checked 10:02)\n', 5);
  assert.deepEqual(line, { stage: 'land', since: 5, usual: null, waitingOn: 'in line to ship (2nd)', text: 'in line to ship (2nd)', brief: '2nd' });
  const got = landProgress('queue: 2nd in line for the land lock, about 9 min\nqueue: got the land lock\n', 5);
  assert.deepEqual([got.waitingOn, got.text], [null, 'shipping: tests, then onto main']);
  assert.equal(landProgress('', 5).waitingOn, null, 'no queue lines yet: landing');
});

test('landProgress: "next in line" is a place too, and rows rank landing first, then each place (#766)', () => {
  const next = landProgress('queue: next in line for the land lock (ahead: outside 3)\n', 5);
  assert.deepEqual([next.waitingOn, next.brief], ['in line to ship (next)', 'next']);
  assert.deepEqual(
    ['', 'next', '2nd', '5th'].map((b) => placeRank(b === '' ? undefined : b)),
    [0, 1, 2, 5],
  );
});

test('handed-off lands list in line order, not minion-number order (#766)', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const repo = join(root, `land-repo-${n}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  landOne(repo, Date.now(), 'README.md');
  const p = store.createProject('Peek Auras', 'https://github.com/o/peek');
  store.setProjectRepoDir(p.id, repo);
  const outs = new Map<number, string>();
  const places = ['', 'queue: 2nd in line for the land lock\n', 'queue: 5th in line for the land lock\n', 'queue: 4th in line for the land lock\n', 'queue: 3rd in line for the land lock\n'];
  const ids: number[] = [];
  places.forEach((o, i) => {
    const x = store.createTicket({ project_id: p.id, title: `Change ${i}`, permission_mode: 'default', created_by: 'Cara' });
    store.setTicketDir(x.id, root, `ticket/${i}-c`);
    ids.push(x.id);
    outs.set(x.id, o);
  });
  const ci: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', numbering: { name: 'Build {n}', number: 'run' } };
  const lands = new LandsInFlight({ store, finder: finderOf([ci]), landings: { handoffs: () => ids, get: (id) => ({ output: outs.get(id)!, code: null }) }, now: () => 1000 });
  const vs = [{ target: { id: ci.id, projectId: p.id, name: 'Windows', kind: 'ci', link: null }, current: null, next: null, line: [], recent: [] }];
  lands.attach(vs as never); // files not read yet: it goes on the first target, in this order either way
  const got = (vs[0].next as { changes: { title: string; brief?: string }[] } | null)?.changes ?? [];
  assert.deepEqual(
    got.map((c) => c.brief ?? 'landing'),
    ['landing', '2nd', '3rd', '4th', '5th'],
  );
  assert.deepEqual(
    got.map((c) => c.title),
    ['Change 0', 'Change 1', 'Change 4', 'Change 3', 'Change 2'],
  );
  // Only the change landing now is in the release under way; the rest of the line goes out after it, so none carries its number.
  assert.deepEqual(
    (got as { later?: boolean }[]).map((c) => !!c.later),
    [false, true, true, true, true],
  );
});

test('a handed-off land is on its targets from the hand-off: in line, then landing, ahead of what is on main (#764)', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const repo = join(root, `land-repo-${n}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  landOne(repo, Date.now(), 'README.md');
  const p = store.createProject('Peek Auras', 'https://github.com/o/peek');
  store.setProjectRepoDir(p.id, repo);
  const x = store.createTicket({ project_id: p.id, title: 'Overlay fix', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(x.id, root, 'ticket/1-overlay');
  git(repo, 'checkout', '-q', '-b', 'ticket/1-overlay');
  landOne(repo, Date.now(), 'crates/overlay/lib.rs');
  git(repo, 'checkout', '-q', 'main');
  const app: Found = { id: 'app:peek', projectId: p.id, name: 'Companion', kind: 'contraption', link: null, branch: 'main', paths: ['companion/'] };
  const ci: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', numbering: { name: 'Build {n}', number: 'run' } };
  let output = 'queue: 2nd in line for the land lock, about 9 min (ahead: ticket/441-x)\n';
  let code: number | null = null;
  const lands = new LandsInFlight({ store, finder: finderOf([app, ci]), landings: { handoffs: () => [x.id], get: () => ({ output, code }) }, now: () => 1000 });
  const views = () =>
    [app, ci].map((t) => ({
      target: { id: t.id, projectId: t.projectId, name: t.name, kind: t.kind, link: null, ...(t.numbering ? { numbering: t.numbering } : {}) },
      current: { version: 'v', number: 996, link: null, changes: [], started: null, live: null, outcome: 'live', stages: {} },
      next: null,
      line: [],
      recent: [],
    }));
  let vs = views();
  lands.attach(vs);
  assert.deepEqual(
    vs.map((v) => v.next?.changes.map((c) => c.title) ?? []),
    [['Overlay fix'], []],
    'its files not read yet: the first target',
  );
  for (let i = 0; i < 100 && vs[1].next == null; i++) {
    await new Promise((r) => setTimeout(r, 20));
    vs = views();
    lands.attach(vs);
  }
  assert.equal(vs[0].next, null, 'its branch touches no companion file');
  const [v] = [vs[1]];
  assert.deepEqual(
    v.next?.stages.map((s) => s.name),
    ['land', 'ci', 'package', 'live'],
  );
  assert.deepEqual([v.next?.stage, v.next?.waitingOn, v.next?.brief, v.next?.number], ['land', 'in line to ship (2nd)', '2nd', null], 'numbered by run: not known yet');
  named(v);
  assert.equal(v.next?.name, 'Next build');

  // It gets the lock, while something already on main waits for CI: that leads, the land joins behind it.
  output += 'queue: got the land lock\n';
  vs = views();
  vs[1].next = {
    stage: 'ci',
    since: 0,
    usual: null,
    waitingOn: 'w',
    text: 'w',
    number: null,
    link: null,
    stages: [
      { name: 'ci', usual: null },
      { name: 'package', usual: 5 },
      { name: 'live', usual: 0 },
    ],
    eta: null,
    changes: [{ ticketId: 99, number: 9, title: 'On main', stage: 'ci', since: 0, usual: null, waitingOn: 'w', text: 'w' }],
  };
  lands.attach(vs);
  assert.deepEqual(
    vs[1].next?.stages.map((s) => s.name),
    ['land', 'ci', 'package', 'live'],
  );
  assert.deepEqual(
    vs[1].next?.changes.map((c) => [c.title, c.stage, c.waitingOn]),
    [
      ['On main', 'ci', 'w'],
      ['Overlay fix', 'land', null],
    ],
  );
  // A build already under way (its change waits on nothing) can't take the land: it's marked for the one after.
  vs = views();
  vs[1].next = {
    stage: 'package',
    since: 0,
    usual: null,
    waitingOn: null,
    text: 'p',
    number: 997,
    link: null,
    stages: [
      { name: 'ci', usual: null },
      { name: 'package', usual: 5 },
      { name: 'live', usual: 0 },
    ],
    eta: null,
    changes: [{ ticketId: 99, number: 9, title: 'On main', stage: 'package', since: 0, usual: null, waitingOn: null, text: 'p' }],
  };
  lands.attach(vs);
  assert.deepEqual(
    vs[1].next?.changes.map((c) => [c.title, !!c.later]),
    [
      ['On main', false],
      ['Overlay fix', true],
    ],
  );

  // Done: off the list (a reader has it on main now).
  code = 0;
  vs = views();
  lands.attach(vs);
  assert.deepEqual(
    vs.map((v) => v.next),
    [null, null],
  );
});

test('named: a template names each numbered release; a next with no number is "Next <name>"; none keeps the default', () => {
  const r = (number: number | null) => ({ version: 'v', number, link: null, changes: [], started: null, live: null, outcome: 'live', stages: {} });
  const tv = { target: { id: 'x', projectId: 1, name: 'X', kind: 'ci', link: null, numbering: { name: 'Build {n}' } }, current: r(5), recent: [r(4), r(null)], next: { ...r(null), stage: 'ci', since: 0, usual: null, waitingOn: null, text: '', stages: [], eta: null, changes: [] } };
  named(tv);
  assert.deepEqual([tv.current.name, tv.recent.map((x) => (x as { name?: string }).name), tv.next.name], ['Build 5', ['Build 4', undefined], 'Next build']);
  const plain = { ...tv, target: { ...tv.target, numbering: undefined }, current: r(5), next: null, recent: [] };
  named(plain);
  assert.equal((plain.current as { name?: string }).name, undefined, 'no template: the page says "Release 5"');
});

test('a deploy build in the heavy queue says what it waits on, not "running long" (Cara, 2026-11-17)', () => {
  const job = (who: string, reason?: string) => ({ who, what: 'npm ci', since: 1, ...(reason && { reason }) });
  const heavy = { holders: [], waiters: [job('Citadel #5 (cara)'), job('voice deploy'), job('mandate deploy', 'load')] };
  assert.equal(buildWait(heavy, 'voice deploy'), 'in line for a build slot · 1 ahead');
  assert.equal(buildWait(heavy, 'mandate deploy'), 'perigee is busy · waiting for load to ease');
  assert.equal(buildWait({ holders: [], waiters: [job('voice deploy')] }, 'voice deploy'), 'in line for a build slot · next');
  assert.equal(buildWait(heavy, 'peek deploy'), null, 'not queued: it is running, so "running long" stays honest');
});

test("each target's part of a scheme's land line, in the line's order, with why a landing can't move (#1007)", () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const repo = join(root, `land-repo-${n}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  landOne(repo, Date.now(), 'README.md');
  const p = store.createProject('Peek Auras', 'https://github.com/o/peek');
  store.setProjectRepoDir(p.id, repo);
  // The kit land template's tickets: pid and start, got, label (the branch), phase, commit, verdict, base, "order".
  const q = join(repo, '.git', 'land-queue');
  mkdirSync(q);
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const me = `${process.pid} ${stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]}`;
  const ids: number[] = [];
  // #4 is from an older branch: nobody who arrived after one of those goes ahead of it (The Trans Agenda #76), so #5,
  // behind it, can't move either.
  const tickets: [string, string, boolean][] = [
    ['1', '1795067420', true],
    ['2', '0', true],
    ['3', '0', true],
    ['4', '0', false],
    ['5', '0', true],
  ];
  for (const [i, got, orders] of tickets) {
    const x = store.createTicket({ project_id: p.id, title: `Change ${i}`, permission_mode: 'default', created_by: 'Cara' });
    store.setTicketDir(x.id, root, `ticket/${i}-c`);
    ids.push(x.id);
    writeFileSync(join(q, i.padStart(10, '0')), [me, got, `ticket/${i}-c`, got === '0' ? 'waiting' : 'waiting for CI', '-', '-', '-', ...(orders ? ['order'] : [])].join('\n') + '\n');
  }
  writeFileSync(join(q, '.order'), '# Cara moved #3 to land next\n0000000003\n0000000002\n');
  // Their outputs lag the line (a move since): the line itself says the order.
  const outs = ['queue: got the land lock\n', 'queue: next in line for the land lock\n', 'queue: 2nd in line for the land lock\n', 'queue: 3rd in line for the land lock\n', 'queue: 4th in line for the land lock\n'];
  const ci: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', numbering: { name: 'Build {n}', number: 'run' } };
  const lands = new LandsInFlight({ store, finder: finderOf([ci]), landings: { handoffs: () => ids, get: (id) => ({ output: outs[ids.indexOf(id)], code: null }) }, now: () => 1000 });
  const views = () => [{ target: { id: ci.id, projectId: p.id, name: 'Windows', kind: 'ci', link: null }, current: null, next: null, line: [], recent: [] }] as unknown as TargetView[];
  const look = () => {
    const vs = views();
    lands.attach(vs);
    return { titles: vs[0].next?.changes.map((c) => c.title), line: vs[0].line.map((e) => [e.name, e.holds, e.movable, e.why ?? '']) };
  };
  // The scheme's own land.sh is older than reordering: none of its landings can move, and each says why.
  const old = look();
  assert.deepEqual(old.titles, ['Change 1', 'Change 3', 'Change 2', 'Change 4', 'Change 5']);
  assert.deepEqual(
    old.line.map(([name, holds, movable]) => [name, holds, movable]),
    [
      ['#1', true, false],
      ['#3', false, false],
      ['#2', false, false],
      ['#4', false, false],
      ['#5', false, false],
    ],
  );
  assert.match(String(old.line[1][3]), /this scheme's land script is older/);
  assert.equal(old.line[0][3], '', 'the one landing just lands');
  // Its copy of the template follows .order: the marked waiters move; one from an older branch says why it can't.
  mkdirSync(join(repo, 'tools'));
  writeFileSync(join(repo, 'tools', 'land.sh'), '#!/usr/bin/env bash\nqueue_order() {\n  :\n}\n');
  const now = look();
  assert.deepEqual(now.line, [
    ['#1', true, false, ''],
    ['#3', false, true, ''],
    ['#2', false, true, ''],
    ['#4', false, false, OLD_LAND],
    ['#5', false, false, BEHIND_OLD],
  ]);
  // The route's write, as the route makes it: Land next on #2 puts it first in the scheme's .order, and the line follows.
  // #5 stays out of it: a land.sh from before #1020 ranks .order's waiters ahead of #4, which waits only for 1 to 3.
  const order = writeOrder(landQueue(repo), schemeLine(repo), [5, 2, 3], (o) => `Cara moved #2 to ${o.indexOf(2) ? 'later' : 'land next'}`, 2);
  assert.deepEqual(order, [2, 3]);
  assert.equal(readFileSync(join(q, '.order'), 'utf8'), '# Cara moved #2 to land next\n0000000002\n0000000003\n');
  assert.deepEqual(
    look().line.map(([name]) => name),
    ['#1', '#2', '#3', '#4', '#5'],
  );
});

test('a CI package with release.needs: a build that passed its own job is not live until every workflow it needs ran every job green on its commit (#1019)', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const repo = join(root, `peek-gate-${n}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const now = Date.now(),
    m = 60_000;
  const base = landOne(repo, now - 120 * m, 'README.md');
  const p = store.createProject('Peek Auras', 'https://github.com/o/peek');
  store.setProjectRepoDir(p.id, repo);
  const minion = (title: string, branch: string) => {
    const t = store.createTicket({ project_id: p.id, title, permission_mode: 'default', created_by: 'Cara' });
    store.setTicketDir(t.id, root, branch);
    return t;
  };
  minion('Sound tab', 'ticket/1-sound');
  minion('Panel drag', 'ticket/2-drag');
  const at = Date.now() + 1000;
  const one = landOne(repo, at, 'crates/app/sound.rs', 'ticket/1-sound');
  const two = landOne(repo, at + 1000, 'crates/app/drag.rs', 'ticket/2-drag');
  const t: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', workflow: '.github/workflows/windows.yml', job: 'release', numbering: { name: 'Build {n}', number: 'run' }, needs: ['desktop.yml'] };
  // Tonight's shape: three windows runs whose release job passed; desktop.yml green on the oldest only, cancelled on the
  // next, and queued for a runner for 22 minutes on the newest.
  const win: Run[] = [
    { ...run(1291, 'completed', 'success', now - 30 * m, now - 25 * m), head_sha: two },
    { ...run(1289, 'completed', 'success', now - 40 * m, now - 35 * m), head_sha: one },
    { ...run(1275, 'completed', 'success', now - 110 * m, now - 100 * m), head_sha: base },
  ];
  const desk: Run[] = [
    { ...run(1000, 'queued', null, now - 22 * m), name: 'desktop', head_sha: two },
    { ...run(998, 'completed', 'cancelled', now - 40 * m, now - 30 * m), name: 'desktop', head_sha: one },
    { ...run(984, 'completed', 'success', now - 110 * m, now - 60 * m), name: 'desktop', head_sha: base },
  ];
  const jobs: Record<number, Job[]> = {
    1291: [job(1291, 'release', 'completed', 'success', now - 28 * m, now - 25 * m)],
    1289: [job(1289, 'release', 'completed', 'success', now - 38 * m, now - 35 * m)],
    1275: [job(1275, 'release', 'completed', 'success', now - 105 * m, now - 100 * m)],
    1000: [],
    998: [job(998, 'screen', 'completed', 'cancelled', now - 39 * m, now - 30 * m)],
    984: [job(984, 'screen', 'completed', 'success', now - 100 * m, now - 90 * m), job(984, 'e2e', 'completed', 'success', now - 90 * m, now - 60 * m)],
  };
  const actions: Actions = {
    async workflowRuns(_p, workflow) {
      return workflow === 'desktop.yml' ? desk : workflow === 'windows.yml' ? win : [];
    },
    async runJobs(_p, r) {
      return jobs[r.id] ?? [];
    },
  };
  let clock = now;
  const reader = new CiPackageReader({ store, finder: finderOf([t]), actions, now: () => clock });
  await reader.refresh();
  let [v] = reader.read();
  named(v);
  assert.equal(v.current?.name, 'Build 1275', 'what people have: the newest build whose desktop tests all passed, not the newest whose release job did');
  assert.deepEqual(
    v.next?.stages.map((s) => s.name),
    ['ci', 'package', 'desktop', 'live'],
    'the workflows it needs are stages of their own',
  );
  assert.deepEqual([v.next?.name, v.next?.stage, v.next?.waitingOn], ['Build 1291', 'desktop', 'desktop waiting for a CI runner']);
  assert.equal(v.next?.since, now - 22 * m, 'since the desktop run was queued');
  assert.deepEqual(
    v.next?.changes.map((c) => [c.title, c.stage]),
    [
      ['Sound tab', 'desktop'],
      ['Panel drag', 'desktop'],
    ],
    'both minions are still on their way, in the newest build',
  );
  assert.deepEqual(
    v.recent.map((r) => r.name),
    [],
    'the builds whose desktop tests never passed never reached anyone',
  );
  assert.equal(store.countReleases(p.id, t.id), 1, 'only the build that went out is counted as a release');

  // The runner takes it and every job goes green: Build 1291 is live and nothing is left on its way.
  desk[0] = { ...run(1000, 'completed', 'success', now - 22 * m, now), name: 'desktop', head_sha: two };
  jobs[1000] = [job(1000, 'screen', 'completed', 'success', now - 5 * m, now - 3 * m), job(1000, 'e2e', 'completed', 'success', now - 3 * m, now)];
  clock += 10_000;
  await reader.refresh();
  [v] = reader.read();
  named(v);
  assert.deepEqual([v.current?.name, v.current?.changes.map((c) => c.title)], ['Build 1291', ['Sound tab', 'Panel drag']]);
  assert.equal(v.next, null);
  assert.deepEqual(
    v.recent.map((r) => r.name),
    ['Build 1275'],
  );
  assert.equal(store.countReleases(p.id, t.id), 2);
});

test('a CI package with release.needs: a needed workflow that skipped a job, or failed, keeps the build from going out (#1019)', async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Peek Auras', 'https://github.com/o/r');
  const t: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', workflow: '.github/workflows/windows.yml', job: 'release', needs: ['desktop.yml'] };
  const now = Date.now(),
    m = 60_000;
  const win = [run(3, 'completed', 'success', now - 30 * m, now - 25 * m), run(2, 'completed', 'success', now - 60 * m, now - 55 * m)];
  const desk = [
    { ...run(13, 'completed', 'failure', now - 30 * m, now - 5 * m), head_sha: 'sha3' },
    { ...run(12, 'completed', 'success', now - 60 * m, now - 40 * m), head_sha: 'sha2' },
  ];
  const jobs: Record<number, Job[]> = {
    3: [job(3, 'release', 'completed', 'success', now - 28 * m, now - 25 * m)],
    2: [job(2, 'release', 'completed', 'success', now - 58 * m, now - 55 * m)],
    13: [job(13, 'screen', 'completed', 'failure', now - 20 * m, now - 5 * m)],
    // Its run says success, but a job was skipped (NOT RUN): that isn't tested.
    12: [job(12, 'screen', 'completed', 'success', now - 50 * m, now - 45 * m), job(12, 'e2e', 'completed', 'skipped', null, null)],
  };
  const actions: Actions = {
    async workflowRuns(_p, w) {
      return w === 'desktop.yml' ? desk : win;
    },
    async runJobs(_p, r) {
      return jobs[r.id] ?? [];
    },
  };
  const reader = new CiPackageReader({ store, finder: finderOf([t]), actions, now: () => now });
  await reader.refresh();
  const [v] = reader.read();
  assert.equal(v.current, null, 'neither build went out');
  assert.deepEqual([v.next?.number, v.next?.stage, v.next?.waitingOn], [1, 'desktop', 'desktop failed: it waits on a fix'], 'its first release, waiting on a fix');
});

test("a CI package's last green build is the newest released run last green holds; a roll back's pin shows it as current and the store keeps both (ADR 0012)", async () => {
  const store = new Store(join(root, `c-${++n}.db`));
  const p = store.createProject('Peek Auras', 'https://github.com/o/r');
  store.setProjectRepoDir(p.id, root);
  const t: Found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', workflow: '.github/workflows/windows.yml', job: 'release' };
  const now = Date.now(),
    m = 60_000;
  const runs = [3, 2, 1].map((i) => run(i, 'completed', 'success', now - (40 - i) * m, now - (30 - i) * m));
  const jobs = Object.fromEntries([3, 2, 1].map((i) => [i, [job(i, 'release', 'completed', 'success', now - (35 - i) * m, now - (30 - i) * m)]]));
  // Run 1 has no file left in the store: never a build to hand out.
  for (const i of [3, 2]) store.putCiFile({ project_id: p.id, workflow: 'windows.yml', run_id: i, run_attempt: 1, sha: `sha${i}`, ref: '', target: '', size: 1, sha256: '', created_at: now, name: `peek-${i}.zip`, kind: 'build' });
  const order = ['sha1', 'sha2', 'sha3', 'sha4'];
  let green = { sha: 'sha4', at: 1 };
  const pins: Record<string, Pin> = {};
  let clock = now;
  let unsure = '';
  const reader = new CiPackageReader({
    store,
    finder: finderOf([t]),
    actions: fakeActions(runs, jobs).actions,
    now: () => clock,
    contains: async (_d, a, b) => (a === unsure ? null : order.indexOf(a) <= order.indexOf(b)),
    lastGreen: { get: () => green, pinned: (_p, id) => pins[id] ?? null },
  });
  await reader.refresh();
  assert.deepEqual(reader.greenBuild(p.id, t.id), { run: 3, sha: 'sha3', workflow: 'windows.yml' }, 'last green past the newest build: the newest');
  green = { sha: 'sha2', at: 2 };
  await reader.refresh();
  assert.deepEqual(reader.greenBuild(p.id, t.id), { run: 2, sha: 'sha2', workflow: 'windows.yml' });
  assert.equal(reader.read()[0].current?.version, 'sha3', 'unpinned, the newest build is current');
  pins[t.id] = { sha: 'sha2', from: 'sha3', at: 1, by: 'Cara', build: { run: 2, sha: 'sha2', workflow: 'windows.yml' } };
  const [held] = reader.read();
  assert.equal(held.current?.version, 'sha2');
  assert.match(held.current?.link ?? '', /peek-2\.zip$/);
  assert.equal(held.next, null);
  assert.deepEqual(
    held.recent.map((r) => r.version),
    ['sha3', 'sha1'],
    'the build after it is a previous one',
  );
  assert.deepEqual([...reader.keeps()], [`${p.id}/2`]);

  // A newer build git can't place against last green yet (a timeout): last green's build stays what it was, so the CI
  // store keeps it meanwhile.
  delete pins[t.id];
  order.splice(2, 0, 'sha5');
  runs.unshift(run(5, 'completed', 'success', now - 20 * m, now - 10 * m));
  jobs[5] = [job(5, 'release', 'completed', 'success', now - 15 * m, now - 10 * m)];
  store.putCiFile({ project_id: p.id, workflow: 'windows.yml', run_id: 5, run_attempt: 1, sha: 'sha5', ref: '', target: '', size: 1, sha256: '', created_at: now, name: 'peek-5.zip', kind: 'build' });
  unsure = 'sha5';
  clock += 10 * m;
  await reader.refresh();
  assert.equal(reader.read()[0].current?.version, 'sha5', 'read again');
  assert.deepEqual(reader.greenBuild(p.id, t.id), { run: 2, sha: 'sha2', workflow: 'windows.yml' }, "git couldn't tell: last green's build is kept");
  assert.ok(reader.keeps().has(`${p.id}/2`));
  unsure = '';

  // Pinned again, then newer runs push the held one out of the page GitHub lists: it's still what people get.
  pins[t.id] = { sha: 'sha2', from: 'sha3', at: 1, by: 'Cara', build: { run: 2, sha: 'sha2', workflow: 'windows.yml' } };
  runs.splice(
    runs.findIndex((r) => r.id === 2),
    1,
  );
  clock += 10 * m;
  await reader.refresh();
  const [gone] = reader.read();
  assert.deepEqual([gone.current?.version, gone.current?.outcome, gone.next], ['sha2', 'live', null], 'the held build is current from its pin');
  assert.ok(reader.keeps().has(`${p.id}/2`), 'and the store keeps it');
  green = { sha: 'sha1', at: 3 };
  await reader.refresh();
  assert.equal(reader.greenBuild(p.id, t.id), null, 'run 1 is gone from the store: nothing to hand out');
});
