// Prints what an expression gives in the first web page of a window started with --remote-debugging-port=<port>.
// Usage: node eval.mjs <port> <expression> [wait seconds before, default 6]
const [port, expression, wait = '6'] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page;
for (let i = 0; i < 60 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && /^https?:/.test(t.url)); } catch {}
  if (!page) await sleep(500);
}
if (!page) { console.log('FAIL no page on port', port); process.exit(1); }
await sleep(Number(wait) * 1000);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { console.log(JSON.stringify(d.result?.result?.value ?? d.result ?? d.error)); ws.close(); } };
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
