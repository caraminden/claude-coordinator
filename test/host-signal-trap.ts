// Preloaded (node --import) into the server test/host-signals.test.ts boots (#1485). It writes one line to
// $HOST_SIGNAL_TRAP for each kind of read that reaches the real box's signals: its CPU, memory and IO pressure, load,
// memory, CPU counters and cgroups, or a time-of-day formatter in the real Pacific zone; and, when the server exits,
// the zone its local clock ran in. A server whose host signals are pinned (CITADEL_HOST_SIGNALS=fixed) writes only
// that last line.
import fs, { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';

const LOG = process.env.HOST_SIGNAL_TRAP;
if (!LOG) throw new Error('host-signal-trap: set HOST_SIGNAL_TRAP to the log file');

/** The real box's signal files: PSI, load, memory, CPU counters, and the cgroup tree (its own cgroup included). */
export const HOST_FILE = /^\/proc\/(pressure(\/|$)|loadavg$|meminfo$|stat$|self\/cgroup$)|^\/sys\/fs\/cgroup(\/|$)/;
const PACIFIC = 'America/Los_Angeles'; // pacific-ok: the real zone this trap catches a server reading the day from

const seen = new Set<string>();
const note = (line: string) => {
  if (seen.has(line)) return;
  seen.add(line);
  appendFileSync(LOG, `${line}\n`);
};
const pathOf = (p: unknown): string => (typeof p === 'string' ? p : p instanceof URL ? p.pathname : Buffer.isBuffer(p) ? p.toString() : '');

const wrap = (obj: any, name: string, label: string) => {
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
  (os as any)[n] = (...a: unknown[]) => (note(`os.${n}()`), real(...a));
}
syncBuiltinESMExports(); // `import { readFile } from 'node:fs/promises'` and the like see the wrapped functions

// Time of day: a formatter asked for the real Pacific zone decides the day (or the hour) from the real clock.
const pacificAsked = (how: string, opts: unknown) => {
  if ((opts as { timeZone?: unknown } | undefined)?.timeZone === PACIFIC) note(`${how} in ${PACIFIC}`);
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
  } as any;
}

// The zone the server's local clock (getHours, setHours, a formatter with no zone) ran in, and its hour then.
process.on('exit', () => {
  const zone = new RealFormat().resolvedOptions().timeZone;
  appendFileSync(LOG, `zone ${zone} hour ${new Date().getHours()}\n`);
});
