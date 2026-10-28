import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterChoices } from '../public/propfilter.js';

const key = (key, value_kind, values = [], status = 'active') => ({ key, value_kind, status, values });
const val = (value, status = 'active', reviewed = true) => ({ value, status, reviewed });

test('a list key offers its active values, unreviewed ones included, archived and proposed ones not', () => {
  const keys = [key('type', 'enum', [val('feature'), val('bug', 'archived'), val('art', 'proposed'), val('research', 'active', false)])];
  assert.deepEqual(filterChoices(keys, []), [{ key: 'type', values: ['feature', 'research'] }]);
});

test('person and number keys offer what minions carry, sorted; empty and inactive keys are left out', () => {
  const keys = [key('requestedBy', 'user'), key('build', 'integer'), key('note', 'text'), key('area', 'enum', [val('town')], 'proposed')];
  const tickets = [
    { properties: { requestedBy: 'josh', build: 10 } },
    { properties: { requestedBy: 'cara', build: 8 } },
    { properties: { requestedBy: 'cara', build: 9 } },
    {},
  ];
  assert.deepEqual(filterChoices(keys, tickets), [
    { key: 'requestedBy', values: ['cara', 'josh'] },
    { key: 'build', values: [8, 9, 10] },
  ]);
});
