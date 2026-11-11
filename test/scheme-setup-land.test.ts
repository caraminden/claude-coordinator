import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { scriptEnv } from './script-env.ts';

// The scheme-setup kit skill's land.sh template, on throwaway repos: a scheme repo on main with the
// template's pre-push hook active, a bare origin, and a minion worktree that lands through it.
const templates = join(import.meta.dirname, '..', 'kit', 'skills', 'scheme-setup', 'templates');
const root = mkdtempSync(join(tmpdir(), 'scheme-land-'));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...scriptEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
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

// The line for the land lock (the queue_* functions in the template, from Citadel's tools/deploy-queue.sh,
// #502). The kernel grants a flock in no order, so several landings waiting on it at once (2026-11-10)
// meant some lost every round and timed out. Fake work: the check waits for a file named in $GATE.
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function until(what: string, cond: () => boolean, ms = 30_000) {
  for (const end = Date.now() + ms; !cond(); await sleep(20)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}
const gated = 'until [ -e "$GATE" ]; do sleep 0.05; done';
function queueSetup(branches: number, check = gated) {
  const r = setup(check);
  const state = git(r.main, 'rev-parse', '--absolute-git-dir');
  const gate = join(r.dir, 'gate');
  const wts = [r.wt];
  for (let i = 2; i <= branches; i++) git(r.main, 'worktree', 'add', '-q', '-b', `ticket/${i}-x`, wts[wts.push(join(r.dir, `wt${i}`)) - 1]);
  wts.forEach((wt, i) => r.commit(wt, `f${i + 1}.txt`, `${i + 1}\n`));
  const tickets = () => (existsSync(join(state, 'land-queue')) ? readdirSync(join(state, 'land-queue')).filter((f) => /^\d+$/.test(f)).sort() : []);
  const issued = () => (existsSync(join(state, 'land-queue', '.seq')) ? Number(readFileSync(join(state, 'land-queue', '.seq'), 'utf8')) : 0);
  const phase = (ticket: string) => { try { return readFileSync(join(state, 'land-queue', ticket), 'utf8').split('\n')[3]; } catch { return ''; } };
  // Landing i (from 1), started and left running.
  const land = (i: number, extra: Record<string, string> = {}) => {
    const child = spawn('bash', [join(wts[i - 1], 'tools', 'land.sh')], { cwd: wts[i - 1], stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, GATE: gate, LAND_QUEUE_POLL: '0.05', ...extra } });
    let stderr = '';
    child.stderr!.on('data', (d) => (stderr += d));
    const exit = new Promise<number | null>((ok) => child.on('close', ok));
    return { child, exit, stderr: () => stderr };
  };
  const open = () => writeFileSync(gate, '');
  const landed = () => git(r.main, 'log', '--reverse', '--format=%s', 'main').split('\n').slice(1);
  return { ...r, state, wts, tickets, issued, phase, land, open, landed };
}

test('ten landings started together land in the order they arrived, each told its place in line', async () => {
  const q = queueSetup(10);
  const lands: ReturnType<typeof q.land>[] = [];
  try {
    for (let i = 1; i <= 10; i++) {
      lands.push(q.land(i));
      await until(`landing ${i}'s ticket`, () => q.issued() === i); // arrival order is the order of the tickets
    }
    // The first holds the lock, in its check, until all ten are in line and the last has been told its place.
    await until('the last to say its place', () => /queue: 10th in line for the land lock, about 45 min \(ahead: ticket\/1-x, running the check since \d\d:\d\d\)/.test(lands[9].stderr()));
  } finally {
    q.open();
  }
  const codes = await Promise.all(lands.map((l) => l.exit));
  codes.forEach((code, i) => assert.equal(code, 0, `landing ${i + 1}: ${lands[i].stderr()}`));
  assert.deepEqual(q.landed(), lands.map((_, i) => `f${i + 1}.txt: ${i + 1}`));
  assert.equal(git(q.origin, 'rev-parse', 'main'), git(q.main, 'rev-parse', 'main'), 'the last push carried them all');
  assert.doesNotMatch(lands[0].stderr(), /in line/, 'the first had nobody to wait for');
  assert.match(lands[9].stderr(), /queue: 2nd in line for the land lock, about \d+ min \(ahead: ticket\/9-x, /);
  assert.match(lands[9].stderr(), /queue: got the land lock/);
  assert.deepEqual(q.tickets(), [], 'every ticket is gone');
  assert.equal(readFileSync(join(q.state, 'land-queue', '.took'), 'utf8').trim().split('\n').length, 5, 'the newest five landings were timed, for the estimate');
  assert.ok(landLockFree(q), 'the land lock is free');
});

test('a waiter that is killed leaves the line, and the one behind it goes next', async () => {
  const q = queueSetup(3);
  const a = q.land(1);
  try {
    await until('a to run its check', () => /running the check/.test(q.phase(q.tickets()[0] ?? '')));
    const b = q.land(2);
    await until("b's ticket", () => q.issued() === 2);
    const c = q.land(3);
    await until('c to see its place', () => /3rd in line/.test(c.stderr()));
    b.child.kill('SIGKILL');
    await b.exit;
    await until('c to move up past the dead ticket', () => /2nd in line/.test(c.stderr()));
    assert.equal(q.tickets().length, 2, 'the waiter behind it removed it');
    q.open();
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await c.exit, 0, c.stderr());
    assert.deepEqual(q.landed(), ['f1.txt: 1', 'f3.txt: 3']);
  } finally {
    q.open();
  }
});

test('a holder that is killed leaves the line too, and its lock goes with it', async () => {
  const q = queueSetup(2);
  const a = q.land(1);
  try {
    await until('a to run its check', () => /running the check/.test(q.phase(q.tickets()[0] ?? '')));
    const b = q.land(2);
    await until('b to wait', () => /2nd in line/.test(b.stderr()));
    a.child.kill('SIGKILL'); // its check runs on without the lock, until the gate opens below
    await until('b to get the lock', () => /got the land lock/.test(b.stderr()));
    q.open();
    assert.equal(await b.exit, 0, b.stderr());
    assert.deepEqual(q.landed(), ['f2.txt: 2']);
  } finally {
    q.open();
  }
});

test('a waiter gives up once nothing has moved for the stall limit, with nothing landed', async () => {
  const q = queueSetup(2);
  const a = q.land(1);
  try {
    await until('a to run its check', () => /running the check/.test(q.phase(q.tickets()[0] ?? '')));
    const b = q.land(2, { LAND_CHECK_TIMEOUT: '1', LAND_QUEUE_SLACK: '1' });
    assert.equal(await b.exit, 1, 'it gives up in the end');
    assert.match(b.stderr(), /2nd in line for the land lock, about 5 min \(ahead: ticket\/1-x, running the check since/);
    assert.match(b.stderr(), /nothing has moved for 1 min \(ahead: ticket\/1-x, running the check since .*\), so this gave up and nothing landed/);
    assert.equal(q.tickets().length, 1, 'its ticket went with it');
    q.open();
    assert.equal(await a.exit, 0, a.stderr());
    assert.deepEqual(q.landed(), ['f1.txt: 1']);
  } finally {
    q.open();
  }
});

test('the stall limit is longer than the check limit, so a waiter outlasts a check that runs to its limit', async () => {
  // The holder's branch has a file that makes the check hang; the waiter's does not.
  const q = queueSetup(2, '[ ! -e f1.txt ] || sleep 30');
  const limits = { LAND_CHECK_TIMEOUT: '3', LAND_QUEUE_SLACK: '4' }; // slack to spare: bash counts whole seconds, and the box may be busy
  const a = q.land(1, limits);
  await until('a to run its check', () => /running the check/.test(q.phase(q.tickets()[0] ?? '')));
  const b = q.land(2, limits);
  assert.equal(await a.exit, 1);
  assert.match(a.stderr(), /the check ran past 3s and was stopped/);
  assert.equal(await b.exit, 0, b.stderr());
  assert.match(b.stderr(), /2nd in line/);
  assert.deepEqual(q.landed(), ['f2.txt: 2']);
  assert.equal(spawnSync('bash', [join(q.wt, 'tools', 'land.sh')], { cwd: q.wt, encoding: 'utf8', env: { ...env, LAND_CHECK_TIMEOUT: '30m' } }).stderr.trim(), 'land: LAND_CHECK_TIMEOUT is in whole seconds, not "30m"');
});

test('the head of the line waits for a lock held outside it (an older land.sh), and the estimate comes from past landings', async () => {
  const q = queueSetup(2, 'true');
  mkdirSync(join(q.state, 'land-queue'));
  writeFileSync(join(q.state, 'land-queue', '.took'), '100\n140\n');
  const older = spawn('bash', ['-c', 'exec 9>"$0"; flock 9; exec sleep 600', join(q.state, 'land.lock')], { stdio: 'ignore' }); // one process, so killing it frees the lock
  try {
    await until('the lock to be held', () => !landLockFree(q));
    const a = q.land(1);
    await until('a to say it waits', () => /next in line for the land lock \(ahead: a landing started from a branch whose land.sh is older/.test(a.stderr()));
    const b = q.land(2);
    await until('b to say its place', () => /2nd in line for the land lock, about 2 min \(ahead: ticket\/1-x, waiting\)/.test(b.stderr()));
    assert.deepEqual(q.landed(), []);
    older.kill('SIGKILL');
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await b.exit, 0, b.stderr());
    assert.deepEqual(q.landed(), ['f1.txt: 1', 'f2.txt: 2']);
    assert.equal(readFileSync(join(q.state, 'land-queue', '.took'), 'utf8').trim().split('\n').length, 4, 'each noted how long it held the lock');
  } finally {
    older.kill('SIGKILL');
  }
});
