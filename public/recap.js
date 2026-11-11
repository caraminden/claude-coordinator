// The scheme recap: opening the Taskmaster chat 6+ hours after you last did anything
// in the scheme puts a card at the bottom listing what changed since, built from the minions'
// own states and notes. It is yours alone, never stored in the chat, and goes once you act.
import { ago, api, h, me, view } from './base.js';
import { usage } from './core.js';
import { threadRow } from './sidebar.js';
import { rowState } from './threadstate.js';
import { recapSections } from './threadgroups.js';

const AWAY_MS = 6 * 60 * 60 * 1000; // Cara, 2026-10-28: "only ... if you havent taken an action for 6+ hours". The server skips the count before then: RECAP_AWAY_MS in src/db.ts.

/** Fetch the recap for the open Taskmaster chat and show it, if you have been away long enough. */
export async function showRecap() {
  const { projectId, id } = view;
  // Its Dismissed section needs the dismissed minions, which load behind the scheme's first paint (#538).
  const [recap] = await Promise.all([api(`api/projects/${projectId}/recap`).catch(() => null), view.dismissedLoad]);
  if (!recap?.since || Date.now() - recap.since < AWAY_MS || view?.id !== id) return;
  const tickets = [...view.tickets.values()];
  const sections = recapSections(tickets, recap.since, recap.turns, (t) => rowState(t, usage));
  const log = document.getElementById('log');
  if (!sections.length || !log) return;
  const minions = sections.flatMap((s) => s.rows);
  const turns = minions.reduce((n, t) => n + (recap.turns[t.id] ?? 0), 0);
  const fresh = minions.filter((t) => t.created_at > recap.since).length;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  document.getElementById('recap')?.remove();
  const card = h('div', { class: 'recap', id: 'recap' },
    h('div', { class: 'recap-head' },
      h('strong', {}, 'While you were away'),
      h('span', { class: 'muted' }, [`since your last action ${ago(recap.since)}`, turns ? `${plural(turns, 'turn')} across ${plural(minions.length, 'minion')}` : plural(minions.length, 'minion'), fresh ? `${fresh} new` : ''].filter(Boolean).join(' · '))),
    sections.map((s) => h('section', { class: `recap-group g-${s.key}` }, h('h4', {}, s.label), s.rows.map((t) => threadRow(t)))));
  log.append(card);
  // Its top just under the pinned thread bar, which is stuck there since the chat opened at its end.
  card.style.scrollMarginTop = `${(document.getElementById('ticket-head')?.getBoundingClientRect().bottom ?? 0) + 8}px`;
  card.scrollIntoView({ block: 'start' });
}

/** A chat event: your own message means you're back, so the recap goes. */
export function recapEvent(event, data) {
  if (event.kind === 'user_message' && data.author === me) document.getElementById('recap')?.remove();
}
