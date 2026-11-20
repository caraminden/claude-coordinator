// Failed contraption timers (#555). A contraption's timer jobs (citadel-app-<name>-<job>, from its citadel-app.json)
// ran unwatched: Mandate's nightly backup exiting 1 only showed in systemd. Every 5 minutes the live server reads
// each job's last run; a failed one is one Mandate alert item for every admin and the owner of the app's home scheme
// (as the watchdog's down push goes, src/watchdog.ts), naming the app, the job, when it failed and its last journal
// lines. It stays one item however many runs fail, and is cleared once a run of that job succeeds, or the job is
// gone (#532: an alert goes when its problem does).
import type { ContraptionRow, Project, Store, User } from './db.ts';
import type { TimerRun } from './app-services.ts';
import { clock } from './ci-health.ts';
import { every, type Job } from './every.ts';

const POLL_MS = 5 * 60_000;
/** Settings key: the alerts out, by unit → who the item came from, its key and title, and who has it. */
const OUT = 'timer-alerts';
type Sender = Pick<Project, 'id' | 'name'>;
type Out = Record<string, { from: Sender; key: string; title: string; link: string; users: number[] }>;

export interface TimerAlertDeps {
  /** Every contraption's timer jobs' last runs; a throw skips the round, so nothing clears on a failed read. */
  runs: (rows: ContraptionRow[]) => Promise<TimerRun[]>;
  /** A unit's own last journal lines. */
  journal: (unit: string) => Promise<string[]>;
  /** Put (with `title`) or clear (null) a person's Mandate alert item; true once Mandate has it settled. */
  mandate: (from: Sender, person: User, key: string, title: string | null, link?: string) => Promise<boolean>;
}

/** Blank out what looks like a secret in a journal line: key=value or key: value for secret-ish keys, bearer tokens, long opaque runs. */
export function redact(line: string): string {
  return line
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 [hidden]')
    .replace(/\b([\w-]*(?:token|secret|passw(?:or)?d|api[_-]?key|auth\w*|cookie|session|credential)[\w-]*)(["']?\s*[:=]\s*)("[^"]*"?|'[^']*'?|[^\s"',;&]+)/gi,
      (_, key, sep, value) => `${key}${sep}${/^["']/.test(value) ? `${value[0]}[hidden]${value[0]}` : '[hidden]'}`)
    // Long runs of letters and digits both, like keys and hashes; not paths (no slash) or plain words.
    .replace(/\b(?=[\w+=-]*\d)(?=[\w+=-]*[A-Za-z])[\w+=-]{32,}\b/g, '[hidden]')
    .replace(/:\/\/[^\s/:@]+:[^\s/@]+@/g, '://[hidden]@');
}

/** The item's words: app, job, when and how it failed, then its last lines, within Mandate's 500 characters. */
export function alertTitle(run: TimerRun, lines: string[], now: number): string {
  const how = run.result === 'exit-code' ? `exit ${run.status}` : run.result || 'failed';
  const head = `${run.app.title}'s ${run.job} timer failed ${clock(run.exitAt ?? now)} (${how})`;
  const tail = lines.slice(-5).map((l) => redact(l.trim()).slice(0, 200)).join(' | ');
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

  /** Put the item for everyone who should have it and doesn't yet: once for a new failure, then only retries and newcomers. */
  private async raise(run: TimerRun, out: Out, now: number) {
    const home = run.app.home_scheme === null ? undefined : this.store.getProject(run.app.home_scheme);
    // shortcut: an app with no home scheme sends as scheme 0, sharing CI health's switch in Mandate; give it its own sender if that bites.
    const o = (out[run.unit] ??= {
      from: home ? { id: home.id, name: home.name } : { id: 0, name: 'Contraption timers' },
      key: `timer.${run.unit.replace(/\.service$/, '')}`.replace(/[^A-Za-z0-9._:-]+/g, '_').slice(0, 128),
      title: alertTitle(run, await this.deps.journal(run.unit), now),
      link: home ? `/c/#/p/${home.id}` : '/c/',
      users: [],
    });
    for (const u of this.recipients(run.app)) {
      if (!o.users.includes(u.id) && (await this.deps.mandate(o.from, u, o.key, o.title, o.link))) o.users.push(u.id);
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
