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

/**
 * A dead stdout or stderr (the reader went away) is no crash: an 'error' listener on the stream keeps its EPIPE from
 * becoming an uncaughtException, and `onDead` runs once. Without it the last-resort handler logged each EPIPE to the dead
 * pipe, which raised the next, through nextTick, so timers and SIGTERM never ran again. Call it at start, before keepServing.
 */
export function guardPipes(onDead?: () => void) {
  for (const s of [process.stdout, process.stderr]) {
    s.on('error', () => {
      if (pipeDead) return;
      pipeDead = true;
      onDead?.();
    });
  }
}

/** The last resort: log a stray rejection or throw loudly and keep serving everyone else. */
export function keepServing() {
  process.on('unhandledRejection', (err) => say('UNHANDLED REJECTION, still serving:', err));
  process.on('uncaughtException', (err) => say('UNCAUGHT EXCEPTION, still serving:', err));
}
