import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';

// Turns run in a process of their own (src/turn-wrapper.ts) and write to a turn folder, so a server
// that dies mid-turn leaves the turn running, and the next server re-attaches and catches up. Here the
// wrapper is a detached child, which outlives a Runner just as a unit outlives the service.
const root = mkdtempSync(join(tmpdir(), 'turn-survives-'));
after(() => rmSync(root, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
// The live service's bus address; a turn must not inherit it.
process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/0/bus';
const fake = join(root, 'claude-fake');
const release = join(root, 'release');
const seen = join(root, 'seen.jsonl');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync } = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env), input }) + '\\n');
  const say = (text) => console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }));
  say(input.includes('big line') ? 'x'.repeat(1.5e6) : 'working on it');
  const wait = setInterval(() => {
    if (!existsSync(${JSON.stringify(release)})) return;
    clearInterval(wait);
    say('all done');
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'all done' }));
    process.exit(0);
  }, 20);
});
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);

/** A runner as a freshly started server would make it. */
function server() {
  const r = new Runner(store, () => {}, () => ({ COORDINATOR_TOKEN: 'secret' }), fake);
  r.resumeGapMs = 10;
  r.pollMs = 10;
  return r;
}

function newTicket() {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  return t.id;
}

async function until(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), 'timed out');
}

const texts = (id: number) =>
  store.listEvents(id).filter((e) => e.kind === 'claude').flatMap((e) => JSON.parse(e.data).message?.content ?? []).map((b: any) => b.text);
const notes = (id: number) => store.listEvents(id).filter((e) => e.kind === 'note').map((e) => JSON.parse(e.data).text as string);
const turnDir = (r: Runner, id: number): string => (r as any).turns.get(id).dir;

/** Start a turn and let it get going: its first line handled, so the old server has seen part of the stream. */
async function started(id: number, text = 'build it') {
  rmSync(release, { force: true });
  const r = server();
  r.send(id, 'Cara', text);
  await until(() => texts(id).length > 0);
  return r;
}

test('a turn outlives its server, and the next one re-attaches and shows the rest exactly once', async () => {
  const id = newTicket();
  const before = await started(id);
  const dir = turnDir(before, id);
  before.detachAll();

  const next = server();
  next.recover();
  assert.ok(next.isRunning(id));
  assert.equal(store.getTicket(id)!.status, 'running');
  writeFileSync(release, '');
  await until(() => !next.isRunning(id));
  assert.deepEqual(texts(id), ['working on it', 'all done']);
  assert.equal(store.getTicket(id)!.status, 'idle');
  assert.ok(!notes(id).some((n) => /restart/i.test(n)), 'no interruption note, no resume');
  assert.equal(store.getSetting(`turn:${id}`), null);
  assert.ok(!existsSync(dir), 'the turn folder is cleaned up');
});

test('a turn that ends while no server is running is finished by the next one', async () => {
  const id = newTicket();
  const before = await started(id);
  const dir = turnDir(before, id);
  before.detachAll();
  writeFileSync(release, '');
  await until(() => existsSync(join(dir, 'exit.json')));

  const next = server();
  next.recover();
  await until(() => !next.isRunning(id));
  assert.deepEqual(texts(id), ['working on it', 'all done']);
  assert.equal(store.getTicket(id)!.status, 'idle');
});

test('a re-attached turn can be stopped, and messages queued behind it survive the restart', async () => {
  const stopped = newTicket();
  const queued = newTicket();
  const a = await started(stopped);
  const b = await started(queued);
  b.send(queued, 'Josh', 'and then this');
  a.detachAll();
  b.detachAll();

  const next = server();
  next.recover();
  assert.equal(next.queued(queued), 1);
  assert.ok(next.stop(stopped));
  await until(() => !next.isRunning(stopped));
  assert.equal(store.getTicket(stopped)!.status, 'idle');
  assert.ok(notes(stopped).includes('Stopped by user.'));

  writeFileSync(release, '');
  // The queued message runs as the next turn once the re-attached one ends.
  await until(() => readFileSync(seen, 'utf8').includes('and then this'));
  await until(() => !next.isRunning(queued));
});

test('the turn keeps its own tripwire and MCP copies, the env allowlist, and no token on disk', async () => {
  const id = newTicket();
  const r = await started(id);
  const dir = turnDir(r, id);
  const run = JSON.parse(readFileSync(seen, 'utf8').trim().split('\n').at(-1)!);
  const settings = JSON.parse(readFileSync(run.argv[run.argv.indexOf('--settings') + 1], 'utf8'));
  const hook = settings.hooks.PreToolUse[0].hooks[0].command.split(' ')[1].slice(1, -1);
  assert.equal(hook, join(dir, 'pin', 'tripwire.ts'));
  assert.ok(existsSync(hook));
  const mcp = JSON.parse(run.argv[run.argv.indexOf('--mcp-config') + 1]).mcpServers.thread.args[0];
  assert.equal(mcp, join(dir, 'pin', 'mcp.ts'));
  assert.ok(run.env.includes('COORDINATOR_TOKEN'));
  assert.ok(!run.env.includes('DBUS_SESSION_BUS_ADDRESS'));
  assert.ok(!existsSync(join(dir, 'spec.json')), 'the wrapper deletes the spec, which holds the token');
  writeFileSync(release, '');
  await until(() => !r.isRunning(id));
});

test('a stream line longer than the read buffer arrives whole', async () => {
  const id = newTicket();
  const r = await started(id, 'big line please');
  writeFileSync(release, '');
  await until(() => !r.isRunning(id));
  assert.equal(texts(id)[0].length, 1.5e6);
  assert.equal(texts(id)[1], 'all done');
});

test('a command too long to start is reported at once, not as a turn killed a minute later', () => {
  // spawn throws E2BIG rather than emitting 'error'; the wrapper must still write exit.json.
  const dir = mkdtempSync(join(tmpdir(), 'wrapper-e2big-'));
  for (const f of ['prompt.jsonl', 'stream.jsonl', 'stderr.log']) writeFileSync(join(dir, f), '');
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ command: 'true', args: ['x'.repeat(200 * 1024)], cwd: dir, env: { PATH: process.env.PATH } }));
  spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'turn-wrapper.ts'), dir]);
  const exit = JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8'));
  assert.match(exit.error, /E2BIG/);
  assert.match(readFileSync(join(dir, 'stderr.log'), 'utf8'), /Could not start true: .*E2BIG/);
  rmSync(dir, { recursive: true, force: true });
});
