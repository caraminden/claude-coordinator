// Semantic memory (#331): what gets indexed, what never does, and that a search never crosses schemes.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import type { Embed } from '../src/memory.ts';
import { Contraptions } from '../src/contraptions.ts';
import { agentToken, bootServer, SECRET } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'memory-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** A stand-in model: words hashed into 64 buckets, so texts that share words score high. */
function fakeVec(text: string): Float32Array {
  const v = new Float32Array(64);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 64] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const calls: string[][] = [];
const embed: Embed = async (texts) => {
  calls.push(texts);
  return texts.map(fakeVec);
};

const assistant = (text: string, extra: object = {}) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra });

/** A turn: the person's message, Claude's words (tool calls and a Grunt's among them), and its result. */
function turn(store: Store, ticketId: number, author: string, asked: string, reply: string, done = true) {
  const msg = store.addEvent(ticketId, 'user_message', { author, text: asked });
  store.addEvent(ticketId, 'claude', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat secrets.env' } }] } });
  store.addEvent(ticketId, 'claude', { type: 'user', message: { content: [{ type: 'tool_result', content: 'TOKEN=hunter2 from the tool output' }] } });
  store.addEvent(ticketId, 'claude', assistant('A Grunt says pineapples', { parent_tool_use_id: 'toolu_1' }));
  store.addEvent(ticketId, 'claude', assistant(reply));
  if (done) {
    const result = store.addEvent(ticketId, 'claude', { type: 'result', result: reply });
    store.recordTurn(ticketId, { event_id: result.id, ended_at: Date.now(), session_cost_usd: 0 });
  }
  return msg;
}

function world(file: string) {
  const store = new Store(file);
  const A = store.createProject('A', null);
  const B = store.createProject('B', null);
  const mk = (project: number, title: string) => store.createTicket({ project_id: project, title, permission_mode: 'default', created_by: 'Cara' });
  const a1 = mk(A.id, 'Dentist reminders');
  const a2 = mk(A.id, 'Usage bar');
  const b1 = mk(B.id, 'Secret dentist plan');
  return { store, A, B, a1, a2, b1 };
}

test('indexes finished turns and minion titles, never tool output, a Grunt, person notes or another scheme', async () => {
  const { store, A, B, a1, a2, b1 } = world(join(root, 'one.db'));
  store.setPersonNote(a1.id, 'private dentist note', 'Cara');
  turn(store, a1.id, 'Cara', 'When is the dentist appointment?', 'Cara decided the dentist is on Tuesday.');
  turn(store, a2.id, 'Josh', 'Make the usage bar blue', 'The usage bar is blue now.');
  turn(store, a2.id, 'GitHub', 'CI passed on the dentist branch', 'Nothing to do.');
  turn(store, b1.id, 'Cara', 'Dentist dentist dentist', 'B scheme dentist reply');

  while ((await store.memory.index(A.id, embed, 'fake')) > 0);
  const rows = store.db.prepare('SELECT project_id, source_kind, text FROM memory_chunks ORDER BY id').all() as { project_id: number; source_kind: string; text: string }[];
  assert.ok(rows.every((r) => r.project_id === A.id), 'only scheme A was indexed');
  const all = rows.map((r) => r.text).join('\n');
  assert.match(all, /Cara: When is the dentist appointment\?\n\nReply: Cara decided the dentist is on Tuesday\./);
  assert.match(all, /#\d+ Dentist reminders/);
  for (const never of ['hunter2', 'secrets.env', 'pineapples', 'private dentist note', 'CI passed']) assert.ok(!all.includes(never), `never indexed: ${never}`);
  assert.equal(rows.filter((r) => r.source_kind === 'turn').length, 2);
  assert.equal(rows.filter((r) => r.source_kind === 'ticket').length, 2, 'both minions, not the Taskmaster');

  // B indexed too, with text closer to the query than A's: A's search still never returns it.
  while ((await store.memory.index(B.id, embed, 'fake')) > 0);
  const hits = await store.memory.search(A.id, 'dentist dentist', embed, 'fake', { limit: 20 });
  assert.ok(hits.length >= 2);
  assert.ok(hits.every((h) => h.ticket_id !== b1.id));
  assert.equal(hits[0].ticket_id, a1.id, 'the dentist chat ranks first');
  assert.ok((await store.memory.search(B.id, 'dentist', embed, 'fake')).every((h) => h.ticket_id === b1.id));

  // Narrowed to one minion, or to one person's messages.
  assert.ok((await store.memory.search(A.id, 'dentist', embed, 'fake', { ticketId: a2.id })).every((h) => h.ticket_id === a2.id));
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  turn(store, a1.id, 'Josh', 'Josh asks about the dentist too', 'Noted.');
  while ((await store.memory.index(A.id, embed, 'fake')) > 0);
  const his = await store.memory.search(A.id, 'dentist', embed, 'fake', { personId: josh.id, limit: 20 });
  assert.deepEqual(his.map((h) => h.text.split(':')[0]), ['Josh']);
  store.db.close();
});

test('a turn still running after an hour waits for its result, and is indexed with its final reply (#468 S05-2)', async () => {
  const { store, A, a1 } = world(join(root, 'long.db'));
  store.updateTicket(a1.id, { status: 'running' });
  const long = turn(store, a1.id, 'Cara', 'A long job about figs', 'Let me look at the tests first.', false);
  const later = Date.now() + 61 * 60_000;
  await store.memory.index(A.id, embed, 'fake', 32, later);
  const turns = () => store.db.prepare("SELECT source_id, text FROM memory_chunks WHERE source_kind = 'turn'").all() as { source_id: number; text: string }[];
  assert.equal(turns().some((t) => t.source_id === long.id), false, 'not while its minion is still running');
  store.addEvent(a1.id, 'claude', assistant('Figs are done: all green.'));
  const result = store.addEvent(a1.id, 'claude', { type: 'result', result: 'x' });
  store.recordTurn(a1.id, { event_id: result.id, ended_at: Date.now(), session_cost_usd: 0 });
  store.updateTicket(a1.id, { status: 'idle' });
  await store.memory.index(A.id, embed, 'fake', 32, later);
  assert.match(turns().find((t) => t.source_id === long.id)!.text, /Reply: Figs are done: all green\./);
  store.db.close();
});

test('a turn still running after a day holds the mark no longer: its reply so far is indexed (#468 S05-2 review)', async () => {
  const { store, A, a1 } = world(join(root, 'day.db'));
  store.updateTicket(a1.id, { status: 'running' });
  const long = turn(store, a1.id, 'Cara', 'A job about plums that waits on a card', 'Waiting on the approval.', false);
  await store.memory.index(A.id, embed, 'fake', 32, Date.now() + 25 * 60 * 60_000);
  const chunk = store.db.prepare("SELECT text FROM memory_chunks WHERE source_kind = 'turn' AND source_id = ?").get(long.id) as { text: string } | undefined;
  assert.match(chunk?.text ?? '', /Reply: Waiting on the approval\./);
  assert.ok(store.getSetting<number>(`memory_turns_after:${A.id}`)! >= long.id, 'the mark moves past it');
  store.db.close();
});

test('each embed request carries at most 2 texts, so a full batch stays well inside the timeout on a busy box (#525)', async () => {
  const { store, A, a1 } = world(join(root, 'small.db'));
  for (let i = 0; i < 7; i++) turn(store, a1.id, 'Cara', `Ask number ${i}`, `Reply number ${i}`);
  const sizes: number[] = [];
  const counting: Embed = async (texts) => {
    sizes.push(texts.length);
    return texts.map(fakeVec);
  };
  assert.equal(await store.memory.index(A.id, counting, 'fake', 8), 8);
  assert.deepEqual(sizes, [2, 2, 2, 2]);
  store.db.close();
});

test("a running turn waits, and holds the mark, until its result; then it's indexed once", async () => {
  const { store, A, a1, a2 } = world(join(root, 'two.db'));
  const running = turn(store, a1.id, 'Cara', 'Still thinking about kiwis', 'Half an answer', false);
  turn(store, a2.id, 'Cara', 'Bananas please', 'Bananas done.');
  await store.memory.index(A.id, embed, 'fake');
  const turns = () => store.db.prepare("SELECT source_id, text FROM memory_chunks WHERE source_kind = 'turn'").all() as { source_id: number; text: string }[];
  assert.deepEqual(turns().map((t) => t.text.split('\n')[0]), ['Cara: Bananas please']);
  assert.ok((store.getSetting<number>(`memory_turns_after:${A.id}`) ?? 0) < running.id, 'the mark stays before the running turn');

  store.addEvent(a1.id, 'claude', assistant('Kiwis are settled: green ones.'));
  const result = store.addEvent(a1.id, 'claude', { type: 'result', result: 'x' });
  store.recordTurn(a1.id, { event_id: result.id, ended_at: Date.now(), session_cost_usd: 0 });
  await store.memory.index(A.id, embed, 'fake');
  assert.match(turns().find((t) => t.source_id === running.id)!.text, /Reply: Kiwis are settled: green ones\./, 'the final reply, not the half one');
  calls.length = 0;
  assert.equal(await store.memory.index(A.id, embed, 'fake'), 0, 'nothing left');
  assert.equal(calls.length, 0);

  // A turn with no result counts as over after an hour.
  const stuck = turn(store, a2.id, 'Cara', 'Lost turn about plums', 'Plums so far', false);
  await store.memory.index(A.id, embed, 'fake', 32, Date.now() + 2 * 60 * 60_000);
  assert.ok(turns().some((t) => t.source_id === stuck.id));
  store.db.close();
});

test("a message sent during a turn gets its own turn's reply, and the turn it waited on keeps its final one", async () => {
  const { store, A, a1 } = world(join(root, 'queued.db'));
  const a = store.addEvent(a1.id, 'user_message', { author: 'Cara', text: 'Question about apples' });
  store.addEvent(a1.id, 'claude', assistant('Apples half way'));
  const b = store.addEvent(a1.id, 'user_message', { author: 'Cara', text: 'Then pears' });
  store.db.prepare('UPDATE events SET created_at = ? WHERE id = ?').run(a.created_at + 5, b.id);
  store.addEvent(a1.id, 'claude', assistant('Apples final answer'));
  const ra = store.addEvent(a1.id, 'claude', { type: 'result' });
  const ended = a.created_at + 10;
  store.recordTurn(a1.id, { event_id: ra.id, ended_at: ended, duration_ms: ended - a.created_at, session_cost_usd: 0 });
  store.addEvent(a1.id, 'claude', assistant('Pears done'));
  const rb = store.addEvent(a1.id, 'claude', { type: 'result' });
  store.recordTurn(a1.id, { event_id: rb.id, ended_at: ended + 100, duration_ms: 50, session_cost_usd: 0 });
  while ((await store.memory.index(A.id, embed, 'fake')) > 0);
  const text = (id: number) => (store.db.prepare("SELECT text FROM memory_chunks WHERE source_kind = 'turn' AND source_id = ?").get(id) as { text: string }).text;
  assert.match(text(a.id), /Reply: Apples final answer$/);
  assert.match(text(b.id), /Reply: Pears done$/);
  store.db.close();
});

test('a new title or note, or a new model, embeds again; a deleted minion takes its chunks', async () => {
  const { store, A, a1, a2 } = world(join(root, 'three.db'));
  turn(store, a1.id, 'Cara', 'Hello there', 'Hi.');
  while ((await store.memory.index(A.id, embed, 'fake')) > 0);
  store.updateTicket(a1.id, { note: 'needs a pick: tabs or list' });
  assert.equal(await store.memory.index(A.id, embed, 'fake'), 1);
  assert.match((store.db.prepare("SELECT text FROM memory_chunks WHERE source_kind = 'ticket' AND source_id = ?").get(a1.id) as { text: string }).text, /needs a pick/);

  const n = (store.db.prepare('SELECT COUNT(*) AS n FROM memory_chunks').get() as { n: number }).n;
  let embedded = 0;
  for (let k; (k = await store.memory.index(A.id, embed, 'fake-2')) > 0; ) embedded += k;
  assert.equal(embedded, n, 'every row again with the new model');
  assert.equal((await store.memory.search(A.id, 'hello', embed, 'fake')).length, 0, "the old model's vectors aren't compared with the new one's");
  assert.ok((await store.memory.search(A.id, 'hello', embed, 'fake-2')).length > 0);

  store.deleteTicket(a1.id);
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM memory_chunks WHERE ticket_id = ?').get(a1.id) as { n: number }).n, 0);
  // A chunk an older release's deleteTicket left behind doesn't show on the minion that reuses its id.
  store.db.prepare("INSERT INTO memory_chunks (project_id, ticket_id, source_kind, source_id, ts, text, vec, model) VALUES (?, ?, 'turn', 999999, 1, 'left behind hello', ?, 'fake-2')")
    .run(A.id, a2.id, new Uint8Array(fakeVec('left behind hello').buffer));
  assert.ok((await store.memory.search(A.id, 'left behind hello', embed, 'fake-2', { limit: 20 })).every((h) => h.source_id !== 999999));
  store.db.close();
});

test('the route: the indexer fills it in the background, and nobody reads a scheme they are not in', async () => {
  // The embedding service, faked over HTTP as llama-server answers.
  const fake = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const { input } = JSON.parse(body) as { input: string[] };
    // A query's instruction is the same words every time: left in, they'd swamp the fake model's word counts.
    const embedding = (t: string) => [...fakeVec(t.replace(/^Instruct:[\s\S]*?\nQuery: /, ''))];
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: embedding(t) })) }));
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const embedUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  after(() => fake.close());

  const boot = mkdtempSync(join(tmpdir(), 'memory-boot-'));
  const data = join(boot, 'data');
  mkdirSync(data, { recursive: true });
  const { store, A, B, a1, a2, b1 } = world(join(data, 'coordinator.db'));
  turn(store, a1.id, 'Cara', 'Where do we keep the dentist reminders?', 'In the Mandate app.');
  turn(store, b1.id, 'Cara', 'B dentist secret', 'B reply');
  store.db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(a2.id);
  const tmA = store.createTicket({ project_id: A.id, title: 'A', permission_mode: 'default', created_by: 'Cara', kind: 'coordinator' });
  const contraptions = new Contraptions(store, SECRET, join(data, 'contraptions'));
  contraptions.register({ name: 'notes', title: 'Notes', port: 9177, icon: null, home_scheme: A.id, open_paths: '[]', default_model: null, turn_cap: null });
  const appKey = readFileSync(join(data, 'contraptions', 'notes', 'contraption.key'), 'utf8');
  store.db.close();

  // No CITADEL_MEMORY_SCHEMES: every scheme is indexed (#488).
  const srv = await bootServer({ root: boot, env: { CITADEL_EMBED_URL: embedUrl, CITADEL_MEMORY_SCHEMES: undefined, CITADEL_MEMORY_EVERY_MS: '100' } });
  try {
    const search = (project: number, q: string, headers: Record<string, string> = { Cookie: srv.cookie }, more = '') =>
      fetch(`${srv.base}/api/projects/${project}/memory?q=${encodeURIComponent(q)}${more}`, { headers }).then(async (r) => ({ status: r.status, data: await r.json() }));
    let r = await search(A.id, 'dentist reminders');
    for (let i = 0; i < 100 && !r.data.hits?.length; i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      r = await search(A.id, 'dentist reminders');
    }
    assert.equal(r.status, 200);
    assert.ok(r.data.hits.length > 0);
    assert.ok(r.data.hits.every((h: any) => h.ticket_id !== b1.id));

    const bearer = (id: number) => ({ Authorization: `Bearer ${agentToken(data, id)}` });
    assert.equal((await search(A.id, 'dentist', bearer(a1.id))).status, 200, "a minion searches its own scheme");
    assert.equal((await search(A.id, 'dentist', bearer(b1.id))).status, 403, "but not another scheme's");
    assert.ok((await search(B.id, 'dentist', bearer(b1.id))).data.hits.every((h: any) => h.ticket_id === b1.id));
    assert.equal((await search(A.id, 'x')).status, 400, 'too short to search');

    // The minion's MCP tool: listed only where memory is on, and answered through the route.
    const mcp = async (memory: boolean, method: string, params: object = {}) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.ts')], {
        env: { ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: agentToken(data, a1.id), COORDINATOR_PROJECT: String(A.id), COORDINATOR_TICKET: String(a1.id), COORDINATOR_ROLE: 'thread', COORDINATOR_MEMORY: memory ? '1' : '' },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      try {
        const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
        return (await reply).result;
      } finally {
        child.kill();
      }
    };
    const names = async (memory: boolean) => (await mcp(memory, 'tools/list')).tools.map((t: any) => t.name);
    assert.ok((await names(true)).includes('search_memory'));
    assert.ok(!(await names(false)).includes('search_memory'));
    const text = (await mcp(true, 'tools/call', { name: 'search_memory', arguments: { query: 'dentist reminders' } })).content[0].text;
    assert.match(text, new RegExp(`^#${a1.number} Dentist reminders · \\d{4}-\\d\\d-\\d\\d · `));
    assert.ok(!text.includes('B dentist secret'));

    // Open minions only, titles and notes only: the duplicate check's scope (#488).
    const minions = (await search(A.id, 'dentist reminders usage bar', undefined, '&scope=minions')).data.hits;
    assert.deepEqual(minions.map((h: any) => [h.source_kind, h.ticket_id, h.status]), [['ticket', a1.id, 'new']], 'no turns, and not the dismissed Usage bar');

    // create_ticket, as the Taskmaster: refused when an open minion reads like the same work, until not_duplicate.
    const create = async (args: object) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.ts')], {
        env: { ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: agentToken(data, tmA.id), COORDINATOR_PROJECT: String(A.id), COORDINATOR_TICKET: String(tmA.id), COORDINATOR_ROLE: 'coordinator', COORDINATOR_MEMORY: '1' },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      try {
        const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_ticket', arguments: { properties: { type: 'feature' }, ...args } } }) + '\n');
        const r = await reply;
        return r.result?.content?.[0]?.text ?? JSON.stringify(r);
      } finally {
        child.kill();
      }
    };
    const twin = await create({ title: 'Dentist reminders', message: 'Remind people about the dentist' });
    assert.match(twin, /^Not created: /);
    assert.match(twin, new RegExp(`^- #${a1.number} Dentist reminders \\(new, [01]\\.\\d+\\)$`, 'm'));
    assert.match(await create({ title: 'Usage bar', message: 'Show the usage bar' }), /^Created /, 'a dismissed minion is no twin');
    assert.match(await create({ title: 'Dentist reminders', message: 'Remind people about the dentist', not_duplicate: true }), /^Created /);

    // The embed route (#488): a contraption's own server, with its key, gets the model's vectors.
    const embedCall = (body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${appKey}` }) =>
      fetch(`${srv.base}/api/contraptions/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
    const got = await embedCall({ texts: ['dentist on tuesday', 'usage bar'] });
    assert.equal(got.status, 200);
    assert.equal(got.data.model, 'Qwen3-Embedding-0.6B-Q8_0');
    const dot = (a: number[], b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);
    assert.deepEqual(got.data.vectors.map((v: number[], i: number) => Math.round(dot(v, fakeVec(['dentist on tuesday', 'usage bar'][i])) * 1000) / 1000), [1, 1], 'each text its own vector, in order');
    assert.equal((await embedCall({ texts: ['x'] }, {})).status, 401, 'no key, no vectors');
    assert.equal((await embedCall({ texts: ['x'] }, { Cookie: srv.cookie })).status, 403, "a person's browser can't call it");
    for (const texts of [[], ['ok', ''], ['a'.repeat(4001)], Array(17).fill('a'), 'dentist', [3]]) assert.equal((await embedCall({ texts })).status, 400, JSON.stringify(texts).slice(0, 40));
  } finally {
    await srv.stop();
    rmSync(boot, { recursive: true, force: true });
  }
});
