// The desktop app's saved password (#1754), end to end on real Windows: the newest published build's Citadel.exe with this
// checkout's desktop/ as its app (as keys.mjs checkout), in a throwaway profile folder, signed out on the WCO rig's dev copy
// (rig.ts up, no driver needed). It signs in with Remember ticked, signs out, and checks the sign-in page comes back filled
// and waits (no sign-in by itself); then a wrong saved password is dropped on its refusal; then Forget empties the form.
//   node saved-login.mjs <config URL from rig.ts up's box line>
// Prints PASS/FAIL lines (exit 1 on a FAIL); shots land in saved-login-rig\ in the checkout (fetch_file reads them).
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const [cfgUrl] = process.argv.slice(2);
const cfg = await (await fetch(`${cfgUrl.replace(/\/$/, '')}/config`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const repo = path.resolve(import.meta.dirname, '../../../../..');
const shots = path.join(repo, 'saved-login-rig');
mkdirSync(shots, { recursive: true });

// The app: the newest build keys.mjs fetched (or build 9), with this checkout's desktop/ files, the ones build.sh ships.
const root = path.join(process.env.TEMP, 'citadel-keys');
mkdirSync(root, { recursive: true });
const have = readdirSync(root).filter((d) => /^build-\d+$/.test(d)).sort((a, b) => Number(b.slice(6)) - Number(a.slice(6)));
let base = have[0] && path.join(root, have[0]);
if (!base) {
  const zip = path.join(root, 'citadel-9.zip');
  execFileSync('curl.exe', ['-fsSL', '-o', zip, 'https://citadel.zip/api/desktop/2/citadel/citadel-9.zip'], { stdio: 'inherit' });
  base = path.join(root, 'build-9');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `$ProgressPreference='SilentlyContinue'; Expand-Archive -Force '${zip}' '${base}'`], { stdio: 'inherit' });
}
if (!existsSync(path.join(base, 'Citadel.exe'))) base = path.join(base, readdirSync(base)[0]);
const dir = path.join(root, 'saved-login');
rmSync(dir, { recursive: true, force: true });
cpSync(base, dir, { recursive: true });
rmSync(path.join(dir, 'resources', 'app'), { recursive: true, force: true });
mkdirSync(path.join(dir, 'resources', 'app'));
const from = path.join(repo, 'desktop');
for (const f of readFileSync(path.join(from, 'build.sh'), 'utf8').match(/cp "\$here"\/\{([^}]+)\} "\$work\/Citadel\/resources\/app\/"/)[1].split(',')) {
  cpSync(path.join(from, f), path.join(dir, 'resources', 'app', f));
}

const [uh, up] = cfg.upstream.split(':');
const fwd = net.createServer((c) => { const u = net.connect(Number(up), uh); c.pipe(u).pipe(c); c.on('error', () => u.destroy()); u.on('error', () => c.destroy()); });
const port = await new Promise((res) => fwd.listen(0, '127.0.0.1', () => res(fwd.address().port)));
const origin = `http://localhost:${port}`;
const profile = mkdtempSync(path.join(os.tmpdir(), 'citadel-saved-login-'));
const dbg = 20000 + Math.floor(Math.random() * 9000);
let app;
const launch = () => { app = spawn(path.join(dir, 'Citadel.exe'), [`--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`], { env: { ...process.env, CITADEL_URL: `${origin}/c/` }, stdio: 'ignore' }); };


/** A DevTools connection to the app's page: ev(expr), until(what, expr), shot(name), close(). */
async function connect() {
  let browserWs;
  for (let i = 0; i < 60 && !browserWs; i++) {
    try { browserWs = (await (await fetch(`http://127.0.0.1:${dbg}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(500); }
  }
  const ws = new WebSocket(browserWs);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waits = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); const w = waits.get(d.id); if (w) { waits.delete(d.id); d.error ? w.j(new Error(d.error.message)) : w.r(d.result); } };
  const send = (method, params = {}, sessionId) => new Promise((r, j) => { const n = ++id; waits.set(n, { r, j }); ws.send(JSON.stringify({ id: n, method, params, sessionId })); });
  let page;
  for (let i = 0; i < 60 && !page; i++) { page = (await send('Target.getTargets')).targetInfos.find((t) => t.type === 'page'); if (!page) await sleep(500); }
  const s = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value;
  return {
    ev,
    send: (method, params) => send(method, params, s),
    async until(what, expr, ms = 20000) {
      for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(250)) if (await ev(expr).catch(() => false)) return;
      throw new Error(`timed out waiting for ${what}`);
    },
    shot: async (name) => writeFileSync(path.join(shots, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, s)).data, 'base64')),
    close: () => ws.close(),
  };
}

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed++; };
const form = `document.getElementById('login-form')`;
const STATE = `(() => { const f = ${form}; const r = f?.querySelector('.login-remember'); const e = document.getElementById('login-error');
  return f && { login: f.login.value, password: f.password.value, row: !!r && !r.hidden, ticked: !!f.remember?.checked,
  forget: !!r && !r.querySelector('button').hidden, error: e.hidden ? '' : e.textContent }; })()`;
const SIGN_OUT = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Sign out').click()`;
const file = path.join(profile, 'saved-login.bin');
const waitFile = async (there) => { for (let i = 0; i < 40 && existsSync(file) !== there; i++) await sleep(250); return existsSync(file) === there; };

let c;
try {
  launch();
  c = await connect();
  await c.send('Page.navigate', { url: `${origin}/c/` });
  await c.until('the sign-in page', `!!${form}`);
  await c.until('the Remember row', `!${form}.querySelector('.login-remember').hidden`);
  let st = await c.ev(STATE);
  check(st.row && !st.ticked && !st.password, 'first sign-in page: Remember shows, unticked, nothing filled');
  await c.ev(`(() => { const f = ${form}; f.login.value = ${JSON.stringify(cfg.login)}; f.password.value = ${JSON.stringify(cfg.password)}; f.remember.click(); })()`);
  await c.shot('1-remember');
  await c.ev(`${form}.querySelector('button[type=submit]').click()`);
  await c.until('signed in', `!${form}`);
  check(await waitFile(true), `signing in with Remember ticked saves it, in this profile's own folder`);
  check(existsSync(file) && !readFileSync(file).toString('latin1').includes(cfg.password), 'the saved file holds no clear password');

  await c.until('the Sign out button', SIGN_OUT.replace('.click()', ''));
  await c.ev(SIGN_OUT);
  await c.until('the fill after signing out', `!!${form}?.password.value`);
  await sleep(3000);
  st = await c.ev(STATE);
  check(st.login === cfg.login && st.password === cfg.password && st.ticked && st.forget, 'after signing out: login and password filled, Remember ticked, Forget shows');
  check(await c.ev(`!!${form}`), 'it waits on the sign-in page: no sign-in by itself after 3 s');
  await c.shot('2-filled');

  // A new start of the app, the same Windows account: still filled.
  c.close();
  app.kill();
  await sleep(2000);
  launch();
  c = await connect();
  await c.until('the fill after a restart', `!!${form}?.password.value`);
  st = await c.ev(STATE);
  check(st.password === cfg.password && st.ticked, 'after restarting the app: still filled');

  // A saved password the server refuses is dropped, and the form shows empty with the error.
  await c.ev(`window.citadelDesktop.saveLogin(${JSON.stringify(cfg.login)}, 'not-the-password-1754')`);
  await c.send('Page.reload', {});
  await c.until('the wrong fill', `${form}?.password.value === 'not-the-password-1754'`);
  await c.ev(`${form}.querySelector('button[type=submit]').click()`);
  await c.until('the refusal', `!document.getElementById('login-error').hidden`);
  st = await c.ev(STATE);
  check(!st.password && !st.ticked && !st.forget && /wrong/i.test(st.error), `a refused saved password: form emptied, unticked, error shown ("${st.error}")`);
  check(await waitFile(false), 'a refused saved password is deleted');
  await c.shot('3-refused');

  // Save it again, then Forget.
  await c.ev(`(() => { const f = ${form}; f.password.value = ${JSON.stringify(cfg.password)}; f.remember.click(); f.querySelector('button[type=submit]').click(); })()`);
  await c.until('signed in', `!${form}`);
  await waitFile(true);
  await c.until('the Sign out button', SIGN_OUT.replace('.click()', ''));
  await c.ev(SIGN_OUT);
  await c.until('the fill again', `!!${form}?.password.value`);
  await c.ev(`${form}.querySelector('.login-remember button').click()`);
  await sleep(500);
  st = await c.ev(STATE);
  check(!st.password && !st.ticked && !st.forget, 'Forget: password emptied, unticked, Forget hidden');
  check(await waitFile(false), 'Forget deletes the saved file');
  await c.shot('4-forgotten');
  await c.send('Page.reload', {});
  await c.until('the sign-in page', `!!${form}`);
  await sleep(2000);
  check(!(await c.ev(STATE)).password, 'after Forget, the next sign-in page is not filled');
} catch (e) {
  console.log(`FAIL ${e.message}`);
  failed++;
  // What the page and the bridge held when it stopped (the password itself left out).
  const seen = await c?.ev(`(async () => { const f = ${form}; const r = await window.citadelDesktop?.savedLogin?.().catch((x) => String(x));
    return { url: location.href, form: !!f, login: f?.login.value, password: f ? f.password.value.length : null, file: null,
      bridge: r && (typeof r === 'string' ? r : { canSave: r.canSave, login: r.login?.login, password: r.login ? r.login.password.length : null }) }; })()`).catch((x) => String(x));
  console.log('seen', JSON.stringify(seen), 'file', existsSync(file));
}

c?.close();
app?.kill();
fwd.close();
await sleep(1500);
rmSync(profile, { recursive: true, force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
