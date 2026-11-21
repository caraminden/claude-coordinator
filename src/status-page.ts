// The Status page (#1123): "is Citadel OK?" and "is my app OK?" from one read. Citadel's own server (uptime and why
// it last restarted, stalls, memory and disk, ships, CI, its units, the CI desktop) and each app the viewer can see
// (deploys, errors, agent turns, who used it, disk), each with a week of daily history. Read-only: it only reads
// what other parts already record, plus perigee's memory and disk, which HostSampler samples every 5 minutes.
import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism, homedir, loadavg } from 'node:os';
import type { Store, HostSample, ReleaseRow, ContraptionRow } from './db.ts';
import type { CiView } from './ci-health.ts';
import type { PcView } from './ci-load.ts';
import type { DiskUse, UnitState } from './app-services.ts';
import { pacificDay, pacificStamp } from './pacific.ts';
import { join } from 'node:path';
import { pressure } from './pressure.ts';
import { appBackup, readBackups, backupProblems, type BackupInfo } from './backup-freshness.ts';
import { SLOW_P90_S, shipTargets, type ShipTarget } from './ship-time.ts';
import { parseStorm, type Storm } from './memory-storms.ts';
import { BOOT_STALL } from './deploy-watch.ts';
import { every, jobList, type JobRow, type Job } from './every.ts';

const DAY_MS = 24 * 60 * 60_000;
/** Days of history each tile shows: today and the 7 before it. */
export const STATUS_DAYS = 8;
export const SAMPLE_EVERY_MS = 5 * 60_000;
/** How long a built page is reused: every open page re-reads every 30 s. */
const BUILD_KEEP_MS = 20_000;
/** Citadel's own units (deploy/), whose state the page shows; one that isn't installed is listed as such, not as trouble. */
export const CITADEL_UNITS = ['claude-coordinator.service', 'claude-coordinator-backup.timer', 'claude-coordinator-backup.service', 'claude-coordinator-prune.timer', 'citadel-watchdog.timer', 'citadel-embed.service', 'citadel-android-adb.service'];
/** A stall at least this long, in the last day, turns Citadel's verdict to warn. */
const STALL_WARN_S = 5;
/** Seconds stalled at a memory limit in the last day (#1280) that turn Citadel's verdict to warn. Starting number; tune here. */
export const STORM_WARN_S = 60;
/** Errors in an app's last day that turn its verdict to warn. */
export const APP_ERRORS_WARN = 10;
/**
 * perigee's load turns Citadel's verdict to warn when every reading of the last CPU_WARN_MS sat over CPU_WARN_PER_CORE times its
 * cores (#1273). Picked from the day's readings (Nov 20: 2 to 226 on 16 cores; over 32 only in the 10:44 and 11:17-11:36 PST
 * pile-ups), so a busy build is quiet and a pile-up that lasts is not.
 */
export const CPU_WARN_PER_CORE = 2;
export const CPU_WARN_MS = 15 * 60_000;
/** How far back an Investigate click (#1273) and the minion on it are remembered: the page's week. */
const LOOK_MS = 8 * DAY_MS;

export type Tone = 'ok' | 'warn' | 'bad';

/** Failure share from which a rate turns yellow, and red (Josh, 2026-11-20: one failure is not trouble). Starting numbers; tune here. */
export const RATE_WARN = 0.1;
export const RATE_BAD = 0.3;
/** Fewest runs, and fewest failures, before a share counts: 1 of 2 is 50% but not news. */
export const RATE_MIN_RUNS = 5;
export const RATE_MIN_FAILED = 2;

/** The colour of `failed` out of `total` runs by share. Failure counts of state (a failed unit, the last deploy) don't use this. */
export function rateTone(failed: number, total: number): Tone {
  if (total < RATE_MIN_RUNS || failed < RATE_MIN_FAILED) return 'ok';
  const share = failed / total;
  return share >= RATE_BAD ? 'bad' : share >= RATE_WARN ? 'warn' : 'ok';
}
/** tiles[i] is the tile reasons[i] comes from (#1273), whose look (who is on it) the page shows beside it. */
export interface Verdict { tone: Tone; reasons: string[]; tiles: string[] }
type Reason = [Tone, string, string];

/** The last STATUS_DAYS Pacific days, oldest first, as 2026-11-19. */
export function lastDays(now: number): string[] {
  // Calendar steps from today's date, not 24-hour steps, which repeat or skip a day across a DST change.
  const noon = Date.parse(`${pacificDay(now)}T12:00:00Z`);
  return Array.from({ length: STATUS_DAYS }, (_, i) => new Date(noon - (STATUS_DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const worst = (reasons: Reason[]): Verdict => {
  const shown = [...reasons.filter(([t]) => t === 'bad'), ...reasons.filter(([t]) => t === 'warn')];
  return { tone: shown[0]?.[0] ?? 'ok', reasons: shown.map(([, r]) => r), tiles: shown.map(([, , k]) => k) };
};

/** The tag an Investigate click on a tile carries (#1273): a minion whose title or messages quote it is the one on it. */
export const lookTag = (target: string, tile: string) => `status:${target}/${tile}`;

/** Who is on a tile (#1273): the newest Investigate click on it, and the minion that quotes its tag, the first open one, else the newest. */
export interface Look { sentAt: number | null; by: string | null; minion: { project: number; number: number; title: string; closed: boolean } | null }

/** Each tile of `target` someone pressed Investigate on in the last LOOK_MS, with its minion; CI's fix minion wins on Citadel's CI tile. */
export function looksFor(store: Store, scheme: number | null, target: string, now: number): Record<string, Look> {
  const out: Record<string, Look> = {};
  const prefix = lookTag(target, '');
  const first = new Map<string, number>();
  const quoted = new Map<string, { at: number; id: number }[]>();
  for (const e of store.healthEventsSince(['investigate', 'look'], now - LOOK_MS)) {
    const [tag, who] = e.detail.split('\n');
    if (!tag.startsWith(prefix)) continue;
    const tile = tag.slice(prefix.length);
    if (e.kind === 'investigate') {
      if (!first.has(tile)) first.set(tile, e.at);
      out[tile] = { sentAt: e.at, by: who ?? null, minion: null };
    } else quoted.set(tile, [...(quoted.get(tile) ?? []), { at: e.at, id: Number(who) }]);
  }
  if (scheme == null) return out;
  // Quoted from a minute before the first click on (a brief written as the click lands), by one of this scheme's minions.
  for (const [tile, from] of first) {
    const named = [...new Set((quoted.get(tile) ?? []).filter((q) => q.at >= from - 60_000).map((q) => q.id))]
      .map((id) => store.getTicket(id)).filter((t) => t && t.project_id === scheme && t.kind !== 'coordinator' && t.number != null)
      .sort((a, b) => a!.created_at - b!.created_at);
    const t = named.find((x) => x!.status !== 'closed') ?? named.at(-1);
    if (t) out[tile].minion = { project: scheme, number: t.number!, title: t.title, closed: t.status === 'closed' };
  }
  return out;
}

/** "…Cause: waited for disk (…)" → "waited for disk"; null for a line from before the cause was recorded. */
export function stallCauseOf(detail: string): string | null {
  return /Cause: ([a-zA-Z ]+?) \(/.exec(detail)?.[1] ?? null;
}

/** "The event loop was held for 2.3 s: …" → 2.3; null when the line doesn't say. */
export function stallSeconds(detail: string): number | null {
  const m = /held for ([\d.]+) ?(ms|s)\b/.exec(detail);
  if (!m) return null;
  return m[2] === 'ms' ? Number(m[1]) / 1000 : Number(m[1]);
}

/**
 * Record this server's start as a 'boot' health event and say why it started: a ship (new code since the last
 * start) or a restart on the same code (a crash, the watchdog or by hand). Returns that reason.
 */
export function recordBoot(store: Store, commit: string, at: number): string {
  const last = store.healthEventsSince(['boot'], 0).at(-1);
  const reason = !last ? 'first start on record'
    : last.commit_sha && commit && last.commit_sha !== commit ? `a ship: new code ${commit.slice(0, 8)}`
    : 'a restart on the same code: a crash, the watchdog or by hand';
  store.addHealthEvent('boot', at, commit || null, reason);
  return reason;
}

/** Bytes of memory free for new work, from MemAvailable (free alone leaves out reclaimable cache). */
async function readMem(): Promise<{ total: number; avail: number }> {
  const text = await readFile('/proc/meminfo', 'utf8');
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? NaN) * 1024;
  return { total: kb('MemTotal'), avail: kb('MemAvailable') };
}

export interface StatusDeps {
  store: Store;
  dataDir: string;
  bootAt: number;
  commit: string;
  /** Citadel's own scheme: its releases are Citadel's ships and its CI is Citadel's. */
  ownScheme: () => number | null;
  ciSnapshot?: (canSee: (id: number) => boolean) => { id: number; view: CiView; problems?: { fixMinion?: { number: number; closed: boolean } }[] }[];
  /** perigee's cores, for the CPU tile (#1273); the real count unless a test says otherwise. */
  cores?: number;
  desktops?: () => PcView[];
  diskUse?: (row: ContraptionRow) => DiskUse | null;
  /** systemctl --user show for these units; left out where they can't be read (a preview, a test). */
  unitStates?: (units: string[]) => Promise<UnitState[]>;
  now?: () => number;
  /** Where apps' DATA_DIRs are under (~/.local/share/<name>); the real home unless a test says otherwise. */
  home?: string;
  /** Tell a scheme's Taskmaster (a wake): the slow-ship nudge. Left out in a preview or a test that doesn't send. */
  tell?: (projectId: number, text: string) => void;
  mem?: () => Promise<{ total: number; avail: number }>;
  /** Memory-limit storms still going (#1280, src/memory-storms.ts); the ones that ended are 'memory-high' health events. */
  storms?: () => Storm[];
  disk?: (dir: string) => Promise<{ total: number; free: number }>;
}

/** One tile as a person saw it when they pressed Investigate (#1273): what the Taskmaster is sent. */
export interface InvestigateTile { target: string; tile: string; title: string; value: string; sub: string; chart: string; reasons: string[] }

/** Who reads the page: canSee is the store's for their session; admin sees apps with no home scheme too. */
export interface Viewer { canSee: (projectId: number) => boolean; admin: boolean; key: string }

/** One hour of the host chart: its time, memory used %, disk used %, highest load, highest CPU and memory pressure % (null without PSI, #1301). */
export type HostPoint = [number, number, number, number, number | null, number | null];

export class StatusPage {
  private built = new Map<string, { at: number; data: Promise<StatusData> }>();
  private units: { at: number; rows: UnitState[] } | null = null;
  private timer: Job | null = null;
  readonly deps: StatusDeps;
  constructor(deps: StatusDeps) {
    this.deps = deps;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** One reading of memory, disk and load into host_samples. Never throws. */
  async sample(): Promise<HostSample | null> {
    try {
      const mem = await (this.deps.mem ?? readMem)();
      const disk = await (this.deps.disk ?? (async (dir) => {
        const s = await statfs(dir);
        return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
      }))(this.deps.dataDir);
      const psi = await pressure.read();
      const s: HostSample = {
        at: this.now(), mem_total: mem.total, mem_avail: Number.isFinite(mem.avail) ? mem.avail : 0,
        disk_total: disk.total, disk_free: disk.free, load1: loadavg()[0], rss: process.memoryUsage.rss(), cpu_psi: psi.cpu, mem_psi: psi.mem,
      };
      this.deps.store.addHostSample(s);
      return s;
    } catch (err: any) {
      console.error(`Status sample failed: ${err?.message ?? err}`);
      return null;
    }
  }

  start() {
    this.timer = every('status sample', SAMPLE_EVERY_MS, () => this.sample().then(() => this.nudgeSlowShips()), 0);
  }

  stop() {
    this.timer?.stop();
  }

  /**
   * #1132: the day a target's p90 of asked-to-live passes SLOW_P90_S, its scheme's Taskmaster hears once, however many
   * ships follow; the next day's slow tail is a new nudge. Remembered as a 'ship-slow' health event, so a restart doesn't repeat it.
   */
  nudgeSlowShips(): number {
    const { store, tell } = this.deps;
    const now = this.now();
    const day = pacificDay(now);
    const told = new Set(store.healthEventsSince(['ship-slow'], now - 2 * DAY_MS).map((e) => e.detail.split('\n')[0]));
    let sent = 0;
    for (const t of shipTargets(store, lastDays(now), this.deps.ownScheme())) {
      const p90 = t.p90.at(-1);
      const mark = `${t.key}|${day}`;
      if (p90 == null || p90 <= SLOW_P90_S || told.has(mark) || t.scheme == null) continue;
      store.addHealthEvent('ship-slow', now, null, `${mark}\n${t.title}: p90 ${Math.round(p90)} s`);
      tell?.(t.scheme, `Ships to ${t.title} are slow today: the slowest tenth took ${Math.round(p90 / 60)} min or more from asked to live (the median ${Math.round((t.median.at(-1) ?? 0) / 60)} min, ${t.counts.at(-1)} ships), over the ${SLOW_P90_S / 60} min line. The Status page's Time to ship chart shows each ship's steps. This is the one nudge for ${t.title} today.`);
      sent++;
    }
    return sent;
  }

  /** Citadel's looks; with `ciRed`, CI's tile takes the CI page's fix minion for the red (ci-health.ts), the first open one, else the newest. */
  private citadelLooks(viewer: Viewer, own: number, now: number, ciRed: boolean): Record<string, Look> {
    const looks = looksFor(this.deps.store, own, 'citadel', now);
    if (!ciRed) return looks;
    const fixes = (this.deps.ciSnapshot?.((id) => id === own && viewer.canSee(id)).find((s) => s.id === own)?.problems ?? []).flatMap((x) => (x.fixMinion ? [x.fixMinion] : []));
    const fix = fixes.find((f) => !f.closed) ?? fixes.at(-1);
    if (fix) looks.ci = { sentAt: looks.ci?.sentAt ?? null, by: looks.ci?.by ?? null, minion: { project: own, number: fix.number, title: this.deps.store.getTicketByNumber(own, fix.number)?.title ?? '', closed: fix.closed } };
    return looks;
  }

  /**
   * An Investigate click on a tile (#1273; Cara, 2026-11-20: "each of the boxes should have an "investigate" button that sends
   * the data to the relevant taskmaster to look into it"): records it, and returns the scheme whose Taskmaster hears it (Citadel's
   * own for its tiles, an app's home scheme for the app's) and what it reads. A second click while the look is open says so,
   * naming the minion on it, so the Taskmaster adds to it rather than starting another (Cara picked "Add to the same one").
   * Null when the viewer can't see that target.
   */
  investigate(viewer: Viewer, who: string, tile: InvestigateTile): { scheme: number; text: string; record: () => void } | null {
    const { store } = this.deps;
    const now = this.now();
    const own = this.deps.ownScheme();
    const app = tile.target === 'citadel' ? null : store.listContraptions().find((a) => `app:${a.name}` === tile.target);
    if (tile.target === 'citadel' ? own == null || !viewer.canSee(own) : !app || (app.home_scheme === null ? !viewer.admin : !viewer.canSee(app.home_scheme))) return null;
    // An app with no home scheme is admin-only; its tiles go to Citadel's Taskmaster.
    const scheme = app?.home_scheme ?? own;
    if (scheme == null) return null;
    const tag = lookTag(tile.target, tile.tile);
    // The same looks the page shows, CI's fix minion included, so a click on a red already being fixed adds to that fix.
    const open = (app ? looksFor(store, scheme, tile.target, now) : this.citadelLooks(viewer, scheme, now, true))[tile.tile];
    const before = open && (!open.minion || !open.minion.closed) ? open : null;
    // Recorded by the caller once the Taskmaster has it, so a failed send shows no look nobody heard of.
    const record = () => { store.addHealthEvent('investigate', now, null, `${tag}\n${who}`); this.built.clear(); };
    const where = app ? app.title : 'Citadel';
    const lines = [
      `[Status page] ${who} pressed Investigate on ${where}'s ${tile.title} tile.`,
      before
        ? `More on the open look at this (${before.sentAt ? `first sent ${pacificStamp(before.sentAt)}` : 'its CI fix'}${before.minion ? `; #${before.minion.number} ${before.minion.title} is on it` : '; no minion on it yet'}): pass these numbers on rather than start another minion.`
        : `Look into it, and decide whether it needs a minion. Quote the tag \`${tag}\` in the brief of a minion you start for it, or in a message to one already on it: the Status page links whichever minion quotes it as "Looking into it".`,
      '',
      `${tile.title}: ${tile.value}`,
      tile.sub,
      ...(tile.chart ? [`Chart: ${tile.chart}`] : []),
      ...(tile.reasons.length ? [`Why ${where}'s verdict isn't OK, from this tile: ${tile.reasons.join(' · ')}`] : []),
      `Read ${pacificStamp(now)}.`,
    ];
    return { scheme, text: lines.join('\n'), record };
  }

  /** The page for one viewer, reused for BUILD_KEEP_MS per viewer. */
  read(viewer: Viewer): Promise<StatusData> {
    const now = this.now();
    const kept = this.built.get(viewer.key);
    if (kept && now - kept.at < BUILD_KEEP_MS && now >= kept.at) return kept.data;
    for (const [k, v] of this.built) if (now - v.at >= BUILD_KEEP_MS) this.built.delete(k);
    const data = this.build(viewer, now);
    this.built.set(viewer.key, { at: now, data });
    data.catch(() => this.built.delete(viewer.key));
    return data;
  }

  /** The units' states; [] where they aren't read (a preview, a test), null when the read failed. */
  private async unitRows(apps: ContraptionRow[]): Promise<UnitState[] | null> {
    const now = this.now();
    if (this.units && now - this.units.at < 60_000 && now >= this.units.at) return this.units.rows;
    const names = [...CITADEL_UNITS, ...apps.map((a) => `citadel-app-${a.name}.service`)];
    try {
      const rows = (await this.deps.unitStates?.(names)) ?? [];
      this.units = { at: now, rows };
      return rows;
    } catch (err: any) {
      // Not cached: a failed read says so on the page and asks again on the next one.
      console.error(`Status: reading the units failed: ${err?.message ?? err}`);
      return null;
    }
  }

  async build(viewer: Viewer, now = this.now()): Promise<StatusData> {
    const { store } = this.deps;
    const days = lastDays(now);
    const since = now - STATUS_DAYS * DAY_MS;
    const apps = store.listContraptions().filter((a) => (a.home_scheme === null ? viewer.admin : viewer.canSee(a.home_scheme)));
    const units = await this.unitRows(store.listContraptions());
    const unitOf = (u: string) => units?.find((r) => r.unit === u) ?? null;
    const ownId = this.deps.ownScheme();
    const names = new Set(apps.map((a) => `app:${a.name}`));
    const shipTimes = shipTargets(store, days, ownId, (scheme, key) => (key.startsWith('app:') ? names.has(key) : scheme === ownId || (scheme != null && viewer.canSee(scheme))));
    return {
      now,
      days,
      shipTimes,
      citadel: this.citadel(viewer, now, days, since, units, apps),
      apps: apps.map((a) => appVitals(store, a, now, days, since, unitOf(`citadel-app-${a.name}.service`), this.deps.diskUse?.(a) ?? null, this.deps.home)),
    };
  }

  private citadel(viewer: Viewer, now: number, days: string[], since: number, units: UnitState[] | null, apps: ContraptionRow[]): CitadelStatus {
    const { store, bootAt } = this.deps;
    const dayOf = (at: number) => pacificDay(at);
    const blank = () => Object.fromEntries(days.map((d) => [d, 0])) as Record<string, number>;
    const events = store.healthEventsSince(['boot', 'loop-lag', BOOT_STALL], since);
    // Restarts: each boot, why, and how many a day.
    const boots = events.filter((e) => e.kind === 'boot');
    const lastBoot = boots.filter((b) => b.at <= bootAt + 60_000).at(-1) ?? null;
    const restarts = blank();
    for (const b of boots) if (dayOf(b.at) in restarts) restarts[dayOf(b.at)]++;
    // Stalls: count and longest per day, and the last one's line.
    const stallCount = blank();
    const stallLongest = blank();
    const stalls = events.filter((e) => e.kind === 'loop-lag' || e.kind === BOOT_STALL);
    for (const s of stalls) {
      const d = dayOf(s.at);
      if (!(d in stallCount)) continue;
      stallCount[d]++;
      stallLongest[d] = Math.max(stallLongest[d], stallSeconds(s.detail) ?? 0);
    }
    const lastStall = stalls.at(-1);
    // Memory limits (#1280): storms per day, the seconds stalled, the last one, and any going now.
    const storms = store.healthEventsSince(['memory-high'], since).flatMap((e) => {
      const s = parseStorm(e.detail);
      return s ? [{ at: e.at, ...s }] : [];
    });
    const stormCount = blank();
    const stormStalled = blank();
    for (const s of storms) {
      const d = dayOf(s.at);
      if (!(d in stormCount)) continue;
      stormCount[d]++;
      stormStalled[d] += s.stalled;
    }
    const stormsNow = this.deps.storms?.() ?? [];
    // Memory and disk: the hourly worst (least free), and the newest reading.
    const samples = store.hostSamples(since);
    const hourly = new Map<number, HostSample>();
    const psiMax = new Map<number, [number | null, number | null]>(); // the hour's highest CPU and memory pressure (#1301)
    const hi = (a: number | null, b: number | null | undefined) => (b == null ? a : a == null ? b : Math.max(a, b));
    for (const s of samples) {
      const h = Math.floor(s.at / 3_600_000) * 3_600_000;
      const prev = hourly.get(h);
      const pm = psiMax.get(h) ?? [null, null];
      psiMax.set(h, [hi(pm[0], s.cpu_psi), hi(pm[1], s.mem_psi)]);
      if (!prev || s.mem_avail / s.mem_total < prev.mem_avail / prev.mem_total) hourly.set(h, { ...s, disk_free: Math.min(s.disk_free, prev?.disk_free ?? Infinity), load1: Math.max(s.load1, prev?.load1 ?? 0) });
      else {
        prev.disk_free = Math.min(prev.disk_free, s.disk_free);
        prev.load1 = Math.max(prev.load1, s.load1);
      }
    }
    const series = [...hourly.entries()].map(([h, s]) => [h, Math.round((1 - s.mem_avail / s.mem_total) * 1000) / 10, Math.round((1 - s.disk_free / s.disk_total) * 1000) / 10, Math.round(s.load1 * 10) / 10, ...(psiMax.get(h) ?? [null, null])] as HostPoint);
    const latest = samples.at(-1) ?? null;
    // CPU (#1273): load against the cores, today's peak, and whether it has sat high for CPU_WARN_MS.
    const cores = this.deps.cores ?? availableParallelism();
    const today = samples.filter((s) => dayOf(s.at) === days.at(-1));
    const peak = today.reduce<HostSample | null>((p, s) => (!p || s.load1 > p.load1 ? s : p), null);
    // Readings must cover the window (the first within one sample of its start), so two high readings 5 min apart aren't 15 min.
    const recent = samples.filter((s) => s.at >= now - CPU_WARN_MS);
    const cpuHigh = recent.length >= 2 && recent[0].at < now - CPU_WARN_MS + SAMPLE_EVERY_MS && recent.every((s) => s.load1 > cores * CPU_WARN_PER_CORE);
    // Ships: Citadel's releases that went live, per day, and how long each took from start to live.
    const own = this.deps.ownScheme();
    const releases: ReleaseRow[] = own ? store.releasesSince(own, 'citadel-server', since).filter((r) => r.outcome === 'live' && r.live_at) : [];
    const ships = blank();
    const shipTimes: Record<string, number[]> = Object.fromEntries(days.map((d) => [d, []]));
    for (const r of releases) {
      const d = dayOf(r.live_at!);
      if (!(d in ships)) continue;
      ships[d]++;
      if (r.started_at) shipTimes[d].push((r.live_at! - r.started_at) / 1000);
    }
    const lastShip = releases.reduce<ReleaseRow | undefined>((l, r) => (!l || r.live_at! > l.live_at! ? r : l), undefined);
    // CI: Citadel's workflows' verdicts on main and how many of the runs the last poll saw passed.
    const ciVisible = !!own && viewer.canSee(own);
    const view = ciVisible ? this.deps.ciSnapshot?.((id) => id === own && viewer.canSee(id)).find((s) => s.id === own)?.view : undefined;
    // Only the default branch's runs of workflows that ring: `view.runs` is every branch's newest, quiet workflows included.
    const quietNames = new Set((view?.workflows ?? []).filter((w) => w.quiet).map((w) => w.name));
    const done = (view?.runs ?? []).filter((r: any) => r.branch === view?.branch && !quietNames.has(r.name)).filter((r: any) => r.status === 'completed' && r.conclusion && r.conclusion !== 'cancelled' && r.conclusion !== 'skipped');
    const redWorkflows = (view?.workflows ?? []).filter((w) => !w.quiet && w.verdict?.conclusion && w.verdict.conclusion !== 'success').map((w) => w.name);
    // Enough main runs: by failure share. Too few (tests.yml on main is daily): main's newest verdict red is yellow, as before.
    const enough = done.length >= RATE_MIN_RUNS;
    const ciTone: Tone = enough ? rateTone(done.length - done.filter((r: any) => r.conclusion === 'success').length, done.length) : redWorkflows.length ? 'warn' : 'ok';
    const ci = view ? {
      tone: ciTone,
      at: view.at, url: `https://github.com/${view.slug}/actions`,
      workflows: view.workflows.filter((w) => !w.quiet).map((w) => ({ name: w.name, conclusion: w.verdict?.conclusion ?? null, status: w.verdict?.status ?? null, at: w.verdict?.at ?? null, url: w.verdict?.url ?? null })),
      runs: done.length, green: done.filter((r: any) => r.conclusion === 'success').length,
    } : null;
    const citadelUnits = (units ?? []).filter((u) => CITADEL_UNITS.includes(u.unit));
    const desktops = (this.deps.desktops?.() ?? []).map((pc) => ({ host: pc.host, verdict: pc.verdict, now: pc.now, restarts: pc.restarts, seen: pc.series.some((s) => s[1] !== null) }));
    // The verdict: bad on a failed unit; warn on a restart that wasn't a ship, a long stall, low memory or disk; CI by its share of failed runs.
    const reasons: Reason[] = [];
    for (const u of citadelUnits) if (u.active === 'failed') reasons.push(['bad', `${u.unit} failed`, 'services']);
    if (units === null) reasons.push(['warn', 'its services couldn\'t be read', 'services']);
    const dayAgo = now - DAY_MS;
    const oddBoots = boots.filter((b) => b.at >= dayAgo && b.detail.startsWith('a restart'));
    if (oddBoots.length) reasons.push(['warn', `${oddBoots.length} restart${oddBoots.length > 1 ? 's' : ''} without a ship in the last day`, 'uptime']);
    const longStall = Math.max(0, ...stalls.filter((s) => s.at >= dayAgo).map((s) => stallSeconds(s.detail) ?? 0));
    if (longStall >= STALL_WARN_S) reasons.push(['warn', `a ${longStall.toFixed(1)} s stall in the last day`, 'stalls']);
    const stormS = storms.filter((s) => s.at >= dayAgo).reduce((n, s) => n + s.stalled, 0) + stormsNow.reduce((n, s) => n + s.stalled, 0);
    if (stormS >= STORM_WARN_S) reasons.push(['warn', `${stormS < 90 ? `${Math.round(stormS)} s` : `${Math.round(stormS / 60)} min`} stalled at a memory limit in the last day`, 'memory-limits']);
    if (latest && latest.mem_avail / latest.mem_total < 0.1) reasons.push(['warn', 'under 10% of memory free', 'memory']);
    if (latest && latest.disk_free / latest.disk_total < 0.1) reasons.push(['warn', 'under 10% of disk free', 'disk']);
    if (cpuHigh) reasons.push(['warn', `load over ${cores * CPU_WARN_PER_CORE} on ${cores} cores for ${CPU_WARN_MS / 60_000} min`, 'cpu']);
    const backup = readBackups(this.deps.dataDir, this.deps.home ?? homedir(), apps, now);
    const backupMissing = backupProblems(backup, now);
    if (backupMissing.length) reasons.push(['bad', `backups: ${backupMissing.join('; ')}`, 'backups']);
    if (ci && ci.tone !== 'ok') reasons.push([ci.tone, enough ? `${ci.runs - ci.green} of the last ${ci.runs} CI runs failed` : `CI red on main: ${redWorkflows.join(', ')}`, 'ci']);
    // Who is on each tile (#1273); CI's tile takes the CI page's fix minion for the red (ci-health.ts), the first open one, else the newest.
    // Only for those who can see Citadel's scheme: the looks name its minions and who clicked, and only they can press Investigate.
    const looks = ciVisible ? this.citadelLooks(viewer, own!, now, !!ci && ci.tone !== 'ok') : {};
    return {
      verdict: worst(reasons),
      looks,
      canInvestigate: ciVisible,
      uptime: { bootAt, commit: this.deps.commit, reason: lastBoot?.detail ?? null, restarts: days.map((d) => restarts[d]), boots: boots.slice(-10).reverse().map((b) => ({ at: b.at, reason: b.detail, commit: b.commit_sha })) },
      stalls: { counts: days.map((d) => stallCount[d]), longest: days.map((d) => Math.round(stallLongest[d] * 10) / 10), last: lastStall ? { at: lastStall.at, seconds: stallSeconds(lastStall.detail), cause: stallCauseOf(lastStall.detail), afterBoot: lastStall.kind === BOOT_STALL, detail: lastStall.detail.slice(0, 700) } : null },
      host: { series, latest, sampledFrom: samples[0]?.at ?? null, cores, cpuWarn: cores * CPU_WARN_PER_CORE, cpuWarnMin: CPU_WARN_MS / 60_000, peak: peak && { at: peak.at, load1: Math.round(peak.load1 * 10) / 10 } },
      storms: { counts: days.map((d) => stormCount[d]), stalled: days.map((d) => stormStalled[d]), last: storms.at(-1) ?? null, now: stormsNow },
      ciVisible,
      // Every periodic job (#1311), for those who see Citadel's scheme.
      jobs: ciVisible ? jobList(now) : [],
      ships: { counts: days.map((d) => ships[d]), median: days.map((d) => median(shipTimes[d])), last: lastShip ? { at: lastShip.live_at!, version: lastShip.version.slice(0, 8), changes: ciVisible ? shipChanges(lastShip) : [] } : null },
      ci,
      unitsFailed: units === null,
      units: citadelUnits.map((u) => ({ unit: u.unit, load: u.load, active: u.active, sub: u.sub })),
      desktops,
      backup: { ...backup, problems: backupMissing },
      // Tiles still to come: the minions that build them fill these in (Build 5, lane 3).
      slots: [
        { key: 'line', title: 'Ship line', note: 'Who is shipping and who waits: coming with the line panel.' },
      ],
    };
  }
}

function shipChanges(r: ReleaseRow): string[] {
  try {
    return (JSON.parse(r.changes) as { number?: number; title?: string }[]).slice(0, 5).map((c) => `${c.number ? `#${c.number} ` : ''}${c.title ?? ''}`.trim());
  } catch {
    return [];
  }
}

/** One app's week: deploys, errors, agent turns and who ran them, disk, its service, and a verdict. */
export function appVitals(store: Store, a: ContraptionRow, now: number, days: string[], since: number, unit: UnitState | null, disk: DiskUse | null, home = homedir()): AppStatus {
  const dayOf = (at: number) => pacificDay(at);
  const idx = new Map(days.map((d, i) => [d, i]));
  const zero = () => days.map(() => 0);
  // Deploys
  const deploys = store.appDeploysSince(a.name, since);
  const dCount = zero();
  const dFailed = zero();
  for (const d of deploys) {
    const i = idx.get(dayOf(d.started_at));
    if (i === undefined) continue;
    dCount[i]++;
    if (d.outcome === 'failed') dFailed[i]++;
  }
  const took = deploys.filter((d) => d.finished_at).map((d) => (d.finished_at! - d.started_at) / 1000);
  const lastDeploy = store.appDeploysSince(a.name, 0).at(-1) ?? null;
  // Errors
  const errs = store.appErrorsSince(a.id, days[0]);
  const eCount = zero();
  const kinds: Record<string, number> = {};
  const keys = new Map<string, { kind: string; key: string; count: number; sample: string; last_at: number }>();
  for (const e of errs) {
    const i = idx.get(e.day);
    if (i === undefined) continue;
    eCount[i] += e.count;
    kinds[e.kind] = (kinds[e.kind] ?? 0) + e.count;
    const k = `${e.kind}\n${e.key}`;
    const prev = keys.get(k);
    keys.set(k, prev ? { ...prev, count: prev.count + e.count, last_at: Math.max(prev.last_at, e.last_at) } : { ...e });
  }
  const top = [...keys.values()].sort((x, y) => y.count - x.count).slice(0, 5).map(({ kind, count, sample, last_at }) => ({ kind, count, sample, last_at }));
  // The last day's errors: today's and yesterday's rows whose last one fell in the last 24 hours (a day's rows only say when its last error was).
  const lastDay = errs.filter((e) => e.last_at >= now - DAY_MS).reduce((n, e) => n + e.count, 0);
  // Agent turns
  const turns = store.appTurnsSince(a.id, since);
  const tCount = zero();
  const tTokens = zero();
  const people = new Map<string, number>();
  for (const t of turns) {
    const i = idx.get(dayOf(t.started_at));
    if (i === undefined) continue;
    tCount[i]++;
    tTokens[i] += t.tokens;
    people.set(t.person, (people.get(t.person) ?? 0) + 1);
  }
  // Verdict: bad when its service isn't running or its last deploy failed; warn on many errors or a failed deploy this week.
  const reasons: Reason[] = [];
  if (unit && unit.load !== 'not-found' && unit.active !== 'active' && unit.active !== 'activating' && unit.active !== 'reloading') reasons.push(['bad', `its service is ${unit.active}`, 'service']);
  const nFailed = dFailed.reduce((x, y) => x + y, 0);
  const deployTone: Tone = lastDeploy?.outcome === 'failed' ? 'bad' : rateTone(nFailed, deploys.length);
  if (lastDeploy?.outcome === 'failed') reasons.push(['bad', 'its last deploy failed', 'deploys']);
  else if (deployTone !== 'ok') reasons.push([deployTone, `${nFailed} of ${deploys.length} deploys failed this week`, 'deploys']);
  if (lastDay >= APP_ERRORS_WARN) reasons.push(['warn', `${lastDay} errors in the last day`, 'errors']);
  if (disk?.warn_gb && disk.data_bytes >= disk.warn_gb * 1e9) reasons.push(['warn', `its data is over ${disk.warn_gb} GB`, 'disk']);
  const backup = appBackup(join(home, '.local/share', a.name), now);
  if (backup.day && !backup.ok) reasons.push(['warn', `its last backup was ${backup.day}`, 'backup']);
  return {
    name: a.name, title: a.title, icon: a.icon, scheme: a.home_scheme,
    verdict: worst(reasons),
    looks: looksFor(store, a.home_scheme, `app:${a.name}`, now),
    service: unit ? { unit: unit.unit, active: unit.active, sub: unit.sub, installed: unit.load !== 'not-found' } : null,
    deploys: { tone: deployTone, counts: dCount, failed: dFailed, median: median(took), longest: took.length ? Math.max(...took) : null, last: lastDeploy ? { at: lastDeploy.started_at, outcome: lastDeploy.outcome, by: lastDeploy.by, sha: lastDeploy.to_sha?.slice(0, 8) ?? null, took: lastDeploy.finished_at ? (lastDeploy.finished_at - lastDeploy.started_at) / 1000 : null } : null },
    errors: { counts: eCount, kinds, top, lastDay },
    turns: { counts: tCount, tokens: tTokens, people: [...people.entries()].sort((x, y) => y[1] - x[1]).map(([name, turns]) => ({ name, turns })) },
    disk: disk ? { bytes: disk.data_bytes, at: disk.measured_at, warn_gb: disk.warn_gb } : null,
    backup,
  };
}

export interface CitadelStatus {
  verdict: Verdict;
  /** Who is on each tile, by tile key (#1273): only tiles someone pressed Investigate on, and CI's with a fix minion. */
  looks: Record<string, Look>;
  /** Whether this viewer can see Citadel's scheme, so its tiles carry Investigate (#1273). */
  canInvestigate: boolean;
  uptime: { bootAt: number; commit: string; reason: string | null; restarts: number[]; boots: { at: number; reason: string; commit: string | null }[] };
  stalls: { counts: number[]; longest: number[]; last: { at: number; seconds: number | null; cause: string | null; afterBoot: boolean; detail: string } | null };
  /** series: [hour, memory used %, disk used %, load], the hour's worst; peak: today's highest load. */
  host: { series: HostPoint[]; latest: HostSample | null; sampledFrom: number | null; cores: number; cpuWarn: number; cpuWarnMin: number; peak: { at: number; load1: number } | null };
  /** Memory-limit storms (#1280): per day, their count and seconds stalled; the last that ended; those going now. */
  storms: { counts: number[]; stalled: number[]; last: (Storm & { at: number }) | null; now: Storm[] };
  /** Every periodic job (#1311): empty for a viewer who can't see Citadel's scheme. */
  jobs: (JobRow & { overdue: boolean; slow: boolean })[];
  ships: { counts: number[]; median: (number | null)[]; last: { at: number; version: string; changes: string[] } | null };
  /** Whether the viewer may see Citadel's CI: `ci` is null for them only when there is no reading yet. */
  ciVisible: boolean;
  ci: { tone: Tone; at: number; url: string; workflows: { name: string; conclusion: string | null; status: string | null; at: string | null; url: string | null }[]; runs: number; green: number } | null;
  /** The read of the units failed this time: `units` is empty because it is unknown, not because none run. */
  unitsFailed: boolean;
  units: { unit: string; load: string; active: string; sub: string }[];
  desktops: { host: string; verdict: PcView['verdict']; now: PcView['now']; restarts: number[]; seen: boolean }[];
  /** Backup freshness (#1142): problems is what a missed night names; empty when all is well. */
  backup: BackupInfo & { problems: string[] };
  slots: { key: string; title: string; note: string }[];
}

export interface AppStatus {
  name: string;
  title: string;
  icon: string | null;
  scheme: number | null;
  verdict: Verdict;
  looks: Record<string, Look>;
  service: { unit: string; active: string; sub: string; installed: boolean } | null;
  deploys: { tone: Tone; counts: number[]; failed: number[]; median: number | null; longest: number | null; last: { at: number; outcome: string; by: string; sha: string | null; took: number | null } | null };
  errors: { counts: number[]; kinds: Record<string, number>; top: { kind: string; count: number; sample: string; last_at: number }[]; lastDay: number };
  turns: { counts: number[]; tokens: number[]; people: { name: string; turns: number }[] };
  disk: { bytes: number; at: number; warn_gb: number | null } | null;
  backup: { day: string | null; ok: boolean };
}

export interface StatusData {
  now: number;
  /** The Pacific days every per-day array follows, oldest first. */
  days: string[];
  /** Time to ship (#1132): each target the viewer can see, per day, with its ships' steps. */
  shipTimes: ShipTarget[];
  citadel: CitadelStatus;
  apps: AppStatus[];
}
