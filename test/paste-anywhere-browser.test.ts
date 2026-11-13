// Paste anywhere in a chat, and a draft image shown large (#654, Josh 2026-11-13: "if you Ctrl-V while on a chat
// view, it should paste into the message even if you arent currently focused on the chat box, and once you upload an
// image you should be able to click on it to see it larger"), in a real browser (headless Chromium, test/browser.ts)
// against the real server. A paste is a ClipboardEvent sent where the browser sends one: the focused element, or
// the page's body when nothing is focused.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootServer, until, type Booted } from './helpers.ts';
import { chromium, launch, waitFor, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
const shots = process.env.PASTE_SHOTS; // a folder: write desktop and phone screenshots there

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

/** Paste `text` and/or a small PNG where the browser would; whether the page took the paste (preventDefault). */
const paste = (page: Page, { text = '', image = false }) => page.eval<boolean>(`(async () => {
  const dt = new DataTransfer();
  if (${JSON.stringify(text)}) dt.setData('text/plain', ${JSON.stringify(text)});
  if (${image}) {
    const c = Object.assign(document.createElement('canvas'), { width: 600, height: 400 });
    const g = c.getContext('2d');
    g.fillStyle = '#6a4cff'; g.fillRect(0, 0, 600, 400); g.fillStyle = '#fff'; g.fillRect(200, 120, 200, 160);
    dt.items.add(new File([await new Promise((r) => c.toBlob(r, 'image/png'))], 'shot.png', { type: 'image/png' }));
  }
  const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e.defaultPrevented;
})()`);
const box = `document.querySelector('.composer textarea')`;
/** A tap on a phone, a mouse click on a desktop. */
async function press(page: Page, width: number, x: number, y: number) {
  if (width < 800) return page.tap(x, y);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
const click = async (page: Page, width: number, selector: string) => {
  const { x, y } = await page.centre(selector);
  await press(page, width, x, y);
};

async function shoot(page: Page, name: string) {
  if (!shots) return;
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
}

for (const [width, label] of [[1280, 'desktop'], [390, 'phone']] as const) {
  test(`at ${label} width a paste with nothing focused goes in the chat's box, and a draft image opens large`, { skip }, async () => {
    const page = await open(width, `Paste ${label}`);
    // After the box's own autofocus, a frame after it shows (ui/composer.js), so the blur sticks.
    await page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await page.eval(`(() => { const b = ${box}; b.value = 'draft'; b.dispatchEvent(new Event('input')); b.blur(); })()`);
    assert.equal(await page.eval('document.activeElement === document.body'), true, 'nothing focused');

    // Text goes in at the end of the draft, and the box takes the focus.
    assert.equal(await paste(page, { text: ' and more' }), true);
    assert.equal(await page.eval(`${box}.value`), 'draft and more');
    assert.equal(await page.eval(`document.activeElement === ${box}`), true);

    // An image attaches, keeping the text.
    await page.eval(`${box}.blur()`);
    assert.equal(await paste(page, { image: true }), true);
    await waitFor(page, 'the thumbnail', '!!document.querySelector(".attachments .thumb img")');
    assert.equal(await page.eval(`${box}.value`), 'draft and more');
    await shoot(page, `${label}-pasted.png`);

    // Clicking (tapping) the thumbnail shows it full size; a click off the picture closes it.
    await click(page, width, '.attachments .thumb .zoom');
    await waitFor(page, 'the viewer', '!!document.querySelector("dialog.image-zoom[open]")');
    assert.equal(await page.eval(`document.querySelector('dialog.image-zoom img').src === document.querySelector('.attachments .thumb img').src`), true);
    assert.ok(await page.eval<number>(`document.querySelector('dialog.image-zoom img').getBoundingClientRect().width`) > 300, 'larger than the thumbnail');
    await shoot(page, `${label}-zoom.png`);
    await press(page, width, 10, 790);
    await waitFor(page, 'the viewer to close on a click outside', '!document.querySelector("dialog.image-zoom")');
    // Esc closes it too.
    await click(page, width, '.attachments .thumb .zoom');
    await waitFor(page, 'the viewer again', '!!document.querySelector("dialog.image-zoom[open]")');
    await page.key('Escape');
    await waitFor(page, 'the viewer to close on Esc', '!document.querySelector("dialog.image-zoom")');

    // ✕ removes the image and opens nothing.
    await click(page, width, '.attachments .thumb .remove');
    await waitFor(page, 'the image removed', '!document.querySelector(".attachments .thumb")');
    assert.equal(await page.eval('!!document.querySelector("dialog.image-zoom")'), false);
    assert.equal(await page.eval(`${box}.value`), 'draft and more');
  });
}

test('a paste into Find in chat stays there; a paste in an open dialog without the chat stays out of the box', { skip }, async () => {
  const page = await open(1280, 'Paste find');
  await page.eval(`document.querySelector('.chat-find').focus()`);
  assert.equal(await paste(page, { text: 'needle' }), false, 'left to the find box');
  assert.equal(await paste(page, { image: true }), false);
  assert.equal(await page.eval(`${box}.value`), '');
  assert.equal(await page.eval('!!document.querySelector(".attachments .thumb")'), false);
  assert.equal(await page.eval(`document.activeElement === document.querySelector('.chat-find')`), true);

  await page.eval(`(() => { const d = document.createElement('dialog'); d.innerHTML = '<p>other</p>'; document.body.append(d); d.showModal(); document.activeElement?.blur(); })()`);
  assert.equal(await paste(page, { text: 'nope' }), false);
  assert.equal(await page.eval(`${box}.value`), '');
});
