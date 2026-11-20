// Point at something (#1141, Josh 2026-11-19): the 🎯 beside Attach dims the page, a click or tap on a part puts a
// chip naming it (page, part, window size, theme) and a crop of it in the chat's box, the chip's text goes with the
// message, and Escape backs out. In a real browser (headless Chromium, test/browser.ts) against the real server.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bootServer, until, type Booted } from './helpers.ts';
import { chromium, launch, waitFor, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';

let srv: Booted;
let browser: Browser;
let projectId = 0;

before(async () => {
  srv = await bootServer();
  projectId = (await srv.call('/api/projects', { name: 'P' })).data.id;
  if (!skip) browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await srv?.stop();
});

async function open(width: number, title: string) {
  const t = (await srv.call(`/api/projects/${projectId}/tickets`, { title, message: 'hi' })).data;
  await until('the first turn to end', async () => (await srv.call(`/api/tickets/${t.id}`)).data.ticket.status !== 'running');
  const page = await browser.page('data:text/html,<script>window.ready=true</script>', { width, height: 800, touch: width < 800 });
  const [name, value] = srv.cookie.split('=');
  await page.send('Network.setCookie', { name, value, url: srv.base });
  await page.send('Page.navigate', { url: `${srv.base}/#/p/${projectId}/t/${t.number}` });
  await waitFor(page, 'the chat', '!!document.querySelector(".composer textarea") && !!document.querySelector("#log .msg.user")');
  return page;
}

/** A tap on a phone, a mouse click on a desktop. */
async function click(page: Page, width: number, selector: string) {
  const { x, y } = await page.centre(selector);
  if (width < 800) return page.tap(x, y);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
}

const dimmed = '!!document.querySelector(".pick-dim")';

for (const [width, label] of [[1280, 'desktop'], [390, 'phone']] as const) {
  test(`at ${label} width a pick names the part, crops it, and goes with the message`, { skip }, async () => {
    const page = await open(width, `Point ${label}`);
    // Escape backs out, and nothing lands in the box.
    await click(page, width, '[data-part=point-at]');
    await waitFor(page, 'pick mode', dimmed);
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(page, 'pick mode to end', `!${dimmed}`);
    assert.equal(await page.eval('!!document.querySelector(".point-chip")'), false, 'Escape adds no chip');

    await click(page, width, '[data-part=point-at]');
    await waitFor(page, 'pick mode', dimmed);
    // The press lands on the dim, so the Attach button under it doesn't open the file picker.
    await click(page, width, '[data-part=attach]');
    await waitFor(page, 'the chip and the crop', '!!document.querySelector(".point-chip") && !!document.querySelector(".attachments img")');
    const note = await page.eval<string>('document.querySelector(".point-chip").title');
    assert.match(note, /Pointed at: button "Attach images or files" \(part attach\)/);
    assert.match(note, new RegExp(`window ${width}×800 · (light|dark) theme`));
    assert.match(note, /'s chat \(#\/p\/\d+\/t\/\d+\)/);
    // The dim stays a moment after a tap, to take the click that follows it, then goes.
    await waitFor(page, 'the dim to go', `!${dimmed}`);

    await page.eval(`(() => { const b = document.querySelector('.composer textarea'); b.value = 'is this it?'; b.dispatchEvent(new Event('input')); })()`);
    await click(page, width, '.send-group > button');
    await waitFor(page, 'the message with the note', `[...document.querySelectorAll('#log .msg.user')].some((m) => /is this it\\?[\\s\\S]*Pointed at: button/.test(m.innerText))`);
    assert.equal(await page.eval('!!document.querySelector(".point-chip")'), false, 'the chip went with the message');
  });
}

test('Alt+Shift+P starts pick mode on a desktop', { skip }, async () => {
  const page = await open(1280, 'Point shortcut');
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'P', code: 'KeyP', modifiers: 9, windowsVirtualKeyCode: 80 });
  await waitFor(page, 'pick mode', dimmed);
});
