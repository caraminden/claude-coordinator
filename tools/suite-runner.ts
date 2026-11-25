// The full run's `node --test`, with its files started longest first (#1565). node's CLI always starts a run's
// files in name order, so a long file whose name sorts late (run-tests.test.ts) began near the end and the run waited
// on it alone: on Nov 21 that tail was about 30 s of a 167 s run, and 45 s of a 256 s one. node's run() starts files in
// the order it is given, so this hands it the files sorted by the seconds each took last time, kept in the file
// $CITADEL_TEST_TIMES ("<seconds>\t<file>" lines; CI keeps one per runner). A file with no time yet goes first, as
// it may be long; with no times file at all the order is the CLI's. The same tests run, in the same processes, with
// the same limits: only when each file starts changes.
//
// tools/run-tests.sh calls it in place of `node --test`, through tools/citadel-node:
//   suite-runner.ts --concurrency N --timeout MS [--global-setup FILE] [--failed-to FILE] [--] <file or folder>...
// It reports as the CLI did there: spec to stdout, tools/failed-files-reporter.ts to --failed-to, and
// tools/progress-reporter.ts when CITADEL_TEST_PROGRESS_TO is set (the CLI path got it from tools/citadel-node). It
// exits 1 when a test failed, as the CLI does, and forces exit once the tests end (--test-force-exit).
//
// While other full suites run on the machine, this one runs fewer files at once (#1871; Josh, 2026-11-24, "Scale down when
// overlapping"): N divided by the suites running, back to N once it is alone. CITADEL_SUITE_WINDOW names this run's own
// window file (tests.yml, #1811); the others in its folder are the other suites'. node's run() can't change its
// concurrency once started, so each file waits at tools/suite-gate.ts before its first import until a place is free.
//
// Load-sensitive files run last (#1898; Josh, 2026-11-24, "Can we move the load sensitive tests to only run when load is
// low?"). CITADEL_LATE_TESTS names a file listing them, one per line (tests.yml fetches it from Citadel, which makes it from
// the retro log's flake lines: src/late-tests.ts). They are ordered last and wait at the gate until every other file has
// ended, and then up to LATE_WAIT_MS for other suites' main waves (shorter in a run already long); then LATE_AT_ONCE run at
// a time. A red there is red like any other. While a suite's own main wave is over, "<window>.late" beside its window tells
// the others not to wait for it, so two suites never wait for each other.
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import failedFiles from './failed-files-reporter.ts';
import progress from './progress-reporter.ts';

// node's default patterns for a folder (checked on node 26; test/pipeline-files.test.ts pins the same list).
const nodeRuns = /(^|\/)(test|test-[^/]*|[^/]*[._-]test)\.[cm]?[jt]s$/;

export function expand(targets: string[], cwd = process.cwd()): string[] {
  const out = new Set<string>();
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.name !== 'node_modules' && !d.name.startsWith('.'))
      .flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
  for (const t of targets) {
    const abs = resolve(cwd, t);
    if (statSync(abs).isDirectory())
      for (const f of walk(abs)
        .filter((f) => nodeRuns.test(relative(abs, f)))
        .sort())
        out.add(f);
    else out.add(abs);
  }
  return [...out];
}

// "<seconds>\t<file>" lines, file relative to the run's folder. A line that doesn't read is skipped.
export function readTimes(path: string | undefined): Map<string, number> {
  const times = new Map<string, number>();
  if (!path) return times;
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return times;
  }
  for (const line of text.split('\n')) {
    const [s, file] = line.split('\t');
    const n = Number(s);
    if (file && s !== '' && Number.isFinite(n) && n >= 0) times.set(file, n);
  }
  return times;
}

// The files on the late list that this run has (relative to its folder in the list); none when it can't be read.
export function readLate(path: string | undefined, files: string[], cwd = process.cwd()): string[] {
  if (!path) return [];
  try {
    const listed = new Set(readFileSync(path, 'utf8').split('\n').filter(Boolean));
    return files.filter((f) => listed.has(relative(cwd, f)));
  } catch {
    return [];
  }
}

// Longest first; files with no time go before them all, in name order; ties keep name order.
export function order(files: string[], times: Map<string, number>, cwd = process.cwd()): string[] {
  if (times.size === 0) return [...files].sort();
  const t = (f: string) => times.get(relative(cwd, f)) ?? Infinity;
  return [...files].sort((a, b) => t(b) - t(a) || (a < b ? -1 : a > b ? 1 : 0));
}

// The new times: this run's for the files it ran, the old ones kept for files it left out that still exist (a
// product-tier run leaves out the pipeline's), and none for deleted files.
export function mergeTimes(old: Map<string, number>, ran: Map<string, number>, cwd = process.cwd()): string {
  const all = new Map(old);
  for (const [f, s] of ran) all.set(f, s);
  const keep = [...all].filter(([f]) => {
    try {
      return statSync(resolve(cwd, f)).isFile();
    } catch {
      return false;
    }
  });
  return keep
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([f, s]) => `${Math.round(s * 10) / 10}\t${f}\n`)
    .join('');
}

// How many other suites run now: open windows ("<start> 0") written in the last minute. Each suite freshens its own every
// 2 s (below), so a killed run's, left open, counts for a minute at most.
const BEAT_MS = 2000;
const STALE_MS = 60_000;
export const otherSuites = (window: string, now = Date.now()) => otherWindows(window, now).length;
/** Those still in their main wave: no "<window>.late" beside them. */
export const otherMainWaves = (window: string, now = Date.now()) => otherWindows(window, now).filter((w) => !existsSync(`${w}.late`)).length;

function otherWindows(window: string, now: number): string[] {
  const dir = dirname(window);
  const out: string[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (f === basename(window)) continue;
      const path = join(dir, f);
      try {
        const end = readFileSync(path, 'utf8').trim().split(' ')[1];
        if (end === '0' && now - statSync(path).mtimeMs < STALE_MS) out.push(path);
      } catch {} // gone meanwhile
    }
  } catch {} // no windows folder: alone
  return out;
}

export const filesAtOnce = (own: number, others: number) => Math.max(1, Math.ceil(own / (others + 1)));

const LATE_AT_ONCE = 2;
// A ship's run has 9 minutes on CI in all (land.sh's LAND_CI_TIMEOUT), so the wait is short and ends by the 4th minute.
const LATE_WAIT_MS = 60_000;
const LATE_WAIT_BY_MS = 240_000;
export const lateWait = (wait: number, elapsed: number) => Math.max(0, Math.min(wait, LATE_WAIT_BY_MS - elapsed));
// Some main file never reached the gate (it couldn't write there): none running this long is the wave's end too.
const SETTLED_MS = 10_000;

// The files' gate: a folder with "<pid>.wait" for each file waiting ("<pid>.late" for one on the late list, which `late`
// holds), "<pid>.run" for each let in, and "open" while nothing but the late files is held back, so a suite alone never
// waits. Returns its stop.
function startGate(window: string | undefined, own: number, late: string[], mains: number, started: number): () => void {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'suite-gate-'));
  const open = join(dir, 'open');
  const ownLate = window ? `${window}.late` : undefined;
  writeFileSync(join(dir, 'late'), late.join('\n'));
  let others = -1;
  let beat = -Infinity;
  const seen = new Set<number>(); // main files that reached the gate
  const lateRun = new Set<number>();
  let quietSince = 0; // since when no main file runs or waits
  let waveEnd = 0; // when the main wave ended
  let waveGo = false; // the late files may start
  const look = () => {
    if (Date.now() - beat < BEAT_MS) return;
    beat = Date.now();
    if (window) {
      try {
        utimesSync(window, new Date(), new Date());
      } catch {} // no window: the others can't see this suite, and it still sees them
    }
    const n = window ? otherSuites(window) : 0;
    if (n !== others && (n || others > 0)) process.stdout.write(`suite-runner: ${n} other suite(s) on this machine, so ${filesAtOnce(own, n)} test files at once (${own} alone)\n`);
    others = n;
    if (filesAtOnce(own, n) === own) writeFileSync(open, '');
    else rmSync(open, { force: true });
  };
  // Whether the late files may start now: the main wave has ended, and other suites' main waves too, or the cap passed.
  const lateMay = (running: number, waiting: number) => {
    if (waveGo) return true;
    const now = Date.now();
    quietSince = running || waiting ? 0 : quietSince || now;
    if (!waveEnd) {
      // node starts files in order, so a main file not seen yet is only starting.
      if (!quietSince || (seen.size < mains && now - quietSince < SETTLED_MS)) return false;
      waveEnd = now;
      try {
        if (ownLate) writeFileSync(ownLate, '');
      } catch {} // the others then wait for this suite up to their cap
    }
    const busy = window ? otherMainWaves(window) : 0;
    if (busy && now - waveEnd < lateWait(Number(process.env.CITADEL_LATE_WAIT ?? LATE_WAIT_MS), waveEnd - started)) return false;
    waveGo = true;
    if (busy) process.stdout.write(`suite-runner: ${busy} other suite(s) in their main wave after ${((now - waveEnd) / 1000).toFixed(1)} s: the load-sensitive test files run now\n`);
    process.stdout.write(`suite-runner: the main wave has ended; ${late.length} load-sensitive test files run now, ${LATE_AT_ONCE} at once, after ${Math.round((now - started) / 1000)} s\n`);
    return true;
  };
  const tick = () => {
    look();
    const max = filesAtOnce(own, others);
    if (max === own && !late.length) return;
    const names = readdirSync(dir);
    const of = (kind: string) =>
      names
        .filter((f) => f.endsWith(kind))
        .map((f) => parseInt(f, 10))
        .sort((a, b) => a - b); // node starts files in order, so the lowest pid waited longest
    let running = 0;
    let lateRunning = 0;
    for (const pid of of('.run')) {
      if (!lateRun.has(pid)) seen.add(pid);
      if (!existsSync(`/proc/${pid}`)) rmSync(join(dir, `${pid}.run`), { force: true });
      else if (lateRun.has(pid)) lateRunning++;
      else running++;
    }
    const waiting = of('.wait');
    const letIn = (pid: number, kind: string) => {
      try {
        renameSync(join(dir, `${pid}.${kind}`), join(dir, `${pid}.run`));
        return true;
      } catch {
        return false; // it let itself in while the gate was open
      }
    };
    const held = waiting.length;
    for (const pid of waiting) {
      if (running >= max) break;
      if (letIn(pid, 'wait')) running++;
    }
    const lates = of('.late');
    if (!lates.length || !lateMay(running, held)) return;
    for (const pid of lates) {
      if (lateRunning >= LATE_AT_ONCE) break;
      lateRun.add(pid);
      if (letIn(pid, 'late')) lateRunning++;
    }
  };
  tick();
  process.env.CITADEL_SUITE_GATE = dir;
  const timer = setInterval(tick, 100);
  return () => {
    clearInterval(timer);
    rmSync(dir, { recursive: true, force: true });
    if (ownLate) rmSync(ownLate, { force: true });
  };
}

function parseArgs(argv: string[]) {
  const o: { concurrency: number; timeout: number; globalSetup?: string; failedTo?: string; targets: string[] } = { concurrency: 1, timeout: Infinity, targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      o.targets.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--concurrency') o.concurrency = Number(argv[++i]);
    else if (a === '--timeout') o.timeout = Number(argv[++i]);
    else if (a === '--global-setup') o.globalSetup = argv[++i];
    else if (a === '--failed-to') o.failedTo = argv[++i];
    else if (a.startsWith('--')) throw new Error(`suite-runner: unknown option ${a}`);
    else o.targets.push(a);
  }
  if (!(o.concurrency >= 1)) throw new Error('suite-runner: --concurrency needs a number of 1 or more');
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const timesPath = process.env.CITADEL_TEST_TIMES || undefined;
  const old = readTimes(timesPath);
  const all = order(expand(o.targets.length ? o.targets : ['test/']), old);
  const late = readLate(process.env.CITADEL_LATE_TESTS, all);
  delete process.env.CITADEL_LATE_TESTS;
  const files = [...all.filter((f) => !late.includes(f)), ...late];
  // The times file is this run's: a test that starts a run of its own must not rewrite it. (Not run()'s env option:
  // the leak guard's global setup adds its run id to process.env after this point, and the tests must inherit it.)
  delete process.env.CITADEL_TEST_TIMES;
  const window = process.env.CITADEL_SUITE_WINDOW;
  delete process.env.CITADEL_SUITE_WINDOW;
  const stopGate = window || late.length ? startGate(window, o.concurrency, late, all.length - late.length, Date.now()) : undefined;
  const stream = run({
    files,
    concurrency: o.concurrency,
    timeout: o.timeout,
    forceExit: true,
    ...(stopGate ? { execArgv: ['--import', join(import.meta.dirname, 'suite-gate.ts')] } : {}),
    ...(o.globalSetup ? { globalSetupPath: resolve(o.globalSetup) } : {}),
  });
  // Each reporter reads its own copy of the events, as the CLI's reporters do.
  const copies: PassThrough[] = [];
  const copy = () => {
    const p = new PassThrough({ objectMode: true });
    copies.push(p);
    return p;
  };
  const ran = new Map<string, number>();
  let failed = false;
  const done: Promise<unknown>[] = [];
  const toStdout = copy().compose(spec);
  toStdout.pipe(process.stdout, { end: false });
  done.push(new Promise((r) => toStdout.on('end', r)));
  if (o.failedTo) {
    const out: string[] = [];
    done.push(
      (async () => {
        for await (const line of failedFiles(copy())) out.push(line);
        writeFileSync(o.failedTo!, out.join(''));
      })(),
    );
  }
  if (process.env.CITADEL_TEST_PROGRESS_TO)
    done.push(
      (async () => {
        for await (const _ of progress(copy())) void _;
      })(),
    );
  for await (const event of stream as AsyncIterable<{ type: string; data: { file?: string; nesting?: number; success?: boolean; details?: { duration_ms?: number } } }>) {
    const { type, data } = event;
    if (type === 'test:summary' && data.file === undefined && !data.success) failed = true;
    if ((type === 'test:pass' || type === 'test:fail') && data.file && data.nesting === 0) {
      const f = relative(process.cwd(), data.file);
      ran.set(f, (ran.get(f) ?? 0) + (data.details?.duration_ms ?? 0) / 1000);
    }
    for (const p of copies) p.write(event);
  }
  stopGate?.();
  for (const p of copies) p.end();
  await Promise.all(done);
  if (timesPath && ran.size) {
    try {
      writeFileSync(`${timesPath}.${process.pid}`, mergeTimes(old, ran));
      renameSync(`${timesPath}.${process.pid}`, timesPath);
    } catch {
      // Times that can't be kept only cost the next run its order.
    }
  }
  if (failed) process.exitCode = 1; // else as the global setup's teardown left it (the leak guard fails a run that way)
  // --test-force-exit: the tests are over, so nothing left open in this process keeps the run going.
  process.stdout.write('', () => process.exit());
}

if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  });
}
