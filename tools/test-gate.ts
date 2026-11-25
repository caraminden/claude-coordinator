// One shared limit on test files running at once, across every citadel-test run on the box (#1928, Josh 2026-11-25:
// "One shared limit", and the limit scales with CPU pressure like the worker pool). tools/citadel-test puts this file in
// NODE_OPTIONS, so it loads first in every test file's own process (node --test runs each file in a child of the runner)
// and holds that file back until a place is free. The place is a flock(1) lock on $CITADEL_HEAVY_DIR/test-slot-N, the folder
// every container mounts at the same path; the lock lives in a small helper that watches this process (tail --pid), so a
// killed file frees its place and no counter file can go stale. The helper is no child of this process and carries no
// leak-guard id, so test/leak-file.ts doesn't count it.
// How many places: CITADEL_TEST_FILES (4 to start; 0 = off), moved by the host's CPU pressure ("some avg60" of
// /proc/pressure/cpu, the reading the worker pool in src/turn-limits.ts uses, whose pool grows under 35% and shrinks at 50%):
//   under 8%: ceiling (CITADEL_TEST_FILES_MAX, 8) | under 15%: start + 2 | 15-24%: start | 25-34%: start - 1 | 35% and up: floor (_MIN, 2)
// Tests give way first: they shed at 25%, ten points before the pool stops growing, and are down to the floor at 35%, so the
// pressure our own test files raise never carries the pool past its grow mark, and the pool, which only shrinks at 50%, never
// sees tests holding its reading up. The limit is read at each file's start: files already running finish, none is killed.
// A new file starts only while fewer places than that are held, the ones above a shrunk limit included.
// Waiting: a line of small files in $CITADEL_HEAVY_DIR/test-line, each kept fresh while it waits and holding no place. It goes
// by each file's number within its own run, then by when it asked: a run's first file is never behind another run's later
// ones, and within a run they go in order. A file starts anyway after CITADEL_TEST_ROOM_WAIT seconds (120), so nothing is stuck.
// The run's first file to wait half a second writes one line to $CITADEL_TEST_GATE_NOTE, which citadel-test prints as it
// appears. Any error here lets the file run.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const env = process.env;
env.NODE_OPTIONS = (env.NODE_OPTIONS ?? '').replace(/\s*--import=\S*test-gate\.ts/, '');
const n = (v: string | undefined, d: number) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : d);

/** The places open at this CPU pressure (null: no reading, so the start). Pure, for the tests. */
export function limitAt(pressure: number | null, start: number, min: number, max: number): number {
  const l = pressure === null ? start : pressure >= 35 ? min : pressure >= 25 ? start - 1 : pressure < 8 ? max : pressure < 15 ? start + 2 : start;
  return Math.max(min, Math.min(max, l));
}

function pressure(): number | null {
  try {
    const m = readFileSync(env.CITADEL_HEAVY_PRESSURE || '/proc/pressure/cpu', 'utf8').match(/^some .*avg60=([\d.]+)/m);
    return m ? Math.floor(Number(m[1])) : null;
  } catch {
    return null;
  }
}

// A place is taken by a helper that holds the flock until this process is gone: it prints ok (taken) or no (busy).
const HOLD = '( flock -n "$1" sh -c \'echo ok; exec tail --pid="$0" -f /dev/null\' "$2" || echo no ) &';
function tryHold(file: string): Promise<boolean> {
  return new Promise((done) => {
    const { CITADEL_LEAK_FILE: _, ...clean } = env;
    const c = spawn('sh', ['-c', HOLD, 'sh', file, String(process.pid)], { env: clean, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const finish = (ok: boolean) => {
      c.stdout.destroy();
      c.unref();
      done(ok);
    };
    c.stdout.on('data', (b) => {
      out += b;
      if (out.includes('ok')) finish(true);
      else if (out.includes('no')) finish(false);
    });
    c.on('error', () => finish(true));
    c.on('close', () => finish(out.includes('ok')));
  });
}

// How many places are held right now, over all of them: a shrink must count the files still running in the places above it.
function heldPlaces(files: string[]): Promise<number> {
  return new Promise((done) => {
    const c = spawn('sh', ['-c', 'for f; do flock -n "$f" true || echo held; done', 'sh', ...files], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (b) => (out += b));
    c.on('error', () => done(0));
    c.on('close', () => done(out.split('held').length - 1));
  });
}

async function gate() {
  const start = n(env.CITADEL_TEST_FILES, 4);
  if (start === 0 || env.RUNNER_TEMP || env.GITHUB_ACTIONS || env.CITADEL_HEAVY_HELD) return;
  const min = n(env.CITADEL_TEST_FILES_MIN, 2);
  const max = Math.max(start, min, n(env.CITADEL_TEST_FILES_MAX, 8));
  const dir = env.CITADEL_HEAVY_DIR || join(env.HOME ?? '', '.local/share/claude-coordinator/projects/.heavy');
  const places = Array.from({ length: max }, (_, i) => join(dir, `test-slot-${i}`));
  const line = join(dir, 'test-line');
  mkdirSync(line, { recursive: true });
  // This file's number within its run, from a byte each of the run's files adds to one file.
  const note = env.CITADEL_TEST_GATE_NOTE;
  let nth = 1;
  if (note) {
    appendFileSync(`${note}.n`, '.');
    nth = statSync(`${note}.n`).size;
  }
  const me = `${String(nth).padStart(6, '0')}-${String(Date.now()).padStart(15, '0')}-${Math.random().toString(36).slice(2)}`;
  const mine = join(line, me);
  const cap = n(env.CITADEL_TEST_ROOM_WAIT, 120) * 1000;
  const since = Date.now();
  let told = !note;
  try {
    for (;;) {
      writeFileSync(mine, '');
      const live = readdirSync(line).filter((f) => {
        try {
          return Date.now() - statSync(join(line, f)).mtimeMs < 5000;
        } catch {
          return false;
        }
      });
      const waited = Date.now() - since;
      const p = pressure();
      const limit = limitAt(p, start, min, max);
      const head = live.sort()[0] === me;
      if (head && (await heldPlaces(places)) < limit) for (const f of places) if (await tryHold(f)) return;
      if (waited >= cap) {
        // Started past the limit, it still takes a place if one is free, so the others count it.
        for (const f of places) if (await tryHold(f)) return;
        return;
      }
      if (!told && note && waited >= 500) {
        told = true;
        try {
          writeFileSync(note, `waiting for room: ${limit} test files may run at once on this box${p === null ? '' : ` (CPU pressure ${p}%)`} and other files hold them; each starts anyway after ${cap / 1000} s\n`, { flag: 'wx' });
        } catch {}
      }
      await sleep(head ? 150 : 50);
    }
  } finally {
    rmSync(mine, { force: true });
  }
}

await gate().catch(() => {});
