// How long a reload takes in Citadel's desktop app (#1697): starts desktop/ from this checkout on the WCO rig's dev copy
// (rig.ts up, no driver needed), signed in, at a route, then reloads it N times and prints, per reload, the time from the
// reload to the app drawn (#app has children) and to the splash gone, with how many front files came back 200 or 304.
//   node reload.mjs <config URL from rig.ts up's box line> [route, default the rig's scheme] [reloads, default 5]
// Electron is the defender-copy rig's (%LOCALAPPDATA%\defender-copy). The reload is CDP's Page.reload, the same normal
// reload Ctrl+R runs (not a cache-bypassing one).
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const [cfgUrl, routeArg, nArg] = process.argv.slice(2);
// An https:// first argument is a live Citadel, signed out: what its sign-in page costs to reload.
const live = /^https:/.test(cfgUrl);
const cfg = live ? { upstream: '', route: '', cookie: '' } : await (await fetch(`${cfgUrl.replace(/\/$/, '')}/config`)).json();
const route = routeArg && routeArg !== '-' ? routeArg : `#${cfg.route.replace(/^#/, '')}`;
const N = Number(nArg ?? 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const repo = path.resolve(import.meta.dirname, '../../../../..');
const [uh, up] = cfg.upstream.split(':');

const fwd = live
  ? null
  : net.createServer((c) => {
      const u = net.connect(Number(up), uh);
      c.pipe(u).pipe(c);
      c.on('error', () => u.destroy());
      u.on('error', () => c.destroy());
    });
const port = live ? 0 : await new Promise((res) => fwd.listen(0, '127.0.0.1', () => res(fwd.address().port)));
const origin = live ? new URL(cfgUrl).origin : `http://localhost:${port}`;
const dbg = 20000 + Math.floor(Math.random() * 9000);
const electron = path.join(process.env.LOCALAPPDATA, 'defender-copy', 'node_modules', 'electron', 'dist', 'electron.exe');
const app = spawn(electron, [`--remote-debugging-port=${dbg}`, path.join(repo, 'desktop')], { env: { ...process.env, CITADEL_URL: `${origin}/c/` }, stdio: 'ignore' });

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
// Every front-end file a reload asks for, from DevTools' network events: 200 from the network, 304, or the browser's cache.
let net0 = null;
const front = (url) => {
  try {
    const p = new URL(url).pathname;
    return p.startsWith('/c/') && !p.startsWith('/c/api/');
  } catch {
    return false;
  }
};
const onNet = (d) => {
  if (!net0) return;
  if (d.method === 'Network.requestWillBeSent' && front(d.params.request.url)) net0.asked.set(d.params.requestId, d.params.request.url);
  if (d.method === 'Network.requestServedFromCache' && net0.asked.has(d.params.requestId)) net0.cached++;
  if (d.method === 'Network.responseReceived' && net0.asked.has(d.params.requestId)) {
    const r = d.params.response;
    if (r.fromDiskCache || r.fromServiceWorker || r.fromPrefetchCache) net0.cached++;
    else if (r.status === 304) net0.n304++;
    else net0.n200++;
  }
  // The status on the wire: a revalidated file's responseReceived shows the cached 200, its extra info the 304.
  if (d.method === 'Network.responseReceivedExtraInfo' && d.params.statusCode === 304) net0.wire304.add(d.params.requestId);
  if (d.method === 'Network.loadingFinished' && net0.asked.has(d.params.requestId)) net0.bytes += d.params.encodedDataLength;
};
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.method) onNet(d);
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
if (!live) await send('Storage.setCookies', { cookies: [{ name: cn, value: cv, domain: 'localhost', path: '/' }] });
let page;
for (let i = 0; i < 60 && !page; i++) {
  page = (await send('Target.getTargets')).targetInfos.find((t) => t.type === 'page');
  if (!page) await sleep(500);
}
const s = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value;
// Each new document notes when #app first has children and when the splash fades and goes (ms since its navigation start).
await send('Page.enable', {}, s);
await send('Network.enable', {}, s);
await send(
  'Page.addScriptToEvaluateOnNewDocument',
  {
    source: `(() => {
  const t = window.__reload = {};
  const look = () => {
    const app = document.getElementById('app'), sp = document.getElementById('splash');
    if (t.drawn == null && app?.childElementCount) t.drawn = performance.now();
    if (t.fade == null && sp?.classList.contains('gone')) t.fade = performance.now();
    if (t.gone == null && document.body && !sp) t.gone = performance.now();
  };
  new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
})()`,
  },
  s,
);
await send('Page.navigate', { url: `${origin}/c/${route}` }, s);
for (let i = 0; i < 40 && !(await ev('!!window.__reload?.gone').catch(() => false)); i++) await sleep(500);
await sleep(3000);

const rows = [];
for (let i = 0; i < N; i++) {
  net0 = { asked: new Map(), n200: 0, n304: 0, cached: 0, bytes: 0, wire304: new Set() };
  const t0 = Date.now();
  await send('Page.reload', { ignoreCache: false }, s);
  let r = null;
  for (let k = 0; k < 60; k++) {
    await sleep(250);
    r = await ev(`window.__reload?.gone != null && window.__reload.drawn != null ? (() => {
      const files = performance.getEntriesByType('resource').filter((e) => new URL(e.name).pathname.startsWith('/c/') && !new URL(e.name).pathname.startsWith('/c/api/'));
      const nav = performance.getEntriesByType('navigation')[0];
      return { origin: performance.timeOrigin, ...window.__reload, files: files.length, ok: files.filter((e) => e.responseStatus === 200).length,
        notModified: files.filter((e) => e.responseStatus === 304).length, bytes: files.reduce((n, e) => n + e.transferSize, 0),
        pageStatus: nav?.responseStatus, loadEnd: nav?.loadEventEnd };
    })() : null`).catch(() => null);
    if (r) break;
  }
  if (!r) {
    console.log(`reload ${i + 1}: did not finish in 15 s`);
    continue;
  }
  const off = r.origin - t0; // ms from the reload call to the new page's navigation start
  const row = {
    reload: i + 1,
    toDrawn: Math.round(off + r.drawn),
    toFade: r.fade == null ? null : Math.round(off + r.fade),
    toGone: Math.round(off + r.gone),
    navToDrawn: Math.round(r.drawn),
    files: net0.asked.size,
    ok200: net0.n200 - [...net0.wire304].filter((r) => net0.asked.has(r)).length,
    ok304: net0.n304 + [...net0.wire304].filter((r) => net0.asked.has(r)).length,
    cached: net0.cached,
    kb: Math.round(net0.bytes / 1024),
    page: r.pageStatus,
    load: Math.round(r.loadEnd),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  await sleep(2000);
}
const med = (k) => {
  const v = rows
    .map((r) => r[k])
    .filter((x) => x != null)
    .sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
console.log(`MEDIAN reload→drawn ${med('toDrawn')} ms, reload→splash gone ${med('toGone')} ms, files 200 ${med('ok200')} / 304 ${med('ok304')} / cache ${med('cached')}, ${med('kb')} KB`);
app.kill();
fwd?.close();
ws.close();
process.exit(0);
