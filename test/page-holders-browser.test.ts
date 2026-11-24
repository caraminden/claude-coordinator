// What cards, job cards and the file viewer keep in the page after they leave it (#1760; leak hunt #1756, finding E).
// Question cards kept every card's picture strip for good (cards.js cardPictures), a job card of a finished job stayed in
// jobs.js's `drawn` until that job changed, a closed viewer left its keyboard watch on screen.orientation (artifacts.js)
// and the bridge kept every closed viewer's iframe (bridge-host.js). Run in a real browser against the real server:
// (the app's own module copies, under /c/). Each round draws and drops 20 new cards, job cards and viewers; after a forced collection the detached elements
// and the page's listeners don't grow with the rounds.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bootServer, type Booted } from './helpers.ts';
import { chromium, launch, waitFor, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';

let srv: Booted;
let browser: Browser;
let projectId: number;
let ticketId: number;

before(async () => {
  srv = await bootServer();
  projectId = (await srv.call('/api/projects', { name: 'Holders' })).data.id;
  ticketId = (await srv.call(`/api/projects/${projectId}/tickets`, { message: 'hi' })).data.id;
  if (!skip) browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await srv?.stop();
});

/** Detached elements of a kind and the page's listeners, after a forced collection, counted without DevTools holding any result. */
async function measure(page: Page, protoExpr: string) {
  await page.send('HeapProfiler.enable');
  for (let i = 0; i < 2; i++) await page.send('HeapProfiler.collectGarbage');
  const group = 'leak-measure';
  const proto = await page.send('Runtime.evaluate', { expression: protoExpr, objectGroup: group });
  const all = await page.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId, objectGroup: group });
  const off = await page.send('Runtime.callFunctionOn', { objectId: all.objects.objectId, returnByValue: true, objectGroup: group,
    functionDeclaration: 'function () { return this.filter((t) => { try { return !t.isConnected; } catch { return false; } }).length; }' });
  await page.send('Runtime.releaseObjectGroup', { objectGroup: group });
  const { metrics } = await page.send('Performance.getMetrics');
  return { detached: off.result.value as number, listeners: metrics.find((m: any) => m.name === 'JSEventListeners').value as number };
}

async function open(hash: string): Promise<Page> {
  const page = await browser.page('data:text/html,<script>window.ready=true</script>', { width: 1280, height: 800 });
  const [name, value] = srv.cookie.split('=');
  await page.send('Network.setCookie', { name, value, url: srv.base });
  await page.send('Page.navigate', { url: `${srv.base}/${hash}` });
  await waitFor(page, 'the page', `!!document.querySelector('.composer textarea')`);
  await page.send('Performance.enable');
  return page;
}

const ROUNDS = 4;
const PER_ROUND = 20;

async function rounds(page: Page, proto: string, round: (r: number) => Promise<void>) {
  const seen: { detached: number; listeners: number }[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    await round(r);
    seen.push(await measure(page, proto));
  }
  return seen;
}

// Round 0 builds the page's caches; later rounds must add nothing.
const grew = (seen: { detached: number; listeners: number }[], key: 'detached' | 'listeners') => seen.at(-1)![key] - seen[0][key];

test('question cards seen and left leave nothing behind', { skip }, async () => {
  const page = await open(`#/t/${ticketId}`);
  await waitFor(page, "the chat's ticket", `import('/c/base.js').then((b) => !!b.view?.ticket)`);
  const seen = await rounds(page, 'HTMLElement.prototype', async (r) => {
    await page.eval(`(async () => {
      const { questionCard } = await import('/c/cards.js');
      const { view } = await import('/c/base.js');
      for (let i = 0; i < ${PER_ROUND}; i++) {
        const id = 'q${r}-' + i;
        const el = questionCard(${ticketId}, { id, questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] });
        document.body.append(el);
        await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
        el.remove();
        view.cards.delete(id); // the chat's own list of its cards: a chat keeps it only while it is the one open
      }
    })()`);
  });
  assert.ok(grew(seen, 'detached') <= 10, `detached elements grew by ${grew(seen, 'detached')} over ${ROUNDS - 1} rounds of ${PER_ROUND} cards: ${JSON.stringify(seen)}`);
});

test('job cards seen and left leave nothing behind', { skip }, async () => {
  const page = await open(`#/p/${projectId}`);
  const seen = await rounds(page, 'HTMLElement.prototype', async (r) => {
    await page.eval(`(async () => {
      const { jobCard } = await import('/c/jobs.js');
      for (let i = 0; i < ${PER_ROUND}; i++) {
        const id = ${1000} + ${r} * ${PER_ROUND} + i;
        const el = jobCard(id, { id, state: 'done', kind: { name: 'Build' }, machine: { name: 'box' }, log_tail: '', created_at: Date.now(), ended_at: Date.now() }, 'chat');
        document.body.append(el);
        await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
        el.remove();
      }
    })()`);
  });
  assert.ok(grew(seen, 'detached') <= 10, `detached elements grew by ${grew(seen, 'detached')} over ${ROUNDS - 1} rounds of ${PER_ROUND} job cards: ${JSON.stringify(seen)}`);
});

test('opening and closing the file viewer leaves nothing behind', { skip }, async () => {
  const page = await open(`#/p/${projectId}`);
  const seen = await rounds(page, 'HTMLDialogElement.prototype', async (r) => {
    // Five a round: Chromium drops address changes past about 200 in 10 s, and each open and close makes several.
    for (let i = 0; i < 5; i++) {
      await page.eval(`location.hash = '#/f/${ticketId}/' + encodeURIComponent('f${r}-${i}.txt')`);
      await waitFor(page, 'the viewer', `!!document.querySelector('dialog.viewer[open]')`);
      await page.eval(`location.hash = '#/p/${projectId}'`);
      await waitFor(page, 'the viewer to close', `!document.querySelector('dialog.viewer')`);
    }
  });
  assert.ok(grew(seen, 'detached') <= 1 && grew(seen, 'listeners') <= 10, `viewers left behind: ${JSON.stringify(seen)}`);
  // The phone keyboard watch is on while a viewer is open and off once it closes.
  const turns = async () => {
    const o = await page.send('Runtime.evaluate', { expression: 'screen.orientation', objectGroup: 'turns' });
    const { listeners } = await page.send('DOMDebugger.getEventListeners', { objectId: o.result.objectId });
    await page.send('Runtime.releaseObjectGroup', { objectGroup: 'turns' });
    return listeners.filter((l: any) => l.type === 'change').length;
  };
  await page.eval(`location.hash = '#/f/${ticketId}/' + encodeURIComponent('last.txt')`);
  await waitFor(page, 'the viewer', `!!document.querySelector('dialog.viewer[open]')`);
  assert.equal(await turns(), 1, 'an open viewer watches for the phone turning');
  await page.eval(`location.hash = '#/p/${projectId}'`);
  await waitFor(page, 'the viewer to close', `!document.querySelector('dialog.viewer')`);
  assert.equal(await turns(), 0, 'a closed viewer stops watching');
});

test('closed bridge frames are let go', { skip }, async () => {
  const page = await open(`#/p/${projectId}`);
  const seen = await rounds(page, 'HTMLIFrameElement.prototype', async () => {
    await page.eval(`(async () => {
      const { attachBridge } = await import('/c/bridge-host.js');
      for (let i = 0; i < ${PER_ROUND}; i++) {
        const iframe = document.createElement('iframe');
        document.body.append(iframe);
        attachBridge(iframe, { open: { ticket: ${ticketId}, path: 'a.html' }, name: 'a.html', owner: 'x', api: async () => ({}) });
        iframe.remove();
      }
    })()`);
  });
  assert.ok(grew(seen, 'detached') <= 2, `closed frames kept: ${JSON.stringify(seen)}`);
});
