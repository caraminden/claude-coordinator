// What a minion waits on (#544): its place in the land line and that landing's phase, a heavy slot, or
// the idle restart. One shape for every kind, read from what's already on disk or in the server: the
// land line's ticket files (tools/deploy-queue.sh), citadel-heavy's slot and waiter files, and the ship
// line's "deploying" stage. CI runs (#546, src/ci-wait.ts) fill the same record: a PR's run, and a landing's CI gate;
// a test run's file counts (#545, tools/progress-reporter.ts) fill in done and total.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './db.ts';
import type { Ship } from './branch.ts';
import type { CiRuns } from './ci-wait.ts';
import type { LandSeen } from './ci-health.ts';

export interface Wait {
  /** Its source: land (the land line and its landing), heavy (a heavy slot), ci (a PR's CI run), restart. */
  kind: string;
  /** Where it is: a landing's stage (line, rebase, test, deploy, restart) or a lone wait's own (slot, run; CI's queued, jobs, passed, failed, cancelled). */
  stage: string;
  /** The row's badge, as short as it gets: "line · 2nd". */
  chip: string;
  /** The readout's detail: "2nd in line, behind #513 (testing)". */
  text: string;
  /** A shorter detail for the one-line readout and the list row, when the text runs long: "CI: the full suite" (#630). */
  brief?: string;
  /** When this stage began, ms. */
  since: number;
  /** About how long it takes, s: the median of its last five, or an estimate; null when nothing is known. */
  usual: number | null;
  done?: number;
  total?: number;
  /** When it ended, ms: a CI run's pass or fail, shown a while after; its time stops there. */
  ended?: number;
}

/** A landing's stages, in order: a wait at one of these shows the track. */
export const TRACK = ['line', 'rebase', 'test', 'deploy', 'restart', 'live'];
const TYPICAL_LANDING = 300; // tools/deploy-queue.sh's QUEUE_TYPICAL, until landings have been timed

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

export const ordinal = (n: number) => (n === 1 ? 'next' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);
const read = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const mtime = (f: string) => { try { return statSync(f).mtimeMs; } catch { return null; } };
const files = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };

/** "<pid> <start time>" as tools/deploy-queue.sh's queue_proc writes it, when that process still runs. */
export function procAlive(pidStart: string): boolean {
  const [pid, start] = pidStart.split(' ');
  if (!/^\d+$/.test(pid ?? '')) return false;
  const stat = read(`/proc/${pid}/stat`);
  if (!stat) return false;
  const f = stat.slice(stat.lastIndexOf(') ') + 2).split(' '); // the command's name may hold spaces
  return !/^[ZXx]$/.test(f[0]) && f[19] === start;
}

/** A test run's files done, of how many, and the newest one running (tools/progress-reporter.ts). */
export interface TestCounts { done: number; total: number; file: string }

/** The counts in a progress file written since `since` (ms): an older one is a run before this one. */
export function readTestCounts(f: string, since: number): TestCounts | null {
  const at = mtime(f), text = read(f);
  if (at == null || at < since || text == null) return null;
  const [done, total, file = ''] = text.split('\n');
  const d = Number(done), t = Number(total);
  return /^\d+$/.test(done) && /^\d+$/.test(total) && t > 0 && d <= t ? { done: d, total: t, file } : null;
}

const countsText = (c: TestCounts) => `${c.done} of ${c.total} files${c.file ? ` · ${c.file}` : ''}`;

/** `orders`: its landing follows queue/.order (deploy-queue.sh's 5th ticket line, #1002); one from an older branch doesn't. */
export interface LandTicket { seq: number; proc: string; got: number; label: string; phase: string; mtime: number; orders?: boolean; tests?: TestCounts | null }

/** The waiting tickets' numbers in the order people set on the Releases page (#1002): queue/.order, as deploy-queue.sh reads it. */
const readOrder = (q: string) => (read(join(q, '.order')) ?? '').split('\n').filter((l) => /^\d{10}$/.test(l)).map(Number);

/**
 * The land line in order, its gone processes left out, and the last landings' lengths in s: the holder first, then the
 * waiters .order names in its order, then the rest in arrival order (tools/deploy-queue.sh's queue_lock). The holder running
 * the tests gets tools/run-tests.sh's counts: land.sh's run logs to land-test.log, deploy.sh's to test.log.
 */
export function readLandLine(stateDir: string, alive = procAlive): { line: LandTicket[]; took: number[] } {
  const q = join(stateDir, 'queue');
  const line = readQueue(q, 4, alive);
  for (const t of line) {
    const log = /^running the tests/.test(t.phase) ? 'land-test' : /^deploying: running the tests/.test(t.phase) ? 'test' : null;
    if (t.got > 0 && log) t.tests = readTestCounts(join(stateDir, `${log}.progress`), t.mtime);
  }
  const took = (read(join(q, '.took')) ?? '').split('\n').filter((l) => /^\d+$/.test(l)).map(Number);
  return { line, took };
}

/**
 * A queue folder's tickets in line order, its gone processes left out: deploy-queue.sh's queue/ (the "order" line is
 * its 5th, `orderAt` 4) or the kit land template's <.git>/land-queue (its 8th, #1007). Both read .order the same way.
 */
export function readQueue(q: string, orderAt: number, alive = procAlive): LandTicket[] {
  const line: LandTicket[] = [];
  const order = readOrder(q);
  const rank = (t: LandTicket) => (t.got > 0 ? -1 : order.includes(t.seq) ? order.indexOf(t.seq) : order.length);
  for (const name of files(q).filter((n) => /^\d+$/.test(n)).sort()) {
    const f = join(q, name), text = read(f), at = mtime(f);
    if (text == null || at == null) continue;
    const l = text.split('\n');
    const [proc = '', got = '0', label = '', phase = ''] = l;
    if (!alive(proc)) continue;
    line.push({ seq: Number(name), proc, got: Number(got) || 0, label, phase, mtime: at, orders: l[orderAt] === 'order' });
  }
  return line.sort((a, b) => rank(a) - rank(b) || a.seq - b.seq);
}

/**
 * Write a queue's .order (#1002, #1007): `seqs` first, the waiters it leaves out behind them in the line's order; a
 * holder, a ticket no longer waiting or one from an older branch is left out (an older one waits for every lower
 * ticket, so ranking it ahead of one could deadlock). `note` says who moved what, for the waiters' output. Returns the order written.
 */
export function writeOrder(q: string, line: LandTicket[], seqs: number[], note: string): number[] {
  const waiting = line.filter((t) => t.got === 0 && t.orders).map((t) => t.seq);
  const order = [...new Set([...seqs.filter((n) => waiting.includes(n)), ...waiting])];
  if (!order.length) throw new Error('No landing waiting in line to reorder');
  const f = join(q, '.order'), tmp = `${f}.tmp${process.pid}`;
  // By a rename, as the queue scripts write their tickets, so a waiter never reads half of it.
  writeFileSync(tmp, `# ${note.replace(/[\x00-\x1f]+/g, ' ')}\n${order.map((n) => String(n).padStart(10, '0')).join('\n')}\n`);
  renameSync(tmp, f);
  return order;
}

/** A landing's phase (queue_phase's words in land.sh and deploy.sh) as its stage, badge word and detail. */
export function landPhase(phase: string): { stage: string; word: string; key: string; text: string } {
  const p = phase.replace(/ since \d\d:\d\d$/, '');
  if (/^waiting for CI/.test(p)) return { stage: 'test', word: 'CI', key: 'ci', text: 'waiting for CI on the rebased commit' };
  // land.sh runs the suite itself only when CI couldn't answer (its CI FALLBACK, #523).
  if (/^running the tests/.test(p)) return { stage: 'test', word: 'tests', key: 'tests', text: 'CI fell back: running the full suite on perigee' };
  if (/^deploying/.test(p)) return { stage: 'deploy', word: 'deploy', key: 'deploy', text: p.replace(/^deploying(: )?/, '') || 'deploying' };
  return { stage: 'rebase', word: 'rebase', key: 'rebase', text: p === 'starting' ? 'starting' : 'rebasing onto main' };
}

// The one-line readout's words for a landing's test phases (#630): the stage and its count say the rest, and the
// suite's file counts fill its piece of the track.
const BRIEF: Record<string, string> = { ci: 'CI: starting', tests: 'full suite on perigee' };
const HEAD_WORD: Record<string, string> = { rebase: 'rebasing', ci: 'waiting for CI', tests: 'testing', deploy: 'deploying' };

/** Each land-line ticket's wait, by its label (a branch, or "tools/deploy.sh"). `name` turns a label into "#513". */
export function landWaits(line: LandTicket[], took: number[], now: number, usual: (key: string) => number | null, name: (label: string) => string): Map<string, Wait> {
  const out = new Map<string, Wait>();
  const typical = median(took) ?? TYPICAL_LANDING;
  const holder = line.find((t) => t.got > 0);
  line.forEach((t, i) => {
    if (t.got > 0) {
      const ph = landPhase(t.phase), c = t.tests;
      out.set(t.label, {
        kind: 'land', stage: ph.stage, since: t.mtime, usual: usual(`land:${ph.key}`),
        chip: `land · ${c ? `${c.done}/${c.total}` : ph.word}`, text: c ? `${ph.text}: ${countsText(c)}` : ph.text,
        ...(BRIEF[ph.key] && { brief: BRIEF[ph.key] }), ...(c && { done: c.done, total: c.total }),
      });
      return;
    }
    const ahead = line.slice(0, i);
    const place = ordinal(ahead.length + 1);
    let text: string, usualS: number | null = null;
    if (!ahead.length) {
      text = 'next in line, waiting for a queued restart or an older landing to let go of the lock';
    } else {
      const head = ahead[0], word = head.got > 0 ? HEAD_WORD[landPhase(head.phase).key] : 'waiting';
      text = `${place} in line, behind ${name(head.label)} (${word})${ahead.length > 1 ? ` and ${ahead.length - 1} more` : ''}`;
      // From when it joined: what was left of the holder's landing then, and a whole one for each other waiter
      // ahead. Fixed while the line stands, so a holder running long turns the bar amber.
      const joined = t.mtime / 1000;
      usualS = Math.round(ahead.reduce((s, a) => s + (a === holder ? Math.max(0, typical - Math.max(0, joined - a.got)) : typical), 0));
    }
    out.set(t.label, { kind: 'land', stage: 'line', chip: `line · ${place}`, text, since: t.mtime, usual: usualS });
  });
  return out;
}

export interface HeavyJob { who: string; what: string; since: number; reason?: string; slot?: number; tests?: TestCounts | null }

/** Whether a heavy slot's lock is held: a holder killed past its trap leaves its .who behind, but not the lock. */
export function slotHeld(file: string): boolean {
  // The probe holds a free slot for a moment, so a job taking it then waits one more poll (2 s) at most.
  const r = spawnSync('flock', ['-n', '-E', '75', file, 'true'], { timeout: 2000 });
  return r.status !== 0; // 75: held; no flock at all: trust the file
}

const STALE_WAITER_MS = 60_000; // citadel-heavy freshens a waiter's file at least every 20 s

/**
 * citadel-heavy's holders (slot-N.who: "who: what (since HH:MM, pid N)", while slot-N's lock is held) and
 * waiters (wait-<pid>-<random>: who, what, since s, reason; freshened while it waits). A holder running a Node test
 * suite gets its counts from slot-N.progress, which citadel-heavy has tools/citadel-node write.
 */
export function readHeavy(dir: string, now = Date.now(), held = slotHeld): { holders: HeavyJob[]; waiters: HeavyJob[] } {
  const holders: HeavyJob[] = [], waiters: HeavyJob[] = [];
  for (const name of files(dir)) {
    const f = join(dir, name);
    let m = name.match(/^slot-(\d+)\.who$/);
    if (m) {
      const text = read(f)?.trim(), at = mtime(f);
      const w = text?.match(/^(.*?): (.*) \(since \d\d:\d\d, pid \d+\)$/);
      if (w && at != null && held(join(dir, `slot-${m[1]}`))) {
        holders.push({ who: w[1], what: w[2], since: at, slot: Number(m[1]) + 1, tests: readTestCounts(join(dir, `slot-${m[1]}.progress`), at) });
      }
      continue;
    }
    if (/^wait-\d+-\d+$/.test(name) && now - (mtime(f) ?? 0) < STALE_WAITER_MS) {
      const [who, what, since, reason] = (read(f) ?? '').split('\n');
      if (who && Number(since)) waiters.push({ who, what, since: Number(since) * 1000, reason });
    }
  }
  waiters.sort((a, b) => a.since - b.since);
  return { holders, waiters };
}

/** Each heavy job's wait, by its who ("Citadel #544 (cara)"). */
export function heavyWaits({ holders, waiters }: ReturnType<typeof readHeavy>, usual: (key: string) => number | null, name: (who: string) => string): Map<string, Wait> {
  const out = new Map<string, Wait>();
  for (const h of holders) {
    const c = h.tests, text = `running in heavy slot ${h.slot}: ${h.what}`;
    out.set(h.who, {
      kind: 'heavy', stage: 'run', since: h.since, usual: usual(`heavy:run:${h.what}`),
      // Only a Node suite run through tools/citadel-node has counts; any other run shows elapsed against usual alone.
      chip: c ? `tests ${c.done}/${c.total}` : 'heavy run', text: c ? `${text}: ${countsText(c)}` : text,
      ...(c && { done: c.done, total: c.total }),
    });
  }
  waiters.forEach((w, i) => {
    const place = ordinal(i + 1);
    const busy = holders.map((h) => name(h.who)).join(', ');
    const text = w.reason === 'load'
      ? 'a heavy slot is free, but the box is busy: it starts when the load eases, or within 5 min'
      : `${place} in line for a heavy slot${busy ? `, all held (${busy})` : ''}`;
    out.set(w.who, { kind: 'heavy', stage: 'slot', chip: w.reason === 'load' ? 'slot · busy box' : `slot · ${place}`, text, since: w.since, usual: usual('heavy:slot') });
  });
  return out;
}

type CiView = NonNullable<ReturnType<CiRuns['view']>>;

/** A landing waiting for CI, with the run's jobs and steps; its usual stays the landing's own. */
export function landCi(w: Wait, ci: CiView): Wait {
  const short = `CI ${ci.short.replace(/^step /, '')}`;
  const text = ci.stage === 'queued' ? `waiting for CI: ${ci.text}; if none starts it soon, the suite runs on perigee` : `waiting for CI: ${ci.text}`;
  // The line keeps one counter, the landing's stage (Cara: "are the tests on step 3/6 or 10/13?"): CI's steps fill its piece.
  return { ...w, chip: `land · ${short}`, text, brief: `CI: ${ci.step ?? ci.short}`, ...(ci.total ? { done: ci.done, total: ci.total } : {}) };
}

/** A minion's PR waiting on its CI run. */
export function prCi(ci: CiView): Wait {
  const w: Wait = { kind: 'ci', stage: ci.stage, chip: `CI · ${ci.short}`, text: `${ci.what} · ${ci.text}`, since: ci.since, usual: ci.usual };
  if (ci.total) Object.assign(w, { done: ci.done, total: ci.total });
  if (ci.ended) w.ended = ci.ended;
  return w;
}

const USUALS = 'wait-usual'; // { [key]: the last five lengths in s }
// { [ticket id]: when its restart wait began, ms }: kept, as the restart it waits for restarts this server.
const RESTARTS = 'wait-restart-since';

export interface WaitDeps {
  store: Store;
  /** The deploy lock's state folder (<live checkout's git dir>/cc-deploy), or null outside one. */
  deployState: string | null;
  /** citadel-heavy's folder (CITADEL_HEAVY_DIR). */
  heavyDir: string;
  ship: (ticketId: number) => Ship | null;
  interruptible: () => number;
  /** Called with a minion whose wait changed, to re-send its row. */
  changed: (ticketId: number) => void;
  now?: () => number;
  alive?: (proc: string) => boolean;
  held?: (slotFile: string) => boolean;
  /** CI runs (#546): a landing's CI gate and a minion's PR; its repo's "owner/name" for the landing's. */
  ci?: CiRuns;
  ciSlug?: () => string | null;
  /** Every poll: the land line with each landing's phase and its gate run, for the land alarm (#561, CiHealth.land). */
  landLine?: (seen: LandSeen[], now: number) => void;
}

/** The waits of every minion, polled from disk; a change re-sends that minion's row. */
export class Waits {
  private current = new Map<number, Wait & { key?: string }>();
  private restartSince: Map<number, number>;
  private shown = new Map<number, string>();
  private d: WaitDeps;
  constructor(d: WaitDeps) {
    this.d = d;
    this.restartSince = new Map(Object.entries(d.store.getSetting<Record<string, number>>(RESTARTS) ?? {}).map(([k, v]) => [Number(k), v]));
  }

  private saveRestarts() {
    this.d.store.setSetting(RESTARTS, Object.fromEntries(this.restartSince));
  }

  private now = () => (this.d.now ?? Date.now)();

  usual = (key: string): number | null => median(this.d.store.getSetting<Record<string, number[]>>(USUALS)?.[key] ?? []);

  private record(key: string, seconds: number) {
    if (!(seconds > 0)) return;
    const all = this.d.store.getSetting<Record<string, number[]>>(USUALS) ?? {};
    all[key] = [...(all[key] ?? []), Math.round(seconds)].slice(-5);
    this.d.store.setSetting(USUALS, all);
  }

  /** A minion's wait, for its row (Runner.view). */
  wait = (ticketId: number): Wait | null => {
    const w = this.current.get(ticketId);
    const ci = this.d.ci?.view(ticketId);
    if (w) {
      const { key, ...rest } = w;
      return key === 'land:ci' && ci ? landCi(rest, ci) : rest;
    }
    // A PR's CI shows once the turn has ended (outside): while it runs, its steps say more.
    if (ci?.what && this.d.store.getTicket(ticketId)?.status !== 'running') return prCi(ci);
    return this.restart(ticketId);
  };

  /** Merged and pulled but not running yet: the idle restart, and the turns it waits for. */
  private restart(ticketId: number): Wait | null {
    const stage = this.d.ship(ticketId)?.stage;
    const since = this.restartSince.get(ticketId);
    if (stage !== 'deploying') {
      if (since != null) {
        if (stage === 'live') this.record('restart', (this.now() - since) / 1000);
        this.restartSince.delete(ticketId);
        this.saveRestarts();
      }
      return null;
    }
    const at = since ?? this.now();
    if (since == null) {
      this.restartSince.set(ticketId, at);
      this.saveRestarts();
    }
    const n = this.d.interruptible();
    return {
      kind: 'restart', stage: 'restart', since: at, usual: this.usual('restart'),
      chip: n ? `restart · ${n} turn${n === 1 ? '' : 's'}` : 'restart',
      text: n ? `the restart waits for ${n} running turn${n === 1 ? '' : 's'} to end` : 'restarting',
    };
  }

  /** The land line as the last poll read it (src/releases.ts reads it too). */
  line: LandTicket[] = [];

  /**
   * Put the waiting landings in this order (#1002, the Releases page): `seqs` first, the ones it leaves out behind them in
   * the line's order; a holder, a ticket no longer waiting or one from an older branch is left out. `note` says who moved what, for the waiters' output.
   * Returns the order written.
   */
  setOrder(seqs: number[], note: string): number[] {
    if (!this.d.deployState) throw new Error('This server has no land line');
    this.poll();
    const order = writeOrder(join(this.d.deployState, 'queue'), this.line, seqs, note);
    this.poll();
    return order;
  }

  /** Labels found to be a minion; a miss is looked up again next time, as its minion may not be there yet. */
  private byLabel = new Map<string, number>();
  ticketFor(label: string): number | null {
    if (!this.byLabel.has(label)) {
      const { store } = this.d;
      let t = label.includes('/') && label !== 'tools/deploy.sh' ? store.ticketByBranch(label) : undefined;
      const m = !t && label.match(/^(.+?) #(\d+)(?: \(.*\))?$/);
      if (m) {
        const p = store.listProjects().find((x) => x.name === m[1]);
        t = p && store.getTicketByNumber(p.id, Number(m[2]));
      }
      if (t) this.byLabel.set(label, t.id);
    }
    return this.byLabel.get(label) ?? null;
  }

  private name = (label: string) => {
    const id = this.ticketFor(label);
    const t = id != null ? this.d.store.getTicket(id) : undefined;
    return t ? `#${t.number ?? t.id}` : label.replace(/ \(.*\)$/, '');
  };

  poll() {
    const now = this.now();
    const next = new Map<number, Wait & { key?: string }>();
    if (this.d.deployState) {
      const { line, took } = readLandLine(this.d.deployState, this.d.alive);
      this.line = line;
      // Before ci.landings below lets go of a landing that left its CI wait, so its run's last stage is still there.
      this.d.landLine?.(line.map((t) => {
        const id = this.ticketFor(t.label);
        return { seq: t.seq, name: t.label === 'tools/deploy.sh' ? t.label : this.name(t.label), phase: t.got > 0 ? landPhase(t.phase).key : 'line', ci: id != null ? this.d.ci?.view(id)?.stage ?? null : null, run: id != null ? this.d.ci?.runOf(id) ?? null : null };
      }), now);
      for (const [label, w] of landWaits(line, took, now, this.usual, this.name)) {
        const id = this.ticketFor(label);
        const holder = line.find((t) => t.label === label && t.got > 0);
        if (id != null) next.set(id, { ...w, key: holder ? `land:${landPhase(holder.phase).key}` : undefined });
      }
    }
    const heavy = readHeavy(this.d.heavyDir, now, this.d.held);
    for (const [who, w] of heavyWaits(heavy, this.usual, this.name)) {
      const id = this.ticketFor(who);
      // A heavy job runs inside its minion's turn; its files can outlive a killed job, so only a running minion shows one.
      if (id == null || next.has(id) || this.d.store.getTicket(id)?.status !== 'running') continue;
      const h = heavy.holders.find((x) => x.who === who);
      next.set(id, { ...w, key: w.stage === 'run' ? `heavy:run:${h?.what}` : 'heavy:slot' });
    }
    // A stage that moved on (or a slot or run that ended) adds its length to that stage's usual. A landing
    // that left the line before deploying stopped early (a conflict, a red test), and a heavy job whose
    // minion stopped was cut off: those don't count.
    for (const [id, old] of this.current) {
      const now2 = next.get(id);
      if (!old.key || (now2 && now2.stage === old.stage && now2.since === old.since)) continue;
      const movedOn = now2 ? TRACK.indexOf(now2.stage) > TRACK.indexOf(old.stage) || old.kind === 'heavy'
        : old.kind === 'heavy' ? this.d.store.getTicket(id)?.status === 'running' : old.stage === 'deploy';
      if (movedOn) this.record(old.key, (now - old.since) / 1000);
    }
    const ids = new Set([...this.current.keys(), ...next.keys()]);
    this.current = next;
    const gates = new Map<number, { branch: string; cwd: string | null; since: number }>();
    for (const [id, w] of next) {
      const t = w.key === 'land:ci' ? this.d.store.getTicket(id) : undefined;
      if (t?.branch) gates.set(id, { branch: t.branch, cwd: t.cwd, since: w.since });
    }
    this.d.ci?.landings(this.d.ciSlug?.() ?? null, gates);
    for (const id of ids) this.check(id);
  }

  /** Re-send a minion's row when what its wait says has changed. */
  check(ticketId: number) {
    const json = JSON.stringify(this.wait(ticketId));
    if (this.shown.get(ticketId) === json) return;
    this.shown.set(ticketId, json);
    this.d.changed(ticketId);
  }
}
