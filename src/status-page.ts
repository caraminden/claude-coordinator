// The Status page (#1123): "is Citadel OK?" and "is my app OK?" from one read. Citadel's own server (uptime and why
// it last restarted, stalls, memory and disk, ships, CI, its units, the CI desktop) and each app the viewer can see
// (deploys, errors, agent turns, who used it, disk), each with a week of daily history. Read-only: it only reads
// what other parts already record, plus perigee's memory and disk, which HostSampler samples every 5 minutes.
import { readFile, statfs } from 'node:fs/promises';
import { loadavg } from 'node:os';
import type { Store, HostSample, ReleaseRow, ContraptionRow } from './db.ts';
import type { CiView } from './ci-health.ts';
import type { PcView } from './ci-load.ts';
import type { DiskUse, UnitState } from './app-services.ts';
import { pacificDay } from './contraption-errors.ts';

const DAY_MS = 24 * 60 * 60_000;
/** Days of history each tile shows: today and the 7 before it. */
export const STATUS_DAYS = 8;
export const SAMPLE_EVERY_MS = 5 * 60_000;
/** How long a built page is reused: every open page re-reads every 30 s. */
const BUILD_KEEP_MS = 20_000;
/** Citadel's own units (deploy/), whose state the page shows; one that isn't installed is listed as such, not as trouble. */
export const CITADEL_UNITS = ['claude-coordinator.service', 'claude-coordinator-backup.timer', 'claude-coordinator-prune.timer', 'citadel-watchdog.timer', 'citadel-embed.service', 'citadel-android-adb.service'];
/** A stall at least this long, in the last day, turns Citadel's verdict to warn. */
const STALL_WARN_S = 5;
/** Errors in an app's last day that turn its verdict to warn. */
export const APP_ERRORS_WARN = 10;

export type Tone = 'ok' | 'warn' | 'bad';
export interface Verdict { tone: Tone; reasons: string[] }

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

const worst = (reasons: [Tone, string][]): Verdict => {
  const bad = reasons.filter(([t]) => t === 'bad').map(([, r]) => r);
  const warn = reasons.filter(([t]) => t === 'warn').map(([, r]) => r);
  return bad.length ? { tone: 'bad', reasons: [...bad, ...warn] } : warn.length ? { tone: 'warn', reasons: warn } : { tone: 'ok', reasons: [] };
};

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
  ciSnapshot?: (canSee: (id: number) => boolean) => { id: number; view: CiView }[];
  desktops?: () => PcView[];
  diskUse?: (row: ContraptionRow) => DiskUse | null;
  /** systemctl --user show for these units; null where it can't be read (a preview, a test). */
  unitStates?: (units: string[]) => Promise<UnitState[]>;
  now?: () => number;
  mem?: () => Promise<{ total: number; avail: number }>;
  disk?: (dir: string) => Promise<{ total: number; free: number }>;
}

/** Who reads the page: canSee is the store's for their session; admin sees apps with no home scheme too. */
export interface Viewer { canSee: (projectId: number) => boolean; admin: boolean; key: string }

export class StatusPage {
  private built = new Map<string, { at: number; data: Promise<StatusData> }>();
  private units: { at: number; rows: UnitState[] } | null = null;
  private timer: NodeJS.Timeout | null = null;
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
      const s: HostSample = {
        at: this.now(), mem_total: mem.total, mem_avail: Number.isFinite(mem.avail) ? mem.avail : 0,
        disk_total: disk.total, disk_free: disk.free, load1: loadavg()[0], rss: process.memoryUsage.rss(),
      };
      this.deps.store.addHostSample(s);
      return s;
    } catch (err: any) {
      console.error(`Status sample failed: ${err?.message ?? err}`);
      return null;
    }
  }

  start() {
    void this.sample();
    this.timer = setInterval(() => void this.sample(), SAMPLE_EVERY_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
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

  private async unitRows(apps: ContraptionRow[]): Promise<UnitState[]> {
    const now = this.now();
    if (this.units && now - this.units.at < 60_000 && now >= this.units.at) return this.units.rows;
    const names = [...CITADEL_UNITS, ...apps.map((a) => `citadel-app-${a.name}.service`)];
    const rows = await this.deps.unitStates?.(names).catch(() => [] as UnitState[]) ?? [];
    this.units = { at: now, rows };
    return rows;
  }

  async build(viewer: Viewer, now = this.now()): Promise<StatusData> {
    const { store } = this.deps;
    const days = lastDays(now);
    const since = now - STATUS_DAYS * DAY_MS;
    const apps = store.listContraptions().filter((a) => (a.home_scheme === null ? viewer.admin : viewer.canSee(a.home_scheme)));
    const units = await this.unitRows(store.listContraptions());
    const unitOf = (u: string) => units.find((r) => r.unit === u) ?? null;
    return {
      now,
      days,
      citadel: this.citadel(viewer, now, days, since, units),
      apps: apps.map((a) => appVitals(store, a, now, days, since, unitOf(`citadel-app-${a.name}.service`), this.deps.diskUse?.(a) ?? null)),
    };
  }

  private citadel(viewer: Viewer, now: number, days: string[], since: number, units: UnitState[]): CitadelStatus {
    const { store, bootAt } = this.deps;
    const dayOf = (at: number) => pacificDay(at);
    const blank = () => Object.fromEntries(days.map((d) => [d, 0])) as Record<string, number>;
    const events = store.healthEventsSince(['boot', 'loop-lag'], since);
    // Restarts: each boot, why, and how many a day.
    const boots = events.filter((e) => e.kind === 'boot');
    const lastBoot = boots.filter((b) => b.at <= bootAt + 60_000).at(-1) ?? null;
    const restarts = blank();
    for (const b of boots) if (dayOf(b.at) in restarts) restarts[dayOf(b.at)]++;
    // Stalls: count and longest per day, and the last one's line.
    const stallCount = blank();
    const stallLongest = blank();
    const stalls = events.filter((e) => e.kind === 'loop-lag');
    for (const s of stalls) {
      const d = dayOf(s.at);
      if (!(d in stallCount)) continue;
      stallCount[d]++;
      stallLongest[d] = Math.max(stallLongest[d], stallSeconds(s.detail) ?? 0);
    }
    const lastStall = stalls.at(-1);
    // Memory and disk: the hourly worst (least free), and the newest reading.
    const samples = store.hostSamples(since);
    const hourly = new Map<number, HostSample>();
    for (const s of samples) {
      const h = Math.floor(s.at / 3_600_000) * 3_600_000;
      const prev = hourly.get(h);
      if (!prev || s.mem_avail / s.mem_total < prev.mem_avail / prev.mem_total) hourly.set(h, { ...s, disk_free: Math.min(s.disk_free, prev?.disk_free ?? Infinity) });
      else prev.disk_free = Math.min(prev.disk_free, s.disk_free);
    }
    const series = [...hourly.entries()].map(([h, s]) => [h, Math.round((1 - s.mem_avail / s.mem_total) * 1000) / 10, Math.round((1 - s.disk_free / s.disk_total) * 1000) / 10] as [number, number, number]);
    const latest = samples.at(-1) ?? null;
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
    const lastShip = releases.at(-1);
    // CI: Citadel's workflows' verdicts on main and how many of the runs the last poll saw passed.
    const view = own && viewer.canSee(own) ? this.deps.ciSnapshot?.((id) => id === own && viewer.canSee(id)).find((s) => s.id === own)?.view : undefined;
    const done = (view?.runs ?? []).filter((r: any) => r.status === 'completed' && r.conclusion && r.conclusion !== 'cancelled' && r.conclusion !== 'skipped');
    const ci = view ? {
      at: view.at, url: `https://github.com/${view.slug}/actions`,
      workflows: view.workflows.filter((w) => !w.quiet).map((w) => ({ name: w.name, conclusion: w.verdict?.conclusion ?? null, status: w.verdict?.status ?? null, at: w.verdict?.at ?? null, url: w.verdict?.url ?? null })),
      runs: done.length, green: done.filter((r: any) => r.conclusion === 'success').length,
    } : null;
    const citadelUnits = units.filter((u) => CITADEL_UNITS.includes(u.unit));
    const desktops = (this.deps.desktops?.() ?? []).map((pc) => ({ host: pc.host, verdict: pc.verdict, now: pc.now, restarts: pc.restarts, seen: pc.series.some((s) => s[1] !== null) }));
    // The verdict: bad on a failed unit; warn on a restart that wasn't a ship, a long stall, low memory or disk, or red CI.
    const reasons: [Tone, string][] = [];
    for (const u of citadelUnits) if (u.active === 'failed') reasons.push(['bad', `${u.unit} failed`]);
    const dayAgo = now - DAY_MS;
    const oddBoots = boots.filter((b) => b.at >= dayAgo && b.detail.startsWith('a restart'));
    if (oddBoots.length) reasons.push(['warn', `${oddBoots.length} restart${oddBoots.length > 1 ? 's' : ''} without a ship in the last day`]);
    const longStall = Math.max(0, ...stalls.filter((s) => s.at >= dayAgo).map((s) => stallSeconds(s.detail) ?? 0));
    if (longStall >= STALL_WARN_S) reasons.push(['warn', `a ${longStall.toFixed(1)} s stall in the last day`]);
    if (latest && latest.mem_avail / latest.mem_total < 0.1) reasons.push(['warn', 'under 10% of memory free']);
    if (latest && latest.disk_free / latest.disk_total < 0.1) reasons.push(['warn', 'under 10% of disk free']);
    const red = ci?.workflows.filter((w) => w.conclusion && w.conclusion !== 'success') ?? [];
    if (red.length) reasons.push(['warn', `CI red on main: ${red.map((w) => w.name).join(', ')}`]);
    return {
      verdict: worst(reasons),
      uptime: { bootAt, commit: this.deps.commit, reason: lastBoot?.detail ?? null, restarts: days.map((d) => restarts[d]), boots: boots.slice(-10).reverse().map((b) => ({ at: b.at, reason: b.detail, commit: b.commit_sha })) },
      stalls: { counts: days.map((d) => stallCount[d]), longest: days.map((d) => Math.round(stallLongest[d] * 10) / 10), last: lastStall ? { at: lastStall.at, seconds: stallSeconds(lastStall.detail), detail: lastStall.detail.slice(0, 300) } : null },
      host: { series, latest, sampledFrom: samples[0]?.at ?? null },
      ships: { counts: days.map((d) => ships[d]), median: days.map((d) => median(shipTimes[d])), last: lastShip ? { at: lastShip.live_at!, version: lastShip.version.slice(0, 8), changes: shipChanges(lastShip) } : null },
      ci,
      units: citadelUnits.map((u) => ({ unit: u.unit, load: u.load, active: u.active, sub: u.sub })),
      desktops,
      // Tiles still to come: the minions that build them fill these in (Build 5, lane 3).
      slots: [
        { key: 'line', title: 'Ship line', note: 'Who is shipping and who waits: coming with the line panel.' },
        { key: 'ship-time', title: 'Time to ship', note: 'How long a ship takes, step by step: coming next in Build 5.' },
        { key: 'backups', title: 'Backups', note: 'When each backup last ran and whether it worked: coming in Build 5.' },
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
export function appVitals(store: Store, a: ContraptionRow, now: number, days: string[], since: number, unit: UnitState | null, disk: DiskUse | null): AppStatus {
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
  const reasons: [Tone, string][] = [];
  if (unit && unit.load !== 'not-found' && unit.active !== 'active' && unit.active !== 'activating' && unit.active !== 'reloading') reasons.push(['bad', `its service is ${unit.active}`]);
  if (lastDeploy?.outcome === 'failed') reasons.push(['bad', 'its last deploy failed']);
  else if (dFailed.some(Boolean)) reasons.push(['warn', `${dFailed.reduce((x, y) => x + y, 0)} failed deploy${dFailed.reduce((x, y) => x + y, 0) > 1 ? 's' : ''} this week`]);
  if (lastDay >= APP_ERRORS_WARN) reasons.push(['warn', `${lastDay} errors in the last day`]);
  if (disk?.warn_gb && disk.data_bytes >= disk.warn_gb * 1e9) reasons.push(['warn', `its data is over ${disk.warn_gb} GB`]);
  return {
    name: a.name, title: a.title, icon: a.icon, scheme: a.home_scheme,
    verdict: worst(reasons),
    service: unit ? { unit: unit.unit, active: unit.active, sub: unit.sub, installed: unit.load !== 'not-found' } : null,
    deploys: { counts: dCount, failed: dFailed, median: median(took), longest: took.length ? Math.max(...took) : null, last: lastDeploy ? { at: lastDeploy.started_at, outcome: lastDeploy.outcome, by: lastDeploy.by, sha: lastDeploy.to_sha?.slice(0, 8) ?? null, took: lastDeploy.finished_at ? (lastDeploy.finished_at - lastDeploy.started_at) / 1000 : null } : null },
    errors: { counts: eCount, kinds, top, lastDay },
    turns: { counts: tCount, tokens: tTokens, people: [...people.entries()].sort((x, y) => y[1] - x[1]).map(([name, turns]) => ({ name, turns })) },
    disk: disk ? { bytes: disk.data_bytes, at: disk.measured_at, warn_gb: disk.warn_gb } : null,
    // Filled in by the backup freshness minion (Build 5, lane 3).
    backup: null,
  };
}

export interface CitadelStatus {
  verdict: Verdict;
  uptime: { bootAt: number; commit: string; reason: string | null; restarts: number[]; boots: { at: number; reason: string; commit: string | null }[] };
  stalls: { counts: number[]; longest: number[]; last: { at: number; seconds: number | null; detail: string } | null };
  /** series: [hour, memory used %, disk used %], the hour's worst. */
  host: { series: [number, number, number][]; latest: HostSample | null; sampledFrom: number | null };
  ships: { counts: number[]; median: (number | null)[]; last: { at: number; version: string; changes: string[] } | null };
  ci: { at: number; url: string; workflows: { name: string; conclusion: string | null; status: string | null; at: string | null; url: string | null }[]; runs: number; green: number } | null;
  units: { unit: string; load: string; active: string; sub: string }[];
  desktops: { host: string; verdict: PcView['verdict']; now: PcView['now']; restarts: number[]; seen: boolean }[];
  slots: { key: string; title: string; note: string }[];
}

export interface AppStatus {
  name: string;
  title: string;
  icon: string | null;
  scheme: number | null;
  verdict: Verdict;
  service: { unit: string; active: string; sub: string; installed: boolean } | null;
  deploys: { counts: number[]; failed: number[]; median: number | null; longest: number | null; last: { at: number; outcome: string; by: string; sha: string | null; took: number | null } | null };
  errors: { counts: number[]; kinds: Record<string, number>; top: { kind: string; count: number; sample: string; last_at: number }[]; lastDay: number };
  turns: { counts: number[]; tokens: number[]; people: { name: string; turns: number }[] };
  disk: { bytes: number; at: number; warn_gb: number | null } | null;
  backup: null;
}

export interface StatusData {
  now: number;
  /** The Pacific days every per-day array follows, oldest first. */
  days: string[];
  citadel: CitadelStatus;
  apps: AppStatus[];
}
