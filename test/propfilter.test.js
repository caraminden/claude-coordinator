import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterChoices, matchesPicks, samePicks, valueCounts, viewPicks } from '../public/propfilter.js';

const key = (key, value_kind, values = [], status = 'active') => ({ key, value_kind, status, values });
const val = (value, status = 'active', reviewed = true) => ({ value, status, reviewed });

test('a list key offers its active values, unreviewed ones included, archived and proposed ones not', () => {
  const keys = [key('type', 'enum', [val('feature'), val('bug', 'archived'), val('art', 'proposed'), val('research', 'active', false)])];
  assert.deepEqual(filterChoices(keys, []), [{ key: 'type', values: ['feature', 'research'] }]);
});

test('person and number keys offer what minions carry, sorted; empty and inactive keys are left out', () => {
  const keys = [key('requestedBy', 'user'), key('build', 'integer'), key('note', 'text'), key('area', 'enum', [val('town')], 'proposed')];
  const tickets = [{ properties: { requestedBy: 'josh', build: 10 } }, { properties: { requestedBy: 'cara', build: 8 } }, { properties: { requestedBy: 'cara', build: 9 } }, {}];
  assert.deepEqual(filterChoices(keys, tickets), [
    { key: 'requestedBy', values: ['cara', 'josh'] },
    { key: 'build', values: [8, 9, 10] },
  ]);
});

test('picks: any value within a key, every key across them; multi and number values count', () => {
  const a = { properties: { type: 'bug', stage: 'in-progress', area: ['town', 'ui'], build: 8 } };
  const b = { properties: { type: 'feature', stage: 'done', area: ['ui'] } };
  const c = {};
  const match = (picks) => [a, b, c].filter((t) => matchesPicks(t, new Map(Object.entries(picks).map(([k, v]) => [k, new Set(v)])))).length;
  assert.equal(match({}), 3);
  assert.equal(match({ type: ['bug', 'feature'] }), 2);
  assert.equal(match({ type: ['bug', 'feature'], stage: ['in-progress'] }), 1);
  assert.equal(match({ area: ['town'] }), 1);
  assert.equal(match({ build: [8] }), 1);
  assert.equal(match({ type: ['art'] }), 0);
});

test("counts: a value counts the minions carrying it that every other key's picks let through", () => {
  const ts = [{ properties: { type: 'bug', stage: 'done', area: ['town', 'ui'] } }, { properties: { type: 'bug', stage: 'in-progress', area: ['ui'] } }, { properties: { type: 'feature', stage: 'in-progress' } }];
  const picks = (o) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
  assert.deepEqual(
    valueCounts('type', ts, picks({})),
    new Map([
      ['bug', 2],
      ['feature', 1],
    ]),
  );
  // The key's own picks don't narrow its counts (OR within a key); other keys' do.
  assert.deepEqual(
    valueCounts('type', ts, picks({ type: ['bug'], stage: ['in-progress'] })),
    new Map([
      ['bug', 1],
      ['feature', 1],
    ]),
  );
  assert.deepEqual(
    valueCounts('area', ts, picks({ type: ['bug'] })),
    new Map([
      ['town', 1],
      ['ui', 2],
    ]),
  );
});

test('a saved view applies what the registry still offers: archived values and inactive keys drop quietly', () => {
  const keys = [key('type', 'enum', [val('feature'), val('bug', 'archived')]), key('build', 'integer'), key('area', 'enum', [val('town')], 'archived'), key('stage', 'enum', [val('done'), val('idea', 'archived')])];
  const saved = { type: ['feature', 'bug'], build: [8], area: ['town'], stage: ['idea'], gone: ['x'] };
  assert.deepEqual(
    viewPicks(saved, keys),
    new Map([
      ['type', new Set(['feature'])],
      ['build', new Set([8])],
    ]),
  );
  // A key named like an Object method isn't read off the prototype.
  assert.deepEqual(viewPicks({}, [key('constructor', 'text')]), new Map());
});

test('samePicks compares the ticked values, not their order', () => {
  const a = new Map([
    ['type', new Set(['bug', 'feature'])],
    ['build', new Set([8])],
  ]);
  assert.ok(
    samePicks(
      a,
      new Map([
        ['build', new Set([8])],
        ['type', new Set(['feature', 'bug'])],
      ]),
    ),
  );
  assert.ok(!samePicks(a, new Map([['type', new Set(['bug', 'feature'])]])));
  assert.ok(
    !samePicks(
      a,
      new Map([
        ['type', new Set(['bug'])],
        ['build', new Set([8])],
      ]),
    ),
  );
  assert.ok(
    !samePicks(
      a,
      new Map([
        ['type', new Set(['bug', 'feature'])],
        ['stage', new Set([8])],
      ]),
    ),
  );
});
