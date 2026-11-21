// tools/ui-shot.ts's steps in a real browser (#643): click, hover, fill, key, wait (for a selector and for text),
// text and eval against a small static page, run as the one command a minion would type; a wrong selector names
// its step and shoots the page; and open() for a script. Skipped without headless Chromium.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
// @ts-ignore: plain JS from the kit
import { findChrome } from '../kit/skills/critique/scripts/ui-measure.mjs';
import { open } from '../tools/ui-shot.ts';
import { tempRoot } from './helpers.ts';

const skip = !(process.env.CHROME || findChrome()) && 'no headless Chromium';
const tool = resolve(import.meta.dirname, '..', 'tools', 'ui-shot.ts');

// Send shows the name field's value in the log after a beat, as a chat shows a sent message.
const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<button id="send">Send</button> <span id="tip">-</span>
<input id="name" value="old"> <div id="log"></div>
<script>
  const $ = (id) => document.getElementById(id);
  $('send').onclick = () => setTimeout(() => $('log').insertAdjacentHTML('beforeend', '<p class="msg">' + $('name').value + '</p>'), 300);
  $('tip').onmouseenter = () => ($('tip').textContent = 'hovered');
  $('name').onkeydown = (e) => { if (e.key === 'Enter') document.title = 'entered ' + e.target.value; };
</script>`;

const tmp = tempRoot('ui-shot-test-');
const out = tmp.dir;
let url = '';
before(async () => {
  const port = await tmp.serve(createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE)));
  url = `http://127.0.0.1:${port}/`;
});
after(() => tmp.teardown());

/** The command a minion types, against the static page; a child we await, so this process keeps serving it. */
function uiShot(...args: string[]) {
  return new Promise<{ code: number | null; text: string }>((ok) => {
    const p = tmp.spawn(process.execPath, [tool, '--url', url, '--anon', '--out', out, ...args], { env: { ...process.env, DEV_URL: '', DEV_COOKIE: '' } });
    let text = '';
    p.stdout.on('data', (d) => (text += d));
    p.stderr.on('data', (d) => (text += d));
    p.on('exit', (code) => ok({ code, text }));
  });
}

test('a flow is one command: fill, click, wait for text, hover, key, text and eval print a line each', { skip }, async () => {
  const r = await uiShot('--widths', '1440,390',
    '--step', 'fill #name | hello there',
    '--step', 'key Enter',
    '--step', 'click #send',
    '--step', 'wait #log .msg | hello there',
    '--step', 'hover #tip',
    '--step', 'text #tip',
    '--step', 'eval document.title',
    '--step', 'eval ({ msgs: document.querySelectorAll(".msg").length })',
    '--step', 'shot sent');
  assert.equal(r.code, 0, r.text);
  for (const w of [1440, 390]) {
    // fill replaced "old"; the click's message came after its delay; hover and the real Enter key reached the page.
    assert.match(r.text, new RegExp(`/ at ${w}: text #tip: "hovered"`));
    assert.match(r.text, new RegExp(`/ at ${w}: eval: "entered hello there"`));
    assert.match(r.text, new RegExp(`/ at ${w}: eval: \\{"msgs":1\\}`));
    assert.ok(existsSync(join(out, `front-${w}-sent.png`)));
  }
});

test('fill with nothing empties the field; type adds to it', { skip }, async () => {
  const r = await uiShot('--widths', '390', '--step', 'type #name |  and more', '--step', 'eval document.getElementById("name").value',
    '--step', 'fill #name |', '--step', 'eval document.getElementById("name").value', '--step', 'shot typed');
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /eval: "old and more"\n[^\n]*eval: ""/);
});

test('a wrong selector fails naming its step, and shoots the page as it was', { skip }, async () => {
  const r = await uiShot('--widths', '390', '--timeout', '2', '--step', 'click #send', '--step', 'wait #log .msg', '--step', 'click #nope', '--step', 'shot never');
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /FAILED \/ at 390, at step 3, click #nope: .*#nope never came/);
  assert.ok(existsSync(join(out, 'front-390-failed.png')), r.text);
  assert.ok(!existsSync(join(out, 'front-390-never.png')));
});

test('wait for text that never comes names the text', { skip }, async () => {
  const r = await uiShot('--widths', '390', '--timeout', '1', '--step', 'wait #tip | never');
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /at step 1, wait #tip \| never: "never" in #tip never came/);
});

test('open() hands a script a ready page with do(), evaluate() and shot()', { skip }, async () => {
  const page = await open('/', { width: 390, args: ['--url', url, '--anon', '--out', out] });
  try {
    assert.deepEqual(await page.do('fill #name | from a script\nclick #send\nwait .msg\ntext .msg'), ['text .msg: "from a script"']);
    assert.equal(await page.evaluate('document.querySelectorAll(".msg").length'), 1);
    assert.equal(await page.shot('script'), join(out, 'front-390-script.png'));
  } finally {
    await page.close();
  }
});
