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
function setup(check = 'test ! -e red', config: Record<string, string> = {}) {
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
  let script = readFileSync(landSh, 'utf8').replace(/^CHECK=.*$/m, () => `CHECK='${check}'`);
  for (const [key, value] of Object.entries(config)) script = script.replace(new RegExp(`^${key}=.*$`, 'm'), () => `${key}='${value}'`);
  writeFileSync(landSh, script);
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
function queueSetup(branches: number, check = gated, config: Record<string, string> = {}, files = (i: number) => `f${i}.txt`) {
  const r = setup(check, config);
  const state = git(r.main, 'rev-parse', '--absolute-git-dir');
  const gate = join(r.dir, 'gate');
  const wts = [r.wt];
  for (let i = 2; i <= branches; i++) git(r.main, 'worktree', 'add', '-q', '-b', `ticket/${i}-x`, wts[wts.push(join(r.dir, `wt${i}`)) - 1]);
  wts.forEach((wt, i) => r.commit(wt, files(i + 1), `${i + 1}\n`));
  const tickets = () => (existsSync(join(state, 'land-queue')) ? readdirSync(join(state, 'land-queue')).filter((f) => /^\d+$/.test(f)).sort() : []);
  const issued = () => (existsSync(join(state, 'land-queue', '.seq')) ? Number(readFileSync(join(state, 'land-queue', '.seq'), 'utf8')) : 0);
  const phase = (ticket: string) => { try { return readFileSync(join(state, 'land-queue', ticket), 'utf8').split('\n')[3]; } catch { return ''; } };
  // Landing i (from 1), started and left running.
  const land = (i: number, extra: Record<string, string> = {}) => {
    const child = spawn('bash', [join(wts[i - 1], 'tools', 'land.sh')], { cwd: wts[i - 1], stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, GATE: gate, LAND_QUEUE_POLL: '0.05', ...extra } });
    let stderr = '';
    child.stderr!.on('data', (d) => (stderr += d));
    // A landing that never ends fails its test by name instead of hanging the whole run (#560).
    const exit = new Promise<number | null>((ok, no) => {
      const late = setTimeout(() => no(new Error(`land.sh was still running after 60 s:\n${stderr}`)), 60_000);
      child.on('close', (code) => { clearTimeout(late); ok(code); });
    });
    exit.catch(() => {}); // for a test that had already failed on something else
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

// A zombie: b's parent starts it, then becomes a sleep that never waits on it, so once b is killed its
// /proc entry stays, start time and all, until the parent goes.
const isZombie = (pid: number) => { try { return /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };

test('a killed waiter whose parent never reaps it leaves the line too', async () => {
  const q = queueSetup(3);
  const a = q.land(1);
  const pidFile = join(q.dir, 'b.pid');
  let c: ReturnType<typeof q.land> | undefined;
  let parent: ReturnType<typeof spawn> | undefined;
  try {
    await until('a to run its check', () => /running the check/.test(q.phase(q.tickets()[0] ?? '')));
    parent = spawn('bash', ['-c', 'bash "$0" & echo $! >"$1"; exec sleep 600', join(q.wts[1], 'tools', 'land.sh'), pidFile], { cwd: q.wts[1], stdio: 'ignore', env: { ...env, GATE: join(q.dir, 'gate'), LAND_QUEUE_POLL: '0.05' } });
    await until("b's ticket", () => q.issued() === 2);
    c = q.land(3);
    const cs = c.stderr;
    await until('c to see its place', () => /3rd in line/.test(cs()));
    const [ta, , tc] = q.tickets();
    assert.ok(tc, 'three tickets in line');
    const b = Number(readFileSync(pidFile, 'utf8'));
    process.kill(b, 'SIGKILL');
    await until('b to be a zombie', () => isZombie(b));
    await until('c to move up past the zombie', () => /2nd in line/.test(cs()));
    assert.deepEqual(q.tickets(), [ta, tc], "the zombie's ticket was removed");
    assert.ok(isZombie(b), 'b was still a zombie when c moved up');
    q.open();
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await c.exit, 0, c.stderr());
    assert.deepEqual(q.landed(), ['f1.txt: 1', 'f3.txt: 3']);
  } finally {
    q.open();
    c?.child.kill('SIGKILL'); // with nothing ahead it would wait out the stall limit
    parent?.kill('SIGKILL');
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

// The CI gate and the stack (#537). CI is faked two ways: a CI_STATUS command that answers from a file named after
// the commit (its exit code; no file: not started; "<code> once": that answer one time, then not started), and for
// the built-in reader a gh that prints what the test wrote (runs.once.tsv one time, then runs.tsv; branch-runs for
// the scratch branch's unfinished runs, "<id>\t<commit>" a line).
// Either way a gh stands first in PATH, so no test reaches GitHub.
function ciSetup(branches: number, { stack = '', check = 'true', builtin = false, files = (i: number) => `f${i}.txt` } = {}) {
  const config: Record<string, string> = { ...(builtin ? { CI_WORKFLOWS: 'ci.yml slow.yml' } : { CI_STATUS: '"$CI_FAKE"' }), ...(stack ? { CI_STACK: stack } : {}) }; // no stack: the template's own depth, 3
  const q = queueSetup(branches, check, config, files);
  const ci = join(q.dir, 'ci');
  const bin = join(q.dir, 'bin');
  mkdirSync(ci);
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/bash\necho "$*" >>"$CI_DIR/gh.log"\ncase "$*" in *head_sha=*) if [ -e "$CI_DIR/runs.once.tsv" ]; then cat "$CI_DIR/runs.once.tsv"; rm "$CI_DIR/runs.once.tsv"; else cat "$CI_DIR/runs.tsv" 2>/dev/null; fi ;; *status=in_progress*) cat "$CI_DIR/busy" 2>/dev/null ;; */jobs*) cat "$CI_DIR/failed-steps" 2>/dev/null ;; *branch=*) cat "$CI_DIR/branch-runs" 2>/dev/null ;; esac\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(ci, 'status.sh'), '#!/bin/bash\nf=$CI_DIR/${1:0:12}\nread -r code once <"$f" 2>/dev/null || code=3\n[ -z "$once" ] || rm "$f"\nexit "$code"\n', { mode: 0o755 });
  const ciEnv = { CI_DIR: ci, CI_FAKE: join(ci, 'status.sh'), PATH: `${bin}:${env.PATH}`, LAND_CI_POLL: '0', LAND_CI_GRACE: '0' };
  const started: ReturnType<typeof q.land>[] = [];
  const land = (i: number, extra: Record<string, string> = {}) => started[started.push(q.land(i, { ...ciEnv, ...extra })) - 1];
  type L = ReturnType<typeof land>;
  // The commits a landing sent to CI, oldest first, as land.sh names them (12 characters).
  const sent = (l: L) => [...l.stderr().matchAll(/waiting for CI on ([0-9a-f]{12}) \(origin/g)].map((m) => m[1]);
  /** Waits until the landing has sent its nth commit to CI, and returns it. */
  const tip = async (l: L, nth = 1) => { await until(`CI run ${nth}: ${l.stderr()}`, () => sent(l).length >= nth); return sent(l)[nth - 1]; };
  const verdict = (sha: string, code: number, once = false) => writeFileSync(join(ci, sha), `${code}${once ? ' once' : ''}\n`);
  const parent = (sha: string) => git(q.main, 'rev-parse', `${sha}^`).slice(0, 12);
  const mainAt = () => git(q.main, 'rev-parse', 'main').slice(0, 12);
  const scratch = () => git(q.origin, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/land').split('\n').filter(Boolean).map((l) => l.replace(/^(\S+ .{12}).*/, '$1'));
  const on = (i: number) => git(q.wts[i - 1], 'branch', '--show-current');
  const stop = () => { for (const l of started) if (l.child.exitCode === null && l.child.signalCode === null) l.child.kill('SIGKILL'); };
  /** Starts these landings one after another, so their places in line are the order given. */
  const lands = async (...is: number[]) => {
    const out: L[] = [];
    for (const i of is) {
      const had = q.issued();
      out.push(land(i));
      await until(`landing ${i}'s ticket`, () => q.issued() === had + 1);
    }
    return out;
  };
  return { ...q, ci, land, lands, sent, tip, verdict, parent, mainAt, scratch, on, stop };
}
const GREEN = 0, RED = 1, LOST = 4;

test('CI gate: the commit goes to a scratch branch, and lands only once CI passed exactly that commit', async () => {
  const c = ciSetup(1, { stack: '1' });
  try {
    c.commit(c.main, 'c.txt', 'someone else\n');
    const before = c.mainAt();
    const a = c.land(1);
    const sha = await c.tip(a);
    assert.equal(c.parent(sha), before, 'it was rebased onto main');
    assert.deepEqual(c.scratch(), [`land/ticket/1-x ${sha}`]);
    c.verdict(git(c.wt, 'rev-parse', 'ticket/1-x').slice(0, 12), GREEN); // green on the branch as it was: another commit
    await sleep(400);
    assert.equal(c.mainAt(), before, 'a green run of another commit lands nothing');
    assert.equal(c.on(1), '', 'the worktree waits on the detached commit');
    c.verdict(sha, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(c.mainAt(), sha);
    assert.equal(git(c.origin, 'rev-parse', 'main').slice(0, 12), sha);
    assert.deepEqual(c.scratch(), [], 'the scratch branch is gone');
    assert.equal(c.on(1), 'ticket/1-x');
    assert.equal(git(c.wt, 'rev-parse', 'HEAD').slice(0, 12), sha, 'the branch is at what landed');
    assert.ok(landLockFree(c));
  } finally {
    c.stop();
  }
});

test('CI gate: red CI refuses with main untouched; no runner within the limit parks with exit 75', async () => {
  const c = ciSetup(2, { stack: '1' });
  try {
    const before = c.mainAt();
    const a = c.land(1);
    c.verdict(await c.tip(a), RED);
    assert.equal(await a.exit, 1, a.stderr());
    assert.match(a.stderr(), /CI is red on [0-9a-f]{12} \(above\), so main is untouched/);
    const b = c.land(2, { LAND_CI_START: '1' });
    assert.equal(await b.exit, 75, b.stderr());
    assert.match(b.stderr(), /no runner has started CI on [0-9a-f]{12} within 1 min .* nothing landed\. Park/);
    assert.equal(c.mainAt(), before);
    assert.deepEqual(c.scratch(), []);
    assert.deepEqual([c.on(1), c.on(2)], ['ticket/1-x', 'ticket/2-x']);
    assert.deepEqual(c.tickets(), []);
    // A run that never ends parks too.
    const again = c.land(2, { LAND_CI_TIMEOUT: '1' });
    c.verdict(await c.tip(again), 2);
    assert.equal(await again.exit, 75, again.stderr());
    assert.match(again.stderr(), /hasn't finished within 1 min/);
    assert.equal(spawnSync('bash', [join(c.wt, 'tools', 'land.sh')], { cwd: c.wt, encoding: 'utf8', env: { ...env, LAND_CI_START: 'soon' } }).stderr.trim(), 'land: LAND_CI_START is in whole seconds, not "soon"');
  } finally {
    c.stop();
  }
});

test("CI gate: a landed commit's runs on the scratch branch are left to finish; stale ones, and a refused landing's, are cancelled", async () => {
  const c = ciSetup(2, { stack: '1' });
  const full = (sha: string) => git(c.main, 'rev-parse', sha);
  const cancelled = () => [...readFileSync(join(c.ci, 'gh.log'), 'utf8').matchAll(/actions\/runs\/(\d+)\/cancel/g)].map((m) => m[1]);
  try {
    const a = c.land(1);
    const sha = await c.tip(a);
    const old = 'b'.repeat(40); // an older commit of this branch, pushed by an earlier try: it won't land
    writeFileSync(join(c.ci, 'branch-runs'), `11\t${full(sha)}\n12\t${old}\n`);
    c.verdict(sha, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.deepEqual(cancelled(), ['12'], 'the landed run goes on; the stale one is cancelled');
    // The next landing's cleanup before its push spares the landed run too; a refused landing's run is cancelled.
    writeFileSync(join(c.ci, 'gh.log'), '');
    writeFileSync(join(c.ci, 'branch-runs'), `11\t${full(sha)}\n12\t${old}\n`);
    const b = c.land(2);
    const shb = await c.tip(b);
    writeFileSync(join(c.ci, 'branch-runs'), `11\t${full(sha)}\n21\t${full(shb)}\n`);
    c.verdict(shb, RED);
    assert.equal(await b.exit, 1, b.stderr());
    assert.deepEqual(cancelled(), ['12', '21'], 'nothing landed, so its run is cancelled; the landed one still goes on');
  } finally {
    c.stop();
  }
});

test('the stack: three in line run CI at once, each on top of the one ahead, and land in order on one run each', async () => {
  const c = ciSetup(3);
  try {
    const [a, b, d] = await c.lands(1, 2, 3);
    const [ta, tb, td] = [await c.tip(a), await c.tip(b), await c.tip(d)];
    assert.equal(c.parent(tb), ta, "the 2nd is built on the 1st's commit");
    assert.equal(c.parent(td), tb, "the 3rd on the 2nd's");
    assert.match(b.stderr(), /rebasing ticket\/2-x onto ticket\/1-x's commit [0-9a-f]{12}, 2nd in line/);
    assert.deepEqual(c.scratch(), [`land/ticket/1-x ${ta}`, `land/ticket/2-x ${tb}`, `land/ticket/3-x ${td}`]);
    assert.equal(git(c.main, 'rev-list', '--count', 'main..ticket/2-x'), '1', "the 2nd's branch holds only its own commit while it is stacked");
    // The last one's run ends first: nothing lands until the head's does.
    c.verdict(td, GREEN);
    c.verdict(tb, GREEN);
    await until('the 3rd to see its green run', () => /CI is green/.test(d.stderr()));
    assert.deepEqual(c.landed(), []);
    c.verdict(ta, GREEN);
    for (const l of [a, b, d]) assert.equal(await l.exit, 0, l.stderr());
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3']);
    assert.equal(c.mainAt(), td, 'main is the very commit CI passed for the 3rd');
    for (const l of [a, b, d]) assert.equal(c.sent(l).length, 1, `one CI run each: ${l.stderr()}`);
    assert.deepEqual(c.scratch(), []);
    assert.deepEqual([1, 2, 3].map(c.on), ['ticket/1-x', 'ticket/2-x', 'ticket/3-x']);
    assert.equal(git(c.origin, 'rev-parse', 'main').slice(0, 12), td);
    assert.deepEqual(c.tickets(), []);
    assert.ok(landLockFree(c));
  } finally {
    c.stop();
  }
});

test('the stack: a red run in the middle is refused, and the one behind it builds again on the one ahead and lands', async () => {
  const c = ciSetup(3);
  try {
    const [a, b, d] = await c.lands(1, 2, 3);
    const [ta, tb, td] = [await c.tip(a), await c.tip(b), await c.tip(d)];
    c.verdict(td, RED); // red only because it sits on the 2nd: not believed while the 2nd hasn't landed
    await until('the 3rd to see red', () => /CI is red/.test(d.stderr()));
    assert.match(d.stderr(), /sits on ticket\/2-x's, which hasn't landed: waiting to see whether it does/);
    c.verdict(tb, RED);
    await until('the 2nd to see red', () => /CI is red/.test(b.stderr()));
    assert.equal(c.parent(await c.tip(d, 2)), ta, "the 3rd builds again on the 1st's commit at once, past the red 2nd");
    await sleep(300);
    assert.equal(b.child.exitCode, null, 'the 2nd waits too: the 1st may yet be why it is red');
    c.verdict(ta, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await b.exit, 1, b.stderr());
    assert.match(b.stderr(), /CI is red on [0-9a-f]{12} \(above\), so main is untouched/);
    const again = await c.tip(d, 2);
    assert.equal(c.parent(again), ta, "the 3rd is built again on the 1st's commit, which is main now");
    assert.deepEqual(c.landed(), ['f1.txt: 1']);
    c.verdict(again, GREEN);
    assert.equal(await d.exit, 0, d.stderr());
    assert.doesNotMatch(d.stderr(), /rebasing ticket\/3-x onto main/, 'the 3rd kept the run it had on the 1st\'s commit: it is not built a third time once the red 2nd is all that is ahead (#560)');
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f3.txt: 3'], "none of the 2nd's commits reached main");
    assert.equal(c.mainAt(), again);
    assert.equal(c.on(2), 'ticket/2-x');
    assert.equal(git(c.wts[1], 'log', '--format=%s', 'main..ticket/2-x'), 'f2.txt: 2', "the 2nd's branch holds its own commit only");
    assert.deepEqual(c.scratch(), []);
  } finally {
    c.stop();
  }
});

test('the stack: a run lost mid-way is run again on the same commit, and the one behind keeps its run', async () => {
  const c = ciSetup(3);
  try {
    const [a, b, d] = await c.lands(1, 2, 3);
    const [ta, tb, td] = [await c.tip(a), await c.tip(b), await c.tip(d)];
    c.verdict(tb, LOST, true);
    assert.equal(await c.tip(b, 2), tb, 'the same commit goes to CI again');
    assert.match(b.stderr(), /ended without a verdict \(a runner lost mid-run, or the run cancelled\): running it again, once/);
    c.verdict(tb, GREEN);
    c.verdict(td, GREEN);
    c.verdict(ta, GREEN);
    for (const l of [a, b, d]) assert.equal(await l.exit, 0, l.stderr());
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3']);
    assert.equal(c.sent(d).length, 1, 'the 3rd kept its run');
    assert.equal(c.mainAt(), td);
  } finally {
    c.stop();
  }
});

test('the stack: a run lost twice parks that landing with exit 75, and the one behind builds again', async () => {
  const c = ciSetup(2);
  try {
    const [a, b] = await c.lands(1, 2);
    const [ta, tb] = [await c.tip(a), await c.tip(b)];
    c.verdict(ta, LOST);
    assert.equal(await a.exit, 75, a.stderr());
    assert.match(a.stderr(), /ended without a verdict a second time/);
    const again = await c.tip(b, 2);
    assert.notEqual(again, tb);
    assert.equal(c.parent(again), c.mainAt(), 'the 2nd is built again on main');
    c.verdict(again, GREEN);
    assert.equal(await b.exit, 0, b.stderr());
    assert.deepEqual(c.landed(), ['f2.txt: 2']);
    assert.equal(c.on(1), 'ticket/1-x');
  } finally {
    c.stop();
  }
});

test('the stack: when the head is killed mid-CI the ones behind build again on main, and its branch is as it was', async () => {
  const c = ciSetup(3);
  try {
    const was = git(c.wt, 'rev-parse', 'ticket/1-x');
    const [a, b, d] = await c.lands(1, 2, 3);
    const [, tb, td] = [await c.tip(a), await c.tip(b), await c.tip(d)];
    a.child.kill('SIGKILL');
    const [tb2, td2] = [await c.tip(b, 2), await c.tip(d, 2)];
    assert.notEqual(tb2, tb);
    assert.notEqual(td2, td);
    assert.equal(c.parent(tb2), c.mainAt());
    assert.equal(c.parent(td2), tb2);
    c.verdict(tb2, GREEN);
    c.verdict(td2, GREEN);
    assert.equal(await b.exit, 0, b.stderr());
    assert.equal(await d.exit, 0, d.stderr());
    assert.deepEqual(c.landed(), ['f2.txt: 2', 'f3.txt: 3']);
    // The killed one: its worktree is left on the detached commit, its branch where it was. Run again, it lands.
    assert.equal(c.on(1), '');
    assert.equal(git(c.wt, 'rev-parse', 'ticket/1-x'), was);
    const a2 = c.land(1);
    c.verdict(await c.tip(a2), GREEN);
    assert.equal(await a2.exit, 0, a2.stderr());
    assert.match(a2.stderr(), /an earlier landing here was stopped mid-way: .* is back on ticket\/1-x as it was/);
    assert.deepEqual(c.landed(), ['f2.txt: 2', 'f3.txt: 3', 'f1.txt: 1']);
  } finally {
    c.stop();
  }
});

test('the stack: a stacked landing that is killed and run again lands none of the unlanded commits it sat on', async () => {
  const c = ciSetup(3);
  try {
    const [a, b, d] = await c.lands(1, 2, 3);
    const [ta, tb] = [await c.tip(a), await c.tip(b), await c.tip(d)];
    d.child.kill('SIGKILL'); // its worktree now sits on a commit holding the 1st's and the 2nd's work
    await d.exit;
    assert.equal(git(c.wts[2], 'log', '--topo-order', '--format=%s', 'main..HEAD'), 'f3.txt: 3\nf2.txt: 2\nf1.txt: 1');
    c.verdict(tb, RED);
    c.verdict(ta, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await b.exit, 1, b.stderr());
    const d2 = c.land(3);
    const again = await c.tip(d2);
    assert.equal(c.parent(again), ta);
    c.verdict(again, GREEN);
    assert.equal(await d2.exit, 0, d2.stderr());
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f3.txt: 3']);
  } finally {
    c.stop();
  }
});

test('the stack: a conflict with an unlanded commit ahead waits; it lands if that one fails, and is refused if that one lands', async () => {
  for (const ahead of [RED, GREEN]) {
    // The 2nd and the 3rd both rewrite a.txt; the 1st touches something else.
    const c = ciSetup(3, { files: (i) => (i === 1 ? 'f1.txt' : 'a.txt') });
    try {
      const mine = git(c.wts[2], 'rev-parse', 'HEAD');
      const [a, b, d] = await c.lands(1, 2, 3);
      const [ta, tb] = [await c.tip(a), await c.tip(b)];
      await until('the 3rd to meet the conflict', () => /on top of ticket\/2-x's commit, which hasn't landed: the rebase onto main failed/.test(d.stderr()));
      assert.deepEqual(c.sent(d), [], 'nothing of the 3rd went to CI');
      c.verdict(tb, ahead);
      c.verdict(ta, GREEN);
      assert.equal(await a.exit, 0, a.stderr());
      if (ahead === RED) {
        assert.equal(await b.exit, 1, b.stderr());
        const sha = await c.tip(d);
        assert.equal(c.parent(sha), ta);
        c.verdict(sha, GREEN);
        assert.equal(await d.exit, 0, d.stderr());
        assert.deepEqual(c.landed(), ['f1.txt: 1', 'a.txt: 3']);
      } else {
        assert.equal(await b.exit, 0, b.stderr());
        assert.equal(await d.exit, 1, d.stderr());
        assert.match(d.stderr(), /the rebase onto main failed/);
        assert.deepEqual(c.landed(), ['f1.txt: 1', 'a.txt: 2']);
        assert.equal(c.on(3), 'ticket/3-x');
        assert.equal(git(c.wts[2], 'rev-parse', 'HEAD'), mine, 'the branch is where it was');
        assert.equal(git(c.wts[2], 'status', '--porcelain'), '');
      }
    } finally {
      c.stop();
    }
  }
});

test('the stack: the 4th in line builds nothing until a place frees, and a red check stacked on unlanded work waits like red CI', async () => {
  // The check is red for the 3rd only while the 2nd's file is there too.
  const c = ciSetup(4, { check: '[ ! -e f3.txt ] || [ ! -e f2.txt ]' });
  try {
    const lands = await c.lands(1, 2, 3);
    const [ta, tb] = [await c.tip(lands[0]), await c.tip(lands[1])];
    await until('the 3rd to fail its check on the 2nd', () => /which hasn't landed: the check failed/.test(lands[2].stderr()));
    lands.push(c.land(4));
    await until('the 4th to say its place', () => /4th in line/.test(lands[3].stderr()));
    await sleep(300);
    assert.doesNotMatch(lands[3].stderr(), /rebasing/, 'the 4th is outside the stack');
    assert.equal(lands[2].child.exitCode, null, 'the 3rd waits');
    c.verdict(tb, RED);
    c.verdict(ta, GREEN);
    assert.equal(await lands[0].exit, 0, lands[0].stderr());
    assert.equal(await lands[1].exit, 1, lands[1].stderr());
    const tc = await c.tip(lands[2]); // without the 2nd under it, its check passes
    const td = await c.tip(lands[3]);
    assert.equal(c.parent(tc), ta);
    assert.equal(c.parent(td), tc, 'the 4th joined the stack');
    c.verdict(tc, GREEN);
    c.verdict(td, GREEN);
    assert.equal(await lands[2].exit, 0, lands[2].stderr());
    assert.equal(await lands[3].exit, 0, lands[3].stderr());
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f3.txt: 3', 'f4.txt: 4']);
  } finally {
    c.stop();
  }
});

test('the stack: nobody builds on a ticket from a land.sh older than the stack, and a commit made on main under the head is built on again', async () => {
  const c = ciSetup(1);
  // A four-line ticket, first in line, for a process that stays alive.
  const older = spawn('sleep', ['600'], { stdio: 'ignore' });
  try {
    const stat = readFileSync(`/proc/${older.pid}/stat`, 'utf8');
    mkdirSync(join(c.state, 'land-queue'));
    writeFileSync(join(c.state, 'land-queue', '0000000001'), `${older.pid} ${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}\n0\nticket/0-old\nrunning the check since 10:00\n`);
    writeFileSync(join(c.state, 'land-queue', '.seq'), '1\n');
    const a = c.land(1);
    await until('it to say its place', () => /2nd in line for the land lock, about 5 min \(ahead: ticket\/0-old, running the check since 10:00\)/.test(a.stderr()));
    await sleep(300);
    assert.doesNotMatch(a.stderr(), /rebasing/);
    older.kill('SIGKILL');
    const first = await c.tip(a);
    c.commit(c.main, 'c.txt', 'made on main by hand\n');
    const second = await c.tip(a, 2);
    assert.equal(c.parent(second), c.mainAt());
    c.verdict(first, GREEN); // the run nobody waits for
    await sleep(300);
    assert.deepEqual(c.landed(), ['c.txt: made on main by hand']);
    c.verdict(second, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.deepEqual(c.landed(), ['c.txt: made on main by hand', 'f1.txt: 1']);
  } finally {
    older.kill('SIGKILL');
    c.stop();
  }
});

test("CI gate: the built-in reader takes the newest run of each workflow, the worst of them, and tells a lost runner from a red step", async () => {
  const c = ciSetup(1, { builtin: true });
  const run = (workflow: string, id: number, status: string, result: string) => `.github/workflows/${workflow}\t${id}\t${status}\t${result}\thttps://ci.test/${id}\n`;
  const runs = (...rows: string[]) => writeFileSync(join(c.ci, 'runs.tsv'), rows.join(''));
  const gh = () => readFileSync(join(c.ci, 'gh.log'), 'utf8');
  try {
    const a = c.land(1);
    const sha = await c.tip(a);
    assert.match(gh(), new RegExp(`api repos/.*/actions/runs\\?head_sha=${sha}`), 'it asks about the exact commit');
    // One workflow green, the other still running: not green.
    runs(run('ci.yml', 2, 'completed', 'success'), run('slow.yml', 3, 'in_progress', '-'));
    await sleep(400);
    assert.deepEqual(c.landed(), []);
    // The newest run of slow.yml failed with no failed step (its runner went away); an older green one doesn't count.
    writeFileSync(join(c.ci, 'failed-steps'), '0\n');
    writeFileSync(join(c.ci, 'runs.once.tsv'), [run('ci.yml', 2, 'completed', 'success'), run('slow.yml', 5, 'completed', 'failure'), run('slow.yml', 1, 'completed', 'success')].join(''));
    await c.tip(a, 2);
    assert.match(a.stderr(), /slow\.yml: completed failure https:\/\/ci\.test\/5/);
    assert.match(a.stderr(), /running it again, once/);
    // The new run fails in a step: red.
    writeFileSync(join(c.ci, 'failed-steps'), '1\n');
    runs(run('ci.yml', 2, 'completed', 'success'), run('slow.yml', 7, 'completed', 'failure'));
    assert.equal(await a.exit, 1, a.stderr());
    assert.match(a.stderr(), /CI is red on/);
    assert.deepEqual(c.landed(), []);
    // Green on both: lands, without a push, since the commit's runs already passed.
    runs(run('ci.yml', 2, 'completed', 'success'), run('slow.yml', 6, 'completed', 'success'));
    const b = c.land(1);
    assert.equal(await b.exit, 0, b.stderr());
    assert.match(b.stderr(), /CI already passed/);
    assert.deepEqual(c.landed(), ['f1.txt: 1']);
  } finally {
    c.stop();
  }
});

test('CI gate: an old red run of the same commit is not believed just after the push; a run queued behind busy runners waits, and no answer at all says so', async () => {
  const c = ciSetup(1, { stack: '1' });
  try {
    // Main hasn't moved, so the commit CI gets is the branch's own: red from an earlier try.
    const sha = git(c.wt, 'rev-parse', 'HEAD').slice(0, 12);
    c.verdict(sha, RED);
    const a = c.land(1, { LAND_CI_GRACE: '600', LAND_CI_START: '1' });
    assert.equal(await c.tip(a), sha, 'it starts a new run');
    writeFileSync(join(c.ci, 'busy'), '2\n');
    await until('it to see the runners are busy', () => /runners are busy with other runs: still waiting/.test(a.stderr()));
    assert.equal(a.child.exitCode, null, 'neither refused on the old red nor parked');
    c.verdict(sha, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    // A verdict command that can't answer: it parks saying that, not that the runners are off.
    c.commit(c.wt, 'g.txt', 'more\n');
    const b = c.land(1, { LAND_CI_START: '1' });
    c.verdict(await c.tip(b), 5);
    assert.equal(await b.exit, 75, b.stderr());
    assert.match(b.stderr(), /CI gave no answer about [0-9a-f]{12} for 1 min \(exit 5 from "\$CI_FAKE"; above\)/);
  } finally {
    c.stop();
  }
});

test('the stack: a commit made on the detached HEAD a killed landing left is not thrown away', async () => {
  const c = ciSetup(1, { stack: '1' });
  try {
    const a = c.land(1);
    await c.tip(a);
    a.child.kill('SIGKILL');
    await a.exit;
    c.commit(c.wt, 'late.txt', 'made on the detached commit\n');
    const again = c.land(1);
    assert.equal(await again.exit, 1, again.stderr());
    assert.match(again.stderr(), /left .* on a detached commit \([0-9a-f]{12}\), and HEAD has moved since\. If you committed here, put those commits on ticket\/1-x/);
    assert.equal(git(c.wt, 'log', '-1', '--format=%s'), 'late.txt: made on the detached commit', 'the commit is still there');
    assert.deepEqual(c.landed(), []);
  } finally {
    c.stop();
  }
});

test('CI gate: a commit put on the branch while its landing waited is not landed around, and the branch keeps it', async () => {
  const c = ciSetup(1);
  try {
    const a = c.land(1, { LAND_STACK_DEPTH: '2' });
    const sha = await c.tip(a);
    git(c.main, 'branch', '-f', 'ticket/1-x', git(c.main, 'commit-tree', '-p', 'ticket/1-x', '-m', 'late', 'ticket/1-x^{tree}'));
    const late = git(c.main, 'rev-parse', 'ticket/1-x');
    c.verdict(sha, GREEN);
    assert.equal(await a.exit, 1, a.stderr());
    assert.match(a.stderr(), /moved while the landing waited, so what CI passed is not what is here now and nothing landed/);
    assert.deepEqual(c.landed(), []);
    assert.equal(git(c.wt, 'rev-parse', 'HEAD'), late, 'the worktree is back on the branch, late commit and all');
    assert.equal(spawnSync('bash', [join(c.wt, 'tools', 'land.sh')], { cwd: c.wt, encoding: 'utf8', env: { ...env, LAND_STACK_DEPTH: '0' } }).stderr.trim(), 'land: CI_STACK is a number from 1 up, not "0"');
  } finally {
    c.stop();
  }
});
