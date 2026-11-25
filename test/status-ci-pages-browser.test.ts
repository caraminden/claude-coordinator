// Status and Test health keep reading (#1922, from #1835's front-end review), in a real browser on the real public/ files:
// WP1 the Ship lines read starts again when the tab shows again, WP12 Test health's failure line has a Try again that
// reads again, WP14 a timed redraw keeps the keyboard focus and inner scroll. (WP13, the contraptions read, needs a whole
// status payload for an app to reach the service controls: it is checked in a dev copy instead.)
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, serveApp, skipMessage, waitFor, type App, type Browser } from './browser.ts';

const skip = !chromium() && skipMessage;
let app: App;
let browser: Browser;

const PAGE = `<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
  window.calls = { lines: 0 };
  window.fetch = async (path) => {
    if (String(path).includes('ship-lines')) window.calls.lines++;
    return new Response(String(path).includes('ship-lines') ? '{"lines":[]}' : 'null', { headers: { 'content-type': 'application/json' } });
  };
  const { shipLinePanel } = await import('/status.js');
  const { testHealth } = await import('/ci-health.js');
  const { keepView } = await import('/base.js');
  Object.assign(window, { shipLinePanel, testHealth, keepView });
  window.ready = true;
</script>`;

before(async () => {
  if (skip) return;
  app = await serveApp({ stub: '', extra: (url, res) => (url.pathname === '/t.html' ? (res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE), true) : false) });
  browser = await launch(chromium()!);
});
after(async () => {
  await browser?.close();
  await app?.close();
});

test('the Ship lines read starts again when its tab shows again after being off screen', { skip }, async () => {
  const page = await browser.page(`${app.base}t.html`);
  await waitFor(page, 'the modules', 'window.ready === true');
  // The tile is on screen but its page is not (the Releases page showing another tab): the chain ends after one 3 s tick.
  await page.eval(`window.parent1 = document.createElement('div'); window.tile = shipLinePanel(window.parent1); document.getElementById('root').append(window.tile); 0`);
  await waitFor(page, 'the first read', 'window.calls.lines >= 1');
  await new Promise((r) => setTimeout(r, 3600)); // timing-ok: the chain ends silently on its next tick
  const before = await page.eval<number>('window.calls.lines');
  await page.eval(`document.body.append(window.parent1); window.tile.resume(); 0`);
  await waitFor(page, 'a read after showing', `window.calls.lines > ${before}`);
});

test("Test health's failed read has a Try again that reads again", { skip }, async () => {
  const page = await browser.page(`${app.base}t.html`);
  await waitFor(page, 'the modules', 'window.ready === true');
  const tried = await page.eval<number>(`(() => { let n = 0; const [p] = testHealth({ id: 1 }, { error: true }, () => n++); p.querySelector('button').click(); return n; })()`);
  assert.equal(tried, 1);
});

test('a redraw through keepView keeps the keyboard focus and an inner scroll', { skip }, async () => {
  const page = await browser.page(`${app.base}t.html`);
  await waitFor(page, 'the modules', 'window.ready === true');
  const r = await page.eval<{ focus: string; top: number }>(`(() => {
    const root = document.getElementById('root');
    const make = () => { const d = document.createElement('div'); d.innerHTML = '<button id="b">x</button><div id="s" style="height:50px;overflow:auto"><div style="height:500px"></div></div>'; return [...d.children]; };
    root.replaceChildren(...make());
    document.getElementById('b').focus();
    document.getElementById('s').scrollTop = 120;
    keepView(root, () => root.replaceChildren(...make()));
    return { focus: document.activeElement?.id, top: document.getElementById('s').scrollTop };
  })()`);
  assert.deepEqual(r, { focus: 'b', top: 120 });
});
