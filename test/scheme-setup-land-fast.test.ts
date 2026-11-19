// The scheme-setup template land.sh in fast mode (#1017): LAND_FAST lands on the smoke check alone, LAND_KNOWN_RED lets
// failures already on main through, and --verify runs the full check and CI on a commit on main.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { env, git, queueSetup, setup, until } from './scheme-setup-land-fixture.ts';

// CI faked as in scheme-setup-land-ci.test.ts: CI_STATUS answers from a file named after the commit ("<code>" and what
// to print; no file: not started), and a gh first in PATH, so nothing reaches GitHub. asked: every commit it was asked about.
function fakeCi(dir: string) {
  const ci = join(dir, 'ci');
  const bin = join(dir, 'bin');
  mkdirSync(ci);
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(ci, 'status.sh'), '#!/bin/bash\necho "${1:0:12}" >>"$CI_DIR/asked"\nf=$CI_DIR/${1:0:12}\n[ -e "$f" ] || exit 3\ntail -n +2 "$f"\nexit "$(head -n 1 "$f")"\n', { mode: 0o755 });
  const answer = (sha: string, code: number, out = '') => writeFileSync(join(ci, sha.slice(0, 12)), `${code}\n${out}`);
  const asked = () => { try { return readFileSync(join(ci, 'asked'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  return { env: { CI_DIR: ci, CI_FAKE: join(ci, 'status.sh'), PATH: `${bin}:${env.PATH}`, LAND_CI_POLL: '0', LAND_CI_GRACE: '0', LAND_CI_START: '3' }, answer, asked };
}
const CI = { CI_STATUS: '"$CI_FAKE"' };
const red = (...files: string[]) => `printf "test at %s:3:1\\n" ${files.join(' ')}; exit 1`;

test('fast mode: a land goes live on the smoke check alone, with no check and no CI; without LAND_FAST the gate holds', () => {
  const r = setup('false', CI);
  const ci = fakeCi(r.dir);
  r.commit(r.wt, 'b.txt', 'b\n');
  const gated = r.run(ci.env);
  assert.equal(gated.status, 1, gated.stderr);
  assert.match(gated.stderr, /the check failed/);
  const fast = r.run({ ...ci.env, LAND_FAST: '1' });
  assert.equal(fast.status, 0, fast.stderr);
  assert.match(fast.stderr, /fast mode: this lands on the smoke check alone/);
  assert.doesNotMatch(fast.stderr, /running false|waiting for CI/);
  assert.deepEqual(ci.asked(), []);
  assert.equal(git(r.main, 'log', '-1', '--format=%s', 'main'), 'b.txt: b');
  assert.equal(git(r.origin, 'for-each-ref', 'refs/heads/land'), '', 'nothing was pushed for CI');
});

test('fast mode: the smoke check still refuses, and a branch changing the pipeline or a FAST_FULL path takes the full gate', () => {
  const r = setup('false', { FAST_FULL: 'db/*' });
  r.commit(r.wt, 'db/m1.sql', 'one\n');
  const db = r.run({ LAND_FAST: '1' });
  assert.equal(db.status, 1, db.stderr);
  assert.match(db.stderr, /fast mode is on, but db\/m1\.sql takes the full gate/);
  assert.match(db.stderr, /the check failed/);

  const p = setup('false', {}, '');
  p.commit(p.wt, 'b.txt', 'b\n');
  p.commit(p.wt, 'tools/land.local.sh', 'SMOKE_CMD=true\n');
  const pipe = p.run({ LAND_FAST: '1' });
  assert.equal(pipe.status, 1, pipe.stderr);
  assert.match(pipe.stderr, /tools\/land\.local\.sh takes the full gate/);

  const s = setup('false', { SMOKE_CMD: 'test ! -e broken' });
  s.commit(s.wt, 'broken', 'x\n');
  const smoke = s.run({ LAND_FAST: '1' });
  assert.equal(smoke.status, 1, smoke.stderr);
  assert.match(smoke.stderr, /smoke: SMOKE_CMD failed/);
});

test('known reds: a smoke, check or CI red only on known reds goes through and says who is fixing it; a new failure still refuses', () => {
  const known = { LAND_KNOWN_RED: 'test/x.test.ts\t#41\nci:ci.yml\t#42' };
  // The smoke check
  const s = setup('true', { SMOKE_CMD: red('test/x.test.ts') });
  s.commit(s.wt, 'b.txt', 'b\n');
  const sm = s.run(known);
  assert.equal(sm.status, 0, sm.stderr);
  assert.match(sm.stderr, /smoke: SMOKE_CMD failed only on known reds, so it goes on: test\/x\.test\.ts: known red, #41 is fixing it/);
  const s2 = setup('true', { SMOKE_CMD: red('test/x.test.ts', 'test/y.test.ts') });
  s2.commit(s2.wt, 'b.txt', 'b\n');
  assert.equal(s2.run(known).status, 1, 'a new failing file refuses');
  // The check, with node's tap output (absolute paths) too
  const c = setup('printf "not ok 1 - a\\n  location: \\047%s/test/x.test.ts:3:1\\047\\n" "$(pwd)"; exit 1');
  c.commit(c.wt, 'b.txt', 'b\n');
  const ck = c.run(known);
  assert.equal(ck.status, 0, ck.stderr);
  assert.match(ck.stderr, /the check failed only on known reds/);
  const c2 = setup(red('test/x.test.ts'));
  c2.commit(c2.wt, 'b.txt', 'b\n');
  assert.equal(c2.run().status, 1, 'with no LAND_KNOWN_RED the check refuses');
  // CI
  const g = setup('true', CI);
  const ci = fakeCi(g.dir);
  g.commit(g.wt, 'b.txt', 'b\n');
  const tip = git(g.wt, 'rev-parse', 'HEAD');
  // The rebased commit is the branch's own here (main hasn't moved), so its answer can be written now.
  ci.answer(tip, 1, 'ci.yml: completed failure https://x\n');
  const cr = g.run({ ...ci.env, ...known });
  assert.equal(cr.status, 0, cr.stderr);
  assert.match(cr.stderr, /CI on [0-9a-f]{12} failed only on known reds, so it goes on: ci:ci\.yml: known red, #42 is fixing it/);
});

test('--verify: the full check and CI on HEAD, out of line; prints green, or each failing id and red', () => {
  const r = setup(red('test/a.test.ts', 'test/b.test.ts'), CI);
  const ci = fakeCi(r.dir);
  const v = join(r.dir, 'verify');
  git(r.main, 'worktree', 'add', '-q', '--detach', v, 'main');
  const verify = (extra: Record<string, string> = {}) => spawnSync('bash', [join(v, 'tools', 'land.sh'), '--verify'], { cwd: v, encoding: 'utf8', timeout: 30_000, env: { ...env, ...ci.env, ...extra } });
  const head = git(v, 'rev-parse', 'HEAD');
  ci.answer(head, 1, 'ci.yml: completed failure https://x\n');
  const out = verify({ LAND_KNOWN_RED: 'test/a.test.ts\t#1' });
  assert.equal(out.status, 1, out.stderr);
  assert.equal(out.stdout, 'verify: failing ci:ci.yml\nverify: failing test/a.test.ts\nverify: failing test/b.test.ts\nverify: red\n', 'known reds count as red here');
  assert.equal(git(r.origin, 'for-each-ref', 'refs/heads/land'), '', 'its scratch branch is gone');

  const g = setup('true', CI);
  const gci = fakeCi(g.dir);
  const gv = join(g.dir, 'verify');
  git(g.main, 'worktree', 'add', '-q', '--detach', gv, 'main');
  const run = () => spawnSync('bash', [join(gv, 'tools', 'land.sh'), '--verify'], { cwd: gv, encoding: 'utf8', timeout: 30_000, env: { ...env, ...gci.env } });
  const none = run();
  assert.equal(none.status, 75, none.stderr);
  assert.equal(none.stdout, 'verify: no verdict\n');
  gci.answer(git(gv, 'rev-parse', 'HEAD'), 0);
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'verify: green\n');
});

test('fast mode in a batched line: the fast landing is a batch of its own, and the gated ones around it land on their own runs', { timeout: 120_000 }, async () => {
  const q = queueSetup(3, 'until [ -e "$GATE" ]; do sleep 0.05; done', CI);
  const ci = fakeCi(q.dir);
  const e = { ...ci.env, LAND_BATCH: '3', LAND_CI_START: '60' };
  const started: ReturnType<typeof q.land>[] = [];
  try {
    const one = q.land(1, e);
    started.push(one);
    await until('landing 1 in line', () => q.issued() === 1);
    const two = q.land(2, { ...e, LAND_FAST: '1' });
    started.push(two);
    await until(`landing 2 in line: ${two.stderr()}`, () => q.issued() === 2 || two.child.exitCode !== null);
    assert.equal(two.child.exitCode, null, two.stderr());
    const three = q.land(3, e);
    started.push(three);
    await until('landing 3 in line', () => q.issued() === 3);
    q.open();
    // Every run CI is asked about is green.
    const greenAll = setInterval(() => { for (const sha of ci.asked()) ci.answer(sha, 0); }, 50);
    try {
      assert.equal(await one.exit, 0, one.stderr());
      assert.equal(await two.exit, 0, two.stderr());
      assert.equal(await three.exit, 0, three.stderr());
    } finally {
      clearInterval(greenAll);
    }
    assert.deepEqual(q.landed(), ['f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3']);
    assert.doesNotMatch(one.stderr(), /landed in a batch/, "the fast one isn't in landing 1's batch");
    assert.doesNotMatch(two.stderr(), /^land: (waiting for CI|running |lane )/m);
    const fastSha = git(q.main, 'rev-parse', 'main~1').slice(0, 12);
    assert.ok(!ci.asked().includes(fastSha), 'CI was never asked about the fast commit');
  } finally {
    for (const l of started) if (l.child.exitCode === null) l.child.kill('SIGKILL');
  }
});
