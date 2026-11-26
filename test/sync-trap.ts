// The trap the off-thread tests share (#1768, #2135): it catches a blocking file call or process start on the server's
// one thread while a path under test runs.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

/** Runs `fn` and returns the synchronous fs calls made under `dir` before it returned its promise's result. */
export async function syncCallsUnder<T>(dir: string, fn: () => T | Promise<T>, fds = false): Promise<string[]> {
  const names = ['readFileSync', 'readdirSync', 'writeFileSync', 'renameSync', 'existsSync', 'statSync', 'openSync', 'accessSync', 'mkdirSync', 'rmSync', 'linkSync', 'symlinkSync', 'cpSync', 'copyFileSync', 'appendFileSync', 'lstatSync', 'realpathSync', 'readlinkSync', 'utimesSync'] as const;
  const real = Object.fromEntries(names.map((n) => [n, fs[n]]));
  const seen: string[] = [];
  // A blocking process start holds the thread the same way, wherever it runs (#2111).
  const starts = ['execFileSync', 'execSync', 'spawnSync'] as const;
  const realStarts = Object.fromEntries(starts.map((n) => [n, childProcess[n]]));
  for (const n of starts)
    (childProcess as Record<string, unknown>)[n] = (cmd: unknown, ...rest: unknown[]) => {
      seen.push(`${n} ${String(cmd)}`);
      return (realStarts[n] as (...args: unknown[]) => unknown)(cmd, ...rest);
    };
  for (const n of names)
    (fs as Record<string, unknown>)[n] = (p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.startsWith(dir)) seen.push(`${n} ${p.slice(dir.length)}`);
      return (real[n] as (...args: unknown[]) => unknown)(p, ...rest);
    };
  // With `fds`, calls on an open file too, whatever file it is: a kept-open stream asked or read on the thread (#2134).
  const onFds = fds ? (['fstatSync', 'readSync'] as const) : [];
  const realFds = Object.fromEntries(onFds.map((n) => [n, fs[n]]));
  for (const n of onFds)
    (fs as Record<string, unknown>)[n] = (...args: unknown[]) => {
      seen.push(n);
      return (realFds[n] as (...args: unknown[]) => unknown)(...args);
    };
  syncBuiltinESMExports();
  try {
    await fn();
  } finally {
    for (const n of onFds) (fs as Record<string, unknown>)[n] = realFds[n];
    for (const n of names) (fs as Record<string, unknown>)[n] = real[n];
    for (const n of starts) (childProcess as Record<string, unknown>)[n] = realStarts[n];
    syncBuiltinESMExports();
  }
  return seen;
}
