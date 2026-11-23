// A scheme's Chains page (#1679; Cara, 2026-11-22: "this could be linked to in the chip that shows that a minion is
// waiting on another minion, and minions in a dependency chain could also just have a link to it on their chat page").
// She picked its own page, a "See the chain →" link in the wait chip's popover, and every wait on another minion
// counting. Each chain runs left to right from the minion nobody in it waits on, wires between them (hover one to trace
// what it waits on and what waits on it); on a phone it is an indented list. It only reads: src/chains.ts builds it.
import { api, h, icon, phase, poller, view } from './base.js';
import { usage } from './core.js';
import { rowState, spokenCell } from './threadstate.js';
import { emptyCard, schemeTag, statTiles, toneChip } from './look.js';
import { loadingLine } from './ui/state.js';

const KIND = {
  claim: { word: 'Queue', tone: 'warn', hue: 'waiting' },
  build: { word: 'Build', tone: 'violet', hue: 'teal' },
  start_after: { word: 'Starts after', tone: 'neutral', hue: 'held' },
  wait: { word: 'Waits on', tone: 'info', hue: 'running' },
};
const POLL_MS = 15_000;
const STALE_MS = 20_000;

/** Each scheme's last read: { at, chains, error, loading, after }. The page and the chat head's link share it, and every caller's `after` runs when it lands. */
const cache = new Map();
let pageEl = null, pageProject = null, focus = null, drawnSig = '', entered = false;

function read(projectId, after) {
  const c = cache.get(projectId) ?? { at: 0, chains: null, after: [] };
  if (after) c.after.push(after);
  if (c.loading) return c.loading;
  c.loading = api(`api/projects/${projectId}/chains`)
    .then(({ chains }) => { c.chains = chains; c.error = null; })
    .catch((ex) => { c.error = ex.message; })
    .finally(() => { c.at = Date.now(); c.loading = null; for (const f of c.after.splice(0)) f(); });
  cache.set(projectId, c);
  return c.loading;
}

export const chainsHref = (projectId, number) => `#/p/${projectId}/chains${number ? `/${number}` : ''}`;

/** The page at #/p/N/chains, `number` a minion whose chain to highlight. */
export function chainsPage(projectId, number) {
  focus = number ?? null;
  entered = false;
  drawnSig = '';
  pageProject = projectId;
  pageEl = h('section', { class: 'artifacts-main chains-main' });
  draw(projectId);
  read(projectId, () => draw(projectId));
  // Fresh while it's on screen: the poller waits while the tab is hidden and stops once the page is gone.
  const el = pageEl;
  let first = true; // the read above is this one: the page isn't attached yet, so the first tick only starts the wait
  poller(async () => {
    if (first) { first = false; return true; }
    if (!el.isConnected) return false;
    await read(projectId, () => draw(projectId));
  }, POLL_MS).now();
  return pageEl;
}

/** A node's state as the minions list shows it, from the list's own copy when it has one. */
function stateOf(n) {
  const t = n.project === view.projectId ? view.tickets?.get(n.id) : null;
  if (t) {
    const st = rowState(t, usage);
    return { word: st.cell || st.label, label: st.label, spoken: st.cell ? spokenCell(st) : null, fam: t.asleep && t.status !== 'closed' ? 'idle' : st.fam || 'idle', pulse: !!st.pulse, t };
  }
  if (n.status === 'build') return { word: 'Build', fam: 'idle' };
  if (n.status === 'closed') return { word: 'Dismissed', fam: 'idle' };
  // ADR 0027: people read "sealed", never the stored "parked".
  return { word: n.state === 'parked' ? 'sealed' : n.state || n.status, fam: n.status === 'running' ? 'work' : 'idle', pulse: n.status === 'running' };
}

function draw(projectId) {
  // A read for a scheme whose page has since been left (switched schemes mid-fetch) draws nothing.
  if (projectId !== pageProject || (!pageEl?.isConnected && pageEl?.childNodes.length)) return;
  const c = cache.get(projectId);
  const chains = c?.chains;
  // A redraw that would change nothing keeps what's on screen (and the hover a person is tracing).
  const sig = JSON.stringify([c?.error, chains, chains?.flatMap((ch) => ch.nodes.map((n) => { const s = stateOf(n); return [s.word, s.label, s.fam, s.pulse]; }))]);
  if (sig === drawnSig) return;
  drawnSig = sig;
  const head = h('div', { class: 'ticket-head' },
    h('div', { class: 'row' }, h('h2', {}, 'Chains'),
      // A failed refresh keeps the last chains, marked in the head's free room so nothing below moves.
      chains && c.error ? h('span', { class: 'chains-stale', title: c.error }, toneChip('danger', 'Not refreshed')) : '', h('span', { class: 'spacer' }),
      h('a', { class: 'close-view', href: `#/p/${projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
    h('p', { class: 'chains-lede' }, 'Who waits on whom: minions that start after another, wait on its work or a note from it, queue for a claim like the pipeline lane, or feed a build.'));
  const body = !c || (!chains && !c.error) ? [loadingLine('Loading…')]
    : !chains ? [h('p', { class: 'error' }, c.error)]
    : !chains.length ? [emptyCard('No minion waits on another right now', 'When one starts after another, waits on its work, queues for the pipeline lane or feeds a build, its chain shows here.', { mark: '⛓' })]
    : [summary(chains), legend(), ...chains.map((ch) => chainCard(ch))];
  pageEl.replaceChildren(head, ...body);
  pageEl.classList.toggle('enter', !entered && !!chains?.length);
  if (chains?.length) entered = true;
  requestAnimationFrame(() => {
    for (const flow of pageEl.querySelectorAll('.chain-flow')) wire(flow);
    const hit = focus != null && pageEl.querySelector('.chain-card.focus');
    if (hit && !hit.dataset.scrolled) { hit.dataset.scrolled = '1'; hit.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
  });
}

function summary(chains) {
  // A build with no build minion is a node, not a minion: it counts in neither total.
  const waiting = new Set(chains.flatMap((c) => c.edges.map((e) => e.from)).filter((k) => !k.startsWith('build:')));
  const lane = chains.flatMap((c) => c.edges).filter((e) => e.kind === 'claim').length;
  return statTiles([chains.length, chains.length === 1 ? 'chain' : 'chains', 'accent'], [waiting.size, waiting.size === 1 ? 'minion waiting' : 'minions waiting', 'waiting'],
    lane ? [lane, 'in a claim queue', 'held'] : null);
}

const legend = () => h('div', { class: 'chain-legend', 'aria-hidden': 'true' },
  ...Object.entries(KIND).map(([k, v]) => h('span', { class: 'chain-legend-item', 'data-kind': k }, h('i'), v.word)));

function chainCard(ch) {
  const here = focus != null && ch.nodes.some((n) => n.number === focus && n.project === view.projectId);
  const cols = Math.max(...ch.nodes.map((n) => n.col)) + 1;
  const rowIn = new Map();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'chain-wires');
  svg.setAttribute('aria-hidden', 'true');
  const flow = h('div', { class: 'chain-flow' }, svg,
    ...treeOrder(ch).map((n) => {
      const r = (rowIn.get(n.col) ?? 0) + 1;
      rowIn.set(n.col, r);
      return node(n, ch, r, here && n.number === focus);
    }));
  flow.chain = ch;
  flow.style.setProperty('--cols', String(cols));
  const kinds = ch.kinds.map((k) => toneChip(KIND[k].tone, KIND[k].word));
  return h('article', { class: `chain-card${here ? ' focus' : ''}`, 'data-hue': KIND[ch.kinds[0]]?.hue ?? 'running', 'data-key': ch.key },
    h('header', { class: 'chain-head' }, h('span', { class: 'chain-tile', 'aria-hidden': 'true' }, '⛓'),
      h('b', { class: 'chain-title' }, ch.title), ...kinds, h('span', { class: 'chain-count' }, minions(ch.nodes.filter((n) => n.id != null).length))),
    flow);
}

const minions = (n) => `${n} minion${n === 1 ? '' : 's'}`;

/** Each minion straight after the one it comes after, so a phone's indented list reads as a tree; the desktop grid places them by column either way. */
function treeOrder(ch) {
  const out = [], seen = new Set();
  const visit = (n) => {
    if (seen.has(n.key)) return;
    seen.add(n.key);
    out.push(n);
    for (const w of ch.nodes.filter((x) => ch.edges.some((e) => e.from === x.key && e.to === n.key))) visit(w);
  };
  for (const n of ch.nodes.filter((x) => !ch.edges.some((e) => e.from === x.key))) visit(n);
  for (const n of ch.nodes) visit(n); // a loop has no start: its nodes follow in column order
  return out;
}

function node(n, ch, row, here) {
  const s = stateOf(n);
  // One entry per minion it comes after, with each claim or build that puts it there (a pair can be both start_after and a queue).
  const byTo = new Map();
  for (const e of ch.edges.filter((x) => x.from === n.key)) {
    const labels = byTo.get(e.to) ?? [];
    if (e.kind === 'claim' || e.kind === 'build') labels.push(e.label);
    byTo.set(e.to, labels);
  }
  const after = [...byTo].map(([key, labels]) => {
    const to = ch.nodes.find((x) => x.key === key);
    return `${to?.number ? `#${to.number}` : to?.title ?? '?'}${labels.length ? ` · ${labels.join(' · ')}` : ''}`;
  });
  const other = n.project !== view.projectId ? view.projects?.find((p) => p.id === n.project) : null;
  const tag = n.number ? 'a' : 'div';
  const el = h(tag, {
    class: `chain-node f-${s.fam}${here ? ' here' : ''}${n.status === 'closed' ? ' gone' : ''}`, href: n.number ? `#/p/${n.project}/t/${n.number}` : null,
    'data-key': n.key, 'data-col': Math.min(n.col, 8), 'data-row': Math.min(row, 12), 'aria-current': here ? 'true' : null,
    title: after.length ? `After ${after.join(', ')}` : 'Nobody in this chain is ahead of it',
    onpointerenter: (e) => trace(e.currentTarget), onpointerleave: (e) => untrace(e.currentTarget),
    onfocus: (e) => trace(e.currentTarget), onblur: (e) => untrace(e.currentTarget),
  },
  h('span', { class: 'chain-node-top' }, h('span', { class: 'num' }, n.number ? `#${n.number}` : '⑂'), other ? schemeTag(other.name) : '',
    h('span', { class: 'chain-state', title: s.label ?? null, role: s.spoken ? 'img' : null, 'aria-label': s.spoken ?? null }, s.pulse ? phase(h('i', { class: 'pulse' }), 1600) : '', s.word)),
  h('span', { class: 'chain-node-title' }, n.title),
  after.length ? h('span', { class: 'chain-after' }, '↳ after ', after.join(', ')) : '');
  // The grid's place, through the CSSOM (the CSP refuses style="").
  el.style.setProperty('--col', String(n.col + 1));
  el.style.setProperty('--row', String(row));
  return el;
}

/** The chain's wires, measured from where the nodes landed; redrawn when the flow resizes. */
function wire(flow) {
  const svg = flow.querySelector('.chain-wires');
  if (!svg || getComputedStyle(svg).display === 'none') return;
  const box = flow.getBoundingClientRect();
  const at = (key) => flow.querySelector(`.chain-node[data-key="${CSS.escape(key)}"]`)?.getBoundingClientRect();
  svg.setAttribute('width', String(flow.scrollWidth));
  svg.setAttribute('height', String(flow.scrollHeight));
  const ns = 'http://www.w3.org/2000/svg';
  const paths = flow.chain.edges.map((e) => {
    const a = at(e.to), b = at(e.from);
    if (!a || !b) return null;
    const x1 = a.right - box.left + flow.scrollLeft, y1 = a.top + a.height / 2 - box.top;
    const x2 = b.left - box.left + flow.scrollLeft, y2 = b.top + b.height / 2 - box.top;
    // A loop's back wire bows out under the nodes instead of crossing them.
    const d = x2 > x1 ? `M${x1} ${y1} C${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`
      : `M${x1} ${y1} C${x1 + 40} ${y1 + 60}, ${x2 - 40} ${y2 + 60}, ${x2} ${y2}`;
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', 'chain-wire');
    p.dataset.kind = e.kind;
    p.dataset.from = e.from;
    p.dataset.to = e.to;
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', String(x2));
    dot.setAttribute('cy', String(y2));
    dot.setAttribute('r', '3');
    dot.setAttribute('class', 'chain-wire-end');
    dot.dataset.kind = e.kind;
    dot.dataset.from = e.from;
    dot.dataset.to = e.to;
    return [p, dot];
  }).filter(Boolean).flat();
  svg.replaceChildren(...paths);
  fade(flow);
  if (!flow.watching) {
    flow.addEventListener('scroll', () => fade(flow), { passive: true });
    flow.watching = new ResizeObserver(() => (flow.isConnected ? wire(flow) : flow.watching.disconnect()));
    flow.watching.observe(flow);
  }
}

/** A chain wider than its card fades at the edge it scrolls on, until it's scrolled to the end. */
const fade = (flow) => flow.classList.toggle('more', flow.scrollLeft + flow.clientWidth < flow.scrollWidth - 4);

/** Light what a node waits on, all the way back, and what waits on it, all the way on; dim the rest of its chain. */
function trace(el) {
  const flow = el.closest('.chain-flow');
  const ch = flow?.chain;
  if (!ch) return;
  const walk = (start, next) => {
    const seen = new Set([start]);
    const todo = [start];
    while (todo.length) for (const k of next(todo.pop())) if (!seen.has(k)) { seen.add(k); todo.push(k); }
    return seen;
  };
  const k = el.dataset.key;
  const lit = new Set([...walk(k, (x) => ch.edges.filter((e) => e.from === x).map((e) => e.to)), ...walk(k, (x) => ch.edges.filter((e) => e.to === x).map((e) => e.from))]);
  flow.classList.add('tracing');
  for (const n of flow.querySelectorAll('.chain-node')) n.classList.toggle('lit', lit.has(n.dataset.key));
  for (const w of flow.querySelectorAll('.chain-wires > *')) w.classList.toggle('lit', lit.has(w.dataset.from) && lit.has(w.dataset.to));
}

function untrace(el) {
  const flow = el.closest('.chain-flow');
  if (!flow || flow.contains(document.activeElement) && document.activeElement !== el) return;
  flow.classList.remove('tracing');
  for (const x of flow.querySelectorAll('.lit')) x.classList.remove('lit');
}

/**
 * The chat head's link to a minion's chain, or '' when it's in none. Drawn from the scheme's last read; a stale one
 * reads again behind and calls `redraw` once the answer arrives, if that changed whether the link shows.
 */
export function chainLink(t, redraw) {
  if (!t?.number || t.kind === 'coordinator') return '';
  const c = cache.get(t.project_id);
  const find = () => cache.get(t.project_id)?.chains?.find((ch) => ch.nodes.some((n) => n.id === t.id));
  const had = find();
  if (!c || (!c.loading && Date.now() - c.at > STALE_MS)) read(t.project_id, () => { if (!!find() !== !!had || find()?.nodes.length !== had?.nodes.length) redraw?.(); });
  if (!had) return '';
  const n = had.nodes.length;
  return h('a', { class: 'tag-chip chain-link', href: chainsHref(t.project_id, t.number), title: `${minions(n)} in ${had.title}: see who waits on whom` },
    h('span', { 'aria-hidden': 'true' }, '⛓ '), `Chain · ${n}`);
}
