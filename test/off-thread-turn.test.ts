// A turn's start and end make no blocking disk call or process start on the server's thread (#2137): each one waited
// on btrfs while minions' tests and ships wrote to the same disk, and nobody was answered meanwhile. The trap is
// test/off-thread-fs.test.ts's, kept here so the turn's own cases don't share a file three other minions edit.
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { fillPinSpares } from '../src/pin-spares.ts';
import { Runner } from '../src/runner.ts';
import { transcriptPath } from '../src/sessions.ts';
import { followed, releaseFake, runnerInsides, stopTurns, testPins, until } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'off-thread-turn-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
});

// The running turn's 250 ms poll is handoffs/sync-disk-turn-stream.md's: its looks at these files aren't the start or the end.
const POLL = /^(existsSync|readFileSync|openSync|rmSync) .*\/(exit|pid)\.json$|^openSync .*\/stream\.jsonl$/;
// Build 7's look for a `machine` file, made only for a turn with no unit and no container (a test's, a machine's): the server's own turns run in units.
const MACHINE = /^readFileSync .*\/machine$/;

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
  return seen.filter((c) => !POLL.test(c) && !MACHINE.test(c));
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
