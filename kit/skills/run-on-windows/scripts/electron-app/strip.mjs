// Measures the desktop app's title strip against the page top on a route (home, a scheme, #/p/99999): rects, colours, shots.
//   node strip.mjs <config URL from rig.ts up's box line> <route>
// Electron is the defender-copy rig's (%LOCALAPPDATA%\defender-copy). Leaves a shot at %TEMP%\electron-drag.png.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';

const [cfgUrl, routeArg] = process.argv.slice(2);
const cfg = await (await fetch(`${cfgUrl.replace(/\/$/, '')}/config`)).json();
const route = routeArg ?? `#${cfg.route.replace(/^#/, '')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const repo = path.resolve(import.meta.dirname, '../../../../..');
const [uh, up] = cfg.upstream.split(':');

// http://localhost is a secure context (env(titlebar-area-*) and the overlay API want one); the tailnet origin is not.
const fwd = net.createServer((c) => {
  const u = net.connect(Number(up), uh);
  c.pipe(u).pipe(c);
  c.on('error', () => u.destroy());
  u.on('error', () => c.destroy());
});
const port = await new Promise((res) => fwd.listen(0, '127.0.0.1', () => res(fwd.address().port)));
const origin = `http://localhost:${port}`;
const dbg = 20000 + Math.floor(Math.random() * 9000);
const electron = path.join(process.env.LOCALAPPDATA, 'defender-copy', 'node_modules', 'electron', 'dist', 'electron.exe');
// Its own profile: a Citadel app already up on the box holds the single-instance lock and would make this one quit.
const profile = mkdtempSync(path.join(os.tmpdir(), 'citadel-drag-'));
const app = spawn(electron, [`--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`, path.join(repo, 'desktop')], { env: { ...process.env, CITADEL_URL: `${origin}/c/` }, stdio: 'inherit' });

const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(import.meta.dirname, '..', 'wco', 'mouse.ps1')], { stdio: ['pipe', 'pipe', 'inherit'] });
const psQ = [];
readline.createInterface({ input: ps.stdout }).on('line', (l) => psQ.shift()?.(l.trim()));
const mouse = (cmd) =>
  new Promise((r) => {
    psQ.push(r);
    ps.stdin.write(cmd + '\n');
  });

// Any exit, a throw included, takes the app and PowerShell down and removes the temp profile.
process.on('exit', () => {
  app.kill();
  ps.kill();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {}
});
let browserWs;
for (let i = 0; i < 60 && !browserWs; i++) {
  try {
    browserWs = (await (await fetch(`http://127.0.0.1:${dbg}/json/version`)).json()).webSocketDebuggerUrl;
  } catch {
    await sleep(500);
  }
}
if (!browserWs) {
  console.log(`FAIL the app's DevTools port ${dbg} never answered (did the app start?)`);
  process.exit(1);
}
const ws = new WebSocket(browserWs);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let id = 0;
const waits = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  const w = waits.get(d.id);
  if (w) {
    waits.delete(d.id);
    d.error ? w.j(new Error(d.error.message)) : w.r(d.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((r, j) => {
    const n = ++id;
    waits.set(n, { r, j });
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });

const [cn, cv] = [cfg.cookie.slice(0, cfg.cookie.indexOf('=')), cfg.cookie.slice(cfg.cookie.indexOf('=') + 1)];
await send('Storage.setCookies', { cookies: [{ name: cn, value: cv, domain: 'localhost', path: '/' }] });
let page;
for (let i = 0; i < 60 && !page; i++) {
  page = (await send('Target.getTargets')).targetInfos.find((t) => t.type === 'page');
  if (!page) await sleep(500);
}
const s = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s);
  if (r.exceptionDetails) throw new Error(`the page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
await send('Page.navigate', { url: `${origin}/c/${route}` }, s);
for (let i = 0; i < 40 && !(await ev('document.body.children.length > 2').catch(() => false)); i++) await sleep(500);
await sleep(3000);
const measure = () =>
  ev(`(() => {
  const R = (e) => { const r = e?.getBoundingClientRect(); return r && { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const cs = (e, p) => e && getComputedStyle(e)[p];
  const tb = navigator.windowControlsOverlay?.getTitlebarAreaRect();
  const first = document.querySelector('main > *') || document.querySelector('main');
  return { href: location.href, wco: matchMedia('(display-mode: window-controls-overlay)').matches, inset: getComputedStyle(document.documentElement).getPropertyValue('--top-inset'),
    strip: tb && { x: tb.x, y: tb.y, w: tb.width, h: tb.height }, w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
    topbar: R(document.querySelector('.topbar')), topbarBg: cs(document.querySelector('.topbar'), 'backgroundColor'), main: R(document.querySelector('main')), mainPadTop: cs(document.querySelector('main'), 'paddingTop'),
    first: first && { tag: first.tagName + '.' + first.className, ...R(first) }, bodyBg: cs(document.body, 'backgroundColor'), htmlBg: cs(document.documentElement, 'backgroundColor'), scrollY, under: [...document.querySelectorAll('main *')].filter((e) => { const r = e.getBoundingClientRect(); return tb && r.width && r.top < tb.height && r.bottom > 0 && r.right > tb.x + tb.width && !e.children.length && (e.textContent.trim() || e.matches('img,svg')); }).map((e) => e.tagName + ' ' + (e.textContent.trim().slice(0, 14))).slice(0, 8) };
})()`);
const dpr = await ev('devicePixelRatio');
const shoot = async (name) => {
  const b = await ev('({ left: screenX, top: screenY, width: outerWidth, height: outerHeight })');
  const f = path.join(process.env.TEMP, `electron-strip-${name}.png`);
  await mouse(`shot ${f} ${[b.left, b.top, b.width, b.height].map((v) => Math.round(v * dpr)).join(' ')}`);
  console.log('M', name, JSON.stringify(await measure()));
  console.log('shot', f);
};
await shoot('normal');
await ev('window.resizeTo(420, 700)');
await sleep(1500);
await shoot('narrow');
ps.stdin.end();
app.kill();
fwd.close();
ws.close();
process.exit(0);
