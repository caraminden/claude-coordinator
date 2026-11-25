// Running keepalives (#862): which idle minions get one, the weekly readout, what one's result costs, and its end.
// The rules and the sums are in src/keepalive.ts; this runs them.
// Moved out of runner.ts (#1840): it takes what it needs from the Runner as `KeepaliveDeps`.
import type { Project, Store, Ticket } from './db.ts';
import type { ClaudeEvent } from './claude-events.ts';
import { turnOf } from './turn-row.ts';
import { dropTurnDir } from './turn-tmp.ts';
import { GLOBAL_OWNER } from './properties.ts';
import { CACHE_TTL_MS, KEEPALIVE_AFTER_MS, KEEPALIVE_GATES_KEY, KEEPALIVE_OFF_KEY, KEEPALIVE_REPORT_KEY, SERIES_CAP_MS, WEEK_MS, countGate, inWindow, keepaliveKey, missed, reportText, tooManyMisses, weekReport, type KeepaliveSeries } from './keepalive.ts';
import { cardHeld } from './card-wait.ts';
import { pacificDay } from './pacific.ts';
import type { MinionQueue } from './minion-queue.ts';
import type { KillResume, LimitResume, NetResume } from './resumes.ts';
import type { MinionJobs } from './minion-jobs.ts';
import { sameAccount, type OnAccount } from './line-place.ts';
import type { TurnLine } from './turn-line.ts';
import { freshKey, turnKey, savingKey } from './turn-keys.ts';
import { sleepKey, stateWord } from './needs.ts';
import type { QueuedMessage } from './turn-messages.ts';
import type { LiveTurn, TurnState } from './runner.ts';

/** What keepalives need from the Runner. */
export interface KeepaliveDeps {
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
  queue: MinionQueue;
  turnLine: Pick<TurnLine, 'has'>;
  turns: ReadonlyMap<number, unknown>;
  /** Minions whose keepalive is due, → the sweep's clock less the runner's, for its re-check. */
  keepalivePending: Map<number, number>;
  gateCounted: Map<number, { ended: number; day: string; gate: string }>;
  statuses: Map<number, unknown>;
  closing: Map<number, string | null>;
  deployedMidTurn: Set<number>;
  waiting: (ticketId: number) => { msgs: QueuedMessage[]; held: QueuedMessage[] };
  turnPerson: (ticket: Ticket, project: Project, waiting: QueuedMessage[] | { msgs: QueuedMessage[]; held: QueuedMessage[] }) => number | null;
  codexTurn: (t: Ticket, p: Project, person: number | null) => boolean;
  accountOf: (t: Ticket, person: number | null) => OnAccount;
  payerOf: (uid: number | null | undefined) => number | null;
  leaveMail: (to: number, author: string, text: string) => void;
  actOnDeferred: (ticketId: number, closing: boolean, closeReason: string | null, deployed: boolean) => void;
  saveAfterTurn: (ticketId: number, configDir: string, had: Set<string> | null) => Promise<unknown>;
  /** The jobs it runs on the server past its turns (#1890); set by the server after the Runner is built. */
  jobs: () => Pick<MinionJobs, 'running'> | null;
}

export class KeepaliveRun {
  private d: KeepaliveDeps;
  constructor(d: KeepaliveDeps) {
    this.d = d;
  }

  /**
   * Keep waiting minions' prompt caches warm (#862, src/keepalive.ts): a hidden one-line turn 55 minutes after the last
   * one ended, in working hours, while the prefix it would re-read is still the one cached. Also sends the week's
   * readout to the Citadel Taskmaster, and switches keepalives off when they cost more than they saved. Run every minute.
   */
  keepaliveSweep(now = this.d.now()) {
    if (this.d.noTurns() || this.d.store.getSetting(KEEPALIVE_OFF_KEY)) return;
    const reported = this.d.store.getSetting<number>(KEEPALIVE_REPORT_KEY);
    if (!reported) this.d.store.setSetting(KEEPALIVE_REPORT_KEY, now);
    else if (now - reported >= WEEK_MS) {
      this.d.store.setSetting(KEEPALIVE_REPORT_KEY, now);
      // A wait's real turn ends up to a long turn after it starts: the rows reach back a little before the week.
      const r = weekReport(this.d.store.minionTurnsSince(now - WEEK_MS - 9 * 3_600_000), now - WEEK_MS, now);
      const off = r.pings > 0 && r.netUsd < 0;
      if (off) this.d.store.setSetting(KEEPALIVE_OFF_KEY, { reason: 'they cost more than they saved last week', at: now });
      this.tellCitadel(reportText(r, off));
      if (off) return;
    }
    // Runs outside working hours too, only to count the minions the hours turned away (#1274).
    for (const p of this.d.store.listProjects()) {
      for (const t of this.d.store.listTickets(p.id)) {
        // A busy lane (its last save, say) runs it once free, if it still qualifies then.
        if (t.kind === 'coordinator' || t.status !== 'idle' || this.d.keepalivePending.has(t.id)) continue;
        const gate = this.keepaliveGate(t, p, now);
        this.countGate(t.id, gate, now);
        if (gate) continue;
        this.d.keepalivePending.set(t.id, now - this.d.now());
        this.d.next(t.id);
      }
    }
  }

  /** Whether a minion waiting on a person or on its ship has a warm cache that a keepalive would keep (keepaliveSweep). */
  wantsKeepalive(t: Ticket, p: Project, now: number): boolean {
    return !this.keepaliveGate(t, p, now);
  }

  /** Which of wantsKeepalive's gates turns a minion away, or null when a keepalive is due. */
  private keepaliveGate(t: Ticket, p: Project, now: number): string | null {
    if (t.kind === 'coordinator') return 'taskmaster';
    if (!t.session_id || !t.cwd) return 'no session';
    // A live turn, not isRunning: its own lane step re-checks here while it counts as launching (#1808), and a launch
    // under way elsewhere holds the lane, so the sweep's next() waits for it.
    // One waiting in line for a worker is idle too (#1888, Josh, 2026-11-24: "like any idle minion"), whatever its state: it carries on soon.
    const lined = this.d.turnLine.has(t.id);
    if (t.status !== 'idle' || this.d.turns.has(t.id) || (this.d.queued(t.id) && !lined)) return 'busy';
    // A restart's resume still to start (2A2): a keepalive would take its place, or back out and hold its batch as mail.
    if (this.d.queue.owed(t.id)) return 'resume owed';
    if (this.d.limitWait(t.id)) return 'limit wait';
    if (this.d.netWait(t.id)) return 'net wait';
    if (this.d.killWait(t.id)) return 'kill wait';
    if (cardHeld(this.d.store, t.id)) return 'card wait';
    if (this.d.parked(t) && !lined) return 'parked';
    if (this.d.store.getSetting(sleepKey(t.id)) && !lined) return 'asleep';
    if (this.d.store.getSetting(freshKey(t.id))) return 'fresh';
    // Outside (#1274): a day of gate counts found it turned away 120 of 233 due minions, nearly all in the ship line,
    // and about 30 a day of them were woken cold by their ship's result an hour or more later.
    // Waiting on a job the server runs (#1890) is idle too.
    if (!(lined || this.d.jobs()?.running(t.id).length || t.state === null || t.state === 'ready' || t.state === 'try' || t.state === 'outside' || this.d.store.openCardsOf(t.id).length)) return `state ${stateWord(t.state)}`;
    if (!inWindow(now)) return 'hours';
    const person = this.d.turnPerson(t, p, lined ? this.d.waiting(t.id) : []);
    if (this.d.codexTurn(t, p, person)) return 'codex';
    // In line it would run as the waiting turn: on another account that pays to write a cache the turn may not use (#1888).
    const last = lined ? this.d.store.lastTurnOn(t.id) : null;
    if (last && !sameAccount(last, this.d.accountOf(t, person))) return 'other account';
    const s = this.d.store.getSetting<KeepaliveSeries>(keepaliveKey(t.id));
    if (!s) return 'no series';
    if (s.stopped) return `stopped ${s.stopped}`;
    if (now - s.since >= SERIES_CAP_MS) return 'series cap';
    const ended = this.d.store.lastTurnEnd(t.id);
    if (!ended) return 'no turn end';
    return now - ended >= KEEPALIVE_AFTER_MS && now - ended < CACHE_TTL_MS ? null : 'not due';
  }

  /**
   * Count which gate turned a due minion away, or "passed" (#1274): once per idle minion whose last turn ended 55 to
   * 60 minutes ago, per Pacific day in KEEPALIVE_GATES_KEY. A later minute of the same window that finds another gate
   * moves the count there, so a minion busy at minute 55 and pinged at 56 counts as passed. Minions not yet due aren't
   * counted, or "not due" would drown the rest. "passed" is the sweep's ask: the launch can still stop a dirty series.
   */
  private countGate(ticketId: number, gate: string | null, now: number) {
    const ended = this.d.store.lastTurnEnd(ticketId);
    if (!ended || now - ended < KEEPALIVE_AFTER_MS || now - ended >= CACHE_TTL_MS) return;
    const was = this.d.gateCounted.get(ticketId);
    const g = gate ?? 'passed';
    if (was?.ended === ended && was.gate === g) return;
    let counts = this.d.store.getSetting<Record<string, Record<string, number>>>(KEEPALIVE_GATES_KEY);
    if (was?.ended === ended) counts = countGate(counts, was.day, was.gate, -1);
    const day = was?.ended === ended ? was.day : pacificDay(now);
    this.d.gateCounted.set(ticketId, { ended, day, gate: g });
    this.d.store.setSetting(KEEPALIVE_GATES_KEY, countGate(counts, day, g));
  }

  /** Mark a minion's keepalive series stopped, with why. */
  stopSeries(ticketId: number, why: NonNullable<KeepaliveSeries['stopped']>) {
    const s = this.d.store.getSetting<KeepaliveSeries>(keepaliveKey(ticketId));
    if (s && !s.stopped) this.d.store.setSetting(keepaliveKey(ticketId), { ...s, stopped: why });
  }

  /** Held mail to the Citadel scheme's Taskmaster about keepalives. */
  tellCitadel(text: string) {
    const tm = this.d.store.getOverlord(GLOBAL_OWNER);
    if (tm) this.d.leaveMail(tm.id, 'Citadel (keepalives)', text);
  }

  /** A keepalive's result: costed apart, and its miss stops its series; too many misses in a day switch keepalives off. */
  async keepaliveResult(ticketId: number, ev: ClaudeEvent) {
    await this.d.store.recordTurn(ticketId, {
      ...turnOf(ev),
      ended_at: Date.now(),
      payer: this.d.payerOf(this.d.store.getSetting<TurnState>(turnKey(ticketId))?.person),
      keepalive: true,
      account: this.d.store.getSetting<TurnState>(turnKey(ticketId))?.account ?? null,
    });
    if (!missed(ev.usage)) return;
    this.stopSeries(ticketId, 'missed');
    console.log(`[keepalive] minion ${ticketId}: its keepalive wrote ${ev.usage?.cache_creation_input_tokens} tokens to the cache, so its series stops`);
    const day = this.d.store.minionTurnsSince(Date.now() - 24 * 3_600_000).filter((r) => r.keepalive);
    const misses = day.filter((r) => missed({ cache_creation_input_tokens: r.cache_write_tokens })).length;
    if (!tooManyMisses(day.length, misses) || this.d.store.getSetting(KEEPALIVE_OFF_KEY)) return;
    this.d.store.setSetting(KEEPALIVE_OFF_KEY, { reason: `${misses} of ${day.length} keepalives missed the cache in a day`, at: Date.now() });
    this.tellCitadel(`Keepalives are off: ${misses} of the last day's ${day.length} keepalives missed the cache (more than 1 in 5), so something in minions' prompts keeps changing between turns. Find it, then delete the \`${KEEPALIVE_OFF_KEY}\` setting to switch them back on.`);
  }

  /** A keepalive's end (#862): nothing in the chat or the minion's row; a failure stops its series. Its session is saved as any turn's. */
  wrapUpKeepalive(ticketId: number, live: LiveTurn, turn: TurnState | null, exit: { code: number | null; signal: string | null; error?: string } | null) {
    this.d.statuses.delete(ticketId);
    // A dismissal (ciGreen, a land) or a live deploy that came while it ran waited for it, as for any turn (2A3): handed on below.
    const closing = this.d.closing.has(ticketId);
    const closeReason = this.d.closing.get(ticketId) ?? null;
    this.d.closing.delete(ticketId);
    const deployed = this.d.deployedMidTurn.delete(ticketId);
    if (turn?.stopped || !exit || exit.signal || exit.code !== 0 || !turn?.result || turn.result.error) {
      console.log(`[keepalive] minion ${ticketId}: its keepalive failed (${exit?.error ?? turn?.result?.text ?? `exit ${exit?.code ?? exit?.signal ?? 'unknown'}`}), so its series stops`);
      this.stopSeries(ticketId, 'failed');
    }
    void dropTurnDir(live.dir); // renamed aside at once, deleted off the thread (#1459)
    if (!this.d.store.getTicket(ticketId)) {
      this.d.store.deleteSetting(savingKey(ticketId));
      return live.end();
    }
    // Even after a failed keepalive: unlike a real turn's, its failure is hidden upkeep and says nothing about the dismissal.
    this.d.actOnDeferred(ticketId, closing, closeReason, deployed);
    // A message that came in meanwhile waits behind it in the queue, as behind any turn.
    this.d.saveAfterTurn(ticketId, live.configDir, live.had).then(live.end);
  }
}
