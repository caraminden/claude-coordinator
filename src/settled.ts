// What this process is still doing in the background, so a test can wait until it is all done (#1437) instead of
// polling for a first sign of it or sleeping. The DB write worker, the session save and restore workers, the WAL
// checkpoint round and the server's requests report here; settled() resolves once none is busy. Always on (a counter
// each); only a test server serves it (CITADEL_TEST_SETTLED, server.ts), and an in-process test calls it directly.

const sources = new Set<() => string[]>();

/** Report something that can be busy: `busy` names what it is doing right now (none: idle). Returns its removal. */
export function busySource(busy: () => string[]): () => void {
  sources.add(busy);
  return () => void sources.delete(busy);
}

const jobs = new Map<string, number>();
busySource(() => [...jobs].map(([name, n]) => `${n} ${name}`));
/** Count `p` as busy as `name` until it settles. */
export function track<T>(name: string, p: Promise<T>): Promise<T> {
  jobs.set(name, (jobs.get(name) ?? 0) + 1);
  const done = () => {
    const n = (jobs.get(name) ?? 1) - 1;
    if (n) jobs.set(name, n);
    else jobs.delete(name);
  };
  p.then(done, done);
  return p;
}

/** What is busy right now, one line each ("2 queued DB writes"). */
export function busyNow(): string[] {
  return [...sources].flatMap((busy) => busy());
}

/**
 * Wait until nothing is busy, at most `ms`: [] once it is, else what was still busy then. Idle twice across a turn
 * of the event loop, so a job that starts another as it ends (a write's promise starting a save) isn't missed.
 */
export async function settled(ms = 30_000): Promise<string[]> {
  const until = Date.now() + ms;
  for (;;) {
    let busy = busyNow();
    if (!busy.length) {
      await new Promise((r) => setImmediate(r));
      busy = busyNow();
      if (!busy.length) return [];
    }
    if (Date.now() >= until) return busy;
    await new Promise((r) => setTimeout(r, 5));
  }
}
