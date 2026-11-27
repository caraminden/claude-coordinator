// A turn's start and end make no blocking disk call or process start on the server's thread (#2137): each one waited
// on btrfs while minions' tests and ships wrote to the same disk, and nobody was answered meanwhile. The trap is
// test/off-thread-fs.test.ts's, kept here so the turn's own cases don't share a file three other minions edit.
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { ClaudeLink } from '../src/claude-link.ts';
import { Containers, type RunCmd } from '../src/containers.ts';
import { ContraptionTurns, parseTurn, type ClaudePlaces } from '../src/contraption-turns.ts';
import { Contraptions } from '../src/contraptions.ts';
import { Credentials } from '../src/credentials.ts';
import { Store } from '../src/db.ts';
import { fillPinSpares } from '../src/pin-spares.ts';
import { Runner } from '../src/runner.ts';
import { projectSlug, transcriptPath } from '../src/sessions.ts';
import { followed, releaseFake, runnerInsides, stopTurns, testPins, until } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'off-thread-turn-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
});

/** Runs `fn` and returns the blocking fs calls under `dir`, and every blocking process start, made before it settled. */
async function syncCallsUnder(dir: string, fn: () => unknown): Promise<string[]> {
  const names = ['readFileSync', 'readdirSync', 'writeFileSync', 'renameSync', 'existsSync', 'statSync', 'openSync', 'accessSync', 'mkdirSync', 'rmSync', 'linkSync', 'symlinkSync', 'cpSync', 'copyFileSync', 'appendFileSync', 'lstatSync', 'realpathSync', 'readlinkSync', 'utimesSync', 'chmodSync'] as const;
  const starts = ['execFileSync', 'execSync', 'spawnSync'] as const;
  const real = Object.fromEntries(names.map((n) => [n, fs[n]]));
  const realStarts = Object.fromEntries(starts.map((n) => [n, childProcess[n]]));
  const seen: string[] = [];
  for (const n of names)
    (fs as Record<string, unknown>)[n] = (p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.startsWith(dir)) seen.push(`${n} ${p.slice(dir.length)}`);
      return (real[n] as (...args: unknown[]) => unknown)(p, ...rest);
    };
  for (const n of starts)
    (childProcess as Record<string, unknown>)[n] = (cmd: unknown, ...rest: unknown[]) => {
      seen.push(`${n} ${String(cmd)} ${Array.isArray(rest[0]) ? rest[0].join(' ') : ''}`);
      return (realStarts[n] as (...args: unknown[]) => unknown)(cmd, ...rest);
    };
  syncBuiltinESMExports();
  try {
    await fn();
  } finally {
    for (const n of names) (fs as Record<string, unknown>)[n] = real[n];
    for (const n of starts) (childProcess as Record<string, unknown>)[n] = realStarts[n];
    syncBuiltinESMExports();
  }
  return seen;
}

/** A server's data folder with a scheme whose repo has a land script, a build branch, an agent file and a plugin folder. */
async function box(name: string) {
  const data = join(root, name);
  mkdirSync(data);
  testPins(data);
  await fillPinSpares();
  process.env.CLAUDE_CONFIG_DIR = join(data, 'claude');
  const claude = releaseFake(data);
  const store = new Store(join(data, 'db.sqlite'));
  store.typedHandlesUpTo = 0;
  const runner = new Runner(
    store,
    () => {},
    () => ({}),
    claude.fake,
  );
  runner.pollMs = 20;
  const repo = join(data, 'repo');
  mkdirSync(join(repo, 'tools'), { recursive: true });
  mkdirSync(join(repo, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(repo, 'tools', 'land.sh'), '#!/bin/sh\n# --into build/<n>\n');
  writeFileSync(join(repo, '.claude', 'agents', 'judge.md'), '---\nname: judge\ndescription: Judges.\n---\nJudge it.\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
  git('branch', 'build/3');
  const p = store.createProject('Turns', null);
  store.setProjectRepoDir(p.id, repo);
  // The server runs this scheme's code: the start asks git whether its commit is in the repo.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  runner.liveHead = () => head;
  const minion = (title: string) => {
    const t = store.createTicket({ project_id: p.id, title, permission_mode: 'bypassPermissions', created_by: 'Cara' });
    const cwd = join(data, `wt-${t.id}`);
    mkdirSync(cwd);
    store.setTicketDir(t.id, cwd, null);
    store.updateTicket(t.id, { build: 3 });
    return store.getTicket(t.id)!;
  };
  return { data, store, runner, claude, minion };
}

test("a minion's turn starts, takes a message and ends with no blocking disk call or process start on the server's thread", async () => {
  const { data, store, runner, claude, minion } = await box('minion');
  const t = minion('Whole turn');
  claude.setRelease(null);
  const started = await syncCallsUnder(data, async () => {
    runner.send(t.id, 'Cara', 'Go');
    await until('the turn is running', () => followed(runner, t.id));
  });
  assert.deepEqual(started, []);
  const dir = runnerInsides(runner).turns.get(t.id)!.dir;
  // The start did its work: the prompt says it is in a build that merges into its branch.
  assert.match(readFileSync(join(dir, 'prompt.jsonl'), 'utf8'), /Go/);
  assert.match(readFileSync(join(dir, 'system-prompt.md'), 'utf8') + readFileSync(join(dir, 'prompt.jsonl'), 'utf8'), /build\/3/);

  // A message into the running turn: in its steer file, in order, with the first one's end where the second starts.
  const steered = await syncCallsUnder(data, async () => {
    assert.equal(JSON.parse(runner.send(t.id, 'Cara', 'And this', [], {}, true).event.data).steered, true);
    assert.equal(JSON.parse(runner.send(t.id, 'Cara', 'And that', [], {}, true).event.data).steered, true);
    await until('both are in the steer file', async () => /And this[^]*And that/.test(await readFile(join(dir, 'steer.jsonl'), 'utf8')));
  });
  assert.deepEqual(steered, []);

  // Claude Code's transcript says what effort its default was: the end reads it into a thread that has none yet.
  const session = '11111111-2222-4333-8444-555555555555';
  store.updateTicket(t.id, { session_id: session });
  const transcript = transcriptPath(process.env.CLAUDE_CONFIG_DIR!, t.cwd!, session)!;
  await mkdir(dirname(transcript), { recursive: true });
  await writeFile(transcript, '{"effort":"high"}\n');
  const ended = await syncCallsUnder(data, async () => {
    claude.setRelease('ok');
    await until('the turn ended and its session is saved', () => store.getTicket(t.id)!.status === 'idle' && !runner.isRunning(t.id));
    // Read off the thread too, so it lands just after the turn goes idle.
    await until('the effort its transcript names is recorded', () => store.getTicket(t.id)!.last_effort === 'high');
    await until("the turn's folder is gone", () =>
      access(dir).then(
        () => false,
        () => true,
      ),
    );
  });
  // setRelease is this test's own write.
  assert.deepEqual(
    ended.filter((c) => !/\/release(\.tmp)?$/.test(c)),
    [],
  );
});

test("an app's turn starts and ends with no blocking disk call or process start on the server's thread", async () => {
  const data = join(root, 'app');
  mkdirSync(data);
  const store = new Store(join(data, 'db.sqlite'));
  const scheme = store.createProject('Home', null);
  const c = new Contraptions(store, 's'.repeat(40), join(data, 'keys')).register({ name: 'mandate', title: 'Mandate', port: 9101, icon: null, home_scheme: scheme.id, open_paths: '[]', default_model: null, turn_cap: null });
  const person = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
  store.setContraptionUser(c.id, person.id, true, person.id);
  // claude: notes what it resumed, writes its transcript where claude keeps it, and replies.
  const log = join(data, 'claude.log');
  const fake = join(data, 'claude-fake');
  writeFileSync(
    fake,
    `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const argv = process.argv.slice(2), opt = (n) => argv[argv.indexOf(n) + 1];
process.stdin.once('data', () => {
  const session = argv.includes('--resume') ? opt('--resume') : opt('--session-id');
  fs.appendFileSync(${JSON.stringify(log)}, (argv.includes('--resume') ? 'resume ' : 'new ') + session + '\\n');
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, session + '.jsonl'), '{}\\n');
  const out = (o) => console.log(JSON.stringify(o));
  out({ type: 'system', subtype: 'init', session_id: session, tools: [] });
  out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Done.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'Done.', usage: {} });
  process.exit(0);
});
`,
  );
  chmodSync(fake, 0o755);
  // Two accounts: the session's newest transcript is on the other one, so the start carries it over before resuming.
  const [mine, other] = [join(data, 'claude'), join(data, 'claude2')];
  const places: ClaudePlaces = { place: () => ({ host: true }), codexPlace: () => null, expire: () => {}, configDirs: () => [mine, other], limitedView: () => null };
  const turns = new ContraptionTurns(store, new Contraptions(store, 's'.repeat(40), join(data, 'keys')), places, { dataDir: data, claudeBin: fake, env: { PATH: process.env.PATH, HOME: data, CLAUDE_CONFIG_DIR: mine } });
  const session = '11111111-2222-4333-8444-555555555555';
  store.putContraptionSession(c.id, person.id, 'chat', session);
  const cwd = join(data, 'contraption-scratch', 'mandate', String(person.id));
  await mkdir(join(other, 'projects', projectSlug(cwd)), { recursive: true });
  await writeFile(join(other, 'projects', projectSlug(cwd), `${session}.jsonl`), '{"prompt":"before"}\n');
  const events: string[] = [];
  const calls = await syncCallsUnder(data, () => turns.run(c, parseTurn({ person: person.id, session: 'chat', prompt: 'Hello', keep: true, mcp: [] }, c), (event) => events.push(event)));
  assert.deepEqual(calls, []);
  // The turn did its work: it resumed the carried-over session, ended well, kept itself for replays, and left no turn folder.
  assert.deepEqual(
    events.filter((e) => e === 'start' || e === 'end' || e === 'error'),
    ['start', 'end'],
  );
  assert.equal(readFileSync(log, 'utf8'), `resume ${session}\n`);
  assert.match(readFileSync(join(mine, 'projects', projectSlug(cwd), `${session}.jsonl`), 'utf8'), /before[^]*\{\}/);
  const kept = join(data, 'projects', String(scheme.id), 'shared', 'project', '.replay', 'mandate');
  assert.equal(fs.readdirSync(kept).length, 1);
  assert.deepEqual(fs.readdirSync(join(data, 'run', 'contraption-turns')), []);
});

test("a container minion turn's start (its container's spec, folders and Gradle files) makes no blocking disk call on the server's thread", async () => {
  const data = join(root, 'container');
  mkdirSync(data);
  process.env.CLAUDE_CONFIG_DIR = join(data, 'host-claude');
  const store = new Store(join(data, 'db.sqlite'));
  store.setProjectRepoDir(store.createProject('Turns', null).id, join(data, 'repo'));
  const person = store.createUser({ name: 'Josh', login: 'josh', admin: true });
  // The host's home: a tool folder to mount and Gradle's defaults to copy into the person's volume.
  const home = join(data, 'home');
  await mkdir(join(home, '.cargo', 'bin'), { recursive: true });
  await mkdir(join(home, '.gradle'), { recursive: true });
  await writeFile(join(home, '.gradle', 'gradle.properties'), 'org.gradle.daemon=false\n');
  const vol = join(data, 'vol');
  const ran: string[] = [];
  const run: RunCmd = async (cmd, args) => {
    ran.push([cmd, ...args].join(' '));
    if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: `${vol}\n`, stderr: '' };
    // Running from an older spec: the start replaces it, then sees it running.
    if (args[0] === 'container' && args[1] === 'inspect') return { code: 0, stdout: 'true old\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const claude = join(data, 'bin', 'claude');
  await mkdir(dirname(claude), { recursive: true });
  await writeFile(claude, '');
  const link = new ClaudeLink(store, new Credentials(store, 'x'.repeat(40)), data, claude, new Containers(run), 'citadel-claude-t-');
  Object.defineProperty(link, 'home', { value: home }); // its private home is the host's, homedir()
  const calls = await syncCallsUnder(data, () => link.ensure(person.id, true));
  assert.deepEqual(calls, []);
  // The start did its work: the person's volume has Gradle's defaults and the build cache's init script, and the container started.
  assert.equal(readFileSync(join(vol, '.gradle', 'gradle.properties'), 'utf8'), 'org.gradle.daemon=false\n');
  assert.ok(fs.readdirSync(join(vol, '.gradle', 'init.d')).length);
  assert.ok(
    ran.some((r) => r.includes(join(home, '.cargo', 'bin'))),
    "the host's tool folder is mounted",
  );
});
