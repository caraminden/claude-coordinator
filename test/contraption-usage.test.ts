// A contraption turn's usage (#315): a turn counts if any of its replies carried usage, even when the
// last result (a steer's reply) carried none.
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { tempRoot, testPins } from './helpers.ts';

const tmp = tempRoot('contraption-usage-');
const root = tmp.dir;
after(() => tmp.teardown());
const data = join(root, 'data');
process.env.DATA_DIR = data;
testPins(data);
const { ContraptionTurns, parseTurn } = await import('../src/contraption-turns.ts');

// A stand-in for claude: takes the prompt, then answers with one result that carries usage and a later
// result that carries none.
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const out = (o) => console.log(JSON.stringify(o));
require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
  out({ type: 'system', subtype: 'init', session_id: 's', tools: [], model: 'claude-test' });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'First.', usage: { input_tokens: 7, output_tokens: 3 } });
  out({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Second.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'Second.' });
  setTimeout(() => process.exit(0), 50);
});
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(data, 'coordinator.db'));
const contraptions = new Contraptions(store, 's'.repeat(40), join(root, 'keys'));
const app = contraptions.register({ name: 'mandate', title: 'Mandate', port: 9101, icon: null, home_scheme: null, open_paths: '[]', default_model: 'haiku', turn_cap: null });
const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
store.setContraptionUser(app.id, cara.id, true, cara.id);
const places = { place: () => ({ host: true as const }), codexPlace: () => null, expire: () => {}, configDirs: () => [], limitedView: () => ({ next: null, resetAt: 0 }) };
const turns = new ContraptionTurns(store, contraptions, places, { dataDir: data, claudeBin: fake, podman: '/bin/false', env: { PATH: process.env.PATH, HOME: root } });

test('a turn whose last result has no usage still reports the usage an earlier reply carried', async () => {
  const evs: { event: string; data: { turn: number; usage: unknown } }[] = [];
  await turns.run(app, parseTurn({ person: cara.id, session: 'u', prompt: 'hello' }, app), (event, data) => evs.push({ event, data: data as { turn: number; usage: unknown } }));
  const end = evs.find((e) => e.event === 'end');
  assert.ok(end, 'the turn ended');
  assert.deepEqual(end.data.usage, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }, 'end event usage');
  const row = store.getContraptionTurn(evs.find((e) => e.event === 'start')!.data.turn)!;
  assert.equal(row.input_tokens, 7, 'the stored turn row is metered, not null');
  assert.equal(row.output_tokens, 3);
});
