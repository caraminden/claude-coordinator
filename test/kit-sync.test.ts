// The kit sync's git side (#1100): which kit version a scheme's copy came from, and the 3-way merge that keeps the
// scheme's own edits while the kit's change comes in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, KIT_FILES, lineDistance, merge3, pickBase, planScheme, schemeRepos, templateHistory, TRAILER } from '../src/kit-sync.ts';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const LAND = KIT_FILES[0];
const GUARD = KIT_FILES[1];

function repo(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}
function commit(dir: string, files: Record<string, string>, msg: string): string {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, ['add', '-A']);
  git(dir, [...ID, 'commit', '-q', '-m', msg]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}
const lines = (n: number, tag = '') => Array.from({ length: n }, (_, i) => `line ${i}${tag}`).join('\n') + '\n';
const edit = (text: string, i: number, to: string) => text.split('\n').map((l, j) => (j === i ? to : l)).join('\n');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kit-sync-test-'));
  const kit = repo(root, 'kit');
  const v1 = lines(40);
  const g1 = lines(30, ' guard');
  const c1 = commit(kit, { [LAND.template]: v1, [GUARD.template]: g1 }, 'v1');
  const v2 = edit(v1, 5, 'line 5 kit fix');
  const c2 = commit(kit, { [LAND.template]: v2 }, 'v2');
  return { root, kit, v1, v2, g1, c1, c2, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('a copy that is a past version byte for byte takes that version as its base', () => {
  const f = fixture();
  try {
    const s = repo(f.root, 'scheme');
    commit(s, { [LAND.path]: f.v1 }, 'setup');
    const base = pickBase(f.kit, templateHistory(f.kit, 'HEAD', LAND.template), s, 'HEAD', LAND);
    assert.deepEqual(base && { commit: base.commit, how: base.how }, { commit: f.c1, how: 'exact' });
  } finally {
    f.done();
  }
});

test("an adapted copy's base is the closest past version, and the merge keeps the scheme's edit", () => {
  const f = fixture();
  try {
    const s = repo(f.root, 'scheme');
    // Adapted at setup from v1: its own line 30, which the kit never changes.
    const ours = edit(f.v1, 30, 'line 30 this scheme only');
    commit(s, { [LAND.path]: ours, [GUARD.path]: f.g1 }, 'setup');
    const [land, guard] = planScheme(f.kit, 'HEAD', { [LAND.template]: templateHistory(f.kit, 'HEAD', LAND.template) }, s);
    assert.equal(land.base, 'closest');
    assert.equal(land.status, 'merged');
    assert.equal(land.text, edit(f.v2, 30, 'line 30 this scheme only'));
    assert.equal(guard.status, 'same', 'a copy equal to the template is nothing to do');
  } finally {
    f.done();
  }
});

test('the Kit-Sync trailer names the base, so a kit change the scheme undid on purpose after a sync stays undone', () => {
  const f = fixture();
  try {
    const s = repo(f.root, 'scheme');
    commit(s, { [LAND.path]: f.v2 }, `sync\n\n${TRAILER}: ${f.c2}`);
    // Undone by hand after the sync: the file is v1 again, byte for byte, which an exact match would take as its base.
    commit(s, { [LAND.path]: f.v1 }, 'we do not want the line 5 fix');
    const history = templateHistory(f.kit, 'HEAD', LAND.template);
    const base = pickBase(f.kit, history, s, 'HEAD', LAND);
    assert.deepEqual(base && { commit: base.commit, how: base.how }, { commit: f.c2, how: 'trailer' });
    const v3 = edit(f.v2, 20, 'line 20 newer kit fix');
    commit(f.kit, { [LAND.template]: v3 }, 'v3');
    const [land] = planScheme(f.kit, 'HEAD', { [LAND.template]: templateHistory(f.kit, 'HEAD', LAND.template) }, s);
    assert.equal(land.text, edit(f.v1, 20, 'line 20 newer kit fix'));
  } finally {
    f.done();
  }
});

test('a trailer base keeps an edit to the very lines the kit changed, since that change is already in', () => {
  const f = fixture();
  try {
    const s = repo(f.root, 'scheme');
    const ours = edit(f.v2, 5, 'line 5 our own take on the kit fix');
    commit(s, { [LAND.path]: ours }, `sync\n\n${TRAILER}: ${f.c2}`);
    const v3 = edit(f.v2, 20, 'line 20 newer kit fix');
    commit(f.kit, { [LAND.template]: v3 }, 'v3');
    const [land] = planScheme(f.kit, 'HEAD', { [LAND.template]: templateHistory(f.kit, 'HEAD', LAND.template) }, s);
    assert.equal(land.base, 'trailer');
    assert.equal(land.text, edit(v3, 5, 'line 5 our own take on the kit fix'));
  } finally {
    f.done();
  }
});

test('the scheme and the kit changing the same lines is a conflict, with no text to commit', () => {
  const f = fixture();
  try {
    const s = repo(f.root, 'scheme');
    commit(s, { [LAND.path]: edit(f.v1, 5, 'line 5 the scheme went its own way') }, 'setup');
    const [land] = planScheme(f.kit, 'HEAD', { [LAND.template]: templateHistory(f.kit, 'HEAD', LAND.template) }, s);
    assert.equal(land.status, 'conflict');
    assert.equal(land.text, undefined);
  } finally {
    f.done();
  }
});

test('a file the scheme does not have is left alone, and the repo holding the templates is no scheme', () => {
  const f = fixture();
  try {
    const projects = join(f.root, 'projects');
    const s = repo(projects, '3/repo');
    commit(s, { [LAND.path]: f.v1 }, 'setup');
    const own = repo(projects, '2/repo');
    commit(own, { [LAND.template]: f.v2, [LAND.path]: 'its own\n' }, 'citadel');
    mkdirSync(join(projects, '4'), { recursive: true });
    assert.deepEqual(schemeRepos(projects, [2, 3, 4]).map((r) => r.project), [3]);
    const plan = planScheme(f.kit, 'HEAD', { [LAND.template]: templateHistory(f.kit, 'HEAD', LAND.template) }, s);
    assert.deepEqual(plan.map((p) => p.status), ['merged', 'missing', 'missing', 'missing']);
  } finally {
    f.done();
  }
});

test('merge3 and lineDistance on their own', () => {
  assert.deepEqual(merge3('a\nB\nc\nd\ne\n', 'a\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n'), { text: 'a\nB\nc\nd\nE\n', conflict: false });
  assert.equal(merge3('a\nX\nc\n', 'a\nb\nc\n', 'a\nY\nc\n').conflict, true);
  assert.equal(lineDistance('a\nb\n', 'a\nb\n'), 0);
  assert.equal(lineDistance('a\nb\n', 'a\nc\n'), 2);
});
