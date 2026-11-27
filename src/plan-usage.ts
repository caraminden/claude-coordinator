// Whose plan a turn runs on and each plan's usage: the server login's and each person's Claude windows (the top bar's
// meter, and a lifted limit freeing the turns waiting on it), and each person's Codex switch, windows and thread log.
// Why a person can't use Codex (codexWhy) stays in runner.ts, which launches turns with it.
// Moved out of runner.ts (#2045): it takes what it needs from the Runner as `PlanUsageDeps`.
import type { Project, Store, TicketFields } from './db.ts';
import { accountUsageKey } from './account-pick.ts';
import { codexSwitchKey, codexThreadKey, codexUsageKey, HANDOVER_MAX, type CodexThread, type CodexUsage } from './codex.ts';
import type { LimitResume, Resumes } from './resumes.ts';
import { usageWindow, type CodexLimits, type CodexWindow, type QueuedMessage, type RateLimitInfo, type Usage } from './turn-messages.ts';
import { turnKey } from './turn-keys.ts';
import type { Broadcast, LiveTurn, TurnState } from './runner.ts';

/** The most of a minion's Codex log kept for the way back, as characters (twice what a hand-over carries). */
const CODEX_LOG_MAX = 2 * HANDOVER_MAX;

/** What plan usage needs from the Runner. The optional hooks are the Runner's own, which server.ts sets after it is made. */
export interface PlanUsageDeps {
  store: Store;
  turns: Map<number, LiveTurn>;
  resumes: () => Resumes;
  broadcast: Broadcast;
  codexWhy: (person: number | null) => string | null;
  turnPerson: (ticket: TicketFields, project: Project, waiting: QueuedMessage[], resuming?: boolean) => number | null;
  limitCleared: (payer: number | null) => void;
  claudeAccounts: (person: number) => { inUse: number | null; why?: string; pinned?: number; accounts: { n: number; label: string; same?: string }[] } | null | undefined;
  onCleared: (person: number, account: number) => void;
}

export class PlanUsage {
  private d: PlanUsageDeps;
  constructor(d: PlanUsageDeps) {
    this.d = d;
  }

  get usage(): Usage | null {
    return this.d.store.getSetting<Usage>('usage');
  }

  /** Whose plan a person's turns run on: null for the server login (its owner's turns run on the host), else their own. */
  payerOf(uid: number | null | undefined): number | null {
    return uid && !this.d.store.getUser(uid)?.server_login ? uid : null;
  }

  /** A plan as the minion's chip names it: payerOf's id, and whose it is (the server login's owner for it). */
  payerView(uid: number | null, user = (id: number) => this.d.store.getUser(id)): { id: number | null; name: string } | null {
    if (!uid) return null;
    const id = user(uid)?.server_login ? null : uid;
    const name = user(id ?? this.d.store.serverLoginOwner() ?? uid)?.name;
    return name ? { id, name } : null;
  }

  /** A turn is running with this Claude config folder now (#779: unlinking its account would end it on a 401). */
  turnIn(configDir: string): boolean {
    return [...this.d.turns.values()].some((t) => t.configDir === configDir);
  }

  /**
   * A person's own plan usage, for their top-bar meter: the server login's, or their container turns', of the
   * account in use. With several accounts (#779) it says which, and carries each account's.
   */
  usageOf(uid: number | null | undefined): (Usage & { account?: number; why?: string; pinned?: number; accounts?: { n: number; label: string; same?: string; usage: Usage | null }[] }) | null {
    const payer = this.payerOf(uid);
    const acc = uid ? this.d.claudeAccounts(uid) : null;
    const usage = this.d.store.getSetting<Usage>(accountUsageKey(payer, acc?.inUse ?? 1));
    if (!acc || acc.accounts.length < 2) return usage;
    // `account` is where a new or cold turn goes now, and `why` (#793): its week resets soonest, it's pinned, or every account is near full.
    return { ...(usage ?? { weekly: null, session: null, updatedAt: 0 }), account: acc.inUse ?? 1, ...(acc.why ? { why: acc.why } : {}), ...(acc.pinned ? { pinned: acc.pinned } : {}), accounts: acc.accounts.map((a) => ({ ...a, usage: this.d.store.getSetting<Usage>(accountUsageKey(payer, a.n)) })) };
  }

  /** What the usage bar shows of a person's Codex: whether they can use it, the switch and its windows. */
  codexView(uid: number | null | undefined): { ready: boolean; why: string | null; on: boolean; usage: CodexUsage | null } | null {
    if (!uid) return null;
    const why = this.d.codexWhy(uid);
    return { ready: !why, why, on: !!this.d.store.getSetting<boolean>(codexSwitchKey(uid)), usage: this.d.store.getSetting<CodexUsage>(codexUsageKey(uid)) };
  }

  /**
   * "Enable Codex override" (#337). Switching on resumes the person's minions waiting out a usage
   * limit right away (on Codex now); returns why it can't, or null.
   */
  setCodexSwitch(uid: number, on: boolean): string | null {
    if (on) {
      const why = this.d.codexWhy(uid);
      if (why) return why;
      this.d.store.setSetting(codexSwitchKey(uid), true);
    } else this.d.store.deleteSetting(codexSwitchKey(uid));
    this.d.broadcast({ type: 'codex', codex: this.codexView(uid), to: uid });
    if (!on) return null;
    const mine = (w: LimitResume) => {
      const t = this.d.store.getTicket(w.ticket);
      const p = t && this.d.store.getProject(t.project_id);
      return !!p && this.d.turnPerson(t!, p, [], true) === uid;
    };
    // Due now, on Codex, spaced limitGapMs apart like any limit resume.
    const list = this.d.resumes().limit.all();
    if (list.some(mine)) this.d.resumes().saveLimits(list.map((w) => (mine(w) ? { ...w, at: Date.now(), tries: 0, codex: true as const } : w)));
    return null;
  }

  /** Record a Codex turn's usage windows (account/rateLimits) as its person's, for their usage bar. */
  updateCodexUsage(l: unknown, person: number | null) {
    const w = (x: CodexWindow | null | undefined) => (x && typeof x.usedPercent === 'number' ? { usedPercent: x.usedPercent, windowDurationMins: typeof x.windowDurationMins === 'number' ? x.windowDurationMins : null, resetsAt: typeof x.resetsAt === 'number' ? x.resetsAt : null } : null);
    if (person === null || !l) return;
    this.d.store.setSetting(codexUsageKey(person), { primary: w((l as CodexLimits).primary), secondary: w((l as CodexLimits).secondary), updatedAt: Date.now() });
    this.d.broadcast({ type: 'codex', codex: this.codexView(person), to: person });
  }

  /** Add a finished Codex turn's log to its minion's Codex thread. */
  keepCodexLog(ticketId: number, log: string | null) {
    const t = this.d.store.getSetting<CodexThread>(codexThreadKey(ticketId));
    if (!t || !log) return;
    // Past what a hand-over can carry, the oldest turns go: fitLog would cut them to nothing anyway.
    let all = t.log + log;
    if (all.length > CODEX_LOG_MAX) all = all.slice(all.indexOf('\n', all.length - CODEX_LOG_MAX) + 1);
    this.d.store.setSetting(codexThreadKey(ticketId), { ...t, log: all });
  }

  /** Record a turn's plan usage: the server login's (the top bar's meter), or a container turn's payer's own (#213). */
  updateUsage(info: unknown, ticketId?: number) {
    const turn = ticketId === undefined ? null : this.d.store.getSetting<TurnState>(turnKey(ticketId));
    this.recordUsage(info, turn?.container && turn.person ? turn.person : null, turn?.person ?? null, turn?.account);
  }

  /** Record a Claude turn's `rate_limit_info` on `account` of `payer` (null: the server login), a minion's or an app's (#793). */
  recordUsage(info: unknown, payer: number | null, person: number | null, account?: number) {
    const windows = (info as RateLimitInfo | null | undefined)?.unifiedWindows;
    if (!windows) return;
    const key = accountUsageKey(payer, account);
    const was = this.d.store.getSetting<Usage>(key);
    const now = Date.now();
    // An event may report one window: the other keeps its last reading until it resets, so the account pick still sees a nearly
    // spent week. Not its status: a stale 'rejected' would hold the next limit's turns until that window's reset.
    const kept = (w: Usage['weekly'] | undefined) => (w && w.resetsAt && w.resetsAt > now ? { ...w, status: null } : null);
    const usage: Usage = { weekly: usageWindow(windows.seven_day) ?? kept(was?.weekly), session: usageWindow(windows.five_hour) ?? kept(was?.session), updatedAt: now };
    if (!usage.weekly && !usage.session) return;
    this.d.store.setSetting(key, usage);
    // The plan's limit lifted (#477): every window that was hit now says otherwise, so what waits on it needn't wait for the reset time.
    const hit = (['session', 'weekly'] as const).filter((k) => was?.[k]?.status === 'rejected');
    if (hit.length && hit.every((k) => usage[k]?.status && usage[k]!.status !== 'rejected')) {
      if (person && account) this.d.onCleared(person, account);
      this.d.limitCleared(payer);
    }
    // Only the payer's own meter shows it (server.ts, broadcast): the account in use's, whichever account this turn ran on.
    this.d.broadcast({ type: 'usage', usage: person ? (this.usageOf(person) ?? usage) : usage, payer });
  }
}
