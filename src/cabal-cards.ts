// Each open cabal's card in the minions list (#2092): its board (src/cabal-board.ts) cut down to what the card shows.
// Read per scheme, cached, polled with the build headers and again on every board write, and broadcast when it
// changes, so opening a card asks the server nothing. A cabal is open while its lead is.
import { type BoardDeps, type BoardMember, overseerOf, readBoard } from './cabal-board.ts';
import type { Store } from './db.ts';

export interface CabalCardMember {
  /** The minion's id; null for a roster row nobody started. */
  id: number | null;
  number: number | null;
  label: string;
  title: string;
  state: BoardMember['state'];
  word: string;
  /** Its scheme's name when it runs in another (#2094): it isn't in this scheme's list, so the card lists it by name. */
  scheme: string | null;
}

export interface CabalCard {
  /** The lead minion's id, number and title. */
  lead: number;
  number: number | null;
  title: string;
  /** "Build 7's Overseer": one per cabal (Josh, 2026-11-25). */
  overseer: string;
  /** The lead's build, whose section the card takes the place of; null for a goal cabal without one. */
  build: number | null;
  /** What finished work is called: "merged" into a build branch, else "shipped". */
  done: 'merged' | 'shipped';
  members: CabalCardMember[];
  finished: number;
  next: number;
  /** Open asks on its board. */
  asks: number;
  spend: number;
}

const UNSTARTED = new Set<BoardMember['state']>(['roster', 'sealed']);

/** Unstarted members whose wait is over or is on members all under way: they start next. */
export function nextUp(members: Pick<BoardMember, 'state' | 'after' | 'number' | 'label'>[]): number {
  // `after` is free text ("M1", "#12", "M1, M2", "everything"): a name that is no member under way keeps its row waiting.
  const underWay = (name: string) => members.some((m) => !UNSTARTED.has(m.state) && (`#${m.number}` === name || m.label === name));
  return members.filter(
    (m) =>
      UNSTARTED.has(m.state) &&
      (!m.after ||
        m.after
          .split(/\s*(?:,|\+|&|\band\b)\s*/)
          .filter(Boolean)
          .every(underWay)),
  ).length;
}

/** A scheme's open cabals, by build then lead. */
export async function cabalCards(store: Store, projectId: number, deps: BoardDeps): Promise<CabalCard[]> {
  const out: CabalCard[] = [];
  for (const leadId of store.openCabalLeads(projectId)) {
    const board = await readBoard(store, leadId, deps);
    if (!board) continue;
    const ids = new Map(store.cabalRows(leadId).map((r) => [r.id, r.ticket_id]));
    out.push({
      lead: leadId,
      number: board.lead.number,
      title: board.lead.title,
      overseer: overseerOf(board),
      build: store.getTicket(leadId)?.build ?? null,
      done: board.kind === 'build' ? 'merged' : 'shipped',
      members: board.members.map((m) => ({ id: ids.get(m.row) ?? null, number: m.number, label: m.label, title: m.title, state: m.state, word: m.word, scheme: m.scheme })),
      finished: board.counts.merged,
      next: nextUp(board.members),
      asks: board.asks.length,
      spend: board.counts.spend,
    });
  }
  return out.sort((a, b) => (a.build ?? Infinity) - (b.build ?? Infinity) || a.lead - b.lead);
}

export class CabalCards {
  private cache = new Map<number, { list: CabalCard[]; json: string }>();
  private running = new Map<number, Promise<void>>();
  private again = new Set<number>();
  private d: { store: Store; broadcast: (msg: { type: 'cabals'; projectId: number; cabals: CabalCard[] }) => void; parked: BoardDeps['parked'] };

  constructor(d: { store: Store; broadcast: (msg: { type: 'cabals'; projectId: number; cabals: CabalCard[] }) => void; parked: BoardDeps['parked'] }) {
    this.d = d;
  }

  /** The last cards read for a scheme, for its page load. */
  get(projectId: number): CabalCard[] {
    return this.cache.get(projectId)?.list ?? [];
  }

  /** Read a scheme's cabals again: one read at a time, and a call meanwhile (a write it may have missed) reads once more. */
  refresh(projectId: number): Promise<void> {
    const busy = this.running.get(projectId);
    if (busy) {
      this.again.add(projectId);
      return busy;
    }
    const next = (async () => {
      do {
        this.again.delete(projectId);
        const list = await cabalCards(this.d.store, projectId, this.d);
        const json = JSON.stringify(list);
        const was = this.cache.get(projectId)?.json ?? '[]';
        this.cache.set(projectId, { list, json });
        if (json !== was) this.d.broadcast({ type: 'cabals', projectId, cabals: list });
      } while (this.again.has(projectId));
    })().finally(() => this.running.delete(projectId));
    this.running.set(projectId, next);
    return next;
  }

  async poll() {
    for (const p of this.d.store.listProjects()) await this.refresh(p.id).catch(() => {});
  }
}
