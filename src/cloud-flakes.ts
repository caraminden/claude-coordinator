// Flaky tests' repeat runs in Claude Code cloud sessions (#2187; Cara, 2026-11-26, picked "Start it after #2153": "moves
// minions' repeat-runs of flaky tests to cloud sessions and adds a nightly sweep that reruns the flakiest test files about 10
// times. Uses your plan's usage (about $0.50 per 20 minutes a session runs), not the server's CPU").
//
// tools/cloud-flake.ts runs inside a minion's turn, so its session is on that turn's person's own login (sender pays). Its
// `proof` reruns a minion's test files there instead of a heavy slot at home; its `sweep`, which a nightly schedule's minion
// runs, reruns the scheme's flakiest files on main's tip and posts the night here. A flaky result of the sweep becomes a
// flake sighting of source CLOUD_SOURCE: the Test health tab counts it and marks a file seen only there as cloud-only, but it
// never starts or reopens a fix minion (src/flake-fixes.ts skips it) and never refuses a ship (land.sh reads the retro log and
// flake_fixes, never these rows): a cloud VM has 4 vCPU, so timing-sensitive tests can fail there and nowhere else.

/** The flake_events source of a sighting made in a cloud session. */
export const CLOUD_SOURCE = 'cloud';

/** Cara's card's figure: about $0.50 for each 20 minutes a session runs, on its sender's plan (an estimate: its tokens never reach Citadel). */
export const cloudCostUsd = (minutes: number) => Math.round(minutes * 2.5) / 100;

export const SWEEP = {
  /** Files a night reruns, and copies at once of each (one batch, under load, as tools/flake-proof.sh runs it). */
  files: 10,
  copies: 10,
  /** Nights kept for the tab. */
  keep: 30,
};

/** What one batch of a file came to on the VM (tools/cloud-flake-vm.sh's verdicts). */
export const VERDICTS = ['clean', 'flaky', 'red', 'skipped', 'stopped'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface SweepFile {
  file: string;
  copies: number;
  /** Copies that failed. */
  failed: number;
  /** clean: every copy passed; flaky: some failed, or all did and it passed alone; red: it failed alone too on the VM (a plain red
   * or the VM's own environment, no race); skipped: a test skipped there, so it proves nothing; stopped: over the step's limit. */
  verdict: Verdict;
  seconds: number;
  detail: string;
}

export interface SweepNight {
  at: number;
  /** main's commit the session ran, as it read it. */
  sha: string | null;
  sessions: number;
  /** Wall minutes from the session's start to its result: what it is counted at. */
  minutes: number;
  costUsd: number;
  files: SweepFile[];
  /** The minion that ran it (its number). */
  minion: number | null;
  /** Why the night has no results, when it has none. */
  error: string | null;
}

export const sweepsKey = (projectId: number) => `cloud-sweeps:${projectId}`;

const FILE = /^[A-Za-z0-9_./-]{1,200}$/;

/** A night as a minion posted it, checked (it comes from a session's output, through a turn): the night, or why it's refused. */
export function readNight(body: unknown, minion: number | null, now: number): SweepNight | string {
  if (!body || typeof body !== 'object') return 'the body must be a JSON object';
  const b = body as Record<string, unknown>;
  const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
  const sessions = num(b.sessions, 20);
  const minutes = num(b.minutes, 24 * 60);
  if (sessions == null || minutes == null) return 'sessions (0 to 20) and minutes (0 to 1440) must be numbers';
  if (!Array.isArray(b.files) || b.files.length > 50) return 'files must be a list of at most 50';
  const files: SweepFile[] = [];
  for (const raw of b.files as unknown[]) {
    const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const copies = num(f.copies, 100);
    const failed = num(f.failed, 100);
    if (typeof f.file !== 'string' || !FILE.test(f.file) || f.file.split('/').includes('..')) return `a file must be a repo path: ${String(f.file).slice(0, 80)}`;
    if (!(VERDICTS as readonly unknown[]).includes(f.verdict)) return `${f.file}: verdict must be one of ${VERDICTS.join(', ')}`;
    if (copies == null || failed == null || failed > copies) return `${f.file}: copies and failed must be counts, failed no more than copies`;
    files.push({ file: f.file, copies, failed, verdict: f.verdict as Verdict, seconds: num(f.seconds, 86_400) ?? 0, detail: typeof f.detail === 'string' ? f.detail.slice(0, 1500) : '' });
  }
  const sha = typeof b.sha === 'string' && /^[0-9a-f]{7,64}$/.test(b.sha) ? b.sha : null;
  const error = typeof b.error === 'string' && b.error ? b.error.slice(0, 600) : null;
  return { at: now, sha, sessions, minutes: Math.round(minutes * 10) / 10, costUsd: cloudCostUsd(minutes), files, minion, error };
}

/** The sightings a night makes: only its flaky files (a red one failed alone there too, so it's no race). */
export function nightSightings(n: SweepNight): { file: string; source: string; detail: string }[] {
  return n.files.filter((f) => f.verdict === 'flaky').map((f) => ({ file: f.file, source: CLOUD_SOURCE, detail: `cloud sweep: failed in ${f.failed} of ${f.copies} copies at once on a 4-vCPU cloud VM${f.detail ? `\n${f.detail}` : ''}` }));
}

/** Kept nights with the new one first, at most SWEEP.keep. */
export const keepNights = (old: SweepNight[] | undefined, n: SweepNight) => [n, ...(old ?? [])].slice(0, SWEEP.keep);
