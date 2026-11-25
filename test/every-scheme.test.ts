// #656: the Citadel scheme's Taskmaster reads every scheme (Josh: "the Citadel taskmaster should have full read access
// to all schemes"), read-only and only on a Citadel member's or admin's ask; other Taskmasters and writes stay as they were.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { ClaudeLink } from '../src/claude-link.ts';
import { Containers } from '../src/containers.ts';
import { Contraptions } from '../src/contraptions.ts';
import { Credentials } from '../src/credentials.ts';
import { askerKey, Store } from '../src/db.ts';
import { systemPrompt, turnContext } from '../src/prompts.ts';
import { Runner } from '../src/runner.ts';
import { isTurnNote } from '../src/codex.ts';
import { tripwire, type TripwireConfig } from '../src/tripwire.ts';
import { coordinatorAccess } from '../src/turn-launch.ts';
import { bootServer, PASSWORD, SECRET, tempRoot } from './helpers.ts';
import { agentEnv, mcpOnce } from './mcp-agent.ts';

const tmp = tempRoot('every-scheme-');
const root = tmp.dir;
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(() => tmp.teardown());

// Three schemes, Citadel's the second (GLOBAL_OWNER), each with a Taskmaster, and a minion in Peek.
const store = new Store(join(data, 'coordinator.db'));
const scheme = (name: string) => {
  const p = store.createProject(name, null);
  store.setProjectRepoDir(p.id, join(data, 'projects', String(p.id), 'repo'));
  return store.getProject(p.id)!;
};
const delve = scheme('Delve');
const citadel = scheme('Citadel');
const peek = scheme('Peek');
// The admin bootServer signs in as.
const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
assert.equal(citadel.id, 2);
function thread(projectId: number, kind: 'ticket' | 'coordinator', title: string) {
  const t = store.createTicket({ project_id: projectId, kind, title, permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(data, 'projects', String(projectId), kind === 'ticket' ? `tickets/${t.id}` : 'coordinator');
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  return store.getTicket(t.id)!;
}
const tmCitadel = thread(citadel.id, 'coordinator', 'Coordinator');
const tmPeek = thread(peek.id, 'coordinator', 'Coordinator');
const peekMinion = thread(peek.id, 'ticket', 'Aura timers');
const closed = thread(peek.id, 'ticket', 'Old work');
store.updateTicket(closed.id, { status: 'closed' });
const josh = store.createUser({ name: 'Josh', login: 'josh' }); // a Citadel member
store.addMember(citadel.id, josh.id);
const alex = store.createUser({ name: 'Alex', login: 'alex' }); // Peek only
store.addMember(peek.id, alex.id);
const appDir = join(root, 'apps', 'peek-auras');
mkdirSync(appDir, { recursive: true });
new Contraptions(store, SECRET, join(data, 'contraptions')).register({
  name: 'peek-auras',
  title: 'Peek Auras',
  port: 1,
  icon: null,
  home_scheme: peek.id,
  open_paths: '[]',
  default_model: null,
  turn_cap: null,
  folder: appDir,
});
const askedBy = (ticket: { id: number }, uid: number) => store.setSetting(askerKey(ticket.id), uid);

test('the runner opens every scheme only to the Citadel Taskmaster, on a Citadel member or admin ask', () => {
  const runner = new Runner(
    store,
    () => {},
    () => ({}),
    '/bin/false',
  );
  const every = runner.everySchemeFor(citadel, tmCitadel, josh.id)!;
  assert.ok(every, 'a Citadel member');
  assert.ok(runner.everySchemeFor(citadel, tmCitadel, cara.id), 'an admin');
  // The folder and its two deploy slots beside it (#801).
  assert.deepEqual(every.apps, [appDir, join(root, 'apps', '.peek-auras')]);
  // Other schemes' repos and their open minions' worktrees; not its own, and not a dismissed minion's.
  assert.ok(every.gitDirs.includes(delve.repo_dir!) && every.gitDirs.includes(peek.repo_dir!) && every.gitDirs.includes(peekMinion.cwd!));
  assert.ok(!every.gitDirs.includes(citadel.repo_dir!) && !every.gitDirs.includes(closed.cwd!));
  assert.equal(runner.everySchemeFor(citadel, tmCitadel, alex.id), null, "a non-member's relay");
  assert.equal(runner.everySchemeFor(citadel, tmCitadel, null), null, 'no one asked');
  assert.equal(runner.everySchemeFor(peek, tmPeek, josh.id), null, "another scheme's Taskmaster");
  assert.equal(runner.everySchemeFor(citadel, peekMinion, josh.id), null, 'a minion');
});

test('its launch reads the contraption folders and other repos, never writes or fetches there, and keeps secrets out', () => {
  const every = { gitDirs: [peek.repo_dir!, peekMinion.cwd!], apps: [appDir], data, keysDir: join(data, 'contraptions') };
  const plain = coordinatorAccess(citadel.repo_dir, join(data, 'projects/2/tickets'), null, null, null, [data]);
  const wide = coordinatorAccess(citadel.repo_dir, join(data, 'projects/2/tickets'), null, null, null, [data], every);
  const { allow, deny } = wide.settings.permissions;
  assert.deepEqual(wide.addDirs, plain.addDirs, 'nothing new is added, so acceptEdits writes nowhere new');
  assert.ok(allow.includes(`Read(/${appDir}/**)`));
  assert.ok(!plain.settings.permissions.allow.some((r) => r.includes(appDir)));
  for (const d of [peek.repo_dir, peekMinion.cwd, appDir]) {
    assert.ok(allow.includes(`Bash(git -C ${d} log:*)`), `${d} log`);
    assert.ok(!allow.some((r) => r.startsWith(`Bash(git -C ${d} fetch`)), `${d} never fetches`);
  }
  assert.ok(allow.includes(`Bash(git -C ${citadel.repo_dir} fetch)`), 'its own repo still fetches');
  for (const f of [`${appDir}/**/.env`, `${appDir}/**/.env.*`, `${data}/**/.env`, `${data}/contraptions/*/contraption.key`]) assert.ok(deny.includes(`Read(/${f})`), f);
  assert.ok(plain.settings.permissions.deny.includes(`Read(/${data}/**/.env)`), "every Taskmaster, not only this one, is kept from the data folder's .env files");
});

test('the tripwire keeps a Taskmaster from .env files, named or found by a recursive search, and lets other searches through', () => {
  mkdirSync(join(data, 'projects/3/repo/sub'), { recursive: true });
  writeFileSync(join(data, 'projects/3/repo/sub/.env'), 'SECRET=x');
  const cfg: TripwireConfig = { home: root, data, checkout: join(root, 'live'), project: 2, claudeConfig: join(root, '.claude'), deployScript: true, envFiles: [data, appDir] };
  const bash = (command: string, c = cfg) => tripwire({ tool_name: 'Bash', tool_input: { command, description: 'read another scheme' }, cwd: join(data, 'projects/2/coordinator') }, c)?.reason ?? null;
  const repo = join(data, 'projects/3/repo');
  for (const cmd of [`cat ${repo}/sub/.env`, `head ${repo}/*/.env`, `cat ${appDir}/.env.local`, `grep -rn SECRET ${repo}`, `grep -rn SECRET ${data}/projects`, `grep -rn SECRET --exclude=.env ${repo}`, `rg --hidden SECRET ${repo}`, `rg -uu SECRET ${repo}`, `cd ${repo} && grep -r SECRET .`])
    assert.match(bash(cmd) ?? '', /\.env/, cmd);
  for (const cmd of [`grep -rn SECRET --exclude='.env*' ${repo}`, `grep -rn SECRET --include='*.ts' ${repo}`, `rg SECRET ${repo}`, `rg --hidden -g '!.env*' SECRET ${repo}`, `cat ${repo}/sub/notes.txt`, `grep -rn SECRET ${join(root, 'elsewhere')}`]) assert.equal(bash(cmd), null, cmd);
  assert.equal(bash(`grep -rn SECRET ${repo}`, { ...cfg, envFiles: undefined }), null, 'minions are as before');
  const grepTool = (input: object) => tripwire({ tool_name: 'Grep', tool_input: { pattern: 'SECRET', ...input }, cwd: data }, cfg)?.reason ?? null;
  assert.match(grepTool({ path: repo }) ?? '', /\.env/);
  assert.equal(grepTool({ path: repo, glob: '*.ts' }), null);
  assert.match(grepTool({ path: repo, glob: '.env*' }) ?? '', /\.env/);
});

test('the tripwire refuses its writes into a contraption folder, and lets it read there', () => {
  const home = root;
  const cfg: TripwireConfig = { home, data, checkout: join(root, 'live'), project: 2, claudeConfig: join(home, '.claude'), deployScript: true, readOnly: [appDir] };
  const call = (tool_name: string, tool_input: object, c = cfg) => tripwire({ tool_name, tool_input, cwd: join(data, 'projects/2/coordinator') }, c)?.reason ?? null;
  assert.match(call('Write', { file_path: join(appDir, 'x.ts'), content: '' })!, /contraption's folder/);
  assert.match(call('Bash', { command: `touch ${appDir}/x`, description: 'make a file' })!, /contraption's folder/);
  assert.equal(call('Read', { file_path: join(appDir, 'x.ts') }), null);
  assert.equal(call('Write', { file_path: join(appDir, 'x.ts'), content: '' }, { ...cfg, readOnly: undefined }), null, 'other turns are as before');
  // Another scheme's folder stays unwritable, as before.
  assert.match(call('Write', { file_path: join(data, 'projects/3/repo/x'), content: '' })!, /another scheme/);
});

// In the turn message, not system-prompt.md (#878): it flips with who asked, and the system prompt stays the same either way.
test('its turn message names every scheme and contraption folder on a member ask, and not otherwise', () => {
  const view = { data, schemes: [{ id: 3, name: 'Peek' }], apps: [{ name: 'peek-auras', folder: appDir }] };
  const on = turnContext(citadel, tmCitadel, null, null, join(data, 'projects/2/tickets'), null, [], false, '', null, [], null, false, view);
  assert.ok(on.includes(`${join(data, 'projects')}/<number>/`) && on.includes('3 Peek') && on.includes(`peek-auras ${appDir}`));
  const off = turnContext(citadel, tmCitadel, null, null, join(data, 'projects/2/tickets'), null);
  assert.ok(!off.includes(`peek-auras ${appDir}`) && off.includes('message_taskmaster instead'));
  for (const note of [on, off]) assert.ok(isTurnNote(`[System]: ${note}`), 'a Codex hand-over knows it for a turn note');
  assert.equal(systemPrompt(citadel, tmCitadel, null, null, join(data, 'projects/2/tickets'), null, [], false, '', null, [], null, false, view), systemPrompt(citadel, tmCitadel, null, null, join(data, 'projects/2/tickets'), null));
  assert.equal(turnContext(peek, tmPeek, null, null, join(data, 'projects/3/tickets'), null, [], false, '', null, [], null, false, view), '');
});

test("a member's container mounts the contraption folders read-only; others' don't", async () => {
  const link = new ClaudeLink(store, new Credentials(store, 'x'.repeat(40)), data, process.execPath, new Containers(async () => ({ code: 0, stdout: '', stderr: '' })), 'citadel-claude-es-');
  // The folder's parent: the folder links into its slots beside it, which must follow each deploy (#801).
  const apps = dirname(appDir);
  const mount = async (uid: number) => (await link.spec(uid)).mounts.find((m) => m.src === apps);
  assert.deepEqual(await mount(josh.id), { src: apps, dst: apps, ro: true });
  assert.equal(await mount(alex.id), undefined);
});

test("list_tickets and read_ticket read another scheme for the Citadel Taskmaster on a member's ask, and nothing else crosses", { timeout: 60_000 }, async () => {
  const srv = await bootServer({ root });
  after(() => srv.stop());
  const tokens = new Auth(PASSWORD, SECRET);
  const api = (as: { id: number }, method: string, path: string) => fetch(srv.base + path, { method, headers: { Authorization: `Bearer ${tokens.agentToken(as.id)}`, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }).then((r) => r.status);
  type ToolDef = { name: string; inputSchema?: { properties?: { scheme?: unknown } } };
  type ToolAnswer = { isError: boolean; text: string };
  async function tool(as: { id: number; project_id: number }, name: 'tools/list', args: object, citadelTools: boolean): Promise<ToolDef[]>;
  async function tool(as: { id: number; project_id: number }, name: string, args: object, citadelTools: boolean): Promise<ToolAnswer>;
  async function tool(as: { id: number; project_id: number }, name: string, args: object, citadelTools: boolean): Promise<ToolDef[] | ToolAnswer> {
    const r = await mcpOnce(agentEnv(srv.base, tokens.agentToken(as.id), as, 'coordinator', { COORDINATOR_APP_INSTRUCTIONS: citadelTools ? '1' : undefined }), name === 'tools/list' ? 'tools/list' : 'tools/call', { name, arguments: args }, tmp.track);
    return name === 'tools/list' ? r.tools : { isError: !!r.isError, text: r.content[0].text as string };
  }
  const schemeArg = (tools: ToolDef[], name: string) => !!tools.find((t) => t.name === name)!.inputSchema!.properties!.scheme;
  assert.ok(schemeArg(await tool(tmCitadel, 'tools/list', {}, true), 'list_tickets') && schemeArg(await tool(tmCitadel, 'tools/list', {}, true), 'read_ticket'));
  assert.ok(!schemeArg(await tool(tmPeek, 'tools/list', {}, false), 'list_tickets'), "other Taskmasters aren't offered it");
  assert.ok(!(await tool(tmCitadel, 'tools/list', {}, true)).some((t) => !['list_tickets', 'read_ticket', 'live_facts', 'message_taskmaster'].includes(t.name) && t.inputSchema?.properties?.scheme), 'no other tool takes a scheme (message_taskmaster always named the one it writes to)');

  askedBy(tmCitadel, josh.id);
  const list = await tool(tmCitadel, 'list_tickets', { scheme: peek.id }, true);
  assert.ok(!list.isError && list.text.startsWith('Scheme Peek:') && list.text.includes('#1 Aura timers'), list.text);
  const read = await tool(tmCitadel, 'read_ticket', { scheme: peek.id, ticket_id: peekMinion.number }, true);
  assert.ok(!read.isError && read.text.includes('Aura timers'), read.text);
  assert.ok(!(await tool(tmCitadel, 'read_ticket', { scheme: peek.id, ticket_id: peekMinion.number, live: true }, true)).isError);
  const facts = await tool(tmCitadel, 'live_facts', { scheme: peek.id, ticket_id: peekMinion.number }, true);
  assert.ok(!facts.isError && facts.text.includes('Aura timers (scheme Peek)'), facts.text);
  // Reads only: writes and routes not marked everyScheme still stop at its own scheme.
  for (const [method, path] of [
    ['GET', `/api/projects/${peek.id}/tickets`],
    ['GET', `/api/tickets/${peekMinion.id}`],
    ['GET', `/api/tickets/${peekMinion.id}/events?after=0`],
    ['GET', `/api/projects/${peek.id}?number=1`],
  ])
    assert.equal(await api(tmCitadel, method, path), 200, path);
  for (const [method, path] of [
    ['PATCH', `/api/tickets/${peekMinion.id}`],
    ['POST', `/api/tickets/${peekMinion.id}/messages`],
    ['POST', `/api/tickets/${peekMinion.id}/stop`],
    ['PATCH', `/api/projects/${peek.id}`],
    ['POST', `/api/projects/${peek.id}/tickets`],
    ['GET', `/api/projects/${peek.id}/artifacts`],
  ]) {
    assert.equal(await api(tmCitadel, method, path), 403, `${method} ${path}`);
  }
  // A non-member's relay: refused, with the reason.
  askedBy(tmCitadel, alex.id);
  const refused = await tool(tmCitadel, 'list_tickets', { scheme: peek.id }, true);
  assert.ok(refused.isError && /Citadel member or admin/.test(refused.text), refused.text);
  // Another scheme's Taskmaster: its tools refuse a scheme, and the API too.
  askedBy(tmPeek, josh.id);
  assert.match((await tool(tmPeek, 'list_tickets', { scheme: delve.id }, false)).text, /Only the Citadel scheme's Taskmaster/);
  assert.equal(await api(tmPeek, 'GET', `/api/projects/${delve.id}/tickets`), 403);
});
