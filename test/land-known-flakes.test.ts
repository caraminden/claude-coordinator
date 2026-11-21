// #1419 (Cara, 2026-11-20: "known flakes that havent been fixed are acceptable and do not block ship trains from going
// live"; she picked "Known flakes only"): a CI red whose every failed file passed alone, and each of them a known flake
// (seen passing alone on another branch in 14 days, or an open fix minion: tools/known-flakes.ts), ships with no fresh
// run. A first sighting, a file the ship touched or imports it changed, and a real failure keep #769's behaviour.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, git, seen, setup } from './land-fixture.ts';
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
  const res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'flakes', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /test\/busy\.test\.ts \(not seen on another branch in 14 days, and no minion is fixing it\) is no known flake/);
  assert.match(res.stderr, /only flakes failed \(test\/busy\.test\.ts, test\/slow\.test\.ts\); running CI once more on \w+, the land needs a fully green run/);
  assert.match(res.stderr, /on the one fresh run after a red of flakes only \(test\/busy\.test\.ts, test\/slow\.test\.ts\), so main is untouched/);
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
    assert.match(res.stderr, /only flakes failed \(test\/busy\.test\.ts, test\/slow\.test\.ts\); running CI once more/, how);
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
      assert.match(res.stderr, /refused by the pipeline \(only flakes failed on perigee: test\/flaky\.test\.mjs\), not your change/);
      assert.doesNotMatch(res.stderr, /shipped past/);
    }
  }
});
