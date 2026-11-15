// Markdown tables (ui/markdown.js's .cui-md sheet) in a real browser (headless Chromium, test/browser.ts).
// #462: one long `code` token in a cell made the table wider than a narrow panel, and auto table layout
// then squeezed every other column to one word per line (Theory of Crafting's repro, a 372px panel:
// columns 479/69/94 px, rows 173 px tall). Code and links in a cell may now break, so the table fits.
// TABLE_SHOTS=<folder> writes before/after screenshots there.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { themeCss } from '../src/theme.ts';
import { chromium, launch, type Browser, type Page, serveUi, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;
const pub = join(import.meta.dirname, '..', 'public');
const shots = process.env.TABLE_SHOTS;

const WIDE = `| Setting | What it does | Default |
| --- | --- | --- |
| \`soul_extraction_chaos_damage_to_deal_per_minute_against_decayed\` | How much chaos damage the extraction deals each minute to a target that has already decayed | 120 per minute |
| \`soul_extraction_lightning_resistance_penalty_while_channelling\` | Lightning resistance the channeller loses for as long as the extraction runs | minus 15 percent |`;

const LINK = `| Source | Notes |
| --- | --- |
| https://example.com/a/very/long/path/that/goes/on/and/on/without/any/spaces/at/all/index.html | The reference a reviewer cited for the damage numbers |`;

const SHORT = `| Name | Count | Done |
| --- | ---: | --- |
| apples | 3 | yes |
| pears | 12 | no |`;

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/ui/base.css">
<style>body{margin:0;padding:16px;font:15px var(--citadel-font);background:var(--citadel-bg);color:var(--citadel-text)}
#panel{max-width:100%;box-sizing:border-box;padding:12px;border:1px solid var(--citadel-border)}</style>
<div id="panel"></div>
<script type="module">
  import { markdownElement } from '/ui/markdown.js';
  const panel = document.getElementById('panel');
  for (const [id, src] of Object.entries(${JSON.stringify({ wide: WIDE, link: LINK, short: SHORT })})) {
    const md = markdownElement(src);
    md.id = id;
    panel.append(md);
  }
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

interface Layout { scroller: number; table: number; cols: number[]; rows: number[]; line: number }

/** The table in #id: its scroller's and its own width, each column's width, each body row's height, and one line's height. */
const layout = (page: Page, id: string) => page.eval<Layout>(`(() => {
  const md = document.getElementById(${JSON.stringify(id)});
  const t = md.querySelector('table');
  return {
    scroller: md.querySelector('.cui-table').clientWidth,
    table: t.getBoundingClientRect().width,
    cols: [...t.rows[0].cells].map((c) => Math.round(c.getBoundingClientRect().width)),
    rows: [...t.tBodies[0].rows].map((r) => Math.round(r.getBoundingClientRect().height)),
    line: Math.round(t.rows[0].getBoundingClientRect().height),
  };
})()`);

async function open(width: number, panel: number | null, touch = false) {
  const page = await browser.page(base, { width, height: 900, touch });
  if (panel) await page.eval(`document.getElementById('panel').style.width = '${panel}px'`);
  return page;
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
}

for (const [label, width, panel, touch] of [['a 372px side panel', 1366, 372, false], ['a phone', 390, null, true]] as const) {
  test(`${label}: a long code token in a cell breaks, so the table fits and its prose columns keep a readable width`, { skip }, async () => {
    const page = await open(width, panel, touch);
    await shot(page, `table-${touch ? 'phone' : 'panel'}.png`);
    for (const id of ['wide', 'link']) {
      const l = await layout(page, id);
      assert.ok(l.table <= l.scroller + 0.5, `${id}: the table fits its scroller (${l.table} > ${l.scroller})`);
      // The prose column ("What it does", "Notes") was squeezed to 14% of the table before (#462); a share, not pixels, so fonts don't matter.
      const prose = l.cols[1];
      assert.ok(prose >= l.table * 0.3, `${id}: the prose column keeps a readable share: ${l.cols.join('/')}`);
      for (const h of l.rows) assert.ok(h <= l.line * 6, `${id}: no tower rows: ${l.rows.join('/')} (one line is ${l.line})`);
    }
  });
}

test('a wide desktop panel: rows stay short, and a short table is laid out as before', { skip }, async () => {
  const page = await open(1366, 1200);
  await shot(page, 'table-desktop.png');
  const wide = await layout(page, 'wide');
  for (const h of wide.rows) assert.ok(h <= wide.line * 2, `rows of at most two lines, as before: ${wide.rows.join('/')}`);
  const link = await layout(page, 'link');
  assert.ok(link.table < link.scroller, 'a table that fits keeps its URL on one line, at its natural width');
  const narrow = await open(390, null, true);
  for (const p of [page, narrow]) {
    const short = await layout(p, 'short');
    assert.ok(short.table < short.scroller, 'a short table stays its natural width');
    for (const h of short.rows) assert.equal(h, short.line, 'no cell of a short table wraps');
  }
});
