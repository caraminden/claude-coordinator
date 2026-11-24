// ui/optimistic.js and toast()'s action button in a real browser (headless Chromium, test/browser.ts): Cara's rule
// (2026-11-08, "assume things will work instantly, but recover later if there was an issue"). Each send is a
// promise the test settles by hand (window.reqs), so the order and overlap of sends is seen, not timed.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, type Browser, type Page, serveUi, skipMessage, type App } from './browser.ts';
import { until } from './wait.ts';

const bin = chromium();
const skip = !bin && skipMessage;

// act(id, key): an action on item `id` that marks it done at once, sends a request the test settles by hand
// (ok(n) / no(n), n its place in window.reqs), and unmarks it on failure. window.log records what happened.
const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/ui/base.css">
<style>body{margin:0;padding:16px;font:15px var(--citadel-font);background:var(--citadel-bg);color:var(--citadel-text)}</style>
<ul id="items"><li id="a">a</li><li id="b">b</li><li id="c">c</li></ul>
<script type="module">
  import { optimistic } from '/ui/optimistic.js';
  import { toast } from '/ui/status.js';
  window.log = [];
  window.reqs = [];
  window.unhandled = 0;
  addEventListener('unhandledrejection', () => window.unhandled++);
  window.act = (id, key, label = 'reject ' + id) => optimistic({
    key, label,
    apply: () => { document.getElementById(id).dataset.done = ''; log.push('apply ' + id); },
    send: () => new Promise((ok, no) => { reqs.push({ id, ok, no }); log.push('send ' + id); }),
    undo: (err) => { delete document.getElementById(id).dataset.done; log.push('undo ' + id + ' ' + err.message); },
  });
  // set(v): an action that sets one value (a pin, a status) to v, and whose undo puts back what it saw before.
  window.value = 0;
  window.set = (v, key) => { const was = value; return optimistic({
    key, sets: 'v', label: 'set ' + v,
    apply: () => (window.value = v),
    send: () => new Promise((ok, no) => reqs.push({ id: 'v' + v, ok, no })),
    undo: () => (window.value = was),
  }); };
  window.ok = (n) => reqs[n].ok(n);
  window.no = (n) => reqs[n].no(new Error('nope'));
  window.settle = () => new Promise((r) => setTimeout(r, 0));
  window.done = () => [...document.querySelectorAll('[data-done]')].map((el) => el.id).join('');
  window.toastText = () => { const t = document.querySelector('.cui-toast'); return t?.matches(':popover-open') ? t.textContent : null; };
  Object.assign(window, { optimistic, toast });
  window.ready = true;
</script>`;

let app: App;
let browser: Browser;
let base = '';

before(async () => {
  if (skip) return;
  app = await serveUi(PAGE);
  base = app.base;
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await app?.close();
});

const open = (opts?: Parameters<Browser['page']>[1]) => browser.page(base, opts);

/** A real mouse click at the centre of `selector`. */
async function click(page: Page, selector: string) {
  const { x, y } = await page.centre(selector);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

test('every click shows at once; one key sends in click order, other keys side by side', { skip }, async () => {
  const page = await open();
  await page.eval(`act('a', 'k'), act('b', 'k'), act('c', 'other'), null`);
  // All three applied at once; the first of key k and the other key are sent, the second of k waits its turn.
  assert.equal(await page.eval('done()'), 'abc');
  assert.deepEqual(await page.eval('log'), ['apply a', 'send a', 'apply b', 'apply c', 'send c']);
  await page.eval('ok(1), settle()'); // c (the other key) finishes first: nothing of k moves
  assert.deepEqual(await page.eval('reqs.map((r) => r.id)'), ['a', 'c']);
  await page.eval('ok(0), settle()');
  assert.deepEqual(await page.eval('reqs.map((r) => r.id)'), ['a', 'c', 'b'], 'b sends once a has');
  await page.eval('ok(2), settle()');
  assert.equal(await page.eval('done()'), 'abc');
  assert.equal(await page.eval('toastText()'), null, 'no toast when all went');
});

test('a failure rolls back that item alone, toasts what failed and why with Retry, and the next of its key still sends', { skip }, async () => {
  const page = await open();
  await page.eval(`window.out = {}; act('a', 'k').then((v) => (out.a = 'ok ' + v), (e) => (out.a = 'failed ' + e.message)); act('b', 'k'), act('c'), null`);
  await page.eval('no(0), settle()');
  assert.equal(await page.eval('done()'), 'bc', 'a rolled back; b and c kept');
  assert.ok((await page.eval<string[]>('log')).includes('undo a nope'), 'undo gets the error');
  assert.equal(await page.eval('toastText()'), "Couldn't reject a: nopeRetry");
  assert.equal(await page.eval('document.querySelector(".cui-toast").dataset.tone'), 'danger');
  assert.deepEqual(await page.eval('reqs.map((r) => r.id)'), ['a', 'c', 'b'], 'b sends after a failed');
  assert.deepEqual(await page.eval('out'), {}, 'while Retry is on offer, the promise waits');
  await click(page, '.cui-toast-text'); // the toast sent away without a Retry: that failure is final
  assert.deepEqual(await page.eval('settle().then(() => out)'), { a: 'failed nope' });
  await page.eval('ok(1), ok(2), settle()');
});

test('Retry runs apply and send again and settles the first promise; failures while the toast is up join its one Retry', { skip }, async () => {
  const page = await open();
  await page.eval(`window.out = {}; for (const id of 'abc') act(id).then((v) => (out[id] = 'ok ' + v), (e) => (out[id] = 'failed ' + e.message)); null`);
  await page.eval('no(0), settle()');
  await page.eval('no(1), settle()');
  assert.equal(await page.eval('toastText()'), "Couldn't reject a: nope (and 1 more)Retry");
  assert.deepEqual(await page.eval('out'), {}, 'a, carried into the newer toast, still waits');
  assert.equal(await page.eval('done()'), 'c');
  assert.equal(await page.eval('unhandled'), 0, 'an unchained failure logs no unhandled rejection');
  await click(page, '.cui-toast-action');
  await page.eval('settle()');
  assert.equal(await page.eval('toastText()'), null, 'the toast goes on Retry');
  assert.equal(await page.eval('done()'), 'abc', 'both applied again');
  assert.deepEqual(await page.eval('reqs.map((r) => r.id)'), ['a', 'b', 'c', 'a', 'b'], 'both sent again');
  await page.eval('ok(3), ok(4), ok(2), settle()');
  assert.equal(await page.eval('done()'), 'abc');
  assert.deepEqual(await page.eval('out'), { a: 'ok 3', b: 'ok 4', c: 'ok 2' }, "each first promise settles with its Retry's value");
  // A failure after that toast went starts a toast of its own, not "and 2 more".
  await page.eval(`act('a'), settle()`);
  await page.eval('no(5), settle()');
  assert.equal(await page.eval('toastText()'), "Couldn't reject a: nopeRetry");
});

test('clicks that set one thing end on what the server took, whatever order they fail and go through in', { skip }, async () => {
  const page = await open();
  for (const n of [2, 3]) {
    for (let bits = 0; bits < 2 ** n; bits++) {
      const outcomes = [...Array(n)].map((_, i) => ((bits >> i) & 1 ? 'ok' : 'no'));
      // Click n times at once (values 1..n from 0), then the server answers each, in click order.
      await page.eval(`value = 0; reqs = []; for (let v = 1; v <= ${n}; v++) set(v); null`);
      for (let i = 0; i < n; i++) {
        await page.eval(`${outcomes[i]}(${i}), settle()`);
        if (i < n - 1) assert.equal(await page.eval('value'), n, `${outcomes}: the newest click shows while a later one is on its way (after ${i + 1})`);
      }
      const took = outcomes.lastIndexOf('ok') + 1; // the value the server last took, or 0 when it took none
      assert.equal(await page.eval('value'), took, `${outcomes}: ends on what the server took`);
      assert.equal(await page.eval('reqs.length'), n, `${outcomes}: one send a click, one after another`);
    }
  }
});

test("one thing's failure waits for its later clicks, and its Retry counts as the newest click", { skip }, async () => {
  const page = await open();
  // set(1) fails while set(2) is on its way; Retry sends 1 again behind it; 2 fails, the retried 1 goes.
  await page.eval('set(1), set(2), null');
  await page.eval('no(0), settle()');
  assert.equal(await page.eval('value'), 2);
  await click(page, '.cui-toast-action');
  assert.equal(await page.eval('settle().then(() => value)'), 1);
  await page.eval('no(1), settle()');
  assert.equal(await page.eval('value'), 1, "the retried 1 is on its way, so 2's failure waits");
  await page.eval('ok(2), settle()');
  assert.equal(await page.eval('value'), 1);
  // Under a key shared with other things, it still waits only for its own later clicks.
  await page.eval(`value = 0; reqs = []; set(1, 'k'), act('a', 'k'), null`);
  await page.eval('no(0), settle()');
  assert.equal(await page.eval('value'), 0, 'no later click of its own: rolled back at once');
  await page.eval('ok(1), settle()');
});

test('a send that throws, or no key, label or undo, still recovers; another toast makes a failure final', { skip }, async () => {
  const page = await open();
  await page.eval(`window.thrown = optimistic({ send: () => { throw new Error('boom'); } }).catch((e) => e.message); null`);
  assert.equal(await page.eval('settle().then(() => toastText())'), "Couldn't do that: boomRetry");
  assert.equal(await page.eval(`toast('Copied'), thrown`), 'boom');
  await page.eval(`optimistic({ label: 'save', send: () => Promise.reject() }); null`);
  assert.equal(await page.eval('settle().then(() => toastText())'), "Couldn't saveRetry", 'no error, no colon');
});

test('on Retry, an apply that throws (its item gone) settles that action and the others still retry', { skip }, async () => {
  const page = await open();
  await page.eval(`window.out = {}; let first = true;
    optimistic({ label: 'x', apply: () => { if (!first) throw new Error('gone'); first = false; }, send: () => Promise.reject(new Error('down')) }).catch((e) => (out.x = e.message));
    act('a').then((v) => (out.a = 'ok ' + v)); null`);
  await page.eval('no(0), settle()');
  await click(page, '.cui-toast-action');
  assert.deepEqual(await page.eval('settle().then(() => reqs.map((r) => r.id))'), ['a', 'a']);
  await page.eval('ok(1), settle()');
  assert.deepEqual(await page.eval('out'), { x: 'gone', a: 'ok 1' });
});

for (const [label, opts] of [
  ['desktop', { width: 900, height: 600 }],
  ['phone, dark', { width: 390, height: 700, touch: true, dark: true }],
] as const) {
  test(`${label}: a toast's action sits beside its text with equal room above and below`, { skip }, async () => {
    const page = await open(opts);
    for (const text of ["Couldn't reject speculation", "Couldn't reject the speculation about the Scion's ascendancy tree and 4 more things"]) {
      await page.eval(`toast(${JSON.stringify(text)}, { tone: 'danger', action: { label: 'Retry', run: () => {} } })`);
      const [t, txt, btn] = await page.eval<DOMRect[]>('[".cui-toast", ".cui-toast-text", ".cui-toast-action"].map((s) => document.querySelector(s).getBoundingClientRect().toJSON())');
      const top = Math.min(txt.top, btn.top) - t.top;
      const bottom = t.bottom - Math.max(txt.bottom, btn.bottom);
      assert.ok(top > 0 && Math.abs(top - bottom) <= 1, `equal room above and below (${top} / ${bottom})`);
      assert.ok(Math.abs((btn.top + btn.bottom) / 2 - (t.top + t.bottom) / 2) <= 1, 'the button is centred');
      assert.ok(btn.left >= txt.right && btn.right <= t.right, 'the button sits after the text, inside');
      assert.ok(t.left >= 0 && t.right <= opts.width && t.bottom <= opts.height, 'inside the window');
    }
    assert.equal(await page.eval('document.querySelector(".cui-toast").hasAttribute("aria-hidden")'), false, 'its button is reachable');
    await page.eval(`toast('Copied')`);
    assert.equal(await page.eval('document.querySelector(".cui-toast").getAttribute("aria-hidden")'), '', 'a plain toast is still hidden from a screen reader');
    assert.equal(await page.eval('document.querySelector(".cui-toast-action")'), null);
  });
}

test('onHide runs once, however the toast goes', { skip }, async () => {
  const page = await open();
  // Read in the same eval: a separate look could come after 'two's 50 ms on a loaded box.
  assert.deepEqual(await page.eval(`window.hid = []; toast('one', { onHide: () => hid.push('one') }); toast('two', { onHide: () => hid.push('two'), ms: 50 }); [...hid]`), ['one'], 'a newer toast sends the last away');
  await until('the second toast to time out', async () => (await page.eval<string[]>('[...hid]')).length === 2);
  assert.deepEqual(await page.eval('hid'), ['one', 'two'], 'its time ran out');
  await page.eval(`toast('three')`);
  assert.deepEqual(await page.eval('hid'), ['one', 'two'], 'not again');
});
