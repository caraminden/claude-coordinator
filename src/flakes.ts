// Flaky test files (#1063): a land's or fast mode's output names each file that failed in the full run and passed alone
// (land.sh's `land: flake: <file> · <where>` lines, run-tests.sh's "failed in the full run, passed alone"). Each becomes a
// flake_events row, and the CI page's Test health tab counts them and offers a minion to fix one.

import { execFile } from 'node:child_process';
import { pacificStamp } from './pacific.ts';

/** When `file`'s newest commit on main was made (ms), or null when git can't say. A sighting from before it was of the old file (#1219). */
export function fileChangedAt(repoDir: string, file: string): Promise<number | null> {
  return new Promise((done) => execFile('git', ['log', '-1', '--format=%ct', 'main', '--', file], { cwd: repoDir, timeout: 15_000 }, (err, out) => {
    const sec = Number(String(out ?? '').trim());
    done(err || !Number.isFinite(sec) || sec <= 0 ? null : sec * 1000);
  }));
}

/**
 * When the default branch first held `branch`'s tip (ms), from main's reflog (#1521, CA1): land.sh fast-forwards main onto the
 * rebased branch, so a shipped fix's tip is on main. null: not on main (never shipped); undefined: can't tell (no such branch,
 * git failed). With the reflog gone it falls back to the tip's commit time, which a rebase at ship time keeps close.
 */
export async function branchShippedAt(repoDir: string, branch: string): Promise<number | null | undefined> {
  const git = (...args: string[]) => new Promise<string | null>((done) => execFile('git', args, { cwd: repoDir, timeout: 15_000, maxBuffer: 16 << 20 }, (err, out) => done(err ? null : String(out))));
  const tip = (await git('rev-parse', '-q', '--verify', `refs/heads/${branch}^{commit}`))?.trim();
  if (!tip) return undefined;
  const after = await git('rev-list', `${tip}..main`);
  if (after == null) return undefined;
  if ((await git('merge-base', '--is-ancestor', tip, 'main')) == null) return null;
  const holds = new Set([tip, ...after.split('\n').filter(Boolean)]);
  let first: number | null = null;
  const log = (await git('reflog', 'show', '--date=unix', '--format=%H %gd', 'refs/heads/main')) ?? '';
  for (const line of log.split('\n')) {
    const m = /^([0-9a-f]+) \S*@\{(\d+)\}$/.exec(line);
    if (m && holds.has(m[1])) first = Number(m[2]) * 1000; // newest first: the last one that holds it is the earliest
  }
  if (first != null) return first;
  const sec = Number((await git('log', '-1', '--format=%ct', tip))?.trim());
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : undefined;
}

/** The same-flake alarm (#1245): one test passing alone on this many different branches inside the window wakes the Taskmaster, once per test per day or until its file changes on main. */
export const ALARM_BRANCHES = 3;
export const ALARM_WINDOW_MS = 30 * 60_000;
export const ALARM_QUIET_MS = 24 * 60 * 60_000;

/** The commits a same-flake alarm names: the newest on main before the first sighting, and the newest that touched the test file (the same one is named once). */
export function suspectCommits(repoDir: string, file: string, firstAt: number): Promise<string | null> {
  const before = new Date(firstAt).toISOString();
  const one = (...extra: string[]) => new Promise<string>((done) => execFile('git', ['log', '-1', '--format=%h %s', `--before=${before}`, 'main', ...extra], { cwd: repoDir, timeout: 15_000 }, (err, out) => done(err ? '' : String(out).trim())));
  return Promise.all([one(), one('--', file)]).then(([last, touched]) => {
    const parts = [last && `last on main before the first sighting: ${last}`, touched && touched !== last && `last to touch ${file}: ${touched}`].filter(Boolean);
    return parts.length ? parts.join('; ') : null;
  });
}

/** The earliest sighting at which `sights` (one file's, oldest first) show ALARM_BRANCHES different branches inside ALARM_WINDOW_MS, with the window's sightings; null when none do. */
export function sameFlake(sights: { at: number; branch?: string }[]): { at: number; branches: string[]; first: number } | null {
  for (let i = 0; i < sights.length; i++) {
    const inWin = sights.filter((s) => s.at <= sights[i].at && s.at > sights[i].at - ALARM_WINDOW_MS && s.branch);
    const branches = [...new Set(inWin.map((s) => s.branch!))];
    if (branches.length >= ALARM_BRANCHES) return { at: sights[i].at, branches, first: Math.min(...inWin.map((s) => s.at)) };
  }
  return null;
}

export const FLAKE_WINDOW_MS = 14 * 24 * 60 * 60_000;
/** The third sighting of one file inside this window starts its fix minion (#1120). */
export const FLAKE_REPEAT = 3;
export const FLAKE_REPEAT_MS = 7 * 24 * 60 * 60_000;
/** A fix is held after this many clean runs of the file on the desktop runner: 5 batches of 10 copies at once, no batch red (#1443). */
export const PROOF_RUNS = 50;
/** The proof workflow runs the file in batches, one step each, so a run's steps say how many runs were clean without reading its log. */
export const PROOF_BATCH = 10;
const FILE = /^[\w./-]+\.test\.ts$/;

/** One flake per file in `output`, with where it was seen and the output's other lines naming the file kept as the detail (the first 5, 400 chars: run-tests' "passed alone" line with its load; land.sh's own output has no failing lines). */
export function parseFlakes(output: string): { file: string; source: string; detail: string }[] {
  const seen = new Map<string, string>();
  for (const m of output.matchAll(/^(?:land: flake: (\S+) · (.+)|run-tests: (\S+): failed in the full run, passed alone.*)$/gm)) {
    const file = m[1] ?? m[3];
    if (FILE.test(file) && !seen.has(file)) seen.set(file, m[2] ?? 'run-tests');
  }
  return [...seen].map(([file, source]) => {
    const lines = output.split('\n').filter((l) => l.includes(file) && !l.startsWith('land: flake:')).slice(0, 5);
    return { file, source: source.replace(/\s+/g, ' ').slice(0, 40), detail: lines.join('\n').slice(0, 400) };
  });
}

/**
 * The flake lines of one day's retro log (shared/retro-log/<day>/land.md), written by land.sh's retro_log and run-tests.sh's
 * log_flake: `- 02:45:47Z · flake · test/x.test.ts · load 16.43 · <branch> · in CI`. Every line is a sighting, whether or not the
 * land that saw it was one the server read (a minion's own test run, a deploy's, a land that ended while the server was down),
 * which is the undercount #1120 fixes. "flake rerun" lines are no sightings.
 */
export function parseRetroFlakes(md: string, day: string): { file: string; at: number; source: string; branch?: string }[] {
  const out: { file: string; at: number; source: string; branch?: string }[] = [];
  for (const m of md.matchAll(/^- (\d\d:\d\d:\d\d)Z · flake · (.+)$/gm)) {
    const parts = m[2].split(' · ');
    const at = Date.parse(`${day}T${m[1]}Z`);
    if (!FILE.test(parts[0]) || Number.isNaN(at)) continue;
    const source = parts.includes('in CI') ? 'in CI' : parts[1] === 'smoke' ? 'smoke' : 'run-tests';
    // land.sh and run-tests.sh write the branch after the load: `· load 16.4 · ticket/945-x · in CI`.
    const branch = source === 'smoke' ? undefined : parts.slice(1).find((x) => x !== 'in CI' && !x.startsWith('load '));
    out.push({ file: parts[0], at, source, ...(branch ? { branch } : {}) });
  }
  return out;
}

/** The proof's clean runs from its run's steps (PROOF_BATCH each, a step per batch named "<n> clean runs …"), all of PROOF_RUNS once the run is green. */
export function cleanRuns(steps: { name?: string; conclusion?: string | null }[], conclusion: string | null): number {
  if (conclusion === 'success') return PROOF_RUNS;
  const n = steps.filter((s) => /^\d+ clean runs/.test(s.name ?? '') && s.conclusion === 'success').length * PROOF_BATCH;
  return Math.min(n, PROOF_RUNS - PROOF_BATCH);
}

/** What the "Start a minion" button sends as a new minion's first message. */
export function flakeBrief(file: string, count: number, details: { at: number; detail: string }[], errors: { message: string; test: string; cls: string; count: number }[] = []): { title: string; message: string } {
  const when = pacificStamp;
  const seen = errors.length ? `How it fails (the error CI printed, most common first):\n\n${errors.map((e) => `${e.count}× ${e.cls || 'other'}${e.test ? ` · ${e.test}` : ''}:\n\`\`\`\n${e.message}\n\`\`\``).join('\n\n')}\n\n` : '';
  const outputs = details.length ? details.map((d) => `${when(d.at)}:\n\`\`\`\n${d.detail}\n\`\`\``).join('\n\n') : '(no failing output was kept for it)';
  return {
    title: `Flaky test: ${file}`,
    message: `Fix the flaky test file ${file}. It failed in a full run and then passed alone ${count} time${count === 1 ? '' : 's'} in the last 14 days (the Test health tab on the CI page counts these).\n\n`
      + `Open the citadel:diagnosing-bugs skill first: a flake has a cause (shared state, a fixed port, a timing assumption, load), and a longer wait or a retry is not the fix. Find the cause, fix it in the test or the code under test, and show the file passing repeatedly under load.\n\n`
      + `**Prove the fix held before you ship it** (#1120): a fix counts only after ${PROOF_RUNS} clean runs of this file on the desktop runner, ${PROOF_BATCH} copies at once per batch (the crowd a flake fails in). Rebase your branch onto main (the run uses your branch's copy of the workflow, and main's keeps the ship runner free: #1240), push it and dispatch the \`flake-proof.yml\` workflow on it with \`file=${file}\` (\`gh workflow run flake-proof.yml --ref <your branch> -f file=${file}\`); the Test health tab shows its clean-run count, and the run's result wakes you. Ship only on a green run. Do not skip, quarantine or loosen the test (Cara, 2026-11-10: "Keep failing, log it").\n\n`
      + seen
      + `The last ${details.length || 'no'} failing output${details.length === 1 ? '' : 's'}:\n\n${outputs}\n`,
  };
}
