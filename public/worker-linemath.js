// The line for a worker as its drawer shows it (worker-line.js): the Urgent group, then the automatic order, and what a
// move makes of them. No page in here, so Node tests it.
import { moved } from './reorder.js';

/** GET /api/line as two lists of rows: the Urgent group whole, waiting or not, then everyone else in the line. */
export function lineGroups({ urgent, line }) {
  const waits = new Map(line.filter((w) => w.ticket != null).map((w) => [w.ticket, w]));
  return { urgent: urgent.map((m) => ({ ...(m.ticket == null ? {} : waits.get(m.ticket)), ...m })), rest: line.filter((w) => !w.urgent) };
}

/**
 * `groups` after `op`, as the server will have it: { row, on, before, by }. `before` is the minion in the group it goes
 * just ahead of, null for the group's end, undefined to keep its spot. Applying one twice changes nothing more.
 */
export function applyMove(groups, { row, on, before, by }) {
  const at = groups.urgent.findIndex((r) => r.ticket === row.ticket);
  const known = groups.urgent[at] ?? groups.rest.find((r) => r.ticket === row.ticket) ?? row;
  const urgent = groups.urgent.filter((r) => r.ticket !== row.ticket);
  const rest = groups.rest.filter((r) => r.ticket !== row.ticket);
  if (!on) return at < 0 ? groups : { urgent, rest: known.waiting === false ? rest : [{ ...known, urgent: false }, ...rest] };
  const mark = at >= 0 && known.kind === 'person' ? known : { ...known, kind: 'person', by, reason: undefined, urgent: true, waiting: at >= 0 ? known.waiting : groups.rest.some((r) => r.ticket === row.ticket) };
  const spot = before === undefined ? at : before === null ? -1 : urgent.findIndex((r) => r.ticket === before); // null is the end, not another scheme's row
  urgent.splice(spot < 0 ? urgent.length : spot, 0, mark);
  return { urgent, rest };
}

/**
 * The move a drop makes, from and to counted over the group, the divider under it, then the rest; null where it changes
 * nothing: below the divider the order is the server's.
 */
export function dropped(groups, from, to) {
  const items = moved([...groups.urgent, null, ...groups.rest], from, to);
  const divider = items.indexOf(null);
  const row = items[to];
  if (to < divider) return { row, on: true, before: items.slice(to + 1, divider).find((r) => r.ticket != null)?.ticket ?? null };
  return from < groups.urgent.length ? { row, on: false } : null;
}

/** Which minion in the group `id` is just ahead of: null at its end, undefined when it isn't in the group. */
export function nextUrgent(groups, id) {
  const i = groups.urgent.findIndex((r) => r.ticket === id);
  return i < 0 ? undefined : (groups.urgent.slice(i + 1).find((r) => r.ticket != null)?.ticket ?? null);
}

/** Why it stands where it does, in a few words. */
export function lineWhy(r) {
  if (r.kind) return r.by ? `by ${r.by}${r.reason ? `: ${r.reason}` : ''}` : '';
  return [r.first ? 'ship refused, or others wait on it' : '', r.warm ? 'warm, about to go cold' : !r.first && r.fresh ? 'brand new' : ''].filter(Boolean).join(' · ');
}
