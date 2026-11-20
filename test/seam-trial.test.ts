// The seam trial's enrolment (#1129): groups take turns, stay the same size, and stop at ARM_SIZE each.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARM_SIZE, armOf, enrol, SEAM_CONTEXT_TOKENS, type SeamTrial } from '../src/seam-trial.ts';

test('only past the mark, once per minion, alternating groups, and nobody once both are full', () => {
  assert.equal(enrol(null, 1, SEAM_CONTEXT_TOKENS, 5), null);
  let t: SeamTrial | null = null;
  const arms: string[] = [];
  for (let id = 1; id <= ARM_SIZE * 2; id++) {
    const r = enrol(t, id, SEAM_CONTEXT_TOKENS + 1, id)!;
    assert.equal(r.filled, id === ARM_SIZE * 2);
    arms.push(r.arm);
    t = r.trial;
    assert.equal(enrol(t, id, 300_000, 99), null, 'enrolled once');
  }
  assert.equal(t!.since, 1);
  assert.deepEqual(arms.slice(0, 4), ['fresh', 'control', 'fresh', 'control']);
  assert.equal(t!.fresh.length, ARM_SIZE);
  assert.equal(t!.control.length, ARM_SIZE);
  assert.equal(t!.full, ARM_SIZE * 2);
  assert.equal(enrol(t, 999, 300_000, 100), null);
  assert.equal(armOf(t, 1), 'fresh');
  assert.equal(armOf(t, 2), 'control');
  assert.equal(armOf(t, 999), null);
});

test("a minion's MCP server offers fresh_session only in the fresh group", async () => {
  const { execFileSync } = await import('node:child_process');
  const names = (flag: string) => {
    const out = execFileSync(process.execPath, ['src/mcp.ts'], {
      input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n', timeout: 20_000,
      env: { ...process.env, COORDINATOR_ROLE: 'thread', COORDINATOR_TICKET: '1', COORDINATOR_SEAM_TRIAL: flag },
    }).toString();
    return JSON.parse(out.split('\n').find((l) => l.includes('"id":1'))!).result.tools.map((t: { name: string }) => t.name) as string[];
  };
  assert.ok(names('1').includes('fresh_session'));
  assert.ok(!names('0').includes('fresh_session'));
});
