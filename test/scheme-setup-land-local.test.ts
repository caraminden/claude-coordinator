// The scheme-setup template land.sh with a scheme's tools/land.local.sh (#602): the core is the kit's, byte for
// byte, and the scheme's settings and land_after hook live in the local file it sources. With no local file the
// core behaves as before: scheme-setup-land.test.ts and scheme-setup-land-ci.test.ts run without one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, setup, landLockFree, rebasedHook, rebasedCalls } from './scheme-setup-land-fixture.ts';

// A land_after that records its arguments, whether the land lock was free, and how many places in line were left.
const recorder = `land_after() {
  local lock=free n
  flock -n "$LAND_GITDIR/land.lock" true || lock=held
  n=$(find "$LAND_GITDIR/land-queue" -maxdepth 1 -regex '.*/[0-9]+' 2>/dev/null | wc -l)
  echo "$1 $2 $lock $n" >>"$AFTER_LOG"
}
`;
const hooked = (local: string, ...rest: Parameters<typeof setup>) => {
  const r = setup(rest[0], rest[1], local);
  const log = join(r.dir, 'after.log');
  const extra = { LAND_GITDIR: git(r.main, 'rev-parse', '--absolute-git-dir'), AFTER_LOG: log };
  const after = () => { try { return readFileSync(log, 'utf8').trim().split('\n'); } catch { return []; } };
  return { ...r, run: (more: Record<string, string> = {}) => r.run({ ...extra, ...more }), after };
};

test("the local file's settings win over the core's defaults", () => {
  // The fixture puts a green check in the core; the local file's red one is what runs.
  const r = setup('true', {}, "CHECK='echo from-local; false'\n");
  r.commit(r.wt, 'b.txt', 'mine\n');
  const before = git(r.main, 'rev-parse', 'main');
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /running echo from-local; false/);
  assert.match(res.stderr, /the check failed on the rebased branch/);
  assert.equal(git(r.main, 'rev-parse', 'main'), before);
  // And BRANCH: the landing and the clash refusal name the local file's branch, not "main".
  const m = setup('true', {}, 'BRANCH=trunk\n');
  git(m.main, 'branch', '-m', 'main', 'trunk');
  m.commit(m.wt, 'b.txt', 'mine\n');
  const ok = m.run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /trunk is now at/);
  assert.equal(git(m.origin, 'rev-parse', 'trunk'), git(m.wt, 'rev-parse', 'HEAD'));
  m.commit(m.main, 'CLAUDE.md', '# R\n\n- **Numbered things:** files db/NNNN-*.sql\n');
  m.commit(m.main, 'db/0001-theirs.sql', 'x\n');
  m.commit(m.wt, 'db/0001-mine.sql', 'y\n');
  const clash = m.run();
  assert.equal(clash.status, 1, clash.stderr);
  assert.match(clash.stderr, /takes a number trunk already has .*Renumber yours past trunk's highest \(bump the version past trunk's\)/);
});

test('a land.local.sh that fails, or whose last line comes out false, stops the landing and says so; PUSH_MAIN is 0 or 1', () => {
  for (const local of ['false\nCHECK=true\n', '[ -n "${NOPE:-}" ] && CI_STACK=2\n']) {
    const r = setup('true', {}, local);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const before = git(r.main, 'rev-parse', 'main');
    const res = r.run();
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /land\.local\.sh failed \(exit 1\), so nothing ran/);
    assert.equal(git(r.main, 'rev-parse', 'main'), before);
  }
  const r = setup('true', {}, 'PUSH_MAIN=no\n');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const was = git(r.origin, 'rev-parse', 'main');
  const res = r.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /PUSH_MAIN is 1 \(push main\) or 0 \(keep it local\), not "no"/);
  assert.equal(git(r.origin, 'rev-parse', 'main'), was);
});

test('PUSH_MAIN=0 lands on main and pushes nothing, and land_after does not run', () => {
  const r = hooked(`PUSH_MAIN=0\n${recorder}`);
  const was = git(r.origin, 'rev-parse', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /PUSH_MAIN is 0, so main stays local/);
  assert.equal(git(r.main, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
  assert.equal(git(r.origin, 'rev-parse', 'main'), was, 'origin untouched');
  assert.deepEqual(r.after(), []);
});

test('land_after runs once after a pushed landing, with the lock and the place in line already free', () => {
  const r = hooked(recorder);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  assert.equal(git(r.origin, 'rev-parse', 'main'), tip);
  assert.deepEqual(r.after(), [`${tip} ticket/1-x free 0`]);
  assert.ok(res.stderr.indexOf('pushed main to origin') >= 0);
});

test('land_after does not run when the landing is refused or main moved but its push failed', () => {
  const red = hooked(recorder);
  red.commit(red.wt, 'red', 'x\n');
  assert.equal(red.run().status, 1);
  assert.deepEqual(red.after(), [], 'a red check');
  const r = hooked(recorder);
  git(r.main, 'remote', 'set-url', 'origin', join(r.dir, 'missing.git'));
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = r.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /push to origin failed/);
  assert.deepEqual(r.after(), [], 'a failed push');
});

test('a land_after that fails or exits is only warned about: the landing still exits 0', () => {
  for (const body of ['false', 'exit 7', 'echo "$nope"']) {
    const r = setup(undefined, {}, `land_after() { ${body}; }\n`);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const res = r.run();
    assert.equal(res.status, 0, `${body}: ${res.stderr}`);
    assert.match(res.stderr, /land\.local\.sh's land_after failed for ticket\/1-x \(exit [1-9]\d*\), which landed all the same/, body);
    assert.equal(git(r.origin, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
    assert.ok(landLockFree(r));
  }
});

test("a landing whose push failed has its land_after made up by the next landing that pushes (KT4, #1519)", () => {
  const r = hooked(recorder);
  const url = git(r.main, 'remote', 'get-url', 'origin');
  git(r.main, 'remote', 'set-url', 'origin', join(r.dir, 'missing.git'));
  r.commit(r.wt, 'b.txt', 'mine\n');
  const failed = r.run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /land_after didn't run, since main isn't on origin: the next landing that pushes it runs it/);
  const first = git(r.wt, 'rev-parse', 'HEAD');
  assert.deepEqual(r.after(), []);
  git(r.main, 'remote', 'set-url', 'origin', url);
  r.commit(r.wt, 'c.txt', 'more\n');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  const second = git(r.wt, 'rev-parse', 'HEAD');
  assert.deepEqual(r.after(), [`${first} ticket/1-x free 0`, `${second} ticket/1-x free 0`]);
  // Made up once: a third landing doesn't run it again.
  r.commit(r.wt, 'd.txt', 'again\n');
  assert.equal(r.run().status, 0);
  assert.equal(r.after().length, 3);
});

test("land_rebased runs on the branch rebased onto main, before the check, and the commit it makes ships with it", () => {
  // The check sees the hook's file: it runs after the hook.
  const r = setup('test -s rebased.txt', {}, rebasedHook);
  r.commit(r.main, 'm.txt', 'main moved\n');
  const base = git(r.main, 'rev-parse', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(rebasedCalls(r.main), [`${base} ticket/1-x`]);
  assert.equal(git(r.main, 'log', '--format=%s', 'main', '-3'), `rebased on ${base}\nb.txt: mine\nm.txt: main moved`);
  assert.equal(git(r.main, 'show', 'main:rebased.txt'), base);
  assert.equal(git(r.origin, 'rev-parse', 'main'), git(r.main, 'rev-parse', 'main'), 'what was pushed holds it');
  const tip = git(r.main, 'rev-parse', 'main').slice(0, 12);
  assert.equal(res.stderr.trimEnd().split('\n').pop(), `ship: landed ${tip} batch 1 of 1 deploy none`);
  assert.equal(git(r.wt, 'rev-parse', 'ticket/1-x'), git(r.main, 'rev-parse', 'main'), 'the branch sits on what shipped');
});

test('a land_rebased that fails, or leaves changes uncommitted, refuses the landing and main stays', () => {
  for (const body of ['false', 'echo x >>a.txt', 'echo x >new.txt']) {
    const r = setup('true', {}, `land_rebased() { ${body}; }\n`);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const before = git(r.main, 'rev-parse', 'main');
    const res = r.run();
    assert.equal(res.status, 1, `${body}: ${res.stderr}`);
    assert.match(res.stderr, { false: /land_rebased failed \(exit 1\)/, 'echo x >>a.txt': /land_rebased left changes it didn't commit/, 'echo x >new.txt': /land_rebased made files it didn't commit \(new\.txt\)/ }[body]!, body);
    assert.match(res.stderr, /land\.local\.sh's land_rebased failed on the rebased branch \(above\), so main is untouched/, body);
    assert.equal(git(r.main, 'rev-parse', 'main'), before, body);
    assert.equal(git(r.wt, 'status', '--porcelain', '--untracked-files=no'), '', `${body}: the worktree is left clean`);
    assert.equal(git(r.wt, 'branch', '--show-current'), 'ticket/1-x', body);
    assert.ok(landLockFree(r));
  }
});

test("land_deploy on a lone landing: its last word is the ship line's deploy state; a failed one takes main back and nothing is pushed", () => {
  for (const [body, word] of [['echo restart', 'restart'], ['echo "Deployed it."', 'done'], [':', 'done']]) {
    const r = setup('true', {}, `land_deploy() { echo "$1" >"$(git rev-parse --path-format=absolute --git-common-dir)/deployed"; ${body}; }\n`);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const res = r.run();
    assert.equal(res.status, 0, `${body}: ${res.stderr}`);
    const tip = git(r.main, 'rev-parse', 'main');
    assert.equal(readFileSync(join(git(r.main, 'rev-parse', '--absolute-git-dir'), 'deployed'), 'utf8').trim(), tip, body);
    assert.equal(res.stderr.trimEnd().split('\n').pop(), `ship: landed ${tip.slice(0, 12)} batch 1 of 1 deploy ${word}`, body);
    assert.equal(git(r.origin, 'rev-parse', 'main'), tip, body);
  }
  // A server the deploy leaves running doesn't keep the land lock.
  const bg = setup('true', {}, `land_deploy() { sleep 30 >/dev/null 2>&1 & echo $! >"$(git rev-parse --path-format=absolute --git-common-dir)/bg.pid"; }\n`);
  bg.commit(bg.wt, 'b.txt', 'mine\n');
  const bres = bg.run();
  const pid = Number(readFileSync(join(git(bg.main, 'rev-parse', '--absolute-git-dir'), 'bg.pid'), 'utf8'));
  try {
    assert.equal(bres.status, 0, bres.stderr);
    assert.ok(landLockFree(bg), 'the lock is free while what it started runs on');
  } finally {
    process.kill(pid);
  }
  const r = setup('true', {}, 'land_deploy() { false; echo live; }\n'); // set -e holds: the false is the failure
  r.commit(r.wt, 'b.txt', 'mine\n');
  const before = git(r.main, 'rev-parse', 'main');
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, new RegExp(`land_deploy failed \\(exit 1\\), so main went back to ${before.slice(0, 12)} and nothing shipped\\n`));
  assert.match(res.stderr.trimEnd().split('\n').pop()!, /^ship: refused [0-9a-f]{12} batch 1 of 1 deploy back$/);
  assert.equal(git(r.main, 'rev-parse', 'main'), before);
  assert.equal(git(r.origin, 'rev-parse', 'main'), before, 'never pushed');
  assert.equal(git(r.main, 'status', '--porcelain', '--untracked-files=no'), '', "main's checkout went back with it");
  assert.ok(landLockFree(r));
});
