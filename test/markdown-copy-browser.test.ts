// The Copy button on fenced code blocks (ui/markdown.js, #340) in a real browser (headless Chromium,
// test/browser.ts): it copies the code exactly as written (no language tag, no added newline), through
// navigator.clipboard and through the hidden-textarea fallback a plain-http address needs; it sits
// clear of the first line's text; hidden until hover on desktop, always shown on a phone.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, type Browser, type Page, serveUi, skipMessage, type App } from './browser.ts';
import { until } from './wait.ts';

const bin = chromium();
const skip = !bin && skipMessage;

/** PowerShell with indentation, both quotes, a backtick and a trailing blank line inside the fence. */
const CODE = `$ErrorActionPreference = 'Stop'\nif (-not (Test-Path "$env:USERPROFILE\\citadel")) {\n    New-Item -ItemType Directory "$env:USERPROFILE\\citadel" | Out-Null\n\tWrite-Host "it's \`"done\`""\n}\n`;
const SRC = `Run this:\n\n\`\`\`powershell\n${CODE}\n\`\`\`\n\nThen \`inline code\` and front matter-free text.\n\n\`\`\`\none line, long enough to wrap under where a button would sit if it covered the text at all, which it must not\n\`\`\``;

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/ui/base.css">
<style>body{margin:0;padding:16px;font:15px var(--citadel-font);background:var(--citadel-bg);color:var(--citadel-text)}</style>
<div id="out"></div>
<script type="module">
  import { markdownElement, updateMarkdown } from '/ui/markdown.js';
  window.src = ${JSON.stringify(SRC)};
  const md = markdownElement(window.src, { breaks: true });
  document.getElementById('out').append(md);
  Object.assign(window, { md, updateMarkdown });
  window.copies = [];
  document.addEventListener('copy', () => {
    const t = document.activeElement;
    window.copies.push(t instanceof HTMLTextAreaElement ? t.value.slice(t.selectionStart, t.selectionEnd) : String(getSelection()));
  });
  window.useClipboard = (on) => Object.defineProperty(navigator, 'clipboard', { configurable: true,
    value: on ? { writeText: async (t) => { window.copies.push('api:' + t); } } : undefined });
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

async function click(page: Page, selector: string) {
  const { x, y } = await page.centre(selector);
  await page.mouse(x, y);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  await page.eval('new Promise((r) => setTimeout(r, 50))');
}


test('only fenced blocks get a button, and the text of the reply stays the code', { skip }, async () => {
  const page = await browser.page(base, { width: 900, height: 700 });
  assert.equal(await page.eval('md.querySelectorAll("pre > .cui-copy").length'), 2, 'one per fence');
  assert.equal(await page.eval('md.querySelectorAll(":not(pre) > .cui-copy").length'), 0, 'none on inline code');
  assert.equal(await page.eval('md.querySelector("pre > code").textContent'), CODE, 'a blank last line inside the fence is kept; nothing is added');
  assert.ok(!(await page.eval<string>('md.textContent')).includes('Copy'), 'the label is CSS, not text a selection or search picks up');
  assert.equal(await page.eval('md.querySelector(".cui-copy").getAttribute("aria-label")'), 'Copy code');
});

/** Whether the first button is hidden by the (hover: hover) rule: headless Chromium has no hover, so the rule's selector is matched by hand. */
const hoverHides = (page: Page, i = 0) => page.eval<boolean>(`(() => {
  const rule = document.adoptedStyleSheets.flatMap((s) => [...s.cssRules]).find((r) => r.conditionText === '(hover: hover)');
  return md.querySelectorAll('.cui-copy')[${i}].matches(rule.cssRules[0].selectorText) && rule.cssRules[0].style.opacity === '0';
})()`);

test('desktop: copies the code exactly through navigator.clipboard, says Copied, then Copy again', { skip }, async () => {
  const page = await browser.page(base, { width: 900, height: 700 });
  await page.eval('useClipboard(true)');
  assert.equal(await hoverHides(page), false, 'a shell-tagged command block keeps Copy in view (#944)');
  assert.equal(await hoverHides(page, 1), true, 'an untagged block hides it until hover where there is hover');
  await click(page, 'pre .cui-copy');
  assert.deepEqual(await page.eval('window.copies'), [`api:${CODE}`]);
  assert.equal(await page.eval('md.querySelector(".cui-copy").dataset.copied'), 'yes');
  assert.equal(await page.eval('getComputedStyle(md.querySelector(".cui-copy"), "::before").content'), '"Copied"');
  await page.mouse(5, 690);
  assert.equal(await hoverHides(page, 1), true);
  assert.equal(await hoverHides(page), false, 'the feedback stays visible after the pointer leaves');
  await until('the Copied feedback to time out', async () => (await page.eval('md.querySelector(".cui-copy").dataset.copied ?? null')) === null);
  assert.equal(await page.eval('md.querySelector(".cui-copy").dataset.copied ?? null'), null);
  assert.equal(await page.eval('getComputedStyle(md.querySelector(".cui-copy"), "::before").content'), '"Copy"');
  await page.eval('document.activeElement.blur()');
  assert.equal(await hoverHides(page), false, 'a command block stays shown');
});

test('plain http (no navigator.clipboard): the textarea fallback copies the same text, multi-line, indented, quoted', { skip }, async () => {
  const page = await browser.page(base, { width: 900, height: 700 });
  await page.eval('useClipboard(false)');
  await click(page, 'pre .cui-copy');
  assert.deepEqual(await page.eval('window.copies'), [CODE]);
  assert.equal(await page.eval('md.querySelector(".cui-copy").dataset.copied'), 'yes');
  assert.equal(await page.eval('document.querySelectorAll("textarea").length'), 0, 'the textarea is gone again');
});

test('the button keeps clear of the first line, and a streamed redraw keeps the blocks that did not change', { skip }, async () => {
  const page = await browser.page(base, { width: 390, height: 700, touch: true });
  assert.equal(await page.eval('getComputedStyle(md.querySelectorAll(".cui-copy")[1]).opacity'), '1', 'always shown on a phone (no hover)');
  const overlap = await page.eval<number>(`(() => {
    const pre = md.querySelectorAll('pre')[1], b = pre.querySelector('.cui-copy').getBoundingClientRect();
    const r = document.createRange();
    r.selectNodeContents(pre.querySelector('code'));
    return [...r.getClientRects()].filter((c) => c.right > b.left && c.left < b.right && c.bottom > b.top && c.top < b.bottom).length;
  })()`);
  assert.equal(overlap, 0, 'no line of the code sits under the button');
  const pad = await page.eval<number[]>(`(() => { const s = getComputedStyle(md.querySelector('.cui-copy')); return [s.paddingTop, s.paddingBottom]; })()`);
  assert.equal(pad[0], pad[1], 'equal top and bottom padding');
  assert.notEqual(pad[0], '0px');
  await page.eval('(window.first = md.querySelector("pre"), updateMarkdown(md, src + "\\n\\nmore", { breaks: true }))');
  assert.equal(await page.eval('md.querySelector("pre") === window.first'), true, 'an unchanged block, button and all, is kept');
});
