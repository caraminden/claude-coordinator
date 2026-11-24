// An automatic reload skips the cold-open splash (#1556; Cara, 2026-11-21: "Lets not show the splash screen when the app
// refreshes automatically"); a cold open still shows it. The reload leaves a stamp in sessionStorage (base.js
// reloadQuietly), which login-map-art.js reads and clears before the first paint.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, serveApp, skipMessage, waitFor, type App, type Browser } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;
// Signed out and offline: the page only needs to get as far as the splash script. #stamp stands in for reloadQuietly().
const stub = `<script>
  window.fetch = () => Promise.resolve(new Response('{"error":"Not logged in"}', { status: 401 }));
  window.EventSource = class { addEventListener() {} close() {} };
  if (location.hash === '#stamp') sessionStorage.setItem('cc-no-splash', String(Date.now()));
  if (location.hash === '#old') sessionStorage.setItem('cc-no-splash', String(Date.now() - 60000));
  // Slow head (a starved box, #1802): DOMContentLoaded comes after the splash's 1 s mark, so its lift is due the moment the app draws.
  if (location.hash === '#slow') { while (performance.now() < 1300) {} }
  // The title bar's colours as the page's own scripts left them at DOMContentLoaded, read in that same task: the splash's lift
  // is a timer that fires later, so this is always "while it shows", however long a loaded box takes to get a test's poll in.
  const bar = () => [...document.querySelectorAll('meta[name=theme-color][media*=window-controls-overlay]')].map((m) => m.content).join(' ');
  document.addEventListener('DOMContentLoaded', () => { window.whileShowing = { bar: bar(), splash: !!document.getElementById('splash'), gone: !!document.querySelector('#splash.gone') }; window.ready = true; });
</script>`;
let app: App;
let browser: Browser;

before(async () => {
  if (skip) return;
  app = await serveApp({ stub });
  browser = await launch(bin!);
});
after(async () => {
  await browser?.close();
  await app?.close();
});

const state = `({ splash: !!document.getElementById('splash'), stamp: sessionStorage.getItem('cc-no-splash') })`;

test('a cold open shows the splash', { skip }, async () => {
  const page = await browser.page(app.base);
  await waitFor(page, 'the page', 'window.ready');
  assert.deepEqual(await page.eval(state), { splash: true, stamp: null });
});

test('after an automatic reload the splash is gone at once, and the stamp is used up', { skip }, async () => {
  const page = await browser.page(app.base + '#stamp');
  await waitFor(page, 'the page', 'window.ready');
  assert.deepEqual(await page.eval(state), { splash: false, stamp: null });
});

test('a stale stamp (the reload never happened) does not hide a later cold open', { skip }, async () => {
  const page = await browser.page(app.base + '#old');
  await waitFor(page, 'the page', 'window.ready');
  assert.deepEqual(await page.eval(state), { splash: true, stamp: null });
});

// The installed app's window buttons sit on the theme-color metas' colour: the map's top while the splash shows, so
// they're no white strip over it, and the page's plain colour once it lifts (#1691).
for (const [name, hash] of [
  ['', ''],
  [', when a slow page head makes its lift due at once', '#slow'],
]) {
  test(`while the splash shows, the title bar takes the map colour, and gets its plain one back when it lifts${name}`, { skip }, async () => {
    const page = await browser.page(app.base + hash);
    const bar = `[...document.querySelectorAll('meta[name=theme-color][media*=window-controls-overlay]')].map((m) => m.content).join(' ')`;
    await waitFor(page, 'the page', 'window.ready');
    assert.deepEqual(await page.eval('window.whileShowing'), { bar: '#f3e9d2 #16142a', splash: true, gone: false });
    await waitFor(page, 'the splash to lift', `document.getElementById('splash')?.classList.contains('gone') ?? true`);
    assert.equal(await page.eval(bar), '#f6f5f2 #161514');
  });
}
