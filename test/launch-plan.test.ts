// launchPlan (src/turn-launch.ts) on its own: one fact changed at a time, and what that alone changes in
// the plan. The whole launch of each kind of turn is pinned in test/turn-launch.test.ts.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { AUTH_VARS } from '../src/claude-link.ts';
import { launchPlan, type LaunchPlan, type TurnFacts } from '../src/turn-launch.ts';
import { testPins } from './helpers.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'launch-plan-')));
after(() => rmSync(root, { recursive: true, force: true }));
const pins = testPins(root);
const store = new Store(join(root, 'coordinator.db'));
const project = store.createProject('P', null);
const minion = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'bypassPermissions', created_by: 'Cara', kind: 'ticket' });
const taskmaster = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'bypassPermissions', created_by: 'Cara', kind: 'coordinator' });
const dir = join(root, 'turn');
mkdirSync(dir);
const container = { host: false as const, container: 'box', configDir: '/vol/.claude', home: '/vol', turnsDir: '/vol/turns', env: { HOME: '/vol', CLAUDE_CONFIG_DIR: '/vol/.claude' }, ensure: async () => {} };

const base: TurnFacts = {
  project, ticket: minion, dir, pins, place: { host: true }, machines: [], model: null, effort: null, codex: null, codexReview: null,
  folders: { files: null, shared: null, memory: null, tmp: null, tickets: join(root, 'tickets'), data: root },
  env: { server: { PATH: '/usr/bin', HOME: '/home/server', CLAUDE_CONFIG_DIR: '/srv/claude', ANTHROPIC_API_KEY: 'server-key', SECRET_OF_THE_SERVER: 'x' }, coordinator: { COORDINATOR_TOKEN: 'tok' }, heavy: {}, github: null },
  deploys: false, memory: false, typer: null, homeContraptions: [], claudeBin: process.execPath, unit: null,
};
const plan = (over: Partial<TurnFacts> = {}) => launchPlan({ ...base, ...over });
const file = (p: LaunchPlan, name: string) => JSON.parse(p.files.find((f) => f.name === name)!.text);
const flag = (p: LaunchPlan, name: string) => (p.args.includes(name) ? p.args[p.args.indexOf(name) + 1] : undefined);

test('a plan is data: it writes nothing into the turn folder and never resumes by itself', () => {
  const p = plan({ ticket: { ...minion, session_id: 'abc' } });
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(p.files.map((f) => [f.name, f.mode]), [['mcp.json', undefined], ['codex-tripwire.json', 0o444], ['settings.json', undefined]]);
  assert.equal(p.args.includes('--resume'), false);
  assert.equal(flag(p, '--settings'), join(dir, 'settings.json'));
  assert.equal(flag(p, '--mcp-config'), join(dir, 'mcp.json'));
});

test("the environment is the server's filtered one plus the turn's own, and nothing else of the server's", () => {
  const p = plan();
  assert.equal(p.env.SECRET_OF_THE_SERVER, undefined);
  assert.equal(p.env.ANTHROPIC_API_KEY, 'server-key');
  assert.equal(p.env.COORDINATOR_TOKEN, 'tok');
  assert.equal(p.env.COORDINATOR_ROLE, 'thread');
  assert.equal(p.env.COORDINATOR_TICKET, String(minion.id));
  // The turn's pinned tools come first on PATH (the Android toolchain may follow, when this machine has one).
  assert.ok(p.env.PATH.startsWith(`${join(dir, 'pin', 'bin')}:/usr/bin`), p.env.PATH);
  assert.equal(p.configDir, '/srv/claude');
});

// One fact each: the env names it adds to the plain minion's, and no others.
const adds: [string, Partial<TurnFacts>, Record<string, string>][] = [
  ['deploys', { deploys: true }, { COORDINATOR_DEPLOYS: '1' }],
  ['memory', { memory: true }, { COORDINATOR_MEMORY: '1' }],
  ['the typer', { typer: { id: 7, login: 'josh' } }, { CITADEL_PERSON_ID: '7', CITADEL_PERSON_LOGIN: 'josh' }],
  ['home contraptions', { homeContraptions: ['a', 'b'] }, { COORDINATOR_HOME_CONTRAPTIONS: 'a,b' }],
  ['a GitHub login', { env: { ...base.env, github: { GH_TOKEN: 'gh' } } }, { GH_TOKEN: 'gh' }],
  ['citadel-heavy', { env: { ...base.env, heavy: { CITADEL_HEAVY_URL: 'u' } } }, { CITADEL_HEAVY_URL: 'u' }],
  ['a temp folder', { folders: { ...base.folders, tmp: '/t' } }, { TMPDIR: '/t', TMP: '/t', TEMP: '/t', CLAUDE_CODE_TMPDIR: '/t' }],
  ['files and shared folders', { folders: { ...base.folders, files: '/f', shared: '/s' } }, { COORDINATOR_FILES_DIR: '/f', COORDINATOR_SHARED_DIR: '/s' }],
];
for (const [name, over, extra] of adds) {
  test(`${name} adds ${Object.keys(extra).join(', ')} to the environment and nothing else`, () => {
    assert.deepEqual(plan(over).env, { ...plan().env, ...extra });
  });
}

test("a container turn carries none of the server's sign-in, takes the container's env and is spawned there", () => {
  const p = plan({ place: container, folders: { ...base.folders, tmp: '/t' }, unit: 'never-used' });
  for (const v of AUTH_VARS) assert.equal(p.env[v], undefined, v);
  assert.equal(p.env.HOME, '/vol');
  assert.equal(p.env.COORDINATOR_CONTAINER, '1');
  assert.equal(p.env.XDG_RUNTIME_DIR, '/t');
  assert.equal(p.configDir, '/vol/.claude');
  assert.deepEqual(p.spawn, { how: 'container', wrapper: [join(dir, 'pin', 'bin', 'citadel-node'), join(dir, 'pin', 'turn-wrapper.ts'), dir] });
});

test('a host turn is a unit when it has one and a child when not, with the same wrapper', () => {
  const child = plan().spawn;
  const unit = plan({ unit: 'citadel-turn-x' }).spawn;
  assert.equal(child.how, 'child');
  assert.ok(unit.how === 'unit' && child.how === 'child');
  assert.deepEqual(unit.wrapper, child.wrapper);
  assert.deepEqual(unit.wrapper, [join(dir, 'pin', 'bin', 'citadel-node'), join(dir, 'pin', 'turn-wrapper.ts'), dir]);
  assert.ok(unit.systemdRun.includes('--unit=citadel-turn-x'));
  assert.deepEqual(unit.systemdRun.slice(-3), unit.wrapper);
});

test("a minion's approval rules become asks and it gets the approval tool; a Taskmaster gets neither", () => {
  const withRules = { ...project, approval_rules: 'Bash(rm *)' };
  const m = plan({ project: withRules });
  assert.ok(file(m, 'settings.json').permissions.ask.includes('Bash(rm *)'));
  assert.equal(m.env.COORDINATOR_APPROVALS, '1');
  assert.deepEqual(Object.keys(file(m, 'mcp.json').mcpServers), ['thread']);
  const t = plan({ project: withRules, ticket: taskmaster });
  assert.equal(JSON.stringify(file(t, 'settings.json')).includes('Bash(rm *)'), false);
  assert.equal(t.env.COORDINATOR_APPROVALS, undefined);
  assert.equal(t.env.MCP_TOOL_TIMEOUT, undefined);
  assert.equal(t.env.COORDINATOR_ROLE, 'coordinator');
  assert.deepEqual(Object.keys(file(t, 'mcp.json').mcpServers), ['coordinator']);
});

test('a lent machine is an MCP server of the turn, allowed by name, and never in argv', () => {
  const p = plan({ machines: [{ id: 3, name: 'perigee-godot', owner_id: null, servers: ['mcp', 'ws'] } as TurnFacts['machines'][number]] });
  const servers = Object.keys(file(p, 'mcp.json').mcpServers);
  assert.deepEqual(servers, ['thread', 'perigee-godot', 'perigee-godot-ws']);
  for (const s of servers) assert.ok(file(p, 'settings.json').permissions.allow.includes(`mcp__${s}`), s);
  assert.equal(p.args.join(' ').includes('perigee'), false);
});

test('a Codex turn runs the shim in claude\'s place, on its thread when it has one, checked in turn mode', () => {
  const claude = plan();
  const fresh = plan({ codex: { thread: null } });
  const resumed = plan({ codex: { thread: 'th-1' } });
  assert.equal(plan({ claudeBin: '/opt/claude' }).command, '/opt/claude');
  assert.equal(plan({ claudeBin: '/opt/claude', codex: { thread: null } }).command, join(dir, 'pin', 'bin', 'citadel-node'));
  assert.equal(fresh.args[0], join(dir, 'pin', 'codex-turn.ts'));
  assert.deepEqual(fresh.args.slice(-claude.args.length), claude.args);
  assert.equal(flag(fresh, '--codex-thread'), undefined);
  assert.equal(flag(resumed, '--codex-thread'), 'th-1');
  assert.equal(file(claude, 'codex-tripwire.json').mode, undefined);
  const tw = file(fresh, 'codex-tripwire.json');
  assert.equal(tw.mode, 'turn');
  assert.equal(tw.config.turnDir, dir);
  assert.deepEqual(tw.mcp, ['thread']);
});

test("the container a host turn's Codex reviews run in is named in its tripwire file, and only when there is one", () => {
  assert.equal(file(plan(), 'codex-tripwire.json').container, undefined);
  const review = { container: 'codex-box', turnsDir: '/c/turns', env: { HOME: '/c' } };
  assert.deepEqual(file(plan({ codexReview: review }), 'codex-tripwire.json').container, { name: 'codex-box', turnsDir: '/c/turns', env: { HOME: '/c' } });
});

test('the model and effort it was given are passed on, and left out when there is none', () => {
  assert.equal(flag(plan(), '--model'), undefined);
  assert.equal(flag(plan(), '--effort'), undefined);
  const p = plan({ model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(flag(p, '--model'), 'claude-opus-5-5');
  assert.equal(flag(p, '--effort'), 'high');
});
