import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { readGrunts } from '../src/grunts.ts';
import { projectSlug } from '../src/sessions.ts';

// A turn's Grunts, read from the session's subagents/ folder (#948): one row each, costed from the usage on their
// messages, which repeat per content block (dedupe by message id).
const root = mkdtempSync(join(tmpdir(), 'turn-grunts-'));
after(() => rmSync(root, { recursive: true, force: true }));
const cwd = '/work/ticket-1';
const session = 'aaaaaaaa-1111-2222-3333-444444444444';
const sub = join(root, 'projects', projectSlug(cwd), session, 'subagents');
mkdirSync(sub, { recursive: true });
const msg = (id: string, model: string, usage: object, effort?: string) => JSON.stringify({ type: 'assistant', requestId: 'req_' + id, ...(effort ? { effort } : {}), message: { id, model, usage } });
const grunt = (id: string, meta: object, lines: string[]) => {
  writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify(meta));
  writeFileSync(join(sub, `agent-${id}.jsonl`), lines.join('\n') + '\n');
};
// Sonnet is $2 in, $10 out, $0.1 cache read per million; cache writes cost 1.25x input.
grunt('a1', { agentType: 'Explore', description: 'Find usages', spawnDepth: 1, requestShape: 'foreground', finished: true }, [
  msg('m1', 'claude-sonnet-5-5', { input_tokens: 1000000, output_tokens: 0 }, 'medium'),
  msg('m1', 'claude-sonnet-5-5', { input_tokens: 1000000, output_tokens: 100000 }, 'medium'), // same message again: counts once
  msg('m2', 'claude-sonnet-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 10000000, cache_creation_input_tokens: 400000 }, 'medium'),
]);
grunt('b2', { agentType: 'citadel:reviewer', description: 'Review', spawnDepth: 2, requestShape: 'background', effort: 'high', finished: true }, [msg('m3', 'claude-opus-5-5', { input_tokens: 500000, output_tokens: 50000 }, 'low')]);

test('one row per Grunt, with type, model, effort, calls, cost and shape', async () => {
  const rows = (await readGrunts(root, cwd, session)).sort((a, b) => a.agent_id.localeCompare(b.agent_id));
  assert.equal(rows.length, 2);
  const [a, b] = rows;
  assert.deepEqual([a.agent_type, a.model, a.effort, a.calls, a.request_shape, a.spawn_depth, a.description], ['Explore', 'claude-sonnet-5-5', 'medium', 2, 'foreground', 1, 'Find usages']);
  // m1: 1M in ($2) + 0.1M out ($1); m2: 10M read ($1) + 0.4M write at 1.25x ($1)
  assert.ok(Math.abs(a.cost_usd - 5) < 1e-9, String(a.cost_usd));
  // meta's effort wins over the transcript's; 0.5M in ($2) + 0.05M out ($1)
  assert.deepEqual([b.agent_type, b.model, b.effort, b.calls, b.request_shape], ['citadel:reviewer', 'claude-opus-5-5', 'high', 1, 'background']);
  assert.ok(Math.abs(b.cost_usd - 3) < 1e-9, String(b.cost_usd));
});

test('a session with no subagents folder, or one found under another working folder, still reads', async () => {
  assert.deepEqual(await readGrunts(root, cwd, 'bbbbbbbb-1111-2222-3333-444444444444'), []);
  assert.equal((await readGrunts(root, '/elsewhere/in/a/container', session)).length, 2);
});

test('the store keeps them under the turn, and a later read updates a Grunt instead of adding it', async () => {
  const store = new Store(join(root, 'c.db'));
  const p = store.createProject('P', null);
  const t = store.createTicket({ project_id: p.id, kind: 'ticket', title: 'T', permission_mode: 'default', created_by: 'x' });
  const turn = store.recordTurn(t.id, { session_id: session, ended_at: 1, session_cost_usd: 1 });
  const rows = await readGrunts(root, cwd, session);
  store.recordGrunts(turn.id, rows);
  store.recordGrunts(
    turn.id + 1,
    rows.map((r) => ({ ...r, cost_usd: r.cost_usd + 1 })),
  );
  const got = store.db.prepare('SELECT turn_id, agent_id, cost_usd FROM turn_grunts ORDER BY agent_id').all() as any[];
  assert.equal(got.length, 2);
  assert.deepEqual(
    got.map((g) => g.turn_id),
    [turn.id, turn.id],
  );
  assert.ok(Math.abs(got[0].cost_usd - 6) < 1e-9);
});
