// Two read-outs on the Releases page (#1060): the claims a scheme holds (the pipeline lane and other single-holder
// duties, src/claims.ts) with their queues (#1334), and Citadel's post-deploy watch (src/deploy-watch.ts): each deploy's
// checks at +20 min, +1 h and +24 h, before against after. The server decides every verdict; nothing here knows a threshold.
import { ago, api, h } from './base.js';
import { optimistic } from './ui/optimistic.js';
import { hueRow, showFirst, statTiles, toneChip } from './look.js';
import { settingsRow } from './settings.js';

const claims = new Map(); // projectId → [claim view]
let watch = null; // deploy-watch deploys, or null

/** Reads one scheme's claims (a `claims` event, or the first look). Quiet on failure: the card just has no claims line. */
export async function loadClaims(projectId, redraw) {
  try {
    claims.set(projectId, (await api(`api/projects/${projectId}/claims`)).claims);
    redraw?.();
  } catch { /* an older server, or a restart's gap */ }
}

export async function loadWatch(redraw) {
  try {
    watch = (await api('api/deploy-watch')).deploys;
    redraw?.();
  } catch { /* as above */ }
}

const OFFSETS = { 1_200_000: '+20 min', 3_600_000: '+1 h', 86_400_000: '+24 h' };

const STAGES = ['Working', 'Reviewing', 'Shipping', 'Live'];
const STAGE_AT = { working: 0, reviewing: 1, shipping: 2 };
// A queued minion's chip (src/routes/projects.ts queuedState): [tone, words].
const QUEUED = { done: ['ok', '✓ Done'], working: ['info', 'Working'], waiting: ['violet', 'Waiting'], new: ['neutral', 'Not started'], gone: ['neutral', 'Dismissed'] };

// A past holder's chip by how its time ended (src/claims.ts SpanEnd).
const ENDED = { live: ['ok', '✓ Shipped'], released: ['neutral', 'Released'], dismissed: ['neutral', 'Dismissed'] };

/** A holder's or a queued minion changed (its plan, state or ship): redraw its claim's stage, time and chips, at most every 5 s per scheme. */
const holderLoads = new Map();
export function onHolderTicket(t, redraw) {
  if (!(claims.get(t.project_id) ?? []).some((c) => c.holder === t.id || (c.queue ?? []).some((q) => q.number === t.number)) || holderLoads.has(t.project_id)) return;
  holderLoads.set(t.project_id, setTimeout(() => { holderLoads.delete(t.project_id); loadClaims(t.project_id, redraw); }, 5000));
}

/** "40 min", "3.5 h": a rough time, as the estimate is. */
function roughly(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 90 ? `${min} min` : `${Math.round(min / 6) / 10} h`;
}

/** A bar's fill through the CSSOM (the CSP refuses style=""): --p as a percent, --f as a fraction for scaleX. */
function filled(el, frac) {
  const f = Math.max(0, Math.min(1, frac));
  el.style.setProperty('--p', `${(f * 100).toFixed(1)}%`);
  el.style.setProperty('--f', f.toFixed(3));
  return el;
}

/**
 * The closed row's line (#1334, Cara picked "Segment bar"): one segment per step of this run (past holders filled, the
 * holder's filling by its stage, the waiting empty), then "N of M done" and the time left in a fixed-width column, so
 * nothing moves as they change. With too little history the time says so instead of guessing.
 */
function claimProgress(c) {
  const tip = (q) => `#${q.number} ${q.title}`;
  const done = c.queue.filter((q) => q.state === 'done');
  const waiting = c.queue.filter((q) => q.state !== 'done');
  const holder = h('span', { class: 'h', title: c.holder_name }, filled(h('i'), c.progress ?? 0));
  const segs = [...done.map((q) => h('span', { class: 'd', title: tip(q) })), holder, ...waiting.map((q) => h('span', { title: tip(q) }))];
  const time = c.estimate
    ? h('span', { class: 'claim-est', tabindex: 0, 'data-tip': `Estimate: the median time a holder kept ${c.name}, over its last ${c.estimate.of} holders (${roughly(c.estimate.median_ms)} each)` }, `≈ ${roughly(c.estimate.left_ms)} left`)
    : h('span', { class: 'muted' }, 'time after 3 holders');
  return h('span', { class: 'claim-prog' }, h('span', { class: 'claim-segs', 'aria-hidden': 'true' }, ...segs),
    h('span', { class: 'claim-side' }, h('b', {}, `${c.done} of ${c.total} done`), time));
}

/** The holder's four stages, the one it is in filled by how far along it is. */
function stageStrip(c) {
  const at = STAGE_AT[c.stage] ?? 0;
  return h('div', { class: 'claim-stages' }, ...STAGES.map((name, i) => {
    const el = h('div', { class: i < at ? 'past' : i === at ? 'on' : null }, name);
    return i === at ? filled(el, at === 0 ? (c.progress ?? 0) / 0.6 : 0.5) : el;
  }));
}

/**
 * The queue with the waiting steps in `order` (minion numbers), at once: expected starts stay with their places in line, a
 * removed step leaves the count. The server's view replaces it.
 */
function reordered(c, order) {
  const done = c.queue.filter((q) => q.state === 'done');
  const waiting = c.queue.filter((q) => q.state !== 'done');
  const next = order.map((n, i) => ({ ...waiting.find((q) => q.number === n), starts_text: waiting[i].starts_text }));
  return { ...c, queue: [...done, ...next], total: c.total - (waiting.length - next.length) };
}

/**
 * The open row: the holder's box, then the line in order, each with its chip and, when history allows, its expected start.
 * A waiting step moves up or down or leaves the line (Cara, 2026-11-20, "Reorder and remove"); adding one stays with the
 * Taskmaster's tools. `edit(order, label)` saves a new waiting order.
 */
function claimBody(c, edit) {
  const step = c.step ? `plan step ${Math.min(c.step.done + 1, c.step.of)} of ${c.step.of}` : STAGES[STAGE_AT[c.stage] ?? 0];
  const box = h('div', { class: 'claim-holder' }, h('div', { class: 'claim-who' },
    h('span', {}, h('b', {}, c.holder_name), ' ', h('span', { class: 'muted' }, `${c.since_text}${c.note ? ` · ${c.note}` : ''}`)),
    c.stage ? h('span', { class: 'muted num' }, step) : null), c.stage ? stageStrip(c) : null);
  // A dismissed minion still in the line can't be sent back (the server refuses closed minions): any edit drops it.
  const order = c.queue.filter((q) => q.state !== 'done' && q.state !== 'gone' && q.number != null).map((q) => q.number);
  const swap = (i, j) => order.map((n, k) => (k === i ? order[j] : k === j ? order[i] : n));
  const rows = c.queue.map((q, i) => {
    const [tone, word] = q.state === 'chained' ? ['warn', `After #${q.after}`] : q.state === 'done' ? ENDED[q.how] ?? QUEUED.done : QUEUED[q.state] ?? QUEUED.waiting;
    const at = order.indexOf(q.number);
    const btn = (glyph, label, enabled, next) => h('button', { type: 'button', class: 'claim-mv', 'aria-label': `${label} #${q.number}`, 'data-tip': `${label} #${q.number}`, disabled: !enabled,
      onclick: () => edit(next(), `${label.toLowerCase()} #${q.number}`) }, glyph);
    const moves = at < 0 ? h('span', { class: 'claim-mvs' }) : h('span', { class: 'claim-mvs' },
      btn('↑', 'Move up', at > 0, () => swap(at, at - 1)), btn('↓', 'Move down', at < order.length - 1, () => swap(at, at + 1)),
      btn('✕', 'Take out of the line', true, () => order.filter((n) => n !== q.number)));
    return h('li', { class: `claim-q${q.state === 'done' ? ' d' : ''}` }, h('span', { class: 'pos' }, String(i + 1)),
      h('span', { class: 'nm' }, `#${q.number} ${q.title}`), toneChip(tone, word), h('span', { class: 'eta' }, q.starts_text ?? ''), moves);
  });
  return [box, h('div', {}, h('div', { class: 'claim-sub' }, c.estimate ? 'Queue · expected start' : 'Queue'), h('ol', { class: 'claim-qlist' }, ...rows))];
}

export function claimsBlock(projectId, redraw) {
  const list = claims.get(projectId) ?? [];
  if (!list.length) return '';
  // Each claim is a row that opens (Citadel's look, #1068): who holds it and the queue's bar on the closed line, the rest inside.
  const rows = list.map((c) => {
    const queued = Array.isArray(c.queue) && c.queue.length > 0;
    const stage = c.stage ? ` · ${STAGES[STAGE_AT[c.stage]]}` : '';
    const [row] = settingsRow({ key: `claim:${projectId}/${c.name}`, icon: 'lock', hue: 'held', title: c.name,
      summary: [toneChip('violet', 'Held'), `${c.holder_name}${queued ? stage : ` · ${c.since_text}`}`] },
    ...(queued ? claimBody(c, (order, label) => optimistic({
      key: `claim:${projectId}/${c.name}`,
      apply: () => { claims.set(projectId, (claims.get(projectId) ?? []).map((x) => (x.name !== c.name ? x : reordered(x, order)))); redraw(); },
      send: () => api(`api/projects/${projectId}/claims/${encodeURIComponent(c.name)}/queue`, { method: 'PUT', body: { queue: order } }),
      undo: () => { claims.set(projectId, list); redraw(); },
      label,
    })) : []),
    hueRow({ hue: 'held' }, queued ? h('span', { class: 'muted' }, 'A Taskmaster passes it on; it also passes on when its holder is dismissed.') : [h('b', {}, c.holder_name), ' ', h('span', { class: 'muted' }, `${c.since_text}${c.note ? ` · ${c.note}` : ''}`)]));
    if (queued) row.querySelector('.settings-row-text').append(claimProgress(c));
    return row;
  });
  return h('section', { class: 'rel-claims' }, h('h3', { class: 'settings-section', 'data-hue': 'held' }, 'Held by one at a time'),
    h('div', { class: 'settings-rows' }, ...rows));
}

const verdict = (r) => (r.worse ? 'worse' : 'fine');

/** One check of a deploy: its offset and verdict on a bar in the verdict's hue, then each reading under it. */
function checkRows(d, c) {
  const offset = OFFSETS[c.offset] ?? `+${c.offset / 60000} min`;
  const note = (t) => h('span', { class: 'muted' }, t);
  if (c.len === null) return [hueRow({ hue: 'muted', lead: offset }, note(d.alerted ? 'not run: an earlier check raised the alert' : 'not due yet'))];
  if (!c.readings.length) return [hueRow({ hue: 'muted', lead: offset }, note('window too short to compare (the next deploy cut it)'))];
  const bad = c.readings.filter((r) => r.worse).length;
  return [hueRow({ hue: bad ? 'danger' : 'done', lead: offset, meta: toneChip(bad ? 'danger' : 'ok', bad ? `${bad} worse` : 'Fine') },
    `${c.readings.length} readings`),
  ...c.readings.map((r) => hueRow({ hue: r.worse ? 'danger' : 'done', meta: `${r.before} → ${r.after} · ${verdict(r)}` }, `${r.name}`))];
}

export function watchBlock() {
  if (!watch?.length) return '';
  const rows = watch.map((d, i) => {
    const run = d.checks.filter((c) => c.readings.length).length; // a window the next deploy cut short compared nothing
    const worse = d.checks.reduce((n, c) => n + c.readings.filter((r) => r.worse).length, 0);
    const [tone, word] = d.alerted ? ['danger', 'Raised an alert'] : worse ? ['warn', `${worse} worse`] : run ? ['ok', 'Fine'] : ['neutral', 'Not checked yet'];
    return settingsRow({ key: `watch:${d.commit}`, icon: 'eye', hue: d.alerted ? 'danger' : worse ? 'waiting' : 'done', open: i === 0, title: d.commit.slice(0, 8),
      summary: [toneChip(tone, word), `live ${ago(d.at)} · ${run}/${d.checks.length} checks compared`] },
    statTiles([`${run} of ${d.checks.length}`, 'checks compared', 'running'], [String(worse), 'readings worse', worse ? 'danger' : 'done']),
    h('div', { class: 'hue-rows' }, ...d.checks.flatMap((c) => checkRows(d, c))))[0];
  });
  return h('section', { class: 'rel-watch' }, h('h3', { class: 'settings-section', 'data-hue': 'running' }, 'Post-deploy watch'),
    showFirst({ key: 'watch-deploys', items: rows, n: 5, noun: 'deploys', wrap: (xs) => h('div', { class: 'settings-rows' }, ...xs) }),
    h('p', { class: 'look-prose' }, 'Each reading in the window after a deploy against the same window before it. It only warns: it never reverts.'));
}
