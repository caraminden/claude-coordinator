// A mock page's Send in Citadel's own viewer, on the real server with the real bridge and mock kit (#1940): the viewer
// closes on the chat only once the page has stored that it sent, so the page opened again shows Sent and posts nothing more.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { bootServer, REPO, tempRoot, until, type Booted } from './helpers.ts';
import { chromium, launch, skipMessage, waitFor, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const tmp = tempRoot('page-send-');
const data = join(tmp.dir, 'data');
mkdirSync(data, { recursive: true });
const store = new Store(join(data, 'coordinator.db'));
const scheme = store.createProject('Sends', null);
const work = join(tmp.dir, 'work');
mkdirSync(work);
const minion = store.createTicket({ project_id: scheme.id, kind: 'ticket', title: 'Mocks', permission_mode: 'default', created_by: 'Cara' });
store.setTicketDir(minion.id, work, null);
for (const f of ['mockkit.js', 'mockkit.css']) cpSync(join(REPO, 'kit/skills/docs-and-mocks/starter', f), join(work, f));
writeFileSync(
  join(work, 'takes.html'),
  `<!doctype html><meta charset="utf-8"><title>Takes</title><link rel="stylesheet" href="mockkit.css"><script src="mockkit.js"></script>
<body class="mk"><main class="mk-page"><section data-pick="a" data-title="Take A"><h2>Take A</h2></section></main><script>mock.picks()</script>`,
);

let srv: Booted;
let browser: Browser;
before(async () => {
  if (skip) return;
  srv = await bootServer({ root: tmp.dir });
  // The page frame in the viewer's own process, so a test can look inside it.
  browser = await launch(bin!, ['--disable-features=IsolateSandboxedIframes']);
});
after(async () => {
  await browser?.close();
  await srv?.stop();
  await tmp.teardown();
});

const FRAME = `document.querySelector('dialog.viewer iframe')`;
const sends = () => store.listEvents(minion.id).filter((e) => e.kind === 'user_message').length;

/** What the framed page shows, read in its own world: its origin is opaque, so the app can't look in. */
async function inFrame<T>(page: Page, expression: string): Promise<T | undefined> {
  const { frameTree } = await page.send('Page.getFrameTree');
  const frame = frameTree.childFrames?.find((f: { frame: { url: string } }) => f.frame.url.includes('takes.html'))?.frame;
  if (!frame) return undefined;
  const { executionContextId } = await page.send('Page.createIsolatedWorld', { frameId: frame.id });
  return (await page.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true })).result.value;
}
async function press(page: Page, sel: string) {
  const at = (await inFrame<{ x: number; y: number }>(page, `(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`))!;
  const box = await page.eval<{ x: number; y: number }>(`(({ x, y }) => ({ x, y }))(${FRAME}.getBoundingClientRect())`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x + at.x, y: box.y + at.y, button: 'left', clickCount: 1 });
}
const button = (page: Page) => inFrame<string>(page, `document.querySelector('.mk-dock > button')?.textContent`);

test('a page sent in the viewer closes it, is Sent when opened again, and posts once', { skip }, async () => {
  const page = await browser.page('data:text/html,<script>window.ready=true</script>', { width: 1280, height: 800 });
  const [name, value] = srv.cookie.split('=');
  await page.send('Network.setCookie', { name, value, url: srv.base });
  await page.send('Page.navigate', { url: `${srv.base}/#/t/${minion.id}` });
  await waitFor(page, 'the chat', `!!document.querySelector('.composer textarea')`);
  const open = () => page.eval(`location.hash = '#/f/${minion.id}/takes.html'`);
  await open();
  await until('the dock', async () => (await button(page)) === 'Send picks');
  await press(page, '[data-v="pick"]');
  await until('the pick', () => inFrame(page, `document.querySelector('.mk-dock-text').textContent.startsWith('1 picked · saved')`));
  const before = sends();
  await press(page, '.mk-dock > button');
  await waitFor(page, 'the viewer to close', `!document.querySelector('dialog.viewer')`);
  assert.equal(sends(), before + 1);
  await open();
  await until('the dock again', () => button(page));
  await until('the pick back', () => inFrame(page, `document.querySelector('.mk-dock-text').textContent.startsWith('1 picked')`));
  assert.equal(await button(page), 'Sent ✓');
  assert.equal(await inFrame(page, `document.querySelector('.mk-dock > button').disabled`), true, 'nothing to press again');
  assert.equal(sends(), before + 1, 'the same picks go once');
});
