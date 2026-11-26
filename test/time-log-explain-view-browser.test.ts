// Explain on the time log (public/time-log-ui.js) keeps its reply when the page goes away mid-request (#2125): the
// reply is a paid Haiku call. The real module in headless Chromium (test/browser.ts), fetch answered in the page.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';
import { pageStub } from './page-stub.ts';

const bin = chromium();
const skip = !bin && skipMessage;

// The log is read once; every later read hangs, so only the reply Explain stored can draw the reading. The press waits
// for window.answer().
const STUB = pageStub(`
  const log = (presses) => ({ start: now - 60000, end: now, running: false, closed: false, segs: [{ kind: 'work', start: now - 60000, end: now, row: 0 }],
    rows: [{ type: 'line', title: 'A step', kind: 'work', start: now - 60000, end: now, work: 60000, wait: 0, lost: 0 }],
    totals: { work: 60000, wait: 0, lost: 0, guess: 0 }, explain: { parts: {}, presses, fresh: [], writing: null } });
  window.ready = true;
  let reads = 0;
  window.answer = null;
  function route(path) {
    if (path === 'api/tickets/7/time-log') return reads++ ? new Promise(() => {}) : reply(200, log([]));
    if (path === 'api/tickets/7/time-log/explain')
      return new Promise((done) => (window.answer = () => {
        const res = reply(200, log([{ by: 'Josh', at: now, cost: null, parts: 1 }]));
        const json = res.json.bind(res);
        // A task after the body is read, everything that waited on it has run: window.handled says so.
        res.json = () => json().finally(() => setTimeout(() => (window.handled = true)));
        done(res);
      }));
  }
`);

let app: App;
let browser: Browser;

before(async () => {
  if (skip) return;
  app = await serveApp({
    stub: STUB,
    extra: (url, res) => url.pathname === '/blank' && !!res.writeHead(200, { 'content-type': 'text/html' }).end(`<head>${STUB}</head><body></body>`),
  });
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await app?.close();
});

test('Explain keeps its reply when no view is open by the time it answers', { skip }, async () => {
  const page = await browser.page(`${app.base}blank`, { width: 1280, height: 800 });
  await page.eval(`(async () => {
    const { setView } = await import('/base.js');
    const { timeLogPanel, drawTimeLog } = await import('/time-log-ui.js');
    const view = { ticket: { id: 7, status: 'idle' }, progress: { tasks: [] }, ui: {} };
    window.show = () => (setView(view), document.body.append(timeLogPanel()), drawTimeLog());
    window.leave = () => (setView(null), document.body.replaceChildren());
    show();
  })()`);
  await waitFor(page, 'the Explain button', `document.querySelector('.tl-explain-btn')`);
  await page.eval(`document.querySelector('.tl-explain-btn').click()`);
  await waitFor(page, 'the press to be asked', `window.answer`);
  // The route fails mid-request (core.js sets no view), then the reply arrives.
  await page.eval(`leave(); answer()`);
  await waitFor(page, 'the reply to be handled', `window.handled`);
  await page.eval(`show()`);
  const text = await page.eval<string>(`document.querySelector('.time-log').textContent`);
  assert.doesNotMatch(text, /Explain didn't work|no view is open/);
  assert.match(text, /Haiku's reading · Josh/);
});
