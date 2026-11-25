// Standing checks (#1415, the reliability lens's RL9): Citadel's recovery promises, checked at boot and hourly. Each
// check reads the store and the run folders and names every broken promise: a running minion with no turn record, a
// queued message in two places, a due wake that never fired, a hand-off with no ship process, and so on. Report only:
// nothing here repairs anything. A promise seen broken in two passes two minutes apart is a finding; its first sighting
// writes one `standing-check` health row (so it lands in an open incident's timeline), and the Status page lists the
// current ones. The reads run in a worker on a read-only handle, never on the server's thread (Josh, 2026-11-20: "I dont
// want to go too crazy until the halts are dealt with"). The handoff: shared/project/handoffs/qp-reliability-standing-checks.md.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { Store } from './db.ts';
import { nextRun } from './schedules.ts';
import { ZONE } from './pacific.ts';
import { attachEventsIfThere } from './events-db.ts';

/** One broken promise. `key` names it across runs (check, minion, subject), so one stays one health row. */
export interface Finding {
  check: string;
  key: string;
  /** The minion's id, when one minion owns it. */
  ticket: number | null;
  /** The scheme's id, when a scheme and no one minion owns it (a schedule). Neither: Citadel's own (the DB, app turns). */
  project?: number | null;
  /** "#N: what's wrong", for people. */
  text: string;
}

/** What only the server's own memory and /proc know, read on its thread (cheap) just before the worker starts. */
export interface Snapshot {
  at: number;
  /** What each minion's next turn would take (runner.queuedIds: its queue, waits and held mail), as user_message event ids. */
  queued: Record<number, number[]>;
  /** The contraption_turns rows whose process the server holds now. */
  appTurns: number[];
  /** Processes the reaper's scan put in a minion's folders (any minion's: the check keeps the closed ones). */
  procs: { pid: number; ticketId: number; projectId: number; command: string }[];
}

export interface CheckEnv {
  db: DatabaseSync;
  /** The server's data folder: its run/landings/ holds the hand-off files. */
  dataDir: string;
  now: number;
  snap: Snapshot;
  /** Run the weekly `PRAGMA quick_check` this pass. */
  integrity: boolean;
}

/** A due wake or schedule slot this late, or a stuck send, counts as never fired. */
export const LATE_MS = 15 * 60_000;
/** Two starts of one schedule this close together are one slot fired twice. */
const TWICE_WINDOW_MS = 10 * 60_000;
/** How far back the "fired twice" and "gave up" checks look. */
const LOOKBACK_MS = 24 * 3600_000;
/** A hand-off whose ship ended this long ago and still isn't reported. */
const UNREPORTED_MS = 10 * 60_000;
/** A hand-off with no pid yet is starting for this long (host-job.ts's START_GRACE_MS). */
const START_GRACE_MS = 60_000;
/** "Shipped, not live yet" this long with nothing said to the minion since. */
const NOT_LIVE_MS = 3600_000;
/** An app turn's row this young may not be in the snapshot yet. */
const APP_TURN_GRACE_MS = 60_000;
/** The outbox's words for a handed message the runner no longer holds (src/outbox.ts). */
const RUNNER_DROPPED = 'the runner dropped it before its turn started';

const turnKey = (id: number) => `turn:${id}`;

function setting<T>(db: DatabaseSync, key: string): T | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

/** "#N (Scheme)" for a minion id, or "minion <id>" when it has no number or is gone. */
function namer(db: DatabaseSync): (id: number) => string {
  const q = db.prepare('SELECT t.number, p.name FROM tickets t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?');
  const seen = new Map<number, string>();
  return (id) => {
    if (!seen.has(id)) {
      const r = q.get(id) as { number: number | null; name: string | null } | undefined;
      seen.set(id, r?.number != null ? `#${r.number}${r.name ? ` (${r.name})` : ''}` : `minion ${id}`);
    }
    return seen.get(id)!;
  };
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

type Check = { name: string; promise: string; run(env: CheckEnv, name: (id: number) => string): Finding[] };

/** The named list: what each check promises, in the order the reliability lens's recovery table gives them. */
export const CHECKS: Check[] = [
  {
    name: 'turn-record',
    promise: 'A running minion has a turn record and a folder.',
    run({ db }, name) {
      const out: Finding[] = [];
      for (const t of db.prepare("SELECT id FROM tickets WHERE status = 'running'").all() as { id: number }[]) {
        const turn = setting<{ dir?: string }>(db, turnKey(t.id));
        const why = !turn ? 'shows running but has no turn record' : !turn.dir ? 'shows running but its turn record names no folder' : !isDir(turn.dir) ? `shows running but its turn folder ${turn.dir} is gone` : null;
        if (why) out.push({ check: 'turn-record', key: `turn-record:${t.id}`, ticket: t.id, text: `${name(t.id)} ${why}.` });
      }
      return out;
    },
  },
  {
    name: 'one-place',
    promise: 'A queued message is in exactly one place: the queue, a wait or held mail.',
    run({ db, snap }, name) {
      const out: Finding[] = [];
      // Twice in what the next turn takes (the runner's queue, its waits and held mail together): it would be sent twice.
      for (const [ticket, ids] of Object.entries(snap.queued)) {
        const n = new Map<number, number>();
        for (const id of ids) n.set(id, (n.get(id) ?? 0) + 1);
        for (const [id, times] of n) {
          if (times > 1) out.push({ check: 'one-place', key: `one-place:${ticket}:${id}`, ticket: Number(ticket), text: `${name(Number(ticket))}: message ${id} waits ${times} times in what its next turn takes, so it would be sent ${times} times.` });
        }
      }
      // In no place: a delivery handed to the runner that the runner lost, again and again (the outbox re-sends it each time).
      const lost = db.prepare("SELECT id, to_id, attempts FROM deliveries WHERE to_kind = 'minion' AND state IN ('waiting', 'sending') AND attempts >= 2 AND last_error = ?").all(RUNNER_DROPPED) as { id: number; to_id: number; attempts: number }[];
      for (const r of lost) out.push({ check: 'one-place', key: `one-place:delivery:${r.id}`, ticket: r.to_id, text: `${name(r.to_id)}: delivery #${r.id} was handed to the runner and lost before its turn started, ${r.attempts} times.` });
      return out;
    },
  },
  {
    name: 'fired-once',
    promise: 'A due timed wake and a due schedule slot fired once, not zero or two times.',
    run({ db, now }, name) {
      const out: Finding[] = [];
      const late = now - LATE_MS;
      const since = now - LOOKBACK_MS;
      const target = (r: { to_kind: string; to_id: number }) => (r.to_kind === 'minion' ? name(r.to_id) : `the Taskmaster of scheme ${r.to_id}`);
      // Zero: due and not sent (the outbox ticks every few seconds), or given up on.
      for (const r of db.prepare("SELECT id, kind, to_kind, to_id, state, due FROM deliveries WHERE state IN ('waiting', 'sending') AND due IS NOT NULL AND due < ?").all(late) as { id: number; kind: string; to_kind: string; to_id: number; state: string; due: number }[]) {
        out.push({ check: 'fired-once', key: `fired-once:delivery:${r.id}`, ticket: r.to_kind === 'minion' ? r.to_id : null, text: `${target(r)}: delivery #${r.id} (${r.kind}) was due ${minutes(now - r.due)} ago and is still ${r.state}.` });
      }
      for (const r of db.prepare("SELECT id, kind, to_kind, to_id, attempts, last_error FROM deliveries WHERE state = 'failed' AND updated_at >= ?").all(since) as { id: number; kind: string; to_kind: string; to_id: number; attempts: number; last_error: string | null }[]) {
        out.push({ check: 'fired-once', key: `fired-once:delivery:${r.id}`, ticket: r.to_kind === 'minion' ? r.to_id : null, text: `${target(r)}: delivery #${r.id} (${r.kind}) never arrived; the outbox gave up after ${r.attempts} tries${r.last_error ? ` (${r.last_error})` : ''}.` });
      }
      // Two: one delivery's text in a minion's chat twice. A repeat the server marked as maybe repeating is a told repeat.
      const sent = db.prepare("SELECT id, to_id, created_at FROM deliveries WHERE state = 'sent' AND to_kind = 'minion' AND created_at >= ?").all(since) as { id: number; to_id: number; created_at: number }[];
      const msgs = db.prepare("SELECT data FROM events WHERE ticket_id = ? AND kind = 'user_message' AND created_at >= ?");
      for (const r of sent) {
        const tail = `(delivery #${r.id})`;
        let n = 0;
        for (const e of msgs.iterate(r.to_id, r.created_at) as Iterable<{ data: string }>) {
          if (!e.data.includes(tail)) continue;
          try {
            if (
              String((JSON.parse(e.data) as { text?: string }).text ?? '')
                .trimEnd()
                .endsWith(tail)
            )
              n++;
          } catch {
            /* not ours */
          }
        }
        if (n > 1) out.push({ check: 'fired-once', key: `fired-once:twice:${r.id}`, ticket: r.to_id, text: `${name(r.to_id)}: delivery #${r.id} arrived ${n} times.` });
      }
      // Schedules: a slot not fired (late, or its start failed), or fired twice.
      for (const s of db.prepare('SELECT s.id, s.project_id, s.name, s.next_run_at, s.last_error, p.name AS scheme FROM schedules s LEFT JOIN projects p ON p.id = s.project_id WHERE s.paused = 0 AND ((s.next_run_at IS NOT NULL AND s.next_run_at < ?) OR s.last_error IS NOT NULL)').all(late) as {
        id: number;
        project_id: number;
        name: string;
        next_run_at: number | null;
        last_error: string | null;
        scheme: string | null;
      }[]) {
        const which = `The schedule "${s.name}"${s.scheme ? ` (${s.scheme})` : ''}`;
        // A failed start moves next_run_at on, so the slot it missed is only in last_error (schedules.ts, ran).
        if (s.last_error) out.push({ check: 'fired-once', key: `fired-once:schedule-error:${s.id}`, ticket: null, project: s.project_id, text: `${which}: its last slot didn't start (${s.last_error.slice(0, 160)}).` });
        else if (s.next_run_at !== null) out.push({ check: 'fired-once', key: `fired-once:schedule:${s.id}:${s.next_run_at}`, ticket: null, project: s.project_id, text: `${which} was due ${minutes(now - s.next_run_at)} ago and hasn't run.` });
      }
      // Twice: two minions it started with no slot between them. By title, since a start that crashed before its
      // slot was marked (schedules.ts: newMinion, then ran) has no brief yet, and its retry makes the second.
      const all = db.prepare('SELECT id, project_id, name, cron FROM schedules').all() as { id: number; project_id: number; name: string; cron: string }[];
      const started = db.prepare("SELECT id, created_at FROM tickets WHERE project_id = ? AND title = ? AND kind = 'ticket' AND created_at >= ? ORDER BY created_at");
      for (const sc of all) {
        if (all.some((o) => o.id !== sc.id && o.project_id === sc.project_id && o.name === sc.name)) continue; // two of one name: can't tell whose
        const list = started.all(sc.project_id, sc.name, since) as { id: number; created_at: number }[];
        for (let i = 1; i < list.length; i++) {
          const [a, b] = [list[i - 1], list[i]];
          if (b.created_at - a.created_at > TWICE_WINDOW_MS) continue;
          let slot: number | null = null;
          try {
            slot = nextRun(sc.cron, a.created_at);
          } catch {
            /* a cron that doesn't parse: no slot to tell them apart */
          }
          if (slot !== null && slot <= b.created_at) continue; // a schedule this frequent: two slots
          out.push({ check: 'fired-once', key: `fired-once:schedule-twice:${a.id}:${b.id}`, ticket: b.id, text: `The schedule "${sc.name}" started ${name(a.id)} and ${name(b.id)} ${minutes(b.created_at - a.created_at)} apart: one slot fired twice.` });
        }
      }
      return out;
    },
  },
  {
    name: 'handoff-process',
    promise: 'A hand-off file has a ship process or a result.',
    run({ dataDir, now }, name) {
      const out: Finding[] = [];
      const root = join(resolve(dataDir), 'run', 'landings');
      let names: string[];
      try {
        names = readdirSync(root).filter((n) => /^\d+$/.test(n));
      } catch (err: any) {
        if (err?.code === 'ENOENT') return out; // no ship has run on this box yet
        throw err; // unreadable: an error line, never "All kept"
      }
      for (const n of names) {
        const dir = join(root, n);
        if (!isFile(join(dir, 'handoff.json'))) continue;
        const id = Number(n);
        const code = readText(join(dir, 'code'));
        if (code !== null && code.trim() !== '') {
          const ended = mtime(join(dir, 'code'));
          if (ended !== null && now - ended > UNREPORTED_MS) out.push({ check: 'handoff-process', key: `handoff-process:${id}:${ended}`, ticket: id, text: `${name(id)}: its ship ended ${minutes(now - ended)} ago and was never reported.` });
        } else if (!jobAlive(dir, now)) {
          out.push({ check: 'handoff-process', key: `handoff-process:${id}:none`, ticket: id, text: `${name(id)}: it handed off a ship, but no ship process runs and none has ended.` });
        }
      }
      return out;
    },
  },
  {
    name: 'shipped-live',
    promise: 'A ship that said "shipped, not live yet" is live within an hour, or its minion was told why not.',
    run({ db, now }, name) {
      const out: Finding[] = [];
      // Counted from the ship line (land.ts writes it, then sets pending-deploy), else the newest event for a
      // minion that set the state itself; a chat that goes on after it doesn't reset the clock.
      const shipped = db.prepare("SELECT id, created_at FROM events WHERE ticket_id = ? AND kind = 'note' AND (json_extract(data, '$.text') LIKE 'Shipped %' OR json_extract(data, '$.text') LIKE 'Merged %') ORDER BY id DESC LIMIT 1");
      const last = db.prepare('SELECT id, created_at FROM events WHERE ticket_id = ? ORDER BY id DESC LIMIT 1');
      // Runner.deployLive's notes: it went live and the minion was told why it stays open (a card, a message).
      const told = db.prepare("SELECT 1 FROM events WHERE ticket_id = ? AND kind = 'note' AND id > ? AND json_extract(data, '$.text') LIKE 'The deploy is live%' LIMIT 1");
      for (const t of db.prepare("SELECT id FROM tickets WHERE state = 'pending-deploy' AND status NOT IN ('closed', 'running')").all() as { id: number }[]) {
        const from = (shipped.get(t.id) ?? last.get(t.id)) as { id: number; created_at: number } | undefined;
        if (!from || now - from.created_at <= NOT_LIVE_MS || told.get(t.id, from.id)) continue;
        out.push({ check: 'shipped-live', key: `shipped-live:${t.id}`, ticket: t.id, text: `${name(t.id)} has waited ${minutes(now - from.created_at)} for its ship to go live, and nothing has told it why not.` });
      }
      return out;
    },
  },
  {
    name: 'app-turn-ended',
    promise: "An app turn's row is ended once its process is gone.",
    run({ db, snap }) {
      const live = new Set(snap.appTurns);
      const rows = db.prepare('SELECT t.id, t.started_at, c.name FROM contraption_turns t LEFT JOIN contraptions c ON c.id = t.contraption_id WHERE t.ended_at IS NULL AND t.started_at < ?').all(snap.at - APP_TURN_GRACE_MS) as { id: number; started_at: number; name: string | null }[];
      return rows.filter((r) => !live.has(r.id)).map((r) => ({ check: 'app-turn-ended', key: `app-turn-ended:${r.id}`, ticket: null, text: `App turn ${r.id}${r.name ? ` (${r.name})` : ''} is still open, but no process runs it.` }));
    },
  },
  {
    name: 'closed-processes',
    promise: "No process runs from a closed minion's folders.",
    run({ db, snap }, name) {
      const q = db.prepare("SELECT 1 FROM tickets WHERE id = ? AND project_id = ? AND kind <> 'coordinator' AND status = 'closed'");
      return snap.procs.filter((p) => q.get(p.ticketId, p.projectId)).map((p) => ({ check: 'closed-processes', key: `closed-processes:${p.ticketId}:${p.pid}`, ticket: p.ticketId, text: `${name(p.ticketId)} is closed, but pid ${p.pid} still runs in its folders: ${p.command}` }));
    },
  },
  {
    name: 'db-integrity',
    promise: 'The live database passes PRAGMA quick_check (weekly, at night).',
    run({ db, integrity }) {
      if (!integrity) return [];
      const rows = db.prepare('PRAGMA quick_check').all() as Record<string, string>[];
      const lines = rows.map((r) => String(Object.values(r)[0]));
      if (lines.length === 1 && lines[0] === 'ok') return [];
      return [{ check: 'db-integrity', key: 'db-integrity', ticket: null, text: `The live database fails PRAGMA quick_check: ${lines.slice(0, 5).join('; ')}${lines.length > 5 ? ` (and ${lines.length - 5} more)` : ''}.` }];
    },
  },
];

/** Every check over one read of the store. A check that throws becomes a finding of its own, not a lost run. */
export function runChecks(env: CheckEnv): Finding[] {
  const name = namer(env.db);
  return CHECKS.flatMap((c) => {
    try {
      return c.run(env, name);
    } catch (err: any) {
      return [{ check: c.name, key: `${c.name}:error`, ticket: null, text: `The check itself failed: ${String(err?.message ?? err).slice(0, 300)}` }];
    }
  });
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function mtime(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}
function readText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** host-job.ts's liveness, read only: the pid's command line names the folder, or the job started under a minute ago. */
function jobAlive(dir: string, now: number): boolean {
  const pid = Number(readText(join(dir, 'pid')));
  if (!(pid > 0)) return now - Number(readText(join(dir, 'started'))) < START_GRACE_MS;
  const cmd = readText(`/proc/${pid}/cmdline`);
  return !!cmd && cmd.split('\0').some((a) => a === dir || a.startsWith(`${dir}/`));
}

/** The weekly integrity check runs between 03:00 and 05:00 Pacific, once six days have passed since the last. */
export function integrityDue(now: number, lastAt: number | null): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', hourCycle: 'h23' }).format(now));
  return hour >= 3 && hour < 5 && (lastAt === null || now - lastAt > 6 * 86_400_000);
}

/** The findings now, kept in a setting: the Status page and incidents read it, and each run diffs against it. */
export interface Kept {
  ranAt: number;
  findings: (Finding & { since: number })[];
  integrityAt: number | null;
  error: string | null;
}
export const KEPT = 'standing-checks';
export const HEALTH_KIND = 'standing-check';

/** The current findings, for the Status page and incidents. */
export function keptChecks(store: Pick<Store, 'getSetting'>): Kept | null {
  return store.getSetting<Kept>(KEPT);
}

/** The Status page's tile: the promises checked, and the last run's findings (null before the first). */
export type StandingStatus = { checks: { name: string; promise: string }[]; last: Kept | null };
export function standingStatus(store: Pick<Store, 'getSetting' | 'getTicket'>, canSee: (projectId: number) => boolean, citadel: boolean): StandingStatus {
  const last = keptChecks(store);
  // Schemes stay apart (ADR 0015): a viewer gets the findings of schemes they see, and Citadel's own only in Citadel's.
  const shown = (f: Finding) => {
    const project = f.ticket != null ? store.getTicket(f.ticket)?.project_id : f.project;
    return project != null ? canSee(project) : citadel;
  };
  return { checks: CHECKS.map((c) => ({ name: c.name, promise: c.promise })), last: last && { ...last, findings: last.findings.filter(shown), error: citadel ? last.error : null } };
}

/** Two passes this far apart: a promise broken in both is a finding (a turn starting or a delivery in flight is not). */
export const CONFIRM_MS = 2 * 60_000;
/** A worker past this is stopped (the weekly quick_check on a 2 GB file takes about a minute). */
const WORKER_MAX_MS = 10 * 60_000;

export interface StandingDeps {
  store: Store;
  dataDir: string;
  commit: string | null;
  /** The server's memory, read on its thread: each open minion's queued message ids, the app turns it holds, the reaper's scan. */
  queued: (ticketIds: number[]) => Record<number, number[]>;
  appTurns: () => number[];
  procs: () => Promise<Snapshot['procs']>;
  now?: () => number;
  confirmMs?: number;
  wait?: (ms: number) => Promise<void>;
}

export class StandingChecks {
  private running: Promise<void> | null = null;
  private readonly d: StandingDeps;

  constructor(d: StandingDeps) {
    this.d = d;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /**
   * One run, the part the Jobs tile times: a pass in a worker. A pass that finds something, or a night the integrity check
   * is due, starts the confirm pass a couple of minutes later behind it (settled()), which keeps the findings.
   */
  async run(): Promise<void> {
    if (this.running) return;
    const kept = keptChecks(this.d.store);
    let first: Finding[];
    try {
      first = await this.pass(await this.snapshot(), false);
    } catch (err: any) {
      this.keep(kept?.findings ?? [], kept?.integrityAt ?? null, String(err?.message ?? err).slice(0, 300));
      throw err;
    }
    const integrity = integrityDue(this.now(), kept?.integrityAt ?? null);
    if (!first.length && !integrity) return this.keep(this.lastIntegrity(kept), kept?.integrityAt ?? null, null);
    this.running = this.confirm(first, integrity, kept)
      .catch((err: any) => {
        console.error('Standing checks: the confirm pass failed:', err);
        this.keep(kept?.findings ?? [], kept?.integrityAt ?? null, String(err?.message ?? err).slice(0, 300));
      })
      .finally(() => (this.running = null));
  }

  /** The confirm pass behind the last run, if one is waiting (tests). */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async confirm(first: Finding[], integrity: boolean, kept: Kept | null) {
    await (this.d.wait ?? ((ms) => sleep(ms, undefined, { ref: false })))(this.d.confirmMs ?? CONFIRM_MS);
    const seen = new Set(first.map((f) => f.key));
    const found = (await this.pass(await this.snapshot(), integrity)).filter((f) => seen.has(f.key) || f.check === 'db-integrity');
    if (!integrity) found.push(...this.lastIntegrity(kept));
    this.keep(found, integrity ? this.now() : (kept?.integrityAt ?? null), null);
  }

  /** Between weekly integrity checks the last verdict stands. */
  private lastIntegrity(kept: Kept | null): Finding[] {
    return (kept?.findings ?? []).filter((f) => f.check === 'db-integrity');
  }

  private async snapshot(): Promise<Snapshot> {
    const procs = await this.d.procs();
    const open = (this.d.store.db.prepare("SELECT id FROM tickets WHERE status <> 'closed'").all() as { id: number }[]).map((t) => t.id);
    return { at: this.now(), queued: this.d.queued(open), appTurns: this.d.appTurns(), procs };
  }

  private pass(snap: Snapshot, integrity: boolean): Promise<Finding[]> {
    const { store, dataDir } = this.d;
    const now = snap.at;
    if (store.path === ':memory:') return Promise.resolve(runChecks({ db: store.db, dataDir, now, snap, integrity }));
    return new Promise((ok, fail) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { standingChecks: { path: store.path, dataDir, now, snap, integrity } } });
      const timer = setTimeout(() => void worker.terminate(), WORKER_MAX_MS).unref();
      worker.once('message', (r: Finding[]) => {
        clearTimeout(timer);
        ok(r);
      });
      worker.once('error', (err) => {
        clearTimeout(timer);
        fail(err);
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        fail(new Error(`the standing checks worker stopped (exit code ${code}) before it finished`));
      });
    });
  }

  private keep(found: Finding[], integrityAt: number | null, error: string | null) {
    const { store, commit } = this.d;
    const now = this.now();
    const before = new Map((keptChecks(store)?.findings ?? []).map((f) => [f.key, f.since]));
    const findings: Kept['findings'] = [];
    const keys = new Set<string>();
    for (const f of found) {
      if (keys.has(f.key)) continue;
      keys.add(f.key);
      const since = before.get(f.key);
      if (since === undefined && !error) store.addHealthEvent(HEALTH_KIND, now, commit, `${f.check}\n${f.text}`);
      findings.push({ ...f, since: since ?? now });
    }
    store.setSetting(KEPT, { ranAt: now, findings, integrityAt, error } satisfies Kept);
  }
}

if (!isMainThread && workerData?.standingChecks) {
  const { path, dataDir, now, snap, integrity } = workerData.standingChecks as { path: string; dataDir: string; now: number; snap: Snapshot; integrity: boolean };
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  attachEventsIfThere(db, path);
  try {
    parentPort!.postMessage(runChecks({ db, dataDir, now, snap, integrity }));
  } finally {
    db.close();
  }
}
