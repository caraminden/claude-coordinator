// What a running turn costs the server's one thread (#1559). 100 fake turns, each writing two lines a second, run on a
// real server; the test reads the main thread's CPU time (CPU, not wall time, so a busy runner can't flake it) over a
// window when all of them are live, and divides by the turn-seconds. The budget is in test/turn-cost.json and may only
// fall: lower it when the number drops; raise it never (fix what made a turn dearer, or say why in the commit).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    await new Promise((r) => setTimeout(r, WINDOW_S * 1000)); // timing-ok: the measurement window is the point; CPU is read at its ends
    const perTurnSecond = (mainCpuMs(srv.proc.pid!) - before) / (TURNS * WINDOW_S);
    const { msPerTurnSecond } = JSON.parse(readFileSync(budgetFile, 'utf8'));
    writeFileSync(stop, '');
    console.log(`main thread: ${perTurnSecond.toFixed(3)} ms of CPU per turn-second (budget ${msPerTurnSecond})`);
    assert.ok(perTurnSecond <= msPerTurnSecond, `${perTurnSecond.toFixed(3)} ms of CPU per turn-second is over the budget of ${msPerTurnSecond}: a running turn got dearer for the server's one thread`);
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
