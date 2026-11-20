import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firefoxLink, firefoxAvailable, appLink, appSrc, classifyLink, mountLinkHandler, SCHEME, downloadAddress, firefoxDownload } from '../public/extlinks.js';

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

test('a click on an app link opens the app view with the switch off or on; a middle click opens the app view too', () => {
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
  assert.equal(fire('auxclick', voice), true, 'switch off too: a middle click opens the app view, never a Chrome tab');
  assert.equal(fire('click', voice, { ctrlKey: true }), false);
  assert.equal(fire('click', 'https://example.com/'), false, 'switch off: outside links stay');
  assert.deepEqual(seen, [['app', 'voice', '/apps/voice/rate/'], ['app', 'voice', '/apps/voice/rate/']]);
  on = true;
  assert.equal(fire('auxclick', voice), true, 'a middle click on an app link opens the app view too: never a Chrome tab');
  assert.equal(fire('click', 'https://voice.citadel.zip/other/'), true, 'an app host path the view cannot show goes to Firefox');
  assert.equal(fire('click', 'https://example.com/'), true);
  assert.equal(fire('click', '/c/#/x'), false, 'Citadel itself stays');
  assert.deepEqual(seen.slice(3), [['ff', 'https://voice.citadel.zip/other/'], ['ff', 'https://example.com/']]);
});

// #988 regression: a framed app's own links went to Firefox. One table decides, switch on and off.
const ctxOf = (self, firefox) => ({ own: ['cara.apps.example.net'], domain: 'citadel.zip', apps: { 'transdata.citadel.zip': 'transdata', 'voice.citadel.zip': 'voice' }, self, firefox });
const kindOf = (href, at, self, firefox) => { const c = classifyLink(href, at, ctxOf(self, firefox)); return c.kind === 'app' ? `app:${c.app.name}${c.app.to}` : c.kind; };

test('classifyLink: one table for a page in transdata (its own host), switch on and off', () => {
  const at = 'https://transdata.citadel.zip/apps/transdata/';
  for (const firefox of [true, false]) {
    assert.equal(kindOf('/apps/transdata/ingest', at, 'transdata', firefox), 'page', 'relative, same app');
    assert.equal(kindOf('https://transdata.citadel.zip/apps/transdata/ingest', at, 'transdata', firefox), 'page', 'absolute, same app');
    assert.equal(kindOf('https://transdata.citadel.zip/', at, 'transdata', firefox), 'page');
    assert.equal(kindOf('https://transdata.citadel.zip/anything', at, 'transdata', firefox), 'page', 'same origin stays with the page');
    assert.equal(kindOf('https://voice.citadel.zip/apps/voice/rate/', at, 'transdata', firefox), 'app:voice/apps/voice/rate/', 'another app\'s host');
    assert.equal(kindOf('https://cara.apps.example.net/apps/voice/rate/', at, 'transdata', firefox), 'app:voice/apps/voice/rate/', 'another app on Citadel\'s host');
    assert.equal(kindOf('https://cara.apps.example.net/c/#/p/2', at, 'transdata', firefox), 'window', 'Citadel\'s own page');
    assert.equal(kindOf('https://citadel.zip/', at, 'transdata', firefox), 'window', 'the bare apps domain');
    assert.equal(kindOf('https://docs.citadel.zip/x', at, 'transdata', firefox), 'window', 'a citadel.zip host that is no app');
    assert.equal(kindOf('https://notcitadel.zip/', at, 'transdata', firefox), firefox ? 'firefox' : 'browser', 'only the domain and its subdomains');
    assert.equal(kindOf('https://example.com/x', at, 'transdata', firefox), firefox ? 'firefox' : 'browser', 'outside');
    assert.equal(kindOf('https://voice.citadel.zip/other/', at, 'transdata', firefox), 'window', 'an app host path the view can\'t show: still Citadel\'s, this window goes there');
    assert.equal(kindOf('mailto:a@b.c', at, 'transdata', firefox), 'page');
  }
});

test('classifyLink: a page in transdata on Citadel\'s host (no apps domain), and Citadel\'s own page', () => {
  const frameAt = 'https://cara.apps.example.net/apps/transdata/';
  for (const firefox of [true, false]) {
    assert.equal(kindOf('/apps/transdata/ingest', frameAt, 'transdata', firefox), 'page');
    assert.equal(kindOf('https://cara.apps.example.net/apps/transdata/ingest', frameAt, 'transdata', firefox), 'page');
    assert.equal(kindOf('/apps/voice/', frameAt, 'transdata', firefox), 'app:voice/apps/voice/');
    assert.equal(kindOf('https://example.com/', frameAt, 'transdata', firefox), firefox ? 'firefox' : 'browser');
    // Citadel's own page: no app of its own, so its /apps/<y>/ links open the app view
    const top = 'https://cara.apps.example.net/c/';
    assert.equal(kindOf('/apps/transdata/ingest', top, null, firefox), 'app:transdata/apps/transdata/ingest');
    assert.equal(kindOf('https://transdata.citadel.zip/apps/transdata/x', top, null, firefox), 'app:transdata/apps/transdata/x');
    assert.equal(kindOf('#/p/2/t/9', top, null, firefox), 'page');
    assert.equal(kindOf('/api/x', top, null, firefox), 'page');
    assert.equal(kindOf('https://example.com/', top, null, firefox), firefox ? 'firefox' : 'browser');
  }
  assert.equal(kindOf('/apps/transdata/ingest', frameAt, 'transdata', true), 'page', 'before Citadel\'s lists arrive nothing same-origin leaves the page');
  assert.equal(classifyLink('/apps/transdata/ingest', frameAt, { self: 'transdata', firefox: true }).kind, 'page');
});

// #1184: with the switch on, a download goes to Firefox too. Citadel's own file addresses need a login Firefox doesn't
// have, so they go through a short-lived download link the server mints; anything else goes as it is.
test('downloadAddress: download-attribute links, ?download addresses and installer files are downloads', () => {
  const at = 'https://cara.apps.example.net/c/';
  assert.equal(downloadAddress('api/tickets/5/file?path=a.zip&download', at, false), 'https://cara.apps.example.net/c/api/tickets/5/file?path=a.zip&download');
  assert.equal(downloadAddress('api/artifacts/9/raw?v=3&download', at, false), 'https://cara.apps.example.net/c/api/artifacts/9/raw?v=3&download');
  assert.equal(downloadAddress('api/tickets/5/uploads/notes.txt', at, true), 'https://cara.apps.example.net/c/api/tickets/5/uploads/notes.txt', 'a download attribute');
  assert.equal(downloadAddress('/apps/mandate/android/mandate-7.apk', at, false), 'https://cara.apps.example.net/apps/mandate/android/mandate-7.apk', 'a release APK');
  assert.equal(downloadAddress('/api/projects/2/ci-files/4/citadel-0.3.xpi', at, false), 'https://cara.apps.example.net/api/projects/2/ci-files/4/citadel-0.3.xpi');
  for (const ext of ['zip', 'exe', 'msi', 'msix', 'xpi', 'crx', 'apk', '7z', 'tgz']) assert.ok(downloadAddress(`https://example.com/x.${ext}`, at, false), ext);
  assert.equal(downloadAddress('api/tickets/5/file?path=a.md', at, false), null, 'a file that opens in Citadel');
  assert.equal(downloadAddress('https://example.com/zip', at, false), null);
  assert.equal(downloadAddress('#/p/2/t/9', at, false), null);
  assert.equal(downloadAddress('mailto:a@b.c', at, true), null, 'only web addresses');
  assert.equal(downloadAddress('blob:https://cara.apps.example.net/1', at, true), null, 'a blob the page made stays in the browser');
  assert.equal(downloadAddress('data:text/plain,hi', at, true), null);
});

test('a download click goes to Firefox with the switch on; switch off or a modifier key leaves it to Chrome', () => {
  const handlers = [];
  globalThis.addEventListener = (type, fn) => handlers.push([type, fn]);
  let on = false;
  const seen = [];
  mountLinkHandler({ on: () => on, own: () => ['cara.apps.example.net'], open: (u) => seen.push(['ff', u]), download: (u) => seen.push(['dl', u]), openApp: (l) => seen.push(['app', l.name]), base: () => 'https://cara.apps.example.net/c/' });
  const fire = (href, attr, extra = {}, here = false) => {
    const e = { type: 'click', button: 0, target: { closest: () => ({ getAttribute: () => href, hasAttribute: (n) => (n === 'download' && attr) || (n === 'data-here' && here) }) }, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra };
    for (const [t, fn] of handlers) if (t === e.type) fn(e);
    return e.prevented === true;
  };
  assert.equal(fire('api/artifacts/9/raw?v=3&download', false), false, 'switch off: Chrome downloads it');
  assert.equal(fire('api/tickets/5/uploads/a.bin', true), false);
  assert.equal(fire('/apps/mandate/android/mandate-7.apk', false), true, 'switch off: an app path still opens the app view, as before');
  assert.deepEqual(seen, [['app', 'mandate']]);
  on = true;
  assert.equal(fire('api/artifacts/9/raw?v=3&download', false), true);
  assert.equal(fire('api/tickets/5/uploads/a.bin', true), true);
  assert.equal(fire('/apps/mandate/android/mandate-7.apk', false), true);
  assert.equal(fire('api/artifacts/9/raw?v=3&download', false, { ctrlKey: true }), false, 'a modifier key downloads in Chrome anyway');
  assert.equal(fire('api/artifacts/9/raw?v=3&download', false, { shiftKey: true }), false);
  assert.equal(fire('api/tickets/5/file?path=a.md', false), false, 'not a download: the page shows it');
  assert.equal(fire('citadel-firefox-link.ps1', true, {}, true), false, 'data-here (the setup script) stays in this browser');
  assert.deepEqual(seen.slice(1), [
    ['dl', 'https://cara.apps.example.net/c/api/artifacts/9/raw?v=3&download'],
    ['dl', 'https://cara.apps.example.net/c/api/tickets/5/uploads/a.bin'],
    ['dl', 'https://cara.apps.example.net/apps/mandate/android/mandate-7.apk'],
  ]);
});

test('a page with no download handler (a framed contraption) leaves downloads alone', () => {
  const handlers = [];
  globalThis.addEventListener = (type, fn) => handlers.push([type, fn]);
  mountLinkHandler({ on: () => true, own: () => [], open: () => assert.fail('no Firefox'), base: () => 'https://transdata.citadel.zip/apps/transdata/' });
  const e = { type: 'click', button: 0, target: { closest: () => ({ getAttribute: () => 'export.zip', hasAttribute: () => true }) }, preventDefault() { this.prevented = true; }, stopPropagation() {} };
  for (const [, fn] of handlers) fn(e);
  assert.equal(e.prevented, undefined);
});

test('firefoxDownload: a Citadel file goes to Firefox through a short-lived link; anything else as it is', async () => {
  const origin = 'https://cara.apps.example.net';
  const launched = [];
  const posted = [];
  const post = async (path) => (posted.push(path), { path: '/c/api/dl/TOKEN123' });
  const launch = (a) => (launched.push(a), true);
  await firefoxDownload(`${origin}/c/api/artifacts/9/raw?v=3&download`, { origin, post, launch });
  assert.deepEqual(posted, ['/c/api/artifacts/9/raw?v=3&download']);
  assert.deepEqual(launched, [`${origin}/c/api/dl/TOKEN123`], 'Firefox gets the signed address, never the login-gated one');
  await firefoxDownload(`${origin}/apps/mandate/android/mandate-7.apk`, { origin, post, launch });
  await firefoxDownload('https://example.com/x.zip', { origin, post, launch });
  assert.equal(posted.length, 1, 'an app path or an outside address needs no link');
  assert.deepEqual(launched.slice(1), [`${origin}/apps/mandate/android/mandate-7.apk`, 'https://example.com/x.zip']);
});

test('firefoxDownload: when the server gives no link, Chrome downloads it as before', async () => {
  const origin = 'https://cara.apps.example.net';
  const chrome = [];
  await firefoxDownload(`${origin}/c/api/tickets/5/file?path=a.zip&download`, { origin, post: async () => { throw new Error('403'); }, launch: () => assert.fail('no Firefox'), fallback: (a) => chrome.push(a) });
  assert.deepEqual(chrome, [`${origin}/c/api/tickets/5/file?path=a.zip&download`]);
});
