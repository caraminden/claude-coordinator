// #1174 (5736d400): the did-you-mean note for a call to a tool the agent doesn't have goes only to the main
// agent, and not when tool search may have left the app's tools out of init's list.
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ClaudePlaces } from '../src/contraption-turns.ts';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { tempRoot, testPins } from './helpers.ts';

const tmp = tempRoot('contraption-toolsuggest-');
const root = tmp.dir;
after(() => tmp.teardown());
const data = join(root, 'data');
process.env.DATA_DIR = data;
testPins(data);
const { ContraptionTurns, parseTurn } = await import('../src/contraption-turns.ts');

// A stand-in for claude: init lists `tools` (mcp__ names unless the prompt says "hidden"), then one call to a tool it
// doesn't have is refused (as a Grunt's when the prompt says "sub"), and it waits a moment for a note from Citadel.
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const argv = process.argv.slice(2);
const out = (o) => console.log(JSON.stringify(o));
const got = [];
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => { if (l.trim()) got.push(JSON.parse(l)); });
const textOf = (m) => m.message.content.map((b) => b.text).join('');
const first = new Promise((resolve) => { const t = setInterval(() => { if (got.length) { clearInterval(t); resolve(textOf(got.shift())); } }, 5); });
first.then((prompt) => {
  const session = argv[argv.indexOf('--session-id') + 1] ?? argv[argv.indexOf('--resume') + 1];
  out({ type: 'system', subtype: 'init', session_id: session, tools: prompt.includes('hidden') ? ['ToolSearch'] : ['Read', 'mcp__mandate__move'], model: 'claude-test' });
  const p = prompt.includes('sub') ? { parent_tool_use_id: 'ag1' } : { parent_tool_use_id: null };
  out({ type: 'assistant', ...p, message: { id: 'p1', content: [{ type: 'tool_use', id: 'ph1', name: 'mandate_move', input: {} }] } });
  out({ type: 'user', ...p, message: { content: [{ type: 'tool_result', tool_use_id: 'ph1', is_error: true, content: '<tool_use_error>Error: No such tool available: mandate_move</tool_use_error>' }] } });
  setTimeout(() => {
    out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'p2', content: [{ type: 'text', text: got.length ? 'Note: ' + textOf(got[0]) : 'NO NOTE' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: '', usage: {} });
    setTimeout(() => process.exit(0), 20);
  }, 700);
});
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(data, 'coordinator.db'));
const contraptions = new Contraptions(store, 's'.repeat(40), join(root, 'keys'));
const mandate = contraptions.register({ name: 'mandate', title: 'Mandate', port: 9101, icon: null, home_scheme: null, open_paths: '[]', default_model: 'haiku', turn_cap: null });
const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
store.setContraptionUser(mandate.id, cara.id, true, cara.id);
const places: ClaudePlaces = {
  place: (uid) => (uid === cara.id ? { host: true as const } : null),
  codexPlace: () => null,
  expire: () => {},
  configDirs: () => [join(root, 'claude')],
  limitedView: () => ({ next: null, resetAt: 0 }),
};
const serverEnv = { PATH: process.env.PATH, HOME: homedir(), CLAUDE_CONFIG_DIR: join(root, 'claude'), LANG: 'C.UTF-8' };
const turns = new ContraptionTurns(store, contraptions, places, { dataDir: data, claudeBin: fake, env: serverEnv });

async function said(body: object): Promise<string> {
  const evs: { event: string; data: { delta?: string } }[] = [];
  await turns.run(mandate, parseTurn({ person: cara.id, prompt: 'x', ...body }, mandate), (event, data) => evs.push({ event, data }));
  return evs
    .filter((e) => e.event === 'text')
    .map((e) => e.data.delta)
    .join('');
}

test("the main agent gets the note (the control), a Grunt's call and a tool-search turn without the app's tools get none", async () => {
  assert.match(await said({ session: 'main', prompt: 'main call' }), /Note: mandate_move is not one of your tools\. Did you mean mcp__mandate__move\?/, 'the main agent is told');
  assert.equal(await said({ session: 'grunt', prompt: 'sub call' }), 'NO NOTE', "a Grunt's refused call gets no note about the main agent's tools");
  assert.equal(await said({ session: 'search', prompt: 'hidden call', toolSearch: true }), 'NO NOTE', "tool search hid the app's tools: init's list would name the wrong ones");
});
