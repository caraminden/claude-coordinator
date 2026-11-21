// Semantic memory (#331): what gets indexed, what never does, and that a search never crosses schemes.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import type { Embed } from '../src/memory.ts';
import { Contraptions } from '../src/contraptions.ts';
import { agentToken, bootServer, SECRET, tempRoot, until } from './helpers.ts';

const tmp = tempRoot('memory-');
const root = tmp.dir;
after(() => tmp.teardown());

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

test('a search reads the vectors in pages and still finds the best across all of them, yielding between pages (#614)', async () => {
  const { store, A, a1, a2 } = world(join(root, 'pages.db'));
  const put = store.db.prepare("INSERT INTO memory_chunks (project_id, ticket_id, source_kind, source_id, ts, text, vec, model) VALUES (?, ?, 'turn', ?, ?, ?, ?, 'fake')");
  const now = Date.now();
  // 600 rows, more than two pages; the best match sits on the last one, a narrowed search's on the first.
  for (let i = 0; i < 600; i++) {
    const text = i === 599 ? 'dentist dentist' : i === 3 ? 'usage dentist' : `filler ${i} words`;
    put.run(A.id, i === 3 ? a2.id : a1.id, 10_000 + i, now, text, new Uint8Array(fakeVec(text).buffer));
  }
  let ticks = 0;
  let on = true;
  const tick = () => { if (on) { ticks++; setImmediate(tick); } };
  setImmediate(tick);
  const hits = await store.memory.search(A.id, 'dentist', embed, 'fake', { limit: 2 });
  on = false;
  assert.deepEqual(hits.map((h) => h.text), ['dentist dentist', 'usage dentist']);
  assert.ok(ticks > 0, 'other work ran between pages');
  assert.deepEqual((await store.memory.search(A.id, 'dentist', embed, 'fake', { ticketId: a2.id, limit: 20 })).map((h) => h.text), ['usage dentist']);

  // A minion deleted between pages, after its chunk was ranked, drops out of the hits rather than leaving a hit with no text.
  const pending = store.memory.search(A.id, 'dentist', embed, 'fake', { limit: 2 });
  setImmediate(() => store.deleteTicket(a2.id));
  assert.deepEqual((await pending).map((h) => h.text), ['dentist dentist']);
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
  const embedUrl = `http://127.0.0.1:${await tmp.serve(fake)}`;

  const boot = tmp.path('boot');
  const data = join(boot, 'data');
  mkdirSync(data, { recursive: true });
  const { store, A, B, a1, a2, b1 } = world(join(data, 'coordinator.db'));
  turn(store, a1.id, 'Cara', 'Where do we keep the dentist reminders?', 'In the Mandate app.');
  turn(store, b1.id, 'Cara', 'B dentist secret', 'B reply');
  store.db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(a2.id);
  store.props.set('minion', a1.id, A.id, { assigned: 'Josh' }, 'Cara');
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
    await until('the index to hold the minion', async () => {
      if (r.data.hits?.length) return true;
      r = await search(A.id, 'dentist reminders');
      return r.data.hits?.length > 0;
    }, 10_000);
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
      const child = tmp.spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.ts')], {
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
    // search_decisions (#1064) is listed with or without chat search, and answers with the page's entries and its sources.
    assert.ok((await names(false)).includes('search_decisions'));
    const said = (await mcp(false, 'tools/call', { name: 'search_decisions', arguments: { query: 'no such decision anywhere', scope: 'scheme' } })).content[0].text;
    assert.match(said, /^No decision matches\.\n\nSources: Citadel-wide instructions 0 in 1 file, Scheme instructions 0 in 1 file, The kit \d+ in \d+ files\.$/);

    // Open minions only, titles and notes only: the duplicate check's scope (#488).
    const minions = (await search(A.id, 'dentist reminders usage bar', undefined, '&scope=minions')).data.hits;
    assert.deepEqual(minions.map((h: any) => [h.source_kind, h.ticket_id, h.status]), [['ticket', a1.id, 'new']], 'no turns, and not the dismissed Usage bar');

    // create_ticket, as the Taskmaster: refused when an open minion reads like the same work, until not_duplicate.
    const create = async (args: object) => {
      const child = tmp.spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.ts')], {
        env: { ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: agentToken(data, tmA.id), COORDINATOR_PROJECT: String(A.id), COORDINATOR_TICKET: String(tmA.id), COORDINATOR_ROLE: 'coordinator', COORDINATOR_MEMORY: '1' },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      try {
        const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_ticket', arguments: { properties: { type: 'feature' }, model: 'claude-opus-5-5', effort: 'high', ...args } } }) + '\n');
        const r = await reply;
        return r.result?.content?.[0]?.text ?? JSON.stringify(r);
      } finally {
        child.kill();
      }
    };
    const twin = await create({ title: 'Dentist reminders', message: 'Remind people about the dentist' });
    assert.match(twin, /^Not created: /);
    assert.match(twin, new RegExp(`^- #${a1.number} Dentist reminders, Josh's \\(new, [01]\\.\\d+\\)$`, 'm'), "with its owner (#689)");
    assert.match(await create({ title: 'Usage bar', message: 'Show the usage bar' }), /^Created /, 'a dismissed minion is no twin');
    assert.match(await create({ title: 'Dentist reminders', message: 'Remind people about the dentist', not_duplicate: true }), /^Created /);

    // A person's start (#689): never refused, and a quiet note in the new minion's chat names the look-alike with its owner.
    const started = await fetch(`${srv.base}/api/projects/${A.id}/tickets`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: srv.cookie }, body: JSON.stringify({ title: 'Dentist reminders', message: 'Remind people about the dentist' }) });
    assert.equal(started.status, 201);
    const { id: newId } = await started.json();
    const look = new Store(join(data, 'coordinator.db'));
    const noteOf = (id: number) => (look.db.prepare("SELECT data FROM events WHERE ticket_id = ? AND kind = 'note' AND data LIKE '%Similar and open%'").get(id) as { data: string } | undefined)?.data;
    let note = noteOf(newId);
    await until('the twin note', () => ((note ??= noteOf(newId)), note !== undefined), 5_000);
    assert.match(JSON.parse(note ?? '{}').text ?? '', new RegExp(`^Similar and open: .*#${a1.number} 'Dentist reminders', Josh's`));
    assert.ok(!JSON.parse(note!).text.includes(`'Usage bar'`), 'a dismissed minion is no twin');
    look.db.close();

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
  }
});

test('a search with a selective filter yields between pages of rows scanned, and still finds matches on late pages (#1034)', async () => {
  const { store, A, a1 } = world(join(root, 'paged.db'));
  const put = store.db.prepare("INSERT INTO memory_chunks (project_id, ticket_id, person_id, source_kind, source_id, ts, text, vec, model) VALUES (?, ?, ?, 'turn', ?, ?, ?, ?, 'fake')");
  const vec = new Uint8Array(fakeVec('dentist').buffer);
  // 600 chunks of one person, then 100 of another: a search for the second's matches only on its last page of 256.
  store.db.exec('BEGIN');
  for (let i = 0; i < 700; i++) put.run(A.id, a1.id, i < 600 ? 1 : 2, 1000 + i, Date.now() + 1000, `chunk ${i}`, vec);
  store.db.exec('COMMIT');
  let ticks = 0, going = true;
  const tick = () => { ticks++; if (going) setImmediate(tick); };
  setImmediate(tick);
  const hits = await store.memory.search(A.id, 'dentist', embed, 'fake', { personId: 2, limit: 20 });
  going = false;
  assert.equal(hits.length, 20);
  assert.ok(hits.every((h) => h.source_id >= 1600));
  // 700 rows are 3 pages of 256, so the search yields twice.
  assert.ok(ticks >= 2, `the search held the loop for all 700 rows at once (${ticks} ticks)`);
});

// #1125: the pass read every message past the mark, text and all, into a sort for 200 of them (0.7 s of the loop).
test('indexing finds new messages through events_asks, not a seek into every minion of the scheme (#1251)', async () => {
  const { store } = world(join(root, 'asks.db'));
  const P = store.createProject('P', null);
  for (let i = 0; i < 3; i++) store.createTicket({ project_id: P.id, title: `m${i}`, permission_mode: 'default', created_by: 'cara' });
  const t = store.createTicket({ project_id: P.id, title: 'm', permission_mode: 'default', created_by: 'cara' });
  turn(store, t.id, 'cara', 'question', 'answer');
  const seen: string[] = [];
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = ((sql: string, ...r: any[]) => { seen.push(sql); return prepare(sql, ...r); }) as typeof store.db.prepare;
  await store.memory.index(P.id, embed, 'fake');
  const ids = seen.find((sql) => /SELECT e\.id FROM events e/.test(sql));
  assert.ok(ids, 'pendingTurns reads the message ids first');
  const plan = (prepare(`EXPLAIN QUERY PLAN ${ids}`).all(1, 0, 1e9) as { detail: string }[]).map((r) => r.detail).join(' | ');
  // A seek per minion was 2,200 random reads a pass on a big scheme: on a disk busy after a deploy it held the loop 23 s.
  // Covering: the walk reads ticket_id from the index, not a page of the events table per message.
  assert.match(plan, /^SEARCH e USING COVERING INDEX events_asks/, plan);
  assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
});

test("a quiet scheme's mark moves past other schemes' messages, so the next pass doesn't walk them again (#1251)", async () => {
  const { store, A, b1 } = world(join(root, 'quiet.db'));
  let last = 0;
  for (let i = 0; i < 5; i++) last = turn(store, b1.id, 'cara', `question ${i}`, `answer ${i}`).id;
  await store.memory.index(A.id, embed, 'fake');
  assert.ok((store.getSetting<number>(`memory_turns_after:${A.id}`) ?? 0) >= last, "the mark moves past B's messages");
});

test('indexing sorts message ids, never message text', async () => {
  const { store } = world(join(root, 'sort.db'));
  const P = store.createProject('P', null);
  const t = store.createTicket({ project_id: P.id, title: 'm', permission_mode: 'default', created_by: 'cara' });
  for (let i = 0; i < 5; i++) turn(store, t.id, 'cara', `question ${i}`, `answer ${i}`);
  const seen: string[] = [];
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = ((sql: string, ...r: any[]) => { seen.push(sql); return prepare(sql, ...r); }) as typeof store.db.prepare;
  assert.equal(await store.memory.index(P.id, embed, 'fake'), 6, 'five turns and the minion itself');
  const withText = seen.filter((sql) => /e\.data/.test(sql) && /FROM events/.test(sql));
  assert.ok(withText.length);
  for (const sql of withText) {
    const plan = (store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array((sql.match(/\?/g) ?? []).length).fill(1)) as { detail: string }[]).map((r) => r.detail).join('\n');
    assert.doesNotMatch(plan, /TEMP B-TREE/, `a statement that reads message text must not sort:\n${sql}`);
  }
});

test('a cut that lands inside an emoji never sends a lone surrogate to the embedder', async () => {
  const { store, A, a1 } = world(join(root, 'emoji.db'));
  // USER_MAX is 1000: 999 letters then an emoji put the cut between its two halves.
  turn(store, a1.id, 'Cara', `${'a'.repeat(999)}😀 and more`, 'Fine.');
  const sent: string[] = [];
  const strict: Embed = async (texts) => {
    sent.push(...texts);
    return texts.map(fakeVec);
  };
  while ((await store.memory.index(A.id, strict, 'fake')) > 0);
  assert.ok(sent.some((t) => t.includes('aaaa')), 'the turn was embedded');
  for (const t of sent) assert.equal(t, t.toWellFormed(), 'no lone surrogate');
  store.db.close();
});

test('a chunk the embedder refuses with a 4xx is skipped once and indexing moves on; a 5xx still stops the pass', async () => {
  const { store, A, a1, a2 } = world(join(root, 'refused.db'));
  turn(store, a1.id, 'Cara', 'POISON chunk about kiwis', 'Kiwis.');
  turn(store, a2.id, 'Josh', 'A fine question about limes', 'Limes.');
  const refusing: Embed = async (texts) => {
    if (texts.some((t) => t.includes('POISON'))) throw Object.assign(new Error('embedding service answered 400'), { status: 400 });
    return texts.map(fakeVec);
  };
  const logged: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logged.push(a);
  try {
    for (let i = 0; i < 6; i++) await store.memory.index(A.id, refusing, 'fake', 8);
  } finally {
    console.error = orig;
  }
  const texts = (store.db.prepare("SELECT text FROM memory_chunks WHERE source_kind = 'turn'").all() as { text: string }[]).map((r) => r.text);
  assert.ok(texts.some((t) => t.includes('limes')), 'the chunk after it is indexed');
  assert.ok(!texts.some((t) => t.includes('POISON')), 'the refused one is not');
  assert.equal(logged.filter((a) => String(a[0]).includes('skipped')).length, 1, 'logged once');
  const down: Embed = async () => {
    throw Object.assign(new Error('embedding service answered 503'), { status: 503 });
  };
  turn(store, a1.id, 'Cara', 'Another question about pears', 'Pears.');
  await assert.rejects(store.memory.index(A.id, down, 'fake', 8), /503/);
  store.db.close();
});
