// The line for the deploy lock that tools/land.sh waits in.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { root, env, git, setup, landAsync, tickets, issued } from './land-fixture.ts';
import { until } from './wait.ts';

// The line for the deploy lock (tools/deploy-queue.sh, #502). The kernel grants a flock in no order, so ten
// landings waiting on it at once (2026-11-10) meant some lost every round and timed out.

test('ten landings started together land in the order they arrived, each told its place in line', async () => {
  const r = setup();
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  const extra = { DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), FAKE_DEPLOY_GATE: join(r.dir, 'gate'), DEPLOY_QUEUE_POLL: '0.05' };
  const wts = [r.wt];
  for (let i = 2; i <= 10; i++) git(r.source, 'worktree', 'add', '-q', '-b', `ticket/${i}-x`, wts[wts.push(join(r.dir, `wt${i}`)) - 1]);
  wts.forEach((wt, i) => r.commit(wt, `f${i + 1}.txt`, `${i + 1}\n`));
  const lands: ReturnType<typeof landAsync>[] = [];
  let last = '';
  for (let i = 1; i <= 10; i++) {
    lands.push(landAsync(wts[i - 1], extra, 120_000, (stderr) => i === 10 && (last = stderr)));
    await until(`landing ${i}'s ticket`, () => issued(state) === i); // arrival order is the order of the tickets
  }
  // The first holds the lock until all ten are in line and the last has been told its place.
  await until('the last to say its place', () => /queue: 10th in line for the deploy lock, about 45 min \(ahead: ticket\/1-x, deploying\)/.test(last));
  writeFileSync(join(r.dir, 'gate'), '');
  const done = await Promise.all(lands);
  done.forEach((d, i) => assert.equal(d.status, 0, `landing ${i + 1}: ${d.stderr}`));
  assert.deepEqual(git(r.source, 'log', '--reverse', '--format=%s', 'main').split('\n'), ['base', ...done.map((_, i) => `f${i + 1}.txt: ${i + 1}`)]);
  assert.doesNotMatch(done[0].stderr, /in line/, 'the first had nobody to wait for');
  assert.match(done[9].stderr, /queue: 2nd in line for the deploy lock, about \d+ min \(ahead: ticket\/9-x, /);
  assert.match(done[9].stderr, /queue: got the deploy lock/);
  assert.deepEqual(tickets(state), [], 'every ticket is gone');
  assert.equal(readFileSync(join(state, 'queue', '.took'), 'utf8').trim().split('\n').length, 5, 'the newest five landings were timed, for the estimate');
  assert.equal(spawnSync('flock', ['-n', join(state, 'lock'), 'true']).status, 0, 'the deploy lock is free');
});

test('a landing waiting in line rechecks each time main moves, and leaves the line at once when it would conflict (#770)', async () => {
  const r = setup();
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  const shared = join(r.dir, 'shared');
  const extra = { DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), FAKE_DEPLOY_GATE: join(r.dir, 'gate'), DEPLOY_QUEUE_POLL: '0.05', COORDINATOR_SHARED_DIR: shared };
  const wt2 = join(r.dir, 'wt2');
  git(r.source, 'worktree', 'add', '-q', '-b', 'ticket/2-x', wt2);
  r.commit(r.wt, 'f1.txt', '1\n');
  r.commit(wt2, 'a.txt', 'mine\n');
  try {
    const first = landAsync(r.wt, extra, 60_000);
    await until('landing 1 to hold the lock in its deploy', () => r.note() !== null);
    let said = '';
    const second = landAsync(wt2, extra, 60_000, (stderr) => (said = stderr));
    await until('landing 2 to wait in line', () => /2nd in line/.test(said));
    // main moved (landing 1's own commit is on it already): a clean move keeps it in line.
    r.commit(r.source, 'b.txt', 'clean\n');
    await new Promise((ok) => setTimeout(ok, 500));
    assert.equal(tickets(state).length, 2, 'still in line after a clean move');
    r.commit(r.source, 'a.txt', 'theirs\n');
    const main = git(r.source, 'rev-parse', 'main');
    const out = await second;
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`land: ticket/2-x won't rebase onto main \\(${main.slice(0, 7)} "a\\.txt: theirs"\\) cleanly, by git merge-tree waiting in line, so nothing landed; conflicted files: a\\.txt\\. On conflicts: run git rebase main`));
    const log = readFileSync(join(shared, 'retro-log', readdirSync(join(shared, 'retro-log'))[0], 'land.md'), 'utf8');
    assert.match(log, new RegExp(`· land conflict · ticket/2-x onto ${main.slice(0, 7)}: a\\.txt · waiting in line$`, 'm'));
    assert.equal(tickets(state).length, 1, 'its ticket is gone, the holder keeps its own');
    assert.equal(git(wt2, 'status', '--porcelain'), '');
    writeFileSync(join(r.dir, 'gate'), '');
    const held = await first;
    assert.equal(held.status, 0, held.stderr);
  } finally {
    writeFileSync(join(r.dir, 'gate'), '');
  }
});

// Fake work for the line itself: wait in line, note the turn, then hold the lock while $3 runs.
const queueLib = join(import.meta.dirname, '..', 'tools', 'deploy-queue.sh');
// `old`: a landing from a branch before #1002, whose queue_lock waits for every lower ticket and ignores .order.
const before1002 = `queue_order() { QUEUE_RANK=() QUEUE_ORDER_BY=""; }; queue_write() { printf '%s\\n' "$2" "$3" "$4" "$5" >"$1.tmp$$" && mv -f "$1.tmp$$" "$1"; }; `;
function waiter(state: string, label: string, work: string, extra: Record<string, string> = {}, old = false) {
  const child = spawn('bash', ['-c', `. "$0"; ${old ? before1002 : ''}queue_lock "$1" "$2" || exit 1; echo "$2" >>"$1/order"; eval "$3"; queue_done ok`, queueLib, state, label, work], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, DEPLOY_QUEUE_POLL: '0.05', ...extra } });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += d));
  const exit = new Promise<number | null>((ok) => child.on('close', ok));
  return { child, exit, stderr: () => stderr };
}
const order = (state: string) => (existsSync(join(state, 'order')) ? readFileSync(join(state, 'order'), 'utf8').trim().split('\n') : []);
let n = 0; // queueState's own count; setup() keeps its own in land-fixture.ts
const queueState = () => {
  const state = join(root, `queue-${++n}`);
  mkdirSync(state);
  return state;
};

test('a waiter that is killed leaves the line, and the one behind it goes next', async () => {
  const state = queueState();
  const a = waiter(state, 'a', `until [ -e '${state}/go' ]; do sleep 0.05; done`);
  let c: ReturnType<typeof waiter> | undefined;
  try {
    await until('a to hold the lock', () => order(state).length === 1);
    const b = waiter(state, 'b', 'true');
    await until("b's ticket", () => issued(state) === 2);
    c = waiter(state, 'c', 'true');
    const cs = c.stderr;
    await until('c to see its place', () => /3rd in line/.test(cs()));
    const [ta, , tc] = tickets(state);
    assert.ok(tc, 'three tickets in line');
    b.child.kill('SIGKILL');
    await b.exit;
    // Not counted right after the kill: c may already have removed it by then.
    await until('c to move up past the dead ticket', () => /2nd in line/.test(cs()));
    assert.deepEqual(tickets(state), [ta, tc], "the waiter behind it removed the killed waiter's ticket");
    writeFileSync(join(state, 'go'), '');
    assert.equal(await a.exit, 0);
    assert.equal(await c.exit, 0, c.stderr());
    assert.deepEqual(order(state), ['a', 'c']);
  } finally {
    writeFileSync(join(state, 'go'), ''); // a failed check must not leave a and c waiting, which hangs the file
    c?.child.kill('SIGKILL');
  }
});

// A zombie: b's parent starts it, then becomes a sleep that never waits on it, so once b is killed its
// /proc entry stays, start time and all, until the parent goes.
const isZombie = (pid: number) => { try { return /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };

test('a killed waiter whose parent never reaps it leaves the line too', async () => {
  const state = queueState();
  const a = waiter(state, 'a', `until [ -e '${state}/go' ]; do sleep 0.05; done`);
  let c: ReturnType<typeof waiter> | undefined;
  let parent: ReturnType<typeof spawn> | undefined;
  try {
    await until('a to hold the lock', () => order(state).length === 1);
    parent = spawn('bash', ['-c', 'bash -c \'. "$0"; queue_lock "$1" b\' "$0" "$1" & echo $! >"$1/b.pid"; exec sleep 600', queueLib, state], { stdio: 'ignore', env: { ...env, DEPLOY_QUEUE_POLL: '0.05' } });
    await until("b's ticket", () => issued(state) === 2);
    c = waiter(state, 'c', 'true');
    const cs = c.stderr;
    await until('c to see its place', () => /3rd in line/.test(cs()));
    const [ta, , tc] = tickets(state);
    assert.ok(tc, 'three tickets in line');
    const b = Number(readFileSync(join(state, 'b.pid'), 'utf8'));
    process.kill(b, 'SIGKILL');
    await until('b to be a zombie', () => isZombie(b));
    await until('c to move up past the zombie', () => /2nd in line/.test(cs()));
    assert.deepEqual(tickets(state), [ta, tc], "the zombie's ticket was removed");
    assert.ok(isZombie(b), 'b was still a zombie when c moved up');
    writeFileSync(join(state, 'go'), '');
    assert.equal(await a.exit, 0);
    assert.equal(await c.exit, 0, c.stderr());
    assert.deepEqual(order(state), ['a', 'c']);
  } finally {
    writeFileSync(join(state, 'go'), '');
    c?.child.kill('SIGKILL');
    parent?.kill('SIGKILL');
  }
});

test('a holder that is killed leaves the line too, and its lock goes with it', async () => {
  const state = queueState();
  const a = waiter(state, 'a', 'exec sleep 600');
  await until('a to hold the lock', () => order(state).length === 1);
  const b = waiter(state, 'b', 'true');
  await until('b to wait', () => /2nd in line/.test(b.stderr()));
  a.child.kill('SIGKILL');
  assert.equal(await b.exit, 0, b.stderr());
  assert.deepEqual(order(state), ['a', 'b']);
});

test('waiters outlast the stall limit while the holder moves on, and give up once nothing moves', async () => {
  const state = queueState();
  // Three seconds of work in phases, against a two-second limit on no progress (bash counts whole seconds, so it can be a second short).
  const a = waiter(state, 'a', `for i in $(seq 10); do queue_phase "step $i"; sleep 0.3; done; touch '${state}/stuck'; exec sleep 600`);
  await until('a to hold the lock', () => order(state).length === 1);
  const b = waiter(state, 'b', 'true', { DEPLOY_QUEUE_STALL: '2' });
  const t = Date.now();
  assert.equal(await b.exit, 1, 'it gives up in the end');
  try {
    assert.ok(existsSync(join(state, 'stuck')), `not while the holder was still moving: gave up after ${Date.now() - t} ms\n${b.stderr()}`);
    assert.match(b.stderr(), /2nd in line for the deploy lock, about 5 min \(ahead: a, step 1\)/);
    assert.match(b.stderr(), /nothing has moved for .* \(ahead: a, step 10; pid \d+, state \w; the lock is held\), so this gave up/);
    assert.deepEqual(tickets(state).length, 1, 'its ticket went with it');
    assert.deepEqual(order(state), ['a']);
  } finally {
    a.child.kill('SIGKILL');
  }
});

test('the head of the line waits for a lock held outside it (the queued restart), and the estimate comes from past landings', async () => {
  const state = queueState();
  mkdirSync(join(state, 'queue'));
  writeFileSync(join(state, 'queue', '.took'), '100\n140\n');
  const restart = spawn('bash', ['-c', 'exec 9>"$0"; flock 9; exec sleep 600', join(state, 'lock')], { stdio: 'ignore' }); // one process, so killing it frees the lock
  try {
    await until('the lock to be held', () => spawnSync('flock', ['-n', join(state, 'lock'), 'true']).status !== 0);
    const a = waiter(state, 'a', 'sleep 1.2');
    await until('a to say it waits', () => /next in line for the deploy lock \(ahead: outside the line, the lock is open in pid \d+ \(sleep 600\)\)/.test(a.stderr()));
    const b = waiter(state, 'b', 'true');
    await until('b to say its place', () => /2nd in line for the deploy lock, about 2 min \(ahead: a, waiting\)/.test(b.stderr()));
    assert.deepEqual(order(state), []);
    restart.kill('SIGKILL');
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await b.exit, 0, b.stderr());
    assert.deepEqual(order(state), ['a', 'b']);
    // Each noted how long it held the lock; a held it for a second or two.
    const took = readFileSync(join(state, 'queue', '.took'), 'utf8').trim().split('\n').map(Number);
    assert.equal(took.length, 4);
    assert.ok(took[2] >= 1 && took[2] <= 30, `a's time: ${took[2]}`);
  } finally {
    restart.kill('SIGKILL');
  }
});

// The pipeline failure drill's F3 (#553): a SIGSTOP stops a waiter (state T). It holds nothing, yet everyone behind it
// waited on it with the lock free, and gave up. A frozen cgroup is below.
test('a waiter that is frozen is passed over: the one behind it takes the lock, and it goes when it wakes', { timeout: 60_000 }, async () => {
  const state = queueState();
  const a = waiter(state, 'a', `until [ -e '${state}/go' ]; do sleep 0.05; done`);
  let b: ReturnType<typeof waiter> | undefined;
  let c: ReturnType<typeof waiter> | undefined;
  try {
    // a first: started together, b can take the first ticket under load and never be 2nd (#564).
    await until('a to hold the lock', () => order(state).length === 1);
    b = waiter(state, 'b', 'true');
    const bs = b.stderr;
    await until('b to say its place', () => /2nd in line/.test(bs()));
    process.kill(b.child.pid!, 'SIGSTOP');
    c = waiter(state, 'c', `until [ -e '${state}/go2' ]; do sleep 0.05; done`, { DEPLOY_QUEUE_STALL: '3' });
    const cs = c.stderr;
    await until('c to say its place', () => /in line/.test(cs()));
    writeFileSync(join(state, 'go'), '');
    await until('c to take the lock', () => order(state).length === 2);
    assert.deepEqual(order(state), ['a', 'c']);
    // Awake again while the one that passed it has the lock: that is a landing in line, not something outside it, and
    // like any holder it is ahead of every waiter (#1002).
    process.kill(b.child.pid!, 'SIGCONT');
    await until('b to say what it waits for now', () => /2nd in line for the deploy lock, about \d+ min \(ahead: c, starting\)/.test(b.stderr()));
    assert.doesNotMatch(b.stderr(), /outside the line/);
    writeFileSync(join(state, 'go2'), '');
    assert.equal(await c.exit, 0, cs());
    assert.equal(await b.exit, 0, b.stderr());
    assert.deepEqual(order(state), ['a', 'c', 'b']);
  } finally {
    for (const w of [a, b, c]) w?.child.kill('SIGKILL');
  }
});

// A waiter frozen with `systemctl freeze` (the cgroup freezer, #585) shows state S, not T. Its cgroup's cgroup.events
// says "frozen 1": that counts as stopped too. A fake cgroup root stands in for /sys/fs/cgroup, so nothing real is frozen.
function frozenWaiter(state: string, label: string) {
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  const pid = sleeper.pid!;
  const start = readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[19];
  const cg = readFileSync(`/proc/${pid}/cgroup`, 'utf8').match(/^0::(.*)$/m)![1];
  const fake = join(state, 'cgroup');
  mkdirSync(join(fake, cg), { recursive: true });
  writeFileSync(join(fake, cg, 'cgroup.events'), 'populated 1\nfrozen 1\n');
  mkdirSync(join(state, 'queue'), { recursive: true });
  writeFileSync(join(state, 'queue', '0000000001'), `${pid} ${start}\n0\n${label}\nwaiting\n`);
  writeFileSync(join(state, 'queue', '.seq'), '1\n');
  return { sleeper, cgroupRoot: fake };
}

test('a waiter whose cgroup is frozen (state S) is passed over like a stopped one: the one behind it takes the free lock', { timeout: 60_000 }, async () => {
  const state = queueState();
  const f = frozenWaiter(state, 'frozen');
  let c: ReturnType<typeof waiter> | undefined;
  try {
    await until('the frozen one to be in state S, as a frozen cgroup leaves it', () => /\) S /.test(readFileSync(`/proc/${f.sleeper.pid}/stat`, 'utf8')));
    c = waiter(state, 'c', 'true', { DEPLOY_QUEUE_STALL: '3', DEPLOY_QUEUE_CGROUP: f.cgroupRoot });
    assert.equal(await c.exit, 0, c.stderr());
    assert.deepEqual(order(state), ['c']);
    assert.ok(existsSync(join(state, 'queue', '0000000001')), 'the frozen one keeps its place, to go when it thaws');
  } finally {
    f.sleeper.kill('SIGKILL');
    c?.child.kill('SIGKILL');
  }
});

test('giving up names the process at the head of the line, its state and whether the lock is held', { timeout: 60_000 }, async () => {
  const state = queueState();
  const a = waiter(state, 'a', 'exec sleep 60'); // exec: the same pid, so killing it leaves nothing behind
  let b: ReturnType<typeof waiter> | undefined;
  try {
    await until('a to hold the lock', () => order(state).length === 1);
    process.kill(a.child.pid!, 'SIGSTOP'); // the holder itself is frozen: nobody can pass it
    b = waiter(state, 'b', 'true', { DEPLOY_QUEUE_STALL: '2' });
    assert.equal(await b.exit, 1, b.stderr());
    assert.match(b.stderr(), new RegExp(`nothing has moved for 0 min \\(ahead: a, starting; pid ${a.child.pid}, stopped; the lock is held\\), so this gave up`));
  } finally {
    for (const w of [a, b]) w?.child.kill('SIGKILL');
  }
});

// F8: an orphan of a killed landing (its test run, its boot check) keeps the lock with no ticket, and the waiters
// were told "a queued restart, or a landing started from a branch older than the line", which it never was.
test('a waiter behind a lock held from outside the line names the process that holds it, and not the waiters behind or their children', { timeout: 60_000 }, async () => {
  const state = queueState();
  const outside = spawn('bash', ['-c', 'exec 9>"$0"; flock 9; exec sleep 41', join(state, 'lock')], { stdio: 'ignore' }); // one process, the lock on its fd 9
  const ws: ReturnType<typeof waiter>[] = [];
  try {
    await until('the lock to be held', () => spawnSync('flock', ['-n', join(state, 'lock'), 'true']).status !== 0);
    const b = ws[ws.push(waiter(state, 'b', 'true', { DEPLOY_QUEUE_STALL: '2' })) - 1];
    await until('b to say what it waits for', () => /next in line/.test(b.stderr()));
    // Two behind it, whose own children (the sleep between polls) have the lock file open too.
    const [c, d] = [waiter(state, 'c', 'true'), waiter(state, 'd', 'true')];
    ws.push(c, d);
    assert.equal(await b.exit, 1, b.stderr());
    const named = new RegExp(`\\(ahead: outside the line, the lock is open in pid ${outside.pid} \\(sleep 41\\)\\)`, 'g');
    assert.equal(b.stderr().match(named)?.length, 2, `when it arrived and when it gave up, the holder and nothing else:\n${b.stderr()}`);
    outside.kill('SIGKILL');
    assert.equal(await c.exit, 0, c.stderr());
    assert.equal(await d.exit, 0, d.stderr());
  } finally {
    outside.kill('SIGKILL');
    for (const w of ws) w.child.kill('SIGKILL');
  }
});

// A waiter's poll sleep has the lock file open and may end while queue_outside looks at it: it held nothing, so it
// isn't named (#564: CI named one with no command line, and before the fix this script did in most polls).
test('a child of a waiter that ends while the holder is looked up is not named as the holder', { timeout: 60_000 }, () => {
  const state = queueState();
  mkdirSync(join(state, 'queue'));
  const r = spawnSync('bash', ['-c', `
    exec 9>"$1/lock"
    ( for i in $(seq 400); do sleep 0.0$((RANDOM % 9 + 1)) & sleep 0.004; done; wait ) & w=$!
    exec 9>&-
    echo "$w 0" >"$1/queue/1"
    . "$0"
    while kill -0 $w 2>/dev/null; do queue_outside "$1"; done`, queueLib, state], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('a queued restart'), 'it looked while the waiter ran');
  assert.doesNotMatch(r.stdout + r.stderr, /outside the line|cmdline/);
});

// F4: the queued restart takes no ticket, so the waiters saw nothing move through it and gave up. It now says what
// it is doing in <state>/restart ("<pid>" and its phase), and each new phase is progress.
test("the queued restart's phases show to the waiters and count as progress", { timeout: 60_000 }, async () => {
  const state = queueState();
  const restart = spawn('bash', ['-c', 'exec 9>"$0"; flock 9; exec sleep 42', join(state, 'lock')], { stdio: 'ignore' }); // one process, the lock on its fd 9
  const started = () => readFileSync(`/proc/${restart.pid}/stat`, 'utf8').split(') ').pop()!.split(' ')[19];
  const phase = (text: string) => writeFileSync(join(state, 'restart'), `${restart.pid} ${started()}\n${text}\n`);
  let b: ReturnType<typeof waiter> | undefined;
  try {
    await until('the lock to be held', () => spawnSync('flock', ['-n', join(state, 'lock'), 'true']).status !== 0);
    phase('restarting citadel on abc1234 since 10:00');
    b = waiter(state, 'b', 'true', { DEPLOY_QUEUE_STALL: '3' });
    const bs = b.stderr;
    await until('b to see the restart', () => /ahead: the queued restart, restarting citadel on abc1234 since 10:00\)/.test(bs()));
    await new Promise((ok) => setTimeout(ok, 2000));
    phase('rolling back to def5678 since 10:01');
    await until('b to see the next phase', () => /ahead: the queued restart, rolling back to def5678 since 10:01\)/.test(bs()));
    await new Promise((ok) => setTimeout(ok, 2000));
    assert.doesNotMatch(bs(), /gave up/, 'past the stall since it arrived, but the restart moved');
    restart.kill('SIGKILL');
    assert.equal(await b.exit, 0, bs());
  } finally {
    restart.kill('SIGKILL');
    b?.child.kill('SIGKILL');
  }
});

// #790: the stall was timed with $SECONDS, which ticks whole seconds, so a 3 s stall gave up 2.0-3.0 s after the last
// change, and the test above failed whenever its 2 s gaps ran a little long on a loaded box.
test('the stall is timed in real seconds: a 1 s stall gives up no sooner than 1 s after the last change', async () => {
  const state = queueState();
  const holder = spawn('bash', ['-c', 'exec 9>"$0"; flock 9; exec sleep 42', join(state, 'lock')], { stdio: 'ignore' });
  try {
    await until('the lock to be held', () => spawnSync('flock', ['-n', join(state, 'lock'), 'true']).status !== 0);
    const t0 = Date.now();
    const a = waiter(state, 'a', 'true', { DEPLOY_QUEUE_STALL: '1' });
    assert.equal(await a.exit, 1, a.stderr());
    const took = Date.now() - t0;
    assert.match(a.stderr(), /nothing has moved/);
    assert.ok(took >= 1000, `gave up after ${took} ms`);
  } finally {
    holder.kill('SIGKILL');
  }
});

// F12b: a lock file that can't be opened printed "flock: 9: Bad file descriptor" about once a second for the whole
// 15 min stall, then blamed a holder.
test("a deploy lock that can't be opened gives up at once and says so, not a flock error a second", async () => {
  const state = queueState();
  writeFileSync(join(state, 'lock'), '', { mode: 0o444 });
  const a = waiter(state, 'a', 'true', { DEPLOY_QUEUE_STALL: '3' });
  assert.equal(await a.exit, 1, a.stderr());
  assert.match(a.stderr(), /queue: can't open the deploy lock \S+\/lock for writing, so nothing landed or deployed: a person needs to look at it/);
  assert.doesNotMatch(a.stderr(), /Bad file descriptor|nothing has moved/);
  assert.deepEqual(tickets(state), []);
});

// The same for the restart lock (#566 put it beside the deploy lock): it waited out DEPLOY_RESTART_WAIT on a bad fd, then blamed a restart.
test("a restart lock that can't be opened gives up at once and says so", () => {
  const state = queueState();
  writeFileSync(join(state, 'restart.lock'), '', { mode: 0o444 });
  const res = spawnSync('bash', ['-c', `. '${queueLib}'; restart_lock "$1"`, 'x', state], { encoding: 'utf8', timeout: 20_000, env: { ...env, DEPLOY_RESTART_WAIT: '3' } });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /queue: can't open the restart lock \S+\/restart\.lock for writing, so nothing landed or deployed: a person needs to look at it/);
  assert.doesNotMatch(res.stderr, /Bad file descriptor|has not been let go/);
});

// F12c: junk in queue/.seq made a landing go live and still exit 1, and every later one too, until a person deleted
// it, and nothing named .seq.
test('a queue/.seq that holds no number is named, and the next ticket still goes behind the ones in line', async () => {
  const state = queueState();
  const a = waiter(state, 'a', `until [ -e '${state}/go' ]; do sleep 0.05; done`);
  let b: ReturnType<typeof waiter> | undefined;
  try {
    await until('a to hold the lock', () => order(state).length === 1);
    writeFileSync(join(state, 'queue', '.seq'), 'junk\n');
    b = waiter(state, 'b', 'true');
    const bs = b.stderr;
    await until('b to wait', () => /2nd in line/.test(bs()));
    assert.match(bs(), /queue: \S+\/queue\/\.seq held no ticket number \("junk"\); numbering goes on from the newest ticket, 1/);
    writeFileSync(join(state, 'go'), '');
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await b.exit, 0, bs());
    assert.deepEqual(order(state), ['a', 'b']);
    assert.equal(issued(state), 2);
    assert.deepEqual(readdirSync(join(state, 'queue')).filter((f) => f.includes('.tmp')), [], 'no half-written tickets left');
  } finally {
    for (const w of [a, b]) w?.child.kill('SIGKILL');
  }
});

// #1002 (Cara, 2026-11-18: "I should be able to drag the order and choose which one gets released next"): the Releases
// page writes queue/.order, the waiting tickets in the order people set. The holder keeps the lock; the waiters take it
// in that order, and one that joins later, or that .order doesn't name, goes behind them in arrival order.
test('the waiters take the lock in the order .order sets, a later one goes to the back, and each says who reordered', { timeout: 60_000 }, async () => {
  const state = queueState();
  const a = waiter(state, 'a', `until [ -e '${state}/go' ]; do sleep 0.05; done`);
  const ws = [a];
  try {
    await until('a to hold the lock', () => order(state).length === 1);
    for (const [i, label] of ['b', 'c', 'd'].entries()) {
      ws.push(waiter(state, label, 'true'));
      await until(`${label}'s ticket`, () => issued(state) === i + 2);
    }
    const [, tb, tc, td] = tickets(state);
    await until('d to say its place', () => /4th in line/.test(ws[3].stderr()));
    writeFileSync(join(state, 'queue', '.order'), `# Cara moved #4 to the front\n${td}\n${tb}\n`);
    await until('d to see it is next', () => /queue: 2nd in line for the deploy lock, about \d+ min \(ahead: a, starting\)/.test(ws[3].stderr().split('Cara moved')[1] ?? ''));
    assert.match(ws[3].stderr(), /queue: Cara moved #4 to the front/);
    await until('c to say who reordered', () => /queue: Cara moved #4 to the front/.test(ws[2].stderr()));
    ws.push(waiter(state, 'e', 'true'));
    await until("e's ticket", () => issued(state) === 5);
    await until('e to see its place', () => /5th in line/.test(ws[4].stderr()));
    assert.ok(tc, 'c is in line');
    writeFileSync(join(state, 'go'), '');
    for (const w of ws) assert.equal(await w.exit, 0, w.stderr());
    assert.deepEqual(order(state), ['a', 'd', 'b', 'c', 'e']);
  } finally {
    writeFileSync(join(state, 'go'), '');
    for (const w of ws) w.child.kill('SIGKILL');
  }
});

// The Releases page's server lists in .order only the tickets marked "order" (src/waits.ts setOrder): a landing from an
// older branch waits for every lower ticket, so ranking it ahead of one would leave the two waiting on each other.
test('a landing from a branch before .order keeps its arrival order, and nobody waits on it forever', { timeout: 60_000 }, async () => {
  const state = queueState();
  const a = waiter(state, 'a', `until [ -e '${state}/go' ]; do sleep 0.05; done`);
  const ws = [a];
  try {
    await until('a to hold the lock', () => order(state).length === 1);
    for (const [i, label] of ['b', 'c', 'd'].entries()) {
      ws.push(waiter(state, label, 'true', {}, label === 'd'));
      await until(`${label}'s ticket`, () => issued(state) === i + 2);
    }
    const ts = tickets(state);
    const marked = ts.filter((t) => readFileSync(join(state, 'queue', t), 'utf8').split('\n')[4] === 'order');
    assert.deepEqual(marked, [ts[0], ts[1], ts[2]], 'every ticket but the old one is marked');
    // What setOrder writes for "Land next on c": the marked waiters only, c first. Had it ranked d (old) first, d would
    // wait for b and c (lower tickets) while they waited for d.
    writeFileSync(join(state, 'queue', '.order'), `# Cara moved #3 to land next\n${ts[2]}\n${ts[1]}\n`);
    await until('b to see the order', () => /queue: Cara moved #3 to land next/.test(ws[1].stderr()));
    writeFileSync(join(state, 'go'), '');
    for (const w of ws) assert.equal(await w.exit, 0, w.stderr());
    assert.deepEqual(order(state), ['a', 'c', 'b', 'd']);
  } finally {
    writeFileSync(join(state, 'go'), '');
    for (const w of ws) w.child.kill('SIGKILL');
  }
});
