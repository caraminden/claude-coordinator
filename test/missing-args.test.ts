import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const store = new Store(join(data, 'coordinator.db'));
store.createProject('Delve', null);
const Citadel = store.createProject('Citadel', null); // the second scheme is the global one
const TM = store.createTicket({ project_id: Citadel.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
// On a turn an admin asked for, so set_app_instructions gets past #255's check to its own.
store.updateTicket(TM.id, { person_id: store.createUser({ name: 'Cara', login: 'cara', admin: true }).id });
const Minion = store.createTicket({ project_id: Citadel.id, kind: 'ticket', title: 'Some work', permission_mode: 'default', created_by: 'Cara' });
store.setProjectInstructions(Citadel.id, 'Scheme rule.', 'Cara');
store.setAppInstructions('App rule.', 'Cara');

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});
after(async () => {
  await srv?.stop(); // ends the server and its turns before the folder goes (#218)
  rmSync(root, { recursive: true, force: true });
});

async function tool(ticket: { id: number }, role: 'coordinator' | 'thread', name: string, args: object, env: Record<string, string> = {}): Promise<{ isError?: boolean; text: string }> {
  const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: {
      ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: tokens.agentToken(ticket.id),
      COORDINATOR_PROJECT: String(Citadel.id), COORDINATOR_TICKET: String(ticket.id), COORDINATOR_ROLE: role,
      COORDINATOR_APP_INSTRUCTIONS: '1', ...env,
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

test('explicit empties still go through: replies [], note null', async () => {
  assert.ok(!(await tool(Minion, 'thread', 'set_thread_status', { replies: [] })).isError);
  assert.ok(!(await tool(TM, 'coordinator', 'update_ticket', { ticket_id: Minion.number, note: null })).isError);
});

// #481: the wrong arguments models send most often are accepted, and every limit is in the schema.
async function listTools(role: 'coordinator' | 'thread', ticket: { id: number }): Promise<any[]> {
  const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: { ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: tokens.agentToken(ticket.id), COORDINATOR_PROJECT: String(Citadel.id), COORDINATOR_TICKET: String(ticket.id), COORDINATOR_ROLE: role, COORDINATOR_DEPLOYS: '1', COORDINATOR_APP_INSTRUCTIONS: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    return (await reply).result.tools;
  } finally {
    child.kill();
  }
}

const saw = (ticketId: number, text: string) => store.listEvents(ticketId).some((e) => e.data.includes(text));

test('"Message is required": message is accepted for text on the message tools', async () => {
  const sent = await tool(TM, 'coordinator', 'message_ticket', { ticket_id: Minion.number, message: 'Alias from the Taskmaster.' });
  assert.ok(!sent.isError, sent.text);
  assert.ok(saw(Minion.id, 'Alias from the Taskmaster.'));
  const up = await tool(Minion, 'thread', 'message_coordinator', { need: 'ask', message: 'Alias from the minion.' });
  assert.ok(!up.isError, up.text);
  assert.ok(saw(TM.id, 'Alias from the minion.'));
  // message_taskmaster gets past the text check to the scheme lookup.
  const across = await tool(TM, 'coordinator', 'message_taskmaster', { scheme: 'No such scheme', need: 'ask', message: 'Hi.' });
  assert.doesNotMatch(across.text, /Message is required/);
  refused(await tool(Minion, 'thread', 'message_coordinator', {}), /Message is required/);
});

test('state enum error: the string "null" is read as null', async () => {
  store.updateTicket(Minion.id, { state: 'parked', note: 'old note' });
  const r = await tool(Minion, 'thread', 'set_thread_status', { state: 'null', note: 'null' });
  assert.ok(!r.isError, r.text);
  const t = store.getTicket(Minion.id)!;
  assert.equal(t.state, null);
  assert.equal(t.note, null);
  refused(await tool(Minion, 'thread', 'set_thread_status', { state: 'done' }), /State must be one of/);
  // Only where null is allowed: a message that says "null" is still that text.
  assert.ok(!(await tool(Minion, 'thread', 'message_coordinator', { text: 'null', need: 'ask' })).isError);
});

test('"is too long": the limit is in the schema, and the error names it', async () => {
  const thread = await listTools('thread', Minion);
  const status = thread.find((t) => t.name === 'set_thread_status').inputSchema.properties;
  assert.equal(status.note.maxLength, 60);
  assert.equal(status.title.maxLength, 120);
  assert.equal(status.replies.items.maxLength, 40);
  const option = thread.find((t) => t.name === 'ask_question').inputSchema.properties.questions.items.properties.options.items.properties;
  assert.equal(option.description.maxLength, 300);
  assert.equal(option.label.maxLength, 80);
  // Every string the server caps carries its cap: none of these tools' text arguments is left without one.
  const coord = await listTools('coordinator', TM);
  for (const [list, name, field] of [
    [coord, 'message_ticket', 'text'], [coord, 'message_taskmaster', 'text'], [coord, 'create_ticket', 'message'],
    [thread, 'message_coordinator', 'text'], [thread, 'propose_plan', 'summary'], [thread, 'propose_plan', 'plan'],
    [thread, 'strike_text', 'text'], [thread, 'strike_text', 'reason'], [coord, 'set_project_instructions', 'instructions'],
  ] as const) {
    const p = (list as any[]).find((t) => t.name === name).inputSchema.properties[field];
    assert.ok(p.maxLength > 0, `${name}.${field} has no maxLength`);
  }
  refused(await tool(Minion, 'thread', 'set_thread_status', { note: 'x'.repeat(61) }), /Note is too long: 61 characters, at most 60/);
});

test('"needs a recommended option": a recommendation written into the label or description counts', async () => {
  const card = (options: object[]) => tool(Minion, 'thread', 'ask_question', { questions: [{ question: 'Which?', options }] });
  for (const options of [
    [{ label: 'Stitched (rec.)', description: 'Free.' }, { label: 'Written', description: 'Costs.' }],
    [{ label: 'Exe', description: 'Recommended. Built here.' }, { label: 'CI', description: 'Slower.' }],
    [{ label: 'Exe', recommended: 'true' }, { label: 'CI' }],
  ]) {
    const r = await card(options);
    assert.ok(!r.isError, `${JSON.stringify(options)}: ${r.text}`);
  }
  const q = JSON.parse(store.listEvents(Minion.id).filter((e) => e.kind === 'question').at(-2)!.data);
  assert.deepEqual(q.questions[0].options[0], { label: 'Exe', description: 'Built here.', recommended: true });
  // An explicit flag wins over the words; with neither, it is still refused.
  refused(await card([{ label: 'A' }, { label: 'B', description: 'Recommended for big ones' }]), /needs a recommended option/);
});

test('a brief naming a shared file that does not exist yet is refused; one asking for it to be written passes', async () => {
  const shared = join(root, 'shared', 'project');
  mkdirSync(join(shared, 'handoffs'), { recursive: true });
  writeFileSync(join(shared, 'handoffs', 'there.md'), '# Here\n');
  const env = { COORDINATOR_SHARED_DIR: shared };
  const missing = join(shared, 'handoffs', 'not-yet.md');
  const count = () => store.listTickets(Citadel.id).length;
  const before = count();
  const r = await tool(TM, 'coordinator', 'create_ticket', { title: 'Brief', properties: { type: 'chore' }, model: 'claude-sonnet-5-5', effort: 'medium', message: `Read ${missing} first; it is your whole brief.` }, env);
  refused(r, new RegExp(`${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} does not exist yet\\. Start this minion once it is written, or drop the path`));
  assert.equal(count(), before, 'no minion was made');
  refused(await tool(TM, 'coordinator', 'message_ticket', { ticket_id: Minion.number, text: `See \`${missing}\`.` }, env), /does not exist yet\. Send this once it is written/);
  // Present, or asked for: it goes through.
  const ok = await tool(TM, 'coordinator', 'create_ticket', { title: 'Brief two', properties: { type: 'chore' }, model: 'claude-sonnet-5-5', effort: 'medium', message: `Read ${join(shared, 'handoffs', 'there.md')}. When done, write your report to ${missing}.` }, env);
  assert.ok(!ok.isError, ok.text);
  assert.ok(!(await tool(TM, 'coordinator', 'message_ticket', { ticket_id: Minion.number, text: `Create ${missing} with the plan.` }, env)).isError);
});
