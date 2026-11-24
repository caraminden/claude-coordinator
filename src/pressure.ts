// How starved the box is (#1301, performance P8): one reader of /proc/pressure/cpu, /proc/pressure/memory and (for
// the host samples, #1325) /proc/pressure/io ("some avg60", the same line tools/citadel-heavy gates on), cached for 5 s
// and read asynchronously, so a look never blocks the event loop. The server's background passes (indexers, sweeps,
// kit-sync's look) ask `pressure.gate(name)` and skip a pass while starved; nothing a person or a minion starts asks
// (turn starts never read this). The box's memory level (#1748, src/memory-ease.ts: free memory and reclaim, which PSI
// misses on zram swap) counts too once the server hands it over with `useEase`: easing or tight is starved.
//
// Small API: `pressure.read()` (the reading), `pressure.gate(name)` (true: run this pass), `createPressure()` (tests).
import { hostText, PSI_FILES } from './host-signals.ts';

/** CPU pressure at or above this percent is starved: tools/citadel-heavy's CITADEL_HEAVY_MAX_PRESSURE default. */
export const MAX_CPU_PRESSURE = 50;
/** Memory pressure at or above this percent is starved: CITADEL_HEAVY_MAX_MEM_PRESSURE's default (#1298). */
export const MAX_MEM_PRESSURE = 20;
/** A pass skipped this long in a row runs anyway, so a starved box still indexes eventually. */
export const RUN_ANYWAY_MS = 10 * 60_000;
const CACHE_MS = 5_000;

/** One look: whole percents (null without a PSI file) and whether CPU or memory is at its line; `why` says which, for a log line. IO is recorded, never gated on. */
export interface PressureReading { cpu: number | null; mem: number | null; io: number | null; starved: boolean; why: string }

/** The memory level's look (src/memory-ease.ts MemoryEase.get). */
export type EaseLook = () => { level: 'ok' | 'easing' | 'tight'; why: string };

export interface PressureOptions {
  cpuFile?: string; memFile?: string; ioFile?: string; now?: () => number; log?: (line: string) => void;
  maxCpu?: number; maxMem?: number; runAnywayMs?: number; ease?: EaseLook;
}

/** "some avg60=63.21" as a whole percent, like citadel-heavy's read_pressure; null when the file is missing or odd. */
export async function readPsi(file: string): Promise<number | null> {
  try {
    const m = (await hostText(file)).match(/^some .*avg60=([\d.]+)/m);
    return m ? Math.floor(Number(m[1])) : null;
  } catch { return null; }
}

export function createPressure(opts: PressureOptions = {}) {
  const cpuFile = opts.cpuFile ?? process.env.CITADEL_PSI_CPU ?? PSI_FILES.cpu;
  const memFile = opts.memFile ?? process.env.CITADEL_PSI_MEMORY ?? PSI_FILES.memory;
  const ioFile = opts.ioFile ?? process.env.CITADEL_PSI_IO ?? PSI_FILES.io;
  const maxCpu = opts.maxCpu ?? (Number(process.env.CITADEL_HEAVY_MAX_PRESSURE) || MAX_CPU_PRESSURE);
  const maxMem = opts.maxMem ?? (Number(process.env.CITADEL_HEAVY_MAX_MEM_PRESSURE) || MAX_MEM_PRESSURE);
  const runAnywayMs = opts.runAnywayMs ?? RUN_ANYWAY_MS;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.log(line));
  let ease = opts.ease;
  let cached: { at: number; reading: Promise<PressureReading> } | null = null;
  const skipping = new Map<string, number>(); // pass name -> when its current run of skips began

  const look = async (): Promise<PressureReading> => {
    const [cpu, mem, io] = await Promise.all([readPsi(cpuFile), readPsi(memFile), readPsi(ioFile)]);
    const e = ease?.();
    const why = cpu !== null && cpu >= maxCpu ? `CPU pressure ${cpu}%` : mem !== null && mem >= maxMem ? `memory pressure ${mem}%` : e && e.level !== 'ok' ? `memory ${e.level}: ${e.why}` : '';
    return { cpu, mem, io, starved: why !== '', why };
  };

  /** The current reading, at most 5 s old. */
  const read = (): Promise<PressureReading> => {
    if (!cached || now() - cached.at >= CACHE_MS) cached = { at: now(), reading: look() };
    return cached.reading;
  };

  /**
   * Should this background pass run now? True when the box isn't starved, or when the pass has been skipped for
   * `runAnywayMs` in a row. Logs one line when a pass's stretch of skips begins, not per skipped pass.
   */
  const gate = async (name: string): Promise<boolean> => {
    const r = await read();
    if (!r.starved) { skipping.delete(name); return true; }
    const since = skipping.get(name);
    if (since === undefined) {
      skipping.set(name, now());
      log(`${name} paused: ${r.why}`);
      return false;
    }
    if (now() - since >= runAnywayMs) { skipping.delete(name); return true; }
    return false;
  };

  /** Counts the memory level from now on (the server's MemoryEase). */
  const useEase = (look: EaseLook) => { ease = look; cached = null; };

  return { read, gate, useEase };
}

/** The server's one reader. */
export const pressure = createPressure();
