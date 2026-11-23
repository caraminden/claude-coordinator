// Land runs' reds by cause (#1607, Cara 2026-11-22: "figure out the main culprits for minions that pass their own tests ...
// but then fail in the CI train"). The CI page's Test health tab counts the last day's CI runs on land/** branches and puts
// each red one under one cause, so its red rate says how often a ship's change was really at fault:
//   flaky   a test that passed alone, a burn-in copy race (failed in fewer than all copies), a known flake, a cut-off run
//   main    main was red on the same test and the train shipped through it (#1478)
//   change  a ship's own change: pinned by the train's suspects or bisect, a burn-in file red in every copy, or a lone
//           ship refused at CI with no flake on the run. `rider`: the change was another ship's on this train, not the lead's.
//   unknown the retro log says nothing about the run (a time-out, a run that never got to the tests, a log line lost)
// It reads only what tools/land.sh already writes to shared/retro-log/<day>/land.md: lines naming the run's link first, then
// the lead branch's own lines between the run's start and the next run on that branch (at most RUN_TAIL_MS after it ends).
// shortcut: a join by branch and time, not a per-run verdict line; upgrade if land.sh starts logging one line per red run.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Cause = 'flaky' | 'main' | 'change' | 'unknown';

/** A CI run as GitHub lists it, the fields this reads. */
export interface LandRun { id: number; head_branch: string; status: string; conclusion: string | null; created_at: string; updated_at?: string; html_url?: string }
/** One retro-log line: when, its kind (`ship train red`), the rest split on ` · `, and the run its link names. */
export interface RetroLine { at: number; kind: string; parts: string[]; run: number | null }
export interface Red { id: number; branch: string; at: string; url: string | null; cause: Cause; rider: boolean; why: string }
export interface LandReds { partial?: boolean; since: number; runs: number; green: number; red: number; other: number; causes: Record<Cause, number>; riders: number; reds: Red[] }

/** The window the Test health tab counts. */
export const LAND_REDS_MS = 24 * 3_600_000;
/** How long after a run ends its branch's own lines still count as its outcome: land.sh writes them within a few minutes. */
export const RUN_TAIL_MS = 20 * 60_000;
/** How long after a train's red run its suspects or bisect verdict can come: the bisect's own runs come first. */
export const TRAIN_MS = 60 * 60_000;
const RED = new Set(['failure', 'timed_out']);

/** The lines of one day's land.md (`- 02:45:47Z · <kind> · a · b`), the header and blank lines skipped. */
export function parseRetro(md: string, day: string): RetroLine[] {
  const out: RetroLine[] = [];
  for (const m of md.matchAll(/^- (\d\d:\d\d:\d\d)Z · ([^·\n]+?) · (.*)$/gm)) {
    const at = Date.parse(`${day}T${m[1]}Z`);
    if (Number.isNaN(at)) continue;
    const run = m[3].match(/\/actions\/runs\/(\d+)/);
    out.push({ at, kind: m[2].trim(), parts: m[3].split(' · ').map((s) => s.trim()), run: run ? Number(run[1]) : null });
  }
  return out;
}

const ticketOf = (branch: string) => branch.match(/^(?:land\/)?ticket\/(\d+)-/)?.[1] ?? null;
const sameShip = (label: string, lead: string) => label === lead || (ticketOf(lead) != null && label === `#${ticketOf(lead)}`);

/** A red run's cause, from the lines that name its link (`own`) and its branch's lines after it started (`after`, oldest first). */
export function causeOf(lead: string, own: RetroLine[], after: RetroLine[]): { cause: Cause; rider: boolean; why: string } {
  // A train's first red run is often named by no line: its suspects and bisect lines link the later runs they made.
  // A verdict that links this run beats one borrowed from a later round of the same train.
  const TRAIN = ['ship train red', 'ship train suspects'];
  const borrow = !own.some((l) => TRAIN.includes(l.kind));
  const train = (kind: string) => after.find((l) => l.kind === kind && l.run != null && sameShip(l.parts[0] ?? '', lead));
  const of = (kind: string) => own.find((l) => l.kind === kind) ?? (borrow && TRAIN.includes(kind) ? train(kind) : undefined);
  if (of("shipped through main's red")) return { cause: 'main', rider: false, why: `main was red on ${of("shipped through main's red")!.parts[1] ?? 'the same test'} too` };
  const bisect = of('ship train red');
  if (bisect) {
    const culprit = bisect.parts[1] ?? '';
    return { cause: 'change', rider: !sameShip(culprit, lead), why: `the bisect pinned ${culprit}` };
  }
  const sus = of('ship train suspects');
  const sure = sus?.parts.find((p) => p.startsWith('failed alone here: '))?.slice('failed alone here: '.length);
  if (sure) {
    const ships = sure.split(', ');
    return { cause: 'change', rider: !ships.some((s) => sameShip(s, lead)), why: `failed alone with ${sure}` };
  }
  const burn = own.filter((l) => l.kind === 'burn-in red').flatMap((l) => l.parts.join(' · ').match(/failed in \d+ of \d+ copies/g) ?? []);
  if (burn.some((b) => { const [, k, n] = b.match(/(\d+) of (\d+)/)!; return k === n; })) return { cause: 'change', rider: false, why: 'a new or changed test failed in every burn-in copy' };
  if (burn.length) return { cause: 'flaky', rider: false, why: 'a new or changed test failed in only some burn-in copies (a race)' };
  if (of('known flake')) return { cause: 'flaky', rider: false, why: `known flake: ${(of('known flake')!.parts[1] ?? '').replace(/ \(seen [^)]*\)/g, '')}`.trim() };
  // A guess land.sh couldn't confirm alone: one suspect ship is still that ship's change; several stay unknown.
  if (sus) {
    const named = (sus.parts[1] ?? '').split(/, (?=#|ticket\/)/).map((s) => s.replace(/ \(.*$/, ''));
    if (named.length === 1 && named[0]) return { cause: 'change', rider: !sameShip(named[0], lead), why: `suspect ${named[0]} (not confirmed alone)` };
  }
  // A cut-off rerun line links the run that was cut off.
  if (own.some((l) => l.kind === 'cut-off rerun')) return { cause: 'flaky', rider: false, why: 'cut off before any test failed' };
  // The lead's own lines: a refusal at CI, the flakes its run saw. A `flake rerun` line comes once the fresh run ends, so it is
  // that fresh run's: a red one says nothing more (its refusal does), the rest mean the fresh run never got to its tests.
  const mine = after.filter((l) => l.run == null);
  const rerun = mine.find((l) => l.kind === 'flake rerun' && l.parts.at(-1) !== 'red');
  if (rerun) return { cause: 'flaky', rider: false, why: `passed alone: ${rerun.parts[1] ?? ''}; the fresh run: ${rerun.parts.at(-1)}` };
  if (mine.some((l) => l.kind === 'timing' && l.parts.at(-1) === 'refused at ci')) return { cause: 'change', rider: false, why: 'refused at CI with a real failure' };
  const flakes = mine.filter((l) => l.kind === 'flake' && l.parts.includes('in CI'));
  if (flakes.length) return { cause: 'flaky', rider: false, why: `passed alone: ${flakes.map((l) => l.parts[0]).join(', ')}` };
  return { cause: 'unknown', rider: false, why: 'the retro log says nothing about this run' };
}

/** The land runs created since `since`, counted, and each red one's cause from the retro log's lines. */
export function landReds(runs: LandRun[], lines: RetroLine[], since: number): LandReds {
  const land = runs.filter((r) => r.head_branch.startsWith('land/') && Date.parse(r.created_at) >= since)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const out: LandReds = { since, runs: land.length, green: 0, red: 0, other: 0, causes: { change: 0, flaky: 0, main: 0, unknown: 0 }, riders: 0, reds: [] };
  const sorted = [...lines].sort((a, b) => a.at - b.at);
  for (const [i, r] of land.entries()) {
    if (r.status === 'completed' && r.conclusion === 'success') { out.green++; continue; }
    if (r.status !== 'completed' || !RED.has(r.conclusion ?? '')) { out.other++; continue; }
    out.red++;
    const lead = r.head_branch.slice('land/'.length);
    const start = Date.parse(r.created_at);
    const next = land.slice(i + 1).find((x) => x.head_branch === r.head_branch);
    const end = Math.min(Date.parse(r.updated_at ?? r.created_at) + RUN_TAIL_MS, next ? Date.parse(next.created_at) : Infinity);
    const own = sorted.filter((l) => l.run === r.id);
    // The lead's own lines up to its next run; its train's suspects and bisect verdicts, which come after the bisect's runs, for longer.
    const after = sorted.filter((l) => l.at >= start && l.run !== r.id && l.parts.includes(lead) && l.at < (l.run == null ? end : start + TRAIN_MS));
    const c = causeOf(lead, own, after);
    out.causes[c.cause]++;
    if (c.rider) out.riders++;
    out.reds.push({ id: r.id, branch: lead, at: r.created_at, url: r.html_url ?? null, ...c });
  }
  return out;
}

/** The retro log's lines of each UTC day from `since` to `now`, from a scheme's shared folder; a missing day is none. */
export async function readRetro(sharedDir: string, since: number, now: number): Promise<RetroLine[]> {
  const days: string[] = [];
  for (let t = since - (since % 86_400_000); t <= now; t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  const read = await Promise.all(days.map(async (d) => parseRetro(await readFile(join(sharedDir, 'retro-log', d, 'land.md'), 'utf8').catch(() => ''), d)));
  return read.flat();
}
