// The Releases page's Flow tab (#1989; Josh, 2026-11-25, "Flow A: A river with the leaks drawn in"): every minion started in a
// range, from its kind, through how it got to main, to how it ended, by count or dollars. A click on any part lists its
// minions, costliest first, and draws their way through the river. src/work-flow.ts decides each one's path and ending.
import { api, h, icon } from './base.js';
import { COLS, dayBefore, layout, money, nodesOf, ribbon, rows, value } from './flowmath.js';
import { emptyCard, showFirst, toneChip } from './look.js';

const num = (n) => n.toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const amount = (v, unit) => (unit === 'cost' ? money(v) : num(v));
const SHORT = Object.fromEntries(COLS.map(([col, names]) => [col, Object.fromEntries(names.map(([key, name, short = name]) => [key, short]))]));
const NAME = Object.fromEntries(COLS.map(([col, names]) => [col, Object.fromEntries(names.map(([key, name]) => [key, name]))]));
const PRESETS = [
  [7, '1 week'],
  [14, '2 weeks'],
  [30, '30 days'],
  [90, '90 days'],
];
const NS = 'http://www.w3.org/2000/svg';
/** A name and its shorter one: the page's width shows one (ci.css). */
const both = (name, short) => [h('span', { class: 'full' }, name), h('span', { class: 'short' }, short)];
const svgEl = (tag, attrs) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const put = (el, props) => {
  for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v);
  return el;
};
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(Date.now());
const dayWords = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// ---------- what is asked for ----------

/** What the tab shows, for every scheme: kept while the page is open. `days` 0 is a range of picked dates. */
const st = { days: 14, from: '', to: '', unit: 'n', table: false, pick: { col: 'end', key: 'nothing' } };
const setDays = (days) => Object.assign(st, { days, from: dayBefore(today(), days - 1), to: today() });
setDays(14);
const rangeKey = () => `${st.from}..${st.to}`;
const kept = new Map(); // scheme id -> the newest read of the range that was picked when it came

/** The scheme's read of the range now picked; its `key` says which that was. One that lands after another was picked is dropped. */
export async function readFlow(id) {
  if (st.days) setDays(st.days);
  const key = rangeKey();
  let data;
  try {
    data = { ...(await api(`api/projects/${id}/flow?from=${st.from}&to=${st.to}`)), key };
  } catch (err) {
    data = { error: err.message || true, key };
  }
  if (key === rangeKey()) kept.set(id, data);
  return kept.get(id) ?? data;
}

// ---------- the river ----------

const THICK = 14;
/** The drawing; `on.pick` is told which node was clicked, `draw` shows what `st` says now. */
function river(minions, on) {
  const el = h('div', { class: 'flow-river' });
  const tip = h('div', { class: 'ci-tip flow-tip', hidden: true });
  let width = 0;

  const showTip = (ev, title, lines) => {
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
  const pool = new Map(); // key -> { el, now }
  const part = (layer, key, now, make) => {
    let p = pool.get(`${layer} ${key}`);
    if (!p) {
      p = { layer };
      p.el = make(() => p.now);
      pool.set(`${layer} ${key}`, p);
      layers[layer].append(p.el);
    }
    p.now = now;
    p.used = true;
    return p.el;
  };
  const about = (ms) => [`${plural(ms.length, 'minion')} · ${money(value(ms, 'cost'))}`];
  const makeRibbon = (now) => {
    const p = svgEl('path', { class: 'ribbon' });
    p.addEventListener('pointermove', (ev) => showTip(ev, `${now().from.name} → ${now().to.name}`, about(now().ms)));
    p.addEventListener('pointerleave', hideTip);
    return p;
  };
  const makeNode = (now) => {
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
  const attrs = (node, o) => {
    for (const [k, v] of Object.entries(o)) node.setAttribute(k, v);
  };

  function draw() {
    const W = width;
    if (!W) return;
    const down = W < 440;
    const tight = W < 640; // shorter names; a phone's are in the lists under it (ci.css)
    const pad = down ? 0 : tight ? 128 : 226;
    const along = down ? W : Math.max(340, Math.min(500, W * 0.42));
    const across = down ? 430 : W - pad;
    const H = down ? across : along;
    const { cols, links } = layout(minions, st.unit, along, { gap: down ? 8 : 14, least: down ? 3 : 2 });
    const depth = (i) => (i / 2) * (across - THICK);
    attrs(svg, { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-label': `${plural(minions.length, 'minion')} from kind, through how they got to main, to how they ended. The table shows the same numbers.` });
    for (const p of pool.values()) p.used = false;
    const colIndex = (n) => COLS.findIndex(([c]) => c === n.col);
    const chosen = (m) => m[st.pick.col] === st.pick.key;
    for (const l of links) {
      const i = colIndex(l.from);
      const [d0, d1] = [depth(i) + THICK, depth(i + 1)];
      const key = `${l.from.col}-${l.from.key}>${l.to.key}`;
      attrs(part('ribbon', key, l, makeRibbon), { d: ribbon(l, d0, d1, down), 'data-hue': i ? `end-${l.to.key}` : `kind-${l.from.key}` });
      // The picked part's own minions, drawn through every ribbon they are in.
      const some = l.ms.filter(chosen);
      if (!some.length) continue;
      const share = l.v ? value(some, st.unit) / l.v : some.length / l.ms.length;
      const thin = (x0, x1) => Math.max(x0 + 1, x0 + (x1 - x0) * share);
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
        const [hit, bar, lead, text] = g.children;
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

let last = null; // { id, data, el, redraw }: a poll's draw with the same read moves nothing
let again = null; // the timer of a read that still lacks some chats

/** The Flow tab for scheme `id`: `data` is its read, null while it's on its way. `retry` reads again. */
export function flowTab(id, name, data, retry) {
  if (last?.id !== id) {
    const el = h('div', { class: 'flow-tab code-tab' });
    last = {
      id,
      el,
      redraw() {
        const at = el.contains(document.activeElement) ? (document.activeElement.closest('[aria-label]')?.getAttribute('aria-label') ?? null) : null;
        el.replaceChildren(...build(id, name, this.data, retry, () => this.redraw()));
        if (!at) return;
        const now = el.querySelector(`[aria-label="${CSS.escape(at)}"]`);
        (now?.matches('[role=group].chips') ? now.querySelector('.on') : now)?.focus({ preventScroll: true });
      },
    };
  } else if (last.data === data) return last.el;
  last.data = data;
  last.redraw();
  clearTimeout(again);
  if (data?.unread) again = setTimeout(() => last.el.isConnected && retry(), 4000);
  return last.el;
}

function build(id, name, data, retry, redraw) {
  const fresh = data?.key === rangeKey() ? data : null;
  const stale = !fresh && data?.minions ? data : null; // the last range's, dimmed while the new one is read
  const shown = fresh ?? stale;
  const chip = (words, on, act) => h('button', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick: act }, words);
  const choose = (act) => {
    act();
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
        value: st[k],
        max: today(),
        onchange: (ev) => {
          const v = ev.target.value;
          if (!v) return;
          // The other end follows, so a range is never backwards.
          choose(() => Object.assign(st, { days: 0, [k]: v }, st.from > v && k === 'to' ? { from: v } : st.to < v && k === 'from' ? { to: v } : {}));
        },
      }),
    ]),
  );
  let map = null;
  let show = redraw;
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
            st.unit = u;
            if (!map) return redraw();
            // Moved in place, so the river flows from one count to the other.
            for (const c of ev.currentTarget.parentElement.children) {
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
          chip(words, st.table === t, () => {
            st.table = t;
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
  const has = (p) => ms.some((m) => m[p.col] === p.key);
  if (!has(st.pick)) {
    const first = ['nothing', 'norepo', 'late', 'live', 'main', 'answer', 'open', 'build'].find((key) => has({ col: 'end', key }));
    st.pick = { col: 'end', key: first };
  }
  const drawList = () => {
    const some = ms.filter((m) => m[st.pick.col] === st.pick.key).sort((a, b) => b.cost - a.cost || b.number - a.number);
    const cost = value(some, 'cost');
    listBox.replaceChildren(
      h('h4', { 'data-hue': `${st.pick.col}-${st.pick.key}` }, h('i', { class: 'flow-key', 'aria-hidden': 'true' }), NAME[st.pick.col][st.pick.key], h('span', { class: 'muted' }, `${plural(some.length, 'minion')} · ${money(cost)}`)),
      st.pick.col === 'end' && st.pick.key === 'nothing' ? h('p', { class: 'muted small flow-cant' }, "Why each one closed isn't recorded, so one stopped on purpose and given to others can't be told from a loss. Its closing note is shown where it left one.") : '',
      showFirst({
        key: `flow-${id}-${st.pick.col}-${st.pick.key}-${shown.key}`,
        items: some.map((m) => rowOf(id, m, some[0].cost)),
        n: 6,
        noun: 'minions',
        wrap: (xs) => h('ol', { class: 'flow-rows' }, ...xs),
      }),
    );
  };
  const pick = (p) => {
    st.pick = p;
    show();
  };
  const drawLegend = () => {
    const at = legend.contains(document.activeElement) ? document.activeElement.dataset.hue : null;
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
    if (at) legend.querySelector(`[data-hue="${at}"]`)?.focus({ preventScroll: true });
  };
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
    map.draw();
    drawLegend();
    drawList();
  };
  drawLegend();
  drawList();
  body.append(h('div', { class: 'code-sum flow-sum' }, h('span', { class: 'settings-tile' }, icon('chart')), summary(ms, shown.early)), stage, legend, listBox);
  return [head, controls, ...notes, body, how(shown)];
}

/** One minion in the list, opening its chat. */
function rowOf(id, m, most) {
  const bar = put(h('i', {}), { '--pct': `${most ? ((m.cost / most) * 100).toFixed(1) : 0}%` });
  const facts = [NAME.kind[m.kind], m.refused ? plural(m.refused, 'refused ship') : '', ['nothing', 'norepo', 'answer'].includes(m.end) ? m.said || 'No closing note' : ''].filter(Boolean).join(' · ');
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
  );
}

/** The sentence over the river. */
function summary(ms, early) {
  const refused = ms.filter((m) => m.path === 'refused'),
    there = refused.filter((m) => m.end === 'late'),
    nothing = ms.filter((m) => m.end === 'nothing' || m.end === 'norepo'),
    where = nothing[0]?.end === 'norepo' ? 'closed, with no repo to look in' : 'closed with nothing on main, why not recorded';
  return h(
    'p',
    { class: 'flow-words' },
    h('b', {}, num(ms.length)),
    ` ${ms.length === 1 ? 'minion' : 'minions'}, ${money(value(ms, 'cost'))}. `,
    ...(refused.length
      ? [h('b', {}, num(refused.length)), ` had two or more refused ships${there.length === refused.length ? ', and all of them still got there. ' : `, and ${num(there.length)} of those still got there. `}`]
      : [early ? 'None is on record with two or more refused ships. ' : 'None had two or more refused ships. ']),
    ...(nothing.length ? [h('b', {}, num(nothing.length)), ` ${nothing.length === 1 ? 'feature, fix or chore' : 'features, fixes and chores'} ${where}: ${money(value(nothing, 'cost'))}.`] : ['No feature, fix or chore closed with nothing on main.']),
  );
}

const how = (data) =>
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
      'A refused ship is a hand-off that did not go through, kept in its chat since Nov 14, or a note of two failed ships, since Nov 19. A ship from before then, or one the minion ran itself, has none on record, so it reads "refusals not recorded" rather than as a first try. Why a minion closed isn\'t recorded either: one stopped on purpose and given to others counts with the rest.',
    ),
  );
