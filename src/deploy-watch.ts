// The post-deploy watch (#724): after each deploy goes live, compare a few health readings from just before it with
// just after it, at +20 min, +1 h and +1 day. When one clearly gets worse, wake the minions whose commits went live in
// that deploy, once each, and leave the Taskmaster held mail. A minion is woken only when the readings name a file its
// commits touched, or the rise holds over a second HOLD_MS window (#2049: 56 of 68 wakes ended "not mine"); otherwise
// it gets a note, which starts no turn. It never reverts, rolls back or blocks a land: a person or
// the minion decides. Plain server code, no model: the only spend is the turn each woken minion takes.
//
// The readings, all from what's already stored, so a restart loses none of them:
// - front-end errors, from the beacon (public/error-beacon.js, POST /api/client-errors), in health_events;
// - 5xx answers, in-server fallbacks (src/fallbacks.ts) and event-loop stalls (src/loop-lag.ts), in health_events;
// - the share of turns that failed, from the turns table and error events.
// The windows before and after are the same length: the check's offset, cut short where the next deploy went live, so
// a later deploy's trouble is never blamed on this one (that deploy's own checks cover it).
import { execFile } from 'node:child_process';
import type { Project, Store } from './db.ts';
import { pacific } from './pacific.ts';
import { thrown } from './thrown.ts';

/** Settings key: the commit last seen live, and the deploys still being watched. */
export const WATCH_KEY = 'deploy-watch';
const MIN = 60_000;
/** When each check runs, after the deploy went live. */
export const CHECKS = [20 * MIN, 60 * MIN, 24 * 60 * MIN];
/** The second window a rise must hold over before it wakes a minion whose files no reading names (#2049). */
export const HOLD_MS = 20 * MIN;
/** A window cut shorter than this by the next deploy says too little to compare. */
export const MIN_WINDOW = 5 * MIN;
/**
 * Event-loop stalls in a restart's first minutes are the boot's own work (afterRestore, the card refresh, resumed turns),
 * not the change's: a restart's startup ran stalls up to 8 minutes in (#734).
 */
export const BOOT_QUIET_MS = 10 * MIN;
/** The health kind of a stall inside BOOT_QUIET_MS of the boot: kept and shown, never counted by a check. */
export const BOOT_STALL = 'loop-lag-boot';
/** A stall whose stacks name this file is the watch's own query, never the change's. */
const OWN_STALL = 'src/deploy-watch.ts';

/** One kind of reading: worse means at least `floor` after and at least double the window before. */
export interface Signal {
  key: string;
  name: string;
  floor: number;
}
export const SIGNALS: Signal[] = [
  // 3, not 5: the route keeps one report per person per error each 10 minutes, so one person adds at most 2 in 20 minutes.
  { key: 'client-error', name: 'front-end errors', floor: 3 },
  { key: 'server-5xx', name: 'server 5xx answers', floor: 5 },
  { key: 'fallback', name: 'jobs run inside the server (systemd-run fallbacks)', floor: 3 },
  { key: 'loop-lag', name: 'event-loop stalls over half a second', floor: 5 },
];
/** Turn failures: worse means at least this many failed after, and at least double the failed share before. */
export const TURN_FLOOR = 3;

export interface Watched {
  commit: string;
  /** The commit live before it: the deploy shipped prev..commit. */
  prev: string;
  /** When it went live (ms). */
  at: number;
  /** Check offsets not run yet. */
  due: number[];
  /** The longest window compared so far: a later check cut to the same length would compare the same rows. */
  len: number;
  /** Set once it raised an alert: no more checks or wakes for it. */
  alerted?: boolean;
  /** An alert that woke only some minions: at `due` the found signals are read again, and if they held, `noted` are woken. */
  hold?: { due: number; names: string[]; noted: number[] };
}
export interface WatchState {
  live: string | null;
  deploys: Watched[];
}

export interface Finding {
  name: string;
  before: string;
  after: string;
  first: number | null;
  top: { detail: string; n: number }[];
}
/** A reading with its verdict: what the page may show. `first` and `top` are for alerts, not for everyone signed in. */
export type Reading = Finding & { worse: boolean };
export interface Suspect {
  ticketId: number;
  number: number | null;
  commits: { sha: string; subject: string }[];
}

export interface WatchDeps {
  store: Store;
  /** Commits that went live from `prev` to `head`, oldest first, or null when git can't say. */
  commits(prev: string, head: string): Promise<{ sha: string; subject: string }[] | null>;
  /** Wake (or reopen) a minion with a message from the server. */
  wake(ticketId: number, text: string): void;
  /** A note on a minion's chat, starting no turn and reopening nothing. */
  note(ticketId: number, text: string): void;
  /** The files these commits touched, or null when git can't say. */
  files(shas: string[]): Promise<string[] | null>;
  /** Leave a Taskmaster held mail, starting no turn. */
  mail(taskmasterId: number, text: string): void;
  /** The scheme whose code this server runs: its Taskmaster hears, and its minion numbers name the suspects. */
  scheme(): Project | null;
  /** The commit live now, stamped on each reading. */
  head(): string | null;
  /** The database file, for the minion's note on where to read the rows. */
  dbPath: string;
  now?: () => number;
  /** When this process started (ms), for BOOT_QUIET_MS. */
  bootAt?: number;
}

/**
 * WatchDeps.commits from the git checkout in `dir`: oldest first, parents before children, merges included, since a
 * land's Shipped note can name a merge (a build's tip) and owns the commits before it.
 */
export function gitCommits(dir: string): WatchDeps['commits'] {
  return (prev, head) =>
    new Promise((done) =>
      execFile('git', ['log', '--reverse', '--topo-order', '--format=%H%x09%s', `${prev}..${head}`], { cwd: dir, timeout: 30_000, maxBuffer: 16 << 20 }, (err, out) =>
        done(
          err
            ? null
            : out
                .split('\n')
                .filter(Boolean)
                .map((l) => ({ sha: l.slice(0, l.indexOf('\t')), subject: l.slice(l.indexOf('\t') + 1) })),
        ),
      ),
    );
}

/** WatchDeps.files from the git checkout in `dir`. */
export function gitFiles(dir: string): WatchDeps['files'] {
  return (shas) => new Promise((done) => execFile('git', ['log', '--no-walk=unsorted', '--name-only', '--format=', ...shas], { cwd: dir, timeout: 30_000, maxBuffer: 16 << 20 }, (err, out) => done(err ? null : [...new Set(out.split('\n').filter(Boolean))])));
}

/**
 * The changed files a reading's text names, as a whole path: by repo path (a stall's frames, a failing turn's stack), or
 * for a public/ file by the path it is served at (the beacon's source).
 */
export function namedFiles(files: string[], texts: string[]): string[] {
  const at = (p: string) => new RegExp(`(?:^|[^\\w.-])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`);
  return files.filter((f) => {
    const forms = [at(f), ...(f.startsWith('public/') ? [at(f.slice('public'.length))] : [])];
    return texts.some((t) => forms.some((r) => r.test(t)));
  });
}

/**
 * The minion number a main subject names: "#N", "WIP #N" or "WIP: #N" at the start, else the last trailing "(#N)".
 * Same rules as `sub ticket` in tools/land.sh (keep the two in step).
 */
export function subjectTicket(subject: string): string {
  const lead = /^(?:WIP:? )?#(\d+)\b/.exec(subject);
  if (lead) return lead[1];
  return [...subject.matchAll(/#(\d+)\)/g)].pop()?.[1] ?? '';
}

function span(ms: number): string {
  const m = Math.round(ms / MIN);
  return m % 60 === 0 ? (m === 60 ? 'hour' : `${m / 60} hours`) : `${m} minutes`;
}

/** Worse: at least `floor` after, and at least double the count before (0 before counts as anything). */
export function worse(before: number, after: number, floor: number): boolean {
  return after >= floor && after >= 2 * before;
}

/** Whether a failed request is a server fault the watch should count: a 5xx, unless the server gave it knowingly (HttpError.expected). */
export function countsAsServerFault(status: number, err: unknown): boolean {
  return status >= 500 && !(err as { expected?: boolean } | null)?.expected;
}

export class DeployWatch {
  private d: WatchDeps;
  private ticking = false;
  /** report()'s readings of windows wholly in the past, by `at:len`: their rows never change, and the page asks on every release event (#1178). */
  private settled = new Map<string, Reading[]>();

  constructor(d: WatchDeps) {
    this.d = d;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  state(): WatchState {
    return this.d.store.getSetting<WatchState>(WATCH_KEY) ?? { live: null, deploys: [] };
  }

  private save(s: WatchState) {
    this.d.store.setSetting(WATCH_KEY, s);
  }

  /** A health reading of `kind` now. Never throws: it's called from error paths (a 500's catch, a stall's log). */
  record(kind: string, detail: string) {
    try {
      const now = this.now();
      if (kind === 'loop-lag' && detail.includes(OWN_STALL)) return;
      // Marked, not dropped: a stall in a boot's first minutes is stored as its own kind, so the checks above never count it
      // and the Status page still shows it with its cause.
      if (kind === 'loop-lag' && now - (this.d.bootAt ?? 0) < BOOT_QUIET_MS) kind = BOOT_STALL;
      this.d.store.addHealthEvent(kind, now, this.d.head(), detail);
    } catch (err) {
      console.error(`Recording a ${kind} health reading failed: ${thrown(err).message ?? err}`);
    }
  }

  /** The server now runs `head` (at boot and after a front-end reload): a new commit starts a watch. */
  live(head: string | null) {
    if (!head) return;
    const s = this.state();
    if (s.live === head) return;
    const now = this.now();
    // The first commit ever seen has nothing to compare with; a restart on the same commit isn't a deploy.
    if (s.live) s.deploys.push({ commit: head, prev: s.live, at: now, due: [...CHECKS], len: 0 });
    s.live = head;
    // Kept a while after its last check, as the cut-off for the deploy before it.
    s.deploys = s.deploys.filter((w) => w.due.length || now - w.at < CHECKS.at(-1)! + 2 * 60 * MIN);
    this.save(s);
  }

  /** Run the checks that are due. Called every minute and at boot; a check missed while the server was down runs late, on the same windows. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const w of this.state().deploys) {
        for (const offset of w.due.filter((o) => w.at + o <= now)) {
          // Re-read: a check before this one (or live()) may have changed the list.
          const s = this.state();
          const cur = s.deploys.find((o) => o.commit === w.commit && o.at === w.at);
          if (!cur || cur.alerted || !cur.due.includes(offset)) break;
          cur.due = cur.due.filter((o) => o !== offset);
          const next = s.deploys.filter((o) => o.at > cur.at).reduce((a, o) => Math.min(a, o.at), Infinity);
          const len = Math.min(cur.at + offset, next, now) - cur.at;
          if (len < MIN_WINDOW || len <= cur.len) {
            this.save(s);
            continue;
          }
          cur.len = len;
          const found = this.compare(cur.at, len);
          // Saved before anything is sent, so a crash mid-alert never wakes anyone twice.
          if (found.length) (cur.alerted = true), (cur.due = []);
          this.save(s);
          if (found.length) await this.alert(cur, len, found);
        }
      }
      for (const w of this.state().deploys) if (w.hold && w.hold.due <= now) await this.recheck(w);
    } finally {
      this.ticking = false;
    }
  }

  /** Every reading in [from, from + len) (from defaults to at) against [at - len, at), each with whether it got worse. */
  readings(at: number, len: number, from = at): Reading[] {
    const { store } = this.d;
    const out: Reading[] = [];
    for (const sig of SIGNALS) {
      const b = store.healthCount(sig.key, at - len, at);
      // Stalls just after a boot are stored as BOOT_STALL (#734), so a front-end deploy soon after a restart would see "0 before":
      // the before side counts both kinds, so warm-up stalls that go on past the quiet window aren't the deploy's.
      if (sig.key === 'loop-lag') b.count += store.healthCount(BOOT_STALL, at - len, at).count;
      const a = store.healthCount(sig.key, from, from + len);
      out.push({ name: sig.name, before: String(b.count), after: String(a.count), first: a.first, top: a.top, worse: worse(b.count, a.count, sig.floor) });
    }
    const b = store.turnOutcomes(at - len, at);
    const a = store.turnOutcomes(from, from + len);
    const share = (o: { turns: number; failed: number }) => (o.turns ? o.failed / o.turns : 0);
    const pct = (o: { turns: number; failed: number }) => `${Math.round(100 * share(o))}% (${o.failed} of ${o.turns})`;
    out.push({ name: 'failed turns', before: pct(b), after: pct(a), first: a.first, top: [], worse: a.failed >= TURN_FLOOR && share(a) >= 2 * share(b) });
    // Informational only (#1481): logged-out turns are left out of the failed share, so say which account, never worse.
    const who = (o: { loggedOut: number[] }) => (o.loggedOut.length ? `account ${o.loggedOut.join(', ')}` : 'none');
    out.push({ name: 'logged-out turns (not counted as failed)', before: who(b), after: who(a), first: null, top: [], worse: false });
    return out;
  }

  /** The signals that got worse in [at, at + len) against [at - len, at). */
  compare(at: number, len: number): Finding[] {
    return this.readings(at, len)
      .filter((r) => r.worse)
      .map(({ worse: _w, ...f }) => f);
  }

  /**
   * What the Releases page shows (#1060): each watched deploy, newest first, with its checks as far as they have come
   * due: the readings over the same window the watch itself used, so the page and an alert never disagree.
   */
  report(): { commit: string; prev: string; at: number; alerted: boolean; checks: { offset: number; len: number | null; readings: Reading[] }[] }[] {
    const now = this.now();
    const deploys = this.state().deploys;
    const kept = new Map<string, Reading[]>();
    const read = (at: number, len: number) => {
      const key = `${at}:${len}`;
      const r = this.settled.get(key) ?? kept.get(key) ?? this.readings(at, len).map((r) => ({ ...r, first: null, top: [] }));
      if (at + len <= now) kept.set(key, r);
      return r;
    };
    const out = deploys
      .map((w) => {
        const next = deploys.filter((o) => o.at > w.at).reduce((a, o) => Math.min(a, o.at), Infinity);
        const checks = CHECKS.map((offset) => {
          if (w.at + offset > now && next === Infinity) return { offset, len: null, readings: [] };
          const len = Math.min(w.at + offset, next, now) - w.at;
          // An alert ends the watch: checks past the one that raised it never ran.
          if (w.alerted && len > w.len) return { offset, len: null, readings: [] };
          return len < MIN_WINDOW ? { offset, len, readings: [] } : { offset, len, readings: read(w.at, len) };
        });
        return { commit: w.commit, prev: w.prev, at: w.at, alerted: !!w.alerted, checks };
      })
      .sort((a, b) => b.at - a.at);
    // Only the windows still shown, so deploys that left the watch leave the cache too.
    this.settled = kept;
    return out;
  }

  /**
   * Who shipped each commit of the deploy: the minion whose handed-off land moved main to a commit (its "Shipped"
   * note) owns that commit and the ones before it not owned yet; what's left goes by a "#N:" at the start of its
   * subject, in this server's scheme. Commits neither names are returned unowned.
   */
  async suspects(w: Watched): Promise<{ suspects: Suspect[]; unowned: { sha: string; subject: string }[] }> {
    const { store } = this.d;
    const commits = (await this.d.commits(w.prev, w.commit)) ?? [];
    const shipped = store.shippedSince(w.at - 24 * 60 * MIN);
    const by = new Map<number, Suspect>();
    const own = (ticketId: number, c: { sha: string; subject: string }) => {
      const t = store.getTicket(ticketId);
      if (!t) return false;
      const s = by.get(ticketId) ?? { ticketId, number: t.number, commits: [] };
      s.commits.push(c);
      by.set(ticketId, s);
      return true;
    };
    let pending: { sha: string; subject: string }[] = [];
    for (const c of commits) {
      pending.push(c);
      const land = shipped.findLast((l) => c.sha.startsWith(l.commit));
      if (land) {
        for (const p of pending) own(land.ticket_id, p);
        pending = [];
      }
    }
    const scheme = this.d.scheme();
    const unowned = pending.filter((c) => {
      const n = subjectTicket(c.subject);
      const t = n && scheme ? store.getTicketByNumber(scheme.id, Number(n)) : undefined;
      return !(t && own(t.id, c));
    });
    return { suspects: [...by.values()], unowned };
  }

  /** The texts a finding's files are looked for in: each worse reading's commonest details, and the failing turns' errors. */
  private texts(from: number, len: number, found: Finding[]): string[] {
    const texts = found.flatMap((f) => f.top.map((t) => t.detail));
    if (found.some((f) => f.name === 'failed turns')) texts.push(...this.d.store.turnErrorTexts(from, from + len));
    return texts;
  }

  private async alert(w: Watched, len: number, found: Finding[]) {
    const { suspects, unowned } = await this.suspects(w);
    const texts = this.texts(w.at, len, found);
    const named = new Map<Suspect, string[]>();
    for (const s of suspects) {
      const files = (await this.d.files(s.commits.map((c) => c.sha))) ?? [];
      const hit = namedFiles(files, texts);
      if (hit.length) named.set(s, hit);
    }
    const woken = suspects.filter((s) => named.has(s));
    const noted = suspects.filter((s) => !named.has(s));
    const when = `${pacific(w.at)} (deploy ${w.commit.slice(0, 8)})`;
    const window = span(len);
    const lines = this.lines(found);
    const holdEnd = w.at + len + HOLD_MS;
    if (noted.length) {
      // Saved before anything is sent, like the alert itself: a crash never wakes anyone twice.
      const s = this.state();
      const cur = s.deploys.find((o) => o.commit === w.commit && o.at === w.at);
      if (cur) cur.hold = { due: holdEnd, names: found.map((f) => f.name), noted: noted.map((n) => n.ticketId) };
      this.save(s);
    }
    for (const s of suspects) {
      const hit = named.get(s);
      const head = hit
        ? `Post-deploy watch: since your change went live at ${when}, ${lines.join('; ')}, comparing the ${window} after the deploy with the ${window} before it. Its readings name ${hit.join(', ')}, which your change touched.`
        : `Post-deploy watch (not woken: no reading names a file your change touched): since your change went live at ${when}, ${lines.join('; ')}, comparing the ${window} after the deploy with the ${window} before it. If it still holds over the next ${span(HOLD_MS)} (to ${pacific(holdEnd)}), the watch wakes this minion.`;
      const text = this.message(head, s, suspects, unowned, found, w, len, !!hit);
      try {
        if (hit) this.d.wake(s.ticketId, text);
        else this.d.note(s.ticketId, text);
      } catch (err) {
        console.error(`Deploy watch: ${hit ? 'waking' : 'noting on'} minion ${s.ticketId} failed: ${thrown(err).message ?? err}`);
      }
    }
    const nums = (l: Suspect[]) => l.map((s) => `#${s.number ?? s.ticketId}`).join(', ');
    const loose = unowned.length
      ? ` Commits with no minion: ${unowned
          .slice(0, 5)
          .map((c) => `${c.sha.slice(0, 8)} ${c.subject.slice(0, 80)}`)
          .join('; ')}${unowned.length > 5 ? `; and ${unowned.length - 5} more` : ''}.`
      : '';
    const who = suspects.length
      ? [woken.length ? `Woke ${nums(woken)}. The readings name files they touched.` : '', noted.length ? `Noted on ${nums(noted)}, not woken: no reading names their files; they are woken if it holds to ${pacific(holdEnd)} (a deploy before then ends the hold: its own watch covers what follows).` : '']
          .filter(Boolean)
          .join(' ')
      : 'No minion to wake: none of its commits names one.';
    this.mailTaskmaster(`Post-deploy watch: after ${when}, ${lines.join('; ')} (${window} after vs before). ${who}${loose} Nothing was reverted.`);
  }

  /** At the hold's end: the signals the alert found, read again over the next HOLD_MS; if any is still worse, wake the noted minions. */
  private async recheck(w: Watched) {
    const s = this.state();
    const cur = s.deploys.find((o) => o.commit === w.commit && o.at === w.at);
    const hold = cur?.hold;
    if (!cur || !hold) return;
    delete cur.hold;
    this.save(s);
    const from = cur.at + cur.len;
    const next = s.deploys.filter((o) => o.at > cur.at).reduce((a, o) => Math.min(a, o.at), Infinity);
    // The next deploy's trouble is its own: a second window it cuts short says too little.
    const len = Math.min(from + HOLD_MS, next) - from;
    if (len < MIN_WINDOW) return;
    const found = this.readings(cur.at, len, from)
      .filter((r) => r.worse && hold.names.includes(r.name))
      .map(({ worse: _w, ...f }) => f);
    if (!found.length) return;
    const { suspects, unowned } = await this.suspects(cur);
    const wake = suspects.filter((x) => hold.noted.includes(x.ticketId));
    const when = `${pacific(cur.at)} (deploy ${cur.commit.slice(0, 8)})`;
    const lines = this.lines(found);
    for (const x of wake) {
      const head = `Post-deploy watch: the rise after your change went live at ${when} held over the next ${span(len)}: ${lines.join('; ')}, comparing ${pacific(from)} onward with the ${span(len)} before the deploy. No reading names a file your change touched, so it may not be yours.`;
      try {
        this.d.wake(x.ticketId, this.message(head, x, suspects, unowned, found, cur, len, true, from));
      } catch (err) {
        console.error(`Deploy watch: waking minion ${x.ticketId} failed: ${thrown(err).message ?? err}`);
      }
    }
    if (wake.length) this.mailTaskmaster(`Post-deploy watch: after ${when}, the rise held over the next ${span(len)} (${lines.join('; ')}). Woke ${wake.map((x) => `#${x.number ?? x.ticketId}`).join(', ')}. Nothing was reverted.`);
  }

  private lines(found: Finding[]): string[] {
    return found.map((f) => `${f.name} went from ${f.before} to ${f.after}${f.first ? `; first seen ${pacific(f.first)}` : ''}`);
  }

  private message(head: string, s: Suspect, suspects: Suspect[], unowned: { sha: string }[], found: Finding[], w: Watched, len: number, woken: boolean, from = w.at): string {
    const tops = found.flatMap((f) => f.top.map((t) => `- ${t.n}× ${t.detail.slice(0, 300)}`));
    const sql = `sqlite3 -readonly ${this.d.dbPath} "SELECT datetime(at/1000, 'unixepoch'), kind, commit_sha, detail FROM health_events WHERE at >= ${w.at - len} AND at < ${from + len} ORDER BY at"`;
    const others = suspects.filter((o) => o !== s).map((o) => `#${o.number ?? o.ticketId} (${o.commits.length})`);
    return [
      head,
      ...(tops.length ? ['Commonest:', ...tops] : []),
      `Your commits in that deploy: ${s.commits.map((c) => `${c.sha.slice(0, 8)} ${c.subject}`).join('; ')}.`,
      ...(others.length || unowned.length ? [`Also in it: ${[...others, ...(unowned.length ? [`${unowned.length} commit${unowned.length > 1 ? 's' : ''} with no minion`] : [])].join(', ')}.`] : []),
      woken
        ? `Nothing was reverted or blocked. Check whether your change caused it: if it did, fix it and ship the fix; if not, say why in one line and close. The readings: ${sql} (turn failures come from the turns table and error events). This is the watch's only wake about this deploy.`
        : `Nothing was reverted or blocked, and nothing is asked of this minion. The readings: ${sql} (turn failures come from the turns table and error events).`,
    ].join('\n');
  }

  private mailTaskmaster(text: string) {
    const scheme = this.d.scheme();
    // Nobody's in particular: the Overlord's (#921), the scheme's only Taskmaster before a split.
    const tm = scheme && this.d.store.getOverlord(scheme.id);
    if (!tm) return;
    try {
      this.d.mail(tm.id, text);
    } catch (err) {
      console.error(`Deploy watch: mailing the Taskmaster failed: ${thrown(err).message ?? err}`);
    }
  }
}

/** Per-person limits on beacon reports: the same error once per DEDUPE_MS, and at most RATE per RATE_MS. */
export const DEDUPE_MS = 10 * MIN;
export const RATE = 30;
export const RATE_MS = 60 * MIN;

/** Browser warnings that aren't faults: never recorded. A new harmless one is a one-line add. */
export const HARMLESS_CLIENT_ERRORS: { name: string; match: RegExp }[] = [
  // Fires when a ResizeObserver callback needs another layout pass; nothing breaks.
  { name: 'ResizeObserver loop', match: /^ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i },
];

/** The beacon's reports (POST /api/client-errors): each person's de-duplicated and rate-limited, kept in memory only. */
export class ClientErrors {
  private seen = new Map<string, { since: number; n: number; last: Map<string, number> }>();

  /** The row to record for `who`'s report, or null when it's a repeat, over the limit, or empty. */
  take(who: string, body: Record<string, unknown> | null, now = Date.now()): string | null {
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
    const message = text(body?.message, 300);
    if (!message || HARMLESS_CLIENT_ERRORS.some((h) => h.match.test(message))) return null;
    // Only the path: the origin and any query (a cache-buster, a token) would split one error into many.
    const source = text(body?.source, 300)
      .replace(/^[a-z]+:\/\/[^/]+/i, '')
      .replace(/[?#].*$/, '');
    const line = typeof body?.line === 'number' && Number.isInteger(body.line) && body.line > 0 ? `:${body.line}` : '';
    const detail = `${body?.kind === 'rejection' ? 'Unhandled rejection: ' : ''}${message}${source ? ` (${source}${line})` : ''}`;
    let p = this.seen.get(who);
    if (!p || now - p.since >= RATE_MS) this.seen.set(who, (p = { since: now, n: 0, last: p?.last ?? new Map() }));
    if (p.n >= RATE) return null;
    const last = p.last.get(detail);
    if (last !== undefined && now - last < DEDUPE_MS) return null;
    for (const [k, at] of p.last) if (now - at >= DEDUPE_MS) p.last.delete(k);
    p.last.set(detail, now);
    p.n++;
    return detail;
  }
}
