// Copies text inside a browser window at one address, the way a person does (select, then Ctrl+C), for check.ps1 (#1186).
// Usage: node copy.mjs <port> <text, base64>. The window was started with --remote-debugging-port=<port>; this finds its page,
// puts <text> in a textarea, selects it and sends a real Ctrl+C key press through the debugging protocol.
const [port, b64] = process.argv.slice(2);
const text = Buffer.from(b64, 'base64').toString('utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
for (let i = 0; i < 60 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && /^https?:/.test(t.url)); } catch {}
  if (!page) await sleep(500);
}
if (!page) { console.log('FAIL no page on port', port); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const waits = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); waits.get(d.id)?.(d); };
const send = (method, params = {}) => new Promise((r) => { const n = ++id; waits.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });

await sleep(4000); // let the page settle
const at = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
console.log('page', at.result?.result?.value);
await send('Page.bringToFront');
await send('Runtime.evaluate', { userGesture: true, expression: `(() => {
  const t = document.createElement('textarea'); t.value = ${JSON.stringify(text)};
  t.style.cssText = 'position:fixed;top:10px;left:10px;width:600px;height:80px;z-index:99999';
  document.body.append(t); t.focus(); t.select(); return document.activeElement === t; })()`, returnByValue: true });
for (const type of ['rawKeyDown', 'keyUp']) {
  await send('Input.dispatchKeyEvent', { type, modifiers: 2, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, commands: type === 'rawKeyDown' ? ['copy'] : [] });
}
console.log('copied by Ctrl+C');
await sleep(1500);
const ex = await send('Runtime.evaluate', { userGesture: true, expression: `document.execCommand('copy')`, returnByValue: true });
console.log('execCommand copy', ex.result?.result?.value);
ws.close();
