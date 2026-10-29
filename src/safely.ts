// Keeping the server up: one failing request or background job must never take the process down.

/** Run a background job; a throw (or rejection) is logged with the job's name instead of escaping. */
export async function safely(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`Background job "${name}" failed:`, err);
  }
}

/** The last resort: log a stray rejection or throw loudly and keep serving everyone else. */
export function keepServing() {
  process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION, still serving:', err));
  process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION, still serving:', err));
}
