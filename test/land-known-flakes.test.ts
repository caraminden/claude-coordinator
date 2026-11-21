// #1419 (Cara, 2026-11-20: "known flakes that havent been fixed are acceptable and do not block ship trains from going
// live"; she picked "Known flakes only"): a CI red whose every failed file passed alone, and each of them a known flake
// (seen passing alone on another branch in 14 days, or an open fix minion: tools/known-flakes.ts), ships with no fresh
// run. A first sighting, a file the ship touched or imports it changed, and a real failure keep #769's behaviour.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, git, issued, seen, setup } from './land-fixture.ts';
import { gitAt } from './git.ts';

const landLog = (shared: string) => readFileSync(join(shared, 'retro-log', readdirSync(join(shared, 'retro-log'))[0], 'land.md'), 'utf8');
const pushes = (c: ReturnType<typeof ci>) => c.calls().split('\n').filter((l) => l.includes('/actions/runners ')).length;

test('a red of known flakes only ships with no fresh CI run, says so, and still counts each sighting', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  seen(shared, ['test/busy.test.ts', 'test/slow.test.ts']);
  seen(shared, ['test/slow.test.ts'], 'ticket/8-another');
  seen(shared, ['test/busy.test.ts'], 'ticket/1-x'); // its own earlier sighting doesn't count
  const res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 0, res.stderr);
  const why = 'test/busy\\.test\\.ts \\(seen on 1 other branch in 14 days\\), test/slow\\.test\\.ts \\(seen on 2 other branches in 14 days\\)';
  assert.match(res.stderr, new RegExp(`only known flakes failed in CI \\(https://ci/\\d+\\): ${why}, so this goes on as green, with no fresh run`));
  assert.match(res.stderr, new RegExp(`^land: shipped past known flakes ${why}$`, 'm'));
  assert.doesNotMatch(res.stderr, /running CI once more|CI FALLBACK|retry in place/);
  assert.equal(pushes(c), 1, 'one run, no second push');
  assert.match(res.stderr, /^land: flake: test\/busy\.test\.ts · in CI$/m, 'the Test health tab still counts it');
  assert.match(landLog(shared), /· flake · test\/slow\.test\.ts · load 31\.5 · ticket\/1-x · in CI$/m);
  assert.match(landLog(shared), new RegExp(`· known flake · ticket/1-x · ${why} · https://ci/\\d+$`, 'm'));
  assert.doesNotMatch(landLog(shared), /· flake rerun ·/);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  assert.equal(c.localRuns(), 0);
});

test('one failed file seen for the first time gets the one fresh run, as before, and a red one refuses', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  seen(shared, ['test/slow.test.ts']);
  // The fresh run's red has a real failure: a second red of flakes only would keep its place (part 2, below).
  const res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'flakes', FAKE_LOG_RERUN: 'mixed', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /test\/busy\.test\.ts \(not seen on another branch in 14 days, and no minion is fixing it\) is no known flake/);
  assert.match(res.stderr, /failed in the full run but passed alone \(test\/busy\.test\.ts, test\/slow\.test\.ts\); running CI once more on \w+, the land needs a fully green run/);
  assert.match(res.stderr, /on the one fresh run after a red whose files all passed alone \(test\/busy\.test\.ts, test\/slow\.test\.ts\), so main is untouched/);
  assert.equal(pushes(c), 2);
  assert.doesNotMatch(res.stderr, /shipped past/);
  assert.doesNotMatch(landLog(shared), /· known flake ·/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

test("a known flake the ship changed, or that imports what it changed, gets the one fresh run: it's never excused", () => {
  for (const how of ['changed', 'imports'] as const) {
    const r = setup();
    const c = ci(r);
    if (how === 'imports') {
      // On main an hour before the sightings, so they count; the ship changes only what it imports.
      writeFileSync(join(r.source, 'lib.ts'), 'export const a = 1;\n');
      writeFileSync(join(r.source, 'test', 'slow.test.ts'), "import { a } from '../lib.ts';\n");
      git(r.source, 'add', '-A');
      gitAt(Date.now() - 3600_000, r.source, 'commit', '-qm', 'slow test');
      git(r.wt, 'rebase', '-q', 'main');
      r.commit(r.wt, 'lib.ts', 'export const a = 2;\n');
    } else r.commit(r.wt, 'test/slow.test.ts', 'mine\n');
    const shared = join(r.dir, 'shared');
    seen(shared, ['test/busy.test.ts', 'test/slow.test.ts']);
    const res = c.run({ FAKE_CI: 'red', FAKE_CI_RERUN: 'green', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /test\/slow\.test\.ts is a known flake, but #1 changed it or what it imports, so it isn't excused/, how);
    assert.match(res.stderr, /failed in the full run but passed alone \(test\/busy\.test\.ts, test\/slow\.test\.ts\); running CI once more/, how);
    assert.equal(pushes(c), 2, how);
    assert.doesNotMatch(res.stderr, /shipped past/, how);
    assert.match(landLog(shared), /· flake rerun · ticket\/1-x · test\/busy\.test\.ts, test\/slow\.test\.ts · green$/m, how);
  }
});

test('a real failure beside a known flake refuses at once, with no fresh run', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  seen(shared, ['test/slow.test.ts', 'test/real.test.ts']);
  const res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'mixed', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /tests failed on the rebased branch in CI \(https:\/\/ci\/\d+\), so main is untouched/);
  assert.doesNotMatch(res.stderr, /once more|known flake|shipped past/);
  assert.equal(pushes(c), 1);
});

test('a run that also left processes running is no flake run: the leak guard keeps the fresh run', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  seen(shared, ['test/busy.test.ts', 'test/slow.test.ts']);
  const res = c.run({ FAKE_CI: 'red', FAKE_CI_RERUN: 'green', FAKE_LOG: 'flakes', FAKE_LEAK: '1', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /the run also left processes running \(the leak guard\), so no flake is excused/);
  assert.match(res.stderr, /running CI once more/);
  assert.equal(pushes(c), 2);
  assert.doesNotMatch(res.stderr, /shipped past/);
});

const flaky = "import { readFileSync, writeFileSync } from 'node:fs';\nconst f = process.env.FLAKY_COUNT;\nif (f) {\n  let n = 0;\n  try { n = Number(readFileSync(f, 'utf8')); } catch {}\n  writeFileSync(f, String(++n));\n  if ((process.env.FLAKY_FAIL ?? '').split(',').includes(String(n))) throw new Error('flaky');\n}\n";

test("a perigee red of known flakes only lands on that run: no retry in place; an unknown one still goes again (#1360)", () => {
  for (const known of [true, false]) {
    const r = setup();
    const c = ci(r);
    writeFileSync(join(r.source, 'test', 'flaky.test.mjs'), flaky); // on main, so the ship didn't touch it
    git(r.source, 'add', '-A');
    gitAt(Date.now() - 3600_000, r.source, 'commit', '-qm', 'flaky test');
    git(r.wt, 'rebase', '-q', 'main');
    r.commit(r.wt, 'b.txt', 'mine\n');
    const shared = join(r.dir, 'shared');
    if (known) seen(shared, ['test/flaky.test.mjs']);
    else seen(shared, ['test/other.test.mjs']);
    const res = c.run({ LAND_CI: '0', LAND_SMOKE: '0', FLAKY_COUNT: join(r.dir, 'count'), FLAKY_FAIL: '1', COORDINATOR_SHARED_DIR: shared });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
    if (known) {
      assert.match(res.stderr, /only known flakes failed on perigee: test\/flaky\.test\.mjs \(seen on 1 other branch in 14 days\), so this goes on as green/);
      assert.match(res.stderr, /^land: shipped past known flakes test\/flaky\.test\.mjs \(seen on 1 other branch in 14 days\)$/m);
      assert.doesNotMatch(res.stderr, /refused by the pipeline|retry in place/);
      assert.equal(readFileSync(join(r.dir, 'count'), 'utf8'), '2', 'the full run and its rerun alone, once');
    } else {
      assert.match(res.stderr, /refused by the pipeline \(failed in the full run but passed alone on perigee: test\/flaky\.test\.mjs\), not your change/);
      assert.doesNotMatch(res.stderr, /shipped past/);
    }
  }
});

test('an open fix minion makes a file known with no other sighting, and the reason names its number', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  seen(shared, ['test/busy.test.ts', 'test/slow.test.ts'], 'ticket/1-x'); // only this ship's own sightings
  const dbPath = join(r.dir, 'flakes.db');
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE tickets (id INTEGER PRIMARY KEY, project_id INTEGER, number INTEGER, status TEXT); CREATE TABLE flake_fixes (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, file TEXT NOT NULL, ticket_id INTEGER, state TEXT NOT NULL, held_at INTEGER); INSERT INTO tickets VALUES (5, 2, 1, 'working'), (1040, 2, 40, 'working'), (1041, 2, 41, 'working'); INSERT INTO flake_fixes (project_id, file, ticket_id, state) VALUES (2, 'test/busy.test.ts', 1040, 'open'), (2, 'test/slow.test.ts', 1041, 'open')");
  db.close();
  const res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared, DEPLOY_DB: dbPath, COORDINATOR_TICKET: '5' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /^land: shipped past known flakes test\/busy\.test\.ts \(fix #40\), test\/slow\.test\.ts \(fix #41\)$/m);
  assert.equal(pushes(c), 1, 'no fresh run');
});

// Part 2 (Taskmaster, 2026-11-21, after Cara: "I thought they were supposed to keep their spot not?"): a red of flakes
// only on the fresh run too keeps the ship's place in line, up to twice a hand-off, instead of going back to its minion.
const keeps = (shared: string) => landLog(shared).split('\n').filter((l) => l.includes(' · flake keep · '));

test('a second red of flakes only keeps its place in line, goes again on the same ticket, and ships on a green', async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const state = join(r.dir, 'ci-state');
  writeFileSync(state, 'red');
  let flipped = false;
  const res = await c.runAsync({ FAKE_CI_FILE: state, FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared }, (s) => {
    if (!flipped && /keeping its place in line/.test(s)) { flipped = true; writeFileSync(state, 'green'); }
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /refused on flakes only \(test\/busy\.test\.ts, test\/slow\.test\.ts, then test\/busy\.test\.ts, test\/slow\.test\.ts on the fresh run\), not your change: keeping its place in line and riding the next train \(1 of 2\)/);
  assert.match(res.stderr, /back at the front after its retry in place/);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  assert.equal(issued(join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy')), 1, 'the same ticket, not a new one at the back');
  assert.equal(keeps(shared).length, 1);
});

test('reds of flakes only keep its place twice at most, then it is refused back to its minion', () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const shared = join(r.dir, 'shared');
  const res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\(2 of 2\)/);
  assert.doesNotMatch(res.stderr, /\(3 of 2\)/);
  assert.match(res.stderr, /only flakes failed again \(test\/busy\.test\.ts, test\/slow\.test\.ts\), but it has kept its place 2 times already, so it is refused this time/);
  assert.match(res.stderr, /on the one fresh run after a red whose files all passed alone/);
  assert.equal(keeps(shared).length, 2);
  assert.equal(pushes(c), 6, 'two runs a go, three goes');
});

test('a second red with a real failure, a flake the ship changed, or leftover processes goes back to its minion at once', () => {
  for (const how of ['real', 'touched', 'leak'] as const) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, how === 'touched' ? 'test/slow.test.ts' : 'b.txt', 'mine\n');
    const shared = join(r.dir, 'shared');
    const res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'flakes', ...(how === 'real' ? { FAKE_LOG_RERUN: 'mixed' } : {}), ...(how === 'leak' ? { FAKE_LEAK: '1' } : {}), COORDINATOR_SHARED_DIR: shared });
    assert.equal(res.status, 1, how);
    assert.doesNotMatch(res.stderr, /keeping its place/, how);
    assert.match(res.stderr, /on the one fresh run after a red whose files all passed alone/, how);
    assert.equal(pushes(c), 2, how);
  }
});
