import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { scriptEnv } from './script-env.ts';
import { tempRoot } from './helpers.ts';

// #545 review fix (617e7225): tools/run-tests.sh clears a progress temp file left by an earlier killed run, not only
// the progress file. A leftover temp the reporter cannot overwrite (read-only) would otherwise hide every count.
const tools = join(import.meta.dirname, '..', 'tools');
const scratch = tempRoot('run-tests-replay-');
after(() => scratch.teardown());
const env = { ...scriptEnv(), NODE_TEST_CONTEXT: undefined, COORDINATOR_SHARED_DIR: undefined, DEPLOY_TEST_CPU_WEIGHT: '', DEPLOY_TEST_TIMEOUT: undefined, DEPLOY_RERUN_TIMEOUT: undefined, DEPLOY_RERUN_DEADLINE: undefined, CITADEL_TEST_TIMEOUT: undefined, CITADEL_TEST_CONCURRENCY: '1' };

test("a stale progress temp file from a killed run does not hide the next run's counts, and nothing is left after", async () => {
  const dir = join(scratch.dir, 'a');
  mkdirSync(join(dir, 'tools'), { recursive: true });
  mkdirSync(join(dir, 'test'));
  for (const f of ['run-tests.sh', 'parse-check.ts', 'deploy-queue.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'suite-runner.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(tools, f), join(dir, 'tools', f));
  writeFileSync(join(dir, 'test', 'ok.test.mjs'), "import test from 'node:test';\ntest('fine', () => {});\n");
  writeFileSync(
    join(dir, 'test', 'progress.test.mjs'),
    `import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
test('watch', async () => {
  const f = process.env.CITADEL_TEST_PROGRESS_TO;
  // timing-ok: fixture child in a temp dir, can't import ./wait.ts
  for (let i = 0; i < 200 && !(f && existsSync(f) && readFileSync(f, 'utf8').startsWith('1\\n2\\ntest/progress.test.mjs\\n')); i++) await new Promise((r) => setTimeout(r, 25)); // poll-ok: fixture child, no ./wait.ts
  writeFileSync('seen-progress', f && existsSync(f) ? readFileSync(f, 'utf8') : 'none');
});
`,
  );
  const stale = join(dir, 'land-test.progress.tmp');
  writeFileSync(stale, '99\n99\nstale\n');
  chmodSync(stale, 0o444);
  const log = join(dir, 'land-test.log');
  const code = await new Promise<number | null>((resolve) => {
    const p = execFile('bash', [join(dir, 'tools', 'run-tests.sh'), log], { cwd: dir, encoding: 'utf8', timeout: 90_000, env: { ...env, COORDINATOR_SHARED_DIR: join(dir, 'shared') } }, (err) => resolve(err ? ((err as Error & { code?: number }).code ?? null) : 0));
    scratch.track(p).stdin?.end();
  });
  assert.equal(code, 0, readFileSync(log, 'utf8'));
  assert.equal(readFileSync(join(dir, 'seen-progress'), 'utf8'), '1\n2\ntest/progress.test.mjs\n\n', 'the run wrote its own counts over the stale leftover');
  assert.equal(existsSync(join(dir, 'land-test.progress')), false);
  assert.equal(existsSync(stale), false);
});
