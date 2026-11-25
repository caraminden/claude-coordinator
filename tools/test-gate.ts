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
// ones, and within a run they go in order. CITADEL_TEST_ROOM_WAIT seconds (120) after
// the run's first wait its files start anyway, the later ones too, so nothing is stuck.
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

// Counts the held places, the ones above a shrunk limit too, and takes a free one when fewer than the limit are held; one lock
// around both, so two files can't count the same room. The place's lock passes to a helper that lives until this process is gone.
const TAKE = `exec 9>"$1" && flock -w 5 9 || exit; pid=$2 limit=$3 held=0 got=; shift 3
for f; do
  if [ -n "$got" ]; then flock -n "$f" true || held=$((held + 1))
  elif exec 8>"$f" && flock -n 8; then got=1
  else held=$((held + 1)); fi
done
[ -n "$got" ] && [ "$held" -lt "$limit" ] || exit
tail --pid="$pid" -f /dev/null 9>&- >/dev/null 2>&1 &
echo ok`;
function take(dir: string, places: string[], limit: number): Promise<boolean> {
  return new Promise((done) => {
    const { CITADEL_LEAK_FILE: _, ...clean } = env;
    const c = spawn('sh', ['-c', TAKE, 'sh', join(dir, 'test-count'), String(process.pid), String(limit), ...places], { env: clean, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (b) => (out += b));
    c.on('error', () => done(true));
    c.on('close', () => done(out.includes('ok')));
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
  // The cap is the run's: it counts from the run's first wait (the note's own time), so a run of many files can't wait it many
  // times over and run into citadel-test's own limit.
  const firstWait = () => {
    try {
      return note ? Math.min(since, statSync(note).mtimeMs) : since;
    } catch {
      return since;
    }
  };
  let touched = 0;
  try {
    for (;;) {
      const now = Date.now();
      if (now - touched >= 1000) {
        writeFileSync(mine, '');
        touched = now;
      }
      const live = readdirSync(line).filter((f) => {
        try {
          const age = now - statSync(join(line, f)).mtimeMs;
          if (age > 60_000) rmSync(join(line, f), { force: true }); // a killed waiter's
          return age < 5000;
        } catch {
          return false;
        }
      });
      const p = pressure();
      const limit = limitAt(p, start, min, max);
      const capped = now - firstWait() >= cap;
      // Past the cap it starts whatever is held, still taking a place if one is free, so the others count it.
      if ((capped || live.sort()[0] === me) && (await take(dir, places, capped ? max : limit))) return;
      if (capped) return;
      if (note && now - since >= 500) {
        try {
          writeFileSync(note, `waiting for room: ${limit} test files may run at once on this box${p === null ? '' : ` (CPU pressure ${p}%)`} and other files hold them; this run waits at most ${cap / 1000} s in all\n`, { flag: 'wx' });
        } catch {}
      }
      await sleep(250);
    }
  } finally {
    rmSync(mine, { force: true });
  }
}

await gate().catch(() => {});
