// The Code tab's counts (#1988; Josh, 2026-11-25, "Split these"): a small seeded repo is counted as its history says, a split's
// files start at nothing, a scheme is counted once a day and never at 3-6 AM, and who is splitting what comes from open minions.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { CodeCounts, countApart, splitting, type Counted } from '../src/code-counts.ts';
import { Store } from '../src/db.ts';
import { counted, countRepo } from '../tools/code-counts.ts';
import { candidates, score, zone } from '../public/codemath.js';

const root = mkdtempSync(join(tmpdir(), 'code-counts-'));
after(() => rmSync(root, { recursive: true, force: true }));
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 25, 20); // noon PST

let n = 0;
/** A repo whose commits each set files, at a minute before NOW. */
function seeded() {
  const dir = join(root, `repo-${n++}`);
  mkdirSync(dir);
  const git = (at: number, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: `${Math.floor(at / 1000)} +0000`, GIT_COMMITTER_DATE: `${Math.floor(at / 1000)} +0000` } });
  git(NOW, 'init', '-q', '-b', 'main');
  let minutes = 10_000;
  const commit = (subject: string, files: Record<string, string | number>, opts: { at?: number } = {}) => {
    const at = opts.at ?? NOW - (minutes -= 60) * 60_000;
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), typeof body === 'number' ? lines(body, subject) : body);
    }
    git(at, 'add', '-A');
    git(at, 'commit', '-q', '-m', subject);
    return at;
  };
  return { dir, git, commit };
}
/** `n` lines, the first one its own so a rewrite is a change. */
const lines = (count: number, tag: string) => `${[tag, ...Array.from({ length: count - 1 }, (_, i) => `line ${i}`)].join('\n')}\n`;
const at = (c: Counted, path: string) => c.files.find((f) => f.path === path);

test('each minion counts once per file, bug minions apart; tests, docs and old commits stay out', () => {
  const r = seeded();
  r.commit('#1 old', { 'src/a.ts': 100, 'src/b.ts': 10 }, { at: NOW - 20 * DAY });
  r.commit('#2 older change', { 'src/a.ts': 100 }, { at: NOW - 15 * DAY });
  r.commit('#3 change', { 'src/a.ts': 100, 'docs/a.md': 5, 'test/a.test.ts': 5 });
  r.commit('#3 review fixes', { 'src/a.ts': 101 });
  r.commit('Fix a thing (#4), after #9', { 'src/a.ts': 102, 'src/b.ts': 11 });
  const c = countRepo(r.dir, 14, [4], NOW);
  assert.deepEqual(at(c, 'src/a.ts'), { path: 'src/a.ts', lines: 102, changed: 2, bugs: 1, who: [4, 3] });
  assert.deepEqual(at(c, 'src/b.ts'), { path: 'src/b.ts', lines: 11, changed: 1, bugs: 1, who: [4] });
  assert.deepEqual(c.files.map((f) => f.path).sort(), ['src/a.ts', 'src/b.ts']);
  assert.equal(c.branch, 'main');
});

test('commits naming no minion: with the ship they went in with, else one unnamed ship each time', () => {
  const r = seeded();
  r.commit('#1 made', { 'a.ts': 50 }, { at: NOW - 9 * DAY });
  const t = r.commit('#2 change', { 'a.ts': 50 });
  r.commit('format', { 'a.ts': 51 }, { at: t + 5_000 }); // #2's ship
  r.commit('Tidy', { 'a.ts': 52 }, { at: t + 40 * 60_000 }); // nobody's
  r.commit('Tidy more', { 'a.ts': 53 }, { at: t + 40 * 60_000 + 30_000 }); // the same ship
  assert.deepEqual(at(countRepo(r.dir, 14, [], NOW), 'a.ts'), { path: 'a.ts', lines: 53, changed: 2, bugs: 0, who: [2] });
});

test('a split: the new files start at nothing, and the old one drops what it counted for code that left', () => {
  const r = seeded();
  r.commit('#1 big', { 'src/db.ts': 1000 }, { at: NOW - 20 * DAY });
  for (const m of [2, 3, 4]) r.commit(`#${m} change`, { 'src/db.ts': 1000 });
  assert.equal(at(countRepo(r.dir, 14, [], NOW), 'src/db.ts')?.changed, 3);
  r.commit('#5 split db.ts', { 'src/db.ts': 300, 'src/db/a.ts': 400, 'src/db/b.ts': 300 });
  r.commit('#5 review fixes', { 'src/db/a.ts': 400 });
  let c = countRepo(r.dir, 14, [], NOW);
  // None of them: the old file's changes were to code now elsewhere, the splitting minion made the new ones.
  assert.deepEqual(c.files, []);
  r.commit('#6 change', { 'src/db.ts': 300, 'src/db/a.ts': 401 });
  c = countRepo(r.dir, 14, [], NOW);
  assert.deepEqual(
    c.files.map((f) => [f.path, f.changed, f.who]),
    [
      ['src/db.ts', 1, [6]],
      ['src/db/a.ts', 1, [6]],
    ],
  );
});

test('a small piece taken out keeps the history: the file is still the one everybody changed', () => {
  const r = seeded();
  r.commit('#1 big', { 'run.ts': 1000 }, { at: NOW - 20 * DAY });
  for (const m of [2, 3]) r.commit(`#${m} change`, { 'run.ts': 1000 });
  r.commit('#4 take a piece', { 'run.ts': 800, 'piece.ts': 200 });
  assert.equal(at(countRepo(r.dir, 14, [], NOW), 'run.ts')?.changed, 3);
});

test("a scheme's copies of the kit's files stay out; the kit's own repo keeps them", () => {
  const r = seeded();
  r.commit('#1 made', { 'tools/land.sh': 50 }, { at: NOW - 20 * DAY });
  r.commit('#2 change', { 'tools/land.sh': 50 });
  assert.deepEqual(countRepo(r.dir, 14, [], NOW).files, []);
  r.commit('#3 the kit', { 'kit/skills/scheme-setup/templates/land.sh': 50 });
  assert.equal(at(countRepo(r.dir, 14, [], NOW), 'tools/land.sh')?.changed, 1);
});

test('what counts as our own code', () => {
  for (const p of ['src/a.ts', 'public/x.css', 'crates/app/src/run.rs', 'scripts/player.gd', 'tools/land.sh', 'src/test-page.ts', 'specimen.py']) assert.ok(counted(p), p);
  for (const p of ['README.md', 'package-lock.json', 'test/a.ts', 'web/src/a.test.tsx', 'a_test.go', 'tests/x.py', 'test_x.py', 'vendor/a.js', 'web/node_modules/a.js', 'a.min.js', 'x.svg']) assert.ok(!counted(p), p);
});

test('a repo with no main branch says so; the low-priority process answers the same as the count', async () => {
  const r = seeded();
  await assert.rejects(countApart(r.dir, []), /no main branch yet/);
  r.commit('#1 made', { 'a.ts': 50 }, { at: Date.now() - 2 * DAY });
  r.commit('#2 change', { 'a.ts': 50 }, { at: Date.now() - DAY });
  assert.deepEqual((await countApart(r.dir, [2])).files, [{ path: 'a.ts', lines: 50, changed: 1, bugs: 1, who: [2] }]);
});

test('one scheme a tick, once a Pacific day, not 3-6 AM; a failure keeps the last numbers and waits a day', async () => {
  const store = new Store(join(root, 'store.db'));
  const peek = store.createProject('Peek Auras', null);
  store.setProjectRepoDir(peek.id, '/repos/peek');
  const spec = store.createProject('Threadspace', null);
  store.setProjectRepoDir(spec.id, '/repos/threadspace');
  store.createProject('No repo', null);
  let now = Date.UTC(2026, 10, 25, 11); // 3 AM PST
  const calls: string[] = [];
  let fail = false;
  const good = (repo: string): Counted => ({ at: now, branch: 'main', commit: 'abc', days: 14, files: [{ path: 'a.ts', lines: 1000, changed: 5, bugs: 0, who: [1] }] });
  const dir = join(root, 'counts');
  const make = () =>
    new CodeCounts(store, {
      dir,
      now: () => now,
      count: async (repo) => {
        calls.push(repo);
        if (fail) throw new Error('git broke');
        return good(repo);
      },
    });
  let jobs = make();
  /** The file's own time is when it was counted. */
  const stamp = (id: number) => utimesSync(join(dir, `${id}.json`), now / 1000, now / 1000);
  assert.deepEqual(await jobs.view(peek.id), { repo: true, kept: null, splitting: {} });
  assert.equal(await jobs.tick(), null);
  now += 2 * 3600_000 + 59 * 60_000; // 5:59
  assert.equal(await jobs.tick(), null);
  now += 60_000;
  assert.equal(await jobs.tick(), peek.id);
  stamp(peek.id);
  assert.equal(await jobs.tick(), spec.id);
  stamp(spec.id);
  assert.equal(await jobs.tick(), null);
  jobs = make(); // a restart the same day counts nothing again
  assert.equal(await jobs.tick(), null);
  assert.deepEqual(calls, ['/repos/peek', '/repos/threadspace']);
  now += DAY;
  fail = true;
  assert.equal(await jobs.tick(), peek.id);
  const { kept } = await jobs.view(peek.id);
  assert.equal(kept?.error, 'git broke');
  assert.equal(kept?.at, now - DAY);
  assert.equal(kept?.files.length, 1);
  assert.equal(await jobs.tick(), spec.id); // the failed one doesn't hold up the next
  now += DAY;
  fail = false;
  assert.equal(await jobs.tick(), peek.id);
  assert.equal(JSON.parse(readFileSync(join(dir, `${peek.id}.json`), 'utf8')).error, undefined);
});

test('bug minions and who is splitting what come from this scheme only', async () => {
  const store = new Store(join(root, 'split.db'));
  const peek = store.createProject('Peek Auras', null);
  const other = store.createProject('Delve', null);
  const add = (p: number, title: string) => store.createTicket({ project_id: p, title, permission_mode: 'default', created_by: 'Cara' });
  const split = add(peek.id, 'Split run.rs into modules');
  add(other.id, 'Split main.rs');
  const closed = add(peek.id, 'Split store.ts');
  store.updateTicket(closed.id, { status: 'closed' });
  assert.deepEqual(
    store.openTitles(peek.id).map((t) => ({ ...t })),
    [{ number: split.number, title: split.title }],
  );
  const files = [{ path: 'crates/app/src/run.rs' }, { path: 'crates/app/src/main.rs' }, { path: 'companion/src/store.ts' }, { path: 'src/trun.rs' }];
  assert.deepEqual(splitting(files, store.openTitles(peek.id)), { 'crates/app/src/run.rs': [{ number: split.number, title: split.title }] });
});

test('a title names a file by path or by name, and has to say split', () => {
  const files = [{ path: 'tools/land.sh' }, { path: 'kit/templates/land.sh' }, { path: 'src/runner.ts' }];
  const on = (title: string) => Object.keys(splitting(files, [{ number: 7, title }])).sort();
  assert.deepEqual(on('Break up the land script, land.sh'), ['kit/templates/land.sh', 'tools/land.sh']);
  assert.deepEqual(on('Split tools/land.sh'), ['tools/land.sh']);
  assert.deepEqual(on('Splitting runner.ts, piece 6'), ['src/runner.ts']);
  assert.deepEqual(on('Fix runner.ts'), []);
  assert.deepEqual(on('Split these files on the Code tab'), []);
});

test('the zone is big files a quarter as busy as the busiest; the list is the zone, best score first', () => {
  const f = (path: string, lines: number, changed: number, bugs = 0) => ({ path, lines, changed, bugs, who: [] });
  const files = [f('huge-quiet', 5000, 3), f('big-busy', 4000, 100), f('mid', 1000, 40, 2), f('small-busy', 200, 150), f('under', 1200, 24)];
  assert.deepEqual(zone(files), { lines: 900, changed: 25 });
  assert.deepEqual(
    candidates(files).map((x: { path: string }) => x.path),
    ['big-busy', 'mid'],
  );
  assert.ok(score(f('a', 1000, 10, 1)) > score(f('a', 1000, 10)));
  assert.equal(zone([]).changed, 4); // a small scheme: at least 4 minions
  assert.deepEqual(candidates([f('a', 2000, 3)]), []);
});

test("only the scheme's minions set to bug count as bugs", () => {
  const store = new Store(join(root, 'bugs.db'));
  const peek = store.createProject('Peek Auras', null);
  const other = store.createProject('Delve', null);
  const add = (p: number) => store.createTicket({ project_id: p, title: 'x', permission_mode: 'default', created_by: 'Cara' });
  const [bug, feature, theirs] = [add(peek.id), add(peek.id), add(other.id)];
  const props = store.props;
  props.seed();
  for (const [t, type] of [
    [bug, 'bug'],
    [feature, 'feature'],
    [theirs, 'bug'],
  ] as const)
    props.set('minion', t.id, t.project_id, { type }, 'Cara');
  assert.deepEqual(store.bugNumbers(peek.id), [bug.number]);
});
