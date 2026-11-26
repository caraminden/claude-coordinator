// The Releases page's Flow tab (#1989; Josh, 2026-11-25, "Flow A: A river with the leaks drawn in"): every minion started in a
// range, from its kind, through how it got to main, to how it ended, by count or dollars. A click on any part lists its
// minions, costliest first, and draws their way through the river. src/work-flow.ts decides each one's path and ending.
import { api, h, icon, todayPacific as today, svg as svgEl } from './base.js';
import { COLS, dayBefore, layout, money, nodesOf, ribbon, rows, value } from './flowmath.js';
import { emptyCard, showFirst, toneChip } from './look.js';
import { optimistic } from './ui/optimistic.js';

/** @import { FlowMinion, FlowView } from './types.js' */
/** @import { FlowCol, FlowUnit, FlowNode, FlowLink } from './flowmath.js' */
/** @typedef {FlowView & { asked: number, key: string, error?: undefined }} FlowOk */
/** A read that failed: ours names its range, ci.js's own does not. @typedef {{ error: string | true, key?: string, asked?: undefined, minions?: undefined, unread?: undefined, repo?: undefined }} FlowFail */
/** @typedef {FlowOk | FlowFail} FlowRead */
/** @typedef {{ col: FlowCol, key: string }} FlowPick */

const num = (/** @type {number} */ n) => n.toLocaleString('en-US');
const plural = (/** @type {number} */ n, /** @type {string} */ one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const amount = (/** @type {number} */ v, /** @type {FlowUnit} */ unit) => (unit === 'cost' ? money(v) : num(v));
const SHORT = /** @type {Record<FlowCol, Record<string, string>>} */ (Object.fromEntries(COLS.map(([col, names]) => [col, Object.fromEntries(names.map(([key, name, short = name]) => [key, short]))])));
const NAME = /** @type {Record<FlowCol, Record<string, string>>} */ (Object.fromEntries(COLS.map(([col, names]) => [col, Object.fromEntries(names.map(([key, name]) => [key, name]))])));
/** @type {[number, string][]} */
const PRESETS = [
  [7, '1 week'],
  [14, '2 weeks'],
  [30, '30 days'],
  [90, '90 days'],
];
/** A name and its shorter one: the page's width shows one (ci.css). */
const both = (/** @type {string} */ name, /** @type {string} */ short) => [h('span', { class: 'full' }, name), h('span', { class: 'short' }, short)];
/**
 * @template {HTMLElement | SVGElement} E
 * @param {E} el
 * @param {Record<string, string>} props
 */
const put = (el, props) => {
  for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v);
  return el;
};
const dayWords = (/** @type {string} */ day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// ---------- what is asked for ----------

/** What the tab shows, for every scheme: kept while the page is open. `days` 0 is a range of picked dates. */
const st = { days: 14, from: '', to: '', unit: /** @type {FlowUnit} */ ('n'), table: false, pick: /** @type {FlowPick} */ ({ col: 'end', key: 'nothing' }) };
const setDays = (/** @type {number} */ days) => Object.assign(st, { days, from: dayBefore(today(), days - 1), to: today() });
setDays(14);
const rangeKey = () => `${st.from}..${st.to}`;
/** @type {Map<number, FlowRead>} */
const kept = new Map(); // scheme id -> the newest read of the range that was picked when it came

/** The scheme's read of the range now picked; its `key` says which that was. One that lands after another was picked is dropped. */
export async function readFlow(/** @type {number} */ id) {
  if (st.days) setDays(st.days);
  const key = rangeKey();
  const asked = Date.now();
  /** @type {FlowRead} */
  let data;
  try {
    data = { asked, ...(await api(`api/projects/${id}/flow?from=${st.from}&to=${st.to}`)), key };
  } catch (err) {
    data = { error: /** @type {Error} */ (err).message || true, key };
  }
  if (key === rangeKey()) kept.set(id, data);
  return kept.get(id) ?? data;
}

// ---------- why one closed ----------

const WHY = ['done', 'replaced', 'dropped'];
/** @type {Map<number, { why: string | null, saved: number | null }>} */
const words = new Map(); // minion id -> { why, saved }: what was clicked here, and when the server had it; null until it has
/** @type {Map<number, string | null>} */
const had = new Map(); // minion id -> the word the server last had
/** @type {Set<number>} */
let moved = new Set(); // minions whose click took them out of the list they were clicked in: they stay in it until another is picked

/** A read that set out before the server had a click doesn't undo it. */
function withWords(/** @type {FlowRead | null} */ data) {
  for (const m of data?.minions ?? []) {
    const w = words.get(m.id);
    if (!w) continue;
    const read = /** @type {FlowOk} */ (data); // it has minions
    if (w.saved === null || read.asked <= w.saved) setWhy(m, w.why, read.repo);
    else had.set(m.id, m.why); // someone else's, since
  }
}
/**
 * @param {FlowMinion} m
 * @param {string | null} why
 * @param {boolean} repo
 */
function setWhy(m, why, repo) {
  m.why = why;
  if (['nothing', 'why', 'norepo'].includes(m.end)) m.end = why ? 'why' : repo ? 'nothing' : 'norepo';
}

/** Save why minion `m` closed, or that it isn't recorded (null): shown at once, put back if it didn't save. */
/**
 * @param {FlowMinion} m
 * @param {string | null} why
 */
function mark(m, why) {
  if (!had.has(m.id)) had.set(m.id, m.why);
  const show = (/** @type {{ why: string | null, saved: number | null }} */ w) => {
    words.set(m.id, w);
    moved.add(m.id);
    const now = last?.data?.minions?.find((x) => x.id === m.id);
    if (now) setWhy(now, w.why, /** @type {FlowOk} */ (/** @type {NonNullable<typeof last>} */ (last).data).repo);
    last?.show();
  };
  /** @type {{ why: string | null, saved: number | null }} */
  const w = { why, saved: null };
  optimistic({
    key: `closedAs:${m.id}`,
    sets: `closedAs:${m.id}`,
    apply: () => show(w),
    send: async () => {
      await api(`api/tickets/${m.id}/properties`, { method: 'PUT', body: { properties: { closedAs: why } } });
      w.saved = Date.now();
      had.set(m.id, why);
    },
    undo: () => words.get(m.id) === w && show({ why: /** @type {string | null} */ (had.get(m.id)), saved: Date.now() }),
    label: why ? `mark #${m.number} ${why}` : `clear why #${m.number} closed`,
  });
}

// ---------- the river ----------

const THICK = 14;
/**
 * The drawing; `on.pick` is told which node was clicked, `draw` shows what `st` says now.
 * @param {FlowMinion[]} minions
 * @param {{ pick: (p: FlowPick) => void }} on
 */
function river(minions, on) {
  const el = h('div', { class: 'flow-river' });
  const tip = h('div', { class: 'ci-tip flow-tip', hidden: true });
  let width = 0;

  const showTip = (/** @type {PointerEvent} */ ev, /** @type {string} */ title, /** @type {string[]} */ lines) => {
    tip.replaceChildren(h('strong', {}, title), ...lines.map((t) => h('span', {}, t)));
    tip.hidden = false;
    const b = el.getBoundingClientRect();
    const x = ev.clientX - b.left,
      y = ev.clientY - b.top;
    put(tip, { left: `${Math.max(0, Math.min(b.width - tip.offsetWidth, x + 14))}px`, top: `${Math.max(0, Math.min(b.height - tip.offsetHeight, y + 14))}px` });
  };
  const hideTip = () => {
    tip.hidden = true;
  };

  const svg = svgEl('svg', { role: 'group' });
  const layers = { ribbon: svgEl('g', {}), thread: svgEl('g', {}), node: svgEl('g', {}) };
  svg.append(layers.ribbon, layers.thread, layers.node);
  el.append(svg, tip);
  // One element per ribbon, thread and node, kept between draws so a change of unit moves them rather than swapping them.
  /** @typedef {{ layer: keyof typeof layers, el: SVGElement, now: unknown, used?: boolean }} Part */
  /** @type {Map<string, Part>} */
  const pool = new Map(); // key -> { el, now }
  /**
   * @template T
   * @param {keyof typeof layers} layer
   * @param {string} key
   * @param {T} now
   * @param {(now: () => T) => SVGElement} make
   */
  const part = (layer, key, now, make) => {
    let p = pool.get(`${layer} ${key}`);
    if (!p) {
      const added = /** @type {Part} */ ({ layer });
      p = added;
      p.el = make(() => /** @type {T} */ (added.now));
      pool.set(`${layer} ${key}`, p);
      layers[layer].append(p.el);
    }
    p.now = now;
    p.used = true;
    return p.el;
  };
  const about = (/** @type {FlowMinion[]} */ ms) => [`${plural(ms.length, 'minion')} · ${money(value(ms, 'cost'))}`];
  const makeRibbon = (/** @type {() => FlowLink} */ now) => {
    const p = svgEl('path', { class: 'ribbon' });
    p.addEventListener('pointermove', (ev) => showTip(ev, `${now().from.name} → ${now().to.name}`, about(now().ms)));
    p.addEventListener('pointerleave', hideTip);
    return p;
  };
  const makeNode = (/** @type {() => FlowNode} */ now) => {
    const g = svgEl('g', { role: 'button', tabindex: 0 });
    const t = svgEl('text', {});
    t.append(svgEl('tspan', { class: 'name' }), svgEl('tspan', { class: 'v' }));
    g.append(svgEl('rect', { class: 'hit' }), svgEl('rect', { class: 'bar' }), svgEl('path', { class: 'lead' }), t);
    const act = () => on.pick({ col: now().col, key: now().key });
    g.addEventListener('click', act);
    g.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      act();
    });
    g.addEventListener('pointermove', (ev) => showTip(ev, now().name, about(now().ms)));
    g.addEventListener('pointerleave', hideTip);
    return g;
  };
  const attrs = (/** @type {Element} */ node, /** @type {Record<string, string | number>} */ o) => {
    for (const [k, v] of Object.entries(o)) node.setAttribute(k, String(v));
  };

  function draw() {
    const W = width;
    if (!W) return;
    const down = W < 440;
    const tight = W < 640; // shorter names; a phone's are in the lists under it (ci.css)
    const pad = down ? 0 : tight ? 136 : 226;
    const along = down ? W : Math.max(340, Math.min(500, W * 0.42));
    const across = down ? 430 : W - pad;
    const H = down ? across : along;
    const { cols, links } = layout(minions, st.unit, along, { gap: down ? 8 : 14, least: down ? 3 : 2 });
    const depth = (/** @type {number} */ i) => (i / 2) * (across - THICK);
    attrs(svg, { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-label': `${plural(minions.length, 'minion')} from kind, through how they got to main, to how they ended. The table shows the same numbers.` });
    for (const p of pool.values()) p.used = false;
    const colIndex = (/** @type {FlowNode} */ n) => COLS.findIndex(([c]) => c === n.col);
    const chosen = (/** @type {FlowMinion} */ m) => m[st.pick.col] === st.pick.key;
    for (const l of links) {
      const i = colIndex(l.from);
      const [d0, d1] = [depth(i) + THICK, depth(i + 1)];
      const key = `${l.from.col}-${l.from.key}>${l.to.key}`;
      attrs(part('ribbon', key, l, makeRibbon), { d: ribbon(l, d0, d1, down), 'data-hue': i ? `end-${l.to.key}` : `kind-${l.from.key}` });
      // The picked part's own minions, drawn through every ribbon they are in.
      const some = l.ms.filter(chosen);
      if (!some.length) continue;
      const share = l.v ? value(some, st.unit) / l.v : some.length / l.ms.length;
      const thin = (/** @type {number} */ x0, /** @type {number} */ x1) => Math.max(x0 + 1, x0 + (x1 - x0) * share);
      attrs(
        part('thread', key, l, () => svgEl('path', { class: 'thread' })),
        { d: ribbon({ a0: l.a0, a1: thin(l.a0, l.a1), b0: l.b0, b1: thin(l.b0, l.b1) }, d0, d1, down), 'data-hue': `${st.pick.col}-${st.pick.key}` },
      );
    }
    cols.forEach((col, i) => {
      let lastLabel = -Infinity;
      for (const n of col) {
        const d = depth(i);
        const picked = n.col === st.pick.col && n.key === st.pick.key;
        const g = part('node', `${n.col}-${n.key}`, n, makeNode);
        attrs(g, { class: `flow-node${picked ? ' on' : ''}`, 'data-hue': `${n.col}-${n.key}`, 'aria-pressed': String(picked), 'aria-label': `${n.name}: ${plural(n.ms.length, 'minion')}, ${money(value(n.ms, 'cost'))}. List them` });
        const [hit, bar, lead, text] = /** @type {HTMLCollectionOf<SVGElement>} */ (g.children);
        attrs(bar, { ...(down ? { x: n.at, y: d, width: n.size, height: THICK } : { x: d, y: n.at, width: THICK, height: n.size }), rx: Math.min(3, n.size / 2) });
        const tall = Math.max(24, n.size + 12);
        attrs(hit, down ? { x: n.at - 3, y: d - 14, width: n.size + 6, height: THICK + 28 } : { x: d - 8, y: n.at + n.size / 2 - tall / 2, width: i === 2 ? pad : THICK + 16, height: tall });
        text.children[0].textContent = down ? '' : tight ? n.short : n.name;
        text.children[1].textContent = down && n.size < 40 ? '' : amount(n.v, st.unit);
        if (down) {
          lead.setAttribute('d', '');
          attrs(text, { 'text-anchor': 'middle' });
          put(text, { transform: `translate(${n.at + n.size / 2}px, ${i === 0 ? d + THICK + 14 : d - 7}px)` });
        } else {
          // Names sit beside their node; two that would touch are moved apart, downwards.
          const mid = n.at + n.size / 2;
          const y = Math.max(mid, lastLabel + 17);
          lastLabel = y;
          attrs(text, { 'text-anchor': 'start' });
          attrs(text.children[1], { dx: 6 });
          put(text, { transform: `translate(${d + THICK + 8}px, ${y + 4}px)` });
          lead.setAttribute('d', y - mid > 4 ? `M${d + THICK} ${mid} L${d + THICK + 6} ${y}` : '');
        }
      }
    });
    for (const [key, p] of pool) {
      if (p.used) continue;
      p.el.remove();
      pool.delete(key);
    }
    el.classList.toggle('down', down);
    hideTip();
  }
  new ResizeObserver(() => {
    const w = Math.round(el.clientWidth);
    if (w && w !== width) {
      width = w;
      draw();
    }
  }).observe(el);
  return { el, draw };
}

// ---------- the tab ----------

/** @type {{ id: number, el: HTMLDivElement, data?: FlowRead | null, show: () => unknown, redraw: () => void } | null} */
let last = null; // { id, data, el, redraw }: a poll's draw with the same read moves nothing
/** @type {ReturnType<typeof setTimeout> | undefined} */
let again; // the timer of a read that still lacks some chats

/**
 * The Flow tab for scheme `id`: `data` is its read, null while it's on its way. `retry` reads again.
 * @param {number} id
 * @param {string} name
 * @param {FlowRead | null} data
 * @param {() => unknown} retry
 */
export function flowTab(id, name, data, retry) {
  if (last?.id !== id) {
    moved = new Set();
    const el = h('div', { class: 'flow-tab code-tab' });
    last = {
      id,
      el,
      show: () => {},
      redraw() {
        const active = /** @type {Element} */ (document.activeElement); // read only where `el` holds it
        const at = el.contains(document.activeElement) ? (active.closest('[aria-label]')?.getAttribute('aria-label') ?? null) : null;
        const word = at && active.textContent;
        el.replaceChildren(...build(id, name, this.data, retry, () => this.redraw()));
        if (!at) return;
        const now = el.querySelector(`[aria-label="${CSS.escape(at)}"]`);
        /** @type {HTMLElement | null | undefined} */ (now?.matches('[role=group]') ? ([...now.querySelectorAll('button')].find((b) => b.textContent === word) ?? now.querySelector('.on')) : now)?.focus({ preventScroll: true });
      },
    };
  } else if (last.data === data) return last.el;
  last.data = data;
  withWords(data);
  last.redraw();
  clearTimeout(again);
  if (data?.unread) again = setTimeout(() => /** @type {NonNullable<typeof last>} */ (last).el.isConnected && retry(), 4000);
  return last.el;
}

/**
 * @param {number} id
 * @param {string} name
 * @param {FlowRead | null | undefined} data
 * @param {() => unknown} retry
 * @param {() => void} redraw
 */
function build(id, name, data, retry, redraw) {
  const fresh = data?.key === rangeKey() ? data : null;
  const stale = !fresh && data?.minions ? data : null; // the last range's, dimmed while the new one is read
  const shown = /** @type {FlowOk | null} */ (fresh ?? stale); // a failed one returns below before `shown` is read
  const chip = (/** @type {string} */ words, /** @type {boolean} */ on, /** @type {(ev: Event) => unknown} */ act) => h('button', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick: act }, words);
  const choose = (/** @type {() => unknown} */ act) => {
    act();
    moved = new Set();
    redraw();
    void retry();
  };
  const dates = h(
    'span',
    { class: 'flow-dates', hidden: st.days !== 0 },
    ...['from', 'to'].flatMap((k, i) => [
      i ? ' to ' : '',
      h('input', {
        type: 'date',
        'aria-label': k === 'from' ? 'First day' : 'Last day',
        value: st[/** @type {'from' | 'to'} */ (k)],
        max: today(),
        onchange: (/** @type {Event} */ ev) => {
          const v = /** @type {HTMLInputElement} */ (ev.target).value;
          if (!v) return;
          // The other end follows, so a range is never backwards.
          choose(() => Object.assign(st, { days: 0, [k]: v }, st.from > v && k === 'to' ? { from: v } : st.to < v && k === 'from' ? { to: v } : {}));
        },
      }),
    ]),
  );
  /** @type {ReturnType<typeof river> | null} */
  let map = null;
  let show = redraw;
  const tab = /** @type {NonNullable<typeof last>} */ (last); // flowTab made it before building
  tab.show = redraw;
  const controls = h(
    'div',
    { class: 'code-ctl flow-ctl' },
    h(
      'div',
      { class: 'chips', role: 'group', 'aria-label': 'Started in' },
      ...PRESETS.map(([d, words]) => chip(words, st.days === d, () => choose(() => setDays(d)))),
      chip('Dates', st.days === 0, () => {
        st.days = 0;
        redraw();
      }),
      dates,
    ),
    h(
      'div',
      { class: 'flow-ctl-right' },
      h(
        'div',
        { class: 'chips', role: 'group', 'aria-label': 'Count' },
        ...[
          ['n', 'Minions'],
          ['cost', 'Dollars'],
        ].map(([u, words]) =>
          chip(words, st.unit === u, (ev) => {
            st.unit = /** @type {FlowUnit} */ (u);
            if (!map) return redraw();
            // Moved in place, so the river flows from one count to the other.
            for (const c of /** @type {Element} */ (/** @type {Element} */ (ev.currentTarget).parentElement).children) {
              const on = c === ev.currentTarget;
              c.classList.toggle('on', on);
              c.setAttribute('aria-pressed', String(on));
            }
            show();
          }),
        ),
      ),
      h(
        'div',
        { class: 'chips', role: 'group', 'aria-label': 'Show as' },
        ...[
          [false, 'Chart'],
          [true, 'Table'],
        ].map(([t, words]) =>
          chip(/** @type {string} */ (words), st.table === t, () => {
            st.table = /** @type {boolean} */ (t);
            redraw();
          }),
        ),
      ),
    ),
  );
  const head = h('div', { class: 'ci-head' }, h('h3', {}, name), h('span', { class: 'muted' }, `minions started ${dayWords(st.from)} to ${dayWords(st.to)}`));
  if (fresh?.error) return [head, controls, h('p', { class: 'cui-notice', 'data-tone': 'danger', role: 'alert' }, "Couldn't read where this scheme's work went. ", h('button', { type: 'button', class: 'secondary small', onclick: retry }, 'Try again'))];
  if (!shown) return [head, controls, h('div', { class: 'code-skeleton flow-skeleton', role: 'status', 'aria-label': "Reading the minions' chats" })];
  const ms = shown.minions;
  const notes = [
    shown.unread ? h('p', { class: 'flow-note' }, toneChip('info', 'Still reading'), ' ', h('span', { class: 'muted' }, `${plural(shown.unread, 'chat')} not read yet: they join as they are.`)) : '',
    shown.early ? h('p', { class: 'flow-note' }, toneChip('info', 'Refusals not recorded'), ' ', h('span', { class: 'muted' }, 'before Nov 14: a refused ship from then shows nowhere here.')) : '',
    shown.git ? '' : h('p', { class: 'flow-note' }, toneChip('warn', "Main wasn't read"), ' ', h('span', { class: 'muted' }, "Its commits couldn't be, so some work that is on main may read as never shipped.")),
  ];
  if (!ms.length) return [head, controls, ...notes, shown.unread ? h('div', { class: 'code-skeleton flow-skeleton' }) : emptyCard('Nothing started in these days', 'Every minion started here shows as a thread from its kind to how it ended. Pick a longer range to see older ones.', { mark: '≈', hue: 'muted' })];

  const body = h('section', { class: `ci-block code-block flow-block${stale ? ' stale' : ''}${st.table ? ' table' : ''}`, 'data-hue': 'accent', 'aria-busy': String(!!stale) });
  const listBox = h('div', { class: 'flow-list' });
  const legend = h('div', { class: 'flow-names' });
  const has = (/** @type {FlowPick} */ p) => ms.some((m) => m[p.col] === p.key);
  if (!has(st.pick) && !ms.some((m) => moved.has(m.id))) {
    const first = ['nothing', 'why', 'norepo', 'late', 'live', 'main', 'answer', 'open', 'build'].find((key) => has({ col: 'end', key }));
    st.pick = { col: 'end', key: /** @type {string} */ (first) }; // every ending is in the list above
  }
  const drawList = () => {
    const some = ms.filter((m) => m[st.pick.col] === st.pick.key);
    const listed = ms.filter((m) => some.includes(m) || moved.has(m.id)).sort((a, b) => b.cost - a.cost || b.number - a.number);
    const active = /** @type {Element} */ (document.activeElement); // read only where `listBox` holds it
    const row = /** @type {HTMLElement | null | undefined} */ (active?.closest('.flow-why'));
    const at = listBox.contains(document.activeElement) ? (row?.dataset.id ?? null) : null;
    const word = at && active.textContent;
    const cost = value(some, 'cost');
    listBox.replaceChildren(
      h('h4', { 'data-hue': `${st.pick.col}-${st.pick.key}` }, h('i', { class: 'flow-key', 'aria-hidden': 'true' }), NAME[st.pick.col][st.pick.key], h('span', { class: 'muted' }, `${plural(some.length, 'minion')} · ${money(cost)}`)),
      st.pick.col === 'end' && st.pick.key === 'nothing' ? h('p', { class: 'muted small flow-cant' }, 'Nothing says why these closed: they may be a loss, or stopped on purpose, or given to others. Know which? Say so, and it moves to its own ending. Those closed before Nov 25 were never asked.') : '',
      showFirst({
        key: `flow-${id}-${st.pick.col}-${st.pick.key}-${shown.key}`,
        items: listed.map((m) => rowOf(id, m, listed[0].cost)),
        n: 6,
        noun: 'minions',
        wrap: (xs) => h('ol', { class: 'flow-rows' }, ...xs),
      }),
    );
    if (at) [.../** @type {NodeListOf<HTMLButtonElement>} */ (listBox.querySelectorAll(`.flow-why[data-id="${at}"] button`))].find((b) => b.textContent === word)?.focus({ preventScroll: true });
  };
  const pick = (/** @type {FlowPick} */ p) => {
    st.pick = p;
    moved = new Set();
    show();
  };
  const drawLegend = () => {
    const at = legend.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).dataset.hue : null;
    legend.replaceChildren(
      ...nodesOf(ms).map((col, i) =>
        h(
          'div',
          { class: 'flow-names-col' },
          h('h4', {}, ['Kind', 'How it got to main', 'How it ended'][i]),
          ...col.map((n) => {
            const on = n.col === st.pick.col && n.key === st.pick.key;
            return h(
              'button',
              { type: 'button', class: `flow-name${on ? ' on' : ''}`, 'aria-pressed': String(on), 'data-hue': `${n.col}-${n.key}`, onclick: () => pick({ col: n.col, key: n.key }) },
              h('i', { class: 'flow-key', 'aria-hidden': 'true' }),
              ...both(n.name, n.short),
              h('b', {}, amount(value(n.ms, st.unit), st.unit)),
            );
          }),
        ),
      ),
    );
    if (at) /** @type {HTMLElement | null} */ (legend.querySelector(`[data-hue="${at}"]`))?.focus({ preventScroll: true });
  };
  const sum = h('p', { class: 'flow-words' }, ...summary(ms, shown.early));
  const stage = h('div', { class: 'flow-stage' });
  if (st.table) {
    stage.append(
      showFirst({
        key: `flow-table-${id}`,
        items: rows(ms, st.unit).map((x) => h('tr', {}, ...COLS.map(([col]) => h('td', {}, ...both(NAME[col][x[col]], SHORT[col][x[col]]))), h('td', {}, num(x.n)), h('td', {}, money(x.cost)))),
        n: 8,
        noun: 'rows',
        wrap: (xs) =>
          h(
            'div',
            { class: 'flow-table-wrap' },
            h(
              'table',
              { class: 'code-table flow-table' },
              h('thead', {}, h('tr', {}, ...['Kind', 'How it got to main', 'How it ended', 'Minions', 'Cost'].map((t) => h('th', { scope: 'col' }, t)))),
              h('tbody', {}, ...xs),
              h('tfoot', {}, h('tr', {}, h('th', { scope: 'row', colspan: 3 }, 'All'), h('td', {}, num(ms.length)), h('td', {}, money(value(ms, 'cost'))))),
            ),
          ),
      }),
    );
  } else {
    map = river(ms, { pick });
    stage.append(map.el);
  }
  show = () => {
    if (st.table) return redraw();
    /** @type {NonNullable<typeof map>} */ (map).draw();
    drawLegend();
    drawList();
    sum.replaceChildren(...summary(ms, shown.early));
  };
  tab.show = () => show();
  drawLegend();
  drawList();
  body.append(h('div', { class: 'code-sum flow-sum' }, h('span', { class: 'settings-tile' }, icon('chart')), sum), stage, legend, listBox);
  return [head, controls, ...notes, body, how(shown)];
}

/**
 * One minion in the list, opening its chat.
 * @param {number} id
 * @param {FlowMinion} m
 * @param {number} most
 */
function rowOf(id, m, most) {
  const bar = put(h('i', {}), { '--pct': `${most ? ((m.cost / most) * 100).toFixed(1) : 0}%` });
  const facts = [NAME.kind[m.kind], m.refused ? plural(m.refused, 'refused ship') : '', ['nothing', 'why', 'norepo', 'answer'].includes(m.end) ? m.said || 'No closing note' : ''].filter(Boolean).join(' · ');
  return h(
    'li',
    {},
    h(
      'a',
      { class: 'flow-row', href: `#/p/${id}/t/${m.number}`, 'data-hue': `end-${m.end}` },
      h('span', { class: 'flow-row-title' }, h('b', {}, `#${m.number}`), ` ${m.title}`),
      h('b', { class: 'flow-row-cost' }, money(m.cost)),
      h('span', { class: 'muted flow-row-facts' }, facts),
      h('span', { class: 'flow-row-bar', 'aria-hidden': 'true' }, bar),
    ),
    ['nothing', 'why', 'norepo', 'answer'].includes(m.end) ? whyOf(m) : '',
  );
}

/** The three words, and any other a scheme gave the property that these have. */
const wordsOf = (/** @type {FlowMinion[]} */ ms) => [...new Set([...WHY, ...ms.flatMap((m) => m.why ?? [])])];

const listWords = (/** @type {string[]} */ xs) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`);

/**
 * Why one closed, and the three words to say it with; the one on takes itself back.
 * @param {FlowMinion} m
 */
function whyOf(m) {
  return h(
    'div',
    { class: 'flow-why', role: 'group', 'aria-label': `Why #${m.number} closed`, 'data-id': String(m.id), 'data-hue': `end-${m.end}` },
    h('span', { class: 'muted' }, m.why ? 'Closed as' : 'Not recorded'),
    ...wordsOf([m]).map((w) => h('button', { type: 'button', class: `chip${m.why === w ? ' on' : ''}`, 'aria-pressed': String(m.why === w), onclick: () => mark(m, m.why === w ? null : w) }, w[0].toUpperCase() + w.slice(1))),
  );
}

/**
 * The sentence over the river.
 * @param {FlowMinion[]} ms
 * @param {boolean} early
 */
function summary(ms, early) {
  const refused = ms.filter((m) => m.path === 'refused'),
    there = refused.filter((m) => m.end === 'late'),
    nothing = ms.filter((m) => m.end === 'nothing' || m.end === 'norepo'),
    why = ms.filter((m) => m.end === 'why'),
    where = nothing[0]?.end === 'norepo' ? 'closed, with no repo to look in and why not recorded' : 'closed with nothing on main, why not recorded';
  return [
    h('b', {}, num(ms.length)),
    ` ${ms.length === 1 ? 'minion' : 'minions'}, ${money(value(ms, 'cost'))}. `,
    ...(refused.length
      ? [h('b', {}, num(refused.length)), ` had two or more refused ships${there.length === refused.length ? ', and all of them still got there. ' : `, and ${num(there.length)} of those still got there. `}`]
      : [early ? 'None is on record with two or more refused ships. ' : 'None had two or more refused ships. ']),
    ...(nothing.length ? [h('b', {}, num(nothing.length)), ` ${nothing.length === 1 ? 'feature, fix or chore' : 'features, fixes and chores'} ${where}: ${money(value(nothing, 'cost'))}.`] : ['No feature, fix or chore closed with nothing on main and no word why.']),
    ...(why.length ? [' ', h('b', {}, num(why.length)), ` more ${why.length === 1 ? 'was' : 'were'} closed as ${listWords(wordsOf(why).filter((w) => why.some((m) => m.why === w)))}: ${money(value(why, 'cost'))}.`] : []),
  ];
}

const how = (/** @type {FlowOk} */ data) =>
  h(
    'details',
    { class: 'code-how' },
    h('summary', {}, "How it's counted"),
    h(
      'p',
      { class: 'look-prose muted small' },
      `Each minion started in these days, Pacific, counts once, with all its turns so far at API prices; a killed turn counts at its estimate. "Live" means a release or an app's deploy that went live names it${data.releases ? '' : '; no release here names any of these'}. "On main" without one means its ship, its pull request or a commit that names it is on the main branch.`,
    ),
    h(
      'p',
      { class: 'look-prose muted small' },
      'A refused ship is a hand-off that did not go through, kept in its chat since Nov 14, or a note of two failed ships, since Nov 19. A ship from before then, or one the minion ran itself, has none on record, so it reads "refusals not recorded" rather than as a first try. Why a minion closed is one word it or the Taskmaster says as it closes it, since Nov 25, or a person says in the list: done, replaced by another, or dropped on purpose. One with no word reads "not recorded", never guessed.',
    ),
  );
