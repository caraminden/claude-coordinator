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
//   LAND_FIX                      a person -> land.sh: "this branch fixes the commit whose deploy was rolled back"; the suite a landing runs inherits it.
//   CITADEL_TEST_PROGRESS(_TO)    citadel-heavy and run-tests.sh -> citadel-node -> its reporter: where a run's counts go.
//   CITADEL_TEST_ALWAYS           land.sh's smoke check -> citadel-test: rerun a failed file without the always-tests (#1012).
//   CITADEL_HEAVY_WHAT            land.sh's CI fallback -> citadel-heavy: how its slot and history name the suite (#1254).
//   CITADEL_TEST_CONCURRENCY      land.sh's CI fallback -> run-tests.sh: half the usual files at once, on a quiet perigee (#1254).
export const SCRIPT_ENV = ['DEPLOY_LOCKED', 'DEPLOY_TESTED', 'DEPLOY_TIMES', 'DEPLOY_QUEUE_TICKET', 'CITADEL_HEAVY_HELD', 'CITADEL_HEAVY_FALLBACK_FILE', 'LAND_REBASED', 'LAND_REDO', 'LAND_FIX', 'CITADEL_TEST_PROGRESS', 'CITADEL_TEST_PROGRESS_TO', 'CITADEL_TEST_ALWAYS', 'CITADEL_HEAVY_WHAT', 'CITADEL_TEST_CONCURRENCY'] as const;

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
