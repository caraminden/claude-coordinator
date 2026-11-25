// What one added node costs in style (#1534): a page's `:has()` rules can make every insert restyle the whole page.
//
//   citadel-dev-copy start
//   node tools/has-cost.ts [--route '#/p/2'] [--width 1440] [--rounds 6]
//
// It opens the route (a scheme page with a chat open, so `#log` exists) in the worktree's dev copy and, `--rounds`
// times over, appends a div to `#log` 31 times and takes the median of the style recalc each one forces, first with
// the sheets as shipped, then with every `:has()` rule deleted, alternating so a box whose speed drifts hits both.
// Calibration is a fixed busy loop (3e7 steps): compare numbers only between runs with a similar one, and write
// the box load beside them. test/css-has-cost.test.ts keeps the costly shape out.
//
// Numbers from this tool on perigee, scheme 2 at 1440 px, 2026-11-21 (dev copy of the live data):
//   main at 56768f2c, load 62.5:  21.2 ms median as shipped (18.5 to 21.6), 0.8 ms with no :has() (calibration 35 to 84)
//   #1534, load 57.3:             2.8 ms median (0.8 to 3.5), 0.7 ms with no :has() (calibration 30 to 54)
//   #1534, load 74.2:             3.1 ms median (2.6 to 3.5), 0.7 ms with no :has() (calibration 37 to 133)
import { loadavg } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { open } from './ui-shot.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const route = arg('route', '#/p/2');
const width = Number(arg('width', '1440'));
const rounds = Number(arg('rounds', '6'));

const page = await open(route, { width });
try {
  for (const end = Date.now() + 120_000; !(await page.evaluate(`!!document.querySelector('#log') && !document.body.classList.contains('navigating')`).catch(() => false)); await sleep(200)) {
    if (Date.now() > end) throw new Error(`no chat (#log) on ${route}: open a scheme page whose chat shows`);
  }
  await sleep(3000);
  const r = await page.evaluate(`(() => {
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const log = document.querySelector('#log');
    const insert = (n = 31) => { const ts = []; for (let i = 0; i < n; i++) { document.body.offsetHeight; const d = document.createElement('div'); d.className = 'msg'; d.textContent = 'x' + i; log.append(d); const t = performance.now(); getComputedStyle(document.body).color; ts.push(performance.now() - t); d.remove(); } return +med(ts).toFixed(2); };
    const calib = () => { const t = performance.now(); let x = 0; for (let i = 0; i < 3e7; i++) x += i % 7; return Math.round(performance.now() - t); };
    const rules = [];
    const walk = (owner) => { for (let i = 0; i < owner.cssRules.length; i++) { const r = owner.cssRules[i]; if (r.selectorText?.includes(':has(')) rules.push({ owner, i, text: r.cssText }); else if (r.cssRules?.length) walk(r); } };
    for (const s of document.styleSheets) { try { walk(s); } catch {} }
    const out = { rules: rules.length, shipped: [], none: [], calib: [] };
    for (let k = 0; k < ${rounds}; k++) {
      out.calib.push(calib());
      out.shipped.push(insert());
      for (const x of [...rules].reverse()) x.owner.deleteRule(x.i);
      out.none.push(insert());
      for (const x of rules) x.owner.insertRule(x.text, x.i);
    }
    return out;
  })()`);
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
  console.log(`load ${loadavg()[0].toFixed(1)}, ${r.rules} :has() rules, calibration ${r.calib.join(' ')}`);
  console.log(`one insert, as shipped:   ${r.shipped.join(' ')} ms (median ${med(r.shipped)})`);
  console.log(`one insert, no :has():    ${r.none.join(' ')} ms (median ${med(r.none)})`);
} finally {
  await page.close();
}
