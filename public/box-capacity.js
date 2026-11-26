// How many minions fit (#1987), beside the Status page's Workers tile: each reading a dot, load against the turns
// running at the time, and a slider that says what the readings near a number show. The numbers come worked out
// (src/box-capacity.ts); it changes nothing, and the pool's size, which workers.js tells it, is a mark on the chart.
import { api, h, pacificStamp, poller, svg } from './base.js';
import { emptyCard, statTiles, toneChip } from './look.js';

/** @import { BoxCapacity, BoxRow } from './types.js' */

const READ_MS = 60_000;
const plural = (/** @type {number} */ n, /** @type {string} */ word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const load = (/** @type {number | null} */ v) => (v === null ? '–' : v >= 100 ? `${Math.round(v)}` : `${Math.round(v * 10) / 10}`);
const pct = (/** @type {Pick<BoxRow, 'stalls' | 'stallOf'>} */ r) => (r.stallOf ? `${Math.round((r.stalls / r.stallOf) * 1000) / 10}%` : '–');
/** @type {BoxRow} */
const NONE = { count: 0, typical: null, high: null, stalls: 0, stallOf: 0 };
const TICKS = [0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000];
/** A dot this many px from the pointer is the one it means. */
const REACH = 18;

/** The panel; `page` is the pane it sits on. `resume` starts its reads, `dragging` is true while a person holds the slider. */
export function capacityPanel(/** @type {HTMLElement} */ page) {
  /** @type {BoxCapacity | null} */
  let d = null;
  /** @type {string | null} */
  let failed = null;
  /** @type {number | null} */
  let pool = null;
  let n = 0; // the slider's number; the pool's size until a person moves it (set by draw)
  let moved = false;
  let held = false;
  let owed = false; // news came while a person held the slider: drawn when they let go
  /** @type {{ pick: () => void } | null} */
  let chart = null; // what a move of the slider updates
  let width = 0;

  const range = h('input', { type: 'range', min: 0, step: 1, 'aria-label': 'Turns at once', class: 'st-fit-range', oninput: () => pick(Number(range.value)) });
  range.addEventListener('pointerdown', () => {
    held = true;
    const end = new AbortController();
    for (const ev of ['pointerup', 'pointercancel', 'blur'])
      window.addEventListener(
        ev,
        () => {
          held = false;
          end.abort();
          if (owed) draw();
        },
        { signal: end.signal },
      );
  });
  const number = h('output', { class: 'st-fit-n' });
  const numbers = h('div', { class: 'st-fit-numbers' });
  const figure = h('div', { class: 'st-fit-chart' });
  const head = h('div', { class: 'st-fit-head' });
  const notes = h('div', { class: 'st-fit-notes' });
  const table = h('details', { class: 'st-limits st-fit-table' });
  const control = h('label', { class: 'st-fit-pick' }, h('span', {}, 'Turns at once'), range, number);
  const body = h('div', { class: 'st-fit-body' }, control, numbers, figure, notes, table);
  const title = h('h4', {}, 'How many minions fit');
  const el = h('section', { class: 'st-tile wide st-lines st-fit loading', 'data-tile': 'fit' }, title, head, body);

  // Nothing here runs before a read: draw() and the slider come once `d` is in.
  const data = () => /** @type {BoxCapacity} */ (d);
  const near = () => data().near[n] ?? NONE;
  const most = () => Math.max(data().near.length - 1, pool ?? 0, 1);

  const pick = (/** @type {number} */ to) => {
    moved = true;
    n = to;
    drawPick();
  };

  /** What the slider's number changes: its words, and which dots are near it. */
  const drawPick = () => {
    const d = data();
    range.max = String(most());
    range.value = String(n);
    range.style.setProperty('--at', `${(n / most()) * 100}%`);
    number.textContent = String(n);
    const r = near();
    const few = r.count < d.enough;
    range.setAttribute('aria-valuetext', `${plural(n, 'turn')} at once: ${few ? 'not enough readings' : `typical load ${load(r.typical)}, 1 in 10 readings above ${load(r.high)}, ${pct(r)} of readings stalled`}`);
    numbers.replaceChildren(
      few
        ? emptyCard('Not enough readings', `${plural(r.count, 'reading')} near ${plural(n, 'turn')} at once; ${d.enough} say something.`, { mark: '·', hue: 'waiting' })
        : statTiles(
            [load(r.typical), 'typical load', /** @type {number} */ (r.typical) > d.cores ? 'waiting' : 'running'],
            [load(r.high), '1 in 10 readings above', /** @type {number} */ (r.high) > d.cores * 2 ? 'waiting' : 'running'],
            [pct(r), `of readings stalled (${r.stalls} of ${r.stallOf})`, r.stalls > d.stallShare * r.stallOf ? 'danger' : 'running'],
            [r.count, `readings near ${n}`, 'running'],
          ),
    );
    chart?.pick();
  };

  const drawHead = () => {
    const d = data();
    const { turns, past } = d.comfortable;
    if (turns === null) {
      const words = past === null ? 'Not enough readings' : `Loaded even at ${plural(past, 'turn')} at once`;
      head.replaceChildren(h('b', { class: 'st-value' }, words), h('div', { class: 'st-sub muted' }, `A number needs ${d.enough} readings near it.`));
      return;
    }
    const chip = pool === null ? '' : pool > turns ? toneChip('warn', `pool is ${pool}, ${pool - turns} above`) : toneChip('info', `pool is ${pool}`);
    const why = past === null ? ` Past ${turns} there are not enough readings to say.` : '';
    head.replaceChildren(h('div', { class: 'st-fit-say' }, h('b', { class: 'st-value' }, `${past === null ? 'At least ' : ''}${plural(turns, 'turn')} at once ${turns === 1 ? 'is' : 'are'} comfortable`), chip), h('div', { class: 'st-sub muted' }, `From ${plural(d.near[turns].count, 'reading')} near ${turns}.${why}`));
  };

  const drawNotes = () => {
    const d = data();
    const old = d.waiting.count;
    const all = d.readings.length;
    notes.replaceChildren(
      h('p', { class: 'look-prose' }, `Comfortable: typical load within the ${d.cores} cores, and memory stalled in no more than ${Math.round(d.stallShare * 100)}% of readings, at that number and every lower one with enough readings.`),
      h('p', { class: 'look-prose' }, 'Load is the whole box: heavy builds and tests land on it too, so turns explain only part of it. Turns running also counts Taskmasters and, for a few minutes, turns waiting on a card. The pool leaves both out, so a pool this size runs a few more turns than its number.'),
      old
        ? h(
            'p',
            { class: 'look-prose' },
            toneChip('info', old === all ? 'All readings' : `${old.toLocaleString('en-US')} of ${all.toLocaleString('en-US')} readings`),
            ` are from before ${pacificStamp(d.waiting.until)}, when a turn waiting on a card or a job still counted as running. Today's pool gives that worker back, so more of its turns are working at the same number: read the comfortable number as a little high.`,
          )
        : '',
    );
  };

  const drawTable = () => {
    const d = data();
    table.replaceChildren(
      h('summary', {}, 'As a table'),
      h(
        'div',
        { class: 'st-fit-scroll' },
        h(
          'table',
          { class: 'ci-pools' },
          h('thead', {}, h('tr', {}, ...['Turns at once', 'Readings', 'Typical load', '1 in 10 above', 'Stalled'].map((t, i) => h('th', { scope: 'col', class: i ? 'num' : null }, t)))),
          h('tbody', {}, ...d.bands.map((b) => h('tr', {}, h('th', { scope: 'row' }, b.to === null ? `${b.from}+` : `${b.from} to ${b.to}`), ...[b.count, load(b.typical), load(b.high), b.stallOf ? `${pct(b)} (${b.stalls})` : '–'].map((v) => h('td', { class: 'num' }, String(v)))))),
        ),
      ),
      h('p', { class: 'look-prose' }, `Stalled: memory pressure of ${d.stallPct}% or more. Fewer than ${d.enough} readings in a row say little.`),
    );
  };

  /** The chart at the width it has, so its words keep their size on a phone. */
  const drawChart = () => {
    const W = width;
    if (!W || !d?.readings.length) return;
    const drawn = d; // not null from here, which the callbacks below can't tell
    const H = W < 520 ? 300 : 340;
    const [L, R, T, B] = [36, 10, 22, 40];
    const max = most();
    const loads = d.readings.map((r) => r[2]);
    const lo = Math.max(0.1, Math.min(1, ...loads));
    const hi = Math.max(d.cores * 2, ...loads) * 1.15;
    const step = (W - L - R) / (max + 1);
    const x = (/** @type {number} */ t) => L + (t + 0.5) * step;
    const y = (/** @type {number} */ v) => T + (1 - Math.log(Math.max(v, lo) / lo) / Math.log(hi / lo)) * (H - T - B);
    const base = H - B;
    const every = [1, 2, 5, 10].find((s) => step * s >= 26) ?? 20;
    const { turns: fits } = d.comfortable;
    // Dots by number of turns, so a move of the slider lights whole columns; a spread inside the column keeps them apart.
    /** @type {Map<number, SVGElement>} */
    const columns = new Map();
    const dots = d.readings.map(([at, turns, l, used, stall], i) => {
      const cx = x(turns) + (((i * 37) % 11) / 11 - 0.45) * step * 0.7;
      const cy = y(l);
      const bad = stall !== null && stall >= drawn.stallPct;
      if (!columns.has(turns)) columns.set(turns, svg('g', { class: 'st-fit-col' }));
      /** @type {SVGElement} */ (columns.get(turns)).append(bad ? svg('path', { class: 'st-fit-stall', d: `M${cx.toFixed(1)},${(cy - 6).toFixed(1)}l6,6l-6,6l-6,-6z` }) : svg('circle', { class: 'st-fit-dot', cx: cx.toFixed(1), cy: cy.toFixed(1), r: 3 }));
      return { cx, cy, at, turns, l, used, stall, bad };
    });
    // The typical load's line: whole where a number has enough readings near it, dashed where it has a few.
    const path = (/** @type {number} */ least) => {
      let out = '';
      let pen = false;
      drawn.near.forEach((r, t) => {
        if (r.count >= least) out += `${pen ? 'L' : 'M'}${x(t).toFixed(1)},${y(/** @type {number} */ (r.typical)).toFixed(1)}`;
        pen = r.count >= least;
      });
      return out;
    };
    const band = svg('rect', { class: 'st-fit-band', y: T, height: base - T, rx: 4, x: 0, width: (Math.min(3, max + 1) * step).toFixed(1) });
    const ring = svg('circle', { class: 'st-fit-ring', r: 8, visibility: 'hidden' });
    const mark = svg('g', { class: 'st-fit-pool' });
    if (pool !== null) {
      const right = x(pool) > W - 70;
      mark.append(svg('line', { x1: x(pool), x2: x(pool), y1: T - 6, y2: base }), svg('text', { x: x(pool) + (right ? -5 : 5), y: T - 8, 'text-anchor': right ? 'end' : 'start' }, `pool ${pool}`));
    }
    const root = svg(
      'svg',
      { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Load against turns running: ${plural(d.readings.length, 'reading')}${fits === null ? '' : `, comfortable up to ${fits}`}. The table below has the numbers.` },
      ...TICKS.filter((v) => v >= lo && v <= hi).flatMap((v) => [svg('line', { class: 'st-fit-grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }), svg('text', { class: 'st-fit-tick', x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, String(v))]),
      ...Array.from({ length: max + 1 }, (_, t) => t)
        .filter((t) => t % every === 0)
        .map((t) => svg('text', { class: 'st-fit-tick', x: x(t), y: base + 20, 'text-anchor': 'middle' }, String(t))),
      svg('text', { class: 'st-fit-tick', x: W - R, y: H - 4, 'text-anchor': 'end' }, 'turns running at once'),
      svg('text', { class: 'st-fit-tick', x: 2, y: T - 8 }, 'load'),
      band,
      svg('line', { class: 'st-fit-cores', x1: L, x2: W - R, y1: y(d.cores), y2: y(d.cores) }),
      svg('text', { class: 'st-fit-tick halo', x: W - R, y: y(d.cores) - 5, 'text-anchor': 'end' }, `${d.cores} cores`),
      // Only under numbers with enough readings: a gap in them is a gap in the bar.
      ...d.near.flatMap((r, t) => (fits !== null && t <= fits && r.count >= drawn.enough ? [svg('rect', { class: 'st-fit-ok', x: L + t * step, y: base + 2, width: step + 0.5, height: 4 })] : [])),
      ...columns.values(),
      svg('path', { class: 'st-fit-halo', d: path(d.enough) }),
      svg('path', { class: 'st-fit-line few', d: path(4) }),
      svg('path', { class: 'st-fit-line', d: path(d.enough) }),
      mark,
      ring,
    );
    const tip = h('div', { class: 'st-fit-tip', hidden: true });
    const at = (/** @type {MouseEvent} */ e) => {
      const box = root.getBoundingClientRect();
      return [e.clientX - box.left, e.clientY - box.top];
    };
    const hide = () => {
      tip.hidden = true;
      ring.setAttribute('visibility', 'hidden');
    };
    const hover = (/** @type {MouseEvent} */ e) => {
      const [px, py] = at(e);
      /** @type {(typeof dots)[number] | null} */
      let best = null;
      let gap = REACH;
      for (const dot of dots) {
        const far = Math.hypot(dot.cx - px, dot.cy - py);
        if (far < gap) [best, gap] = [dot, far];
      }
      if (!best) return hide();
      ring.setAttribute('cx', String(best.cx));
      ring.setAttribute('cy', String(best.cy));
      ring.setAttribute('visibility', 'visible');
      tip.replaceChildren(h('b', {}, pacificStamp(best.at)), h('span', {}, `${plural(best.turns, 'turn')} running, load ${load(best.l)}`), h('span', { class: best.bad ? 'bad' : 'muted' }, `Memory ${Math.round(best.used)}% used${best.stall === null ? '' : `, stall ${best.stall}%`}`));
      tip.hidden = false;
      tip.style.left = `${Math.max(0, Math.min(W - tip.offsetWidth, best.cx - tip.offsetWidth / 2))}px`;
      const above = best.cy - tip.offsetHeight - 14;
      tip.style.top = `${above >= 0 ? above : best.cy + 14}px`;
    };
    root.addEventListener('pointermove', /** @type {EventListener} */ (hover));
    root.addEventListener('pointerleave', hide);
    root.addEventListener('click', (/** @type {MouseEvent} */ e) => {
      hover(e);
      pick(Math.max(0, Math.min(max, Math.floor((at(e)[0] - L) / step))));
    });
    figure.replaceChildren(
      h(
        'div',
        { class: 'st-fit-legend', 'aria-hidden': 'true' },
        h('span', { class: 'k reading' }, 'A reading'),
        h('span', { class: 'k stall' }, `Memory stalled ${d.stallPct}% or more`),
        h('span', { class: 'k line' }, 'Typical load'),
        h('span', { class: 'k line few' }, `Under ${d.enough} readings near`),
        fits === null ? '' : h('span', { class: 'k ok' }, 'Comfortable'),
      ),
      h('div', { class: 'st-fit-plot' }, root, tip),
    );
    chart = {
      pick() {
        const from = Math.max(0, n - 1);
        band.style.transform = `translateX(${(L + from * step).toFixed(1)}px)`;
        band.setAttribute('width', ((Math.min(max, n + 1) - from + 1) * step).toFixed(1));
        for (const [t, g] of columns) g.classList.toggle('near', Math.abs(t - n) <= 1);
      },
    };
    chart.pick();
  };

  const draw = () => {
    const none = !d?.readings.length;
    owed = false;
    body.hidden = none;
    el.classList.toggle('loading', !d && !failed);
    title.textContent = d && failed ? `How many minions fit · couldn't read again: ${failed}` : 'How many minions fit';
    if (!d) return head.replaceChildren(h('b', { class: 'st-value' }, failed ? `Couldn't read it: ${failed}` : 'Reading…'));
    if (none) return head.replaceChildren(emptyCard('No readings yet', 'The server reads its load and the turns running every 5 minutes. Each reading becomes a dot here.', { mark: '·', hue: 'running' }));
    n = moved ? Math.min(n, most()) : (pool ?? d.comfortable.turns ?? 0);
    drawHead();
    drawNotes();
    drawTable();
    drawChart();
    drawPick();
  };

  page.addEventListener('pool', (e) => {
    const { detail } = /** @type {CustomEvent<number | null>} */ (e);
    if (pool === detail) return;
    pool = detail;
    if (held) owed = true;
    else if (d) draw();
  });
  new ResizeObserver(() => {
    const w = Math.floor(figure.clientWidth);
    if (!w || w === width) return;
    width = w;
    if (d) draw();
  }).observe(figure);

  const read = poller(async () => {
    if (!page.isConnected) return false;
    try {
      /** @type {BoxCapacity} */
      const next = await api('api/box-capacity');
      const same = d && !failed && next.readings.at(-1)?.[0] === d.readings.at(-1)?.[0] && next.readings.length === d.readings.length;
      failed = null;
      d = next;
      if (same) return;
      if (held) owed = true;
      else draw();
    } catch (err) {
      failed = /** @type {Error} */ (err).message;
      if (held) owed = true;
      else draw();
    }
  }, READ_MS);
  draw();
  return Object.assign(el, { resume: () => read.now(), dragging: () => held });
}
