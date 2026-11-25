// One copy of the two ways Citadel runs a program: into a log with a time limit, and to a result.
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { constants } from 'node:os';

/**
 * Runs a command, its output appended to `log`: its exit code, 124 when it ran out of time, 127 when it wouldn't start, 128 + the
 * signal's number when a signal killed it (as a shell says it). A timeout stops its process group (SIGTERM, then SIGKILL after 10 s).
 * A timeout or a kill also ends the log with a line saying so: a killed build's own output just stops (#955).
 */
export const runLogged = (argv: string[], cwd: string, env: NodeJS.ProcessEnv, log: string, ms: number): Promise<number> =>
  new Promise<number>((ok) => {
    const fd = openSync(log, 'a');
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    let late = false;
    const timer = setTimeout(
      () => {
        late = true;
        try {
          process.kill(-child.pid!, 'SIGTERM');
          setTimeout(() => {
            try {
              process.kill(-child.pid!, 'SIGKILL');
            } catch {}
          }, 10_000).unref();
        } catch {}
      },
      Math.max(1, ms),
    );
    child.once('error', () => {
      clearTimeout(timer);
      ok(127);
    });
    const note = (line: string) => {
      try {
        appendFileSync(log, `\n== ${line}\n`);
      } catch {}
    };
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (late) {
        note(`stopped: it ran past ${ms / 1000} s`);
        return ok(124);
      }
      if (signal) {
        note(`killed by ${signal}`);
        return ok(128 + (constants.signals[signal] ?? 0));
      }
      ok(code ?? 1);
    });
  });

/** `err` is stderr as it came; `fail` is the spawn or exit error's message (empty when it ran clean). */
export interface ExecResult {
  code: number;
  out: string;
  err: string;
  fail: string;
}

/** Runs `bin` and resolves (never rejects) with its exit code (1 when it has none), stdout, stderr and the failure's message. */
export const execResult = (bin: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number } = {}): Promise<ExecResult> =>
  new Promise((ok) => {
    execFile(bin, args, opts, (err, out, errText) => ok({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out), err: String(errText), fail: err ? String(err.message) : '' }));
  });
