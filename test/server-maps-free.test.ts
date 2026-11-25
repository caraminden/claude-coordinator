// The server's small per-minion lists (#1761, leak hunt #1756 finding D): a closed minion's entries go, a hung call's heartbeat stops.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { HISTORY_CACHE_MAX, gitEdits, historyCacheSize } from '../src/decisions.ts';
import { beatWhileOpen } from '../src/pool-context.ts';
import { Runner } from '../src/runner.ts';
import { testPins } from './helpers.ts';
import { holds } from './holds.ts';
import { until } from './wait.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'server-maps-'));
after(() => rmSync(root, { recursive: true, force: true }));

test("closing a minion frees its entries in the runner's per-minion maps", () => {
  const store = new Store(join(root, 'a.db'));
  const project = store.createProject('P', null);
  const runner: any = new Runner(
    store,
    () => {},
    () => ({}),
    '/bin/true',
  );
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const other = 999999;
  for (const id of [t.id, other]) {
    runner.progressFor(id);
    runner.mainModels.set(id, 'm');
    runner.gateCounted.set(id, { ended: 1, day: 'd', gate: 'g' });
  }
  runner.close(t.id, 'done');
  for (const f of ['progress', 'mainModels', 'gateCounted']) {
    assert.equal(runner[f].has(t.id), false, `${f} dropped the closed minion`);
    assert.equal(runner[f].has(other), true, `${f} kept another minion's entry`);
  }
});

test('an account-error push is allowed once an hour, and old texts are forgotten', () => {
  const runner: any = new Runner(
    new Store(join(root, 'b.db')),
    () => {},
    () => ({}),
    '/bin/true',
  );
  assert.equal(runner.firstAccountPush('x', 0), true);
  assert.equal(runner.firstAccountPush('x', 1000), false);
  assert.equal(runner.firstAccountPush('y', 2 * 3600_000), true);
  assert.equal(runner.accountPushes.size, 1, 'x aged out');
  assert.equal(runner.firstAccountPush('x', 2 * 3600_000 + 1), true);
});

test('a heartbeat stops when its response closes, even if the call never answers', async () => {
  const res: any = new EventEmitter();
  let beats = 0;
  res.write = () => beats++;
  beatWhileOpen(res, 5);
  await until('two beats', () => beats >= 2);
  res.emit('close');
  const at = beats;
  // A leaked timer would beat again; a witness timer, firing after several beat periods, bounds the watch.
  let witness = false;
  setTimeout(() => (witness = true), 60);
  await holds('the heartbeat stays stopped', () => beats === at, { after: () => witness });
});

test('the git-history cache is capped', async () => {
  const repo = join(root, 'repo');
  const run = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['init', '-q', repo]);
  // A dated line in every file, so a miss (a real git read) calls href once and a hit never does.
  const total = HISTORY_CACHE_MAX + 4;
  for (let i = 0; i < total; i++) writeFileSync(join(repo, `f${i}.md`), 'on 2026-11-24 something\n');
  run('add', '.');
  run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
  let reads = 0;
  const href = () => {
    reads++;
    return null;
  };
  for (let i = 0; i < total; i++) await gitEdits(repo, [`f${i}.md`], href);
  assert.equal(reads, total);

  assert.equal(historyCacheSize(), HISTORY_CACHE_MAX);
  await gitEdits(repo, [`f${total - 1}.md`], href);
  assert.equal(reads, total, 'the newest key is still cached');
  await gitEdits(repo, ['f0.md'], href);
  assert.equal(reads, total + 1, 'the first key was evicted, so it is read again');
  // 2ME6: a refresh of a key that is already cached (its HEAD moved) evicts no other scheme's entry.
  const full = historyCacheSize();
  run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'moves HEAD');
  const before = reads;
  await gitEdits(repo, [`f${total - 1}.md`], href);
  assert.equal(reads, before + 1, 'refreshed after HEAD moved');
  assert.equal(historyCacheSize(), full, 'the refreshed key replaced its own entry; no other repo lost one');
});
