// What a turn is launched with, pinned as a snapshot (test/turn-launch.snapshot.json) for a matrix of
// turns: minion and Taskmaster, Claude and Codex, host and container, a unit and a plain child, with and
// without lent machines and approval rules, a resumed session, a preview. Each case is the spec the
// wrapper gets (command, argv, cwd, env), the settings.json, mcp.json and codex-tripwire.json the turn
// reads, the files in its folder and how it is spawned. A change here is a change to every turn of
// that kind: `UPDATE_SNAPSHOT=1 node --test test/turn-launch.test.ts` rewrites the snapshot, and the
// diff is what to review.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// The snapshot records each file's mode, and the server's umask (077 under its unit) isn't a shell's.
process.umask(0o022);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'turn-launch-')));
after(() => rmSync(root, { recursive: true, force: true }));
// A fixed environment, set before anything reads it: a turn inherits HOME, PATH, the locale and every
// CLAUDE_* and ANTHROPIC_* variable of the server, and a snapshot can't depend on whose shell runs it.
const { turnEnv } = await import('../src/turn-launch.ts');
for (const k of Object.keys(turnEnv(process.env))) if (k !== 'PATH') delete process.env[k];
const bin = join(root, 'bin');
mkdirSync(bin);
// A fake systemd-run that records what a unit would be started with, and starts nothing.
const units = join(root, 'units.jsonl');
writeFileSync(join(bin, 'systemd-run'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(units)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
chmodSync(join(bin, 'systemd-run'), 0o755);
const PATH = process.env.PATH!;
Object.assign(process.env, { HOME: join(root, 'home'), PATH: `${bin}:${PATH}`, CLAUDE_CONFIG_DIR: join(root, 'host-claude'), XDG_RUNTIME_DIR: '/run/user/1000', LC_TIME: 'en_GB.UTF-8', ANTHROPIC_API_KEY: 'server-key', MACHINES_URL: 'http://127.0.0.1:1', COORDINATOR_PASSWORD: 'hunter2' });
mkdirSync(process.env.HOME!);
const { Store } = await import('../src/db.ts');
const { Runner } = await import('../src/runner.ts');
const { codexSwitchKey, codexThreadKey } = await import('../src/codex.ts');
const { transcriptPath } = await import('../src/sessions.ts');
const { GLOBAL_OWNER } = await import('../src/properties.ts');
const { jsonLines, lines, testPins } = await import('./helpers.ts');
testPins(root);

const store = new Store(join(root, 'coordinator.db'));
const cara = store.createUser({ name: 'Cara', login: 'cara', server_login: true });
const josh = store.createUser({ name: 'Josh', login: 'josh' });
const volume = join(root, 'josh-volume');
const joshPlace = { host: false as const, container: 'citadel-claude-test-2', configDir: join(volume, '.claude'), home: volume, turnsDir: join(root, 'run', 'turns', `person-${josh.id}`), env: { HOME: volume, CLAUDE_CONFIG_DIR: join(volume, '.claude') }, ensure: async () => {} };
const caraVolume = join(root, 'cara-volume');
const caraCodex = { host: false as const, container: 'citadel-claude-test-cara', configDir: process.env.CLAUDE_CONFIG_DIR!, home: caraVolume, turnsDir: join(root, 'run', 'turns', `person-${cara.id}`), env: { HOME: caraVolume, CLAUDE_CONFIG_DIR: join(caraVolume, '.claude') }, ensure: async () => {} };

// Never run: a container turn resolves it to a real path, so it has to exist.
const claude = join(bin, 'claude');
writeFileSync(claude, '');
interface Spawned { how: string; dir: string; wrapper: string[] }
let spawned: Spawned[] = [];
const runner = new Runner(store, () => {}, (t) => ({ COORDINATOR_API: 'http://127.0.0.1:8573', COORDINATOR_TOKEN: `token-${t.id}`, COORDINATOR_PROJECT: String(t.project_id) }), claude);
runner.pollMs = 10;
runner.personOf = (author) => (author === 'Josh' ? josh.id : author === 'Cara' ? cara.id : null);
runner.placeFor = (uid) => (uid === josh.id ? joshPlace : { host: true });
runner.codexReady = () => null;
runner.sharedDir = (project) => join(root, 'projects', String(project.id), 'shared', 'project');
runner.ticketsDir = (project) => join(root, 'projects', String(project.id), 'tickets');
// Nothing is started: the two spawn paths record what they were handed (a unit goes to the fake systemd-run).
(runner as any).spawnWrapper = (wrapper: string[], dir: string) => spawned.push({ how: 'child', dir, wrapper });
(runner as any).spawnInContainer = (place: { container: string }, dir: string, wrapper: string[]) => spawned.push({ how: `container ${place.container}`, dir, wrapper });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Paths, ids and times that differ per run, by name. Longest first, so a folder inside another keeps its own name. */
function scrub(value: unknown): any {
  let text = JSON.stringify(value);
  const names: [string, string][] = [[join(import.meta.dirname, '..'), '<CHECKOUT>'], [root, '<ROOT>'], [root.replace(/[^a-zA-Z0-9]/g, '-'), '<ROOT-AS-SLUG>'], [process.execPath, '<NODE>'], [PATH, '<PATH>']];
  for (const [path, name] of names.sort((a, b) => b[0].length - a[0].length)) text = text.replaceAll(JSON.stringify(path).slice(1, -1), name);
  return JSON.parse(text.replace(/-\d{13}\b/g, '-<TIME>').replace(/citadel-turn-[0-9a-f]{8}-/g, 'citadel-turn-<TAG>-'));
}

interface Case { kind?: 'ticket' | 'coordinator'; project?: number; author?: string; set?: Record<string, unknown>; before?: (ticket: number, project: number) => void; units?: boolean }
/** Start one turn and return everything it was launched with, then end it. */
async function launch(c: Case) {
  const project = c.project ? store.getProject(c.project)! : store.createProject(`P${store.listProjects().length + 1}`, null);
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'bypassPermissions', created_by: 'Cara', kind: c.kind ?? 'ticket' });
  const cwd = join(root, `ticket-${t.id}`);
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  if (c.set) store.updateTicket(t.id, c.set as any);
  c.before?.(t.id, project.id);
  spawned = [];
  rmSync(units, { force: true });
  runner.units = !!c.units;
  runner.send(t.id, c.author ?? 'Cara', 'go');
  for (let i = 0; i < 500 && !spawned.length && !lines(units).length && runner.isRunning(t.id); i++) await wait(10);
  const notes = store.listEvents(t.id).filter((e) => e.kind === 'note').map((e) => JSON.parse(e.data).text as string);
  const turn = store.getSetting<{ dir: string }>(`turn:${t.id}`);
  if (!turn) return scrub({ launched: false, notes });
  const dir = turn.dir;
  const read = (f: string) => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null);
  const files = readdirSync(dir).filter((f) => f !== 'pin').sort().map((f) => `${f} ${(statSync(join(dir, f)).mode & 0o777).toString(8)}`);
  const got = { launched: true, notes, spec: read('spec.json'), settings: read('settings.json'), mcp: read('mcp.json'), codexTripwire: read('codex-tripwire.json'), files, pinned: readdirSync(join(dir, 'pin')).length > 0,
    spawned: spawned.map(({ how, wrapper }) => ({ how, wrapper })), unit: existsSync(units) ? jsonLines(units) : null };
  // End it: the wrapper that would have run it never started.
  writeFileSync(join(dir, 'exit.json'), JSON.stringify({ code: 0, signal: null }));
  for (let i = 0; i < 1000 && runner.isRunning(t.id); i++) await wait(10);
  assert.ok(!runner.isRunning(t.id), 'the turn ended');
  return scrub(got);
}

const machine = (id: number, name: string, owner: number | null, servers?: string[]) => ({ id, name, owner_id: owner, ...(servers ? { servers } : {}) }) as any;
const cases: Record<string, Case | (() => Promise<unknown>)> = {
  'a minion on the host, as a plain child': {},
  'a minion on the host in a unit, with files and shared folders, lent machines, approval rules, a model, an effort, Workflow, GitHub, deploys and memory': {
    units: true,
    set: { model: 'claude-sonnet-5-5', effort: 'low', workflow: 1 },
    before: (ticket, project) => {
      store.setProjectSettings(project, { approval_rules: 'Bash(git push:*)\nmcp__github__create_issue', plugin_dirs: join(root, 'plugins', 'a'), default_effort: 'medium' });
      runner.filesDir = (t) => (t.id === ticket ? join(root, 'projects', String(project), 'shared', String(ticket)) : null);
      runner.machines = (p) => (p.id === project ? [machine(7, 'perigee-godot', null), machine(8, 'caras-laptop', cara.id, ['mcp', 'ws'])] : []);
      runner.githubFor = (person) => ({ env: { GH_TOKEN: `gh-${person}`, GIT_AUTHOR_NAME: 'Cara' }, line: 'GitHub: this turn runs for Cara.', login: 'caraminden' });
      runner.liveHead = () => 'abc';
      runner.memoryScheme = (p) => p === project;
    },
  },
  'a Taskmaster on the host, with a repo and two minion folders': {
    kind: 'coordinator',
    before: (_ticket, project) => {
      runner.githubFor = undefined;
      runner.liveHead = () => null;
      store.setProjectRepoDir(project, join(root, 'repo'));
      for (const d of ['1', '2']) mkdirSync(join(root, 'projects', String(project), 'tickets', d), { recursive: true });
    },
  },
  "the Citadel scheme's Taskmaster": async () => {
    // Its scheme has a fixed id (GLOBAL_OWNER): make schemes until that one exists.
    while (!store.getProject(GLOBAL_OWNER)) store.createProject(`P${store.listProjects().length + 1}`, null);
    return launch({ kind: 'coordinator', project: GLOBAL_OWNER });
  },
  "a minion in a person's container": { author: 'Josh' },
  "a minion in a person's container, with units": { author: 'Josh', units: true },
  'a minion on Codex, a new thread': { author: 'Josh', before: () => store.setSetting(codexSwitchKey(josh.id), true) },
  'a minion on Codex, resuming its thread, with approval rules and a lent machine': {
    author: 'Josh',
    set: { model: 'gpt-5.5-codex' },
    before: (ticket, project) => {
      store.setProjectSettings(project, { approval_rules: 'Bash(git push:*)' });
      runner.machines = (p) => (p.id === project ? [machine(7, 'perigee-godot', null)] : []);
      store.setSetting(codexThreadKey(ticket), { thread: 'th-9', person: josh.id, log: '' });
    },
  },
  "a Claude turn after Codex turns, back in the person's container": {
    author: 'Josh',
    before: (ticket) => {
      store.deleteSetting(codexSwitchKey(josh.id));
      store.setSetting(codexThreadKey(ticket), { thread: 'th-9', person: josh.id, log: '' });
    },
  },
  "the server login's Codex turn, in its Codex container": {
    before: () => {
      runner.codexPlaceFor = (uid) => (uid === cara.id ? caraCodex : null);
      store.setSetting(codexSwitchKey(cara.id), true);
    },
  },
  "the server login's Claude turn on the host, naming its Codex container for reviews": { before: () => store.deleteSetting(codexSwitchKey(cara.id)) },
  'a resumed session whose transcript is on this login': {
    set: { session_id: 'sess-7' },
    before: (ticket) => {
      runner.codexPlaceFor = undefined;
      const file = transcriptPath(process.env.CLAUDE_CONFIG_DIR!, join(root, `ticket-${ticket}`), 'sess-7');
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '');
    },
  },
  'a session whose transcript is nowhere starts fresh': { set: { session_id: 'sess-gone' } },
  'a preview launches nothing': async () => {
    runner.noTurns = true;
    try {
      return await launch({});
    } finally {
      runner.noTurns = false;
    }
  },
};

test('every kind of turn is launched with exactly what the snapshot says', async () => {
  const got: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(cases)) got[name] = typeof c === 'function' ? await c() : await launch(c);
  const file = join(import.meta.dirname, 'turn-launch.snapshot.json');
  if (process.env.UPDATE_SNAPSHOT) writeFileSync(file, JSON.stringify(got, null, 1) + '\n');
  const want = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(got), Object.keys(want));
  for (const name of Object.keys(want)) assert.deepEqual(got[name], want[name], name);
});
