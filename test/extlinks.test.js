import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appLink, appSrc, classifyLink, mountLinkHandler } from '../public/extlinks.js';

const base = 'https://cara.apps.example.net/c/';

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

test("the app view only takes a path inside its own app on Citadel's origin", () => {
  const o = 'https://cara.apps.example.net';
  assert.equal(appSrc('voice', '/apps/voice/rate/?q#h', o), '/apps/voice/rate/?q#h');
  for (const to of ['//evil.com/apps/voice/', '/\\evil.com/apps/voice/', 'https://evil.com/apps/voice/', '/apps/voice2/', '/apps/_citadel/x', '/apps/mandate/', '/apps/voice/../mandate/']) assert.equal(appSrc('voice', to, o), null, to);
});

test('a click on an app link opens the app view; a middle click does too; outside links are left to the browser', () => {
  const handlers = [];
  globalThis.addEventListener = (type, fn) => handlers.push([type, fn]);
  const seen = [];
  mountLinkHandler({ own: () => citadel, apps: () => apps, openApp: (l) => seen.push(['app', l.name, l.to]), base: () => base });
  const fire = (type, href, extra = {}) => {
    const e = {
      type,
      button: type === 'click' ? 0 : 1,
      target: { closest: () => ({ getAttribute: () => href, hasAttribute: () => false }) },
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {},
      ...extra,
    };
    for (const [t, fn] of handlers) if (t === type) fn(e);
    return e.prevented === true;
  };
  const voice = 'https://voice.citadel.zip/apps/voice/rate/';
  assert.equal(fire('click', voice), true);
  assert.equal(fire('auxclick', voice), true, 'a middle click opens the app view, never a new tab');
  assert.equal(fire('click', voice, { ctrlKey: true }), false);
  assert.equal(fire('click', 'https://example.com/'), false, 'outside links stay with the browser');
  assert.equal(fire('click', '/c/#/x'), false, 'Citadel itself stays');
  assert.deepEqual(seen, [
    ['app', 'voice', '/apps/voice/rate/'],
    ['app', 'voice', '/apps/voice/rate/'],
  ]);
});

// One table decides what a click on a link does.
const ctxOf = (self) => ({ own: ['cara.apps.example.net'], domain: 'citadel.zip', apps: { 'transdata.citadel.zip': 'transdata', 'voice.citadel.zip': 'voice' }, self });
const kindOf = (href, at, self) => {
  const c = classifyLink(href, at, ctxOf(self));
  return c.kind === 'app' ? `app:${c.app.name}${c.app.to}` : c.kind;
};

test('classifyLink: one table for a page in transdata (its own host)', () => {
  const at = 'https://transdata.citadel.zip/apps/transdata/';
  assert.equal(kindOf('/apps/transdata/ingest', at, 'transdata'), 'page', 'relative, same app');
  assert.equal(kindOf('https://transdata.citadel.zip/apps/transdata/ingest', at, 'transdata'), 'page', 'absolute, same app');
  assert.equal(kindOf('https://transdata.citadel.zip/anything', at, 'transdata'), 'page', 'same origin stays with the page');
  assert.equal(kindOf('https://voice.citadel.zip/apps/voice/rate/', at, 'transdata'), 'app:voice/apps/voice/rate/', "another app's host");
  assert.equal(kindOf('https://cara.apps.example.net/apps/voice/rate/', at, 'transdata'), 'app:voice/apps/voice/rate/', "another app on Citadel's host");
  assert.equal(kindOf('https://cara.apps.example.net/c/#/p/2', at, 'transdata'), 'window', "Citadel's own page");
  assert.equal(kindOf('https://citadel.zip/', at, 'transdata'), 'window', 'the bare apps domain');
  assert.equal(kindOf('https://docs.citadel.zip/x', at, 'transdata'), 'window', 'a citadel.zip host that is no app');
  assert.equal(kindOf('https://notcitadel.zip/', at, 'transdata'), 'browser', 'only the domain and its subdomains');
  assert.equal(kindOf('https://example.com/x', at, 'transdata'), 'browser', 'outside');
  assert.equal(kindOf('https://voice.citadel.zip/other/', at, 'transdata'), 'window', "an app host path the view can't show: still Citadel's");
  assert.equal(kindOf('mailto:a@b.c', at, 'transdata'), 'page');
});

test("classifyLink: a page in transdata on Citadel's host (no apps domain), and Citadel's own page", () => {
  const frameAt = 'https://cara.apps.example.net/apps/transdata/';
  assert.equal(kindOf('/apps/transdata/ingest', frameAt, 'transdata'), 'page');
  assert.equal(kindOf('/apps/voice/', frameAt, 'transdata'), 'app:voice/apps/voice/');
  assert.equal(kindOf('https://example.com/', frameAt, 'transdata'), 'browser');
  const top = 'https://cara.apps.example.net/c/';
  assert.equal(kindOf('/apps/transdata/ingest', top, null), 'app:transdata/apps/transdata/ingest');
  assert.equal(kindOf('#/p/2/t/9', top, null), 'page');
  assert.equal(kindOf('/api/x', top, null), 'page');
  assert.equal(kindOf('https://example.com/', top, null), 'browser');
  assert.equal(classifyLink('/apps/transdata/ingest', frameAt, { self: 'transdata' }).kind, 'page');
});
