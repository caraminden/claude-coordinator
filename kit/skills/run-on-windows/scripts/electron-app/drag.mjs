// Where Citadel's desktop app (#1186, desktop/) can be dragged by: it starts the app from this checkout on a Citadel the
// WCO rig serves (rig.ts up, then this with its config URL), signed in, at a scheme page, then drags with the real mouse
// (wco/mouse.ps1) from points in the header strip and prints, for each, what the page has there and whether the window moved.
//   node drag.mjs <config URL from rig.ts up's box line> [route, default the rig's scheme]
// Electron is the defender-copy rig's (%LOCALAPPDATA%\defender-copy). Leaves a shot at %TEMP%\electron-drag.png.
import { spawn } from 'node:child_process';
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
const app = spawn(electron, [`--remote-debugging-port=${dbg}`, path.join(repo, 'desktop')], { env: { ...process.env, CITADEL_URL: `${origin}/c/` }, stdio: 'inherit' });

const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(import.meta.dirname, '..', 'wco', 'mouse.ps1')], { stdio: ['pipe', 'pipe', 'inherit'] });
const psQ = [];
readline.createInterface({ input: ps.stdout }).on('line', (l) => psQ.shift()?.(l.trim()));
const mouse = (cmd) =>
  new Promise((r) => {
    psQ.push(r);
    ps.stdin.write(cmd + '\n');
  });

let browserWs;
for (let i = 0; i < 60 && !browserWs; i++) {
  try {
    browserWs = (await (await fetch(`http://127.0.0.1:${dbg}/json/version`)).json()).webSocketDebuggerUrl;
  } catch {
    await sleep(500);
  }
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
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value;
await send('Page.navigate', { url: `${origin}/c/${route}` }, s);
for (let i = 0; i < 40 && !(await ev("!!document.querySelector('.split .ticket-head, .split')").catch(() => false)); i++) await sleep(500);
await sleep(2500);
// Electron's CDP has no Browser window calls: the window's place comes from the page (CSS px), and a drag that moved it
// is undone by dragging back.
const where = () => ev(`({ x: screenX + (outerWidth - innerWidth) / 2, y: screenY + outerHeight - innerHeight - (outerWidth - innerWidth) / 2 })`);
console.log(
  'page',
  JSON.stringify(
    await ev(`({ href: location.href, wco: matchMedia('(display-mode: window-controls-overlay)').matches,
  inset: getComputedStyle(document.documentElement).getPropertyValue('--top-inset'), strip: navigator.windowControlsOverlay?.getTitlebarAreaRect().toJSON(), dpr: devicePixelRatio })`),
  ),
);

// Points in CSS px of the page: across the header strip, and just under it.
const dpr = await ev('devicePixelRatio');
const W = await ev('innerWidth');
// The empty space of each header in the strip, its ‹, and a point below the strip that should not drag.
const points = await ev(`(() => {
  const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
  const out = [];
  for (const p of ['.shelf', '.sidebar']) {
    const s = r(p + '[open] > summary'), last = document.querySelector(p + '[open] > summary > :last-child')?.getBoundingClientRect();
    if (s) { out.push([p + ' above header', s.left + 40, Math.max(2, s.top / 2)]); out.push([p + ' header gap', Math.round((last.right + s.right - 24) / 2), Math.round(s.top + s.height / 2)]); }
  }
  const row = document.querySelector('.ticket-head > .row'), rr = row.getBoundingClientRect(), kids = [...row.children].filter((k) => k.getClientRects().length);
  const end = Math.max(...kids.map((k) => k.getBoundingClientRect().right)), stop = navigator.windowControlsOverlay?.getTitlebarAreaRect().right || rr.right;
  out.push(['chat head above row', Math.round((end + stop) / 2), Math.max(2, Math.round(rr.top / 2))]);
  out.push(['chat head row gap', Math.round((end + stop) / 2), Math.round(rr.top + rr.height / 2)]);
  out.push(['chat head row, by the controls', Math.round(stop - 20), Math.round(rr.top + rr.height / 2)]);
  out.push(['below the strip (no drag)', Math.round((end + stop) / 2), Math.round(rr.bottom + 30)]);
  return out;
})()`);
for (const [label, x, y] of points) {
  const what = await ev(
    `(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? (e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).join('.') : '') + ' "' + (e.textContent || '').trim().slice(0, 20) + '" region:' + getComputedStyle(e).appRegion) : 'none'; })()`,
  );
  const before = await where();
  const sx = Math.round((before.x + x) * dpr),
    sy = Math.round((before.y + y) * dpr);
  await mouse(`drag ${sx} ${sy} ${sx + 60} ${sy + 40}`);
  await sleep(500);
  const after = await where();
  const moved = after.x !== before.x || after.y !== before.y;
  console.log(`${moved ? 'DRAGS  ' : 'no drag'} ${label} (${x},${y}): ${what}`);
  if (moved) {
    await mouse(`drag ${sx + 60} ${sy + 40} ${sx} ${sy}`);
    await sleep(500);
  }
  await mouse('key {ESC}');
}
// The ‹ of each open panel still folds it, by a real click.
for (const p of ['.shelf', '.sidebar']) {
  const c = await ev(`(() => { const s = document.querySelector('${p}[open] > summary'); if (!s) return null; const b = s.getBoundingClientRect(); return [b.right - 10, b.top + b.height / 2]; })()`);
  if (!c) continue;
  const o = await where();
  await mouse(`click ${Math.round((o.x + c[0]) * dpr)} ${Math.round((o.y + c[1]) * dpr)}`);
  await sleep(600);
  console.log(`${p} ‹ ${(await ev(`document.querySelector('${p}').open`)) ? 'did NOT fold' : 'folds'} the panel`);
  await ev(`(document.querySelector('${p}').open = true, 1)`);
  await sleep(400);
}
const b = await ev('({ left: screenX, top: screenY, width: outerWidth, height: outerHeight })');
await mouse(`shot ${path.join(process.env.TEMP, 'electron-drag.png')} ${[b.left, b.top, b.width, b.height].map((v) => Math.round(v * dpr)).join(' ')}`);
console.log('shot', path.join(process.env.TEMP, 'electron-drag.png'));
ps.stdin.end();
app.kill();
fwd.close();
ws.close();
process.exit(0);
