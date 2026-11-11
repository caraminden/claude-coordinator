import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

// The scheme-setup kit skill's land.sh template, on throwaway repos: a scheme repo on main with the
// template's pre-push hook active, a bare origin, and a minion worktree that lands through it.
const templates = join(import.meta.dirname, '..', 'kit', 'skills', 'scheme-setup', 'templates');
const root = mkdtempSync(join(tmpdir(), 'scheme-land-'));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, DEPLOY_LOCKED: undefined, DEPLOY_TESTED: undefined, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();

let n = 0;
function setup(check = 'test ! -e red') {
  const dir = join(root, String(++n));
  const main = join(dir, 'repo');
  mkdirSync(join(main, 'tools'), { recursive: true });
  mkdirSync(join(main, '.githooks'));
  git(main, 'init', '-q', '-b', 'main');
  copyFileSync(join(templates, 'land.sh'), join(main, 'tools', 'land.sh'));
  copyFileSync(join(templates, 'pre-push'), join(main, '.githooks', 'pre-push'));
  chmodSync(join(main, 'tools', 'land.sh'), 0o755);
  chmodSync(join(main, '.githooks', 'pre-push'), 0o755);
  // The check (by default red while a file named "red" exists).
  const landSh = join(main, 'tools', 'land.sh');
  writeFileSync(landSh, readFileSync(landSh, 'utf8').replace(/^CHECK=.*$/m, () => `CHECK='${check}'`));
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
    mkdirSync(dirname(join(where, file)), { recursive: true });
    writeFileSync(join(where, file), text);
    git(where, 'add', '-A');
    git(where, 'commit', '-qm', `${file}: ${text.trim()}`);
  };
  const run = (extra: Record<string, string> = {}) => spawnSync('bash', [join(wt, 'tools', 'land.sh')], { cwd: join(wt, 'tools'), encoding: 'utf8', timeout: 90_000, env: { ...env, ...extra } });
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

// The check runs under the land lock, so it must end and must not take the lock with it (#468 S10-2).
const landLockFree = (r: ReturnType<typeof setup>) =>
  spawnSync('flock', ['-n', join(git(r.main, 'rev-parse', '--absolute-git-dir'), 'land.lock'), 'true']).status === 0;

test('a check that hangs is stopped at the time limit, says so, and lets go of the lock', () => {
  const r = setup('sleep 30');
  const before = git(r.main, 'rev-parse', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const t = Date.now();
  const res = r.run({ LAND_CHECK_TIMEOUT: '2' });
  assert.ok(Date.now() - t < 20_000, `stopped at the limit, not run out: ${Date.now() - t} ms`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /the check ran past 2s and was stopped/);
  assert.match(res.stderr, /check failed/);
  assert.equal(git(r.main, 'rev-parse', 'main'), before);
  assert.ok(landLockFree(r), 'the land lock is free');
});

test('a process the check leaves running does not hold the land lock', () => {
  const pidFile = join(root, `left-${n + 1}.pid`);
  const r = setup('sleep 30 >/dev/null 2>&1 & echo $! >"$LEFT_PID"');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = r.run({ LEFT_PID: pidFile });
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.equal(res.status, 0, res.stderr);
    assert.ok(landLockFree(r), 'the land lock is free while the leftover process runs');
  } finally {
    process.kill(pid);
  }
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

// The numbered-things check: a scheme whose Project facts name its migrations, a version and a ledger.
// The line wraps onto a second line, as Project facts bullets do.
const facts = [
  '## Project facts',
  '',
  '- **Check commands:** none.',
  '- **Numbered things:** `files db/migrations/NNNN-*.sql`; `ids docs/ledger.md "^- \\*\\*U(\\d+)\\."`;',
  '  `version addons/*/*.toc "^## Version: (.+)"`',
  '- **Glossary:** none.',
  '',
].join('\n');
const ledger = (open: string, proven: string) => `# Ledger\n\n## Open\n\n${open}\n## Proven\n\n${proven}\n## End\n`;
function numbered() {
  const r = setup();
  r.commit(r.main, 'CLAUDE.md', facts);
  r.commit(r.main, 'db/migrations/0001-base.sql', 'create\n');
  r.commit(r.main, 'docs/ledger.md', ledger('- **U1.** one\n', '- **U2.** two\n'));
  r.commit(r.main, 'addons/beacon/beacon.toc', '## Title: Beacon\n## Version: 0.2.0\n');
  git(r.wt, 'rebase', '-q', 'main');
  return r;
}
function refused(r: ReturnType<typeof setup>, res: ReturnType<typeof r.run>, mine: string, main: string, says: RegExp) {
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, says);
  assert.match(res.stderr, /takes a number main already has .*back where it was\. Renumber yours past main's highest/);
  assert.equal(git(r.main, 'rev-parse', 'main'), main, 'main untouched');
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), mine, 'the branch is put back unrebased');
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
}

test('numbered things: a migration number main already has is refused, naming both files', () => {
  const r = numbered();
  r.commit(r.wt, 'db/migrations/0002-mine.sql', 'mine\n');
  r.commit(r.main, 'db/migrations/0002-theirs.sql', 'theirs\n');
  const mine = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.main, 'rev-parse', 'main');
  refused(r, r.run(), mine, main, /db\/migrations\/0002-mine\.sql takes number 2, which db\/migrations\/0002-theirs\.sql already has \(the highest so far is 2\)/);
});

test('numbered things: two identical version bumps, which git merges silently, are refused and stay refused', () => {
  const r = numbered();
  r.commit(r.wt, 'addons/beacon/beacon.toc', '## Title: Beacon\n## Version: 0.2.1\n');
  r.commit(r.wt, 'mine.lua', 'x\n');
  // Main's bump comes second, or it would be the very same commit as the branch's (same parent, message and second).
  r.commit(r.main, 'theirs.lua', 'y\n');
  r.commit(r.main, 'addons/beacon/beacon.toc', '## Title: Beacon\n## Version: 0.2.1\n');
  const mine = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.main, 'rev-parse', 'main');
  const says = /addons\/beacon\/beacon\.toc: this branch moves its version from 0\.2\.0 to 0\.2\.1, but main moved it to 0\.2\.1/;
  refused(r, r.run(), mine, main, says);
  // Running it again without renumbering is refused again, since the branch went back unrebased.
  refused(r, r.run(), mine, main, says);
  // Bumped past main's, it lands.
  git(r.wt, 'rebase', '-q', '-X', 'theirs', 'main');
  r.commit(r.wt, 'addons/beacon/beacon.toc', '## Title: Beacon\n## Version: 0.2.2\n');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(r.main, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
});

test('numbered things: a ledger id main already has is refused, even in another section', () => {
  const r = numbered();
  r.commit(r.wt, 'docs/ledger.md', ledger('- **U1.** one\n- **U3.** mine\n', '- **U2.** two\n'));
  r.commit(r.main, 'docs/ledger.md', ledger('- **U1.** one\n', '- **U2.** two\n- **U3.** theirs\n'));
  const mine = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.main, 'rev-parse', 'main');
  refused(r, r.run(), mine, main, /docs\/ledger\.md has id 3 twice: this branch adds one and main already has it \(the highest so far is 3\)/);
});

test('numbered things: new numbers past main\'s, a version only the branch bumps and edits to old entries land', () => {
  const r = numbered();
  // A duplicate main already had is not this branch's to fix, even when the branch edits that entry.
  r.commit(r.main, 'docs/ledger.md', ledger('- **U1.** one\n- **U1.** old duplicate\n', '- **U2.** two\n'));
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.main, 'db/migrations/0002-theirs.sql', 'theirs\n');
  r.commit(r.main, 'docs/ledger.md', ledger('- **U1.** one\n- **U1.** old duplicate\n', '- **U2.** two\n- **U3.** theirs\n'));
  r.commit(r.wt, 'db/migrations/0003-mine.sql', 'mine\n');
  r.commit(r.wt, 'docs/ledger.md', ledger('- **U1.** one, reworded\n- **U1.** old duplicate\n- **U4.** mine\n', '- **U2.** two\n'));
  r.commit(r.wt, 'addons/beacon/beacon.toc', '## Title: Beacon\n## Version: 0.2.1\n');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(r.main, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
});

test('numbered things: a line that does not parse refuses and names it; "none" checks nothing', () => {
  const r = numbered();
  r.commit(r.wt, 'CLAUDE.md', facts.replace('`files db/migrations/NNNN-*.sql`', '`files db/migrations/*.sql`'));
  const mine = git(r.wt, 'rev-parse', 'HEAD');
  const res = r.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /does not parse: "files db\/migrations\/\*\.sql": files takes one glob with NNNN/);
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), mine);
  r.commit(r.wt, 'CLAUDE.md', '- **Numbered things:** none.\n');
  r.commit(r.wt, 'db/migrations/0001-again.sql', 'dup\n');
  const ok = r.run();
  assert.equal(ok.status, 0, ok.stderr);
});
