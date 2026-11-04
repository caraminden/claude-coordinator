// ui/status.js and base.css's cui-status and cui-steady in a real browser (headless Chromium, test/browser.ts): the
// layout-shift check for Cara's rule (2026-11-04, "set up rules that make sure status changes like that dont move
// any UI elements"). Each part cycles through its states while the test records every element's box and the
// page's layout-shift entries; nothing may move. A naive status line (a <p> that's empty until it says something)
// proves the check catches a shift. Apps copy this check (citadel:contraption-ui, "Status line").
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { themeCss } from '../src/theme.ts';
import { chromium, launch, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
const pub = join(import.meta.dirname, '..', 'public');

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/ui/base.css">
<style>body{margin:0;padding:16px;font:15px var(--citadel-font);background:var(--citadel-bg);color:var(--citadel-text)}
.box{width:min(320px,100%)} .row{display:flex;gap:8px;align-items:center} h1,p{margin:0}</style>
<h1 id="above">Above</h1>
<div class="box"><div id="slot"></div></div>
<div class="row"><span id="left">Left</span><span class="box" id="inline-slot"></span><span id="right">Right</span></div>
<div class="row"><button class="cui-btn" id="save"></button><button class="cui-btn cui-primary" id="send"><span class="cui-steady"><span>Send</span><span hidden>Sending…</span></span></button><button class="cui-btn" id="next">Next</button></div>
<p id="below">Below</p>
<p id="naive"></p>
<p id="after-naive">After the naive line</p>
<script type="module">
  import { statusSlot, steadyLabel } from '/ui/status.js';
  import { mountTips } from '/ui/tip.js';
  mountTips(document.body);
  window.slot = statusSlot(document.getElementById('slot'));
  window.inline = statusSlot(document.getElementById('inline-slot'));
  const spin = document.createElement('span');
  spin.className = 'cui-spin';
  const saving = document.createDocumentFragment();
  saving.append(spin, 'Saving…');
  window.save = steadyLabel(document.getElementById('save'), { idle: 'Save', saving, saved: 'Saved', failed: 'Couldn\\'t save, retry' });
  window.shifts = [];
  new PerformanceObserver((l) => window.shifts.push(...l.getEntries().map((e) => e.value))).observe({ type: 'layout-shift', buffered: true });
  window.frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.boxes = () => Object.fromEntries([...document.querySelectorAll('[id]')].map((el) => [el.id, el.getBoundingClientRect().toJSON()]));
  window.ready = true;
</script>`;

let server: Server;
let browser: Browser;
let base = '';

before(async () => {
  if (skip) return;
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (path === '/theme.css') return res.writeHead(200, { 'content-type': 'text/css' }).end(themeCss(readFileSync(join(pub, 'style.css'), 'utf8')));
    const m = /^\/ui\/([a-z-]+\.(js|css))$/.exec(path);
    if (!m) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': m[2] === 'js' ? 'text/javascript' : 'text/css' }).end(readFileSync(join(pub, 'ui', m[1])));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r(null)));
});

type Boxes = Record<string, { x: number; y: number; width: number; height: number }>;
const LONG = 'Saved 14 files to the build folder, rebuilt the passive tree, recalculated every skill';

/** Each change in turn, then every element's box: what moved, by id, against the first state. */
async function moved(page: Page, changes: string[], ignore: string[] = []) {
  // Load-time shifts (the module filling the page) aren't the parts' doing: count from here.
  await page.eval('window.frame().then(() => { window.shifts = []; })');
  const first = await page.eval<Boxes>('window.boxes()');
  const out: string[] = [];
  for (const change of changes) {
    await page.eval(`(${change}, window.frame())`);
    const now = await page.eval<Boxes>('window.boxes()');
    for (const [id, b] of Object.entries(now)) {
      const a = first[id];
      if (ignore.includes(id) || !a) continue;
      if (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) out.push(`${id} after ${change}`);
    }
  }
  return out;
}

for (const [label, opts] of [['desktop', { width: 900, height: 600 }], ['phone, dark', { width: 390, height: 700, touch: true, dark: true }]] as const) {
  test(`${label}: a status line through empty, text, a long text, working, a tone and clear moves nothing`, { skip }, async () => {
    const page = await browser.page(base, opts);
    const steps = [`slot.text('Saved')`, `slot.text(${JSON.stringify(LONG)})`, `slot.working('Saving…')`, `slot.text('Couldn\\'t save', { tone: 'danger' })`, 'slot.clear()',
      `inline.text(${JSON.stringify(LONG)})`, `inline.working()`, 'inline.clear()'];
    // The lines' own children come and go; the lines themselves and everything else stay put.
    assert.deepEqual(await moved(page, steps, ['naive']), []);
    assert.deepEqual(await page.eval('window.shifts'), [], 'no layout-shift entries');
    assert.equal(await page.eval('document.querySelector("#slot").getBoundingClientRect().height'), 22, 'empty, it still takes its 22 px');
  });

  test(`${label}: a steady label through each of its labels keeps its width`, { skip }, async () => {
    const page = await browser.page(base, opts);
    const steps = [`save.set('saving')`, `save.set('saved')`, `save.set('failed')`, `save.set('idle')`,
      `document.querySelector('#send .cui-steady').children[0].hidden = true, document.querySelector('#send .cui-steady').children[1].hidden = false`];
    assert.deepEqual(await moved(page, steps), []);
    assert.deepEqual(await page.eval('window.shifts'), []);
  });
}

test('the check catches a naive status line that pushes the page down', { skip }, async () => {
  const page = await browser.page(base);
  const out = await moved(page, [`document.getElementById('naive').textContent = 'Saved'`]);
  assert.ok(out.includes(`after-naive after document.getElementById('naive').textContent = 'Saved'`), out.join('\n'));
  assert.ok((await page.eval<number[]>('window.shifts')).length > 0, 'and Chromium reports the layout shift');
});

test('a steady label shows one label to the eye and the screen reader; the button is named by it', { skip }, async () => {
  const page = await browser.page(base);
  await page.eval(`save.set('saving')`);
  assert.equal(await page.eval('save.current'), 'saving');
  assert.equal(await page.eval('[...document.querySelectorAll("#save [data-label]")].filter((s) => getComputedStyle(s).visibility === "visible").map((s) => s.dataset.label).join()'), 'saving');
  const { nodes } = await page.send('Accessibility.getPartialAXTree', { backendNodeId: (await page.send('DOM.describeNode', { objectId: (await page.send('Runtime.evaluate', { expression: 'document.getElementById("save")' })).result.objectId })).node.backendNodeId, fetchRelatives: false });
  assert.equal(nodes[0].name.value, 'Saving…');
  await assert.rejects(page.eval(`save.set('nope')`), /no label "nope"/);
});

test('a cut-off status shows its whole text in a tip on hover; one that fits shows none', { skip }, async () => {
  const page = await browser.page(base);
  const tip = () => page.eval<string | null>('[...document.querySelectorAll(".cui-tip")].find((p) => p.matches(":popover-open"))?.textContent ?? null');
  await page.eval(`slot.text(${JSON.stringify(LONG)})`);
  assert.equal(await page.eval('getComputedStyle(document.querySelector("#slot .cui-status-text")).textOverflow'), 'ellipsis');
  let c = await page.centre('#slot .cui-status-text');
  await page.mouse(c.x, c.y);
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(await tip(), LONG);
  await page.mouse(5, 590);
  await new Promise((r) => setTimeout(r, 250));
  await page.eval(`slot.text('Saved')`);
  c = await page.centre('#slot .cui-status-text');
  await page.mouse(c.x, c.y);
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(await tip(), null);
});

test('the working state is a spinner and its words; a tone sets data-tone; role="status" is kept', { skip }, async () => {
  const page = await browser.page(base);
  await page.eval(`slot.working()`);
  assert.equal(await page.eval('document.querySelector("#slot").innerHTML'), '<span class="cui-spin" aria-hidden="true"></span><span class="cui-status-text" data-tip="Working…" data-tip-overflow="">Working…</span>');
  await page.eval(`slot.text('Nope', { tone: 'danger' })`);
  assert.equal(await page.eval('document.querySelector("#slot").dataset.tone'), 'danger');
  await page.eval(`slot.text('Fine')`);
  assert.equal(await page.eval('document.querySelector("#slot").dataset.tone ?? null'), null);
  assert.equal(await page.eval('document.querySelector("#slot").getAttribute("role")'), 'status');
});
