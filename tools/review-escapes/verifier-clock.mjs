// Loaded with --import by `boot.mjs start --clock <iso>` (#1740): Date reads VERIFIER_CLOCK_OFFSET_MS ahead (or behind),
// so the dev copy, its turns and its tool servers meet midnight, a reset hour or a stale timestamp when the verifier
// wants. Timers still run in real time.
const offset = Number(process.env.VERIFIER_CLOCK_OFFSET_MS) || 0;
if (offset) {
  const Real = Date;
  globalThis.Date = class extends Real {
    constructor(...a) { super(...(a.length ? a : [Real.now() + offset])); }
    static now() { return Real.now() + offset; }
  };
}
