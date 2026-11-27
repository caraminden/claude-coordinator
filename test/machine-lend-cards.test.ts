import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { agentToken, bootServer, ok, stopProcs, tempRoot, until, type Booted } from './helpers.ts';
import { machineFakes } from './machine-fakes.ts';
import { agentEnv, mcpOnce } from './mcp-agent.ts';
import { lendLines, lendPatch, type MachineNow } from '../src/machine-lend.ts';
import { Store } from '../src/db.ts';

// propose_machine_lend (#1638; Cara, 2026-11-22, "Propose, card, link", "Who can save the page", "Both", "Machine
// switches"): a minion or Taskmaster asks for a machine's lending to change, a card shows it, and Approve by the
// machine's owner or an admin saves it through the Machines page's PATCH, so the real agent is told and the sessions of
// a scheme taken off end, as a page save does.
const tmp = tempRoot('machine-lend-');
const root = tmp.dir;
const procs: ChildProcess[] = [];
after(async () => {
  try {
    await srv?.settled();
  } finally {
    await stopProcs(procs);
    await tmp.teardown();
  }
});
const { mcpServer, fakeClaude, startMachineAgent } = machineFakes(root, procs);

let srv: Booted;
const cookies: Record<string, string> = {};
/** As a person (by name) or an agent ('agent:<ticket id>'). */
const call = async (who: string, path: string, opts: { method?: string; body?: unknown } = {}) => ok(await srv.as(who.startsWith('agent:') ? { token: agentToken(srv.data, Number(who.slice(6))) } : { cookie: cookies[who] })(path, opts.body || undefined, opts.method ?? 'GET'));

let project: { id: number };
let minion: { id: number };
let joshs: { id: number };
let taskmaster: { id: number };
let box: { id: number };
let output: () => string;

/** A chat event's data, as the tests read a lending card or a message. */
type Card = { id: string; status: string; summary: string; plan: string; text: string; machineLend: { lines: string[]; after: unknown } };
const events = async (t: { id: number }, kind = 'plan'): Promise<Card[]> => (await call('Cara', `/api/tickets/${t.id}/events?after=0`)).filter((e: { kind: string }) => e.kind === kind).map((e: { data: string }) => JSON.parse(e.data) as Card);
const card = async (t: { id: number }, id: string) => (await events(t)).find((c) => c.id === id)!;
const propose = (body: object, t = minion) => call(`agent:${t.id}`, `/api/tickets/${t.id}/machine-lend`, { method: 'POST', body });
const verdict = (who: string, t: { id: number }, planId: string, v: 'approve' | 'revise', notes?: string) => call(who, `/api/tickets/${t.id}/verdict`, { method: 'POST', body: { planId, verdict: v, notes } });
const boxNow = async () => (await call('Cara', '/api/machines')).find((m: { name: string }) => m.name === 'box');
const idle = (t: { id: number }) => until('the turn to end', async () => (await call('Cara', `/api/tickets/${t.id}`)).ticket.status !== 'running');
const lastMessage = async (t: { id: number }) => (await events(t, 'user_message')).at(-1)!.text;

before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude } });
  cookies.Cara = srv.cookie;
  procs.push(srv.proc);
  project = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Cantrips' } });
  for (const name of ['Josh', 'Dana']) {
    const made = await call('Cara', '/api/people', { method: 'POST', body: { name } });
    const res = await fetch(`${srv.base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: `${name}-password-1` }) });
    cookies[name] = res.headers.get('set-cookie')!.split(';')[0];
    await call('Cara', `/api/projects/${project.id}/members`, { method: 'POST', body: { person: made.person.id } });
    // Their turns run on the server's (stand-in) login, so their asks start turns.
    new Store(join(srv.data, 'coordinator.db')).updateUser(made.person.id, { server_login: 1 });
  }
  // An admin's machine, its tools lent to every turn in its schemes (Build 10 H1: no row is shared, it has an owner), with
  // a real agent that found two workspaces and an MCP server.
  const dir = join(root, 'box');
  for (const d of ['w', 'x', 'home']) mkdirSync(join(dir, d), { recursive: true });
  const config = join(dir, 'machine-agent.json');
  writeFileSync(config, JSON.stringify({ servers: { own: { run: [process.execPath, mcpServer] } }, workspaces: { w: { path: join(dir, 'w') }, x: { path: join(dir, 'x') } } }));
  const made = await call('Cara', '/api/machines', { method: 'POST', body: { name: 'box' } });
  box = made.machine;
  await call('Cara', `/api/machines/${box.id}/roles`, { method: 'PATCH', body: { role: 'tools', everyone: true } });
  ({ output } = startMachineAgent({ base: srv.base, token: made.token, run: ['--config', config], env: { CLAUDE_CONFIG_DIR: join(dir, 'home') } }));
  await until('box to report what it found', async () => {
    const m = await boxNow();
    return m.managed && m.workspaces.length === 2 && m;
  });
  await call('Josh', '/api/machines', { method: 'POST', body: { name: 'josh-box' } });
  minion = await call('Cara', `/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'use box' } });
  await idle(minion);
  joshs = await call('Josh', `/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'use my box' } });
  await idle(joshs);
  ({ coordinator: taskmaster } = await call('Cara', `/api/projects/${project.id}`));
});

test('the change is worked out against the machine as it is: only what differs, keeping the GPU switch', () => {
  const now: MachineNow = { projects: [1], lend: { server: 'own', workspaces: ['w'], gpu_off: true }, workspace_tools: false, always_on: false };
  assert.deepEqual(lendPatch({ here: true, tick: ['w'], server: 'own', always_on: false }, now, 1), {}, 'all of it already so');
  assert.deepEqual(lendPatch({ tick: ['x'], untick: ['w'] }, now, 2), { lend: { server: 'own', workspaces: ['x'], gpu_off: true } });
  assert.deepEqual(lendPatch({ here: false, always_on: true }, now, 1), { projects: [], always_on: true });
  assert.deepEqual(lendLines({ here: true, tick: ['x'], server: null, workspace_tools: true }, now, { id: 2, name: 'S' }, 'm'), ['+ Lend m to S', '+ Tick the x workspace', '− Untick the own MCP server', '+ Switch workspace tools on']);
  // The GPU jobs switch, the page's third (Cara, 2026-11-22, "Machine switches").
  assert.deepEqual(lendPatch({ gpu: true }, now, 1), { lend: { server: 'own', workspaces: ['w'] } });
  assert.deepEqual(lendPatch({ gpu: false }, now, 1), {}, 'already off');
  assert.deepEqual(lendLines({ gpu: true }, now, { id: 1, name: 'S' }, 'm'), ['+ Switch GPU jobs on']);
  // An agent from before ticks saves only the switch, as the page's does for it.
  const old = { projects: [], lend: null, workspace_tools: true, always_on: false, managed: false };
  assert.deepEqual(lendPatch({ gpu: false }, old, 1), { lend: { server: null, workspaces: [], before_ticks: true, gpu_off: true } });
  assert.deepEqual(lendPatch({ gpu: true }, old, 1), {});
});

test("a minion's call posts a card with the change and what it lends after; bad calls are refused before anyone sees them", async () => {
  const r = await propose({ machine: 'box', here: true, tick: ['w'], why: 'Cantrips needs the w folder' });
  assert.equal(r.owner, 'Cara');
  assert.equal(r.page, `#/p/${project.id}/machines/box`);
  const c = await card(minion, r.id);
  assert.equal(c.summary, 'Lend box to Cantrips');
  assert.equal(c.status, 'pending');
  assert.deepEqual(c.machineLend.lines, ['+ Lend box to Cantrips', '+ Tick the w workspace']);
  assert.deepEqual(c.machineLend.after, { server: null, workspaces: ['w'] });
  assert.match(c.plan, /After this it lends: workspaces w\./);
  assert.match(c.plan, new RegExp(`\\[box on the Machines page\\]\\(#/p/${project.id}/machines/box\\)`));

  await assert.rejects(propose({ machine: 'nope' }), /404 No machine called nope; there are box$/);
  await assert.rejects(propose({ machine: 'josh-box', here: true }), /404 No machine called josh-box/, "someone else's own machine is out of sight, as everywhere (#306)");
  await assert.rejects(propose({ machine: 'box', tick: ['zz'] }), /400 box has no workspace called zz; it has w, x/);
  await assert.rejects(propose({ machine: 'box', server: 'zz' }), /400 box has no MCP server called zz; it found own/);
  await assert.rejects(propose({ machine: 'box', tick: ['w'], untick: ['w'] }), /400 A workspace is in both tick and untick/);
  await assert.rejects(propose({ machine: 'box', here: false, untick: ['x'] }), /400 Nothing to change/);
  await assert.rejects(call('Josh', `/api/tickets/${minion.id}/machine-lend`, { method: 'POST', body: { machine: 'box', here: true } }), /403/);
  assert.equal((await boxNow()).projects.length, 0, 'a proposal changes nothing by itself');
});

test('only its owner or an admin approves: Approve saves it as the page would, and the agent is told', async () => {
  const [c] = (await events(minion)).filter((e) => e.status === 'pending');
  await assert.rejects(verdict('Dana', minion, c.id, 'approve'), /403 Only Cara, who owns box, or an admin can change what it lends/);
  await assert.rejects(verdict(`agent:${minion.id}`, minion, c.id, 'approve'), /403/);
  assert.equal((await card(minion, c.id)).status, 'pending');
  await verdict('Cara', minion, c.id, 'approve');
  const m = await boxNow();
  assert.deepEqual(m.projects, [project.id]);
  assert.deepEqual(m.lend, { server: null, workspaces: ['w'] });
  await until('the agent to hear of the tick', () => /Lent from the Machines page: workspaces w/.test(output()));
  assert.equal((await card(minion, c.id)).status, 'approved');
  assert.match(await lastMessage(minion), /^Approved: box's lending is saved as the card showed\. Its agent has it now/);
  await assert.rejects(verdict('Cara', minion, c.id, 'approve'), /409 Cara already approved this change/);
  await idle(minion);

  // Josh's own machine, from a minion he asked: he or an admin approves, nobody else.
  const theirs = await propose({ machine: 'josh-box', here: true }, joshs);
  assert.equal(theirs.owner, 'Josh');
  await assert.rejects(verdict('Dana', joshs, theirs.id, 'approve'), /403 Only Josh, who owns josh-box, or an admin can change what it lends/);
  await verdict('Josh', joshs, theirs.id, 'revise', 'Not now');
  assert.equal(await lastMessage(joshs), 'Rejected your proposed lending for josh-box; nothing changed.\n\nNot now');
  await idle(joshs);
  const again = await propose({ machine: 'josh-box', here: true }, joshs);
  await verdict('Josh', joshs, again.id, 'approve');
  assert.deepEqual((await call('Josh', '/api/machines')).find((m: { name: string }) => m.name === 'josh-box').projects, [project.id]);
  await idle(joshs);
});

test('the Taskmaster can ask too, and a newer proposal for the machine supersedes its open one', async () => {
  const first = await propose({ machine: 'box', tick: ['x'] }, taskmaster);
  const plan = await call(`agent:${taskmaster.id}`, `/api/tickets/${taskmaster.id}/plans`, { method: 'POST', body: { summary: 'A plan', plan: 'Steps' } });
  const was = (await boxNow()).always_on;
  const second = await propose({ machine: 'box', always_on: !was }, taskmaster);
  assert.equal((await card(taskmaster, first.id)).status, 'superseded');
  assert.equal((await card(taskmaster, plan.id)).status, 'pending', 'a lending card leaves a plan alone');
  assert.equal((await card(taskmaster, second.id)).summary, 'Change what box lends');
  await assert.rejects(verdict('Cara', taskmaster, first.id, 'approve'), /409 A newer proposal for box's lending replaced this one/);
  await verdict('Cara', taskmaster, second.id, 'approve');
  assert.equal((await boxNow()).always_on, !was);
  await idle(taskmaster);
});

test('Approve applies the change to the machine as it is then, so a tick made on the page meanwhile stays', async () => {
  const r = await propose({ machine: 'box', tick: ['x'] });
  await call('Cara', `/api/machines/${box.id}`, { method: 'PATCH', body: { lend: { server: 'own', workspaces: ['w'] } } });
  await verdict('Cara', minion, r.id, 'approve');
  assert.deepEqual((await boxNow()).lend, { server: 'own', workspaces: ['w', 'x'] });
  await until('the agent to hear of both', () => /Lent from the Machines page: MCP server own and workspaces w, x/.test(output()));
  await idle(minion);
});

test("taking the scheme off ends its minions' open sessions, as the page does", async () => {
  const opened = await fetch(`${srv.base}/api/machines/${box.id}/session`, { headers: { Authorization: `Bearer ${agentToken(srv.data, minion.id)}` } });
  assert.equal(opened.status, 200);
  const stream = opened.body!.getReader();
  await stream.read(); // the session id
  const r = await propose({ machine: 'box', here: false });
  assert.equal((await card(minion, r.id)).summary, 'Take box from Cantrips');
  await verdict('Cara', minion, r.id, 'approve');
  for (let s = await stream.read(); !s.done; s = await stream.read());
  assert.deepEqual((await boxNow()).projects, []);
  // Approve starts a turn, and its launch mints the minion's next token some 50 ms after the verdict returns (#1808):
  // a token read before then is the turn before's by the time the server checks it, a 401 (#1886). So the turn ends first.
  await idle(minion);
  const again = await fetch(`${srv.base}/api/machines/${box.id}/session`, { headers: { Authorization: `Bearer ${agentToken(srv.data, minion.id)}` } });
  assert.equal(again.status, 403);
  await again.body!.cancel();
});

/** One JSON-RPC call through the real MCP server (src/mcp.ts) as an agent of this scheme. */
async function mcp(t: { id: number }, role: string, method: string, params: object) {
  return mcpOnce(agentEnv(srv.base, agentToken(srv.data, t.id), { id: t.id, project_id: project.id }, role, { COORDINATOR_MACHINES: '' }), method, params, tmp.track);
}

test('end to end: the tool call posts the card, its reply links it and the Machines page, and Approve saves it', async () => {
  for (const [t, role] of [
    [minion, 'thread'],
    [taskmaster, 'coordinator'],
  ] as const) {
    const tools = (await mcp(t, role, 'tools/list', {})).tools.map((x) => x.name);
    assert.ok(tools.includes('propose_machine_lend'), `${role} has it`);
  }
  const r = await mcp(taskmaster, 'coordinator', 'tools/call', { name: 'propose_machine_lend', arguments: { machine: 'box', here: true, why: 'for the test' } });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(r.content[0].text, new RegExp(`\\[the lending card below\\]\\(#/p/${project.id}\\?e=\\d+\\)`), "a Taskmaster's card is in its scheme's chat");
  assert.match(r.content[0].text, new RegExp(`\\[box on the Machines page\\]\\(#/p/${project.id}/machines/box\\)`));
  const [c] = (await events(taskmaster)).filter((e) => e.status === 'pending' && e.machineLend);
  assert.deepEqual(c.machineLend.lines, ['+ Lend box to Cantrips']);
  await verdict('Cara', taskmaster, c.id, 'approve');
  assert.deepEqual((await boxNow()).projects, [project.id]);
  assert.match(await lastMessage(taskmaster), /^Approved: box's lending is saved as the card showed/);
  await idle(taskmaster);
});
