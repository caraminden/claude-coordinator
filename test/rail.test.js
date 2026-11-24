import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromeIntent, inNativeApp, installMode, opensApart, railItems } from '../public/rail.js';

test('no contraption enabled: no rail at all', () => {
  assert.deepEqual(railItems([], '/'), []);
  assert.deepEqual(railItems(undefined, '/'), []);
});

test('the rail lists Citadel, then each contraption, and marks where you are', () => {
  const mine = [
    { name: 'mandate', title: 'Mandate', icon: '/icon.svg' },
    { name: 'peek-auras', title: 'Peek Auras', icon: null },
  ];
  // In Citadel, a contraption opens in Citadel's own window (#/apps/<name>, frames.js; #274).
  const inCitadel = railItems(mine, null, '/c/', true);
  assert.deepEqual(
    inCitadel.map((i) => [i.title, i.href, i.current]),
    [
      ['Citadel', '/c/', true],
      ['Mandate', '#/apps/mandate', false],
      ['Peek Auras', '#/apps/peek-auras', false],
    ],
  );
  // A contraption's icon is a path it serves; none gets a letter tile.
  assert.deepEqual(
    inCitadel.map((i) => i.icon),
    ['/c/icon.svg', '/apps/_citadel/icon/mandate', null],
  );
  assert.deepEqual(
    railItems(mine, 'mandate', '/c/', true).map((i) => i.current),
    [false, true, false],
  );
  // From a contraption's own page, the others open in Citadel's window too, through Citadel's root.
  const inMandate = railItems(mine, 'mandate', '/c/');
  assert.deepEqual(
    inMandate.map((i) => [i.href, i.current]),
    [
      ['/c/', false],
      ['/c/#/apps/mandate', true],
      ['/c/#/apps/peek-auras', false],
    ],
  );
  // One that isn't up (service down, keys that don't open) gets a greyed letter tile: nothing is fetched from it.
  const down = railItems(
    [
      { ...mine[0], up: false },
      { ...mine[1], up: true },
    ],
    null,
    '/c/',
    true,
  );
  assert.deepEqual(
    down.map((i) => [i.icon, i.down]),
    [
      ['/c/icon.svg', undefined],
      [null, true],
      [null, false],
    ],
  );
  // In a preview, Citadel is its preview's root.
  assert.equal(railItems(mine, null, '/preview/4/c/')[0].href, '/preview/4/c/');
});

test("a contraption's own installed app opens every other entry apart, so Chrome hands it to Citadel's app; in a tab, same tab", () => {
  const items = railItems([{ name: 'mandate', title: 'Mandate' }], 'mandate', '/c/');
  assert.deepEqual(
    items.map((i) => opensApart(i, true)),
    [true, false],
  ); // Mandate is where you are
  assert.deepEqual(
    items.map((i) => opensApart(i, false)),
    [false, false],
  );
});

test('the Install button picks how this browser installs the app showing (#297)', () => {
  const at = (o) => installMode({ own: false, standalone: false, prompt: false, installed: false, android: false, ios: false, ...o });
  // On the app's own page in a browser tab: the browser's prompt once it offers one.
  assert.equal(at({ own: true, prompt: true }), 'prompt');
  assert.equal(at({ own: true, prompt: true, android: true }), 'prompt');
  // No prompt: on Android it may be a Custom Tab (no Install in its menu), so hand the page to Chrome; iOS gets the Share hint.
  assert.equal(at({ own: true, android: true }), 'intent');
  assert.equal(at({ own: true, ios: true }), 'ios');
  // A desktop browser that offers nothing (installed already, or one that can't): no button.
  assert.equal(at({ own: true }), null);
  // The app's own installed window, or an app this browser installed: no button anywhere.
  assert.equal(at({ own: true, standalone: true, prompt: true }), null);
  assert.equal(at({ own: true, prompt: true, installed: true }), null);
  assert.equal(at({ installed: true }), null);
  // In Citadel, the app framed (the browser sees only Citadel): its own page in a new tab ...
  assert.equal(at({}), 'tab');
  assert.equal(at({ android: true }), 'tab');
  assert.equal(at({ ios: true }), 'tab');
  assert.equal(at({ standalone: true }), 'tab');
  // ... except Citadel's installed app on Android, whose new tab would be a Custom Tab: straight to Chrome.
  assert.equal(at({ standalone: true, android: true }), 'intent');
});

test("the Android link opens the app's page in Chrome, falling back to the page itself", () => {
  const url = new URL('https://cara.example.net/apps/theory-of-crafting/');
  assert.equal(chromeIntent(url), 'intent://cara.example.net/apps/theory-of-crafting/#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fcara.example.net%2Fapps%2Ftheory-of-crafting%2F;end');
});

test('inNativeApp: a Capacitor WebView (remote server.url included) or a CitadelApp user agent, never a plain browser', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36';
  assert.equal(inNativeApp({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' }, navigator: { userAgent: ua } }), true);
  assert.equal(inNativeApp({ Capacitor: { getPlatform: () => 'ios' }, navigator: { userAgent: ua } }), true);
  assert.equal(inNativeApp({ navigator: { userAgent: ua + ' CitadelApp' } }), true);
  // Capacitor's web fallback (a browser that loaded its script) and plain tabs are not the app.
  assert.equal(inNativeApp({ Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' }, navigator: { userAgent: ua } }), false);
  assert.equal(inNativeApp({ navigator: { userAgent: ua } }), false);
  assert.equal(inNativeApp(null), false);
});
