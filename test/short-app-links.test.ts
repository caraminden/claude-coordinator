import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contraptions } from '../src/contraptions.ts';

test('appUrl is the app on its own host only when APPS_DOMAIN is set (#827)', () => {
  const c = Object.create(Contraptions.prototype) as Contraptions;
  assert.equal(c.appUrl('mandate'), null);
  c.appsDomain = 'citadel.zip';
  assert.equal(c.appUrl('mandate'), 'https://mandate.citadel.zip/');
});
