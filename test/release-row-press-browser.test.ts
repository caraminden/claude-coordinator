// A click on a release row in the rail opens the Releases page even when the release redraws between the press and the
// release (#1548; Cara, 2026-11-21: "Sometimes I feel like I have to click on this twice to load the releases page?").
// A `releases` event swaps every rail row for a new one, so the release fell on the new row and no click reached the old.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, launch, waitFor, serveApp, skipMessage, type Browser, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = `<script>
  window.ready = true;
  const now = Date.now();
  window.rel = { projectId: 1, testCopies: [], targets: [{ target: { id: 'server', name: 'Server' }, line: [], recent: [], next: { number: 688, stage: 'test', since: now - 600000, eta: now - 1000, stages: [{ name: 'test', usual: 60000 }, { name: 'deploy', usual: 60000 }, { name: 'live', usual: 0 }], changes: [] } }] };
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply({ name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply([{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply({ project: { id: 1, name: 'Alpha', instructions: '' }, coordinator: { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: now, created_at: now }, tickets: [], dismissed: 0, seen: {}, person_notes: {}, pins: [] });
    if (/\\/events$/.test(path)) return reply({ events: [], tasks: [], more: false });
    if (/inbox$/.test(path)) return reply({ items: [] });
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

test('a release row in the rail opens the Releases page when the release redraws during the click', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the rail row', `!!document.querySelector('.rel-row')`);
  const { x, y } = await page.centre('.rel-row .rel-ver');
  const at = { x, y, button: 'left', clickCount: 1 };
  await page.mouse(x, y);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
  await page.eval(`es.onmessage({ data: JSON.stringify({ type: 'releases', projectId: 1, releases: rel }) })`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
  await waitFor(page, 'the page to open', `/releases/.test(location.hash)`);
  assert.match(await page.eval<string>('location.hash'), /^#\/p\/1\/releases/);
});
