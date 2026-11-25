// What a dropped live stream missed (it has no replay): the scheme's lists and the open chat's messages are fetched,
// live messages wait behind that fetch, and one that fails is tried again until it works (#1854).
import { api, h, me, view } from './base.js';
import { inMerged } from './mine.js';
import { freshest, mergeOpen } from './closedlist.js';
import { eventsUrl, keptOpen, reconnecting, route } from './core.js';
import { setArtifacts } from './artifacts.js';
import { appendEvent } from './thread.js';
import { refreshBranch, renderTicketHead } from './thread-head.js';
import { schedulePaintRefs } from './refstate.js';
import { markSeen } from './seen.js';
import { renderSidebar } from './sidebar.js';
import { forgetOtherSchemes, refreshSchemeCounts } from './inbox.js';

// The kept chat drawn at launch (#1144) says so until the live answers replace it, and so does a page whose catch-up
// failed, until one works; it stands in for Reconnecting….
let chip = null;
export const catchingUp = () => !!chip;
export function showCatchingUp() {
  reconnecting(false);
  if (chip) return;
  chip = h('div', { class: 'cui-chip reconnecting', 'data-tone': 'warn', role: 'status' }, h('span', { class: 'cui-spin', 'aria-hidden': 'true' }), 'Catching up…');
  document.body.append(chip);
}

// Each fetch's place in line, so a success only makes up for the failures that started before it.
let asked = 0;
let good = 0; // the newest resync that worked
let bad = 0; // the newest resync or catch-up that failed
let tries = 0;
let retry = null;

/** Nothing is owed any more: caught up, or signed out. */
export function stopCatchingUp() {
  clearTimeout(retry);
  retry = null;
  tries = 0;
  bad = 0;
  chip?.remove();
  chip = null;
}

function failed(seq) {
  if (!me || keptOpen) return; // signed out meanwhile, or still on the kept chat: goLive resyncs
  bad = Math.max(bad, seq);
  showCatchingUp();
  retry ??= setTimeout(
    () => {
      retry = null;
      if (view?.kind === 'project') resync();
      else stopCatchingUp(); // another page meanwhile, loaded afresh
    },
    Math.min(30_000, 1000 * 2 ** tries++),
  );
}

/** Refresh the open scheme and chat in place, so a half-typed message in the composer survives. Never rejects. */
export async function resync() {
  if (view?.kind !== 'project') {
    stopCatchingUp(); // route() loads the page afresh
    return route();
  }
  const v = view;
  const seq = ++asked;
  let ok = true;
  const fell = () => {
    ok = false;
  };
  // Together: however long the lists take, the chat's own messages don't wait for them.
  await Promise.all([refreshLists(v).catch(fell), catchUpEvents().catch(fell)]);
  if (!ok) return failed(seq);
  if (view === v) good = Math.max(good, seq);
  if (good >= bad) stopCatchingUp();
  else failed(bad);
}

async function refreshLists(v) {
  const was = { rows: new Map(v.tickets), coordinator: v.coordinator, ticket: v.ticket };
  const [{ coordinator, tickets, dismissed, seen, person_notes, pins, builds }, artifacts, chat] = await Promise.all([api(`api/projects/${v.projectId}?tickets=open`), api(`api/projects/${v.projectId}/artifacts`), v.id ? api(`api/tickets/${v.id}`) : null]);
  if (view !== v) return; // you went to another view meanwhile; its own load is fresh
  view.coordinator = freshest(view.coordinator, was.coordinator, coordinator);
  view.tickets = mergeOpen(tickets, dismissed, was.rows); // the dismissed rows already read stay (closedlist.js)
  schedulePaintRefs(); // links already in the chat take the fresh states
  view.seen = seen ?? view.seen;
  view.personNotes = person_notes ?? view.personNotes;
  view.pins = pins ?? view.pins;
  view.builds = builds ?? view.builds;
  if (view.id) markSeen(view.id);
  renderSidebar();
  // Cards raised or settled while the stream was down, here or in other schemes (the counts fetch the inbox after them).
  forgetOtherSchemes();
  refreshSchemeCounts();
  setArtifacts(artifacts);
  if (!chat) return;
  view.ticket = freshest(view.ticket, was.ticket, chat.ticket);
  renderTicketHead();
  if (view.ticket.branch) refreshBranch(view.id);
}

/** Live events for the open chat, held while a catch-up fetches what came before them, or until one that failed has worked. */
let held = null; // { view, events, owed: fetches on their way, good, bad: the newest catch-up that worked, and that failed }
const holed = (hold) => hold.bad > hold.good;

function holdEvents(v) {
  if (held?.view !== v) held = { view: v, events: [], owed: 0, good: 0, bad: 0 };
  held.owed++;
  return held;
}

function letGo(hold) {
  if (--hold.owed || (holed(hold) && view === hold.view)) return; // still owed: the retry lets them go
  if (held === hold) held = null;
  // Another chat opened meanwhile: these aren't its events, and its own load is fresh. Mine and Everyone may have flipped.
  if (view === hold.view) for (const ev of hold.events) if (ev.id > view.lastEventId && (ev.ticket_id === view.id || inMerged(view.merged, ev))) appendEvent(ev);
}

/** Hold a live event for the open chat if a catch-up is owed; whether it was held. */
export function holdEvent(event) {
  if (held?.view !== view) return false;
  held.events.push(event);
  return true;
}

/** The open chat lacks messages a failed catch-up was to bring. */
export const chatHoled = () => held?.view === view && holed(held);

/** Draw what the open chat's history is missing since its newest event; how many were added. Tried again if it fails. */
export async function catchUpEvents() {
  const v = view;
  if (!v?.id) return 0;
  const seq = ++asked;
  // Live events wait until this has what came before them, or the first would move the cursor past the rest (see resync).
  const hold = holdEvents(v);
  try {
    const events = await api(eventsUrl(v.merged?.src ?? v.id, `after=${v.lastEventId}`));
    hold.good = Math.max(hold.good, seq);
    if (view !== v) return 0; // another view (or chat) opened meanwhile: these aren't its events
    let added = 0;
    for (const ev of events)
      if (ev.id > view.lastEventId) {
        appendEvent(ev);
        added++;
      }
    return added;
  } catch (err) {
    hold.bad = Math.max(hold.bad, seq);
    if (view === v) failed(seq);
    throw err;
  } finally {
    letGo(hold);
  }
}
