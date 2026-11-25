// A minion is only marked seen, left or "here" while its chat could be seen (#1851): not in a hidden tab, under an open
// app, or in Citadel's put-away layer over an app's installed window. A seen mark clears the unread mark and the
// @mention, and a `left` closes a finished minion seen at its last update (#811), so a wrong one loses it unread.
// And the sign-in form keeps what is typed: no heartbeat redraws it. Citadel's real front end in headless Chromium
// (test/browser.ts), served at /c/ as it is live, with fetch and EventSource faked in the page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, serve, skipMessage, waitFor, type App, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;
const pub = join(import.meta.dirname, '..', 'public');
const APPS = [
  { name: 'peek', title: 'Peek', icon: null, up: true },
  { name: 'toc', title: 'ToC', icon: null, up: true },
];

// Runs before app.js: a fake API that notes what is posted, a stream the test drives, a tab the test hides, and the
// 30 s timers (the presence heartbeat) run when the test says.
const STUB = `<script>
  window.ready = true;
  window.posts = [];
  window.presence = [];
  window.signedOut = false;
  let now = Date.now() - 60_000;
  const minion = (id, number) => ({ id, project_id: 1, kind: 'ticket', number, title: 'Minion ' + number, status: 'idle', state: null, updated_at: now, created_at: now - 600_000 });
  const coordinator = { ...minion(100, 0), kind: 'coordinator', title: 'Taskmaster' };
  window.tickets = [minion(101, 7), minion(102, 8)];
  const seen = { 100: now, 101: now, 102: now };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input, opts = {}) => {
    const url = new URL(input.url ?? input, location.href);
    const path = url.pathname.replace(/^\\/c\\//, '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (path === 'api/logout') return (window.signedOut = true), reply(200, {});
    if (path === 'api/presence') presence.push(signedOut ? 'signed out' : body.ticketId);
    if (window.signedOut) return reply(401, { error: 'Not logged in' });
    const m = path.match(/^api\\/tickets\\/(\\d+)\\/seen$/);
    if (m) {
      posts.push((body.left ? 'left ' : 'seen ') + m[1]);
      if (!body.left) seen[m[1]] = Date.now();
      return reply(200, { seen_at: seen[m[1]] ?? 0 });
    }
    if (path === 'api/me') return reply(200, { name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets, seen: { ...seen }, person_notes: {}, pins: [] });
    const t = path.match(/^api\\/tickets\\/(\\d+)$/);
    if (t) return reply(200, { ticket: [coordinator, ...tickets].find((x) => String(x.id) === t[1]) });
    if (/events$/.test(path)) return reply(200, url.search.includes('after=') ? [] : { events: [], tasks: [], more: false });
    if (path === 'api/contraptions/mine') return reply(200, ${JSON.stringify(APPS)});
    if (/inbox$/.test(path)) return reply(200, { items: [] });
    if (path === 'api/projects/1/properties') return reply(200, { keys: [] });
    return reply(200, []);
  };
  window.streams = [];
  window.EventSource = class {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    readyState = 0;
    constructor() { streams.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); tell({ type: 'hello', version: 'v1', stream: 's' + streams.length }); }); }
    close() { this.readyState = 2; }
  };
  window.tell = (msg) => streams.at(-1).onmessage({ data: JSON.stringify(msg) });
  window.reconnect = () => { const es = streams.at(-1); es.readyState = 0; es.onerror(); es.readyState = 1; es.onopen(); };
  /** Minion 101 finishes: on the server, and (unless the stream is down) told to the page. */
  window.finish = (told = true) => {
    now = Date.now();
    tickets[0] = { ...tickets[0], state: 'complete', updated_at: now };
    if (told) tell({ type: 'ticket', ticket: tickets[0] });
  };
  let hidden = parent === window ? sessionStorage.getItem('hidden') === '1' : false;
  Object.defineProperty(document, 'hidden', { get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible') });
  window.hide = (on) => { hidden = on; if (parent === window) sessionStorage.setItem('hidden', on ? '1' : ''); document.dispatchEvent(new Event('visibilitychange')); };
  const beats = [];
  const every = window.setInterval;
  window.setInterval = (fn, ms, ...a) => (ms === 30_000 ? beats.push(fn) : every(fn, ms, ...a));
  window.beat = () => beats.forEach((fn) => fn());
</script>`;

// An app's own installed window (rail.js openLayer): Citadel opens in a layer over it.
const INSTALLED = `<!doctype html><meta charset="utf-8"><body><script>window.ready = true;
  const media = window.matchMedia.bind(window);
  window.matchMedia = (q) => (q.includes('display-mode') ? { matches: true, addEventListener() {} } : media(q));
</script><script type="module">import '/apps/_citadel/rail.js';</script>`;

const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
let app: App;
let browser: Browser;

before(async () => {
  if (skip) return;
  app = await serve((path, res) => {
    const send = (type: string, body: string | Buffer) => void res.writeHead(200, { 'content-type': type }).end(body);
    if (path === '/c/') return send('text/html', readFileSync(join(pub, 'index.html'), 'utf8').replace('<head>', `<head>${STUB}`));
    if (path === '/apps/peek/') return send('text/html', INSTALLED);
    if (path === '/apps/toc/') return send('text/html', '<!doctype html><p>ToC</p>');
    if (path === '/apps/_citadel/api/mine') return send('application/json', JSON.stringify({ name: 'Cara', citadel: null, apps: APPS }));
    const file = normalize(join(pub, path.replace(/^\/(c|apps\/_citadel)\//, '/')));
    try {
      if (file.startsWith(pub)) return send(types[extname(file)] ?? 'application/octet-stream', readFileSync(file));
    } catch {}
    res.writeHead(404).end();
  });
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await app?.close();
});

/** Minion 7's chat, open in a tab on screen, its first seen mark sent. `w`: the window its page runs in. */
async function chat(page: Page, w = 'window') {
  await waitFor(page, "the chat and its first mark", `${w}.document.getElementById('ticket-head')?.textContent.includes('Minion 7') && ${w}.posts.includes('seen 101') && ${w}.presence.at(-1) === 101`);
  await page.eval(`${w}.posts.length = 0, ${w}.presence.length = 0`);
}
const openChat = async () => {
  const page = await browser.page(`${app.base}c/#/p/1/t/7`, { width: 1280, height: 800 });
  await chat(page);
  return page;
};
/** What was posted once a mark (800 ms after it's asked for) would have gone. */
const posted = (page: Page, w = 'window') => page.eval<string[]>(`new Promise((r) => setTimeout(() => r([...${w}.posts]), 1200))`);
const go = (page: Page, hash: string) => page.eval(`location.hash = ${JSON.stringify(hash)}`);
const row = `document.querySelector('#threads .thread-row[href="#/p/1/t/7"]')`;

test('a hidden tab that reconnects leaves its chat unread, and closing or reloading it does not leave the minion', { skip }, async () => {
  const page = await openChat();
  await page.eval('hide(true)');
  assert.deepEqual(await posted(page), ['left 101'], 'hiding a tab leaves the chat that was on screen');
  await page.eval('posts.length = 0; finish(false); reconnect()');
  await waitFor(page, 'the catch-up', `${row}?.textContent && document.getElementById('ticket-head').closest('.chat')`);
  assert.deepEqual(await posted(page), [], 'the reconnect marked nothing seen');
  await waitFor(page, 'the unread mark kept', `${row}.matches('.unread')`);
  await page.eval(`dispatchEvent(new PageTransitionEvent('pagehide'))`);
  assert.deepEqual(await posted(page), [], 'closing the hidden tab left nothing');
  await page.eval('hide(false)');
  assert.deepEqual(await posted(page), ['seen 101'], 'back on screen: seen');
});

test('a hidden tab that reloaded itself marks its chat seen only once shown', { skip }, async () => {
  const page = await openChat();
  await page.eval('hide(true); location.reload()');
  await waitFor(page, 'the chat again, still hidden', `document.hidden && document.getElementById('ticket-head')?.textContent.includes('Minion 7') && streams.length`);
  assert.deepEqual(await posted(page), []);
  await page.eval(`dispatchEvent(new PageTransitionEvent('pagehide'))`);
  assert.deepEqual(await posted(page), [], 'nor is it left');
  await page.eval('hide(false)');
  assert.deepEqual(await posted(page), ['seen 101']);
});

test('a mark still waiting to be sent when the tab is hidden is not sent', { skip }, async () => {
  const page = await openChat();
  await page.eval(`finish(); hide(true); posts.length = 0`);
  assert.deepEqual(await posted(page), []);
});

test('a tab shown again with its stream alive marks the chat seen', { skip }, async () => {
  const page = await openChat();
  await page.eval('hide(true); finish(); posts.length = 0');
  assert.deepEqual(await posted(page), []);
  await page.eval('hide(false)');
  assert.deepEqual(await posted(page), ['seen 101']);
});

test('a chat under an open app is not marked seen, left or here, and is again once the app is left for it', { skip }, async () => {
  const page = await openChat();
  await go(page, '#/apps/toc');
  await waitFor(page, 'the app', `document.documentElement.classList.contains('framed')`);
  await waitFor(page, 'presence: not in the chat', `presence.at(-1) === null`);
  await page.eval('beat()');
  assert.equal(await page.eval('presence.at(-1)'), null, 'nor at a heartbeat');
  await page.eval('finish(); reconnect()');
  assert.deepEqual(await posted(page), []);
  await page.eval(`hide(true); dispatchEvent(new PageTransitionEvent('pagehide')); hide(false)`);
  assert.deepEqual(await posted(page), [], 'the window hidden, closed or shown changes nothing');
  await go(page, '#/p/1/t/7');
  await waitFor(page, 'presence: in the chat', `presence.at(-1) === 101`);
  assert.deepEqual(await posted(page), ['seen 101']);
  await go(page, '#/p/1/t/8');
  assert.ok((await posted(page)).includes('left 101'), 'read and left: it can close');
});

test('a minion that finished under an app is still unread after leaving the app for another chat', { skip }, async () => {
  const page = await openChat();
  await go(page, '#/apps/toc');
  await waitFor(page, 'the app', `document.documentElement.classList.contains('framed')`);
  await page.eval('finish()');
  await go(page, '#/p/1/t/8');
  await waitFor(page, 'the other chat', `document.getElementById('ticket-head')?.textContent.includes('Minion 8') && posts.includes('seen 102')`);
  assert.deepEqual((await posted(page)).filter((p) => p.endsWith('101')), []);
});

test('a finished minion read before the app was opened is left when the app is left for another chat', { skip }, async () => {
  const page = await openChat();
  await page.eval('finish()');
  assert.deepEqual(await posted(page), ['seen 101']);
  await go(page, '#/apps/toc');
  await waitFor(page, 'the app', `document.documentElement.classList.contains('framed')`);
  assert.deepEqual(await posted(page), ['seen 101'], 'opening an app is not leaving the chat under it');
  await page.eval('reconnect()'); // nothing new: what was read is still read
  assert.deepEqual(await posted(page), ['seen 101']);
  await go(page, '#/p/1/t/8');
  await waitFor(page, 'the leave', `posts.includes('left 101')`);
});

test("a chat in Citadel's put-away layer is not marked seen or here until the layer is back", { skip }, async () => {
  const page = await browser.page(`${app.base}apps/peek/`, { width: 1280, height: 800 });
  await waitFor(page, 'the rail', `!!document.querySelector('.citadel-rail a[data-app=""]')`);
  const click = (w: string, name: string) => page.eval(`${w}.document.querySelector('.citadel-rail a[data-app="${name}"]').click()`);
  await click('window', '');
  const w = `document.querySelector('.citadel-layer iframe').contentWindow`;
  await waitFor(page, "Citadel's rail in the layer", `!!${w}.document.querySelector('.citadel-rail a[data-app="peek"]')`);
  await page.eval(`${w}.location.hash = '#/p/1/t/7'`);
  await chat(page, w);
  await click(w, 'peek');
  await waitFor(page, 'the layer put away', `document.querySelector('.citadel-layer').hidden`);
  await waitFor(page, 'presence: not in the chat', `${w}.presence.at(-1) === null`);
  await page.eval(`${w}.finish(); ${w}.reconnect(); ${w}.hide(true); ${w}.hide(false)`);
  assert.deepEqual(await posted(page, w), []);
  // A new front end reloads it out of sight: still put away, and where it was.
  await page.eval(`${w}.location.reload()`);
  await waitFor(page, 'the chat again', `${w}.document.getElementById('ticket-head')?.textContent.includes('Minion 7') && ${w}.streams.length`);
  assert.deepEqual(await posted(page, w), []);
  await click('window', '');
  await waitFor(page, 'the layer back', `!document.querySelector('.citadel-layer').hidden`);
  assert.deepEqual(await posted(page, w), ['seen 101']);
  await waitFor(page, 'presence: in the chat', `${w}.presence.at(-1) === 101`);
});

test('the sign-in form keeps what is typed through the presence heartbeat', { skip }, async () => {
  const page = await openChat();
  await page.eval(`document.querySelector('.sign-out, #me button').click()`);
  await waitFor(page, 'the sign-in form', `!!document.getElementById('login-form')`);
  await page.eval(`(window.form = document.getElementById('login-form')).querySelector('input').value = 'cara'; beat(); hide(true); hide(false)`);
  assert.deepEqual(await posted(page), []);
  assert.equal(await page.eval(`form.isConnected && document.querySelector('#login-form input').value`), 'cara');
  assert.equal(await page.eval(`presence.includes('signed out')`), false, 'nothing reported for nobody');
});
