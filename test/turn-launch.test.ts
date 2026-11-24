// What a turn is launched with, pinned as a snapshot (test/turn-launch.snapshot.json) for a matrix of
// turns: minion and Taskmaster, Claude and Codex, host and container, a unit and a plain child, with and
// without lent machines and approval rules, a resumed session, a preview. Each case is the spec the
// wrapper gets (command, argv, cwd, env), the settings.json, mcp.json and codex-tripwire.json the turn
// reads, the files in its folder and how it is spawned. A change here is a change to every turn of
// that kind: `UPDATE_SNAPSHOT=1 node --test test/turn-launch.test.ts` rewrites the snapshot, and the
// diff is what to review.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

// The snapshot records each file's mode, and the server's umask (077 under its unit) isn't a shell's.
process.umask(0o022);
const { jsonLines, lines, stopTurns, tempRoot, testPins } = await import('./helpers.ts');
const tmp = tempRoot('turn-launch-');
const root = realpathSync(tmp.dir);
// The delete hit ENOTEMPTY under CI load (#758): a turn's session save was still running, and its worker thread
// made state.db in root mid-delete. launch() waits for each save; this ends whatever else a failed test leaves.
after(async () => {
  await stopTurns(root);
  for (const live of (runner as any).turns.values()) clearInterval(live.timer);
  store.db.close();
  await tmp.teardown();
});
// A fixed environment, set before anything reads it: a turn inherits HOME, PATH, the locale and every
// CLAUDE_* and ANTHROPIC_* variable of the server, and a snapshot can't depend on whose shell runs it.
const { turnEnv } = await import('../src/turn-launch.ts');
// The snapshot pins a systemd new enough for MemoryTHP=, whatever the host runs (CI's runners don't).
(await import('../src/unit-thp.ts')).setThpSupport(true);
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
interface Spawned {
  how: string;
  dir: string;
  wrapper: string[];
}
let spawned: Spawned[] = [];
const runner = new Runner(
  store,
  () => {},
  (t) => ({ COORDINATOR_API: 'http://127.0.0.1:8573', COORDINATOR_TOKEN: `token-${t.id}`, COORDINATOR_PROJECT: String(t.project_id) }),
  claude,
);
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
  const names: [string, string][] = [
    [join(import.meta.dirname, '..'), '<CHECKOUT>'],
    [root, '<ROOT>'],
    [root.replace(/[^a-zA-Z0-9]/g, '-'), '<ROOT-AS-SLUG>'],
    [process.execPath, '<NODE>'],
    [PATH, '<PATH>'],
  ];
  for (const [path, name] of names.sort((a, b) => b[0].length - a[0].length)) text = text.replaceAll(JSON.stringify(path).slice(1, -1), name);
  return JSON.parse(text.replace(/-\d{13}\b/g, '-<TIME>').replace(/citadel-turn-[0-9a-f]{8}-/g, 'citadel-turn-<TAG>-'));
}

interface Case {
  kind?: 'ticket' | 'coordinator';
  project?: number;
  author?: string;
  set?: Record<string, unknown>;
  before?: (ticket: number, project: number) => void;
  units?: boolean;
  peek?: (dir: string) => void | Promise<void>;
}
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
  const notes = store
    .listEvents(t.id)
    .filter((e) => e.kind === 'note')
    .map((e) => JSON.parse(e.data).text as string);
  const turn = store.getSetting<{ dir: string }>(`turn:${t.id}`);
  if (!turn) return scrub({ launched: false, notes });
  const dir = turn.dir;
  const read = (f: string) => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null);
  const files = readdirSync(dir)
    .filter((f) => f !== 'pin')
    .sort()
    .map((f) => `${f} ${(statSync(join(dir, f)).mode & 0o777).toString(8)}`);
  const got = {
    launched: true,
    notes,
    spec: read('spec.json'),
    settings: read('settings.json'),
    mcp: read('mcp.json'),
    codexTripwire: read('codex-tripwire.json'),
    files,
    pinned: readdirSync(join(dir, 'pin')).length > 0,
    spawned: spawned.map(({ how, wrapper }) => ({ how, wrapper })),
    unit: existsSync(units) ? jsonLines(units) : null,
  };
  await c.peek?.(dir);
  // End it: the wrapper that would have run it never started.
  writeFileSync(join(dir, 'exit.json'), JSON.stringify({ code: 0, signal: null }));
  // Its lane ends with the session save, whose worker thread opens state.db under root: wait for that too.
  const busy = () => runner.isRunning(t.id) || (runner as any).lanes.busy(t.id);
  for (let i = 0; i < 1000 && busy(); i++) await wait(10);
  assert.ok(!busy(), 'the turn ended and its session is saved');
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
  // Git rules for the open minion's folder only: one per folder in tickets/, closed ones too, outgrew the 2 MiB settings cap.
  // Its two minions are deleted after, so the cases below keep their ticket ids (no AUTOINCREMENT: the ids come back).
  'a Taskmaster on the host, with a repo, an open minion and a closed one': async () => {
    const minions: number[] = [];
    const launched = await launch({
      kind: 'coordinator',
      before: (_ticket, project) => {
        runner.githubFor = undefined;
        runner.liveHead = () => null;
        store.setProjectRepoDir(project, join(root, 'repo'));
        for (const d of ['1', '2']) {
          const dir = join(root, 'projects', String(project), 'tickets', d);
          mkdirSync(dir, { recursive: true });
          const m = store.createTicket({ project_id: project, title: `M${d}`, permission_mode: 'bypassPermissions', created_by: 'Cara' });
          store.setTicketDir(m.id, dir, null);
          if (d === '2') store.updateTicket(m.id, { status: 'closed' });
          minions.push(m.id);
        }
      },
    });
    for (const id of minions) store.deleteTicket(id);
    return launched;
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

// Claude Code's date line is in the turn's zone: UTC flips it at 4 PM PST, mid keepalive hours (#862). The server stays UTC.
test("every turn runs on Pacific time, whatever the server's TZ is", () => {
  for (const tz of [undefined, 'UTC', 'Asia/Tokyo']) assert.equal(turnEnv({ ...process.env, TZ: tz }).TZ, 'America/Los_Angeles', String(tz));
});

// Claude Code records a conversation's first system prompt and replays it on every resume unless told not
// to (--system-prompt-snapshot, on by default since 2.1.319 at the latest), so saved scheme and Citadel-wide
// instructions never reached a running session (#618). Turns where the text didn't change still read it from cache.
test("a resumed turn is sent this turn's system prompt, not its session's first one", async () => {
  const turns: Record<string, Case> = { minion: cases['a resumed session whose transcript is on this login'] as Case, Taskmaster: { kind: 'coordinator', set: { session_id: 'sess-7' } } };
  for (const [name, c] of Object.entries(turns)) {
    const args: string[] = ((await launch(c)) as any).spec.args;
    assert.equal(args[args.indexOf('--system-prompt-snapshot') + 1], 'off', name);
    assert.ok(args.includes('--append-system-prompt-file'), name);
    if (name === 'minion') assert.equal(args[args.indexOf('--resume') + 1], 'sess-7');
  }
});

// The advisor trial (#817): a minion set to Sonnet with an Opus advisor launches as Sonnet and gets
// --advisor; a plain model never does, and a Taskmaster set to it runs without the advisor.
test("--advisor is passed only when the minion's model carries one, and never to a Taskmaster", async () => {
  const flags = async (c: Case) => {
    const args: string[] = ((await launch(c)) as any).spec.args;
    const at = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
    return { model: at('--model'), advisor: at('--advisor') };
  };
  assert.deepEqual(await flags({ set: { model: 'claude-sonnet-5-5+opus-advisor' } }), { model: 'claude-sonnet-5-5', advisor: 'opus' });
  assert.deepEqual(await flags({ set: { model: 'claude-sonnet-5-5' } }), { model: 'claude-sonnet-5-5', advisor: null });
  assert.deepEqual(await flags({}), { model: null, advisor: null });
  assert.deepEqual(await flags({ kind: 'coordinator', set: { model: 'claude-sonnet-5-5+opus-advisor' } }), { model: 'claude-sonnet-5-5', advisor: null });
});

// Build 4 (#1051): the scheme's review set comes from the store, not its repo, so a scheme with no rubric files gets one too.
test("a turn gets its scheme's review set as files, named in its turn message, with the off entries left out", async () => {
  let seen: { files: string[]; ui: string; message: string; added: string } | null = null;
  await launch({
    before: (_t, project) => {
      store.reviews.create(project, { slug: 'ui', name: 'UI', body: '## Pass\n\nLooks right.\n', triggers: { diff: ['public/**'] }, stage: 'work', trial: true }, 'Cara');
      store.reviews.create(project, { slug: 'old', name: 'Old', body: '## Pass\n\nx\n', triggers: {}, stage: 'ask', enabled: false }, 'Cara');
      // Phase 2 (#1052): the kit's own reviewers are entries too, switched per scheme; the turn hears which are off.
      store.reviews.ensureBuiltIns(project);
      for (const slug of ['pre-ship-review', 'lens-tests', 'fresh-eyes']) store.reviews.save(project, slug, { enabled: false }, 'Cara', 'Turned off');
      store.reviews.save(project, 'finding-checker', { body: 'Check the migration claims twice.' }, 'Cara', 'Edited by hand');
    },
    peek: (dir) => {
      const set = join(dir, 'review-set');
      seen = { files: readdirSync(set), ui: readFileSync(join(set, 'ui.md'), 'utf8'), message: readFileSync(join(dir, 'prompt.jsonl'), 'utf8'), added: readFileSync(join(dir, 'review-kit', 'finding-checker.md'), 'utf8') };
    },
  });
  assert.ok(seen, 'the turn launched');
  const { files, ui, message, added } = seen!;
  assert.deepEqual(files, ['ui.md'], "kit entries aren't rubric files");
  assert.match(ui, /^---\nname: ui\nwhen: "diff: public\/\*\*"\ntrial: true\n---\n\n## Pass/);
  assert.match(message, /Review set: .*review-set/);
  assert.match(message, /Kit reviewers: This scheme's pre-ship review is off: don't run citadel:self-review's reviewer and give no risk label\. Every ship waits for a person's go/);
  assert.match(message, /This scheme switched off: Lens: Tests, Fresh eyes\./);
  assert.match(message, /review-kit\/finding-checker\.md` \(Finding checker\)/);
  assert.match(added, /Check the migration claims twice\./);
});

// #1272: from #1259 going live, every turn under the service had no Citadel tools: the runner's spec.json left out the
// pool, so the wrapper never set CITADEL_POOL_PORT and Claude Code refused mcp.json's url as written. The real CLI can't
// run in CI (the runner may lack it, and a skip there is red), so a stand-in does what Claude Code does with the config:
// fill in ${VAR} and ${VAR:-default} from its env, leaving an unset one as written, refuse a server whose url doesn't
// parse, and list each server's tools over HTTP with its headers. The turn runs through the runner's own wrapper and pool.
test('a pooled turn gets its Citadel tools: the wrapper starts its pool and Claude Code can reach it from mcp.json', async () => {
  const { createServer } = await import('node:http');
  const { readPool } = await import('../src/pool-client.mjs');
  // The pool's calls back to the app go here, never to the live server the runner's env names.
  const app = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'));
  const appPort = await tmp.serve(app);
  const standIn = join(root, 'stand-in-claude.mjs');
  const out = join(root, 'stand-in-claude.json');
  writeFileSync(
    standIn,
    `
    import { readFileSync, writeFileSync } from 'node:fs';
    const fill = (s) => s.replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\\}/g, (m, k, d) => process.env[k] ?? d ?? m);
    const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--mcp-config') + 1], 'utf8'));
    const servers = {};
    for (const [name, s] of Object.entries(config.mcpServers)) {
      if (s.type !== 'http') { servers[name] = { status: 'stdio' }; continue; }
      const url = fill(s.url);
      try { new URL(url); } catch { servers[name] = { status: 'failed', error: "'url' is not a valid URL: " + url }; continue; }
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
      for (const [k, v] of Object.entries(s.headers ?? {})) headers[k] = fill(v);
      const rpc = async (id, method) => {
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stand-in', version: '1' } } : {} }) });
        const text = await res.text();
        if (!res.ok) throw new Error(res.status + ' ' + text);
        const data = text.split('\\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
        return JSON.parse(data.length ? data[data.length - 1] : text);
      };
      try {
        await rpc(1, 'initialize');
        servers[name] = { status: 'connected', tools: (await rpc(2, 'tools/list')).result.tools.map((t) => t.name) };
      } catch (e) { servers[name] = { status: 'failed', error: e.message }; }
    }
    writeFileSync(${JSON.stringify(out)}, JSON.stringify(servers));
    console.log(JSON.stringify({ type: 'result' }));`,
  );
  let pool: { pid: number } | null = null;
  let seen: any = null;
  let exit: { code: number | null } | null = null;
  runner.pool = true;
  try {
    await launch({
      peek: async (dir) => {
        // The turn as the runner launched it, with the stand-in in claude's place and the app swapped for the fake.
        const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
        spec.command = process.execPath;
        spec.args = [standIn, ...spec.args];
        spec.env = { ...spec.env, COORDINATOR_API: `http://127.0.0.1:${appPort}` };
        writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec), { mode: 0o600 });
        // The runner follows this turn too, and ends it (deleting its folder) on the poll that sees exit.json. Racing
        // that poll for the file failed under CI load (#1293): it is held off until the test has read the folder.
        const [id, live] = [...(runner as any).turns.entries()].find(([, l]: any) => l.dir === dir)!;
        clearInterval(live.timer);
        try {
          const [node, ...wrapper] = spawned[0].wrapper;
          const w = tmp.spawn(node, wrapper, { stdio: 'ignore' });
          for (let i = 0; i < 3000 && !existsSync(join(dir, 'exit.json')); i++) await wait(10);
          w.kill();
          exit = existsSync(join(dir, 'exit.json')) ? JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8')) : null;
          if (spec.pool) pool = readPool(spec.pool.dir);
          seen = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
        } finally {
          live.timer = setInterval(() => (runner as any).poll(id), runner.pollMs).unref();
        }
      },
    });
  } finally {
    runner.pool = false;
    if (pool)
      try {
        process.kill(pool!.pid, 'SIGKILL');
      } catch {}
    app.close();
  }
  assert.equal(exit?.code, 0, 'the wrapper saw the stand-in exit cleanly');
  assert.ok(seen, 'the stand-in claude ran');
  assert.equal(seen.thread.status, 'connected', `the thread server: ${seen.thread.error}`);
  assert.ok(seen.thread.tools.includes('set_thread_status'), `its tools: ${seen.thread.tools}`);
});

test('a pooled turn in a unit hands its wrapper the pool too, to start in a unit of its own', async () => {
  runner.pool = true;
  try {
    const got = await launch({ units: true });
    assert.match(got.spec.pool.script, /\/mcp-pool\.ts$/);
    assert.ok(
      got.spec.pool.systemdRun.some((a: string) => a.startsWith('--unit=citadel-mcp-pool-')),
      JSON.stringify(got.spec.pool),
    );
    assert.match(got.mcp.mcpServers.thread.url, /\$\{CITADEL_POOL_PORT\}/);
  } finally {
    runner.pool = false;
  }
});
