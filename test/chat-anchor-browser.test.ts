// A reply that arrives while you're at the bottom of a chat scrolls so its first line sits under the thread bar,
// and holds there as it grows; a short one shows in full; scrolled up, nothing moves (#1745). Citadel's real
// front end in headless Chromium (test/browser.ts), with fetch and the stream answered in the page.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

// Runs before app.js: a fake server with one running minion. Its turn so far: a line, work, a line, work,
// a Taskmaster message steered in, a line, work, and the newest line. push(n) sends line n live.
const STUB = `<script>
  window.ready = true;
  const now = Date.now();
  const started = now - 600_000;
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  const minion = { id: 101, project_id: 1, kind: 'ticket', number: 7, title: 'A minion', status: 'running', turnStartedAt: started, updated_at: 0, created_at: started };
  let id = 0;
  const ev = (kind, data) => ({ id: ++id, ticket_id: 101, kind, data: JSON.stringify(data), created_at: started + id * 1000 });
  const line = (text) => ev('claude', { type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use', id: 'tu' + id, name: 'Bash', input: { command: 'true' } }] } });
  const events = [ev('user_message', { author: 'Cara', text: 'Start.' }), ev('claude', { type: 'system', subtype: 'init', model: 'opus' })];
  for (let i = 0; i < 30; i++) events.push(ev('user_message', { author: 'Cara', text: 'History line ' + i + ' ' + 'filler '.repeat(60) }));
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply(200, { name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets: [minion], seen: {}, person_notes: {}, pins: [] });
    if (path === 'api/projects/1/recap') return reply(200, { since: null, turns: {} });
    let m;
    if ((m = path.match(/^api\\/tickets\\/(\\d+)$/))) return reply(200, { ticket: m[1] === '100' ? coordinator : minion });
    if ((m = path.match(/^api\\/tickets\\/(\\d+)\\/events$/))) {
      if (url.search.includes('after=')) return reply(200, []);
      return reply(200, { events: m[1] === '101' ? events : [], tasks: [], more: false });
    }
    if (/inbox$/.test(path)) return reply(200, { items: [] });
    return reply(200, []);
  };
  let stream;
  window.EventSource = class { constructor() { stream = this; setTimeout(() => this.onopen?.()); } close() {} };
  window.push = (text) => stream.onmessage({ data: JSON.stringify({ type: 'event', event: line(text) }) });
  window.pushTool = () => stream.onmessage({ data: JSON.stringify({ type: 'event', event: ev('claude', { type: 'user', message: { content: [] } }) }) });
</script>`;

let app: App;
let browser: Browser;
let base = '';

before(async () => {
  if (skip) return;
  app = await serveApp({ stub: STUB });
  base = app.base;
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await app?.close();
});

const LONG = Array.from({ length: 60 }, (_, i) => `Reply sentence ${i}.`).join('\n\n');
// How far the newest reply's top sits below the thread bar's bottom edge.
const OFFSET = `(() => { const rs = [...document.querySelectorAll('#log .msg.reply')]; const r = rs[rs.length - 1].getBoundingClientRect(); return Math.round(r.top - document.getElementById('ticket-head').getBoundingClientRect().bottom); })()`;
// A real wheel ends the open-time holds, as a person's first scroll would.
const wheel = (page: any) => page.eval(`dispatchEvent(new Event('wheel'))`);
// SHOT_DIR=<dir> also saves screenshots, for the before/after in a PR.
const shot = async (page: any, name: string) => {
  if (!process.env.SHOT_DIR) return;
  await page.eval(`document.getElementById('splash')?.remove()`);
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(process.env.SHOT_DIR, `${name}.png`), Buffer.from(r.data, 'base64'));
};
const frame = (page: any) => page.eval(`new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)))`);

for (const [name, size] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 780 }]] as const) {
  test(`${name}: a long reply at the bottom lands with its first line under the thread bar; a short one shows in full`, { skip }, async () => {
    const page = await browser.page(`${base}#/p/1/t/7`, size);
    await waitFor(page, 'the chat to draw', `document.getElementById('log').textContent.includes('History line 29')`);
    await wheel(page);
    await wheel(page);
  await page.eval(`scrollTo(0, document.documentElement.scrollHeight)`);
    await frame(page);
    await page.eval(`push(${JSON.stringify('LONGREPLY\n\n' + LONG)})`);
    await frame(page);
    await shot(page, `${process.env.SHOT_TAG}-${name}-bottom-long`);
    const off = await page.eval<number>(OFFSET);
    assert.ok(off >= 0 && off <= 16, `reply top ${off}px under the thread bar`);
    // It grows (a card or more text arrives): the top holds.
    await page.eval(`pushTool(); push(${JSON.stringify('NEXTREPLY\n\n' + LONG)})`);
    await frame(page);
    const rs = await page.eval<number>(`document.querySelectorAll('#log .msg.reply').length`);
    assert.ok(rs > 1);
    // Each newer reply takes over the hold (the long one scrolls away), so what holds now is the newest (long) reply's top.
    const held = await page.eval<number>(OFFSET);
    assert.ok(held >= 0 && held <= 16, `after it grew, the newest reply's top is ${held}px under the thread bar`);
  });

  test(`${name}: scrolled up, a new reply moves nothing`, { skip }, async () => {
    const page = await browser.page(`${base}#/p/1/t/7`, size);
    await waitFor(page, 'the chat to draw', `document.getElementById('log').textContent.includes('History line 29')`);
    await wheel(page);
    await page.eval(`scrollTo(0, 300)`);
    await frame(page);
    const before = await page.eval<number>(`scrollY`);
    await page.eval(`push(${JSON.stringify('Late reply\n\n' + LONG)})`);
    await frame(page);
    await shot(page, `${process.env.SHOT_TAG}-${name}-scrolled-up`);
    assert.equal(await page.eval<number>(`scrollY`), before);
    // More of the turn streams in (tool results, another line): still nothing moves.
    await page.eval(`pushTool(); push('Another line'); pushTool()`);
    await frame(page);
    assert.equal(await page.eval<number>(`scrollY`), before);
  });
}

test('a short reply at the bottom shows in full', { skip }, async () => {
  const page = await browser.page(`${base}#/p/1/t/7`, { width: 1280, height: 800 });
  await waitFor(page, 'the chat to draw', `document.getElementById('log').textContent.includes('History line 29')`);
  await wheel(page);
  await page.eval(`scrollTo(0, document.documentElement.scrollHeight)`);
  await frame(page);
  await page.eval(`push('SHORTREPLY')`);
  await frame(page);
  assert.ok(await page.eval<boolean>(`(() => { const rs = [...document.querySelectorAll('#log .msg.reply')]; const r = rs[rs.length - 1].getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; })()`));
});
