// The environment tools/land.sh, tools/deploy.sh, tools/deploy-queue.sh, tools/run-tests.sh and tools/citadel-heavy
// hand to their children. A real land runs this suite under that environment, so a test that starts one of these
// scripts must start it without them (test/script-env.test.ts checks that every such test does).
//   DEPLOY_LOCKED, DEPLOY_TESTED  land.sh -> deploy.sh: "I hold the lock on fd 9" and "this commit passed the tests".
//   DEPLOY_QUEUE_TICKET           deploy-queue.sh's exported place in line; a script in a test would remove it on exit.
//   CITADEL_HEAVY_HELD            citadel-heavy -> its command: land.sh refuses to run with it set.
//   CITADEL_HEAVY_FALLBACK_FILE   citadel-heavy -> heavy-ci.ts (#1160): the file it writes when nothing ran on CI.
//   LAND_REBASED                  land.sh -> its rebased copy (unset again before any child, cleared in case).
//   DEPLOY_TIMES                  land.sh -> deploy.sh: the file deploy.sh notes its "queued" and "live" times in (#565).
//   LAND_REDO                     land.sh -> the copy that starts over after main went back (unset again before any child, like LAND_REBASED).
//   LAND_RETRIED, LAND_RETRY_NOW, LAND_FLAKE_KEPT  land.sh -> the copy that goes again after a refusal by the pipeline (#1360; unset again before any child).
//   LAND_FIX                      a person -> land.sh: "this branch fixes the commit whose deploy was rolled back"; the suite a landing runs inherits it.
//   LAND_URGENT                   a person -> land.sh -> deploy.sh: "this fixes shipping or an outage now": its restart skips the starved-box hold (#1417).
//   CITADEL_TEST_PROGRESS(_TO)    citadel-heavy and run-tests.sh -> citadel-node -> its reporter: where a run's counts go.
//   CITADEL_TEST_ALWAYS           land.sh's smoke check -> citadel-test: rerun a failed file without the always-tests (#1012).
//   FMT_TRACKED                   land.sh -> its tests -> tools/fmt: an untracked file isn't the ship's (#1885).
//   CITADEL_HEAVY_WHAT            land.sh's CI fallback -> citadel-heavy: how its slot and history name the suite (#1254).
//   CITADEL_TEST_CONCURRENCY      land.sh's CI fallback -> run-tests.sh: half the usual files at once, on a quiet perigee (#1254).
//   LAND_MERGE_DIFF3              the kit core (tools/land-core.sh) -> land_merge -> ship-numbers.ts: git's diff3 merge first (#1323).
//   LAND_KNOWN_RED, LAND_PARK_RETRIED  the kit core -> its --verify run and land_fallback (#1323).
//   CITADEL_HEAVY_SHIP, CITADEL_HEAVY_CI_QUEUE, CITADEL_HEAVY_WHO  the light check (tools/light-check.sh) -> heavy-ci.ts (#1620).
//   CITADEL_HEAVY_JUDGE           burn-in.sh off CI -> citadel-heavy: a local burn-in always takes a slot and the load gate (#1725).
export const SCRIPT_ENV = [
  'DEPLOY_LOCKED',
  'DEPLOY_TESTED',
  'DEPLOY_TIMES',
  'DEPLOY_QUEUE_TICKET',
  'CITADEL_HEAVY_HELD',
  'CITADEL_HEAVY_FALLBACK_FILE',
  'LAND_REBASED',
  'LAND_REDO',
  'LAND_RETRIED',
  'LAND_RETRY_NOW',
  'LAND_FLAKE_KEPT',
  'LAND_FIX',
  'LAND_URGENT',
  'CITADEL_TEST_PROGRESS',
  'CITADEL_TEST_PROGRESS_TO',
  'CITADEL_TEST_ALWAYS',
  'FMT_TRACKED',
  'CITADEL_HEAVY_WHAT',
  'CITADEL_TEST_CONCURRENCY',
  'LAND_MERGE_DIFF3',
  'LAND_KNOWN_RED',
  'LAND_PARK_RETRIED',
  'CITADEL_HEAVY_SHIP',
  'CITADEL_HEAVY_CI_QUEUE',
  'CITADEL_HEAVY_WHO',
  'CITADEL_HEAVY_JUDGE',
] as const;

/**
 * `process.env` without the variables the scripts export and without a person's own DEPLOY_*, LAND_* and
 * CITADEL_HEAVY_* knobs (an exported DEPLOY_BACKUPS would fail a land's suite run), plus `extra`, which a test
 * uses to set one on purpose (an undefined value removes a name).
 */
export function scriptEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of SCRIPT_ENV) delete env[name];
  for (const name of Object.keys(env)) if (/^(DEPLOY|LAND|CITADEL_HEAVY)_/.test(name)) delete env[name];
  return { ...env, ...extra };
}
