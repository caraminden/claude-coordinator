// The load-sensitive test files (#1898, Josh 2026-11-24: "Timing tests run last, alone"): tools/suite-runner.ts runs them
// after a suite's main wave, two at once. Nobody types the list: it is read from what the ship script already writes to
// shared/retro-log/<day>/land.md, so a file joins and leaves by itself.
//   joins   `flake` lines with a load reading (failed in the full run, passed alone) from two branches within three days
//   leaves  three days without such a line, or a fix proven after them (flake_fixes, held)
//   alone   it also failed run by itself in the last three days: a real failure, so it runs with the rest, and is marked

import type { Store } from './db.ts';
import type { FlakeFix } from './db-rows.ts';
import { readRetro, type RetroLine } from './land-reds.ts';
import { projectSharedDir } from './workspace.ts';

export type LateFix = Pick<FlakeFix, 'file' | 'state' | 'held_at' | 'ticket_id'>;
export interface LateTest {
  file: string;
  sightings: number;
  branches: string[];
  last: number;
  /** The lowest and highest load average it failed at. */
  loads: [number, number];
  /** The open fix's minion (tickets.id), or null. */
  fixing: number | null;
}
export interface AloneTest {
  file: string;
  failedAlone: number;
  where: string;
}

/** A file joins on this many branches' sightings within CLEAN_MS of each other, and leaves CLEAN_MS after its last. */
const BRANCHES = 2;
export const CLEAN_MS = 3 * 86_400_000;
/** How far back the log is read: a run of sightings with no gap of CLEAN_MS. shortcut: a file sighted every few days for longer counts from here. */
export const LATE_READ_MS = 14 * 86_400_000;
const TEST_FILE = /^test\/[\w./-]+\.test\.m?[jt]s$/;

/** Each failure of a file run by itself: a ship's reruns alone in CI, and main's own reds. */
function aloneFailures(l: RetroLine): { file: string; where: string }[] {
  const files = (s: string | undefined) => (s ?? '').split(/[\s,]+/).filter((f) => TEST_FILE.test(f));
  if (l.kind === 'failed alone') return files(l.parts[0]).map((file) => ({ file, where: l.parts[1] ?? '' }));
  // main's own red: refused ("red on main too: …") or shipped through
  if (l.kind.startsWith('red on main too') || l.kind === "shipped through main's red") return files(l.parts[1]).map((file) => ({ file, where: 'main' }));
  return [];
}

/** The list at `now`, from the retro log's lines (readRetro, LATE_READ_MS back) and each file's newest fix. */
export function lateTests(lines: RetroLine[], fixes: LateFix[], now: number): { listed: LateTest[]; alone: AloneTest[] } {
  const fixOf = new Map(fixes.map((f) => [f.file, f]));
  const settled = (file: string) => fixOf.get(file)?.held_at ?? 0;
  const sighted = new Map<string, { at: number; branch: string; load: number }[]>();
  const alone = new Map<string, AloneTest>();
  for (const l of [...lines].sort((a, b) => a.at - b.at)) {
    if (l.at > now) continue;
    for (const { file, where } of aloneFailures(l)) if (l.at > Math.max(now - CLEAN_MS, settled(file))) alone.set(file, { file, failedAlone: l.at, where });
    const [file, loadPart = '', branch = ''] = l.parts;
    const load = Number(loadPart.match(/^load ([\d.]+)$/)?.[1] ?? NaN);
    if (l.kind !== 'flake' || !TEST_FILE.test(file) || Number.isNaN(load) || l.at <= settled(file)) continue;
    let seen = sighted.get(file) ?? [];
    if (seen.length && l.at - seen[seen.length - 1].at > CLEAN_MS) seen = []; // it had left
    sighted.set(file, [...seen, { at: l.at, branch, load }]);
  }
  const joined = (seen: { at: number; branch: string }[]) => seen.some((s) => new Set(seen.filter((o) => o.branch && o.at <= s.at && s.at - o.at <= CLEAN_MS).map((o) => o.branch)).size >= BRANCHES);
  const on = [...sighted].filter(([, seen]) => now - seen[seen.length - 1].at <= CLEAN_MS && joined(seen));
  const listed = on
    .filter(([file]) => !alone.has(file))
    .map(([file, seen]) => {
      const loads = seen.map((s) => s.load);
      const fix = fixOf.get(file);
      return { file, sightings: seen.length, branches: [...new Set(seen.map((s) => s.branch).filter(Boolean))], last: seen[seen.length - 1].at, loads: [Math.min(...loads), Math.max(...loads)] as [number, number], fixing: fix?.state === 'open' ? fix.ticket_id : null };
    })
    .sort((a, b) => b.branches.length - a.branches.length || b.sightings - a.sightings || a.file.localeCompare(b.file));
  return { listed, alone: on.flatMap(([file]) => alone.get(file) ?? []).sort((a, b) => a.file.localeCompare(b.file)) };
}

/** A scheme's list now, read from its shared folder's retro log (the Test health tab and CI's own read, GET /api/late-tests). */
export async function lateList(app: { store: Store; dataDir: string }, projectId: number, now = Date.now()) {
  const fixes = new Map<string, LateFix>();
  for (const f of app.store.flakeFixes(projectId)) if (!fixes.has(f.file)) fixes.set(f.file, f); // newest first
  return lateTests(await readRetro(projectSharedDir(app.dataDir, projectId), now - LATE_READ_MS, now), [...fixes.values()], now);
}

/** When the scheme's CI last took its list (a setting). */
export const lateReadKey = (projectId: number) => `lateTests:read:${projectId}`;

/** The Test health tab's view of the list, each open fix's minion by number; null for a scheme whose CI never takes it. */
export async function lateView(app: { store: Store; dataDir: string }, projectId: number) {
  const readAt = app.store.getSetting<number>(lateReadKey(projectId));
  if (readAt == null) return null;
  const { listed, alone } = await lateList(app, projectId);
  return { readAt, listed: listed.map((f) => ({ ...f, fixing: f.fixing == null ? null : (app.store.getTicket(f.fixing)?.number ?? null) })), alone };
}
