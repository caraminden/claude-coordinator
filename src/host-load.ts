// Host load (#1060): what tools/citadel-heavy already keeps in its folder, read for the CI page: the slots and who
// holds them, the line behind them, the CPU-pressure gate, and a week of waits per scheme from its history file.
// Read-only: the slot count stays a file (X2 was left unpicked: raising it put the load near 100 on Nov 10).
import { readFile } from 'node:fs/promises';
import { hostTextSync, PSI_FILES } from './host-signals.ts';
import { join } from 'node:path';
import { median, type HeavyJob, type HeavyJobs } from './waits.ts';
import { MAX_CPU_PRESSURE } from './pressure.ts';
import { longView, readLongJobs } from './long-jobs.ts';

/** citadel-heavy's defaults (its header): pressure at or above 50% holds a free slot, for at most 5 minutes. */
export const MAX_PRESSURE = MAX_CPU_PRESSURE;
export const LOAD_WAIT_S = 300;
const WEEK_MS = 7 * 24 * 3600_000;

/** What a citadel-heavy job was: a minion's turn, an app's deploy build, its APK build, or one of its own steps. */
export type JobKind = 'turn' | 'deploy' | 'apk' | 'app';
export interface Waits {
  jobs: number;
  medianS: number;
  longestS: number;
}
/** One kind of job inside a scheme's row: `label` is the app's name for an app's jobs, the scheme's for its turns. */
export interface WaitsPart extends Waits {
  label: string;
  kind: JobKind;
}
/** A scheme's week; `parts` splits it by kind when it has more than one (its turns, and each app it owns). */
export interface SchemeWaits extends Waits {
  scheme: string;
  parts?: WaitsPart[];
}
/** An app's name or title, lower-cased, to its home scheme's name (from the contraptions table). */
export type AppOwners = Map<string, string>;

/** Each app's name and title (lower case) to its home scheme's name, for the schemes `canSee` lets the viewer see:
 * which scheme owns an app is for its people and admins to know (#1068 review), so a hidden scheme claims nothing. */
export function appOwners(apps: { name: string; title: string; home_scheme: number | null }[], canSee: (id: number) => boolean, nameOf: (id: number) => string | undefined): AppOwners {
  const owners: AppOwners = new Map();
  for (const c of apps) {
    const home = c.home_scheme === null || !canSee(c.home_scheme) ? undefined : nameOf(c.home_scheme);
    if (home) for (const k of [c.name, c.title]) owners.set(k.toLowerCase(), home);
  }
  return owners;
}

/**
 * Who ran a heavy job, from citadel-heavy's who string: "Citadel #544 (cara)" is Citadel's turn, "peek-auras deploy"
 * an app's deploy build (src/app-services.ts), "TWIReader APK build" its APK (src/apk-build.ts, the app's title) and
 * "twireader (app)" one of its own steps (tools/citadel-app-heavy). An app's jobs go under its home scheme in `owners`,
 * so a scheme's row isn't split across its name and its app's slug; an app with no home scheme keeps its own name.
 */
export function jobOfWho(who: string, owners: AppOwners = new Map()): { scheme: string; label: string; kind: JobKind } {
  const m = who.match(/^(.*?)(?: #\d.*| (deploy)| (APK build)| \((app)\))$/);
  const label = (m?.[1] || who).trim();
  const kind: JobKind = m?.[2] ? 'deploy' : m?.[3] ? 'apk' : m?.[4] ? 'app' : 'turn';
  return { scheme: kind === 'turn' ? label : (owners.get(label.toLowerCase()) ?? label), label, kind };
}

/** The scheme a who string's job counts under (jobOfWho). */
export function schemeOfWho(who: string, owners?: AppOwners): string {
  return jobOfWho(who, owners).scheme;
}

const summary = (w: number[]): Waits => ({ jobs: w.length, medianS: median(w) ?? 0, longestS: Math.max(...w) });

/** The history file's lines since `since`: one entry per scheme with its median and longest wait. Bad lines are skipped. */
export function parseHistory(text: string, since: number, owners?: AppOwners): SchemeWaits[] {
  const by = new Map<string, Map<string, { label: string; kind: JobKind; w: number[] }>>();
  for (const line of text.split('\n')) {
    const [started, who, , , wait] = line.split('\t');
    const at = Date.parse(started ?? ''),
      w = Number(wait);
    if (!who || !(at >= since) || !Number.isFinite(w) || wait === '') continue;
    const j = jobOfWho(who, owners);
    const parts = by.get(j.scheme) ?? by.set(j.scheme, new Map()).get(j.scheme)!;
    const key = `${j.kind}\t${j.label}`;
    (parts.get(key) ?? parts.set(key, { label: j.label, kind: j.kind, w: [] }).get(key)!).w.push(w);
  }
  return [...by]
    .map(([scheme, parts]) => {
      const all = [...parts.values()];
      const row: SchemeWaits = { scheme, ...summary(all.flatMap((p) => p.w)) };
      if (all.length > 1) row.parts = all.map((p) => ({ label: p.label, kind: p.kind, ...summary(p.w) })).sort((a, b) => b.jobs - a.jobs);
      return row;
    })
    .sort((a, b) => b.longestS - a.longestS);
}

export interface PlaceWaits extends Waits {
  /** 'here' (perigee), 'on:<machine>' or 'ci:<owner>/<repo>'. */
  place: string;
  /** How many of its jobs waited on each thing, most first. */
  on: { why: string; jobs: number }[];
}

/**
 * The history's lines since `since` by where each job ran (#2109). Lines written before it have what a perigee job
 * waited on where the place now is, and nothing of that for a job elsewhere.
 */
export function parsePlaces(text: string, since: number): PlaceWaits[] {
  const by = new Map<string, { w: number[]; on: Map<string, number> }>();
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    const [started, who, , at4, wait] = f;
    const w = Number(wait);
    if (!who || !(Date.parse(started ?? '') >= since) || !Number.isFinite(w) || wait === '') continue;
    const elsewhere = /^(on|ci):/.test(at4!);
    const place = elsewhere ? at4! : 'here';
    const why = f[9] ?? (elsewhere || at4 === 'here' ? 'none' : at4!);
    const row = by.get(place) ?? by.set(place, { w: [], on: new Map() }).get(place)!;
    row.w.push(w);
    // 'light' ran at once without a slot: it waited on nothing.
    if (why !== 'none' && why !== 'light') row.on.set(why, (row.on.get(why) ?? 0) + 1);
  }
  return [...by].map(([place, r]) => ({ place, ...summary(r.w), on: [...r.on].map(([why, jobs]) => ({ why, jobs })).sort((a, b) => b.jobs - a.jobs) })).sort((a, b) => b.jobs - a.jobs);
}

const slotCount = async (dir: string): Promise<number> => {
  try {
    // citadel-heavy's rule: the first number, else 2; a 0 is one slot, and 64 is the most.
    const m = (await readFile(join(dir, 'slots'), 'utf8')).replace(/#.*/g, '').match(/\d+/)?.[0];
    return m === undefined ? 2 : Math.min(Math.max(Number(m), 1), 64);
  } catch {
    return 2;
  }
};

/** The gate's reading: /proc/pressure/cpu "some avg60" as a whole percent, or null without PSI. */
export function readPressure(file: string = PSI_FILES.cpu): number | null {
  try {
    return Math.floor(Number(hostTextSync(file).match(/^some .*avg60=([\d.]+)/m)?.[1]));
  } catch {
    return null;
  }
}

export interface HostLoad {
  slots: number;
  holders: (HeavyJob & { scheme: string })[];
  waiters: (HeavyJob & { scheme: string })[];
  pressure: number | null;
  maxPressure: number;
  loadWaitS: number;
  week: SchemeWaits[];
  /** The same week by where the jobs ran (#2109). */
  places: PlaceWaits[];
  /** Long jobs (#1363): queued, running, and ended in the last day. */
  long: (ReturnType<typeof longView>[number] & { scheme: string })[];
  now: number;
}

export async function hostLoad(dir: string, heavy: HeavyJobs, now = Date.now(), pressureFile?: string, owners?: AppOwners, longs = readLongJobs(dir)): Promise<HostLoad> {
  const { holders, waiters } = heavy;
  const tag = (j: HeavyJob) => ({ ...j, scheme: schemeOfWho(j.who, owners) });
  let history = '';
  try {
    history = await readFile(join(dir, 'history'), 'utf8');
  } catch {
    /* none yet */
  }
  return {
    slots: await slotCount(dir),
    holders: holders.map(tag),
    waiters: waiters.filter((w) => w.reason !== 'ease').map(tag) /* a nested session claude-pace holds is no heavy job */,
    pressure: readPressure(pressureFile),
    maxPressure: MAX_PRESSURE,
    loadWaitS: LOAD_WAIT_S,
    week: parseHistory(history, now - WEEK_MS, owners),
    places: parsePlaces(history, now - WEEK_MS),
    long: longView(longs, now).map((j) => ({ ...j, scheme: schemeOfWho(j.who, owners) })),
    now,
  };
}
