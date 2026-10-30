import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// The scheme-setup kit skill's land.sh template, on throwaway repos: a scheme repo on main with the
// template's pre-push hook active, a bare origin, and a minion worktree that lands through it.
const templates = join(import.meta.dirname, '..', 'kit', 'skills', 'scheme-setup', 'templates');
const root = mkdtempSync(join(tmpdir(), 'scheme-land-'));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();

let n = 0;
function setup() {
  const dir = join(root, String(++n));
  const main = join(dir, 'repo');
  mkdirSync(join(main, 'tools'), { recursive: true });
  mkdirSync(join(main, '.githooks'));
  git(main, 'init', '-q', '-b', 'main');
  copyFileSync(join(templates, 'land.sh'), join(main, 'tools', 'land.sh'));
  copyFileSync(join(templates, 'pre-push'), join(main, '.githooks', 'pre-push'));
  chmodSync(join(main, 'tools', 'land.sh'), 0o755);
  chmodSync(join(main, '.githooks', 'pre-push'), 0o755);
  // The check: red while a file named "red" exists.
  execFileSync('sed', ['-i', "s/^CHECK=.*/CHECK='test ! -e red'/", join(main, 'tools', 'land.sh')]);
  writeFileSync(join(main, 'a.txt'), 'one\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'base');
  git(main, 'config', 'core.hooksPath', '.githooks');
  const origin = join(dir, 'origin.git');
  git(dir, 'clone', '-q', '--bare', main, origin);
  git(main, 'remote', 'add', 'origin', origin);
  const wt = join(dir, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'ticket/1-x', wt);
  const commit = (where: string, file: string, text: string) => {
    writeFileSync(join(where, file), text);
    git(where, 'add', '-A');
    git(where, 'commit', '-qm', `${file}: ${text.trim()}`);
  };
  const run = () => spawnSync('bash', [join(wt, 'tools', 'land.sh')], { cwd: join(wt, 'tools'), encoding: 'utf8', env });
  return { dir, main, origin, wt, commit, run };
}

test('rebases onto main, checks, fast-forwards main and pushes it past the pre-push hook', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  r.commit(r.main, 'c.txt', 'someone else\n');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  assert.equal(git(r.main, 'rev-parse', 'main'), tip);
  assert.equal(git(r.origin, 'rev-parse', 'main'), tip);
  assert.equal(git(r.main, 'log', '--format=%s', '-3'), 'b.txt: mine\nc.txt: someone else\nbase');
});

test('a red check leaves main and origin untouched', () => {
  const r = setup();
  const before = git(r.main, 'rev-parse', 'main');
  r.commit(r.wt, 'red', 'x\n');
  const res = r.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /check failed/);
  assert.equal(git(r.main, 'rev-parse', 'main'), before);
  assert.equal(git(r.origin, 'rev-parse', 'main'), before);
});

test('a rebase conflict aborts and leaves main untouched', () => {
  const r = setup();
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.main, 'a.txt', 'theirs\n');
  const mine = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.main, 'rev-parse', 'main');
  const res = r.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /rebase onto main failed/);
  assert.equal(git(r.main, 'rev-parse', 'main'), main);
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), mine);
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
});

test('a failed push keeps main moved and says so', () => {
  const r = setup();
  git(r.main, 'remote', 'set-url', 'origin', join(r.dir, 'missing.git'));
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = r.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /main moved, but the push to origin failed/);
  assert.equal(git(r.main, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
});

test('the pre-push template refuses a push to main from the same clone', () => {
  const r = setup();
  r.commit(r.main, 'b.txt', 'unlanded\n');
  const res = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: r.main, encoding: 'utf8', env });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /push to main refused/);
});
