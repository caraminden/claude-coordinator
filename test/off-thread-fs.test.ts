// The server's one thread makes no synchronous file call in two paths that run while the disk is busiest (#1768): a
// card refreshing running turns' snapshots, and the flake log's read every few minutes. On Nov 24 each such call waited
// on btrfs for up to 2 s while minions' tests and ships wrote to the same disk, and nobody was answered meanwhile.
import assert from 'node:assert/strict';
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { loadDecisions } from '../src/decisions-load.ts';
import type { App } from '../src/http.ts';
import { LongJobs } from '../src/long-jobs.ts';
import { memoryDir } from '../src/memory-files.ts';
import { LandsInFlight } from '../src/release-readers.ts';
import { Releases } from '../src/releases.ts';
import { moveShip } from '../src/ship-line.ts';
import { stopShip } from '../src/ship-stop.ts';
import { FlakeFixes } from '../src/flake-fixes.ts';
import { Waits } from '../src/waits.ts';
import { Runner } from '../src/runner.ts';
import { FakeClock } from './fake-clock.ts';
import { fake } from './typed.ts';
import type { SchemeRefs } from '../src/scheme-refs.ts';
import { gzipSync } from 'node:zlib';
import { fillPinSpares, readySpares, SPARES } from '../src/pin-spares.ts';
import { stopTurns, testPins, until, followed, runnerInsides } from './helpers.ts';

type FlakeDeps = ConstructorParameters<typeof FlakeFixes>[0];
const root = mkdtempSync(join(tmpdir(), 'off-thread-fs-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
});

/** Runs `fn` and returns the synchronous fs calls made under `dir` before it returned its promise's result. */
async function syncCallsUnder<T>(dir: string, fn: () => T | Promise<T>): Promise<string[]> {
  const names = ['readFileSync', 'readdirSync', 'writeFileSync', 'renameSync', 'existsSync', 'statSync', 'openSync', 'accessSync', 'mkdirSync', 'rmSync', 'linkSync', 'symlinkSync', 'cpSync', 'copyFileSync', 'appendFileSync', 'lstatSync', 'realpathSync', 'readlinkSync', 'utimesSync'] as const;
  const real = Object.fromEntries(names.map((n) => [n, fs[n]]));
  const seen: string[] = [];
  for (const n of names)
    (fs as Record<string, unknown>)[n] = (p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.startsWith(dir)) seen.push(`${n} ${p.slice(dir.length)}`);
      return (real[n] as (...args: unknown[]) => unknown)(p, ...rest);
    };
  syncBuiltinESMExports();
  try {
    await fn();
  } finally {
    for (const n of names) (fs as Record<string, unknown>)[n] = real[n];
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
  // Nothing in server.ts reads the folder with the synchronous twin.
  assert.doesNotMatch(readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8'), /\breadHeavy\(/);
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
  assert.doesNotMatch(readFileSync(join(import.meta.dirname, '..', 'src', 'ship-stop.ts'), 'utf8'), /readQueueA|LandsInFlight/);
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
