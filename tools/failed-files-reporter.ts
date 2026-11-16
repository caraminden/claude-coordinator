// A node --test reporter for tools/run-tests.sh: one line per test file with a failure, relative to where the run started,
// then a tab and the file's own time in this run in whole seconds (its top-level tests' durations added up): the rerun's
// limit is sized from it, so a long file isn't called hung for taking as long alone as it did in the run.
import { relative, resolve } from 'node:path';

type Ev = { type: string; data: { file?: string; nesting?: number; details?: { duration_ms?: number } } };

export default async function* failedFiles(source: AsyncIterable<Ev>) {
  const failed = new Set<string>();
  const ms = new Map<string, number>();
  for await (const { type, data } of source) {
    if (!data.file || (type !== 'test:pass' && type !== 'test:fail')) continue;
    if (type === 'test:fail') failed.add(data.file);
    if (data.nesting === 0) ms.set(data.file, (ms.get(data.file) ?? 0) + (data.details?.duration_ms ?? 0));
  }
  for (const file of failed) yield `${relative(process.cwd(), resolve(file))}\t${Math.ceil((ms.get(file) ?? 0) / 1000)}\n`;
}
