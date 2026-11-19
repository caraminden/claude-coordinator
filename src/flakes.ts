// Flaky test files (#1063): a land's or fast mode's output names each file that failed in the full run and passed alone
// (land.sh's `land: flake: <file> · <where>` lines, run-tests.sh's "failed in the full run, passed alone"). Each becomes a
// flake_events row, and the CI page's Test health tab counts them and offers a minion to fix one.

export const FLAKE_WINDOW_MS = 14 * 24 * 60 * 60_000;
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

/** What the "Start a minion" button sends as a new minion's first message. */
export function flakeBrief(file: string, count: number, details: { at: number; detail: string }[]): { title: string; message: string } {
  const when = (t: number) => new Date(t).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const outputs = details.length ? details.map((d) => `${when(d.at)}:\n\`\`\`\n${d.detail}\n\`\`\``).join('\n\n') : '(no failing output was kept for it)';
  return {
    title: `Flaky test: ${file}`,
    message: `Fix the flaky test file ${file}. It failed in a full run and then passed alone ${count} time${count === 1 ? '' : 's'} in the last 14 days (the Test health tab on the CI page counts these).\n\n`
      + `Open the citadel:diagnosing-bugs skill first: a flake has a cause (shared state, a fixed port, a timing assumption, load), and a longer wait or a retry is not the fix. Find the cause, fix it in the test or the code under test, and show the file passing repeatedly under load.\n\n`
      + `The last ${details.length || 'no'} failing output${details.length === 1 ? '' : 's'}:\n\n${outputs}\n`,
  };
}
