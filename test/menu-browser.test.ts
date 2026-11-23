// Citadel's right-click menu (#1663; Cara picked take B on #1661, 2026-11-22): right-click a thing for a menu headed
// by what it is, "Point at this" and "Point and draw…" first, with no dim step. Text boxes and Shift+right-click keep
// the browser's own menu; Shift+F10 opens it from the keyboard and Escape puts focus back; on a mouse device the
// composer's 🎯 goes and a one-time tip says to right-click. In headless Chromium (test/browser.ts), real server.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bootServer, until, type Booted } from './helpers.ts';
import { chromium, launch, waitFor, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';

let srv: Booted;
let browser: Browser;
// Headless Chromium has no hover and no fine pointer; this one reports a mouse: (hover: hover) and (pointer: fine).
let mouseBrowser: Browser;
let projectId = 0;

before(async () => {
  srv = await bootServer();
  projectId = (await srv.call('/api/projects', { name: 'P' })).data.id;
  if (!skip) {
    browser = await launch(bin!);
    mouseBrowser = await launch(bin!, ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2']);
  }
});

after(async () => {
  await browser?.close();
  await mouseBrowser?.close();
  await srv?.stop();
});

async function open(title: string, { mouse = false, phone = false } = {}) {
  const t = (await srv.call(`/api/projects/${projectId}/tickets`, { title, message: 'hi' })).data;
  await until('the first turn to end', async () => (await srv.call(`/api/tickets/${t.id}`)).data.ticket.status !== 'running');
  const page = await (mouse ? mouseBrowser : browser).page('data:text/html,<script>window.ready=true</script>', phone ? { width: 390, height: 800, touch: true } : { width: 1280, height: 800 });
  const [name, value] = srv.cookie.split('=');
  await page.send('Network.setCookie', { name, value, url: srv.base });
  await page.send('Page.navigate', { url: `${srv.base}/#/p/${projectId}/t/${t.number}` });
  await waitFor(page, 'the chat', '!!document.querySelector(".composer textarea") && !!document.querySelector("#log .msg.user")');
  return page;
}

async function rightClick(page: Page, selector: string, { shift = false } = {}) {
  const { x, y } = await page.centre(selector);
  const modifiers = shift ? 8 : 0;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1, modifiers });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1, modifiers });
}

const hold = (ms: number) => new Promise((r) => setTimeout(r, ms)); // timing-ok: the press length is what these tests are about
const menuOpen = '!!document.querySelector(".cui-menu")';
const items = '[...document.querySelectorAll(".cui-menu .cui-menu-item")].map((b) => b.textContent)';
const esc = (page: Page) => page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

test('right-clicking a message opens its menu, Point pair first; Point at this needs no dim step', { skip }, async () => {
  const page = await open('Menu message');
  await rightClick(page, '#log .msg.user');
  await waitFor(page, 'the menu', menuOpen);
  assert.equal(await page.eval('document.querySelector(".cui-menu .cui-menu-kind").textContent'), 'Message');
  const labels = await page.eval<string[]>(items);
  assert.deepEqual(labels.slice(0, 2), ['📍Point at thisAlt+Shift+P', '✎Point and draw…']);
  assert.ok(labels.some((l) => l.includes('Reply with a quote')), `its own actions follow: ${labels}`);
  assert.equal(await page.eval('document.activeElement.classList.contains("cui-menu-item")'), true, 'focus is on the first item');
  // Arrows move; End goes to the last item.
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  assert.equal(await page.eval('document.activeElement === [...document.querySelectorAll(".cui-menu-item")].at(-1)'), true);
  await esc(page);
  await waitFor(page, 'the menu to close', `!${menuOpen}`);

  await rightClick(page, '#log .msg.user');
  await waitFor(page, 'the menu', menuOpen);
  await page.eval('document.querySelector(".cui-menu .cui-menu-point").click()');
  await waitFor(page, 'the chip and the crop', '!!document.querySelector(".point-chip") && !!document.querySelector(".attachments img")');
  assert.equal(await page.eval('!!document.querySelector(".pick-dim")'), false, 'no dim step');
  assert.match(await page.eval<string>('document.querySelector(".point-chip").title'), /Pointed at: message/);
});

test('Point and draw… opens the crop in the drawing tools', { skip }, async () => {
  const page = await open('Menu draw');
  await rightClick(page, '#log .msg.user');
  await waitFor(page, 'the menu', menuOpen);
  await page.eval('document.querySelectorAll(".cui-menu .cui-menu-point")[1].click()');
  await waitFor(page, 'the drawing tools', '!!document.querySelector(".cui-lb canvas")');
});

test('a text box and Shift+right-click keep the browser\'s own menu', { skip }, async () => {
  const page = await open('Menu native');
  await rightClick(page, '.composer textarea');
  await rightClick(page, '#log .msg.user', { shift: true });
  // Then a plain right-click that does open one, so the two above had their chance to.
  await rightClick(page, '#log .msg.user');
  await waitFor(page, 'the menu', menuOpen);
  assert.equal(await page.eval('document.querySelectorAll(".cui-menu").length'), 1);
  assert.equal(await page.eval('document.querySelector(".cui-menu .cui-menu-kind").textContent'), 'Message', 'only the plain right-click opened one');
});

test('Shift+F10 on a focused minion row opens its menu; Escape puts focus back', { skip }, async () => {
  const page = await open('Menu keyboard');
  // The sidebar redraws as the chat settles and a redraw drops focus, so focus and press in one step.
  // (A real Shift+F10 through DevTools reaches the same keydown; the race is only the test's.)
  // A redraw after the menu closed drops focus again, which is the page's doing and not the menu's: so the focus is read
  // in the microtask that follows the menu's removal, in the same task as the Escape keydown, before any redraw can run.
  const row = 'a.thread-row[data-id]:not(.coordinator)';
  await page.eval(`(() => {
    window.focusAfterClose = null;
    new MutationObserver((recs) => {
      if (recs.some((r) => [...r.removedNodes].some((n) => n.classList?.contains('cui-menu')))) window.focusAfterClose = document.activeElement.matches('${row}');
    }).observe(document.body, { childList: true, subtree: true });
    const r = document.querySelector('${row}'); r.focus(); r.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
  })()`);
  await waitFor(page, 'the menu', menuOpen);
  assert.equal(await page.eval('document.querySelector(".cui-menu .cui-menu-kind").textContent'), 'Minion');
  await esc(page);
  await waitFor(page, 'the menu to close', `!${menuOpen}`);
  assert.equal(await page.eval('window.focusAfterClose'), true, 'focus is back on the row');
});

test('a scroll of what it is about closes it; a redraw\'s scroll elsewhere doesn\'t', { skip }, async () => {
  const page = await open('Menu scroll');
  await rightClick(page, '#log .msg.user');
  await waitFor(page, 'the menu', menuOpen);
  // Scroll events are dispatched synchronously, so the check right after is deterministic.
  assert.equal(await page.eval(`(() => { document.querySelector('a.thread-row[data-id]').parentElement.dispatchEvent(new Event('scroll')); return ${menuOpen}; })()`), true, 'the sidebar scrolling leaves it open');
  await page.eval('document.querySelector("#log .msg.user").closest(".log, #log").dispatchEvent(new Event("scroll"))');
  await waitFor(page, 'the menu to close', `!${menuOpen}`);
});

test('on a mouse device the composer has no 🎯 and a one-time tip says to right-click', { skip }, async () => {
  const page = await open('Menu mouse', { mouse: true });
  assert.equal(await page.eval('getComputedStyle(document.querySelector("[data-part=point-at]")).display'), 'none');
  await waitFor(page, 'the tip', '[...document.querySelectorAll(".cui-toast")].some((t) => /Right-click anything to point at it/.test(t.textContent))');
  assert.equal(await page.eval('localStorage.getItem("citadel.pointTip") !== null'), true, 'it is shown once');
  // Alt+Shift+P still starts a pick.
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'P', code: 'KeyP', modifiers: 9, windowsVirtualKeyCode: 80 });
  await waitFor(page, 'pick mode', '!!document.querySelector(".pick-dim")');
});

// A phone's long press (#1664, Cara 2026-11-22: "Long-press opens the menu on phones: Yes, a sheet").
test('a long press on a link opens the menu as a sheet; its tap does nothing; the dim closes it', { skip }, async () => {
  const page = await open('Menu phone', { phone: true });
  await page.eval(`(() => { const m = document.querySelector('#log .msg.user'); m.insertAdjacentHTML('beforeend', '<p><a id="lp" href="#/p/999">a link</a></p>'); window.clicked = 0; document.getElementById('lp').addEventListener('click', () => { window.clicked++; }); })()`);
  const { x, y } = await page.centre('#lp');
  await page.touch('touchStart', x, y);
  await hold(250);
  assert.equal(await page.eval(menuOpen), false, 'not yet at 250 ms');
  await waitFor(page, 'the sheet', '!!document.querySelector(".cui-menu[data-sheet]")');
  await page.touch('touchEnd');
  assert.equal(await page.eval('window.clicked'), 0, 'the press did not click the link');
  assert.equal(await page.eval('location.hash.includes("999")'), false);
  assert.equal(await page.eval('document.querySelector(".cui-menu .cui-menu-kind").textContent'), 'Link');
  const rows = await page.eval('[...document.querySelectorAll(".cui-menu .cui-menu-item")].map((b) => [b.textContent, Math.round(b.getBoundingClientRect().height)])') as [string, number][];
  assert.match(rows[0][0], /Point at this/);
  assert.match(rows[1][0], /Point and draw/);
  assert.ok(rows.every(([, h]) => h >= 44), `every row is 44 px or taller: ${JSON.stringify(rows)}`);
  assert.equal(await page.eval('!!document.querySelector(".cui-menu .cui-menu-grab")'), true);
  await waitFor(page, 'the sheet at the bottom', 'Math.abs(document.querySelector(".cui-menu").getBoundingClientRect().bottom - innerHeight) < 1');
  await hold(400);
  await page.tap(200, 60); // the dim
  await waitFor(page, 'the sheet to close', `!${menuOpen}`);
});

test('a moved finger cancels the long press, and message text keeps its own selection', { skip }, async () => {
  const page = await open('Menu phone cancel', { phone: true });
  const t = await page.centre('#log .msg.user');
  await page.touch('touchStart', t.x, t.y);
  await hold(650);
  await page.touch('touchEnd');
  assert.equal(await page.eval(menuOpen), false, 'message text: no sheet');
  await page.eval(`document.querySelector('#log .msg.user').insertAdjacentHTML('beforeend', '<p><a id="lp" href="#/p/999">a link</a></p>')`);
  const { x, y } = await page.centre('#lp');
  await page.touch('touchStart', x, y);
  await page.touch('touchMove', x, y + 30);
  await hold(650);
  await page.touch('touchEnd');
  assert.equal(await page.eval(menuOpen), false, 'moved more than 10 px: no sheet');
});

// A modal <dialog> makes everything outside it inert, so a menu appended to <body> drew but couldn't be clicked (Peek Auras #885).
const inDialog = (sheet: boolean) => `(async () => {
  const { openDialog } = await import('/ui/dialog.js');
  const { openMenu } = await import('/ui/menu.js');
  const b = document.createElement('button'); b.id = 'tgt'; b.textContent = 'target';
  const d = openDialog({ title: 'Library', body: [b] });
  window.ran = 0; window.dlgClosed = false; d.addEventListener('close', () => { window.dlgClosed = true; });
  const r = b.getBoundingClientRect();
  openMenu({ kind: 'Pack', name: 'x', sheet: ${sheet}, returnTo: b, items: [{ label: 'Do it', run: () => { window.ran++; } }] }, r.left, r.bottom);
})()`;

test('a menu opened inside a modal dialog can be clicked, and Escape closes only the menu', { skip }, async () => {
  const page = await open('Menu in dialog');
  await page.eval(inDialog(false));
  assert.equal(await page.eval(`document.querySelector('.cui-menu').closest('dialog') === document.querySelector('dialog:modal')`), true, 'mounted in the modal');
  await esc(page);
  await waitFor(page, 'the menu to close', `!${menuOpen}`);
  assert.equal(await page.eval('window.dlgClosed'), false, 'the dialog stays open');
  assert.equal(await page.eval('document.activeElement?.id'), 'tgt', 'focus returns to the target');
});

test('clicking an item of a menu inside a modal dialog runs it', { skip }, async () => {
  const page = await open('Menu in dialog click');
  await page.eval(inDialog(false));
  const { x, y } = await page.centre('.cui-menu-item');
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  await waitFor(page, 'the item to run', 'window.ran === 1');
  assert.equal(await page.eval(menuOpen), false);
  assert.equal(await page.eval('window.dlgClosed'), false);
});

test('the phone sheet inside a modal dialog: its row runs, its dim closes only the sheet', { skip }, async () => {
  const page = await open('Menu in dialog phone', { phone: true });
  await page.eval(inDialog(true));
  await waitFor(page, 'the sheet at the bottom', 'Math.abs(document.querySelector(".cui-menu").getBoundingClientRect().bottom - innerHeight) < 1');
  await hold(400);
  await page.tap(20, 20); // the dim
  await waitFor(page, 'the sheet to close', `!${menuOpen}`);
  assert.equal(await page.eval('window.dlgClosed'), false, 'the dialog stays open');
  await page.eval(inDialog(true));
  await waitFor(page, 'the sheet at the bottom', 'Math.abs(document.querySelector(".cui-menu").getBoundingClientRect().bottom - innerHeight) < 1');
  await hold(400);
  const { x, y } = await page.centre('.cui-menu-item');
  await page.tap(x, y);
  await waitFor(page, 'the row to run', 'window.ran === 1');
});
