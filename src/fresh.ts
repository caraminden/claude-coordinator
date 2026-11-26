// Fresh starts (#406, #423): asking for one, the handoff it waits for, what ends it, the idle sweep.
// Moved out of runner.ts (#1840): it takes what it needs from the Runner as `FreshDeps`.
import type { EventRow, Store, Ticket } from './db.ts';
import type { Lanes } from './lanes.ts';
import { handoffSheet, SHEET_CHECK, SHEET_FAILED } from './live-facts.ts';
import { COMPACT_COMMAND, handoffPrompt, minionHandoffPrompt } from './prompts.ts';
import type { KillResume, LimitResume, NetResume } from './resumes.ts';
import { contextKey, freshKey, handoffKey } from './turn-keys.ts';
import type { QueuedMessage } from './turn-messages.ts';
import type { Runner, TurnState } from './runner.ts';

/**
 * A Taskmaster's fresh start (#406): asked for (why), its handoff once the old session wrote it with
 * fresh_session, and `compact` once the handoff failed and a /compact turn falls back on. `auto`: Citadel
 * asked for it by itself (turn end or idle), so a message queued meanwhile goes first.
 */
export interface FreshState {
  why: string;
  summary?: string;
  compact?: true;
  auto?: true;
}
/** A fresh start's idle time for the chat's divider (#1059): "55 m", "1 h 12 m". */
export const idleText = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ''}`;
};
/** What a fresh start's notes call the chat's agent. */
export const roleWord = (t: Ticket) => (t.kind === 'coordinator' ? 'Taskmaster' : 'minion');
/** Idle this long, a Taskmaster's prompt cache (1 hour) is still warm, so its handoff turn reads it cheaply. */
export const FRESH_IDLE_MS = 55 * 60_000;
/** Past this much context (tokens), a Taskmaster whose turn just ended starts fresh by itself (#423), so a long working session isn't cut mid-flow. */
export const FRESH_CONTEXT_TOKENS = 150_000;
/** Past this much context (tokens), an idle Taskmaster starts fresh (#406): its next cold wake would re-read all of it at full price. Cara 2026-11-15: 60k, not 150k. */
export const FRESH_IDLE_CONTEXT_TOKENS = 60_000;
const HANDOFF_MAX = 20_000;

/** What a fresh start needs from the Runner. */
export interface FreshDeps {
  store: Store;
  now: () => number;
  noTurns: () => boolean;
  /** Messages queued for a minion's next turn. */
  queued: (ticketId: number) => number;
  limitWait: (ticketId: number) => LimitResume | null;
  netWait: (ticketId: number) => NetResume | null;
  killWait: (ticketId: number) => KillResume | null;
  parked: (t: Ticket) => boolean;
  next: (ticketId: number) => void;
  lanes: Lanes;
  closing: ReadonlyMap<number, string | null>;
  emit: (ticketId: number, kind: string, data: unknown) => EventRow;
  isRunning: (ticketId: number) => boolean;
  broadcastTicket: (ticketId: number) => void;
  send: (ticketId: number, author: string, text: string, images?: [], extra?: { fresh?: true }) => unknown;
  tellCitadel: (text: string) => void;
  view: Runner['view'];
}

export class Fresh {
  private d: FreshDeps;
  constructor(d: FreshDeps) {
    this.d = d;
  }

  /**
   * Start a Taskmaster, or a minion (its composer's /fresh, #937), on a fresh Claude session (#406): a handoff
   * turn on the old session first (once any running turn ends), then the next turn starts a new session from
   * that handoff. A Taskmaster hands off with fresh_session; a minion's handoff is that turn's reply. Returns
   * why it can't, or null.
   */
  requestFresh(ticketId: number, why: string, auto = false): string | null {
    const ticket = this.d.store.getTicket(ticketId);
    if (!ticket) return 'No such minion';
    if (ticket.status === 'closed') return 'A dismissed minion keeps its session: send it a message first';
    if (!ticket.session_id) return 'Its session is already fresh';
    if (this.d.store.getSetting<FreshState>(freshKey(ticketId))) return 'A fresh start is already under way';
    this.d.store.setSetting(freshKey(ticketId), { why, ...(auto ? { auto: true as const } : {}) });
    this.d.emit(ticketId, 'note', { text: `Starting a fresh session (${why}): the ${roleWord(ticket)} writes its handoff first${this.d.isRunning(ticketId) ? ', once this turn ends' : ''}.` });
    if (!this.d.isRunning(ticketId)) this.d.next(ticketId);
    this.d.broadcastTicket(ticketId);
    return null;
  }

  /**
   * The handoff a Taskmaster's running turn wrote (fresh_session): its session resets as the turn ends.
   */
  recordHandoff(ticketId: number, summary: string): string | null {
    if (this.d.store.getTicket(ticketId)?.kind !== 'coordinator') return 'Only a Taskmaster starts its own fresh session: a person can type /fresh in your chat';
    if (!this.d.isRunning(ticketId)) return 'Only a running turn can hand off';
    const was = this.d.store.getSetting<FreshState>(freshKey(ticketId));
    this.d.store.setSetting(freshKey(ticketId), { why: was?.why ?? 'the Taskmaster asked for it', summary: summary.slice(0, HANDOFF_MAX) });
    return null;
  }

  /** A fresh start's next step, if it needs a turn of its own: the handoff ask, or the /compact fallback. */
  freshStep(ticketId: number): QueuedMessage | null {
    const f = this.d.store.getSetting<FreshState>(freshKey(ticketId));
    // After a network outage, its resume (holding any queued messages) goes first: a step now would fail too and replace that wait.
    if (!f || f.summary || this.d.netWait(ticketId) || this.d.killWait(ticketId)) return null;
    // A message queued for a fresh start Citadel asked for by itself goes first, before its handoff or
    // its /compact fallback; the step follows that turn (#423).
    if (f.auto && this.d.queued(ticketId)) return null;
    const minion = this.d.store.getTicket(ticketId)?.kind !== 'coordinator';
    return f.compact ? { author: 'System', text: COMPACT_COMMAND, images: [], fresh: 'compact' } : { author: 'System', text: (minion ? minionHandoffPrompt : handoffPrompt)(f.why), images: [], fresh: 'handoff' };
  }

  /**
   * A fresh-start step's turn ended (wrapUp). A handoff resets the session; a Taskmaster's handoff turn without one
   * resets it from a server-built facts sheet (G6), a minion's falls back on compaction, unless it was stopped; a compaction ends the fresh start either way.
   */
  endFresh(ticketId: number, turn: TurnState | null, ok: boolean, stopped: boolean) {
    let f = this.d.store.getSetting<FreshState>(freshKey(ticketId));
    if (!f) return;
    const ticket = this.d.store.getTicket(ticketId);
    const who = ticket ? roleWord(ticket) : 'Taskmaster';
    // A minion's /fresh has no fresh_session: its handoff turn's reply is its handoff (#937), the status line left out.
    const reply = ticket?.kind !== 'coordinator' && turn?.fresh === 'handoff' && ok && !stopped && !turn.result?.error ? (turn.result?.text ?? '').replace(/<!--\s*status:[\s\S]*?-->/g, '').trim() : '';
    if (!f.summary && reply) f = { ...f, summary: reply.slice(0, HANDOFF_MAX) };
    // A Taskmaster's failed handoff starts the fresh session from a facts sheet the server builds from the database (G6), not a compaction.
    const sheeted = ticket?.kind === 'coordinator' && !f.summary && turn?.fresh === 'handoff' && !stopped;
    if (f.summary || sheeted) {
      const sheet = ticket?.kind === 'coordinator' ? handoffSheet(this.d.store, this.d, ticket) : '';
      const text = sheeted ? `${SHEET_FAILED}\n\n${sheet}` : sheet ? `${f.summary}\n\n${SHEET_CHECK}\n\n${sheet}` : f.summary!;
      this.d.store.deleteSetting(freshKey(ticketId));
      this.d.store.setSetting(handoffKey(ticketId), text);
      this.d.store.deleteSetting(contextKey(ticketId));
      this.d.store.updateTicket(ticketId, { session_id: null });
      if (sheeted) this.d.emit(ticketId, 'note', { text: `No handoff came back${ok ? '' : ' (the turn failed)'}, so the new session starts from a facts sheet the server built from the database.` });
      this.d.emit(ticketId, 'fresh', { summary: sheeted ? text : f.summary, why: f.why });
    } else if (turn?.fresh === 'handoff' && stopped) {
      this.d.store.deleteSetting(freshKey(ticketId));
      this.d.emit(ticketId, 'note', { text: `The handoff turn was stopped, so the fresh start is off: the ${who} keeps its session.` });
    } else if (turn?.fresh === 'handoff') {
      this.d.store.setSetting(freshKey(ticketId), { ...f, compact: true });
      this.d.emit(ticketId, 'note', { text: `No handoff came back${ok ? '' : ' (the turn failed)'}, so the ${who} compacts its session instead.` });
    } else if (turn?.fresh === 'compact') {
      this.d.store.deleteSetting(freshKey(ticketId));
      // Its size is unknown until its next turn, which keeps the idle check from asking again meanwhile.
      this.d.store.deleteSetting(contextKey(ticketId));
      this.d.emit(ticketId, 'note', { text: ok ? `Compacted the ${who}'s session instead of a fresh start.` : `Compacting failed too, so the ${who} keeps its session as it was.` });
    }
  }

  /**
   * Taskmasters idle FRESH_IDLE_MS with more than FRESH_IDLE_CONTEXT_TOKENS of context start fresh (#406),
   * while their prompt cache is still warm. One that missed that window (a restart) still does: its
   * next wake would re-read the whole context anyway. Run every minute.
   */
  freshSweep(now = Date.now()) {
    if (this.d.noTurns()) return;
    for (const p of this.d.store.listProjects()) {
      for (const t of this.d.store.listTickets(p.id)) {
        if (t.kind !== 'coordinator' || !t.session_id || t.status !== 'idle' || this.d.isRunning(t.id) || this.d.queued(t.id) || this.d.lanes.busy(t.id) || this.d.limitWait(t.id) || this.d.netWait(t.id) || this.d.killWait(t.id)) continue;
        const size = this.d.store.getSetting<number>(contextKey(t.id));
        const ended = this.d.store.lastTurnEnd(t.id);
        if (!size || size <= FRESH_IDLE_CONTEXT_TOKENS || !ended || now - ended < FRESH_IDLE_MS) continue;
        this.requestFresh(t.id, `idle ${idleText(now - ended)} with ${Math.round(size / 1000)}k context`, true);
      }
    }
  }

  /**
   * A Taskmaster whose turn ended past FRESH_CONTEXT_TOKENS starts fresh at once (#423), not only once idle.
   * Not while messages wait (the last of their turns hands off) or on a usage-limit or network wait, and
   * never after a fresh-start step's own turn: one that leaves it big waits for the next real turn.
   */
  freshAtTurnEnd(ticketId: number, turn: TurnState) {
    if (turn.fresh || this.d.queued(ticketId) || this.d.limitWait(ticketId) || this.d.netWait(ticketId) || this.d.killWait(ticketId)) return;
    const t = this.d.store.getTicket(ticketId);
    const size = this.d.store.getSetting<number>(contextKey(ticketId));
    if (t?.kind !== 'coordinator' || !t.session_id || !size || size <= FRESH_CONTEXT_TOKENS) return;
    this.requestFresh(ticketId, `${Math.round(size / 1000)}k tokens of context at the end of a turn`, true);
  }
}
