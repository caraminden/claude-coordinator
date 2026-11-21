import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { systemPrompt } from '../src/prompts.ts';
import { bootServer, PASSWORD, REPO, SECRET, type Booted, tempRoot } from './helpers.ts';

// Personal instructions (#688): each person's own text for everywhere and per scheme, loaded last in the
// minions assigned to them and never in the Taskmaster's prompt, which reads them with a tool instead.
const tmp = tempRoot('personal-instructions-');
const root = tmp.dir;
const data = join(root, 'data');
mkdirSync(data, { recursive: true });

const store = new Store(join(data, 'coordinator.db'));
const Delve = store.createProject('Delve', null);
const Peek = store.createProject('Peek', null);
const Cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
const Josh = store.createUser({ name: 'Josh', login: 'josh' });
const minion = (p: number) => store.createTicket({ project_id: p, kind: 'ticket', title: 'Some work', permission_mode: 'default', created_by: 'Cara' });
const DelveTM = store.createTicket({ project_id: Delve.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
store.updateTicket(DelveTM.id, { person_id: Cara.id });

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});
after(async () => {
  await srv?.stop();
  await tmp.teardown();
});

test('each person and scope keeps its own text, every save a history row, and an unchanged save adds none', () => {
  store.setPersonalInstructions(Josh.id, null, 'Short replies.');
  store.setPersonalInstructions(Josh.id, Peek.id, 'Run the plan back first.');
  store.setPersonalInstructions(Josh.id, null, 'Short replies.\nNo emoji.');
  store.setPersonalInstructions(Josh.id, null, 'Short replies.\nNo emoji.');
  assert.equal(store.personalInstructions(Josh.id, null).text, 'Short replies.\nNo emoji.');
  assert.equal(store.personalInstructions(Josh.id, Peek.id).text, 'Run the plan back first.');
  assert.deepEqual(store.personalInstructions(Josh.id, Delve.id), { text: '', at: null });
  assert.deepEqual(store.personalInstructions(Cara.id, null), { text: '', at: null }, 'one person\'s text is not another\'s');
  assert.deepEqual(store.personalInstructionHistory(Josh.id, null, 5).map((r) => [r.old_text, r.new_text]),
    [['Short replies.', 'Short replies.\nNo emoji.'], ['', 'Short replies.']]);
});

test("a minion loads its owner's layer last, everywhere then the scheme's; the Taskmaster and an unowned minion never do", () => {
  const m = minion(Peek.id);
  assert.equal(store.personalLayer(m), null, 'no owner, no layer');
  store.props.set('minion', m.id, Peek.id, { assigned: 'josh' }, 'Cara');
  const layer = store.personalLayer(m)!;
  assert.deepEqual(layer, { name: 'Josh', everywhere: 'Short replies.\nNo emoji.', scheme: 'Run the plan back first.' });

  store.setProjectInstructions(Peek.id, 'Peek rule.', 'Cara');
  const prompt = systemPrompt(store.getProject(Peek.id)!, store.getTicket(m.id)!, null, null, root, null, [], false, 'App rule.', null, [], null, false, null, layer);
  const order = ['App rule.', 'Peek rule.', "# Josh's own instructions", 'No emoji.', 'Run the plan back first.'].map((s) => prompt.indexOf(s));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `layers in order: ${order}`);
  assert.match(prompt, /the tripwire;/, 'the list it can\'t change sits beside the text');
  assert.ok(prompt.trimEnd().endsWith('Run the plan back first.'), 'the personal layer is the last word');

  assert.equal(store.personalLayer(store.getTicket(DelveTM.id)!), null, 'never for the Taskmaster');
  store.props.set('minion', m.id, Peek.id, { assigned: 'Cara' }, 'Cara');
  assert.equal(store.personalLayer(m), null, 'a new owner with no text loads nothing from the next turn');
});

test('My instructions: GET and PUT your own text per scope, capped at 4,000 characters, with history', async () => {
  const put = (body: object) => srv.call(`/api/projects/${Delve.id}/my-instructions`, body, 'PUT');
  assert.equal((await put({ scope: 'everywhere', text: '  Be brief.\r\n  ' })).status, 200);
  const r = await put({ scope: 'scheme', text: 'Delve only.' });
  assert.equal(r.data.everywhere.text, 'Be brief.');
  assert.equal(r.data.scheme.text, 'Delve only.');
  assert.equal(r.data.max, 4000);
  assert.equal((await put({ scope: 'scheme', text: 'x'.repeat(4001) })).status, 400);
  assert.equal((await put({ scope: 'nowhere', text: 'x' })).status, 400);
  const got = await srv.call(`/api/projects/${Peek.id}/my-instructions`);
  assert.equal(got.data.everywhere.text, 'Be brief.');
  assert.equal(got.data.scheme.text, '', "another scheme's text is its own");
  const h = await srv.call(`/api/projects/${Delve.id}/my-instructions/history?scope=scheme`);
  assert.deepEqual(h.data.history.map((x: any) => [x.by, x.diff]), [['Cara', [{ op: '+', text: 'Delve only.' }]]]);
});

/** One tools/call through the real MCP server, as Delve's Taskmaster. */
async function mcpCall(name: string, args: object): Promise<any> {
  const child = tmp.spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: {
      ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: tokens.agentToken(DelveTM.id),
      COORDINATOR_PROJECT: String(Delve.id), COORDINATOR_TICKET: String(DelveTM.id), COORDINATOR_ROLE: 'coordinator',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    return (await reply).result;
  } finally {
    child.kill();
  }
}

test("the Taskmaster reads a person's text with read_person_instructions; a minion can't", async () => {
  const r = await mcpCall('read_person_instructions', { person: 'cara' });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(r.content[0].text, /Cara's instructions for everywhere:\n\nBe brief\./);
  assert.match(r.content[0].text, /for this scheme[^\n]*\n\nDelve only\./);
  assert.match((await mcpCall('read_person_instructions', { person: 'nobody' })).content[0].text, /No one called nobody/);

  const m = minion(Delve.id);
  const res = await fetch(`${srv.base}/api/projects/${Delve.id}/people/Cara/instructions`, { headers: { Authorization: `Bearer ${tokens.agentToken(m.id)}` } });
  assert.equal(res.status, 403);
});
