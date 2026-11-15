// Opening a chat dims the old view (body.navigating) until the new one is drawn (#494). The dim used to stay
// on after the chat showed, for as long as the catch-up fetch and a Taskmaster's "While you were away" recap
// took, which is seconds on a big database. Citadel's real front end (public/index.html) in headless
// Chromium (test/browser.ts), with fetch answered in the page so nothing reaches a server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
const pub = join(import.meta.dirname, '..', 'public');

// Runs before app.js: a fake server for the API. The recap and the catch-up (events?after=) wait until
// the test calls release(), as a slow server would.
const STUB = `<script>
  window.ready = true;
  let open;
  const held = new Promise((r) => (open = r));
  window.release = () => open();
  const now = Date.now();
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  const minion = { id: 101, project_id: 1, kind: 'ticket', number: 7, title: 'A minion', status: 'idle', updated_at: 0, created_at: now - 1000 };
  const said = (id, ticket, text) => ({ id, ticket_id: ticket, kind: 'user_message', data: JSON.stringify({ text, author: 'Cara' }), created_at: now - 60_000 });
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply(200, { name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets: [minion], seen: {}, person_notes: {}, pins: [] });
    if (path === 'api/projects/1/recap') return held.then(() => reply(200, { since: null, turns: {} }));
    let m;
    if ((m = path.match(/^api\\/tickets\\/(\\d+)$/))) return reply(200, { ticket: m[1] === '100' ? coordinator : minion });
    if ((m = path.match(/^api\\/tickets\\/(\\d+)\\/events$/))) {
      const id = Number(m[1]);
      if (url.search.includes('after=')) return held.then(() => reply(200, Number(url.searchParams.get('after')) < 3 ? [said(3, id, 'caught up')] : []));
      return reply(200, { events: [said(id === 100 ? 1 : 2, id, 'drawn')], tasks: [], more: false });
    }
    if (/inbox$/.test(path)) return reply(200, { items: [] });
    return reply(200, []);
  };
  window.EventSource = class { close() {} };
</script>`;

let server: Server;
let browser: Browser;
let base = '';

before(async () => {
  if (skip) return;
  const types: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/') {
      const html = readFileSync(join(pub, 'index.html'), 'utf8').replace('<head>', `<head>${STUB}`);
      return res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    }
    const file = normalize(join(pub, path));
    if (!file.startsWith(pub)) return res.writeHead(404).end();
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      return res.writeHead(404).end();
    }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r(null)));
});

const drawn = `[...document.querySelectorAll('#log .msg')].some((el) => el.textContent.includes('drawn'))`;
const dimmed = `document.body.classList.contains('navigating')`;

for (const [who, hash] of [['a Taskmaster', '#/p/1'], ['a minion', '#/p/1/t/7']]) {
  test(`${who}'s chat isn't dimmed once it's drawn, while the catch-up and recap are still on their way`, { skip }, async () => {
    const page = await browser.page(`${base}${hash}`, { width: 1280, height: 800 });
    await waitFor(page, 'the chat to draw', drawn);
    await waitFor(page, 'the dim to clear', `!(${dimmed})`);
    // It cleared while the catch-up was still held, and the chat shows at full opacity.
    assert.equal(await page.eval(`document.getElementById('log').textContent.includes('caught up')`), false, 'the catch-up was held');
    assert.equal(await page.eval(`getComputedStyle(document.querySelector('#app .split > :last-child, #app > :not(.split)')).opacity`), '1');
    // The held fetches still land once the server answers.
    await page.eval('release()');
    await waitFor(page, 'the caught-up message', `document.getElementById('log').textContent.includes('caught up')`);
  });
}
