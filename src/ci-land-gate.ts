// The land gate's alarm (#561). Pure: read from the land line, no GitHub calls.
import { clock, held, type Problem } from './ci-problems.ts';

// ---------- the land gate (#561) ----------
// Josh's pick, 2026-11-11 ("Add the live alarm"): the CI gate that tools/land.sh waits on hung for hours on 11-11 and
// nobody heard. So the one alert also says when the gate fell back to perigee on LAND_STREAK lands in a row (cleared by
// the next land whose gate is green), or a land has been in the line LAND_SLOW_MS (cleared when it leaves). Read from
// what Waits.poll already sees every 2 s, the land line and ci-wait's view of each gate run: no GitHub calls of its own.
// On 11-10 and 11-11, 130 lands: 30 min was passed once outside the outage; 2 fallbacks in a row only in it, and
// while Cara's desktop was off, which isn't the gate failing (the runner-offline alert says it), so a land that never
// reached the CI wait (no runner online, LAND_CI=0, GitHub not answering, or the light lane) neither counts nor clears.
export const LAND_STREAK = 2;
// #1342: the line, not a ship, is what is slow. A ship 15th in line waits over an hour with nothing wrong, so the clock is
// how long the line has been still (its head land, that land's phase or CI run, and who is in it all unchanged), not a
// ship's age. Quiet after 20 min still (a ship's slowest honest step is the 15-min wait for a busy runner, #1361; the CI run's
// start moves the line); then it waits like every other problem (#1662: its Taskmaster first, phones an hour later).
export const LAND_SLOW_MS = 20 * 60_000;
// land.sh's CI_LIMIT is 540 s from the run's start (#1361, #1606): a run still going this far into the CI wait was cut off by it.
export const LAND_CAP_MS = 8 * 60_000;

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
  /** `at`: when it fell back (#1662: the streak waits from its LAND_STREAK-th); absent in state kept before, and set on the next look. */
  fellBack: { name: string; why: string; run: number | null; at?: number }[];
  /** #1342: when the line last moved (its head, the head's phase or CI run, or a land leaving), and what it looked like then. Absent in state kept before. */
  moved?: number;
  head?: string;
}
export const newLandState = (): LandState => ({ lands: {}, fellBack: [] });

/** Why a land's gate fell back, from what CI said while it waited. shortcut: a rate-limited ci-wait reads as GitHub's; land.sh's own reason would need it to say so in the line. */
export function fellBackWhy(l: Landing, now: number): string {
  if (!l.ci) return 'GitHub never started its run';
  if (l.ci === 'queued') return 'no runner started its job';
  if (l.ci === 'failed') return 'its run failed before the tests ran';
  if (l.ci === 'jobs' && now - (l.ciSince ?? now) >= LAND_CAP_MS) return 'the desktop suite hit the 9-min cap';
  return 'CI gave no verdict';
}

/** One look at the line: landings join and leave, a fallback adds to the count, a green gate ends it. Updates `s` in place. */
export function landStep(s: LandState, seen: LandSeen[], now: number): LandState {
  for (const f of s.fellBack) f.at ??= now;
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
      if (l.ciSince != null) s.fellBack.push({ name: l.name, why: fellBackWhy(l, now), run: l.run ?? null, at: now });
    } else if (x.phase === 'deploy' && !l.tests && !l.green && l.ciSince != null) {
      // #1521 (CA3): only a ship that waited on CI is a green gate; a light-lane ship (rebase then deploy) never asked CI.
      l.green = true;
      s.fellBack = [];
    }
  }
  let left = false;
  for (const key of Object.keys(s.lands)) if (!here.has(key)) { delete s.lands[key]; left = true; }
  // The head is the lowest seq in the line: it holds the lock, and each phase or CI run it passes through is progress.
  const first = seen.filter((x) => x.name !== 'tools/deploy.sh').sort((a, b) => a.seq - b.seq)[0];
  const head = first ? `${first.seq}/${first.phase}/${first.ci ?? ''}/${first.run ?? ''}` : '';
  if (s.moved == null || left || head !== s.head) s.moved = now;
  s.head = head;
  return s;
}

/**
 * The land gate's problems now. Each waits (#1662, Cara 2026-11-22: "After the wait, if nobody's on it"): its Taskmaster is
 * woken as it opens, and it rings if it's still open RED_FIX_MS later.
 */
export function landProblems(s: LandState, now: number): Problem[] {
  const out: Problem[] = [];
  const n = s.fellBack.length;
  if (n >= LAND_STREAK) {
    const named = s.fellBack.slice(-3).map((f) => `${f.name} (${f.why}${f.run ? `, run ${f.run}` : ''})`);
    const whys = [...new Set(s.fellBack.slice(-3).map((f) => f.why))];
    out.push(held({
      key: 'land:fallback',
      plain: { what: `the last ${n} ships skipped CI and ran the whole test suite on perigee instead`, next: whys.some((w) => /runner/.test(w)) ? "Check the desktop's Linux runners are online (the CI page's Runners tab); shipping goes back to CI by itself" : 'Open the fallen-back runs on the CI page and fix what stopped them; the next ship with a green gate clears this' },
      title: `CI: the ship gate fell back to perigee on ${n} ships in a row: ${n > 3 ? `${n - 3} more, then ` : ''}${named.join(', ')}`,
      why: `${whys.join('; ')}, so each ship ran the full suite on perigee instead of waiting on CI`,
      fix: whys.some((w) => /runner/.test(w)) ? "check the desktop's Linux runners are online (the CI page's Runners tab); shipping goes back to CI by itself"
        : 'open the fallen-back runs on the CI page and fix what stopped them; the next ship with a green gate clears this',
    }, s.fellBack[LAND_STREAK - 1].at ?? now, now));
  }
  // Ringing needs a line that is still non-empty and has not moved: a deep line whose head keeps changing is just busy.
  const line = Object.entries(s.lands).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, l]) => l);
  const since = s.moved ?? now;
  if (line.length && now - since >= LAND_SLOW_MS) {
    const behind = line.length - 1;
    out.push(held({
      key: 'land:slow',
      plain: { what: `shipping is stuck: nothing has moved in the ship line since ${clock(since)}, with ${line[0].name} first of ${line.length}`, next: "Read the first minion's ship output; if nothing has moved for 15 more minutes, tell the Citadel Taskmaster shipping is jammed" },
      title: `CI: the ship line has been still since ${clock(since)} (over 20 min): ${line[0].name} is first of ${line.length}${behind ? `, ${behind} waiting behind` : ''}`,
      why: 'the first ship, its step and the ships in the line have not changed, though each ship normally takes under 15 min, so its CI run, the suite or the deploy is stuck',
      fix: "read the first minion's land.sh output for its last queue: line; if nothing has moved for 15 min, tell the Citadel Taskmaster shipping is jammed",
    }, since + LAND_SLOW_MS, now));
  }
  return out;
}
