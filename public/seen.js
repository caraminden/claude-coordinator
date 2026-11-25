// Seen marks and leaving: the open chat is marked seen while it can be seen (base.js chatInSight), and a finished
// minion you saw closes once you leave it (#811, #1851).
import { api, chatInSight, me, view } from './base.js';
import { showFrame } from './frames.js';
import { reportPresence } from './presence.js';
import { renderSidebar, scheduleSidebar } from './sidebar.js';

const listed = (id) => (view?.kind === 'project' ? (view.tickets?.get(id) ?? (view.coordinator?.id === id ? view.coordinator : null)) : null);

/** The open chat is going out of sight (a hidden tab, an app over it, a put-away layer): what it was when last seen, until it's back. */
function chatCovered() {
  const t = listed(view?.id);
  if (!t) return;
  view.sawAt ??= t.updated_at;
  seenTimers.get(t.id)?.(); // a mark still waiting was asked for in sight: sent now, as what happens next isn't seen
}

/** Back in sight from under an app or a put-away layer. */
export const chatUncovered = () => view?.kind === 'project' && view.id && view.sawAt !== undefined && markSeen(view.id);

document.addEventListener('citadel-layer', () => {
  if (chatInSight()) chatUncovered();
  else chatCovered();
  reportPresence();
});

/** Open a contraption over the page. */
export function coverWith(name, src) {
  chatCovered();
  showFrame(name, src);
  reportPresence();
}

const seenTimers = new Map(); // chat id → sends its waiting mark now
/** Record that you have looked at the open chat as it is now (shortly, so a burst of updates sends one), if it can be seen. */
export function markSeen(ticketId) {
  if (!chatInSight()) return void (view?.id === ticketId && (view.sawAt ??= 0));
  if (view?.id === ticketId) delete view.sawAt;
  // The unread mark goes at once (Cara, 2026-11-08: "assume things will work instantly"); the server's time replaces ours when it answers.
  const t = listed(ticketId);
  if (t && view.seen && (view.seen[ticketId] ?? 0) < t.updated_at) {
    view.seen[ticketId] = t.updated_at;
    renderSidebar();
  }
  if (seenTimers.has(ticketId)) return;
  const send = async () => {
    clearTimeout(timer);
    seenTimers.delete(ticketId);
    if (!me) return;
    try {
      const { seen_at } = await api(`api/tickets/${ticketId}/seen`, { method: 'POST', body: {} });
      if (view?.kind !== 'project') return;
      if (view.seen[ticketId] === seen_at) return; // nothing changed: no second redraw per update (#1532)
      view.seen[ticketId] = seen_at;
      scheduleSidebar();
    } catch {}
  };
  const timer = setTimeout(send, 800);
  seenTimers.set(ticketId, send);
}

/**
 * You've left the open chat (another page, a hidden tab, a closed page): a finished minion you had open at its last
 * update closes (#811). One that changed out of sight, under an app say, isn't left: nobody saw that.
 */
export function leaveSeen(ticketId) {
  if (!ticketId || (view.sawAt !== undefined && (listed(ticketId)?.updated_at ?? 0) > view.sawAt)) return;
  fetch(`api/tickets/${ticketId}/seen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ left: true }), keepalive: true }).catch(() => {});
}
// A hidden tab has left already, and can't know what it missed since.
addEventListener('pagehide', () => document.visibilityState === 'visible' && view?.kind === 'project' && leaveSeen(view.id));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden' || view?.kind !== 'project') return;
  leaveSeen(view.id);
  chatCovered();
});
