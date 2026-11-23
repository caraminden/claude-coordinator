// Holding a warm session's tool text (#1731): only description wording may stay old; any other change lists the current tools.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { heldTools, toolsForTurn } from '../src/tool-hold.ts';

const tool = (description: string, extra: object = {}) => ({ name: 'hand_off_land', description, inputSchema: { type: 'object', properties: { summary: { type: 'string', description: `${description} summary` }, ...extra } } });
const seen = [tool('Ship: the server runs land.sh. Use it once tested.')];
const reworded = [tool('Ship: the server runs land.sh.')];

test('a warm session keeps the descriptions it saw while nothing else changed', () => {
  assert.equal(heldTools(reworded, seen, true), seen);
  assert.equal(heldTools(reworded, seen, false), reworded, 'cold, new session or past the cap');
  assert.equal(heldTools(reworded, null, true), reworded, 'nothing kept yet');
  assert.equal(heldTools([tool('Ship.', { outage: { type: 'boolean' } })], seen, true)[0].inputSchema.properties.outage?.type, 'boolean', 'a new parameter lists the current tools');
  assert.equal(heldTools([...reworded, { name: 'plan', description: 'x' }], seen, true).length, 2, 'a new tool lists the current tools');
  // A parameter named "description" is part of the contract, not wording.
  const withParam = (t: string) => [{ name: 'create_ticket', description: 'x', inputSchema: { properties: { description: { type: t } } } }];
  assert.equal(heldTools(withParam('number'), withParam('string'), true)[0].inputSchema.properties.description.type, 'number');
});

const dir = mkdtempSync(join(tmpdir(), 'tool-hold-'));
after(() => rmSync(dir, { recursive: true, force: true })); // timing-ok: own temp dir

test('tools/list keeps what the session saw in its TMPDIR and serves it on a warm turn', async () => {
  const env = { TMPDIR: dir, COORDINATOR_TICKET: '7' };
  assert.equal(await toolsForTurn(seen, env), seen, 'first turn: the current list');
  assert.deepEqual(await toolsForTurn(reworded, { ...env, CITADEL_TOOL_HOLD: '1' }), seen, 'warm: the list it saw');
  assert.equal(await toolsForTurn(reworded, env), reworded, 'cold: the current list');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.citadel-tools-7.json'), 'utf8')).tools, reworded, 'which is now the one kept');
  assert.equal(await toolsForTurn(seen, { ...env, CITADEL_TOOL_HOLD: '1', COORDINATOR_MSG: '{"max":3}' }), seen, 'new message numbers: the current list');
  writeFileSync(join(dir, '.citadel-tools-7.json'), '{"msg":"","tools":[');
  assert.equal(await toolsForTurn(reworded, { ...env, CITADEL_TOOL_HOLD: '1' }), reworded, 'a broken file is no hold, not an error');
  assert.equal(await toolsForTurn(seen, { COORDINATOR_TICKET: '7', CITADEL_TOOL_HOLD: '1' }), seen, 'no TMPDIR: no hold');
});
