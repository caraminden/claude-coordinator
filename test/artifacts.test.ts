import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkedPaths } from '../src/artifacts.ts';

const cwd = '/work/t1';
const linked = (...texts: string[]) => [...linkedPaths(texts, cwd)].sort();

test('finds linked files, relative or absolute', () => {
  assert.deepEqual(linked('See [the report](docs/report.md) and ![shot](/shared/9/a.png).'), ['/shared/9/a.png', '/work/t1/docs/report.md']);
  assert.deepEqual(linked('[x](./pages/../pages/glossary.html#top)'), ['/work/t1/pages/glossary.html']);
  assert.deepEqual(linked('[x](<my notes.md> "Notes")', '[y](my%20plan.md)'), ['/work/t1/my notes.md', '/work/t1/my plan.md']);
});

test('ignores web links, anchors and unlinked paths', () => {
  assert.deepEqual(linked('[a](https://x.dev/r.md) [b](#/p/2/t/3) [c](//x.dev/a.html) [d](mailto:a@b.c) wrote t/a.html'), []);
});
