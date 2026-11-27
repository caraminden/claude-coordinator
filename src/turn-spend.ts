// What a running turn has spent and the minion's budget: the spend meter and its alert card, the budget marks (an ask
// steered into the turn, a word to the Taskmaster, a card), Keep going, and what the minion page shows of the budget.
// Moved out of runner.ts (#2045): it takes what it needs from the Runner as `TurnSpendDeps`.
import type { EventRow, Store, Ticket } from './db.ts';
import { cardHref } from './card-links.ts';
import type { ClaudeEvent } from './claude-events.ts';
import { steerLater } from './turn-files.ts';
import { promptMessage } from './prompts.ts';
import { ASK, askText, type Budget, budgetCard, budgetFor, budgetKey, type BudgetState, CARD, chatNote, costReason, markOf, passed, REASON, WAKE, wakeLevel, wakeText } from './minion-budget.ts';
import { openSpend, SpendMeter, spendText, STAGES_SETTING, stagesFrom } from './spend-alert.ts';
import { turnKey } from './turn-keys.ts';
import type { LiveTurn, TurnState } from './runner.ts';

/** What spend and budgets need from the Runner. The on* hooks are the Runner's own, which server.ts sets after it is made. */
export interface TurnSpendDeps {
  store: Store;
  turns: Map<number, LiveTurn>;
  now: () => number;
  emit: (ticketId: number, kind: string, data: unknown, reserved?: number) => EventRow;
  saveTurn: (ticketId: number, patch: Partial<TurnState>) => void;
  broadcastTicket: (ticketId: number) => void;
  onSpendAlert: (ticketId: number, text: string, eventId: number, person: number | null) => void;
  onBudgetWake: (ticketId: number, text: string) => void;
  onBudgetCard: (ticketId: number, question: ReturnType<typeof budgetCard>) => void;
}

export class TurnSpend {
  /** Each running turn's spend meter, by the turn's start (a new turn starts a new one). */
  readonly spends = new Map<number, { startedAt: number; meter: SpendMeter; prior: number; budget: Budget | null }>();
  private d: TurnSpendDeps;
  constructor(d: TurnSpendDeps) {
    this.d = d;
  }

  /**
   * Count an assistant message (main thread or Grunt) toward the turn's estimated cost, and post the alert card (and push)
   * when it passes a stage. Saved in the TurnState, so a restart carries on where it was; Codex turns aren't metered.
   */
  meterSpend(ticketId: number, ev: ClaudeEvent) {
    const turn = this.d.store.getSetting<TurnState>(turnKey(ticketId));
    if (!turn?.startedAt || turn.codex) return;
    let spend = this.spends.get(ticketId);
    if (spend?.startedAt !== turn.startedAt) {
      const ticket = this.d.store.getTicket(ticketId);
      // Earlier turns' cost and the budget once a turn: this runs on every assistant message.
      const budget = ticket?.kind === 'ticket' ? budgetFor(this.d.store, ticket) : null;
      this.spends.set(ticketId, (spend = { startedAt: turn.startedAt, meter: new SpendMeter(turn.spend), prior: budget ? this.d.store.ticketCost(ticketId) : 0, budget }));
    }
    const { meter } = spend;
    if (!meter.add(ev)) return;
    const stage = meter.crossed(stagesFrom(this.d.store.getSetting(STAGES_SETTING)));
    this.d.saveTurn(ticketId, { spend: meter.state });
    this.checkBudget(ticketId, spend.budget, spend.prior + meter.usd, true);
    if (stage === null) return;
    const text = spendText(meter.usd, Date.now() - turn.startedAt);
    console.log(`[spend] minion ${ticketId}: passed $${stage}, about $${meter.usd.toFixed(2)}`);
    const row = this.d.emit(ticketId, 'spend', { text, usd: Math.round(meter.usd), stage, turn: turn.startedAt });
    meter.alert = { stage, event: row.id, at: row.created_at };
    this.d.saveTurn(ticketId, { spend: meter.state });
    this.d.broadcastTicket(ticketId); // the list row's badge and Needs you
    this.d.onSpendAlert(ticketId, text, row.id, turn.person ?? null);
  }

  /**
   * Tell the minion and its Taskmaster when its spend passes a budget mark (#1114), each mark once per minion. The ask goes
   * into the running turn (`steer`) when it can take one; otherwise the next turn's budget line carries it. Never stops anything.
   */
  checkBudget(ticketId: number, budget: Budget | null, spent: number, steer: boolean) {
    if (!budget) return;
    const state = this.d.store.getSetting<BudgetState>(budgetKey(ticketId)) ?? {};
    const marks = passed(budget, spent, state);
    if (!marks.length) return;
    const now = this.d.now();
    const level = wakeLevel(budget, spent);
    this.d.store.setSetting(budgetKey(ticketId), {
      ...state,
      ...(marks.includes('ask') ? { asked: now } : {}),
      ...(marks.includes('wake') ? { woke: state.woke ?? now, wakes: level } : {}),
      ...(marks.includes('card') ? { carded: now } : {}),
    });
    console.log(`[budget] minion ${ticketId}: passed ${marks.join(' and ')} at about $${spent.toFixed(2)} (usual $${budget.usd.toFixed(2)})`);
    if (marks.includes('ask')) {
      const row = this.d.emit(ticketId, 'note', { text: chatNote(budget, spent) });
      if (steer) this.steerSystem(ticketId, askText(budget, spent), row.id);
    }
    // tellTaskmaster posts its own "Sent the Taskmaster" line in the chat.
    if (marks.includes('wake')) this.d.onBudgetWake(ticketId, wakeText(budget, spent, level, !!state.woke));
    if (marks.includes('card')) this.d.onBudgetCard(ticketId, budgetCard(budget, spent, this.costReason(ticketId)));
  }

  /** The minion's own "Costing more:" line since the ask (#1672), from its main thread's replies; null when it never said. */
  private costReason(ticketId: number): string | null {
    const ask = this.d.store.eventsOfKinds(ticketId, ['note']).findLast((e) => JSON.parse(e.data).text?.startsWith('Budget:'));
    const texts = this.d.store
      .eventsOfKinds(ticketId, ['claude'], ask?.id ?? 0)
      .filter((e) => e.data.includes(REASON))
      .flatMap((e) => {
        const d: ClaudeEvent = JSON.parse(e.data);
        return d.type === 'assistant' && !d.parent_tool_use_id && Array.isArray(d.message?.content) ? d.message.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text!) : [];
      });
    return costReason(texts);
  }

  /**
   * Pass a line from Citadel into the running turn, as a steer is, when it can take one. Not kept in `steered`: one the
   * turn never reads is dropped rather than queued to start a turn of its own.
   */
  private steerSystem(ticketId: number, text: string, id: number): boolean {
    const live = this.d.turns.get(ticketId);
    const turn = live && this.d.store.getSetting<TurnState>(turnKey(ticketId));
    if (!live || !turn || turn.result || turn.fresh || turn.keepalive || turn.stopped || turn.light) return false;
    if (live.ending) return false;
    steerLater(live, () => promptMessage([{ author: 'System', text, images: [], id }]));
    return true;
  }

  /** What the minion page shows of its budget (#1114), or null with too little history. */
  budgetView(ticket: Ticket, props?: Record<string, unknown>) {
    const b = budgetFor(this.d.store, ticket, Date.now(), props);
    return b && { usd: b.usd, basis: b.basis, n: b.n, ask: markOf(b, ASK), wake: markOf(b, WAKE), card: markOf(b, CARD), ...(b.estimate ? { estimate: b.estimate } : {}) };
  }

  /** The running turn's unanswered spend alert (openSpend), or null; reads the saved turn only while one runs. */
  spendAlert(ticket: Ticket) {
    const spend = this.d.turns.has(ticket.id) ? openSpend(this.d.store.getSetting<TurnState>(turnKey(ticket.id))?.spend) : null;
    return spend && { ...spend, href: cardHref(ticket, spend.event) };
  }

  /** Keep going (#723): no more spend alerts for the running turn. False when no turn is running. */
  muteSpend(ticketId: number, by: string, startedAt: number): boolean {
    const turn = this.d.store.getSetting<TurnState>(turnKey(ticketId));
    // An earlier turn's card can't mute this one: it's refused unless it names the running turn's start.
    if (!this.d.turns.has(ticketId) || !turn?.startedAt || turn.startedAt !== startedAt) return false;
    if (turn.spend?.muted) return true;
    const spend = this.spends.get(ticketId);
    if (spend?.startedAt === turn.startedAt) spend.meter.muted = by;
    this.d.saveTurn(ticketId, { spend: { ...(turn.spend ?? { usd: 0, fired: 0 }), muted: by } });
    this.d.emit(ticketId, 'spend_muted', { turn: turn.startedAt, by });
    this.d.broadcastTicket(ticketId);
    return true;
  }
}
