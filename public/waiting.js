// Cards waiting on you, over the Taskmaster's composer (#608; Josh, 2026-11-12: "something at the bottom of a
// tastmasters chat with pending card links"), so a night's activity needn't be scrolled to find them. Only the
// Taskmaster's own cards (Josh's pick, 2026-11-12); each is a link that opens the chat at the card. They're the
// row's open_cards (Runner.cardLinks), the list read_ticket and list_tickets show.
import { h, me } from './base.js';
import { openHash } from './core.js';
import { cardsForMe } from './waiting-cards.js';

/** The strip for Taskmaster `t`, or null when nothing waits on you. */
export function waitingStrip(t) {
  const cards = cardsForMe(t.open_cards, me);
  if (!cards.length) return null;
  const link = (c) => h('a', {
    class: 'waiting-card', href: c.href, title: `Open the ${c.what ?? c.kind} card${c.label ? ` "${c.label}"` : ''}`,
    // openHash also jumps when the link is the address you're on already (a second click on the same card).
    onclick: (e) => { if (e.button || e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); openHash(c.href); },
  }, h('span', { class: 'what' }, c.what ?? c.kind, c.to ? ` for ${c.to}` : ''), c.label ? h('span', { class: 'label' }, c.label) : '');
  return h('div', { class: 'waiting-strip' }, h('span', { class: 'waiting-head' }, cards.length === 1 ? '1 card waits on you' : `${cards.length} cards wait on you`), ...cards.map(link));
}
