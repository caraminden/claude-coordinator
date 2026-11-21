// tools/known-flakes.ts (#1419): which failed-alone test files land.sh may ship past.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { parseRetroFlakes } from '../src/flakes.ts';

const script = join(import.meta.dirname, '..', 'tools', 'known-flakes.ts');
const root = mkdtempSync(join(tmpdir(), 'known-flakes-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' } }).stdout.trim();
const stamp = (ms: number) => { const d = new Date(ms).toISOString(); return { day: d.slice(0, 10), time: d.slice(11, 19) }; };
const line = (ago: number, rest: string) => { const s = stamp(Date.now() - ago); return { day: s.day, text: `- ${s.time}Z · flake · ${rest}` }; };
const MIN = 60_000, DAY = 24 * 60 * MIN;

/** A repo whose test/x.test.ts was committed `fileAgo` ms ago, a retro log of `lines`, and optionally a database. */
function setup(lines: { day: string; text: string }[], fileAgo = 30 * DAY, fixes?: { file: string; ticket: number; state: string; status: string }[]) {
  const dir = join(root, String(++n));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'test'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'test', 'x.test.ts'), '1\n');
  writeFileSync(join(repo, 'test', 'y.test.ts'), '1\n');
  git(repo, 'add', '-A');
  const when = `@${Math.floor((Date.now() - fileAgo) / 1000)} +0000`;
  spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
  const shared = join(dir, 'shared');
  for (const l of lines) {
    mkdirSync(join(shared, 'retro-log', l.day), { recursive: true });
    writeFileSync(join(shared, 'retro-log', l.day, 'land.md'), `${l.text}\n`, { flag: 'a' });
  }
  const env: Record<string, string> = { ...process.env as Record<string, string>, COORDINATOR_SHARED_DIR: shared };
  if (fixes) {
    const db = new DatabaseSync(join(dir, 'c.db'));
    db.exec('CREATE TABLE tickets (id INTEGER PRIMARY KEY, project_id INTEGER, status TEXT); CREATE TABLE flake_fixes (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, file TEXT NOT NULL, ticket_id INTEGER, state TEXT NOT NULL)');
    db.prepare('INSERT INTO tickets VALUES (1, 2, ?)').run('running'); // the shipping minion, in scheme 2
    for (const f of fixes) {
      db.prepare('INSERT INTO tickets VALUES (?, 2, ?)').run(f.ticket, f.status);
      db.prepare('INSERT INTO flake_fixes (project_id, file, ticket_id, state) VALUES (2, ?, ?, ?)').run(f.file, f.ticket, f.state);
    }
    db.prepare("INSERT INTO tickets VALUES (900, 3, 'running')").run(); // another scheme's fix of the same file
    db.prepare("INSERT INTO flake_fixes (project_id, file, ticket_id, state) VALUES (3, 'test/y.test.ts', 900, 'open')").run();
    db.close();
    Object.assign(env, { LAND_FLAKE_DB: join(dir, 'c.db'), COORDINATOR_TICKET: '1' });
  }
  return (branches: string, ...files: string[]) => {
    const r = spawnSync(process.execPath, ['--no-warnings', script, 'main', branches, ...files], { cwd: repo, encoding: 'utf8', env });
    return { status: r.status, out: r.stdout.trim(), err: r.stderr };
  };
}

test('a file that passed alone on other branches in the last 14 days is known; the ship and its riders own sightings are not', () => {
  const run = setup([
    line(2 * DAY, 'test/x.test.ts · load 12.5 · ticket/7-a · in CI'),
    line(3 * DAY, 'test/x.test.ts · load 9.1 · ticket/8-b · in CI'),
    line(4 * DAY, 'test/x.test.ts · load 9.1 · ticket/8-b'),
    line(1 * DAY, 'test/y.test.ts · load 3 · ticket/1-me · in CI'),
    line(1 * DAY, 'test/y.test.ts · load 3 · ticket/2-rider · in CI'),
  ]);
  const r = run('ticket/1-me ticket/2-rider', 'test/x.test.ts');
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, 'test/x.test.ts (seen on 2 other branches in 14 days)');
  const both = run('ticket/1-me ticket/2-rider', 'test/x.test.ts', 'test/y.test.ts');
  assert.equal(both.status, 1, 'one unknown file keeps the rerun');
  assert.equal(both.out, 'test/x.test.ts (seen on 2 other branches in 14 days)\ntest/y.test.ts (not seen on another branch in 14 days since it last changed on main, and no minion is fixing it)');
});

test('a sighting older than 14 days, a smoke line, or one before the file last changed on main does not make it known', () => {
  assert.equal(setup([line(15 * DAY, 'test/x.test.ts · load 1 · ticket/7-a · in CI')])('ticket/1-me', 'test/x.test.ts').status, 1);
  assert.equal(setup([line(1 * DAY, 'test/x.test.ts · smoke · ticket/7-a')])('ticket/1-me', 'test/x.test.ts').status, 1);
  const fixed = setup([line(3 * DAY, 'test/x.test.ts · load 1 · ticket/7-a · in CI')], 2 * DAY)('ticket/1-me', 'test/x.test.ts');
  assert.equal(fixed.status, 1, 'the file changed on main after it flaked: maybe fixed');
  assert.equal(setup([line(1 * DAY, 'test/x.test.ts · load 1 · ticket/7-a · in CI')], 2 * DAY)('ticket/1-me', 'test/x.test.ts').status, 0, 'flaked since that change');
});

test("an open fix minion in the ship's own scheme makes a file known; a closed or held one, or another scheme's, does not", () => {
  const run = setup([line(2 * DAY, 'test/x.test.ts · load 1 · ticket/7-a · in CI')], 30 * DAY, [
    { file: 'test/x.test.ts', ticket: 41, state: 'open', status: 'running' },
    { file: 'test/z.test.ts', ticket: 42, state: 'open', status: 'closed' },
    { file: 'test/w.test.ts', ticket: 43, state: 'held', status: 'running' },
  ]);
  assert.equal(run('ticket/1-me', 'test/x.test.ts').out, 'test/x.test.ts (seen on 1 other branch in 14 days, fix #41)');
  assert.equal(run('ticket/7-a', 'test/x.test.ts').out, 'test/x.test.ts (fix #41)');
  for (const f of ['test/z.test.ts', 'test/w.test.ts', 'test/y.test.ts']) assert.equal(run('ticket/1-me', f).status, 1, f);
});

test('no retro log, no database or a broken one: nothing is known, and it says so rather than fail', () => {
  const run = setup([], 30 * DAY, []);
  assert.equal(run('ticket/1-me', 'test/x.test.ts').status, 1);
  const r = spawnSync(process.execPath, ['--no-warnings', script, 'main', 'ticket/1-me', 'test/x.test.ts'], { cwd: root, encoding: 'utf8', env: { ...process.env, COORDINATOR_SHARED_DIR: join(root, 'none'), LAND_FLAKE_DB: join(root, 'none.db'), COORDINATOR_TICKET: '1' } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /^test\/x\.test\.ts \(not seen on another branch/);
});

test("its retro-log parsing matches src/flakes.ts's parseRetroFlakes on the lines land.sh and run-tests.sh write", () => {
  const md = ['- 02:45:47Z · flake · test/a.test.ts · load 16.43 · ticket/945-x · in CI', '- 03:00:00Z · flake · test/b.test.ts · smoke · nothing', '- 04:00:00Z · flake rerun · ticket/9-y · test/a.test.ts · green', '- 05:00:00Z · flake · test/c.test.ts · load 2 · ticket/946-z'].join('\n');
  const day = stamp(Date.now()).day;
  assert.deepEqual(parseRetroFlakes(md, day).filter((s) => s.branch).map((s) => `${s.file} ${s.branch}`), ['test/a.test.ts ticket/945-x', 'test/c.test.ts ticket/946-z']);
  // The same lines through the script: a and c on other branches, b (smoke) and the rerun line not.
  const run = setup([]);
  const dir = join(root, String(n), 'shared', 'retro-log', day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'land.md'), md.replace(/^- \d\d:\d\d:\d\d/gm, `- ${stamp(Date.now() - MIN).time}`));
  for (const [f, known] of [['test/a.test.ts', 0], ['test/b.test.ts', 1], ['test/c.test.ts', 0]] as const) assert.equal(run('ticket/1-me', f).status, known, f);
});
