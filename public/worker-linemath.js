// The line for a worker as its drawer shows it (worker-line.js): the Urgent group, then the automatic order, and what a
// move makes of them. No page in here, so Node tests it.
import { moved } from './reorder.js';

/** @import { LineData, LineGroups, LineRow } from './types/workers.js' */

/**
 * GET /api/line as two lists of rows: the Urgent group whole, waiting or not, then everyone else in the line. One on a worker of its own is in neither, unless it's Urgent.
 * @param {Pick<LineData, 'urgent' | 'line'>} data
 * @returns {LineGroups}
 */
export function lineGroups({ urgent, line }) {
  const waits = new Map(line.filter((w) => w.ticket != null).map((w) => [w.ticket, w]));
  return { urgent: urgent.map((m) => ({ ...(m.ticket == null ? {} : waits.get(m.ticket)), ...m })), rest: line.filter((w) => !w.urgent && !w.forced) };
}

/**
 * GET /api/line after a Start now or a Release (#1957): `{ row, on, by, at }`. Applying one twice changes nothing more.
 * @template {Pick<LineData, 'forced' | 'line'>} D
 * @param {D} data
 * @param {{ row: LineRow, on: boolean, by: string | null, at: number }} op
 * @returns {D}
 */
export function applyStart(data, { row, on, by, at }) {
  const id = row.ticket;
  const waits = data.line.some((w) => w.ticket === id);
  const was = data.forced.find((f) => f.ticket === id);
  const mark = was ?? { ticket: id, project: row.project, number: row.number, title: row.title, waiting: waits, since: at, by };
  return {
    ...data,
    forced: on ? (was ? data.forced : [...data.forced, mark]) : data.forced.filter((f) => f.ticket !== id),
    line: data.line.map((w) => (w.ticket === id ? { ...w, forced: on } : w)),
  };
}

/** What a minion with a worker of its own is doing, in a few words. */
export const ownSaid = (/** @type {LineRow} */ f, /** @type {string | false | null | undefined} */ held) => (held ? `waiting: ${held}` : f.waiting ? 'starting' : f.working ? 'working' : 'idle');

/**
 * `groups` after `op`, as the server will have it: { row, on, before, by }. `before` is the minion in the group it goes
 * just ahead of, null for the group's end, undefined to keep its spot. Applying one twice changes nothing more.
 * @param {LineGroups} groups
 * @param {{ row: LineRow, on: boolean, before?: number | null, by: string | null }} op
 * @returns {LineGroups}
 */
export function applyMove(groups, { row, on, before, by }) {
  const at = groups.urgent.findIndex((r) => r.ticket === row.ticket);
  const known = groups.urgent[at] ?? groups.rest.find((r) => r.ticket === row.ticket) ?? row;
  const urgent = groups.urgent.filter((r) => r.ticket !== row.ticket);
  const rest = groups.rest.filter((r) => r.ticket !== row.ticket);
  if (!on) return at < 0 ? groups : { urgent, rest: known.waiting === false ? rest : [{ ...known, urgent: false }, ...rest] };
  /** @type {LineRow} */
  const mark = at >= 0 && known.kind === 'person' ? known : { ...known, kind: 'person', by, reason: undefined, urgent: true, waiting: at >= 0 ? known.waiting : groups.rest.some((r) => r.ticket === row.ticket) };
  const spot = before === undefined ? at : before === null ? -1 : urgent.findIndex((r) => r.ticket === before); // null is the end, not another scheme's row
  urgent.splice(spot < 0 ? urgent.length : spot, 0, mark);
  return { urgent, rest };
}

/**
 * The move a drop makes, from and to counted over the group, the divider under it, then the rest; null where it changes
 * nothing: below the divider the order is the server's.
 * @param {LineGroups} groups
 * @param {number} from
 * @param {number} to
 * @returns {{ row: LineRow, on: boolean, before?: number | null } | null}
 */
export function dropped(groups, from, to) {
  const items = /** @type {(LineRow | null)[]} */ (moved([...groups.urgent, null, ...groups.rest], from, to));
  const divider = items.indexOf(null);
  const row = /** @type {LineRow} */ (items[to]); // a drag picks up rows, never the divider
  if (to < divider) return { row, on: true, before: /** @type {LineRow[]} */ (items.slice(to + 1, divider)).find((r) => r.ticket != null)?.ticket ?? null };
  return from < groups.urgent.length ? { row, on: false } : null;
}

/**
 * Which minion in the group `id` is just ahead of: null at its end, undefined when it isn't in the group.
 * @param {LineGroups} groups
 * @param {number} id
 */
export function nextUrgent(groups, id) {
  const i = groups.urgent.findIndex((r) => r.ticket === id);
  return i < 0 ? undefined : (groups.urgent.slice(i + 1).find((r) => r.ticket != null)?.ticket ?? null);
}

/**
 * Why it stands where it does, in a few words.
 * @param {Omit<LineRow, 'ticket'>} r
 */
export function lineWhy(r) {
  if (r.kind) return r.by ? `by ${r.by}${r.reason ? `: ${r.reason}` : ''}` : '';
  return [r.quick ? 'or quick lane' : '', r.first ? 'ship refused, or others wait on it' : '', r.warm ? 'warm, about to go cold' : !r.first && r.fresh ? 'brand new' : '', r.after ? 'after those with no computer connected' : ''].filter(Boolean).join(' · ');
}

/**
 * The quick lane in words (#1986): its workers out, why it is smaller than 2, and the turns that moved to pool.
 * @param {{ used: number, size: number, moved: number }} lane
 */
export function laneSaid({ used, size, moved }) {
  const now = size === 0 ? `${used ? `${used} working, ` : ''}closed while memory is tight` : `${used} of ${size} working${size === 1 ? ', 1 while memory is under strain' : ''}`;
  return `${now}${moved ? ` · ${moved} moved to pool` : ''}`;
}
