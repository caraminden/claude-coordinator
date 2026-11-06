import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// citadel:skill-stocktake's usage count: one per tool-call id, inside the window by the call's own time.
const script = join(import.meta.dirname, '..', 'kit', 'skills', 'skill-stocktake', 'uses.ts');

test('uses.ts counts each skill load and agent start once, and only recent ones', () => {
  const home = mkdtempSync(join(tmpdir(), 'stocktake-'));
  try {
    const dir = join(home, '.claude', 'projects', 'p', 'subagents');
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const call = (id: string, name: string, input: object, timestamp = now) =>
      JSON.stringify({ timestamp, message: { content: [{ type: 'tool_use', id, name, input }] } });
    writeFileSync(join(dir, 'a.jsonl'), [
      call('t1', 'Skill', { skill: 'citadel:retro' }),
      call('t1', 'Skill', { skill: 'citadel:retro' }), // the same call logged twice
      call('t2', 'Skill', { skill: 'citadel:retro' }),
      call('t3', 'Agent', { prompt: '}', subagent_type: 'citadel:check-runner' }),
      call('t4', 'Agent', { prompt: 'x' }),
      call('t5', 'Skill', { skill: 'citadel:grilling' }, old), // an old call in a resumed session
      call('t6', 'Bash', { command: 'ls' }),
      'not json "tool_use"',
    ].join('\n'));
    const stale = join(dir, 'b.jsonl');
    writeFileSync(stale, call('t7', 'Skill', { skill: 'citadel:subagents' }));
    const longAgo = (Date.now() - 40 * 86_400_000) / 1000;
    utimesSync(stale, longAgo, longAgo);
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const counts = Object.fromEntries(r.stdout.trim().split('\n').map(l => l.trim().split(/\s+/)).map(([n, k]) => [k, Number(n)]));
    assert.deepEqual(counts, { 'citadel:retro': 2, 'agent:citadel:check-runner': 1, 'agent:general-purpose': 1 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
