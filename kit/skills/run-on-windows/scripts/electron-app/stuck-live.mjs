// Citadel's real page stuck on "Reconnecting…" in the desktop app, then each reload key (#2263). Starts a published build
// (or this checkout's desktop/ on the newest one's Electron) on the WCO rig's dev copy (rig.ts up, no driver needed), signed
// in, through a proxy here on the box that can hold the live stream: while held, a stream request is taken and never
// answered, as a booting server's was (#2260). The rig drops the open stream, the page asks again into the hold and sits on
// Reconnecting…; then the hold lets go (the server is fine again) and a key goes in through DevTools (Input.dispatchKeyEvent:
// the browser-side path, before-input-event and all). PASS: a new page loaded and its stream answered, no chip, within 8 s
// (well inside the page's own 30 s retry). RIG_HELD=1, a control: the hold stays on through one Ctrl+R, which must still
// reload, the new page stuck again as it would be on a server still booting.
//   node stuck-live.mjs <config URL from rig.ts up's box line> [build number | checkout, default checkout]
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const [cfgUrl, build = 'checkout'] = process.argv.slice(2);
const cfg = await (await fetch(`${cfgUrl.replace(/\/$/, '')}/config`)).json();
const [uh, up] = cfg.upstream.split(':');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const repo = path.resolve(import.meta.dirname, '../../../../..');
const keepHeld = !!process.env.RIG_HELD;

// ---------- the proxy: the dev copy, with a hold on the live stream ----------
let held = false;
const hung = []; // stream requests taken and never answered
const open = []; // streams answered and still open
let answered = 0;
const isStream = (u) => /\/api\/stream(\?|$)/.test(u);
const proxy = http.createServer((req, res) => {
  if (isStream(req.url) && held) return void hung.push(res);
  const out = http.request({ host: uh, port: Number(up), method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    if (isStream(req.url) && r.statusCode === 200) {
      answered++;
      open.push(res);
      res.flushHeaders();
    }
    r.pipe(res);
  });
  out.on('error', () => res.destroy());
  res.on('close', () => out.destroy());
  req.pipe(out);
});
const port = await new Promise((r) => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
const origin = `http://localhost:${port}`;

// ---------- the app ----------
const root = path.join(process.env.TEMP, 'citadel-keys');
mkdirSync(root, { recursive: true });
function fetchBuild(n) {
  const dir = path.join(root, `build-${n}`);
  if (existsSync(path.join(dir, 'Citadel.exe'))) return dir;
  const zip = path.join(root, `citadel-${n}.zip`);
  execFileSync('curl.exe', ['-fsSL', '-o', zip, `https://citadel.zip/api/desktop/2/citadel/citadel-${n}.zip`], { stdio: 'inherit' });
  rmSync(dir, { recursive: true, force: true });
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `$ProgressPreference='SilentlyContinue'; Expand-Archive -Force '${zip}' '${dir}'`], { stdio: 'inherit' });
  const kids = readdirSync(dir);
  return kids.length === 1 && !existsSync(path.join(dir, 'Citadel.exe')) ? path.join(dir, kids[0]) : dir;
}
let exe;
if (build === 'checkout') {
  const have = readdirSync(root)
    .filter((d) => /^build-\d+$/.test(d))
    .sort((a, b) => Number(b.slice(6)) - Number(a.slice(6)));
  const dir = path.join(root, 'checkout-stuck');
  rmSync(dir, { recursive: true, force: true });
  cpSync(fetchBuild(have[0]?.slice(6) ?? '11'), dir, { recursive: true });
  rmSync(path.join(dir, 'resources', 'app'), { recursive: true, force: true });
  const files = readFileSync(path.join(repo, 'desktop', 'build.sh'), 'utf8')
    .match(/cp "\$here"\/\{([^}]+)\} "\$work\/Citadel\/resources\/app\/"/)[1]
    .split(',');
  mkdirSync(path.join(dir, 'resources', 'app'));
  for (const f of files) cpSync(path.join(repo, 'desktop', f), path.join(dir, 'resources', 'app', f));
  exe = path.join(dir, 'Citadel.exe');
} else exe = path.join(fetchBuild(build), 'Citadel.exe');
console.log('app', exe);
const profile = mkdtempSync(path.join(os.tmpdir(), 'citadel-stuck-'));
const dbg = 20000 + Math.floor(Math.random() * 9000);
const app = spawn(exe, [`--user-data-dir=${profile}`, `--remote-debugging-port=${dbg}`], { env: { ...process.env, CITADEL_URL: `${origin}/c/` }, stdio: 'ignore' });
process.on('exit', () => {
  app.kill();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {}
});

// ---------- DevTools ----------
let browserWs;
for (let i = 0; i < 60 && !browserWs; i++) {
  try {
    browserWs = (await (await fetch(`http://127.0.0.1:${dbg}/json/version`)).json()).webSocketDebuggerUrl;
  } catch {
    await sleep(500);
  }
}
if (!browserWs) {
  console.log(`FAIL the app's DevTools port ${dbg} never answered`);
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
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s).catch(() => ({ result: {} }))).result.value;
const until = async (ok, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await ok()) return true;
  return !!(await ok());
};
const chip = () => ev(`!!document.querySelector('.cui-chip.reconnecting')`);
await send('Page.navigate', { url: `${origin}/c/#${cfg.route.replace(/^#/, '')}` }, s);
if (!(await until(async () => answered > 0 && (await ev(`!!document.querySelector('textarea')`)), 30000))) {
  console.log(`FAIL the page never came up live (streams answered ${answered})`);
  process.exit(1);
}
await sleep(1500);
const KEYS = [
  ['Ctrl+R', 'r', 'KeyR', 82, 2],
  ['F5', 'F5', 'F5', 116, 0],
  ['Ctrl+Shift+R', 'R', 'KeyR', 82, 10],
  ['Ctrl+F5', 'F5', 'F5', 116, 2],
];
const FOCUS = {
  page: `document.activeElement?.blur(); document.body.focus(); document.activeElement === document.body || document.activeElement === null`,
  'text box': `(() => { const t = document.querySelector('textarea'); t?.focus(); return document.activeElement === t; })()`,
};
let fails = 0;
for (const [where, focusJs] of Object.entries(FOCUS)) {
  for (const [name, key, code, vk, modifiers] of KEYS) {
    // Stuck: the open stream drops (a deploy) and the page's ask lands in the hold, never answered.
    held = true;
    const h0 = hung.length;
    for (const r of open.splice(0)) r.destroy();
    const asked = await until(() => hung.length > h0, 10000);
    const stuck = asked && (await until(chip, 8000));
    // The server is fine again; nothing on the page asks.
    if (!keepHeld) held = false;
    await sleep(1500);
    const a0 = answered;
    const stillStuck = (await chip()) && answered === a0;
    await ev(`window.__before = 1`);
    const focused = await ev(focusJs);
    for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }, s).catch(() => {});
    // A new document: the mark is gone, read by an evaluate that answered (a failed one is not a reload).
    const fresh = async () => {
      const r = await send('Runtime.evaluate', { expression: 'window.__before', returnByValue: true }, s).catch(() => null);
      return !!r && !r.exceptionDetails && r.result.type === 'undefined';
    };
    const reloaded = await until(fresh, 8000);
    const back = !keepHeld && (await until(async () => answered > a0 && !(await chip()) && (await ev(`!!document.querySelector('textarea')`)), 8000));
    // The control: the new page asked into the hold too, and sits on the chip again with no stream answered.
    const again = keepHeld && (await until(async () => answered === a0 && hung.length > h0 + 1 && (await chip()), 8000));
    const ok = stuck && stillStuck && focused && reloaded && (keepHeld ? again : back);
    if (!ok) fails++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} stuck (${asked ? 'stream held' : 'no stream asked'}, chip ${stuck ? 'shown' : 'not shown'}${stillStuck ? '' : ', not stuck before the key'}), focus ${where.padEnd(8)}${focused ? '' : ' (not focused)'} ${name.padEnd(12)} -> ${reloaded ? 'reloaded' : 'no reload'}${keepHeld ? (again ? ', hold kept, stuck again' : ', hold kept, but not stuck again') : back ? ', stream answered, chip gone' : ', still stuck'}`,
    );
    if (keepHeld) held = false;
    // A control: the reloaded page's stream is held too, and only its own 30 s retry would bring it back, so one key is enough.
    if (keepHeld) break;
    await until(async () => answered > a0 && !(await chip()), 10000);
    await sleep(1000);
  }
  if (keepHeld) break;
}
console.log(`fails ${fails}`);
proxy.close();
ws.close();
process.exit(fails ? 1 : 0);
