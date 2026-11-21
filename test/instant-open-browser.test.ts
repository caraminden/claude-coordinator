// The installed app opens at once (#1144), in a real browser (headless Chromium, test/browser.ts) against the real server:
// - with the server gone, it opens on the last chat from the files its service worker kept and the chat kept on the
//   device, saying it is catching up;
// - with the server there, the kept chat shows first, then the live one replaces it in place;
// - signing out forgets the kept chat;
// - a ship (SIGHUP with a changed public/, as tools/deploy.sh does) reaches an open app with no refresh by hand.
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as listen, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { bootServer, until, PASSWORD, type Booted } from './helpers.ts';
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
  // A stream's hello redraws the usage meter from the server's usage (none on a test server: it hides the meter), so a
  // test that draws usage itself waits for the hello first: `window.hellos` counts the ones the page has handled.
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.hellos = 0;
    const ES = window.EventSource;
    window.EventSource = class extends ES {
      constructor(...a) {
        super(...a);
        // Counted a task later, so the page's own handlers (however it adds them) have drawn this hello first.
        this.addEventListener('message', (e) => { if (JSON.parse(e.data).type === 'hello') setTimeout(() => window.hellos++); });
      }
    };
  })()` });
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
    // The address now takes every connection and never answers, so the launch's requests hang for good (the test
    // closes them at the end). The kept chat showing while they hang is what "doesn't wait on the network" means.
    const held: Socket[] = [];
    const hole = listen((c) => { held.push(c); });
    after(() => { for (const c of held) c.destroy(); hole.close(); });
    await new Promise<void>((ok) => hole.listen(Number(new URL(srv.base).port), '127.0.0.1', ok));
    // The installed app's start: /c/ with no address of its own.
    await page.send('Page.navigate', { url: `${srv.base}/c/` });
    await waitFor(page, 'the kept chat', said('hello from before'));
    assert.equal(await page.eval(chip), 'Catching up…');
    assert.equal(await page.eval('location.hash'), hash, 'the app is at the kept chat\'s address');
    await until('a request to be held', () => held.length > 0);
    assert.ok(held.length > 0, 'the launch did ask the network, and was never answered');
    console.log(`# ${label}: the kept chat showed while ${held.length} connection(s) to the server were held open`);
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

test('signing out forgets the kept chat, and what was asked, so the next person signing in on that page keeps none of it', { skip }, async () => {
  const { srv, hash, ticket } = await server();
  const page = await openOnce(srv, hash);
  const asked = `import(new URL('base.js', location.href)).then((m) => Object.keys(m.keptAnswers(${ticket.project_id}, ${ticket.id})).length)`;
  assert.ok(await page.eval(asked) > 0);
  await page.eval(`import(new URL('core.js', location.href)).then((m) => m.logout())`);
  assert.equal(await page.eval(`localStorage.getItem('cc-last-chat')`), null);
  assert.equal(await page.eval(asked), 0);
});

test('signed out, the top bar has no usage meter or chips (#1439); signing back in brings them back with no reload', { skip }, async () => {
  const { srv, hash } = await server();
  const page = await openOnce(srv, hash);
  const seen = `({ chips: document.querySelectorAll('.topbar .meters .ci-chip, .topbar .meters .status-chip, .topbar .meters .releases-chip').length, usage: !!document.querySelector('.topbar .meters .usage:not([hidden])') })`;
  await waitFor(page, 'the stream\'s hello', 'window.hellos > 0');
  await page.eval(`import(new URL('core.js', location.href)).then((m) => m.renderUsage({ weekly: { utilization: 0.44, resetsAt: Date.now() + 36e5 } }))`);
  await waitFor(page, 'the chips and meter', `${seen}.chips === 3 && ${seen}.usage`);
  await page.eval(`import(new URL('core.js', location.href)).then((m) => m.logout())`);
  assert.deepEqual(await page.eval(seen), { chips: 0, usage: false }, 'the login screen shows none');
  await shoot(page, 'signed-out.png');
  await page.eval('window.hellos = 0');
  await page.eval(`(() => { const f = document.getElementById('login-form'); f.login.value = 'Cara'; f.password.value = ${JSON.stringify(PASSWORD)}; f.requestSubmit(); })()`);
  await waitFor(page, 'the chips back', `${seen}.chips === 3`);
  await waitFor(page, 'the new stream\'s hello', 'window.hellos > 0'); // a hello after the usage below hid it under load
  await page.eval(`import(new URL('core.js', location.href)).then((m) => m.renderUsage({ weekly: { utilization: 0.44, resetsAt: Date.now() + 36e5 } }))`);
  assert.equal((await page.eval(seen)).usage, true, 'the meter shows again');
  await shoot(page, 'signed-in-again.png');
});

test('a ship reaches an open app out of sight: a visible page stays, the next navigation loads the new version from the worker\'s kept files', { skip }, async () => {
  // A copy of the repo to ship into, so the change to public/ stays out of this checkout.
  const repo = join(import.meta.dirname, '..');
  const copy = mkdtempSync(join(tmpdir(), 'ship-'));
  after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(repo, copy, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules)$/.test(src) });
  const srv = await bootServer({ script: join(copy, 'server.ts') });
  servers.push(srv);
  browser ??= await launch(bin!);
  const page = await browser.page('data:text/html,<script>window.ready=true</script>', { width: 1280, height: 800 });
  const [name, value] = srv.cookie.split('=');
  await page.send('Network.setCookie', { name, value, url: srv.base });
  await page.send('Page.navigate', { url: `${srv.base}/c/` });
  const version = `document.querySelector('meta[name="citadel-version"]').content`;
  await waitFor(page, 'the page', `!!document.querySelector('.topbar')`);
  const v1 = await page.eval(version);
  await waitFor(page, 'the kept files', `caches.keys().then((k) => k.join() === 'shell-${v1}')`);
  await page.eval('window.beforeTheShip = true');

  appendFileSync(join(copy, 'public', 'style.css'), '\n/* shipped */\n');
  srv.proc.kill('SIGHUP');
  const shipped = Date.now();
  // A page you are looking at never refreshes by itself (#1256): give the stream's hello time to land, then check it stayed.
  await new Promise((done) => setTimeout(done, 7000));
  assert.equal(await page.eval('window.beforeTheShip'), true, 'a visible page does not reload on its own');
  await page.eval(`location.hash = '#/settings'`);
  await waitFor(page, 'the new version', `!window.beforeTheShip && document.querySelector('meta[name="citadel-version"]')?.content !== ${JSON.stringify(v1)}`);
  const v2 = await page.eval(version);
  console.log(`# the open app was on the new version ${Date.now() - shipped} ms after the ship`);
  assert.equal(v2, (await fetch(`${srv.base}/c/`)).headers.get('x-front-version'), 'the page is the version the server now runs');
  await waitFor(page, 'only the new files kept', `caches.keys().then((k) => k.join() === 'shell-${v2}')`);
  assert.equal(await page.eval(`fetch('style.css').then((r) => r.text()).then((t) => t.includes('/* shipped */'))`), true);
  assert.equal(await page.eval('navigator.serviceWorker.controller?.state'), 'activated');
});
