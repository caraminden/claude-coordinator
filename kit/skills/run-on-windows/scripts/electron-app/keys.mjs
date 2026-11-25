// Citadel's desktop app (#1186) with real keys and right-clicks, focus in the page and in an app's frame (#1526, #1691).
// It serves a fixture Citadel on 127.0.0.1 (no dev copy: /c/ is a page with a text box and three app frames: a same-origin
// /apps/demo/, a sandboxed one like an artifact, and a cross-site one on localhost), starts the app pointed at it, clicks
// into each text box with the real mouse (wco/mouse.ps1) and presses Ctrl+R, F5, Ctrl+Shift+R and Ctrl+F5 with SendKeys.
// For each it prints whether the window reloaded (the server counts /c/ loads; a hard one asks with no-cache) or the key
// reached the page instead. `rclick` right-clicks plain space in each place, reads the native menu's items (UI Automation),
// expects Reload this app and Inspect in each app frame and no new menu in Citadel's page, invokes Reload this app and
// checks only that frame reloaded (the server counts each /apps/<name>/ load). It leaves a shot per place.
// RIG_KIT=1: each app frame draws its own menu (cancels contextmenu, as rail.js's kit menu does), so none should come up.
//   node keys.mjs <build|checkout|edge> [keys|rclick|all]     RIG_INPUT=cdp: clicks and keys through DevTools (Input.dispatch*), for when
// real input can't reach the window: while an elevated window (an admin console left open on the box) has the foreground,
// Windows drops a normal process's injected input. DevTools' events take the same browser-side path from the focused
// frame's widget (before-input-event, the context-menu event), but skip Windows' own message loop.
// <build> is a published build number (downloaded from citadel.zip's feed into %TEMP%\citadel-keys) or `checkout`: the
// newest downloaded build's Electron with this checkout's desktop/ as its app. Shots land in keys-rig\ in the checkout (fetch_file reads them).
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';

const [build = 'checkout', what = 'all'] = process.argv.slice(2);
if (!['keys', 'rclick', 'all'].includes(what) || (build === 'edge' && what === 'rclick')) {
  console.log(`FAIL nothing to run: mode '${what}'${build === 'edge' ? ' in an Edge window (keys only)' : ''}; use keys, rclick or all`);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.join(process.env.TEMP, 'citadel-keys');
const repo = path.resolve(import.meta.dirname, '../../../../..');
const shots = path.join(repo, 'keys-rig');
mkdirSync(root, { recursive: true });
mkdirSync(shots, { recursive: true });

function fetchBuild(n) {
  const dir = path.join(root, `build-${n}`);
  if (existsSync(path.join(dir, 'Citadel.exe'))) return dir;
  const zip = path.join(root, `citadel-${n}.zip`);
  execFileSync('curl.exe', ['-fsSL', '-o', zip, `https://citadel.zip/api/desktop/2/citadel/citadel-${n}.zip`], { stdio: 'inherit' });
  rmSync(dir, { recursive: true, force: true });
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `$ProgressPreference='SilentlyContinue'; Expand-Archive -Force '${zip}' '${dir}'`], { stdio: 'inherit' });
  // A lone top folder in the zip is the build.
  const kids = readdirSync(dir);
  return kids.length === 1 && !existsSync(path.join(dir, 'Citadel.exe')) ? path.join(dir, kids[0]) : dir;
}

let exe;
// `edge`: the same checks in an Edge app window (Citadel as a PWA, or in a browser tab), keys only.
const edge = build === 'edge';
if (edge) exe = ['ProgramFiles(x86)', 'ProgramFiles'].map((v) => path.join(process.env[v] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(existsSync);
else if (build === 'checkout') {
  const have = readdirSync(root)
    .filter((d) => /^build-\d+$/.test(d))
    .sort((a, b) => Number(b.slice(6)) - Number(a.slice(6)));
  const base = fetchBuild(have[0]?.slice(6) ?? '9');
  const dir = path.join(root, 'checkout');
  rmSync(dir, { recursive: true, force: true });
  cpSync(base, dir, { recursive: true });
  rmSync(path.join(dir, 'resources', 'app'), { recursive: true, force: true });
  // Only the files desktop/build.sh puts in the app, so a file it misses fails here too. RIG_APP: another desktop/ folder
  // (an older commit's, for a control run).
  const from = process.env.RIG_APP || path.join(repo, 'desktop');
  const files = readFileSync(path.join(from, 'build.sh'), 'utf8')
    .match(/cp "\$here"\/\{([^}]+)\} "\$work\/Citadel\/resources\/app\/"/)[1]
    .split(',');
  mkdirSync(path.join(dir, 'resources', 'app'));
  for (const f of files) cpSync(path.join(from, f), path.join(dir, 'resources', 'app', f));
  exe = path.join(dir, 'Citadel.exe');
} else exe = path.join(fetchBuild(build), 'Citadel.exe');
console.log('app', exe);

// ---------- the fixture Citadel ----------
const loads = []; // each /c/ load: { hard }
const appLoads = { same: 0, sandboxed: 0, cross: 0 };
const seen = []; // keys that reached a page: "<where> <key>"
let layout = null;
const pane = (id, note) => `<!doctype html><meta charset=utf-8><style>html,body{margin:0;height:100%}textarea{box-sizing:border-box;width:100%;height:50%;font:16px sans-serif}p{margin:8px}</style>
<textarea id=t>${note}</textarea><p>plain text, not a text box</p><script>
const say = (p) => fetch('http://127.0.0.1:${'${PORT}'}' + p, { mode: 'no-cors' });
addEventListener('keydown', (e) => { if (e.ctrlKey || e.key === 'F5') say('/seen?w=${id}&k=' + encodeURIComponent((e.ctrlKey ? 'C+' : '') + (e.shiftKey ? 'S+' : '') + e.key)); });
addEventListener('focusin', () => say('/focus?w=${id}'));
addEventListener('mousedown', () => say('/mouse?w=${id}'));
${process.env.RIG_KIT && id !== 'top' ? "addEventListener('contextmenu', (e) => e.preventDefault());" : ''}
</script>`;
const top = `<!doctype html><meta charset=utf-8><title>Citadel</title><style>html,body{margin:0;height:100%}body{display:grid;grid-template:1fr 1fr/1fr 1fr;gap:6px;padding:40px 6px 6px;box-sizing:border-box;background:#eee}
iframe,textarea{box-sizing:border-box;width:100%;height:100%;border:2px solid #888;background:#fff;font:16px sans-serif}</style>
<div id=t style="display:grid;grid-template-rows:1fr 1fr"><textarea>Citadel's own page</textarea><p>plain text in Citadel's page</p></div>
<iframe id=same src="/apps/demo/"></iframe>
<iframe id=sandboxed sandbox="allow-scripts" src="/apps/art/"></iframe>
<iframe id=cross src="http://localhost:${'${PORT}'}/apps/cross/"></iframe>
<script>
${pane('top', '').split('<script>')[1].replace('</script>', '')}
const report = () => {
  const r = (el) => { const b = el.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 4, b.top + b.height * 3 / 4]; };
  say('/layout?d=' + encodeURIComponent(JSON.stringify({ x: screenX, y: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio,
    at: { top: r(t), same: r(document.getElementById('same')), sandboxed: r(document.getElementById('sandboxed')), cross: r(document.getElementById('cross')) } })));
};
addEventListener('load', report); addEventListener('resize', report);
</script>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (body, type = 'text/html') => {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=600' });
    res.end(body.replaceAll('${PORT}', String(PORT)));
  };
  if (u.pathname === '/c/') {
    layout = null;
    loads.push({ hard: /no-cache/.test(req.headers['cache-control'] ?? '') || /no-cache/.test(req.headers.pragma ?? '') });
    return send(top);
  }
  const app = { '/apps/demo/': 'same', '/apps/art/': 'sandboxed', '/apps/cross/': 'cross' }[u.pathname];
  if (app) appLoads[app]++;
  if (u.pathname === '/apps/demo/') return send(pane('same', 'same-origin app frame'));
  if (u.pathname === '/apps/art/') return send(pane('sandboxed', 'sandboxed frame (like an artifact)'));
  if (u.pathname === '/apps/cross/') return send(pane('cross', 'cross-site frame'));
  if (u.pathname === '/seen') seen.push(`${u.searchParams.get('w')} ${u.searchParams.get('k')}`);
  if (process.env.RIG_DEBUG && u.pathname !== '/c/') console.log('  page:', u.pathname, u.search);
  if (u.pathname === '/focus') focus = u.searchParams.get('w');
  if (u.pathname === '/layout') layout = JSON.parse(u.searchParams.get('d'));
  res.writeHead(204, { 'access-control-allow-origin': '*' });
  res.end();
});
let focus = null;
const PORT = await new Promise((r) => server.listen(0, () => r(server.address().port)));

// ---------- the app and the real input ----------
const profile = path.join(root, 'profile');
rmSync(profile, { recursive: true, force: true });
const dbg = 20000 + Math.floor(Math.random() * 9000);
const app = spawn(exe, [`--user-data-dir=${profile}`, `--remote-debugging-port=${dbg}`, ...(edge ? ['--no-first-run', '--no-default-browser-check', `--app=http://127.0.0.1:${PORT}/c/`] : [])], { env: { ...process.env, CITADEL_URL: `http://127.0.0.1:${PORT}/c/` }, stdio: 'inherit' });
const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(import.meta.dirname, '..', 'wco', 'mouse.ps1')], { stdio: ['pipe', 'pipe', 'inherit'] });
const psQ = [];
readline.createInterface({ input: ps.stdout }).on('line', (l) => psQ.shift()?.(l.trim()));
const input = (cmd) =>
  new Promise((r) => {
    psQ.push(r);
    ps.stdin.write(cmd + '\n');
  });
// Every exit after the app is up goes through here, so a failed run doesn't leave the app and PowerShell running for the next rig.
const quit = async (code) => {
  ps.stdin.end();
  ps.kill();
  app.kill();
  server.close();
  await sleep(500);
  process.exit(code);
};
const until = async (ok, ms = 15000) => {
  for (let t = 0; t < ms && !ok(); t += 200) await sleep(200);
  return ok();
};

const cdp = process.env.RIG_INPUT === 'cdp';
let send = null;
if (cdp) {
  let wsUrl;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${dbg}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {
      await sleep(500);
    }
  }
  const ws = new WebSocket(wsUrl);
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
  const raw = (method, params = {}, sessionId) =>
    new Promise((r, j) => {
      const n = ++id;
      waits.set(n, { r, j });
      ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    });
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = (await raw('Target.getTargets')).targetInfos.find((t) => t.type === 'page');
    if (!page) await sleep(500);
  }
  const sid = (await raw('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
  send = (method, params) => raw(method, params, sid);
}
// CSS px in the page, for DevTools' events.
const css = (where, lower) => {
  const [x, y1, y2] = layout.at[where];
  return [x, lower ? y2 : y1];
};
const mouse = async (where, button, lower) => {
  if (!cdp) return input(`${button === 'right' ? 'rclick' : 'click'} ${(([x, y1, y2]) => [x, lower ? y2 : y1])(at(where)).join(' ')}`);
  const [x, y] = css(where, lower);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0, clickCount: 1 });
};
// SendKeys text, and DevTools' key: [key, code, Windows key code, modifiers (2 Ctrl, 8 Shift)].
const KEYS = { '^r': ['r', 'KeyR', 82, 2], '{F5}': ['F5', 'F5', 116, 0], '^+r': ['R', 'KeyR', 82, 10], '^{F5}': ['F5', 'F5', 116, 2], '{ESC}': ['Escape', 'Escape', 27, 0] };
const press = async (k) => {
  if (!cdp) return input(`key ${k}`);
  const [key, code, vk, modifiers] = KEYS[k];
  for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }).catch(() => {});
};

// Each /c/ load clears the layout; the page sends a new one once it and its frames have loaded.
const ready = async () => {
  await until(() => layout);
  await sleep(600);
};
if (!(await until(() => loads.length, 30000))) {
  console.log('FAIL the app never loaded /c/');
  await quit(1);
}
await ready();
if (!layout) {
  console.log('FAIL the page never sent its layout');
  await quit(1);
}
const at = (where) => {
  const L = layout,
    bx = L.x + (L.ow - L.iw) / 2,
    by = L.y + L.oh - L.ih - (L.ow - L.iw) / 2;
  const [x, y1, y2] = L.at[where];
  return [Math.round((bx + x) * L.dpr), Math.round((by + y1) * L.dpr), Math.round((by + y2) * L.dpr)];
};
const places = ['top', 'same', 'sandboxed', 'cross'];
// Another window (a console left open on the box) may sit on top: the app's window comes forward before each click.
const front = () => input(`front ${app.pid}`);
console.log('front', await front());
await sleep(300);
await input(`shot ${path.join(shots, 'start.png')}`);
let fails = 0;

if (what === 'keys' || what === 'all') {
  console.log('input', cdp ? 'DevTools' : 'real (SendKeys, mouse_event)');
  const keys = [
    ['^r', 'Ctrl+R', false],
    ['{F5}', 'F5', false],
    ['^+r', 'Ctrl+Shift+R', true],
    ['^{F5}', 'Ctrl+F5', true],
  ];
  for (const where of places) {
    for (const [k, name, hard] of keys) {
      focus = null;
      await front();
      await mouse(where, 'left', false);
      // A missed click leaves focus elsewhere, and a reload there would pass for this frame's: no focus, no pass.
      const focused = await until(() => focus === where, 3000);
      const f = focus,
        n = loads.length,
        s = seen.length;
      await press(k);
      const reloaded = await until(() => loads.length > n, 4000);
      const ok = focused && reloaded && (!hard || loads.at(-1).hard);
      if (!ok) fails++;
      console.log(`${ok ? 'PASS' : 'FAIL'} focus ${where.padEnd(9)} (focused: ${f ?? 'unknown'}) ${name.padEnd(12)} -> ${reloaded ? (loads.at(-1).hard ? 'hard reload' : 'reload') : 'no reload'}${seen.length > s ? `; the page got ${seen.slice(s).join(', ')}` : ''}`);
      if (reloaded) await ready();
    }
  }
}

// An open menu would take the next right-click, so each one is closed and the rig waits until it's gone.
const closeMenu = async () => {
  for (let i = 0; i < 10 && (await input('menu')).trim(); i++) {
    await input('menu-close');
    await sleep(300);
  }
};
if (!edge && (what === 'rclick' || what === 'all')) {
  // The rig's own check: a text box always gets the edit menu, so none here means the rig can't see a menu.
  {
    const [x, y] = at('top');
    await front();
    await input(`move ${x} ${y}`);
    await mouse('top', 'right', false);
    await sleep(900);
    const items = (await input('menu')).trim();
    await input(`shot ${path.join(shots, 'rclick-textbox.png')}`);
    console.log(`${items ? 'ok  ' : 'RIG?'} right-click Citadel's text box, menu: ${items || '(none): the rig sees no menu, so the lines below prove nothing'}`);
    if (!items) {
      fails++;
      console.log('FAIL the rig saw no menu on a text box: every right-click result below is unproven');
      console.log('  top-level windows:', await input('windows'));
    }
    await closeMenu();
  }
  for (const where of places) {
    const [x, , y] = at(where);
    await front();
    // A native menu opens at the real cursor, so it goes there first (DevTools' click doesn't move it).
    await input(`move ${x} ${y}`);
    await mouse(where, 'right', true);
    await sleep(900);
    const items = (await input('menu'))
      .split(' | ')
      .map((s) => s.trim())
      .filter(Boolean);
    await input(`shot ${path.join(shots, `rclick-${where}.png`)}`);
    const has = (re) => items.some((i) => re.test(i));
    let ok,
      note = '';
    if (where === 'top') {
      ok = !has(/Reload this app/);
    } else if (process.env.RIG_KIT) ok = !items.length;
    else {
      ok = has(/^Reload this app/) && has(/^Inspect/);
      if (ok) {
        const c = loads.length,
          a = { ...appLoads };
        note = `; ${await input('menu-invoke ^Reload this app')}`;
        const reloaded = await until(() => appLoads[where] > a[where], 4000);
        await sleep(800);
        const others = places.slice(1).filter((p) => p !== where && appLoads[p] !== a[p]);
        ok = reloaded && loads.length === c && !others.length;
        note += reloaded ? `, ${where} reloaded` : ', the frame did not reload';
        if (loads.length !== c) note += ', but the whole window reloaded too';
        if (others.length) note += `, and ${others.join(', ')} too`;
      }
    }
    await closeMenu();
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'} right-click ${where.padEnd(9)} menu: ${items.join(' | ') || '(none)'}${note}`);
    if (loads.length) await ready();
  }
}
writeFileSync(path.join(root, 'last.txt'), `fails ${fails}\n`);
await quit(fails ? 1 : 0);
