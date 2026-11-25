// The growth stop (#1748): while the box's memory level (src/memory-ease.ts) is tight, the host turn that grew most in
// the last 2 minutes, and is over 2 GB, is held at its size: a runtime MemoryHigh on its scope at what it uses now plus
// 256 MB (`systemctl --user set-property --runtime`). The kernel then throttles and reclaims inside that one turn as it
// tries to grow, so the turn causing the squeeze slows instead of the whole box swapping. It is never squeezed below
// where it is, never a MemoryMax, never on a Taskmaster or the server (only citadel-turns.slice's turn scopes are
// read), and nothing is stopped or killed. While tight lasts, one more turn can be held a minute after the last.
// Leaving tight lifts every hold at once; a server start lifts any a restart left behind.
//
// Why this isn't 2026-11-20 again: that line sat on the whole turns slice, every turn stalled at it and CachyOS's oomd
// rule killed 23. This one is on one turn's scope; the turns slice has no oomd pressure rule since #1338
// (deploy/oomd.md), and citadel.slice's 90%-for-60-s rule counts only time when *every* task in Citadel is stalled,
// which one held turn can't cause. Containers' turns share one container cgroup per person, so they aren't held here.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { hostDir, hostText } from './host-signals.ts';
import { citadelSliceDir } from './memory-storms.ts';
import type { EaseLevel, Slowed } from './memory-ease.ts';
import { thrown } from './thrown.ts';

const MB = 1024 ** 2;
export const STOP = {
  /** Only a turn at least this big is held. */
  minBytes: 2048 * MB,
  /** Held at its size plus this. */
  headroom: 256 * MB,
  /** Growth is measured over this window. */
  windowMs: 2 * 60_000,
  /** While tight, another turn can be held this long after the last. */
  spacingMs: 60_000,
};
const SCOPE = /^citadel-turn-.*\.scope$/;

export interface ScopeReading {
  unit: string;
  current: number;
  high: number | null;
}

/** The minion a turn scope belongs to: citadel-turn-<hash>-<ticket id>-<started>.scope. */
export function scopeTicket(unit: string): number | null {
  const m = unit.match(/^citadel-turn-[0-9a-f]+-(\d+)-\d+\.scope$/);
  return m ? Number(m[1]) : null;
}

/** The turn scopes in citadel-turns.slice, with memory.current and memory.high (null for max). */
export async function readTurnScopes(turnsDir: string): Promise<ScopeReading[]> {
  const out: ScopeReading[] = [];
  for (const unit of await hostDir(turnsDir).catch(() => [] as string[])) {
    if (!SCOPE.test(unit)) continue;
    try {
      const current = Number((await hostText(join(turnsDir, unit, 'memory.current'))).trim());
      const h = (await hostText(join(turnsDir, unit, 'memory.high'))).trim();
      if (Number.isFinite(current)) out.push({ unit, current, high: h === 'max' ? null : Number(h) });
    } catch {
      /* the turn ended between the listing and the read */
    }
  }
  return out;
}

/** Sets (bytes) or lifts (null) a scope's runtime MemoryHigh. */
export function setMemoryHigh(unit: string, bytes: number | null): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('systemctl', ['--user', 'set-property', '--runtime', unit, `MemoryHigh=${bytes === null ? 'infinity' : bytes}`], { timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

export interface GrowthStopDeps {
  /** citadel-turns.slice's cgroup folder; found from the server's own cgroup unless given. */
  turnsDir?: string | null;
  read?: (turnsDir: string) => Promise<ScopeReading[]>;
  set?: (unit: string, bytes: number | null) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

export class GrowthStop {
  private d: GrowthStopDeps;
  private dir: string | null | undefined;
  private seen = new Map<string, { at: number; current: number }[]>();
  private held = new Map<string, Slowed>();
  private lastHold = -Infinity;
  private cleaned = false;
  private stopped = false;

  constructor(d: GrowthStopDeps = {}) {
    this.d = d;
    this.dir = d.turnsDir;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }
  private log(line: string) {
    (this.d.log ?? ((l: string) => console.log(`[growth-stop] ${l}`)))(line);
  }
  private set(unit: string, bytes: number | null) {
    return (this.d.set ?? setMemoryHigh)(unit, bytes);
  }

  /** The turns held now. */
  slowed(): Slowed[] {
    return [...this.held.values()];
  }

  /** One reading at this level. Never throws. */
  async tick(level: EaseLevel): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.dir === undefined) {
        const citadel = await citadelSliceDir();
        this.dir = citadel ? join(citadel, 'citadel-turns.slice') : null;
      }
      if (!this.dir) return;
      const now = this.now();
      const scopes = await (this.d.read ?? readTurnScopes)(this.dir);
      const live = new Set(scopes.map((s) => s.unit));
      for (const unit of [...this.seen.keys()]) if (!live.has(unit)) this.seen.delete(unit);
      for (const unit of [...this.held.keys()]) if (!live.has(unit)) this.held.delete(unit);
      // Lifted by someone else (the old server in a handover): no longer ours to show or lift.
      for (const s of scopes) if (s.high === null) this.held.delete(s.unit);
      for (const s of scopes) {
        const h = (this.seen.get(s.unit) ?? []).filter((r) => now - r.at <= STOP.windowMs);
        h.push({ at: now, current: s.current });
        this.seen.set(s.unit, h);
      }
      if (!this.cleaned) {
        // A restart's leftovers: only this sets MemoryHigh on a turn scope, so any set one is ours; held now, they are
        // lifted below like any other once the box isn't tight.
        this.cleaned = true;
        for (const s of scopes) if (s.high !== null) this.held.set(s.unit, { unit: s.unit, ticket: scopeTicket(s.unit), bytes: s.high, at: now });
      }
      if (level !== 'tight') {
        for (const unit of [...this.held.keys()]) await this.lift(unit, `the box is back to ${level}`);
        return;
      }
      if (now - this.lastHold < STOP.spacingMs) return;
      let pick: { unit: string; current: number; grew: number } | null = null;
      for (const s of scopes) {
        if (this.held.has(s.unit) || s.current < STOP.minBytes) continue;
        const h = this.seen.get(s.unit)!;
        const grew = s.current - h[0].current;
        if (grew > 0 && (!pick || grew > pick.grew)) pick = { unit: s.unit, current: s.current, grew };
      }
      if (!pick) return;
      const bytes = pick.current + STOP.headroom;
      await this.set(pick.unit, bytes);
      this.held.set(pick.unit, { unit: pick.unit, ticket: scopeTicket(pick.unit), bytes, at: now });
      this.lastHold = now;
      // A stop that came while this set ran has already lifted what it saw, so lift this one too.
      if (this.stopped) return await this.lift(pick.unit, 'the server is stopping');
      this.log(`holding ${pick.unit} at ${Math.round(bytes / MB)} MB: it grew ${Math.round(pick.grew / MB)} MB in ${STOP.windowMs / 60_000} min while memory is tight`);
    } catch (err) {
      console.error(`Growth stop failed: ${thrown(err).message ?? err}`);
    }
  }

  private async lift(unit: string, why: string) {
    try {
      await this.set(unit, null);
      this.held.delete(unit);
      this.log(`lifted the hold on ${unit}: ${why}`);
    } catch (err) {
      console.error(`Lifting the hold on ${unit} failed (tried again next reading): ${thrown(err).message ?? err}`);
    }
  }

  /** On shutdown: lifts every hold, so none outlives the server that watches it. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const unit of [...this.held.keys()]) await this.lift(unit, 'the server is stopping');
  }
}
