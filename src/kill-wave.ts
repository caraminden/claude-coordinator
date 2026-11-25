// Turns that died together with no record of how (#1938): Nov 24, 5:03 PM PST, 25 turns in one container, and each chat's
// note named only its own. They are noticed over several seconds, so each new one rewrites the notes before it
// (an open chat shows the new words when it is next loaded).
import type { EventRow, Store } from './db.ts';

/** A death this soon after the last one in the same place is the same wave. */
export const WAVE_GAP_MS = 30_000;

/** The notes' last line for `n` turns seen dying over `ms`, in `container` (null: each in a unit or process group of its own). */
export function waveText(n: number, ms: number, container: string | null): string {
  return `${n} turns were killed together, within ${Math.max(1, Math.ceil(ms / 1000))} s: ${container ? `all ran in the container ${container}` : 'each in a unit or process group of its own on the server'}.`;
}

export class KillWaves {
  private waves = new Map<string | null, { from: number; last: number; events: number[] }>();
  private store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  /** Count one death whose note or error in the chat is `event`; from the second on, every one's says how many. */
  add(container: string | null, at: number, event: EventRow) {
    let w = this.waves.get(container);
    if (!w || at - w.last > WAVE_GAP_MS) this.waves.set(container, (w = { from: at, last: at, events: [] }));
    const before = w.events.length > 1 ? `\n${waveText(w.events.length, w.last - w.from, container)}` : '';
    w.last = at;
    w.events.push(event.id);
    if (w.events.length < 2) return;
    const line = `\n${waveText(w.events.length, at - w.from, container)}`;
    for (const id of w.events) {
      const row = this.store.getEvent(id);
      if (!row) continue;
      const data = JSON.parse(row.data);
      const text = (before && data.text.endsWith(before) ? data.text.slice(0, -before.length) : data.text) + line;
      this.store.setEventData(id, { ...data, text });
    }
  }
}
