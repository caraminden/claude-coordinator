import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// tools/citadel-heavy (#325): the host-wide slots for heavy builds, on a throwaway lock folder.
const heavy = join(import.meta.dirname, '..', 'tools', 'citadel-heavy');
const root = mkdtempSync(join(tmpdir(), 'heavy-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
// A fake /proc/pressure/cpu, so no test reads (or depends on) the real box's load.
const psi = (some60: number) => `some avg10=${some60}.12 avg60=${some60}.34 avg300=1.00 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;
function folder(slots?: number, pressure = 5) {
  const dir = join(root, `locks-${n++}`);
  const pressureFile = `${dir}-pressure`;
  writeFileSync(pressureFile, psi(pressure));
  const env = { ...process.env, CITADEL_HEAVY_HELD: undefined, CITADEL_HEAVY_DIR: dir, CITADEL_HEAVY_SLOTS: slots === undefined ? undefined : String(slots), CITADEL_HEAVY_PRESSURE: pressureFile, CITADEL_HEAVY_POLL: '0.1', CITADEL_HEAVY_MAX_PRESSURE: undefined, CITADEL_HEAVY_LOAD_WAIT: undefined };
  return { dir, env, pressureFile };
}
type Job = { child: ChildProcess; err: () => string; done: Promise<number | null> };
function job(env: NodeJS.ProcessEnv, who: string, script: string): Job {
  // Its own process group, so a test can kill the wrapper and its command together, as a crash would.
  const child = spawn(heavy, ['sh', '-c', script], { env: { ...env, CITADEL_HEAVY_WHO: who }, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr!.on('data', (b) => (err += b));
  return { child, err: () => err, done: new Promise((r) => child.on('close', (code) => r(code))) };
}
async function until(what: string, check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(check(), `timed out waiting for ${what}`);
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

test('without a usable lock folder it warns and runs anyway', () => {
  const blocker = join(root, 'a-file');
  writeFileSync(blocker, '');
  const r = spawnSync(heavy, ['echo', 'ran'], { env: { ...process.env, CITADEL_HEAVY_HELD: undefined, CITADEL_HEAVY_DIR: join(blocker, 'locks') }, encoding: 'utf8' });
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
    writeFileSync(pressureFile, psi(49));
    assert.equal(await b.done, 0);
  } finally {
    writeFileSync(pressureFile, psi(0));
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
  writeFileSync(pressureFile, psi(90));
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
    writeFileSync(pressureFile, psi(5));
    process.kill(head.child.pid!, 'SIGCONT');
    for (const j of [...jobs, head]) assert.equal(await j.done, 0);
  }
});
