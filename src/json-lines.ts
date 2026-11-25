import type { Readable } from 'node:stream';

/**
 * Each JSON value a stream carries, one a line, as it arrives. Blank lines and lines that aren't JSON are skipped: a CLI
 * prints other things too. A CLI's shim runs this in a container, so it imports nothing of Citadel's.
 */
export function jsonLines<T>(stream: Readable, on: (m: T) => void): void {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let m: T;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      on(m);
    }
  });
}
