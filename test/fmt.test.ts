// tools/fmt --own and the format check before the line (test/format-own.test.ts on tools/always-tests.txt, #1885), in
// throwaway repos: a ship that changed an unformatted file is refused by land.sh's real smoke check, Biome installed or not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { env, git, setup } from './land-fixture.ts';

const repo = join(import.meta.dirname, '..');
const biome = join(repo, 'node_modules/.bin/biome');
const skip = !existsSync(biome) && !process.env.CI ? 'Biome is not installed here (run `npm ci`)' : false;
const BAD = 'const  a = {b:1}\n';
const GOOD = 'const a = { b: 1 };\n';

/** A land fixture whose main has the formatter, the check and what citadel-test needs, and one unformatted file of main's own. */
function fmtRepo(installed = true) {
  const r = setup();
  for (const f of ['tools/fmt', 'tools/citadel-test', 'tools/citadel-test-reporter.ts', 'tools/citadel-node', 'tools/citadel-node.cjs', 'tools/mem-room', 'test/leak-guard.ts', 'test/leak-file.ts', 'test/format-own.test.ts', 'biome.json', 'package.json']) {
    mkdirSync(dirname(join(r.source, f)), { recursive: true });
    if (existsSync(join(repo, f))) cpSync(join(repo, f), join(r.source, f)); // a base without the check fails on what it lets through
  }
  // Only the format check of the real list; whether the list has it is asserted below.
  const listed = readFileSync(join(repo, 'tools/always-tests.txt'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('format'));
  writeFileSync(join(r.source, 'tools/always-tests.txt'), `${listed.filter((l) => !l.startsWith('#')).join('\n')}\n`);
  writeFileSync(join(r.source, '.gitignore'), 'node_modules\n');
  writeFileSync(join(r.source, 'main-own.ts'), BAD);
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'formatter');
  git(r.wt, 'rebase', '-q', 'main');
  // npx as a stand-in, so no test goes to the network: the pinned Biome, or a fetch that fails.
  const bin = join(r.dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash\n[ -z "\${NPX_FAILS:-}" ] || { echo "npm error network" >&2; exit 1; }\necho "$2" >>'${join(r.dir, 'npx-ran')}'\nshift 2; exec '${biome}' "$@"\n`);
  chmodSync(join(bin, 'npx'), 0o755);
  if (installed) {
    mkdirSync(join(r.wt, 'node_modules/.bin'), { recursive: true });
    symlinkSync(biome, join(r.wt, 'node_modules/.bin/biome'));
  }
  const own = { CI: '', CITADEL_TEST_EXTRA: '0', PATH: `${bin}:${process.env.PATH}`, TMPDIR: r.dir };
  const e = (extra: Record<string, string> = {}) => ({ ...env, ...own, ...extra });
  const fmt = (args: string[], extra: Record<string, string> = {}) => {
    const x = spawnSync(join(r.wt, 'tools/fmt'), args, { cwd: r.wt, encoding: 'utf8', env: e(extra) });
    return { code: x.status, out: x.stdout + x.stderr };
  };
  const land = (extra: Record<string, string> = {}) => r.run({ ...own, ...extra });
  const citadelTest = (extra: Record<string, string> = {}) => {
    const x = spawnSync(join(r.wt, 'tools/citadel-test'), ['test/ok.test.mjs'], { cwd: r.wt, encoding: 'utf8', env: e(extra) });
    return { code: x.status, out: x.stdout + x.stderr };
  };
  const npxRan = () => existsSync(join(r.dir, 'npx-ran'));
  return { ...r, fmt, land, citadelTest, npxRan };
}

for (const installed of [true, false])
  test(`a ship with an unformatted file of its own is refused before the line, and citadel-test shows it, ${installed ? 'Biome installed' : 'no Biome in the worktree'}`, { skip }, () => {
    const r = fmtRepo(installed);
    r.commit(r.wt, 'new.ts', BAD);
    const t = r.citadelTest();
    assert.equal(t.code, 1, t.out);
    assert.match(t.out, /format-own\.test\.ts.*every \.ts, \.js and \.mjs file this branch changed is formatted/);
    const before = git(r.source, 'rev-parse', 'main');
    const res = r.land();
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /land: smoke: .*tools\/fmt --own && git add -u && git commit/);
    assert.match(res.stderr, /smoke: tests failed \(exit 1\), before the line/);
    assert.match(res.stderr, /new\.ts/);
    assert.doesNotMatch(res.stderr, /main-own\.ts/, "main's own file is not this ship's");
    assert.equal(git(r.source, 'rev-parse', 'main'), before);
    assert.equal(r.npxRan(), !installed);
    // The fix it names.
    assert.equal(r.fmt(['--own']).code, 0);
    assert.equal(readFileSync(join(r.wt, 'new.ts'), 'utf8'), GOOD);
    assert.equal(readFileSync(join(r.wt, 'main-own.ts'), 'utf8'), BAD, 'a file the branch did not change is left as it is');
    git(r.wt, 'commit', '-qam', 'format');
    writeFileSync(join(r.wt, 'scratch.ts'), BAD); // untracked: not in the ship
    const ok = r.land();
    assert.equal(ok.status, 0, ok.stderr);
  });

test('with no Biome and no way to fetch it, the check fails saying nothing was checked', { skip }, () => {
  const r = fmtRepo(false);
  assert.equal(r.fmt(['--check', '--own'], { NPX_FAILS: '1' }).code, 0, 'a branch with no file to check needs no Biome');
  r.commit(r.wt, 'new.ts', GOOD);
  const x = r.fmt(['--check', '--own'], { NPX_FAILS: '1' });
  assert.equal(x.code, 3, x.out);
  assert.match(x.out, /format of 1 changed files was NOT checked\. Run npm ci/);
  const t = r.citadelTest({ NPX_FAILS: '1' });
  assert.equal(t.code, 1, t.out);
  assert.match(t.out, /NOT checked/);
});

test('--own takes committed, uncommitted and new files, skips excluded, deleted and other ones, and checks no untracked one', { skip }, () => {
  const r = fmtRepo();
  const own = () => r.fmt(['--check', '--own']);
  r.commit(r.wt, 'notes.md', '# x\n');
  assert.equal(own().code, 0);
  mkdirSync(join(r.wt, 'test/fixtures'));
  r.commit(r.wt, 'test/fixtures/x.ts', BAD);
  assert.equal(own().code, 0, 'a path biome.json leaves out');
  writeFileSync(join(r.wt, 'new file.mjs'), BAD);
  assert.equal(own().code, 0, 'untracked: not in the ship');
  git(r.wt, 'add', '-A');
  assert.equal(own().code, 1, 'staged, its name with a space');
  git(r.wt, 'rm', '-qf', 'new file.mjs');
  git(r.wt, 'rm', '-q', 'main-own.ts');
  git(r.wt, 'commit', '-qm', 'gone');
  assert.equal(own().code, 0, 'deleted files');
});

test("--own leaves a build's other feeders' files alone", { skip }, () => {
  const r = fmtRepo();
  r.commit(r.wt, 'other-feeder.ts', BAD);
  git(r.source, 'branch', 'build/7', 'ticket/1-x');
  r.commit(r.wt, 'mine.ts', GOOD);
  assert.equal(r.fmt(['--check', '--own']).code, 0);
  r.commit(r.wt, 'mine2.ts', BAD);
  const x = r.fmt(['--check', '--own']);
  assert.equal(x.code, 1);
  assert.match(x.out, /mine2\.ts/);
  assert.doesNotMatch(x.out, /other-feeder/);
  // At the build's tip a feeder still answers for its own edits alone, an untracked file included.
  git(r.source, 'branch', '-f', 'build/7', 'ticket/1-x');
  writeFileSync(join(r.wt, 'new.ts'), BAD);
  assert.equal(r.fmt(['--check', '--own']).code, 0);
  assert.equal(r.fmt(['--own']).code, 0);
  assert.equal(readFileSync(join(r.wt, 'new.ts'), 'utf8'), GOOD);
  assert.equal(git(r.wt, 'diff', '--name-only'), '', "no other feeder's file was touched");
});

test("a build's own ship is refused for any unformatted file the build brings to main", { skip }, () => {
  const r = fmtRepo();
  r.commit(r.wt, 'feeder.ts', BAD);
  git(r.source, 'branch', 'build/7', 'ticket/1-x');
  const res = r.run({ CI: '', CITADEL_TEST_EXTRA: '0', TMPDIR: r.dir }, ['--build']);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /land: smoke: .*FMT_WHOLE_BUILD=1 tools\/fmt --own/);
  assert.match(res.stderr, /feeder\.ts/);
  assert.doesNotMatch(res.stderr, /main-own\.ts/);
  assert.equal(r.fmt(['--own'], { FMT_WHOLE_BUILD: '1' }).code, 0);
  assert.equal(readFileSync(join(r.wt, 'feeder.ts'), 'utf8'), GOOD);
});

test('the format check leaves no skipped test on CI, which refuses a run with one (tests.yml), and still runs elsewhere', () => {
  const run = (CI: string) => spawnSync(process.execPath, ['--test', '--test-reporter=spec', 'test/format-own.test.ts'], { cwd: repo, encoding: 'utf8', env: { ...env, NODE_TEST_CONTEXT: undefined, CI } }).stdout;
  const ci = run('true');
  assert.match(ci, /^ℹ skipped 0$/m);
  assert.match(ci, /^ℹ fail 0$/m);
  assert.doesNotMatch(ci, /this branch changed is formatted/, 'test/format.test.ts checks every file there');
  assert.match(run(''), /this branch changed is formatted/);
});
