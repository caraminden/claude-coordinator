// Preloaded (node --import) into the server test/host-signals.test.ts boots (#1485). It writes one line to
// $HOST_SIGNAL_TRAP for each kind of read that reaches the real box's signals: its CPU, memory and IO pressure, load,
// memory, CPU counters and cgroups, or a day or hour formatter in the real Pacific zone (#1536); and, when the server
// exits, the zone its local clock ran in. A server whose host signals are pinned (CITADEL_HOST_SIGNALS=fixed) writes only
// that last line.
import fs, { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { isMainThread } from 'node:worker_threads';

const LOG = process.env.HOST_SIGNAL_TRAP;
const PACIFIC = 'America/Los_Angeles'; // pacific-ok: the real zone this trap catches a server reading the day from
if (!LOG) throw new Error('host-signal-trap: set HOST_SIGNAL_TRAP to the log file');

/** The real box's signal files: PSI, load, memory, CPU counters, and the cgroup tree (its own cgroup included). */
export const HOST_FILE = /^\/proc\/(pressure(\/|$)|loadavg$|meminfo$|stat$|self\/cgroup$)|^\/sys\/fs\/cgroup(\/|$)/;

const seen = new Set<string>();
const note = (line: string) => {
  if (seen.has(line)) return;
  seen.add(line);
  appendFileSync(LOG, `${line}\n`);
};
const pathOf = (p: unknown): string => (typeof p === 'string' ? p : p instanceof URL ? p.pathname : Buffer.isBuffer(p) ? p.toString() : '');

const wrap = (obj: Record<string, unknown>, name: string, label: string) => {
  const real = obj[name];
  if (typeof real !== 'function') return;
  obj[name] = function (this: unknown, p: unknown, ...rest: unknown[]) {
    const path = pathOf(p);
    if (HOST_FILE.test(path)) note(`${label} ${path.replace(/^\/sys\/fs\/cgroup\/.*/, '/sys/fs/cgroup/…')}`);
    return real.call(this, p, ...rest);
  };
};
for (const n of ['readFileSync', 'readFile', 'readdirSync', 'readdir', 'openSync', 'open', 'createReadStream', 'statSync', 'stat']) wrap(fs, n, `fs.${n}`);
for (const n of ['readFile', 'readdir', 'open', 'stat']) wrap(fs.promises, n, `fs/promises.${n}`);
for (const n of ['loadavg', 'availableParallelism', 'cpus', 'freemem', 'totalmem'] as const) {
  const real = os[n] as (...a: unknown[]) => unknown;
  Object.assign(os, { [n]: (...a: unknown[]) => (note(`os.${n}()`), real(...a)) });
}
syncBuiltinESMExports(); // `import { readFile } from 'node:fs/promises'` and the like see the wrapped functions

// Day and hour: a formatter asked for the real Pacific zone reads the day (or the hour) the test's fixtures don't, since
// they use the zone the test handed the server (CITADEL_ZONE). src/host-signals.ts's dayZone reads Pacific's date to
// pick an afternoon zone when none was handed: the one read allowed.
const pacificAsked = (how: string, opts: unknown) => {
  if ((opts as { timeZone?: unknown } | undefined)?.timeZone === PACIFIC && !/\/src\/host-signals\.ts:/.test(new Error().stack ?? '')) note(`${how} in ${PACIFIC}`);
};
const RealFormat = Intl.DateTimeFormat;
Intl.DateTimeFormat = new Proxy(RealFormat, {
  construct: (t, args, nt) => (pacificAsked('Intl.DateTimeFormat', args[1]), Reflect.construct(t, args, nt)),
  apply: (t, self, args) => (pacificAsked('Intl.DateTimeFormat', args[1]), Reflect.apply(t, self, args)),
});
for (const m of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'] as const) {
  const real = Date.prototype[m] as (this: Date, ...a: unknown[]) => string;
  Date.prototype[m] = function (this: Date, locales?: unknown, opts?: unknown) {
    pacificAsked(`Date.${m}`, opts);
    return real.call(this, locales, opts);
  };
}

// The zone the server's local clock (getHours, setHours, a formatter with no zone) ran in.
// The server's own exit only: a worker that ends (the chat log's move at boot, #1169) fires its own 'exit'.
if (isMainThread) process.on('exit', () => appendFileSync(LOG, `zone ${new RealFormat().resolvedOptions().timeZone}\n`));
