import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import type { Machine, Project, Ticket } from '../src/db.ts';
import { systemPrompt, turnContext, type TurnMachine } from '../src/prompts.ts';
import { isTurnNote } from '../src/codex.ts';
import { TRIPWIRE_BLOCKS } from '../src/tripwire-blocks.ts';
import { tempRoot } from './helpers.ts';
import { fake } from './typed.ts';

// How the app behaves (the chat, links, the tripwire) is the same in every scheme, so the built-in
// prompts say it; tools/deploy.sh, pending-deploy and previews only exist where the server runs the code.
const tmp = tempRoot('app-facts-');
after(() => tmp.teardown());
const project = fake<Project>({ id: 3, name: 'Delve', instructions: '', approval_rules: '' });
const minion = fake<Ticket>({ id: 5, number: 5, title: 'T', kind: 'ticket', branch: 'ticket/5-t' });
const taskmaster = fake<Ticket>({ ...minion, kind: 'coordinator' });

// A Taskmaster gets the tripwire in one line, not the list (Cara's pick on #760, 2026-11-15): it writes only in the shared folder.
test('minions get the tripwire blocks, Taskmasters the one-line tripwire', () => {
  assert.ok(systemPrompt(project, minion, null, null, '/tickets', null).includes(TRIPWIRE_BLOCKS));
  const tm = systemPrompt(project, taskmaster, null, null, '/tickets', null);
  assert.ok(!tm.includes(TRIPWIRE_BLOCKS));
  assert.match(tm, /tripwire/i);
});

test('deploy lines show only when the server runs the scheme', () => {
  const served = systemPrompt(project, minion, null, null, '/tickets', null, [], true);
  assert.match(served, /tools\/deploy\.sh/);
  assert.match(served, /pending-deploy/);
  const elsewhere = systemPrompt(project, minion, null, null, '/tickets', null);
  assert.doesNotMatch(elsewhere, /deploy\.sh|pending-deploy/);
});

type ToolDef = { name: string; description: string; inputSchema: { properties: Record<string, { enum: string[]; description: string }> } };
/** The thread MCP server's tools, with or without COORDINATOR_DEPLOYS. */
async function threadTools(deploys: boolean, more: Record<string, string> = {}): Promise<ToolDef[]> {
  const env: Record<string, string | undefined> = { ...process.env, MACHINES_URL: undefined, COORDINATOR_API: 'http://127.0.0.1:1', COORDINATOR_TOKEN: 'x', COORDINATOR_PROJECT: '3', COORDINATOR_ROLE: 'thread', COORDINATOR_TICKET: '5', COORDINATOR_DEPLOYS: deploys ? '1' : undefined, ...more };
  const mcp = tmp.spawn(process.execPath, [join(import.meta.dirname, '../src/mcp.ts')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    const reply = new Promise<{ result: { tools: ToolDef[] } }>((r) => createInterface({ input: mcp.stdout! }).once('line', (l) => r(JSON.parse(l))));
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
    return (await reply).result.tools;
  } finally {
    mcp.kill();
  }
}

test("a minion's MCP tools mention deploys and offer previews only when the server runs the scheme", async () => {
  for (const deploys of [true, false]) {
    const tools = await threadTools(deploys);
    const tool = (name: string) => tools.find((t) => t.name === name);
    assert.equal(!!tool('start_preview'), deploys);
    assert.equal(/deploy\.sh/.test(tool('close_self')!.description), deploys);
    const state = tool('set_thread_status')!.inputSchema.properties.state!;
    assert.equal(state.enum.includes('pending-deploy'), deploys);
    assert.equal(state.description.includes('pending-deploy'), deploys);
  }
});

test('a minion parked on start_after is told what it waits on, in its turn message (#878)', () => {
  const args: Parameters<typeof systemPrompt> = [project, minion, null, null, '/tickets', null, [], false, '', "#3 Leader's work is merged"];
  assert.ok(turnContext(...args).includes("#3 Leader's work is merged"));
  assert.ok(!systemPrompt(...args).includes("#3 Leader's work is merged"));
  assert.ok(!turnContext(project, minion, null, null, '/tickets', null).includes("#3 Leader's work is merged"));
});

test("a minion's system prompt is byte-identical when its title, state, note or properties change (#704)", () => {
  const render = (t: Ticket) => systemPrompt(project, t, '/shared/5', '/shared/project', '/tickets', '/memory', [], true, 'App rule.');
  const before = render(minion);
  const after = render({ ...minion, title: 'A completely new title', state: 'ready', note: 'waiting on a pick', replies: ['Merge it'], props: { type: 'bug', stage: 'review' } });
  assert.equal(after, before);
  assert.ok(!before.includes('"T"'));
});

// Lever A (#878): two minions of a scheme share one cached system prompt and one tool list, so nothing about the
// minion, its sender or what is online right now reaches system-prompt.md or the thread server's tools/list.
test('two minions of one scheme get a byte-identical system prompt and tool list; what differs is in their turn messages (#878)', async () => {
  const machine = fake<TurnMachine>({ id: 1, name: 'josh-box', notes: 'The GPU box.', owner_id: 2, servers: ['mcp', 'ws'] });
  const a: Parameters<typeof systemPrompt> = [project, { ...minion, number: 5, branch: 'ticket/5-t', build: 2 }, '/shared/5', '/shared/project', '/tickets', '/memory', [machine], true, 'App rule.', null, [], { build: 2, branch: 'build/2', owner: false }, true, null, null, true];
  const b: Parameters<typeof systemPrompt> = [project, { ...minion, id: 9, number: 9, branch: 'ticket/9-other', title: 'Other' }, '/shared/9', '/shared/project', '/tickets', '/memory', [], true, 'App rule.', null, [], null, true, null, null, false];
  assert.equal(systemPrompt(...a), systemPrompt(...b));
  for (const varies of ['#5', '#9', 'ticket/5-t', 'ticket/9-other', '/shared/5', '/shared/9', 'josh-box', 'The GPU box.', 'build/2', 'ci-failures']) assert.ok(!systemPrompt(...a).includes(varies), varies);
  const [ca, cb] = [turnContext(...a), turnContext(...b)];
  assert.ok(isTurnNote(`[System]: ${ca}`) && isTurnNote(`[System]: ${cb}`), 'a Codex hand-over knows them for turn notes');
  for (const has of ['#5', 'ticket/5-t', '/shared/5', 'josh-box', 'The GPU box.', 'feeder in Build 2', 'ci-failures']) assert.ok(ca.includes(has), has);
  for (const has of ['#9', 'ticket/9-other', '/shared/9', 'When you open a GitHub pull request']) assert.ok(cb.includes(has), has);
  assert.ok(!cb.includes('josh-box') && !cb.includes('Build 2'));
  // One sends with OpenRouter and a Codex login and has a machine online; the other has none of them.
  const toolsA = await threadTools(true, { COORDINATOR_MACHINES: 'josh-box', COORDINATOR_MEDIA: '1', COORDINATOR_CODEX_IMAGES: '1', COORDINATOR_TICKET: '5' });
  const toolsB = await threadTools(true, { COORDINATOR_TICKET: '9' });
  assert.equal(JSON.stringify(toolsA), JSON.stringify(toolsB));
});
