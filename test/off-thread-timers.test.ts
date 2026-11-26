// Minute-scale timers make no blocking disk call or process start on the server's one thread (#2135): the previews
// sweep, the minion index's handoff tidy, the release targets' rescan and the incident timeline's write. A btrfs stall
// of 2-10 s held every request while one of these waited.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Previews } from '../src/previews.ts';
import { MinionIndexer } from '../src/minion-index.ts';
import { TargetFinder } from '../src/release-targets.ts';
import { writeReport } from '../src/incidents.ts';
import { projectSharedDir, projectDir } from '../src/workspace.ts';
import { git } from './git.ts';
import { syncCallsUnder } from './sync-trap.ts';

const root = mkdtempSync(join(tmpdir(), 'off-thread-timers-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir

test('the previews sweep stops an idle preview and drops a gone build with no blocking call', async () => {
  const dir = join(root, 'previews');
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(repo, 'branch', 'build/10');
  const store = new Store(join(dir, 'coordinator.db'));
  const p = store.createProject('Citadel', null);
  store.setProjectRepoDir(p.id, repo);
  const previews = new Previews(store, dir);
  previews.buildScheme = () => store.getProject(p.id)!;
  const builds = join(projectDir(dir, p.id), 'build-previews');
  const gone = join(builds, '9');
  const kept = join(builds, '10');
  git(repo, 'worktree', 'add', '-q', '--detach', gone, 'main');
  git(repo, 'worktree', 'add', '-q', '--detach', kept, 'main');
  // An idle preview: a stand-in process and its copy of the data.
  const idleDir = join(previews.root, '1');
  mkdirSync(idleDir, { recursive: true });
  const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  (Reflect.get(previews, 'running') as Map<string, unknown>).set('1', { proc, port: 0, auth: null, dir: idleDir, head: null, lastUsed: 0 });
  const seen = await syncCallsUnder(dir, () => previews.sweep());
  assert.deepEqual(seen, []);
  assert.equal(previews.isRunning(1), false);
  assert.equal(existsSync(idleDir), false, 'the idle copy of the data is gone');
  assert.equal(existsSync(gone), false, 'the build whose branch went lost its worktree');
  assert.equal(existsSync(kept), true);
  assert.doesNotMatch(git(repo, 'worktree', 'list'), /build-previews\/9/);
  store.db.close();
});

test("the minion index files a closed minion's handoff with no blocking call", async () => {
  const dir = join(root, 'tidy');
  mkdirSync(dir);
  const store = new Store(join(dir, 'c.db'));
  const project = store.createProject('Other', null).id;
  const shared = projectSharedDir(dir, project);
  mkdirSync(join(shared, 'handoffs'), { recursive: true });
  writeFileSync(join(shared, 'handoffs', 'a.md'), '# Handoff\nDo it.');
  writeFileSync(join(shared, 'handoffs', 'b.md'), '**Not picked (2026-11-12): no.**\nx');
  const idx = new MinionIndexer(store, dir);
  for (const n of ['a', 'b']) {
    const t = store.createTicket({ project_id: project, title: n, permission_mode: 'default', created_by: 'Cara' });
    store.addEvent(t.id, 'user_message', { author: 'Cara', text: `Your brief is ${shared}/handoffs/${n}.md` });
    store.updateTicket(t.id, { status: 'closed' });
  }
  const seen = await syncCallsUnder(dir, () => idx.run());
  assert.deepEqual(seen, []);
  assert.equal(readFileSync(join(shared, 'handoffs/shipped/a.md'), 'utf8'), '# Handoff\nDo it.');
  assert.ok(existsSync(join(shared, 'handoffs/not-picked/b.md')));
  assert.ok(!existsSync(join(shared, 'handoffs/a.md')) && !existsSync(join(shared, 'handoffs/b.md')));
  store.db.close();
});

test("the release targets' rescan finds an app's APK feed with no blocking call", async () => {
  const dir = join(root, 'targets');
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.github/workflows/android.yml'), 'name: Android\non:\n  workflow_dispatch:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./gradlew assembleRelease\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'ci');
  const store = new Store(join(dir, 'c.db'));
  const p = store.createProject('Mandate', 'https://github.com/o/mandate');
  store.setProjectRepoDir(p.id, repo);
  store.createContraption({ name: 'mandate', title: 'Mandate', icon: null, port: 9, home_scheme: p.id, open_paths: '[]', relay_paths: '[]', repo: 'o/mandate', branch: null, folder: join(dir, 'app'), default_model: null, turn_cap: null, identity_public: 'x', identity_private: 'x', key_hash: 'h', keys_at: 0 });
  const feeds = join(dir, 'feeds');
  mkdirSync(join(feeds, 'mandate'), { recursive: true });
  writeFileSync(join(feeds, 'mandate', 'latest.json'), '{}');
  const finder = new TargetFinder({ store, own: () => null, apkFeed: (name) => join(feeds, name, 'latest.json') });
  const seen = await syncCallsUnder(dir, () => finder.scan());
  assert.deepEqual(seen, []);
  assert.deepEqual(
    finder.list('apk').map((t) => [t.link, t.contraption]),
    [['/apps/mandate/android/', 'mandate']],
  );
  store.db.close();
});

test("an incident's timeline is written with no blocking call, and a second one never overwrites the first", async () => {
  const dir = join(root, 'incidents');
  const reports = join(dir, 'shared', 'reports');
  let files: (string | null)[] = [];
  const seen = await syncCallsUnder(dir, async () => {
    files = [await writeReport(reports, 'incident.md', 'one'), await writeReport(reports, 'incident.md', 'two')];
  });
  assert.deepEqual(seen, []);
  assert.deepEqual(files, [join(reports, 'incident.md'), join(reports, 'incident-2.md')]);
  assert.equal(readFileSync(join(reports, 'incident.md'), 'utf8'), 'one');
  assert.equal(readFileSync(join(reports, 'incident-2.md'), 'utf8'), 'two');
});
