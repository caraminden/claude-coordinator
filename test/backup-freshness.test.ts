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
const apps = [{ name: 'mandate', title: 'Mandate' }, { name: 'voice', title: 'Voice' }, { name: 'quiet', title: 'Quiet' }];

function world(dbAgeH: number | null, pulledAgoH: number | null, mandateDay: string | null, voiceDay: string | null) {
  const dir = mkdtempSync(join(root, 'w-'));
  const data = join(dir, 'data');
  mkdirSync(join(data, 'backups'), { recursive: true });
  const age = (f: string, h: number) => utimesSync(f, new Date(NOW - h * HOUR), new Date(NOW - h * HOUR));
  if (dbAgeH !== null) { const f = join(data, 'backups', 'coordinator-2026-11-19.db'); writeFileSync(f, 'x'.repeat(2048)); age(f, dbAgeH); }
  if (pulledAgoH !== null) { mkdirSync(join(data, 'offbox')); const f = join(data, 'offbox', '.pulled'); writeFileSync(f, ''); age(f, pulledAgoH); }
  for (const [name, day] of [['mandate', mandateDay], ['voice', voiceDay]] as const) {
    if (!day) continue;
    mkdirSync(join(dir, '.local/share', name, 'backups', day), { recursive: true });
    writeFileSync(join(dir, '.local/share', name, 'backups', day, `${name}.db`), 'x');
  }
  return readBackups(data, dir, apps, NOW);
}

test('a good night reads clean and lists every app yes or no', () => {
  const b = world(5, 6, '2026-11-19', null);
  assert.equal(b.db?.size, 2048);
  assert.deepEqual(b.apps.map((a) => [a.name, a.ok, a.day]), [['mandate', true, '2026-11-19'], ['voice', false, null], ['quiet', false, null]]);
  assert.deepEqual(backupProblems(b, NOW), [], 'an app that never wrote one is "no", not an alert');
});

test('a day-old database backup, a quiet off-box pull and a stopped app are each named', () => {
  assert.deepEqual(backupProblems(world(30, 6, '2026-11-19', null), NOW), ['the database backup is 30 h old']);
  assert.deepEqual(backupProblems(world(5, 40, '2026-11-19', null), NOW), ['the off-box copy was last pulled 40 h ago']);
  assert.deepEqual(backupProblems(world(5, null, '2026-11-19', '2026-11-16'), NOW), ['Voice last wrote a backup on 2026-11-16'], 'never pulled is not a miss yet');
  assert.deepEqual(backupProblems(world(null, null, null, null), NOW), ['no database backup on disk']);
});

test('deploy/offbox-serve.sh list marks the pull', () => {
  const dir = mkdtempSync(join(root, 'serve-'));
  mkdirSync(join(dir, 'offbox'));
  writeFileSync(join(dir, 'offbox', 'SHA256SUMS'), '');
  execFileSync(join(import.meta.dirname, '..', 'deploy', 'offbox-serve.sh'), { env: { ...process.env, DATA_DIR: dir, SSH_ORIGINAL_COMMAND: 'list' } });
  assert.ok(readBackups(dir, dir, [], Date.now()).pulledAt! > Date.now() - 60_000);
});
