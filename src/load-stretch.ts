// How much a boot check step's usual time limit stretches on a busy box (#1514). With more runnable
// processes than cores, each gets about cores/load of a core, so CPU-bound work takes about load/cores
// times as long: a limit sized for a quiet box, times that, tells a slow box from a hung step.
import { availableParallelism, loadavg } from 'node:os';

/** Capped at 4: past that the boot check's own 3-minute backstop (and deploy.sh's 420 s) decides. */
export const MAX_STRETCH = 4;

/** A step's limit for the load now: `ms(base)` in whole seconds, and `why` to add to its failure (empty on a quiet box). */
export function loadStretch(load = loadavg()[0], cores = availableParallelism()) {
  const by = Math.min(MAX_STRETCH, Math.max(1, load / cores));
  return {
    by,
    ms: (base: number) => Math.ceil((base * by) / 1000) * 1000,
    why: by > 1 ? ` (stretched ${by.toFixed(1)}x for load ${load.toFixed(0)} on ${cores} cores)` : '',
  };
}
