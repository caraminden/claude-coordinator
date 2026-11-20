// The installed app opens at once (#1144), in a real browser (headless Chromium, test/browser.ts) against the real server:
// - with the server gone, it opens on the last chat from the files its service worker kept and the chat kept on the
//   device, saying it is catching up;
// - with the server there, the kept chat shows first, then the live one replaces it in place;
// - signing out forgets the kept chat.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { bootServer, until, type Booted } from './helpers.ts';
import { chromium, launch, waitFor, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
const shots = process.env.INSTANT_OPEN_SHOTS; // a folder: write desktop and phone screenshots there

const servers: Booted[] = [];
let browser: Browser | null = null;
after(async () => {
  await browser?.close();
  for (const s of servers) await s.stop();
});

/** A server with a scheme and a quiet minion (CLAUDE_BIN is /bin/false, so its first turn just ends). */
async function server() {
  const srv = await bootServer();
  servers.push(srv);
  const projectId = (await srv.call('/api/projects', { name: 'P' })).data.id;
  const t = (await srv.call(`/api/projects/${projectId}/tickets`, { title: 'Kept', message: 'hello from before' })).data;
  await until('the first turn to end', async () => (await srv.call(`/api/tickets/${t.id}`)).data.ticket.status !== 'running');
  return { srv, hash: `#/p/${projectId}/t/${t.number}`, ticket: t };
}

const said = (text: string) => `[...document.querySelectorAll('#log .msg.user')].some((m) => m.textContent.includes(${JSON.stringify(text)}))`;
const chip = `document.querySelector('.reconnecting')?.textContent`;

/** Open the chat signed in, and wait for the service worker to keep the app's files and the page to keep the chat. */
async function openOnce(srv: Booted, hash: string, width = 1280) {
  browser ??= await launch(bin!);
  const page = await browser.page('data:text/html,<script>window.ready=true</script>', { width, height: 800 });
  const [name, value] = srv.cookie.split('=');
  await page.send('Network.setCookie', { name, value, url: srv.base });
  await page.send('Page.navigate', { url: `${srv.base}/c/${hash}` });
  await waitFor(page, 'the chat', said('hello from before'));
  await waitFor(page, 'the kept chat', `JSON.parse(localStorage.getItem('cc-last-chat') || '{}').hash === ${JSON.stringify(hash)}`);
  await page.eval(`navigator.serviceWorker.ready.then(() => undefined)`);
  await waitFor(page, 'the kept files', `caches.keys().then((k) => k.some((n) => n.startsWith('shell-')))`);
  return page;
}

async function shoot(page: Page, name: string) {
  if (!shots) return;
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
}

for (const [width, label] of [[1440, 'desktop'], [390, 'phone']] as const) {
  test(`at ${label} width, with the server gone, the app opens on the last chat at once and says it is catching up`, { skip }, async () => {
    const { srv, hash } = await server();
    const page = await openOnce(srv, hash, width);
    await srv.stop();
    servers.splice(servers.indexOf(srv), 1);
    const began = Date.now();
    // The installed app's start: /c/ with no address of its own.
    await page.send('Page.navigate', { url: `${srv.base}/c/` });
    await waitFor(page, 'the kept chat', said('hello from before'));
    const ms = Date.now() - began;
    assert.equal(await page.eval('location.hash'), hash, 'the app is at the kept chat\'s address');
    assert.equal(await page.eval(chip), 'Catching up…');
    assert.ok(ms < 2000, `opened in ${ms} ms`);
    console.log(`# ${label}: the kept chat showed ${ms} ms after the launch, with no server`);
    await shoot(page, `${label}-offline.png`);
    // It stays as it is, saying so, while there is no server.
    await page.eval('new Promise((r) => setTimeout(r, 500))');
    assert.equal(await page.eval(chip), 'Catching up…');
    assert.equal(await page.eval(said('hello from before')), true);
  });
}

test('with the server there, the kept chat shows first and the live one replaces it in place', { skip }, async () => {
  const { srv, hash, ticket } = await server();
  const page = await openOnce(srv, hash);
  // Hold the launch's sign-in check, so what shows before it answers is only what was kept.
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const real = window.fetch;
    window.letGo = null;
    window.fetch = (url, opts) => String(url).endsWith('api/me') && !window.letGo
      ? new Promise((ok) => (window.letGo = () => ok(real(url, opts)))) : real(url, opts);
  })()` });
  await page.send('Page.navigate', { url: `${srv.base}/c/` });
  await waitFor(page, 'the kept chat', said('hello from before'));
  await waitFor(page, 'the held sign-in check', '!!window.letGo');
  assert.equal(await page.eval(chip), 'Catching up…');
  await srv.call(`/api/tickets/${ticket.id}/messages`, { text: 'said since', sendId: 'since-1' });
  await page.eval(`(() => { const b = document.querySelector('.composer textarea'); b.value = 'half typed'; b.dispatchEvent(new Event('input')); })()`);
  await page.eval('window.letGo()');
  await waitFor(page, 'the live chat', said('said since'));
  await waitFor(page, 'the chip to go', `!document.querySelector('.reconnecting')`);
  assert.equal(await page.eval(`document.querySelector('.composer textarea').value`), 'half typed', 'refreshed in place: the box keeps what was typed');
  assert.equal(await page.eval(`[...document.querySelectorAll('#log .msg.user')].filter((m) => m.textContent.includes('hello from before')).length`), 1, 'nothing drawn twice');
});

test('signing out forgets the kept chat', { skip }, async () => {
  const { srv, hash } = await server();
  const page = await openOnce(srv, hash);
  await page.eval(`import(new URL('core.js', location.href)).then((m) => m.logout())`);
  assert.equal(await page.eval(`localStorage.getItem('cc-last-chat')`), null);
});
