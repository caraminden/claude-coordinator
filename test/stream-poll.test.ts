// A running turn's per-tick cost on the server's one thread (#1562). Four times a second each followed turn is
// polled: today's reader opened, read into a fresh 1 MiB buffer and closed its stream, and looked up exit.json,
// every tick. Now the stream and the turn's folder stay open, a tick asks their sizes and times with fstat, and
// exit.json is looked up only after the folder changed. Since #2134 every one of those calls is made off the
// server's thread, one poll of a turn at a time. These tests count the file calls a quiet tick makes (not
// wall time, which a busy box would make flaky) and pin that lines and ends still arrive on the next tick.
import assert from 'node:assert/strict';
import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { thrown } from '../src/thrown.ts';
import { testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'stream-poll-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir
const store = new Store(join(root, 'db.sqlite'));
const project = store.createProject('Poll', null);

/** A Runner whose turns are polled by hand: lines and ends are recorded instead of handled. */
function setup() {
  const runner = new Runner(
    store,
    () => {},
    () => ({}),
    join(root, 'no-claude'),
  );
  runner.pollMs = 1e9; // no timer fires: the test ticks
  const lines = new Map<number, string[]>();
  const ended = new Map<number, unknown>();
  const r = runner as any;
  r.handleLine = (id: number, line: string) => (lines.get(id) ?? lines.set(id, []).get(id)!).push(line);
  r.finish = (id: number, live: any, exit: unknown) => {
    ended.set(id, exit);
    clearInterval(live.timer);
    r.unfollow(live);
    r.turns.delete(id);
  };
  const follow = (name: string) => {
    const t = store.createTicket({ project_id: project.id, title: name, permission_mode: 'default', created_by: 'Cara' });
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stream.jsonl'), '');
    r.follow(t.id, { dir, offset: 0, startedAt: Date.now() });
    return { id: t.id, dir, stream: join(dir, 'stream.jsonl') };
  };
  /** One tick, to its end: a poll waits on the disk off the thread. */
  const tick = (id: number): Promise<void> => {
    r.poll(id);
    return r.turns.get(id)?.polling ?? Promise.resolve();
  };
  const live = (id: number) => r.turns.get(id);
  const stop = () => {
    for (const [id, l] of r.turns) {
      clearInterval(l.timer);
      r.unfollow(l);
      r.turns.delete(id);
    }
  };
  return { runner, follow, tick, live, lines, ended, stop };
}

/**
 * Count the calls to these fs functions (`p.` ones are node:fs/promises') and Buffer allocations, with their bytes,
 * while `fn` runs.
 */
async function counting(fn: () => Promise<void>): Promise<Record<string, number>> {
  const names = ['openSync', 'closeSync', 'existsSync', 'statSync', 'lstatSync', 'readSync', 'readFileSync', 'readdirSync', 'fstatSync', 'open', 'close', 'fstat', 'read'] as const;
  const promised = ['access', 'readFile', 'readdir', 'stat', 'open'] as const;
  const counts: Record<string, number> = {};
  const saved = new Map<string, any>();
  const f = fs as any;
  for (const n of names) {
    saved.set(n, f[n]);
    counts[n] = 0;
    f[n] = (...a: unknown[]) => (counts[n]++, saved.get(n)(...a));
  }
  for (const n of promised) {
    saved.set(`p.${n}`, f.promises[n]);
    counts[`p.${n}`] = 0;
    f.promises[n] = (...a: unknown[]) => (counts[`p.${n}`]++, saved.get(`p.${n}`)(...a));
  }
  const { alloc, allocUnsafe } = Buffer;
  counts.alloc = counts.allocBytes = 0;
  const count = (size: number) => (counts.alloc++, (counts.allocBytes += size));
  Buffer.alloc = ((...a: Parameters<typeof alloc>) => (count(a[0]), alloc(...a))) as typeof alloc;
  Buffer.allocUnsafe = ((...a: Parameters<typeof allocUnsafe>) => (count(a[0]), allocUnsafe(...a))) as typeof allocUnsafe;
  syncBuiltinESMExports();
  try {
    await fn();
  } finally {
    for (const n of names) f[n] = saved.get(n);
    for (const n of promised) f.promises[n] = saved.get(`p.${n}`);
    Buffer.alloc = alloc;
    Buffer.allocUnsafe = allocUnsafe;
    syncBuiltinESMExports();
  }
  return Object.fromEntries(Object.entries(counts).filter(([, v]) => v));
}

test("a quiet tick of 100 running turns opens, closes, looks up and allocates nothing: two fstats a turn, off the server's thread", async () => {
  const s = setup();
  const turns = Array.from({ length: 100 }, (_, i) => s.follow(`quiet-${i}`));
  for (const t of turns) appendFileSync(t.stream, '{"type":"system"}\n');
  // Warm up: the first ticks open the files and see the folder's first mtime, and look once more after it.
  for (const t of turns) await s.tick(t.id);
  await until('every turn folder is open', async () => turns.every((t) => typeof s.live(t.id).dirFd === 'number'));
  for (let i = 0; i < 2; i++) for (const t of turns) await s.tick(t.id);
  // Ticks 4 to 18: neither the 20th tick's liveness look nor the 40th's quiet check.
  const ticks = 15;
  const counts = await counting(async () => {
    for (let i = 0; i < ticks; i++) await Promise.all(turns.map((t) => s.tick(t.id)));
  });
  assert.deepEqual(counts, { fstat: 2 * turns.length * ticks });
  assert.ok(turns.every((t) => s.lines.get(t.id)?.length === 1));
  // A tick with new lines reads them into a buffer of their size and a byte (turns read at once, so each has its
  // own): nothing opened, and no 1 MiB buffer a tick.
  const line = '{"type":"assistant"}\n';
  for (const t of turns) appendFileSync(t.stream, line);
  const busy = await counting(async () => {
    await Promise.all(turns.map((t) => s.tick(t.id)));
  });
  assert.deepEqual(busy, { fstat: 2 * turns.length, read: turns.length, alloc: turns.length, allocBytes: turns.length * (line.length + 1) });
  assert.ok(turns.every((t) => s.lines.get(t.id)?.length === 2));
  s.stop();
});

test('a partial line waits for its newline, and a line or a burst past the buffer comes whole', async () => {
  const s = setup();
  const t = s.follow('partial');
  appendFileSync(t.stream, '{"a":1}\n{"b":');
  await s.tick(t.id);
  assert.deepEqual(s.lines.get(t.id), ['{"a":1}']);
  appendFileSync(t.stream, '2}\n');
  await s.tick(t.id);
  assert.deepEqual(s.lines.get(t.id), ['{"a":1}', '{"b":2}']);
  // One line of 2.5 MiB, longer than the 1 MiB buffer, then 3 MiB of short lines: one tick takes all of it.
  const long = JSON.stringify({ text: 'x'.repeat(2.5 * (1 << 20)) });
  const short = Array.from({ length: 30_000 }, (_, i) => JSON.stringify({ i, pad: 'y'.repeat(90) }));
  appendFileSync(t.stream, `${long}\n${short.join('\n')}\n`);
  await s.tick(t.id);
  const got = s.lines.get(t.id)!;
  assert.equal(got.length, 3 + short.length);
  assert.equal(got[2], long);
  assert.deepEqual(got.slice(3), short);
  assert.equal(s.live(t.id).offset, fs.statSync(t.stream).size);
  s.stop();
});

test('a turn that ends between ticks is seen on the next one, its last line without a newline included', async () => {
  const s = setup();
  const t = s.follow('ends');
  await s.tick(t.id);
  await until('its folder is open', async () => typeof s.live(t.id).dirFd === 'number');
  for (let i = 0; i < 3; i++) await s.tick(t.id); // quiet now: no exit.json lookups
  appendFileSync(t.stream, '{"a":1}\n{"type":"result"}');
  writeFileSync(join(t.dir, 'exit.json'), JSON.stringify({ code: 0, signal: null }));
  await s.tick(t.id);
  assert.deepEqual(s.lines.get(t.id), ['{"a":1}', '{"type":"result"}']);
  assert.deepEqual(s.ended.get(t.id), { code: 0, signal: null });
  assert.equal(s.live(t.id), undefined);
});

test('a file made right after a tick saw the folder change is still looked for on the next tick', async () => {
  // A file's times are as coarse as the kernel's tick: pid.json and exit.json made a moment apart can leave the
  // folder with one mtime, so the tick after a change looks again even if the mtime didn't move.
  const s = setup();
  const t = s.follow('same-tick');
  await s.tick(t.id);
  await until('its folder is open', async () => typeof s.live(t.id).dirFd === 'number');
  for (let i = 0; i < 3; i++) await s.tick(t.id);
  writeFileSync(join(t.dir, 'pid.json'), '{}');
  await s.tick(t.id); // sees the change, finds no exit.json
  const seen = s.live(t.id).dirSeen;
  writeFileSync(join(t.dir, 'exit.json'), JSON.stringify({ code: 1, signal: null }));
  // Make the mtime look unmoved, as two files made in one kernel tick would leave it.
  fs.utimesSync(t.dir, new Date(), seen / 1000);
  assert.equal(fs.statSync(t.dir).mtimeMs, seen);
  await s.tick(t.id);
  assert.deepEqual(s.ended.get(t.id), { code: 1, signal: null });
});

test('an exit.json a tick failed on is looked for again on the ticks after, folder change or not', async () => {
  const s = setup();
  const t = s.follow('retry');
  await s.tick(t.id);
  await until('its folder is open', async () => typeof s.live(t.id).dirFd === 'number');
  for (let i = 0; i < 3; i++) await s.tick(t.id);
  writeFileSync(join(t.dir, 'exit.json'), '{"code":'); // caught mid-write, as a failing read would leave it
  for (let i = 0; i < 3; i++) await s.tick(t.id);
  assert.equal(s.ended.has(t.id), false);
  writeFileSync(join(t.dir, 'exit.json'), JSON.stringify({ code: 0, signal: null })); // same name: the folder is unchanged
  await s.tick(t.id);
  assert.deepEqual(s.ended.get(t.id), { code: 0, signal: null });
});

test('a turn that stops being followed closes its files', async () => {
  const s = setup();
  const t = s.follow('closes');
  appendFileSync(t.stream, '{"a":1}\n');
  await s.tick(t.id);
  await until('its folder is open', async () => typeof s.live(t.id).dirFd === 'number');
  const { streamFd, dirFd } = s.live(t.id);
  writeFileSync(join(t.dir, 'exit.json'), JSON.stringify({ code: 0, signal: null }));
  await s.tick(t.id);
  assert.ok(s.ended.has(t.id));
  await until('both are closed', async () =>
    [streamFd, dirFd].every((fd) => {
      try {
        fs.fstatSync(fd);
        return false;
      } catch (err) {
        return thrown(err).code === 'EBADF';
      }
    }),
  );
});

test('ticks that come while a poll still waits on the disk do nothing: each line is handled once, in order (#2134)', async () => {
  const s = setup();
  const t = s.follow('overlap');
  const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ i }));
  appendFileSync(t.stream, `${lines.join('\n')}\n`);
  // Three ticks before the first has heard back from the disk, then more lines and three again.
  const first = [s.tick(t.id), s.tick(t.id), s.tick(t.id)];
  appendFileSync(t.stream, '{"then":1}\n');
  await Promise.all(first);
  await Promise.all([s.tick(t.id), s.tick(t.id), s.tick(t.id)]);
  assert.deepEqual(s.lines.get(t.id), [...lines, '{"then":1}']);
  assert.equal(s.live(t.id).offset, fs.statSync(t.stream).size);
  s.stop();
});
