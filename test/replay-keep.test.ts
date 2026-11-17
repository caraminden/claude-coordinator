// Kept chats' deletes (#836, src/replay-keep.ts): a session's delete takes only that session's files, an opt-out takes
// all of a person's wherever they are (apps no longer registered too), and the daily sweep ages files out everywhere.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, test } from 'node:test';
import { dropKeptPerson, dropKeptSession, KEEP_DAYS, keptDirs, keptFile, sweepKept } from '../src/replay-keep.ts';

const data = mkdtempSync(join(tmpdir(), 'replay-keep-'));
after(() => rmSync(data, { recursive: true, force: true }));
const dirOf = (scheme: number, app: string) => join(data, 'projects', String(scheme), 'shared', 'project', '.replay', app);
const put = (dir: string, person: number, session: string, claude = 'abcdef0123') => {
  mkdirSync(dir, { recursive: true });
  const f = keptFile(dir, person, session, claude);
  writeFileSync(f, '{}\n');
  return basename(f);
};

test('deleting a session takes its files only, not those of a session whose name starts the same', () => {
  const dir = dirOf(1, 'app');
  const a = put(dir, 1, 'a');
  const a2 = put(dir, 1, 'a', '99999999ff');
  const ab = put(dir, 1, 'a-b');
  const other = put(dir, 2, 'a');
  dropKeptSession(dir, 1, 'a');
  assert.ok(![a, a2].some((f) => readdirSync(dir).includes(f)), 'every fresh start of a');
  assert.deepEqual(readdirSync(dir).sort(), [ab, other].sort());
});

test('an opt-out takes everything of the person\'s in every scheme\'s folders, unregistered apps included, and nobody else\'s', () => {
  const one = dirOf(3, 'live-app');
  const gone = dirOf(4, 'removed-app');
  put(one, 7, 's1');
  put(gone, 7, 's2');
  const kept = put(gone, 8, 's2');
  mkdirSync(join(data, 'projects', '5', 'shared', 'project'), { recursive: true }); // a scheme with nothing kept
  assert.deepEqual(keptDirs(data).sort(), [dirOf(1, 'app'), one, gone].sort());
  dropKeptPerson(keptDirs(data), 7);
  assert.deepEqual(readdirSync(one), []);
  assert.deepEqual(readdirSync(gone), [kept]);
});

test('the daily sweep drops files past KEEP_DAYS in every kept folder', () => {
  const dir = dirOf(6, 'quiet-app');
  const old = put(dir, 1, 'old');
  const fresh = put(dir, 1, 'fresh');
  const t = (Date.now() - (KEEP_DAYS + 1) * 86_400_000) / 1000;
  utimesSync(join(dir, old), t, t);
  sweepKept(data);
  assert.deepEqual(readdirSync(dir), [fresh]);
});
