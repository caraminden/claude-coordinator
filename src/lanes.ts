/**
 * One serial queue per minion (#259). Every step of a minion's turn lifecycle (a turn, from its
 * session restore to its end-of-turn save; a resume; the boot sweep's save; a dismissal's cleanup)
 * runs on its minion's lane and starts only once the step before it has finished, so no step can
 * overlap the next turn the way #250's save did. Lanes of different minions run side by side; there
 * is no global lock. A step on an idle lane starts at once, before run() returns, so its caller sees
 * what it did (a turn counts as running) straight away.
 */
export class Lanes {
  private tails = new Map<number, Promise<void>>();
  /** A lane's last step has finished and nothing waits behind it (the runner starts queued messages then). */
  onIdle: (key: number) => void = () => {};

  /** Whether a step runs or waits on this lane. */
  busy(key: number): boolean {
    return this.tails.has(key);
  }

  /**
   * Run `step` once every step queued before it on this lane has finished. Resolves when it has
   * finished. A step started at once that throws before its first await throws to the caller, as a
   * plain call would; any other error is logged with `what`, so one failed step can't stall the lane.
   */
  run(key: number, what: string, step: () => unknown): Promise<void> {
    const before = this.tails.get(key);
    let started: Promise<unknown>;
    let thrown: { err: unknown } | null = null;
    if (before) started = before.then(step);
    else {
      try {
        started = Promise.resolve(step());
      } catch (err) {
        started = Promise.resolve();
        thrown = { err };
      }
    }
    const done = started.then(
      () => {},
      (err) => console.error(`Minion ${key}: ${what} failed:`, err),
    );
    // A step started at once may itself have run a step on this lane at once (the outbox's send starts a turn, #1464):
    // that step's tail is the lane's now, and this one ends only after it, or the lane would go idle under a live turn.
    const nested = before ? undefined : this.tails.get(key);
    const tail = Promise.all([done, nested]).then(() => {
      if (this.tails.get(key) !== tail) return;
      this.tails.delete(key);
      this.onIdle(key);
    });
    this.tails.set(key, tail);
    if (thrown) throw thrown.err;
    return done;
  }
}
