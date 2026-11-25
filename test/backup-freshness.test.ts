// Backup freshness (#1142): what the Status line and the watchdog's push read.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { backupProblems, readBackups } from '../src/backup-freshness.ts';

const root = mkdtempSync(join(tmpdir(), 'freshness-'));
after(() => rmSync(root, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-19T20:00:00Z');
const apps = [
  { name: 'mandate', title: 'Mandate' },
  { name: 'voice', title: 'Voice' },
  { name: 'quiet', title: 'Quiet' },
];

async function world(dbAgeH: number | null, pulledAgoH: number | null, mandateDay: string | null, voiceDay: string | null, setAgoH: number | null = pulledAgoH === null ? null : 5) {
  const dir = mkdtempSync(join(root, 'w-'));
  const data = join(dir, 'data');
  mkdirSync(join(data, 'backups'), { recursive: true });
  const age = (f: string, h: number) => utimesSync(f, new Date(NOW - h * HOUR), new Date(NOW - h * HOUR));
  if (dbAgeH !== null) {
    const f = join(data, 'backups', 'coordinator-2026-11-19.db');
    writeFileSync(f, 'x'.repeat(2048));
    age(f, dbAgeH);
  }
  if (pulledAgoH !== null || setAgoH !== null) mkdirSync(join(data, 'offbox'));
  if (pulledAgoH !== null) {
    const f = join(data, 'offbox', '.pulled');
    writeFileSync(f, '');
    age(f, pulledAgoH);
  }
  if (setAgoH !== null) {
    const f = join(data, 'offbox', 'SHA256SUMS');
    writeFileSync(f, '');
    age(f, setAgoH);
  }
  for (const [name, day] of [
    ['mandate', mandateDay],
    ['voice', voiceDay],
  ] as const) {
    if (!day) continue;
    mkdirSync(join(dir, '.local/share', name, 'backups', day), { recursive: true });
    writeFileSync(join(dir, '.local/share', name, 'backups', day, `${name}.db`), 'x');
  }
  return readBackups(data, dir, apps, NOW);
}

test('a good night reads clean and lists every app yes or no', async () => {
  const b = await world(5, 6, '2026-11-19', null);
  assert.equal(b.db?.size, 2048);
  assert.deepEqual(
    b.apps.map((a) => [a.name, a.ok, a.day]),
    [
      ['mandate', true, '2026-11-19'],
      ['voice', false, null],
      ['quiet', false, null],
    ],
  );
  assert.deepEqual(backupProblems(b, NOW), [], 'an app that never wrote one is "no", not an alert');
});

test('a day-old database backup, a quiet off-box pull and a stopped app are each named', async () => {
  assert.deepEqual(backupProblems(await world(30, 6, '2026-11-19', null), NOW), ['the database backup is 30 h old']);
  assert.deepEqual(backupProblems(await world(5, 40, '2026-11-19', null), NOW), ['the off-box copy was last pulled 40 h ago']);
  assert.deepEqual(backupProblems(await world(5, null, '2026-11-19', '2026-11-16'), NOW), ['Voice last wrote a backup on 2026-11-16'], 'never pulled is not a miss yet');
  assert.deepEqual(backupProblems(await world(null, null, null, null), NOW), ['no database backup on disk']);
});

test('a fresh pull of an off-box set that stopped being made is a miss (B1): the list touches .pulled every night', async () => {
  // backup.sh's state-db check or offbox.sh exiting 1 leaves SHA256SUMS behind while the desktop keeps listing it.
  assert.deepEqual(backupProblems(await world(5, 6, '2026-11-19', null, 30), NOW), ['the off-box set was last made 30 h ago']);
  assert.deepEqual(backupProblems(await world(5, null, '2026-11-19', null, 30), NOW), ['the off-box set was last made 30 h ago'], 'made but never pulled still says the set is old');
  assert.equal((await world(5, 6, null, null, 7)).setAt, NOW - 7 * HOUR);
  assert.equal((await world(5, null, null, null)).setAt, null, 'no off-box folder: not set up here');
  assert.deepEqual(backupProblems(await world(5, 6, '2026-11-19', null, null), NOW), ['the off-box set is missing (no SHA256SUMS)'], 'pulled, but the list it reads is gone');
});

test('deploy/offbox-serve.sh list marks the pull', async () => {
  const dir = mkdtempSync(join(root, 'serve-'));
  mkdirSync(join(dir, 'offbox'));
  writeFileSync(join(dir, 'offbox', 'SHA256SUMS'), '');
  execFileSync(join(import.meta.dirname, '..', 'deploy', 'offbox-serve.sh'), { env: { ...process.env, DATA_DIR: dir, SSH_ORIGINAL_COMMAND: 'list' } });
  assert.ok((await readBackups(dir, dir, [], Date.now())).pulledAt! > Date.now() - 60_000);
});
