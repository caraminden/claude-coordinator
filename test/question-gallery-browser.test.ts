// Question cards with pictures (#634; Cara, 2026-11-12: "Cards with images should never autosend, and clicking
// it anywhere should show the image to you"). Citadel's real front end (public/index.html) in headless Chromium
// (test/browser.ts), the API answered in the page. Josh, 2026-11-13: "clicking should still select them". A click
// anywhere on a picture tile selects it and opens the file viewer,
// whose bar steps between the card's pictures and picks one, and only the card's Send sends.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
const pub = join(import.meta.dirname, '..', 'public');

const opts = (n: number) => ['Garden', 'Forest', 'Desert'].slice(0, n).map((label, i) => ({ label, description: `${label} palette`, image: `takes/${label.toLowerCase()}.svg`, recommended: i === 0 }));
// Each card is one minion's chat: 7 a picture card, 8 the same answered, 9 text only, 10 pictures with a second question.
const CARDS: Record<number, { questions: unknown[]; answered?: string[] }> = {
  7: { questions: [{ header: 'Palette', question: 'Which direction?', options: opts(3) }] },
  8: { questions: [{ header: 'Palette', question: 'Which direction?', options: opts(2) }], answered: ['Forest'] },
  9: { questions: [{ header: 'Layout', question: 'Tabs or list?', options: [{ label: 'Tabs', recommended: true }, { label: 'List' }] }] },
  10: { questions: [{ header: 'Palette', question: 'Which direction?', options: opts(2) }, { header: 'Size', question: 'How big?', options: [{ label: 'Small', recommended: true }, { label: 'Large' }] }] },
  11: { questions: [{ header: 'Palette', question: 'Which direction?', options: [...opts(2), { label: 'Garden, darker', image: 'takes/garden.svg' }] }] },
  12: { questions: [{ header: 'Palette', question: 'Which ones?', multiSelect: true, options: opts(2) }] },
};

// Runs before app.js: a fake server for the API. Answers are recorded in `sent` and never answered, as a
// slow server would.
const STUB = `<script>
  window.ready = true;
  window.sent = [];
  const CARDS = ${JSON.stringify(CARDS)};
  const now = Date.now();
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  const minion = (n) => ({ id: n, project_id: 1, kind: 'ticket', number: n, title: 'Minion ' + n, status: 'idle', updated_at: 0, created_at: now - 1000 });
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply(200, { name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets: Object.keys(CARDS).map((n) => minion(Number(n))), seen: {}, person_notes: {}, pins: [] });
    if (path === 'api/projects/1/recap') return reply(200, { since: null, turns: {} });
    let m;
    if ((m = path.match(/^api\\/tickets\\/(\\d+)\\/answer$/))) {
      sent.push(JSON.parse(init.body));
      return new Promise(() => {});
    }
    if ((m = path.match(/^api\\/tickets\\/(\\d+)\\/file$/))) {
      const p = url.searchParams.get('path');
      return reply(200, { path: p, name: p.split('/').pop(), display_path: p, abs: '/w/' + p, kind: 'image', size: 300, mtime: 1, artifact: null });
    }
    if ((m = path.match(/^api\\/tickets\\/(\\d+)$/))) return reply(200, { ticket: m[1] === '100' ? coordinator : minion(Number(m[1])) });
    if ((m = path.match(/^api\\/tickets\\/(\\d+)\\/events$/))) {
      const id = Number(m[1]);
      if (url.search.includes('after=')) return reply(200, []);
      const card = CARDS[id];
      if (!card) return reply(200, { events: [], tasks: [], more: false });
      const events = [{ id: 1, ticket_id: id, kind: 'question', data: JSON.stringify({ id: 'q' + id, questions: card.questions }), created_at: now - 60_000 }];
      if (card.answered) events.push({ id: 2, ticket_id: id, kind: 'user_message', data: JSON.stringify({ author: 'Cara', text: 'My answers', answer: { questionId: 'q' + id, answers: [{ selected: card.answered, other: '' }] } }), created_at: now - 50_000 });
      return reply(200, { events, tasks: [], more: false });
    }
    if (/inbox$/.test(path)) return reply(200, { items: [] });
    return reply(200, []);
  };
  window.EventSource = class { close() {} };
</script>`;

const PICTURE = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="${fill}"/><circle cx="450" cy="300" r="160" fill="#40573a"/></svg>`;
const FILLS: Record<string, string> = { garden: '#b8c9ad', forest: '#6f8f6a', desert: '#e3c99a' };

let server: Server;
let browser: Browser;
let base = '';

before(async () => {
  if (skip) return;
  const types: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/') {
      const html = readFileSync(join(pub, 'index.html'), 'utf8').replace('<head>', `<head>${STUB}`);
      return res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    }
    // The pictures themselves load as <img src>, past the page's fetch.
    const pic = /\/file$/.test(url.pathname) && /(\w+)\.svg$/.exec(url.searchParams.get('path') ?? '');
    if (pic) return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(PICTURE(FILLS[pic[1]] ?? '#ccc'));
    const file = normalize(join(pub, url.pathname));
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

const viewerOpen = `!!document.querySelector('dialog.viewer[open] .gallery-controls')`;
const title = `document.querySelector('dialog.viewer .viewer-bar h2')?.textContent`;
const picked = `[...document.querySelectorAll('.qcard .opt.picked')].map((b) => b.dataset.label)`;
const sendBtn = `[...document.querySelectorAll('.qcard .row button')].find((b) => /^Send/.test(b.textContent))`;
const click = (page: Page, selector: string) => page.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);

async function chat(minion: number, opts: { width?: number; height?: number; touch?: boolean } = {}) {
  const page = await browser.page(`${base}#/p/1/t/${minion}`, { width: 1280, height: 800, ...opts });
  await waitFor(page, 'the card', `!!document.querySelector('.qcard .opt')`);
  return page;
}
async function closeViewer(page: Page) {
  await click(page, 'dialog.viewer .close-view');
  await waitFor(page, 'the viewer to close', `!document.querySelector('dialog.viewer')`);
}

test('a click anywhere on a picture tile selects it, opens it in the viewer and sends nothing', { skip }, async () => {
  const page = await chat(7);
  for (const part of ['.tile .thumb', '.tile .opt .label', '.tile .opt .desc', '.tile .opt']) {
    await click(page, part);
    await waitFor(page, `the viewer from ${part}`, viewerOpen);
    assert.equal(await page.eval(title), 'Garden', part);
    assert.equal(await page.eval('sent.length'), 0, part);
    assert.deepEqual(await page.eval(picked), ['Garden'], `${part} selects it`);
    await closeViewer(page);
  }
});

test('the viewer steps between the card\'s pictures, and Pick this picks without sending', { skip }, async () => {
  const page = await chat(7);
  await click(page, '.tile:nth-child(2) .opt');
  await waitFor(page, 'the viewer', viewerOpen);
  assert.equal(await page.eval(title), 'Forest');
  assert.equal(await page.eval(`document.querySelector('.gallery-controls .count').textContent`), '2 / 3');
  await click(page, '.gallery-controls a[aria-label="Next option"]');
  await waitFor(page, 'Desert', `${title} === 'Desert'`);
  await click(page, '.gallery-controls a[aria-label="Next option"]');
  await waitFor(page, 'round to Garden', `${title} === 'Garden'`);
  await click(page, '.gallery-controls a[aria-label="Previous option"]');
  await waitFor(page, 'back to Desert', `${title} === 'Desert'`);
  await click(page, '.gallery-controls .pick');
  assert.deepEqual(await page.eval(picked), ['Desert'], 'the card beside shows the pick');
  assert.equal(await page.eval(`document.querySelector('.gallery-controls .pick').textContent`), '✓ Picked');
  assert.equal(await page.eval('sent.length'), 0);
  // Another pick on a one-answer question replaces it.
  await click(page, '.gallery-controls a[aria-label="Previous option"]');
  await waitFor(page, 'Forest', `${title} === 'Forest'`);
  await click(page, '.gallery-controls .pick');
  assert.deepEqual(await page.eval(picked), ['Forest']);
  await closeViewer(page);
  // Only Send sends, once.
  await page.eval(`${sendBtn}.click(); ${sendBtn}.click()`);
  assert.deepEqual(await page.eval('sent'), [{ questionId: 'q7', answers: [{ selected: ['Forest'], other: '' }] }]);
});

test('an answered picture card still opens its pictures, read-only', { skip }, async () => {
  const page = await chat(8);
  await waitFor(page, 'the answer', `document.querySelector('.qcard').classList.contains('answered')`);
  await click(page, '.tile:nth-child(1) .opt .label');
  await waitFor(page, 'the viewer', viewerOpen);
  assert.equal(await page.eval(title), 'Garden');
  assert.equal(await page.eval(`!!document.querySelector('.gallery-controls .pick')`), false, 'no Pick on an answered card');
  await click(page, '.gallery-controls a[aria-label="Next option"]');
  await waitFor(page, 'Forest', `${title} === 'Forest'`);
  assert.equal(await page.eval(`document.querySelector('.gallery-controls .picked')?.textContent`), '✓ Picked');
  assert.equal(await page.eval('sent.length'), 0);
});

test('a text-only one-pick card still sends on the first click', { skip }, async () => {
  const page = await chat(9);
  await click(page, '.opt');
  assert.deepEqual(await page.eval('sent'), [{ questionId: 'q9', answers: [{ selected: ['Tabs'], other: '' }] }]);
});

test('a picture card with a second question waits for Send with both answers', { skip }, async () => {
  const page = await chat(10);
  await click(page, '.tile:nth-child(1) .thumb');
  await waitFor(page, 'the viewer', viewerOpen);
  await click(page, '.gallery-controls .pick');
  await closeViewer(page);
  await click(page, '[data-q="1"] .opt');
  assert.equal(await page.eval('sent.length'), 0);
  await page.eval(`${sendBtn}.click()`);
  assert.deepEqual(await page.eval('sent[0].answers'), [{ selected: ['Garden'], other: '' }, { selected: ['Small'], other: '' }]);
});

test('two options with one picture each get their own place in the viewer and their own pick', { skip }, async () => {
  const page = await chat(11);
  await click(page, '.tile:nth-child(3) .opt');
  await waitFor(page, 'the viewer', viewerOpen);
  assert.equal(await page.eval(title), 'Garden, darker');
  assert.equal(await page.eval(`document.querySelector('.gallery-controls .count').textContent`), '3 / 3');
  await click(page, '.gallery-controls .pick');
  assert.deepEqual(await page.eval(picked), ['Garden, darker']);
  await click(page, '.gallery-controls a[aria-label="Next option"]');
  await waitFor(page, 'Garden', `${title} === 'Garden'`);
  await click(page, '.gallery-controls a[aria-label="Previous option"]');
  await waitFor(page, 'back to Garden, darker', `${title} === 'Garden, darker'`);
});

test('a card settled while its picture is open turns the viewer read-only', { skip }, async () => {
  const page = await chat(7);
  await click(page, '.tile:nth-child(1) .thumb');
  await waitFor(page, 'the viewer', viewerOpen);
  // What a question_result event does: thread.js calls the card's markSettled.
  await page.eval(`import('/base.js').then((b) => void b.view.cards.get('q7').markSettled())`);
  assert.equal(await page.eval(`!!document.querySelector('.gallery-controls .pick')`), false);
});

test('on a pick-any question a tile click adds the option, a second look keeps it, and the viewer\'s button takes it off', { skip }, async () => {
  const page = await chat(12);
  await click(page, '.tile:nth-child(1) .opt');
  await waitFor(page, 'the viewer', viewerOpen);
  await closeViewer(page);
  await click(page, '.tile:nth-child(2) .thumb');
  await waitFor(page, 'the viewer', viewerOpen);
  await closeViewer(page);
  assert.deepEqual(await page.eval(picked), ['Garden', 'Forest']);
  await click(page, '.tile:nth-child(1) .opt .label');
  await waitFor(page, 'the viewer', viewerOpen);
  assert.deepEqual(await page.eval(picked), ['Garden', 'Forest'], 'a second look keeps it');
  await click(page, '.gallery-controls .pick');
  assert.deepEqual(await page.eval(picked), ['Forest']);
  assert.equal(await page.eval('sent.length'), 0);
});

// The three states Cara asked to see, at desktop and phone widths: nothing picked, one picked waiting for Send,
// and the viewer open. GALLERY_SHOTS=<dir> saves them.
for (const [label, size] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844, touch: true }]] as const) {
  test(`${label}: the bar fits, with even padding, and nothing scrolls sideways`, { skip }, async () => {
    const page = await chat(7, size);
    const shot = async (name: string) => {
      const dir = process.env.GALLERY_SHOTS;
      if (!dir) return;
      mkdirSync(dir, { recursive: true });
      await page.eval(`Promise.all([...document.images].map((i) => i.decode().catch(() => {})))`);
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(dir, `gallery-${size.width}-${name}.png`), Buffer.from(data, 'base64'));
    };
    await page.eval(`document.querySelector('.qcard').scrollIntoView({ block: 'center' })`);
    await shot('1-nothing-picked');
    await click(page, '.tile:nth-child(1) .opt');
    await waitFor(page, 'the viewer', viewerOpen);
    await shot('3-viewer');
    const bar = await page.eval<Record<string, any>>(`(() => {
      const bar = document.querySelector('.viewer-bar'), r = bar.getBoundingClientRect();
      const kids = [...bar.querySelectorAll('.gallery-controls > *, .close-view')].map((el) => el.getBoundingClientRect());
      const pick = document.querySelector('.gallery-controls .pick'), ps = getComputedStyle(pick);
      const heights = [...bar.querySelectorAll('.gallery-controls .step, .gallery-controls .pick, a.button')].filter((el) => el.offsetParent).map((el) => el.getBoundingClientRect().height);
      const tile = document.querySelector('dialog.viewer .qcard .tile'), t = tile.getBoundingClientRect();
      return { inside: kids.every((k) => k.left >= r.left && k.right <= r.right + 0.5), padTop: ps.paddingTop, padBottom: ps.paddingBottom, heights,
        pickH: pick.getBoundingClientRect().height, wide: document.documentElement.scrollWidth > innerWidth, tileShown: tile.contains(document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2)) };
    })()`);
    assert.ok(bar.inside, `the bar's controls fit inside it: ${JSON.stringify(bar)}`);
    assert.equal(bar.padTop, bar.padBottom, 'Pick this has equal room above and below');
    if (size.width <= 800) assert.ok(bar.pickH >= 32, `Pick this is a phone tap target: ${bar.pickH}`);
    assert.equal(bar.wide, false);
    assert.ok(bar.heights.every((x: number) => Math.abs(x - bar.heights[0]) < 0.5), `the bar's buttons are one height: ${bar.heights}`);
    // A phone's chat under the picture is mostly its message box: the bar's ✓ Picked says it there.
    if (size.width > 800) assert.ok(bar.tileShown, 'the chat beside the picture keeps the card in sight');
    await click(page, '.gallery-controls .pick');
    await closeViewer(page);
    await page.eval(`document.querySelector('.qcard').scrollIntoView({ block: 'center' })`);
    await shot('2-picked');
    assert.deepEqual(await page.eval(picked), ['Garden']);
    assert.equal(await page.eval(`${sendBtn}.disabled`), false, 'Send is ready');
    assert.equal(await page.eval('sent.length'), 0);
  });
}
