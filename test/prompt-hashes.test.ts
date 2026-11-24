// Lever A (#878) through a real turn: the minion's own lines open its turn message, system-prompt.md is the
// scheme's, and the turn's row in `turns` keeps a hash per part (Store.promptHashes) for the cache-miss log.
// A stand-in `claude -p` keeps each turn's prompt and system prompt, says its version in init, and ends.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { jsonLines, stopTurns, until, testPins } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'prompt-hashes-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');

const seen = join(root, 'seen.jsonl');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const fs = require('node:fs');
const system = fs.readFileSync(process.argv[process.argv.indexOf('--append-system-prompt-file') + 1], 'utf8');
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ input: JSON.parse(input), system }) + '\\n');
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', claude_code_version: '9.9.9' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));
  process.exit(0);
});
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const runner = new Runner(
  store,
  () => {},
  () => ({}),
  fake,
);
const project = store.createProject('P', null);

function minion(title: string) {
  const t = store.createTicket({ project_id: project.id, title, permission_mode: 'default', created_by: 'Cara', kind: 'ticket' });
  const cwd = join(root, `t${t.id}`);
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  return store.getTicket(t.id)!;
}

async function turn(id: number, text: string) {
  const before = jsonLines(seen).length;
  runner.send(id, 'Cara', text);
  await until('the turn', async () => jsonLines(seen).length > before && !runner.isRunning(id) && store.promptHashes(id).length > 0);
  return jsonLines(seen).at(-1);
}

test("a minion's turn message opens with its own lines; its system prompt and hashes match another minion's but for those", async () => {
  const [a, b] = [minion('A'), minion('B')];
  const ta = await turn(a.id, 'hello');
  const tb = await turn(b.id, 'hi');
  const texts = ta.input.message.content.map((c: any) => c.text);
  assert.match(texts[0], new RegExp(`^\\[System\\]: You are a minion working on #${a.number} in scheme "P"\\.\\n`));
  assert.equal(texts.at(-1), '[Cara]: hello');
  assert.equal(ta.system, tb.system, 'the same system-prompt.md for both minions');
  assert.ok(!ta.system.includes('You are a minion working on'));

  const [ha, hb] = [store.promptHashes(a.id)[0].hashes, store.promptHashes(b.id)[0].hashes];
  assert.deepEqual(ha.system, hb.system);
  assert.ok(ha.system.base && ha.system.files && ha.system.approval, JSON.stringify(ha.system));
  assert.notEqual(ha.turn.minion, hb.turn.minion);
  assert.equal(ha.turn.where, hb.turn.where);
  assert.deepEqual(ha.tools, hb.tools);
  assert.equal(typeof ha.tools.role, 'string');
  assert.equal(ha.claude, '9.9.9', "Claude Code's version, from the turn's init event");
  assert.ok('model' in ha && 'effort' in ha && 'payer' in ha);
});
