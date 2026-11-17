// ui/media.js in a real browser (headless Chromium, test/browser.ts), #833: the scrubber's pins go out through its
// callbacks and come back through update(), the panner pans and pauses, and the lightbox steps with ←/→ and says so.
// The page carries the img and button resets most apps have (Tailwind's preflight), which the parts have to survive.
// The media are the design-system demo's code-made ones (docs/design-system/media), never a real app's.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { themeCss } from '../src/theme.ts';
import { chromium, launch, serve, skipMessage, waitFor, type App, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;
const root = join(import.meta.dirname, '..');

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/ui/base.css">
<style>img,video{max-width:100%;height:auto}button{color:inherit}body{margin:0;font:15px var(--citadel-font);background:var(--citadel-bg);color:var(--citadel-text)}#box{display:flex;flex-direction:column;width:600px;height:420px}</style>
<div id="box"></div><textarea id="field"></textarea>
<script type="module">
  import * as media from '/ui/media.js';
  // A blob URL, so the clip seeks without the test server answering range requests.
  window.clip = URL.createObjectURL(await (await fetch('/media/clip.webm')).blob());
  window.log = [];
  Object.assign(window, media);
  window.ready = true;
</script>`;

let app: App;
let browser: Browser;

before(async () => {
  if (skip) return;
  app = await serve((path, res) => {
    if (path === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (path === '/theme.css') return void res.writeHead(200, { 'content-type': 'text/css' }).end(themeCss(readFileSync(join(root, 'public', 'style.css'), 'utf8')));
    const ui = /^\/ui\/([a-z-]+\.(js|css))$/.exec(path);
    if (ui) return void res.writeHead(200, { 'content-type': ui[2] === 'js' ? 'text/javascript' : 'text/css' }).end(readFileSync(join(root, 'public', 'ui', ui[1])));
    const m = /^\/media\/([a-z0-9-]+\.(webm|svg))$/.exec(path);
    if (m) return void res.writeHead(200, { 'content-type': m[2] === 'svg' ? 'image/svg+xml' : 'video/webm' }).end(readFileSync(join(root, 'docs', 'design-system', 'media', m[1])));
    res.writeHead(404).end();
  });
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await app?.close();
});

const KEYS: Record<string, [string, number]> = { ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], a: ['KeyA', 65], s: ['KeyS', 83], e: ['KeyE', 69], ' ': ['Space', 32] };
/** A real key press on whatever has focus. */
async function press(page: Page, key: string) {
  const [code, vk] = KEYS[key];
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text: key.length === 1 ? key : undefined });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
}
/** Let the page draw n frames: long enough for a running pan to have moved. */
const frames = (page: Page, n = 12) => page.eval(`new Promise((r) => { let i = ${n}; const f = () => (--i ? requestAnimationFrame(f) : r(true)); requestAnimationFrame(f); })`);
async function click(page: Page, selector: string) {
  const { x, y } = await page.centre(selector);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

/** A clip in #box with a scrubber, its pins logged as they go out. */
async function clipPage(opts = '{}') {
  const page = await browser.page(app.base, { width: 700, height: 600 });
  await page.eval(`(() => {
    const v = document.createElement('video'); v.src = clip; v.muted = true; box.append(v);
    window.s = scrubber(v, { onStart: (ms) => log.push(['start', ms]), onEnd: (ms) => log.push(['end', ms]), ...${opts} });
    box.append(s.el);
  })()`);
  await waitFor(page, 'the clip to load', `document.querySelector('.cui-scrub-time').textContent.endsWith('/ 0:08')`);
  return page;
}

test('scrubber: a Start pin comes in, the clip opens there, and pins go out through the callbacks', { skip }, async () => {
  const page = await clipPage('{ start: 2000 }');
  await waitFor(page, 'the seek to the Start pin', `Math.abs(s.video.currentTime - 2) < 0.05`);
  assert.equal(await page.eval(`document.querySelector('.cui-scrub-pins text').textContent`), 'Start 0:02');
  assert.equal(await page.eval(`document.querySelectorAll('.cui-scrub-frame').length`), 10);
  assert.equal(await page.eval(`document.querySelector('.cui-scrub-frame:nth-child(6)').getAttribute('aria-label')`), 'Go to 0:04');

  // The End pin at 1 s, before the Start: the Start goes, and both changes are reported.
  await page.eval(`s.seek(1)`);
  await click(page, '.cui-scrub-pin ~ .cui-scrub-pin');
  assert.deepEqual(await page.eval('log'), [['start', null], ['end', 1000]]);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll('.cui-scrub-pins text')].map((t) => t.textContent)`), ['End 0:01']);

  // S on the seek bar pins the Start at the playhead; the part draws it at once and stores nothing else.
  await page.eval(`s.seek(0.5); document.querySelector('.cui-scrub-range').focus()`);
  await press(page, 's');
  assert.deepEqual((await page.eval<unknown[]>('log')).at(-1), ['start', 500]);

  // The app rolls a failed save back with update(); Clear reports both pins gone.
  await page.eval(`s.update({ start: null })`);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll('.cui-scrub-pins text')].map((t) => t.textContent)`), ['End 0:01']);
  await page.eval(`log.length = 0`);
  await click(page, '.cui-scrub-acts .cui-ghost:last-child');
  assert.deepEqual(await page.eval('log'), [['end', null]], 'only the pin that was there is cleared');
});

test('scrubber: ←/→ on the seek bar step a second and stay there; a file that will not play says so', { skip }, async () => {
  const page = await clipPage();
  await page.eval(`window.bubbled = 0; addEventListener('keydown', () => bubbled++); s.seek(3); document.querySelector('.cui-scrub-range').focus()`);
  await press(page, 'ArrowRight');
  await waitFor(page, 'the step', `Math.abs(s.video.currentTime - 4) < 0.05`);
  await waitFor(page, 'the thumb to follow with the seek bar focused', `Math.abs(Number(document.querySelector('.cui-scrub-range').value) - 4) < 0.05`);
  assert.equal(await page.eval('bubbled'), 0, 'a lightbox around it does not see the arrow');

  await page.eval(`(() => {
    const v = document.createElement('video'); v.src = '/missing.webm'; box.append(v);
    window.bad = scrubber(v); box.append(bad.el);
  })()`);
  await waitFor(page, 'the failure notice', `!bad.el.querySelector('.cui-scrub-fail').hidden`);
  assert.equal(await page.eval(`bad.el.querySelector('.cui-scrub-play').disabled`), true);
});

test('panner: a wide picture pans and the slider looks around; reduced motion starts paused; one that fits shows whole', { skip }, async () => {
  const page = await browser.page(app.base, { width: 700, height: 600 });
  await page.eval(`(() => { const i = new Image(); i.src = '/media/panorama.svg'; box.append(i); window.p = panner(i); })()`);
  await waitFor(page, 'the panorama to load and move', `p.el.querySelector('.cui-pan-view').scrollLeft > 5`);
  assert.equal(await page.eval(`p.el.classList.contains('cui-pan-fits')`), false);
  assert.equal(await page.eval(`p.img.offsetHeight === p.el.querySelector('.cui-pan-view').clientHeight`), true, 'the page\'s img { height: auto } leaves it the box\'s height');
  await page.eval(`p.look(1)`);
  assert.equal(await page.eval(`(() => { const v = p.el.querySelector('.cui-pan-view'); return Math.abs(v.scrollLeft - (v.scrollWidth - v.clientWidth)) <= 1; })()`), true, 'look(1) is the right end');
  assert.equal(await page.eval(`p.el.querySelector('.cui-pan-bar .cui-btn').getAttribute('aria-label')`), 'Pan', 'looking pauses');
  const at = await page.eval(`p.el.querySelector('.cui-pan-view').scrollLeft`);
  await frames(page);
  assert.equal(await page.eval(`p.el.querySelector('.cui-pan-view').scrollLeft`), at, 'paused stays put');

  const reduced = await browser.page(app.base, { width: 700, height: 600 });
  await reduced.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await reduced.eval(`(() => { const i = new Image(); i.src = '/media/panorama.svg'; box.append(i); window.p = panner(i); })()`);
  await waitFor(reduced, 'the panorama to load', `p.img.complete`);
  await frames(reduced);
  assert.equal(await reduced.eval(`p.el.querySelector('.cui-pan-view').scrollLeft`), 0, 'reduced motion: no pan until asked');
  assert.equal(await reduced.eval(`p.el.querySelector('.cui-pan-bar .cui-btn').getAttribute('aria-label')`), 'Pan');

  await page.eval(`(() => { box.replaceChildren(); const i = new Image(); i.src = '/media/screen-1.svg'; box.append(i); window.q = panner(i); })()`);
  await waitFor(page, 'a picture that fits to show whole', `q.el.classList.contains('cui-pan-fits')`);
});

test('lightbox: ←/→ step and wrap, the app hears of a person\'s move but not of its own go(); keys in a field stay there', { skip }, async () => {
  const page = await browser.page(app.base, { width: 700, height: 600 });
  await page.eval(`window.lb = lightbox([{ src: '/media/screen-1.svg' }, { src: clip, kind: 'video' }, { src: '/media/screen-2.svg', caption: 'Minions' }],
    { into: box, onChange: (i) => log.push(i) })`);
  assert.equal(await page.eval(`document.querySelector('.cui-lb-count').textContent`), '1 / 3');
  await press(page, 'ArrowRight');
  assert.equal(await page.eval('lb.at'), 1);
  assert.equal(await page.eval(`!!document.querySelector('.cui-lb-stage .cui-scrubber')`), true, 'a clip gets the scrubber');
  assert.equal(await page.eval(`getComputedStyle(document.querySelector('.cui-lb-next svg')).color`), 'rgb(255, 255, 255)', 'the page\'s button { color: inherit } leaves the arrow white on its scrim');
  await press(page, 'ArrowLeft');
  await press(page, 'ArrowLeft');
  assert.equal(await page.eval('lb.at'), 2, 'wraps round');
  assert.deepEqual(await page.eval('log'), [1, 0, 2]);
  assert.equal(await page.eval(`document.querySelector('.cui-lb-thumb[aria-current="true"]').getAttribute('aria-label')`), '3: Minions');

  await page.eval(`lb.go(0)`);
  assert.deepEqual(await page.eval('log'), [1, 0, 2], 'go() is quiet');
  await page.eval(`field.focus()`);
  await press(page, 'ArrowRight');
  assert.equal(await page.eval('lb.at'), 0, 'an arrow in a text field moves its caret, not the lightbox');

  // Without `into` it is a kit dialog; Escape closes it and the app hears.
  await page.eval(`lb.destroy(); window.shut = 0; window.d = lightbox([{ src: '/media/screen-1.svg' }], { onClose: () => shut++ })`);
  assert.equal(await page.eval(`document.querySelector('dialog.cui-dialog.cui-lightbox').open`), true);
  assert.equal(await page.eval(`d.el.classList.contains('cui-lb-one') || !!d.el.querySelector('.cui-lb-one')`), true, 'one item: no strip or ‹ ›');
  await page.key('Escape');
  await waitFor(page, 'the dialog to close', `shut === 1 && !document.querySelector('dialog.cui-lightbox')`);
});

// ———————————————————————————————————————————————————————— TripPresenter's gaps (#897)

const PAN = (opts: string, pic = 'panorama') => `(() => { const i = new Image(); i.src = '/media/${pic}.svg'; box.append(i); window.p = panner(i, ${opts}); })()`;

test('panner: once pans one leg and reports progress and the end; onPause hears a person, not the app', { skip }, async () => {
  const page = await browser.page(app.base, { width: 700, height: 600 });
  await page.eval(PAN(`{ pan: 'ltr', once: true, duration: 400, onLeg: (n) => log.push(['leg', n]), onProgress: (f) => log.push(['p', f]), onPause: (b) => log.push(['pause', b]) }`));
  await waitFor(page, 'the leg to end', `log.some((e) => e[0] === 'leg')`);
  await frames(page);
  assert.deepEqual((await page.eval<unknown[][]>('log')).filter((e) => e[0] === 'leg'), [['leg', 1]], 'once: one leg, once');
  const ps = (await page.eval<unknown[][]>('log')).filter((e) => e[0] === 'p').map((e) => e[1] as number);
  assert.equal(ps.at(-1), 1);
  assert.deepEqual([...ps].sort((a, b) => a - b), ps, 'progress only climbs within the leg');
  assert.equal(await page.eval(`p.el.querySelector('.cui-pan-bar .cui-btn').getAttribute('aria-label')`), 'Pan', 'it stops at the end');
  assert.equal(await page.eval(`(() => { const v = p.el.querySelector('.cui-pan-view'); return Math.abs(v.scrollLeft - (v.scrollWidth - v.clientWidth)) <= 1; })()`), true);
  assert.equal((await page.eval<unknown[][]>('log')).some((e) => e[0] === 'pause'), false, 'the part\'s own stop is not a person\'s Pause');

  await page.eval(`log.length = 0; p.play(); p.pause()`);
  assert.deepEqual(await page.eval('log'), [], 'the app\'s play() and pause() stay quiet');
  await click(page, '.cui-pan-bar .cui-btn');
  await click(page, '.cui-pan-bar .cui-btn');
  assert.deepEqual((await page.eval<unknown[][]>('log')).filter((e) => e[0] === 'pause'), [['pause', false], ['pause', true]], 'Pan then Pause');
  await page.eval(`log.length = 0; p.play()`);
  await page.eval(`p.el.querySelector('.cui-pan-view').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  assert.deepEqual((await page.eval<unknown[][]>('log')).filter((e) => e[0] === 'pause'), [['pause', true]], 'a press on the picture pauses, and says so once');
});

test('panner: fits and onFit say whether the picture shows whole; the overlay sits over it, above the bar', { skip }, async () => {
  const page = await browser.page(app.base, { width: 700, height: 600 });
  await page.eval(PAN(`{ onFit: (f) => log.push(['fit', f]) }`));
  await waitFor(page, 'the fit to be known', `log.length > 0`);
  assert.deepEqual(await page.eval('log'), [['fit', false]]);
  assert.equal(await page.eval('p.fits'), false);
  const o = await page.eval<{ inside: boolean; above: boolean; through: string }>(`(() => {
    const r = p.overlay.getBoundingClientRect(), v = p.el.querySelector('.cui-pan-view').getBoundingClientRect(), b = p.el.querySelector('.cui-pan-bar').getBoundingClientRect();
    return { inside: r.width === v.width && r.height === v.height && r.top === v.top, above: r.bottom <= b.top, through: getComputedStyle(p.overlay).pointerEvents };
  })()`);
  assert.deepEqual(o, { inside: true, above: true, through: 'none' });
  await page.eval(`log.length = 0; box.replaceChildren(); ${PAN(`{ onFit: (f) => log.push(['fit', f]) }`, 'screen-1')}`);
  await waitFor(page, 'a picture that fits', `p.fits`);
  assert.deepEqual(await page.eval('log'), [['fit', true]]);
});

test('scrubber: order refuse keeps the old pins and says so; stopAtEnd false plays on past End', { skip }, async () => {
  const page = await clipPage(`{ start: 2000, order: 'refuse', onRefuse: (w, ms) => log.push(['refuse', w, ms]) }`);
  await page.eval(`s.seek(1)`);
  await click(page, '.cui-scrub-pin ~ .cui-scrub-pin');
  assert.deepEqual(await page.eval('log'), [['refuse', 'end', 1000]], 'no pin dropped, no pin set');
  assert.deepEqual(await page.eval(`[...document.querySelectorAll('.cui-scrub-pins text')].map((t) => t.textContent)`), ['Start 0:02']);

  const free = await clipPage(`{ end: 600, stopAtEnd: false }`);
  await free.eval(`s.seek(0.2); s.toggle()`);
  await waitFor(free, 'play past the End', `s.video.currentTime > 1 && !s.video.paused`);
  await free.eval(`s.toggle()`);
  const held = await clipPage(`{ end: 600 }`);
  await held.eval(`s.seek(0.2); s.toggle()`);
  await waitFor(held, 'the End to stop it', `s.video.paused && Math.abs(s.video.currentTime - 0.6) < 0.05`);
});

test('scrubber: pinKeys move or drop the pin keys, and the tooltip names only the keys that work', { skip }, async () => {
  const page = await clipPage(`{ pinKeys: { start: 'a', end: null } }`);
  const tips = await page.eval<string[]>(`[...document.querySelectorAll('.cui-scrub-pin')].map((b) => b.dataset.tip)`);
  assert.match(tips[0], /\(A\)$/);
  assert.doesNotMatch(tips[1], /\(/);
  await page.eval(`s.seek(1); document.querySelector('.cui-scrub-range').focus()`);
  await press(page, 's');
  await press(page, 'e');
  assert.deepEqual(await page.eval('log'), [], 'S and E no longer pin');
  await press(page, 'a');
  assert.deepEqual(await page.eval('log'), [['start', 1000]]);
  const off = await clipPage(`{ pinKeys: false }`);
  assert.equal(await off.eval(`[...document.querySelectorAll('.cui-scrub-pin')].some((b) => /\\(/.test(b.dataset.tip))`), false);
  await off.eval(`s.seek(1); document.querySelector('.cui-scrub-range').focus()`);
  await press(off, 's');
  assert.deepEqual(await off.eval('log'), []);
});

test('scrubber: onUser hears a person\'s play, pause and seek, never the app\'s own', { skip }, async () => {
  const page = await clipPage(`{ onUser: (kind, sec) => log.push([kind, sec == null ? null : Math.round(sec)]) }`);
  await page.eval(`s.seek(3); s.toggle(); s.toggle()`);
  assert.deepEqual(await page.eval('log'), [], 'the app\'s own calls are quiet');
  await click(page, '.cui-scrub-play');
  await click(page, '.cui-scrub-play');
  await page.eval(`(() => { const r = document.querySelector('.cui-scrub-range'); r.value = '5'; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.deepEqual(await page.eval('log'), [['play', null], ['pause', null], ['seek', 5]]);
});

test('scrubber: Play after the end goes back to the Start pin when there is no End', { skip }, async () => {
  const page = await clipPage(`{ start: 2000 }`);
  await page.eval(`s.seek(8)`);
  await page.eval(`s.toggle()`);
  await waitFor(page, 'the replay to start at the Start pin', `s.video.currentTime >= 2 && s.video.currentTime < 3`);
  await page.eval(`s.toggle()`);
});

test('tap targets: the panner\'s Look around and the scrubber\'s seek bar are at least 24 px (desktop) and 40 px (phone) tall', { skip }, async () => {
  for (const [width, min] of [[900, 24], [390, 40]]) {
    const page = await browser.page(app.base, { width, height: 800 });
    await page.eval(`(() => { const v = document.createElement('video'); v.src = clip; box.append(v); window.s = scrubber(v); box.append(s.el); })()`);
    const pan = await browser.page(app.base, { width, height: 800 });
    await pan.eval(PAN(`{}`));
    await waitFor(pan, 'the panorama to load', `p.img.complete && !p.fits`);
    const h = [await pan.eval<number>(`document.querySelector('.cui-pan-look').getBoundingClientRect().height`), await page.eval<number>(`document.querySelector('.cui-scrub-range').getBoundingClientRect().height`)];
    assert.ok(h.every((x) => x >= min), `${width}px wide: ${h} ≥ ${min}`);
  }
});
