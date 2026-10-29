// Ports for servers this app (and its tests) start on 127.0.0.1. Picking a free port and binding it
// later races: in the gap, the kernel can hand that port to another process's listen(0) or to an
// outgoing connection, so the later bind fails or, worse, requests meet someone else's server.
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';

/**
 * The port a server.ts started with PORT=0 bound, read from its "listening on http://host:port"
 * line on stdout (which must be piped). Rejects if it exits or `ms` passes first.
 */
export function listeningPort(proc: ChildProcess, ms = 20_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: proc.stdout! });
    const done = (fn: () => void) => {
      clearTimeout(timer);
      proc.off('exit', exited);
      lines.close();
      // Closing readline pauses stdout; keep it flowing so a full pipe never blocks the server.
      proc.stdout!.resume();
      fn();
    };
    const exited = (code: number | null) => done(() => reject(new Error(`The server exited during boot (code ${code})`)));
    const timer = setTimeout(() => done(() => reject(new Error(`The server did not say which port it listens on within ${ms / 1000} s`))), ms);
    proc.once('exit', exited);
    lines.on('line', (line) => {
      const port = Number(/listening on http:\/\/.*:(\d+)$/.exec(line)?.[1]);
      if (port) done(() => resolve(port));
    });
  });
}

/**
 * A port nothing listens on now, for a server that has to be told its port before it starts (a
 * branch's server.ts from before PORT=0 was reported, or a test of a server that is down). It is
 * picked below 32768, outside the range Linux hands out to listen(0) and outgoing connections
 * (ip_local_port_range, 32768-60999), so only another hand-picked port can take it in the gap.
 */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = 10_000 + Math.floor(Math.random() * 22_768);
    const srv = createServer();
    const ok = await new Promise<boolean>((r) => {
      srv.once('error', () => r(false));
      srv.listen(port, '127.0.0.1', () => r(true));
    });
    if (ok) {
      await new Promise((r) => srv.close(r));
      return port;
    }
  }
}
