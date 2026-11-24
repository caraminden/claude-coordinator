import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { GLOBAL_OWNER } from '../src/properties.ts';
import { systemPrompt } from '../src/prompts.ts';
import { bootServer, PASSWORD, REPO, SECRET, tempRoot, type Booted } from './helpers.ts';

// The Citadel-wide instructions (#148): one app-wide text with history, in every prompt right before
// the scheme's own, and edited only by people and the Citadel scheme's Taskmaster.
const tmp = tempRoot('app-instructions-');
const root = tmp.dir;
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
  await tmp.teardown();
});

const as = (id: number, method = 'GET', body?: object) =>
  fetch(srv.base + '/api/app/instructions', {
    method,
    headers: { Authorization: `Bearer ${tokens.agentToken(id)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

/** One tools/list or tools/call through the real MCP server, as `ticket`'s Taskmaster. */
async function mcp(ticket: { id: number; project_id: number }, method: string, params: object, appTools: boolean): Promise<any> {
  const child = tmp.spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: {
      ...process.env,
      COORDINATOR_API: srv.base,
      COORDINATOR_TOKEN: tokens.agentToken(ticket.id),
      COORDINATOR_PROJECT: String(ticket.project_id),
      COORDINATOR_TICKET: String(ticket.id),
      COORDINATOR_ROLE: 'coordinator',
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
  }
  const prompt = systemPrompt(delve, store.getTicket(DelveTM.id)!, null, null, root, null, [], false, 'Be kind.');
  const layer = prompt.indexOf('# Citadel-wide instructions');
  const scheme = prompt.indexOf('# Scheme instructions for "Delve"');
  assert.ok(layer < scheme && prompt.indexOf('Be kind.') < scheme, 'the layer comes before the scheme section');
  assert.ok(prompt.indexOf('Delve rule.') > scheme);
  assert.equal(prompt.indexOf('# Scheme instructions'), prompt.lastIndexOf('# Scheme instructions'));
});

test("only the Citadel scheme's Taskmaster prompt names set_app_instructions as its own", () => {
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

test("the Citadel scheme's Taskmaster reads and sets it; another scheme's Taskmaster and a minion are refused", async () => {
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

test("the MCP tools: listed only for the Citadel scheme's Taskmaster, and refused for another scheme's if called anyway", async () => {
  const names = async (t: typeof DelveTM, on: boolean) => (await mcp(t, 'tools/list', {}, on)).tools.map((x: any) => x.name);
  assert.ok((await names(CitadelTM, true)).includes('set_app_instructions'));
  assert.ok(!(await names(DelveTM, false)).includes('set_app_instructions'));
  assert.ok(!(await names(DelveTM, false)).includes('get_app_instructions'));

  const set = await mcp(CitadelTM, 'tools/call', { name: 'set_app_instructions', arguments: { instructions: 'Three rules.' } }, true);
  assert.ok(!set.isError, set.content[0].text);
  assert.match(set.content[0].text, /^Saved \(12 characters\)/);
  const got = await mcp(CitadelTM, 'tools/call', { name: 'get_app_instructions', arguments: {} }, true);
  assert.match(got.content[0].text, /Three rules\./);

  const refused = await mcp(DelveTM, 'tools/call', { name: 'set_app_instructions', arguments: { instructions: 'Mine now.' } }, false);
  assert.ok(refused.isError);
  assert.equal((await srv.call('/api/app/instructions')).data.text, 'Three rules.');
});

// #1211: the Taskmaster's own saves get the overlap check a person's Settings save gets (#1162), and are refused with
// the list unless it passes repeats_ok.
test('a Taskmaster save that repeats a registered rule is refused with the list, and saved with repeats_ok', async () => {
  const repeat = 'Three rules.\n\n## Wrapping up\n\nA minion stays open until nothing is left for a person, and never waits on an "are we good?" from anyone.';
  for (const [tool, read, appTools] of [
    ['set_app_instructions', () => store.appInstructions().text, true],
    ['set_project_instructions', () => store.getProject(Citadel.id)!.instructions, true],
  ] as const) {
    const before = read();
    const held = await mcp(CitadelTM, 'tools/call', { name: tool, arguments: { instructions: repeat } }, appTools);
    assert.ok(held.isError, `${tool}: ${held.content[0].text}`);
    assert.match(held.content[0].text, /Nothing was saved/);
    assert.match(held.content[0].text, /Registered rule: When a minion closes/);
    assert.match(held.content[0].text, /repeats_ok/);
    assert.equal(read(), before, `${tool} saved nothing`);

    assert.match(held.content[0].text, /Sonnet Grunt/, 'it says to have its own Grunt judge them');

    // repeats_ok saves past them only with its Grunt's verdicts (Josh, 2026-11-20: "Yes, its own Grunt").
    const bare = await mcp(CitadelTM, 'tools/call', { name: tool, arguments: { instructions: repeat, repeats_ok: true } }, appTools);
    assert.ok(bare.isError, `${tool}: ${bare.content[0].text}`);
    assert.match(bare.content[0].text, /repeats_ok needs your Grunt's verdict on each place as overlaps \(1 listed, 0 given\)/);
    assert.equal(read(), before, `${tool} saved nothing without verdicts`);

    const verdict = 'Registered rule: When a minion closes: repeats; the Closing rule already says this.';
    const saved = await mcp(CitadelTM, 'tools/call', { name: tool, arguments: { instructions: repeat, repeats_ok: true, overlaps: [verdict] } }, appTools);
    assert.ok(!saved.isError, saved.content[0].text);
    assert.equal(read(), repeat);
    assert.ok(saved.content[0].text.includes(verdict), 'the verdicts come back to tell the person');
  }
  // Another scheme's Taskmaster gets the same check on its own scheme's text.
  const delve = await mcp(DelveTM, 'tools/call', { name: 'set_project_instructions', arguments: { instructions: repeat } }, false);
  assert.ok(delve.isError, delve.content[0].text);
  assert.match(delve.content[0].text, /Registered rule: When a minion closes/);
  assert.equal(store.getProject(Delve.id)!.instructions, 'Delve rule.');
  // A save that repeats nothing goes straight through.
  const plain = await mcp(CitadelTM, 'tools/call', { name: 'set_app_instructions', arguments: { instructions: 'Three rules.\n\nLunch is at noon on Fridays for everyone in the building.' } }, true);
  assert.ok(!plain.isError, plain.content[0].text);
});
