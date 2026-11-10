// The front end's base helpers (public/base.js): paths, file kinds, sizes, costs, ages and minion names.
// Importing it here is itself the check that it needs no document at load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, costText, fileExt, fileKind, formatSize, isLocalPath, joinPath, listGroupsOf, setView, shortPath, statusLabel, threadFullName, threadHref, threadTitleParts } from '../public/base.js';

test('joinPath resolves a relative link against its folder', () => {
  const rows = [
    ['docs/specs', 'plan.md', 'docs/specs/plan.md'],
    ['docs/specs', './plan.md', 'docs/specs/plan.md'],
    ['docs/specs', '../img/a.png', 'docs/img/a.png'],
    ['docs', '../../a.png', '../a.png'],
    ['', 'a.png', 'a.png'],
    ['', '../a.png', '../a.png'],
    ['docs', '/abs/a.png', '/abs/a.png'],
    ['/home/x', '../y/a.md', '/home/y/a.md'],
    // The root is never popped.
    ['/home', '../../a.md', '/../a.md'],
    ['docs', '..', '.'],
    ['docs', 'a//b/', 'docs/a/b'],
  ];
  for (const [dir, rel, want] of rows) assert.equal(joinPath(dir, rel), want, `${dir} + ${rel}`);
});

test('fileKind goes by extension, whatever its case, ignoring a query or fragment', () => {
  assert.equal(fileKind('notes/Plan.MD'), 'markdown');
  assert.equal(fileKind('a/b/shot.png?v=2'), 'image');
  assert.equal(fileKind('page.html#top'), 'html');
  assert.equal(fileKind('clip.webm'), 'video');
  assert.equal(fileKind('out.tar'), 'download');
  assert.equal(fileKind('build/app-release.APK'), 'download');
  assert.equal(fileKind('run.exe'), null);
  assert.equal(fileKind('Makefile'), null);
  assert.equal(fileExt('a/b/shot.png'), 'PNG');
  assert.equal(fileExt('Makefile'), 'FILE');
});

test('isLocalPath tells a path from a URL, a fragment or a mail address', () => {
  for (const p of ['a.md', '/abs/a.md', '../a.md']) assert.equal(isLocalPath(p), true, p);
  for (const p of ['https://x.test/a.md', '//x.test/a.md', '#top', 'mailto:a@b.test']) assert.equal(isLocalPath(p), false, p);
});

test('shortPath names the shared folders and keeps the tail of other absolute paths', () => {
  assert.equal(shortPath('/data/projects/2/shared/project/specs/plan.md'), 'scheme shared/specs/plan.md');
  assert.equal(shortPath('/data/projects/2/shared/1022/shot.png'), 'shared files/shot.png');
  assert.equal(shortPath('/data/projects/2/tickets/1022/docs/plan.md'), '…/docs/plan.md');
  assert.equal(shortPath('docs/plan.md'), 'docs/plan.md');
});

test('formatSize switches units and drops the decimal from 10 KB up', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(1023), '1023 B');
  assert.equal(formatSize(1024), '1.0 KB');
  assert.equal(formatSize(10 * 1024), '10 KB');
  assert.equal(formatSize(1024 * 1024 - 1), '1024 KB');
  assert.equal(formatSize(5.5 * 1024 * 1024), '5.5 MB');
});

test('costText shows cents under $10 and whole dollars from there', () => {
  assert.equal(costText(0.416), '≈ $0.42');
  assert.equal(costText(9.999), '≈ $10.00');
  assert.equal(costText(10), '≈ $10');
  assert.equal(costText(12.5), '≈ $13');
});

test('ago rounds down to the biggest unit', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const back = (s) => ago(Date.now() - s * 1000);
  assert.equal(back(59), 'just now');
  assert.equal(back(60), '1m ago');
  assert.equal(back(3599), '59m ago');
  assert.equal(back(3600), '1h ago');
  assert.equal(back(86399), '23h ago');
  assert.equal(back(3 * 86400), '3d ago');
});

test('listGroupsOf reads a scheme\'s promoted groups and survives junk', () => {
  assert.deepEqual(listGroupsOf({ list_groups: '["area: ui"]' }), ['area: ui']);
  assert.deepEqual(listGroupsOf({ list_groups: '{oops' }), []);
  assert.deepEqual(listGroupsOf({}), []);
  assert.deepEqual(listGroupsOf(null), []);
});

// h() makes elements, so the name helpers that return nodes get the least document that can.
class Node {}
class El extends Node {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.kids = []; }
  setAttribute(k, v) { this.attrs[k] = v; }
  append(c) { this.kids.push(c); }
  get text() { return this.kids.map((k) => (k instanceof El ? k.text : k)).join(''); }
}
const flat = (parts) => [parts].flat().map((p) => (p instanceof El ? `<${p.className ?? Object.entries(p.attrs).map(([k, v]) => `${k}=${v}`).join(' ')}>${p.text}</>` : p)).join('');

test('minion names: the full name, its phone-friendly parts, the address and the status word', (t) => {
  Object.assign(globalThis, { Node, document: { createElement: (tag) => new El(tag) } });
  t.after(() => { delete globalThis.Node; delete globalThis.document; setView(null); });
  const minion = { id: 900, number: 12, project_id: 2, title: 'Usage bar', status: 'idle', state: 'ready', properties: { type: 'feature' } };
  assert.equal(threadFullName(minion), '🛠️ 12 FEATURE: Usage bar ✅');
  assert.equal(flat(threadTitleParts(minion)), '🛠️ 12 <wide-only>FEATURE: </>Usage bar<wide-only> ✅</>');
  // No state emoji while it runs; `other` has no emoji or type word; no number falls back to the id.
  assert.equal(threadFullName({ ...minion, status: 'running' }), '🛠️ 12 FEATURE: Usage bar');
  const plain = { id: 900, project_id: 2, title: 'Odd job', status: 'idle', properties: { type: 'other' } };
  assert.equal(threadFullName(plain), '900 Odd job');
  assert.equal(flat(threadTitleParts(plain)), '900 Odd job');
  assert.equal(threadHref(minion), '#/p/2/t/12');
  assert.equal(threadHref(plain), '#/t/900');

  // The Taskmaster goes by its scheme's name, and is "Ready" where a new minion is "Starting".
  const tm = { id: 1, kind: 'coordinator', project_id: 2, status: 'new' };
  setView({ kind: 'project', projectId: 2, projects: [{ id: 2, name: 'Citadel' }] });
  assert.equal(threadFullName(tm), 'Citadel Taskmaster');
  assert.equal(flat(threadTitleParts(tm)), '<data-taskmaster-name=2>Citadel Taskmaster</>');
  assert.equal(threadHref(tm), '#/p/2');
  assert.equal(statusLabel(tm), 'Ready');
  assert.equal(statusLabel({ ...minion, status: 'new' }), 'Starting');
  assert.equal(statusLabel(minion), 'Waiting for you');
});
