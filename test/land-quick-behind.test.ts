// The full run behind a quick train, land.sh's side (#2244, tools/land/behind.sh): the quick-behind line a quick train
// owes, cleared by the next full train's green run or marked with its red, and `tools/land.sh --verify`, which
// src/fast-mode.ts's quick scheme runs (test/fast-mode-quick.test.ts). The gap train's own tests check the line is
// written by a real quick ship and never with it off (test/land-quick-train*.test.ts).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, git, setup } from './land-fixture.ts';

const behind = join(import.meta.dirname, '..', 'tools', 'land', 'behind.sh');

/** A detached worktree of the fixture's repo at main, as fast mode's kept one is. */
const detached = (r: ReturnType<typeof setup>) => {
  const wt = join(r.dir, 'verify-wt');
  git(r.source, 'worktree', 'add', '-q', '--detach', wt, 'main');
  return wt;
};
const verdict = (stdout: string) => stdout.split('\n').filter((l) => l.startsWith('verify: '));

test('--verify runs the full suite on CI on HEAD: real failures are named, files that passed alone are not, and its scratch branches go', () => {
  const r = setup();
  const c = ci(r);
  const wt = detached(r);
  const res = c.run({ FAKE_CI: 'red', FAKE_LOG: 'mixed', LAND_VERIFY_BASE: git(r.source, 'rev-parse', 'main') }, ['--verify'], wt);
  assert.equal(res.status, 1, res.stderr);
  assert.deepEqual(verdict(res.stdout), ['verify: failing test/real.test.ts', 'verify: red']);
  assert.match(res.stderr, /failed in the full run and passed alone: no culprit/);
  assert.match(c.calls(), new RegExp(`head_sha=${git(r.source, 'rev-parse', 'main')}`));
  assert.doesNotMatch(c.refs(), /behind/, 'land/behind and land-base/behind are gone');
  // Passed-alone files with the leak guard's line, or a skipped test: red of their own, naming no file ("CI").
  for (const extra of [{ FAKE_LEAK: '1' }, { FAKE_SKIP: '1' }] as Record<string, string>[]) {
    const mixed = c.run({ FAKE_CI: 'red', FAKE_LOG: 'flakes', ...extra }, ['--verify'], wt);
    assert.equal(mixed.status, 1, mixed.stderr);
    assert.deepEqual(verdict(mixed.stdout), ['verify: failing CI', 'verify: red'], JSON.stringify(extra));
  }
  const green = c.run({ FAKE_CI: 'green' }, ['--verify'], wt);
  assert.equal(green.status, 0, green.stderr);
  assert.deepEqual(verdict(green.stdout), ['verify: green']);
  const none = c.run({ LAND_CI: '0' }, ['--verify'], wt);
  assert.equal(none.status, 75, none.stderr);
  assert.deepEqual(verdict(none.stdout), ['verify: no verdict']);
  const queue = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'queue');
  assert.deepEqual(existsSync(queue) ? readdirSync(queue).filter((f) => /^\d+$/.test(f)) : [], [], 'it never joined the line');
});

test('--verify with LAND_VERIFY_IDS runs each file alone here, and only one that fails twice is red', () => {
  const r = setup();
  const flip = join(r.dir, 'flip-count');
  writeFileSync(join(r.wt, 'test', 'bad.test.mjs'), "throw new Error('bad');\n");
  // Fails on its first run only: a flake run alone.
  // Hits its time limit (node's words for it) each run: no answer, never a culprit (#1430).
  writeFileSync(join(r.wt, 'test', 'slow.test.mjs'), "console.log('test timed out after 60000ms');\nprocess.exit(1);\n");
  writeFileSync(join(r.wt, 'test', 'flip.test.mjs'), `import { existsSync, writeFileSync } from 'node:fs';\nif (!existsSync(${JSON.stringify(flip)})) { writeFileSync(${JSON.stringify(flip)}, '1'); throw new Error('once'); }\n`);
  git(r.wt, 'add', '-A');
  git(r.wt, 'commit', '-qm', 'tests');
  git(r.source, 'merge', '-q', '--ff-only', 'ticket/1-x');
  const wt = detached(r);
  const res = r.run({ LAND_VERIFY_IDS: 'test/bad.test.mjs\ntest/flip.test.mjs\ntest/ok.test.mjs' }, ['--verify'], wt);
  assert.equal(res.status, 1, res.stderr);
  assert.deepEqual(verdict(res.stdout), ['verify: failing test/bad.test.mjs', 'verify: red']);
  assert.match(res.stderr, /test\/flip\.test\.mjs failed alone on \w+ once and then passed: no culprit/);
  const slow = r.run({ LAND_VERIFY_IDS: 'test/slow.test.mjs' }, ['--verify'], wt);
  assert.equal(slow.status, 1, slow.stderr);
  assert.deepEqual(verdict(slow.stdout), ['verify: failing the check', 'verify: red'], 'no culprit: the check gave no answer');
  const ok = r.run({ LAND_VERIFY_IDS: 'test/ok.test.mjs' }, ['--verify'], wt);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(verdict(ok.stdout), ['verify: green']);
});

/** behind.sh's functions run alone in bash on a repo: $state, $old, $tip, $own and the train's arrays set as land.sh sets them. */
function sh(r: ReturnType<typeof setup>, state: string, script: string, vars: Record<string, string>) {
  const res = spawnSync('bash', ['-c', `set -euo pipefail; say() { echo "land: $*" >&2; }; retro_log() { :; }; declare -A through_by=(); train_n=(); train_br=(); train_tip=(); . "${behind}"; ${script}`], { cwd: r.source, encoding: 'utf8', env: { ...process.env, state, SOURCE: r.source, ...vars } });
  assert.equal(res.status, 0, res.stderr);
  return res;
}

test("the line a quick train owes: its base, top and each ship's top with its #N; a green full ship over it clears it, a red on main's tip at its top marks it", () => {
  const r = setup();
  const state = join(r.dir, 'state');
  mkdirSync(state);
  const base = git(r.source, 'rev-parse', 'main');
  r.commit(r.wt, 'q1.txt', '1\n');
  const front = git(r.wt, 'rev-parse', 'HEAD');
  r.commit(r.wt, 'q2.txt', '2\n');
  const top = git(r.wt, 'rev-parse', 'HEAD');
  git(r.source, 'merge', '-q', '--ff-only', 'ticket/1-x');
  sh(r, state, 'branch=ticket/51-x old=$B tip=$T own=$O train_n=(1); train_br=(ticket/52-y); train_tip=($T); behind_mark', { B: base, T: top, O: front });
  const line = readFileSync(join(state, 'quick-behind'), 'utf8').trim();
  assert.match(line, new RegExp(`^\\d+ ${base} ${top} ${front}:51 ${top}:52$`));
  // A full train's run red on a file that fails alone on main's tip, the quick top: marked once.
  const red = sh(r, state, 'old=$T branch=ticket/60-z; behind_red test/a.test.ts test/b.test.ts; behind_red test/c.test.ts', { T: top });
  assert.match(red.stderr, /test\/a\.test\.ts, test\/b\.test\.ts fails on \w+, the quick train's top/);
  assert.match(readFileSync(join(state, 'quick-behind'), 'utf8'), / red=test\/a\.test\.ts,test\/b\.test\.ts\n$/);
  // A known flake is screened out: all of them flakes, nothing is marked.
  r.commit(r.wt, 'q3.txt', '3\n');
  const top2 = git(r.wt, 'rev-parse', 'HEAD');
  sh(r, state, 'branch=ticket/53-x old=$B tip=$T own=$T; behind_mark', { B: top, T: top2 });
  const flaky = sh(r, state, 'known_flakes() { [ "$1" = test/f.test.ts ] && known_why=seen; }; old=$T branch=ticket/60-z; behind_red test/f.test.ts', { T: top2 });
  assert.match(flaky.stderr, /test\/f\.test\.ts is a known flake \(seen\): no culprit/);
  assert.equal(readFileSync(join(state, 'quick-behind'), 'utf8').split('\n')[1].includes('red='), false);
  sh(r, state, 'known_flakes() { [ "$1" = test/f.test.ts ] && known_why=seen; }; old=$T branch=ticket/60-z; behind_red test/f.test.ts test/g.test.ts', { T: top2 });
  assert.match(readFileSync(join(state, 'quick-behind'), 'utf8').split('\n')[1], / red=test\/g\.test\.ts$/);
  // Shipped through main's red: the line stays for the server's pin.
  sh(r, state, 'tip=$T; through_by[$T]=test/a.test.ts; behind_landed', { T: top });
  assert.ok(existsSync(join(state, 'quick-behind')));
  // Shipped green over it: the full train's own run counted.
  r.commit(r.wt, 'f.txt', 'full\n');
  git(r.source, 'merge', '-q', '--ff-only', 'ticket/1-x');
  sh(r, state, 'tip=$T; behind_landed', { T: git(r.source, 'rev-parse', 'main') });
  assert.ok(!existsSync(join(state, 'quick-behind')), 'cleared');
  // A red on main's tip with no quick train owed: nothing is written.
  sh(r, state, 'old=$T branch=ticket/60-z; behind_red test/a.test.ts; tip=$T; behind_landed', { T: top });
  assert.ok(!existsSync(join(state, 'quick-behind')));
});
