import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { bootServer, jsonLines, tempRoot, until, ok, type Booted } from './helpers.ts';
import { agentEnv, mcpOnce } from './mcp-agent.ts';

// A minion proposes a machine's notes (#617, Josh: "Minion proposes, owner approves"): a plan card that only the
// machine's owner or an admin can approve, which saves them through the Machines page's PATCH. Through the real
// server, with a stand-in `claude -p` that records each turn's token and ends the turn.
const tmp = tempRoot('machine-notes-');
const root = tmp.dir;
after(() => tmp.teardown());

const fakeClaude = join(root, 'claude-fake');
writeFileSync(
  fakeClaude,
  `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).once('line', (prompt) => {
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ prompt: JSON.parse(prompt), token: process.env.COORDINATOR_TOKEN }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`,
);
chmodSync(fakeClaude, 0o755);

let base = '';
const cookies: Record<string, string> = {};
const ids: Record<string, number> = {};

let srv: Booted;
const call = async (who: string, path: string, opts: { method?: string; body?: unknown } = {}) => ok(await srv.as(who === 'minion' ? { token: live() } : { cookie: cookies[who] })(path, opts.body || undefined, opts.method ?? 'GET'));

const turns = () => jsonLines(join(root, 'turns.jsonl'));
const live = () =>
  turns()
    .filter((t) => t.token.startsWith(`${ticket.id}.`))
    .at(-1).token;
const idle = () => until('the turn to end', async () => (await call('Josh', `/api/tickets/${ticket.id}`)).ticket.status !== 'running');
const events = async (kind: string) => (await call('Josh', `/api/tickets/${ticket.id}/events?after=0`)).filter((e: any) => e.kind === kind).map((e: any) => JSON.parse(e.data));
const propose = (machine: string, notes: string) => call('minion', `/api/tickets/${ticket.id}/machine-notes`, { method: 'POST', body: { machine, notes } });
const verdict = (who: string, planId: string, v: 'approve' | 'revise', notes?: string) => call(who, `/api/tickets/${ticket.id}/verdict`, { method: 'POST', body: { planId, verdict: v, notes } });
const notesOf = async (name: string) => (await call('Cara', '/api/machines')).find((m: any) => m.name === name).notes;
/** The text of the newest message a person sent the minion. */
const lastMessage = async () => (await events('user_message')).at(-1).text;

let ticket: any;
let box: any;

before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude } });
  base = srv.base;
  cookies.Cara = srv.cookie;
  tmp.track(srv.proc);
  const project = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'P' } });
  for (const name of ['Josh', 'Dana']) {
    const made = await call('Cara', '/api/people', { method: 'POST', body: { name } });
    ids[name] = made.person.id;
    const res = await fetch(`${base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: `${name}-password-1` }) });
    cookies[name] = res.headers.get('set-cookie')!.split(';')[0];
    await call('Cara', `/api/projects/${project.id}/members`, { method: 'POST', body: { person: made.person.id } });
  }
  // Josh's turns run on the server's (stand-in) login, so his ask can start one: an owned machine goes only to its owner's turns.
  new Store(join(srv.data, 'coordinator.db')).updateUser(ids.Josh, { server_login: 1 });
  ({ machine: box } = await call('Josh', '/api/machines', { method: 'POST', body: { name: 'josh-box' } }));
  await call('Josh', `/api/machines/${box.id}`, { method: 'PATCH', body: { projects: [project.id], notes: 'Old line\nKeep this' } });
  await call('Josh', '/api/machines', { method: 'POST', body: { name: 'unlent' } });
  ticket = await call('Josh', `/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'change how josh-box is used' } });
  await until('the first turn', () => turns().length >= 1);
  await idle();
});

test("a minion proposes a lent machine's whole notes as a plan card with a diff; nobody else can, and bad notes are refused", async () => {
  const { id, href, owner } = await propose('josh-box', 'New line\nKeep this');
  assert.equal(owner, 'Josh');
  assert.match(href, /\?e=\d+$/);
  const [card] = await events('plan');
  assert.deepEqual(card, {
    id,
    summary: 'New notes for josh-box',
    plan: 'New line\nKeep this',
    status: 'pending',
    machine: { id: box.id, name: 'josh-box', owner: 'Josh' },
    old: 'Old line\nKeep this',
    diff: [
      { op: '-', text: 'Old line' },
      { op: '+', text: 'New line' },
    ],
  });
  await assert.rejects(propose('unlent', 'x'), /404 No machine called unlent that this minion gets/);
  await assert.rejects(propose('nope', 'x'), /404/);
  await assert.rejects(propose('josh-box', ' Old line\r\nKeep this '), /400 Those are already josh-box's notes/);
  await assert.rejects(propose('josh-box', 'x'.repeat(2001)), /400 Notes are limited to 2,000 characters/);
  await assert.rejects(call('Josh', `/api/tickets/${ticket.id}/machine-notes`, { method: 'POST', body: { machine: 'josh-box', notes: 'x' } }), /403/);
  await assert.rejects(verdict('minion', id, 'approve'), /403/);
});

test('only the owner or an admin approves; anyone in the scheme may reject, with or without a reason', async () => {
  const [{ id }] = await events('plan');
  await assert.rejects(verdict('Dana', id, 'approve'), /403 Only Josh, who owns josh-box, or an admin can approve its notes/);
  assert.equal((await events('plan'))[0].status, 'pending', 'a refused approve changes nothing');
  assert.equal(await notesOf('josh-box'), 'Old line\nKeep this');
  await verdict('Dana', id, 'revise');
  assert.equal((await events('plan'))[0].status, 'rejected');
  assert.equal(await lastMessage(), 'Rejected your proposed notes for josh-box; they are unchanged.');
  assert.equal(await notesOf('josh-box'), 'Old line\nKeep this');
  await assert.rejects(verdict('Josh', id, 'approve'), /409 Dana already rejected these notes/);
  await idle();
  const second = await propose('josh-box', 'Second');
  await verdict('Dana', second.id, 'revise', 'Not yet');
  assert.equal(await lastMessage(), 'Rejected your proposed notes for josh-box; they are unchanged.\n\nNot yet');
  await idle();
});

test('a newer proposal for the machine supersedes the open one, and a plan card is left alone', async () => {
  const notes = await propose('josh-box', 'Third');
  const plan = await call('minion', `/api/tickets/${ticket.id}/plans`, { method: 'POST', body: { summary: 'A plan', plan: 'Steps' } });
  const fourth = await propose('josh-box', 'Fourth');
  const status = Object.fromEntries((await events('plan')).map((c: any) => [c.id, c.status]));
  assert.equal(status[notes.id], 'superseded');
  assert.equal(status[plan.id], 'pending', 'a notes card does not supersede a plan');
  assert.equal(status[fourth.id], 'pending');
  await assert.rejects(verdict('Josh', notes.id, 'approve'), /409 A newer proposal for josh-box's notes replaced this one/);
  await call('minion', `/api/tickets/${ticket.id}/plans`, { method: 'POST', body: { summary: 'Another plan', plan: 'Steps' } });
  assert.equal(Object.fromEntries((await events('plan')).map((c: any) => [c.id, c.status]))[fourth.id], 'pending', 'nor a plan a notes card');
});

test('approving writes the notes through the PATCH path, unless they changed since the proposal', async () => {
  const fourth = (await events('plan')).filter((c: any) => c.machine && c.status === 'pending').at(-1);
  await call('Josh', `/api/machines/${box.id}`, { method: 'PATCH', body: { notes: 'Edited by hand' } });
  await assert.rejects(verdict('Josh', fourth.id, 'approve'), /409 josh-box's notes changed since this was proposed/);
  assert.equal(await notesOf('josh-box'), 'Edited by hand', 'the hand edit is not overwritten');

  const fifth = await propose('josh-box', 'Fifth\r\n');
  await verdict('Josh', fifth.id, 'approve');
  assert.equal(await notesOf('josh-box'), 'Fifth');
  const card = (await events('plan')).find((c: any) => c.id === fifth.id);
  assert.equal(card.status, 'approved');
  assert.equal(card.by, 'Josh');
  assert.equal(await lastMessage(), "Approved: josh-box's new notes are saved, and turns read them from their next start.");
  await idle();
  // An admin manages every machine, so Cara may approve too.
  const sixth = await propose('josh-box', 'Sixth');
  await verdict('Cara', sixth.id, 'approve');
  assert.equal(await notesOf('josh-box'), 'Sixth');
  await idle();
});

/** One JSON-RPC call through the real MCP server (src/mcp.ts) as this minion's turn, with the machines it got. */
async function mcp(method: string, params: object, machines: string): Promise<any> {
  return mcpOnce(agentEnv(base, live(), ticket, 'thread', { COORDINATOR_MACHINES: machines }), method, params, tmp.track);
}

test("the tool is listed for every minion with a free machine name (#878), refused for a machine the turn didn't get, and its call posts the card", async () => {
  const before = live();
  // Cara's approve started the last turn, and Josh's own machine goes only to his turns: he asks for this one.
  await call('Josh', `/api/tickets/${ticket.id}/messages`, { method: 'POST', body: { text: 'propose the notes again' } });
  await until("Josh's turn", () => turns().length && live() !== before && live());
  await idle();
  const offered = async (machines: string) => (await mcp('tools/list', {}, machines)).tools.find((t: any) => t.name === 'propose_machine_notes');
  assert.deepEqual(await offered(''), await offered('josh-box'));
  assert.equal((await offered('')).inputSchema.properties.machine.enum, undefined);
  const none = await mcp('tools/call', { name: 'propose_machine_notes', arguments: { machine: 'josh-box', notes: 'Seventh' } }, '');
  assert.ok(none.isError);
  assert.match(none.content[0].text, /This turn got no connected machines/);
  const r = await mcp('tools/call', { name: 'propose_machine_notes', arguments: { machine: 'josh-box', notes: 'Seventh' } }, 'josh-box');
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(r.content[0].text, /Only Josh \(its owner\) or an admin can approve it/);
  const card = (await events('plan')).at(-1);
  assert.deepEqual([card.plan, card.status], ['Seventh', 'pending']);
  assert.match(r.content[0].text, new RegExp(`\\[the notes card below\\]\\(#/p/${ticket.project_id}/t/${ticket.number}\\?e=\\d+\\)`));
});
