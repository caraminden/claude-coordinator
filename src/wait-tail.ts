// A waiting job's newest output lines (#1681): the tail of the file citadel-heavy tees a run's output into.
import { open } from 'node:fs/promises';
import { redact } from './timer-alerts.ts';

const READ = 64 * 1024; // only the file's end is read, so a huge line or log costs the same as a small one
const LINE = 300;

/** The last `n` lines of `file`, newest last: a `\r`-rewritten line keeps its latest state, colour codes dropped, secrets hidden. Empty when unreadable. */
export async function readTail(file: string, n: number): Promise<string[]> {
  let fh;
  try {
    fh = await open(file, 'r');
    const size = (await fh.stat()).size, len = Math.min(size, READ), buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map((l) => l.replace(/\r+$/, '').split('\r').pop()!);
    if (lines.at(-1) === '') lines.pop();
    // A read that began mid-file starts mid-line: its first piece isn't a whole line.
    if (size > len && lines.length > 1) lines.shift();
    return lines.slice(-n).map((l) => redact(l).slice(-LINE));
  } catch {
    return [];
  } finally {
    await fh?.close();
  }
}
