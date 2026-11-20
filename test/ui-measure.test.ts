// The ui-screenshots rubric's measuring script (kit/skills/critique/scripts/ui-measure.mjs) in a real
// headless Chromium: each check fires on a planted defect and stays quiet on its clean twin.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from './browser.ts';
// @ts-ignore: a kit script in plain JS, so other schemes run it with no type stripping
import { launch, openPage, shot } from '../kit/skills/critique/scripts/ui-measure.mjs';
// @ts-ignore
import { measure } from '../kit/skills/critique/scripts/ui-measure.mjs';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';

const STYLE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>:root{--control-h:32px} @media (max-width:800px){:root{--control-h:40px}}
body{margin:0;font:15px sans-serif;background:#fff} button,.chip{font:inherit}
.btn{display:inline-flex;align-items:center;min-height:var(--control-h);padding:4px 12px;background:#eef;border:1px solid #99a;border-radius:6px}
.chip{display:inline-flex;align-items:center;padding:4px 10px;background:#efe;border-radius:99px}</style>`;

const PAGES: Record<string, string> = {
  '/clean': `${STYLE}<main style="padding:16px;max-width:600px">
<button class="btn" id="b1">Save</button> <span class="chip" id="c1">running</span>
<p>Read <a href="#x">this link</a> in a sentence, and a long id that wraps: <span style="overflow-wrap:anywhere">${'a'.repeat(120)}</span>.</p>
<div style="border:1px solid #888;padding:8px"><p style="margin:0">a panel</p><div style="border-top:1px solid #ccc;margin-top:8px">with a rule inside</div></div>
<div style="width:120px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis" data-tip-overflow>${'Truncated on purpose '.repeat(3)}</div>
<button id="frame" style="display:block;width:80px;height:40px;padding:0;border:0;background:#ddd"><canvas width="80" height="40" style="display:block;width:100%;height:100%"></canvas></button>
<dialog id="d" style="padding:12px"><div style="position:sticky;top:0"><button class="btn" aria-label="Close">✕</button></div><div style="height:900px">body</div></dialog>
<div style="overflow-x:auto"><table><tr><td style="white-space:nowrap">${'wide cell '.repeat(40)}</td></tr></table></div>
<p>A <a href="https://x.io/a">https://x.io/a</a>, <a href="https://x.io/b" title="https://x.io/b">a titled one</a>, <code>curl https://x.io/c</code>, version 1.10.1234/5.</p>
</main><script>document.getElementById('d').show()</script>`,
  '/broken': `${STYLE}
<span class="chip" id="lop" style="padding:2px 10px 10px">lopsided</span>
<button class="btn" id="small" style="min-height:0;padding:2px 6px;line-height:14px">x</button>
<div id="clip" style="width:80px;height:20px;overflow:hidden;white-space:nowrap">${'cut off text '.repeat(4)}</div>
<div id="outer" style="border:1px solid #888;padding:2px;width:300px"><textarea id="ta" style="border:1px solid #888;width:100%;box-sizing:border-box;display:block"></textarea></div>
<div id="wide" style="width:1600px;height:4px"></div>
<p id="bare">see https://x.io/a. or doi:10.1000/xyz</p> <span id="tipped" title="https://x.io/b">the ref</span> <div id="tipwrap" title="https://x.io/src"><a href="/help">Help</a></div>
<dialog id="d" style="max-height:200px;overflow:auto;padding:0"><button class="btn" aria-label="Close" id="close">✕</button><div style="height:600px">body</div></dialog>
<script>document.getElementById('d').show()</script>`,
  // Rule 23: one button shows its result at once; the other disables every control until the server answers.
  '/clicks': `${STYLE}<ul id="list"><li>one</li></ul>
<button class="btn" id="good">Add</button> <button class="btn" id="bad">Reject</button> <button class="btn" id="other">Other</button>
<script>
const all = () => document.querySelectorAll('button');
document.getElementById('good').onclick = () => { document.getElementById('list').insertAdjacentHTML('beforeend', '<li>new</li>'); fetch('/slow'); };
document.getElementById('bad').onclick = async () => { all().forEach((b) => (b.disabled = true)); await fetch('/slow'); all().forEach((b) => (b.disabled = false)); };
</script>`,
  // A spinner that never stops, an animation that ends, and a chip whose tooltip opens on hover.
  '/busy': `${STYLE}<style>@keyframes r{to{transform:rotate(360deg)}} #sp{width:40px;height:40px;border:6px solid #ccc;border-top-color:#339;border-radius:50%;animation:r .8s linear infinite}
#fade{animation:f .6s forwards} @keyframes f{from{opacity:0}to{opacity:1}} #tip{display:none} #h:hover #tip{display:block}</style>
<div id="sp"></div><p id="fade">hello</p><button class="btn" id="h" style="position:fixed;right:0;bottom:0">hover<span id="tip">tip</span></button>`,
  // Existing controls: one real no-op beside two that work (one changes the page, one navigates away).
  '/sweep': `${STYLE}<ul id="list"><li>one</li></ul>
<button class="btn" id="good">Add</button> <button class="btn" id="dead">Pin</button> <button class="btn" id="leave">Leave</button>
<script>
document.getElementById('good').onclick = () => document.getElementById('list').insertAdjacentHTML('beforeend', '<li>new</li>');
document.getElementById('leave').onclick = () => { location.href = '/clean'; };
</script>`,
  // A 36 px chip on a 40 px phone control height: the loop stops before a critic is spent.
  '/chip': `${STYLE}<button class="chip" id="chip36" style="height:36px;border:0">filter</button>`,
  // A modal dialog (position: fixed, scrolling itself) whose head scrolls away, rebuilt from Peek's before #175.
  ...Object.fromEntries(['static', 'sticky'].map((pos) => [`/modal-${pos}`, `${STYLE}
<dialog id="m" style="width:400px;max-height:300px;padding:0"><div style="display:flex;padding:8px;position:${pos};top:0;background:#fff">
<h2 style="flex:1;margin:0;font-size:15px">Your PC</h2><button class="btn" aria-label="Close" id="x">✕</button></div><div style="height:900px">body</div></dialog>
<script>document.getElementById('m').showModal()</script>`])),
};

let server: Server;
let base = '';
before(async () => {
  server = createServer((req, res) => {
    const page = PAGES[req.url ?? ''];
    res.writeHead(page ? 200 : req.url === '/slow' ? 204 : 404, { 'content-type': 'text/html' });
    res.end(page ?? '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

const opts = (url: string, more = {}) => ({ urls: [base + url], widths: [1440, 390], settle: 100, cookies: [], headers: [], ignore: [], dark: false, chrome: bin, ...more });
const at = (r: any, width: number) => r.pages.find((p: any) => p.width === width).findings;
const has = (fs: any[], check: string, selector: string) => fs.some((f) => f.check === check && f.selector.includes(selector));

test('a clean page has no findings at either width', { skip }, async () => {
  const r = await measure(opts('/clean'));
  assert.deepEqual(r.pages.map((p: any) => p.findings), [[], []], JSON.stringify(r.pages.map((p: any) => p.findings)));
  assert.equal(r.ok, true);
  assert.equal(r.pages[0].truncated[0].full_text_in, 'data-tip-overflow');
});

test('each planted defect is found, with its numbers', { skip }, async () => {
  const r = await measure(opts('/broken'));
  const desk = at(r, 1440);
  const phone = at(r, 390);
  const lop = desk.find((f: any) => f.check === 'padding' && f.selector === '#lop');
  assert.ok(lop && lop.bottom - lop.top >= 7, JSON.stringify(lop));
  // #small's line-height is pinned (20 px tall with its padding and border): left to the font, it came out
  // 24 px under DejaVu Sans in a person's container, over the 22 px desktop cut, and under it on the host (#458).
  assert.ok(has(desk, 'tap', '#small') && has(phone, 'tap', '#small'), JSON.stringify(desk.concat(phone).filter((f: any) => f.selector === '#small')));
  assert.equal(phone.find((f: any) => f.selector === '#small' && f.check === 'tap').min, 40);
  assert.ok(has(desk, 'clip', '#clip'));
  assert.ok(has(phone, 'overflow', '#wide'));
  const dbl = desk.find((f: any) => f.check === 'double-border');
  assert.ok(dbl && dbl.selector === '#ta' && dbl.outer === '#outer', JSON.stringify(dbl));
  assert.ok(has(desk, 'close-scrolls', '#close'));
  assert.equal(desk.find((f: any) => f.check === 'bare-link' && f.selector === '#bare')?.text, 'https://x.io/a');
  assert.ok(has(desk, 'bare-link', '#tipped'));
  assert.ok(has(desk, 'bare-link', '#tipwrap'), 'a link inside to somewhere else does not make the tooltip\'s address clickable');
  assert.equal(r.ok, false);
});

test('--ignore drops a finding and counts it', { skip }, async () => {
  const r = await measure(opts('/broken', { widths: [1440], ignore: ['padding:#lop'] }));
  assert.ok(!has(at(r, 1440), 'padding', '#lop'));
  assert.ok(r.ignored >= 1);
});

test('--click flags a click that disables the other controls, not one that shows its result', { skip }, async () => {
  const bad = at(await measure(opts('/clicks', { widths: [1440], click: '#bad' })), 1440);
  assert.ok(bad.some((f: any) => f.check === 'click-froze' && f.disabled?.length === 2), JSON.stringify(bad));
  const good = at(await measure(opts('/clicks', { widths: [1440], click: '#good' })), 1440);
  assert.deepEqual(good.filter((f: any) => f.selector === '#good'), []);
});

test("a modal dialog's ✕ that scrolls away is found, and a pinned one isn't", { skip }, async () => {
  assert.ok(has(at(await measure(opts('/modal-static', { widths: [1440] })), 1440), 'close-scrolls', '#x'));
  assert.ok(!has(at(await measure(opts('/modal-sticky', { widths: [1440] })), 1440), 'close-scrolls', '#x'));
});

test('--click also clicks the existing controls: a dead one fails the check, one that works or navigates does not', { skip }, async () => {
  const r = await measure(opts('/sweep', { widths: [1440], click: '#good' }));
  const f = at(r, 1440).filter((x: any) => x.check.startsWith('click'));
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.ok(f[0].check === 'click-no-result' && f[0].selector.includes('#dead'), JSON.stringify(f));
  assert.equal(r.ok, false);
  const sweep = at(await measure(opts('/sweep', { widths: [1440], sweep: true })), 1440);
  assert.ok(has(sweep, 'click-no-result', '#dead') && !has(sweep, 'click-no-result', '#good') && !has(sweep, 'click-no-result', '#leave'), JSON.stringify(sweep));
  const clean = await measure(opts('/clicks', { widths: [1440], sweep: true, ignore: ['click-froze:#bad'] }));
  assert.ok(!has(at(clean, 1440), 'click-no-result', '#good'), JSON.stringify(at(clean, 1440)));
});

test('a tap or overflow finding stops the loop before a critic round; other findings do not', { skip }, async () => {
  const chip = await measure(opts('/chip', { widths: [390] }));
  assert.ok(has(at(chip, 390), 'tap', '#chip36'));
  assert.equal(chip.stop, true);
  assert.equal((await measure(opts('/broken', { widths: [390] }))).stop, true);
  assert.equal((await measure(opts('/clean'))).stop, false);
  assert.equal((await measure(opts('/chip', { widths: [390], ignore: ['tap:#chip36'] }))).stop, false, 'an ignored tap does not stop it');
  assert.equal((await measure(opts('/modal-static', { widths: [1440] }))).stop, false, 'close-scrolls is a finding, not a stop');
});

test('a shot settles first: a spinner is frozen on its first frame and the pointer is off the page controls', { skip }, async () => {
  const browser = launch(bin);
  try {
    const shots: string[] = [];
    for (let i = 0; i < 3; i++) {
      const page = await openPage(browser.send, base + '/busy', 390, { headers: [], cookies: [], settle: 50 });
      try {
        await page.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 385, y: 835 }); // hover the fixed button
        shots.push(readFileSync(await shot(page, join(tmpdir(), `uim-busy-${process.pid}-${i}.png`))).toString('base64'));
        assert.equal(await page.evaluate(`document.getElementById('tip').offsetParent === null && getComputedStyle(document.getElementById('fade')).opacity`), '1');
      } finally { await page.close(); }
    }
    assert.ok(shots.every((x) => x === shots[0]), 'three shots of the same view differ');
  } finally { await browser.close(); }
});

test('sweep: false keeps --click to its one control, and shot() leaves a hover the flow asked for', { skip }, async () => {
  const r = await measure(opts('/sweep', { widths: [1440], click: '#good', sweep: false }));
  assert.equal(at(r, 1440).filter((f: any) => f.check.startsWith('click')).length, 0);
  assert.equal(r.pages[0].sweep, undefined);
  const browser = launch(bin);
  try {
    const page = await openPage(browser.send, base + '/busy', 390, { headers: [], cookies: [], settle: 50 });
    await page.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 385, y: 835 });
    await shot(page, join(tmpdir(), `uim-hover-${process.pid}.png`));
    assert.equal(await page.evaluate(`document.getElementById('tip').offsetParent !== null`), true);
    await page.close();
  } finally { await browser.close(); }
});
