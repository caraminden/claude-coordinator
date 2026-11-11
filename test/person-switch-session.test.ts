import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { gzipSync } from 'node:zlib';
import { projectSlug } from '../src/sessions.ts';
import { jsonLines, stopTurns, testPins } from './helpers.ts';
testPins();

// #250: a minion whose turns move from one Claude login to another between turns (Josh's container,
// then the host's login for Cara) must still resume its conversation there. The fake claude keeps
// transcripts in its own CLAUDE_CONFIG_DIR, as the real one does, and fails a --resume it can't find.
const root = mkdtempSync(join(tmpdir(), 'person-switch-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
const hostConfig = join(root, 'host-claude');
process.env.CLAUDE_CONFIG_DIR = hostConfig;
const bin = join(root, 'bin');
mkdirSync(bin);
// A fake podman whose exec runs on the host, as in claude-container.test.ts.
writeFileSync(
  join(bin, 'podman'),
  `#!${process.execPath}
const { spawn, spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] !== 'exec') process.exit(0);
const detached = args[1] === '-d';
const [cmd, ...rest] = args.slice(detached ? 3 : 2);
const run = cmd === 'node' ? process.execPath : cmd;
if (detached) spawn(run, rest, { detached: true, stdio: 'ignore' }).unref();
else process.exit(spawnSync(run, rest, { stdio: 'inherit' }).status ?? 1);
`,
);
chmodSync(join(bin, 'podman'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const seen = join(root, 'seen.jsonl');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const at = args.indexOf('--resume');
const resume = at >= 0 ? args[at + 1] : null;
const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
  appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ config: process.env.CLAUDE_CONFIG_DIR, resume }) + '\\n');
  if (resume && !existsSync(join(dir, resume + '.jsonl'))) {
    console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'No conversation found with session ID: ' + resume }));
    process.exit(1);
  }
  const id = resume ?? 'sess-' + Date.now();
  mkdirSync(dir, { recursive: true });
  // A transcript big enough that gzipping it takes a moment, as a real one does.
  appendFileSync(join(dir, id + '.jsonl'), JSON.stringify({ turn: Date.now(), pad: 'x'.repeat(4_000_000) }) + '\\n');
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: id }));
  process.exit(0);
});
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const josh = store.createUser({ name: 'Josh', login: 'josh' });
const cara = store.createUser({ name: 'Cara', login: 'cara', server_login: true });
const volume = join(root, 'josh-volume');
mkdirSync(join(volume, '.claude'), { recursive: true });
const joshPlace = { host: false as const, container: 'citadel-claude-test-2', configDir: join(volume, '.claude'), home: volume, turnsDir: join(root, 'run', 'turns', 'person-2'), env: { HOME: volume, CLAUDE_CONFIG_DIR: join(volume, '.claude'), DISABLE_AUTOUPDATER: '1' }, ensure: async () => {} };

function runner() {
  const r = new Runner(store, () => {}, () => ({ COORDINATOR_TOKEN: 'secret' }), fake);
  r.resumeGapMs = 10;
  r.pollMs = 10;
  r.personOf = (author) => (author === 'Josh' ? josh.id : author === 'Cara' ? cara.id : null);
  r.placeFor = (uid) => (uid === josh.id ? joshPlace : { host: true });
  return r;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), 'timed out');
}
const turns = () => jsonLines(seen);
const notes = (id: number) => store.listEvents(id).filter((e) => e.kind === 'note').map((e) => JSON.parse(e.data).text as string);

test("a message that arrives during Josh's turn, from Cara, resumes the same conversation on the host's login", async () => {
  rmSync(seen, { force: true });
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Josh' });
  const cwd = join(root, 'wt-1');
  mkdirSync(cwd);
  store.setTicketDir(t.id, cwd, null);
  const r = runner();
  r.send(t.id, 'Josh', 'build it');
  await until(() => store.getTicket(t.id)!.status === 'running');
  // Cara answers while Josh's turn still runs: her turn starts the moment his ends.
  r.send(t.id, 'Cara', 'merge and ship');
  await until(() => turns().length === 2 && store.getTicket(t.id)!.status !== 'running');
  const [first, second] = turns();
  assert.equal(first.config, join(volume, '.claude'));
  assert.equal(second.config, hostConfig);
  assert.equal(second.resume, store.getTicket(t.id)!.session_id, 'resumed the same session');
  assert.ok(existsSync(join(hostConfig, 'projects', projectSlug(cwd), `${second.resume}.jsonl`)), "Josh's transcript was brought over before Cara's turn");
  assert.equal(store.getTicket(t.id)!.status, 'idle');
});

test('a session nobody has a copy of starts fresh with a note, instead of failing every turn', async () => {
  rmSync(seen, { force: true });
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(root, 'wt-2');
  mkdirSync(cwd);
  store.setTicketDir(t.id, cwd, null);
  store.updateTicket(t.id, { session_id: 'lost-session', person_id: cara.id });
  const r = runner();
  r.send(t.id, 'Cara', 'hello?');
  await until(() => turns().length === 1 && store.getTicket(t.id)!.status !== 'running');
  assert.equal(turns()[0].resume, null, 'no --resume of a transcript that is nowhere');
  assert.equal(store.getTicket(t.id)!.status, 'idle');
  assert.notEqual(store.getTicket(t.id)!.session_id, 'lost-session');
  assert.ok(notes(t.id).some((n) => /fresh session/.test(n) && n.includes('lost-session')), notes(t.id).join('\n'));
});

test("a restore that fails doesn't cost the database its copy: the turn resumes, fails, and the next one recovers", async () => {
  rmSync(seen, { force: true });
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(root, 'wt-3');
  mkdirSync(cwd);
  store.setTicketDir(t.id, cwd, null);
  store.updateTicket(t.id, { session_id: 'kept', person_id: cara.id });
  const path = join('projects', projectSlug(cwd), 'kept.jsonl');
  const text = JSON.stringify({ turn: 0 }) + '\n';
  store.putClaudeState({ path, project_id: project.id, ticket_id: t.id, size: text.length, mtime: Date.now(), data: gzipSync(text) });
  // A file where the session's folder should be: the restore can't write there.
  mkdirSync(join(hostConfig, 'projects'), { recursive: true });
  writeFileSync(join(hostConfig, 'projects', projectSlug(cwd)), '');
  const r = runner();
  r.send(t.id, 'Cara', 'one');
  await until(() => turns().length === 1 && store.getTicket(t.id)!.status !== 'running');
  assert.equal(turns()[0].resume, 'kept');
  await new Promise((res) => setTimeout(res, 300)); // the failed turn's save
  assert.equal(store.getTicket(t.id)!.session_id, 'kept');
  assert.ok(store.getClaudeState(path), "the database's copy survives the failed turn");
  rmSync(join(hostConfig, 'projects', projectSlug(cwd)));
  r.send(t.id, 'Cara', 'two');
  await until(() => turns().length === 2 && store.getTicket(t.id)!.status !== 'running');
  assert.equal(turns()[1].resume, 'kept');
  assert.equal(store.getTicket(t.id)!.status, 'idle');
});
