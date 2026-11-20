import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readFolder } from '../src/memory-files.ts';
import { applyChanges, checkChanges, countLine, KEEP_MS, MEMORY_PROPOSALS_SCHEMA, MemoryProposals, restoreSaved, withDrift, withLine } from '../src/memory-curator.ts';

const A = '---\nname: A\ndescription: first\n---\nalpha\n';
const B = '---\nname: B\ndescription: second\n---\nbeta\n';
const C = '---\nname: C\ndescription: unindexed\n---\ngamma\n';
const setup = () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'curator-')), 'memory');
  mkdirSync(dir);
  writeFileSync(join(dir, 'a.md'), A);
  writeFileSync(join(dir, 'b.md'), B);
  writeFileSync(join(dir, 'c.md'), C);
  writeFileSync(join(dir, 'MEMORY.md'), '- [A](a.md) — first\n- [B](b.md) — second\n');
  return dir;
};
const view = (dir: string) => readFolder({ label: 'x', dir, id: 'x', rel: 'r' }, () => false);
const snapshot = (dir: string) => ['a.md', 'b.md', 'c.md', 'd.md', 'MEMORY.md'].map((f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null));

test('checkChanges refuses bad changes and keeps what each note was', () => {
  const dir = setup();
  const v = view(dir);
  const bad: [unknown, RegExp][] = [
    [[], /at least one/],
    [[{ action: 'zap', file: 'a.md', reason: 'r' }], /action/],
    [[{ action: 'flag', file: '../a.md', reason: 'r' }], /file name/],
    [[{ action: 'flag', file: 'MEMORY.md', reason: 'r' }], /file name/],
    [[{ action: 'flag', file: 'a.md', reason: '' }], /reason/],
    [[{ action: 'flag', file: 'a.md', reason: 'r' }, { action: 'delete', file: 'a.md', reason: 'r' }], /two changes/],
    [[{ action: 'delete', file: 'zz.md', reason: 'r' }], /no note/],
    [[{ action: 'add', file: 'a.md', text: 'x', line: '- [A](a.md)', reason: 'r' }], /already exists/],
    [[{ action: 'edit', file: 'a.md', text: A, reason: 'r' }], /as it is now/],
    [[{ action: 'index', file: 'c.md', line: '- [C](a.md)', reason: 'r' }], /links the note/],
    [[{ action: 'index', file: 'c.md', line: '- [C](c.md)\n- [D](d.md)', reason: 'r' }], /one line/],
    [[{ action: 'index', file: 'a.md', line: '- [A](a.md) — first', reason: 'r' }], /as it is now/],
    [[{ action: 'add', file: 'd.md', text: 'x', reason: 'r' }], /needs line/],
  ];
  for (const [changes, msg] of bad) assert.throws(() => checkChanges(v, changes), msg, JSON.stringify(changes));
  const ok = checkChanges(v, [
    { action: 'edit', file: 'a.md', text: 'new a', line: '- [A](a.md) — first', reason: 'merged' },
    { action: 'index', file: 'c.md', line: '- [C](c.md) — unindexed', reason: 'unindexed' },
  ]);
  assert.equal(ok[0].text, 'new a\n');
  assert.equal(ok[0].line, null, 'an edit that keeps the line changes only the text');
  assert.equal(ok[0].was, A);
  assert.equal(ok[1].wasLine, null);
});

test('withLine replaces in place, drops duplicates, appends or removes', () => {
  const idx = '# Memory\n- [A](a.md) — old\n- [B](b.md)\n- [A again](a.md)\n';
  assert.equal(withLine(idx, 'a.md', '- [A](a.md) — new'), '# Memory\n- [A](a.md) — new\n- [B](b.md)\n');
  assert.equal(withLine(idx, 'c.md', '- [C](c.md)'), `${idx}- [C](c.md)\n`);
  assert.equal(withLine(idx, 'a.md', null), '# Memory\n- [B](b.md)\n');
  assert.equal(withLine('', 'a.md', '- [A](a.md)'), '- [A](a.md)\n');
});

test('nothing changes until approve, and only the ticked changes apply', () => {
  const dir = setup();
  const before = snapshot(dir);
  const changes = checkChanges(view(dir), [
    { action: 'edit', file: 'a.md', text: 'merged a+b', line: '- [A](a.md) — a and b', reason: 'merge' },
    { action: 'delete', file: 'b.md', reason: 'merged into a' },
    { action: 'index', file: 'c.md', line: '- [C](c.md) — unindexed', reason: 'unindexed' },
    { action: 'add', file: 'd.md', text: 'new', line: '- [D](d.md) — new', reason: 'split' },
  ]);
  assert.deepEqual(snapshot(dir), before, 'checking a proposal writes nothing');
  const gone: string[] = [];
  const { changes: out, backup } = applyChanges(dir, changes, new Set([1, 3, 4]), (f) => gone.push(f));
  assert.deepEqual(out.map((c) => c.outcome), ['applied', 'turned down', 'applied', 'applied']);
  assert.equal(readFileSync(join(dir, 'a.md'), 'utf8'), 'merged a+b\n');
  assert.equal(readFileSync(join(dir, 'b.md'), 'utf8'), B, 'an unticked delete leaves the note');
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [A](a.md) — a and b\n- [B](b.md) — second\n- [C](c.md) — unindexed\n- [D](d.md) — new\n');
  assert.deepEqual(gone, []);
  assert.equal(backup.length, 3);
  // Put back restores every note and line, and removes the note the proposal added.
  assert.equal(restoreSaved(dir, backup, (f) => gone.push(f)), 3);
  assert.deepEqual(snapshot(dir), before);
  assert.deepEqual(gone, ['d.md']);
});

test('a delete removes the note and its line, and put back brings both back', () => {
  const dir = setup();
  const before = snapshot(dir);
  const changes = checkChanges(view(dir), [{ action: 'delete', file: 'b.md', reason: 'stale' }]);
  const gone: string[] = [];
  const { backup } = applyChanges(dir, changes, new Set([1]), (f) => gone.push(f));
  assert.equal(existsSync(join(dir, 'b.md')), false);
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [A](a.md) — first\n');
  assert.deepEqual(gone, ['b.md']);
  restoreSaved(dir, backup);
  assert.deepEqual(snapshot(dir), before);
});

test('a note changed since the proposal is skipped, and the page sees it first', () => {
  const dir = setup();
  const changes = checkChanges(view(dir), [
    { action: 'edit', file: 'a.md', text: 'curated', reason: 'r' },
    { action: 'index', file: 'c.md', line: '- [C](c.md) — x', reason: 'r' },
    { action: 'add', file: 'd.md', text: 'new', line: '- [D](d.md)', reason: 'r' },
    { action: 'flag', file: 'b.md', reason: 'live state: make it a pointer' },
  ]);
  writeFileSync(join(dir, 'a.md'), 'someone edited it\n');
  writeFileSync(join(dir, 'MEMORY.md'), '- [A](a.md) — first\n- [B](b.md) — second\n- [C](c.md) — by hand\n');
  writeFileSync(join(dir, 'd.md'), 'made by hand\n');
  assert.deepEqual(withDrift(dir, changes).map((c) => c.drifted), [true, true, true, false]);
  const { changes: out, backup } = applyChanges(dir, changes, new Set([1, 2, 3, 4]));
  assert.deepEqual(out.map((c) => c.outcome), ['changed since', 'changed since', 'changed since', 'noted']);
  assert.equal(readFileSync(join(dir, 'a.md'), 'utf8'), 'someone edited it\n');
  assert.equal(readFileSync(join(dir, 'd.md'), 'utf8'), 'made by hand\n');
  assert.deepEqual(backup, []);
});

test('a full MEMORY.md fails that change before its note is touched, and the rest go on', () => {
  const dir = setup();
  writeFileSync(join(dir, 'MEMORY.md'), `- [A](a.md) — first\n- [B](b.md) — second\n${'- filler\n'.repeat(198)}`);
  const changes = checkChanges(view(dir), [
    { action: 'add', file: 'd.md', text: 'new', line: '- [D](d.md)', reason: 'r' },
    { action: 'edit', file: 'b.md', text: 'tidier b', reason: 'r' },
  ]);
  const { changes: out } = applyChanges(dir, changes, new Set([1, 2]));
  assert.match(out[0].outcome!, /^failed: MEMORY.md would pass/);
  assert.equal(existsSync(join(dir, 'd.md')), false);
  assert.equal(out[1].outcome, 'applied');
});

test('countLine names each kind once', () => {
  assert.equal(countLine([{ action: 'index' }, { action: 'index' }, { action: 'delete' }, { action: 'flag' }]), '1 delete, 2 index lines, 1 flag');
});

test('the store supersedes an open proposal, decides once, and drops old notes after 30 days', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY);INSERT INTO projects VALUES (1),(2);');
  db.exec(MEMORY_PROPOSALS_SCHEMA);
  const s = new MemoryProposals(db);
  const one = s.create({ project_id: 1, ticket_id: 10, folder: 'f', changes: [] }, 1000).proposal;
  s.create({ project_id: 2, ticket_id: 20, folder: 'f', changes: [] }, 1000);
  const { proposal: two, superseded } = s.create({ project_id: 1, ticket_id: 11, folder: 'f', changes: [] }, 2000);
  assert.deepEqual(superseded.map((p) => p.id), [one.id]);
  assert.equal(s.get(one.id)!.status, 'superseded');
  assert.equal(s.open(1)!.id, two.id);
  assert.equal(s.open(2)!.ticket_id, 20, 'another scheme keeps its own');
  const backup = [{ file: 'a.md', text: 'old', line: null }];
  assert.equal(s.decide(one.id, { status: 'applied', changes: [], backup, by: 'josh' }), false, 'a superseded one can no longer be decided');
  assert.equal(s.decide(two.id, { status: 'applied', changes: [], backup, by: 'josh' }, 3000), true);
  assert.equal(s.decide(two.id, { status: 'dismissed', changes: [], backup: [], by: 'cara' }), false, 'decided once');
  assert.deepEqual(s.kept(1).map((p) => p.backup), [backup]);
  assert.equal(s.prune(3000 + KEEP_MS - 1), 0);
  assert.equal(s.prune(3000 + KEEP_MS + 1), 1);
  assert.deepEqual(s.kept(1), []);
});
