// The desktop app's link rule (desktop/route.cjs, #1186): Citadel's own pages stay in the window, on its own host.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { route } = createRequire(import.meta.url)('../desktop/route.cjs');
const START = new URL('https://cara.apps.webplatformisbestplatform.net/c/');
const go = (href: string) => route(href, START, ['citadel.zip']);

test('Citadel pages at its own address stay in the window', () => {
  assert.deepEqual(go('/c/#/p/2/t/1186'), { kind: 'here', url: 'https://cara.apps.webplatformisbestplatform.net/c/#/p/2/t/1186' });
});

test('a citadel.zip link opens here, on the app\'s address, keeping its path', () => {
  assert.deepEqual(go('https://citadel.zip/c/#/p/2/t/1?e=5'), { kind: 'here', url: 'https://cara.apps.webplatformisbestplatform.net/c/#/p/2/t/1?e=5' });
});

test('other sites, contraption hosts and mail go to the default browser', () => {
  assert.deepEqual(go('https://github.com/x'), { kind: 'browser', url: 'https://github.com/x' });
  assert.deepEqual(go('https://mandate.citadel.zip/'), { kind: 'browser', url: 'https://mandate.citadel.zip/' });
  assert.deepEqual(go('mailto:a@b.c'), { kind: 'browser', url: 'mailto:a@b.c' });
});

test('a citadel.zip link carrying a login, or over http, is not taken as Citadel\'s', () => {
  assert.equal(go('https://u:p@citadel.zip/c/').kind, 'browser');
  assert.equal(go('http://citadel.zip/c/').kind, 'browser');
});

test('anything that is not a web or mail link is ignored', () => {
  for (const h of ['javascript:alert(1)', 'file:///C:/x', 'citadel-firefox:https://x']) assert.deepEqual(go(h), { kind: 'none' });
});
