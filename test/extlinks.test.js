import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firefoxLink, firefoxAvailable, appLink, appSrc, mountLinkHandler, SCHEME } from '../public/extlinks.js';

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

// Links to one of our apps open that app in Citadel's own app view, never a new Chrome tab (#988 follow-up).
const citadel = ['cara.apps.example.net'];
const apps = { 'voice.citadel.zip': 'voice', 'mandate.citadel.zip': 'mandate' };
const app = (href) => appLink(href, base, citadel, apps);

test('an app link maps to its name and the path inside Citadel', () => {
  assert.deepEqual(app('https://voice.citadel.zip/apps/voice/rate/?q=1#h'), { name: 'voice', to: '/apps/voice/rate/?q=1#h' });
  assert.deepEqual(app('https://VOICE.citadel.zip/'), { name: 'voice', to: '/apps/voice/' });
  assert.deepEqual(app('https://cara.apps.example.net/apps/mandate/x'), { name: 'mandate', to: '/apps/mandate/x' });
  assert.deepEqual(app('/apps/voice/rate/'), { name: 'voice', to: '/apps/voice/rate/' });
});

test('what the app view cannot show is not an app link', () => {
  assert.equal(app('https://voice.citadel.zip/other/'), null, 'a path outside /apps/voice/');
  assert.equal(app('https://voice.citadel.zip/apps/mandate/'), null);
  assert.equal(app('https://unknown.citadel.zip/apps/unknown/'), null);
  assert.equal(app('https://cara.apps.example.net/apps/_citadel/ui/x.js'), null);
  assert.equal(app('https://cara.apps.example.net/api/x'), null);
  assert.equal(app('https://u:p@voice.citadel.zip/'), null);
  assert.equal(app('mailto:a@b.c'), null);
  assert.equal(app('https://example.com/apps/voice/'), null);
});

test('the app view only takes a path inside its own app on Citadel\'s origin', () => {
  const o = 'https://cara.apps.example.net';
  assert.equal(appSrc('voice', '/apps/voice/rate/?q#h', o), '/apps/voice/rate/?q#h');
  for (const to of ['//evil.com/apps/voice/', '/\\evil.com/apps/voice/', 'https://evil.com/apps/voice/', '/apps/voice2/', '/apps/_citadel/x', '/apps/mandate/', '/apps/voice/../mandate/']) assert.equal(appSrc('voice', to, o), null, to);
});

test('a click on an app link opens the app view with the switch off or on; a middle click goes to Firefox only when on', () => {
  const handlers = [];
  globalThis.addEventListener = (type, fn) => handlers.push([type, fn]);
  let on = false;
  const seen = [];
  mountLinkHandler({ on: () => on, own: () => citadel, apps: () => apps, open: (u) => seen.push(['ff', u]), openApp: (l) => seen.push(['app', l.name, l.to]), base: () => base });
  const fire = (type, href, extra = {}) => {
    const e = { type, button: type === 'click' ? 0 : 1, target: { closest: () => ({ getAttribute: () => href, hasAttribute: () => false }) }, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra };
    for (const [t, fn] of handlers) if (t === type) fn(e);
    return e.prevented === true;
  };
  const voice = 'https://voice.citadel.zip/apps/voice/rate/';
  assert.equal(fire('click', voice), true);
  assert.equal(fire('auxclick', voice), false, 'switch off: nothing else exists, the browser keeps it');
  assert.equal(fire('click', voice, { ctrlKey: true }), false);
  assert.equal(fire('click', 'https://example.com/'), false, 'switch off: outside links stay');
  assert.deepEqual(seen, [['app', 'voice', '/apps/voice/rate/']]);
  on = true;
  assert.equal(fire('auxclick', voice), true);
  assert.equal(fire('click', 'https://voice.citadel.zip/other/'), true, 'an app host path the view cannot show goes to Firefox');
  assert.equal(fire('click', 'https://example.com/'), true);
  assert.equal(fire('click', '/c/#/x'), false, 'Citadel itself stays');
  assert.deepEqual(seen.slice(1), [['ff', voice], ['ff', 'https://voice.citadel.zip/other/'], ['ff', 'https://example.com/']]);
});
