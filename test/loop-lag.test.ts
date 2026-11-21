import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ioStalledUs, namedStacks, openersOf, stallCause, stallSpan, summarizeWaits, watchLoopLag, type Reading } from '../src/loop-lag.ts';
import { until } from './wait.ts';

const spin = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until); // synchronous work, as a git call on the event loop is
};
const waitFor = async (ok: () => boolean, ms = 5000) => {
  await until('the condition', async () => ok(), ms);
};

test('a stall of the event loop is logged with its length, and a free loop logs nothing', async () => {
  const logged: string[] = [];
  const watch = watchLoopLag((text) => logged.push(text), 10, 150);
  try {
    await new Promise((r) => setTimeout(r, 100));
    // A loaded box can keep the loop waiting for the CPU past the threshold: a real stall, rightly logged (#1424).
    // What a free loop never logs is a stall of its own work.
    assert.deepEqual(logged.filter((l) => /Cause: own work/.test(l)), [], 'nothing in the process held it');
    const before = logged.length;
    spin(400);
    await waitFor(() => logged.length > before);
    const line = logged[before]; // the first tick after the spin measures it; any later line is the box's own stall
    const held = Number(line.match(/held for (\d+\.\d) s/)?.[1]);
    assert.ok(held >= 0.3, `it logs the stall's length: ${line}`); // longer on a busy box, never shorter
    // Where the kernel tells disk stalls (PSI), the line says how much of it was the disk (#622).
    if (ioStalledUs() != null) assert.match(line, / Disk: the box was fully stalled on I\/O for \d+\.\d s of it\.$/);
  } finally {
    watch.stop();
  }
});

test('with the sampler on, a stall names the code that held the loop (#609)', async () => {
  const logged: string[] = [];
  const watch = watchLoopLag((text) => logged.push(text), 10, 150, { profile: true });
  try {
    await new Promise((r) => setTimeout(r, 200)); // the sampler starts
    function holdTheLoopForTest() { spin(600); }
    holdTheLoopForTest();
    // On a loaded box other real stalls get lines too (waiting for the CPU, the sampler's own start): this one is
    // the line that names the function that held the loop, and it gets exactly one (#1424).
    const ours = () => logged.filter((l) => /holdTheLoopForTest \(test\/loop-lag\.test\.ts:\d+\)/.test(l));
    await waitFor(() => ours().length > 0);
    assert.equal(ours().length, 1, logged.join('\n'));
    assert.match(ours()[0], /held for \d+\.\d s \([^)]+\): .* Running: \d+% /);
  } finally {
    watch.stop();
  }
});

test('namedStacks counts only the window, leaf first then the repo\'s own callers outward', () => {
  const root = new URL('..', import.meta.url).href;
  const frame = (functionName: string, url = '', lineNumber = 0) => ({ functionName, url, lineNumber });
  const profile = {
    startTime: 1000,
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2, 5] },
      { id: 2, callFrame: frame('handler', `${root}src/routes/projects.ts`, 410), children: [3] },
      { id: 3, callFrame: frame('listTickets', `${root}src/db.ts`, 1200), children: [4] },
      { id: 4, callFrame: frame('all', 'node:sqlite') },
      { id: 5, callFrame: frame('(garbage collector)') },
    ],
    // at 1010, 1020, 1030, 1040, 1050: the first and last fall outside [1015, 1045]
    samples: [4, 4, 4, 5, 5],
    timeDeltas: [10, 10, 10, 10, 10],
  };
  assert.equal(namedStacks([profile], 1015, 1045), '67% all (node:sqlite) < listTickets (src/db.ts:1201) < handler (src/routes/projects.ts:411); 33% (garbage collector)');
  assert.equal(namedStacks([profile], 2000, 3000), '', 'no sample in the window');
  // A stall across the sampler's roll is read from both profiles, the roll's and the next.
  const next = { ...profile, startTime: 1050, samples: [4], timeDeltas: [5] };
  assert.equal(namedStacks([profile, next], 1015, 1060), '56% all (node:sqlite) < listTickets (src/db.ts:1201) < handler (src/routes/projects.ts:411); 44% (garbage collector)'); // weighted by time: 25 of 45
});

test('ioStalledUs reads the box\'s full I/O stall from PSI, and null without it (#622)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'psi-'));
  try {
    writeFileSync(join(dir, 'io'), 'some avg10=0.30 avg60=0.85 avg300=1.26 total=8868426449\nfull avg10=0.25 avg60=0.64 avg300=0.86 total=4769907761\n');
    assert.equal(ioStalledUs(join(dir, 'io')), 4769907761);
    assert.equal(ioStalledUs(join(dir, 'none')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openersOf names the other processes with a database open, its -wal included, not the server itself (#622)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openers-'));
  const db = join(dir, 'coordinator.db');
  writeFileSync(`${db}-wal`, '');
  const child = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(`${db}-wal`)}, 'r'); console.log('open'); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((r) => child.stdout!.once('data', r));
    const who = await openersOf([db, join(dir, 'state.db')]);
    assert.deepEqual(who.filter((w) => w.startsWith(`${child.pid} `)), [`${child.pid} ${process.execPath.split('/').at(-1)} -e`]);
    assert.ok(!who.some((w) => w.startsWith(`${process.pid} `)));
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
    rmSync(dir, { recursive: true, force: true });
  }
});

const reading = (over: Partial<Reading> = {}): Reading => ({ cpuUs: 0, majorFaults: 0, voluntarySwitches: 0, involuntarySwitches: 0, cpuWaitUs: 0, ioWaitUs: 0, memWaitUs: 0, ...over });

test('stallCause names each cause from the counters over a 2 s stall (P2)', () => {
  const at = reading();
  assert.equal(stallCause(at, reading({ cpuUs: 1_900_000 }), 2000).cause, 'own work');
  assert.equal(stallCause(at, reading({ cpuUs: 200_000, cpuWaitUs: 1_500_000, involuntarySwitches: 40 }), 2000).cause, 'waited for CPU');
  assert.equal(stallCause(at, reading({ cpuUs: 100_000, ioWaitUs: 1_200_000 }), 2000).cause, 'waited for disk');
  assert.equal(stallCause(at, reading({ cpuUs: 100_000, memWaitUs: 1_200_000, majorFaults: 900 }), 2000).cause, 'waited for memory');
  assert.equal(stallCause(at, reading({ cpuUs: 100_000 }), 2000).cause, 'unclear');
  // Memory starves the CPU share too, so it outranks CPU pressure; a box that can't say falls back on CPU time.
  assert.equal(stallCause(at, reading({ cpuWaitUs: 1_500_000, memWaitUs: 1_500_000 }), 2000).cause, 'waited for memory');
  assert.equal(stallCause(at, reading({ cpuUs: 1_900_000, cpuWaitUs: null, ioWaitUs: null, memWaitUs: null }), 2000).cause, 'own work');
  const t = stallCause(at, reading({ cpuUs: 1_900_000, majorFaults: 3, voluntarySwitches: 5, involuntarySwitches: 7 }), 2000).text;
  assert.match(t, /1\.9 s on CPU of 2\.0 s; .* 3 major faults, 5 voluntary and 7 involuntary switches/);
});

test('a real stall line carries its cause and the writer backlog (P2)', async () => {
  const logged: string[] = [];
  const watch = watchLoopLag((text) => logged.push(text), 10, 150, { backlog: () => 7 });
  try {
    await new Promise((r) => setTimeout(r, 100));
    spin(400);
    await waitFor(() => logged.length > 0);
    assert.match(logged[0], /held for \d+\.\d s \([^)]+\): the server answered nobody meanwhile\. Cause: (own work|waited for CPU|waited for disk|waited for memory|unclear) \(.*; 7 writes queued on the write worker\)\./, logged[0]);
  } finally {
    watch.stop();
  }
});

test('a stall line states its own start and end clock time, measured when it was detected', async () => {
  const logged: string[] = [];
  const watch = watchLoopLag((text) => logged.push(text), 10, 150);
  try {
    const before = Date.now();
    spin(400);
    await waitFor(() => logged.length > 0);
    const m = /held for \d+\.\d s \((\d\d):(\d\d):(\d\d) to (\d\d):(\d\d):(\d\d) P[SD]T\)/.exec(logged[0]);
    assert.ok(m, logged[0]);
    assert.match(stallSpan(before, before + 1000), /^\d\d:\d\d:\d\d to \d\d:\d\d:\d\d P[SD]T$/);
  } finally {
    watch.stop();
  }
});

test('summarizeWaits names the commonest kernel waits, a D state with its wchan', () => {
  const s = (state: string, wchan: string) => ({ state, wchan });
  assert.equal(summarizeWaits([s('D', 'folio_wait_bit_common'), s('D', 'folio_wait_bit_common'), s('S', 'futex_wait_queue'), s('R', '0')]), 'D folio_wait_bit_common ×2, S futex_wait_queue ×1, R ×1');
  assert.equal(summarizeWaits([]), '');
});

test('a hold of the main thread is sampled from /proc by a worker: the line names the kernel state it was in', { skip: process.platform !== 'linux' }, async () => {
  const logged: string[] = [];
  const watch = watchLoopLag((text) => logged.push(text), 10, 150);
  try {
    // The worker takes a moment to start: hold the loop again until a line carries its samples.
    await until('a stall line with the held thread running', async () => {
      spin(700);
      await new Promise((r) => setImmediate(r));
      return logged.some((l) => /Main thread waited on: R ×\d+/.test(l));
    });
    // Blocked off-CPU, as on a disk wait: the thread sleeps in the kernel.
    logged.length = 0;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
    await waitFor(() => logged.some((l) => /Main thread waited on: S/.test(l)));
  } finally {
    watch.stop();
  }
});

test('namedStacks weights by time, so a gap with no samples counts for the frame after it, and outer names the job', () => {
  const cf = (functionName: string, lineNumber: number) => ({ functionName, url: new URL('../src/x.ts', import.meta.url).href, lineNumber });
  const profile = {
    nodes: [{ id: 1, callFrame: cf('', 0), children: [2] }, { id: 2, callFrame: cf('job', 4), children: [3, 4] }, { id: 3, callFrame: cf('fast', 9) }, { id: 4, callFrame: cf('slowRead', 19) }],
    startTime: 0, samples: [3, 4], timeDeltas: [10_000, 90_000],
  };
  assert.equal(namedStacks([profile], 0, 100_000), '90% slowRead (src/x.ts:20) < job (src/x.ts:5) < (anonymous) (src/x.ts:1); 10% fast (src/x.ts:10) < job (src/x.ts:5) < (anonymous) (src/x.ts:1)');
  assert.equal(namedStacks([profile], 0, 100_000, 3, true), '100% job (src/x.ts:5)');
});
