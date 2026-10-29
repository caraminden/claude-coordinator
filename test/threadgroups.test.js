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

test('only the build field counts, not a build named in the title', () => {
  assert.deepEqual(shape([
    { n: 1, tag: 'feature', title: 'Major Build #7' }, { n: 2, tag: 'design', title: 'Lair Strip · Build #8' },
    { n: 3, tag: 'feature', title: 'Workshop · Build #7', build: 9 },
  ]), [['build-9', true, [3]], ['feature', false, [1]], ['design', false, [2]]]);
});

test('parked minions leave their build or kind for a Parked section at the bottom', () => {
  assert.deepEqual(shape([
    { n: 1, tag: 'bug', state: 'parked', status: 'idle' }, { n: 2, tag: 'bug' }, { n: 3, tag: 'feature', build: 7, state: 'parked' },
    { n: 4, tag: 'feature', build: 8 }, { n: 5, tag: 'idea', build: 9 }, { n: 6, tag: 'idea', state: 'parked', status: 'running' },
    { n: 7, tag: 'design', state: 'parked', approvals: 1 },
  ]), [['build-8', true, [4]], ['bug', false, [2]], ['design', false, [7]], ['idea', false, [6]], ['build-9', false, [5]], ['parked', false, [1, 3]]]);
});

test('search matches title, exact number and property values, not anything else', async () => {
  const { threadMatches } = await import('../public/threadgroups.js');
  const t = { number: 78, title: 'Minion search', created_by: 'Cara', last_activity: 'Ran the tests', note: 'needs a pick',
    properties: { type: 'feature', area: ['ui', 'town'], stage: 'in-progress' } };
  for (const q of ['search', 'MINION', '78', '#78', 'feature', 'town', 'type: feature', 'area: ui']) assert.ok(threadMatches(t, q), q);
  for (const q of ['7', '#7', '780', 'cara', 'tests', 'pick', 'type', 'type: bug', 'area: feature']) assert.ok(!threadMatches(t, q), q);
  assert.ok(threadMatches({ number: 3, title: 'x' }, '3'), 'no properties');
});

test('recap sections: changed minions only, newest first, by what they need', async () => {
  const { recapSections } = await import('../public/threadgroups.js');
  const stateOf = (t) => ({ rank: t.rank, fam: t.fam });
  const t = (id, updated_at, rest) => ({ id, updated_at, status: 'idle', rank: 2, fam: 'wait', ...rest });
  const tickets = [
    t(1, 50), // unchanged since 100
    t(2, 120, { rank: 0, fam: 'you' }),
    t(3, 150, { rank: 0, fam: 'you' }),
    t(4, 90, { status: 'running', rank: 1, fam: 'work' }), // a turn finished, still running
    t(5, 130, { status: 'closed', rank: 5, fam: 'idle' }),
    t(6, 110, { state: 'parked', rank: 4, fam: 'idle' }),
  ];
  assert.deepEqual(recapSections(tickets, 100, { 4: 1 }, stateOf).map((s) => [s.key, s.rows.map((r) => r.id)]),
    [['you', [3, 2]], ['work', [4]], ['wait', [6]], ['closed', [5]]]);
  assert.deepEqual(recapSections(tickets, 200, {}, stateOf), []);
});
