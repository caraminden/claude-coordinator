// The box side of the WCO rig (rig.ts serves this file): Edge on a fresh profile with Citadel's dev copy installed
// as an app, title bar overlay on, driven over the CDP pipe plus real mouse input (mouse.ps1). It then runs the
// snippets rig.ts queues until rig.ts says quit or nothing comes for 15 minutes.
//   node driver.mjs <rig url with token>
// A snippet is an async function body; it sees the names in HELPERS below and returns what rig.ts prints.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const IDLE_MS = 15 * 60_000;
const base = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
const cfg = await (await fetch(`${base}/config`)).json();
const dir = path.join(os.tmpdir(), 'citadel-wco');
const prof = path.join(dir, `edge-${process.pid}`);
fs.mkdirSync(prof, { recursive: true });

// http://localhost is a secure context, so Edge offers the install; a tailnet http:// origin is not.
const [uh, up] = cfg.upstream.split(':');
const fwd = net.createServer((c) => {
  const u = net.connect(+up, uh);
  c.pipe(u).pipe(c);
  c.on('error', () => u.destroy());
  u.on('error', () => c.destroy());
});
const port = await new Promise(function tryPort(res) {
  const p = 20000 + Math.floor(Math.random() * 10000);
  fwd.once('error', () => tryPort(res)).listen(p, '127.0.0.1', () => res(p));
});
const origin = `http://localhost:${port}`;

// PWA.install and PWA.launch exist only over the pipe, not --remote-debugging-port.
const edge = spawn(EDGE, [`--user-data-dir=${prof}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(import.meta.dirname, 'mouse.ps1')], { stdio: ['pipe', 'pipe', 'inherit'] });
const psQ = [];
readline.createInterface({ input: ps.stdout }).on('line', (l) => psQ.shift()?.(l.trim()));
/** One mouse.ps1 command; resolves with its answer line. */
const mouse = (cmd) => new Promise((r) => { psQ.push(r); ps.stdin.write(cmd + '\n'); });

let id = 0, buf = '';
const pending = new Map();
edge.stdio[4].on('data', (d) => {
  buf += d;
  for (let k; (k = buf.indexOf('\0')) >= 0; buf = buf.slice(k + 1)) {
    const m = JSON.parse(buf.slice(0, k));
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result); }
  }
});
/** A CDP command, on a page's session when given. */
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej, method });
  setTimeout(() => { if (pending.delete(i)) rej(new Error(`timeout: ${method}`)); }, 20_000);
  edge.stdio[3].write(JSON.stringify({ id: i, method, params, sessionId }) + '\0');
});
const sessions = new Map();
/** The first page whose URL contains `match`, attached: { s: its session, targetId }. */
async function session(match) {
  const t = (await send('Target.getTargets')).targetInfos.find((x) => x.type === 'page' && x.url.includes(match));
  if (!t) throw new Error(`no page matching ${match}`);
  if (!sessions.has(t.targetId)) sessions.set(t.targetId, (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId);
  return { s: sessions.get(t.targetId), targetId: t.targetId };
}
/** Runs `expr` (an async function body) in a page; returns its value. */
const evIn = async (s, expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }, s);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
/** Screen px of a CSS point in a page: the viewport's origin from screenX/Y and the window frame. */
const screenPt = async (s, x, y) => {
  const [dpr, sx, sy, fw, fh] = await evIn(s, 'return [devicePixelRatio, screenX, screenY, outerWidth - innerWidth, outerHeight - innerHeight]');
  return [Math.round((sx + fw / 2 + x) * dpr), Math.round((sy + fh - fw / 2 + y) * dpr)];
};
/** A PNG of the window that holds `targetId`, sent to rig.ts as <name>.png. */
async function shot(name, targetId) {
  const { windowId } = await send('Browser.getWindowForTarget', { targetId });
  const { bounds: b } = await send('Browser.getWindowBounds', { windowId });
  const { s } = await session('/c/');
  const dpr = await evIn(s, 'return devicePixelRatio');
  const file = path.join(dir, 'shot.png');
  await mouse(`shot ${file} ${[b.left, b.top, b.width, b.height].map((v) => Math.round(v * dpr)).join(' ')}`);
  await fetch(`${base}/shot/${encodeURIComponent(name)}`, { method: 'POST', body: fs.readFileSync(file) });
  return `${name}.png`;
}

/**
 * Citadel installed from Edge's own address-bar chip and dialog, by real clicks: the app window that gives has the
 * overlay on (a CDP install opens in a tab, and Chrome for Testing's app window never offers the overlay).
 */
async function install(route) {
  const [cn, cv] = [cfg.cookie.slice(0, cfg.cookie.indexOf('=')), cfg.cookie.slice(cfg.cookie.indexOf('=') + 1)];
  await send('Storage.setCookies', { cookies: [{ name: cn, value: cv, domain: 'localhost', path: '/' }] });
  const { targetId } = await send('Target.createTarget', { url: `${origin}/c/#${route.replace(/^#/, '')}` });
  const { windowId } = await send('Browser.getWindowForTarget', { targetId });
  await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await send('Browser.setWindowBounds', { windowId, bounds: { left: 20, top: 10, width: 1300, height: 800 } });
  const clickFirst = async (what, re) => {
    for (let i = 0; i < 40; i++) {
      const r = await mouse(`uia-click ${re}`);
      if (r.startsWith('clicked')) return r;
      await sleep(500);
    }
    throw new Error(`no ${what} (${re}) in Edge's windows; seen: ${await mouse('uia-list .')}`);
  };
  log(await clickFirst('install chip', cfg.chip ?? '^App available'));
  log(await clickFirst('Install button', '^Install$'));
  // Edge then offers to pin the app and make shortcuts; decline it all (cleanup.ps1 removes what slips through).
  for (let i = 0; i < 10; i++) {
    const r = await mouse(`uia-click ${cfg.decline ?? "^(Not now|Don't allow|No thanks)$"}`);
    if (r.startsWith('clicked')) { log(r); break; }
    await sleep(500);
  }
  for (let i = 0; i < 40; i++) {
    for (const t of (await send('Target.getTargets')).targetInfos) {
      if (t.type !== 'page' || !t.url.startsWith(origin)) continue;
      const s = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
      if (await evIn(s, "return matchMedia('(display-mode: window-controls-overlay)').matches || matchMedia('(display-mode: standalone)').matches")) {
        sessions.set(t.targetId, s);
        return t.targetId;
      }
      await send('Target.detachFromTarget', { sessionId: s });
    }
    await sleep(500);
  }
  throw new Error('the app window never opened after the install');
}

const HELPERS = { send, mouse, session, evIn, screenPt, shot, sleep, log, origin };
const AsyncFunction = (async () => {}).constructor;
let quit = false;
try {
  await sleep(1500);
  const app = await install(cfg.route);
  log('installed; app window target', app, 'origin', origin);
  await fetch(`${base}/ready`, { method: 'POST' });
  for (let after = 0, last = Date.now(); !quit && Date.now() - last < IDLE_MS;) {
    const r = await fetch(`${base}/next?after=${after}`).catch(() => null);
    if (!r || r.status !== 200) { await sleep(r ? 0 : 3000); continue; }
    const cmd = await r.json();
    after = cmd.id;
    last = Date.now();
    let out;
    if (cmd.code === 'quit') { quit = true; out = { ok: true, text: 'quit' }; }
    else {
      try { out = { ok: true, text: String(await new AsyncFunction(...Object.keys(HELPERS), cmd.code)(...Object.values(HELPERS)) ?? '') }; }
      catch (e) { out = { ok: false, text: String(e?.stack ?? e) }; }
    }
    log(cmd.id, out.ok ? 'ok' : 'error', out.text.slice(0, 2000));
    await fetch(`${base}/result/${cmd.id}`, { method: 'POST', body: JSON.stringify(out) }).catch(() => {});
  }
} catch (e) {
  log('driver stopped:', String(e?.stack ?? e));
  await fetch(`${base}/ready`, { method: 'POST', body: String(e?.stack ?? e) }).catch(() => {});
} finally {
  // Edge's own uninstall takes the app's shortcuts and uninstall entry with it; cleanup.ps1 gets any left.
  try { await send('PWA.uninstall', { manifestId: `${origin}/` }); log('uninstalled the app'); } catch (e) { log(String(e.message)); }
  try { await send('Browser.close'); } catch {}
  await sleep(1500);
  try { edge.kill(); } catch {}
  ps.stdin.end();
  fwd.close();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
