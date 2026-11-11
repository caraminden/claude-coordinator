// What a minion waits on (#544): its place in the land line and that landing's phase, a heavy slot, or
// the idle restart. One shape for every kind, read from what's already on disk or in the server: the
// land line's ticket files (tools/deploy-queue.sh), citadel-heavy's slot and waiter files, and the ship
// line's "deploying" stage. Later sources (test counts, CI jobs) fill the same record.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './db.ts';
import type { Ship } from './branch.ts';

export interface Wait {
  /** Its source: land (the land line and its landing), heavy (a heavy slot), restart. */
  kind: string;
  /** Where it is: a landing's stage (line, rebase, test, deploy, restart) or a lone wait's own (slot, run). */
  stage: string;
  /** The row's badge, as short as it gets: "line · 2nd". */
  chip: string;
  /** The readout's detail: "2nd in line, behind #513 (testing)". */
  text: string;
  /** When this stage began, ms. */
  since: number;
  /** About how long it takes, s: the median of its last five, or an estimate; null when nothing is known. */
  usual: number | null;
  done?: number;
  total?: number;
}

/** A landing's stages, in order: a wait at one of these shows the track. */
export const TRACK = ['line', 'rebase', 'test', 'deploy', 'restart', 'live'];
const TYPICAL_LANDING = 300; // tools/deploy-queue.sh's QUEUE_TYPICAL, until landings have been timed

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const ordinal = (n: number) => (n === 1 ? 'next' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);
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

export interface LandTicket { seq: number; proc: string; got: number; label: string; phase: string; mtime: number }

/** The land line in order, its gone processes left out, and the last landings' lengths in s. */
export function readLandLine(stateDir: string, alive = procAlive): { line: LandTicket[]; took: number[] } {
  const q = join(stateDir, 'queue');
  const line: LandTicket[] = [];
  for (const name of files(q).filter((n) => /^\d+$/.test(n)).sort()) {
    const f = join(q, name), text = read(f), at = mtime(f);
    if (text == null || at == null) continue;
    const [proc = '', got = '0', label = '', phase = ''] = text.split('\n');
    if (!alive(proc)) continue;
    line.push({ seq: Number(name), proc, got: Number(got) || 0, label, phase, mtime: at });
  }
  const took = (read(join(q, '.took')) ?? '').split('\n').filter((l) => /^\d+$/.test(l)).map(Number);
  return { line, took };
}

/** A landing's phase (queue_phase's words in land.sh and deploy.sh) as its stage, badge word and detail. */
export function landPhase(phase: string): { stage: string; word: string; key: string; text: string } {
  const p = phase.replace(/ since \d\d:\d\d$/, '');
  if (/^waiting for CI/.test(p)) return { stage: 'test', word: 'CI', key: 'ci', text: 'waiting for CI on the rebased commit' };
  if (/^running the tests/.test(p)) return { stage: 'test', word: 'tests', key: 'tests', text: 'running the tests on the rebased code' };
  if (/^deploying/.test(p)) return { stage: 'deploy', word: 'deploy', key: 'deploy', text: p.replace(/^deploying(: )?/, '') || 'deploying' };
  return { stage: 'rebase', word: 'rebase', key: 'rebase', text: p === 'starting' ? 'starting' : 'rebasing onto main' };
}

const HEAD_WORD: Record<string, string> = { rebase: 'rebasing', ci: 'waiting for CI', tests: 'testing', deploy: 'deploying' };

/** Each land-line ticket's wait, by its label (a branch, or "tools/deploy.sh"). `name` turns a label into "#513". */
export function landWaits(line: LandTicket[], took: number[], now: number, usual: (key: string) => number | null, name: (label: string) => string): Map<string, Wait> {
  const out = new Map<string, Wait>();
  const typical = median(took) ?? TYPICAL_LANDING;
  const holder = line.find((t) => t.got > 0);
  line.forEach((t, i) => {
    if (t.got > 0) {
      const ph = landPhase(t.phase);
      out.set(t.label, { kind: 'land', stage: ph.stage, chip: `land · ${ph.word}`, text: ph.text, since: t.mtime, usual: usual(`land:${ph.key}`) });
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
      // What's left of the holder's landing, then a whole one for each other waiter ahead.
      const left = ahead.reduce((s, a) => s + (a === holder ? Math.max(0, typical - (now / 1000 - a.got)) : typical), 0);
      usualS = Math.round((now - t.mtime) / 1000 + left);
    }
    out.set(t.label, { kind: 'land', stage: 'line', chip: `line · ${place}`, text, since: t.mtime, usual: usualS });
  });
  return out;
}

export interface HeavyJob { who: string; what: string; since: number; reason?: string; slot?: number }

/** citadel-heavy's holders (slot-N.who: "who: what (since HH:MM, pid N)") and waiters (wait-<pid>: who, what, since s, reason). */
export function readHeavy(dir: string): { holders: HeavyJob[]; waiters: HeavyJob[] } {
  const holders: HeavyJob[] = [], waiters: HeavyJob[] = [];
  for (const name of files(dir)) {
    const f = join(dir, name);
    let m = name.match(/^slot-(\d+)\.who$/);
    if (m) {
      const text = read(f)?.trim(), at = mtime(f);
      const w = text?.match(/^(.*?): (.*) \(since \d\d:\d\d, pid \d+\)$/);
      if (w && at != null) holders.push({ who: w[1], what: w[2], since: at, slot: Number(m[1]) + 1 });
      continue;
    }
    m = name.match(/^wait-\d+$/);
    if (m) {
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
  for (const h of holders) out.set(h.who, { kind: 'heavy', stage: 'run', chip: 'heavy run', text: `running in heavy slot ${h.slot}: ${h.what}`, since: h.since, usual: usual(`heavy:run:${h.what}`) });
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

const USUALS = 'wait-usual'; // { [key]: the last five lengths in s }

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
}

/** The waits of every minion, polled from disk; a change re-sends that minion's row. */
export class Waits {
  private current = new Map<number, Wait & { key?: string }>();
  private restartSince = new Map<number, number>();
  private shown = new Map<number, string>();
  private d: WaitDeps;
  constructor(d: WaitDeps) {
    this.d = d;
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
    if (w) { const { key: _, ...rest } = w; return rest; }
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
      }
      return null;
    }
    const at = since ?? this.now();
    this.restartSince.set(ticketId, at);
    const n = this.d.interruptible();
    return {
      kind: 'restart', stage: 'restart', since: at, usual: this.usual('restart'),
      chip: n ? `restart · ${n} turn${n === 1 ? '' : 's'}` : 'restart',
      text: n ? `the restart waits for ${n} running turn${n === 1 ? '' : 's'} to end` : 'restarting',
    };
  }

  private byLabel = new Map<string, number | null>();
  private ticketFor(label: string): number | null {
    if (!this.byLabel.has(label)) {
      const { store } = this.d;
      let t = label.includes('/') && label !== 'tools/deploy.sh' ? store.ticketByBranch(label) : undefined;
      const m = !t && label.match(/^(.+?) #(\d+)(?: \(.*\))?$/);
      if (m) {
        const p = store.listProjects().find((x) => x.name === m[1]);
        t = p && store.getTicketByNumber(p.id, Number(m[2]));
      }
      this.byLabel.set(label, t ? t.id : null);
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
      for (const [label, w] of landWaits(line, took, now, this.usual, this.name)) {
        const id = this.ticketFor(label);
        const holder = line.find((t) => t.label === label && t.got > 0);
        if (id != null) next.set(id, { ...w, key: holder ? `land:${landPhase(holder.phase).key}` : undefined });
      }
    }
    const heavy = readHeavy(this.d.heavyDir);
    for (const [who, w] of heavyWaits(heavy, this.usual, this.name)) {
      const id = this.ticketFor(who);
      // A heavy job runs inside its minion's turn; its files can outlive a killed job, so only a running minion shows one.
      if (id == null || next.has(id) || this.d.store.getTicket(id)?.status !== 'running') continue;
      const h = heavy.holders.find((x) => x.who === who);
      next.set(id, { ...w, key: w.stage === 'run' ? `heavy:run:${h?.what}` : 'heavy:slot' });
    }
    // A stage that moved on (or a slot or run that ended) adds its length to that stage's usual. A landing
    // that left the line before deploying stopped early (a conflict, a red test): its stage doesn't count.
    for (const [id, old] of this.current) {
      const now2 = next.get(id);
      if (!old.key || (now2 && now2.stage === old.stage && now2.since === old.since)) continue;
      const movedOn = now2 ? TRACK.indexOf(now2.stage) > TRACK.indexOf(old.stage) || old.kind === 'heavy' : old.kind === 'heavy' || old.stage === 'deploy';
      if (movedOn) this.record(old.key, (now - old.since) / 1000);
    }
    const ids = new Set([...this.current.keys(), ...next.keys()]);
    this.current = next;
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
