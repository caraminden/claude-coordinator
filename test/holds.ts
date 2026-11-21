// The absence wait for tests. It imports nothing, like wait.ts; test/helpers.ts re-exports it.

/**
 * Show that something did NOT happen. `check` must stay true the whole time: it is polled every 20 ms and a break fails at
 * once, naming `what`. The wait ends on a witness, a second visible action that comes after the thing that should have
 * been ignored (`after`, truthy once it has happened: a later probe, the next event, the turn that does run), so nothing here
 * guesses how long "nothing" takes. With no witness to wait on, give `ms` (the window to watch); with one, `ms` caps the wait (30 s by default). Returns once the
 * witness is in and `check` still holds.
 */
export async function holds(what: string, check: () => unknown, opts: { after?: () => unknown; ms?: number } = {}): Promise<void> {
  if (!opts.after && opts.ms == null) throw new Error(`holds(${JSON.stringify(what)}): give a witness (after) or a window (ms)`);
  const end = Date.now() + (opts.ms ?? 30_000);
  for (;;) {
    if (!(await check())) throw new Error(`${what}: it happened`);
    if (opts.after ? await opts.after() : Date.now() >= end) return;
    if (opts.after && Date.now() > end) throw new Error(`Timed out waiting for the witness that ${what} stayed true`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
