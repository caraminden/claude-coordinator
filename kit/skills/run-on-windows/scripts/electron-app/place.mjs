// Where Citadel's desktop app (#1186, desktop/) opens: on a fresh profile (most of the screen), from a saved place,
// from a saved place that is off every screen (back to most of the screen), and maximised. Prints each window's
// bounds (CSS px) against the screen's work area. No server needed: the page may fail to load.
//   node place.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const repo = path.resolve(import.meta.dirname, '../../../../..');
const electron = path.join(process.env.LOCALAPPDATA, 'defender-copy', 'node_modules', 'electron', 'dist', 'electron.exe');
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-place-'));

async function run(label, saved) {
  if (saved) fs.writeFileSync(path.join(prof, 'window.json'), JSON.stringify(saved));
  else fs.rmSync(path.join(prof, 'window.json'), { force: true });
  const dbg = 20000 + Math.floor(Math.random() * 9000);
  const app = spawn(electron, [`--user-data-dir=${prof}`, `--remote-debugging-port=${dbg}`, path.join(repo, 'desktop')], { env: { ...process.env, CITADEL_URL: 'http://127.0.0.1:9/c/' }, stdio: 'ignore' });
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
    if (!page) await sleep(500);
  }
  await sleep(2000);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const v = await new Promise((r) => {
    ws.onmessage = (m) => r(JSON.parse(m.data).result.result.value);
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: '({ x: screenX, y: screenY, w: outerWidth, h: outerHeight, area: [screen.availLeft, screen.availTop, screen.availWidth, screen.availHeight] })' } }));
  });
  ws.close();
  app.kill();
  await sleep(1500);
  console.log(label.padEnd(22), JSON.stringify(v));
}

await run('fresh profile');
await run('saved 200,150 900x700', { x: 200, y: 150, width: 900, height: 700, maximized: false });
await run('saved off screen', { x: 9000, y: 9000, width: 900, height: 700, maximized: false });
await run('saved maximised', { x: 200, y: 150, width: 900, height: 700, maximized: true });
fs.rmSync(prof, { recursive: true, force: true });
process.exit(0);
