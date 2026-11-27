// A minion's cards waiting on people (with the link that opens each), and the scheme-refs snapshot every running turn
// keeps in its folder: its scheme's minions and those cards, which the link check reads (src/scheme-refs.ts). A card
// posted or settled refreshes the snapshots of its scheme's running turns, at most once per refsGapMs.
// Moved out of runner.ts (#2045): it takes what it needs from the Runner as `TurnRefsDeps`.
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { access, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EventRow, Project, Store, Ticket } from './db.ts';
import type { SchemeRefs } from './scheme-refs.ts';
import { cardHref, cardLabel, cardWhat, settledHow, type CardLink, type SettledCard } from './card-links.ts';
import { clockTime } from './pacific.ts';
import type { Clock, ClockTimer } from './clock.ts';
import type { Approvals } from './approvals.ts';
import type { LiveTurn } from './runner.ts';

/** The scheme-refs snapshot for a turn of `project`: its name, the other schemes' names and its minions, plus its cards waiting on people (card-links.ts). */
export function schemeRefs(project: Project, projects: Project[], tickets: Ticket[], cards?: { self: number | null; cards: CardLink[] }): SchemeRefs {
  const minions: SchemeRefs['minions'] = {};
  for (const t of tickets) if (t.number != null) minions[t.number] = { title: t.title, closed: t.status === 'closed' };
  return { scheme: project.name, others: projects.filter((p) => p.id !== project.id).map((p) => p.name), minions, ...cards };
}

/** What the cards and snapshots need from the Runner. `turns` stays the Runner's: a snapshot lives in a running turn's folder. */
export interface TurnRefsDeps {
  store: Store;
  turns: Map<number, LiveTurn>;
  clock: () => Clock;
  approvals: () => Approvals;
}

export class TurnRefs {
  private d: TurnRefsDeps;
  constructor(d: TurnRefsDeps) {
    this.d = d;
  }

  /** A minion's cards waiting on people, oldest first, each with the link that opens it (#400); `placed` adds where each sits (CardLink.below). */
  cardLinks(ticket: Ticket, placed = false, open?: EventRow[], approvals?: { at: number; card: unknown }[]): CardLink[] {
    if (ticket.status === 'closed') return [];
    const minion = ticket.kind === 'coordinator' ? null : ticket.number;
    const link = (kind: CardLink['kind'], data: unknown, eventId: number): CardLink => ({
      minion,
      kind,
      what: cardWhat(kind, data),
      label: cardLabel(kind, data),
      href: cardHref(ticket, eventId),
      ...((data as { to?: string })?.to ? { to: (data as { to: string }).to } : {}),
      ...((data as { doc?: { path: string } })?.doc ? { doc: (data as { doc: { path: string } }).doc.path } : {}),
      // Only question and plan cards are held under the turn's words (public/thread.js heldCards).
      ...(placed ? { below: kind !== 'approval' && this.d.store.heldBelow(ticket.id, eventId) } : {}),
    });
    const asks = (
      approvals ??
      this.d
        .approvals()
        .pending()
        .filter((a) => a.ticketId === ticket.id)
    ).flatMap((a) => {
      const eventId = this.d.store.cardEventId(ticket.id, 'approval', (a.card as { id: string }).id);
      return eventId == null ? [] : [{ at: a.at, id: eventId, card: link('approval', a.card, eventId) }];
    });
    const stored = (open ?? this.d.store.openCardsOf(ticket.id)).map((e) => ({ at: e.created_at, id: e.id, card: link(e.kind as CardLink['kind'], JSON.parse(e.data), e.id) }));
    // Cards posted in the same millisecond keep the order they were posted in (their event ids).
    return [...asks, ...stored].sort((a, b) => a.at - b.at || a.id - b.id).map((c) => c.card);
  }

  /** The scheme's newest 500 cards that aren't in `open`, with what happened to each (#531). No time cutoff: a card asked weeks ago may be answered today. */
  private settledCards(projectId: number, open: Set<string>): SettledCard[] {
    return this.d.store.recentCards(projectId, 500).flatMap((r) => {
      const href = cardHref({ project_id: projectId, kind: r.tkind, number: r.number, id: r.ticket_id }, r.id);
      if (open.has(href)) return [];
      const kind = r.kind as CardLink['kind'];
      const data = JSON.parse(r.data);
      const minion = r.tkind === 'coordinator' ? null : r.number;
      const how = settledHow(kind, data, r.reply && JSON.parse(r.reply), r.result && JSON.parse(r.result), r.tstatus === 'closed' ? minion : null, (ms) => clockTime(ms));
      return [{ minion, kind, what: cardWhat(kind, data), label: cardLabel(kind, data), href, how, ...(data?.doc ? { doc: data.doc.path } : {}) }];
    });
  }

  /** Read each scheme's newest cards' rows into the store's memory in small steps, yielding between them, so the first
   * refsShared after a restart doesn't read 500 scattered rows in one go (Store.warmCardRows). Quits on its own errors. */
  async warmCards(chunk = 25, pauseMs = 5) {
    try {
      for (const p of this.d.store.listProjects()) {
        while (this.d.store.warmCardRows(p.id, 500, chunk) > 0) await sleep(pauseMs);
        await sleep(pauseMs);
      }
    } catch (err) {
      console.warn('warming card rows failed:', err);
    }
  }

  /**
   * What every turn's scheme-refs snapshot in a scheme shares, read once however many turns run there (#609). The
   * scheme's open cards come in one query, not one per minion (#1562).
   */
  refsShared(projectId: number) {
    const tickets = this.d.store.listTickets(projectId);
    const openOf = new Map<number, EventRow[]>(tickets.map((t) => [t.id, []]));
    for (const e of this.d.store.openCards(projectId)) openOf.get(e.ticket_id)?.push(e);
    const links = new Map(tickets.map((t) => [t.id, this.cardLinks(t, false, openOf.get(t.id))]));
    const open = new Set([...links.values()].flat().map((c) => c.href));
    return { project: this.d.store.getProject(projectId)!, projects: this.d.store.listProjects(), tickets, openOf, links, settled: this.settledCards(projectId, open) };
  }

  /**
   * Write a turn's scheme-refs snapshot (scheme-refs.ts) for `ticket`, with its scheme's cards waiting on people. `now`
   * writes it before returning (a launch: the turn reads it from its first reply); a refresh goes through putRefs.
   */
  writeRefs(file: string, ticket: Ticket, shared = this.refsShared(ticket.project_id), now = false) {
    const text = this.refsText(ticket, shared);
    if (now) {
      // Whole or not at all: the link check may read it mid-turn.
      writeFileSync(`${file}.new`, text);
      renameSync(`${file}.new`, file);
      // A refresh still on its way to this file would put older text back: it writes this one last.
      const held = this.refsWrites.get(file);
      if (held) held.text = text;
    } else this.putRefs(file, text);
  }

  /** A turn's scheme-refs snapshot (scheme-refs.ts) as text: its scheme's minions and the cards waiting on people. */
  refsText(ticket: Ticket, shared = this.refsShared(ticket.project_id)) {
    const { project, projects, tickets, openOf, links, settled } = shared;
    // Only the turn's own cards say where each sits (`placed`).
    const cards = { self: ticket.kind === 'coordinator' ? null : ticket.number, cards: tickets.flatMap((t) => (t.id === ticket.id ? this.cardLinks(t, true, openOf.get(t.id)) : links.get(t.id)!)) };
    return JSON.stringify({ ...schemeRefs(project, projects, tickets, cards), settled });
  }

  /** Per scheme: how many refreshes of its turns' snapshots have run, so a launch can tell it missed one (#1808). */
  readonly refsSeq = new Map<number, number>();

  /** Per snapshot file: the newest text still to write (null once taken), and its writes' end. */
  private refsWrites = new Map<string, { text: string | null; done: Promise<void> }>();

  /**
   * Writes a running turn's snapshot off the server's thread (#1768): on a busy disk the write and rename each held
   * every request for up to a second (Nov 24, six holds). One write per file at a time, the newest text winning, whole
   * or not at all, and only over a snapshot that is still there: a turn that ended took its folder with it.
   */
  private putRefs(file: string, text: string) {
    const held = this.refsWrites.get(file);
    if (held) {
      held.text = text;
      return;
    }
    const w = { text: text as string | null, done: Promise.resolve() };
    this.refsWrites.set(file, w);
    w.done = (async () => {
      try {
        while (w.text !== null) {
          const next = w.text;
          w.text = null;
          await access(file);
          await writeFile(`${file}.new`, next);
          await rename(`${file}.new`, file);
        }
      } catch {
        // A stale snapshot only means a card goes unchecked.
      } finally {
        this.refsWrites.delete(file);
      }
    })();
  }

  /** Resolves once every snapshot write under way has reached its file. */
  async refsWritten(): Promise<void> {
    while (this.refsWrites.size) await Promise.all([...this.refsWrites.values()].map((w) => w.done));
  }

  /** The least time between two refreshes of a scheme's snapshots (refreshRefs). */
  refsGapMs = 2_000;
  /** Per scheme: when its snapshots were last refreshed, and the refresh waiting for the gap to pass. */
  private refsLast = new Map<number, { at: number; due?: ClockTimer }>();

  /**
   * A card was posted or settled in `ticketId`'s chat: the running turns of its scheme get it in their snapshot, so the
   * link check knows it. At most once per refsGapMs per scheme (#1562): the first card refreshes at once, and the cards
   * after it within the gap share one refresh at its end. The card's own minion gets its snapshot at once either way:
   * its link check may read it before the gap ends, and a missing card there bounces its reply (cardlessChoices).
   * `posted` (the turn posted the card itself) writes that one snapshot before returning, so it is there when the
   * turn's tool call is answered; every other turn's goes off the server's thread (putRefs).
   */
  refreshRefs(ticketId: number, posted = false) {
    const projectId = this.d.store.getTicket(ticketId)?.project_id;
    if (projectId === undefined) return;
    const last = this.refsLast.get(projectId);
    const wait = last ? last.at + this.refsGapMs - this.d.clock().now() : 0;
    const own = posted ? ticketId : undefined;
    if (!last?.due && wait <= 0) return this.writeSchemeRefs(projectId, undefined, own);
    this.writeSchemeRefs(projectId, ticketId, own);
    if (last?.due) return;
    const due = this.d.clock().setTimeout(() => {
      try {
        this.writeSchemeRefs(projectId);
      } catch (err) {
        console.error(`Scheme ${projectId}: refreshing its turns' snapshots failed:`, err);
      }
    }, wait);
    due.unref();
    this.refsLast.set(projectId, { at: last!.at, due });
  }

  /**
   * Rewrite the snapshot of every turn running in `projectId`, or only `only`'s, outside the gap (refreshRefs). `own`'s
   * is written before returning, the rest off the server's thread.
   */
  private writeSchemeRefs(projectId: number, only?: number, own?: number) {
    // The gap starts only once a refresh read something: a card in a scheme with no turn running costs nothing.
    if (only === undefined) this.refsLast.delete(projectId);
    this.refsSeq.set(projectId, (this.refsSeq.get(projectId) ?? 0) + 1);
    let shared: ReturnType<TurnRefs['refsShared']> | undefined;
    for (const [id, turn] of this.d.turns) {
      if (only !== undefined && id !== only) continue;
      const t = this.d.store.getTicket(id);
      if (t?.project_id !== projectId) continue;
      if (!shared && only === undefined) this.refsLast.set(projectId, { at: this.d.clock().now() });
      try {
        const file = join(turn.dir, 'scheme-refs.json');
        // A turn that ended took its folder with it (putRefs checks the same, off the thread).
        if (id === own && !existsSync(file)) continue;
        this.writeRefs(file, t, (shared ??= this.refsShared(projectId)), id === own);
      } catch {
        // A stale snapshot only means a card goes unchecked.
      }
    }
  }
}
