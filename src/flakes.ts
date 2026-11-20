// Flaky test files (#1063): a land's or fast mode's output names each file that failed in the full run and passed alone
// (land.sh's `land: flake: <file> · <where>` lines, run-tests.sh's "failed in the full run, passed alone"). Each becomes a
// flake_events row, and the CI page's Test health tab counts them and offers a minion to fix one.

import { execFile } from 'node:child_process';

/** When `file`'s newest commit on main was made (ms), or null when git can't say. A sighting from before it was of the old file (#1219). */
export function fileChangedAt(repoDir: string, file: string): Promise<number | null> {
  return new Promise((done) => execFile('git', ['log', '-1', '--format=%ct', 'main', '--', file], { cwd: repoDir, timeout: 15_000 }, (err, out) => {
    const sec = Number(String(out ?? '').trim());
    done(err || !Number.isFinite(sec) || sec <= 0 ? null : sec * 1000);
  }));
}

export const FLAKE_WINDOW_MS = 14 * 24 * 60 * 60_000;
/** The third sighting of one file inside this window starts its fix minion (#1120). */
export const FLAKE_REPEAT = 3;
export const FLAKE_REPEAT_MS = 7 * 24 * 60 * 60_000;
/** A fix is held after this many clean runs in a row of the file on the desktop runner. */
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
export function parseRetroFlakes(md: string, day: string): { file: string; at: number; source: string }[] {
  const out: { file: string; at: number; source: string }[] = [];
  for (const m of md.matchAll(/^- (\d\d:\d\d:\d\d)Z · flake · (.+)$/gm)) {
    const parts = m[2].split(' · ');
    const at = Date.parse(`${day}T${m[1]}Z`);
    if (!FILE.test(parts[0]) || Number.isNaN(at)) continue;
    out.push({ file: parts[0], at, source: parts.includes('in CI') ? 'in CI' : parts[1] === 'smoke' ? 'smoke' : 'run-tests' });
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
export function flakeBrief(file: string, count: number, details: { at: number; detail: string }[]): { title: string; message: string } {
  const when = (t: number) => new Date(t).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const outputs = details.length ? details.map((d) => `${when(d.at)}:\n\`\`\`\n${d.detail}\n\`\`\``).join('\n\n') : '(no failing output was kept for it)';
  return {
    title: `Flaky test: ${file}`,
    message: `Fix the flaky test file ${file}. It failed in a full run and then passed alone ${count} time${count === 1 ? '' : 's'} in the last 14 days (the Test health tab on the CI page counts these).\n\n`
      + `Open the citadel:diagnosing-bugs skill first: a flake has a cause (shared state, a fixed port, a timing assumption, load), and a longer wait or a retry is not the fix. Find the cause, fix it in the test or the code under test, and show the file passing repeatedly under load.\n\n`
      + `**Prove the fix held before you ship it** (#1120): a fix counts only after ${PROOF_RUNS} clean runs in a row of this file on the desktop runner. Push your branch and dispatch the \`flake-proof.yml\` workflow on it with \`file=${file}\` (\`gh workflow run flake-proof.yml --ref <your branch> -f file=${file}\`); the Test health tab shows its clean-run count, and the run's result wakes you. Ship only on a green run. Do not skip, quarantine or loosen the test (Cara, 2026-11-10: "Keep failing, log it").\n\n`
      + `The last ${details.length || 'no'} failing output${details.length === 1 ? '' : 's'}:\n\n${outputs}\n`,
  };
}
