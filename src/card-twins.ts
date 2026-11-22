// A question card that repeats one still open, or one just answered, is refused once (#1536's sibling #1508; Cara,
// 2026-11-21: "Catch a card asked twice"). A plain text comparison of the questions and option labels, no memory index.
import { cardHref } from './card-links.ts';
import type { Store, Ticket } from './db.ts';

const WORDS = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean));
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
};

type Q = { question?: string; options?: { label?: string }[] };

/** Whether two questions put the same ask: their wording alike, or alike enough with the same option labels. */
export function sameAsk(a: Q, b: Q): boolean {
  const q = jaccard(WORDS(a.question ?? ''), WORDS(b.question ?? ''));
  if (q >= 0.7) return true;
  const labels = (x: Q) => WORDS((x.options ?? []).map((o) => o.label ?? '').join(' '));
  return q >= 0.6 && jaccard(labels(a), labels(b)) >= 0.7;
}

export const ANSWERED_WITHIN_MS = 24 * 3600_000;

/**
 * The earlier card a new plain question card repeats, as the text to refuse with, or null. Looked at: cards open in the
 * scheme that the same people can answer (no `to`, or the same `to`), and cards answered in the last 24 hours.
 * Choices-page, secret and notice cards (no questions) are never compared.
 */
export function cardTwin(store: Store, ticket: Ticket, card: { questions: Q[]; to?: string | null }, now = Date.now()): string | null {
  // An advisory check: a broken row must never stop a card being asked.
  try { return findTwin(store, ticket, card, now); } catch { return null; }
}

function findTwin(store: Store, ticket: Ticket, card: { questions: Q[]; to?: string | null }, now = Date.now()): string | null {
  if (!card.questions.length) return null;
  const to = card.to?.toLowerCase() ?? null;
  const open = new Set(store.openCards(ticket.project_id).map((e) => e.id));
  for (const e of store.recentCards(ticket.project_id, 200).reverse()) {
    if (e.kind !== 'question') continue;
    const data = JSON.parse(e.data);
    if (!data.questions?.length || data.settled) continue;
    const theirTo = typeof data.to === 'string' ? data.to.toLowerCase() : null;
    const reply = e.reply ? JSON.parse(e.reply) : null;
    const isOpen = open.has(e.id) && !reply;
    const who = reply?.author ? String(reply.author).toLowerCase() : null;
    if (isOpen) {
      if (to !== theirTo) continue;
    } else if (!reply || now - reply.at > ANSWERED_WITHIN_MS || !(theirTo === to || (to && who === to))) continue;
    if (!card.questions.some((q) => data.questions.some((o: Q) => sameAsk(q, o)))) continue;
    const href = cardHref({ project_id: ticket.project_id, kind: e.tkind, number: e.number, id: e.ticket_id }, e.id);
    const tail = 'If it is a different question, call ask_question again with not_duplicate: true.';
    if (isOpen) return `Not posted: a card asking the same is still open, [asked ${e.number != null ? `by #${e.number}` : 'earlier'}](${href}). Point to it, or settle it first. ${tail}`;
    const text = String(reply.text ?? '').replace(/\s+/g, ' ').slice(0, 300);
    return `Not posted: ${reply.author ?? 'someone'} already answered the same question [on ${e.number != null ? `#${e.number}` : 'another chat'}](${href}): ${text}. Use that answer if it covers your case. ${tail}`;
  }
  return null;
}
