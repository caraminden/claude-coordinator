// The message box's Send never locks (#392, Cara 2026-11-08: "assume things will work instantly, but recover
// later if there was an issue"), in a real browser (headless Chromium, test/browser.ts) against the real server.
// The page's fetch holds each POST to /messages until the test lets it go or fails it (window.held), so the
// order and overlap of sends is seen, not timed.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { sendIdOf, sendOnce } from '../src/send-ids.ts';
import { bootServer, until, type Booted } from './helpers.ts';
import { chromium, launch, type Browser, type Page } from './browser.ts';

test('a sendId is sent once per chat; a repeat shares the first one\'s outcome; a failed one is forgotten', async () => {
  assert.equal(sendIdOf(''), undefined);
  assert.equal(sendIdOf(7), undefined);
  assert.equal(sendIdOf('x'.repeat(101)), undefined);
  const sent: string[] = [];
  const ok = (what: string) => async () => void sent.push(what);
  await sendOnce(1, undefined, ok('untagged'));
  await sendOnce(1, undefined, ok('untagged'));
  await sendOnce(1, 'a', ok('a'), 1000);
  await sendOnce(1, 'a', ok('a again'), 2000);
  await sendOnce(2, 'a', ok('a in chat 2'), 2000);
  assert.deepEqual(sent, ['untagged', 'untagged', 'a', 'a in chat 2']);

  // A retry while the first is still running waits for it, and fails with it, so it never says "sent" for a lost one.
  let fail!: (err: Error) => void;
  const first = sendOnce(1, 'b', () => new Promise((_, no) => (fail = no)), 3000);
  const retry = sendOnce(1, 'b', ok('b retry'), 3000);
  fail(new Error('disk full'));
  await assert.rejects(first, /disk full/);
  await assert.rejects(retry, /disk full/);
  await sendOnce(1, 'b', ok('b'), 4000);
  assert.deepEqual(sent.slice(-1), ['b'], 'forgotten after failing, so the next retry goes');
  await sendOnce(1, 'a', ok('a after ten minutes'), 1000 + 10 * 60_000);
  assert.deepEqual(sent.slice(-1), ['a after ten minutes'], 'old ones are forgotten');
});

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
const shots = process.env.SEND_QUEUE_SHOTS; // a folder: write desktop and phone screenshots there

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

/** A minion whose first turn (CLAUDE_BIN is /bin/false) has ended, so its chat is quiet. */
async function minion(title: string) {
  const t = (await srv.call(`/api/projects/${projectId}/tickets`, { title, message: 'hi' })).data;
  await until('the first turn to end', async () => (await srv.call(`/api/tickets/${t.id}`)).data.ticket.status !== 'running');
  return t;
}

const texts = async (id: number) => (await srv.call(`/api/tickets/${id}/events?after=0`)).data
  .filter((e: any) => e.kind === 'user_message').map((e: any) => JSON.parse(e.data).text);

test('a retry of a message the server already took doesn\'t send it twice', async () => {
  const t = await minion('Dedupe');
  for (let i = 0; i < 2; i++) assert.equal((await srv.call(`/api/tickets/${t.id}/messages`, { text: 'once', sendId: 'abc' })).status, 202);
  await srv.call(`/api/tickets/${t.id}/messages`, { text: 'twice' });
  await srv.call(`/api/tickets/${t.id}/messages`, { text: 'twice' });
  assert.deepEqual(await texts(t.id), ['hi', 'once', 'twice', 'twice'], 'untagged messages are never deduped');
});

const HOLD = `(() => {
  window.held = [];
  const real = window.fetch;
  window.fetch = (url, opts) => {
    if (!(opts?.method === 'POST' && /\\/messages$/.test(String(url)))) return real(url, opts);
    return new Promise((ok, no) => held.push({ body: JSON.parse(opts.body), go: () => real(url, opts).then(ok, no), fail: () => no(new TypeError('Failed to fetch')) }));
  };
})()`;

async function open(width: number, t: { id: number; number: number }) {
  const page = await browser.page('data:text/html,<script>window.ready=true</script>', { width, height: 800 });
  const [name, value] = srv.cookie.split('=');
  await page.send('Network.setCookie', { name, value, url: srv.base });
  await page.send('Page.navigate', { url: `${srv.base}/#/p/${projectId}/t/${t.number}` });
  await wait(page, 'the chat', '!!document.querySelector(".composer textarea") && !!document.querySelector("#log .msg.user")');
  await page.eval(HOLD);
  return page;
}

async function wait(page: Page, what: string, expression: string) {
  for (const end = Date.now() + 10_000; !(await page.eval(expression).catch(() => false)); await new Promise((r) => setTimeout(r, 50))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
}

const type = (page: Page, text: string) => page.eval(`(() => {
  const box = document.querySelector('.composer textarea');
  box.value = ${JSON.stringify(text)};
  box.dispatchEvent(new Event('input'));
  document.querySelector('.composer').requestSubmit();
  // As a person sees it: after this task, before the next tap.
  return new Promise((r) => setTimeout(() => r(document.querySelector('.composer button[type=submit]').disabled)));
})()`);
const bubble = (text: string) => `[...document.querySelectorAll('#log .msg.user')].find((m) => [...m.children].slice(1).map((c) => c.textContent).join('').trim() === ${JSON.stringify(text)})`;

async function shoot(page: Page, name: string) {
  if (!shots) return;
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
}

for (const [width, label] of [[1280, 'desktop'], [390, 'phone']] as const) {
  test(`three quick sends at ${label} width go in order, one failing, and Send never locks (#392)`, { skip }, async () => {
    const t = await minion(`Queue ${label}`);
    const page = await open(width, t);
    // Send stays live through all three, and only the first is on its way: the rest wait their turn.
    for (const text of ['one', 'two', 'three']) assert.equal(await type(page, text), false, `Send is live after "${text}"`);
    await wait(page, 'the first send', 'held.length === 1');
    assert.equal(await page.eval('held.length'), 1, 'one at a time');
    assert.equal(await page.eval('document.querySelectorAll("#log .msg.user.pending").length'), 3, 'all three show at once');
    await shoot(page, `${label}-sending.png`);

    await page.eval('held[0].go()');
    await wait(page, 'the second send', 'held.length === 2');
    await page.eval('held[1].fail()');
    // The failed one stays in the chat, not sent, its text kept; the third still goes.
    await wait(page, '"two" marked not sent', `${bubble('two')}?.classList.contains('not-sent')`);
    await wait(page, 'the third send', 'held.length === 3');
    await page.eval('held[2].go()');
    await until('the server to have one and three', async () => (await texts(t.id)).length === 3);
    assert.deepEqual(await texts(t.id), ['hi', 'one', 'three']);
    await wait(page, 'the server\'s copies swapped in', 'document.querySelectorAll("#log .msg.user.pending").length === 0');
    assert.equal(await page.eval('document.querySelectorAll("#log .msg.user.not-sent").length'), 1);
    assert.equal(await page.eval(`${bubble('three')}.compareDocumentPosition(${bubble('two')}) === Node.DOCUMENT_POSITION_FOLLOWING`), true, 'the unsent one stays below what the server has');
    await shoot(page, `${label}-not-sent.png`);

    // Retry sends it again with the same sendId, so a reply lost on the way can't make it twice.
    await page.eval(`${bubble('two')}.querySelector('[aria-label="Send it again"]').click()`);
    await wait(page, 'the retry', 'held.length === 4');
    assert.equal(await page.eval('held[3].body.sendId === held[1].body.sendId && held[3].body.text'), 'two');
    await page.eval('held[3].go()');
    await until('the retry to land', async () => (await texts(t.id)).length === 4);
    assert.deepEqual(await texts(t.id), ['hi', 'one', 'three', 'two']);
    await wait(page, 'no message left pending or unsent', 'document.querySelectorAll("#log .msg.user.pending, #log .msg.user.not-sent").length === 0');

    // ✎ on a failed one takes it back into the box, ahead of anything typed since.
    await type(page, 'four');
    await wait(page, 'the fourth send', 'held.length === 5');
    await page.eval('held[4].fail()');
    await wait(page, '"four" marked not sent', `${bubble('four')}?.classList.contains('not-sent')`);
    await page.eval(`(() => { const b = document.querySelector('.composer textarea'); b.value = 'draft'; b.dispatchEvent(new Event('input')); })()`);
    await page.eval(`${bubble('four')}.querySelector('[aria-label="Take back to edit"]').click()`);
    assert.equal(await page.eval('document.querySelector(".composer textarea").value'), 'four\ndraft');
    assert.equal(await page.eval(`!${bubble('four')}`), true, 'its bubble is gone');
    assert.deepEqual(await texts(t.id), ['hi', 'one', 'three', 'two']);
  });
}
