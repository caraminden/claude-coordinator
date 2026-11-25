import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BURST_MS, CompactWatch, filesRead } from '../src/compactions.ts';
import type { Ticket } from '../src/db.ts';
import type { ClaudeEvent } from '../src/claude-events.ts';

// A minion that compacts again and again is called out (#1920; Josh, 2026-11-24: "we cant have that kind of thing just
// silently going on"): its chat and its Taskmaster, with the files it keeps reading. Run as Peek Auras' minion (scheme 3).
const boundary = (ms = 60_000): ClaudeEvent => ({ type: 'system', subtype: 'compact_boundary', compact_metadata: { duration_ms: ms } });
const read = (name: string, input: Record<string, unknown>, over: object = {}): ClaudeEvent => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name, input }] }, ...over });

function world(over: Partial<Ticket> = {}) {
  const told: { text: string; wake: boolean }[] = [];
  const notes: string[] = [];
  let at = 1_000_000;
  const ticket = { id: 7, number: 12, title: 'A minion', kind: 'ticket', status: 'running', project_id: 3, ...over } as Ticket;
  const watch = new CompactWatch({ ticket: () => ticket, tell: (_t, text, wake) => told.push({ text, wake }), note: (_id, text) => notes.push(text), now: () => at });
  return { watch, told, notes, step: (ms: number) => (at += ms) };
}

test('the second compaction within 15 minutes is called out in the chat and to the Taskmaster, with the files read again', () => {
  const w = world();
  w.watch.observe(7, read('Bash', { command: "cd /w && sed -n '1,200p' tools/land.sh | head -90; git status" }));
  w.watch.observe(7, read('Read', { file_path: '/w/src/once.ts' }));
  w.watch.observe(7, boundary());
  assert.deepEqual(w.notes, [], 'one compaction is not a burst');
  w.step(BURST_MS);
  w.watch.observe(7, read('Bash', { command: 'cat /w/tools/land.sh' }));
  w.watch.observe(7, boundary(90_000));
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0], /2 times in a row.*3 min of this turn.*land\.sh \(in 2 of 2 stretches\)/);
  assert.doesNotMatch(w.notes[0], /once\.ts/);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].text, /^Stall signal on #12 A minion: compacting over and over/);
  assert.equal(w.told[0].wake, false, 'held mail at first');
  assert.deepEqual(w.watch.of(7), { n: 2, ms: 150_000 });
});

test('a burst that goes on is said at the fourth, waking the Taskmaster; a gap over 15 minutes starts again', () => {
  const w = world();
  for (let i = 0; i < 5; i++) w.step(60_000), w.watch.observe(7, boundary());
  assert.deepEqual(
    w.told.map((t) => t.wake),
    [false, true],
    'at 2 and 4, not at 3 or 5',
  );
  w.step(BURST_MS + 1);
  w.watch.observe(7, boundary());
  assert.equal(w.told.length, 2);
  w.watch.ended(7);
  assert.equal(w.watch.of(7), null, 'a turn that ended takes its count with it');
});

test("a Grunt's compactions, a Taskmaster's and a dismissed minion's are not called out; allow_large reads are counted", () => {
  const w = world();
  for (let i = 0; i < 4; i++) w.watch.observe(7, { ...boundary(), parent_tool_use_id: 'grunt' });
  assert.equal(w.watch.of(7), null);
  for (const over of [{ kind: 'coordinator' }, { status: 'closed' }] as Partial<Ticket>[]) {
    const o = world(over);
    o.watch.observe(7, boundary());
    o.watch.observe(7, boundary());
    assert.deepEqual([o.notes, o.told], [[], []]);
    assert.equal(o.watch.of(7)?.n, 2, 'still counted beside the meter');
  }
  w.watch.observe(7, read('Bash', { command: 'cat big.ts # allow_large' }));
  w.watch.observe(7, read('Read', { file_path: 'big.ts', allow_large: true }));
  w.watch.observe(7, boundary());
  w.watch.observe(7, boundary());
  assert.match(w.notes[0], /No file was read again after one.*past the big-read checks 2 times/);
});

test('filesRead names the files a printing command shows, not those it writes or runs', () => {
  const bash = (command: string) => filesRead('Bash', { command });
  assert.deepEqual(bash("cd /w && sed -n '1,9p' a/x.ts y.sh | cut -c1-90"), ['x.ts', 'y.sh']);
  assert.deepEqual(bash("cat > out.txt <<'E'"), []);
  assert.deepEqual(bash('node tools/typecheck.ts; tail -n 5 "$TMPDIR/citadel-test.log"'), ['citadel-test.log']);
  assert.deepEqual(filesRead('Edit', { file_path: 'x.ts' }), []);
});

test('a boundary with no duration is counted, with no minutes made up', () => {
  const w = world();
  for (let i = 0; i < 2; i++) w.watch.observe(7, { type: 'system', subtype: 'compact_boundary' });
  assert.equal(w.notes.length, 1);
  assert.doesNotMatch(w.notes[0], / min of this turn/);
});
