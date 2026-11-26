// The scheme-setup template land.sh in fast mode (#1017): LAND_FAST lands on the smoke check alone, LAND_KNOWN_RED lets
// failures already on main through, and --verify runs the full check and CI on a commit on main.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { env, git, queueSetup, rebasedCalls, rebasedHook, setup, until } from './scheme-setup-land-fixture.ts';

// CI faked as in scheme-setup-land-ci.test.ts: CI_STATUS answers from a file named after the commit ("<code>" and what
// to print; no file: not started), and a gh first in PATH, so nothing reaches GitHub. asked: every commit it was asked about.
function fakeCi(dir: string) {
  const ci = join(dir, 'ci');
  const bin = join(dir, 'bin');
  mkdirSync(ci);
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(ci, 'status.sh'), '#!/bin/bash\necho "${1:0:12}" >>"$CI_DIR/asked"\nf=$CI_DIR/${1:0:12}\n[ -e "$f" ] || exit 3\ntail -n +2 "$f"\nexit "$(head -n 1 "$f")"\n', { mode: 0o755 });
  // Written aside and renamed in: status.sh reading a file writeFileSync had just truncated got an empty exit code (exit 2).
  const answer = (sha: string, code: number, out = '') => {
    const f = join(ci, sha.slice(0, 12));
    writeFileSync(`${f}.tmp`, `${code}\n${out}`);
    renameSync(`${f}.tmp`, f);
  };
  const asked = () => {
    try {
      return readFileSync(join(ci, 'asked'), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  return { env: { CI_DIR: ci, CI_FAKE: join(ci, 'status.sh'), PATH: `${bin}:${env.PATH}`, LAND_CI_POLL: '0', LAND_CI_GRACE: '0', LAND_CI_START: '3' }, answer, asked };
}
const CI = { CI_STATUS: '"$CI_FAKE"' };
const red = (...files: string[]) => `printf "test at %s:3:1\\n" ${files.join(' ')}; exit 1`;

test('fast mode: a land goes live on the smoke check alone, with no check and no CI; without LAND_FAST the gate holds', () => {
  const r = setup('false', { ...CI, SMOKE_CMD: 'true' });
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
  const known = { LAND_KNOWN_RED: 'test/x.test.ts\t#41 is fixing it\nci:ci.yml\t#42 is fixing it' };
  // The smoke check
  const s = setup('true', { SMOKE_CMD: red('test/x.test.ts') });
  s.commit(s.wt, 'b.txt', 'b\n');
  const sm = s.run(known);
  assert.equal(sm.status, 0, sm.stderr);
  assert.match(sm.stderr, /smoke: SMOKE_CMD failed only on known reds, so it goes on: test\/x\.test\.ts: known red, #41 is fixing it/);
  assert.doesNotMatch(sm.stderr, /smoke: passed/, 'a smoke check red on known reds did not pass');
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

  // A known red beside a workflow that ended with no verdict doesn't ship: that one never went green (Mandate #153's review).
  const n = setup('true', CI);
  const nci = fakeCi(n.dir);
  n.commit(n.wt, 'b.txt', 'b\n');
  const before = git(n.main, 'rev-parse', 'main');
  nci.answer(git(n.wt, 'rev-parse', 'HEAD'), 1, 'ci.yml: completed failure https://x\nslow.yml: no verdict (cancelled) https://y\n');
  const nr = n.run({ ...nci.env, ...known });
  assert.notEqual(nr.status, 0, nr.stderr);
  assert.doesNotMatch(nr.stderr, /failed only on known reds, so it goes on/);
  assert.equal(git(n.main, 'rev-parse', 'main'), before, 'nothing shipped');
});

test('--verify: the full check and CI on HEAD, out of line; prints green, or each failing id and red', () => {
  const r = setup(red('test/a.test.ts', 'test/b.test.ts'), CI);
  const ci = fakeCi(r.dir);
  const v = join(r.dir, 'verify');
  git(r.main, 'worktree', 'add', '-q', '--detach', v, 'main');
  const verify = (extra: Record<string, string> = {}) => spawnSync('bash', [join(v, 'tools', 'land.sh'), '--verify'], { cwd: v, encoding: 'utf8', timeout: 30_000, env: { ...env, ...ci.env, ...extra } });
  const head = git(v, 'rev-parse', 'HEAD');
  ci.answer(head, 1, 'ci.yml: completed failure https://x\n');
  const out = verify({ LAND_KNOWN_RED: 'test/a.test.ts\t#1 is fixing it' });
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
  const q = queueSetup(3, 'until [ -e "$GATE" ]; do sleep 0.05; done', { ...CI, SMOKE_CMD: 'true' });
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
    const greenAll = setInterval(() => {
      for (const sha of ci.asked()) ci.answer(sha, 0);
    }, 50);
    try {
      assert.equal(await one.exit, 0, one.stderr());
      assert.equal(await two.exit, 0, two.stderr());
      assert.equal(await three.exit, 0, three.stderr());
    } finally {
      clearInterval(greenAll);
    }
    assert.deepEqual(q.landed(), ['f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3']);
    assert.doesNotMatch(one.stderr(), /landed [0-9a-f]+ "[^"]*" in a batch/, "the fast one isn't in landing 1's batch");
    assert.doesNotMatch(two.stderr(), /^land: (waiting for CI|running |lane )/m);
    const fastSha = git(q.main, 'rev-parse', 'main~1').slice(0, 12);
    assert.ok(!ci.asked().includes(fastSha), 'CI was never asked about the fast commit');
  } finally {
    for (const l of started) if (l.child.exitCode === null) l.child.kill('SIGKILL');
  }
});

test('fast mode: with no smoke check a land takes the full gate', () => {
  const r = setup('false');
  r.commit(r.wt, 'b.txt', 'b\n');
  const out = r.run({ LAND_FAST: '1' });
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stderr, /fast mode is on, but a land with no smoke check takes the full gate/);
  assert.match(out.stderr, /the check failed/);
  const off = setup('false', { SMOKE_CMD: 'true' });
  off.commit(off.wt, 'b.txt', 'b\n');
  assert.equal(off.run({ LAND_FAST: '1', LAND_SMOKE: '0' }).status, 1, 'LAND_SMOKE=0 turns the smoke check off, so fast mode too');
});

test('known reds: a per-test id covers only that test, a file id covers its tests, and a check that hung is never waived', () => {
  // node's spec output: "test at <file>:l:c" then the failing test's name after a cross.
  const spec = (...names: string[]) => `printf "${names.map((n) => `test at test/x.test.ts:3:1\\n\\342\\234\\226 ${n} (1ms)\\n`).join('')}"; exit 1`;
  const one = setup(spec('a'));
  one.commit(one.wt, 'b.txt', 'b\n');
  const ok = one.run({ LAND_KNOWN_RED: 'test/x.test.ts::a\t#41 is fixing it' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /test\/x\.test\.ts::a: known red, #41 is fixing it/);
  const two = setup(spec('a', 'b'));
  two.commit(two.wt, 'b.txt', 'b\n');
  assert.equal(two.run({ LAND_KNOWN_RED: 'test/x.test.ts::a\t#41 is fixing it' }).status, 1, 'b failing is new');
  const file = setup(spec('a', 'b'));
  file.commit(file.wt, 'b.txt', 'b\n');
  assert.equal(file.run({ LAND_KNOWN_RED: 'test/x.test.ts\t#41 is fixing it' }).status, 0, 'the file id covers both');
  const hung = setup('printf "test at test/x.test.ts:3:1\\n"; sleep 20');
  hung.commit(hung.wt, 'b.txt', 'b\n');
  const h = hung.run({ LAND_KNOWN_RED: 'test/x.test.ts\t#41 is fixing it', LAND_CHECK_TIMEOUT: '1' });
  assert.equal(h.status, 1, h.stderr);
  assert.doesNotMatch(h.stderr, /only on known reds/);
});

// git quotes a non-ASCII path in --name-only ("\"db/m\\303\\251.sql\""), which matched none of the patterns (Mandate #152).
test('fast mode: a non-ASCII path in a FAST_FULL pattern or under .github still takes the full gate', () => {
  const r = setup('false', { FAST_FULL: 'db/*', SMOKE_CMD: 'true' });
  r.commit(r.wt, 'db/m\u00e9.sql', 'one\n');
  const db = r.run({ LAND_FAST: '1' });
  assert.equal(db.status, 1, db.stderr);
  assert.match(db.stderr, /fast mode is on, but db\/m\u00e9\.sql takes the full gate/);
  const g = setup('false', { SMOKE_CMD: 'true' });
  g.commit(g.wt, '.github/workflows/t\u00e9sts.yml', 'on: push\n');
  const gh = g.run({ LAND_FAST: '1' });
  assert.equal(gh.status, 1, gh.stderr);
  assert.match(gh.stderr, /fast mode is on, but \.github\/workflows\/t\u00e9sts\.yml takes the full gate/);
  // A newline in a name: split into lines, neither half would match the pattern.
  const nl = setup('false', { FAST_FULL: 'db/*.sql', SMOKE_CMD: 'true' });
  nl.commit(nl.wt, 'db/a\nb.sql', 'one\n');
  const nr = nl.run({ LAND_FAST: '1' });
  assert.equal(nr.status, 1, nr.stderr);
  assert.match(nr.stderr, /fast mode is on, but db\/a\nb\.sql takes the full gate/);
});

// A scheme's CI_STATUS may name its workflows with spaces and indent its lines: still a CI red's id, and still running.
test('known reds: a CI_STATUS line indented or naming a workflow with spaces is read like a plain one', () => {
  const known = { LAND_KNOWN_RED: 'ci:Tests (linux)\t#42 is fixing it', LAND_CI_TIMEOUT: '2' };
  const g = setup('true', CI);
  const ci = fakeCi(g.dir);
  g.commit(g.wt, 'b.txt', 'b\n');
  ci.answer(git(g.wt, 'rev-parse', 'HEAD'), 1, '  Tests (linux): completed failure https://x\n');
  const cr = g.run({ ...ci.env, ...known });
  assert.equal(cr.status, 0, cr.stderr);
  assert.match(cr.stderr, /failed only on known reds, so it goes on: ci:Tests \(linux\): known red, #42 is fixing it/);
  const w = setup('true', CI);
  const wci = fakeCi(w.dir);
  w.commit(w.wt, 'b.txt', 'b\n');
  wci.answer(git(w.wt, 'rev-parse', 'HEAD'), 1, '  Tests (linux): completed failure https://x\n  Lint, mac: in_progress https://y\n');
  const wr = w.run({ ...wci.env, ...known });
  assert.notEqual(wr.status, 0, wr.stderr);
  assert.doesNotMatch(wr.stderr, /failed only on known reds, so it goes on/, 'it waits for Lint, mac, which never finishes');
  // A comma after "completed", as one scheme's CI_STATUS prints it.
  const c = setup('true', CI);
  const cci = fakeCi(c.dir);
  c.commit(c.wt, 'b.txt', 'b\n');
  cci.answer(git(c.wt, 'rev-parse', 'HEAD'), 1, '  android.yml: completed, failure (made 3 min ago, run 5)\n');
  const comma = c.run({ ...cci.env, LAND_KNOWN_RED: 'ci:android.yml\t#42 is fixing it', LAND_CI_TIMEOUT: '2' });
  assert.equal(comma.status, 0, comma.stderr);
  assert.match(comma.stderr, /failed only on known reds, so it goes on: ci:android\.yml: known red, #42 is fixing it/);
});

test('known reds: a known CI red waits for the workflows still running before it goes on', () => {
  const g = setup('true', CI);
  const ci = fakeCi(g.dir);
  g.commit(g.wt, 'b.txt', 'b\n');
  ci.answer(git(g.wt, 'rev-parse', 'HEAD'), 1, 'ci.yml: completed failure https://x\nother.yml: in_progress https://y\n');
  const out = g.run({ ...ci.env, LAND_KNOWN_RED: 'ci:ci.yml\t#42 is fixing it', LAND_CI_TIMEOUT: '2' });
  assert.notEqual(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stderr, /failed only on known reds, so it goes on/);
  assert.equal(git(g.main, 'log', '-1', '--format=%s', 'main'), 'base', 'nothing landed');
});

test('--verify with LAND_VERIFY_IDS: only those ids, each file alone through CHECK_FILE_CMD, and no CI without a ci: id', () => {
  const r = setup('exit 9', { ...CI, CHECK_FILE_CMD: 'echo {file} >>"$RAN"; [ {file} != test/b.test.ts ] || { printf "test at %s:3:1\\n" {file}; exit 1; }' });
  const ci = fakeCi(r.dir);
  const v = join(r.dir, 'verify');
  git(r.main, 'worktree', 'add', '-q', '--detach', v, 'main');
  const ran = join(r.dir, 'ran');
  const out = spawnSync('bash', [join(v, 'tools', 'land.sh'), '--verify'], { cwd: v, encoding: 'utf8', timeout: 30_000, env: { ...env, ...ci.env, RAN: ran, LAND_VERIFY_IDS: 'test/a.test.ts::one\ntest/b.test.ts\ntest/a.test.ts::two' } });
  assert.equal(out.status, 1, out.stderr);
  assert.equal(out.stdout, 'verify: failing test/b.test.ts\nverify: red\n');
  assert.deepEqual(readFileSync(ran, 'utf8').split('\n').filter(Boolean), ['test/a.test.ts', 'test/b.test.ts'], 'each file once, not the whole check');
  assert.deepEqual(ci.asked(), [], 'no ci: id, so CI was not asked');
});

test('fast mode: a smoke check that runs past its time limit refuses, since nothing else would run', () => {
  const r = setup('true', { SMOKE_CMD: 'sleep 20' });
  r.commit(r.wt, 'b.txt', 'b\n');
  const out = r.run({ LAND_FAST: '1', LAND_SMOKE_TIMEOUT: '1' });
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stderr, /ran past 1 s, and a fast land goes live on it alone, so nothing landed/);
  assert.equal(git(r.main, 'log', '-1', '--format=%s', 'main'), 'base');
});

test('--verify: a CI-only id list asks only CI, and a workflow already red is red even if another never finishes', () => {
  const r = setup('exit 9', CI);
  const ci = fakeCi(r.dir);
  const v = join(r.dir, 'verify');
  git(r.main, 'worktree', 'add', '-q', '--detach', v, 'main');
  ci.answer(git(v, 'rev-parse', 'HEAD'), 1, 'ci.yml: completed failure https://x\nother.yml: in_progress https://y\n');
  const run = (extra: Record<string, string>) => spawnSync('bash', [join(v, 'tools', 'land.sh'), '--verify'], { cwd: v, encoding: 'utf8', timeout: 30_000, env: { ...env, ...ci.env, LAND_CI_TIMEOUT: '1', ...extra } });
  const only = run({ LAND_VERIFY_IDS: 'ci:ci.yml' });
  assert.equal(only.stdout, 'verify: failing ci:ci.yml\nverify: red\n', only.stderr);
  assert.doesNotMatch(only.stderr, /exit 9|the check/);
  const full = run({});
  assert.equal(full.stdout, 'verify: failing ci:ci.yml\nverify: failing the check\nverify: red\n', 'the check failed with no id, and ci.yml stays red');
});

test('land_rebased runs in fast mode too, and its commit ships; --verify, on a commit already on main, never calls it', () => {
  const r = setup('false', { ...CI, SMOKE_CMD: 'true' }, rebasedHook);
  const ci = fakeCi(r.dir);
  const base = git(r.main, 'rev-parse', 'main');
  r.commit(r.wt, 'b.txt', 'b\n');
  const fast = r.run({ ...ci.env, LAND_FAST: '1' });
  assert.equal(fast.status, 0, fast.stderr);
  assert.match(fast.stderr, /fast mode: this lands on the smoke check alone/);
  assert.deepEqual(rebasedCalls(r.main), [`${base} ticket/1-x`]);
  assert.equal(git(r.main, 'log', '-1', '--format=%s', 'main'), `rebased on ${base}`);
  assert.equal(git(r.main, 'show', 'main:rebased.txt'), base);

  const v = join(r.dir, 'verify');
  git(r.main, 'worktree', 'add', '-q', '--detach', v, 'main');
  ci.answer(git(v, 'rev-parse', 'HEAD'), 0);
  const out = spawnSync('bash', [join(v, 'tools', 'land.sh'), '--verify'], { cwd: v, encoding: 'utf8', timeout: 30_000, env: { ...env, ...ci.env } });
  assert.match(out.stdout, /verify: (red|green)/, out.stderr);
  assert.deepEqual(rebasedCalls(r.main), [`${base} ticket/1-x`], '--verify called it no more');
});

test("fast mode: a path in PIPELINE_FILES' list (main's copy) keeps the full gate, as the pipeline's own files do", () => {
  const r = setup('false', { SMOKE_CMD: 'true' }, 'PIPELINE_FILES=pipe.txt\n');
  r.commit(r.main, 'pipe.txt', 'deploy/ # the deploy\n');
  r.commit(r.wt, 'deploy/run.sh', 'x\n');
  const res = r.run({ LAND_FAST: '1' });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /fast mode is on, but deploy\/run\.sh takes the full gate/);
});

// #2157 (Peek Auras #977): fast mode turned the early check off, so a fast land ran SMOKE_CMD alone and a new `any` went live.
test('fast mode: the kit type check a fresh scheme has runs on the rebase and refuses a new any; FAST_CHECK replaces it', () => {
  const r = setup('false', { SMOKE_CMD: 'true' });
  const kit = readFileSync(join(import.meta.dirname, '..', 'kit', 'skills', 'scheme-setup', 'templates', 'typecheck.ts'), 'utf8');
  writeFileSync(join(r.main, 'tools', 'typecheck.ts'), kit.replace(/^export const PROJECTS = .*$/m, 'export const PROJECTS: string[] = [];'));
  writeFileSync(join(r.main, 'a.ts'), 'export const a = 1;\n');
  git(r.main, 'add', '-A'); // it counts tracked files
  assert.equal(spawnSync('node', ['tools/typecheck.ts', '--init'], { cwd: r.main, env }).status, 0);
  git(r.main, 'add', '-A');
  git(r.main, 'commit', '-qm', 'the type check');
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'b.ts', 'export const b: any = 1;');
  const before = git(r.main, 'rev-parse', 'main');
  const bad = r.run({ LAND_FAST: '1' });
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /smoke: running node tools\/typecheck\.ts on ticket\/1-x rebased onto main/);
  assert.match(bad.stderr, /b\.ts: escapes 0 → 1\n[^]*smoke: the check failed on the rebased branch/);
  assert.equal(git(r.main, 'rev-parse', 'main'), before, 'nothing shipped');
  r.commit(r.wt, 'b.ts', 'export const b: number = 1;');
  const good = r.run({ LAND_FAST: '1' });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stderr, /smoke: the check passed on the rebased branch/);
  assert.doesNotMatch(good.stderr, /running false/, 'still no full check');

  // FAST_CHECK set in land.local.sh runs instead, on the rebase: red only once main's change is under the branch.
  const s = setup('false', { SMOKE_CMD: 'true' }, "FAST_CHECK='test ! -e red'\n");
  s.commit(s.main, 'red', 'main broke it\n');
  s.commit(s.wt, 'b.txt', 'b\n');
  const own = s.run({ LAND_FAST: '1' });
  assert.equal(own.status, 1, own.stderr);
  assert.match(own.stderr, /smoke: running test ! -e red on ticket\/1-x rebased onto main/);
});
