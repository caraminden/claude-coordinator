import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteNote, memoryDir, memoryFolders, noteFile, readFolder, saveNote, staleFlags } from '../src/memory-files.ts';

test('memoryFolders maps a repo path to each login\'s projects/<slug>/memory, once per distinct dir', () => {
  const repo = '/home/cara/.local/share/claude-coordinator/projects/7/repo';
  const got = memoryFolders(repo, [
    { label: "The server's own login", configDir: '/h/.claude' },
    { label: 'Dev account 2', configDir: '/d/claude-accounts/1/2' },
    { label: 'same as first', configDir: '/h/.claude' },
  ]);
  assert.deepEqual(got, [
    { label: "The server's own login", dir: '/h/.claude/projects/-home-cara--local-share-claude-coordinator-projects-7-repo/memory' },
    { label: 'Dev account 2', dir: '/d/claude-accounts/1/2/projects/-home-cara--local-share-claude-coordinator-projects-7-repo/memory' },
  ]);
  assert.equal(memoryDir('/c', '/a/b'), '/c/projects/-a-b/memory');
  assert.deepEqual(memoryFolders(null, [{ label: 'x', configDir: '/c' }]), []);
});

test('noteFile refuses paths, the index and non-markdown', () => {
  for (const bad of ['../x.md', 'a/b.md', 'MEMORY.md', '.hidden.md', 'x.txt', 5, undefined]) assert.equal(noteFile(bad), null);
  assert.equal(noteFile('fable-burst.md'), 'fable-burst.md');
});

const setup = () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'memfiles-')), 'memory');
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

test('edit replaces a note whole and refuses one that is not there', () => {
  const dir = setup();
  saveNote(dir, 'b.md', 'new');
  assert.equal(readFileSync(join(dir, 'b.md'), 'utf8'), 'new');
  assert.throws(() => saveNote(dir, 'zzz.md', 'x'), /No such note/);
});

test('readFolder lists notes in index order with stale flags; a missing folder is not reachable', () => {
  const dir = setup();
  const v = readFolder({ label: 'L', dir }, (n) => n === 5, Date.parse('2026-11-19T12:00:00-08:00'));
  assert.deepEqual(v.notes.map((n) => [n.file, n.name, n.type]), [['a.md', 'A note', 'project'], ['b.md', 'B', '']]);
  assert.deepEqual(v.notes[0].flags, { closed: [5], datesPast: ['2020-01-01'], datesSoon: [] });
  assert.equal(readFolder({ label: 'L', dir: join(dir, 'nope') }, () => false).reachable, false);
});

test('staleFlags: only dates after a recheck-style word, past or within 3 days', () => {
  const now = Date.parse('2026-11-19T12:00:00-08:00');
  const f = staleFlags('recheck after 2026-11-21; shipped 2026-01-01; by 2027-01-01', () => false, now);
  assert.deepEqual(f, { closed: [], datesPast: [], datesSoon: ['2026-11-21'] });
});
