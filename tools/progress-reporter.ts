// A node --test reporter for a minion's wait (#545): how many test files are done, of how many, the newest one
// running, and the files with a failed test so far (tab-separated, #1368), as four lines in the file
// $CITADEL_TEST_PROGRESS_TO (tools/citadel-node sets it), written by a rename so nobody reads half of it. src/waits.ts reads it. It yields nothing, and nothing it does can fail or
// slow the run: every event is handled in its own try, and it always reads the stream to the end.
import { renameSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

type Event = { type: string; data?: { name?: string; file?: string; todo?: unknown; details?: { passed?: boolean } } };

export default async function* progress(source: AsyncIterable<Event>) {
  const to = process.env.CITADEL_TEST_PROGRESS_TO;
  const files = new Set<string>(),
    done = new Set<string>(),
    failed = new Set<string>(),
    running: string[] = [];
  let shown = '';
  for await (const event of source) {
    try {
      const { name, file } = event.data ?? {};
      if (!to || !file) continue;
      // Any failed test marks its file, a todo's failure aside (it fails no run). test:complete says it as it happens;
      // test:fail waits its turn behind every file that started earlier, so a hang would hold it back (#1863).
      const red = event.type === 'test:fail' || (event.type === 'test:complete' && event.data?.details?.passed === false);
      if (red && !event.data?.todo) failed.add(file);
      // A file's own events carry its path as their name; the tests inside it carry their own names.
      if (name && resolve(name) === file) {
        if (event.type === 'test:enqueue') files.add(file);
        else if (event.type === 'test:dequeue') running.push(file);
        else if (event.type === 'test:complete') done.add(file);
      }
      const current = running.findLast((f) => !done.has(f));
      const rel = (f: string) => relative(process.cwd(), f);
      const text = `${done.size}\n${files.size}\n${current ? rel(current) : ''}\n${[...failed].map(rel).join('\t')}\n`;
      if (text === shown) continue;
      shown = text;
      writeFileSync(`${to}.tmp`, text);
      renameSync(`${to}.tmp`, to);
    } catch {
      // A count that can't be written is a count nobody sees: the run goes on.
    }
  }
}
