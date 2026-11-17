// One copy of the two ways Citadel runs a program: into a log with a time limit, and to a result.
import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

/** Runs a command, its output appended to `log`: its exit code, 124 when it ran out of time, 127 when it wouldn't start. A timeout stops its process group (SIGTERM, then SIGKILL after 10 s). */
export const runLogged = (argv: string[], cwd: string, env: NodeJS.ProcessEnv, log: string, ms: number): Promise<number> => new Promise<number>((ok) => {
  const fd = openSync(log, 'a');
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    try {
      process.kill(-child.pid!, 'SIGTERM');
      setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 10_000).unref();
    } catch {}
  }, Math.max(1, ms));
  child.once('error', () => { clearTimeout(timer); ok(127); });
  child.once('close', (code) => { clearTimeout(timer); ok(late ? 124 : code ?? 1); });
});

export interface ExecResult { code: number; out: string; err: string }

/** Runs `bin` and resolves (never rejects) with its exit code (1 when it has none), stdout and stderr (the error's message when stderr is empty and nothing came out). */
export const execResult = (bin: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number } = {}): Promise<ExecResult> => new Promise((ok) => {
  execFile(bin, args, opts, (err: any, out, errText) => ok({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out), err: String(errText || (err && !out ? err.message : '')) }));
});
