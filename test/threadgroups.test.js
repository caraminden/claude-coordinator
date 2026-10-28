import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadSections } from '../public/threadgroups.js';

const TAGS = ['feature', 'bug', 'design', 'process', 'idea'];
const shape = (open) => threadSections(open, TAGS).map((s) => [s.key, s.current ?? false, s.rows.map((t) => t.n)]);

test('no builds: grouped by kind only', () => {
  assert.deepEqual(shape([{ n: 1, tag: 'bug' }, { n: 2, tag: 'feature' }, { n: 3, tag: null }, { n: 4, tag: 'odd' }]),
    [['feature', false, [2]], ['bug', false, [1]], ['other', false, [3, 4]]]);
});

test('lowest build on top as current, later builds at the bottom ascending, any kind', () => {
  assert.deepEqual(shape([
    { n: 1, tag: 'idea', build: 9 }, { n: 2, tag: 'process', build: 8 }, { n: 3, tag: 'feature', build: 8 },
    { n: 4, tag: 'bug' }, { n: 5, tag: 'idea' }, { n: 6, tag: 'feature', build: 10 },
  ]), [['build-8', true, [2, 3]], ['bug', false, [4]], ['idea', false, [5]], ['build-9', false, [1]], ['build-10', false, [6]]]);
});

test('a build named in the title counts, Delve style; the build field wins', () => {
  assert.deepEqual(shape([
    { n: 1, tag: 'feature', title: 'Major Build #7' }, { n: 2, tag: 'design', title: 'Lair Strip · Build #8' },
    { n: 3, tag: 'process', title: 'Build 8 Features' }, { n: 4, tag: 'process', title: 'Move Build 7 Along' },
    { n: 5, tag: 'feature', title: 'Rebuild 9 things' }, { n: 6, tag: 'feature', title: 'Workshop · Build #7', build: 9 },
  ]), [['build-7', true, [1, 4]], ['feature', false, [5]], ['build-8', false, [2, 3]], ['build-9', false, [6]]]);
});
