#!/usr/bin/env node
// ui-measure: the measurable half of the ui-screenshots rubric. Loads each page in headless Chromium at
// desktop 1440 and phone 390 and reports, as JSON, what a screenshot hides from a model's eye:
//   padding        text or an icon in a box, bar, button, row or chip with unequal or zero room above and below
//   tap            a control shorter than --citadel-control-h on a phone (24 px each way on desktop)
//   overflow       anything that makes the page scroll sideways
//   clip           text cut off by its box, or spilling out of it
//   double-border  an element and one inside it both drawing a line on the same edge
//   close-scrolls  an open dialog whose close button scrolls away with its body
//   bare-link      a URL or DOI shown as plain text, or only in a title or data-tip (outside code)
//   click-*        with --click: a click that shows nothing at once, or disables or covers other controls
// Each finding names a selector and the numbers. Exit 0 clean, 1 findings, 2 a usage or browser error.
// No installs: it drives Playwright's chrome-headless-shell (or --chrome) over the DevTools protocol on a
// pipe, so it opens no port. Usage: node ui-measure.mjs --help
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HELP = `node ui-measure.mjs <url> [<url>...] [options]

  --widths 1440,390      viewport widths; 800 and under is a phone (touch, control-h tap targets)
  --shots <dir>          save a PNG of the window per url and width (and one after each --click)
  --wait <selector>      wait for this element before measuring (default: load, fonts, --settle)
  --settle <ms>          extra wait after load (default 400)
  --before <js>          run this in the page before measuring (open a dialog, fill a list)
  --scope <selector>     measure only inside these (the part your change touched); sideways scroll stays page-wide
  --click <selector>     click it with the network slowed to 3 s and check rule 23 (once per width)
  --cookie <name=value>  set a cookie for each url's host (repeatable)
  --header <Name: value> send this header with every request (repeatable)
  --ignore <check:text>  drop findings of that check whose selector contains text (repeatable);
                         list each one you ignore under "Not fixed" with its reason
  --min-tap <px>         phone tap height (default: the page's --citadel-control-h, else --control-h, else 40)
  --dark                 prefers-color-scheme: dark
  --chrome <path>        the browser (default: newest chrome-headless-shell in ~/.cache/ms-playwright)
  --out <file>           write the JSON there instead of stdout`;

function args(argv) {
  const o = { urls: [], widths: [1440, 390], settle: 400, cookies: [], headers: [], ignore: [], dark: false };
  const many = { '--cookie': 'cookies', '--header': 'headers', '--ignore': 'ignore' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--help' || a === '-h') return null;
    else if (many[a]) o[many[a]].push(val());
    else if (a === '--widths') o.widths = val().split(',').map(Number);
    else if (a === '--shots') o.shots = resolve(val());
    else if (a === '--wait') o.wait = val();
    else if (a === '--settle') o.settle = Number(val());
    else if (a === '--before') o.before = val();
    else if (a === '--click') o.click = val();
    else if (a === '--scope') o.scope = val();
    else if (a === '--min-tap') o.minTap = Number(val());
    else if (a === '--dark') o.dark = true;
    else if (a === '--chrome') o.chrome = val();
    else if (a === '--out') o.out = resolve(val());
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.urls.push(a);
  }
  if (!o.urls.length) throw new Error('give at least one url');
  if (o.widths.some((w) => !(w > 0))) throw new Error('--widths takes numbers, like 1440,390');
  if (!(o.settle >= 0) || (o.minTap !== undefined && !(o.minTap > 0))) throw new Error('--settle and --min-tap take numbers');
  for (const [k, sep] of [['cookies', '='], ['headers', ':'], ['ignore', ':']]) {
    const bad = o[k].find((v) => !v.includes(sep));
    if (bad) throw new Error(`--${k === 'cookies' ? 'cookie' : k === 'headers' ? 'header' : k} ${bad}: needs a "${sep}"`);
  }
  return o;
}

export function findChrome() {
  const cache = join(homedir(), '.cache', 'ms-playwright');
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium_headless_shell-\d+$/.test(d)) : [];
  dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    const bin = join(cache, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (existsSync(bin)) return bin;
  }
  return null;
}

// --- the browser, over --remote-debugging-pipe -------------------------------------------------------

function launch(bin) {
  const dir = mkdtempSync(join(tmpdir(), 'ui-measure-'));
  const chrome = spawn(bin, ['--headless', '--remote-debugging-pipe', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let log = '';
  chrome.stderr.on('data', (d) => (log += d));
  const [input, output] = [chrome.stdio[3], chrome.stdio[4]];
  const pending = new Map();
  let next = 0;
  let gone = null;
  chrome.once('exit', (code) => {
    gone = new Error(`Chromium exited (code ${code}): ${log.slice(-1500)}`);
    for (const p of pending.values()) p.no(gone);
  });
  let buf = '';
  output.setEncoding('utf8');
  output.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\0')) >= 0; buf = buf.slice(i + 1)) {
      const m = JSON.parse(buf.slice(0, i));
      const p = m.id && pending.get(m.id);
      if (!p) continue;
      pending.delete(m.id);
      if (m.error) p.no(new Error(`DevTools ${m.error.message}`));
      else p.ok(m.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
    if (gone) return no(gone);
    pending.set(++next, { ok, no });
    input.write(JSON.stringify({ id: next, method, params, sessionId }) + '\0');
  });
  const close = async () => {
    if (chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill();
      await new Promise((r) => chrome.once('exit', r));
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { send, close };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPage(send, url, width, o) {
  const phone = width <= 800;
  const height = phone ? 844 : 900;
  const { browserContextId } = await send('Target.createBrowserContext');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params = {}) => send(method, params, sessionId);
  await s('Runtime.enable');
  await s('Page.enable');
  await s('Network.enable');
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: phone ? 2 : 1, mobile: phone });
  if (phone) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: o.dark ? 'dark' : 'light' }] });
  if (o.headers.length) {
    const headers = Object.fromEntries(o.headers.map((h) => [h.slice(0, h.indexOf(':')).trim(), h.slice(h.indexOf(':') + 1).trim()]));
    await s('Network.setExtraHTTPHeaders', { headers });
  }
  for (const c of o.cookies) {
    const eq = c.indexOf('=');
    await s('Network.setCookie', { name: c.slice(0, eq), value: c.slice(eq + 1), url });
  }
  const evaluate = async (expression) => {
    const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const nav = await s('Page.navigate', { url });
  if (nav.errorText) throw new Error(`${url}: ${nav.errorText}`);
  const until = async (expr, what) => {
    for (const end = Date.now() + 15_000; !(await evaluate(expr).catch(() => false)); await sleep(50)) {
      if (Date.now() > end) throw new Error(`${url} at ${width}: ${what} never came`);
    }
  };
  await sleep(50);
  await until(`document.readyState === 'complete' && location.href !== 'about:blank'`, 'the load');
  await evaluate('document.fonts.ready.then(() => true)');
  if (o.wait) await until(`!!document.querySelector(${JSON.stringify(o.wait)})`, o.wait);
  if (o.before) await evaluate(`(async () => { ${o.before} })()`);
  await sleep(o.settle);
  return { s, evaluate, phone, width, height, close: () => send('Target.disposeBrowserContext', { browserContextId }) };
}

// What a person sees first, at the window's size: a full-page capture misplaces fixed bars and makes a
// phone shot thousands of pixels tall. Scroll with --before to shoot further down.
async function shot(page, file) {
  const { data } = await page.s('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

// --- what runs in the page ---------------------------------------------------------------------------

function inPage(opts) {
  const TOL = 2; // px: top and bottom room may differ by this much before it's a finding
  const out = [];
  const truncated = [];
  const vw = document.documentElement.clientWidth;
  const css = (el) => getComputedStyle(el);
  const visible = (el) => !el.checkVisibility || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true });
  const r1 = (n) => Math.round(n * 10) / 10;
  const snip = (t) => (t || '').replace(/\s+/g, ' ').trim().slice(0, 40);

  const sel = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
      if (e.id && document.querySelectorAll(`#${CSS.escape(e.id)}`).length === 1) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
      let p = e.localName + [...e.classList].slice(0, 3).map((c) => `.${CSS.escape(c)}`).join('');
      const sibs = e.parentElement ? [...e.parentElement.children].filter((x) => x.localName === e.localName) : [];
      if (sibs.length > 1) p += `:nth-of-type(${sibs.indexOf(e) + 1})`;
      parts.unshift(p);
      if (e === document.body) break;
    }
    return parts.join(' > ');
  };
  // The same selector without positions, so 40 identical rows read as one finding with a count.
  const shape = (s) => s.replace(/:nth-of-type\(\d+\)/g, '');

  const alpha = (c) => {
    if (!c || c === 'transparent') return 0;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const p = m[1].split(/[ ,/]+/).filter(Boolean);
    return p.length > 3 ? parseFloat(p[3]) : 1;
  };
  const bgCache = new Map();
  const bgOf = (el) => {
    if (!el) return 'rgb(255, 255, 255)';
    if (bgCache.has(el)) return bgCache.get(el);
    const c = css(el).backgroundColor;
    const v = alpha(c) > 0.05 ? c : bgOf(el.parentElement);
    bgCache.set(el, v);
    return v;
  };
  const edge = (s, side) => parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== 'none' && s[`border${side}Style`] !== 'hidden' && alpha(s[`border${side}Color`]) > 0.05;
  const boxCache = new Map();
  // A box: something with a visible boundary above and below its content (its own background, borders
  // top and bottom, a shadow), the "box, bar, button, row or chip" of the padding rule. A lone rule line
  // (a separator) isn't one: the room on its open side has nothing to measure against.
  const isBox = (el) => {
    if (boxCache.has(el)) return boxCache.get(el);
    const s = css(el);
    const v = (alpha(s.backgroundColor) > 0.05 && s.backgroundColor !== bgOf(el.parentElement)) || s.backgroundImage !== 'none' || (edge(s, 'Top') && edge(s, 'Bottom')) || s.boxShadow !== 'none';
    boxCache.set(el, v);
    return v;
  };
  const FIELDS = new Set(['input', 'select', 'textarea']);
  const MEDIA = new Set(['svg', 'img', 'canvas', 'video', 'picture', 'progress', 'meter', 'input', 'select', 'textarea']);
  const contentRects = (box) => {
    const rects = [];
    const walk = (node) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 3) {
          if (!ch.data.trim()) continue;
          const r = document.createRange();
          r.selectNodeContents(ch);
          for (const x of r.getClientRects()) if (x.width > 0 && x.height > 0) rects.push({ x, own: true });
        } else if (ch.nodeType === 1) {
          const s = css(ch);
          if (s.display === 'none' || s.position === 'absolute' || s.position === 'fixed' || !visible(ch)) continue;
          if (MEDIA.has(ch.localName) || isBox(ch)) {
            const x = ch.getBoundingClientRect();
            if (x.width > 0 && x.height > 0) rects.push({ x, own: !isBox(ch) });
          } else walk(ch);
        }
      }
    };
    walk(box);
    return rects;
  };

  // --scope: only what sits inside these (the part a change touched); sideways scroll is still page-wide.
  const inScope = (el) => !opts.scope || el.closest(opts.scope);
  const all = [...document.body.querySelectorAll('*')].filter((el) => !['script', 'style', 'template', 'noscript', 'br'].includes(el.localName) && inScope(el));

  // 1. padding
  for (const el of all) {
    if (!isBox(el) || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height <= 0 || r.width <= 0 || r.height > 160 || el.localName === 'td' || el.localName === 'th') continue;
    const s = css(el);
    if (s.display === 'inline') continue; // inline code or a highlight: its padding doesn't size the line
    let top, bottom;
    if (FIELDS.has(el.localName)) {
      if (el.localName === 'textarea' || ['checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden'].includes(el.type)) continue;
      top = parseFloat(s.paddingTop);
      bottom = parseFloat(s.paddingBottom);
      if (Math.abs(top - bottom) <= TOL) continue; // a field centres its line itself; only its own padding can tip it
    } else {
      const items = contentRects(el);
      // Only boxes inside: they get measured themselves.
      if (!items.some((i) => i.own)) continue;
      const rects = items.map((i) => i.x);
      const tall = rects.reduce((a, b) => (b.height > a.height ? b : a));
      // More than one row of content (an item clear of the tallest one's band): a panel, not a bar or chip.
      if (rects.some((x) => x.bottom <= tall.top + 1 || x.top >= tall.bottom - 1)) continue;
      const cTop = Math.min(...rects.map((x) => x.top));
      const cBottom = Math.max(...rects.map((x) => x.bottom));
      top = cTop - (r.top + parseFloat(s.borderTopWidth));
      bottom = r.bottom - parseFloat(s.borderBottomWidth) - cBottom;
      // shortcut: over 48 px of room in all reads as a panel with a heading, not a bar; a 64 px bar with a
      // 14 px line gets skipped. Upgrade if a tall bar's misplaced line slips through.
      if (top + bottom > 48) continue;
    }
    if (Math.abs(top - bottom) > TOL || Math.min(top, bottom) < 0.5) {
      out.push({ check: 'padding', selector: sel(el), text: snip(el.textContent) || el.getAttribute('aria-label') || '', top: r1(top), bottom: r1(bottom), height: r1(r.height), why: Math.min(top, bottom) < 0.5 ? 'no room above or below' : 'unequal room above and below' });
    }
  }

  // 2. tap targets
  const minH = opts.phone ? opts.minTap : 24;
  const TARGETS = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=option]';
  for (const el of document.querySelectorAll(TARGETS)) {
    if (!inScope(el) || !visible(el) || el.closest('[inert], [aria-hidden=true]')) continue;
    let r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1 || r.right <= 0 || r.left >= vw) continue; // screen-reader-only, or a drawer off-screen
    const s = css(el);
    // A text link is exempt (WCAG 2.5.8's inline exception): it sits in a line of text.
    if (s.display === 'inline' && el.localName === 'a') continue;
    if (el.localName === 'input' && ['checkbox', 'radio'].includes(el.type)) {
      const label = el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
      if (label) r = label.getBoundingClientRect();
    }
    // 2 px of slack: a thumb doesn't notice a 39 px field where 40 is the rule.
    const short = r.height < minH - 2;
    const narrow = !opts.phone && r.width < 24 - 2;
    if (short || narrow) out.push({ check: 'tap', selector: sel(el), text: snip(el.textContent) || el.getAttribute('aria-label') || el.getAttribute('title') || '', height: r1(r.height), width: r1(r.width), min: minH, why: opts.phone ? `under ${minH} px tall on a phone` : 'under 24 px on desktop' });
  }

  // 3. sideways scroll
  const scrollW = document.documentElement.scrollWidth;
  if (scrollW > vw + 1) {
    const clipsX = (el) => { for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) { if (e === document.body) return false; if (css(e).overflowX !== 'visible') return true; } return false; };
    const wide = all.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1 && css(el).position !== 'fixed' && visible(el) && !clipsX(el); });
    const set = new Set(wide);
    for (const el of wide) {
      if (el.parentElement && set.has(el.parentElement)) continue; // the outermost only
      const r = el.getBoundingClientRect();
      out.push({ check: 'overflow', selector: sel(el), text: snip(el.textContent), right: r1(r.right), width: r1(r.width), viewport: vw, why: `reaches ${r1(r.right - vw)} px past the ${vw} px window, so the page scrolls sideways` });
    }
    if (!wide.length) out.push({ check: 'overflow', selector: 'html', text: '', right: scrollW, width: scrollW, viewport: vw, why: 'the page scrolls sideways' });
  }

  // 4. clipped or spilling text: each text line against the nearest box that clips it
  const clipper = new Map();
  const nearestClip = (el) => {
    if (clipper.has(el)) return clipper.get(el);
    let v = null;
    if (el && el !== document.documentElement) {
      const s = css(el);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') v = el;
      else v = nearestClip(el.parentElement);
    }
    clipper.set(el, v);
    return v;
  };
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seenClip = new Set();
  for (let n, count = 0; (n = tw.nextNode()) && count < 4000; count++) {
    const host = n.parentElement;
    if (!n.data.trim() || !host || !inScope(host) || !visible(host) || ['script', 'style', 'noscript', 'textarea'].includes(host.localName)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const lines = [...range.getClientRects()].filter((x) => x.width > 0);
    if (!lines.length) continue;
    const box = nearestClip(host);
    const bx = box && box.getBoundingClientRect();
    // Not the body, and not a visually hidden label (a 1 px box, or clipped away whole): that hiding is on purpose.
    if (box && !seenClip.has(box) && box !== document.body && bx.width > 2 && bx.height > 2 && css(box).clipPath === 'none') {
      const s = css(box);
      const ellipsis = s.textOverflow === 'ellipsis' || (s.webkitLineClamp && s.webkitLineClamp !== 'none');
      if (ellipsis) {
        if (box.scrollWidth > box.clientWidth + 1 || box.scrollHeight > box.clientHeight + 1) {
          seenClip.add(box);
          truncated.push({ check: 'truncated', selector: sel(box), text: snip(box.textContent), full_text_in: box.hasAttribute('data-tip-overflow') ? 'data-tip-overflow' : box.title ? 'title' : null });
        }
      } else {
        const b = box.getBoundingClientRect();
        const inner = { left: b.left + box.clientLeft, top: b.top + box.clientTop, right: b.left + box.clientLeft + box.clientWidth, bottom: b.top + box.clientTop + box.clientHeight };
        const hidesX = s.overflowX === 'hidden' || s.overflowX === 'clip';
        const hidesY = s.overflowY === 'hidden' || s.overflowY === 'clip';
        for (const l of lines) {
          // A line wholly outside is hidden on purpose (a drawer off-stage, a carousel); cut text straddles the edge.
          if (l.right <= inner.left || l.left >= inner.right || l.bottom <= inner.top || l.top >= inner.bottom) continue;
          const byX = hidesX ? Math.max(inner.left - l.left, l.right - inner.right) : 0;
          const byY = hidesY ? Math.max(inner.top - l.top, l.bottom - inner.bottom) : 0;
          if (byX > 1 || byY > 1) {
            seenClip.add(box);
            out.push({ check: 'clip', selector: sel(box), text: snip(n.data), axis: byX > 1 ? 'x' : 'y', by: r1(Math.max(byX, byY)), why: `text cut off by ${r1(Math.max(byX, byY))} px (overflow: hidden)` });
            break;
          }
        }
      }
    }
    // Spill: text drawn outside the box around it (overflow visible), past its border.
    let b = host;
    while (b && b !== document.body && !isBox(b)) b = b.parentElement;
    if (b && b !== document.body && !seenClip.has(b) && visible(b)) {
      const r = b.getBoundingClientRect();
      const by = Math.max(...lines.map((l) => Math.max(r.left - l.left, l.right - r.right, r.top - l.top, l.bottom - r.bottom)));
      if (by > 1 && (!box || !b.contains(box))) { // a clipper inside b scrolls or cuts the text instead
        seenClip.add(b);
        out.push({ check: 'clip', selector: sel(b), text: snip(n.data), axis: 'spill', by: r1(by), why: `text runs ${r1(by)} px outside its box` });
      }
    }
  }

  // 5. double borders: an element and one inside it both drawing a line on the same edge, within 6 px
  const lines = new Map();
  for (const el of all) {
    if (['td', 'th', 'tr', 'tbody', 'thead', 'table'].includes(el.localName) && css(el.closest('table') || el).borderCollapse === 'collapse') continue;
    const s = css(el);
    const sides = {};
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) if (edge(s, side)) sides[side] = parseFloat(s[`border${side}Width`]);
    const ow = s.outlineStyle !== 'none' && alpha(s.outlineColor) > 0.05 ? parseFloat(s.outlineWidth) : 0;
    const off = ow ? ow + parseFloat(s.outlineOffset || '0') : 0;
    const ring = /(^|,)\s*(rgba?\([^)]*\)\s*)?0px 0px 0px [1-9]/.test(s.boxShadow) ? 1 : 0;
    if (!Object.keys(sides).length && !ow && !ring) continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const at = { Top: r.top, Right: r.right, Bottom: r.bottom, Left: r.left };
    const drawn = {};
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const sign = side === 'Top' || side === 'Left' ? -1 : 1;
      if (sides[side]) drawn[side] = at[side] - sign * sides[side] / 2;
      else if (ow) drawn[side] = at[side] + sign * (off - ow / 2);
      else if (ring) drawn[side] = at[side];
    }
    lines.set(el, { r, drawn });
  }
  for (const [el, d] of lines) {
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const A = lines.get(a);
      if (!A) continue;
      const shared = [];
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        if (A.drawn[side] === undefined || d.drawn[side] === undefined) continue;
        const gap = Math.abs(A.drawn[side] - d.drawn[side]);
        const along = side === 'Top' || side === 'Bottom' ? [A.r.left, A.r.right, d.r.left, d.r.right] : [A.r.top, A.r.bottom, d.r.top, d.r.bottom];
        const overlap = Math.min(along[1], along[3]) - Math.max(along[0], along[2]);
        if (gap <= 6 && overlap >= 0.5 * (along[1] - along[0])) shared.push(`${side.toLowerCase()} ${r1(gap)} px apart`);
      }
      if (shared.length) out.push({ check: 'double-border', selector: sel(el), outer: sel(a), text: snip(el.textContent) || el.getAttribute('placeholder') || '', sides: shared, why: `it and ${sel(a).split(' > ').pop()} both draw a line: ${shared.join(', ')}` });
      break; // against the nearest lined ancestor only
    }
  }

  // 6. a dialog's close button that scrolls away with its body
  const CLOSE = /^(close|dismiss|cancel|✕|×|✖|x)$|close/i;
  for (const dlg of document.querySelectorAll('dialog[open], [role=dialog], [aria-modal=true]')) {
    if (!visible(dlg) || !inScope(dlg)) continue;
    const btn = [...dlg.querySelectorAll('button, [role=button], a')].find((b) => CLOSE.test((b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim()));
    if (!btn) continue;
    for (let e = btn.parentElement; e; e = e === dlg ? null : e.parentElement) {
      const s = css(e);
      if (/(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1) {
        out.push({ check: 'close-scrolls', selector: sel(btn), scroller: sel(e), text: snip(btn.getAttribute('aria-label') || btn.textContent), scroll_height: e.scrollHeight, client_height: e.clientHeight, why: 'the close button sits inside the part that scrolls, so it scrolls out of view' });
        break;
      }
      if (s.position === 'sticky' || s.position === 'fixed') break; // pinned below the scroller (a modal dialog is fixed and may scroll itself)
    }
  }

  // 7. a URL or DOI a person can't click: plain text outside a link or code, or only in a tooltip
  const URLISH = /https?:\/\/[^\s"'<>]+[^\s"'<>.,:;!?)\]]|(?<![\w/.:-])(?:doi:\s?)?10\.\d{4,9}\/[^\s"'<>]*[^\s"'<>.,:;!?)\]]/i;
  const NOT_TEXT = 'a[href], code, pre, kbd, samp, textarea, input, select, script, style, [contenteditable]';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    const el = n.parentElement;
    const m = URLISH.exec(n.data);
    if (!m || !el || el.closest(NOT_TEXT) || !inScope(el) || !visible(el)) continue;
    out.push({ check: 'bare-link', selector: sel(el), text: snip(m[0]), why: 'a URL or DOI as plain text: make it a link (linkify in ui/markdown.js)' });
  }
  for (const el of all) {
    const tip = el.getAttribute('title') || el.getAttribute('data-tip') || '';
    const m = URLISH.exec(tip);
    if (!m || el.closest('a[href]') || el.querySelector('a[href]') || !visible(el)) continue;
    out.push({ check: 'bare-link', selector: sel(el), text: snip(m[0]), why: 'a URL or DOI only in a tooltip: show it as a link' });
  }

  // Group repeats (40 rows with the same short button) into one finding with a count.
  const grouped = new Map();
  for (const f of out) {
    const key = JSON.stringify([f.check, shape(f.selector), f.top, f.bottom, f.height, f.by, f.sides]);
    const g = grouped.get(key);
    if (g) g.count++;
    else grouped.set(key, { ...f, count: 1 });
  }
  return { viewport: vw, scroll_width: scrollW, findings: [...grouped.values()], truncated: truncated.slice(0, 20) };
}

// Rule 23: click with every request held for 3 s; at 250 ms the click shows something, and no other
// control went disabled or under a cover.
async function clickCheck(page, selector) {
  const pre = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const T = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab]';
    const on = (c) => !c.disabled && c.getAttribute('aria-disabled') !== 'true' && !c.closest('[inert]') && getComputedStyle(c).pointerEvents !== 'none';
    const top = (c) => { const r = c.getBoundingClientRect(); if (r.width < 2 || r.bottom < 0 || r.top > innerHeight) return false; const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && (c === hit || c.contains(hit)); };
    window.__uim = { others: [...document.querySelectorAll(T)].filter((c) => !el.contains(c) && !c.contains(el) && c.checkVisibility() && on(c)), on, top, el, muts: 0 };
    window.__uim.reachable = window.__uim.others.filter(top);
    new MutationObserver((l) => (window.__uim.muts += l.length)).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!pre) return [{ check: 'click', selector, why: 'no element matches --click' }];
  await sleep(250);
  const baseline = await page.evaluate('window.__uim.muts');
  await page.evaluate('window.__uim.muts = 0');
  await page.s('Network.emulateNetworkConditions', { offline: false, latency: 3000, downloadThroughput: -1, uploadThroughput: -1 });
  for (const type of ['mousePressed', 'mouseReleased']) await page.s('Input.dispatchMouseEvent', { type, x: pre.x, y: pre.y, button: 'left', clickCount: 1 });
  await sleep(250);
  const after = await page.evaluate(`(() => {
    const u = window.__uim;
    const name = (c) => c.localName + (c.id ? '#' + c.id : '') + [...c.classList].slice(0, 2).map((x) => '.' + x).join('') + ' "' + (c.textContent || c.getAttribute('aria-label') || '').trim().slice(0, 24) + '"';
    return { muts: u.muts, off: u.others.filter((c) => c.isConnected && !u.on(c)).map(name), covered: u.reachable.filter((c) => c.isConnected && !u.top(c)).map(name) };
  })()`);
  const found = [];
  if (after.muts === 0) found.push({ check: 'click-no-result', selector, baseline_mutations: baseline, why: 'nothing on the page changed 250 ms after the click while its request was held' });
  if (after.off.length) found.push({ check: 'click-froze', selector, disabled: after.off.slice(0, 8), count: after.off.length, why: `${after.off.length} other control(s) went disabled while the request was held` });
  if (after.covered.length) found.push({ check: 'click-froze', selector, covered: after.covered.slice(0, 8), count: after.covered.length, why: `${after.covered.length} other control(s) went under a cover while the request was held` });
  return found;
}

// --- main --------------------------------------------------------------------------------------------

export async function measure(o) {
  const bin = o.chrome || process.env.CHROME || findChrome();
  if (!bin) throw new Error('no browser: install Playwright\'s chrome-headless-shell (npx playwright install chromium-headless-shell) or pass --chrome');
  if (o.shots) mkdirSync(o.shots, { recursive: true });
  const browser = launch(bin);
  const pages = [];
  try {
    for (const [i, url] of o.urls.entries()) {
      const slug = `${o.urls.length > 1 ? `${i + 1}-` : ''}${(new URL(url).pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'index').slice(0, 40)}`;
      for (const width of o.widths) {
        const page = await openPage(browser.send, url, width, o);
        try {
          const minTap = o.minTap || (await page.evaluate(`(() => { const s = getComputedStyle(document.documentElement); return parseFloat(s.getPropertyValue('--citadel-control-h')) || parseFloat(s.getPropertyValue('--control-h')) || 40; })()`));
          const m = await page.evaluate(`(${inPage})(${JSON.stringify({ phone: page.phone, minTap, scope: o.scope })})`);
          const rec = { url, width, phone: page.phone, min_tap: page.phone ? minTap : 24, ...m };
          if (o.shots) rec.shot = await shot(page, join(o.shots, `${slug}-${width}.png`));
          if (o.click) {
            rec.findings.push(...(await clickCheck(page, o.click)));
            if (o.shots) rec.shot_after_click = await shot(page, join(o.shots, `${slug}-${width}-click.png`));
          }
          pages.push(rec);
        } finally {
          await page.close().catch(() => {});
        }
      }
    }
  } finally {
    await browser.close();
  }
  let ignored = 0;
  for (const p of pages) {
    p.findings = p.findings.filter((f) => {
      const drop = o.ignore.some((rule) => { const c = rule.indexOf(':'); return f.check === rule.slice(0, c) && f.selector.includes(rule.slice(c + 1)); });
      if (drop) ignored++;
      return !drop;
    });
  }
  const counts = {};
  for (const p of pages) for (const f of p.findings) counts[f.check] = (counts[f.check] || 0) + 1;
  return { ok: !Object.keys(counts).length, counts, ignored, pages };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('ui-measure.mjs')) {
  let o;
  try {
    o = args(process.argv.slice(2));
  } catch (e) {
    console.error(`ui-measure: ${e.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (!o) {
    console.log(HELP);
    process.exit(0);
  }
  measure(o).then((r) => {
    // One finding a line: the critic and the author read it, so keep it short.
    const json = JSON.stringify(r, null, 1).replace(/\{\n\s*"check"[^{}]*?\n\s*\}/g, (f) => JSON.stringify(JSON.parse(f)));
    if (o.out) writeFileSync(o.out, json + '\n');
    else console.log(json);
    if (o.out) console.error(r.ok ? 'ui-measure: clean' : `ui-measure: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ')} (${o.out})`);
    process.exit(r.ok ? 0 : 1);
  }, (e) => {
    console.error(`ui-measure: ${e.message}`);
    process.exit(2);
  });
}
