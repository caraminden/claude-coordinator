import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { DeployView } from '../src/app-services.ts';
import { Store } from '../src/db.ts';
import { ContraptionReader, lengths } from '../src/release-readers.ts';
import { detect, shipsOn, TargetFinder, type SchemeFacts } from '../src/release-targets.ts';

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
