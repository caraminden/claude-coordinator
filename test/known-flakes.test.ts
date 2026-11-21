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

const stamp = (ms: number) => { const d = new Date(ms).toISOString(); return { day: d.slice(0, 10), time: d.slice(11, 19) }; };
const line = (ago: number, rest: string) => { const s = stamp(Date.now() - ago); return { day: s.day, text: `- ${s.time}Z · flake · ${rest}` }; };
const MIN = 60_000, DAY = 24 * 60 * MIN;

/** A retro log of `lines`, and optionally a database of flake fixes (held_at: ms ago). */
function setup(lines: { day: string; text: string }[], fixes?: { file: string; ticket: number; state: string; status: string; heldAgo?: number }[]) {
  const dir = join(root, String(++n));
  mkdirSync(dir, { recursive: true });
  const shared = join(dir, 'shared');
  for (const l of lines) {
    mkdirSync(join(shared, 'retro-log', l.day), { recursive: true });
    writeFileSync(join(shared, 'retro-log', l.day, 'land.md'), `${l.text}\n`, { flag: 'a' });
  }
  const env: Record<string, string> = { ...process.env as Record<string, string>, COORDINATOR_SHARED_DIR: shared };
  if (fixes) {
    const db = new DatabaseSync(join(dir, 'c.db'));
    db.exec('CREATE TABLE tickets (id INTEGER PRIMARY KEY, project_id INTEGER, number INTEGER, status TEXT); CREATE TABLE flake_fixes (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, file TEXT NOT NULL, ticket_id INTEGER, state TEXT NOT NULL, held_at INTEGER)');
    db.prepare('INSERT INTO tickets VALUES (1, 2, 1, ?)').run('running'); // the shipping minion, in scheme 2
    for (const f of fixes) {
      // A minion's id isn't its number (#1419's review: the live fix for test/memory.test.ts is id 2930, #1381).
      db.prepare('INSERT INTO tickets VALUES (?, 2, ?, ?)').run(f.ticket + 1000, f.ticket, f.status);
      db.prepare('INSERT INTO flake_fixes (project_id, file, ticket_id, state, held_at) VALUES (2, ?, ?, ?, ?)').run(f.file, f.ticket + 1000, f.state, f.heldAgo === undefined ? null : Date.now() - f.heldAgo);
    }
    db.prepare("INSERT INTO tickets VALUES (900, 3, 5, 'running')").run(); // another scheme's fix of the same file
    db.prepare("INSERT INTO flake_fixes (project_id, file, ticket_id, state) VALUES (3, 'test/y.test.ts', 900, 'open')").run();
    db.close();
    Object.assign(env, { LAND_FLAKE_DB: join(dir, 'c.db'), COORDINATOR_TICKET: '1' });
  }
  return (branches: string, ...files: string[]) => {
    const r = spawnSync(process.execPath, ['--no-warnings', script, branches, ...files], { cwd: dir, encoding: 'utf8', env });
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
    line(1 * DAY, 'test/y.test.ts · load 3 · ticket/9-front · in CI · with ticket/8-b ticket/1-me'), // a train the ship rode in
  ]);
  const r = run('ticket/1-me ticket/2-rider', 'test/x.test.ts');
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, 'test/x.test.ts (seen on 2 other branches in 14 days)');
  const both = run('ticket/1-me ticket/2-rider', 'test/x.test.ts', 'test/y.test.ts');
  assert.equal(both.status, 1, 'one unknown file keeps the rerun');
  assert.equal(both.out, 'test/x.test.ts (seen on 2 other branches in 14 days)\ntest/y.test.ts (not seen on another branch in 14 days, and no minion is fixing it)');
  assert.equal(run('ticket/3-other', 'test/y.test.ts').out, 'test/y.test.ts (seen on 3 other branches in 14 days)', "a train's run is one sighting, of its front");
});

test('a sighting older than 14 days, a smoke line, or one from before its fix passed its proof does not make it known', () => {
  assert.equal(setup([line(15 * DAY, 'test/x.test.ts · load 1 · ticket/7-a · in CI')])('ticket/1-me', 'test/x.test.ts').status, 1);
  assert.equal(setup([line(1 * DAY, 'test/x.test.ts · smoke · ticket/7-a')])('ticket/1-me', 'test/x.test.ts').status, 1);
  const fixed = setup([line(3 * DAY, 'test/x.test.ts · load 1 · ticket/7-a · in CI')], [{ file: 'test/x.test.ts', ticket: 41, state: 'held', status: 'closed', heldAgo: 2 * DAY }])('ticket/1-me', 'test/x.test.ts');
  assert.equal(fixed.status, 1, 'fixed since: a flake now is a new one');
  assert.equal(fixed.out, 'test/x.test.ts (not seen on another branch in 14 days since its fix passed its proof, and no minion is fixing it)');
  const again = setup([line(1 * DAY, 'test/x.test.ts · load 1 · ticket/7-a · in CI')], [{ file: 'test/x.test.ts', ticket: 41, state: 'held', status: 'closed', heldAgo: 2 * DAY }])('ticket/1-me', 'test/x.test.ts');
  assert.equal(again.status, 0, 'flaked on another branch since that proof');
});

test("an open fix minion in the ship's own scheme makes a file known; a closed or held one, or another scheme's, does not", () => {
  const run = setup([line(2 * DAY, 'test/x.test.ts · load 1 · ticket/7-a · in CI')], [
    { file: 'test/x.test.ts', ticket: 41, state: 'open', status: 'running' },
    { file: 'test/z.test.ts', ticket: 42, state: 'open', status: 'closed' },
    { file: 'test/w.test.ts', ticket: 43, state: 'held', status: 'running' },
  ]);
  assert.equal(run('ticket/1-me', 'test/x.test.ts').out, 'test/x.test.ts (seen on 1 other branch in 14 days, fix #41)');
  assert.equal(run('ticket/7-a', 'test/x.test.ts').out, 'test/x.test.ts (fix #41)');
  for (const f of ['test/z.test.ts', 'test/w.test.ts', 'test/y.test.ts']) assert.equal(run('ticket/1-me', f).status, 1, f);
});

test('no retro log, no database or a broken one: nothing is known, and it says so rather than fail', () => {
  const run = setup([], []);
  assert.equal(run('ticket/1-me', 'test/x.test.ts').status, 1);
  const r = spawnSync(process.execPath, ['--no-warnings', script, 'ticket/1-me', 'test/x.test.ts'], { cwd: root, encoding: 'utf8', env: { ...process.env, COORDINATOR_SHARED_DIR: join(root, 'none'), LAND_FLAKE_DB: join(root, 'none.db'), COORDINATOR_TICKET: '1' } });
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

// #1487 (Cara, 2026-11-21: "how do we know its a flake ..."): a file red in a big share of the last hours' runs is broken.
const raw = (ago: number, rest: string) => { const s = stamp(Date.now() - ago); return { day: s.day, text: `- ${s.time}Z · ${rest}` }; };
/** `n` test runs (a landing's timing line with a CI run) in the last few hours. */
const runs = (n: number) => Array.from({ length: n }, (_, i) => raw((i + 1) * MIN, `timing · ticket/${100 + i}-r · line 0 · rebase 1 · ci-queue 8 · ci-run 107 · fallback - · deploy 7 · live 42 · landed`));
const reds = (n: number, ago = MIN) => Array.from({ length: n }, (_, i) => line(ago + i * MIN, `test/x.test.ts · load 3 · ticket/${10 + i}-o · in CI`));

test('a file red in 20% or more of the last 6 h of runs is a broken test, not a flake; under that share it still ships as known', () => {
  // 3 reds of 21 runs (20 logged, and the one being judged): 14%, a known flake.
  const under = setup([...runs(20), ...reds(3)])('ticket/1-me', 'test/x.test.ts');
  assert.equal(under.status, 0, under.out);
  assert.equal(under.out, 'test/x.test.ts (seen on 3 other branches in 14 days)');
  // 3 reds of 11 runs: 27%.
  const over = setup([...runs(10), ...reds(3)])('ticket/1-me', 'test/x.test.ts');
  assert.equal(over.status, 1);
  assert.equal(over.out, 'broken test, not a flake: test/x.test.ts red in 3 of 11 runs in the last 6 h');
  // Exactly 20% is broken; a fresh rerun and a bisect run are runs too, a feeder's merge (its own files only) is not; the
  // ship's own red counts, as it reddened a run.
  const edge = setup([...runs(12), raw(MIN, 'flake rerun · ticket/9-y · test/q.test.ts · green'), raw(MIN, 'flake rerun · ticket/9-y · test/q.test.ts · not started'),
    raw(MIN, 'bisect run · ticket/9-y · 1 of 3'), raw(MIN, 'timing · ticket/5-f · line 0 · rebase 1 · tests 40 · deploy - · merged'),
    ...reds(2), line(MIN, 'test/x.test.ts · load 3 · ticket/1-me · in CI')])('ticket/1-me', 'test/x.test.ts');
  assert.equal(edge.out, 'broken test, not a flake: test/x.test.ts red in 3 of 15 runs in the last 6 h');
});

test('a broken test is not excused by its fix minion; too few runs or reds, or reds older than 6 h, give no verdict', () => {
  const fixing = setup([...runs(10), ...reds(3)], [{ file: 'test/x.test.ts', ticket: 41, state: 'open', status: 'running' }])('ticket/1-me', 'test/x.test.ts');
  assert.equal(fixing.status, 1, 'a minion fixing it does not make a broken test a flake');
  assert.equal(fixing.out, 'broken test, not a flake: test/x.test.ts red in 3 of 11 runs in the last 6 h');
  assert.equal(setup([...runs(3), ...reds(3)])('ticket/1-me', 'test/x.test.ts').status, 0, '4 runs: too few to call');
  assert.equal(setup([...runs(5), ...reds(2)])('ticket/1-me', 'test/x.test.ts').status, 0, '2 reds: one quiet hour is no proof');
  assert.equal(setup([...runs(10), ...reds(3, 7 * 60 * MIN)])('ticket/1-me', 'test/x.test.ts').status, 0, 'reds from 7 h ago');
  // Reds from before its fix passed its proof don't count against it either.
  assert.equal(setup([...runs(10), ...reds(3, 30 * MIN)], [{ file: 'test/x.test.ts', ticket: 41, state: 'held', status: 'closed', heldAgo: 10 * MIN }])('ticket/1-me', 'test/x.test.ts').status, 1, 'no sightings since the fix: not known');
  const held = setup([...runs(10), ...reds(3, 30 * MIN), line(MIN, 'test/x.test.ts · load 3 · ticket/7-a · in CI')], [{ file: 'test/x.test.ts', ticket: 41, state: 'held', status: 'closed', heldAgo: 10 * MIN }])('ticket/1-me', 'test/x.test.ts');
  assert.equal(held.out, 'test/x.test.ts (seen on 1 other branch in 14 days)', 'one red since the fix: a flake again, not broken');
});
