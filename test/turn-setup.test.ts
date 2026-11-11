import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { APPROVAL_TIMEOUT_MS } from '../src/approvals.ts';
import { Store } from '../src/db.ts';
import { GLOBAL_OWNER } from '../src/properties.ts';
import { stopTurns, testPins } from './helpers.ts';

// The server pins its MCP servers under its data dir when it starts (pinTurnFiles), sweeping copies of dead servers.
const root = mkdtempSync(join(tmpdir(), 'turn-setup-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
process.env.DATA_DIR = join(root, 'data');
const stale = join(root, 'data', 'run', 'mcp-999999999');
mkdirSync(stale, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
process.env.MACHINES_URL = 'http://127.0.0.1:1';
process.env.COORDINATOR_PASSWORD = 'hunter2';
process.env.XDG_RUNTIME_DIR = '/run/user/1000';
process.env.LC_TIME = 'en_GB.UTF-8';
// The service's own values must never reach a turn; tools/deploy.sh relies on the per-turn ones.
process.env.COORDINATOR_API = 'http://service.invalid';
process.env.COORDINATOR_TOKEN = 'service-token';
process.env.COORDINATOR_TICKET = '999';
const { Runner } = await import('../src/runner.ts');
const { turnEnv } = await import('../src/turn-launch.ts');
const { KIT, MCP_DIR, MCP_SERVER } = testPins(process.env.DATA_DIR);
const { CHECKOUT, HEAVY_LINE } = await import('../src/prompts.ts');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('pinned MCP copies live in the data dir, one folder per server, and stale ones are swept', () => {
  assert.equal(MCP_DIR, join(root, 'data', 'run', `mcp-${process.pid}`));
  assert.equal(dirname(MCP_SERVER), MCP_DIR);
  assert.ok(!existsSync(stale));
  assert.ok(readdirSync(MCP_DIR).includes('appname.ts'));
});

test('the Citadel kit is pinned beside them, a copy of the repo\'s kit/ plugin', () => {
  assert.equal(KIT, join(MCP_DIR, 'kit'));
  const manifest = readFileSync(join(KIT, '.claude-plugin', 'plugin.json'), 'utf8');
  assert.equal(manifest, readFileSync(join(import.meta.dirname, '..', 'kit', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(JSON.parse(manifest).name, 'citadel');
  for (const d of ['skills', 'agents', 'hooks']) assert.ok(existsSync(join(KIT, d)), d);
});

test('a turn inherits only the allowlisted environment', () => {
  const env = turnEnv({ HOME: '/h', PATH: '/bin', LC_ALL: 'C', CLAUDE_CONFIG_DIR: '/c', XDG_RUNTIME_DIR: '/r', GODOT: '/g', MACHINES_URL: 'x', COORDINATOR_PASSWORD: 'p', SESSION_SECRET: 's', PORT: '8573', HOST: 'h', DBUS_SESSION_BUS_ADDRESS: 'd' });
  assert.deepEqual(env, { HOME: '/h', PATH: '/bin', LC_ALL: 'C', CLAUDE_CONFIG_DIR: '/c', XDG_RUNTIME_DIR: '/r', GODOT: '/g' });
});

// A stand-in for `claude -p` that records its arguments and environment, prints an init event
// whose thread/coordinator server has the status in FAKE_MCP, and ends the turn.
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const settings = args.includes('--settings') ? JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8')) : null;
const system = args.includes('--append-system-prompt-file') ? readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8') : null;
const mcp = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
// What a Bash call would run for \`citadel-heavy\`, read while the turn's folder still exists.
const heavy = require('node:child_process').spawnSync('sh', ['-c', 'f=$(command -v citadel-heavy) && [ -x "$f" ] && cat "$f"'], { encoding: 'utf8' }).stdout;
const wait = require('node:child_process').spawnSync('sh', ['-c', 'f=$(command -v citadel-wait) && [ -x "$f" ] && cat "$f"'], { encoding: 'utf8' }).stdout;
writeFileSync(${JSON.stringify(join(root, 'turn'))}, JSON.stringify({ args, env: process.env, settings, system, mcp, heavy, wait }));
const status = readFileSync(${JSON.stringify(join(root, 'mcp-status'))}, 'utf8');
const role = process.env.COORDINATOR_ROLE;
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', cwd: process.cwd(), mcp_servers: status ? [{ name: role, status }] : [] }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
`,
);
chmodSync(fake, 0o755);
const store = new Store(join(root, 'test.db'));
const errors: string[] = [];
const runner = new Runner(store, () => {}, (t) => ({ COORDINATOR_API: 'http://127.0.0.1:8573', COORDINATOR_TOKEN: `token-${t.id}` }), fake);
runner.onTurnError = (_id, text) => errors.push(text);

async function turn(kind: 'ticket' | 'coordinator', mcpStatus: string, set: { model?: string; effort?: string; workflow?: number } = {}, repoDir?: string, projectId?: number) {
  writeFileSync(join(root, 'mcp-status'), mcpStatus);
  // A scheme has one Taskmaster, so each turn gets a scheme of its own unless it names one.
  const project = projectId ? store.getProject(projectId)! : store.createProject(`P${Math.random()}`, null);
  if (repoDir) store.setProjectRepoDir(project.id, repoDir);
  const t = (kind === 'coordinator' && projectId && store.getCoordinator(projectId)) || store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'bypassPermissions', created_by: 'Cara', kind });
  const cwd = join(root, `ticket-${t.id}`);
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  if (Object.keys(set).length) store.updateTicket(t.id, set as any);
  errors.length = 0;
  runner.send(t.id, 'Cara', 'go');
  while (runner.isRunning(t.id)) await wait(20);
  const run = JSON.parse(readFileSync(join(root, 'turn'), 'utf8'));
  const flag = (f: string) => (run.args.includes(f) ? run.args[run.args.indexOf(f) + 1] : null);
  const events = store.listEvents(t.id).filter((e) => e.kind === 'error').map((e) => JSON.parse(e.data).text);
  return { ...run, id: t.id, flag, events };
}

test("a minion turn gets the compaction window, no service secrets, Claude Code's model and the scheme's effort", async () => {
  const t = await turn('ticket', 'connected');
  assert.equal(t.settings.autoCompactWindow, 250000);
  assert.equal(t.env.MACHINES_URL, undefined);
  assert.equal(t.env.COORDINATOR_PASSWORD, undefined);
  assert.equal(t.env.XDG_RUNTIME_DIR, '/run/user/1000');
  assert.equal(t.env.LC_TIME, 'en_GB.UTF-8');
  // What tools/deploy.sh needs to post the restart's outcome to this minion's chat.
  assert.equal(t.env.COORDINATOR_API, 'http://127.0.0.1:8573');
  assert.equal(t.env.COORDINATOR_TOKEN, `token-${t.id}`);
  assert.equal(t.env.COORDINATOR_TICKET, String(t.id));
  assert.equal(t.env.COORDINATOR_ROLE, 'thread');
  assert.equal(t.flag('--model'), null);
  assert.equal(t.flag('--effort'), 'high', "the scheme's default effort");
  assert.deepEqual(t.events, []);
  assert.deepEqual(errors, []);
});

test("each minion's and Taskmaster's turn gets its own private temp folder in its scheme's data folder, not /tmp (#218)", async () => {
  for (const kind of ['ticket', 'coordinator'] as const) {
    const t = await turn(kind, 'connected');
    const tmp = join(root, 'projects', String(store.getTicket(t.id)!.project_id), 'tmp', String(t.id));
    for (const name of ['TMPDIR', 'TMP', 'TEMP', 'CLAUDE_CODE_TMPDIR']) assert.equal(t.env[name], tmp, name);
    assert.equal(statSync(tmp).mode & 0o777, 0o700);
    assert.equal(statSync(dirname(tmp)).mode & 0o777, 0o700);
    // A working directory, or Claude Code asks before `cd $TMPDIR/x && rm out/*` even in bypassPermissions (#242).
    assert.ok(t.args.slice(t.args.indexOf('--add-dir') + 1).includes(tmp), kind);
  }
});

test('a Taskmaster turn defaults to opus at high effort, and keeps a choice people made', async () => {
  const t = await turn('coordinator', 'connected');
  assert.equal(t.settings.autoCompactWindow, 180000, "a Taskmaster's backstop under a minion's 250k (#423)");
  assert.equal(t.flag('--model'), 'opus');
  assert.equal(t.flag('--effort'), 'high');
  const chosen = await turn('coordinator', 'connected', { model: 'sonnet', effort: 'medium' });
  assert.equal(chosen.flag('--model'), 'sonnet');
  assert.equal(chosen.flag('--effort'), 'medium');
});

test('every turn of every scheme loads its own pinned copy of the kit, and shares the compact window (a Taskmaster\'s smaller) and output cap', async () => {
  const a = store.createProject(`Kit A ${Math.random()}`, null);
  const b = store.createProject(`Kit B ${Math.random()}`, null);
  store.setProjectSettings(b.id, { plugin_dirs: 'tools/mods/x' });
  const turns = [await turn('ticket', 'connected', {}, undefined, a.id), await turn('ticket', 'connected', {}, undefined, b.id), await turn('coordinator', 'connected', {}, undefined, b.id)];
  for (const t of turns) {
    const dirs = t.args.flatMap((arg: string, i: number) => (arg === '--plugin-dir' ? [t.args[i + 1]] : []));
    assert.equal(dirs.length, 1, 'the kit, and no scheme folder that does not exist');
    const kit = dirs[0];
    assert.equal(basename(kit), 'kit');
    // The turn's own folder (beside its settings), not the server's copy a restart sweeps, nor the repo.
    assert.equal(dirname(dirname(kit)), dirname(t.flag('--settings')));
    assert.equal(t.settings.autoCompactWindow, t === turns[2] ? 180000 : 250000);
    assert.equal(t.settings.bashOutputMaxChars, 12000);
  }
});

test("a minion asks before merging through a GitHub MCP server, beside its scheme's approval rules; a Taskmaster doesn't", async () => {
  const p = store.createProject(`Asks ${Math.random()}`, null);
  store.setProjectSettings(p.id, { approval_rules: 'Bash(gh pr merge:*)\nmcp__*__merge_pull_request' });
  const minion = await turn('ticket', 'connected', {}, undefined, p.id);
  assert.deepEqual(minion.settings.permissions.ask, ['mcp__*__merge_pull_request', 'mcp__*__enable_pr_auto_merge', 'Bash(gh pr merge:*)']);
  const plain = await turn('ticket', 'connected');
  assert.deepEqual(plain.settings.permissions.ask, ['mcp__*__merge_pull_request', 'mcp__*__enable_pr_auto_merge']);
  const tm = await turn('coordinator', 'connected', {}, undefined, p.id);
  assert.equal(tm.settings.permissions.ask, undefined);
});

test("minion and Taskmaster turns both leave out unused built-in tools and the account's claude.ai skills and connectors", async () => {
  for (const kind of ['ticket', 'coordinator'] as const) {
    const t = await turn(kind, 'connected');
    const denied = t.args.slice(t.args.indexOf('--disallowedTools') + 1);
    for (const tool of ['AskUserQuestion', 'Workflow', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger']) assert.ok(denied.includes(tool), `${kind}: ${tool}`);
    assert.equal(t.settings.syncClaudeAiSkills, false, kind);
    assert.equal(t.settings.disableClaudeAiConnectors, true, kind);
    assert.ok(t.settings.hooks.PreToolUse, `${kind}: the tripwire hook is still there`);
  }
});

test('a minion opted in to Workflow (#359) gets the tool; the rest stay out, and a Taskmaster never gets it', async () => {
  const denied = (t: any) => t.args.slice(t.args.indexOf('--disallowedTools') + 1);
  const minion = await turn('ticket', 'connected', { workflow: 1 });
  assert.ok(!denied(minion).includes('Workflow'));
  for (const tool of ['AskUserQuestion', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger']) assert.ok(denied(minion).includes(tool), tool);
  // The route refuses it for a Taskmaster; the runner holds even if the column says otherwise.
  const tm = await turn('coordinator', 'connected', { workflow: 1 });
  assert.ok(denied(tm).includes('Workflow'));
});

test("a Taskmaster may search and fetch the web without a prompt nobody can answer; a minion's rules are unchanged (#210)", async () => {
  const tm = await turn('coordinator', 'connected');
  for (const tool of ['WebSearch', 'WebFetch']) assert.ok(tm.settings.permissions.allow.includes(tool), tool);
  const minion = await turn('ticket', 'connected');
  assert.deepEqual(minion.settings.permissions.allow, ['mcp__thread']);
  assert.ok(!minion.args.includes('--allowedTools'));
});

test("only Citadel's own Taskmaster may read the live checkout, never write it, and every Taskmaster is told git -C, never cd", async () => {
  while (!store.getProject(GLOBAL_OWNER)) store.createProject(`P${Math.random()}`, null);
  const checkout = CHECKOUT;
  const own = await turn('coordinator', 'connected', {}, undefined, GLOBAL_OWNER);
  const addDirs = own.args.slice(own.args.indexOf('--add-dir') + 1);
  assert.ok(addDirs.includes(checkout));
  assert.ok(own.settings.permissions.deny.includes(`Edit(/${checkout}/**)`));
  assert.ok(own.settings.permissions.allow.includes(`Bash(git -C ${checkout} log:*)`));
  assert.ok(own.system.includes(`The live checkout, the code this server runs right now, is at ${checkout}`));
  for (const other of [await turn('coordinator', 'connected'), await turn('ticket', 'connected', {}, undefined, GLOBAL_OWNER)]) {
    assert.ok(!other.args.includes(checkout));
    assert.ok(!JSON.stringify(other.settings.permissions).includes(checkout));
    assert.doesNotMatch(other.system, /The live checkout, the code this server runs/);
  }
  for (const tm of [own, await turn('coordinator', 'connected')]) assert.match(tm.system, /Read-only shell commands [^\n]*`git -C <folder> [^\n]*never `cd <folder> && …`/);
});

test("minion and Taskmaster turns both keep the Read tool out of the logins, keys, env file and state.db (#185)", async () => {
  for (const kind of ['ticket', 'coordinator'] as const) {
    const { deny } = (await turn(kind, 'connected')).settings.permissions;
    for (const rule of [`Read(/${homedir()}/.claude/.credentials.json)`, `Read(/${homedir()}/.ssh/**)`, `Read(/${homedir()}/.config/claude-coordinator/**)`, `Read(/${homedir()}/.config/gh/hosts.yml)`, `Read(/${dirname(store.path)}/state.db*)`]) {
      assert.ok(deny.includes(rule), `${kind}: ${rule}`);
    }
    if (kind === 'coordinator') assert.ok(deny.some((r: string) => r.startsWith('Edit(')), 'the Taskmaster keeps its own Edit denies');
  }
});

test("a minion gets the servers and notes of the machines lent to its scheme, whatever the retired scheme switch says (#438); a Taskmaster gets none", async () => {
  runner.machines = () => [{ id: 1, name: 'perigee-godot', token_hash: '', created_by: 'Cara', created_at: 0, last_seen_at: 0, notes: 'Never restart it.', workspace_tools: 0, scoped: 0 }];
  try {
    const servers = (t: any) => Object.keys(t.mcp.mcpServers);
    const on = await turn('ticket', 'connected');
    assert.deepEqual(servers(on), ['thread', 'perigee-godot']);
    assert.ok(on.settings.permissions.allow.includes('mcp__perigee-godot'), "the machine's tools are allowed");
    // In claude's argv, the machine's name would let a turn's `pkill -f godot` hit claude itself.
    assert.ok(!on.args.some((a: string) => a.includes('godot')), 'no argument names the machine');
    assert.match(on.system, /Never restart it/);
    // projects.machine_tools is still in the table, unread: off there changes nothing.
    const old = store.createProject('Switch off', null);
    store.db.prepare('UPDATE projects SET machine_tools = 0 WHERE id = ?').run(old.id);
    assert.deepEqual(servers(await turn('ticket', 'connected', {}, undefined, old.id)), ['thread', 'perigee-godot']);
    const taskmaster = await turn('coordinator', 'connected');
    assert.ok(!servers(taskmaster).includes('perigee-godot'));
    assert.doesNotMatch(taskmaster.system, /perigee-godot|Never restart it/);
  } finally {
    runner.machines = () => [];
  }
});

test("a minion's thread server may stay silent as long as a card can wait; Claude Code's 30-minute idle abort expired Delve #46's merge card (#209)", async () => {
  assert.equal((await turn('ticket', 'connected')).mcp.mcpServers.thread.timeout, APPROVAL_TIMEOUT_MS);
  assert.equal((await turn('coordinator', 'connected')).mcp.mcpServers.coordinator.timeout, undefined, 'a Taskmaster posts no cards');
});

test("a Taskmaster's settings travel as a file, so hundreds of worktrees stay under Linux's 128 KiB argument cap", async () => {
  // Citadel's Taskmaster stopped starting (spawn E2BIG) once ~90 worktrees put its inline --settings over 128 KiB.
  const scheme = join(root, 'big-scheme');
  for (let i = 1; i <= 300; i++) mkdirSync(join(scheme, 'tickets', String(i)), { recursive: true });
  const t = await turn('coordinator', 'connected', {}, join(scheme, 'repo'));
  assert.deepEqual(t.events, []);
  for (const arg of t.args) assert.ok(Buffer.byteLength(arg) < 32 * 1024, `argument of ${Buffer.byteLength(arg)} bytes`);
  assert.ok(t.settings.permissions.allow.includes(`Bash(git -C ${join(scheme, 'tickets', '300')} log:*)`));
  assert.ok(t.settings.hooks.PreToolUse);
});

test('every turn finds citadel-heavy first on its PATH, pinned, with the shared slots folder and who it runs for; only minions are told to use it (#325)', async () => {
  const t = await turn('ticket', 'connected');
  assert.equal(t.heavy, readFileSync(join(import.meta.dirname, '..', 'tools', 'citadel-heavy'), 'utf8'), 'on PATH and executable');
  assert.equal(t.wait, readFileSync(join(import.meta.dirname, '..', 'tools', 'citadel-wait'), 'utf8'), 'citadel-wait beside it (#481)');
  assert.ok(!t.env.PATH.startsWith(MCP_DIR) && t.env.PATH.split(':')[0].endsWith('/pin/bin'), "the turn's own pinned copy, which outlives a restart");
  assert.equal(t.env.CITADEL_HEAVY_DIR, join(root, 'projects', '.heavy'), "in the projects folder every container mounts");
  assert.match(t.env.CITADEL_HEAVY_WHO, /^P[\d.]+ #\d+$/);
  assert.equal(t.env.CARGO_BUILD_JOBS, '4');
  // The land tool's land.sh on the host queues in the same slots, under the same name.
  const host = runner.hostEnv(store.getTicket(t.id)!, 'token');
  assert.equal(host.CITADEL_HEAVY_DIR, t.env.CITADEL_HEAVY_DIR);
  assert.equal(host.CITADEL_HEAVY_WHO, t.env.CITADEL_HEAVY_WHO);
  assert.ok(t.system.includes(HEAVY_LINE));
  assert.match(HEAVY_LINE, /`citadel-heavy cargo test --workspace`/);
  const tm = await turn('coordinator', 'connected');
  assert.ok(!tm.system.includes(HEAVY_LINE));
});

test("the system prompt travels as a file, so a `pkill -f` for a word in it can't match claude itself", async () => {
  // Delve #14 SIGTERMed its own claude: `pgrep -f dotnet` matched the prompt's "dotnet build" in claude's argv.
  const project = store.createProject(`P${Math.random()}`, null);
  store.setProjectInstructions(project.id, 'Build with dotnet build Delve.sln.', 'Cara');
  const t = await turn('ticket', 'connected', {}, undefined, project.id);
  assert.match(t.system, /dotnet build Delve\.sln/);
  assert.ok(!t.args.some((a: string) => a.includes('dotnet')), 'no argument carries the prompt text');
});

test('a turn whose own MCP server failed or is missing says so as an error', async () => {
  const failed = await turn('ticket', 'failed');
  assert.equal(failed.events.length, 1);
  assert.match(failed.events[0], /thread MCP server is failed/);
  assert.equal(errors.length, 1);
  const missing = await turn('coordinator', '');
  assert.match(missing.events[0], /coordinator MCP server is missing/);
  const pending = await turn('ticket', 'pending');
  assert.deepEqual(pending.events, []);
});

// The Taskmaster's MCP server against a stand-in API that records what create_ticket sends.
test('create_ticket lists properties but still starts a minion when a stale session leaves them out', async () => {
  const bodies: any[] = [];
  const api = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      bodies.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 40, number: 12, title: 'X', status: 'new', created_by: 'Taskmaster' }));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const mcp = spawn(process.execPath, [MCP_SERVER], {
    env: { PATH: process.env.PATH, COORDINATOR_API: `http://127.0.0.1:${(api.address() as any).port}`, COORDINATOR_TOKEN: 'c.sig', COORDINATOR_PROJECT: '2', COORDINATOR_ROLE: 'coordinator', COORDINATOR_TICKET: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const replies = new Map<number, (r: any) => void>();
  createInterface({ input: mcp.stdout! }).on('line', (l) => {
    const r = JSON.parse(l);
    replies.get(r.id)?.(r);
  });
  let rid = 0;
  const rpc = (method: string, params: object): Promise<any> => {
    const id = ++rid;
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((r) => replies.set(id, r));
  };
  try {
    const schema = (await rpc('tools/list', {})).result.tools.find((t: any) => t.name === 'create_ticket').inputSchema;
    assert.ok(schema.properties.properties);
    assert.ok(!schema.required.includes('properties'));

    const bare = (await rpc('tools/call', { name: 'create_ticket', arguments: { title: 'X', message: 'go' } })).result;
    assert.ok(!bare.isError, bare.content[0].text);
    assert.deepEqual(bodies.at(-1).properties, { type: 'other' });
    assert.match(bare.content[0].text, /type: other for now.*ticket_id 12/);

    const tagged = (await rpc('tools/call', { name: 'create_ticket', arguments: { title: 'X', tag: 'bug', message: 'go' } })).result;
    // A retired tag (#254) still goes to the server, which makes it the type, and the session hears it is retired.
    assert.deepEqual(bodies.at(-1).properties, {});
    assert.equal(bodies.at(-1).tag, 'bug');
    assert.doesNotMatch(tagged.content[0].text, /type: other/);
    assert.match(tagged.content[0].text, /tag is retired.*set_properties/);
    assert.ok(!('tag' in schema.properties));

    await rpc('tools/call', { name: 'create_ticket', arguments: { title: 'X', properties: { Type: 'art' }, message: 'go' } });
    assert.deepEqual(bodies.at(-1).properties, { Type: 'art' });
  } finally {
    mcp.kill();
    api.close();
  }
});

test("only the scheme whose code this server runs hears about deploys, pending-deploy and previews", async () => {
  const repo = join(root, 'served-repo');
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  runner.liveHead = () => git('rev-parse', 'HEAD');
  try {
    const served = await turn('ticket', 'connected', {}, repo);
    assert.equal(served.env.COORDINATOR_DEPLOYS, '1');
    assert.match(served.system, /After you deploy with tools\/deploy\.sh/);
    for (const other of [await turn('ticket', 'connected'), await turn('ticket', 'connected', {}, join(root, 'big-scheme', 'repo'))]) {
      assert.equal(other.env.COORDINATOR_DEPLOYS, undefined);
      assert.doesNotMatch(other.system, /deploy\.sh|pending-deploy/);
    }
    // A Taskmaster's MCP server never offers set_thread_status or start_preview, so it needs no flag.
    assert.equal((await turn('coordinator', 'connected', {}, repo)).env.COORDINATOR_DEPLOYS, undefined);
  } finally {
    runner.liveHead = () => null;
  }
});

test("only the Citadel scheme's Taskmaster is offered the Citadel-wide instruction tools, and every turn's prompt carries the text", async () => {
  while (!store.getProject(GLOBAL_OWNER)) store.createProject(`P${Math.random()}`, null);
  store.setAppInstructions('Be kind everywhere.', 'Cara');
  try {
    const own = await turn('coordinator', 'connected', {}, undefined, GLOBAL_OWNER);
    assert.equal(own.env.COORDINATOR_APP_INSTRUCTIONS, '1');
    for (const other of [await turn('coordinator', 'connected'), await turn('ticket', 'connected', {}, undefined, GLOBAL_OWNER)]) {
      assert.equal(other.env.COORDINATOR_APP_INSTRUCTIONS, undefined);
      assert.match(other.system, /# Citadel-wide instructions[^]*Be kind everywhere\./);
    }
  } finally {
    store.setAppInstructions('', 'Cara');
  }
});
