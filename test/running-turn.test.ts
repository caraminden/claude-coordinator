import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { lines, tempRoot, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// A running turn, by the kind of process it is (#1937): what signal, stop, liveness and re-attach after a restart do for
// each. Driven through the Runner on turns a "previous server" saved, with real processes in the turn folder's shape
// (a wrapper named by its folder, a claude in a process group of its own) and fake podman, systemctl and systemd-run.
const tmp = tempRoot('running-turn-');
const root = tmp.dir;
const procs: ChildProcess[] = [];
after(async () => {
  // The fake claudes ignore SIGTERM, as a stop's grace period needs.
  for (const p of procs) p.kill('SIGKILL');
  await tmp.teardown();
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
process.env.CITADEL_SUPERVISOR_RETRY_MS = '1';

const bin = join(root, 'bin');
mkdirSync(bin);
for (const cmd of ['podman', 'systemctl', 'systemd-run']) {
  // podman exec <container> <command…> runs the command here: these "container" pids are the host's.
  writeFileSync(join(bin, cmd), `#!/bin/sh\necho "${cmd} $*" >> "${bin}/calls"\n${cmd === 'podman' ? 'shift 2; exec "$@"\n' : ''}`);
  chmodSync(join(bin, cmd), 0o755);
}
process.env.PATH = `${bin}:${process.env.PATH}`;
/** What was run on `name`'s behalf: calls that mention it. */
const calls = (name: string) => lines(join(bin, 'calls')).filter((l) => l.includes(name));

const wrapperJs = join(root, 'turn-wrapper.mjs');
writeFileSync(wrapperJs, `setInterval(() => {}, 1000);\n`);
const claudeJs = join(root, 'claude.mjs');
writeFileSync(
  claudeJs,
  `import { appendFileSync } from 'node:fs';
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => appendFileSync(process.argv[2], s + '\\n'));
setInterval(() => {}, 1000);
appendFileSync(process.argv[2], 'up\\n');
`,
);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const turnsDir = join(root, 'run', 'turns');
let n = 0;

type Kind = 'child' | 'unit' | 'supervisor' | 'container';
const KINDS: Kind[] = ['child', 'unit', 'supervisor', 'container'];

const run = (args: string[], detached = false) => {
  const p = tmp.spawn(process.execPath, args, { detached, stdio: 'ignore' });
  procs.push(p);
  return p;
};

/** A turn a previous server left running: its folder and its saved record; with `claude`, its processes too. */
async function left(kind: Kind, opts: { claude?: boolean; supervisor?: number } = {}) {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const work = join(root, `t${t.id}`);
  mkdirSync(work);
  store.setTicketDir(t.id, work, null);
  const dir = join(turnsDir, `${t.id}-${Date.now() + n++}`);
  mkdirSync(dir, { recursive: true });
  const unit = kind === 'unit' || kind === 'supervisor' ? `citadel-turn-test-${basename(dir)}` : null;
  const container = kind === 'container' ? `citadel-claude-test-${t.id}` : null;
  if (container) {
    writeFileSync(join(dir, 'container'), container);
    writeFileSync(join(dir, 'beat'), '');
  }
  writeFileSync(join(dir, 'stream.jsonl'), '');
  const log = join(work, 'signals');
  const claude = opts.claude === false ? null : run([claudeJs, log], true);
  const wrapper = claude && run([wrapperJs, dir]);
  if (claude && wrapper) {
    await until('claude to be up', () => lines(log).includes('up'));
    await until('its wrapper to be up', () => readFileSync(`/proc/${wrapper.pid}/cmdline`, 'utf8').includes(dir));
    writeFileSync(join(dir, 'pid.json'), JSON.stringify({ wrapper: wrapper.pid, claude: claude.pid, ...(kind === 'supervisor' ? { supervisor: opts.supervisor ?? process.pid } : {}) }));
  }
  store.updateTicket(t.id, { status: 'running' });
  // Its resumes are spent, so a turn found gone ends there and starts no other.
  store.setSetting(`turn:${t.id}`, { dir, unit, offset: 0, startedAt: Date.now(), configDir: join(root, 'claude'), person: null, asker: null, typedBy: null, hashes: {}, retries: { restart: 2, kill: 1 }, ...(container ? { container } : {}) });
  return { id: t.id, dir, unit, container, log, claude: claude!, wrapper: wrapper! };
}

const servers: Runner[] = [];
after(() => servers.forEach((r) => r.detachAll()));
/** The next server, which has recovered. */
function server() {
  const r = new Runner(
    store,
    () => {},
    () => ({}),
    join(root, 'no-claude'),
  );
  r.pollMs = 10;
  r.stopKillMs = 600_000; // a stop's SIGKILL retry stops the unit too: never in a test's time
  r.recover();
  servers.push(r);
  return r;
}
/** End a turn as its wrapper does, and wait until the server has finished it. */
async function end(r: Runner, t: { id: number; dir: string }, exit: object = { code: 0, signal: null }) {
  writeFileSync(join(t.dir, 'exit.json'), JSON.stringify(exit));
  await until('the turn to end', () => !r.isRunning(t.id));
}
const notes = (id: number) =>
  store
    .listEvents(id)
    .filter((e) => e.kind === 'note')
    .map((e) => JSON.parse(e.data).text as string);

for (const kind of KINDS) {
  test(`${kind}: a running turn is re-attached, and says whether a restart would end it`, async () => {
    const t = await left(kind);
    const r = server();
    assert.ok(r.isRunning(t.id));
    assert.equal(r.interruptible(), kind === 'child' ? 1 : 0);
    assert.deepEqual(r.interruptibleTurns(), kind === 'child' ? [t.id] : []);
    await end(r, t);
    assert.ok(!notes(t.id).some((s) => /restarted/.test(s)), 'no interruption');
  });

  test(`${kind}: signal reaches claude, and SIGKILL what its unit still holds`, async () => {
    const t = await left(kind);
    const r = server();
    const at = { dir: t.dir, unit: t.unit, container: t.container };
    r.signal(at, 'SIGTERM');
    await until('claude to get SIGTERM', () => lines(t.log).includes('SIGTERM'));
    if (kind === 'container') assert.deepEqual(calls(t.container!), [`podman exec ${t.container} sh -c kill -TERM -${t.claude.pid} 2>/dev/null || kill -TERM ${t.claude.pid}`]);
    else assert.deepEqual(calls(basename(t.dir)), [], 'a started claude is signalled by its process group alone');
    const dead = new Promise((ok) => t.claude.once('exit', (_code, sig) => ok(sig)));
    r.signal(at, 'SIGKILL');
    assert.equal(await dead, 'SIGKILL');
    if (t.unit) await until('its unit to be stopped', () => calls(t.unit!).join() === `systemctl --user stop ${t.unit}.*`);
    else if (kind === 'child') assert.deepEqual(calls(basename(t.dir)), []);
    await end(r, t, { code: null, signal: 'SIGKILL' });
  });

  test(`${kind}: Stop interrupts claude, and the turn ends as stopped`, async () => {
    const t = await left(kind);
    const r = server();
    assert.ok(r.stop(t.id));
    await until('claude to get SIGINT', () => lines(t.log).includes('SIGINT'));
    assert.ok(!lines(t.log).includes('SIGTERM'), 'SIGINT first, so it can write its result');
    assert.ok(!existsSync(join(t.dir, 'exit.json')), "the wrapper's exit ends it, not the server's word");
    await end(r, t, { code: 130, signal: null });
    assert.equal(store.getTicket(t.id)!.status, 'idle');
  });

  test(`${kind}: Stop before claude has started`, async () => {
    const t = await left(kind, { claude: false });
    if (kind === 'container') writeFileSync(join(t.dir, 'pid.json'), '{}'); // re-attached only once its wrapper has run
    const r = server();
    assert.ok(r.isRunning(t.id));
    if (kind === 'container') rmSync(join(t.dir, 'pid.json'));
    r.stop(t.id);
    if (kind === 'container') {
      // Nothing to signal and nothing that will write its exit: the server writes one.
      await until('the turn to end', () => !r.isRunning(t.id));
      assert.deepEqual(calls(t.container!), []);
      return;
    }
    assert.ok(!existsSync(join(t.dir, 'exit.json')), 'its wrapper or the SIGKILL retry ends it');
    if (t.unit) await until('its unit to be stopped', () => calls(t.unit!).join() === `systemctl --user stop ${t.unit}.*`);
    else assert.deepEqual(calls(basename(t.dir)), []);
    await end(r, t, { code: null, signal: null });
  });

  test(`${kind}: a turn whose process is gone without a word ends`, async () => {
    const t = await left(kind);
    const r = server();
    // A pid reused by another program isn't its wrapper, so the pid here goes on living.
    const other = run([claudeJs, t.log]);
    writeFileSync(join(t.dir, 'pid.json'), JSON.stringify({ wrapper: other.pid, claude: t.claude.pid }));
    if (kind === 'container') {
      // Its pids are the container's, so it goes by its beat, then by whether its wrapper is there (claude-container.test.ts).
      utimesSync(join(t.dir, 'beat'), new Date(0), new Date(0));
      t.wrapper.kill('SIGKILL');
    }
    await until('the turn to end', () => !r.isRunning(t.id));
    assert.match(`${store.getTicket(t.id)!.note}`, /The turn's process was killed before it finished/);
  });

  test(`${kind}: a turn that died with the last server counts as interrupted`, async () => {
    const t = await left(kind);
    t.wrapper.kill('SIGKILL');
    await new Promise((ok) => ((t.wrapper.exitCode ?? t.wrapper.signalCode) !== null ? ok(0) : t.wrapper.once('exit', ok)));
    if (kind === 'container') utimesSync(join(t.dir, 'beat'), new Date(0), new Date(0));
    const r = server();
    assert.ok(!r.isRunning(t.id));
    assert.match(notes(t.id).join('\n'), /The server restarted during this turn/);
    assert.ok(!existsSync(t.dir));
  });

  test(`${kind}: a turn the last server was still starting`, async () => {
    const t = await left(kind, { claude: false });
    const r = server();
    // A unit, or a detached child, starts on without the server; a container's start chain died with it, its beat fresh or not (#468 S03-5).
    assert.equal(r.isRunning(t.id), kind !== 'container');
    if (kind === 'container') return assert.match(notes(t.id).join('\n'), /The server restarted during this turn/);
    await end(r, t);
  });

  test(`${kind}: "Is this still going?" looks at its process, or says why it can't`, async () => {
    const t = await left(kind);
    const r = server();
    const look = await r.checkTurn(t.id);
    if (kind === 'container') assert.deepEqual(look, { verdict: 'unknown', text: "This turn runs in a container, so the server can't look at its process." });
    else assert.match(look!.verdict, /^(busy|idle)$/);
    await end(r, t);
  });

  test(`${kind}: only a supervisor turn whose supervisor is gone gets it started again`, async () => {
    const gone = 2 ** 22 + 1; // past pid_max's default, so no process
    const t = await left(kind, { supervisor: gone });
    const r = server();
    const turns = (r as unknown as { turns: Map<number, { ticks: number }> }).turns;
    const before = calls('citadel-supervisor').length;
    r.supervisor = true;
    if (kind === 'supervisor') await until('a supervisor to be started', () => calls('citadel-supervisor').length > before);
    else {
      const at = turns.get(t.id)!.ticks;
      await until('two looks at it', () => turns.get(t.id)!.ticks > at + 45);
      assert.equal(calls('citadel-supervisor').length, before);
    }
    r.supervisor = false;
    await end(r, t);
  });
}

test('container: a turn whose wrapper has started but not yet written its pids is re-attached, its beat fresh or not', async () => {
  const t = await left('container');
  rmSync(join(t.dir, 'pid.json'));
  utimesSync(join(t.dir, 'beat'), new Date(0), new Date(0));
  const r = server();
  assert.ok(r.isRunning(t.id), 'a live process still uses its folder');
  assert.ok(existsSync(t.dir));
  await end(r, t);
});
