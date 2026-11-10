import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { APPROVAL_TOOL, Approvals, cleanPluginDirs, cleanPluginPicks, cleanRules, permissionArgs, pluginDirArgs, turnPluginDirs, unsettledCards } from '../src/approvals.ts';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { stopTurns, testPins } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'approvals-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- rules and plugin folders ----------

test('approval rules: one per line, validated, deduplicated', () => {
  assert.equal(cleanRules('Bash(gh pr merge:*)\r\n\n  mcp__*__merge_pull_request  \nBash(gh pr merge:*)'), 'Bash(gh pr merge:*)\nmcp__*__merge_pull_request');
  assert.equal(cleanRules(['Bash(git push:*)', 'WebFetch']), 'Bash(git push:*)\nWebFetch');
  assert.equal(cleanRules(''), '');
  assert.throws(() => cleanRules('rm -rf /'), /not a Claude Code permission rule/);
  assert.throws(() => cleanRules('Bash(gh pr merge'), /not a Claude Code permission rule/);
  assert.throws(() => cleanRules(42), /list of text lines/);
});

test('plugin folders are relative to the repo root, or absolute', () => {
  assert.equal(cleanPluginDirs('./tools/mods/delve/\nplugins\n/opt/kit/'), 'tools/mods/delve\nplugins\n/opt/kit');
  for (const bad of ['~/x', '../up', 'a/../../b', 'a//b', '/opt/../etc', '//x']) assert.throws(() => cleanPluginDirs(bad), /relative to the repo root/, bad);
});

test('a Taskmaster denies prompts; a minion asks the approval tool', () => {
  assert.deepEqual(permissionArgs(false), ['--permission-prompts', 'none']);
  const args = permissionArgs(true);
  assert.deepEqual(args, ['--permission-prompts', 'host', '--permission-prompt-tool', APPROVAL_TOOL]);
  assert.ok(!args.includes('none'));
});

test('--plugin-dir only for folders that exist, in the worktree or at their absolute path', () => {
  const wt = join(root, 'wt');
  const outside = join(root, 'outside-kit');
  mkdirSync(join(wt, 'tools/mods/delve'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(wt, 'file'), '');
  assert.deepEqual(pluginDirArgs(['tools/mods/delve', 'missing', 'file', outside, join(root, 'gone')], wt), ['--plugin-dir', join(wt, 'tools/mods/delve'), '--plugin-dir', outside]);
  assert.deepEqual(pluginDirArgs([], wt), []);
});

test("a minion's plugin picks (#361) come only from its scheme's optional folders", () => {
  const optional = 'tools/plugins/devtools\ntools/plugins/lsp';
  assert.equal(cleanPluginPicks(['tools/plugins/devtools/', './tools/plugins/lsp'], optional), 'tools/plugins/devtools\ntools/plugins/lsp', 'normalised like the scheme lists');
  assert.equal(cleanPluginPicks(null, optional), '');
  assert.equal(cleanPluginPicks([], optional), '');
  assert.equal(cleanPluginPicks('', optional), '');
  assert.throws(() => cleanPluginPicks(['/home'], optional), /not one of this scheme's optional plugin folders/);
  assert.throws(() => cleanPluginPicks(['tools/plugins/devtools'], ''), /no optional plugin folders/);
  assert.throws(() => cleanPluginPicks([3], optional), /list of text lines/);
});

test("a turn loads the scheme's folders, then its minion's picks that are still optional; a Taskmaster neither", () => {
  const project = { plugin_dirs: 'tools/mods/delve', optional_plugin_dirs: 'tools/plugins/devtools\ntools/mods/delve' };
  const minion = (plugin_dirs: string) => ({ kind: 'ticket', plugin_dirs });
  assert.deepEqual(turnPluginDirs(project, minion('')), ['tools/mods/delve']);
  assert.deepEqual(turnPluginDirs(project, minion('tools/plugins/devtools\ntools/mods/delve')), ['tools/mods/delve', 'tools/plugins/devtools'], 'once each');
  // An admin took it off the optional list: the stored pick stays but no longer loads.
  assert.deepEqual(turnPluginDirs({ plugin_dirs: '', optional_plugin_dirs: '' }, minion('tools/plugins/devtools')), []);
  assert.deepEqual(turnPluginDirs(project, { kind: 'coordinator', plugin_dirs: 'tools/plugins/devtools' }), []);
});

// ---------- cards ----------

test('a card is settled once, by a person, and an unknown one counts as expired', async () => {
  const events: any[] = [];
  const a = new Approvals((ticketId, kind, data) => events.push({ ticketId, kind, data }));
  const id = a.request(1, 'Bash', { command: 'gh pr merge 3' });
  assert.equal(a.waiting(1), 1);
  assert.deepEqual(events[0], { ticketId: 1, kind: 'approval', data: { id, tool: 'Bash', input: { command: 'gh pr merge 3' } } });
  const waiting = a.wait(1, id, 10_000);
  assert.deepEqual(a.decide(2, id, true, 'Josh'), { state: 'expired', reason: 'This request is no longer waiting.' }, 'another thread cannot settle it');
  assert.deepEqual(a.decide(1, id, true, 'Cara'), { state: 'allowed', by: 'Cara' });
  assert.deepEqual(await waiting, { state: 'allowed', by: 'Cara' });
  assert.deepEqual(a.decide(1, id, false, 'Josh'), { state: 'allowed', by: 'Cara' }, 'a second click changes nothing');
  assert.equal(a.waiting(1), 0);
  assert.equal(a.get(1, 'nope').state, 'expired');
});

test('the end of a turn expires what still waits', async () => {
  const events: any[] = [];
  const a = new Approvals((_t, kind, data) => events.push({ kind, data }));
  const id = a.request(1, 'Bash', {});
  const waiting = a.wait(1, id, 10_000);
  a.endTurn(1, 'The turn was stopped while this waited.');
  assert.equal((await waiting).state, 'expired');
  assert.equal(a.decide(1, id, true, 'Cara').state, 'expired');
  assert.deepEqual(events.at(-1), { kind: 'approval_result', data: { id, state: 'expired', reason: 'The turn was stopped while this waited.' } });
  assert.deepEqual(unsettledCards([{ kind: 'approval', data: '{"id":"a"}' }, { kind: 'approval', data: '{"id":"b"}' }, { kind: 'approval_result', data: '{"id":"a"}' }]), ['b']);
});

test('a merge card carries the PR it names; a refused call posts nothing', () => {
  const posted: any[] = [];
  const a = new Approvals((_t, kind, data) => kind === 'approval' && posted.push(data));
  const cfg = { home: '/home/u', data: '/home/u/data', checkout: '/home/u/app', project: 1, claudeConfig: '/home/u/.claude', deployScript: true };
  const merge = { target: '192', method: 'squash', pr: { number: 192, title: 'Port the guard' } };
  assert.ok('id' in a.ask(1, 'Bash', { command: 'gh pr merge 192 --squash' }, '/w', cfg, true, merge));
  assert.deepEqual(posted[0].merge, merge);
  assert.ok('refused' in a.ask(2, 'Bash', { command: 'gh pr merge 192 --squash' }, '/w', cfg, false, merge));
  assert.equal(posted.length, 1);
});

// ---------- the round trip through the thread's MCP server ----------

// A stand-in for the app's two approval routes, backed by a real Approvals.
const TICKET = 7;
const TRIPWIRE_CFG = { home: '/home/u', data: '/home/u/data', checkout: '/home/u/app', project: 1, claudeConfig: '/home/u/.claude', deployScript: true };
const posted: any[] = [];
const cards = new Approvals((_t, kind, data) => kind === 'approval' && posted.push(data));
const api = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const url = new URL(req.url!, 'http://x');
  const send = (status: number, data: object) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  if (url.pathname !== `/api/tickets/${TICKET}/approvals`) return send(404, { error: 'Not found' });
  if (req.method === 'POST') {
    // As server.ts does it, in a project with approval rules.
    const { tool_name, input } = JSON.parse(body);
    const r = cards.ask(TICKET, tool_name, input, '/w', TRIPWIRE_CFG, true);
    return send('id' in r ? 201 : 200, r);
  }
  send(200, await cards.wait(TICKET, url.searchParams.get('id')!, 200));
});
// No top-level await: tests registered after one would run after the file's cleanup.
const listening = new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
after(() => api.close());

async function mcpServer(approvals: boolean) {
  await listening;
  const proc = spawn(process.execPath, [join(import.meta.dirname, '../src/mcp.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined,
      COORDINATOR_API: `http://127.0.0.1:${(api.address() as any).port}`,
      COORDINATOR_TOKEN: `${TICKET}.sig`,
      COORDINATOR_PROJECT: '1',
      COORDINATOR_ROLE: 'thread',
      COORDINATOR_TICKET: String(TICKET),
      COORDINATOR_APPROVALS: approvals ? '1' : undefined, // a minion running the tests has it set
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  after(() => proc.kill());
  const replies = new Map<number, (r: any) => void>();
  createInterface({ input: proc.stdout! }).on('line', (l) => {
    const r = JSON.parse(l);
    replies.get(r.id)?.(r);
  });
  let rid = 0;
  return (method: string, params: object): Promise<any> => {
    const id = ++rid;
    proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((r) => replies.set(id, (m) => r(m.result)));
  };
}
let server: ReturnType<typeof mcpServer> | null = null;
const rpc = async (method: string, params: object) => (await (server ??= mcpServer(true)))(method, params);
/** Ask the approval tool the way Claude Code does, and read its answer. */
const ask = (input: object) =>
  rpc('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input, tool_use_id: 'toolu_1' } }).then((r) => JSON.parse(r.content[0].text));
async function nextCard() {
  while (!posted.length) await wait(10);
  return posted.shift();
}

test('the approve tool is offered only to threads in projects with rules', async () => {
  assert.ok((await rpc('tools/list', {})).tools.some((t: any) => t.name === 'approve'));
  assert.ok(!(await (await mcpServer(false))('tools/list', {})).tools.some((t: any) => t.name === 'approve'));
});

test('Approve answers allow with the input unchanged, after several waits', async () => {
  const input = { command: 'gh pr merge 12 --squash', description: 'Merge the PR' };
  const answer = ask(input);
  const card = await nextCard();
  assert.deepEqual(card.input, input);
  await wait(500); // longer than one wait on the stand-in API
  cards.decide(TICKET, card.id, true, 'Cara');
  assert.deepEqual(await answer, { behavior: 'allow', updatedInput: input });
});

test('Deny answers deny with who denied it', async () => {
  const answer = ask({ command: 'gh pr merge 13' });
  cards.decide(TICKET, (await nextCard()).id, false, 'Josh');
  const result = await answer;
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /^Josh denied this/);
});

test('a tripwire ask: a card with its reason, Approve allows exactly that call, a second at once is refused', async () => {
  const input = { command: 'rm /home/u/data/coordinator.db.bak-1', description: 'Delete the DB copy Cara approved' };
  const answer = ask(input);
  const card = await nextCard();
  assert.deepEqual(card.input, input);
  assert.match(card.tripwire.reason, /live data dir/);
  const second = await ask({ command: 'systemctl --user enable x.timer', description: 'Enable the backup timer from deploy/' });
  assert.equal(second.behavior, 'deny');
  assert.match(second.message, /already waiting/);
  assert.equal(posted.length, 0, 'no second card');
  cards.decide(TICKET, card.id, true, 'Cara');
  assert.deepEqual(await answer, { behavior: 'allow', updatedInput: input });
});

test('a denied tripwire card denies, and the turn gets no more of them', async () => {
  const answer = ask({ command: 'systemctl --user enable x.timer', description: 'Enable the backup timer from deploy/' });
  cards.decide(TICKET, (await nextCard()).id, false, 'Cara');
  const result = await answer;
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /^Cara denied this.*hand the commands/);
  assert.match((await ask({ command: 'rm /home/u/data/x', description: 'Delete the stale copy from #54' })).message, /stop, and hand the commands to a person/);
  cards.endTurn(TICKET, 'The turn ended while this waited.');
});

test('an expired card denies', async () => {
  const answer = ask({ command: 'gh pr merge 14' });
  await nextCard();
  cards.endTurn(TICKET, 'The turn was stopped while this waited.');
  const result = await answer;
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /Nobody approved this.*stopped/);
});

test('a card whose turn ended keeps its outcome for an asker that was between two polls', async () => {
  const id = cards.request(TICKET, 'Bash', { command: 'gh pr merge 15' });
  posted.pop();
  cards.endTurn(TICKET, 'The turn was stopped while this waited.');
  assert.deepEqual(await cards.wait(TICKET, id, 10), { state: 'expired', reason: 'The turn was stopped while this waited.' });
  assert.equal(cards.get(TICKET + 1, id).reason, 'This request is no longer waiting.', "another minion's id tells it nothing");
});

// ---------- turns ----------

// A stand-in for `claude -p` that records its arguments and some of its environment, then waits
// for a release file before ending the turn.
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { existsSync, writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(join(root, 'argv'))}, JSON.stringify({ args: process.argv.slice(2), timeout: process.env.MCP_TOOL_TIMEOUT ?? null, approvals: process.env.COORDINATOR_APPROVALS ?? null }));
process.stdin.resume();
const wait = setInterval(() => {
  if (!existsSync(${JSON.stringify(join(root, 'release'))})) return;
  clearInterval(wait);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const store = new Store(join(root, 'test.db'));
const runner = new Runner(store, () => {}, () => ({}), fake);

async function turn(projectId: number, mkdirs: string[] = [], picks = '') {
  const t = store.createTicket({ project_id: projectId, title: 'T', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  if (picks) store.updateTicket(t.id, { plugin_dirs: picks });
  const cwd = join(root, `ticket-${t.id}`);
  for (const d of mkdirs) mkdirSync(join(cwd, d), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  rmSync(join(root, 'argv'), { force: true });
  runner.send(t.id, 'Cara', 'go');
  while (!existsSync(join(root, 'argv'))) await wait(20);
  await wait(50);
  return { id: t.id, cwd, ...JSON.parse(readFileSync(join(root, 'argv'), 'utf8')) };
}
async function finish(id: number) {
  writeFileSync(join(root, 'release'), '');
  while (runner.isRunning(id)) await wait(20);
  rmSync(join(root, 'release'), { force: true });
}

test('a project without rules or plugins still sends a minion\'s prompts to cards, for the tripwire', async () => {
  const plain = store.createProject('Plain', null);
  const t = await turn(plain.id, ['tools/mods/delve']);
  assert.ok(!t.args.includes('none'));
  assert.equal(t.args[t.args.indexOf('--permission-prompt-tool') + 1], APPROVAL_TOOL);
  // Only the kit, no folder of the scheme's, and the kit is the turn's own copy, there while it runs.
  const plugins = t.args.filter((_: string, i: number) => t.args[i - 1] === '--plugin-dir');
  assert.equal(plugins.length, 1);
  assert.ok(plugins[0].endsWith('/pin/kit') && existsSync(join(plugins[0], '.claude-plugin', 'plugin.json')), plugins[0]);
  // Every turn gets the tripwire hook, here able to ask, the claude.ai opt-outs (#138), the shared
  // settings and the merge asks; no rules of the scheme's.
  const settings = JSON.parse(readFileSync(t.args[t.args.indexOf('--settings') + 1], 'utf8'));
  assert.deepEqual(Object.keys(settings), ['hooks', 'syncClaudeAiSkills', 'disableClaudeAiConnectors', 'autoCompactWindow', 'bashOutputMaxChars', 'permissions']);
  assert.deepEqual(settings.permissions.ask, ['mcp__*__merge_pull_request', 'mcp__*__enable_pr_auto_merge']);
  assert.ok(settings.permissions.deny.includes(`Read(/${join(homedir(), '.ssh/**')})`), 'the logins stay out of reach (#185)');
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /"ask":true/);
  assert.ok(Number(t.timeout) >= 24 * 3600_000);
  assert.equal(t.approvals, '1');
  await finish(t.id);
});

test("a minion's picked plugin folders reach its turn after the scheme's (#361)", async () => {
  const ui = store.createProject('UI', null);
  store.setProjectSettings(ui.id, { plugin_dirs: 'tools/mods/ui', optional_plugin_dirs: 'tools/plugins/devtools\ntools/plugins/lsp' });
  const t = await turn(ui.id, ['tools/mods/ui', 'tools/plugins/devtools', 'tools/plugins/lsp'], 'tools/plugins/devtools');
  const plugins = t.args.filter((_: string, i: number) => t.args[i - 1] === '--plugin-dir');
  assert.deepEqual(plugins.slice(1), [join(t.cwd, 'tools/mods/ui'), join(t.cwd, 'tools/plugins/devtools')], 'not the folder it did not pick');
  await finish(t.id);
});

test('rules and plugin folders reach the turn, and Stop expires a waiting card', async () => {
  const delve = store.createProject('Delve', null);
  store.setProjectSettings(delve.id, { approval_rules: 'Bash(gh pr merge:*)', plugin_dirs: 'tools/mods/delve\nmissing' });
  const t = await turn(delve.id, ['tools/mods/delve']);
  assert.ok(!t.args.includes('none'));
  assert.equal(t.args[t.args.indexOf('--permission-prompt-tool') + 1], APPROVAL_TOOL);
  assert.equal(t.args.filter((a: string) => a === '--settings').length, 1);
  const settings = JSON.parse(readFileSync(t.args[t.args.indexOf('--settings') + 1], 'utf8'));
  assert.deepEqual(settings.permissions.ask, ['mcp__*__merge_pull_request', 'mcp__*__enable_pr_auto_merge', 'Bash(gh pr merge:*)']);
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /tripwire\.ts/);
  const plugins = t.args.filter((_: string, i: number) => t.args[i - 1] === '--plugin-dir');
  assert.deepEqual(plugins.slice(1), [join(t.cwd, 'tools/mods/delve')], 'after the kit');
  assert.ok(plugins[0].endsWith('/pin/kit'));
  assert.ok(Number(t.timeout) >= 24 * 3600_000);
  assert.equal(t.approvals, '1');

  const card = runner.approvals.request(t.id, 'Bash', { command: 'gh pr merge 1' });
  assert.equal(runner.view(store.getTicket(t.id)!).approvals, 1);
  runner.stop(t.id);
  while (runner.isRunning(t.id)) await wait(20);
  assert.equal(runner.approvals.decide(t.id, card, true, 'Cara').state, 'expired');
  const result = store.listEvents(t.id).find((e) => e.kind === 'approval_result');
  assert.match(JSON.parse(result!.data).reason, /stopped/);
});

test('after a restart, cards left waiting show as expired', () => {
  const p = store.createProject('Restart', null);
  const t = store.createTicket({ project_id: p.id, title: 'T', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  store.addEvent(t.id, 'approval', { id: 'abc', tool: 'Bash', input: {} });
  store.updateTicket(t.id, { status: 'running' });
  new Runner(store, () => {}, () => ({}), fake).recover();
  const result = store.listEvents(t.id).find((e) => e.kind === 'approval_result');
  assert.deepEqual(JSON.parse(result!.data), { id: 'abc', state: 'expired', reason: 'The server restarted while this waited.' });
});
