import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { askHold } from '../tools/ci-hold-ask.ts';

// Deploys first (#1902): an optional CI job asks Citadel before it starts, and a Citadel it can't ask never holds it.
let answers: Array<{ status?: number; body?: unknown }> = [];
let asked: string[] = [];
const server = createServer((req, res) => {
  if (req.url?.startsWith('/token')) return void res.end(JSON.stringify({ value: 'run-token' }));
  asked.push(`${req.method} ${req.url} ${req.headers.authorization}`);
  const a = answers.shift() ?? { body: { go: true } };
  res.writeHead(a.status ?? 200).end(JSON.stringify(a.body ?? {}));
});
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
after(() => server.close());
const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const env = { CITADEL_STORE_URL: at, ACTIONS_ID_TOKEN_REQUEST_URL: `${at}/token?x=1`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't' };
const ask = async (next: typeof answers, e: NodeJS.ProcessEnv = env) => {
  answers = next;
  asked = [];
  const lines: string[] = [];
  return { went: await askHold(e, { tries: 3, every: 1, log: (l) => lines.push(l) }), lines: lines.join('\n') };
};
const wait = { body: { go: false, why: '2 ships are in line' } };

test('told to go, it goes after one ask, with its own run token', async () => {
  assert.equal((await ask([{ body: { go: true } }])).went, true);
  assert.deepEqual(asked, ['POST /api/ci-hold Bearer run-token']);
});

test('told to wait, it says what for and asks again until it may go', async () => {
  const r = await ask([wait, wait, { body: { go: true } }]);
  assert.equal(r.went, true);
  assert.equal(asked.length, 3);
  assert.match(r.lines, /2 ships are in line, and ships go first: Citadel stops this run and starts it again/);
});

test('never stopped, it gives its looks up and says so rather than hold a runner', async () => {
  const r = await ask([wait, wait, wait, wait]);
  assert.equal(r.went, false);
  assert.match(r.lines, /::warning::Citadel said wait but never stopped this run: starting/);
});

test('a server that errors, an older one without the route, or no run token: it starts', async () => {
  assert.equal((await ask([{ status: 404 }])).went, true);
  assert.equal((await ask([{ status: 500 }])).went, true);
  const r = await ask([], { CITADEL_STORE_URL: at });
  assert.equal(r.went, true);
  assert.match(r.lines, /::warning::couldn't ask Citadel/);
});
