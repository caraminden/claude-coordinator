import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteNote, indexNote, memoryDir, memoryFolders, noteFile, readFolder, saveNote, staleFlags } from '../src/memory-files.ts';

test("memoryFolders maps a repo path to each login's projects/<slug>/memory, once per distinct dir", () => {
  const repo = '/home/cara/.local/share/claude-coordinator/projects/7/repo';
  const got = memoryFolders(repo, [
    { label: "The server's own login", configDir: '/h/.claude' },
    { label: 'Dev account 2', configDir: '/d/claude-accounts/1/2' },
    { label: 'same as first', configDir: '/h/.claude' },
  ]);
  assert.deepEqual(
    got.map(({ id, ...f }) => f),
    [
      { label: "The server's own login", rel: 'projects/-home-cara--local-share-claude-coordinator-projects-7-repo/memory', dir: '/h/.claude/projects/-home-cara--local-share-claude-coordinator-projects-7-repo/memory' },
      { label: 'Dev account 2', rel: 'projects/-home-cara--local-share-claude-coordinator-projects-7-repo/memory', dir: '/d/claude-accounts/1/2/projects/-home-cara--local-share-claude-coordinator-projects-7-repo/memory' },
    ],
  );
  assert.notEqual(got[0].id, got[1].id);
  assert.equal(memoryDir('/c', '/a/b'), '/c/projects/-a-b/memory');
  assert.deepEqual(memoryFolders(null, [{ label: 'x', configDir: '/c' }]), []);
});

test('two accounts whose projects folder is one symlinked folder list it once (2ME9)', () => {
  const root = mkdtempSync(join(tmpdir(), 'memfiles-'));
  roots.push(root);
  const repo = '/some/repo';
  mkdirSync(join(root, 'one', 'projects'), { recursive: true });
  mkdirSync(join(root, 'two'), { recursive: true });
  symlinkSync(join(root, 'one', 'projects'), join(root, 'two', 'projects'));
  mkdirSync(memoryDir(join(root, 'one'), repo), { recursive: true });
  const got = memoryFolders(repo, [
    { label: 'one', configDir: join(root, 'one') },
    { label: 'two', configDir: join(root, 'two') },
  ]);
  assert.deepEqual(
    got.map((f) => f.label),
    ['one'],
  );
  assert.equal(got[0].dir, memoryDir(join(root, 'one'), repo), "the path and id stay the first login's");
});

test('noteFile refuses paths, the index and non-markdown', () => {
  for (const bad of ['../x.md', 'a/b.md', 'MEMORY.md', '.hidden.md', 'x.txt', 5, undefined]) assert.equal(noteFile(bad), null);
  assert.equal(noteFile('fable-burst.md'), 'fable-burst.md');
});

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'memfiles-'));
  roots.push(root);
  const dir = join(root, 'memory');
  mkdirSync(dir);
  writeFileSync(join(dir, 'a.md'), '---\nname: A note\ndescription: first\nmetadata:\n  type: project\n---\nSee #5 and recheck after 2020-01-01.\n');
  writeFileSync(join(dir, 'b.md'), '---\nname: B\ndescription: second\n---\nbody\n');
  writeFileSync(join(dir, 'MEMORY.md'), '- [A note](a.md) — first\n- [B](b.md) — second\n');
  return dir;
};

test('delete removes the file and only its index line, leaving the rest of the index', () => {
  const dir = setup();
  assert.equal(deleteNote(dir, 'a.md'), 1);
  assert.equal(existsSync(join(dir, 'a.md')), false);
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [B](b.md) — second\n');
  assert.throws(() => deleteNote(dir, 'a.md'), /No such note/);
});

test('delete takes only its own link from an index line that links two notes (ME3)', () => {
  const dir = setup();
  writeFileSync(join(dir, 'MEMORY.md'), '- [A note](a.md) and [B](b.md) — together\n- [B](b.md) — second\n');
  assert.equal(deleteNote(dir, 'a.md'), 1);
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- A note and [B](b.md) — together\n- [B](b.md) — second\n');
});

test('edit replaces a note whole and refuses one that is not there', () => {
  const dir = setup();
  saveNote(dir, 'b.md', 'new');
  assert.equal(readFileSync(join(dir, 'b.md'), 'utf8'), 'new');
  assert.throws(() => saveNote(dir, 'zzz.md', 'x'), /No such note/);
});

test('readFolder lists notes in index order with stale flags; a missing folder is not reachable', () => {
  const dir = setup();
  const v = readFolder({ label: 'L', dir }, (n) => n === 5, Date.parse('2026-11-19T12:00:00-08:00'));
  assert.deepEqual(
    v.notes.map((n) => [n.file, n.name, n.type]),
    [
      ['a.md', 'A note', 'project'],
      ['b.md', 'B', ''],
    ],
  );
  assert.deepEqual(v.notes[0].flags, { closed: [5], datesPast: ['2020-01-01'], datesSoon: [] });
  assert.equal(readFolder({ label: 'L', dir: join(dir, 'nope') }, () => false).reachable, false);
});

test('staleFlags: only dates after a recheck-style word, past or within 3 days', () => {
  const now = Date.parse('2026-11-19T12:00:00-08:00');
  const f = staleFlags('recheck after 2026-11-21; shipped 2026-01-01; by 2027-01-01', () => false, now);
  assert.deepEqual(f, { closed: [], datesPast: [], datesSoon: ['2026-11-21'] });
});

test('a note that is a symlink is neither listed, edited nor deleted', () => {
  const dir = setup();
  const outside = join(mkdtempSync(join(tmpdir(), 'outside-')), 'secret.md');
  writeFileSync(outside, 'secret');
  symlinkSync(outside, join(dir, 'link.md'));
  assert.equal(
    readFolder({ label: 'L', dir }, () => false).notes.some((n) => n.file === 'link.md'),
    false,
  );
  assert.throws(() => saveNote(dir, 'link.md', 'x'), /No such note/);
  assert.throws(() => deleteNote(dir, 'link.md'), /No such note/);
  assert.equal(readFileSync(outside, 'utf8'), 'secret');
});

test('an unreadable index still lists the notes; a past date in prose ("decided on") is not flagged', () => {
  const dir = setup();
  rmSync(join(dir, 'MEMORY.md'));
  mkdirSync(join(dir, 'MEMORY.md'));
  assert.equal(readFolder({ label: 'L', dir }, () => false).notes.length, 2);
  assert.deepEqual(staleFlags('Cara decided on 2026-11-10; set by Josh 2026-11-12', () => false, Date.parse('2026-11-19T12:00:00-08:00')).datesPast, []);
});

test('indexNote appends a linked line once, makes MEMORY.md when missing, and readFolder reports inIndex', () => {
  const dir = setup();
  writeFileSync(join(dir, 'c.md'), '---\nname: C [draft]\ndescription: third one\n---\nbody\n');
  assert.equal(readFolder({ label: 'x', dir, id: 'i', rel: 'r' }, () => false).notes.find((n) => n.file === 'c.md')!.inIndex, false);
  assert.equal(indexNote(dir, 'c.md'), true);
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [A note](a.md) — first\n- [B](b.md) — second\n- [C  draft ](c.md) — third one\n');
  assert.equal(indexNote(dir, 'c.md'), false, 'a second add leaves the index alone');
  assert.equal(
    readFolder({ label: 'x', dir, id: 'i', rel: 'r' }, () => false).notes.every((n) => n.inIndex),
    true,
  );
  rmSync(join(dir, 'MEMORY.md'));
  assert.equal(indexNote(dir, 'b.md'), true);
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [B](b.md) — second\n');
  assert.throws(() => indexNote(dir, 'missing.md'), /No such note/);
  // Only the first 200 lines load: a 199-line index takes one more, a 200-line one refuses and stays as it was.
  const lines = (k: number) => Array.from({ length: k }, (_, i) => `- [n${i}](n${i}.md)\n`).join('');
  writeFileSync(join(dir, 'MEMORY.md'), lines(199));
  assert.equal(indexNote(dir, 'a.md'), true);
  writeFileSync(join(dir, 'MEMORY.md'), lines(200));
  assert.throws(
    () => indexNote(dir, 'a.md'),
    (e: any) => e.status === 409 && /full/.test(e.message),
  );
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), lines(200));
});

test('a note counts as listed when MEMORY.md links it by [[name]] or through a note it links (a topic index)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-hop-'));
  writeFileSync(join(dir, 'topic-index.md'), '---\nname: topic-index\n---\n- [[deep-note]] and [[by-stem]]\n');
  writeFileSync(join(dir, 'deep-note.md'), '---\nname: deep-note\n---\nreached in one hop; see [[two-hops]]\n');
  writeFileSync(join(dir, 'by-stem.md'), '---\nname: Some Title\n---\nlinked by its file stem\n');
  writeFileSync(join(dir, 'named.md'), '---\nname: named\n---\nlinked by name from MEMORY.md\n');
  writeFileSync(join(dir, 'two-hops.md'), '---\nname: two-hops\n---\nonly deep-note links it: two hops is too far\n');
  writeFileSync(join(dir, 'orphan.md'), '---\nname: orphan\n---\nnothing links it\n');
  writeFileSync(join(dir, 'MEMORY.md'), '- [Topics](topic-index.md) — every note by topic\n- see [[named]]\n');
  const listed = Object.fromEntries(readFolder({ label: 'x', dir }, () => false).notes.map((n) => [n.file, n.inIndex]));
  assert.deepEqual(listed, { 'topic-index.md': true, 'named.md': true, 'deep-note.md': true, 'by-stem.md': true, 'two-hops.md': false, 'orphan.md': false });
  rmSync(dir, { recursive: true, force: true });
});
