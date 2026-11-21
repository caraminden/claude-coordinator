// A question card's Send, once the picks are complete, is never left under the sticky message box (#879, from
// #867's phone walkthrough: "Send answers" sat under the composer and the only Send on screen sent a chat message).
// Loads the real public/cards.js in a page with a sticky .composer, the card scrolled to the bottom edge, picks an option.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
// @ts-ignore: plain JS from the kit
import { findChrome } from '../kit/skills/critique/scripts/ui-measure.mjs';
import { tempRoot } from './helpers.ts';

const skip = !(process.env.CHROME || findChrome()) && 'no headless Chromium';
const tool = resolve(import.meta.dirname, '..', 'tools', 'ui-shot.ts');
const pub = resolve(import.meta.dirname, '..', 'public');

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/composer.css">
<div id="app"><div style="height:2000px"></div><div id="slot"></div><div style="height:600px"></div>
<div class="composer"><textarea></textarea><div class="row"><button>Send</button></div></div></div>
<script type="module">
  const { setView } = await import('/base.js');
  setView({ kind: 'ticket', id: 1, cards: new Map(), ticket: { kind: 'ticket', project_id: 1 } });
  const { questionCard } = await import('/cards.js');
  const card = { id: 1, questions: [{ question: 'Which?', header: 'Q', options: [{ label: 'A' }, { label: 'B' }] }] };
  document.getElementById('slot').append(questionCard(1, card));
</script>`;

let server: Server;
let url = '';
const tmp = tempRoot('card-send-');
before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    let body: Buffer;
    try {
      body = readFileSync(join(pub, path));
    } catch {
      return void res.writeHead(404).end();
    }
    const type = { '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type }).end(body);
  });
  url = `http://127.0.0.1:${await tmp.serve(server)}/`;
});
after(() => tmp.teardown());

test('picking an option brings the card\'s Send above the sticky composer on a phone', { skip }, async () => {
  const text = await new Promise<string>((ok) => {
    const p = tmp.spawn(process.execPath, [tool, '--url', url, '--anon', '--out', tmp.dir, '--widths', '390',
      '--step', 'wait .qcard .opt',
      '--step', 'eval document.querySelector(".qcard").scrollIntoView({ block: "end" })',
      '--step', 'eval document.querySelector(".qcard .opt").click()',
      '--step', 'sleep 200',
      '--step', 'eval const f = () => { const b = document.querySelector(".qcard .row button:not(.add-image)"); const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { enabled: !b.disabled, onTop: e === b }; }; return f()',
    ], { env: { ...process.env, DEV_URL: '', DEV_COOKIE: '' } });
    let t = '';
    p.stdout.on('data', (d) => (t += d));
    p.stderr.on('data', (d) => (t += d));
    p.on('exit', () => ok(t));
  });
  assert.match(text, /eval: \{"enabled":true,"onTop":true\}/, text);
});
