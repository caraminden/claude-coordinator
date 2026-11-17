// Which open cards wait on a person (public/waiting.js's strip). Kept apart from the page code so a test can import it.

/** The cards that wait on `person`: those to everyone and those addressed to them, not ones addressed to someone else (they stay in the chat, answerable by anyone). */
export const cardsForMe = (cards, person) => (cards ?? []).filter((c) => !c.to || c.to.toLowerCase() === String(person ?? '').toLowerCase());

/**
 * The cards the strip over the composer lists for `person`: in the Taskmaster's chat every card waiting on them
 * (#608); in a minion's only its open choices cards (#821; Cara, 2026-11-16: "When you have an open choices card it
 * should have a thing at the bottom of the chat") and secret cards (Cara, 2026-11-17: "These secret cards should show up
 * at the bottom of the chat"), since those are answered on another page or in their own field, not by a click in the chat.
 */
export const stripCards = (t, person) => cardsForMe(t?.open_cards, person).filter((c) => t.kind === 'coordinator' || c.doc || c.what === 'secret');
