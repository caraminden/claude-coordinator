import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { GLOBAL_OWNER } from '../src/properties.ts';
import { systemPrompt } from '../src/prompts.ts';
import { bootServer, PASSWORD, REPO, SECRET, type Booted } from './helpers.ts';

// The Citadel-wide instructions (#148): one app-wide text with history, in every prompt right before
// the scheme's own, and edited only by people and the Citadel scheme's Taskmaster.
const root = mkdtempSync(join(tmpdir(), 'app-instructions-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });

const store = new Store(join(data, 'coordinator.db'));
const Delve = store.createProject('Delve', null);
const Citadel = store.createProject('Citadel', null);
assert.equal(Citadel.id, GLOBAL_OWNER, 'the second scheme stands in for Citadel');
const Cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
// Turns an admin asked for (#255: a turn anyone else asked for is refused, test/turn-asker.test.ts).
const taskmaster = (p: number) => {
  const t = store.createTicket({ project_id: p, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(t.id, { person_id: Cara.id });
  return t;
};
const DelveTM = taskmaster(Delve.id);
const CitadelTM = taskmaster(Citadel.id);
const Minion = store.createTicket({ project_id: Citadel.id, kind: 'ticket', title: 'Some work', permission_mode: 'default', created_by: 'Cara' });
store.setProjectInstructions(Delve.id, 'Delve rule.', 'Cara');

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});
after(async () => {
  await srv?.stop(); // ends the server and its turns before the folder goes (#218)
  rmSync(root, { recursive: true, force: true });
});

const as = (id: number, method = 'GET', body?: object) =>
  fetch(srv.base + '/api/app/instructions', {
    method,
    headers: { Authorization: `Bearer ${tokens.agentToken(id)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

/** One tools/list or tools/call through the real MCP server, as `ticket`'s Taskmaster. */
async function mcp(ticket: { id: number; project_id: number }, method: string, params: object, appTools: boolean): Promise<any> {
  const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: {
      ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: tokens.agentToken(ticket.id),
      COORDINATOR_PROJECT: String(ticket.project_id), COORDINATOR_TICKET: String(ticket.id), COORDINATOR_ROLE: 'coordinator',
      COORDINATOR_APP_INSTRUCTIONS: appTools ? '1' : undefined,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
    return (await reply).result;
  } finally {
    child.kill();
  }
}

test('empty text adds no section; set, it comes right before the scheme instructions with the conflict rule', () => {
  const minion = store.getTicket(Minion.id)!;
  const delve = store.getProject(Delve.id)!;
  for (const t of [minion, store.getTicket(DelveTM.id)!]) {
    const p = store.getProject(t.project_id)!;
    assert.doesNotMatch(systemPrompt(p, t, null, null, root, null), /# Citadel-wide instructions/);
    assert.doesNotMatch(systemPrompt(p, t, null, null, root, null, [], false, '  \n'), /# Citadel-wide instructions/);
  }

  for (const t of [minion, store.getTicket(DelveTM.id)!]) {
    const p = store.getProject(t.project_id)!;
    const prompt = systemPrompt(p, t, null, null, root, null, [], false, 'Be kind.');
    const layer = prompt.indexOf('# Citadel-wide instructions');
    assert.ok(layer > 0, 'the section is there');
    assert.ok(prompt.indexOf('Be kind.') > layer);
    assert.match(prompt.slice(layer), /the scheme instruction wins only if it names the Citadel-wide rule it replaces/);
  }
  const prompt = systemPrompt(delve, store.getTicket(DelveTM.id)!, null, null, root, null, [], false, 'Be kind.');
  const layer = prompt.indexOf('# Citadel-wide instructions');
  const scheme = prompt.indexOf('# Scheme instructions for "Delve"');
  assert.ok(layer < scheme && prompt.indexOf('Be kind.') < scheme, 'the layer comes before the scheme section');
  assert.ok(prompt.indexOf('Delve rule.') > scheme);
  assert.equal(prompt.indexOf('# Scheme instructions'), prompt.lastIndexOf('# Scheme instructions'));
});

test('only the Citadel scheme\'s Taskmaster prompt names set_app_instructions as its own', () => {
  const own = systemPrompt(store.getProject(Citadel.id)!, store.getTicket(CitadelTM.id)!, null, null, root, null);
  const other = systemPrompt(store.getProject(Delve.id)!, store.getTicket(DelveTM.id)!, null, null, root, null);
  assert.match(own, /set_app_instructions/);
  assert.doesNotMatch(other, /set_app_instructions/);
  assert.match(other, /message_taskmaster/);
});

test('people save it with a history row; the store keeps who and when', async () => {
  assert.deepEqual((await srv.call('/api/app/instructions')).data, { text: '', by: null, at: null });
  const saved = await srv.call('/api/app/instructions', { text: 'One rule.\r\n' }, 'PUT');
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.text, 'One rule.');
  assert.equal(saved.data.by, 'Cara');
  assert.equal((await srv.call('/api/app/instructions', { text: 'x'.repeat(32_001) }, 'PUT')).status, 400);
  assert.equal((await srv.call('/api/app/instructions', { text: 5 }, 'PUT')).status, 400);
  const { history } = (await srv.call('/api/app/instructions/history')).data;
  assert.equal(history.length, 1);
  assert.equal(history[0].by, 'Cara');
  assert.deepEqual(history[0].diff, [{ op: '+', text: 'One rule.' }]);
});

test('the Citadel scheme\'s Taskmaster reads and sets it; another scheme\'s Taskmaster and a minion are refused', async () => {
  assert.equal((await as(CitadelTM.id, 'PUT', { text: 'Two rules.' })).status, 200);
  assert.equal((await (await as(CitadelTM.id)).json()).text, 'Two rules.');

  for (const method of ['GET', 'PUT']) {
    const r = await as(DelveTM.id, method, method === 'PUT' ? { text: 'Mine now.' } : undefined);
    assert.equal(r.status, 403, `${method} by Delve's Taskmaster`);
    assert.match((await r.json()).error, /message_taskmaster/);
    assert.equal((await as(Minion.id, method, method === 'PUT' ? { text: 'Mine now.' } : undefined)).status, 403, `${method} by a minion`);
  }
  assert.equal((await srv.call('/api/app/instructions')).data.text, 'Two rules.');
});

test('the MCP tools: listed only for the Citadel scheme\'s Taskmaster, and refused for another scheme\'s if called anyway', async () => {
  const names = async (t: typeof DelveTM, on: boolean) => (await mcp(t, 'tools/list', {}, on)).tools.map((x: any) => x.name);
  assert.ok((await names(CitadelTM, true)).includes('set_app_instructions'));
  assert.ok(!(await names(DelveTM, false)).includes('set_app_instructions'));
  assert.ok(!(await names(DelveTM, false)).includes('get_app_instructions'));

  const set = await mcp(CitadelTM, 'tools/call', { name: 'set_app_instructions', arguments: { instructions: 'Three rules.' } }, true);
  assert.ok(!set.isError, set.content[0].text);
  assert.equal(set.content[0].text, 'Saved (12 characters). These instructions are about 3 tokens; each 1k costs about $22 a week across minions.');
  const got = await mcp(CitadelTM, 'tools/call', { name: 'get_app_instructions', arguments: {} }, true);
  assert.match(got.content[0].text, /Three rules\./);

  const refused = await mcp(DelveTM, 'tools/call', { name: 'set_app_instructions', arguments: { instructions: 'Mine now.' } }, false);
  assert.ok(refused.isError);
  assert.equal((await srv.call('/api/app/instructions')).data.text, 'Three rules.');
});
