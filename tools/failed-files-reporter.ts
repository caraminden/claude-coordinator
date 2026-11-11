// A node --test reporter for tools/run-tests.sh: one line per test file with a failure, relative to where the run started.
import { relative, resolve } from 'node:path';

export default async function* failedFiles(source: AsyncIterable<{ type: string; data: { file?: string } }>) {
  const seen = new Set<string>();
  for await (const event of source) {
    const file = event.type === 'test:fail' ? event.data.file : undefined;
    if (!file || seen.has(file)) continue;
    seen.add(file);
    yield `${relative(process.cwd(), resolve(file))}\n`;
  }
}
