/**
 * A long scan's pause (#1414): await the function it returns between the scan's steps, and it yields to the event loop
 * once the scan has held it `ms` since its last yield. Each step should be small (a chunk of rows, one file): a cold
 * read of today's 2 GB database takes seconds in one statement, and the server answers nobody meanwhile.
 */
export function breather(ms = 20): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < ms) return;
    await new Promise((r) => setImmediate(r));
    since = performance.now();
  };
}

/** Runs a generator scan to its end on this thread, all at once: for callers that must answer now (tests, a small table). */
export function drain<T>(steps: Generator<unknown, T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Runs a generator scan to its end, yielding to the event loop between its steps once each `ms` of holding it. */
export async function pace<T>(steps: Generator<unknown, T>, ms = 20): Promise<T> {
  const breathe = breather(ms);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    await breathe();
  }
}
