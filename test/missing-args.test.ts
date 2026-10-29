import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { bootServer, PASSWORD, REPO, SECRET, type Booted } from './helpers.ts';

// #167: a missing or misnamed argument to a set_* / update_* tool must be refused with nothing
// changed. It used to clear the scheme instructions.
const root = mkdtempSync(join(tmpdir(), 'missing-args-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const store = new Store(join(data, 'coordinator.db'));
store.createProject('Delve', null);
const Citadel = store.createProject('Citadel', null); // the second scheme is the global one
const TM = store.createTicket({ project_id: Citadel.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
const Minion = store.createTicket({ project_id: Citadel.id, kind: 'ticket', title: 'Some work', permission_mode: 'default', created_by: 'Cara' });
store.setProjectInstructions(Citadel.id, 'Scheme rule.', 'Cara');
store.setAppInstructions('App rule.', 'Cara');

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});
after(() => srv?.proc.kill());

async function tool(ticket: { id: number }, role: 'coordinator' | 'thread', name: string, args: object): Promise<{ isError?: boolean; text: string }> {
  const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: {
      ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: tokens.agentToken(ticket.id),
      COORDINATOR_PROJECT: String(Citadel.id), COORDINATOR_TICKET: String(ticket.id), COORDINATOR_ROLE: role,
      COORDINATOR_APP_INSTRUCTIONS: '1',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const r = (await reply).result;
    return { isError: r.isError, text: r.content[0].text };
  } finally {
    child.kill();
  }
}

const refused = (r: { isError?: boolean; text: string }, re: RegExp) => {
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, re);
};

test('instruction tools refuse a missing, misnamed or non-string argument and change nothing', async () => {
  for (const [name, read] of [
    ['set_project_instructions', () => store.getProject(Citadel.id)!.instructions],
    ['set_app_instructions', () => store.appInstructions().text],
  ] as const) {
    const before = read();
    for (const args of [{}, { text: 'Oops.' }, { instructions: null }, { instructions: 5 }, { instructions: ['a'] }]) {
      refused(await tool(TM, 'coordinator', name, args), /instructions is required/);
      assert.equal(read(), before, `${name} ${JSON.stringify(args)} changed it`);
    }
  }
});

test('an explicit empty string still clears', async () => {
  const r = await tool(TM, 'coordinator', 'set_project_instructions', { instructions: '' });
  assert.ok(!r.isError, r.text);
  assert.equal(store.getProject(Citadel.id)!.instructions, '');
  assert.ok(!(await tool(TM, 'coordinator', 'set_app_instructions', { instructions: '' })).isError);
  assert.equal(store.appInstructions().text, '');
});

test('set_project_settings refuses nothing-to-set and a null list', async () => {
  refused(await tool(TM, 'coordinator', 'set_project_settings', {}), /Pass approval_rules/);
  const rules = store.getProject(Citadel.id)!.approval_rules;
  assert.equal((await tool(TM, 'coordinator', 'set_project_settings', { approval_rules: null })).isError, true);
  assert.equal(store.getProject(Citadel.id)!.approval_rules, rules);
});

test('set_properties refuses a missing or empty properties', async () => {
  for (const args of [{ ticket_id: Minion.number }, { ticket_id: Minion.number, properties: {} }, { ticket_id: Minion.number, properties: null }]) {
    refused(await tool(TM, 'coordinator', 'set_properties', args), /properties is required/);
  }
  const mine = await tool(Minion, 'thread', 'set_properties', {});
  refused(mine, /properties is required/);
});

test('update_ticket, set_thread_status and update_schedule refuse when given nothing to change', async () => {
  const title = store.getTicket(Minion.id)!.title;
  refused(await tool(TM, 'coordinator', 'update_ticket', { ticket_id: Minion.number }), /at least one of/);
  refused(await tool(TM, 'coordinator', 'update_ticket', { ticket_id: Minion.number, titel: 'Typo' }), /at least one of/);
  refused(await tool(Minion, 'thread', 'set_thread_status', { titel: 'Typo' }), /at least one of/);
  refused(await tool(TM, 'coordinator', 'update_schedule', { schedule_id: 1 }), /at least one of/);
  assert.equal(store.getTicket(Minion.id)!.title, title);
});
