import { readFileSync } from 'node:fs';

/** The runner and the files split out of it (#1840): a test that reads the runner's source for something it must not hold reads them all. */
export const RUNNER_FILES = ['src/runner.ts', 'src/dismissed-cleanup.ts'];

export const runnerSource = () => RUNNER_FILES.map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');
