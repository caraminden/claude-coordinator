// Card links (#400): every mention of a question, plan or approval card in a reply links to that card,
// at the chat address that opens it centred and ringed (#236's jump, public/core.js jumpHref). The
// tools hand the link out (ask_question, propose_plan, read_ticket), and the link check (link-check.ts)
// sends back once a reply that mentions a card still waiting on people without linking it.
import { CODE } from './wording.ts';

/** A card still waiting on people, with the link that opens it. */
export interface CardLink {
  /** The minion's number, or null for the Taskmaster. */
  minion: number | null;
  kind: 'question' | 'plan' | 'approval';
  /** What it asks, short. */
  label: string;
  /** The in-app address: "#/p/2/t/394?e=123". */
  href: string;
  /**
   * In a turn's snapshot, on its own chat's cards: whether the card sits below the reply that ends the
   * turn (Store.heldBelow), so the link check can catch "the card above" on one that's below (#412).
   */
  below?: boolean;
}

/** The chat address that opens `ticket`'s card posted as chat event `eventId` (public/core.js jumpHref). */
export function cardHref(ticket: { project_id: number; kind: string; number: number | null; id: number }, eventId: number): string {
  const chat = ticket.kind === 'coordinator' ? `#/p/${ticket.project_id}` : ticket.number == null ? `#/t/${ticket.id}` : `#/p/${ticket.project_id}/t/${ticket.number}`;
  return `${chat}?e=${eventId}`;
}

const clip = (s: unknown, n = 80) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A card's short label from its chat event's data. */
export function cardLabel(kind: string, data: any): string {
  if (kind === 'plan') return clip(data?.summary);
  if (kind === 'question') return clip((data?.questions ?? []).map((q: any) => q?.header || q?.question).filter(Boolean).join(', '));
  return clip(typeof data?.input?.description === 'string' ? `${data.tool}: ${data.input.description}` : data?.tool);
}

/** How a card reads in a tool's text: `question card "Layout": [open it](#/p/2/t/394?e=123)`. */
export const cardText = (c: CardLink) => `${c.kind} card${c.label ? ` "${c.label}"` : ''}: [open it](${c.href})`;

/** "card", "cards", "card's", as a word. */
const CARD = /(?<![\p{L}\p{N}_-])cards?(?![\p{L}\p{N}_-])/iu;
/** A bare #N as the chat links it (scheme-refs.ts REF), not "PR #N". */
const MINION = /(?<!\b(?:PRs?|[Pp]ull [Rr]equests?|[Ii]ssues?):?\s?)(?<![\w&/#.:?=+-])#(\d{1,6})(?![\w#/-])/g;

/**
 * The cards waiting on people that `text` mentions without linking any of them, by minion. A paragraph
 * that says "card" means the cards of the minions it names with a #N, or failing any of those with a
 * card waiting, this chat's own (`self`). A link to any card of that minion's counts, so one link
 * serves a paragraph that mentions it twice.
 */
export function unlinkedCards(text: string, cards: CardLink[], self: number | null): CardLink[][] {
  if (!cards.length) return [];
  const plain = text.replace(CODE, ' ');
  const linked = new Set([...plain.matchAll(/\?e=(\d+)/g)].map((m) => Number(m[1])));
  const eventOf = (c: CardLink) => Number(/\?e=(\d+)$/.exec(c.href)?.[1]);
  const of = (minion: number | null) => cards.filter((c) => c.minion === minion);
  const missing = new Map<number | null, CardLink[]>();
  for (const para of plain.split(/\n\s*\n/)) {
    if (!CARD.test(para)) continue;
    const named = [...new Set([...para.matchAll(MINION)].map((m) => Number(m[1])))].filter((n) => of(n).length);
    for (const minion of named.length ? named : [self]) {
      const waiting = of(minion);
      if (waiting.length && !waiting.some((c) => linked.has(eventOf(c)))) missing.set(minion, waiting);
    }
  }
  return [...missing.values()];
}

/** A link to a card with a direction word in its text or right after it: "[the card above](…)", "[the card](…) below". */
const POINTED = /\[([^\]]*)\]\([^)\s]*\?e=(\d+)\)(\s+(?:above|below)\b)?/giu;

/**
 * This chat's cards that `text` links with "above" or "below" where the card sits the other way: a
 * card asked early in a long turn still sits below that turn's reply (Transdata #6, #412).
 */
export function misplacedCards(text: string, cards: CardLink[], self: number | null): { card: CardLink; said: 'above' | 'below' }[] {
  const own = new Map(cards.filter((c) => c.minion === self && c.below !== undefined).map((c) => [Number(/\?e=(\d+)$/.exec(c.href)?.[1]), c]));
  const wrong = new Map<CardLink, 'above' | 'below'>();
  for (const m of text.replace(CODE, ' ').matchAll(POINTED)) {
    const card = own.get(Number(m[2]));
    const said = /\b(above|below)\b/i.exec(`${m[1]} ${m[3] ?? ''}`)?.[1].toLowerCase() as 'above' | 'below' | undefined;
    if (card && said && (said === 'below') !== card.below) wrong.set(card, said);
  }
  return [...wrong].map(([card, said]) => ({ card, said }));
}

/** The send-back's lines for misplaced cards. */
export function explainMisplaced(wrong: { card: CardLink; said: 'above' | 'below' }[]): string {
  const lines = ['Your reply points the wrong way to a card:'];
  for (const { card, said } of wrong) {
    const name = `${card.kind} card${card.label ? ` "${card.label}"` : ''} (${card.href})`;
    lines.push(card.below
      ? `- It calls ${name} "${said}", but it sits below this reply: the chat keeps this turn's question and plan cards under the turn's words until someone writes or the turn ends, however early you asked. Say "below".`
      : `- It calls ${name} "${said}", but it sits above this reply: it was posted before this turn's words (an earlier turn, or before someone wrote). Say "above".`);
  }
  return lines.join('\n');
}

/** The send-back's lines for these: each card and the link to put on its mention. */
export function explainCards(missing: CardLink[][], self: number | null): string {
  const lines = ['Your reply mentions a card waiting on people without linking it. Make each mention of a card a link to it, e.g. [the card](#/p/2/t/394?e=123), so it opens that card:'];
  for (const group of missing) {
    for (const c of group) lines.push(`- ${c.minion === self ? "This chat's" : c.minion == null ? "The Taskmaster's" : `#${c.minion}'s`} ${c.kind} card${c.label ? ` "${c.label}"` : ''}: ${c.href}`);
  }
  lines.push("If you didn't mean a card that waits on people, leave it as it is: the next try goes through.");
  return lines.join('\n');
}
