// Schemes put items in the asking person's Mandate (#268, src/mandate-items.ts) and hear her ticks back
// (src/relay.ts schemeHook). A stand-in Mandate records what it's sent; a stand-in `claude -p` calls
// mandate_item's route mid-turn with its thread token, as the MCP tool does.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { messagePerson } from '../src/access.ts';
import { verifyIdentity } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { bootServer, freePort, jsonLines, stopProcs, until, type Booted, stopTurns, testPins } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'mandate-items-'));
const procs: ChildProcess[] = [];

// Each turn runs the calls in plan-<ticket id>.json, then logs what came back.
const fakeClaude = join(root, 'claude-fake');
writeFileSync(fakeClaude, `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).once('line', async (prompt) => {
  const planFile = ${JSON.stringify(root)} + '/plan-' + process.env.COORDINATOR_TICKET + '.json';
  const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : [];
  const api = readFileSync(${JSON.stringify(join(root, 'api'))}, 'utf8');
  const out = [];
  for (const c of plan) {
    const r = await fetch(api + '/api/mandate/items/' + c.key, {
      method: c.method, body: c.body && JSON.stringify(c.body),
      headers: { Authorization: 'Bearer ' + process.env.COORDINATOR_TOKEN, ...(c.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    out.push({ status: r.status, data: await r.json() });
  }
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ ticket: Number(process.env.COORDINATOR_TICKET), prompt: JSON.parse(prompt), out }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`);
chmodSync(fakeClaude, 0o755);

// The stand-in Mandate: a key ending in "off" is switched off; anything else is taken.
const seen: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[] = [];
const mandate = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ method: req.method!, path: req.url!, headers: req.headers, body });
    const key = req.url!.split('/').at(-1)!;
    if (key.endsWith('off')) return void res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":"off","message":"She switched P off"}');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(req.method === 'DELETE' ? { key, state: 'cleared' } : { key, state: 'open', mine: [] }));
  });
});

let srv: Booted;
let project: any;
let minion: any;
let mandateKey = '';
let mandatePub = '';
let peekKey = '';
let cara = 0;

const turns = () => jsonLines(join(root, 'turns.jsonl'));
const idle = (id: number) => until('the turn to end', async () => {
  const { ticket } = (await srv.call(`/api/tickets/${id}`)).data;
  return ticket.status !== 'running' && ticket.queued === 0;
});
/** Cara types a message to the minion; the turn it starts runs `plan`. Returns what the calls answered. */
async function typed(plan: object[], text = 'please') {
  writeFileSync(join(root, `plan-${minion.id}.json`), JSON.stringify(plan));
  const n = turns().length;
  assert.equal((await srv.call(`/api/tickets/${minion.id}/messages`, { text })).status, 202);
  const t = await until('the turn', () => turns().length > n && turns().slice(n).find((t: any) => t.ticket === minion.id));
  writeFileSync(join(root, `plan-${minion.id}.json`), '[]');
  await idle(minion.id);
  return t.out;
}
const hook = (scheme: string, body: unknown, key = mandateKey, person = cara) =>
  fetch(`${srv.base}/api/contraptions/relay/${scheme}/mandate-hook`, {
    method: 'POST', body: JSON.stringify(body), headers: { Authorization: `Bearer ${key}`, 'X-Citadel-Person': String(person), 'Content-Type': 'application/json' },
  });
const said = async (id: number) => ((await srv.call(`/api/tickets/${id}/events?after=0`)).data as any[])
  .map((e) => e.kind === 'user_message' && JSON.parse(e.data)).filter((d) => d && d.author === 'Mandate').map((d) => d.text);

before(async () => {
  const port = await freePort();
  await new Promise<void>((r) => mandate.listen(port, '127.0.0.1', r));
  srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude } });
  procs.push(srv.proc);
  writeFileSync(join(root, 'api'), srv.base);
  const m = await srv.call('/api/contraptions', { name: 'mandate', title: 'Mandate', port });
  assert.equal(m.status, 201);
  mandateKey = readFileSync(join(m.data.keys_dir, 'contraption.key'), 'utf8');
  mandatePub = readFileSync(join(m.data.keys_dir, 'identity.pub'), 'utf8');
  const peek = await srv.call('/api/contraptions', { name: 'peek', title: 'Peek', port: await freePort() });
  peekKey = readFileSync(join(peek.data.keys_dir, 'contraption.key'), 'utf8');
  cara = (await srv.call('/api/me')).data.id;
  for (const name of ['mandate', 'peek']) assert.equal((await srv.call(`/api/contraptions/${name}/people/${cara}`, { enabled: true }, 'PUT')).status, 200);
  project = (await srv.call('/api/projects', { name: 'P' })).data;
  minion = (await srv.call(`/api/projects/${project.id}/tickets`, { message: 'start' })).data;
  await idle(minion.id);
});
after(async () => {
  await stopProcs(procs);
  mandate.closeAllConnections();
  mandate.close();
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});

test("a turn answering Cara's typed message puts the item straight in her Mandate, signed for the scheme, and Mandate's answer comes back", async () => {
  const n = seen.length;
  const out = await typed([{ method: 'PUT', key: 'pr-13', body: { title: 'Review PR #13', day: '2026-11-02', hook: false, link: '/elsewhere' } }]);
  assert.deepEqual(out, [{ status: 200, data: { status: 200, answer: { key: `${minion.number}.pr-13`, state: 'open', mine: [] } } }]);
  assert.equal(seen.length, n + 1);
  const s = seen.at(-1)!;
  assert.deepEqual([s.method, s.path], ['PUT', `/apps/mandate/app-api/items/${minion.number}.pr-13`]);
  // hook is always on and link always the minion's page, whatever the caller sent.
  assert.deepEqual(JSON.parse(s.body), { hook: true, link: `/c/#/p/${project.id}/t/${minion.number}`, title: 'Review PR #13', day: '2026-11-02' });
  const claims = verifyIdentity(s.headers['x-citadel-identity'] as string, mandatePub, 'mandate');
  assert.ok(claims, "signed with Mandate's own key");
  assert.deepEqual([claims.sub, claims.login, claims.from, claims.fromTitle], [cara, 'cara', `scheme-${project.id}`, 'P']);
  assert.equal(s.headers.authorization, undefined);

  // Mandate's refusals pass back as they are.
  const off = await typed([{ method: 'PUT', key: 'x-off', body: { title: 'Nope' } }]);
  assert.deepEqual(off[0].data, { status: 403, answer: { error: 'off', message: 'She switched P off' } });
  // A key that isn't Mandate's shape never leaves Citadel.
  const bad = await typed([{ method: 'PUT', key: 'a%20b', body: { title: 'x' } }]);
  assert.equal(bad[0].status, 400);
  // Nor for someone without Mandate.
  assert.equal((await srv.call(`/api/contraptions/mandate/people/${cara}`, { enabled: false }, 'PUT')).status, 200);
  const n2 = seen.length;
  const without = await typed([{ method: 'PUT', key: 'pr-14', body: { title: 'x' } }]);
  assert.deepEqual([without[0].status, without[0].data.error], [403, "Cara doesn't have Mandate enabled"]);
  assert.equal(seen.length, n2);
  assert.equal((await srv.call(`/api/contraptions/mandate/people/${cara}`, { enabled: true }, 'PUT')).status, 200);
});

test('her tick comes back into the minion as a [Mandate] message quoting the title; a clear forgets it', async () => {
  let res = await hook(`scheme-${project.id}`, { key: `${minion.number}.pr-13`, event: 'ticked', at: '2026-11-02T08:14:00Z' });
  assert.deepEqual([res.status, await res.json()], [200, { delivered: true }]);
  await until('the message', async () => (await said(minion.id)).length === 1);
  assert.deepEqual(await said(minion.id), ['Cara ticked "Review PR #13" (key pr-13)']);
  await idle(minion.id);

  const out = await typed([{ method: 'DELETE', key: 'pr-13' }]);
  assert.deepEqual(out[0].data, { status: 200, answer: { key: `${minion.number}.pr-13`, state: 'cleared' } });
  assert.equal(seen.at(-1)!.method, 'DELETE');
  res = await hook(`scheme-${project.id}`, { key: `${minion.number}.pr-13`, event: 'restored', at: '2026-11-02T08:15:00Z' });
  assert.equal(res.status, 200);
  await until('the message', async () => (await said(minion.id)).length === 2);
  assert.equal((await said(minion.id))[1], 'Cara restored an item (key pr-13)');
  await idle(minion.id);
});

test('an item the chat put can be cleared on any turn, for the person it was put for; a put still needs her typed message (#532)', async () => {
  await typed([{ method: 'PUT', key: 'ci-red', body: { title: 'CI is red on main', alert: true } }]);
  // The next turn is Mandate's own hook (no one typed it), as a GitHub message or a wake would be.
  writeFileSync(join(root, `plan-${minion.id}.json`), JSON.stringify([{ method: 'DELETE', key: 'ci-red' }, { method: 'DELETE', key: 'never-put' }, { method: 'PUT', key: 'ci-red', body: { title: 'again' } }]));
  const n = turns().length;
  const res = await hook(`scheme-${project.id}`, { key: `${minion.number}.ci-red`, event: 'ticked', at: '2026-11-02T08:14:00Z' });
  assert.equal(res.status, 200);
  const t = await until('the turn', () => turns().slice(n).find((x: any) => x.ticket === minion.id));
  writeFileSync(join(root, `plan-${minion.id}.json`), '[]');
  await idle(minion.id);
  assert.deepEqual(t.out[0], { status: 200, data: { status: 200, answer: { key: `${minion.number}.ci-red`, state: 'cleared' } } });
  const s = seen.findLast((x) => x.method === 'DELETE')!;
  assert.equal(s.path, `/apps/mandate/app-api/items/${minion.number}.ci-red`);
  assert.equal(verifyIdentity(s.headers['x-citadel-identity'] as string, mandatePub, 'mandate')?.sub, cara, "cleared from Cara's Mandate");
  assert.equal(t.out[1].status, 403, 'a key this chat never put is still the typed person\'s only');
  assert.equal(t.out[2].status, 403, 'and so is every put');
});

test("only Mandate's hook, for a person on the scheme, reaches a minion; a closed one drops it with a 200", async () => {
  const body = { key: `${minion.number}.k`, event: 'ticked', at: '2026-11-02T08:14:00Z' };
  const status = async (r: Promise<Response>) => {
    const res = await r;
    return [res.status, (await res.json()).error];
  };
  assert.deepEqual(await status(hook(`scheme-${project.id}`, body, peekKey)), [404, 'no_route'], 'only Mandate');
  assert.deepEqual(await status(fetch(`${srv.base}/api/contraptions/relay/scheme-${project.id}/other`, {
    method: 'POST', body: JSON.stringify(body), headers: { Authorization: `Bearer ${mandateKey}`, 'X-Citadel-Person': String(cara), 'Content-Type': 'application/json' },
  })), [404, 'no_route'], 'only /mandate-hook');
  assert.deepEqual(await status(hook('scheme-999', body)), [404, 'no_route']);
  assert.deepEqual((await status(hook(`scheme-${project.id}`, { ...body, event: 'eaten' })))[0], 400);
  assert.deepEqual((await status(hook(`scheme-${project.id}`, { ...body, key: 'no-number' })))[0], 400);

  const store = new Store(join(srv.data, 'coordinator.db'));
  store.updateTicket(minion.id, { status: 'closed' });
  const before = (await said(minion.id)).length;
  const res = await hook(`scheme-${project.id}`, body);
  assert.deepEqual([res.status, await res.json()], [200, { delivered: false }]);
  assert.equal((await said(minion.id)).length, before, 'a closed minion stays closed');
  const gone = await hook(`scheme-${project.id}`, { ...body, key: '999.k' });
  assert.deepEqual([gone.status, await gone.json()], [200, { delivered: false }]);
  store.updateTicket(minion.id, { status: 'idle' });
});

test("in a split scheme a tick on a Taskmaster's item reaches the ticker's own Taskmaster (#921)", async () => {
  const shared = (await srv.call('/api/projects', { name: 'Shared' })).data;
  await srv.call(`/api/projects/${shared.id}`); // makes its Taskmaster
  const store = new Store(join(srv.data, 'coordinator.db'));
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  store.addMember(shared.id, josh.id);
  const own = store.splitScheme(shared.id, josh.id);
  store.db.close();
  assert.equal((await srv.call(`/api/contraptions/mandate/people/${josh.id}`, { enabled: true }, 'PUT')).status, 200);
  const res = await hook(`scheme-${shared.id}`, { key: '0.lane', event: 'ticked', at: '2026-11-17T08:14:00Z' }, mandateKey, josh.id);
  assert.deepEqual([res.status, await res.json()], [200, { delivered: true }]);
  assert.equal((await said(own.id)).length, 1, "Josh's own Taskmaster hears his tick");
});

test('scheme-<number> names are kept for schemes', async () => {
  const r = await srv.call('/api/contraptions', { name: 'scheme-12', title: 'Sneaky', port: await freePort() });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /reserved/);
});

// Which turns may post (Runner.typedBy): only one answering one person's own typed message.
test('typedBy: a typed message is its person\'s; GitHub, relays, contraption asks and two typists are no one\'s; a typed steer counts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'typed-by-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  // Turn n replies once release-<n> is in its folder, and exits at the end of its input.
  const hold = join(dir, 'claude-hold');
  writeFileSync(hold, `#!${process.execPath}
const fs = require('node:fs');
const n = (fs.existsSync('count') ? Number(fs.readFileSync('count', 'utf8')) : 0) + 1;
fs.writeFileSync('count', String(n));
let replied = false, closed = false;
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', () => {});
rl.on('close', () => (closed = true));
setInterval(() => {
  if (!replied && fs.existsSync('release-' + n)) { replied = true; console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' })); }
  if (replied && closed) process.exit(0);
}, 20);
`);
  chmodSync(hold, 0o755);
  const store = new Store(join(dir, 'coordinator.db'));
  const Cara = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
  const Josh = store.createUser({ name: 'Josh', login: 'josh' });
  const Rachel = store.createUser({ name: 'Rachel', login: 'rachel' });
  const p = store.createProject('P', null);
  store.adoptOwnerless(Cara.id);
  store.addMember(p.id, Josh.id);
  store.addMember(p.id, Rachel.id);
  const t = store.createTicket({ project_id: p.id, kind: 'ticket', title: 'M', permission_mode: 'default', created_by: 'Cara' });
  const tm = store.createTicket({ project_id: p.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(dir, 'm');
  mkdirSync(cwd);
  store.setTicketDir(t.id, cwd, null);
  store.updateTicket(t.id, { person_id: Cara.id });
  const r = new Runner(store, () => {}, () => ({}), hold);
  r.pollMs = 10;
  r.personOf = messagePerson(store);
  const count = () => { try { return Number(readFileSync(join(cwd, 'count'), 'utf8')); } catch { return 0; } };
  const turn = (k: number) => until(`turn ${k}`, () => count() === k && r.isRunning(t.id));
  const release = (k: number) => writeFileSync(join(cwd, `release-${k}`), '');
  const idle = () => until('the end', () => !r.isRunning(t.id) && r.queued(t.id) === 0);
  /** typedBy while a turn on `msgs` runs; `queue` waits behind it and makes the next turn, whose typedBy it is then; `steer` goes into the last. */
  const during = async (msgs: [string, object][], opts: { steer?: [string, object]; queue?: [string, object][] } = {}) => {
    let k = count() + 1;
    for (const [author, extra] of msgs) r.send(t.id, author, 'hi', [], extra);
    await turn(k);
    if (opts.queue) {
      for (const [author, extra] of opts.queue) r.send(t.id, author, 'next', [], extra);
      release(k++);
      await turn(k);
    }
    if (opts.steer) r.send(t.id, opts.steer[0], 'and', [], opts.steer[1], true);
    const who = r.typedBy(t.id);
    release(k);
    // The stand-in never reads a steer, so it comes back as a turn of its own.
    if (opts.steer) release(k + 1);
    await idle();
    return who;
  };
  assert.equal(await during([['Cara', { typed: true }]]), Cara.id);
  assert.equal(r.typedBy(t.id), null, 'and no one once it ends');
  assert.equal(await during([['GitHub', {}]]), null);
  // (Before Josh's asks below: a turn someone else asked for takes no steer from Cara, #255.)
  assert.equal(await during([['GitHub', {}]], { steer: ['Cara', { typed: true }] }), Cara.id, 'Cara typed into a GitHub turn');
  assert.equal(await during([['Cara', {}]]), null, 'not typed: a brief or a card answer');
  // Josh's typed steer into Cara's typed turn waits for a turn of its own: the running one keeps her env (#295).
  assert.equal(await during([['Cara', { typed: true }]], { steer: ['Josh', { typed: true }] }), Cara.id, "Josh can't steer into Cara's typed turn");
  assert.equal(await during([['Taskmaster', { from: tm.id }]]), null, 'a relay');
  assert.equal(await during([['Contraption Peek, for Josh', { asker: Josh.id }]]), null, "a contraption's ask");
  assert.equal(await during([['GitHub', {}]], { queue: [['Cara', { typed: true }], ['GitHub', {}]] }), Cara.id, 'Cara typed, with GitHub in the same turn');
  assert.equal(await during([['GitHub', {}]], { queue: [['Cara', { typed: true }], ['Josh', { typed: true }]] }), null, 'two people typed');
  assert.equal(await during([['GitHub', {}]], { queue: [['Josh', { typed: true }], ['Rachel', { typed: true }]], steer: ['Josh', { typed: true }] }), null, 'a steer after two typists leaves it no one\'s');
});
