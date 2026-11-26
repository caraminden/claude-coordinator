// Minion day strips (#1996, Josh's pick of "Day C" on 2026-11-25), on the Releases page's Status tab: every minion of the
// picked scheme that went live on a day, one thin strip each from its real start to live, coloured by what it was doing.
// src/day-strips.ts cuts them from #1991's time log; the part colours are time-log.css's.
import { api, h, pacificClockBare, pacificDate, pacificIso, pacificStamp, pacificZone } from './base.js';
import { shortDuration } from './chattext.js';
import { emptyCard } from './look.js';
import { mountTips } from './ui/tip.js';

/** @import { Strip, StripPartName } from './types.js' */
/** @typedef {Record<StripPartName, number>} Totals */
const SVG = 'http://www.w3.org/2000/svg';
/**
 * @param {string} tag
 * @param {Record<string, string | number | null | undefined>} [attrs]
 * @param {...(Node | string)} kids
 */
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  el.append(...kids);
  return el;
};
/** The parts, in src/day-strips.ts's order, with the words people read. */
/** @type {[StripPartName, string][]} */
export const PARTS = [
  ['work', 'Working'],
  ['person', 'Waiting on a person'],
  ['line', 'Ship line'],
  ['ci', 'CI'],
  ['deploy', 'Deploying'],
  ['other', 'Other waits'],
  ['none', 'Nothing recorded'],
];
/** @type {Partial<Record<StripPartName, string>>} */
const WHY = {
  other: 'Sealed on another minion, held, at a usage limit, waiting for a job or a worker',
  none: 'No record says what this time was. Waits between turns were written down only from late November 2026, so older days have more of it.',
};
/** @type {[string, string][]} */
const TYPES = [
  ['all', 'All'],
  ['feature', 'Features'],
  ['bug', 'Bug fixes'],
  ['chore', 'Chores'],
];
/** @type {[string, string][]} */
const SORTS = [
  ['short', 'Shortest first'],
  ['wait', 'Most waiting first'],
];
/** @type {[string, string][]} */
const LOOKS = [
  ['chart', 'Chart'],
  ['table', 'Table'],
];
/** How long a read of the same scheme stands before showing the tab again reads it again (the server keeps today's 2 min). */
const FRESH_MS = 120_000;
const TICKS = [5, 15, 30, 60, 120, 240, 480, 960, 1440, 2880, 5760, 11520].map((m) => m * 60_000);
const tickWord = (/** @type {number} */ ms) => (ms < 3_600_000 ? `${ms / 60_000} min` : ms < 86_400_000 ? `${ms / 3_600_000} h` : `${ms / 86_400_000} d`);
const dur = (/** @type {number} */ ms) => (ms >= 86_400_000 ? `${Math.floor(ms / 86_400_000)}d ${shortDuration(ms % 86_400_000)}` : shortDuration(ms));
const pct = (/** @type {number} */ v, /** @type {number} */ all) => `${Math.round((v / (all || 1)) * 100)}%`;
const median = (/** @type {number[]} */ xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const shiftDay = (/** @type {string} */ day, /** @type {number} */ by) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
};
const dayWords = (/** @type {string} */ day) => `${new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' })}, ${pacificDate(day)}`;
/** A time in the table: the clock alone on `day`, with its date on any other. */
const clock = (/** @type {number} */ ms, /** @type {string} */ day) => (pacificIso(ms) === day ? pacificClockBare(ms) : `${pacificDate(ms)}, ${pacificClockBare(ms)}`);
const name = (/** @type {Strip} */ s) => `${s.number != null ? `#${s.number} ` : ''}${s.title}`;
const typeOf = (/** @type {Strip} */ s) => (s.type === 'feature' || s.type === 'bug' || s.type === 'chore' ? s.type : 'other');

/**
 * A strip's tip: its name, its times, and where its time went.
 * @param {Strip} s
 */
export function stripTip(s) {
  const len = s.live - s.start;
  const lines = [name(s), `Started ${pacificStamp(s.start)}, live ${pacificStamp(s.live)}`, `Start to live: ${dur(len)}`];
  for (const [k, words] of PARTS) if (s.totals[k] >= 1000) lines.push(`${words}: ${dur(s.totals[k])} (${pct(s.totals[k], len)})`);
  return lines.join('\n');
}

/**
 * The strips shown: the filter's type, in the picked order.
 * @param {Strip[]} strips
 * @param {string} type
 * @param {string} sort
 */
export function shown(strips, type, sort) {
  const of = type === 'all' ? strips : strips.filter((s) => typeOf(s) === type);
  const len = (/** @type {Strip} */ s) => s.live - s.start;
  return [...of].sort(sort === 'wait' ? (a, b) => b.totals.person - a.totals.person || len(a) - len(b) : (a, b) => len(a) - len(b) || a.start - b.start);
}

/** @type {import('./ui/tip.js').Tips | null} */
let tips = null;
const tipBody = (/** @type {Element} */ el) => {
  const text = /** @type {HTMLElement | SVGElement} */ (el).dataset.tip;
  if (!text) return null;
  const [head, ...rest] = text.split('\n');
  return h('span', { class: 'cui-tip-text ds-tip' }, h('b', {}, head), ...rest.map((l) => h('span', {}, l)));
};

/** The panel; `show(scheme)` points it at a scheme's id ('all': none picked). */
export function dayStripsPanel() {
  /** @type {number | 'all' | null} */
  let scheme = null;
  let day = pacificIso(Date.now());
  let type = 'all';
  let sort = 'short';
  let look = 'chart';
  /** @type {{ scheme: number, day: string, strips: Strip[] } | null} */
  let data = null; // once read
  let failed = '';
  let asked = 0;
  let width = 0;
  /** @type {number | null} */
  let picked = null;
  let readAt = 0;

  const chips = (/** @type {string} */ label, /** @type {[string, string][]} */ options, /** @type {string} */ now, /** @type {(k: string) => void} */ set) =>
    h('div', { class: 'chips ds-chips', role: 'group', 'aria-label': label }, ...options.map(([k, words]) => h('button', { type: 'button', class: `chip${k === now ? ' on' : ''}`, 'aria-pressed': String(k === now), onclick: () => set(k) }, words)));
  const dateInput = h('input', {
    type: 'date',
    class: 'ds-date',
    'aria-label': 'Day',
    onchange: () => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) go(dateInput.value);
    },
  });
  const step = (/** @type {number} */ by, /** @type {string} */ words, /** @type {string} */ label) => h('button', { type: 'button', class: 'secondary ds-step', 'aria-label': label, onclick: () => go(shiftDay(day, by)) }, words);
  const before = step(-1, '‹', 'The day before');
  const next = step(1, '›', 'The day after');
  const controls = h('div', { class: 'ds-controls' });
  const body = h('div', { class: 'ds-body' });
  const el = h('section', { class: 'st-tile wide ds-panel', 'data-tile': 'day-strips' }, h('h4', {}, 'Start to live, minion by minion'), controls, body);
  const resize = new ResizeObserver(() => {
    const w = Math.round(body.clientWidth);
    if (w && Math.abs(w - width) > 2) {
      width = w;
      drawBody();
    }
  });
  resize.observe(body);

  const go = (/** @type {string} */ to) => {
    if (to > pacificIso(Date.now())) to = pacificIso(Date.now());
    day = to;
    picked = null;
    readAt = Date.now();
    read();
  };
  const read = async () => {
    drawControls();
    if (scheme == null || scheme === 'all') return drawBody();
    const ask = ++asked;
    const want = { scheme, day };
    failed = '';
    if (!data || data.scheme !== scheme || data.day !== day) {
      data = null;
      drawBody();
    }
    try {
      const got = await api(`api/projects/${want.scheme}/day-strips?day=${want.day}`);
      if (ask !== asked) return;
      data = { ...want, strips: got.strips };
    } catch (err) {
      if (ask !== asked) return;
      failed = /** @type {Error} */ (err).message;
    }
    drawBody();
  };

  const drawControls = () => {
    if (scheme === 'all') return controls.replaceChildren();
    dateInput.value = day;
    dateInput.max = pacificIso(Date.now());
    next.disabled = day >= pacificIso(Date.now());
    controls.replaceChildren(
      h('div', { class: 'ds-day' }, before, dateInput, next),
      chips('Kind of minion', TYPES, type, (k) => {
        type = k;
        drawAll();
      }),
      chips('Order', SORTS, sort, (k) => {
        sort = k;
        drawAll();
      }),
      chips('Show as', LOOKS, look, (k) => {
        look = k;
        drawAll();
      }),
    );
  };
  const drawAll = () => {
    drawControls();
    drawBody();
  };

  const drawBody = () => {
    if (scheme == null) return;
    if (scheme === 'all') return body.replaceChildren(emptyCard('Pick a scheme', 'The strips are one scheme at a time: pick it in the list.', { mark: '↖', hue: 'neutral' }));
    if (failed) return body.replaceChildren(h('p', { class: 'error' }, `Couldn't read the day: ${failed} `, h('button', { type: 'button', class: 'secondary small', onclick: read }, 'Try again')));
    if (!data) return body.replaceChildren(h('p', { class: 'muted ds-reading' }, `Reading ${dayWords(day)}…`));
    const rows = shown(data.strips, type, sort);
    if (!data.strips.length) return body.replaceChildren(emptyCard(`Nothing went live on ${dayWords(day)}`, 'A minion shows here once its ship is live. Try the day before.', { mark: '○', hue: 'neutral' }));
    if (!rows.length) return body.replaceChildren(emptyCard(`No ${/** @type {[string, string]} */ (TYPES.find(([k]) => k === type))[1].toLowerCase()} went live on ${dayWords(day)}`, `${data.strips.length} other minion${data.strips.length === 1 ? '' : 's'} did: pick All.`, { mark: '○', hue: 'neutral' }));
    const tot = /** @type {Totals} */ (Object.fromEntries(PARTS.map(([k]) => [k, rows.reduce((n, s) => n + s.totals[k], 0)])));
    const all = Object.values(tot).reduce((a, b) => a + b, 0);
    const summary = h(
      'p',
      { class: 'ds-sum' },
      h('b', {}, String(rows.length)),
      ` minion${rows.length === 1 ? '' : 's'} went live on ${dayWords(day)}. Median start to live `,
      h('b', {}, dur(median(rows.map((s) => s.live - s.start)))),
      '; waiting on a person was ',
      h('b', {}, pct(tot.person, all)),
      ' of their time, the ship line and CI ',
      h('b', {}, pct(tot.line + tot.ci, all)),
      tot.none ? [', and ', h('b', {}, pct(tot.none, all)), ' has nothing recorded'] : '',
      '.',
    );
    const legend = h('div', { class: 'ds-legend' }, ...PARTS.filter(([k]) => tot[k] > 0).map(([k, words]) => h('span', { class: 'ds-key', ...(WHY[k] && { tabindex: 0, 'data-tip': WHY[k] }) }, h('i', { class: `ds-swatch p-${k}`, 'aria-hidden': 'true' }), words)));
    tips ??= mountTips(document.body, { selector: '.ds-panel [data-tip]', body: tipBody });
    body.replaceChildren(
      summary,
      legend,
      sumBar(tot, all),
      look === 'table' ? table(rows) : chart(rows),
      look === 'table' ? '' : h('p', { class: 'muted ds-note' }, 'Each strip starts at its minion’s start and ends when it went live, on a square-root scale so short ones stay readable. Hover one for its times and click to open it; on a phone, tap one to name it.'),
      tot.none ? h('p', { class: 'muted ds-note' }, `Nothing recorded: ${WHY.none}`) : '',
    );
  };

  /** The whole day's time, split by part: the bar on top. */
  const sumBar = (/** @type {Totals} */ tot, /** @type {number} */ all) => {
    const w = Math.max(200, width || 600);
    const g = svg('svg', { class: 'ds-bar', width: w, height: 22, viewBox: `0 0 ${w} 22`, role: 'img', 'aria-label': PARTS.map(([k, words]) => `${words} ${pct(tot[k], all)}`).join(', ') });
    let x = 0;
    for (const [k, words] of PARTS) {
      const ww = (tot[k] / (all || 1)) * w;
      if (ww < 0.5) continue;
      g.append(svg('rect', { class: `p-${k}`, x: x.toFixed(1), y: 0, width: Math.max(0.5, ww - 1).toFixed(1), height: 22, rx: 3, tabindex: 0, 'data-tip': `${words}\n${dur(tot[k])} in all, ${pct(tot[k], all)}` }));
      if (ww > 44) g.append(svg('text', { x: (x + 6).toFixed(1), y: 15, class: `ds-bar-word on-${k}` }, pct(tot[k], all)));
      x += ww;
    }
    return g;
  };

  const chart = (/** @type {Strip[]} */ rows) => {
    const phone = (width || 600) < 560;
    const w = Math.max(200, width || 600);
    const rh = phone ? 7 : 6;
    const top = 18;
    const H = top + rows.length * rh + 4;
    const longest = Math.max(...rows.map((s) => s.live - s.start), 60_000);
    const X = (/** @type {number} */ ms) => (Math.sqrt(Math.max(0, ms)) / Math.sqrt(longest)) * (w - 2);
    const g = svg('svg', { class: 'ds-chart', width: w, height: H, viewBox: `0 0 ${w} ${H}`, role: 'list', 'aria-label': `${rows.length} start-to-live strips` });
    let lastX = -Infinity;
    for (const t of TICKS) {
      if (t > longest) break;
      const x = X(t);
      if (x - lastX < (phone ? 44 : 64) || x > w - 24) continue;
      lastX = x;
      g.append(svg('line', { class: 'ds-grid', x1: x, x2: x, y1: top - 4, y2: H }), svg('text', { class: 'ds-tick', x, y: 11, 'text-anchor': 'middle' }, tickWord(t)));
    }
    rows.forEach((s, i) => {
      const y = top + i * rh;
      const row = svg('g', { class: `ds-strip${picked === s.id ? ' on' : ''}`, role: 'listitem', tabindex: 0, 'data-tip': stripTip(s), 'data-id': s.id, 'aria-label': stripTip(s).replaceAll('\n', '. ') });
      row.append(svg('rect', { class: 'ds-hit', x: 0, y, width: w, height: rh }), svg('rect', { class: 'ds-rest', x: 0, y: y + rh / 2 - 0.5, width: X(s.live - s.start).toFixed(1), height: 1 }));
      for (const p of s.parts) {
        const a = X(p.start - s.start);
        const b = X(p.end - s.start);
        row.append(svg('rect', { class: `p-${p.part}`, x: a.toFixed(1), y: y + 0.5, width: Math.max(1, b - a - 0.3).toFixed(1), height: rh - 1.5 }));
      }
      g.append(row);
    });
    const stripOf = (/** @type {Event} */ e) => /** @type {Element} */ (e.target).closest?.('.ds-strip');
    const at = (/** @type {Event} */ e) => rows.find((s) => String(s.id) === /** @type {SVGElement | null | undefined} */ (stripOf(e))?.dataset.id);
    const open = (/** @type {Strip} */ s) => {
      location.hash = `#/p/${scheme}/t/${s.number}`;
    };
    // A strip is a few px tall, too small to tap twice with confidence: a tap picks it and names it in a line under the chart, with a full-size button that opens it.
    const pickLine = h('div', { class: 'ds-picked', 'aria-live': 'polite' });
    const showPick = () => {
      const s = rows.find((r) => r.id === picked);
      pickLine.replaceChildren(
        ...(s
          ? [h('span', { class: 'ds-picked-name' }, h('b', {}, name(s)), h('span', { class: 'muted' }, ` ${clock(s.start, day)} to ${clock(s.live, day)}, ${dur(s.live - s.start)}`)), h('button', { type: 'button', class: 'secondary', onclick: () => open(s) }, s.number != null ? `Open #${s.number}` : 'Open')]
          : [h('span', { class: 'muted' }, 'Tap a strip to name it here.')]),
      );
      pickLine.hidden = !s && !phone;
    };
    showPick();
    // A mouse click opens the minion; a tap picks it (above).
    g.addEventListener('click', (/** @type {Event} */ e) => {
      const s = at(e);
      if (!s) return;
      if (/** @type {PointerEvent} */ (e).pointerType !== 'touch') return open(s);
      picked = s.id;
      for (const r of g.querySelectorAll('.ds-strip.on')) r.classList.remove('on');
      /** @type {Element} */ (stripOf(e)).classList.add('on');
      showPick();
    });
    g.addEventListener('keydown', (e) => {
      const s = /** @type {KeyboardEvent} */ (e).key === 'Enter' && at(e);
      if (s) open(s);
    });
    return h('div', { class: 'ds-strips' }, g, pickLine);
  };

  /** The strips as rows: the length and the parts that have any time first, the clock times (one zone, in the caption) last. */
  const table = (/** @type {Strip[]} */ rows) => {
    const cols = PARTS.filter(([k]) => rows.some((s) => s.totals[k] >= 1000));
    return h(
      'div',
      { class: 'ds-table-wrap' },
      h(
        'table',
        { class: 'ds-table' },
        h('caption', { class: 'muted' }, `Times in ${pacificZone()}`),
        h('thead', {}, h('tr', {}, h('th', {}, 'Minion'), h('th', {}, 'Start to live'), ...cols.map(([, words]) => h('th', {}, words)), h('th', {}, 'Started'), h('th', {}, 'Live'))),
        h('tbody', {}, ...rows.map((s) => h('tr', {}, h('td', {}, h('a', { href: `#/p/${scheme}/t/${s.number}` }, name(s))), h('td', {}, dur(s.live - s.start)), ...cols.map(([k]) => h('td', {}, s.totals[k] >= 1000 ? dur(s.totals[k]) : '–')), h('td', {}, clock(s.start, day)), h('td', {}, clock(s.live, day))))),
      ),
    );
  };

  /** Point it at scheme `to` (an id, or 'all'). The list redraws often, so the same scheme is read again only once its read is old. */
  const show = (/** @type {number | 'all'} */ to) => {
    if (to !== scheme) {
      scheme = to;
      data = null;
      picked = null;
    } else if (Date.now() - readAt < FRESH_MS) return;
    readAt = Date.now();
    read();
  };
  return Object.assign(el, { show });
}
