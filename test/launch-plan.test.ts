// launchPlan (src/turn-launch.ts) on its own: one fact changed at a time, and what that alone changes in
// the plan. The whole launch of each kind of turn is pinned in test/turn-launch.test.ts.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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
  project,
  ticket: minion,
  dir,
  pins,
  place: { host: true },
  machines: [],
  model: null,
  effort: null,
  codex: null,
  codexReview: null,
  folders: { files: null, shared: null, memory: null, tmp: null, tickets: join(root, 'tickets'), data: root },
  env: { server: { PATH: '/usr/bin', HOME: '/home/server', CLAUDE_CONFIG_DIR: '/srv/claude', ANTHROPIC_API_KEY: 'server-key', SECRET_OF_THE_SERVER: 'x' }, coordinator: { COORDINATOR_TOKEN: 'tok' }, heavy: {}, github: null },
  deploys: false,
  memory: false,
  typer: null,
  homeContraptions: [],
  claudeBin: process.execPath,
  unit: null,
};
const plan = (over: Partial<TurnFacts> = {}) => launchPlan({ ...base, ...over });
const file = (p: LaunchPlan, name: string) => JSON.parse(p.files.find((f) => f.name === name)!.text);
const flag = (p: LaunchPlan, name: string) => (p.args.includes(name) ? p.args[p.args.indexOf(name) + 1] : undefined);

test('a plan is data: it writes nothing into the turn folder and never resumes by itself', () => {
  const p = plan({ ticket: { ...minion, session_id: 'abc' } });
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(
    p.files.map((f) => [f.name, f.mode]),
    [
      ['mcp.json', undefined],
      ['codex-tripwire.json', 0o444],
      ['settings.json', undefined],
    ],
  );
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
  assert.equal(p.env.CITADEL_MINION_TITLE, minion.title, "the kit's title check reads it (#1154)");
  // The kit's hooks cache their compiled code in the folder the turn's own hooks do (#1296).
  const tripwire = JSON.parse(p.files.find((f) => f.name === 'settings.json')!.text).hooks.PreToolUse.find((m: { hooks: { onFailure: string }[] }) => m.hooks[0].onFailure === 'block').hooks[0].command;
  assert.equal(p.env.CITADEL_HOOK_CACHE, join(dir, 'pin', '.compile-cache'));
  assert.ok(tripwire.startsWith(`NODE_COMPILE_CACHE='${p.env.CITADEL_HOOK_CACHE}' `), tripwire);
  // The turn's pinned tools come first on PATH, bin/heavy's wrappers before them when the pinned folder has it (the Android toolchain may follow, when this machine has one).
  assert.ok(p.env.PATH.startsWith(`${pins.PIN_HAS.heavy ? `${join(dir, 'pin', 'bin', 'heavy')}:` : ''}${join(dir, 'pin', 'bin')}:/usr/bin`), p.env.PATH);
  assert.equal(p.configDir, '/srv/claude');
});

test("a minion's tripwire lets it change its copies of its scheme's apps' data, and only in a scheme with an app (#1884)", () => {
  const settings = (over: Partial<TurnFacts>) =>
    plan(over)
      .files.map((f) => f.text)
      .join('\n');
  const copies = JSON.stringify(join(dir, 'app-copy'));
  assert.ok(
    settings({ homeContraptions: ['a'] })
      .replaceAll('\\', '')
      .includes(`"copies":${copies}`),
  );
  assert.ok(!settings({}).includes('app-copy'));
});

// One fact each: the env names it adds to the plain minion's, and no others.
const adds: [string, Partial<TurnFacts>, Record<string, string>][] = [
  ['deploys', { deploys: true }, { COORDINATOR_DEPLOYS: '1' }],
  ['memory', { memory: true }, { COORDINATOR_MEMORY: '1' }],
  // A minion whose person connected OpenRouter is offered the media tools (#717).
  ['media', { media: true }, { COORDINATOR_MEDIA: '1' }],
  // A minion whose person has a reachable Codex login is offered generate_image_codex (#733).
  ['codex images', { codexImages: true }, { COORDINATOR_CODEX_IMAGES: '1' }],
  ['the typer', { typer: { id: 7, login: 'josh' } }, { CITADEL_PERSON_ID: '7', CITADEL_PERSON_LOGIN: 'josh' }],
  ['home contraptions', { homeContraptions: ['a', 'b'] }, { COORDINATOR_HOME_CONTRAPTIONS: 'a,b' }],
  // A minion turn that got machines is offered propose_machine_notes for them (#617).
  [
    'lent machines',
    {
      machines: [
        { id: 3, name: 'perigee-godot', owner_id: null, servers: ['mcp'] },
        { id: 4, name: 'josh-box', owner_id: 2, servers: ['mcp'] },
      ] as TurnFacts['machines'],
    },
    { COORDINATOR_MACHINES: 'perigee-godot,josh-box' },
  ],
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
  assert.deepEqual(p.spawn, { how: 'container', wrapper: [join(dir, 'pin', 'bin', 'citadel-node'), join(dir, 'pin', 'turn-wrapper.mjs'), dir] });
});

test('a host turn is a unit when it has one and a child when not, with the same wrapper', () => {
  const child = plan().spawn;
  const unit = plan({ unit: 'citadel-turn-x' }).spawn;
  assert.equal(child.how, 'child');
  assert.ok(unit.how === 'unit' && child.how === 'child');
  assert.deepEqual(unit.wrapper, child.wrapper);
  assert.deepEqual(unit.wrapper, [join(dir, 'pin', 'bin', 'citadel-node'), join(dir, 'pin', 'turn-wrapper.mjs'), dir]);
  assert.ok(unit.systemdRun.includes('--unit=citadel-turn-x'));
  assert.deepEqual(unit.systemdRun.slice(-3), unit.wrapper);
});

test("a host Taskmaster turn runs in the Taskmasters' slice, kept off oomd's list; a minion's in the turns' slice; the tools pool beside the Taskmasters (#1280)", () => {
  const run = (p: ReturnType<typeof plan>) => {
    assert.equal(p.spawn.how, 'unit');
    return p.spawn.how === 'unit' ? p.spawn.systemdRun : [];
  };
  const minionRun = run(plan({ unit: 'citadel-turn-x' }));
  const tmRun = run(plan({ unit: 'citadel-turn-y', ticket: taskmaster }));
  assert.ok(minionRun.includes('--slice=citadel-turns.slice') && !minionRun.includes('ManagedOOMPreference=omit'), minionRun.join(' '));
  assert.ok(tmRun.includes('--slice=citadel-taskmasters.slice') && !tmRun.includes('--slice=citadel-turns.slice'), tmRun.join(' '));
  assert.equal(tmRun[tmRun.indexOf('ManagedOOMPreference=omit') - 1], '-p');
  const poolRun = plan({ pool: true, unit: 'citadel-turn-x' }).pool!.systemdRun!;
  assert.ok(poolRun.includes('--slice=citadel-taskmasters.slice'), 'the tools pool Taskmasters call');
  // systemd-oomd (#1338): a minion turn is its last pick, never its first; the pool every turn's tools go through is never picked.
  assert.equal(minionRun[minionRun.indexOf('ManagedOOMPreference=avoid') - 1], '-p', minionRun.join(' '));
  assert.ok(!tmRun.includes('ManagedOOMPreference=avoid'), tmRun.join(' '));
  assert.equal(poolRun[poolRun.indexOf('ManagedOOMPreference=omit') - 1], '-p', poolRun.join(' '));
  assert.ok(existsSync(new URL('../deploy/citadel-taskmasters.slice', import.meta.url)), 'the slice it names ships in deploy/');
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
  assert.equal(t.env.CITADEL_MINION_TITLE, undefined);
  assert.deepEqual(Object.keys(file(t, 'mcp.json').mcpServers), ['coordinator']);
});

test('a lent machine is an MCP server of the turn, allowed by name, and never in argv', () => {
  const p = plan({ machines: [{ id: 3, name: 'perigee-godot', owner_id: null, servers: ['mcp', 'ws'] } as TurnFacts['machines'][number]] });
  const servers = Object.keys(file(p, 'mcp.json').mcpServers);
  assert.deepEqual(servers, ['thread', 'perigee-godot', 'perigee-godot-ws']);
  for (const s of servers) assert.ok(file(p, 'settings.json').permissions.allow.includes(`mcp__${s}`), s);
  assert.equal(p.args.join(' ').includes('perigee'), false);
});

test("a pooled turn reaches its place's shared tool server by HTTP, with its own helpers as the fallback; a Codex turn never pools (#1259)", () => {
  const machines = [{ id: 3, name: 'perigee godot', owner_id: null, servers: ['mcp', 'ws'], lent: 'godot-ai' } as TurnFacts['machines'][number]];
  const own = plan({ machines });
  const p = plan({ machines, pool: true });
  const http = file(p, 'mcp.json').mcpServers;
  // The same servers by name, so allow rules and the tool names the turn sees don't change.
  assert.deepEqual(Object.keys(http), Object.keys(file(own, 'mcp.json').mcpServers));
  assert.deepEqual(file(p, 'mcp-stdio.json'), file(own, 'mcp.json'));
  assert.deepEqual(file(p, 'settings.json'), file(own, 'settings.json'));
  assert.deepEqual(http.thread, { type: 'http', url: 'http://127.0.0.1:${CITADEL_POOL_PORT}/mcp', headers: { Authorization: 'Bearer ${COORDINATOR_TOKEN}' }, timeout: own.files.length && file(own, 'mcp.json').mcpServers.thread.timeout });
  assert.equal(http['perigee godot-ws'].url, 'http://127.0.0.1:${CITADEL_POOL_PORT}/machine/3/ws?name=perigee%20godot-ws');
  // The MCP server ticked now travels with it, so the pool never answers from another one's remembered tools (2MA6).
  assert.equal(http['perigee godot'].url, 'http://127.0.0.1:${CITADEL_POOL_PORT}/machine/3/mcp?name=perigee%20godot&lent=godot-ai');
  // The token only travels in the env, never in a file.
  assert.equal(
    p.files.some((f) => f.text.includes('tok')),
    false,
  );
  assert.deepEqual(p.args, own.args);
  assert.equal(own.pool, undefined);
  assert.equal(p.pool!.dir, join(root, '.pool', pins.POOL_VERSION));
  assert.equal(p.pool!.script, join(dir, 'pin', 'mcp-pool.ts'));
  assert.equal(p.pool!.node, join(dir, 'pin', 'bin', 'citadel-node'));
  // A plain env: no token, no sign-in.
  assert.deepEqual(Object.keys(p.pool!.env).sort(), ['HOME', 'PATH', 'TZ']);
  assert.equal(p.pool!.systemdRun, undefined);
  assert.ok(plan({ pool: true, unit: 'citadel-turn-x' }).pool!.systemdRun!.some((a) => a.startsWith('--unit=citadel-mcp-pool-')));
  assert.equal(plan({ pool: true, place: container, unit: 'never-used' }).pool!.systemdRun, undefined);
  // Their Taskmaster container counts pids apart, and a pool's record is kept by pid: never the one record for both (#1882).
  const taskmaster = { ...minion, kind: 'coordinator' as const };
  assert.notEqual(plan({ pool: true, place: container, ticket: taskmaster }).pool!.dir, plan({ pool: true, place: container }).pool!.dir);
  assert.equal(plan({ pool: true, ticket: taskmaster }).pool!.dir, plan({ pool: true }).pool!.dir, 'the host is one place');
  const codex = plan({ pool: true, codex: { thread: null } });
  assert.equal(codex.pool, undefined);
  assert.equal(
    codex.files.some((f) => f.name === 'mcp-stdio.json'),
    false,
  );
});

test("a Codex turn runs the shim in claude's place, on its thread when it has one, checked in turn mode", () => {
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

test("a minion's turn carries its scheme's screenshot widths and themes for tools/ui-shot.ts, a Taskmaster's none (#1044)", () => {
  const shots = { ...project, shot_widths: '768,390', shot_themes: 'dark' };
  const p = plan({ project: shots });
  assert.equal(p.env.COORDINATOR_SHOT_WIDTHS, '768,390');
  assert.equal(p.env.COORDINATOR_SHOT_THEMES, 'dark');
  assert.equal(plan({ project: shots, ticket: taskmaster }).env.COORDINATOR_SHOT_WIDTHS, undefined);
});

// #1125: a turn's copy of the pinned files was a cpSync of the tree, 3.8 to 8.7 s of the server's loop on a busy disk.
test('copyPinned links the pinned files instead of copying their bytes, and keeps links and modes', async () => {
  const { copyPinned } = await import('../src/turn-launch.ts');
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, statSync, lstatSync, readlinkSync, readFileSync, rmSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'copy-pins-'));
  try {
    const src = join(root, 'src');
    mkdirSync(join(src, 'bin'), { recursive: true });
    writeFileSync(join(src, 'tripwire.ts'), 'guard');
    writeFileSync(join(src, 'bin', 'tool'), '#!/bin/sh');
    chmodSync(join(src, 'bin', 'tool'), 0o755);
    symlinkSync('/usr/bin/node', join(src, 'bin', 'citadel-node'));
    const dst = join(root, 'pin');
    await copyPinned(src, dst);
    assert.equal(statSync(join(dst, 'tripwire.ts')).ino, statSync(join(src, 'tripwire.ts')).ino, 'a link, not a copy');
    assert.equal(statSync(join(dst, 'bin', 'tool')).mode & 0o777, 0o755);
    assert.ok(lstatSync(join(dst, 'bin', 'citadel-node')).isSymbolicLink());
    assert.equal(readlinkSync(join(dst, 'bin', 'citadel-node')), '/usr/bin/node');
    await copyPinned(src, join(root, 'boxed'), false);
    assert.notEqual(statSync(join(root, 'boxed', 'tripwire.ts')).ino, statSync(join(src, 'tripwire.ts')).ino, 'a container turn gets copies');
    rmSync(src, { recursive: true });
    assert.equal(readFileSync(join(dst, 'tripwire.ts'), 'utf8'), 'guard', "the turn's copy outlives the server's");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #1979: a skill's load-time `!` command is checked against the allow rules after CLAUDE_SKILL_DIR is filled in,
// as written (`..` kept; tried in real runs), and nobody can answer a Taskmaster's prompt.
test('a Taskmaster may run exactly what citadel:briefing and citadel:subagents run when they load', () => {
  const p = plan({ ticket: taskmaster });
  const kit = flag(p, '--plugin-dir')!;
  const rules = ['briefing', 'subagents'].map((skill) => {
    const [, command] = readFileSync(join(import.meta.dirname, '..', 'kit', 'skills', skill, 'SKILL.md'), 'utf8').match(/^!`(.+)`$/m)!;
    return `Bash(${command.replace('${CLAUDE_SKILL_DIR}', join(kit, 'skills', skill))})`;
  });
  assert.deepEqual(
    file(p, 'settings.json').permissions.allow.filter((r: string) => r.startsWith('Bash(node')),
    rules,
  );
  assert.ok(!file(plan(), 'settings.json').permissions.allow.some((r: string) => r.startsWith('Bash(')), "a minion's rules don't change");
});
