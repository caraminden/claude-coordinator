// A clock the test moves by hand (#1444). Pass it where a module takes a `Clock` (src/clock.ts) and call `advance`;
// timers fire in due order, each seeing `now()` at its due time. Nothing here reads the real clock, so a busy box
// changes nothing. It imports nothing from src/ (the Clock shape is structural), so pipeline tests can use it too.
// For code that reads the global Date or setTimeout and can't take a clock, use node's `t.mock.timers` instead.

export interface FakeTimer {
  at: number;
  ms: number;
  fn: () => void;
  unref(): FakeTimer;
}

export class FakeClock {
  private t: number;
  private timers: FakeTimer[] = [];

  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }

  now = (): number => this.t;

  setTimeout = (fn: () => void, ms: number): FakeTimer => {
    const timer: FakeTimer = { at: this.t + Math.max(0, ms), ms, fn, unref: () => timer };
    this.timers.push(timer);
    return timer;
  };

  clearTimeout = (timer: unknown): void => {
    this.timers = this.timers.filter((x) => x !== timer);
  };

  /** Timers still waiting, soonest first: `ms` is the delay each was set with, `in` how long until it fires. */
  pending(): { ms: number; in: number }[] {
    return [...this.timers].sort((a, b) => a.at - b.at).map((x) => ({ ms: x.ms, in: x.at - this.t }));
  }

  /** Move time on by `ms`, firing every timer that comes due on the way, in due order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > end) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}
