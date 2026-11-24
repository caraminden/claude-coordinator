// Loaded with --import by `boot.mjs start --clock <iso>` (#1740): Date reads VERIFIER_CLOCK_OFFSET_MS ahead (or behind),
// so the dev copy, its turns and its tool servers meet midnight, a reset hour or a stale timestamp when the verifier
// wants. Timers, performance.now() and SQLite's own datetime('now') still run in real time.
const offset = Number(process.env.VERIFIER_CLOCK_OFFSET_MS) || 0;
if (offset) {
  const Real = Date;
  // A function, not a class, so a bare Date() (which returns a string) still works.
  function Shifted(...a) {
    if (!new.target) return new Real(Real.now() + offset).toString();
    return Reflect.construct(Real, a.length ? a : [Real.now() + offset], new.target);
  }
  Object.setPrototypeOf(Shifted, Real);
  Shifted.prototype = Real.prototype;
  Shifted.now = () => Real.now() + offset;
  globalThis.Date = Shifted;
}
