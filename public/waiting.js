// Cards waiting on you, over the Taskmaster's composer (#608; Josh, 2026-11-12: "something at the bottom of a
// tastmasters chat with pending card links"), so a night's activity needn't be scrolled to find them. Only the
// Taskmaster's own cards (Josh's pick, 2026-11-12); each is a link that opens the chat at the card. They're the
// row's open_cards (Runner.cardLinks), the list read_ticket and list_tickets show. A minion's chat gets the strip
// for its open choices cards (#821, each with Open the page beside it) and secret cards.

/** @import { CardLink, Ticket } from './types.js' */
import { fileHref, h, me } from './base.js';
import { gloss } from './help-words.js';
import { openHash } from './core.js';
import { cardWord } from './threadstate.js';
import { stripCards } from './waiting-cards.js';

/**
 * The strip for chat `t`, or null when nothing waits on you: a Taskmaster's cards, or a minion's open choices and secret
 * cards (#821), each with an Open the page button beside its link, as the card has.
 */
/** @param {Ticket} t */
export function waitingStrip(t) {
  // A choices card shows only its page's title (its label is "picks on “Takes”"); its button says what it is.
  /** @param {CardLink} c */
  const whatOf = (c) => {
    const what = c.doc ? '' : cardWord(c);
    return what || c.to ? h('span', { class: 'what' }, what, c.to ? `${what ? ' ' : ''}for ${c.to}` : '') : '';
  };
  const cards = stripCards(t, me);
  if (!cards.length) return null;
  /** @param {CardLink} c */
  const link = (c) => [
    h(
      'a',
      {
        class: c.doc ? 'waiting-card doc' : 'waiting-card',
        href: c.href,
        title: `Open the ${c.what ?? c.kind} card${c.label ? ` "${c.label}"` : ''}`,
        // openHash also jumps when the link is the address you're on already (a second click on the same card).
        onclick: /** @param {MouseEvent} e */ (e) => {
          if (e.button || e.ctrlKey || e.metaKey || e.shiftKey) return;
          e.preventDefault();
          openHash(c.href);
        },
      },
      whatOf(c),
      c.label ? h('span', { class: 'label' }, c.doc ? c.label.replace(/^picks on “(.*)”$/, '$1') : c.label) : '',
    ),
    // A choices card's page holds its picks; this opens it as the card's button does (public/cards.js docCard).
    c.doc ? h('a', { class: 'button small waiting-open', href: fileHref(t.id, c.doc) }, 'Open the page') : '',
  ];
  // A strip of only choices and secret cards (always so in a minion's chat): on a phone its head gives way to them (public/composer.css).
  return h('div', { class: cards.every((c) => c.doc || c.what === 'secret') ? 'waiting-strip choices' : 'waiting-strip' }, h('span', { class: 'waiting-head' }, cards.length === 1 ? ['1 ', gloss('card', 'card'), ' waits on you'] : [`${cards.length} `, gloss('card', 'cards'), ' wait on you']), ...cards.flatMap(link));
}
