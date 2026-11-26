// cabal_board end to end (#2090): through the real MCP server and the routes behind it. A member's note and asks, the
// lead's answers, rows, log and red line, and the delivery rule: a non-blocking ask is held mail to the lead, a blocking one
// wakes it (the server's claude is a fake that ends at once).
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { bootServer, type Booted, fakeClaude, PASSWORD, SECRET, stopTurns, tempRoot } from './helpers.ts';
import { agentEnv, mcpOnce } from './mcp-agent.ts';

const tmp = tempRoot('cabal-tool-');
const root = tmp.dir;
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(async () => {
  if (srv) await srv.stop();
  await stopTurns(root);
  await tmp.teardown();
});

const store = new Store(join(data, 'coordinator.db'));
const A = store.createProject('A', null);
const minion = (title: string) => store.createTicket({ project_id: A.id, kind: 'ticket', title, permission_mode: 'default', created_by: 'Josh' });
const LEAD = minion('Docs lead');
const M1 = minion('Sweep one');
const M2 = minion('Sweep two');
const OUTSIDER = minion('Not in it');
store.joinCabal(M1.id, LEAD.id, A.id, M1.title);
store.joinCabal(M2.id, LEAD.id, A.id, M2.title);

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude(root) } });
});

async function tool(from: number, args: object, cabal = true) {
  const env = agentEnv(srv.base, tokens.agentToken(from), { id: from, project_id: A.id }, 'thread', cabal ? { COORDINATOR_CABAL: '1' } : {});
  const result = await mcpOnce(env, 'tools/call', { name: 'cabal_board', arguments: args }, tmp.track);
  return { text: String(result.content[0].text), error: !!result.isError };
}
const userMessages = (id: number) =>
  store
    .listEvents(id)
    .filter((e) => e.kind === 'user_message')
    .map((e) => String(JSON.parse(e.data).text ?? ''));

test('only a turn flagged as in a cabal is offered cabal_board', async () => {
  // TMPDIR: tools/list keeps the list it served there (src/tool-hold.ts); the server's temp root is cleared with it.
  const env = agentEnv(srv.base, tokens.agentToken(OUTSIDER.id), { id: OUTSIDER.id, project_id: A.id }, 'thread', { TMPDIR: root });
  const list = await mcpOnce(env, 'tools/list', {}, tmp.track);
  assert.ok(!list.tools.some((t: { name: string }) => t.name === 'cabal_board'));
  const r = await tool(OUTSIDER.id, {});
  assert.match(r.text, /not on a cabal board/);
});

test("only a lead's turn is offered cabal_start and cabal_member (#2091)", async () => {
  const names = async (flag: string) => {
    const env = agentEnv(srv.base, tokens.agentToken(LEAD.id), { id: LEAD.id, project_id: A.id }, 'thread', { TMPDIR: root, COORDINATOR_CABAL: flag });
    return (await mcpOnce(env, 'tools/list', {}, tmp.track)).tools.map((t: { name: string }) => t.name) as string[];
  };
  const member = await names('1');
  assert.ok(member.includes('cabal_board') && !member.includes('cabal_start') && !member.includes('cabal_member'));
  const lead = await names('lead');
  assert.ok(['cabal_board', 'cabal_start', 'cabal_member'].every((n) => lead.includes(n)));
});

test('a member sets its note and files; a non-blocking ask is held mail to the lead', async () => {
  assert.match((await tool(M1.id, { action: 'note', note: 'built, in review', files: ['test/helpers.ts'] })).text, /Saved/);
  const r = await tool(M1.id, { action: 'ask', text: 'Which helper do you want?' });
  assert.match(r.text, /^Ask \d+ is on the board\. #\d+ reads it as held mail/, r.text);
  const read = await tool(M2.id, {});
  assert.match(read.text, /built, in review/);
  assert.match(read.text, /ask \d+ from Sweep one #\d+ .*Which helper/);
  assert.doesNotMatch(read.text, /BLOCKING/);
});

test("the lead edits rows, logs and sets the red line; a member can't", async () => {
  assert.match((await tool(LEAD.id, { action: 'row', label: 'Fix', title: 'Fixer', role: 'fixer' })).text, /Row \d+ saved/);
  assert.match((await tool(LEAD.id, { action: 'log', text: 'Josh, 21:20: "Lend it for one merge"' })).text, /Saved/);
  assert.match((await tool(LEAD.id, { action: 'red', text: 'Full run red on test/x.test.ts' })).text, /Saved/);
  const denied = await tool(M1.id, { action: 'log', text: 'mine' });
  assert.ok(denied.error);
  assert.match(denied.text, /Only the cabal's lead/);
  const read = (await tool(LEAD.id, {})).text;
  assert.match(read, /^RED \(.*\): Full run red/m);
  assert.match(read, /Fix roster Fixer \[fixer\] \| not started/);
  assert.match(read, /Lend it for one merge/);
});

test("people read the board by the lead's #N (the page) and from any member's chat (the panel)", async () => {
  const page = await srv.call(`/api/projects/${A.id}/cabal/${LEAD.number}`);
  assert.equal(page.status, 200);
  assert.equal(page.data.board.lead.id, LEAD.id);
  assert.deepEqual(
    page.data.board.members.map((m: { title: string }) => m.title),
    ['Sweep one', 'Sweep two', 'Fixer'],
  );
  assert.ok(page.data.board.red, 'the red line set above');
  assert.equal((await srv.call(`/api/projects/${A.id}/cabal/${M1.number}`)).status, 404, 'a member leads nothing');
  const chat = await srv.call(`/api/tickets/${M2.id}/cabal`);
  assert.equal(chat.data.lead, LEAD.id);
  assert.equal(chat.data.text, undefined, 'the text is only for cabal_board');
  assert.deepEqual((await srv.call(`/api/tickets/${OUTSIDER.id}/cabal`)).data, { lead: null, board: null });
});

test('create_ticket and update_ticket put a minion on a board; a refused field leaves it where it was; a lead is no row', async () => {
  const made = await srv.call(`/api/projects/${A.id}/tickets`, { title: 'Fixer', message: 'Fix the red run', cabal: LEAD.number, start_after: M2.number }); // sealed: no turn to wait out at teardown
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const id = made.data.id;
  assert.equal(store.cabalRowOf(id)?.lead_id, LEAD.id);
  assert.equal(store.cabalRowOf(id)?.role, 'fixer', "the lead's planned Fixer row became its row");
  assert.equal((await srv.call(`/api/projects/${A.id}/tickets`, { title: 'Nope', message: 'x', cabal: M1.number })).status, 400, 'a member leads nothing');
  assert.equal((await srv.call(`/api/tickets/${OUTSIDER.id}`, { cabal: LEAD.number, model: 'not-a-model' }, 'PATCH')).status, 400);
  assert.equal(store.cabalRowOf(OUTSIDER.id), undefined, 'the refused model kept it off');
  assert.equal((await srv.call(`/api/tickets/${OUTSIDER.id}`, { cabal: LEAD.number }, 'PATCH')).status, 200);
  assert.equal(store.cabalRowOf(OUTSIDER.id)?.lead_id, LEAD.id);
  assert.equal((await srv.call(`/api/tickets/${OUTSIDER.id}`, { cabal: null }, 'PATCH')).status, 200);
  assert.equal(store.cabalRowOf(OUTSIDER.id), undefined, 'off again: its row was made for it, so it goes');
  // Another lead can't be pulled onto this board as a row's minion.
  const other = minion('Other lead');
  store.ensureCabal(other.id, A.id);
  const r = await tool(LEAD.id, { action: 'row', title: 'Pulled', minion: other.number });
  assert.ok(r.error);
  assert.match(r.text, /leads a cabal/);
});

test("the lead's answer comes back the way it was asked: held mail for a plain ask, a wake for a blocking one", async () => {
  const plain = store.cabalAsks(LEAD.id).find((a) => !a.blocking)!;
  assert.match((await tool(LEAD.id, { action: 'answer', ask: plain.id, text: 'test/helpers.ts' })).text, /reads it as held mail/);
  assert.match((await tool(LEAD.id, { action: 'answer', ask: plain.id, text: 'again' })).text, /already answered/);
  // A blocking ask written straight to the board (asking it through the tool would wake the lead, and end this token).
  const blocked = store.addCabalAsk(LEAD.id, M1.id, 'I need src/b.ts to go on', true);
  assert.match((await tool(LEAD.id, { action: 'answer', ask: blocked, text: 'Take it' })).text, /#\d+ is woken for it now/);
  assert.ok(
    userMessages(M1.id).some((t) => t.includes('Take it')),
    "in the asker's chat as a message, not held",
  );
});

test('a blocking ask wakes the lead', async () => {
  const r = await tool(M2.id, { action: 'ask', text: 'I need src/a.ts to go on', blocking: true });
  assert.match(r.text, /is woken for it now/, r.text);
  assert.ok(
    userMessages(LEAD.id).some((t) => t.includes('I need src/a.ts')),
    "in the lead's chat as a message, not held",
  );
});
