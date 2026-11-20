/**
 * The one place that decides whether CI results show a commit green. Every reader of GitHub runs, jobs or checks
 * (last green, the CI wait, a release's needed runs, a PR's checks) maps each result to a CiState here and asks
 * ciVerdict, so none keeps its own list of which conclusions pass (#1307).
 */

/** One run's, job's or check's result: pass (success), skip (skipped, neutral, stale: nothing was tested), cancelled, fail (failure, timed out, anything else bad), running (not completed). */
export type CiState = 'pass' | 'skip' | 'cancelled' | 'fail' | 'running';

/** What a set of results says about a commit. */
export type CiVerdict = 'green' | 'red' | 'running' | 'unknown';

/** A result from GitHub's own words (REST lowercase or GraphQL uppercase): its `status` and its `conclusion`, null until completed. */
export function ciState(status: string | null | undefined, conclusion: string | null | undefined): CiState {
  if ((status ?? '').toLowerCase() !== 'completed') return 'running';
  const c = (conclusion ?? '').toLowerCase();
  if (c === 'success') return 'pass';
  if (c === 'skipped' || c === 'neutral' || c === 'stale') return 'skip';
  if (c === 'cancelled') return 'cancelled';
  return 'fail';
}

/**
 * Red as soon as any result failed or was cancelled; else running while any hasn't finished; else green when at least
 * one passed (all skipped tested nothing, #558); else unknown, also with no results yet. `skipBlocks`: a skipped
 * result keeps it from green (a release's needed run that skipped a job did not ship, so it is unknown).
 */
export function ciVerdict(states: CiState[], opts: { skipBlocks?: boolean } = {}): CiVerdict {
  if (states.some((s) => s === 'fail' || s === 'cancelled')) return 'red';
  if (states.some((s) => s === 'running')) return 'running';
  if (opts.skipBlocks && states.includes('skip')) return 'unknown';
  return states.includes('pass') ? 'green' : 'unknown';
}
