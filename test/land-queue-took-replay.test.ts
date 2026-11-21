// #502 (afe7b6d5): queue_done only times a landing that went all the way (`queue_done ok`); a run that stopped early
// (a conflict, a red test) must not enter the waiters' estimate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'queue-took-'));
after(() => rmSync(root, { recursive: true, force: true }));
const lib = join(import.meta.dirname, '..', 'tools', 'deploy-queue.sh');

function landing(state: string, done: string) {
  const r = spawnSync('bash', ['-c', `. "$0"; queue_lock "$1" x || exit 1; sleep 1.1; queue_done ${done}`, lib, state], { encoding: 'utf8', env: { ...process.env, DEPLOY_QUEUE_POLL: '0.05' } });
  assert.equal(r.status, 0, r.stderr);
}

test('queue_done without ok adds no line to .took; with ok it adds one', () => {
  const state = join(root, 'state');
  mkdirSync(state);
  const took = join(state, 'queue', '.took');
  landing(state, '');
  assert.ok(!existsSync(took), 'a landing that stopped early is not timed');
  landing(state, 'ok');
  const lines = readFileSync(took, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'a landing that went all the way is timed once');
  assert.ok(Number(lines[0]) >= 1, `its seconds are recorded: ${lines[0]}`);
});
