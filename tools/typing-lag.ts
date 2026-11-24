// Does typing in the chat box stall while the scheme updates? (#1077)
//
//   citadel-dev-copy start --data empty && citadel-dev-copy seed busy-scheme
//   node tools/typing-lag.ts [--seconds 30] [--throttle 4] [--rate 2] [--width 1440] [--route '#/p/1'] [--max-delay <ms>] [--profile <file>] [--dismissed-open]
//
// It opens the route in the worktree's dev copy, waits for the dismissed minions to load, then types one key
// every 120 ms into the composer while it plays the server's stream to the page: `--rate` minion updates a
// second, spread over the running minions, the same `ticket` messages a running minion's tool calls broadcast
// (the page's own EventSource handler takes them, so every redraw they cause is the real one). It prints the
// worst input delay (key pressed to its handler starting), the worst key-to-paint time, and the long tasks
// (over 50 ms of main thread) with their total. --throttle slows the CPU as a phone's is (4 is a mid phone).
// At phone widths the key-to-paint figure is not to be trusted: headless Chromium under touch emulation reports
// one ~10 s entry with no load at all, while frames keep coming every 17 ms; input delay and long tasks hold.
// --dismissed-open opens the Dismissed list first, so every redraw builds its rows too. --max-delay exits 1 when the worst input delay passes it. --profile saves a CPU profile for DevTools.
import { writeFileSync } from 'node:fs';
import { open } from './ui-shot.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const seconds = Number(arg('seconds', '30'));
const throttle = Number(arg('throttle', '1'));
const rate = Number(arg('rate', '2'));
const width = Number(arg('width', '1440'));
const route = arg('route', '#/p/1');
const maxDelay = Number(arg('max-delay', '0'));
const profile = arg('profile', '');

// Before the page's own scripts: keep hold of its EventSource, and watch long tasks and key events.
const INIT = `
  const ES = window.EventSource;
  window.EventSource = class extends ES { constructor(...a) { super(...a); window.__es = this; } };
  window.__lag = { tasks: [], delay: 0, paint: 0, keys: 0, on: false };
  new PerformanceObserver((l) => { if (__lag.on) for (const e of l.getEntries()) __lag.tasks.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
  new PerformanceObserver((l) => {
    if (!__lag.on) return;
    for (const e of l.getEntries()) {
      if (e.name !== 'keydown') continue;
      __lag.paint = Math.max(__lag.paint, e.duration);
    }
  }).observe({ type: 'event', durationThreshold: 16 });
  addEventListener('keydown', (e) => { if (__lag.on) { __lag.keys++; __lag.delay = Math.max(__lag.delay, performance.now() - e.timeStamp); } }, true);
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const page = await open(route, { width });
let failed = false;
try {
  await page.s('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
  await page.s('Page.reload');
  const until = async (expr: string, what: string) => {
    for (const end = Date.now() + 30_000; !(await page.evaluate(expr).catch(() => false)); await sleep(100)) if (Date.now() > end) throw new Error(`${what} never came`);
  };
  await until(`!!window.__es && !!document.querySelector('.composer textarea') && !!document.querySelector('#threads .thread-row')`, 'the scheme page');
  // The dismissed minions load behind the first paint: wait until the list stops growing.
  const scheme = await page.evaluate(`fetch('api/projects/' + location.hash.match(/p\\/(\\d+)/)[1]).then((r) => r.json()).then((j) => ({ dismissed: j.dismissed, running: j.tickets.filter((t) => t.status === 'running') }))`);
  if (scheme.dismissed) await until(`!!document.querySelector('#threads details.g-closed')`, 'the dismissed list');
  if (!scheme.running.length) throw new Error('no running minion to update: seed busy-scheme first');
  await page.evaluate(`window.__running = ${JSON.stringify(scheme.running)}`);
  if (process.argv.includes('--dismissed-open')) {
    // A phone's minions drawer starts shut: open it, then the list, and see its rows before measuring.
    await page.evaluate(`document.querySelector('details.sidebar').open = true; document.querySelector('#threads details.g-closed summary').click()`);
    await until(`!!document.querySelector('#threads details.g-closed .thread-row')`, 'the dismissed rows');
  }
  await page.do('click .composer textarea');
  if (throttle > 1) await page.s('Emulation.setCPUThrottlingRate', { rate: throttle });
  if (profile) {
    await page.s('Profiler.enable');
    await page.s('Profiler.start');
  }
  // The stream, played from inside the page so a busy main thread delays it as it would the real one.
  await page.evaluate(`(() => {
    let n = 0;
    __lag.on = true;
    __lag.timer = setInterval(() => {
      const t = __running[n++ % __running.length];
      __es.onmessage({ data: JSON.stringify({ type: 'ticket', ticket: { ...t, last_activity: 'Running commands ' + n, updated_at: Date.now() } }) });
    }, ${Math.round(1000 / rate)});
  })()`);
  const text = 'the quick brown fox jumps over the lazy dog ';
  const end = Date.now() + seconds * 1000;
  for (let i = 0; Date.now() < end; i++) {
    const ch = text[i % text.length];
    await page.s('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
    await page.s('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await sleep(120);
  }
  await sleep(300);
  const lag = await page.evaluate(`(clearInterval(__lag.timer), __lag.on = false, { tasks: __lag.tasks, delay: Math.round(__lag.delay), paint: Math.round(__lag.paint), keys: __lag.keys, typed: document.querySelector('.composer textarea').value.length, rows: document.querySelectorAll('#threads .thread-row').length })`);
  if (profile) {
    const { profile: cpu } = await page.s('Profiler.stop');
    writeFileSync(profile, JSON.stringify(cpu));
  }
  const total = lag.tasks.reduce((a: number, b: number) => a + b, 0);
  console.log(`typing-lag: ${width} px, CPU ${throttle}x, ${rate} updates/s, ${seconds} s, ${lag.rows} rows in the list`);
  console.log(`  keys typed: ${lag.keys} (${lag.typed} in the box)`);
  console.log(`  worst input delay: ${lag.delay} ms`);
  console.log(`  worst key-to-paint: ${lag.paint} ms`);
  console.log(`  long tasks (>50 ms): ${lag.tasks.length}, ${total} ms in all, worst ${Math.max(0, ...lag.tasks)} ms`);
  if (!lag.keys) {
    console.log('  FAILED: no key reached the page, so nothing was measured');
    failed = true;
  }
  if (maxDelay && lag.delay > maxDelay) {
    console.log(`  FAILED: worst input delay ${lag.delay} ms is over ${maxDelay} ms`);
    failed = true;
  }
} finally {
  await page.close();
}
process.exit(failed ? 1 : 0);
