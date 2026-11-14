// Presence (#695): "Josh is here" on a minion's row and in its chat header, when another person has it
// open or wrote in it in the last 10 minutes (src/presence.ts). This tab reports the chat it has open.
import { api, h, me, view } from './base.js';

const HEARTBEAT_MS = 30_000; // src/presence.ts HEARTBEAT_MS
let stream = null;
let sent; // the chat last reported, so a route change reports at once and nothing else does
/** projectId → { ticketId: [names] }, as the server last said. */
const byScheme = new Map();

/** The stream's hello: a new stream id, so report again under it. */
export function presenceHello(id) {
  stream = id;
  sent = undefined;
  reportPresence();
}

/** Tell the server which chat this tab has open: on a route change, a heartbeat, and hiding the tab. */
export function reportPresence(force = false) {
  if (!stream) return;
  const ticketId = document.visibilityState === 'visible' && view?.kind === 'project' && view.id ? view.id : null;
  if (!force && ticketId === sent) return;
  sent = ticketId;
  // Fire and forget: a lost heartbeat is made up by the next one.
  api('api/presence', { method: 'POST', body: { stream, ticketId } }).catch(() => {});
}

setInterval(() => document.visibilityState === 'visible' && reportPresence(true), HEARTBEAT_MS);
document.addEventListener('visibilitychange', () => reportPresence());

/** A presence message from the stream; true when it's about the scheme on screen. */
export function onPresenceMsg(msg) {
  byScheme.set(msg.projectId, msg.tickets);
  return view?.projectId === msg.projectId;
}

/** Other people in a chat right now, never you. */
export function othersIn(t) {
  return (byScheme.get(t.project_id)?.[t.id] ?? []).filter((n) => n !== me);
}

const hereText = (names) => names.length === 1 ? `${names[0]} is here` : `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are here`;

/** The row's chip: a green dot and the first person's initial (+N for more); nothing when it's only you. */
export function presenceChip(t) {
  const names = othersIn(t);
  if (!names.length) return '';
  const text = hereText(names);
  return h('span', { class: 'presence', title: text, 'aria-label': text }, h('i', { class: 'presence-dot', 'aria-hidden': 'true' }),
    names[0][0].toUpperCase(), names.length > 1 ? `+${names.length - 1}` : '');
}

/** The chat header's line: "● Josh is here". */
export function presenceHead(t) {
  const names = othersIn(t);
  if (!names.length) return '';
  return h('span', { class: 'presence-head', title: 'Has this chat open or wrote in it in the last 10 minutes' }, h('i', { class: 'presence-dot', 'aria-hidden': 'true' }), hereText(names));
}
