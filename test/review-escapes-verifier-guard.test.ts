import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

// The verifier trial's hook (#1740): it writes and runs inside its case folder, never against the box, GitHub or the live
// Citadel. Run as Claude Code runs it: the call on stdin, a deny printed or nothing.
const guard = join(import.meta.dirname, '../tools/review-escapes/verifier-guard.ts');
const H = process.env.HOME ?? '/home/someone';
const R = `${H}/.local/share/claude-coordinator/projects/2/tmp/1/verifier-p1/verifier/escape-1`;
const denied = (tool_name: string, tool_input: Record<string, unknown>) => {
  const r = spawnSync(process.execPath, [guard, R, `${H}/kit`], { input: JSON.stringify({ tool_name, tool_input, cwd: `${R}/repo` }), encoding: 'utf8' });
  return r.stdout.includes('"deny"');
};
const bash = (command: string) => denied('Bash', { command });

test('runs, reads and writes inside its case folder', () => {
  for (const c of [`cd ${R}/repo && node --test test/x.test.ts`, `ls ${R}/repo/.claude/rules`, 'git log --oneline', `sqlite3 ${R}/data/coordinator.db .tables`,
    'curl -s -H "Cookie: $DEV_COOKIE" "$DEV_URL"api/projects', 'node boot.mjs stop'])
    assert.equal(bash(c), false, c);
  assert.equal(denied('Read', { file_path: `${R}/repo/server.ts` }), false);
  assert.equal(denied('Read', { file_path: '/usr/include/stdio.h' }), false);
  assert.equal(denied('Write', { file_path: `${R}/scratch/a.sh` }), false);
});

test('local git between its own scratch repos passes; a path that only names push does too', () => {
  for (const c of [`cd ${R}/scratch/app && git push -q ../bare.git HEAD:main`, `git clone -q ${R}/scratch/rel ${R}/scratch/appclone`,
    'git remote add origin ../bare.git', 'git diff main...HEAD -- src/push.ts src/mcp.ts'])
    assert.equal(bash(c), false, c);
});

test('git that reaches the network is refused', () => {
  for (const c of ['git push https://github.com/x/y HEAD', 'git fetch git@github.com:x/y.git', 'git clone https://example.com/r.git'])
    assert.equal(bash(c), true, c);
});

test('kill takes a pid it holds, never one found by name or every process', () => {
  for (const c of ['kill 12345', 'kill $P', 'kill -9 $P', 'kill $(cat scratch/fake.pid)', 'kill -TERM -- -4242', 'kill 10'])
    assert.equal(bash(c), false, c);
  for (const c of ['pkill node', 'kill $(pgrep node)', 'kill $(pidof node)', "ps aux | grep server | awk '{print $2}' | xargs kill", 'kill -9 -1', 'kill 0', 'kill; echo'])
    assert.equal(bash(c), true, c);
});

test('the box, GitHub, the live Citadel and today\'s state are out of reach', () => {
  for (const c of ['systemctl --user restart citadel', 'gh api repos', 'claude -p hi', 'curl -s http://127.0.0.1:8573/api/x',
    'cat ~/.local/share/claude-coordinator/coordinator.db', 'cat /home/someone/.local/share/claude-coordinator/projects/2/repo/src/db.ts'])
    assert.equal(bash(c), true, c);
  assert.equal(denied('Read', { file_path: `${H}/.local/share/claude-coordinator/projects/2/repo/server.ts` }), true);
  assert.equal(denied('Write', { file_path: '/tmp/a.sh' }), true);
  assert.equal(denied('Agent', {}), true);
});
