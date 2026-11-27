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
// With CITADEL_TEST_SHARD=<index>/<total> (#2209, a ship's run on GitHub split 20 ways) it runs only that shard's files
// and keeps only their times; `suite-runner.ts --merge-times <old> <shard times>...` prints them merged for the next split.
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

// One shard's files (#2209): longest first (last time; a file with none counts as the median), each onto the shard with
// the least so far, ties to the lowest. Every shard works out the same split from the same files and times. `head`: seconds
// shard 0 has before its files (the burn-in runs there).
export function shard(files: string[], times: Map<string, number>, index: number, total: number, head = 0, cwd = process.cwd()): string[] {
  const known = files
    .map((f) => times.get(relative(cwd, f)))
    .filter((n) => n !== undefined)
    .sort((a, b) => a - b);
  const guess = known.length ? known[Math.floor(known.length / 2)] : 1;
  const t = (f: string) => times.get(relative(cwd, f)) ?? guess;
  const load = Array<number>(total).fill(0);
  load[0] = head;
  const mine: string[] = [];
  for (const f of [...files].sort((a, b) => t(b) - t(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    let k = 0;
    for (let i = 1; i < total; i++) if (load[i] < load[k]) k = i;
    load[k] += t(f);
    if (k === index) mine.push(f);
  }
  return mine;
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
  if (process.argv[2] === '--merge-times') {
    const [old, ...shards] = process.argv.slice(3);
    const ran = new Map<string, number>();
    for (const p of shards) for (const [f, s] of readTimes(p)) ran.set(f, s);
    process.stdout.write(mergeTimes(readTimes(old), ran));
    return;
  }
  const o = parseArgs(process.argv.slice(2));
  const timesPath = process.env.CITADEL_TEST_TIMES || undefined;
  const old = readTimes(timesPath);
  const split = process.env.CITADEL_TEST_SHARD?.match(/^(\d+)\/(\d+)$/);
  if (process.env.CITADEL_TEST_SHARD && !(split && Number(split[1]) < Number(split[2]))) throw new Error(`suite-runner: CITADEL_TEST_SHARD is <index>/<total> from 0, not ${process.env.CITADEL_TEST_SHARD}`);
  let files = expand(o.targets.length ? o.targets : ['test/']);
  if (split) {
    const [index, total] = [Number(split[1]), Number(split[2])];
    files = shard(files, old, index, total, Number(process.env.CITADEL_TEST_SHARD_HEAD) || 0);
    process.stdout.write(`suite-runner: shard ${index} of ${total}: ${files.length} test file(s)\n`);
    if (!files.length) return;
  }
  files = order(files, old);
  // The times file and the shard are this run's: a test that starts a run of its own must not rewrite it or run a shard.
  // (Not run()'s env option: the leak guard's global setup adds its run id to process.env after this point, and the
  // tests must inherit it.)
  delete process.env.CITADEL_TEST_TIMES;
  delete process.env.CITADEL_TEST_SHARD;
  delete process.env.CITADEL_TEST_SHARD_HEAD;
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
  // Files running now (#1879): a file's own events have name === file; its tests' have the test's name. When the
  // time limit's TERM arrives, each file still running is named with its seconds and its running test(s).
  const active = new Map<string, { t0: number; tests: Set<string> }>();
  process.on('SIGTERM', () => {
    const lines = [...active].map(([f, a]) => `still running: ${f} (${Math.round((Date.now() - a.t0) / 1000)}s)${a.tests.size ? ` in test: ${[...a.tests].join(', ')}` : ''}\n`);
    process.stdout.write(lines.join(''), () => process.exit(143));
  });
  for await (const event of stream as AsyncIterable<{ type: string; data: { file?: string; name?: string; nesting?: number; success?: boolean; details?: { duration_ms?: number } } }>) {
    const { type, data } = event;
    if (data.file && (type === 'test:dequeue' || type === 'test:complete')) {
      const f = relative(process.cwd(), data.file);
      if (data.name === data.file) {
        if (type === 'test:dequeue') active.set(f, { t0: Date.now(), tests: new Set() });
        else active.delete(f);
      } else if (data.name) {
        const a = active.get(f);
        if (type === 'test:dequeue') a?.tests.add(data.name);
        else a?.tests.delete(data.name);
      }
    }
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
      // A shard keeps only its own files' times: the merge after the run puts the shards together (--merge-times).
      writeFileSync(`${timesPath}.${process.pid}`, mergeTimes(split ? new Map() : old, ran));
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
