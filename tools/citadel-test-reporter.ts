// A node --test reporter for tools/citadel-test (#641): the short version of a run, for a minion's own test files.
// A line of counts; for each failed test its file and line, its name and the assertion message with the
// expected/actual diff, capped; a file that crashed before its tests ran shows what it printed; and a run stopped
// from outside (the time limit) names the tests still running. The full spec output goes to a log beside it.
import { relative, resolve } from 'node:path';

type Err = { message?: string; failureType?: string; stack?: string; cause?: unknown };
type Data = {
  name?: string;
  nesting?: number;
  file?: string;
  line?: number;
  skip?: unknown;
  todo?: unknown;
  message?: string;
  details?: { error?: Err; duration_ms?: number; type?: string };
  counts?: { passed: number; failed: number; cancelled: number; skipped: number; todo: number };
  duration_ms?: number;
  tests?: Data[];
};

/** Lines of detail shown per failure, and failures shown in detail; the rest are a name each, then a count. */
const PER_FAILURE = 40;
const DETAILED = 10;
const NAMED = 30;

const rel = (file: string) => relative(process.cwd(), resolve(file));

/** The error a test threw: node wraps it in an ERR_TEST_FAILURE whose cause is the real one. */
function thrown(error: Err | undefined): Err {
  const cause = error?.cause;
  return cause && typeof cause === 'object' ? (cause as Err) : (error ?? {});
}

/** The message, then the stack's frames outside node itself, so a TypeError says where it was thrown. */
function detail(error: Err | undefined): string[] {
  const e = thrown(error);
  const message = (e.message ?? String(e)).replace(/\n+$/, '');
  const frames = (e.stack ?? '')
    .split('\n')
    .filter((l) => /^\s+at /.test(l) && !/\(node:|at node:|\/node_modules\/|\(<anonymous>\)/.test(l))
    .slice(0, 4)
    .map((l) => l.trim().replace('file://', '').replace(`${process.cwd()}/`, ''));
  return [...message.split('\n'), ...frames];
}

function capped(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `… ${lines.length - max} more lines in the log`];
}

export default async function* summary(source: AsyncIterable<{ type: string; data: Data }>) {
  // Per file: the names of the test running and the suites it sits in, by nesting, and what the file printed to stderr.
  const path = new Map<string, string[]>();
  const stderr = new Map<string, string[]>();
  const running = new Map<string, Data>();
  const failures: { file: string; own: boolean; where: string; name: string; error?: Err }[] = [];
  let passed = 0;

  /** The summary; with `still` (the run was stopped from outside) the counts so far and what was still running. */
  function report(total?: Data, still?: Data[]): string {
    const c = total?.counts ?? { passed, failed: failures.length, cancelled: 0, skipped: 0, todo: 0 };
    const skipped = c.skipped + c.todo;
    const failed = c.failed + c.cancelled;
    const counts = `${c.passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`;
    let text = still
      ? `✖ stopped before the end (${counts} by then). Still running:\n${still
          .map((t) => {
            const file = resolve(t.file ?? t.name ?? '');
            const test = running.get(file);
            return `  ${rel(file)}${test ? `:${test.line} › ${(path.get(file) ?? []).join(' › ')}` : ''}\n`;
          })
          .join('')}`
      : `${failed ? '✖' : '✔'} ${counts} in ${((total?.duration_ms ?? 0) / 1000).toFixed(1)} s\n`;
    for (const f of failures.slice(0, DETAILED)) {
      // A file that failed outside any test (it threw while loading, or its process died): what it printed says why.
      const printed = f.own ? (stderr.get(f.file) ?? []) : [];
      const lines = capped(printed.length ? printed : detail(f.error), PER_FAILURE);
      text += `\n✖ ${f.where} › ${f.name}\n${lines.map((l) => `  ${l}`).join('\n')}\n`;
    }
    const named = failures.slice(DETAILED, DETAILED + NAMED);
    if (named.length) text += `\nThe other failures, detail in the log:\n${named.map((f) => `✖ ${f.where} › ${f.name}\n`).join('')}`;
    if (failures.length > DETAILED + NAMED) text += `… and ${failures.length - DETAILED - NAMED} more failures in the log\n`;
    return text;
  }

  // A reporter that stops reading makes node throw, so it reads on to the end after it has reported.
  let reported = false;
  for await (const { type, data } of source) {
    // A file's stderr events name it as given on the command line, its tests' events by absolute path.
    const file = data.file && resolve(data.file);
    if (reported) continue;
    if (type === 'test:summary' && !file) {
      reported = true;
      yield report(data);
    } else if (type === 'test:interrupted') {
      // node exits soon after this event (a SIGTERM from the time limit), so the report can't wait for the end.
      reported = true;
      yield report(undefined, data.tests ?? []);
    }
    if (!file) continue;
    if (type === 'test:stderr') {
      const lines = stderr.get(file) ?? [];
      lines.push(...(data.message ?? '').replace(/\n$/, '').split('\n'));
      stderr.set(file, lines.slice(-PER_FAILURE));
    } else if (type === 'test:dequeue') {
      const names = path.get(file) ?? [];
      names.length = data.nesting ?? 0;
      names.push(data.name ?? '');
      path.set(file, names);
      if (data.details?.type !== 'suite') running.set(file, data);
    } else if (type === 'test:pass' || type === 'test:fail') {
      if (running.get(file)?.name === data.name) running.delete(file);
      if (type === 'test:pass') {
        if (data.details?.type !== 'suite' && !data.skip && !data.todo) passed++;
        continue;
      }
      const error = data.details?.error;
      // A suite that failed because a test inside it did: that test is listed already.
      if (error?.failureType === 'subtestsFailed') continue;
      const own = resolve(data.name ?? '') === resolve(file);
      const name = own ? '(the file itself)' : [...(path.get(file) ?? []).slice(0, data.nesting ?? 0), data.name].join(' › ');
      failures.push({ file, own, where: `${rel(file)}${data.line && !own ? `:${data.line}` : ''}`, name, error });
    }
  }
  if (!reported) yield report();
}
