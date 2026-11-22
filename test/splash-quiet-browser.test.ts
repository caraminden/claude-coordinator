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
  document.addEventListener('DOMContentLoaded', () => { window.ready = true; });
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
