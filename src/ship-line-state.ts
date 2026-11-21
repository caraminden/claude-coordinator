// Who placed each ship in a scheme's line (#1358; Cara, 2026-11-20: "Unless a user explicitly moves the order, you (and other
// taskmasters in their schemes) should have the power to gauge the priority of ships and order them commensurately").
// One setting per scheme. A person's drag pins the ship it moved until it ships; a Taskmaster's move is recorded with its
// reason but never pins. Imports nothing from releases.ts, which reads it.

export interface Placed {
  by: string;
  at: number;
  /** A Taskmaster's one-line reason; a person's move has none. */
  reason?: string;
  /** Moved by a Taskmaster (true) or placed by a person (false: pinned). */
  taskmaster: boolean;
}

export interface ShipLineState {
  placed: Record<string, Placed>;
  /** The last moves, newest last: the line's history. */
  history: { at: number; text: string }[];
}

export const HISTORY_MAX = 30;
export const shipLineKey = (projectId: number) => `ship-line:${projectId}`;

/** A line entry's key: its minion, else its queue ticket and label (queue numbers aren't known never to repeat). */
export const placedKey = (e: { ticketId: number | null; seq: number; name: string }) => (e.ticketId != null ? `t${e.ticketId}` : `s${e.seq}:${e.name}`);

export const emptyState = (): ShipLineState => ({ placed: {}, history: [] });

export const readState = (store: { getSetting<T>(key: string): T | null }, projectId: number): ShipLineState => {
  const s = store.getSetting<ShipLineState>(shipLineKey(projectId));
  return { placed: s?.placed ?? {}, history: s?.history ?? [] };
};
