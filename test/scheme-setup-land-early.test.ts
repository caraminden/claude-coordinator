// The scheme-setup template land.sh's early check (#1177, Peek Auras #637's idea Z1): the smoke check also runs
// CHECK_LIGHT on the branch rebased onto main, so a branch whose rebase fails it is refused before the line, with the
// same last lines a red at the front shows; when main hasn't moved by the front, that checked commit is the build and
// the light check runs once. Here CHECK_LIGHT is CHECK unless a test says otherwise, as for a light lane.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, queueSetup, rebasedCalls, rebasedHook, setup, until } from './scheme-setup-land-fixture.ts';

// Red while a file named "red" is in the tree, saying so last; every run leaves a line in $COUNT.
const CHECK = 'echo run >>"$COUNT"; test ! -e red || { echo "the check saw red"; exit 1; }';
const on = (check: string) => ({ EARLY_CHECK: '1', CHECK_LIGHT: check });
const count = (dir: string) => (existsSync(join(dir, 'count')) ? readFileSync(join(dir, 'count'), 'utf8').split('\n').filter(Boolean).length : 0);
const state = (r: { main: string }) => git(r.main, 'rev-parse', '--absolute-git-dir');
// The line before land.sh's own last one (its refusal; the ship: line after it is dropped): the check's tail (this check prints one line).
const tail = (stderr: string) =>
  stderr
    .trimEnd()
    .replace(/\nship: .*$/, '')
    .split('\n')
    .at(-2);

test('a branch whose rebase onto main fails the check is refused before the line, with the last lines a red at the front gets, and never takes a ticket', () => {
  const runs: Record<string, ReturnType<ReturnType<typeof setup>['run']>> = {};
  for (const early of ['1', '0']) {
    const r = setup(CHECK, { CHECK_LIGHT: CHECK, EARLY_CHECK: early });
    r.commit(r.main, 'red', 'main broke it\n'); // green on the branch alone, red only once rebased onto main
    r.commit(r.wt, 'b.txt', 'b\n');
    const before = git(r.main, 'rev-parse', 'main');
    const res = (runs[early] = r.run({ COUNT: join(r.dir, 'count') }));
    assert.equal(res.status, 1, res.stderr);
    assert.equal(git(r.main, 'rev-parse', 'main'), before, 'main is untouched');
    assert.equal(git(r.wt, 'branch', '--show-current'), 'ticket/1-x', 'the worktree is back on its branch');
    assert.equal(git(r.wt, 'rev-parse', 'HEAD~1'), before, 'the branch is on the rebase, so the fix starts from there');
    assert.ok(!existsSync(join(git(r.wt, 'rev-parse', '--absolute-git-dir'), 'land-branch')), 'nothing is left to recover');
    assert.equal(count(r.dir), 1, 'the check ran once');
    if (early === '1') {
      assert.match(res.stderr, /^land: smoke: the check failed on the rebased branch \(full log: .*\), before the line \(\d+ s\), so nothing landed/m);
      assert.doesNotMatch(res.stderr, /^queue: /m, 'it never got in line');
      assert.ok(!existsSync(join(state(r), 'land-queue', '.seq')), 'no ticket was issued');
    } else {
      assert.match(res.stderr, /^land: the check failed on the rebased branch \(full log: /m);
    }
  }
  assert.equal(tail(runs['1'].stderr), 'the check saw red');
  assert.equal(tail(runs['0'].stderr), 'the check saw red');
  assert.match(runs['1'].stderr, /the check saw red\nland: smoke: the check failed/);
  assert.match(runs['1'].stderr.trimEnd(), /\nship: refused \S+ batch 1 of 1 deploy none$/, 'a refusal before the line still ends on the ship line');
});

test('with main unmoved at the front, the commit the early check passed lands as it is, with what the check committed, and the check runs once', () => {
  // The check commits once, as Peek's regenerated test map does: the commit must ship, not be lost to a skipped rerun.
  const check = `${CHECK}; if [ ! -e made ]; then echo m >made; git add made; git commit -qm made-by-check; fi`;
  const r = setup(check, on(check));
  r.commit(r.main, 'm.txt', 'main moved before the hand-off\n');
  r.commit(r.wt, 'b.txt', 'b\n');
  const res = r.run({ COUNT: join(r.dir, 'count') });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /smoke: the check passed on the rebased branch/);
  assert.match(res.stderr, /the check passed on this same rebase before the line and main hasn't moved since, so it doesn't run again/);
  assert.equal(count(r.dir), 1);
  assert.deepEqual(git(r.main, 'log', '-3', '--format=%s', 'main').split('\n'), ['made-by-check', 'b.txt: b', 'm.txt: main moved before the hand-off']);
  assert.equal(git(r.origin, 'rev-parse', 'main'), git(r.main, 'rev-parse', 'main'));
});

test('when main moves after the early check, the check runs again on the new main before it lands', () => {
  // The early run moves main once (an empty commit, as another landing would), so the front sees a new main.
  const check = `${CHECK}; [ -e "$MOVED" ] || { touch "$MOVED"; git -C "$MAIN_DIR" commit -q --allow-empty -m moved; }`;
  const r = setup(check, on(check));
  r.commit(r.wt, 'b.txt', 'b\n');
  const res = r.run({ COUNT: join(r.dir, 'count'), MOVED: join(r.dir, 'moved'), MAIN_DIR: r.main });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /doesn't run again/);
  assert.equal(count(r.dir), 2, 'early, then again in line');
  assert.deepEqual(git(r.main, 'log', '-2', '--format=%s', 'main').split('\n'), ['b.txt: b', 'moved']);
});

test('a SMOKE_CMD that is the light check runs once, on the rebase; EARLY_CHECK=0, no CHECK_LIGHT and a fast land run no early check', () => {
  const same = setup(CHECK, { ...on(CHECK), SMOKE_CMD: CHECK });
  same.commit(same.wt, 'b.txt', 'b\n');
  const res = same.run({ COUNT: join(same.dir, 'count') });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(count(same.dir), 1);

  for (const config of [{ ...on(CHECK), EARLY_CHECK: '0' }, { EARLY_CHECK: '1' }]) {
    const off = setup(CHECK, config);
    off.commit(off.wt, 'b.txt', 'b\n');
    const o = off.run({ COUNT: join(off.dir, 'count') });
    assert.equal(o.status, 0, o.stderr);
    assert.doesNotMatch(o.stderr, /smoke: running/);
    assert.match(o.stderr, /^land: running /m, 'the check runs in line');
  }

  const fast = setup('false', { ...on('false'), SMOKE_CMD: 'true' });
  fast.commit(fast.wt, 'b.txt', 'b\n');
  const f = fast.run({ LAND_FAST: '1' });
  assert.equal(f.status, 0, f.stderr);
  assert.doesNotMatch(f.stderr, /smoke: running/);
});

test('an early red only on known reds goes on into the line and says so; a new failing file still refuses before it', () => {
  const red = (...files: string[]) => `printf "test at %s:3:1\\n" ${files.join(' ')}; exit 1`;
  const known = { LAND_KNOWN_RED: 'test/x.test.ts\t#41 is fixing it' };
  const k = setup(red('test/x.test.ts'), on(red('test/x.test.ts')));
  k.commit(k.wt, 'b.txt', 'b\n');
  const kr = k.run(known);
  assert.equal(kr.status, 0, kr.stderr);
  assert.match(kr.stderr, /smoke: the check failed only on known reds, so it goes on: test\/x\.test\.ts: known red, #41 is fixing it/);
  assert.doesNotMatch(kr.stderr, /smoke: passed/, 'an early red on known reds did not pass');
  assert.match(kr.stderr, /^land: the check failed only on known reds/m, 'it got in line and ran the check there');
  const n = setup(red('test/x.test.ts'), on(red('test/x.test.ts', 'test/y.test.ts')));
  n.commit(n.wt, 'b.txt', 'b\n');
  const nr = n.run(known);
  assert.equal(nr.status, 1, nr.stderr);
  assert.match(nr.stderr, /^land: smoke: the check failed on the rebased branch/m);
});

test('with lanes, a branch whose lane runs CHECK or CHECK_LIGHT runs CHECK_LIGHT early, and a lane with a check of its own runs none', () => {
  const local = `LANES=tools/lanes\nCHECK_LIGHT='echo light >>"$COUNT"; test ! -e docs/red'\nCHECK_ART=''\n`;
  const r = setup('echo full >>"$COUNT"', { EARLY_CHECK: '1' }, local);
  r.commit(r.main, 'tools/lanes', 'light docs/*\nart art/*\n');
  r.commit(r.main, 'docs/red', 'main broke the light check\n');
  r.commit(r.wt, 'docs/a.md', 'a\n');
  const res = r.run({ COUNT: join(r.dir, 'count') });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /smoke: running echo light/);
  assert.match(res.stderr, /^land: smoke: the check failed on the rebased branch/m);
  assert.equal(readFileSync(join(r.dir, 'count'), 'utf8'), 'light\n');

  // Full, and a lane with no CHECK_<LANE> (Peek's fast lane), whose check is CHECK.
  for (const file of ['src.txt', 'core/a.rs']) {
    const full = setup('echo full >>"$COUNT"', { EARLY_CHECK: '1' }, local);
    full.commit(full.main, 'tools/lanes', 'light docs/*\nart art/*\nfast core/*\n');
    full.commit(full.wt, file, 'a\n');
    const fr = full.run({ COUNT: join(full.dir, 'count') });
    assert.equal(fr.status, 0, fr.stderr);
    assert.equal(readFileSync(join(full.dir, 'count'), 'utf8'), 'light\nfull\n', `${file}: early light, then the full check in line`);
  }

  const art = setup('false', { EARLY_CHECK: '1' }, local);
  art.commit(art.main, 'tools/lanes', 'light docs/*\nart art/*\n');
  art.commit(art.wt, 'art/a.png', 'a\n');
  const ar = art.run({ COUNT: join(art.dir, 'count') });
  assert.equal(ar.status, 0, ar.stderr);
  assert.doesNotMatch(ar.stderr, /smoke: running/);
});

test('land_rebased runs before the early check too; with main unmoved at the front its commit lands as checked, and it is not run again', () => {
  const check = `${CHECK}; test -s rebased.txt`; // the check sees the hook's file: the hook ran first
  const r = setup(check, on(check), rebasedHook);
  r.commit(r.wt, 'b.txt', 'b\n');
  const base = git(r.main, 'rev-parse', 'main');
  const res = r.run({ COUNT: join(r.dir, 'count') });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /the check passed on this same rebase before the line/);
  assert.deepEqual(rebasedCalls(r.main), [`${base} ticket/1-x`], 'once, before the early check');
  assert.equal(count(r.dir), 1, 'the check ran once');
  assert.equal(git(r.main, 'log', '--format=%s', 'main', '-2'), `rebased on ${base}\nb.txt: b`);
});

// CO4 and DR6 (#1866): the early check's note of where the branch was named nobody, so a second run there took the first
// one's worktree from under its check, and a landing stopped mid-check left the worktree off its branch.
const held = 'touch "$GATE.on"; until [ -e "$GATE" ]; do sleep 0.05; done';
test('a land.sh run again during the early check touches nothing, and the first ships', async () => {
  for (const local of [undefined, rebasedHook]) {
    const q = queueSetup(1, held, on(held), undefined, local);
    const a = q.land(1);
    await until('the early check', () => existsSync(`${q.dir}/gate.on`));
    const at = git(q.wt, 'rev-parse', 'HEAD');
    const again = q.run();
    assert.equal(again.status, 1, again.stderr);
    assert.match(again.stderr, /a landing is still running in .* \(pid \d+\) and has its HEAD detached on purpose, so this touched nothing/);
    assert.equal(git(q.wt, 'rev-parse', 'HEAD'), at, 'the worktree is where the check runs');
    assert.equal(git(q.wt, 'branch', '--show-current'), '');
    q.open();
    assert.equal(await a.exit, 0, a.stderr());
  }
});

test('a landing stopped during the early check puts its worktree back on the branch as it was', async () => {
  const q = queueSetup(1, held, on(held));
  q.commit(q.main, 'm.txt', 'main moved\n');
  const was = git(q.wt, 'rev-parse', 'ticket/1-x');
  const a = q.land(1);
  await until('the early check', () => existsSync(`${q.dir}/gate.on`));
  a.child.kill('SIGTERM');
  q.open(); // the check's own processes outlive the stop until now
  await a.exit;
  assert.equal(git(q.wt, 'branch', '--show-current'), 'ticket/1-x');
  assert.equal(git(q.wt, 'rev-parse', 'HEAD'), was);
  assert.match(a.stderr(), /^ship: refused /m);
});
