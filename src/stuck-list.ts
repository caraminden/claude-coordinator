// The stuck list (#1506): when a person starts a Taskmaster turn, the server lists that Taskmaster's minions and cards
// that have waited with nothing set to move them, so people stop being the ones who notice (13 silent-wait chases in
// three weeks to 2026-11-21: shared/project/reports/taskmaster-misses-deep-dive-2026-11-21.md). It informs only: it
// adds no wakes and changes nothing; the Taskmaster decides. What wakes a seal is storedFacts' (src/live-facts.ts).
import { cardHref, cardText } from './card-links.ts';
import type { Store, Ticket } from './db.ts';
import { storedFacts } from './live-facts.ts';
import type { Runner } from './runner.ts';
import { stateWord } from './needs.ts';

/** An open minion with nothing coming is listed once it has been idle this long (a starting number). */
export const STUCK_IDLE_MS = 6 * 3_600_000;
/** A card is listed once it has waited on people this long. */
export const STUCK_CARD_MS = 24 * 3_600_000;
/** A seal that can't wake (its change is live, or its leader was dismissed) is listed after this, so a wake about to fire isn't. */
export const STUCK_PARK_MS = 3_600_000;
/** An item shows again only this long after it last showed. */
export const STUCK_GAP_MS = 12 * 3_600_000;
const CAP = 10;
const shownKey = (taskmaster: number) => `stuck-shown:${taskmaster}`;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ago = (ms: number) => (ms < 48 * 3_600_000 ? `${Math.max(1, Math.round(ms / 3_600_000))} h` : `${Math.round(ms / 86_400_000)} d`);

type View = ReturnType<Runner['view']>;
type Wait = { kind?: string; state?: string };

/** Something will move it without a person: a turn running or queued, a wait in the outbox, a ship or land under way, a usage-limit resume, held mail on a timer. */
function coming(t: Ticket, v: View): boolean {
  const waits = ((v.outbox_waits ?? []) as Wait[]).filter((w) => w.state === 'waiting' || w.state === 'sending' || (w.state === 'held' && w.kind !== 'chain'));
  return t.status === 'running' || v.queued > 0 || !!v.worker_wait || waits.length > 0 || !!v.wakes_on || !!v.wait || !!v.server_work || v.limit_resume_at != null || !!v.held_mail?.until || v.approvals > 0 || (!!v.ship && ['build', 'main', 'deploying'].includes(v.ship.stage));
}

interface Item {
  key: string;
  rank: number;
  waited: number;
  line: string;
}

/** The minions `taskmaster` manages (its scheme's, reporting to it) that are stuck, oldest first within each kind. */
export function stuckItems(store: Store, runner: Pick<Runner, 'view'>, taskmaster: Ticket, now = Date.now()): Item[] {
  const items: Item[] = [];
  // Its own cards too: a by-hand step put to a person on a card sits in the Taskmaster's chat.
  const own = taskmaster.status === 'closed' ? [] : (runner.view(taskmaster).open_cards ?? []);
  const ownAt = new Map(store.openCardsOf(taskmaster.id).map((e) => [cardHref(taskmaster, e.id), e.created_at]));
  for (const c of own) {
    const waited = now - (ownAt.get(c.href) ?? now);
    if (waited > STUCK_CARD_MS) items.push({ key: `card:${c.href}`, rank: 2, waited, line: `Your own card, waited ${ago(waited)} on ${c.to ?? 'anyone in the scheme'}: ${cardText(c)}` });
  }
  for (const t of store.listTickets(taskmaster.project_id)) {
    if (t.kind === 'coordinator' || t.status === 'closed' || store.ownerCoordinator(t)?.id !== taskmaster.id) continue;
    const v = runner.view(t);
    const f = storedFacts(store, { view: () => v }, t);
    const head = `#${f.number} ${cut(f.title, 70)} (${f.status}${f.state ? `, ${stateWord(f.state)}` : ''}`;
    const note = f.note ? ` · note: ${cut(f.note, 100)}` : '';
    const at = new Map(store.openCardsOf(t.id).map((e) => [cardHref(t, e.id), e.created_at]));
    for (const c of f.cards) {
      const waited = now - (at.get(c.href) ?? now);
      const who = c.to ?? v.assignee ?? 'anyone in the scheme';
      if (waited > STUCK_CARD_MS) items.push({ key: `card:${c.href}`, rank: 2, waited, line: `${head}, card waited ${ago(waited)} on ${who}): ${cardText(c)}${note}` });
    }
    if (f.cards.length || coming(t, v)) continue;
    const idle = now - t.updated_at;
    const parked = f.state === 'parked';
    if (parked && f.ship?.stage === 'live' && idle > STUCK_PARK_MS) items.push({ key: `park:${t.id}`, rank: 0, waited: idle, line: `${head}, idle ${ago(idle)}): sealed, but its own change is live${note}` });
    else if (parked && f.parkedOn && idle > STUCK_PARK_MS) items.push({ key: `park:${t.id}`, rank: 1, waited: idle, line: `${head}, idle ${ago(idle)}): sealed on ${cut(f.parkedOn, 160)}${note}` });
    else if (idle > STUCK_IDLE_MS) items.push({ key: `idle:${t.id}`, rank: 3, waited: idle, line: `${head}, idle ${ago(idle)}): ${parked ? 'sealed, nothing wakes it by itself' : 'nothing set to wake it'}${note}` });
  }
  return items.sort((a, b) => a.rank - b.rank || b.waited - a.waited);
}

/**
 * The block for a person-started turn of `taskmaster`, or null when nothing is stuck or all of it showed within the gap.
 * What it shows is kept per Taskmaster in the settings table (a restart keeps it), and only the shown items are marked.
 */
export function stuckList(store: Store, runner: Pick<Runner, 'view'>, taskmaster: Ticket, now = Date.now()): string | null {
  const shown = store.getSetting<Record<string, number>>(shownKey(taskmaster.id)) ?? {};
  const fresh = stuckItems(store, runner, taskmaster, now).filter((i) => !(now - (shown[i.key] ?? 0) < STUCK_GAP_MS));
  if (!fresh.length) return null;
  const show = fresh.slice(0, CAP);
  const keep = Object.fromEntries(Object.entries(shown).filter(([, at]) => now - at < STUCK_GAP_MS));
  for (const i of show) keep[i.key] = now;
  store.setSetting(shownKey(taskmaster.id), keep);
  const more = fresh.length - show.length;
  return [
    `Stuck list, built by the server: your minions and cards that have waited with nothing set to move them (each shows again after ${STUCK_GAP_MS / 3_600_000} h at the earliest). It wakes nothing and changes nothing. Answer the person first, then take each: nudge it, unseal it, put it to its person on a card, close it, or leave it if it waits on purpose.`,
    ...show.map((i) => `- ${i.line}`),
    ...(more > 0 ? [`- and ${more} more`] : []),
  ].join('\n');
}
