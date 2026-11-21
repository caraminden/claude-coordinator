// The clock a module reads time and schedules timers with. Production uses `realClock`; a test passes the fake in
// test/fake-clock.ts and moves time itself, so a busy box can't change what the test sees (#1444).

export interface ClockTimer {
  unref(): unknown;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): ClockTimer;
  clearTimeout(t: ClockTimer | undefined): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout | undefined),
};
