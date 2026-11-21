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
// Numbers on perigee, scheme 2 at 1440 px (2026-11-21):
//   before (main at 56768f2c), load 62:   16.8 ms as shipped, 0.8 ms with no :has() (calibration 78 then 57)
//   before, has.mjs run, load 67:         18.9 ms as shipped (calibration 45)
//   after (#1534), load 67 to 76:         2.1 to 3.4 ms a round, medians 2.8 and 3.1 (calibration 36 to 84)
import { loadavg } from 'node:os';
import { open } from './ui-shot.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const route = arg('route', '#/p/2');
const width = Number(arg('width', '1440'));
const rounds = Number(arg('rounds', '6'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const page: any = await open(route, { width });
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
