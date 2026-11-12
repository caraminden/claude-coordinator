// The environment tools/land.sh, tools/deploy.sh, tools/deploy-queue.sh, tools/run-tests.sh and tools/citadel-heavy
// hand to their children. A real land runs this suite under that environment, so a test that starts one of these
// scripts must start it without them (test/script-env.test.ts checks that every such test does).
//   DEPLOY_LOCKED, DEPLOY_TESTED  land.sh -> deploy.sh: "I hold the lock on fd 9" and "this commit passed the tests".
//   DEPLOY_QUEUE_TICKET           deploy-queue.sh's exported place in line; a script in a test would remove it on exit.
//   CITADEL_HEAVY_HELD            citadel-heavy -> its command: land.sh refuses to run with it set.
//   LAND_REBASED                  land.sh -> its rebased copy (unset again before any child, cleared in case).
//   DEPLOY_TIMES                  land.sh -> deploy.sh: the file deploy.sh notes its "queued" and "live" times in (#565).
//   LAND_FIX                      a person -> land.sh: "this branch fixes the commit whose deploy was rolled back"; the suite a landing runs inherits it.
//   CITADEL_TEST_PROGRESS(_TO)    citadel-heavy and run-tests.sh -> citadel-node -> its reporter: where a run's counts go.
export const SCRIPT_ENV = ['DEPLOY_LOCKED', 'DEPLOY_TESTED', 'DEPLOY_TIMES', 'DEPLOY_QUEUE_TICKET', 'CITADEL_HEAVY_HELD', 'LAND_REBASED', 'LAND_FIX', 'CITADEL_TEST_PROGRESS', 'CITADEL_TEST_PROGRESS_TO'] as const;

/** `process.env` without the variables the scripts export, plus `extra` (an undefined value removes a name). */
export function scriptEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of SCRIPT_ENV) delete env[name];
  return { ...env, ...extra };
}
