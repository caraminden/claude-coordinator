// A scheme page left behind is freed (#1747, Cara 2026-11-23: "I just had a like 20s pause", "The whole app became
// unresponsive"; her desktop app sat at 8.4 GB with a core pegged). Each switch between schemes draws a new page, and
// four lists kept every old one for good or for a minute: the message boxes waiting for the caret (ui/composer.js
// tested a marker it sets to ''), a width watcher made per draw (project.js), each chat's attachment strip
// (composer.js) and the CI and Status chips (ci.js, status.js). In a real browser (headless Chromium, test/browser.ts)
// against the real server: after a visit to each of eight schemes (each chat seen once, so its strip is never moved to a newer page) and a forced collection, the old pages' message boxes are gone.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bootServer, type Booted } from './helpers.ts';
import { chromium, launch, waitFor, type Browser } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';

let srv: Booted;
let browser: Browser;
const schemes: number[] = [];

before(async () => {
  srv = await bootServer();
  for (const name of ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight']) schemes.push((await srv.call('/api/projects', { name })).data.id);
  if (!skip) browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await srv?.stop();
});

test('switching through eight schemes leaves no old page in memory', { skip }, async () => {
  const page = await browser.page('data:text/html,<script>window.ready=true</script>', { width: 1280, height: 800 });
  const [name, value] = srv.cookie.split('=');
  await page.send('Network.setCookie', { name, value, url: srv.base });
  await page.send('Page.navigate', { url: `${srv.base}/#/p/${schemes[0]}` });
  const shown = (id: number) => `location.hash === '#/p/${id}' && !!document.querySelector('.composer textarea') && !document.querySelector('.composer textarea').dataset.leakSeen`;
  const SWITCHES = schemes.length - 1;
  for (let i = 0; i <= SWITCHES; i++) {
    const id = schemes[i];
    if (i) await page.eval(`location.hash = '#/p/${id}'`);
    await waitFor(page, `scheme ${id}'s page`, shown(id));
    // Marked, so the next wait is for a new page's box; two frames on, so the box's own caret step has run.
    await page.eval(`new Promise((ok) => { document.querySelector('.composer textarea').dataset.leakSeen = '1'; requestAnimationFrame(() => requestAnimationFrame(ok)); })`);
  }
  await page.send('HeapProfiler.enable');
  for (let i = 0; i < 2; i++) await page.send('HeapProfiler.collectGarbage');
  const proto = await page.send('Runtime.evaluate', { expression: 'HTMLTextAreaElement.prototype' });
  const all = await page.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
  const off = await page.send('Runtime.callFunctionOn', { objectId: all.objects.objectId, returnByValue: true,
    functionDeclaration: 'function () { return this.filter((t) => { try { return !t.isConnected; } catch { return false; } }).length; }' });
  // The newest lists let go when the next page is drawn, so the page before the one on screen may still be held.
  assert.ok(off.result.value <= 3, `${off.result.value} message boxes from pages left behind are still in memory after ${SWITCHES} switches`);
});
