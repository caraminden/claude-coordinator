// A release target's row opens the Releases page scrolled to that target's own card (#1647; Cara, 2026-11-22: "When you click on a
// release pipeline, it should scroll to that point on the releases page, not just open the top"). A click on the row you are on
// again changes no address, so it does nothing: accepted.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, launch, waitFor, serveApp, skipMessage, type Browser, type App, type Page } from './browser.ts';
import { holds } from './holds.ts';

const bin = chromium();
const skip = !bin && skipMessage;

// Scheme 1 (Alpha) has three tall targets, so the middle one sits far below the fold; scheme 2 (Beta) has one.
const STUB = `<script>
  window.ready = true;
  const now = Date.now();
  const stages = [{ name: 'test', usual: 60000 }, { name: 'deploy', usual: 60000 }, { name: 'live', usual: 0 }];
  const changes = (from, label) => Array.from({ length: 14 }, (_, i) => ({ ticketId: from + i, number: from + i, title: label + ' change ' + i, stage: 'test', since: now - 60000, text: 'testing' }));
  const next = (number, list) => ({ number, stage: 'test', since: now - 600000, eta: now - 1000, stages, changes: list });
  const target = (id, name, n) => ({ target: { id, name }, testCopies: [], line: [], recent: [], next: n });
  window.relA = { projectId: 1, testCopies: [], targets: [target('server', 'Server', next(688, changes(500, 'Server'))), target('apk:app', 'Desktop app', next(6, [])), target('apk:more', 'Android', next(3, changes(600, 'Android')))] };
  window.relB = { projectId: 2, testCopies: [], targets: [target('server', 'Server', next(9, changes(700, 'Beta'))), target('file:windows', 'Windows', next(2, changes(900, 'Win')))] };
  window.bump = () => { relA.targets[0].next.eta += 1000; relA.targets[1].next.changes = changes(800, 'New'); es.onmessage({ data: JSON.stringify({ type: 'releases', projectId: 1, releases: relA }) }); };
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const proj = (id, name) => ({ project: { id, name, instructions: '' }, coordinator: { id: 100 + id, project_id: id, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: now, created_at: now }, tickets: [], dismissed: 0, seen: {}, person_notes: {}, pins: [] });
  window.fetch = async (input) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply({ name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply([{ id: 1, name: 'Alpha', inbox: 0, icon: null }, { id: 2, name: 'Beta', inbox: 0, icon: null }]);
    if (/^api\\/projects\\/\\d$/.test(path)) return reply(proj(Number(path.slice(-1)), path.endsWith('1') ? 'Alpha' : 'Beta'));
    if (/^api\\/projects\\/\\d\\/properties$/.test(path)) return reply({ keys: [], types: [], values: {}, views: [] });
    if (/\\/events$/.test(path)) return reply({ events: [], tasks: [], more: false });
    if (/inbox$/.test(path)) return reply({ items: [] });
    if (path === 'api/ci') return reply({ schemes: [], pcs: [] });
    if (path === 'api/releases') return reply({ schemes: [relA, relB] });
    return reply([]);
  };
  window.EventSource = class { constructor() { window.es = this; setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'hello', usage: {}, version: 'v1' }) }), 100); } close() {} };
</script>`;

let app: App;
let browser: Browser;
before(async () => {
  if (skip) return;
  app = await serveApp({ stub: STUB });
  browser = await launch(bin!);
});
after(async () => {
  await browser?.close();
  await app?.close();
});

const card = (scheme: number, id: string) => `document.querySelector('[data-target="${scheme}/${id}"]')`;
const top = (scheme: number, id: string) => `${card(scheme, id)}?.getBoundingClientRect().top`;
const atTop = (scheme: number, id: string) => `(() => { const t = ${top(scheme, id)}; return t != null && t >= 0 && t < 200; })()`;

async function click(page: Page, selector: string) {
  const { x, y } = await page.centre(selector);
  await page.mouse(x, y);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
const row = (scheme: number, name: string) => `.rel-rows[data-rel-scheme="${scheme}"] .rel-row:has(.rel-name[href$="${name}"]) .rel-name`;
const open = async (hash: string) => {
  const page = await browser.page(`${app.base}${hash}`, { width: 1280, height: 500 });
  await waitFor(page, 'the rail rows', `document.querySelectorAll('.rel-row').length === 5`);
  return page;
};

test("a target row in the rail opens the page with that target's card at the top, and a live update leaves it there", { skip }, async () => {
  const page = await open('#/p/1');
  await click(page, row(1, 'apk%3Aapp'));
  await waitFor(page, 'the card at the top', atTop(1, 'apk:app'));
  assert.match(await page.eval<string>('location.hash'), /^#\/p\/1\/releases\/1\/target\/apk%3Aapp$/);
  // A live update redraws the cards and leaves the page where the person has it.
  await page.eval('scrollBy(0, 40)');
  const y = await page.eval<number>('scrollY');
  await page.eval('bump()');
  await holds('the page stays put', async () => (await page.eval<number>('scrollY')) === y, { after: () => page.eval(`!!document.querySelector('.rel-body').textContent.includes('New change 0')`) });
});

test('on the page, one target row and then another each bring their card to the top', { skip }, async () => {
  const page = await open('#/p/1');
  await click(page, row(1, 'server'));
  await waitFor(page, 'Server at the top', atTop(1, 'server') + ` && /target\\/server$/.test(location.hash)`);
  await click(page, row(1, 'apk%3Amore'));
  await waitFor(page, 'Android at the top', atTop(1, 'apk:more'));
  await click(page, row(1, 'apk%3Aapp'));
  await waitFor(page, 'Desktop app at the top', atTop(1, 'apk:app'));
});

test("another scheme's target row opens that scheme's page at the target's card", { skip }, async () => {
  const page = await open('#/p/1');
  await click(page, row(2, 'file%3Awindows'));
  await waitFor(page, "Beta's Windows card at the top", atTop(2, 'file:windows'));
  assert.match(await page.eval<string>('location.hash'), /^#\/p\/1\/releases\/2\/target\/file%3Awindows$/);
});

test("a change's link opens the page with its card in view", { skip }, async () => {
  const page = await open('#/p/1');
  await page.eval(`location.hash = '#/p/1/releases/1/610'`); // a change in Android's card, far below the fold
  await waitFor(page, 'the change in view', `(() => { const r = document.querySelector('.rel-change.hl')?.getBoundingClientRect(); return !!r && r.top >= 0 && r.bottom <= innerHeight + 1; })()`);
});

test('a plain Releases link, and an unknown target, open at the top', { skip }, async () => {
  for (const hash of ['#/p/1/releases/1', '#/p/1/releases/1/target/nope']) {
    const page = await browser.page(`${app.base}${hash}`, { width: 1280, height: 500 });
    await waitFor(page, 'the cards', `document.querySelectorAll('.rel-card').length >= 3`);
    await holds(`${hash} stays at the top`, async () => (await page.eval<number>('scrollY')) === 0, { after: () => page.eval(`!!document.querySelector('.rel-card h3')`) });
  }
});
