// A container stuck at its memory limit has its biggest process killed, and only that one (#1876).
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { until } from './wait.ts';
import { ContainerRelief, RELIEF, startContainerRelief, TASKMASTER_SLICE, victimText, type Victim } from '../src/container-relief.ts';
import { TASKMASTER_SLICE as TURNS_OWN } from '../src/turn-launch.ts';

const root = mkdtempSync(join(tmpdir(), 'container-relief-'));
after(() => rmSync(root, { recursive: true, force: true }));
const MB = 1024 ** 2;
let n = 0;

/** A fake citadel.slice with one container, its payload in a cgroup below it as podman's --cgroups=split makes it. */
function fake(unit = 'citadel-claude-2.service') {
  const slice = join(root, `slice-${++n}`);
  const dir = join(slice, unit);
  const payload = join(dir, 'libpod-payload-abc');
  mkdirSync(payload, { recursive: true });
  const proc = join(root, `proc-${n}`);
  writeFileSync(join(dir, 'memory.high'), '10737418240\n');
  writeFileSync(join(dir, 'cgroup.procs'), '');
  let high = 0;
  return {
    slice,
    proc,
    read(some: number, gain = 100) {
      high += gain;
      writeFileSync(join(dir, 'memory.events.local'), `low 0\nhigh ${high}\nmax 0\noom 0\noom_kill 0\n`);
      writeFileSync(join(dir, 'memory.pressure'), `some avg10=${some.toFixed(2)} avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`);
    },
    procs(pids: number[], at = payload) {
      writeFileSync(join(at, 'cgroup.procs'), pids.map((p) => `${p}\n`).join(''));
    },
    add(pid: number, o: { name?: string; ppid?: number; anon?: number; swap?: number; cmd?: string[]; start?: number }) {
      const d = join(proc, String(pid));
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'status'), `Name:\t${o.name ?? 'node'}\nPPid:\t${o.ppid ?? 1}\nRssAnon:\t${(o.anon ?? 0) * 1024} kB\nVmSwap:\t${(o.swap ?? 0) * 1024} kB\n`);
      writeFileSync(join(d, 'stat'), `${pid} (a ) b) S ${o.ppid ?? 1} ${'0 '.repeat(17)}${o.start ?? 500} 0 0\n`);
      writeFileSync(join(d, 'cmdline'), (o.cmd ?? ['x']).join('\0') + '\0');
    },
  };
}

/** A relief on a fake clock: `run(seconds, some)` reads every 5 s. */
function relief(f: ReturnType<typeof fake>, kill?: (pid: number) => void) {
  const killed: number[] = [];
  const told: Victim[] = [];
  let now = 1_000_000;
  const r = new ContainerRelief({ dir: f.slice, prefix: 'citadel-claude-', proc: f.proc, now: () => now, kill: kill ?? ((pid) => void killed.push(pid)), report: (v) => void told.push(v) });
  return {
    killed,
    told,
    async run(seconds: number, some: number, gain = 100) {
      for (let t = 0; t < seconds; t += RELIEF.everyMs / 1000) {
        now += RELIEF.everyMs;
        f.read(some, gain);
        await r.tick();
      }
    },
  };
}

test('stuck for a minute: the process with the most anon plus swap dies, then the next one a minute later, and calm stops it', async () => {
  const f = fake();
  f.add(1, { name: 'podman-init', anon: 9000 }); // infrastructure: never, whatever its size
  f.add(10, { cmd: ['node', '/pin/turn-wrapper.mjs', '/run/turns/person-2/3832-1795572569727'], anon: 50, ppid: 1 });
  f.add(11, { name: '2.1.331', anon: 400, ppid: 10 });
  f.add(12, { name: 'cargo', anon: 300, swap: 900, ppid: 11, cmd: ['cargo', 'build'] });
  f.add(13, { name: 'rustc', anon: 1000, ppid: 12 });
  f.procs([1, 10, 11, 12, 13]);
  const r = relief(f);
  await r.run(60, 80); // the first reading only sets the baseline, so this is under a minute stuck
  assert.deepEqual(r.killed, []);
  await r.run(10, 80);
  assert.deepEqual(r.killed, [12]);
  await until('the kill is told', () => r.told.length > 0);
  assert.equal(r.told[0].ticket, 3832);
  assert.equal(r.told[0].bytes, 1200 * MB);
  assert.match(victimText(r.told[0]), /killed `cargo build` \(1\.2 GB\).*10\.0 GB memory limit for 60 s/);
  await r.run(50, 80);
  assert.deepEqual(r.killed, [12]); // once a minute
  await r.run(10, 80);
  assert.deepEqual(r.killed, [12, 13]); // 12 is still listed (dying): not again
  await r.run(300, 2);
  assert.deepEqual(r.killed, [12, 13]);
});

test('a squeeze below the line, short of a minute, or with no high events kills nothing', async () => {
  const f = fake();
  f.add(12, { anon: 3000 });
  f.procs([12]);
  const r = relief(f);
  await r.run(300, 25); // slowed, as MemoryHigh is meant to
  await r.run(55, 90);
  await r.run(5, 3); // calm starts the minute over
  await r.run(55, 90);
  await r.run(5, 3);
  await r.run(300, 90, 0); // stalled, but not at its limit
  for (let i = 0; i < 20; i++) {
    await r.run(5, 35); // one reading over the line
    await r.run(40, 15, 0); // then under it: those don't add up to a minute stuck
  }
  assert.deepEqual(r.killed, []);
});

test("a person's Taskmaster container, in the Taskmasters' slice, is relieved the same way (#1882)", async () => {
  assert.equal(TASKMASTER_SLICE, TURNS_OWN);
  const f = fake(`${TASKMASTER_SLICE}/citadel-claude-2-tm.service`);
  f.add(11, { anon: 400 });
  f.add(12, { name: 'cargo', anon: 3000 });
  f.procs([11, 12]);
  const r = relief(f);
  await r.run(70, 80);
  assert.deepEqual(r.killed, [12]);
});

test('only the containers of this server: another prefix, a slice or a turn scope is never touched', async () => {
  for (const unit of ['citadel-claude-ab12cd-2.service', 'citadel-turns.slice', 'claude-coordinator.service', `${TASKMASTER_SLICE}/citadel-turn-a-1.service`, `${TASKMASTER_SLICE}/citadel-claude-ab12cd-2-tm.service`]) {
    const f = fake(unit);
    f.add(12, { anon: 3000 });
    f.procs([12]);
    const r = relief(f);
    await r.run(200, 95);
    assert.deepEqual(r.killed, [], unit);
  }
});

test('a pid that will not take the signal gives way to the next biggest', async () => {
  const f = fake();
  f.add(12, { anon: 3000 });
  f.add(13, { anon: 2000 });
  f.procs([12, 13]);
  const tried: number[] = [];
  const r = relief(f, (pid) => {
    tried.push(pid);
    if (pid === 12) throw new Error('EPERM');
  });
  await r.run(70, 80);
  assert.deepEqual(tried, [12, 13]);
  assert.deepEqual(
    r.told.map((v) => v.pid),
    [13],
  );
});

test('two readings under the line do not start the minute over, so a flapping storm still ends', async () => {
  const f = fake();
  f.add(12, { anon: 3000 });
  f.procs([12]);
  const r = relief(f);
  for (let i = 0; i < 6; i++) {
    await r.run(5, 60);
    await r.run(10, 20);
  }
  assert.deepEqual(r.killed, [12]);
});

/** The write end of this FIFO, once a read has opened it: opening it for writing without waiting fails until then. */
async function writeEnd(fifo: string): Promise<number> {
  let fd = -1;
  await until('the FIFO has a reader', () => {
    try {
      fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      return true;
    } catch {
      return false;
    }
  });
  return fd;
}

/** Ends the read waiting on this FIFO. */
const endRead = async (fifo: string) => closeSync(await writeEnd(fifo));

for (const [what, change] of [
  ['was reused', (f) => writeFileSync(join(f.proc, '12', 'stat'), `12 (x) S 1 ${'0 '.repeat(17)}501 0 0\n`)],
  ['left the container', (f) => f.procs([13])],
] as [string, (f: ReturnType<typeof fake>) => void][]) {
  test(`a pid that ${what} after it was listed is not signalled`, async () => {
    const f = fake();
    f.add(12, { anon: 3000 });
    f.add(13, { anon: 2000 });
    f.procs([12, 13]);
    const r = relief(f);
    await r.run(65, 80); // the next reading kills
    // Its command line is read between the listing and the kill: that read is held until the pid has changed.
    const cmdline = join(f.proc, '12', 'cmdline');
    rmSync(cmdline);
    execFileSync('mkfifo', [cmdline]);
    const reading = r.run(5, 80);
    change(f);
    await endRead(cmdline);
    await reading;
    assert.deepEqual(r.killed, [13]);
  });
}

const gone = (c: ChildProcess) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : once(c, 'exit').then(() => {}));

test('the worker, on real processes: the big one is SIGKILLed while the small one lives', { timeout: 60_000 }, async () => {
  const f = fake();
  const start = (mb: number) => spawn(process.execPath, ['-e', `globalThis.b = Buffer.alloc(${mb} * 1048576, 1); console.log('up'); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const small = start(5);
  const big = start(250);
  try {
    await Promise.all([once(small.stdout!, 'data'), once(big.stdout!, 'data')]);
    f.procs([small.pid!, big.pid!]);
    // Each reading is handed over through two FIFOs, so none comes between the one that kills and the calm one after it
    // (a storm on a timer runs on until this process sees the exit, which on a loaded box is late enough for a second kill).
    const events = join(f.slice, 'citadel-claude-2.service', 'memory.events.local');
    const pressure = join(f.slice, 'citadel-claude-2.service', 'memory.pressure');
    execFileSync('mkfifo', [events, pressure]);
    const hand = (fd: number, line: string) => {
      writeSync(fd, line);
      closeSync(fd);
    };
    /** Hands over a stuck reading; resolves once the worker is done with it (the next reading has begun), with that one's write end. */
    const stuck = async (fd: number, high: number) => {
      hand(fd, `high ${high}\n`);
      hand(await writeEnd(pressure), 'some avg10=90.00\n');
      return writeEnd(events);
    };
    const told: Victim[] = [];
    const worker = startContainerRelief({ dir: f.slice, prefix: 'citadel-claude-', everyMs: 50, stuckMs: 300, report: (v) => void told.push(v) });
    try {
      let fd = await writeEnd(events);
      try {
        fd = await stuck(fd, 1); // the baseline
        fd = await stuck(fd, 2); // the minute starts
        const from = Date.now();
        await until('the container has been stuck long enough', () => Date.now() - from >= 300);
        fd = await stuck(fd, 3); // the kill
      } finally {
        // Plain files from here on, calm: a worker waiting on a FIFO could not be stopped. O_RDWR opens one with no reader too.
        const ends = [events, pressure].map((fifo) => openSync(fifo, constants.O_RDWR));
        for (const fifo of [events, pressure]) rmSync(fifo);
        f.read(0, 0);
        for (const end of ends) closeSync(end);
      }
      closeSync(fd);
      await until('the kill is told', () => told.length > 0);
      assert.equal(told[0].pid, big.pid);
      await gone(big);
      assert.equal(big.signalCode, 'SIGKILL');
      assert.equal(small.signalCode, null);
      assert.ok(told[0].bytes > 200 * MB, `${told[0].bytes}`);
      assert.doesNotMatch(readFileSync(`/proc/${small.pid}/status`, 'utf8'), /^State:\s+[ZX]/m);
    } finally {
      worker.stop();
    }
  } finally {
    for (const c of [small, big]) {
      c.kill('SIGKILL');
      await gone(c);
    }
  }
});
