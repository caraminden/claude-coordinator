import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { backupGaps, flagUnbacked, hasDatabase, type FlagApp } from '../src/backup-flag.ts';

// #1383: an app with a database but no backup timer or disk_warn_gb is flagged to its scheme's Taskmaster, once.
const root = mkdtempSync(join(tmpdir(), 'backup-flag-'));
after(() => rmSync(root, { recursive: true, force: true }));
const data = (name: string, files: Record<string, string>) => {
  const d = join(root, name);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), body);
  }
  mkdirSync(d, { recursive: true });
};
data('bare', { 'app.db': 'x' });
data('nodb', { 'notes.txt': 'x' });
data('ok', { 'sub/store.sqlite': 'x' });
data('onlycopy', { 'backups/2026-11-19/app.db': 'x' });
const full = { timers: { backup: {} }, disk_warn_gb: 5 };
const manifests: Record<string, { timers: Record<string, unknown>; disk_warn_gb: number | null }> = {
  bare: { timers: {}, disk_warn_gb: null },
  nodb: { timers: {}, disk_warn_gb: null },
  ok: full,
  onlycopy: { timers: {}, disk_warn_gb: null },
};

test('a database is found in the data dir, but a backup copy is not one', async () => {
  assert.equal(await hasDatabase(join(root, 'bare')), true);
  assert.equal(await hasDatabase(join(root, 'ok')), true);
  assert.equal(await hasDatabase(join(root, 'nodb')), false);
  assert.equal(await hasDatabase(join(root, 'onlycopy')), false);
  assert.equal(await hasDatabase(join(root, 'missing')), false);
});

test('gaps name what is missing', () => {
  assert.deepEqual(backupGaps(true, manifests.bare), ['no `backup` timer', 'no `disk_warn_gb`']);
  assert.deepEqual(backupGaps(true, { timers: { backup: {} }, disk_warn_gb: null }), ['no `disk_warn_gb`']);
  assert.deepEqual(backupGaps(true, full), []);
  assert.deepEqual(backupGaps(false, manifests.bare), []);
});

test('flags once per app and gap set, per its own scheme, and again after a change', async () => {
  const apps: FlagApp[] = ['bare', 'nodb', 'ok', 'onlycopy'].map((name, i) => ({ name, title: name, home_scheme: i === 0 ? 7 : 8 }));
  let state: Record<string, string> = {};
  const mails: { id: number; text: string }[] = [];
  const deps = {
    apps: () => apps,
    dataDir: (a: FlagApp) => join(root, a.name),
    manifest: async (a: FlagApp) => manifests[a.name],
    taskmaster: (s: number) => s + 100,
    mail: (id: number, text: string) => mails.push({ id, text }),
    getState: () => state,
    setState: (s: Record<string, string>) => {
      state = s;
    },
  };
  const first = await flagUnbacked(deps);
  assert.deepEqual(
    first.map((f) => f.app),
    ['bare'],
    'only the app with a DB and no convention',
  );
  assert.equal(mails.length, 1);
  assert.equal(mails[0].id, 107, "its own scheme's Taskmaster, not Citadel's");
  assert.match(mails[0].text, /no `backup` timer and no `disk_warn_gb`/);
  assert.deepEqual(await flagUnbacked(deps), [], 'not again');
  manifests.bare = { timers: {}, disk_warn_gb: 5 };
  assert.equal((await flagUnbacked(deps)).length, 1, 'a changed set flags again');
  manifests.bare = full;
  assert.deepEqual(await flagUnbacked(deps), []);
  assert.deepEqual(Object.keys(state), [' ran'], 'a fixed app is forgotten');
});

test('an app whose scheme has no Taskmaster is tried again next round', async () => {
  let state: Record<string, string> = {};
  let tm: number | null = null;
  const mails: number[] = [];
  const deps = {
    apps: () => [{ name: 'bare', title: 'Bare', home_scheme: 3 }],
    dataDir: () => join(root, 'bare'),
    manifest: async () => ({ timers: {}, disk_warn_gb: null }),
    taskmaster: () => tm,
    mail: (id: number) => mails.push(id),
    getState: () => state,
    setState: (s: Record<string, string>) => {
      state = s;
    },
  };
  assert.deepEqual(await flagUnbacked(deps), []);
  tm = 9;
  assert.equal((await flagUnbacked(deps)).length, 1);
  assert.deepEqual(mails, [9]);
});

test('a restart skips the round when one ran today, and an old row without a day runs once (#1735)', async () => {
  let state: Record<string, string> = {};
  let rounds = 0;
  const deps = {
    apps: () => {
      rounds++;
      return [];
    },
    dataDir: () => root,
    manifest: async () => full,
    taskmaster: () => 1,
    mail: () => {},
    getState: () => state,
    setState: (s: Record<string, string>) => {
      state = s;
    },
  };
  const noon = Date.UTC(2026, 10, 23, 20);
  await flagUnbacked(deps, { oncePerDay: true, now: noon });
  assert.equal(rounds, 1, 'a saved row without a day runs once');
  await flagUnbacked(deps, { oncePerDay: true, now: noon + 3_600_000 });
  assert.equal(rounds, 1, 'same Pacific day: skipped');
  await flagUnbacked(deps, { now: noon + 3_600_000 });
  assert.equal(rounds, 2, 'the daily timer always runs');
  await flagUnbacked(deps, { oncePerDay: true, now: noon + 24 * 3_600_000 });
  assert.equal(rounds, 3, 'next day: runs');
});
