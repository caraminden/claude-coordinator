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
