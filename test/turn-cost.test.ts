// What a running turn costs the server's one thread (#1559). 100 fake turns, each writing two lines a second, run on a
// real server; the test reads the main thread's CPU time over a window when all of them are live, and
// divides by the turn-seconds. CPU time is not load-proof (#1896): on a crowded box the same turns cost the thread 1.4
// to 2 times the CPU, so the reading is scaled by a spin timed in the same window (spinCpuMs).
// The budget is in test/turn-cost.json and may only
// fall: lower it when the number drops; raise it never (fix what made a turn dearer, or say why in the commit).
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import type { PoolSize } from '../src/turn-line.ts';
import { bootServer, stopTurns, until, ok } from './helpers.ts';

const TURNS = 100,
  WINDOW_S = 6,
  LIVE_S = 120; // a cap only: each turn ends when the test drops its stop file
const budgetFile = join(import.meta.dirname, 'turn-cost.json');
const root = mkdtempSync(join(tmpdir(), 'turn-cost-'));
// timing-ok: stopTurns ends every child first
after(async () => {
  await stopTurns(root);
  // timing-ok: stopTurns ends every child first
  rmSync(root, { recursive: true, force: true });
});

/** The main thread's CPU so far in ms: utime + stime of /proc/<pid>/task/<pid>, in 10 ms ticks. */
function mainCpuMs(pid: number): number {
  const st = readFileSync(`/proc/${pid}/task/${pid}/stat`, 'utf8');
  const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
  return (Number(f[11]) + Number(f[12])) * 10;
}

// What a fixed piece of file and JSON work costs this process in CPU right now: 22 ms on a quiet perigee, 25 on the CI
// desktop. With 10 copies at once on the desktop it read 53 to 76 while the turn cost read 2.6 to 3.7, against 1.8 with
// one copy; the server thread's involuntary switches went from 2 to between 2,400 and 11,800. The reading is only ever
// scaled down, and by half at most: the spin rises more than the turn cost does (3x against 2x).
// shortcut: a crowded run can pass a turn up to 1.4x over budget (the crowd costs 1.4x, the scale takes off 2x); a quiet run catches it.
const SPIN_QUIET_MS = 25;
const spinFile = join(root, 'spin');
function spinCpuMs(): number {
  const at = process.cpuUsage();
  for (let i = 0; i < 1500; i++) {
    appendFileSync(spinFile, `${JSON.stringify({ i, t: 'working on it' })}\n`);
    JSON.parse(readFileSync(spinFile, 'utf8').slice(0, 40).split('\n')[0]);
  }
  rmSync(spinFile, { force: true });
  const d = process.cpuUsage(at);
  return (d.user + d.system) / 1000;
}

test('a running turn costs the main thread under its budget of CPU per turn-second', { skip: process.platform !== 'linux', timeout: 180_000 }, async () => {
  const started = join(root, 'started');
  const stop = join(root, 'stop');
  const fake = join(root, 'claude-fake');
  writeFileSync(
    fake,
    `#!${process.execPath}
const { writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { createInterface } = require('node:readline');
mkdirSync(${JSON.stringify(started)}, { recursive: true });
createInterface({ input: process.stdin }).once('line', () => {
  writeFileSync(${JSON.stringify(started)} + '/' + process.pid, '');
  const say = () => console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } }));
  const end = () => { clearInterval(timer); console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' })); process.exit(0); };
  const timer = setInterval(() => (existsSync(${JSON.stringify(stop)}) ? end() : say()), 500);
  setTimeout(end, ${LIVE_S * 1000});
});
`,
  );
  chmodSync(fake, 0o755);
  // All of them run at once: the worker pool (#1868) would hold most in line.
  mkdirSync(join(root, 'data'), { recursive: true });
  const seed = new Store(join(root, 'data', 'coordinator.db'));
  seed.setSetting('turn-pool', { size: TURNS, at: 0, fixed: { size: TURNS, by: 'test' } } satisfies PoolSize);
  const srv = await bootServer({ root, env: { CLAUDE_BIN: fake } });
  try {
    const project = ok(await srv.call('/api/projects', { name: 'Load' }));
    for (let i = 0; i < TURNS; i++) await srv.call(`/api/projects/${project.id}/tickets`, { message: `turn ${i}` });
    await until(`${TURNS} turns running`, () => existsSync(started) && readdirSync(started).length >= TURNS, { timeout: 90_000 } as any);
    await new Promise((r) => setTimeout(r, 3000)); // timing-ok: their starts settle; a fixed settle before a CPU window
    const before = mainCpuMs(srv.proc.pid!);
    const spins: number[] = [];
    for (let s = 0; s < WINDOW_S; s++) {
      const t0 = Date.now();
      spins.push(spinCpuMs());
      await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - t0)))); // timing-ok: the measurement window is the point; CPU is read at its ends
    }
    const raw = (mainCpuMs(srv.proc.pid!) - before) / (TURNS * WINDOW_S);
    const spin = spins.sort((a, b) => a - b)[spins.length >> 1];
    const perTurnSecond = raw * Math.max(0.5, Math.min(1, SPIN_QUIET_MS / spin));
    const { msPerTurnSecond } = JSON.parse(readFileSync(budgetFile, 'utf8'));
    writeFileSync(stop, '');
    console.log(`main thread: ${perTurnSecond.toFixed(3)} ms of CPU per turn-second (budget ${msPerTurnSecond}; read ${raw.toFixed(3)}, spin ${spin.toFixed(0)} ms against ${SPIN_QUIET_MS} quiet)`);
    assert.ok(perTurnSecond <= msPerTurnSecond, `${perTurnSecond.toFixed(3)} ms of CPU per turn-second (read ${raw.toFixed(3)}, spin ${spin.toFixed(0)} ms) is over the budget of ${msPerTurnSecond}: a running turn got dearer for the server's one thread`);
  } finally {
    await srv.stop().catch(() => {});
  }
});

test("the budget never rises past main's", { skip: !existsSync(join(import.meta.dirname, '..', '.git')) }, async () => {
  const { execFileSync } = await import('node:child_process');
  let was: string;
  try {
    was = execFileSync('git', ['show', 'main:test/turn-cost.json'], { cwd: import.meta.dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return;
  } // not on main yet, or no main here
  assert.ok(JSON.parse(readFileSync(budgetFile, 'utf8')).msPerTurnSecond <= JSON.parse(was).msPerTurnSecond, 'test/turn-cost.json may only fall');
});
