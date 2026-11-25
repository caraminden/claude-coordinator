// tools/test-deps.sh (the packages a suite's checkout hasn't got) and tools/test-alone.sh (one test file alone, as a
// verdict or as no answer), #1863: a fake npm on PATH writes what the lockfile names.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEP, depsRepo, env, git, root } from './land-fixture.ts';

const tool = (name: string) => join(import.meta.dirname, '..', 'tools', name);

function repo() {
  const dir = mkdtempSync(join(root, 'deps-'));
  const source = join(dir, 'repo');
  mkdirSync(join(source, 'test'), { recursive: true });
  git(source, 'init', '-q', '-b', 'main');
  const { npmBin, npmRuns } = depsRepo(dir, source);
  writeFileSync(join(source, 'test', 'uses.test.ts'), `import '${DEP}';\n`);
  const commit = () => {
    git(source, 'add', '-A');
    git(source, 'commit', '-qm', 'x');
    return git(source, 'rev-parse', 'HEAD');
  };
  commit();
  const worktree = (name: string) => {
    git(source, 'worktree', 'add', '-q', '--detach', join(dir, name));
    return join(dir, name);
  };
  const sh = (name: string, args: string[], extra: Record<string, string> = {}, cwd = source) => spawnSync('bash', [tool(name), ...args], { cwd, encoding: 'utf8', timeout: 60_000, env: { ...env, PATH: `${npmBin}:${process.env.PATH}`, ...extra } });
  return { dir, source, commit, worktree, sh, npmRuns };
}

test('a checkout with no packages gets a link to one store per lockfile, installed once and out of git status', () => {
  const r = repo();
  const [a, b] = [r.worktree('a'), r.worktree('b')];
  let res = r.sh('test-deps.sh', [a]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'linked\n');
  assert.equal(JSON.parse(readFileSync(join(a, 'node_modules', DEP, 'package.json'), 'utf8')).version, '1.0.0');
  assert.equal(git(a, 'status', '--porcelain'), '', 'the link is ignored');
  res = r.sh('test-deps.sh', [b]);
  assert.equal(res.stdout, 'linked\n');
  assert.equal(r.npmRuns().length, 1, r.npmRuns().join('\n'));
  assert.match(r.npmRuns()[0], /ci --ignore-scripts /, "a package's own scripts never run");
  res = r.sh('test-deps.sh', [a]);
  assert.deepEqual([res.status, res.stdout], [0, ''], 'already linked: nothing to undo');
  // Another lockfile: the old link is no match for it.
  depsRepo(r.dir, a, '2.0.0');
  res = r.sh('test-deps.sh', [a]);
  assert.equal(res.stdout, 'linked\n');
  assert.equal(JSON.parse(readFileSync(join(a, 'node_modules', DEP, 'package.json'), 'utf8')).version, '2.0.0');
  assert.equal(JSON.parse(readFileSync(join(b, 'node_modules', DEP, 'package.json'), 'utf8')).version, '1.0.0', "b's is untouched");
});

test("a checkout's own folder is kept when it matches and installed again when it doesn't", () => {
  const r = repo();
  const own = join(r.source, 'node_modules', DEP, 'package.json');
  mkdirSync(join(r.source, 'node_modules', DEP), { recursive: true });
  writeFileSync(own, JSON.stringify({ version: '1.0.0' }));
  let res = r.sh('test-deps.sh', [r.source]);
  assert.deepEqual([res.status, res.stdout, r.npmRuns()], [0, '', []]);
  writeFileSync(own, JSON.stringify({ version: '0.9.0' }));
  res = r.sh('test-deps.sh', [r.source]);
  assert.deepEqual([res.status, res.stdout], [0, ''], res.stderr);
  assert.ok(lstatSync(join(r.source, 'node_modules')).isDirectory(), 'still its own');
  assert.equal(JSON.parse(readFileSync(own, 'utf8')).version, '1.0.0');
});

test("packages that aren't what npm ci installs here are no match: one the lockfile doesn't name, or this machine's own binary missing", () => {
  const r = repo();
  const put = (name: string) => {
    mkdirSync(join(r.source, 'node_modules', name), { recursive: true });
    writeFileSync(join(r.source, 'node_modules', name, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  };
  const lock = join(r.source, 'package-lock.json');
  const json = JSON.parse(readFileSync(lock, 'utf8'));
  const optional = (os: string) => ({ version: '1.0.0', optional: true, os: [os], cpu: [process.arch] });
  json.packages['node_modules/@x/here'] = optional(process.platform);
  json.packages['node_modules/@x/elsewhere'] = optional('aix');
  writeFileSync(lock, JSON.stringify(json));
  put(DEP);
  put('@x/here');
  put('.cache');
  assert.equal(r.sh('test-deps.sh', [r.source]).status, 0);
  assert.deepEqual(r.npmRuns(), [], "another platform's optional package may be absent, and npm's own dot folders are no package");
  for (const extra of ['stray', '@y/stray']) {
    put(extra);
    const res = r.sh('test-deps.sh', [r.source], { FAKE_NPM_FAIL: '1' });
    assert.equal(res.status, 1, extra);
    assert.match(res.stderr, /doesn't match package-lock.json: running npm ci/);
    rmSync(join(r.source, 'node_modules', extra.split('/')[0]), { recursive: true });
  }
  rmSync(join(r.source, 'node_modules', '@x', 'here'), { recursive: true });
  assert.equal(r.sh('test-deps.sh', [r.source], { FAKE_NPM_FAIL: '1' }).status, 1, "this machine's is missing");
});

test('an install that fails is said and leaves nothing behind; no lockfile needs nothing', () => {
  const r = repo();
  const a = r.worktree('a');
  let res = r.sh('test-deps.sh', [a], { FAKE_NPM_FAIL: '1' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /npm error no network[\s\S]*test-deps: npm ci failed/);
  assert.ok(!existsSync(join(a, 'node_modules')));
  res = r.sh('test-deps.sh', [a]);
  assert.equal(res.status, 0, `the next one installs: ${res.stderr}`);
  const bare = mkdtempSync(join(r.dir, 'bare-'));
  assert.equal(r.sh('test-deps.sh', [bare], { FAKE_NPM_FAIL: '1' }).status, 0);
});

test("a missing package is told from a file of the repo's own", () => {
  const r = repo();
  const log = join(r.dir, 'log');
  const missing = (text: string) => {
    writeFileSync(log, text);
    return r.sh('test-deps.sh', ['missing', log]).status === 0;
  };
  for (const t of ["Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'fast-check' imported from /x/a.ts", "Error: Cannot find module 'typescript'", 'typescript is not installed: run npm ci', 'Biome is missing']) assert.ok(missing(t), t);
  for (const t of ["Cannot find module './gone.ts'", "Cannot find module '/x/src/gone.ts' imported from /x/test/a.ts", 'AssertionError: 1 !== 2']) assert.ok(!missing(t), t);
});

test('test-alone.sh run: it passes, it fails, or it is no answer when its packages are missing', () => {
  const r = repo();
  const a = r.worktree('a');
  assert.equal(r.sh('test-alone.sh', ['run', a, 'test/uses.test.ts'], { FAKE_NPM_FAIL: '1' }).status, 2, 'nothing to run it on');
  const ok = r.sh('test-alone.sh', ['run', a, 'test/uses.test.ts']);
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(r.sh('test-alone.sh', ['run', a, 'test/none.test.ts']).status, 0, "a file it hasn't got");
  writeFileSync(join(a, 'test', 'red.test.ts'), "throw new Error('red');\n");
  assert.equal(r.sh('test-alone.sh', ['run', a, 'test/red.test.ts']).status, 1);
  writeFileSync(join(a, 'test', 'other.test.ts'), "import 'not-in-the-lockfile';\n");
  const no = r.sh('test-alone.sh', ['run', a, 'test/other.test.ts']);
  assert.equal(no.status, 2, no.stdout);
  assert.match(no.stdout, /could not run here \(a package is missing\): no verdict/);
  writeFileSync(join(a, 'test', 'killed.test.ts'), "process.kill(process.ppid, 'SIGKILL');\n");
  assert.equal(r.sh('test-alone.sh', ['run', a, 'test/killed.test.ts']).status, 2, 'killed from outside before its limit');
});

test('test-alone.sh stopped names only what fails here and passes on main', () => {
  const r = repo();
  const t = (n: string, text: string) => writeFileSync(join(r.source, 'test', `${n}.test.ts`), text);
  t('mine', '\n');
  t('both', "throw new Error('main too');\n");
  t('flake', '\n');
  t('hang', '\n');
  const main = r.commit();
  t('mine', "throw new Error('mine');\n");
  t('hang', "import test from 'node:test';\ntest('h', () => new Promise(() => setInterval(() => {}, 1000)));\n");
  const tip = r.commit();
  git(r.source, 'checkout', '-q', '--detach', main); // the answer comes from the commits, not from what is checked out
  const log = join(r.dir, 'suite.log');
  writeFileSync(log, 'run-tests: had a failed test when it was stopped: test/mine.test.ts test/both.test.ts test/flake.test.ts\nstill running: test/hang.test.ts (12s) in test: h\n');
  const res = r.sh('test-alone.sh', ['stopped', log, tip, main], { LAND_PIN_LIMIT: '5' });
  assert.equal(res.stdout, 'test/mine.test.ts\ntest/hang.test.ts\n', res.stderr);
  assert.ok(!git(r.source, 'worktree', 'list').includes('land-stopped'), 'its worktree is gone');
});
