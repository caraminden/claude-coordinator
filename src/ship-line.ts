// Moving a scheme's waiting ships (#1002, #1007, #1358): the one path the Releases page's drag and a Taskmaster's
// order_ship_line both take, so the order is written one way and the refusals (an old land script, a pinned ship) are the same.
import type { Store } from './db.ts';
import { HttpError, type App } from './http.ts';
import { CITADEL_TARGET, type LineEntry } from './releases.ts';
import { landQueue, schemeLine } from './release-readers.ts';
import { moveIn, ordinal, writeOrder } from './waits.ts';
import { HISTORY_MAX, placedKey, readState, shipLineKey, type Placed } from './ship-line-state.ts';
import { pacificStamp } from './pacific.ts';

export const REASON_MAX = 200;

export interface Mover {
  /** A person's name, or "<scheme> Taskmaster". */
  name: string;
  taskmaster: boolean;
}

const when = pacificStamp;

/**
 * Put `moved` where `seqs` places it in scheme `projectId`'s line (the person's drag, or the Taskmaster's order), and record who
 * did it. A person's move pins the ship; a Taskmaster's is refused on a pinned ship, or when it would put the ship past one.
 * Throws an HttpError saying why not. Returns the order written.
 */
export function moveShip(app: Pick<App, 'store' | 'releases' | 'waits'>, projectId: number, movedSeq: number, seqs: number[], by: Mover, reason?: string): number[] {
  const { store, releases, waits } = app;
  releases.poll(); // the line as it is now, so a pin placed a second ago counts
  const targets = releases.view((id) => id === projectId)[0]?.targets ?? [];
  const line: LineEntry[] = targets.flatMap((t) => t.line);
  // Citadel's own line is the deploy queue's (#1002); any other scheme's is its copy of the kit's land template (#1007).
  const own = targets.some((t) => t.target.id === CITADEL_TARGET);
  const repo = store.getProject(projectId)?.repo_dir;
  if ((own ? !waits : !repo) || !line.length) throw new HttpError(404, 'This scheme has no ship line here');
  const moved = line.find((e) => e.seq === movedSeq && !e.holds);
  if (!moved) throw new HttpError(409, 'That change is no longer waiting in line to ship');
  if (!moved.movable) throw new HttpError(409, `${moved.name}: ${moved.why ?? "it can't move"}`);

  const state = readState(store, projectId);
  const waiting = line.filter((e) => !e.holds && e.movable);
  const before = waiting.map((e) => e.seq);
  if (by.taskmaster) {
    const after = moveIn(before, seqs, movedSeq);
    const pinned = (e: LineEntry) => (state.placed[placedKey(e)] && !state.placed[placedKey(e)].taskmaster ? state.placed[placedKey(e)] : null);
    const own1 = pinned(moved);
    if (own1) throw new HttpError(409, `${moved.name} was placed by ${own1.by} on ${when(own1.at)}, so it stays where they put it until it ships`);
    for (const p of waiting) {
      const pin = pinned(p);
      if (!pin || p.seq === movedSeq) continue;
      const was = before.indexOf(movedSeq) < before.indexOf(p.seq),
        now = after.indexOf(movedSeq) < after.indexOf(p.seq);
      if (was !== now) throw new HttpError(409, `That would move ${moved.name} past ${p.name}, which ${pin.by} placed on ${when(pin.at)}; it stays where they put it until it ships`);
    }
  }

  // Its place in the order written: a target shows only part of the line, so where it's dropped there isn't always that.
  const note = (order: number[]) => {
    const place = order.indexOf(movedSeq);
    const what = place === 0 ? 'to ship next' : `to ${ordinal(place + 1)} of the changes waiting to ship`;
    return `${by.name} moved ${moved.name} ${what}${reason ? `: ${reason}` : ''}`;
  };
  let order: number[];
  try {
    // The ships people placed, for the land scripts: a holding (Regenerate) ship goes behind them (#1827, "Person's drag wins").
    const pins = waiting.filter((e) => (e.seq === movedSeq ? !by.taskmaster : state.placed[placedKey(e)]?.taskmaster === false)).map((e) => e.seq);
    order = own ? waits!.setOrder(seqs, note, movedSeq, pins) : writeOrder(landQueue(repo!), schemeLine(repo!), seqs, note, movedSeq, pins);
  } catch (err) {
    throw new HttpError(409, (err as Error).message);
  }
  record(store, projectId, line, placedKey(moved), { by: by.name, at: Date.now(), taskmaster: by.taskmaster, ...(reason ? { reason } : {}) }, note(order));
  console.log(`Land line: ${note(order)} (${order.join(', ')})`);
  releases.poll();
  return order;
}

/** Keep `placed` for the ships still in the line (a ship that shipped lets go of its pin) plus this move; add it to the history. */
function record(store: Store, projectId: number, line: LineEntry[], key: string, placed: Placed, text: string) {
  const state = readState(store, projectId);
  const here = new Set(line.map(placedKey));
  const kept = Object.fromEntries(Object.entries(state.placed).filter(([k]) => here.has(k)));
  store.setSetting(shipLineKey(projectId), { placed: { ...kept, [key]: placed }, history: [...state.history, { at: placed.at, text }].slice(-HISTORY_MAX) });
}

/** A Taskmaster's request as the whole waiting order it implies: `ship` first, or just ahead of `before`. */
export function seqsFor(line: LineEntry[], ship: number, before?: number): number[] {
  const rest = line.filter((e) => !e.holds && e.movable && e.seq !== ship).map((e) => e.seq);
  const i = before == null ? 0 : rest.indexOf(before);
  if (i < 0) throw new HttpError(409, 'The ship to go ahead of is not waiting in line, or can not move');
  return [...rest.slice(0, i), ship, ...rest.slice(i)];
}

/**
 * Minion `ticketId`'s waiting ship to the front of its scheme's line (#1487: the fix of a broken test, so every ship behind it
 * stops paying for that test's reds), as a Taskmaster's move: a ship a person placed stays put, and it doesn't go past one.
 * 'moved'; 'first' when it already is; 'refused' when a person's pin is in the way or the write failed (logged); null when it
 * isn't waiting in the line (not handed off yet, shipping now, or a land script too old to move it).
 */
export function shipFirst(app: Pick<App, 'store' | 'releases' | 'waits'>, projectId: number, ticketId: number, by: Mover, reason: string): 'moved' | 'first' | 'refused' | null {
  app.releases.poll();
  const line = app.releases.view((id) => id === projectId)[0]?.targets.flatMap((t) => t.line) ?? [];
  const waiting = line.filter((e) => !e.holds && e.movable);
  const e = waiting.find((x) => x.ticketId === ticketId);
  if (!e) return null;
  if (waiting[0] === e) return 'first';
  try {
    moveShip(app, projectId, e.seq, seqsFor(line, e.seq), { ...by, taskmaster: true }, reason);
    return 'moved';
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    console.warn(`Ship line: ${by.name} couldn't move #${e.seq} to the front: ${err.message}`); // a pin ahead, or the .order write failed
    return 'refused';
  }
}
