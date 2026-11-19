import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firefoxLink, firefoxAvailable, SCHEME } from '../public/extlinks.js';

// #988: "Open links in Firefox". An external web link becomes citadel-firefox:<address>; anything else stays alone.
const base = 'https://cara.apps.example.net/c/';
const own = ['cara.apps.example.net', 'mandate.citadel.zip'];

test('an external http(s) link is rewritten to the citadel-firefox: scheme, address kept whole', () => {
  assert.equal(SCHEME, 'citadel-firefox:');
  assert.equal(firefoxLink('https://example.com/?a=1&b=2#x', base, own), 'citadel-firefox:https://example.com/?a=1&b=2#x');
  assert.equal(firefoxLink('http://example.com', base, own), 'citadel-firefox:http://example.com/');
  assert.equal(firefoxLink('HTTPS://Example.com/Path', base, own), 'citadel-firefox:https://example.com/Path');
});

test('links to Citadel itself and its contraptions stay where they are', () => {
  assert.equal(firefoxLink('/c/#/apps/mandate', base, own), null);
  assert.equal(firefoxLink('#/p/2/t/988', base, own), null);
  assert.equal(firefoxLink('https://cara.apps.example.net/api/x', base, own), null);
  assert.equal(firefoxLink('https://mandate.citadel.zip/', base, own), null);
  assert.equal(firefoxLink('https://MANDATE.citadel.zip/', base, own), null);
  assert.equal(firefoxLink('https://sub.cara.apps.example.net/', base, own) !== null, true, 'only the listed hosts are Citadel\'s own');
});

test('only http(s) links are ever rewritten', () => {
  for (const href of ['mailto:a@b.c', 'javascript:alert(1)', 'data:text/html,hi', 'blob:https://example.com/1', 'file:///etc/passwd', 'tel:123', 'citadel-firefox:https://example.com/', 'firefox:https://example.com/', 'not a url', '', null, undefined]) {
    assert.equal(firefoxLink(href, base, own), null, String(href));
  }
});

test('a link with credentials is left alone, and a control character is percent-encoded', () => {
  assert.equal(firefoxLink('https://user:pw@example.com/', base, own), null);
  assert.equal(firefoxLink('https://example.com/a\u0000b', base, own), 'citadel-firefox:https://example.com/a%00b');
});

test('the switch is for Windows desktop browsers only', () => {
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  assert.equal(firefoxAvailable({ userAgent: win }), true);
  assert.equal(firefoxAvailable({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0 Mobile Safari/537.36' }), false);
  assert.equal(firefoxAvailable({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36' }), false);
  assert.equal(firefoxAvailable({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36' }), false);
  assert.equal(firefoxAvailable({ userAgent: win, userAgentData: { platform: 'Windows', mobile: false } }), true);
  assert.equal(firefoxAvailable({ userAgent: win, userAgentData: { platform: 'Windows', mobile: true } }), false);
});
