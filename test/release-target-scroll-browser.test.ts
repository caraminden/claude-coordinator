// A release target's row opens the Releases page scrolled to that target's own card (#1647; Cara, 2026-11-22: "When you click on a
// release pipeline, it should scroll to that point on the releases page, not just open the top").
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, launch, waitFor, serveApp, skipMessage, type Browser, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = `<script>
  window.ready = true;
  const now = Date.now();
  const stages = [{ name: 'test', usual: 60000 }, { name: 'deploy', usual: 60000 }, { name: 'live', usual: 0 }];
  const changes = Array.from({ length: 14 }, (_, i) => ({ ticketId: 500 + i, number: 500 + i, title: 'Server change ' + i, stage: 'test', since: now - 60000, text: 'testing' }));
  window.rel = { projectId: 1, testCopies: [], targets: [
    { target: { id: 'server', name: 'Server' }, testCopies: [], line: [], recent: [], next: { number: 688, stage: 'test', since: now - 600000, eta: now - 1000, stages, changes } },
    { target: { id: 'apk:app', name: 'Desktop app' }, testCopies: [], line: [], recent: [], next: { number: 6, stage: 'test', since: now - 600000, eta: now - 1000, stages, changes: [] } },
    { target: { id: 'apk:more', name: 'Android' }, testCopies: [], line: [], recent: [], next: { number: 3, stage: 'test', since: now - 600000, eta: now - 1000, stages, changes } },
  ] };
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply({ name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply([{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply({ project: { id: 1, name: 'Alpha', instructions: '' }, coordinator: { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: now, created_at: now }, tickets: [], dismissed: 0, seen: {}, person_notes: {}, pins: [] });
    if (/\\/events$/.test(path)) return reply({ events: [], tasks: [], more: false });
    if (/inbox$/.test(path)) return reply({ items: [] });
    if (/^api\\/projects\\/1\\/properties$/.test(path)) return reply({ keys: [], types: [], values: {}, views: [] });
    if (path === 'api/ci') return reply({ schemes: [], pcs: [] });
    if (path === 'api/releases') return reply({ schemes: [rel] });
    return reply([]);
  };
  window.EventSource = class { constructor() { window.es = this; setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'hello', usage: {}, version: 'v1' }) }), 100); } close() {} };
</script>`;

let app: App;
let browser: Browser;
before(async () => { if (skip) return; app = await serveApp({ stub: STUB }); browser = await launch(bin!); });
after(async () => { await browser?.close(); await app?.close(); });

const cardTop = (title: string) => `[...document.querySelectorAll('.rel-card')].find((c) => c.querySelector('h3')?.textContent.includes('${title}'))?.getBoundingClientRect().top`;

test('a target row in the rail opens the page with that target\'s card at the top', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1`, { width: 1280, height: 500 });
  await waitFor(page, 'the rail rows', `document.querySelectorAll('.rel-row').length === 3`);
  const { x, y } = await page.centre('.rel-row:nth-child(2) .rel-name');
  await page.mouse(x, y);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await waitFor(page, 'the page', `/releases/.test(location.hash) && ${cardTop('Desktop app')} != null`);
  assert.match(await page.eval<string>('location.hash'), /releases\/1\/target\/apk%3Aapp$/);
  await new Promise((r) => setTimeout(r, 400)); // timing-ok: shows a scroll that must NOT move
  const top = await page.eval<number>(cardTop('Desktop app'));
  assert.ok(top >= 0 && top < 200, `Desktop app card top is ${top}`);
  // A live update doesn't pull the page again.
  await page.eval(`window.scrollBy(0, 40)`);
  const y0 = await page.eval<number>('scrollY');
  await page.eval(`es.onmessage({ data: JSON.stringify({ type: 'releases', projectId: 1, releases: rel }) })`);
  await new Promise((r) => setTimeout(r, 300)); // timing-ok: shows a scroll that must NOT move
  assert.equal(await page.eval<number>('scrollY'), y0);
});

test('a plain Releases link opens at the top; an unknown target too', { skip }, async () => {
  for (const hash of ['#/p/1/releases/1', '#/p/1/releases/1/target/nope']) {
    const page = await browser.page(`${app.base}${hash}`, { width: 1280, height: 500 });
    await waitFor(page, 'the cards', `document.querySelectorAll('.rel-card').length >= 2`);
    await new Promise((r) => setTimeout(r, 300)); // timing-ok: shows a scroll that must NOT move
    assert.equal(await page.eval<number>('scrollY'), 0, hash);
  }
});
