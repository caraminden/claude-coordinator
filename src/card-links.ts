// Card links (#400): every mention of a question, plan or approval card in a reply links to that card,
// at the chat address that opens it centred and ringed (#236's jump, public/base.js jumpHref). The
// tools hand the link out (ask_question, propose_plan, read_ticket), and the link check (link-check.ts)
// sends back once a reply that mentions a card still waiting on people without linking it, or that links
// one already answered, settled or dismissed as if it still waited (#531).
import { CODE } from './wording.ts';

/** A card still waiting on people, with the link that opens it. */
export interface CardLink {
  /** The minion's number, or null for the Taskmaster. */
  minion: number | null;
  kind: 'question' | 'plan' | 'approval';
  /** What it asks for, finer than `kind` (cardWhat): the minions list's chip names it (#575). */
  what?: CardWhat;
  /** What it asks, short. */
  label: string;
  /** The in-app address: "#/p/2/t/394?e=123". */
  href: string;
  /**
   * In a turn's snapshot, on its own chat's cards: whether the card sits below the reply that ends the
   * turn (Store.heldBelow), so the link check can catch "the card above" on one that's below (#412).
   */
  below?: boolean;
  /** The one person it's addressed to (#687), whom it waits on. */
  to?: string;
  /** A choices card's page (#804), absolute: the link check knows a linked choices page has its card. */
  doc?: string;
}

/** A card that no longer waits on people, and what happened to it: "answered by Cara at 2:31am: Done, I ran it". */
export interface SettledCard extends CardLink {
  how: string;
}

/** The chat address that opens `ticket`'s card posted as chat event `eventId` (public/base.js jumpHref). */
export function cardHref(ticket: { project_id: number; kind: string; number: number | null; id: number }, eventId: number): string {
  const chat = ticket.kind === 'coordinator' ? `#/p/${ticket.project_id}` : ticket.number == null ? `#/t/${ticket.id}` : `#/p/${ticket.project_id}/t/${ticket.number}`;
  return `${chat}?e=${eventId}`;
}

const clip = (s: unknown, n = 80) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** What a card asks for: a go to ship (a question card asked with kind merge, or an approval for a `gh pr merge`), a tripwire approval, or its plain kind. People read it as the chip (Cara, 2026-11-19, picked "Ship" on #1020's card). */
export type CardWhat = 'question' | 'plan' | 'ship' | 'merge' | 'approval' | 'tripwire' | 'secret';

/** A card's chat event data, the fields read here; unchecked, as it was stored. */
export interface CardData {
  kind?: unknown;
  into?: unknown;
  merge?: { repo?: string; pr?: { base?: string } | null } | null;
  tripwire?: unknown;
  summary?: unknown;
  notice?: unknown;
  doc?: { path?: string; title?: string } | null;
  secret?: { name?: string } | null;
  questions?: ({ header?: string; question?: string } | null)[];
  tool?: unknown;
  input?: { description?: unknown } | null;
  status?: string;
  by?: string;
  at?: number;
  settled?: { at: number; by?: string; dismissed?: boolean; sent?: boolean } | null;
}

/** What card `kind` posted with chat event data `data` asks for (CardWhat). */
export function cardWhat(kind: CardLink['kind'], stored: unknown): CardWhat {
  const data = stored as CardData | null | undefined;
  // A PR into a major build's branch merges into the build; every other go ships.
  if (kind === 'approval' && /^build\//.test(data?.merge?.pr?.base ?? '')) return 'merge';
  // A feeder's own go card (asked with kind merge, stamped with its build) merges into the build too.
  if (kind === 'question' && data?.kind === 'merge' && data?.into) return 'merge';
  if (data?.kind === 'merge' || (kind === 'approval' && data?.merge)) return 'ship';
  if (kind === 'approval' && data?.tripwire) return 'tripwire';
  if (kind === 'question' && data?.secret) return 'secret';
  return kind;
}

/** A card's short label from its chat event's data. */
export function cardLabel(kind: string, stored: unknown): string {
  const data = stored as CardData | null | undefined;
  if (kind === 'plan') return clip(data?.summary);
  if (kind === 'question' && data?.notice) return clip(data.notice);
  if (kind === 'question' && data?.doc) return clip(`picks on “${data.doc.title}”`);
  if (kind === 'question' && data?.secret) return clip(`a secret to save as ${data.secret.name}`);
  if (kind === 'question')
    return clip(
      (data?.questions ?? [])
        .map((q) => q?.header || q?.question)
        .filter(Boolean)
        .join(', '),
    );
  return clip(typeof data?.input?.description === 'string' ? `${data.tool}: ${data.input.description}` : data?.tool);
}

/** The first answer to a card, or the message typed for one. */
export interface CardReply {
  author?: string;
  at: number;
  text?: unknown;
  answer?: { answers?: ({ selected?: string[]; other?: string } | null)[] } | null;
}

/** An approval's result event. */
export interface CardResult {
  state?: string;
  by?: string;
  at: number;
  reason?: string;
  via?: { text?: unknown } | null;
}

/**
 * What happened to a card that no longer waits on people (#531), from its chat event's data, the first
 * answer to it (`reply`, Store.recentCards; a typed message from before #812 can still be one), an approval's result, and whether its minion
 * was dismissed. `clock` formats a time.
 */
export function settledHow(kind: string, data: CardData | null | undefined, reply: CardReply | null | undefined, result: CardResult | null | undefined, dismissed: number | null, clock: (ms: number) => string): string {
  const answers = (reply?.answer?.answers ?? []).flatMap((a) => [...(a?.selected ?? []), ...(a?.other ? [a.other] : [])]);
  if (reply?.answer) return `answered by ${reply.author} at ${clock(reply.at)}${answers.length ? `: ${clip(answers.join('; '))}` : ''}`;
  if (kind === 'plan' && data?.status && data.status !== 'pending') return `${data.status}${data.by ? ` by ${data.by}` : ''}${data.at ? ` at ${clock(data.at)}` : ''}`;
  if (result?.state === 'expired') return `expired at ${clock(result.at)}${result.reason ? ` (${result.reason})` : ''}`;
  if (result?.via) return `allowed on ${result.by}'s go "${clip(result.via.text)}" at ${clock(result.at)}`;
  if (result?.state) return `${result.state}${result.by ? ` by ${result.by}` : ''} at ${clock(result.at)}`;
  if (reply) return `${reply.author} wrote in its chat at ${clock(reply.at)}: "${clip(reply.text)}"`;
  if (data?.settled?.dismissed) return `dismissed by ${data.settled.by} at ${clock(data.settled.at)}`;
  if (data?.settled?.sent) return `picks sent by ${data.settled.by} at ${clock(data.settled.at)}`;
  if (data?.settled?.by) return `seen by ${data.settled.by} at ${clock(data.settled.at)}`;
  if (data?.settled?.at) return `settled by its minion at ${clock(data.settled.at)}`;
  return dismissed != null ? `#${dismissed} was dismissed` : 'no longer waits on people';
}

/** How a card reads in a tool's text: `question card "Layout": [open it](#/p/2/t/394?e=123)`. */
export const cardText = (c: CardLink) => `${c.what === 'secret' || c.what === 'ship' || c.what === 'merge' ? c.what : c.kind} card${c.to ? ` for ${c.to}` : ''}${c.label ? ` "${c.label}"` : ''}: [open it](${c.href})`;

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
    lines.push(
      card.below
        ? `- It calls ${name} "${said}", but it sits below this reply: the chat keeps this turn's question and plan cards under the turn's words until someone writes or the turn ends, however early you asked. Say "below".`
        : `- It calls ${name} "${said}", but it sits above this reply: it was posted before this turn's words (an earlier turn, or before someone wrote). Say "above".`,
    );
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

/** Words that call a card waiting on people: "waiting on you", "needs your go", "still open". */
const PENDING = /\b(?:wait(?:s|ing)?|awaits|awaiting|needs?|pending|unanswered|still open|open (?:card|question)s?|from you|on you|for you to|go card|to (?:answer|approve|pick|decide))\b/i;
/** A request at the start of a sentence or list item: "Tap Done on [the card](…)". */
const ASKS = /^\s*(?:[-*+]|\d+[.)])?\s*(?:please\s+)?(?:tap|click|answer|approve|pick|choose|decide)\b/i;
/** Words that say the card is dealt with, or that nothing is asked, which let the link through. */
const DONE = /\b(?:answered|settled|approved|picked|chose|already|closed|dismissed|resolved|replied|denied|allowed|expired|revised|no (?:need|longer)|nothing|not needed|(?:don't|doesn't|do not|does not) need)\b/i;
/** A line that introduces a list: ends in a colon, or is a heading or a bold line ("Waiting on you:", "**Needs you**"). */
const INTRO = /:\s*$|^\s*#{1,6}\s|^\s*\*\*[^*]+\*\*:?\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/**
 * The settled cards `text` links as if they still waited on people (#531): the link's sentence, or the
 * line introducing its list ("Waiting on you:"), reads as pending, and neither says it's dealt with.
 */
export function staleCards(text: string, settled: SettledCard[]): SettledCard[] {
  if (!settled.length) return [];
  const byEvent = new Map(settled.map((c) => [Number(/\?e=(\d+)$/.exec(c.href)?.[1]), c]));
  const stale = new Set<SettledCard>();
  let lead = '';
  for (const line of text.replace(CODE, ' ').split('\n')) {
    if (!line.trim()) continue;
    const item = LIST_ITEM.test(line);
    if (!item) lead = '';
    // Sentences end at . ! ? ; followed by a space: a link's "?e=" has none.
    for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
      for (const m of sentence.matchAll(/\]\([^)\s]*\?e=(\d+)\)/g)) {
        const card = byEvent.get(Number(m[1]));
        const said = `${lead} ${sentence}`;
        if (card && (PENDING.test(said) || ASKS.test(sentence)) && !DONE.test(said)) stale.add(card);
      }
    }
    if (!item) lead = INTRO.test(line) ? line : '';
  }
  return [...stale];
}

/** A sentence that says something waits on a person: "waiting on you", "still yours", "needs your go", "blocked on Cara". */
const WAITS = /\b(?:wait(?:s|ing)? (?:on|for) (?:you|cara|josh|cody)\b|awaiting (?:your|cara|josh|cody)|still (?:yours|needed from you)|needs? (?:your|cara'?s?|josh'?s?) (?:go|ok|okay|pick|decision|answer|input|sign-?off|approval)|blocked on (?:you|cara|josh|cody)\b|on you to\b)/i;
/** Negations and "it's done" wording near the match, which let the line through. */
const NOT_WAITING = /\b(?:until|was|were|had|parked|sealed|will|would|should(?:n't)?|risk|high-risk|allow|reading|read|per|nothing|no(?:thing| one| longer)?|not|never|isn't|aren't|nobody|n't|already|done|resolved|answered|settled|no need)\b/i;

/**
 * The first sentence that says something waits on a person, when its paragraph links no card (an `?e=` link)
 * and says nothing is done or not needed; null if none (#1507). The caller lets a turn that posted a card, or a
 * status line with a reply button, through. A list introduced by "Waiting on you:" counts as one paragraph.
 */
export function waitingNoCard(text: string): string | null {
  const plain = text.replace(CODE, ' ').replace(/"[^"\n]*"|“[^”\n]*”/g, ' ');
  for (const para of plain.split(/\n\s*\n/)) {
    if (/\?e=\d+|\]\(#\/p\/\d+\/t\/\d+|\bcards?\b/i.test(para)) continue; // a card named or linked: the card checks speak for it
    for (const line of para.split('\n')) {
      for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
        if (WAITS.test(sentence) && !NOT_WAITING.test(sentence)) return sentence.trim();
      }
    }
  }
  return null;
}

/** The send-back's line for a waiting claim with no card. */
export function explainWaiting(sentence: string): string {
  return (
    `Your reply says something waits on a person ("${sentence.slice(0, 120)}") but links no open card. A by-hand step or a prose ask has no object they can answer. ` +
    'Do one of: link the open card that holds it ([the card](its link)); put the step on a card with ask_question, to that person (Done / Later), and link it; or drop the line. ' +
    'If nothing really waits on them, answer KEEP.'
  );
}

/** The send-back's lines for links to settled cards: each card and what happened to it. */
export function explainStale(stale: SettledCard[], self: number | null): string {
  const lines = ['Your reply links a card as if it still waits on people, but it no longer does:'];
  for (const c of stale) lines.push(`- ${c.minion === self ? "This chat's" : c.minion == null ? "The Taskmaster's" : `#${c.minion}'s`} ${c.kind} card${c.label ? ` "${c.label}"` : ''} (${c.href}): ${c.how}`);
  lines.push('Drop it, or say it was answered. If it still needs people for another reason, leave it: the next try goes through.');
  return lines.join('\n');
}
