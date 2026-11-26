// The server's one thread makes no synchronous file call in two paths that run while the disk is busiest (#1768): a
// card refreshing running turns' snapshots, and the flake log's read every few minutes. On Nov 24 each such call waited
// on btrfs for up to 2 s while minions' tests and ships wrote to the same disk, and nobody was answered meanwhile.
import assert from 'node:assert/strict';
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { loadDecisions } from '../src/decisions-load.ts';
import type { App } from '../src/http.ts';
import { LongJobs } from '../src/long-jobs.ts';
import { indexNote, memoryDir, readFolder, saveNote } from '../src/memory-files.ts';
import { injectBridge } from '../src/artifact-data.ts';
import { namedFiles } from '../src/brief-lint.ts';
import { listMedia, mediaFile } from '../src/contraption-media.ts';
import { Fcm } from '../src/fcm.ts';
import { hostLoad } from '../src/host-load.ts';
import { SHELL_OFF_FILE, shellOff } from '../src/shell.ts';
import { chatCommands } from '../src/slash-commands.ts';
import { commandsKey } from '../src/turn-keys.ts';
import { LandsInFlight } from '../src/release-readers.ts';
import { Releases } from '../src/releases.ts';
import { moveShip } from '../src/ship-line.ts';
import { shipLines, stopShip } from '../src/ship-stop.ts';
import * as landNewsFile from '../src/land-news.ts';
import { KitSync, templateBlobs, type KitSyncState } from '../src/kit-sync.ts';
import { FlakeFixes } from '../src/flake-fixes.ts';
import { Waits } from '../src/waits.ts';
import { Runner } from '../src/runner.ts';
import { FakeClock } from './fake-clock.ts';
import { fake } from './typed.ts';
import type { SchemeRefs } from '../src/scheme-refs.ts';
import { gzipSync } from 'node:zlib';
import { fillPinSpares, readySpares, SPARES } from '../src/pin-spares.ts';
import { fakeClaude, stopTurns, testPins, until, followed, runnerInsides } from './helpers.ts';
import { SideAsks, SIDE_IDLE_MS, SIDE_LIMIT_MS } from '../src/side-ask.ts';

type FlakeDeps = ConstructorParameters<typeof FlakeFixes>[0];
const root = mkdtempSync(join(tmpdir(), 'off-thread-fs-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
});

/** Runs `fn` and returns the synchronous fs calls made under `dir` before it returned its promise's result. */
async function syncCallsUnder<T>(dir: string, fn: () => T | Promise<T>, fds = false): Promise<string[]> {
  const names = ['readFileSync', 'readdirSync', 'writeFileSync', 'renameSync', 'existsSync', 'statSync', 'openSync', 'accessSync', 'mkdirSync', 'rmSync', 'linkSync', 'symlinkSync', 'cpSync', 'copyFileSync', 'appendFileSync', 'lstatSync', 'realpathSync', 'readlinkSync', 'utimesSync'] as const;
  const real = Object.fromEntries(names.map((n) => [n, fs[n]]));
  const seen: string[] = [];
  // A blocking process start holds the thread the same way, wherever it runs (#2111).
  const starts = ['execFileSync', 'execSync', 'spawnSync'] as const;
  const realStarts = Object.fromEntries(starts.map((n) => [n, childProcess[n]]));
  for (const n of starts)
    (childProcess as Record<string, unknown>)[n] = (cmd: unknown, ...rest: unknown[]) => {
      seen.push(`${n} ${String(cmd)}`);
      return (realStarts[n] as (...args: unknown[]) => unknown)(cmd, ...rest);
    };
  for (const n of names)
    (fs as Record<string, unknown>)[n] = (p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.startsWith(dir)) seen.push(`${n} ${p.slice(dir.length)}`);
      return (real[n] as (...args: unknown[]) => unknown)(p, ...rest);
    };
  // With `fds`, calls on an open file too, whatever file it is: a kept-open stream asked or read on the thread (#2134).
  const onFds = fds ? (['fstatSync', 'readSync'] as const) : [];
  const realFds = Object.fromEntries(onFds.map((n) => [n, fs[n]]));
  for (const n of onFds)
    (fs as Record<string, unknown>)[n] = (...args: unknown[]) => {
      seen.push(n);
      return (realFds[n] as (...args: unknown[]) => unknown)(...args);
    };
  syncBuiltinESMExports();
  try {
    await fn();
  } finally {
    for (const n of onFds) (fs as Record<string, unknown>)[n] = realFds[n];
    for (const n of names) (fs as Record<string, unknown>)[n] = real[n];
    for (const n of starts) (childProcess as Record<string, unknown>)[n] = realStarts[n];
    syncBuiltinESMExports();
  }
  return seen;
}

test("a card reaches a running turn's snapshot with no synchronous file call on the server's thread", async () => {
  const fake = join(root, 'claude');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);
  const store = new Store(join(root, 'db.sqlite'));
  store.typedHandlesUpTo = 0;
  const runner = new Runner(
    store,
    () => {},
    () => ({}),
    fake,
  );
  const clock = new FakeClock();
  runner.clock = clock;
  const p = store.createProject('Busy', null);
  const [a, b, c] = ['A', 'B', 'C'].map((title) => store.createTicket({ project_id: p.id, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }));
  const turns = join(root, 'turns');
  const dir = join(turns, 'a');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'scheme-refs.json');
  writeFileSync(file, '{}');
  runnerInsides(runner).turns.set(a.id, { dir });
  // A turn whose folder is already gone gets no file made for it.
  runnerInsides(runner).turns.set(b.id, { dir: join(turns, 'gone') });

  // Other minions' cards (C has no turn running) reach A's snapshot off the thread: the first refreshes the scheme at
  // once, the second waits for the gap's end, while the first write may still be under way.
  const calls = await syncCallsUnder(turns, async () => {
    runner.emit(c.id, 'question', { id: 'q1', questions: [{ header: 'A', question: '?' }] });
    runner.emit(c.id, 'question', { id: 'q2', questions: [{ header: 'B', question: '?' }] });
    clock.advance(2_000);
    await runner.refsWritten();
  });
  assert.deepEqual(calls, []);
  // A's own card is in its snapshot before emit returns, even with a refresh for the file still on its way: its reply
  // may be checked against the file as soon as its tool call is answered.
  runner.emit(c.id, 'question_result', { id: 'q1', answers: {} });
  clock.advance(2_000);
  runner.emit(a.id, 'question', { id: 'own', questions: [{ header: 'O', question: '?' }] });
  assert.equal(
    (JSON.parse(readFileSync(file, 'utf8')) as SchemeRefs).cards!.some((x) => x.minion === a.number),
    true,
  );
  clock.advance(2_000);
  await runner.refsWritten();
  // Writes to one file run one at a time and the newest text wins: the file is whole and has the last refresh's cards.
  const refs = JSON.parse(readFileSync(file, 'utf8')) as SchemeRefs;
  assert.equal(refs.self, a.number);
  assert.equal(refs.cards!.length, 3);
  assert.deepEqual(fs.readdirSync(dir), ['scheme-refs.json']);
  assert.equal(fs.existsSync(join(turns, 'gone')), false);
  runnerInsides(runner).turns.clear();
});

test("the flake log is read with no synchronous file call on the server's thread", async () => {
  const dir = mkdtempSync(join(root, 'flakes-'));
  const store = new Store(join(dir, 'c.db'));
  const project = store.createProject('P', null);
  const shared = join(dir, 'shared');
  mkdirSync(join(shared, 'retro-log', '2026-11-20'), { recursive: true });
  const line = (t: string, branch: string) => `- ${t}Z · flake · test/x.test.ts · load 17.0 · ticket/${branch} · in CI`;
  writeFileSync(join(shared, 'retro-log', '2026-11-20', 'land.md'), `# Retro log\n\n${[line('05:00:14', 'a'), line('05:08:44', 'b'), line('05:16:02', 'c')].join('\n')}\n`);
  const woken: string[] = [];
  const fx = new FlakeFixes(fake<FlakeDeps>({ store, sharedDir: () => shared, wake: fake<FlakeDeps['wake']>((_p: unknown, text: string) => void woken.push(text)) }));
  const now = Date.parse('2026-11-20T05:20:00Z');
  let found = 0;
  const calls = await syncCallsUnder(shared, async () => {
    found = await fx.ingest(project, now);
    await fx.alarm(project, now);
  });
  assert.deepEqual(calls, []);
  assert.equal(found, 3);
  assert.equal(woken.length, 1);
});

test("the waits poll reads the land line and the heavy folder with no synchronous file call on the server's thread", async () => {
  const dir = mkdtempSync(join(root, 'waits-'));
  const state = join(dir, 'state'),
    heavy = join(dir, 'heavy'),
    queue = join(state, 'queue');
  mkdirSync(queue, { recursive: true });
  mkdirSync(heavy);
  const store = new Store(join(dir, 'c.db'));
  const p = store.createProject('W', null);
  const t = store.createTicket({ project_id: p.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, dir, `ticket/${t.number}-x`);
  store.updateTicket(t.id, { status: 'running' });
  const nowMs = Date.now();
  writeFileSync(join(queue, '0000000001'), `100 77\n${Math.floor(nowMs / 1000) - 30}\n${`ticket/${t.number}-x`}\nrunning the tests since 14:02\norder\n`);
  writeFileSync(join(queue, '0000000002'), '200 77\n0\nticket/9-y\nwaiting\norder\n');
  writeFileSync(join(queue, '.took'), '100\n200\n');
  writeFileSync(join(queue, '.order'), '# x\n0000000002\n');
  writeFileSync(join(state, 'land-test.progress'), '3\n10\nx.test.ts\n');
  writeFileSync(join(heavy, 'slot-0.who'), 'Other #1 (cara): cargo test (since 14:02, pid 1)\n');
  writeFileSync(join(heavy, 'slot-0.progress'), '1\n2\ny.test.ts\n');
  writeFileSync(join(heavy, 'wait-5-6'), `Other #2 (cara)\ncargo test\n${Math.floor(nowMs / 1000) - 5}\nbusy\n`);
  const changed: number[] = [];
  const waits = new Waits({ store, deployState: state, heavyDir: heavy, interruptible: () => 0, changed: (id) => changed.push(id), ship: () => null, alive: () => true });
  const calls = await syncCallsUnder(dir, async () => {
    await waits.poll();
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(
    waits.line.map((x) => x.seq),
    [1, 2],
  );
  assert.equal(waits.line[0].tests?.done, 3);
});

/** A server's data folder with its pinned files and spares, a stored session, and a turn folder left by another turn. */
async function launchBox(name: string) {
  const data = join(root, name);
  mkdirSync(data);
  const pins = testPins(data);
  await fillPinSpares();
  const config = join(data, 'claude');
  process.env.CLAUDE_CONFIG_DIR = config;
  const fake = join(data, 'fake-claude');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);
  const store = new Store(join(data, 'db.sqlite'));
  store.typedHandlesUpTo = 0;
  const runner = new Runner(
    store,
    () => {},
    () => ({}),
    fake,
  );
  runner.pollMs = 600_000; // the tail of a started turn isn't the launch
  const p = store.createProject('Launch', null);
  const turns = join(data, 'run', 'turns');
  mkdirSync(join(turns, '999-1'), { recursive: true }); // another minion's old turn: the stray check reads the folder
  const minion = (title: string) => {
    const t = store.createTicket({ project_id: p.id, title, permission_mode: 'bypassPermissions', created_by: 'Cara' });
    const cwd = join(data, `wt-${t.id}`);
    mkdirSync(cwd);
    store.setTicketDir(t.id, cwd, null);
    // A stored file the config folder lacks, and one it already has: the restore checks both.
    const body = Buffer.from('{}\n');
    for (const path of [`projects/x-${t.id}/a.jsonl`, `projects/x-${t.id}/b.jsonl`]) store.putClaudeState({ path, project_id: p.id, ticket_id: t.id, size: body.length, mtime: 1_700_000_000_000, data: gzipSync(body) });
    mkdirSync(join(config, `projects/x-${t.id}`), { recursive: true });
    writeFileSync(join(config, `projects/x-${t.id}/b.jsonl`), body);
    return t;
  };
  return { pins, store, runner, turns, config, minion };
}

test("a turn launches with no synchronous file call in the run and session folders on the server's thread", async () => {
  const { runner, turns, config, minion } = await launchBox('launch');
  const t = minion('Launch');
  const run = join(root, 'launch', 'run');
  const calls = [
    ...(await syncCallsUnder(config, async () => {
      runner.send(t.id, 'Cara', 'Go');
      await until('the turn is running', () => followed(runner, t.id));
    })),
  ];
  // The run folder is checked by its own trap, around a second minion's launch, so the two lists say which folder.
  const u = minion('Second');
  calls.push(
    ...(await syncCallsUnder(run, async () => {
      runner.send(u.id, 'Cara', 'Go');
      await until('the second turn is running', () => followed(runner, u.id));
    })),
  );
  assert.deepEqual(calls, []);
  // The launch did its work: a spare became the turn's pin copy, the stored file is back, the prompt is written.
  const dir = runnerInsides(runner).turns.get(t.id)!.dir;
  assert.ok(dir.startsWith(turns));
  assert.equal(readFileSync(join(config, `projects/x-${t.id}/a.jsonl`), 'utf8'), '{}\n');
  assert.match(readFileSync(join(dir, 'prompt.jsonl'), 'utf8'), /Go/);
  assert.ok(fs.existsSync(join(dir, 'pin')));
});

test('a burst of turns launching at once takes each spare once and starts every turn', async () => {
  const { runner, turns, minion } = await launchBox('burst');
  const ts = Array.from({ length: SPARES.link + 3 }, (_, i) => minion(`Burst ${i}`));
  const spares = readySpares('link');
  assert.equal(spares.length, SPARES.link);
  for (const t of ts) runner.send(t.id, 'Cara', 'Go');
  await until('every turn is running', () => ts.every((t) => followed(runner, t.id)));
  const dirs = ts.map((t) => runnerInsides(runner).turns.get(t.id)!.dir);
  assert.equal(new Set(dirs).size, ts.length);
  // Every turn has a whole pin copy: the spares went to one turn each, and the rest were copied.
  const inos = dirs.map((d) => fs.statSync(join(d, 'pin')).ino);
  assert.equal(new Set(inos).size, ts.length, 'no two turns share one pin folder');
  for (const d of dirs) assert.ok(fs.readdirSync(join(d, 'pin')).length > 0, `${d} has its pinned files`);
  const taken = spares.filter((s) => !fs.existsSync(s)).length;
  assert.equal(taken, SPARES.link, 'every spare ready at the burst went to a turn');
  assert.ok(dirs.every((d) => d.startsWith(turns)));
});

test('a stop while a turn is still launching starts no turn, drops its queue and leaves no turn folder', async () => {
  const { runner, store, turns, minion } = await launchBox('stop-launch');
  const t = minion('Stopped');
  // Stopped the moment its launch begins, so the stop lands while its files are still being written.
  const launching = runnerInsides(runner).launching;
  const set = launching.set.bind(launching);
  let stopped: boolean | null = null;
  launching.set = (id, mark) => {
    set(id, mark);
    if (id === t.id && stopped === null) {
      assert.ok(runner.isRunning(t.id), 'a launching turn counts as running');
      assert.equal(runner.view({ ...store.getTicket(t.id)!, status: 'idle' }).status, 'running', 'its token is minted: it shows running, however stale the row');
      // Its ship ended as it launched: the dismissal waits for the turn, and a stopped start leaves the minion open.
      assert.equal(runner.closeAfterTurn(t.id, 'Shipped.'), true);
      stopped = runner.stop(t.id);
    }
    return launching;
  };
  runner.send(t.id, 'Cara', 'Go');
  await until('the stop has landed', () => stopped !== null);
  assert.equal(stopped, true);
  await until('the launch has given up', () => !runner.isRunning(t.id));
  await until('its folder is gone', () => !fs.readdirSync(turns).some((n) => n.startsWith(`${t.id}-`)));
  assert.equal(followed(runner, t.id), false);
  assert.equal(runner.queued(t.id), 0, 'the stop dropped the queued message');
  const notes = store
    .listEvents(t.id)
    .filter((e) => e.kind === 'note')
    .map((e) => (JSON.parse(e.data) as { text: string }).text);
  assert.ok(notes.includes("Shipped. It stays open: its turn didn't start."), notes.join(' | '));
  assert.notEqual(store.getTicket(t.id)!.status, 'closed');
  assert.equal(runner.view(store.getTicket(t.id)!).closing, false, 'no dismissal mark left');
  // The next message runs as usual, without the stopped one.
  runner.send(t.id, 'Cara', 'Again');
  await until('the next turn is running', () => followed(runner, t.id));
  const prompt = readFileSync(join(runnerInsides(runner).turns.get(t.id)!.dir, 'prompt.jsonl'), 'utf8');
  assert.match(prompt, /Again/);
  assert.doesNotMatch(prompt, /\bGo\b/, 'the stopped batch is not run again');
});

test("the Status page's backup check makes no synchronous file call on the server's thread (#1878)", async () => {
  const { appBackup, readBackups } = await import('../src/backup-freshness.ts');
  const home = join(root, 'backup-home');
  const data = join(root, 'backup-data');
  mkdirSync(join(home, '.local/share/mandate/backups/2026-11-24'), { recursive: true });
  writeFileSync(join(home, '.local/share/mandate/backups/2026-11-24/m.db'), 'x');
  mkdirSync(join(data, 'backups'), { recursive: true });
  writeFileSync(join(data, 'backups', 'coordinator-2026-11-24.db'), 'x');
  const now = Date.parse('2026-11-24T20:00:00Z');
  for (const dir of [home, data]) {
    const seen = await syncCallsUnder(dir, async () => {
      const one = await appBackup(join(home, '.local/share/mandate'), now);
      assert.deepEqual(one, { day: '2026-11-24', ok: true });
      const all = await readBackups(data, home, [{ name: 'mandate', title: 'Mandate' }], now);
      assert.equal(all.apps[0].day, '2026-11-24');
      assert.ok(all.db);
    });
    assert.deepEqual(seen, [], `synchronous fs calls under ${dir}`);
  }
});

test("the heavy-jobs folder is read off the server's thread: a snapshot refreshed in the background feeds memory easing and the release readers", async () => {
  const { HeavySnapshot } = await import('../src/waits.ts');
  const heavy = join(root, 'heavy');
  mkdirSync(heavy, { recursive: true });
  writeFileSync(join(heavy, 'wait-1234-5'), `Citadel #1 (cara)\nnpm test\n${Math.floor(Date.now() / 1000)}\nmemory\n`);
  const snap = new HeavySnapshot(heavy);
  assert.deepEqual(snap.get(), { holders: [], waiters: [] }, 'empty before the first read');
  const seen = await syncCallsUnder(heavy, async () => {
    await snap.refresh();
    assert.equal(snap.get().waiters.length, 1);
    assert.equal(snap.get().waiters[0].reason, 'memory');
  });
  assert.deepEqual(seen, []);
  // A folder that can't be read keeps the last answer and never throws.
  const gone = new HeavySnapshot(join(root, 'nope'));
  await gone.refresh();
  assert.deepEqual(gone.get(), { holders: [], waiters: [] });
});

/** A scheme with a kit ship line of `n` tickets (the first holding it), its releases wired as server.ts wires them. */
function shipLine(name: string, n: number) {
  const store = new Store(join(root, `${name}.db`));
  const repo = join(root, `${name}-repo`);
  const q = join(repo, '.git', 'land-queue');
  mkdirSync(q, { recursive: true });
  mkdirSync(join(repo, 'tools'));
  writeFileSync(join(repo, 'tools', 'land.sh'), 'queue_order() {\n  :\n}\n');
  const p = store.createProject(name, 'https://github.com/o/x');
  store.setProjectRepoDir(p.id, repo);
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const me = `${process.pid} ${stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]}`;
  const ids: number[] = [];
  const add = (i: number) => {
    const t = store.createTicket({ project_id: p.id, title: `Change ${i}`, permission_mode: 'default', created_by: 'Cara' });
    store.setTicketDir(t.id, root, `ticket/${i}-c`);
    ids.push(t.id);
    writeFileSync(join(q, String(i).padStart(10, '0')), [me, i === 1 ? '1795067420' : '0', `ticket/${i}-c`, 'waiting', '-', '-', '-', 'order'].join('\n') + '\n');
  };
  for (let i = 1; i <= n; i++) add(i);
  const target = { id: 'ci:w:r', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', numbering: null };
  const lands = new LandsInFlight({ store, finder: { list: () => [target] } as never, landings: { handoffs: () => ids, get: () => ({ output: 'queue: next in line\n', code: null }) } });
  const reader = { read: () => [{ target, current: null, next: null, line: [], recent: [] }] };
  const releases = new Releases({ store, readers: [reader as never], testCopies: () => new Map(), broadcast: () => {}, lines: () => lands.refresh(), inFlight: (v, fresh) => lands.attach(v, fresh) });
  const line = () => releases.view(() => true)[0].targets.flatMap((t) => t.line.map((e) => e.name));
  return { store, repo, q, p, ids, releases, line, add };
}

test("the release poll reads each scheme's ship line with no synchronous file call on the server's thread (#1980)", async () => {
  const w = shipLine('poll-line', 3);
  assert.deepEqual(await syncCallsUnder(w.repo, () => w.releases.pollA()), []);
  assert.equal(w.line().length, 3);
  assert.deepEqual(await syncCallsUnder(w.repo, () => w.releases.refresh()), []);
  // The server's timers and event handlers poll this way.
  assert.doesNotMatch(readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8'), /\breleases\.poll\(/);
});

test('what acts on the ship line reads it fresh, never the snapshot of the last poll (#1980)', async () => {
  const w = shipLine('fresh-line', 3);
  await w.releases.pollA();
  const app = { store: w.store, releases: w.releases, waits: undefined };
  const by = { name: 'Cara', taskmaster: false };
  // Since that poll #2 shipped and #4 joined.
  rmSync(join(w.q, '0000000002'));
  w.add(4);
  assert.throws(() => moveShip(app, w.p.id, 2, [2, 3], by), /no longer waiting in line/);
  assert.deepEqual(moveShip(app, w.p.id, 4, [4, 3], by), [4, 3]);
  // A stop (src/ship-stop.ts): its ticket left the line since the poll.
  await w.releases.pollA();
  rmSync(join(w.q, '0000000001'));
  assert.throws(() => stopShip(fake<App>(app), w.p.id, 1, 'Cara'), /not|longer|left|isn't/);
  // The Status panel's shipLines reads the line fresh too, with readQueueA (off the thread, #2111); the snapshot is what stays out.
  assert.doesNotMatch(readFileSync(join(import.meta.dirname, '..', 'src', 'ship-stop.ts'), 'utf8'), /LandsInFlight/);
});

test('a poll already reading the line never puts an older line over the one an action just read (#1980)', async () => {
  const w = shipLine('late-line', 3);
  // Its read has all three tickets and waits on land.sh when the line moves.
  const { readFile: realRead, stat: realStat } = fs.promises;
  let read = 0;
  let open = () => {};
  const gate = new Promise<void>((done) => {
    open = done;
  });
  const patch = (readFn: typeof realRead, statFn: typeof realStat) => {
    Object.assign(fs.promises, { readFile: readFn, stat: statFn });
    syncBuiltinESMExports();
  };
  patch(
    (async (...a: Parameters<typeof realRead>) => {
      if (String(a[0]).endsWith('land.sh')) await gate;
      return realRead(...a);
    }) as typeof realRead,
    (async (...a: Parameters<typeof realStat>) => {
      const st = await realStat(...a);
      if (String(a[0]).startsWith(w.q)) read++;
      return st;
    }) as typeof realStat,
  );
  const late = w.releases.pollA();
  try {
    await until('the poll read the three tickets', () => read === 3);
  } finally {
    patch(realRead, realStat);
  }
  rmSync(join(w.q, '0000000002'));
  w.releases.poll();
  assert.equal(w.line().length, 2);
  open();
  await late;
  assert.equal(w.line().length, 2);
});

test("the long-jobs pump, sweep and lookups make no synchronous file call on the server's thread (#1980)", async () => {
  const dir = join(root, 'long-heavy');
  const long = join(dir, 'long');
  mkdirSync(long, { recursive: true });
  const now = Date.now();
  const job = (id: string, more: object) => writeFileSync(join(long, `${id}.json`), JSON.stringify({ id, ticket: 1, slug: 'o/r', sha: 'a'.repeat(40), command: 'x', what: 'x', who: 'C #1', queued_at: now, state: 'queued', ...more }));
  job('a-1-a', { quiet: true });
  job('b-2-b', { state: 'running', run_id: 7, slug: 'o/q' });
  job('c-3-c', { state: 'done', ended_at: now - 30 * 24 * 3600_000 });
  writeFileSync(join(long, 'c-3-c.log'), 'x');
  writeFileSync(join(long, '.old.tmp'), 'x');
  fs.utimesSync(join(long, '.old.tmp'), new Date(0), new Date(0));
  writeFileSync(join(long, '.new.tmp'), 'x');
  let saved = '';
  const jobs = new LongJobs({
    dir,
    scheme: () => ({ projectId: 1, slug: null }),
    hours: () => ({}) as never,
    gh: async () => '',
    wake: () => {},
    note: () => {},
  });
  const ok = new LongJobs({
    dir,
    scheme: (t) => ({ projectId: t, slug: 'o/r' }),
    hours: () => ({}) as never,
    gh: async (_p, args) => {
      if (args.some((a) => a.endsWith('/dispatches'))) saved = await readFile(join(long, 'a-1-a.json'), 'utf8');
      return JSON.stringify({ default_branch: 'main', content: '' });
    },
    wake: () => {},
    note: () => {},
  });
  const seen = await syncCallsUnder(dir, async () => {
    await ok.refresh();
    assert.equal(ok.heldSince('a-1-a'), undefined);
    assert.equal(ok.list().length, 3);
    await ok.pump();
    assert.equal(ok.mayResume('a-1-a'), true);
    await jobs.pump();
  });
  assert.deepEqual(seen, []);
  // A folder that can't be listed keeps the last answer: a held job must not look unknown, so free to start.
  fs.renameSync(long, `${long}-away`);
  writeFileSync(long, '');
  await ok.refresh();
  assert.equal(ok.list().length, 3);
  rmSync(long);
  fs.renameSync(`${long}-away`, long);
  assert.equal(JSON.parse(saved).state, 'dispatched', 'saved before GitHub is asked, so a crash never runs it twice');
  assert.deepEqual(fs.readdirSync(long).sort(), ['.new.tmp', 'a-1-a.json', 'b-2-b.json']);
  for (const f of ['server.ts', 'src/routes/machines.ts']) assert.doesNotMatch(readFileSync(join(import.meta.dirname, '..', f), 'utf8'), /\breadLongJobs\(/);
});

test("loading a scheme's decisions makes no synchronous file call on the server's thread (#1980)", async () => {
  const repo = join(root, 'dec-repo');
  mkdirSync(join(repo, '.claude', 'rules', 'deep'), { recursive: true });
  writeFileSync(join(repo, 'CLAUDE.md'), '- One (Cara, 2026-11-19: "kept").\n');
  writeFileSync(join(repo, '.claude', 'rules', 'deep', 'a.md'), '- Two (Cara, 2026-11-20: "second").\n');
  fs.symlinkSync(join(repo, '.claude'), join(repo, '.claude', 'rules', 'loop'));
  const config = join(root, 'dec-config');
  const mem = memoryDir(config, repo);
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'n.md'), '- Three (Cara, 2026-11-21: "third").\n');
  const store = new Store(join(root, 'dec.sqlite'));
  store.createUser({ name: 'Cara', login: 'cara' });
  const u = store.listUsers()[0];
  store.listUsers = () => [{ ...u, server_login: 1 } as never];
  const p = store.createProject('Dec', null);
  store.setProjectRepoDir(p.id, repo);
  const app = fake<App>({ store, claude: fake<App['claude']>({ accounts: () => ({ accounts: [{ n: 1, linkedAt: 0 }], inUse: 1 }), configDir: () => config }), runner: fake<App['runner']>({ leaveMail: () => {} }) });
  let rules: string[] = [];
  const load = async () => {
    rules = (await loadDecisions(app, store.getProject(p.id)!)).decisions.map((d) => d.rule);
  };
  assert.deepEqual(await syncCallsUnder(root, load), []);
  for (const r of ['One', 'Two', 'Three']) assert.ok(rules.includes(r), r);
  assert.deepEqual(await syncCallsUnder(join(import.meta.dirname, '..', 'kit'), load), []);
});

test("the units check reads deploy/ and the install folder with no synchronous file call on the server's thread (#2081)", async () => {
  const { checkUnits } = await import('../src/unit-drift.ts');
  const units = join(root, 'units');
  const deploy = join(units, 'deploy');
  const inst = join(units, 'inst');
  mkdirSync(join(deploy, 'a.service.d'), { recursive: true });
  mkdirSync(inst, { recursive: true });
  writeFileSync(join(deploy, 'a.service'), 'A');
  writeFileSync(join(deploy, 'a.service.d', 'w.conf'), 'W');
  writeFileSync(join(deploy, 'not-installed.txt'), '# none\n');
  writeFileSync(join(inst, 'a.service'), 'old');
  let states: string[] = [];
  const seen = await syncCallsUnder(units, async () => {
    states = (await checkUnits(deploy, inst, root)).map((r) => `${r.name}:${r.state}`);
  });
  assert.deepEqual(states, ['a.service:different', 'a.service.d/w.conf:missing']);
  assert.deepEqual(seen, []);
});

test("the Status page's ship lines are read with no synchronous file call on the server's thread (#2111)", async () => {
  const w = shipLine('status-lines', 3);
  await w.releases.pollA();
  const app = { store: w.store, releases: w.releases, waits: undefined };
  let lines: Awaited<ReturnType<typeof shipLines>> = [];
  // The panel asks every 3 s for as long as it is open.
  assert.deepEqual(await syncCallsUnder(w.repo, async () => void (lines = await shipLines(app, () => true))), []);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].rows.length, 3);
  // Read afresh each time: a ship that left since the last answer is gone from the next.
  rmSync(join(w.q, '0000000003'));
  assert.equal((await shipLines(app, () => true))[0].rows.length, 2);
});

test("a landing log's end reaches the release poll with no synchronous file call on the server's thread (#2111)", async () => {
  const dir = mkdtempSync(join(root, 'tail-'));
  const f = join(dir, 'output.log');
  writeFileSync(f, 'land: early next train: CI started on this train at abc\n');
  // Releases' Next bar and the waits poll read it every 2 s while a ship holds the line.
  const { tailNow, tailsRead, readTailA } = landNewsFile as unknown as { tailNow: (p: string) => string; tailsRead: () => Promise<void>; readTailA: (p: string) => Promise<string> };
  let first = 'unread',
    second = '',
    whole = '';
  const calls = await syncCallsUnder(dir, async () => {
    first = tailNow(f);
    await tailsRead();
    second = tailNow(f);
    whole = await readTailA(f);
  });
  assert.deepEqual(calls, []);
  // The poll gets what the last read found and starts the next read: the first look is empty, the next has the log.
  assert.equal(first, '');
  assert.match(second, /CI started on this train/);
  assert.equal(whole, second);
});

test("kit sync's look at the templates starts no blocking git and makes no synchronous file call (#2111)", async () => {
  const kit = join(import.meta.dirname, '..');
  const dir = mkdtempSync(join(root, 'kit-look-'));
  // Nothing changed since the last round: the look every 10 minutes that finds no work.
  const head = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: kit, encoding: 'utf8' }).trim();
  let saved: KitSyncState | undefined = { blobs: templateBlobs(kit, head) };
  const deps = fake<ConstructorParameters<typeof KitSync>[0]>({ kitDir: kit, projectsDir: dir, runDir: dir, load: () => saved, save: (s: KitSyncState) => (saved = s), projects: () => [], home: () => 2 });
  const calls = await syncCallsUnder(kit, () => new KitSync(deps).poll());
  assert.deepEqual(calls, []);
  assert.equal(saved?.round, undefined);
});

test("an artifact page gets its bridge with no synchronous file call on the server's thread (#2136)", async () => {
  let out = '';
  const calls = await syncCallsUnder(join(import.meta.dirname, '..', 'public'), async () => {
    out = (await injectBridge(Buffer.from('<p>x</p>'), { page: 'p.html', entries: [] })).toString();
  });
  assert.deepEqual(calls, []);
  assert.match(out, /^<script>\(function \(cfg\)/);
});

test("a new minion's brief, an app's media and the push key are read with no synchronous file call (#2136)", async () => {
  const dir = mkdtempSync(join(root, 'reads-'));
  writeFileSync(join(dir, 'brief.md'), 'the brief');
  writeFileSync(join(dir, 'a.png'), 'xx');
  writeFileSync(join(dir, 'key.json'), '{}');
  let named = '',
    listed = 0;
  const calls = await syncCallsUnder(dir, async () => {
    named = await namedFiles(`Read ${dir}/brief.md`, dir);
    listed = (await listMedia(dir)).length;
    await mediaFile(dir, 'a.png');
    await assert.rejects(async () => new Fcm(join(dir, 'key.json')).account(), /not a Firebase service account key/);
    await assert.rejects(async () => new Fcm(join(dir, 'none.json')).account(), /isn't set up/);
  });
  assert.deepEqual(calls, []);
  assert.deepEqual([named, listed], ['the brief', 2]);
});

test("the CI page's host load reads the slots and history with no synchronous file call (#2136)", async () => {
  const dir = mkdtempSync(join(root, 'load-'));
  writeFileSync(join(dir, 'slots'), '4\n');
  writeFileSync(join(dir, 'history'), '');
  let slots = 0;
  const calls = await syncCallsUnder(dir, async () => {
    slots = (await hostLoad(dir, { holders: [], waiters: [] }, Date.now(), undefined, undefined, [])).slots;
  });
  assert.deepEqual(calls, []);
  assert.equal(slots, 4);
});

test("the app shell's off switch is looked up with no synchronous file call (#2136)", async () => {
  const dir = mkdtempSync(join(root, 'shell-'));
  writeFileSync(join(dir, SHELL_OFF_FILE), '');
  let off = false;
  const calls = await syncCallsUnder(dir, async () => {
    off = await shellOff(dir);
  });
  assert.deepEqual(calls, []);
  assert.equal(off, true);
});

test("a chat's slash commands are described with no synchronous file call (#2136)", async () => {
  const dir = mkdtempSync(join(root, 'commands-'));
  mkdirSync(join(dir, '.claude', 'skills', 'deploy'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\ndescription: Ship it.\n---\n');
  const store = new Store(join(dir, 'db.sqlite'));
  const p = store.createProject('P', null);
  const t = store.createTicket({ project_id: p.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  store.setSetting(commandsKey(t.id), { cwd: dir, names: ['deploy'], plugins: [] });
  let description = '';
  const calls = await syncCallsUnder(join(dir, '.claude'), async () => {
    description = (await chatCommands(store, t)).commands[0].description;
  });
  assert.deepEqual(calls, []);
  assert.equal(description, 'Ship it.');
});

test('the ideas ledger reads pages and handoffs with no synchronous file call (#2136)', async () => {
  const dir = mkdtempSync(join(root, 'ideas-'));
  mkdirSync(join(dir, 'handoffs'));
  const page = join(dir, 'ideas.html');
  writeFileSync(page, "<script>mock.picks({ collection: 'ideas', options: ['go', 'later'] });</script>");
  writeFileSync(join(dir, 'handoffs', 'one.md'), '# Handoff: one\n');
  writeFileSync(join(dir, 'handoffs', 'two.md'), '# Handoff: two\n');
  const store = new Store(join(root, 'ideas.sqlite'));
  const p = store.createProject('P', null);
  const t = store.createTicket({ project_id: p.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  store.writeArtifactData(p.id, page, [{ key: 'db/ideas/A', value: JSON.stringify({ v: 'later', by: 'Josh' }) }], 'Josh');
  const calls = await syncCallsUnder(dir, async () => {
    await store.ideas.linkHandoff(p.id, dir, 'handoffs/one.md', t);
    await store.ideas.sync(p.id, dir);
  });
  assert.deepEqual(calls, []);
  assert.equal(store.ideas.list(p.id).length, 3);
});

test('memory notes are listed, saved and indexed, with no synchronous file call (#2136)', async () => {
  const dir = mkdtempSync(join(root, 'memory-'));
  writeFileSync(join(dir, 'a.md'), '---\nname: A\n---\nbody');
  let notes = 0;
  const calls = await syncCallsUnder(dir, async () => {
    await saveNote(dir, 'a.md', '---\nname: A\n---\nnew');
    await indexNote(dir, 'a.md');
    notes = (await readFolder({ label: 'x', dir, id: 'x', rel: 'x' }, () => false)).notes.length;
  });
  assert.deepEqual(calls, []);
  assert.equal(notes, 1);
});

/** What a followed turn's poll keeps in hand, for the cases below. */
interface PolledTurn {
  dir: string;
  ticks: number;
  restart?: () => void;
}
const polled = (runner: Runner, id: number) => runnerInsides(runner).turns.get(id) as PolledTurn;
const texts = (store: Store, id: number) =>
  store
    .listEvents(id)
    .filter((e) => e.kind === 'claude')
    .map((e) => e.data);

test("a running turn's poll reads its stream and its folder with no synchronous file call on the server's thread (#2134)", async () => {
  const { runner, store, turns, minion } = await launchBox('poll');
  const release = join(root, 'poll', 'release');
  fakeClaude(join(root, 'poll'), { release, name: 'fake-claude' });
  runner.pollMs = 10;
  const t = minion('Polled');
  runner.send(t.id, 'Cara', 'Go');
  await until('the turn is running', () => followed(runner, t.id));
  const live = polled(runner, t.id);
  await until('its claude has started', () => fs.existsSync(join(live.dir, 'pid.json')));
  const said = (words: string) => `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: words }] } })}\n`;
  // While it runs: new lines in its stream, in two writes with a line cut between them, and the every-20th-tick look
  // at whether its wrapper is alive.
  const running = await syncCallsUnder(
    turns,
    async () => {
      const [head, tail] = [said('first words').slice(0, 30), said('first words').slice(30)];
      await appendFile(join(live.dir, 'stream.jsonl'), said('before it') + head);
      await until('the whole line to be read', () => texts(store, t.id).some((d) => d.includes('before it')));
      await appendFile(join(live.dir, 'stream.jsonl'), tail + said('second words'));
      await until('both lines to be read', () => texts(store, t.id).some((d) => d.includes('second words')));
      const at = live.ticks;
      await until('two liveness checks', () => live.ticks >= at + 45);
    },
    true,
  );
  assert.deepEqual(running, []);
  // Each line reached the chat once, in the order written.
  const order = texts(store, t.id)
    .join('\n')
    .match(/before it|first words|second words/g);
  assert.deepEqual(order, ['before it', 'first words', 'second words']);
  // A stop, and the turn's end: the poll's and the stop's own looks at pid.json, exit.json and the stream. What the
  // turn's wrap-up reads (its stderr, its folder's removal) is the turn-end path's.
  const ending = await syncCallsUnder(
    turns,
    async () => {
      runner.stop(t.id);
      await until('the stopped turn to end', () => !runner.isRunning(t.id));
    },
    true,
  );
  assert.deepEqual(
    ending.filter((c) => /pid\.json|exit\.json|stream\.jsonl|^fstatSync|^readSync/.test(c)),
    [],
  );
});

test("a turn the supervisor gave back or lost is found with no synchronous file call on the server's thread (#2134)", async () => {
  const { runner, turns, minion } = await launchBox('rescue');
  runner.pollMs = 10;
  const t = minion('Rescued');
  // A turn still starting: followed, with no wrapper yet.
  const dir = join(turns, `${t.id}-1`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stream.jsonl'), '');
  (runner as unknown as { follow(id: number, turn: { dir: string; startedAt: number }): unknown }).follow(t.id, { dir, startedAt: Date.now() });
  const live = polled(runner, t.id);
  let restarts = 0;
  const calls = await syncCallsUnder(
    turns,
    async () => {
      live.restart = () => restarts++;
      await writeFile(join(dir, 'handback'), 'no scope');
      await until('the given-back turn to restart', () => restarts === 1);
      // Lost: the supervisor that claimed its spec is dead.
      live.restart = () => restarts++;
      await writeFile(join(dir, 'spec.json.tmp'), '{}');
      await rename(join(dir, 'spec.json.tmp'), join(dir, 'spec.json.4194000'));
      await until('the lost turn to restart', () => restarts === 2);
    },
    true,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['spec.json', 'stream.jsonl']);
  writeFileSync(join(dir, 'exit.json'), '{"code":0,"signal":null}');
  await until('the turn to end', () => !followed(runner, t.id));
});

test("the wait for a stray turn to end makes no synchronous file call on the server's thread (#2134)", async () => {
  const { runner, turns, minion } = await launchBox('stray');
  const t = minion('Stray');
  const dir = join(turns, `${t.id}-1`);
  mkdirSync(dir, { recursive: true });
  // A process with the folder in its arguments, as a turn's wrapper has.
  const wrapper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)', dir], { stdio: 'ignore' });
  try {
    writeFileSync(join(dir, 'pid.json'), JSON.stringify({ wrapper: wrapper.pid }));
    const inside = runner as unknown as { strayPollMs: number; strayWaits: Set<number>; waitStray(id: number, dir: string): Promise<void> };
    inside.strayPollMs = 10;
    const calls = await syncCallsUnder(turns, async () => {
      await inside.waitStray(t.id, dir);
      assert.equal(inside.strayWaits.has(t.id), true);
      await writeFile(join(dir, 'exit.json'), '{"code":0,"signal":null}');
      await until('the wait to end with the stray', () => !inside.strayWaits.has(t.id));
    });
    assert.deepEqual(calls, []);
  } finally {
    wrapper.kill('SIGKILL');
  }
});

test("a side ask's poll, its answer and its thread's end make no synchronous file call on the server's thread (#2134)", async () => {
  const dir = mkdtempSync(join(root, 'side-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const p = store.createProject('Side', null);
  const t = store.createTicket({ project_id: p.id, title: 'Asked', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  store.updateTicket(t.id, { session_id: '11111111-1111-4111-8111-111111111111' });
  const fork = '22222222-2222-4222-8222-222222222222';
  const config = join(dir, 'config');
  const forkFile = join(config, 'projects', '-cwd', `${fork}.jsonl`);
  mkdirSync(join(config, 'projects', '-cwd'), { recursive: true });
  writeFileSync(forkFile, '{}\n');
  const answers: { ok: boolean; text: string }[] = [];
  const signals: string[] = [];
  let runs = 0;
  const launch = fake<ConstructorParameters<typeof SideAsks>[1]>({
    sideLaunch: async () => {
      const run = join(dir, `run-${++runs}`);
      await mkdir(run);
      return { dir: run, configDir: config, cwd: '/cwd', account: 1, container: null };
    },
    emit: (_id: number, kind: string, data: unknown) => {
      if (kind === 'side_answer') answers.push(data as { ok: boolean; text: string });
      return fake<ReturnType<Runner['emit']>>({ id: answers.length + runs * 100, created_at: Date.now() });
    },
    payerOf: () => null,
    signal: async (_live: unknown, sig: string) => void signals.push(sig),
  });
  const sides = new SideAsks(store, launch, () => {}, 10);
  const threads = (sides as unknown as { threads: Map<number, { run: { dir: string; startedAt: number } | null; lastAt: number }> }).threads;
  const calls = await syncCallsUnder(dir, async () => {
    // An answer: its stream is read as it grows, and its exit ends the ask and deletes its folder.
    const ev = await sides.ask(t.id, 1, 'Cara', 'what now?');
    const thread = threads.get(ev.thread)!;
    const run = thread.run!.dir;
    await writeFile(join(run, 'stream.jsonl'), `${JSON.stringify({ type: 'system', subtype: 'init', session_id: fork })}\n`);
    await appendFile(join(run, 'stream.jsonl'), JSON.stringify({ type: 'result', is_error: false, result: 'this now' }));
    await writeFile(join(run, 'exit.json'), '{"code":0,"signal":null}');
    await until('the answer', () => answers.length === 1);
    // A follow-up past its limit is stopped.
    const next = await sides.ask(t.id, 1, 'Cara', 'and then?', ev.thread);
    assert.equal(next.thread, ev.thread);
    thread.run!.startedAt = Date.now() - SIDE_LIMIT_MS - 1;
    await until('the late ask to be stopped', () => answers.length === 2);
    // The idle thread ends, and its fork's files go.
    thread.lastAt = Date.now() - SIDE_IDLE_MS - 1;
    await until("the fork's transcript to go", async () => !(await readFile(forkFile).catch(() => null)));
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(
    answers.map((a) => [a.ok, a.text]),
    [
      [true, 'this now'],
      [false, 'It took longer than 15 minutes, so it was stopped.'],
    ],
  );
  assert.deepEqual(signals, ['SIGKILL']);
  await until('both run folders to go', () => !fs.existsSync(join(dir, 'run-1')) && !fs.existsSync(join(dir, 'run-2')));
});
