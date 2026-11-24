// Failed contraption timers (#555). A contraption's timer jobs (citadel-app-<name>-<job>, from its citadel-app.json)
// ran unwatched: Mandate's nightly backup exiting 1 only showed in systemd. Every 5 minutes the live server reads
// each job's last run; a failed one is one Mandate alert item for every admin and the owner of the app's home scheme
// (as the watchdog's down push goes, src/watchdog.ts), naming the app, the job, when it failed and its last journal
// lines. It stays one item however many runs fail, and is cleared once a run of that job succeeds, or the job is
// gone (#532: an alert goes when its problem does).
// #1662 (Cara's pick, 2026-11-22: "After the wait, if nobody's on it", the wait "Keep 1 h"): the home scheme's Taskmaster
// is woken as it fails (not 2-9 AM Pacific), and the item goes out only if it is still failing RED_FIX_MS later.
import type { ContraptionRow, Project, Store, User } from './db.ts';
import type { TimerRun } from './app-services.ts';
import { BROKEN_PAGE, clock, RED_FIX_MS } from './ci-health.ts';
import { cap } from './ci-problems.ts';
import { quietUntil } from './alert-wakes.ts';
import type { BrokenRow } from './ci-health.ts';
import { every, type Job } from './every.ts';

const POLL_MS = 5 * 60_000;

/** When a failure rings: RED_FIX_MS after its Taskmaster can hear (one at 2-9 AM Pacific counts from 9). One kept from before #1662 has no `since` and had rung already. */
const ringsAt = (o: { since?: number }) => (o.since == null ? 0 : (quietUntil(o.since) ?? o.since) + RED_FIX_MS);
/** Settings key: the failed jobs, by unit → who the item comes from, its key and title, who has it, when it failed (absent before #1662) and whether its Taskmaster heard. */
export const OUT = 'timer-alerts';
type Sender = Pick<Project, 'id' | 'name'>;
export type Out = Record<string, { from: Sender; key: string; title: string; link: string; users: number[]; since?: number; woke?: boolean }>;

export interface TimerAlertDeps {
  /** Every contraption's timer jobs' last runs; a throw skips the round, so nothing clears on a failed read. */
  runs: (rows: ContraptionRow[]) => Promise<TimerRun[]>;
  /** A unit's own last journal lines. */
  journal: (unit: string) => Promise<string[]>;
  /** Put (with `title`) or clear (null) a person's Mandate alert item; true once Mandate has it settled. */
  mandate: (from: Sender, person: User, key: string, title: string | null, link?: string) => Promise<boolean>;
  /** Wake the Taskmaster of `from`'s scheme (0: Citadel's) with `text`; false when there's none. */
  wake?: (from: Sender, text: string) => boolean;
}

/** Blank out what looks like a secret in a journal line: key=value or key: value for secret-ish keys, bearer tokens, long opaque runs. */
export function redact(line: string): string {
  return (
    line
      .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 [hidden]')
      .replace(/\b([\w-]*(?:token|secret|passw(?:or)?d|api[_-]?key|auth\w*|cookie|session|credential)[\w-]*)(["']?\s*[:=]\s*)("[^"]*"?|'[^']*'?|[^\s"',;&]+)/gi, (_, key, sep, value) => `${key}${sep}${/^["']/.test(value) ? `${value[0]}[hidden]${value[0]}` : '[hidden]'}`)
      // Long runs of letters and digits both, like keys and hashes; not paths (no slash) or plain words.
      .replace(/\b(?=[\w+=-]*\d)(?=[\w+=-]*[A-Za-z])[\w+=-]{32,}\b/g, '[hidden]')
      .replace(/:\/\/[^\s/:@]+:[^\s/@]+@/g, '://[hidden]@')
  );
}

/** The item's words: app, job, when and how it failed, then its last lines, within Mandate's 500 characters. */
export function alertTitle(run: TimerRun, lines: string[], now: number): string {
  const how = run.result === 'exit-code' ? `exit ${run.status}` : run.result || 'failed';
  const head = `${run.app.title}'s ${run.job} timer failed ${clock(run.exitAt ?? now)} (${how})`;
  const tail = lines
    .slice(-5)
    .map((l) => redact(l.trim()).slice(0, 200))
    .join(' | ');
  const s = tail ? `${head}. Last lines: ${tail}` : `${head}. Its journal: contraption_service logs.`;
  return s.length > 500 ? `${s.slice(0, 499)}…` : s;
}

export class TimerAlerts {
  private store: Store;
  private deps: TimerAlertDeps;
  private busy = false;
  private timer: Job | null = null;

  constructor(store: Store, deps: TimerAlertDeps) {
    this.store = store;
    this.deps = deps;
  }

  start() {
    this.timer ??= every('timer alerts', POLL_MS, () => this.tick());
  }

  stop() {
    this.timer?.stop();
    this.timer = null;
  }

  /** Who hears about an app's timers: every admin and its home scheme's owner, while enabled and with Mandate on. */
  private recipients(app: ContraptionRow): User[] {
    const home = app.home_scheme === null ? undefined : this.store.getProject(app.home_scheme);
    return this.store.listUsers().filter((u) => (u.admin || u.id === home?.owner_id) && !u.disabled_at && this.store.contraptionEnabled('mandate', u.id));
  }

  async tick(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const runs = await this.deps.runs(this.store.listContraptions());
      const out = this.store.getSetting<Out>(OUT) ?? {};
      const seen = new Set<string>();
      for (const run of runs) {
        seen.add(run.unit);
        // A run in progress, or one never run, settles nothing.
        if (run.active === 'failed') await this.raise(run, out, now);
        else if (run.active === 'inactive' || run.active === 'active') await this.clear(run.unit, out);
      }
      // A job its app no longer has (or an app removed) has nothing left to fail.
      for (const unit of Object.keys(out)) if (!seen.has(unit)) await this.clear(unit, out);
      this.store.setSetting(OUT, out);
    } finally {
      this.busy = false;
    }
  }

  /**
   * A failed job: its Taskmaster hears first, then, still failing RED_FIX_MS later, the item goes to everyone who should have
   * it and doesn't yet (once, then only retries and newcomers). One kept from before #1662 had gone out already.
   */
  private async raise(run: TimerRun, out: Out, now: number) {
    const home = run.app.home_scheme === null ? undefined : this.store.getProject(run.app.home_scheme);
    // shortcut: an app with no home scheme sends as scheme 0, sharing CI health's switch in Mandate; give it its own sender if that bites.
    const o = (out[run.unit] ??= {
      from: home ? { id: home.id, name: home.name } : { id: 0, name: 'Contraption timers' },
      key: `timer.${run.unit.replace(/\.service$/, '')}`.replace(/[^A-Za-z0-9._:-]+/g, '_').slice(0, 128),
      title: alertTitle(run, await this.deps.journal(run.unit), now),
      link: home ? BROKEN_PAGE : '/c/',
      users: [],
      since: now,
    });
    const due = ringsAt(o);
    if (!o.woke && now < due && quietUntil(now) === null && this.deps.wake) {
      o.woke = this.deps.wake(o.from, `${o.title}\nStart a fix minion for it now, or ask people with a card if it needs a person. If it's still failing at ${clock(due)}, people's phones ring.`);
    }
    if (now < due) return;
    // What is broken, that it still is, and what was done (Cara, 2026-11-22: "which thing is broken and what is being done").
    const text = o.since == null ? o.title : cap(o.title.replace(/^(.*? timer failed [^.]*?\))\. /, `$1, and is still failing an hour on${o.woke ? '; its Taskmaster was asked to fix it' : ''}. `));
    for (const u of this.recipients(run.app)) {
      if (!o.users.includes(u.id) && (await this.deps.mandate(o.from, u, o.key, text, o.link))) o.users.push(u.id);
    }
  }

  /** Clear the item for everyone who has it; who Mandate didn't answer for is tried again next round. */
  private async clear(unit: string, out: Out) {
    const o = out[unit];
    if (!o) return;
    const left: number[] = [];
    for (const uid of o.users) {
      const u = this.store.getUser(uid);
      if (u && !(await this.deps.mandate(o.from, u, o.key, null))) left.push(uid);
    }
    if (left.length) out[unit] = { ...o, users: left };
    else delete out[unit];
  }
}

/** Failed timer jobs as rows of Home's "Broken now" (#1662), for the schemes `canSee` allows (by the app's home scheme). */
export function timerBroken(store: Store, canSee: (projectId: number) => boolean, now = Date.now()): BrokenRow[] {
  const out = store.getSetting<Out>(OUT) ?? {};
  // shortcut: an app with no home scheme (sender 0) is left out; give it a row for admins if one turns up.
  return Object.entries(out)
    .filter(([, o]) => o.from.id && canSee(o.from.id))
    .map(([unit, o]) => {
      const ringing = now >= ringsAt(o);
      return {
        scheme: o.from.name,
        schemeId: o.from.id,
        key: `timer:${unit}`,
        what: o.title.split(/\. (Last lines|Its journal)/)[0],
        since: o.since ?? null,
        ringing,
        ...(!ringing && { ringsAt: ringsAt(o) }),
        who: ringing ? { kind: 'person' as const, label: 'Needs you', href: `#/p/${o.from.id}` } : { kind: 'taskmaster' as const, label: 'Taskmaster looking', href: `#/p/${o.from.id}` },
      };
    });
}
