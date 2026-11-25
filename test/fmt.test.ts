// tools/fmt --own, the format check before the line (test/format-own.test.ts on tools/always-tests.txt, #1885) and land.sh's
// format_ship (tools/ship-format.sh), in throwaway repos: a ship's unformatted files go out formatted, Biome installed or
// not, no other file changes, and where Biome can't do it the check refuses the ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { env, git, setup } from './land-fixture.ts';
import { line, shared } from './land-train-fixture.ts';
import { until } from './wait.ts';

const repo = join(import.meta.dirname, '..');
const biome = join(repo, 'node_modules/.bin/biome');
const skip = !existsSync(biome) && !process.env.CI ? 'Biome is not installed here (run `npm ci`)' : false;
const BAD = 'const  a = {b:1}\n';
const GOOD = 'const a = { b: 1 };\n';
const subjects = (r: ReturnType<typeof setup>, ref: string) => git(r.source, 'log', '--reverse', '--format=%s', ref).split('\n');

/** Puts the formatter, the check and what citadel-test needs on the fixture's main, with one unformatted file of main's own. */
function install(r: ReturnType<typeof setup>) {
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
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash\n[ -z "\${NPX_FAILS:-}" ] || { echo "npm error network" >&2; exit 1; }\n[ -z "\${NPX_HANGS:-}" ] || [ "$4" != --write ] || exec sleep 60\necho "$2" >>'${join(r.dir, 'npx-ran')}'\nshift 2; exec '${biome}' "$@"\n`);
  chmodSync(join(bin, 'npx'), 0o755);
  return bin;
}

function fmtRepo(installed = true) {
  const r = setup();
  const bin = install(r);
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
  const land = (extra: Record<string, string> = {}, args: string[] = [], cwd = r.wt) => r.run({ ...own, ...extra }, args, cwd);
  const citadelTest = (extra: Record<string, string> = {}) => {
    const x = spawnSync(join(r.wt, 'tools/citadel-test'), ['test/ok.test.mjs'], { cwd: r.wt, encoding: 'utf8', env: e(extra) });
    return { code: x.status, out: x.stdout + x.stderr };
  };
  const npxRan = () => existsSync(join(r.dir, 'npx-ran'));
  return { ...r, e, fmt, land, citadelTest, npxRan };
}

for (const installed of [true, false])
  test(`a ship with an unformatted file of its own ships formatted and no other file changes, and citadel-test shows it, ${installed ? 'Biome installed' : 'no Biome in the worktree'}`, { skip }, () => {
    const r = fmtRepo(installed);
    r.commit(r.wt, 'new.ts', BAD);
    const t = r.citadelTest();
    assert.equal(t.code, 1, t.out);
    assert.match(t.out, /format-own\.test\.ts.*every \.ts, \.js and \.mjs file this branch changed is formatted/);
    writeFileSync(join(r.wt, 'scratch.ts'), BAD); // untracked: not in the ship
    const res = r.land();
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /^land: format: formatted 1 of this ship's files in [0-9a-f]{7,} \(new\.ts\)$/m);
    assert.ok(res.stderr.indexOf('land: format:') < res.stderr.indexOf('land: smoke:'), 'before the smoke check, so that, the line and CI see the formatted commit');
    assert.deepEqual(subjects(r, 'main'), ['base', 'formatter', 'new.ts: const  a = {b:1}', 'formatted at ship time']);
    assert.equal(git(r.source, 'diff', '--name-only', 'main^', 'main'), 'new.ts');
    assert.equal(git(r.source, 'show', 'main:new.ts'), GOOD.trim());
    assert.equal(git(r.source, 'show', 'main:main-own.ts'), BAD.trim(), 'a file the branch did not change is left as it is');
    assert.equal(readFileSync(join(r.wt, 'scratch.ts'), 'utf8'), BAD, 'an untracked file is left as it is');
    assert.equal(git(r.wt, 'status', '--porcelain'), '?? scratch.ts');
    assert.equal(r.npxRan(), !installed);
    // Formatted already: no second commit, and nothing said.
    writeFileSync(join(r.wt, 'next.ts'), GOOD);
    git(r.wt, 'add', 'next.ts');
    git(r.wt, 'commit', '-qm', 'next');
    const ok = r.land();
    assert.equal(ok.status, 0, ok.stderr);
    assert.doesNotMatch(ok.stderr, /format:/);
    assert.equal(subjects(r, 'main').at(-1), 'next');
  });

test('the fix the check names formats the files the branch changed', { skip }, () => {
  const r = fmtRepo();
  r.commit(r.wt, 'new.ts', BAD);
  const x = r.fmt(['--check', '--own']);
  assert.equal(x.code, 1);
  assert.match(x.out, /tools\/fmt --own && git add -u && git commit/);
  assert.doesNotMatch(x.out, /main-own\.ts/, "main's own file is not this ship's");
  assert.equal(r.fmt(['--own']).code, 0);
  assert.equal(readFileSync(join(r.wt, 'new.ts'), 'utf8'), GOOD);
  assert.equal(readFileSync(join(r.wt, 'main-own.ts'), 'utf8'), BAD);
});

// When Biome can't do it, the ship goes on as it was and the check decides.
for (const [what, text, extra, said] of [
  ["can't run", BAD, { NPX_FAILS: '1' }, /^land: format: Biome could not run here.*the ship goes on as it is/m],
  ["can't parse a file", 'const = ;\n', {}, /^land: format: Biome could not format every file.*the ship goes on as it is/m],
  ['hangs', BAD, { NPX_HANGS: '1', FMT_TIMEOUT: '1' }, /^land: format: Biome could not format every file.*the ship goes on as it is/m],
] as const)
  test(`a ship goes on unformatted when Biome ${what}, and the check decides`, { skip }, () => {
    const r = fmtRepo(false);
    r.commit(r.wt, 'ok.ts', BAD);
    r.commit(r.wt, 'new.ts', text);
    const head = git(r.wt, 'rev-parse', 'HEAD');
    const res = r.land(extra);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, said);
    assert.match(res.stderr, /smoke: tests failed \(exit 1\), before the line/);
    assert.equal(git(r.wt, 'rev-parse', 'HEAD'), head, 'no commit');
    assert.equal(git(r.wt, 'status', '--porcelain'), '', 'nothing half formatted is left in the worktree');
  });

test('a test the formatting breaks (a pinned hash, a size budget) refuses the ship before the line, saying it was formatted', { skip }, () => {
  const r = fmtRepo();
  r.commit(r.source, 'test/size-budget.test.ts', "import { test } from 'node:test';\nimport { readFileSync } from 'node:fs';\ntest('pinned', () => {\n  if (/b: 1/.test(readFileSync('pin.ts', 'utf8'))) throw new Error('pin.ts moved');\n});\n");
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'pin.ts', BAD);
  const res = r.land();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /pin\.ts moved/);
  assert.match(res.stderr, /smoke: tests failed.*before the line.*run this again\. tools\/land\.sh formatted 1 of this ship's files in [0-9a-f]{7,} \(pin\.ts\)/);
  // Handed off again, with nothing left to format: the same.
  const again = r.land();
  assert.equal(again.status, 1, again.stderr);
  assert.match(again.stderr, /pin\.ts moved/);
});

test("main moved, land.sh with it: the format commit is rebased, and the rebased copy doesn't format again", { skip }, () => {
  const r = fmtRepo();
  for (const f of ['land.sh', 'deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'suite-runner.ts', 'citadel-heavy', 'ship-format.sh']) cpSync(join(repo, 'tools', f), join(r.source, 'tools', f));
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'real land.sh');
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'new.ts', BAD);
  const script = join(r.source, 'tools/land.sh');
  writeFileSync(script, readFileSync(script, 'utf8').replace('say "running the tests"', 'say "running the tests (the rebased land.sh)"'));
  git(r.source, 'commit', '-qam', 'newer land.sh');
  const res = spawnSync('bash', [join(r.wt, 'tools/land.sh')], { cwd: r.wt, encoding: 'utf8', timeout: 90_000, env: r.e({ DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note') }) });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /the rebased land\.sh/);
  assert.equal(res.stderr.match(/^land: format:/gm)?.length, 1, res.stderr);
  assert.deepEqual(subjects(r, 'main').slice(-3), ['newer land.sh', 'new.ts: const  a = {b:1}', 'formatted at ship time']);
});

test("a ship train takes its riders' formatted commits", { skip }, async () => {
  const e: Record<string, string> = { CI: '', CITADEL_TEST_EXTRA: '0' };
  const l = await line([{}, {}, { change: ['new.ts', BAD] }], e, (r) => {
    install(r);
    e.TMPDIR = r.dir; // where citadel-test leaves its log
  });
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[2].stderr, /^land: format: formatted 1 of this ship's files/m);
  assert.match(done[2].stderr, /^land: shipped in ticket\/2-x's ship train of 2 ships/m);
  assert.deepEqual(subjects(l.r, 'main').slice(-4), ['f1.txt: 1', 'f2.txt: 2', 'new.ts: const  a = {b:1}', 'formatted at ship time']);
  assert.equal(git(l.r.source, 'show', 'main:new.ts'), GOOD.trim());
  l.done();
});

test("the early next train is the one that ships when its front's files were formatted", { skip }, async () => {
  const e: Record<string, string> = { CI: '', CITADEL_TEST_EXTRA: '0', LAND_TRAIN_MAX: '1' };
  const held = { FAKE_CI_GATE: '' };
  const l = await line([{}, { env: held }, {}, { change: ['new.ts', BAD] }], e, (r) => {
    install(r);
    Object.assign(e, shared(r.dir), { TMPDIR: r.dir });
    held.FAKE_CI_GATE = join(r.dir, 'ci-go');
  });
  const all = l.go();
  await until("the early push beside ship 2's run", () => /its CI starts now/.test(l.out[1]));
  writeFileSync(held.FAKE_CI_GATE, '');
  const done = await all;
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  const top = /while this one's CI runs \(([0-9a-f]{7,})\)/.exec(done[1].stderr)![1];
  assert.match(done[3].stderr, /^land: early next train: CI started on this train at .* so that run is its CI/m);
  assert.equal(git(l.r.source, 'rev-parse', 'main').slice(0, 7), top.slice(0, 7));
  assert.equal(subjects(l.r, 'main').at(-1), 'formatted at ship time');
  assert.equal(git(l.r.source, 'show', 'main:new.ts'), GOOD.trim());
  l.done();
});

test("a ship's own check runs on its formatted commit, and that run is its CI in line", { skip }, async () => {
  const e: Record<string, string> = { CI: '', CITADEL_TEST_EXTRA: '0', FAKE_CHECK_RUNNERS: '1', LAND_OWN_CHECK_POLL: '0.05' };
  const l = await line([{}, { change: ['new.ts', BAD] }], e, (r) => {
    install(r);
    Object.assign(e, shared(r.dir), { TMPDIR: r.dir });
  });
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /^land: own check: green in \d+ s .* so it joins the line/m);
  assert.equal(l.runs(), 2, "ship 1's run and ship 2's check, which was its CI in line too");
  assert.equal(subjects(l.r, 'main').at(-1), 'formatted at ship time');
  l.done();
});

test("a merge into a build formats the feeder's own files, never another feeder's", { skip }, () => {
  const r = fmtRepo();
  r.commit(r.wt, 'other-feeder.ts', BAD);
  git(r.source, 'branch', 'build/7', 'ticket/1-x');
  r.commit(r.wt, 'mine.ts', BAD);
  git(r.wt, 'commit', '-q', '--amend', '-m', '#1 mine');
  const res = r.land({}, ['--into', 'build/7', 'test/ok.test.mjs']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /^land: format: formatted 1 of this ship's files in [0-9a-f]{7,} \(mine\.ts\)$/m);
  assert.equal(git(r.source, 'diff', '--name-only', 'build/7^', 'build/7'), 'mine.ts');
  assert.equal(subjects(r, 'build/7').at(-1), '#1: formatted at ship time', 'titled like the branch, which commit-titles.sh holds it to');
  assert.equal(git(r.source, 'show', 'build/7:mine.ts'), GOOD.trim());
});

test("a feeder's format commit that would reach lines another feeder merged into a shared file is left out, and the merge goes on", { skip }, () => {
  const r = fmtRepo();
  writeFileSync(join(r.wt, 'build-claims.md'), '# Build 7\nbuild: #9\nshared: hub.ts\n');
  r.commit(r.wt, 'hub.ts', '');
  git(r.source, 'branch', 'build/7', 'ticket/1-x');
  git(r.wt, 'commit', '-q', '--amend', '-m', '#9 claims');
  git(r.source, 'branch', '-f', 'build/7', 'ticket/1-x');
  r.commit(r.wt, 'hub.ts', BAD);
  git(r.wt, 'commit', '-q', '--amend', '-m', '#2 hub');
  git(r.source, 'branch', '-f', 'build/7', 'ticket/1-x');
  r.commit(r.wt, 'hub.ts', `${BAD}const b = 2;\n`);
  const head = git(r.wt, 'rev-parse', 'HEAD');
  const res = r.land({}, ['--into', 'build/7', 'test/ok.test.mjs']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /^land: format: left as it is: formatting this ship's files would change lines another feeder merged in/m);
  assert.equal(git(r.source, 'rev-parse', 'build/7'), head);
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
});

test("a build's full run formats every file the build adds, so its own ship passes the check and adds no commit", { skip }, () => {
  const r = fmtRepo();
  r.commit(r.wt, 'feeder.ts', BAD);
  git(r.source, 'branch', 'build/7', 'ticket/1-x');
  git(r.wt, 'checkout', '-qb', 'ticket/9-build');
  const e = { CITADEL_TEST_EXTRA: '0' };
  const full = r.land(e, ['--into', 'build/7', '--full']);
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stderr, /^land: format: formatted 1 of this ship's files in [0-9a-f]{7,} \(feeder\.ts\)$/m);
  assert.equal(git(r.source, 'show', 'build/7:feeder.ts'), GOOD.trim());
  assert.equal(git(r.source, 'show', 'build/7:main-own.ts'), BAD.trim());
  const head = git(r.wt, 'rev-parse', 'HEAD');
  const res = r.land(e, ['--build']);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /format:/);
  assert.equal(git(r.source, 'rev-parse', 'main'), head);
});

test('the hand-off check (--check) formats nothing', { skip }, () => {
  const r = fmtRepo();
  r.commit(r.wt, 'new.ts', BAD);
  const head = git(r.wt, 'rev-parse', 'HEAD');
  assert.equal(r.land({}, ['--check']).status, 0);
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), head);
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
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
