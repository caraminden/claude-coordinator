// A minion's task list as its readout shows it: built once from the saved plan and the events since, the steps it
// finished (step_times) and the readout's ratio of what steps took to their guesses.
// Moved out of runner.ts (#2045): it takes what it needs from the Runner as `TurnProgressDeps`.
import { planKey, type FinishedStep, type Store, type Ticket } from './db.ts';
import { applyEvent, createProgress, progressLine, stepInfo } from '../public/progress.js';
import { packPlan, unpackPlan } from './history.ts';
import { turnKey } from './turn-keys.ts';
import type { TurnState } from './runner.ts';

/** What the task lists need from the Runner. */
export interface TurnProgressDeps {
  store: Store;
}

export class TurnProgress {
  /** Each minion's task list, built the first time it is needed (progressFor); the Runner forgets one with its minion. */
  readonly progress = new Map<number, ReturnType<typeof createProgress>>();
  private stepRatios = new Map<number, { at: number; ratio: number }>();
  private d: TurnProgressDeps;
  constructor(d: TurnProgressDeps) {
    this.d = d;
  }

  /**
   * A minion's progress as a contraption may see it (#421): the readout's line ("Showing the rune cost… · 1 of 6 done") and step,
   * built from its task list and tool calls. Never last_activity, which can be the first line of its reply.
   */
  progressOf(ticket: Ticket) {
    const p = this.progressFor(ticket.id);
    const { total, done, current, step } = stepInfo(p, ticket.status === 'running');
    return {
      line: progressLine(p, ticket.status === 'running') || null,
      step: total ? { n: step, of: total, done, label: current ? current.activeForm || current.subject : null } : null,
    };
  }

  /**
   * Task-list state for a ticket, built the first time it is needed: from the state saved when its last
   * turn ended plus the events since, or from all its events when nothing usable is saved (#530: a
   * Taskmaster's 6,000 events took 0.6 s to read cold, on the first scheme open after every restart).
   */
  progressFor(ticketId: number) {
    let p = this.progress.get(ticketId);
    if (!p) {
      const saved = unpackPlan(this.d.store.getSetting(planKey(ticketId)));
      const usable = saved != null;
      p = saved?.p ?? createProgress();
      const rows = this.d.store.planEvents(ticketId, undefined, saved?.upTo ?? 0);
      for (const row of rows) applyEvent(p, row.kind, JSON.parse(row.data), row.created_at);
      // Steps finishing from here on are recorded (#571); those before were, live or by backfillStepTimes.
      p.finished = [];
      this.progress.set(ticketId, p);
      // The full replay is paid once: an idle minion would otherwise pay it after every restart.
      if (!usable) {
        this.savePlan(ticketId, p, rows.at(-1)?.id ?? 0);
        // Rebuilt by new task-list rules, so the row's stored line, kept until its next event, says what they say (#2201).
        const t = this.d.store.getTicket(ticketId);
        const line = t && p.tasks.length ? progressLine(p, t.status === 'running') : '';
        if (t && line && line !== t.last_activity) this.d.store.setLastActivity(ticketId, line);
      }
    }
    return p;
  }

  /** Save a ticket's task-list state, which holds every event up to `upTo`. */
  savePlan(ticketId: number, p: ReturnType<typeof createProgress>, upTo: number) {
    this.d.store.setSetting(planKey(ticketId), packPlan(p, upTo));
  }

  /** Write the steps a ticket's plan finished since the last call to step_times (#571). */
  recordSteps(ticketId: number, p: ReturnType<typeof createProgress>) {
    if (!p.finished?.length) return;
    const t = this.d.store.getTicket(ticketId);
    try {
      // The effort it ran at: a low-effort turn's steps (#951) are low, whatever the minion's own.
      const light = this.d.store.getSetting<TurnState>(turnKey(ticketId))?.light;
      this.d.store.addStepTimes(ticketId, p.finished, light ? 'low' : (t?.last_effort ?? t?.effort ?? null));
      p.finished.length = 0;
    } catch (err) {
      // Kept for the next event's try: the backfill has run, so nothing else would record them.
      console.error(`Ticket ${ticketId}: could not record its finished steps, will retry:`, err);
    }
  }

  /**
   * The readout's ratio of what steps took to their guesses (#571), per scheme, read at most once a minute:
   * every minion's view carries it.
   */
  stepRatio(projectId: number): number {
    const hit = this.stepRatios.get(projectId);
    if (hit && Date.now() - hit.at < 60_000) return hit.ratio;
    const ratio = this.d.store.stepRatio(projectId);
    this.stepRatios.set(projectId, { at: Date.now(), ratio });
    return ratio;
  }

  /**
   * Fill step_times once from every minion's stored events (#571), so the ratio has data from its first day.
   * One minion per tick, off the boot's hot path; a restart part way starts over, and rows already there stay.
   */
  async backfillStepTimes() {
    if (this.d.store.getSetting('step_times_backfilled')) return;
    for (const project of this.d.store.listProjects()) {
      for (const t of this.d.store.listTickets(project.id)) {
        const p = { ...createProgress(), finished: [] as FinishedStep[] };
        // shortcut: effort is the minion's now, not when each step ran; nothing reads it yet, and live rows are right.
        for (const row of this.d.store.planEvents(t.id)) applyEvent(p, row.kind, JSON.parse(row.data), row.created_at);
        this.d.store.addStepTimes(t.id, p.finished, t.last_effort ?? t.effort ?? null);
        await new Promise((r) => setImmediate(r));
      }
    }
    this.d.store.setSetting('step_times_backfilled', true);
  }
}
