// tools/light-check-run.sh (#1620): the light check's run on the side runner. citadel-test is faked (it prints
// FAKE_CT_OUT and exits FAKE_CT_RC); each failed file then runs alone for real, with node, on the ship's commit and on main.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, makeRepo } from './git.ts';

const script = join(import.meta.dirname, '..', 'tools', 'light-check-run.sh');
const pass = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const fail = "import { test } from 'node:test';\ntest('breaks', () => { throw new Error('red'); });\n";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'light-check-run-'));
  makeRepo(dir);
  mkdirSync(join(dir, 'test'));
  const put = (files: Record<string, string>, msg: string) => {
    for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', msg);
    return git(dir, 'rev-parse', 'HEAD');
  };
  // On main: a passes, b passes, e fails. The ship breaks b and adds c, which fails.
  // d needs a package from node_modules (made untracked by the test that uses it) and the ship breaks it.
  const needs = "import { test } from 'node:test';\nimport one from 'fakepkg';\ntest('pkg', () => { if (one !== 1) throw new Error('red'); });\n";
  const base = put({ 'test/a.test.mjs': pass, 'test/b.test.mjs': pass, 'test/e.test.mjs': fail, 'test/d.test.mjs': needs }, 'base');
  put({ 'test/b.test.mjs': fail, 'test/c.test.mjs': fail, 'test/d.test.mjs': needs.replace('one !== 1', 'one === 1') }, 'ship');
  writeFileSync(join(dir, 'fake-ct'), '#!/usr/bin/env bash\necho "args $*"\nprintf \'%b\\n\' "$FAKE_CT_OUT"\nexit "$FAKE_CT_RC"\n', { mode: 0o755 });
  // Without NODE_TEST_CONTEXT, which would have the files' own `node --test` report to this runner instead of exiting red.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const run = (rc: number, out: string, extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', [script, base], { cwd: dir, encoding: 'utf8', env: { ...env, LIGHT_CHECK_TEST: join(dir, 'fake-ct'), LIGHT_CHECK_NODE: process.execPath, FAKE_CT_OUT: out, FAKE_CT_RC: String(rc), ...extra } });
    assert.equal(r.status, 0, r.stderr);
    return { out: r.stdout, verdict: r.stdout.trim().split('\n').pop() };
  };
  return { dir, base, run, done: () => rmSync(dir, { recursive: true, force: true }) }; // timing-ok: own temp dir
}

test("light-check-run: green, red that is the ship's own, flakes, main's own red, a run cut off (#1620)", () => {
  const r = repo();
  try {
    const green = r.run(0, '✔ 3 passed');
    assert.equal(green.verdict, 'light check: green');
    assert.match(green.out, new RegExp(`^args --affected --base ${r.base} --timeout 240$`, 'm'), 'its own and affected files against main');
    // b fails alone with the ship and passes on main; c is new with it; a passes alone (a flake); e fails on main too.
    const red = r.run(1, '✖ test/a.test.mjs:2 › ok\n✖ test/b.test.mjs:2 › breaks\n✖ test/b.test.mjs:9 › again\n✖ test/c.test.mjs:2 › breaks\n✖ test/e.test.mjs:2 › breaks');
    assert.equal(red.verdict, 'light check: red: test/b.test.mjs, test/c.test.mjs');
    assert.match(red.out, /--- run alone:/);
    assert.equal(r.run(1, '✖ test/a.test.mjs:2 › ok').verdict, 'light check: no verdict: test/a.test.mjs passed alone (flakes)');
    assert.equal(r.run(1, '✖ test/e.test.mjs:2 › breaks').verdict, 'light check: no verdict: test/e.test.mjs (red on main too)');
    assert.equal(r.run(124, '✖ stopped at the time limit').verdict, 'light check: no verdict: the affected tests ran past 240s');
    assert.equal(r.run(2, 'citadel-test: no such file').verdict, "light check: no verdict: citadel-test couldn't run them (its lines above say why)");
    assert.equal(r.run(1, '✖ 0 passed, 1 failed').verdict, 'light check: no verdict: red (status 1) with no test file named');
    assert.equal(r.run(1, '✖ test/b.test.mjs:2 › breaks', { LIGHT_CHECK_BUDGET: '0' }).verdict, 'light check: no verdict: test/b.test.mjs (out of time)');
    assert.equal(git(r.dir, 'worktree', 'list').split('\n').length, 1, "main's checkout is gone");
  } finally {
    r.done();
  }
});

test('light-check-run: installs packages when the lockfile changed, once (#1789)', () => {
  const r = repo();
  try {
    // A fake npm that logs its call and makes node_modules, as `npm ci` does; NPM_RC makes it fail.
    writeFileSync(join(r.dir, 'fake-npm'), '#!/usr/bin/env bash\necho "npm $*" >>npm.log\nmkdir -p node_modules\nexit "${NPM_RC:-0}"\n', { mode: 0o755 });
    const npm = { LIGHT_CHECK_NPM: join(r.dir, 'fake-npm') };
    const calls = () => (existsSync(join(r.dir, 'npm.log')) ? readFileSync(join(r.dir, 'npm.log'), 'utf8').trim().split('\n') : []);
    assert.equal(r.run(0, '✔ 1 passed', npm).verdict, 'light check: green', 'no lockfile: nothing to install');
    assert.deepEqual(calls(), []);
    writeFileSync(join(r.dir, 'package-lock.json'), '{"v":1}');
    assert.equal(r.run(0, '✔ 1 passed', npm).verdict, 'light check: green');
    assert.deepEqual(calls(), ['npm ci --ignore-scripts --no-audit --no-fund']);
    r.run(0, '✔ 1 passed', npm);
    assert.equal(calls().length, 1, 'the same lockfile again: no second install');
    writeFileSync(join(r.dir, 'package-lock.json'), '{"v":2}');
    assert.equal(r.run(0, '✔ 1 passed', { ...npm, NPM_RC: '1' }).verdict, 'light check: no verdict: npm ci failed (its lines above say why)');
    assert.equal(calls().length, 2);
    r.run(0, '✔ 1 passed', npm);
    assert.equal(calls().length, 3, 'a failed install is tried again next time');
  } finally {
    r.done();
  }
});

test("light-check-run: main's checkout reads the ship's packages, so a red needing one is the ship's own (#1789)", () => {
  const r = repo();
  try {
    mkdirSync(join(r.dir, 'node_modules', 'fakepkg'), { recursive: true });
    writeFileSync(join(r.dir, 'node_modules', 'fakepkg', 'package.json'), '{"name":"fakepkg","main":"index.js"}');
    writeFileSync(join(r.dir, 'node_modules', 'fakepkg', 'index.js'), 'module.exports = 1;\n');
    assert.equal(r.run(1, '✖ test/d.test.mjs:3 › pkg').verdict, 'light check: red: test/d.test.mjs');
    assert.ok(existsSync(join(r.dir, 'node_modules', 'fakepkg', 'index.js')), "removing main's checkout leaves the packages alone");
  } finally {
    r.done();
  }
});
