import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { until } from './wait.ts';

// tools/citadel-heavy (#325): the host-wide slots for heavy builds, on a throwaway lock folder.
const heavy = join(import.meta.dirname, '..', 'tools', 'citadel-heavy');
const root = mkdtempSync(join(tmpdir(), 'heavy-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
// A fake /proc/pressure/cpu, so no test reads (or depends on) the real box's load.
// Swapped in whole, as the kernel's file reads: a plain write empties the file first, and a job that polled it just
// then read no pressure and started at once, with "-" in its history line (a flake in CI, #646).
const setPressure = (file: string, text: string) => {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
};
const psi = (some60: number) => `some avg10=${some60}.12 avg60=${some60}.34 avg300=1.00 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;
function folder(slots?: number, pressure = 5) {
  const dir = join(root, `locks-${n++}`);
  const pressureFile = `${dir}-pressure`;
  setPressure(pressureFile, psi(pressure));
  const env = { ...process.env, CITADEL_HEAVY_HELD: undefined, CITADEL_HEAVY_DIR: dir, CITADEL_HEAVY_SLOTS: slots === undefined ? undefined : String(slots), CITADEL_HEAVY_PRESSURE: pressureFile, CITADEL_HEAVY_POLL: '0.1', CITADEL_HEAVY_MAX_PRESSURE: undefined, CITADEL_HEAVY_LOAD_WAIT: undefined, CITADEL_HEAVY_PRIORITY: undefined, CITADEL_HEAVY_WHAT: undefined,
    // No test reads the real box's memory (#1340: test/mem-room.test.ts has the memory wait).
    CITADEL_HEAVY_MEM_NEED: '0', CITADEL_MEM_ROOM_MB: undefined,
    // The slots as they were before #1160's small slot, and never the repo's CI (test/heavy-ci.test.ts has that).
    CITADEL_HEAVY_HERE: '1', CITADEL_HEAVY_PLAIN_SLOTS: '64',
    // The line's own tests send every job to the line, as before #1629; judged() below turns the judgment back on.
    CITADEL_HEAVY_JUDGE: '0', CITADEL_HEAVY_GUESS: undefined, CITADEL_HEAVY_MIN_RUN: undefined, CITADEL_HEAVY_MIN_CPU: undefined };
  return { dir, env, pressureFile };
}
type Job = { child: ChildProcess; err: () => string; done: Promise<number | null> };
function job(env: NodeJS.ProcessEnv, who: string, script: string, flags: string[] = []): Job {
  // Its own process group, so a test can kill the wrapper and its command together, as a crash would.
  const child = spawn(heavy, [...flags, 'sh', '-c', script], { env: { ...env, CITADEL_HEAVY_WHO: who }, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr!.on('data', (b) => (err += b));
  return { child, err: () => err, done: new Promise((r) => child.on('close', (code) => r(code))) };
}
const touch = (f: string) => `touch '${f}'`;
// Bounded, so a failed assertion can't leave a job holding its slot (and the test file) open for good.
const waitFor = (f: string) => `i=0; while [ ! -e '${f}' ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i + 1)); done`;

test('it runs the command with its stdin and exit status', () => {
  const { env } = folder();
  assert.equal(spawnSync(heavy, ['cat'], { env, input: 'hi', encoding: 'utf8' }).stdout, 'hi');
  assert.equal(spawnSync(heavy, ['sh', '-c', 'exit 7'], { env }).status, 7);
  assert.equal(spawnSync(heavy, [], { env }).status, 2);
});

test('with 2 slots a third job waits in line, says whose jobs hold them, and starts once one ends', async () => {
  const { env } = folder(2);
  const go = join(root, 'go-1');
  const a = job(env, 'Peek #1 (josh)', `${touch(join(root, 'a-up'))}; ${waitFor(go)}`);
  const b = job(env, 'Peek #2 (cara)', `${touch(join(root, 'b-up'))}; ${waitFor(go)}`);
  await until('two jobs running', () => existsSync(join(root, 'a-up')) && existsSync(join(root, 'b-up')));
  const c = job(env, 'Delve #3', touch(join(root, 'c-up')));
  try {
    await until('the third to say whose jobs it waits on', () => /waiting/.test(c.err()) && /slot 2: /.test(c.err()));
    assert.ok(!existsSync(join(root, 'c-up')), 'the third job waits');
    assert.match(c.err(), /Peek #1 \(josh\): sh -c/);
    assert.match(c.err(), /Peek #2 \(cara\): sh -c/);
  } finally {
    writeFileSync(go, '');
  }
  assert.equal(await a.done, 0);
  assert.equal(await b.done, 0);
  assert.equal(await c.done, 0);
  assert.ok(existsSync(join(root, 'c-up')));
});

test('a job killed mid-run frees its slot, and a daemon it leaves behind keeps none', async () => {
  const { dir, env } = folder(1);
  const a = job(env, 'crasher', `${touch(join(root, 'crash-up'))}; sleep 30`);
  await until('the job running', () => existsSync(join(root, 'crash-up')));
  process.kill(-a.child.pid!, 'SIGKILL');
  await a.done;
  assert.equal(spawnSync(heavy, ['true'], { env, timeout: 10_000 }).status, 0, 'the next job gets the slot');
  // A build that starts a server in the background (sccache, say) and exits.
  const pidFile = join(root, 'daemon-pid');
  assert.equal(spawnSync(heavy, ['sh', '-c', `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'`], { env, timeout: 10_000 }).status, 0);
  try {
    assert.equal(spawnSync(heavy, ['true'], { env, timeout: 10_000 }).status, 0, 'the daemon holds no slot');
  } finally {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
  }
  assert.ok(!existsSync(join(dir, 'slot-0.who')), 'a finished job takes its holder line with it');
});

test('the slots file tunes how many run at once, and a nested call runs in the outer slot', async () => {
  const { dir, env } = folder(5);
  spawnSync(heavy, ['true'], { env });
  writeFileSync(join(dir, 'slots'), '1\n');
  const go = join(root, 'go-2');
  const a = job(env, 'first', `${touch(join(root, 'n-up'))}; ${waitFor(go)}`);
  await until('the first job running', () => existsSync(join(root, 'n-up')));
  const b = job(env, 'second', 'true');
  try {
    await until('the second to wait on the one slot', () => /all heavy slots \(1\) are busy/.test(b.err()));
    assert.doesNotMatch(b.err(), /CPU pressure/, 'with no slot free, the load is beside the point');
  } finally {
    writeFileSync(go, '');
  }
  assert.equal(await a.done, 0);
  assert.equal(await b.done, 0);
  // With the one slot held by the outer call, the inner one would wait forever if it queued.
  const nested = spawnSync(heavy, [heavy, 'echo', 'inner'], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(nested.stdout, 'inner\n');
});

// Deploy builds (#885): a contraption's deploy waited behind minions' suites for 15-20 min per step, for seconds of work.
test('a priority job goes ahead of the jobs waiting in line, and the one it passes says why', async () => {
  const { env } = folder(1);
  const go = join(root, 'go-first');
  const order = join(root, 'first-order');
  const a = job(env, 'suite', `${touch(join(root, 'first-up'))}; ${waitFor(go)}`);
  await until('the slot held', () => existsSync(join(root, 'first-up')));
  const b = job(env, 'Peek #4', `echo minion >> '${order}'`);
  await until('the minion job at the head of the line', () => /all heavy slots \(1\) are busy/.test(b.err()));
  const c = job({ ...env, CITADEL_HEAVY_PRIORITY: '1' }, 'voice deploy', `echo deploy >> '${order}'`);
  try {
    await until('the deploy waiting for the slot', () => /all heavy slots \(1\) are busy/.test(c.err()));
    await new Promise((r) => setTimeout(r, 300)); // a few of the head's polls, so it has seen the deploy waiting
  } finally {
    writeFileSync(go, '');
  }
  assert.equal(await a.done, 0);
  assert.equal(await c.done, 0);
  assert.equal(await b.done, 0);
  assert.equal(readFileSync(order, 'utf8'), 'deploy\nminion\n', 'the deploy took the freed slot first');
  assert.match(b.err(), /voice deploy goes first/);
});

test('a priority job skips the load wait, and CITADEL_HEAVY_WHAT names its hold', () => {
  const { dir, env } = folder(2, 90);
  const r = spawnSync(heavy, ['true'], { env: { ...env, CITADEL_HEAVY_PRIORITY: '1', CITADEL_HEAVY_WHO: 'voice deploy', CITADEL_HEAVY_WHAT: 'build: npm ci; npm run build' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  const line = readFileSync(join(dir, 'history'), 'utf8').trim().split('\t');
  assert.deepEqual(line.slice(1, 4), ['voice deploy', 'build: npm ci; npm run build', 'none'], 'admitted at once, on the busy box');
});

test("a priority waiter's marker that stopped being freshened doesn't hold the line up", () => {
  const { dir, env } = folder(1);
  spawnSync(heavy, ['true'], { env });
  writeFileSync(join(dir, 'first'), 'a deploy killed while it waited\n');
  const old = Date.now() / 1000 - 600;
  utimesSync(join(dir, 'first'), old, old);
  assert.equal(spawnSync(heavy, ['true'], { env, timeout: 10_000 }).status, 0);
});

test('without a usable lock folder it warns and runs anyway', () => {
  const blocker = join(root, 'a-file');
  writeFileSync(blocker, '');
  const r = spawnSync(heavy, ['echo', 'ran'], { env: { ...process.env, CITADEL_HEAVY_HELD: undefined, CITADEL_HEAVY_HERE: '1', CITADEL_HEAVY_JUDGE: '0', CITADEL_HEAVY_DIR: join(blocker, 'locks') }, encoding: 'utf8' });
  assert.equal(r.stdout, 'ran\n');
  assert.match(r.stderr, /without waiting for a slot/);
});

// Box load (#503): a free slot is not enough while the CPUs are already full.
test('with a slot free but the box busy, the job waits, says the pressure, and starts once it eases', async () => {
  const { dir, env, pressureFile } = folder(3, 72);
  const a = job(env, 'Peek #4', touch(join(root, 'load-up')));
  try {
    await until('the job to say it waits on load', () => /box is busy/.test(a.err()));
    assert.ok(!existsSync(join(root, 'load-up')), 'it waits though all 3 slots are free');
    assert.match(a.err(), /a heavy slot is free, but the box is busy: CPU pressure 72% over the last minute \(it waits at 50%; load \d+ on \d+ cores\)/);
    assert.match(a.err(), /at most 5 min, then it starts anyway \(Peek #4: sh -c/);
    assert.match(a.err(), /Raising the slot count would make every suite slower, not faster/);
    // The next job in line waits behind it rather than slipping past to the free slots.
    const b = job(env, 'Peek #5', touch(join(root, 'load-up-2')));
    await until('the next to queue', () => /others are in line/.test(b.err()));
    assert.ok(!existsSync(join(root, 'load-up-2')));
    // Each waiter leaves a wait-<pid>-<random> file for Citadel's wait readout (#544): who, what, since, on what.
    const waits = () => readdirSync(dir).filter((f) => /^wait-\d+-\d+$/.test(f)).map((f) => readFileSync(join(dir, f), 'utf8').split('\n'));
    await until('both waiter files', () => waits().length === 2);
    const byWho = Object.fromEntries(waits().map((l) => [l[0], l]));
    assert.equal(byWho['Peek #4'][3], 'load');
    assert.equal(byWho['Peek #5'][3], 'line');
    assert.match(byWho['Peek #4'][1], /^sh -c/);
    assert.ok(Math.abs(Number(byWho['Peek #4'][2]) - Date.now() / 1000) < 60, 'since is now, in seconds');
    setPressure(pressureFile, psi(49));
    assert.equal(await b.done, 0);
  } finally {
    setPressure(pressureFile, psi(0));
  }
  assert.equal(await a.done, 0);
  assert.ok(existsSync(join(root, 'load-up')));
  assert.doesNotMatch(a.err(), /starts anyway in slot/);
  assert.ok(!existsSync(join(dir, 'slot-0.who')));
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('wait-')), [], 'a waiter that got its slot takes its wait file with it');
});

test('a job never waits on load past the limit: then it takes the free slot anyway, and says so', async () => {
  const { env } = folder(2, 90);
  const r = spawnSync(heavy, ['echo', 'ran'], { env: { ...env, CITADEL_HEAVY_LOAD_WAIT: '1' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'ran\n');
  assert.match(r.stderr, /at most 1 s, then it starts anyway/);
  assert.match(r.stderr, /the box is still busy \(CPU pressure 90% .*\) after 1 s waiting on it, so this starts anyway in slot 1/);
});

test('it goes by slots alone below the limit and without a pressure file, and the limit can be set', () => {
  const { env } = folder(1, 49);
  let r = spawnSync(heavy, ['true'], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '', 'below the limit it starts straight away, quietly');
  r = spawnSync(heavy, ['true'], { env: { ...env, CITADEL_HEAVY_PRESSURE: join(root, 'no-such-pressure') }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '', 'no PSI on the host: slots alone');
  r = spawnSync(heavy, ['true'], { env: { ...env, CITADEL_HEAVY_MAX_PRESSURE: '40', CITADEL_HEAVY_LOAD_WAIT: '0' }, encoding: 'utf8', timeout: 10_000 });
  assert.match(r.stderr, /CPU pressure 49% .*it waits at 40%/);
});

test('the slots file can carry comments, digits and all', async () => {
  const { dir, env } = folder(undefined, 5);
  spawnSync(heavy, ['true'], { env });
  writeFileSync(join(dir, 'slots'), '# Raised to 6 on 2026-11-10: it made suites slower, not faster.\n3 # three\n9\n');
  const go = join(root, 'go-3');
  const jobs = [1, 2, 3, 4].map((i) => job(env, `c${i}`, `${touch(join(root, `c${i}-up`))}; ${waitFor(go)}`));
  const up = () => [1, 2, 3, 4].filter((i) => existsSync(join(root, `c${i}-up`))).length;
  try {
    // Whichever job gets in line last waits: 3 slots, from the first number that isn't in a comment.
    await until('three running and one waiting', () => up() === 3 && jobs.some((j) => /all heavy slots \(3\) are busy/.test(j.err())));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(up(), 3);
  } finally {
    writeFileSync(go, '');
  }
  for (const j of jobs) assert.equal(await j.done, 0);
});

test('a job gets its slot\'s progress file for a test run\'s counts (#545), cleared before it starts and gone after', () => {
  const { dir, env } = folder(1);
  spawnSync(heavy, ['true'], { env });
  writeFileSync(join(dir, 'slot-0.progress'), '1\n2\nstale\n');
  const r = spawnSync(heavy, ['sh', '-c', 'cat "$CITADEL_TEST_PROGRESS" 2>/dev/null; echo "$CITADEL_TEST_PROGRESS"; echo 1 >"$CITADEL_TEST_PROGRESS"'], { env, encoding: 'utf8' });
  assert.equal(r.stdout, `${join(dir, 'slot-0.progress')}\n`, "a run before this one left counts that aren't this run's");
  assert.equal(existsSync(join(dir, 'slot-0.progress')), false);
});

// #553 F10: a frozen container or stopped turn at the head of the line blocked every heavy job behind it, in silence.
test('a job behind a head of the line that has stopped moving names it, goes past it, and runs', async () => {
  const { env } = folder(1);
  const go = join(root, 'go-head');
  const a = job(env, 'Peek #1', `${touch(join(root, 'head-a-up'))}; ${waitFor(go)}`);
  await until('the first job running', () => existsSync(join(root, 'head-a-up')));
  const b = job(env, 'Peek #2', 'true');
  await until('the second to be next in line', () => /all heavy slots/.test(b.err()));
  const c = job({ ...env, CITADEL_HEAVY_HEAD_STALE: '1' }, 'Delve #3', touch(join(root, 'head-c-up')));
  try {
    await until('the third to say whom it waits behind', () => /others are in line for a heavy slot first \(next: Peek #2: sh -c true/.test(c.err()));
    process.kill(b.child.pid!, 'SIGSTOP');
    writeFileSync(go, '');
    assert.equal(await a.done, 0);
    await until('the third job to run with the head still stopped', () => existsSync(join(root, 'head-c-up')));
    assert.equal(await c.done, 0);
    assert.match(c.err(), /the job next in line \(Peek #2: sh -c true.*\) has not moved for \d+ s \(stopped or frozen\), so this one goes past it/);
  } finally {
    writeFileSync(go, '');
    process.kill(b.child.pid!, 'SIGCONT');
    // Awaited here too: a job left waiting after a failed assertion would poll the deleted lock folder for good.
    assert.equal(await b.done, 0, 'the stopped job runs once it is woken');
  }
});

test('a job that waits while no slot changes hands gives up at the limit, loudly, without running', async () => {
  const { dir, env } = folder(1);
  const go = join(root, 'go-cap');
  const a = job(env, 'Peek #1', `${touch(join(root, 'cap-a-up'))}; ${waitFor(go)}`);
  await until('the first job running', () => existsSync(join(root, 'cap-a-up')));
  const b = job({ ...env, CITADEL_HEAVY_MAX_WAIT: '1' }, 'Delve #3', touch(join(root, 'cap-b-up')));
  try {
    assert.equal(await b.done, 75);
    assert.match(b.err(), /gave up: no heavy slot has changed hands in 1 s of waiting, so nothing ran \(Delve #3: sh -c.*\)\. .*\n.*slot 1: Peek #1: sh -c/);
    assert.ok(!existsSync(join(root, 'cap-b-up')), 'its command never ran');
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('wait-')), [], 'its wait file is gone');
  } finally {
    writeFileSync(go, '');
  }
  assert.equal(await a.done, 0);
});

test('jobs going past a stopped head still start one at a time on a busy box, each after its own wait on the load', async () => {
  const { env, pressureFile } = folder(2);
  setPressure(pressureFile, psi(90));
  const head = job({ ...env, CITADEL_HEAVY_LOAD_WAIT: '600' }, 'Peek #2', 'true');
  await until('the head to wait on the load', () => /the box is busy/.test(head.err()));
  process.kill(head.child.pid!, 'SIGSTOP');
  // Two slots are free. Each on its own clock, both would give up on the load after 2 s and start together.
  const late = { ...env, CITADEL_HEAVY_HEAD_STALE: '1', CITADEL_HEAVY_LOAD_WAIT: '2' };
  const ups = ['c', 'd'].map((x) => join(root, `past-${x}-up`));
  const jobs = ups.map((up, i) => job(late, `Delve #${i}`, touch(up)));
  const n = () => ups.filter((up) => existsSync(up)).length;
  try {
    await until('one to start', () => n() >= 1);
    const first = performance.now();
    await until('the other to start', () => n() === 2);
    assert.ok(performance.now() - first >= 1500, `the second waited its own 2 s on the load: ${Math.round(performance.now() - first)} ms apart`);
  } finally {
    setPressure(pressureFile, psi(5));
    process.kill(head.child.pid!, 'SIGCONT');
    for (const j of [...jobs, head]) assert.equal(await j.done, 0);
  }
});

// M13: the wait file of a waiter killed past its trap stayed for good.
test("a job deletes the wait files of waiters killed long ago, and leaves a live waiter's", () => {
  const { dir, env } = folder(1);
  mkdirSync(dir, { recursive: true });
  const old = join(dir, 'wait-123-456'), fresh = join(dir, 'wait-124-457');
  writeFileSync(old, 'x\n');
  writeFileSync(fresh, 'x\n');
  const hourAgo = Date.now() / 1000 - 3600;
  utimesSync(old, hourAgo, hourAgo);
  assert.equal(spawnSync(heavy, ['true'], { env }).status, 0);
  assert.ok(!existsSync(old), 'an hour stale: its waiter is long gone');
  assert.ok(existsSync(fresh), 'a fresh one may be a waiter in another container');
});

// #596: one history line per job, so a week of real waits and runs can be read back.
const history = (dir: string) => readFileSync(join(dir, 'history'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));

test('a job that ran appends one line: start, who, what, on what it waited, wait s, run s, status, pressure', () => {
  const { dir, env } = folder(2, 7);
  const r = spawnSync(heavy, ['sh', '-c', 'sleep 1; printf "a\tb"; exit 3'], { env: { ...env, CITADEL_HEAVY_WHO: 'TTA #12 (josh)' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 3);
  const lines = history(dir);
  assert.equal(lines.length, 1);
  const [at, who, what, on, wait, run, status, pressure] = lines[0];
  assert.ok(Math.abs(Date.parse(at) - Date.now()) < 60_000, `${at} is an ISO time of about now`);
  assert.equal(who, 'TTA #12 (josh)');
  assert.equal(what, 'sh -c sleep 1; printf "a b"; exit 3', 'a tab in the command would split its field');
  assert.deepEqual([on, wait, status, pressure], ['none', '0', '3', '7']);
  assert.ok(Number(run) >= 1 && Number(run) < 10, `ran ${run} s`);
  assert.equal(lines[0].length, 9);
  assert.equal(lines[0][8], '0', 'a sleep spends no CPU seconds');
});

test('a job that waited on load says load, with its wait and the pressure it started at; a forced one says forced', async () => {
  const { dir, env, pressureFile } = folder(2, 72);
  const a = job(env, 'Peek #9', 'true');
  try {
    await until('the job to wait on load', () => /box is busy/.test(a.err()));
    await new Promise((r) => setTimeout(r, 1100));
    setPressure(pressureFile, psi(12));
  } finally {
    setPressure(pressureFile, psi(0));
  }
  assert.equal(await a.done, 0);
  const [line] = history(dir);
  assert.equal(line[3], 'load');
  assert.ok(Number(line[4]) >= 1, `waited ${line[4]} s`);
  assert.match(line[7], /^(12|0)$/);
  setPressure(pressureFile, psi(90));
  assert.equal(spawnSync(heavy, ['true'], { env: { ...env, CITADEL_HEAVY_LOAD_WAIT: '1' }, timeout: 10_000 }).status, 0);
  assert.deepEqual([history(dir)[1][3], history(dir)[1][7]], ['forced', '90']);
});

test('a history file that cannot be written changes nothing about the run, its output or its status', () => {
  const { dir, env } = folder(1);
  mkdirSync(join(dir, 'history'), { recursive: true }); // a folder where the file goes: every append fails
  const r = spawnSync(heavy, ['sh', '-c', 'echo ran; exit 7'], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 7);
  assert.equal(r.stdout, 'ran\n');
  assert.equal(r.stderr, '', 'quietly');
});

test('nested calls write no line of their own, and a history past its limit keeps its newest half, whole lines only', () => {
  const { dir, env } = folder(1);
  assert.equal(spawnSync(heavy, [heavy, 'true'], { env, timeout: 10_000 }).status, 0);
  assert.equal(history(dir).length, 1, 'one line for the outer call only');
  writeFileSync(join(dir, 'history'), Array.from({ length: 40 }, (_, i) => `old line ${String(i).padStart(2, '0')}`.padEnd(49, '.')).join('\n') + '\n');
  assert.equal(spawnSync(heavy, ['echo', 'newest'], { env: { ...env, CITADEL_HEAVY_HISTORY_MAX: '1000' }, stdio: 'ignore', timeout: 10_000 }).status, 0);
  const text = readFileSync(join(dir, 'history'), 'utf8');
  assert.ok(text.length <= 500, `${text.length} bytes`);
  const lines = text.split('\n').filter(Boolean);
  assert.match(lines[0], /^old line \d\d\.+$/, 'starts on a whole line');
  assert.match(lines.at(-2)!, /^old line 39/);
  assert.equal(lines.at(-1)!.split('\t')[2], 'echo newest');
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('history.')), [], 'no copy left behind');
});

test('a history write that hangs holds no slot: the next job runs', async () => {
  const { dir, env } = folder(1);
  mkdirSync(dir, { recursive: true });
  assert.equal(spawnSync('mkfifo', [join(dir, 'history')]).status, 0); // no reader: an append to it blocks
  const a = job(env, 'stuck writer', touch(join(root, 'fifo-a-up')));
  try {
    await until('the first job to have run', () => existsSync(join(root, 'fifo-a-up')));
    const r = spawnSync(heavy, ['echo', 'next'], { env: { ...env, CITADEL_HEAVY_MAX_WAIT: '5' }, encoding: 'utf8', timeout: 4_000 });
    assert.equal(r.stdout, 'next\n', 'the slot was free while the first job hung on its history');
  } finally {
    readFileSync(join(dir, 'history')); // a reader lets the hung write through
  }
  assert.equal(await a.done, 0);
});

// Perigee's small slot (#1160, Josh 2026-11-20: "One small slot here"): plain jobs share one slot, niced, and leave
// the others to priority jobs, which take them from the top.
test('plain jobs share one slot at nice 19, and a priority job takes the one above it, not every slot', async () => {
  const { dir, env } = folder(3);
  const small = { ...env, CITADEL_HEAVY_PLAIN_SLOTS: undefined };
  const go = join(root, 'go-small');
  const a = job(small, 'Peek #1', `nice > '${join(root, 'small-nice')}'; ${waitFor(go)}`);
  await until('the plain slot held', () => existsSync(join(root, 'small-nice')));
  try {
    const b = job(small, 'Peek #2', 'true');
    await until('a second plain job waiting with two slots free', () => /all heavy slots \(1\) are busy/.test(b.err()));
    const d = spawnSync(heavy, ['sh', '-c', 'nice'], { env: { ...small, CITADEL_HEAVY_PRIORITY: '1', CITADEL_HEAVY_WHO: 'app deploy' }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(d.status, 0, d.stderr);
    assert.equal(d.stdout.trim(), String(Number(spawnSync('nice', { encoding: 'utf8' }).stdout.trim())), 'a deploy build is not niced further');
    writeFileSync(go, '');
    assert.equal(await b.done, 0);
  } finally {
    writeFileSync(go, '');
  }
  assert.equal(await a.done, 0);
  assert.equal(readFileSync(join(root, 'small-nice'), 'utf8').trim(), '19');
  assert.ok(existsSync(join(dir, 'slot-1')), 'the deploy took the one slot above the plain one');
  assert.ok(!existsSync(join(dir, 'slot-2')), 'deploy builds get one slot more than plain jobs, not every slot');
});

// Memory room (#1340): a free slot and a quiet CPU are not enough while the heavy slice has no room left.
test('with too little memory room the job waits, says how much, and starts once room frees up', async () => {
  const { env } = folder(3);
  const fake = { ...env, CITADEL_HEAVY_MEM_NEED: '2000', CITADEL_MEM_ROOM_MB: '1200' };
  const a = job(fake, 'Peek #7', touch(join(root, 'mem-up')));
  await until('the job to say it waits for memory', () => /waiting for memory: 1200 MB free for heavy work, needs 2000 MB/.test(a.err()));
  assert.ok(!existsSync(join(root, 'mem-up')), 'it waits though a slot is free');
  assert.match(a.err(), /at most 5 min, then it starts anyway with the workers that fit/);
  process.kill(-a.child.pid!, 'SIGTERM');
  await a.done;
});

test('a job waiting for memory starts anyway after the bound, and says so', async () => {
  const { env, dir } = folder(3);
  const a = job({ ...env, CITADEL_HEAVY_MEM_NEED: '2000', CITADEL_MEM_ROOM_MB: '100', CITADEL_HEAVY_MEM_WAIT: '1' }, 'Peek #8', touch(join(root, 'mem-forced')));
  assert.equal(await a.done, 0);
  assert.ok(existsSync(join(root, 'mem-forced')));
  assert.match(a.err(), /memory is still short \(waiting for memory: 100 MB free for heavy work, needs 2000 MB\) after 1 s waiting, so this starts anyway/);
  assert.match(readFileSync(join(dir, 'history'), 'utf8'), /\tforced\t/);
});

test('enough memory room starts at once, and a priority job skips the memory wait', async () => {
  const { env } = folder(3);
  const ok = job({ ...env, CITADEL_HEAVY_MEM_NEED: '2000', CITADEL_MEM_ROOM_MB: '5000' }, 'Peek #9', touch(join(root, 'mem-ok')));
  assert.equal(await ok.done, 0);
  assert.doesNotMatch(ok.err(), /memory/);
  const p = job({ ...env, CITADEL_HEAVY_MEM_NEED: '2000', CITADEL_MEM_ROOM_MB: '1', CITADEL_HEAVY_PRIORITY: '1' }, 'Deploy #3', touch(join(root, 'mem-prio')));
  assert.equal(await p.done, 0);
});

// Only heavy work waits (#1629): each job is judged light or heavy by its own past runs before it takes a place in line.
const past = (who: string, what: string, run: number, cpu?: number) =>
  `2026-11-20T10:00:00-0800\t${who}\t${what}\tnone\t0\t${run}\t0\t5${cpu === undefined ? '' : `\t${cpu}`}\n`;
// One slot, held by a job until its go file appears; returns the go file and the holder.
async function holdSlot(env: NodeJS.ProcessEnv) {
  const up = join(root, `hold-up-${n}`), go = join(root, `hold-go-${n++}`);
  const holder = job(env, 'Holder #1 (cara)', `${touch(up)}; ${waitFor(go)}`);
  await until('the holder in its slot', () => existsSync(up));
  return { go, holder };
}
const lastLine = (dir: string) => history(dir).at(-1)!;
const seed = (dir: string, text: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'history'), text); };
const judged = (env: NodeJS.ProcessEnv) => ({ ...env, CITADEL_HEAVY_JUDGE: undefined });

test('a job whose past runs were short runs at once while the slot is held, and its line says light', async () => {
  const { dir, env } = folder(1);
  // Its key skips wrappers: these past runs are the same job as `sh -c echo quick`.
  seed(dir, past('Tiny #2 (cara)', 'timeout -k 30 600 sh -c echo quick', 1, 1) + past('Tiny #3 (cara)', 'mise exec node@24 -- sh -c echo quick', 2, 1));
  const { go, holder } = await holdSlot(env);
  try {
    const r = spawnSync(heavy, ['sh', '-c', 'echo quick'], { env: { ...judged(env), CITADEL_HEAVY_WHO: 'Tiny #6 (cara)' }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'quick\n');
    assert.match(r.stderr, /runs at once, without a heavy slot: its last 2 run\(s\) took 1 s/);
    assert.deepEqual(lastLine(dir).slice(1, 5), ['Tiny #6 (cara)', 'sh -c echo quick', 'light', '0']);
    assert.equal(lastLine(dir).length, 9, 'with its CPU seconds');
  } finally {
    writeFileSync(go, '');
  }
  assert.equal(await holder.done, 0);
});

test('a Claude-bound job never takes a slot, whatever its past runs say or the caller guesses', async () => {
  const { dir, env } = folder(1);
  const bin = join(root, `bin-${n++}`);
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "eval $*"\n', { mode: 0o755 });
  seed(dir, past('Citadel #1 (cara)', `${bin}/claude -p hi`, 3000, 2900).repeat(3));
  const { go, holder } = await holdSlot(env);
  try {
    const r = spawnSync(heavy, ['--heavy', join(bin, 'claude'), '-p', 'hi'], { env: { ...judged(env), CITADEL_HEAVY_WHO: 'Citadel #2 (cara)' }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'eval -p hi\n');
    assert.match(r.stderr, /without a heavy slot: it runs Claude turns/);
    assert.equal(lastLine(dir)[3], 'light');
  } finally {
    writeFileSync(go, '');
  }
  assert.equal(await holder.done, 0);
});

test('a long CPU-bound job still queues behind the held slot, with no guess of its own', async () => {
  const { dir, env } = folder(1);
  const what = 'npm test';
  // Another minion of the scheme ran it long on busy cores; short runs of one file are another job, not its median.
  seed(dir, past('Citadel #1 (cara)', 'env CI=1 npm test', 600, 2400).repeat(3) + past('Citadel #3 (cara)', 'npm test test/a.test.ts', 2, 2).repeat(5));
  const { go, holder } = await holdSlot(env);
  const up = join(root, `long-up-${n++}`);
  const c = job({ ...judged(env), CITADEL_HEAVY_WHAT: what }, 'Citadel #2 (cara)', touch(up));
  try {
    await until('the long job to wait for the slot', () => /waiting for one/.test(c.err()));
    assert.ok(!existsSync(up), 'it waits');
  } finally {
    writeFileSync(go, '');
  }
  assert.equal(await holder.done, 0);
  assert.equal(await c.done, 0);
  assert.ok(existsSync(up));
});

test('a long job busy under 75 % of its run runs at once; a long one from before the CPU column queues', async () => {
  const { dir, env } = folder(1);
  // 60 % busy is not "the vast majority" of its run (CITADEL_HEAVY_MIN_CPU, 75).
  seed(dir, past('Idle #1 (cara)', 'sh -c echo idle', 900, 540).repeat(2) + past('Old #1 (cara)', 'sh -c echo old', 900).repeat(2));
  const { go, holder } = await holdSlot(env);
  const up = join(root, `old-up-${n++}`);
  const old = job({ ...judged(env), CITADEL_HEAVY_WHAT: 'sh -c echo old' }, 'Old #2 (cara)', `echo old; ${touch(up)}`);
  try {
    const r = spawnSync(heavy, ['sh', '-c', 'echo idle'], { env: { ...judged(env), CITADEL_HEAVY_WHO: 'Idle #2 (cara)' }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /without a heavy slot: its last 2 run\(s\) took 900 s \(median\), CPU busy 60% of it/);
    await until('the old job to wait for the slot', () => /waiting for one/.test(old.err()));
    assert.ok(!existsSync(up), 'it waits');
  } finally {
    writeFileSync(go, '');
  }
  assert.equal(await holder.done, 0);
  assert.equal(await old.done, 0);
});

test('a job with no past runs runs at once and never asks for CI, unless the caller guesses --heavy', async () => {
  const { dir, env } = folder(1);
  // A fake citadel-node: the CI path's first step (heavy-ci.ts --repo) leaves a mark, then says "no CI here".
  const bin = join(root, `bin-${n++}`), asked = join(root, `ci-asked-${n}`);
  mkdirSync(bin);
  writeFileSync(join(bin, 'citadel-node'), `#!/bin/sh\ntouch '${asked}'\nexit 1\n`, { mode: 0o755 });
  const fresh = { ...judged(env), CITADEL_HEAVY_HERE: undefined, PATH: `${bin}:${process.env.PATH}` };
  const { go, holder } = await holdSlot(env);
  const up = join(root, `guess-up-${n++}`);
  let guessed: Job | undefined;
  try {
    const r = spawnSync(heavy, ['sh', '-c', 'echo new'], { env: { ...fresh, CITADEL_HEAVY_WHO: 'New #1 (cara)' }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /without a heavy slot: no past runs of it/);
    assert.ok(!existsSync(asked), 'a light job never goes to CI');
    guessed = job(fresh, 'New #2 (cara)', touch(up), ['--heavy']);
    await until('the guessed-heavy job to wait for the slot', () => /waiting for one/.test(guessed!.err()));
    assert.ok(existsSync(asked), 'a heavy job asks for CI first');
    assert.ok(!existsSync(up), 'it waits');
  } finally {
    writeFileSync(go, '');
  }
  assert.equal(await holder.done, 0);
  assert.equal(await guessed!.done, 0);
  assert.ok(existsSync(up));
  assert.equal(history(dir).filter((l) => l[1] === 'New #1 (cara)')[0][3], 'light');
});

test("the history line's last column is the command's CPU seconds, its children's included", () => {
  const { dir, env } = folder(2);
  // A fixed amount of work (about 3 CPU s here), not a fixed time: a light job runs at nice 19, so on a busy box a
  // time-bound loop got under 1 CPU s. Its CPU is all in sh, the command's own process.
  const r = spawnSync(heavy, ['sh', '-c', 'i=0; while [ $i -lt 2000000 ]; do i=$((i+1)); done'], { env, timeout: 120_000 });
  assert.equal(r.status, 0);
  const cpu = Number(lastLine(dir)[8]);
  assert.ok(cpu >= 1 && cpu <= Number(lastLine(dir)[5]) * 16, `${cpu} CPU s`);
});

test('what the command prints is teed into its slot\'s .out file while it runs, and the file goes with the run (#1681)', async () => {
  const { dir, env } = folder(2);
  const go = join(root, 'go-tee');
  const j = spawn(heavy, ['sh', '-c', `echo out-line; echo err-line >&2; ${waitFor(go)}`], { env: { ...env, CITADEL_HEAVY_WHO: 'Citadel #1 (cara)' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  j.stdout!.on('data', (b) => (out += b));
  j.stderr!.on('data', (b) => (err += b));
  const closed = new Promise((r) => j.on('close', r));
  await until('the output is teed', () => existsSync(join(dir, 'slot-0.out')) && /out-line/.test(readFileSync(join(dir, 'slot-0.out'), 'utf8')) && /err-line/.test(readFileSync(join(dir, 'slot-0.out'), 'utf8')));
  writeFileSync(go, '');
  await closed;
  assert.match(out, /^out-line$/m);
  assert.match(err, /err-line/);
  assert.equal(existsSync(join(dir, 'slot-0.out')), false);
});
