// The scheme-setup template land.sh with a scheme's tools/land.local.sh (#602): the core is the kit's, byte for
// byte, and the scheme's settings and land_after hook live in the local file it sources. With no local file the
// core behaves as before: scheme-setup-land.test.ts and scheme-setup-land-ci.test.ts run without one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, setup, landLockFree } from './scheme-setup-land-fixture.ts';

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
  // And BRANCH: the clash refusal and the rest name the local file's branch, not "main".
  const m = setup('true', {}, 'BRANCH=trunk\n');
  git(m.main, 'branch', '-m', 'main', 'trunk');
  m.commit(m.wt, 'b.txt', 'mine\n');
  const ok = m.run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /trunk is now at/);
  assert.equal(git(m.origin, 'rev-parse', 'trunk'), git(m.wt, 'rev-parse', 'HEAD'));
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
