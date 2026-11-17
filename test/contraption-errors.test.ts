import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { errorKey, ErrorDigest, isErrorLine, pacificDay, sampleLine, type JournalEntry } from '../src/contraption-errors.ts';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';

// Every contraption's errors in one daily file per owning scheme (#835): failed agent tool calls, 5xx answers
// through the proxy and error lines in its journal, grouped with numbers and ids taken out, a count and one sample each.
const root = mkdtempSync(join(tmpdir(), 'contraption-errors-'));
after(() => rmSync(root, { recursive: true, force: true }));
// 2026-11-16 is in PST (UTC-8): 07:59 UTC is 23:59 on the 15th, 08:00 UTC is midnight on the 16th.
const NOV15_LATE = Date.UTC(2026, 10, 16, 7, 59);
const NOV16 = Date.UTC(2026, 10, 16, 8, 0);
const NOV16_NOON = Date.UTC(2026, 10, 16, 20, 0);
const NOV17 = Date.UTC(2026, 10, 17, 9, 0);

test('the day is the Pacific one', () => {
  assert.equal(pacificDay(NOV15_LATE), '2026-11-15');
  assert.equal(pacificDay(NOV16), '2026-11-16');
});

test('a group is the message with numbers, ids, times and long quoted text taken out', () => {
  const same = [
    'Error: room 1234 not found (request 3f2a9c1e-77b0-4d2e-9a51-0c1d2e3f4a5b at 2026-11-16T09:12:44.120Z)',
    'Error: room 98 not found (request 0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9 at 2026-11-15T23:01:02Z)',
  ];
  assert.equal(errorKey(same[0]), errorKey(same[1]));
  assert.notEqual(errorKey('Error: room 12 not found'), errorKey('Error: player 12 not found'));
  assert.equal(errorKey('fetch failed for job 5f3e2a9b8c7d'), errorKey('fetch failed for job a01b9c33ee21'), 'hex ids');
  assert.equal(errorKey('bad input "what a lovely long message this is from a player"'), errorKey('bad input "another long player message that differs entirely"'), 'long quoted text');
  assert.equal(errorKey('<tool_use_error>Error: No such tool available: mcp__peek__roll</tool_use_error>'), 'Error: No such tool available: mcp__peek__roll');
  assert.equal(errorKey('first line 1\n    at foo (x.js:10:2)\n    at bar'), 'first line #', 'only the first line');
});

test('a sample is one scrubbed, short line', () => {
  const s = sampleLine('Request failed: Authorization: Bearer sk-abcdef123456 password=hunter2\nsecond line with the player text');
  assert.doesNotMatch(s, /sk-abcdef123456|hunter2|second line/);
  assert.match(s, /Request failed/);
  assert.ok(sampleLine('x'.repeat(1000)).length <= 200);
});

test('which journal lines are errors', () => {
  for (const l of ['Error: ENOENT: no such file', 'Traceback (most recent call last):', 'TypeError: x is not a function', 'citadel-app-peek.service: Main process exited, code=exited, status=1/FAILURE',
    "citadel-app-peek.service: Failed with result 'exit-code'.", 'Unhandled promise rejection', 'FATAL: database is locked', 'panic: runtime error']) assert.ok(isErrorLine(l, 6), l);
  for (const l of ['Started Peek Auras (Citadel contraption).', 'citadel-app-peek.service: Consumed 1.2s CPU time', 'ggg_forum: 0 errors, 3 facts added',
    'citadel-app-peek.service: Main process exited, code=exited, status=0/SUCCESS', 'retire drop-disabled-uniques: 2 retired']) assert.ok(!isErrorLine(l, 6), l);
  assert.ok(isErrorLine('something odd', 3), 'priority err and worse');
});

test('counts per app, day and group, written to the owning scheme\'s shared folder, and the morning count', async () => {
  const store = new Store(join(root, 'coordinator.db'));
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const peekScheme = store.createProject('Peek Auras', null, josh.id);
  const quiet = store.createProject('Quiet', null, josh.id);
  const c = new Contraptions(store, 's'.repeat(40), join(root, 'keys'));
  const peek = c.register({ name: 'peek-auras', title: 'Peek Auras', port: 9201, icon: null, home_scheme: peekScheme.id, open_paths: '[]', default_model: null, turn_cap: null });
  c.register({ name: 'calm', title: 'Calm', port: 9202, icon: null, home_scheme: quiet.id, open_paths: '[]', default_model: null, turn_cap: null });
  const orphan = c.register({ name: 'orphan', title: 'Orphan', port: 9203, icon: null, home_scheme: null, open_paths: '[]', default_model: null, turn_cap: null });
  const shared = (id: number) => join(root, 'shared', String(id));
  let now = NOV15_LATE;
  let journal: JournalEntry[] = [];
  const cursors: (string | null)[] = [];
  const digest = new ErrorDigest(store, {
    sharedDir: shared,
    now: () => now,
    journal: async (row, cursor) => {
      if (row.name !== 'peek-auras') return { entries: [], cursor };
      cursors.push(cursor);
      const out = journal;
      journal = [];
      return { entries: out, cursor: out.length ? `c${cursors.length}` : cursor };
    },
  });

  // Ten calls to a disabled tool, in two different rooms; one bad call to Read; a 502 twice on ids; one on the 16th.
  for (let i = 0; i < 10; i++) digest.toolError(peek, 'mcp__peek__roll', `<tool_use_error>Error: No such tool available: mcp__peek__roll (room ${i})</tool_use_error>`);
  digest.toolError(peek, 'Read', 'File does not exist: /home/peek/notes/42.md');
  digest.httpError(peek, 502, 'GET', '/api/rooms/17/state?token=abc');
  digest.httpError(peek, 502, 'GET', '/api/rooms/9000/state');
  digest.toolError(orphan, 'Bash', 'exit 1');
  journal = [{ at: NOV15_LATE, unit: 'citadel-app-peek-auras.service', text: 'Error: ENOENT: no such file, open /srv/peek/rooms/77.json', priority: 6 },
    { at: NOV15_LATE, unit: 'citadel-app-peek-auras.service', text: 'Peek Auras contraption on 127.0.0.1:9201', priority: 6 }];
  await digest.tick();
  now = NOV16_NOON;
  digest.toolError(peek, 'mcp__peek__roll', 'Error: No such tool available: mcp__peek__roll');

  const day = store.contraptionErrors('2026-11-15');
  const tool = day.filter((r) => r.kind === 'tool' && r.name === 'peek-auras');
  assert.deepEqual(tool.map((r) => [r.key, r.count]).sort(), [['Read: File does not exist: /home/peek/notes/#.md', 1], ['mcp__peek__roll: Error: No such tool available: mcp__peek__roll (room #)', 10]]);
  const roll = tool.find((r) => r.count === 10)!;
  assert.equal(roll.sample, 'mcp__peek__roll: Error: No such tool available: mcp__peek__roll (room 0)', 'the first one seen, tags stripped');
  assert.deepEqual(day.filter((r) => r.kind === 'http').map((r) => [r.key, r.count]), [['502 GET /api/rooms/#/state', 2]], 'query dropped, ids grouped');
  assert.deepEqual(day.filter((r) => r.kind === 'log').map((r) => [r.key, r.count]), [['Error: ENOENT: no such file, open /srv/peek/rooms/#.json', 1]], 'only error lines');
  assert.equal(store.contraptionErrors('2026-11-16').reduce((n, r) => n + r.count, 0), 1);
  assert.deepEqual(cursors, [null]);

  // The day ends: its file is final, a scheme whose apps had no errors gets a file saying so, an app with no scheme none.
  now = NOV17;
  journal = [];
  await digest.tick();
  assert.deepEqual(cursors, [null, 'c1'], 'the journal is read on from where it stopped');
  const file = join(shared(peekScheme.id), 'reports', 'contraption-errors', '2026-11-15.md');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /## Peek Auras \(peek-auras\): 14/);
  const counts = [...text.matchAll(/^- (\d+) × (\w+)/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual([...counts.slice(0, 2), ...counts.slice(2).sort()], ['10 tool', '2 http', '1 log', '1 tool'], 'biggest first (the two 1s share a time)');
  assert.doesNotMatch(text, /token=abc/);
  assert.match(readFileSync(join(shared(quiet.id), 'reports', 'contraption-errors', '2026-11-15.md'), 'utf8'), /## Calm \(calm\): 0/);
  assert.ok(existsSync(join(shared(peekScheme.id), 'reports', 'contraption-errors', '2026-11-16.md')), 'the 16th is written too');

  // The Taskmaster's morning count: yesterday's total for its scheme's apps, and the file.
  assert.deepEqual(digest.summary(peekScheme.id, NOV17), { day: '2026-11-16', total: 1, apps: [{ title: 'Peek Auras', count: 1 }], file: 'reports/contraption-errors/2026-11-16.md' });
  assert.equal(digest.summary(quiet.id, NOV17), null, 'nothing to say');
});
