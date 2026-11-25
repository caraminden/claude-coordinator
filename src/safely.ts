// Keeping the server up: one failing request or background job must never take the process down.

/** Run a background job; a throw (or rejection) is logged with the job's name instead of escaping. */
export async function safely(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    say(`Background job "${name}" failed:`, err);
  }
}

let pipeDead = false;

/** console.error that never throws and says nothing once stdout or stderr has died: logging the dead pipe's own EPIPE to it raised the next one, forever (#1965). */
function say(...args: unknown[]) {
  if (pipeDead) return;
  try {
    console.error(...args);
  } catch {}
}

let watching = false;
let onDead: (() => void) | undefined;

/** One 'error' listener on stdout and stderr, once: a dead one's EPIPE then never becomes an uncaughtException. */
function watchPipes() {
  if (watching) return;
  watching = true;
  for (const s of [process.stdout, process.stderr]) {
    s.on('error', (err: NodeJS.ErrnoException) => {
      if (pipeDead) return;
      // Only a gone reader ends logging; any other stream error is still said once, loudly.
      if (!['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(err.code ?? '')) return say('stdout/stderr error, still serving:', err);
      pipeDead = true;
      onDead?.();
    });
  }
}

/**
 * A dead stdout or stderr (the reader went away) is no crash, and `fn` runs once when it dies. Without the listener the
 * last-resort handler logged each EPIPE to the dead pipe, which raised the next, through nextTick, so timers and SIGTERM
 * never ran again. Call it early: a pipe that dies during boot is caught; keepServing watches too, for callers without it.
 */
export function guardPipes(fn: () => void) {
  onDead = fn;
  watchPipes();
  if (pipeDead) fn();
}

/** The last resort: log a stray rejection or throw loudly and keep serving everyone else. */
export function keepServing() {
  watchPipes();
  process.on('unhandledRejection', (err) => say('UNHANDLED REJECTION, still serving:', err));
  process.on('uncaughtException', (err) => say('UNCAUGHT EXCEPTION, still serving:', err));
}
