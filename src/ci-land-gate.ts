// The land gate's alarm (#561; split out of ci-health.ts, behaviour unchanged). Pure: read from the land line, no GitHub calls.
import { clock, type Problem } from './ci-problems.ts';

// ---------- the land gate (#561) ----------
// Josh's pick, 2026-11-11 ("Add the live alarm"): the CI gate that tools/land.sh waits on hung for hours on 11-11 and
// nobody heard. So the one alert also says when the gate fell back to perigee on LAND_STREAK lands in a row (cleared by
// the next land whose gate is green), or a land has been in the line LAND_SLOW_MS (cleared when it leaves). Read from
// what Waits.poll already sees every 2 s, the land line and ci-wait's view of each gate run: no GitHub calls of its own.
// On 11-10 and 11-11, 130 lands: 30 min was passed once outside the outage; 2 fallbacks in a row only in it, and
// while Cara's desktop was off, which isn't the gate failing (the runner-offline alert says it), so a land that never
// reached the CI wait (no runner online, LAND_CI=0, GitHub not answering) neither counts nor clears.
export const LAND_STREAK = 2;
export const LAND_SLOW_MS = 30 * 60_000;
// #968 (Cara: "Quiet, ring after 1 h"): those make a quiet item; these ring.
export const LAND_RING_STREAK = 4;
export const LAND_RING_MS = 3600_000;
// land.sh's CI_LIMIT is 360 s: a run still going this far into the CI wait was cut off by it.
export const LAND_CAP_MS = 5 * 60_000;

/** A landing in the line as Waits.poll sees it. */
export interface LandSeen {
  /** Its ticket's number in the line (tools/deploy-queue.sh). */
  seq: number;
  /** "#551", or its label. */
  name: string;
  /** landPhase's key while it holds the lock (rebase, ci, tests, deploy); 'line' while it waits. */
  phase: string;
  /** Its gate run's stage as ci-wait last read it (CiNow's), and the run's id. */
  ci: string | null;
  run: number | null;
}
export interface Landing {
  name: string;
  joined: number;
  ciSince?: number;
  ci?: string | null;
  run?: number | null;
  tests?: boolean;
  green?: boolean;
}
export interface LandState {
  /** By seq: the landings in the line now. */
  lands: Record<string, Landing>;
  /** The fallbacks since the last green gate, oldest first. */
  fellBack: { name: string; why: string; run: number | null }[];
}
export const newLandState = (): LandState => ({ lands: {}, fellBack: [] });

/** Why a land's gate fell back, from what CI said while it waited. shortcut: a rate-limited ci-wait reads as GitHub's; land.sh's own reason would need it to say so in the line. */
export function fellBackWhy(l: Landing, now: number): string {
  if (!l.ci) return 'GitHub never started its run';
  if (l.ci === 'queued') return 'no runner started its job';
  if (l.ci === 'failed') return 'its run failed before the tests ran';
  if (l.ci === 'jobs' && now - (l.ciSince ?? now) >= LAND_CAP_MS) return 'the desktop suite hit the 6-min cap';
  return 'CI gave no verdict';
}

/** One look at the line: landings join and leave, a fallback adds to the count, a green gate ends it. Updates `s` in place. */
export function landStep(s: LandState, seen: LandSeen[], now: number): LandState {
  const here = new Set<string>();
  for (const x of seen) {
    if (x.name === 'tools/deploy.sh') continue; // a deploy on its own isn't a land
    const key = String(x.seq);
    here.add(key);
    const l = (s.lands[key] ??= { name: x.name, joined: now });
    if (x.phase === 'ci') {
      l.ciSince ??= now;
      if (x.ci) l.ci = x.ci;
      if (x.run) l.run = x.run;
    } else if (x.phase === 'tests' && !l.tests) {
      l.tests = true;
      if (l.ciSince != null) s.fellBack.push({ name: l.name, why: fellBackWhy(l, now), run: l.run ?? null });
    } else if (x.phase === 'deploy' && !l.tests && !l.green) {
      l.green = true;
      s.fellBack = [];
    }
  }
  for (const key of Object.keys(s.lands)) if (!here.has(key)) delete s.lands[key];
  return s;
}

/** The land gate's problems now: quiet items, ringing at LAND_RING_STREAK fallbacks or LAND_RING_MS in the line. */
export function landProblems(s: LandState, now: number): Problem[] {
  const out: Problem[] = [];
  const n = s.fellBack.length;
  if (n >= LAND_STREAK) {
    const named = s.fellBack.slice(-3).map((f) => `${f.name} (${f.why}${f.run ? `, run ${f.run}` : ''})`);
    const whys = [...new Set(s.fellBack.slice(-3).map((f) => f.why))];
    out.push({
      key: 'land:fallback', quiet: n < LAND_RING_STREAK,
      title: `CI: the ship gate fell back to perigee on ${n} ships in a row: ${n > 3 ? `${n - 3} more, then ` : ''}${named.join(', ')}`,
      why: `${whys.join('; ')}, so each ship ran the full suite on perigee instead of waiting on CI`,
      fix: whys.some((w) => /runner/.test(w)) ? "check the desktop's Linux runners are online (the CI page's Runners tab); shipping goes back to CI by itself"
        : 'open the fallen-back runs on the CI page and fix what stopped them; the next ship with a green gate clears this',
    });
  }
  const slow = Object.values(s.lands).filter((l) => now - l.joined >= LAND_SLOW_MS).sort((a, b) => a.joined - b.joined);
  if (slow.length) {
    const names = slow.map((l) => l.name);
    const ring = now - slow[0].joined >= LAND_RING_MS;
    const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} have` : `${names[0]} has`;
    out.push({
      key: 'land:slow', quiet: !ring,
      title: `CI: ${who} been shipping since ${clock(slow[0].joined)} (over ${ring ? '1 h' : '30 min'})`,
      why: 'shipping normally takes under 15 min, so its CI run, the suite or the deploy is stuck',
      fix: "read the shipping minion's land.sh output for its last queue: line; if nothing has moved for 15 min, tell the Citadel Taskmaster shipping is jammed",
    });
  }
  return out;
}
