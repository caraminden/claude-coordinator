// The apps a ship deploys and how (src/ship-deploys.ts, #1838), on stand-ins: no server boot.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { HttpError } from '../src/http.ts';
import { shipDeploys } from '../src/ship-deploys.ts';

const root = mkdtempSync(join(tmpdir(), 'ship-deploys-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

/** A scheme with a minion, and shipDeploys over a scratch Store; `refuse` is what auto-deploy's deployNow throws. */
function setup(opts: { off?: string; refuse?: Error; running?: boolean; noClone?: boolean } = {}) {
  const dir = join(root, `s${++n}`);
  mkdirSync(dir);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (file: string, text: string) => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
    git('add', '-A');
    git('commit', '-qm', file);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  const first = commit('README.md', 'x');
  const store = new Store(join(root, `db-${n}.sqlite`));
  const project = store.createProject(`p${n}`, null);
  if (!opts.noClone) store.setProjectRepoDir(project.id, dir);
  const t = store.createTicket({ project_id: project.id, title: 'work', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const cara = store.createUser({ name: 'Cara', login: `cara${n}` });
  store.updateTicket(t.id, { person_id: cara.id });
  const asked: unknown[][] = [];
  const started: unknown[][] = [];
  const last = { state: 'deployed', to: first, said: [], log: '' };
  const d = shipDeploys({
    store,
    services: { opts: { off: opts.off ?? null }, running: () => opts.running ?? null, lastDeploy: async () => last, folder: () => dir },
    autoDeploy: {
      deployNow: async (...a) => {
        asked.push(a);
        if (opts.refuse) throw opts.refuse;
        return 'said';
      },
    },
    startDeploy: (row, by, uid) => {
      started.push([row.name, by, uid]);
      return 'started';
    },
  });
  const app = (name: string, fields: object = {}) =>
    store.createContraption({ name, title: name, icon: null, port: 9000 + n, home_scheme: project.id, open_paths: '[]', relay_paths: '[]', repo: 'https://x/y', branch: null, folder: null, default_model: null, turn_cap: null, identity_public: 'x', identity_private: 'x', key_hash: `${name}${n}`, keys_at: 0, ...fields });
  return { ...d, dir, git, commit, first, store, project, t, cara, asked, started, app, last };
}

test("apps: the scheme's own apps on main with a repo, and a folder app once its manifest is on main", () => {
  const s = setup();
  const other = s.store.createProject('other', null);
  s.app('plain');
  s.app('onmain', { branch: 'main' });
  s.app('branchy', { branch: 'dev' });
  s.app('norepo', { repo: null });
  s.app('away', { home_scheme: other.id });
  s.app('folded', { subdir: 'apps/folded' });
  assert.deepEqual(s.apps(s.t.id).sort(), ['onmain', 'plain']);
  s.commit('apps/folded/citadel-app.json', '{}');
  assert.deepEqual(s.apps(s.t.id).sort(), ['folded', 'onmain', 'plain']);
  const noClone = setup({ noClone: true });
  noClone.app('folded', { subdir: 'apps/folded' });
  assert.deepEqual(noClone.apps(noClone.t.id), [], 'a scheme with no clone has no folder apps to read');
});

test('apps: none for a minion that is gone, or where deploys are off', () => {
  const gone = setup();
  gone.app('plain');
  assert.deepEqual(gone.apps(999_999), []);
  const off = setup({ off: 'a dev copy' });
  off.app('plain');
  assert.deepEqual(off.apps(off.t.id), []);
});

test('running and last read the app services', async () => {
  const s = setup();
  assert.equal(s.deployOps.running('a'), false);
  assert.equal(setup({ running: true }).deployOps.running('a'), true);
  assert.equal(await s.deployOps.last('a'), s.last);
});

test("start goes through auto-deploy's start, as the minion and the person its turn runs for", async () => {
  const s = setup();
  s.app('notes');
  assert.equal(await s.deployOps.start('notes', s.t.id), 'said');
  assert.deepEqual(s.asked, [[s.project.id, 'app:notes', `#${s.t.number}`, s.cara.id]]);
  assert.deepEqual(s.started, []);
});

test('start: an app the release targets have not scanned yet (404) goes straight to its deploy (#712)', async () => {
  const s = setup({ refuse: new HttpError(404, 'no release step') });
  s.app('notes');
  assert.equal(await s.deployOps.start('notes', s.t.id), 'started');
  assert.deepEqual(s.started, [['notes', `#${s.t.number}`, s.cara.id]]);
  await assert.rejects(s.deployOps.start('gone', s.t.id), /no contraption gone/);
});

test("start: auto-deploy's other refusals stand, and nothing starts", async () => {
  for (const refuse of [new HttpError(409, 'rolled back to last green'), new Error('git broke')]) {
    const s = setup({ refuse });
    s.app('notes');
    await assert.rejects(s.deployOps.start('notes', s.t.id), refuse);
    assert.deepEqual(s.started, []);
  }
  const s = setup();
  await assert.rejects(s.deployOps.start('notes', 999_999), /minion 999999 is gone/);
  assert.deepEqual(s.asked, []);
});

test('has: an app deployed at a commit holding the ship; a folder app the ship did not touch counts as held', async () => {
  const s = setup();
  const has = s.deployOps.has!;
  s.app('plain');
  s.app('folded', { subdir: 'apps/folded' });
  const deployed = s.commit('apps/folded/a.txt', '1');
  const outside = s.commit('README.md', 'y');
  const inside = s.commit('apps/folded/a.txt', '2');
  assert.equal(await has('plain', s.first, deployed), true, 'a later deploy holds an earlier ship');
  assert.equal(await has('plain', outside, deployed), false);
  assert.equal(await has('folded', outside, deployed), true, 'nothing in its folder changed');
  assert.equal(await has('folded', inside, deployed), false);
  assert.equal(await has('nosuch', s.first, deployed), false);
  assert.equal(await has('plain', 'not-a-commit', deployed), false, 'git failing is not held');
});
