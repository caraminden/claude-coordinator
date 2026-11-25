// What a person typed or attached in the composer isn't lost or sent half-done (#1852, from #1834's review), in a real
// browser (headless Chromium, test/browser.ts) against the real server.
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

async function open(title: string) {
  const t = (await srv.call(`/api/projects/${projectId}/tickets`, { title, message: 'hi' })).data;
  await until('the first turn to end', async () => (await srv.call(`/api/tickets/${t.id}`)).data.ticket.status !== 'running');
  const page: Page = await browser.page('data:text/html,<script>window.ready=true</script>', { width: 1280, height: 800 });
  const [name, value] = srv.cookie.split('=');
  await page.send('Network.setCookie', { name, value, url: srv.base });
  await page.send('Page.navigate', { url: `${srv.base}/#/p/${projectId}/t/${t.number}` });
  await waitFor(page, 'the chat', '!!document.querySelector(".composer textarea") && !!document.querySelector("#log .msg.user")');
  return { page, t };
}

// C3: Send pressed right after pasting three images goes after all three, in one message.
test('Send during a multi-image add waits for every image (C3)', { skip }, async () => {
  const { page, t } = await open('three images');
  await page.eval(`(async () => {
    const dt = new DataTransfer();
    for (const n of [1, 2, 3]) {
      const c = Object.assign(document.createElement('canvas'), { width: 300, height: 200 });
      c.getContext('2d').fillRect(0, 0, 10 * n, 10);
      dt.items.add(new File([await new Promise((r) => c.toBlob(r, 'image/png'))], 'shot' + n + '.png', { type: 'image/png' }));
    }
    const box = document.querySelector('.composer textarea');
    box.focus();
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    box.form.requestSubmit();
  })()`);
  await until('one message with three images', async () => {
    const ev = (await srv.call(`/api/tickets/${t.id}/events`)).data.events as { kind: string; data: string }[];
    const m = ev.filter((e) => JSON.parse(e.data).images?.length).at(-1);
    return !!m && (JSON.parse(m.data).images?.length ?? 0) === 3;
  });
  assert.equal(await page.eval(`document.querySelectorAll('.composer .attachments .thumb').length`), 0, 'nothing left behind in the box');
});
