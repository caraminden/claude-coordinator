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
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve, join } from 'node:path';
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
  const files = order(expand(o.targets.length ? o.targets : ['test/']), old);
  // The times file is this run's: a test that starts a run of its own must not rewrite it. (Not run()'s env option:
  // the leak guard's global setup adds its run id to process.env after this point, and the tests must inherit it.)
  delete process.env.CITADEL_TEST_TIMES;
  const stream = run({
    files,
    concurrency: o.concurrency,
    timeout: o.timeout,
    forceExit: true,
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
