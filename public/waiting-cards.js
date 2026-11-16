// Which open cards wait on a person (public/waiting.js's strip). Kept apart from the page code so a test can import it.

/** The cards that wait on `person`: those to everyone and those addressed to them, not ones addressed to someone else (they stay in the chat, answerable by anyone). */
export const cardsForMe = (cards, person) => (cards ?? []).filter((c) => !c.to || c.to.toLowerCase() === String(person ?? '').toLowerCase());
