// What the Releases page says about quick trains (#2245, quick train piece 5; Josh, 2026-11-24, on #1910's card: "Plan
// approved: build it this way."; Cara picked take A, "In the line", 2026-11-27). The Citadel server card reads it: whether
// quick trains are on (tools/land/quick.sh's `<cc-deploy>/quick-train-on`; off until a person turns them on after the
// one-week recount, docs/adr/0035-quick-train.md), the quick trains shipped whose full tests still run behind them
// (tools/land/behind.sh's quick-behind lines, less those src/fast-mode.ts has a verdict on), and a red pinned on a ship.
// The quick train waiting in the line is the line's own (src/waits.ts, landWaits). Read with the ship lines (Releases.pollA).
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ESCALATE_MS, type FastState, parseQuickBehind } from './fast-mode.ts';

export interface QuickBehind {
  /** When it shipped, ms. */
  at: number;
  top: string;
  /** Its ships' #N, in the order they were stacked. */
  ships: number[];
  /** The full run is going on its top now; else it waits for the next full train's run, which counts. */
  running: boolean;
}

export interface QuickInfo {
  /** Quick trains are on: `<cc-deploy>/quick-train-on` exists. */
  on: boolean;
  /** Quick trains live whose full tests haven't given a verdict yet, newest first. */
  behind: QuickBehind[];
  /** A red's files being run alone on each ship of its quick train, to find whose it is. */
  pinning: { ids: string[]; ships: number[]; at: number | null } | null;
  /** Reds pinned: the ship's #N (null: on nobody's ship, the Taskmaster's), its files, and when the Taskmaster hears. */
  reds: { ids: string[]; n: number | null; at: number; escalateAt: number; escalated: boolean }[];
}

const numbers = (owners: Record<string, number | null>, tops: string[]) => tops.map((t) => owners[t]).filter((n): n is number => n != null);

/** `on`: `<cc-deploy>/quick-train-on` exists; `behindText`: its quick-behind file; `fast`: Citadel's FastState (src/fast-mode.ts's quick scheme). */
export function quickInfo(on: boolean, behindText: string, fast: FastState | undefined): QuickInfo {
  const done = new Set(fast?.done ?? []);
  const pin = fast?.pin?.quick ? fast.pin : undefined;
  const behind = parseQuickBehind(behindText)
    // A verdict in (green, or red and pinned below), or its red being pinned now: no longer "running behind".
    .filter((l) => !done.has(l.top) && !l.red && pin?.head !== l.top)
    .map((l) => ({ at: l.at, top: l.top, ships: numbers(l.owners, l.tops), running: fast?.running?.sha === l.top }))
    .reverse();
  return {
    on,
    behind,
    pinning: pin?.quick ? { ids: pin.ids, ships: numbers(pin.quick.owners, Object.keys(pin.quick.owners)), at: pin.at ?? null } : null,
    reds: (fast?.reds ?? []).map((e) => ({ ids: e.ids, n: e.n ?? null, at: e.at, escalateAt: e.at + ESCALATE_MS, escalated: !!e.escalated })),
  };
}

/** The same, read from `stateDir` (the live checkout's cc-deploy) off the server's thread; the card shows the last read. */
export async function readQuick(stateDir: string, fast: FastState | undefined): Promise<QuickInfo> {
  const [on, text] = await Promise.all([
    access(join(stateDir, 'quick-train-on')).then(
      () => true,
      () => false,
    ),
    readFile(join(stateDir, 'quick-behind'), 'utf8').catch(() => ''),
  ]);
  return quickInfo(on, text, fast);
}
