// The auto-resume waits a minion can sit in after a turn ends: the usage limit, a network outage, a kill from outside
// and the one retry of a turn that failed otherwise (#2258).
// Each is a list in the settings table, so the wait outlives a restart. Moved out of runner.ts, which keeps the public
// wrappers (netWait, killWait, limitWait, cancelLimitWait) and the tunables tests set on it; this takes what it needs
// through ResumeHost, not the whole Runner.
import type { Retries, RetryKind } from './turn-outcome.ts';
import { thrown } from './thrown.ts';

/** The settings table, as far as a wait list needs it. */
export interface WaitStore {
  getSetting<T>(key: string): T | undefined | null;
  setSetting(key: string, value: unknown): void;
  deleteSetting(key: string): void;
}

/** One persisted list of waits, one entry per minion. The setting is deleted when the list empties. */
export class WaitList<T extends { ticket: number }> {
  private store: WaitStore;
  private key: string;
  constructor(store: WaitStore, key: string) {
    this.store = store;
    this.key = key;
  }

  all(): T[] {
    return this.store.getSetting<T[]>(this.key) ?? [];
  }

  get(ticket: number): T | null {
    return this.all().find((w) => w.ticket === ticket) ?? null;
  }

  /** Save the whole list (the setting goes when it is empty). */
  set(list: T[]) {
    if (list.length) this.store.setSetting(this.key, list);
    else this.store.deleteSetting(this.key);
  }

  /** Add the entry, replacing the minion's old one. */
  put(entry: T) {
    this.set([...this.all().filter((w) => w.ticket !== entry.ticket), entry]);
  }

  /** Remove the minion's entry; returns it, or null if it had none. */
  take(ticket: number): T | null {
    const list = this.all();
    const w = list.find((x) => x.ticket === ticket);
    if (!w) return null;
    this.set(list.filter((x) => x !== w));
    return w;
  }
}

/** One linked Claude account's limit: `here` is the one this minion's turn hit, `kind` what Claude called it ('weekly', '5-hour'). */
export interface LimitedAccount {
  n: number;
  label: string;
  until: number;
  here?: boolean;
  kind?: string;
}

/** Minions waiting for the usage limit to reset, in the settings table so the wait outlives a restart. */
export interface LimitResume {
  ticket: number;
  /** When it resumes (ms): a while after the reset, spaced from the others. */
  at: number;
  /** Limit resumes in a row this one will be. */
  tries: number;
  /** Several accounts all limited (#819): each one's reset, so the banner says which limit is which. */
  accounts?: LimitedAccount[];
  /** Its person switched to Codex: it resumes on Codex now (#337). */
  codex?: true;
  /** A turn on its plan got through, so the limit is gone: it resumes limitProvenGapMs after the last, not limitGapMs. */
  proven?: true;
}

/** Threads waiting for the network to come back. */
export interface NetResume {
  ticket: number;
  /** Network resumes in a row this one will be. */
  tries: number;
}

/** Killed turns waiting for their resume. */
export interface KillResume {
  ticket: number;
  /** Kill resumes in a row this one will be. */
  tries: number;
  /** The killed turn's restart resumes in a row, carried so the two caps together still end a loop. */
  resumes: number;
}

/** The usage-limit wait to resume next, and when: each wait is due at its own time or, if later, its gap after the last resume. */
export function nextLimitResume(list: LimitResume[], lastResume: number, gap: number, provenGap: number): { wait: LimitResume; due: number } | null {
  let best: { wait: LimitResume; due: number } | null = null;
  for (const wait of list) {
    const due = Math.max(wait.at, lastResume + (wait.proven ? provenGap : gap));
    if (!best || due < best.due || (due === best.due && wait.at < best.wait.at)) best = { wait, due };
  }
  return best;
}

/** A minion whose last turn failed for no reason of the other waits, waiting for its one retry (#2258). */
export interface FailResume {
  ticket: number;
  /** When it retries (ms). */
  at: number;
  /** The counts its retry's turn starts with. */
  retries: Retries;
  /** The failure's words, for the retry's prompt. */
  error: string;
}

/** A turn that failed for any other reason is retried once (#2258); a second failure in a row tells its owner's Taskmaster. */
/** The retry's prompt: the failure's words, cut to a few lines. */
export const retryFailPrompt = (error: string) =>
  `Your last turn failed with this error, and Citadel retried it by itself once:\n\n${error.length > 600 ? error.slice(0, 599) + '…' : error}\n\nA command may have half-run when it failed (a ship, a push, a deploy, a test run), so check the state of your work (git first, then files and background jobs) before you continue where you left off. Don't redo finished steps.`;

/** What the owner's Taskmaster is told when the retry is spent: what happened, and the error. */
export const retryFailedText = (what: string, error: string) => `This minion's turn failed and ${what}, so it is left in error with nothing to carry it on. Look at its chat and get it going again, or tell its person. The error:\n${error.length > 1500 ? error.slice(0, 1499) + '…' : error}`;

/** The settings key of the usage-limit waits. */
export const LIMIT_RESUMES = 'limit-resumes';
/** How long the kill line waits for the last resume it started to take its wait before the next goes anyway. */
export const KILL_START_MAX_MS = 2 * 60_000;
/** The longest the line of kill resumes holds for a starved box before one starts anyway (then the clock starts again). */
export const KILL_HOLD_MAX_MS = 5 * 60_000;

/** What the waits need of the Runner. The tunables are read live: tests set them on the Runner after it is built. */
export interface ResumeHost {
  store: WaitStore;
  readonly resumeGapMs: number;
  readonly limitDelayMs: number;
  readonly limitGapMs: number;
  readonly limitProvenGapMs: number;
  readonly netProbe: () => Promise<boolean>;
  readonly netProbeMs: number;
  readonly netProbeMaxMs: number;
  readonly killStarved: () => Promise<{ starved: boolean; why: string }>;
  readonly killHoldMaxMs: number;
  /** How long after a failed turn its retry starts. */
  readonly failRetryMs: number;
  /** Set once detachAll hands the turns to the next server: this one starts no more kill resumes. */
  readonly detached: boolean;
  /** Limit waits whose resume is under way here, each with a token for that one resume (Runner.limitStarting). */
  readonly limitStarting: Map<number, object>;
  /** Kill waits whose resume this server has started (Runner.killStarted). */
  readonly killStarted: Map<number, number>;
  isRunning(ticketId: number): boolean;
  /** Start an auto-resume turn. */
  resume(ticketId: number, via: RetryKind, retries: Retries, onCodex?: boolean): Promise<void> | undefined;
  /** A kill resume's start threw and left its wait (already removed): tell the chat and run what was queued behind it. */
  killResumeFailed(ticketId: number): void;
  /** A failed turn's retry didn't start (and its wait is gone): it stops with an error, and its Taskmaster hears. */
  failRetryLost(ticketId: number, error: string): void;
  /** It waits for a worker (src/turn-line.ts): its start is neither over nor failed. */
  lined(ticketId: number): boolean;
}

export class Resumes {
  readonly net: WaitList<NetResume>;
  readonly kill: WaitList<KillResume>;
  readonly limit: WaitList<LimitResume>;
  readonly fail: WaitList<FailResume>;
  netTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  limitTimer?: NodeJS.Timeout;
  failTimer?: NodeJS.Timeout;
  /** Fail waits whose retry this server has started: each fires once here, and again only after a restart. */
  private failStarted = new Set<number>();
  /** The wait before the next probe; null for netProbeMs, a fresh outage's first. */
  netDelay: number | null = null;
  private lastLimitResume = 0;
  /** When the line of kill resumes began holding for a starved box, or since the last one it let through; null while it moves. */
  private killHeldSince: number | null = null;

  private host: ResumeHost;

  constructor(host: ResumeHost) {
    this.host = host;
    this.net = new WaitList(host.store, 'net-resumes');
    this.kill = new WaitList(host.store, 'kill-resumes');
    this.limit = new WaitList(host.store, LIMIT_RESUMES);
    this.fail = new WaitList(host.store, 'fail-resumes');
  }

  /** Stop the timers, for a server shutting down: the next server probes and resumes from what is saved. */
  stop() {
    clearTimeout(this.netTimer);
    clearTimeout(this.killTimer);
    clearTimeout(this.failTimer);
  }

  netWait(ticketId: number): NetResume | null {
    return this.net.get(ticketId);
  }

  /** Wait for the network, the messages queued behind the turn that died held in its queue; one probe loop serves every waiting thread. */
  waitForNetwork(ticketId: number, tries: number) {
    this.net.put({ ticket: ticketId, tries });
    this.armNetProbe();
  }

  /** End the thread's network wait (a resume, a person's message, a stop, a dismissal); returns the wait it had. */
  cancelNetWait(ticketId: number): NetResume | null {
    return this.net.take(ticketId);
  }

  /** Probe after netDelay, unless a probe is already due or under way, or nobody waits. */
  armNetProbe() {
    if (this.netTimer || !this.net.all().length) return;
    this.netTimer = setTimeout(() => this.probeNet(), this.netDelay ?? this.host.netProbeMs);
    this.netTimer.unref();
  }

  /** Still down: wait twice as long, up to netProbeMaxMs. Back: resume every waiting thread, resumeGapMs apart. */
  private async probeNet() {
    let up = false;
    try {
      up = await this.host.netProbe();
    } catch {
      // A probe that throws is a probe that failed.
    }
    this.netTimer = undefined;
    const waiting = this.net.all();
    if (!up && waiting.length) {
      this.netDelay = Math.min((this.netDelay ?? this.host.netProbeMs) * 2, this.host.netProbeMaxMs);
      return this.armNetProbe();
    }
    this.netDelay = null;
    // Each keeps its place in the list until its own resume's turn starts, so a restart mid-stagger loses none.
    waiting.forEach((w, i) => setTimeout(() => this.netResume(w.ticket), this.host.resumeGapMs * i).unref());
  }

  /** The wait stays saved until the resume's turn takes it (takeQueue), so a restart during the last turn's save still resumes. */
  netResume(ticketId: number) {
    const w = this.net.get(ticketId);
    if (w) this.host.resume(ticketId, 'net', { net: w.tries });
  }

  killWait(ticketId: number): KillResume | null {
    return this.kill.get(ticketId);
  }

  /** Join the line of kill resumes. */
  putKill(ticketId: number, retries: Retries) {
    this.kill.put({ ticket: ticketId, tries: retries.kill ?? 1, resumes: retries.restart ?? 0 });
    this.host.killStarted.delete(ticketId);
  }

  /** End the minion's kill wait (its resume's turn, a person's message, a stop, a dismissal); returns the wait it had. */
  cancelKillWait(ticketId: number): KillResume | null {
    this.host.killStarted.delete(ticketId);
    return this.kill.take(ticketId);
  }

  /** The next step of the kill line in resumeGapMs, unless one is due or under way, or nobody waits whose resume hasn't started. */
  armKillResumes(wait = this.host.resumeGapMs) {
    if (this.killTimer || this.host.detached || !this.kill.all().some((w) => !this.host.killStarted.has(w.ticket))) return;
    this.killTimer = setTimeout(() => void this.killResumeNext(), wait);
    this.killTimer.unref();
  }

  /**
   * One kill resume at a time, resumeGapMs apart, so a wave (16 at once on Nov 20) isn't replayed into the same wall.
   * The line holds while the box is starved (killStarved), at most killHoldMaxMs before one goes anyway; then the
   * clock starts again. It limits only these resumes: nothing a person starts waits on it.
   */
  private async killResumeNext() {
    const h = this.host;
    let r = { starved: false, why: '' };
    try {
      r = await h.killStarved();
    } catch {
      // A reading that fails holds nothing.
    }
    this.killTimer = undefined;
    if (h.detached) return;
    const list = this.kill.all();
    const w = list.find((x) => !h.killStarted.has(x.ticket));
    if (!w) return void (this.killHeldSince = null);
    // The last one started may still be behind its session save (afterRestore): it goes first, so a slow save can't
    // bunch the line up; one stuck that long doesn't hold the rest.
    if (list.some((x) => !h.lined(x.ticket) && Date.now() - (h.killStarted.get(x.ticket) ?? 0) < KILL_START_MAX_MS)) return this.armKillResumes(Math.max(h.resumeGapMs, 250));
    if (r.starved) {
      if (this.killHeldSince === null) {
        this.killHeldSince = Date.now();
        console.log(`[kill-resume] holding the resumes of killed turns: ${r.why}`);
      }
      if (Date.now() - this.killHeldSince < h.killHoldMaxMs) return this.armKillResumes(Math.max(h.resumeGapMs, 250));
      console.log(`[kill-resume] held ${Math.round((Date.now() - this.killHeldSince) / 1000)} s for a starved box (${r.why}): minion ${w.ticket} resumes anyway`);
      this.killHeldSince = Date.now();
    } else this.killHeldSince = null;
    this.startKill(w.ticket);
    this.armKillResumes();
  }

  /** Start the minion's kill resume, if it waits for one; false if not. */
  startKill(ticketId: number): boolean {
    const h = this.host;
    const w = this.kill.get(ticketId);
    if (!w) return false;
    h.killStarted.set(w.ticket, Date.now());
    let ran: Promise<void> | undefined;
    try {
      ran = h.resume(w.ticket, 'kill', { kill: w.tries, ...(w.resumes ? { restart: w.resumes } : {}) });
    } catch (err) {
      console.error(`[kill-resume] minion ${w.ticket}: its resume failed to start: ${thrown(err).message ?? err}`);
    }
    void Promise.resolve(ran).then(() => this.killResumeEnded(w.ticket));
    return true;
  }

  /**
   * A kill resume's start is over. Its turn took the wait (takeQueue), or it bailed and cancelled it; a wait still
   * there means the start threw, so it stops here with an error (the host's killResumeFailed).
   */
  private killResumeEnded(ticketId: number) {
    if (!this.host.killStarted.has(ticketId) || this.host.isRunning(ticketId) || this.host.lined(ticketId)) return;
    if (!this.cancelKillWait(ticketId)) return;
    this.host.killResumeFailed(ticketId);
    this.armKillResumes();
  }

  limitWait(ticketId: number): LimitResume | null {
    return this.limit.get(ticketId);
  }

  /** Save the limit list and time the next resume. */
  saveLimits(list: LimitResume[]) {
    this.limit.set(list);
    this.armLimitTimer();
  }

  /** Wait for the limit to reset, a while after `resetAt` and spaced from the minions already waiting; returns when it resumes. */
  waitForLimit(ticketId: number, resetAt: number, tries: number, accounts?: LimitedAccount[]): number {
    this.host.limitStarting.delete(ticketId);
    const list = this.limit.all().filter((w) => w.ticket !== ticketId);
    let at = resetAt + this.host.limitDelayMs;
    for (const w of [...list].sort((a, b) => a.at - b.at)) if (Math.abs(w.at - at) < this.host.limitGapMs) at = w.at + this.host.limitGapMs;
    list.push({ ticket: ticketId, at, tries, ...(accounts?.length ? { accounts } : {}) });
    this.saveLimits(list);
    return at;
  }

  /** Stop waiting on the usage limit (a stop, a dismissal); true if it was waiting. */
  cancelLimitWait(ticketId: number): boolean {
    this.host.limitStarting.delete(ticketId);
    const list = this.limit.all();
    if (!list.some((w) => w.ticket === ticketId)) return false;
    this.saveLimits(list.filter((w) => w.ticket !== ticketId));
    return true;
  }

  /** Time the next usage-limit resume: the earliest due, and never sooner than a gap after the last (limitGapMs, or limitProvenGapMs for waits a turn getting through released). */
  armLimitTimer() {
    clearTimeout(this.limitTimer);
    const list = this.limit.all().filter((w) => !this.host.limitStarting.has(w.ticket));
    if (!list.length) return;
    const due = nextLimitResume(list, this.lastLimitResume, this.host.limitGapMs, this.host.limitProvenGapMs)!.due;
    // setTimeout overflows past 24.8 days; a weekly limit is at most 7.
    this.limitTimer = setTimeout(() => this.limitResumeNext(), Math.min(Math.max(0, due - Date.now()), 2 ** 31 - 1));
    this.limitTimer.unref();
  }

  limitResumeNext() {
    const h = this.host;
    const list = this.limit.all().filter((w) => !h.limitStarting.has(w.ticket));
    const next = nextLimitResume(list, this.lastLimitResume, h.limitGapMs, h.limitProvenGapMs);
    const w = next?.wait;
    if (!w || next.due > Date.now()) return this.armLimitTimer();
    this.lastLimitResume = Date.now();
    this.startLimit(w.ticket);
  }

  /** Start the minion's limit resume, if it waits for one; false if not. */
  startLimit(ticketId: number): boolean {
    const w = this.limit.get(ticketId);
    if (!w) return false;
    // The wait and its held messages stay saved until the resume's turn takes them (startTurn ends the wait), as a network
    // wait does: a restart while the resume restores the session still resumes (A2, #1286).
    this.host.limitStarting.set(w.ticket, {});
    this.armLimitTimer();
    this.host.resume(w.ticket, 'limit', { limit: w.tries }, !!w.codex);
    return true;
  }

  failWait(ticketId: number): FailResume | null {
    return this.fail.get(ticketId);
  }

  /** Wait failRetryMs, then retry the failed turn once. Its wait stays saved until the retry's turn takes it (takeQueue), so a restart still retries. */
  waitForRetry(ticketId: number, retries: Retries, error: string) {
    this.failStarted.delete(ticketId);
    this.fail.put({ ticket: ticketId, at: Date.now() + this.host.failRetryMs, retries, error });
    this.armFailTimer();
  }

  /** End the minion's retry wait (its retry's turn, a person's message, a stop, a dismissal); returns the wait it had. */
  cancelFailWait(ticketId: number): FailResume | null {
    this.failStarted.delete(ticketId);
    return this.fail.take(ticketId);
  }

  /** Time the earliest retry not yet started here. */
  armFailTimer() {
    clearTimeout(this.failTimer);
    this.failTimer = undefined;
    if (this.host.detached) return;
    const list = this.fail.all().filter((w) => !this.failStarted.has(w.ticket));
    if (!list.length) return;
    this.failTimer = setTimeout(() => this.failRetryNext(), Math.max(0, Math.min(...list.map((w) => w.at)) - Date.now()));
    this.failTimer.unref();
  }

  private failRetryNext() {
    this.failTimer = undefined;
    if (this.host.detached) return;
    for (const w of this.fail.all()) if (!this.failStarted.has(w.ticket) && w.at <= Date.now()) this.startFail(w.ticket);
    this.armFailTimer();
  }

  /** Start the minion's retry, if it waits for one; false if not. A start that took no turn and left the wait ends it (failRetryLost). */
  startFail(ticketId: number): boolean {
    const h = this.host;
    const w = this.fail.get(ticketId);
    if (!w) return false;
    this.failStarted.add(ticketId);
    let ran: Promise<void> | undefined;
    try {
      ran = h.resume(ticketId, 'fail', w.retries);
    } catch (err) {
      console.error(`[fail-retry] minion ${ticketId}: its retry failed to start: ${thrown(err).message ?? err}`);
    }
    void Promise.resolve(ran).then(() => {
      if (!this.failStarted.has(ticketId) || h.isRunning(ticketId) || h.lined(ticketId)) return;
      const gone = this.cancelFailWait(ticketId);
      if (gone) h.failRetryLost(ticketId, gone.error);
    });
    return true;
  }
}
