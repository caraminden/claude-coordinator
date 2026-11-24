// The server's one thread makes no synchronous file call in two paths that run while the disk is busiest (#1768): a
// card refreshing running turns' snapshots, and the flake log's read every few minutes. On Nov 24 each such call waited
// on btrfs for up to 2 s while minions' tests and ships wrote to the same disk, and nobody was answered meanwhile.
import assert from 'node:assert/strict';
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { FlakeFixes } from '../src/flake-fixes.ts';
import { Runner } from '../src/runner.ts';
import { FakeClock } from './fake-clock.ts';
import type { SchemeRefs } from '../src/scheme-refs.ts';

const root = mkdtempSync(join(tmpdir(), 'off-thread-fs-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** Runs `fn` and returns the synchronous fs calls made under `dir` before it returned its promise's result. */
async function syncCallsUnder<T>(dir: string, fn: () => T | Promise<T>): Promise<string[]> {
  const names = ['readFileSync', 'readdirSync', 'writeFileSync', 'renameSync', 'existsSync', 'statSync', 'openSync', 'accessSync'] as const;
  const real = Object.fromEntries(names.map((n) => [n, fs[n]]));
  const seen: string[] = [];
  for (const n of names) (fs as any)[n] = (p: unknown, ...rest: unknown[]) => {
    if (typeof p === 'string' && p.startsWith(dir)) seen.push(`${n} ${p.slice(dir.length)}`);
    return (real[n] as any)(p, ...rest);
  };
  syncBuiltinESMExports();
  try {
    await fn();
  } finally {
    for (const n of names) (fs as any)[n] = real[n];
    syncBuiltinESMExports();
  }
  return seen;
}

test('a card reaches a running turn\'s snapshot with no synchronous file call on the server\'s thread', async () => {
  const fake = join(root, 'claude');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);
  const store = new Store(join(root, 'db.sqlite'));
  store.typedHandlesUpTo = 0;
  const runner = new Runner(store, () => {}, () => ({}), fake);
  const clock = new FakeClock();
  runner.clock = clock;
  const p = store.createProject('Busy', null);
  const [a, b, c] = ['A', 'B', 'C'].map((title) => store.createTicket({ project_id: p.id, title, permission_mode: 'bypassPermissions', created_by: 'Cara' }));
  const turns = join(root, 'turns');
  const dir = join(turns, 'a');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'scheme-refs.json');
  writeFileSync(file, '{}');
  (runner as any).turns.set(a.id, { dir });
  // A turn whose folder is already gone gets no file made for it.
  (runner as any).turns.set(b.id, { dir: join(turns, 'gone') });

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
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as SchemeRefs).cards!.some((x) => x.minion === a.number), true);
  clock.advance(2_000);
  await runner.refsWritten();
  // Writes to one file run one at a time and the newest text wins: the file is whole and has the last refresh's cards.
  const refs = JSON.parse(readFileSync(file, 'utf8')) as SchemeRefs;
  assert.equal(refs.self, a.number);
  assert.equal(refs.cards!.length, 3);
  assert.deepEqual(fs.readdirSync(dir), ['scheme-refs.json']);
  assert.equal(fs.existsSync(join(turns, 'gone')), false);
  (runner as any).turns.clear();
});

test('the flake log is read with no synchronous file call on the server\'s thread', async () => {
  const dir = mkdtempSync(join(root, 'flakes-'));
  const store = new Store(join(dir, 'c.db'));
  const project = store.createProject('P', null);
  const shared = join(dir, 'shared');
  mkdirSync(join(shared, 'retro-log', '2026-11-20'), { recursive: true });
  const line = (t: string, branch: string) => `- ${t}Z · flake · test/x.test.ts · load 17.0 · ticket/${branch} · in CI`;
  writeFileSync(join(shared, 'retro-log', '2026-11-20', 'land.md'), `# Retro log\n\n${[line('05:00:14', 'a'), line('05:08:44', 'b'), line('05:16:02', 'c')].join('\n')}\n`);
  const woken: string[] = [];
  const fx = new FlakeFixes({ store, sharedDir: () => shared, wake: (_p: unknown, text: string) => void woken.push(text) } as any);
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
