// The scheme recap: opening the Taskmaster chat 6+ hours after you last did anything
// in the scheme puts a card at the bottom listing what changed since, built from the minions'
// own states and notes. It is yours alone, never stored in the chat, and goes once you act.
import { ago, api, h, me, openView, view } from './base.js';

/** @import { ChatEvent } from './types.js' */
import { loadClosedSince } from './closedlist.js';
import { usage } from './core.js';
import { threadRow } from './sidebar.js';
import { rowState } from './threadstate.js';
import { recapSections } from './threadgroups.js';

const AWAY_MS = 6 * 60 * 60 * 1000; // Cara, 2026-10-28: "only ... if you havent taken an action for 6+ hours". The server skips the count before then: RECAP_AWAY_MS in src/db.ts.

/** Fetch the recap for the open Taskmaster chat and show it, if you have been away long enough. */
export async function showRecap() {
  const { projectId, id } = openView();
  const recap = await api(`api/projects/${projectId}/recap`).catch(() => null);
  if (!recap?.since || Date.now() - recap.since < AWAY_MS || view?.id !== id) return;
  // Its Dismissed section needs the minions dismissed since you left, which the page doesn't read until asked.
  await loadClosedSince(recap.since);
  if (view?.id !== id) return;
  const tickets = [...openView().tickets.values()];
  const sections = recapSections(tickets, recap.since, recap.turns, (t) => rowState(t, usage ?? undefined));
  const log = document.getElementById('log');
  if (!sections.length || !log) return;
  const minions = sections.flatMap((s) => s.rows);
  const turns = minions.reduce((n, t) => n + (recap.turns[t.id] ?? 0), 0);
  const fresh = minions.filter((t) => t.created_at > recap.since).length;
  /** @param {number} n @param {string} word */
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  document.getElementById('recap')?.remove();
  const card = h(
    'div',
    { class: 'recap', id: 'recap' },
    h(
      'div',
      { class: 'recap-head' },
      h('strong', {}, 'While you were away'),
      h('span', { class: 'muted' }, [`since your last action ${ago(recap.since)}`, turns ? `${plural(turns, 'turn')} across ${plural(minions.length, 'minion')}` : plural(minions.length, 'minion'), fresh ? `${fresh} new` : ''].filter(Boolean).join(' · ')),
    ),
    sections.map((s) =>
      s.key === 'closed'
        ? // Cara, 2026-11-11: "collapse dismissed minions, just say how many were dismissed when minimized".
          // Collapsed each time the card shows, like the sidebar's own Dismissed group.
          h(
            'details',
            { class: `recap-group g-${s.key}` },
            h('summary', {}, `${s.rows.length} dismissed`),
            s.rows.map((t) => threadRow(t)),
          )
        : h(
            'section',
            { class: `recap-group g-${s.key}` },
            h('h4', {}, s.label),
            s.rows.map((t) => threadRow(t)),
          ),
    ),
  );
  log.append(card);
  // Its top just under the pinned thread bar, which is stuck there since the chat opened at its end.
  card.style.scrollMarginTop = `${(document.getElementById('ticket-head')?.getBoundingClientRect().bottom ?? 0) + 8}px`;
  // Someone already scrolling reads on where they are; the card is below (T3).
  if (!openView().scrolledByYou) card.scrollIntoView({ block: 'start' });
}

/** A chat event: your own message means you're back, so the recap goes. */
/** @param {ChatEvent} event @param {{ author?: string }} data */
export function recapEvent(event, data) {
  if (event.kind === 'user_message' && data.author === me) document.getElementById('recap')?.remove();
}
