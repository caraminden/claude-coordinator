// How much a boot check step's usual time limit stretches on a busy box (#1514). With more runnable
// processes than cores, each gets about cores/load of a core, so CPU-bound work takes about load/cores
// times as long: a limit sized for a quiet box, times that, tells a slow box from a hung step.
import { cores as hostCores, loadavg, runnable } from './host-signals.ts';

/** Capped at 4. The stretch lets one slow step through; it doesn't raise the boot check's 3-minute backstop on all
 * the steps after the copy together (kept under deploy.sh's 600 s), so past about 3x the backstop is what refuses. */
export const MAX_STRETCH = 4;

/** How busy the box is now: the 1-minute average, or the runnable count while that average still lags a burst. */
export const busyNow = () => Math.max(loadavg()[0], runnable());

/** A step's limit for one reading of the load: `ms(base)` in whole seconds, and `why` to add to its failure (empty on a quiet box). */
export function loadStretch(load: number, cores: number) {
  const by = Math.min(MAX_STRETCH, Math.max(1, load / cores));
  return {
    by,
    ms: (base: number) => Math.ceil((base * by) / 1000) * 1000,
    why: by > 1 ? ` (stretched ${by.toFixed(1)}x for load ${load.toFixed(0)} on ${cores} cores)` : '',
  };
}

/** One step's limit, stretched by the busiest reading since it began: the load can rise after the step starts (#2009). */
export function stepLimit(load = busyNow, cores = hostCores()) {
  const start = Date.now();
  let most = loadStretch(load(), cores);
  return {
    /** Reads the load again, then says whether `base`, stretched, has passed since `from`. */
    over(base: number, from = start): boolean {
      const now = loadStretch(load(), cores);
      if (now.by > most.by) most = now;
      return Date.now() - from > most.ms(base);
    },
    /** The limit and why, for the failure: "67 s (stretched ...)". */
    text: (base: number) => `${most.ms(base) / 1000} s${most.why}`,
  };
}

/** `work`, or an error that says it ran past `base`, stretched by the load while it ran. */
export async function within<T>(work: Promise<T>, base: number, error: (limit: string) => string, limit = stepLimit()): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, no) => {
    timer = setInterval(() => {
      try {
        if (limit.over(base)) no(new Error(error(limit.text(base))));
      } catch (err) {
        no(err); // an unreadable load ends the step with its error, not an uncaught throw past the caller's cleanup
      }
    }, 250);
  });
  return Promise.race([work, late]).finally(() => clearInterval(timer));
}
