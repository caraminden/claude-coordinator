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

// C5: "Send after this turn" stays "after this turn" when it goes through the secret warning's "Send anyway".
test('"Send after this turn" survives the secret warning (C5)', { skip }, async () => {
  const { page, t } = await open('secret after');
  await page.eval(`(() => {
    window.__bodies = [];
    const f = window.fetch;
    window.fetch = (u, o) => { if (o?.body && /\\/message/.test(String(u))) window.__bodies.push(String(o.body)); return f(u, o); };
    const box = document.querySelector('.composer textarea');
    box.value = 'the password is hunter2!x';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.send-menu button')].find((b) => /after this turn/.test(b.textContent)).click();
  })()`);
  await waitFor(page, 'the warning', '!![...document.querySelectorAll("button")].find((b) => b.textContent === "Send anyway")');
  await page.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Send anyway').click()`);
  await waitFor(page, 'the request', 'window.__bodies.length > 0');
  assert.equal(JSON.parse(await page.eval(`window.__bodies[0]`)).after, true);
  assert.ok(t.id);
});

// #937 (6106ca17): words typed after /fresh stay in the box with a note. Without it a fresh session starts and drops them.
test('"/fresh" with words after it is refused and keeps them; "/fresh" alone asks to start one', { skip }, async () => {
  const { page } = await open('fresh with words');
  const press = (text: string) =>
    page.eval(`(() => {
      let asked = 0;
      window.confirm = () => (asked++, true);
      window.fetch = () => Promise.reject(new Error('cut off')); // no fresh session starts
      const notes = () => document.querySelectorAll('#log .note.error').length;
      const before = notes();
      const box = document.querySelector('.composer textarea');
      box.value = ${JSON.stringify(text)};
      box.form.requestSubmit();
      const out = { asked, left: box.value, notes: notes() - before };
      box.value = '';
      return JSON.stringify(out);
    })()`);
  assert.deepEqual(JSON.parse(await press('/fresh then fix the login page')), { asked: 0, left: '/fresh then fix the login page', notes: 1 });
  assert.deepEqual(JSON.parse(await press('/fresh')), { asked: 1, left: '', notes: 0 });
});
