// Status (#1123; Josh, 2026-11-19: app vitals "alongside CI in a new "Status" page", the Citadel page "Combine
// with A4"), since #1423 the Releases page's Status tab: Citadel and the picked scheme's apps, the one picked showing its
// tiles, each with its last 8 days. It reads /api/status (src/status-page.ts) every 30 s and changes
// nothing. Every tile keeps its size whatever its numbers say, so a re-read moves nothing. The Status chip beside
// CI's opens that tab, its dot the worst verdict it shows.
import { ago, api, h, view, whenShown, pacificStamp, pacificIso, pacificClockBare, pacificClock } from './base.js';
import { toast } from './ui/status.js';
import { hueRow, schemeTag, toneChip } from './look.js';
import { optimistic } from './ui/optimistic.js';
import { pcWord } from './ci-desktop.js';
import { LAST_SCHEME } from './sidebar.js';
import { scopedPageHash } from './page-scope.js';
import { opening } from './releases.js';

const REFRESH_MS = 30_000;
const when = pacificStamp;
const dayLabel = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
export const DOT = { ok: 'ready', warn: 'fix', bad: 'down' };
const CHIP = { ok: 'ok', warn: 'warn', bad: 'danger' };
export const WORD = { ok: 'OK', warn: 'Worth a look', bad: 'Needs a person' };
export const RANK = { ok: 0, warn: 1, bad: 2 };
const SVG = 'http://www.w3.org/2000/svg';

const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  el.append(...kids);
  return el;
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export function bytes(n) {
  if (n === null || n === undefined) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
export function secs(s) {
  if (s === null || s === undefined) return '–';
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}
const span = (ms) => {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  return hrs < 48 ? `${hrs} h ${m % 60} min` : `${Math.floor(hrs / 24)} days ${hrs % 24} h`;
};
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Eight daily bars, one hue, `bad[i]` of each drawn in the error hue on top; a hover title per day (its whole column is the
 * target). The last bar is today. Rounded data ends, 2px gaps; the height is fixed whatever the numbers.
 */
export function dayBars(days, counts, { bad = null, tip = (i) => `${counts[i]}`, label } = {}) {
  const W = 160, H = 36, gap = 2, n = counts.length, bw = (W - gap * (n - 1)) / n;
  const max = Math.max(1, ...counts);
  const top = (x, y, w, hgt, r) => (hgt <= 0 ? '' : `M${x},${y + hgt}V${y + Math.min(r, hgt)}Q${x},${y} ${x + Math.min(r, w / 2)},${y}H${x + w - Math.min(r, w / 2)}Q${x + w},${y} ${x + w},${y + Math.min(r, hgt)}V${y + hgt}Z`);
  const marks = counts.flatMap((c, i) => {
    const x = i * (bw + gap);
    const hgt = c ? Math.max(2, (c / max) * H) : 0;
    const b = bad ? Math.min(bad[i] ?? 0, c) : 0;
    const bh = b ? Math.max(2, (b / max) * H) : 0;
    const out = [];
    // The good part sits on the baseline; the bad part is its top, with the rounded end.
    if (hgt - bh > 0) out.push(svg('path', { d: bh ? `M${x},${H}V${H - (hgt - bh)}H${x + bw}V${H}Z` : top(x, H - hgt, bw, hgt, 4), class: 'st-bar' }));
    if (bh) out.push(svg('path', { d: top(x, H - hgt, bw, bh, 4), class: 'st-bar bad' }));
    if (!c) out.push(svg('rect', { x, y: H - 1, width: bw, height: 1, class: 'st-zero' }));
    out.push(svg('rect', { x, y: 0, width: bw + gap, height: H, class: 'st-hit' }, svg('title', {}, `${dayLabel(days[i])}: ${tip(i)}`)));
    return out;
  });
  return h('figure', { class: 'st-chart' },
    svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label ?? `last ${n} days` }, ...marks),
    h('figcaption', { class: 'st-axis' }, h('span', {}, dayLabel(days[0]).replace(/^\w+, /, '')), h('span', {}, 'today')));
}

/** A week of hourly readings as a line, 0 to `max` (percentages by default), its rule at `rule`, with a hover title per hour. */
export function hourLine(series, idx, { from, to, label, max = 100, rule = 90, tip = (v) => `${v}% used at worst` }) {
  const W = 160, H = 36;
  const x = (t) => ((t - from) / (to - from)) * W;
  const y = (v) => H - (Math.min(v, max) / max) * H;
  const pts = series.map((s) => `${x(s[0]).toFixed(1)},${y(s[idx]).toFixed(1)}`);
  const step = Math.max(1, W / ((to - from) / 3_600_000));
  return h('figure', { class: 'st-chart' },
    svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label },
      svg('line', { x1: 0, x2: W, y1: y(rule), y2: y(rule), class: 'st-rule' }),
      pts.length > 1 ? svg('polyline', { points: pts.join(' '), class: 'st-line' }) : '',
      ...series.map((s) => svg('rect', { x: x(s[0]) - step / 2, y: 0, width: step, height: H, class: 'st-hit' }, svg('title', {}, `${when(s[0])}: ${tip(s[idx])}`)))),
    h('figcaption', { class: 'st-axis' }, h('span', {}, series.length ? `since ${when(series[0][0]).replace(/,? \d+:\d+.*$/, '')}` : 'no readings yet'), h('span', {}, 'now')));
}

// Time to ship (#1132): one chart per ship target, "asked" to "live" per day as a median (blue) and the slow tail, the p90
// (orange), against the 10 minute line the Taskmaster's nudge fires at. A day is a button: it opens that day's ships as
// bars split into their steps. The day with the worst tail is open until a person picks another.
const SLOW_S = 600;
const STAGE_ORDER = ['line', 'rebase', 'test', 'build', 'deploy', 'restart', 'live'];
const shipPick = new Map();
const shortDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'numeric', day: 'numeric' });
const dayPath = (vals, x, y) => {
  let d = '';
  let pen = false;
  vals.forEach((v, i) => { if (v === null) pen = false; else { d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; } });
  return d;
};
const dotPath = (vals, x, y) => vals.map((v, i) => (v === null ? '' : `M${x(i).toFixed(1)},${y(v).toFixed(1)}h0`)).join('');

export function shipChart(t, days, redraw) {
  const n = days.length, W = 400, H = 110;
  const peak = Math.max(SLOW_S * 1.2, ...t.p90.filter((v) => v !== null));
  const x = (i) => ((i + 0.5) / n) * W;
  const y = (v) => H - (v / peak) * H;
  const worst = t.p90.reduce((w, v, i) => (v !== null && (w < 0 || v > t.p90[w]) ? i : w), -1);
  const picked = shipPick.get(t.key);
  const pick = picked !== undefined && (picked === null || days.includes(picked)) ? picked : days[worst];
  const choose = (day) => { shipPick.set(t.key, pick === day ? null : day); redraw(); };
  const hits = days.map((day, i) => svg('rect', { x: (i / n) * W, y: 0, width: W / n, height: H, class: `st-hit${day === pick ? ' on' : ''}`, 'data-day': day, onclick: () => choose(day) },
    svg('title', {}, `${dayLabel(day)}: ${t.counts[i] ? `${plural(t.counts[i], 'ship')}, median ${secs(t.median[i])}, slowest tenth ${secs(t.p90[i])}` : 'no ships'}`)));
  const plot = h('div', { class: 'st-plot' },
    svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `${t.title}: median and slowest-tenth time to ship, a day each` },
      svg('line', { x1: 0, x2: W, y1: y(SLOW_S), y2: y(SLOW_S), class: 'st-rule' }),
      svg('path', { d: dayPath(t.p90, x, y), class: 'st-line s2' }), svg('path', { d: dotPath(t.p90, x, y), class: 'st-dot s2' }),
      svg('path', { d: dayPath(t.median, x, y), class: 'st-line s1' }), svg('path', { d: dotPath(t.median, x, y), class: 'st-dot s1' }),
      ...hits),
    h('span', { class: 'st-rule-label muted' }, '10 min'));
  plot.querySelector('.st-rule-label').style.setProperty('top', `${(y(SLOW_S) / H) * 100}%`);
  const buttons = h('div', { class: 'st-days', role: 'group', 'aria-label': 'Pick a day to see its ships' }, ...days.map((day, i) => h('button', {
    type: 'button', class: `st-day${day === pick ? ' on' : ''}${t.p90[i] !== null && t.p90[i] > SLOW_S ? ' slow' : ''}`, 'aria-pressed': day === pick ? 'true' : 'false', onclick: () => choose(day) },
  h('span', {}, shortDay(day)), h('b', {}, t.counts[i] ? secs(t.p90[i]) : '–'))));
  return h('section', { class: 'st-tile wide st-ship', 'data-key': t.key },
    h('h4', {}, `Time to ship · ${t.title}`),
    h('div', { class: 'st-legend' }, h('span', { class: 's1' }, 'Median'), h('span', { class: 's2' }, 'Slowest tenth (p90)'), h('span', { class: 'muted' }, 'asked to live, per day')),
    plot, buttons, pick ? shipWaterfall(t, pick) : h('p', { class: 'muted small st-pick' }, 'Pick a day to see its ships step by step.'),
    ix?.ask ? foot({ target: ix.target, tile: shipTile(t.key), title: `Time to ship · ${t.title}`, value: `${t.counts.reduce((a, b) => a + b, 0)} ships this week`, sub: 'median and slowest tenth, asked to live',
      chart: days.map((d, i) => `${shortDay(d)} ${t.counts[i]} ships, median ${secs(t.median[i])}, p90 ${secs(t.p90[i])}`).join('; '), reasons: [] }) : '');
}

/** A ship chart's tile key: an app's is its own `ship-time`; each release chart on Citadel's page gets its own, so their looks don't mix. */
const shipTile = (key) => (key.startsWith('release:') ? `ship-${key.slice(8).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 60) : 'ship-time');

/** That day's ships, slowest first (at most 8), each a bar of its steps; the rest of its time, the steps don't name, is grey. */
function shipWaterfall(t, day) {
  const todays = t.ships.filter((s) => pacificIso(s.at) === day).sort((a, b) => b.took - a.took);
  const shown = todays.slice(0, 8);
  const order = [...new Set(todays.flatMap((s) => Object.keys(s.stages)))].sort((a, b) => (STAGE_ORDER.indexOf(a) + 1 || 99) - (STAGE_ORDER.indexOf(b) + 1 || 99));
  const step = (name) => Math.min(order.indexOf(name) + 1, 6);
  const top = Math.max(1, ...shown.map((s) => s.took));
  const row = (s) => {
    const named = sum(Object.values(s.stages));
    const segs = [...order.filter((k) => s.stages[k]).map((k) => [k, s.stages[k], step(k)]), ...(s.took - named > 1 ? [['other', s.took - named, 0]] : [])];
    const bar = h('div', { class: 'st-wbar', role: 'img', 'aria-label': `${secs(s.took)}: ${segs.map(([k, v]) => `${k} ${secs(v)}`).join(', ')}` },
      ...segs.map(([k, v, i]) => { const el = h('i', { class: 'st-seg', 'data-step': i, title: `${k}: ${secs(v)}` }); el.style.setProperty('width', `${(v / top) * 100}%`); return el; }));
    return h('li', { class: s.took > SLOW_S ? 'slow' : '' }, h('span', { class: 'muted' }, pacificClockBare(s.at)), bar, h('b', {}, secs(s.took)));
  };
  return h('div', { class: 'st-water' },
    h('div', { class: 'st-water-head' }, h('b', {}, dayLabel(day)), h('span', { class: 'muted' }, todays.length ? `${plural(todays.length, 'ship')}, slowest first` : 'No ships that day')),
    todays.length ? h('div', { class: 'st-legend' }, ...order.map((k) => h('span', { class: 'st-key', 'data-step': step(k) }, k)), h('span', { class: 'st-key', 'data-step': 0 }, 'other')) : '',
    h('ul', { class: 'st-wlist' }, ...shown.map(row)),
    todays.length > shown.length ? h('p', { class: 'muted small' }, `and ${todays.length - shown.length} quicker`) : '');
}

/** A tile: its name, the headline, one line under it, then a chart or a list. Fixed height, so a re-read moves nothing. */
// Investigate (#1273; Cara, 2026-11-20: "each of the boxes should have an "investigate" button that sends the data to the relevant
// taskmaster"): each tile's foot says who is on it, a link to the minion that quotes its tag, and its button sends the tile's numbers
// to your own Taskmaster in its scheme. `ix` is the target the tiles being drawn belong to, set by draw.
let ix = null;
/** This page's own clicks by tag, kept so a re-read before the server shows them still says Sent. */
const asks = new Map();
const lookLine = (look, ask) => {
  const m = look?.minion;
  if (m) return h('span', { class: 'st-look' }, m.closed ? 'Looked into by ' : 'Looking into it: ', h('a', { href: `#/p/${m.project}/t/${m.number}`, title: m.title }, `#${m.number} ${m.title}`.trim()));
  const sent = Math.max(look?.sentAt ?? 0, ask?.at ?? 0);
  return h('span', { class: 'st-look muted' }, sent ? `Sent ${pacificClock(sent)}` : 'Nobody on it');
};
/** The newest foot drawn per tag: a reply that lands after a re-read paints the button on screen, not the one it replaced. */
const feet = new Map();
const clip = (x, n) => (x.length > n ? `${x.slice(0, n - 1)}…` : x);
function foot(raw) {
  // Clipped to what the server takes, so a long backups list still sends.
  const payload = { ...raw, title: clip(raw.title, 60), value: clip(String(raw.value), 200), sub: clip(String(raw.sub ?? ''), 400), chart: clip(raw.chart ?? '', 2000), reasons: raw.reasons.slice(0, 10).map((r) => clip(r, 300)) };
  const tag = `${payload.target}/${payload.tile}`;
  const look = ix.looks[payload.tile];
  const btn = h('button', { type: 'button', class: 'secondary st-ask' }, 'Investigate');
  const el = h('div', { class: 'st-foot' }, lookLine(look, asks.get(tag)), btn);
  // The button keeps its width whatever it says, so Sent and back moves nothing.
  const paint = (busy) => { el.firstChild.replaceWith(lookLine(look, asks.get(tag))); btn.disabled = busy; btn.textContent = busy ? 'Sent' : 'Investigate'; };
  feet.set(tag, paint);
  if (asks.get(tag)?.busy) paint(true);
  const send = () => {
    const prev = asks.get(tag);
    asks.set(tag, { at: Date.now(), busy: true });
    paint(true);
    api('api/status/investigate', { method: 'POST', body: payload }).then(() => {
      asks.set(tag, { at: asks.get(tag).at, busy: false });
      setTimeout(() => feet.get(tag)?.(false), 3000);
    }, (err) => {
      if (prev) asks.set(tag, prev); else asks.delete(tag);
      feet.get(tag)?.(false);
      toast(`Couldn't send ${payload.title} to your Taskmaster: ${err.message}`, { action: { label: 'Retry', run: send } });
    });
  };
  btn.onclick = send;
  return el;
}
const tile = (name, value, sub, body = null, { tone = null, wide = false, key = null, chart = '' } = {}) => h('section', { class: `st-tile${wide ? ' wide' : ''}`, 'data-tone': tone, 'data-tile': key },
  h('h4', {}, name), h('b', { class: 'st-value' }, value), h('div', { class: 'st-sub muted' }, sub), body ?? h('div', { class: 'st-chart st-empty' }),
  key && ix?.ask ? foot({ target: ix.target, tile: key, title: name, value, sub, chart, reasons: ix.verdict.reasons.filter((_, i) => ix.verdict.tiles?.[i] === key) }) : '');
/** A chart's numbers for the Taskmaster: a week by day, or the last day by hour. */
const perDay = (days, xs) => days.map((d, i) => `${shortDay(d)} ${xs[i]}`).join(', ');
const perHour = (series, idx) => series.slice(-24).map((s) => `${pacificClockBare(s[0])} ${s[idx]}`).join(', ');
const slot = (s) => h('section', { class: 'st-tile st-slot', 'data-slot': s.key }, h('h4', {}, s.title), h('div', { class: 'st-sub muted' }, s.note));

/** Every periodic job (#1311): how often, its last run and how long it took; overdue (3 periods without a run), slow (over 1 s) or failing ones first. */
function jobsTile(jobs, now) {
  const flags = (j) => [j.overdue && ['danger', 'overdue'], j.slow && ['warn', 'slow'], j.error && j.errorAt >= (j.last ?? 0) && ['danger', 'failed']].filter(Boolean);
  const bad = jobs.filter((j) => flags(j).length);
  const every = (ms) => ms >= 3_600_000 ? `every ${ms / 3_600_000} h` : ms >= 60_000 ? `every ${ms / 60_000} min` : `every ${ms / 1000} s`;
  const sorted = [...bad, ...jobs.filter((j) => !flags(j).length)];
  return tile('Jobs', bad.length ? `${plural(bad.length, 'job')} to look at` : 'All running', `${plural(jobs.length, 'periodic job')}; a slow one's freeze, if any, is on Stalls`,
    h('ul', { class: 'st-list st-jobs' }, ...sorted.flatMap((j) => [h('li', {},
      h('code', {}, j.name),
      h('span', { class: 'muted' }, `${every(j.ms)} · ${j.last ? `last ${ago(j.last)}${j.took !== null ? `, took ${j.took < 1000 ? `${j.took} ms` : secs(j.took / 1000)}` : ', running'}` : 'not run yet'}${j.fails ? ` · ${plural(j.fails, 'failure')}` : ''}`),
      ...flags(j).map(([tone, word]) => toneChip(tone, word))),
      // The last error under its job, in full: a fixed-width list row would cut it.
      j.error ? h('li', { class: 'st-job-error muted' }, `${j.name}: last error ${ago(j.errorAt)}: ${j.error}`) : '']).filter(Boolean)),
    { tone: bad.some((j) => j.overdue || flags(j).some(([t]) => t === 'danger')) ? 'bad' : bad.length ? 'warn' : null, wide: true, key: 'jobs', chart: bad.map((j) => `${j.name}: ${flags(j).map((f) => f[1]).join(', ')}${j.error ? ` (${j.error})` : ''}`).join('; ') });
}

/** The standing checks (#1415): Citadel's recovery promises, checked hourly; each broken one with its check and since when. Report only. */
function checksTile(c, now) {
  const found = c.last?.findings ?? [];
  const named = new Map(c.checks.map((x) => [x.name, x.promise]));
  const sub = c.last ? `${plural(c.checks.length, 'promise')} checked hourly · last ${ago(c.last.ranAt)}${c.last.error ? ` · last run failed: ${c.last.error}` : ''}` : `${plural(c.checks.length, 'promise')} checked hourly, from a few minutes after a start`;
  const list = found.length
    ? found.map((f) => h('li', { title: named.get(f.check) ?? '' }, h('code', {}, f.check), h('span', {}, f.text), h('span', { class: 'muted' }, `since ${ago(f.since)}`)))
    : c.checks.map((x) => h('li', {}, h('code', {}, x.name), h('span', { class: 'muted' }, x.promise)));
  return tile('Standing checks', !c.last ? 'Not run yet' : found.length ? `${plural(found.length, 'broken promise')}` : c.last.error ? 'Last run failed' : 'All kept', sub,
    h('ul', { class: 'st-list st-checks' }, ...list),
    { tone: found.length || c.last?.error ? 'warn' : null, wide: true, key: 'checks', chart: found.map((f) => `${f.check}: ${f.text}`).join('; ') });
}

/** CPU by source (#1332): cores each source averaged over the last hour, day and week with its kernel share, and the week by hour as stacked bars. */
const GROUP_CLASS = ['server', 'turns', 'containers', 'builds', 'godot', 'apps', 'mine', 'others'];
function cpuTile(cpu, now) {
  const { windows: w, hours, groups } = cpu;
  const cores = (x) => (x >= 10 ? x.toFixed(0) : x.toFixed(2));
  const wk = w.week;
  const lookup = (win, key) => win.rows.find((r) => r.key === key);
  const keys = [...new Set([...w.hour.rows, ...w.day.rows, ...w.week.rows].map((r) => r.key))]
    .sort((a, b) => (lookup(wk, b)?.cores ?? 0) - (lookup(wk, a)?.cores ?? 0));
  const cell = (win, key) => { const r = lookup(win, key); return h('td', { class: 'num' }, r ? cores(r.cores) : '–'); };
  const table = h('table', { class: 'st-cpu-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Source'), h('th', { class: 'num' }, 'Hour'), h('th', { class: 'num' }, 'Day'), h('th', { class: 'num' }, 'Week'), h('th', { class: 'num' }, 'Kernel (week)'))),
    h('tbody', {}, ...keys.map((k) => { const r = lookup(wk, k) ?? lookup(w.day, k) ?? lookup(w.hour, k);
      return h('tr', {}, h('td', {}, r.label), cell(w.hour, k), cell(w.day, k), cell(w.week, k), h('td', { class: 'num' }, lookup(wk, k) ? `${Math.round(lookup(wk, k).kernel * 100)}%` : '–')); })),
    h('tfoot', {}, ...(w.hour.host || w.week.host ? [h('tr', {}, h('td', {}, 'Host busy (kernel)'),
      ...[w.hour, w.day, w.week].map((x) => h('td', { class: 'num' }, x.host ? `${cores(x.host.busy)} (${cores(x.host.kernel)})` : '–')), h('td', {}))] : []),
    ...(w.week.host ? [h('tr', {}, h('td', {}, 'Waiting on disk · processes started a second'),
      ...[w.hour, w.day, w.week].map((x) => h('td', { class: 'num' }, x.host ? `${cores(x.host.iowait)} · ${x.host.started.toFixed(1)}` : '–')), h('td', {}))] : [])));
  const from = now - 7 * 86_400_000, W = 400, H = 90;
  const per = hours.map((hr) => ({ at: hr.at, vals: groups.map((g) => (hr.seconds ? (hr.groups[g.key] ?? 0) / hr.seconds : 0)) }));
  const max = Math.max(1, ...per.map((p) => sum(p.vals)));
  const bw = W / (7 * 24);
  const bars = per.flatMap((p) => {
    let y = H;
    return p.vals.map((v, i) => { const hgt = (v / max) * H; y -= hgt;
      return hgt > 0.2 ? svg('rect', { x: ((p.at - from) / (7 * 86_400_000)) * W, y: y.toFixed(1), width: Math.max(0.5, bw - 0.3), height: hgt.toFixed(1), class: `st-cpu-bar g-${GROUP_CLASS[i] ?? 'mine'}` }, svg('title', {}, `${when(p.at)}: ${groups[i].label} ${cores(v)} cores`)) : ''; }).filter(Boolean);
  });
  const chart = h('figure', { class: 'st-chart st-cpu-chart' },
    svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Cores used each hour of the week, stacked by source' }, ...bars),
    h('figcaption', { class: 'st-axis' }, h('span', {}, `up to ${cores(max)} cores`), h('span', {}, 'now')));
  const legend = h('div', { class: 'st-legend st-cpu-legend' }, ...groups.map((g, i) => h('span', { class: `g-${GROUP_CLASS[i] ?? 'mine'}` }, g.label)));
  const top = lookup(wk, keys[0]);
  return tile('CPU by source', top ? `${top.label} ${cores(top.cores)} cores` : 'No reading yet',
    'Cores each source averaged, from each unit\'s own counters read every 5 minutes; other users as one total',
    h('div', { class: 'st-cpu' }, chart, legend, table), { wide: true, key: 'cpu-sources',
      chart: keys.slice(0, 8).map((k) => `${lookup(wk, k)?.label ?? k}: hour ${lookup(w.hour, k) ? cores(lookup(w.hour, k).cores) : '–'}, day ${lookup(w.day, k) ? cores(lookup(w.day, k).cores) : '–'}, week ${lookup(wk, k) ? cores(lookup(wk, k).cores) : '–'}`).join('; ') });
}

function citadelTiles(c, days, now, ships, redraw) {
  const today = days.length - 1;
  const lastStall = c.stalls.last;
  const host = c.host.latest;
  const mem = host ? Math.round((1 - host.mem_avail / host.mem_total) * 100) : null;
  const disk = host ? Math.round((1 - host.disk_free / host.disk_total) * 100) : null;
  const from = now - days.length * 24 * 3_600_000;
  const ci = c.ci;
  const red = ci?.workflows.filter((w) => w.conclusion && w.conclusion !== 'success') ?? [];
  return [
    tile('Memory', mem === null ? 'No reading yet' : `${mem}% used`, host ? `${bytes(host.mem_avail)} free of ${bytes(host.mem_total)} · Citadel's server ${bytes(host.rss)}` : 'Read every 5 minutes',
      hourLine(c.host.series, 1, { from, to: now, label: 'memory used each hour, at its worst' }), { tone: mem !== null && mem >= 90 ? 'warn' : null, key: 'memory', chart: `% used, hourly worst: ${perHour(c.host.series, 1)}` }),
    tile('CPU', host ? `load ${host.load1.toFixed(1)} on ${c.host.cores} cores` : 'No reading yet',
      c.host.peak ? `Peak today ${c.host.peak.load1} at ${pacificClockBare(c.host.peak.at)} · warns when it stays over ${c.host.cpuWarn} for ${c.host.cpuWarnMin} min` : 'Read every 5 minutes',
      hourLine(c.host.series, 3, { from, to: now, label: 'load each hour, at its highest', max: Math.max(c.host.cpuWarn * 1.25, ...c.host.series.map((s) => s[3] ?? 0)), rule: c.host.cpuWarn, tip: (v) => `load ${v} at its highest` }),
      { tone: c.verdict.tiles?.includes('cpu') ? 'warn' : null, key: 'cpu', chart: `load, hourly highest: ${perHour(c.host.series, 3)}` }),
    tile('Uptime', `up ${span(now - c.uptime.bootAt)}`, `Started ${when(c.uptime.bootAt)}: ${c.uptime.reason ?? 'no reason on record yet'}`,
      dayBars(days, c.uptime.restarts, { tip: (i) => plural(c.uptime.restarts[i], 'start'), label: 'starts a day' }),
    { tone: c.uptime.reason?.startsWith('a restart') && now - c.uptime.bootAt < 86_400_000 ? 'warn' : null, key: 'uptime', chart: `starts a day: ${perDay(days, c.uptime.restarts)}` }),
    tile('Stalls', plural(c.stalls.counts[today], 'stall') + ' today',
      lastStall ? `${c.stalls.afterBoot?.[today] ? `${c.stalls.afterBoot[today]} of them just after a start · ` : ''}Longest today ${secs(c.stalls.longest[today])} · the last ${ago(lastStall.at)}${lastStall.seconds !== null ? `, ${lastStall.seconds} s` : ''}${lastStall.cause ? `: ${lastStall.cause}` : ''}${lastStall.work ? ` in ${lastStall.work}` : ''}${lastStall.afterBoot ? ' (just after a start)' : ''}` : 'None this week',
      dayBars(days, c.stalls.counts, { tip: (i) => `${plural(c.stalls.counts[i], 'stall')}${c.stalls.afterBoot?.[i] ? ` (${c.stalls.afterBoot[i]} just after a start)` : ''}${c.stalls.counts[i] ? `, longest ${c.stalls.longest[i]} s` : ''}`, label: 'event-loop stalls a day' }),
      { key: 'stalls', chart: `stalls a day, those just after a start included: ${perDay(days, c.stalls.counts)}; of them just after a start: ${perDay(days, c.stalls.afterBoot ?? days.map(() => 0))}; longest a day (s): ${perDay(days, c.stalls.longest)}` }),
    stormTile(c.storms, days, now),
    ...(c.jobs?.length ? [jobsTile(c.jobs, now)] : []),
    ...(c.checks ? [checksTile(c.checks, now)] : []),
    ...(c.host.cpu ? [cpuTile(c.host.cpu, now)] : []),
    cacheTile(c.host, now, c.verdict),
    tile('Starved', host?.cpu_psi == null ? 'No reading yet' : `CPU ${host.cpu_psi}% · memory ${host.mem_psi ?? 0}%`, 'How long work waited for a core or for memory over the last minute; background passes pause at 50% CPU or 20% memory',
      hourLine(c.host.series.filter((s) => s[4] != null), 4, { from, to: now, label: 'CPU pressure each hour, at its highest', rule: 50, tip: (v) => `CPU pressure ${v}% at its highest` }),
      { tone: host?.cpu_psi != null && (host.cpu_psi >= 50 || (host.mem_psi ?? 0) >= 20) ? 'warn' : null, key: 'pressure', chart: `CPU pressure %, hourly highest: ${perHour(c.host.series, 4)}; memory pressure %: ${perHour(c.host.series, 5)}` }),
    tile('Disk', disk === null ? 'No reading yet' : `${disk}% used`, host ? `${bytes(host.disk_free)} free of ${bytes(host.disk_total)}` : 'Read every 5 minutes',
      hourLine(c.host.series, 2, { from, to: now, label: 'disk used each hour, at its worst' }), { tone: disk !== null && disk >= 90 ? 'warn' : null, key: 'disk', chart: `% used, hourly worst: ${perHour(c.host.series, 2)}` }),
    tile('Ships', plural(c.ships.counts[today], 'ship') + ' today',
      c.ships.last ? `Median today ${secs(c.ships.median[today])} · last ${ago(c.ships.last.at)}${c.ships.last.changes[0] ? `: ${c.ships.last.changes[0]}` : ''}` : 'None this week',
      dayBars(days, c.ships.counts, { tip: (i) => `${plural(c.ships.counts[i], 'ship')}${c.ships.median[i] !== null ? `, median ${secs(c.ships.median[i])} to live` : ''}`, label: 'ships a day' }),
      { key: 'ships', chart: `ships a day: ${perDay(days, c.ships.counts)}` }),
    ...ships.filter((t) => t.key.startsWith('release:')).map((t) => shipChart(t, days, redraw)),
    tile('CI on main', !c.ciVisible ? 'Not yours to see' : !ci ? 'No reading yet' : ci.tone === 'ok' ? 'Green' : ci.runs >= 5 ? `${ci.runs - ci.green} of ${ci.runs} runs failed` : `Red: ${red.map((w) => w.name).join(', ')}`,
      ci ? `${ci.green} of main's newest ${plural(ci.runs, 'run')} passed · read ${ago(ci.at)}` : c.ciVisible ? 'Read from GitHub every few minutes' : 'Only Citadel\'s members see its CI',
      ci ? h('ul', { class: 'st-list' }, ...ci.workflows.map((w) => h('li', {}, w.url ? h('a', { href: w.url, target: '_blank', rel: 'noopener' }, w.name) : w.name,
        toneChip(!w.conclusion ? 'neutral' : w.conclusion === 'success' ? 'ok' : 'danger', w.conclusion ?? w.status ?? 'no run')))) : null,
      { tone: ci && ci.tone !== 'ok' ? ci.tone : null, key: 'ci', chart: ci ? ci.workflows.map((w) => `${w.name} ${w.conclusion ?? w.status ?? 'no run'}`).join(', ') : '' }),
    tile('Services', c.unitsFailed ? 'Couldn\'t read them' : !c.units.length ? 'Not read here' : c.units.some((u) => u.active === 'failed') ? 'One has failed' : 'All running',
      c.unitsFailed ? 'Reading them failed; the next read tries again' : c.units.length ? `${c.units.filter((u) => u.load !== 'not-found').length} installed on this server` : 'This server can\'t read its services',
      h('ul', { class: 'st-list' }, ...c.units.map((u) => h('li', {}, h('code', {}, u.unit),
        toneChip(u.load === 'not-found' ? 'neutral' : u.active === 'failed' ? 'danger' : u.active === 'active' ? 'ok' : 'neutral', u.load === 'not-found' ? 'not installed' : u.sub || u.active)))),
      { tone: c.unitsFailed ? 'warn' : c.units.some((u) => u.active === 'failed') ? 'bad' : null, key: 'services', chart: c.units.map((u) => `${u.unit} ${u.load === 'not-found' ? 'not installed' : u.sub || u.active}`).join(', ') }),
    tile('CI desktop', c.desktops.length ? c.desktops.map((pc) => pcWord(pc)[1]).join(', ') : 'None', 'Its load is on the CI page',
      h('ul', { class: 'st-list' }, ...c.desktops.map((pc) => { const [tone, word] = pcWord(pc); return h('li', {}, h('a', { href: `#/p/${view?.projectId ?? 2}/ci` }, pc.host), toneChip(tone, word)); })),
      { key: 'ci-desktop', chart: c.desktops.map((pc) => `${pc.host} ${pcWord(pc)[1]}`).join(', ') }),
    backupTile(c.backup, now),
    ...c.slots.map(slot),
  ];
}

/**
 * File cache (#1501): how much of the database is in memory and how hard the kernel discards and re-reads file cache. A database
 * mostly out of memory is what stalled the server for two days (#1492); the alert is a 'cache-cold' event in the verdict.
 */
function cacheTile(host, now, verdict) {
  const l = host.latest;
  const from = now - 8 * 24 * 3_600_000;
  const MB = (pages) => (pages == null ? '-' : `${((pages * 4) / 1024).toFixed(1)} MB/s`);
  if (!l || l.db_size == null) return tile('File cache', 'No reading yet', 'Read every 5 minutes', null, { key: 'cache', chart: '' });
  const pct = Math.round(((l.db_cached ?? 0) / l.db_size) * 100);
  const rows = [['Discarded by the kernel', MB(l.kswapd_rate)], ['Re-read, whole box', MB(l.refault_rate)], ['Re-read, the server', MB(l.server_refault_rate)],
    ['Disk read', l.pgpgin_rate == null ? '-' : `${(l.pgpgin_rate / 1024).toFixed(1)} MB/s`], ['Failed huge pages', l.thp_fallback_rate == null ? '-' : `${l.thp_fallback_rate}/s`]];
  return tile('File cache', `${pct}% in memory`, `Database ${bytes(l.db_cached ?? 0)} of ${bytes(l.db_size)}`,
    h('div', {}, hourLine(host.cache, 1, { from, to: now, label: 'share of the database in memory each hour, at its lowest', rule: 25, tip: (v) => `${v}% in memory at its lowest` }),
      h('ul', { class: 'st-list' }, ...rows.map(([k, v]) => h('li', {}, k, h('span', {}, v))))),
    { tone: verdict?.tiles?.includes('cache') ? 'warn' : null, key: 'cache', chart: `${rows.map(([k, v]) => `${k} ${v}`).join(', ')}; % of the database in memory, hourly lowest: ${perHour(host.cache, 1)}; discarded MB/s, hourly highest: ${perHour(host.cache, 2)}; re-read MB/s: ${perHour(host.cache, 3)}` });
}

/**
 * Memory limits (#1280): times a slice or container sat at its memory limit while its work stalled, which burns cores
 * reclaiming. The headline is today's stalled time; the line names the group and its largest unit, now or last.
 */
function stormTile(s, days, now) {
  if (!s) return '';
  const today = days.length - 1;
  const one = (x) => `${x.group}${x.limit ? ` (limit ${bytes(x.limit)})` : ''}: ${secs(x.stalled)} stalled over ${secs(x.seconds)}${x.unit ? `, largest ${bytes(x.unitBytes)}: ${x.unit}` : ''}`;
  const live = s.now[0];
  const stalledToday = s.stalled[today] + sum(s.now.map((x) => x.stalled));
  return tile('Memory limits', live ? 'At its limit now' : stalledToday ? `${secs(stalledToday)} stalled today` : 'None today',
    live ? s.now.map(one).join('; ') : s.last ? `The last ${ago(s.last.at)}: ${one(s.last)}` : 'No slice or container at its limit this week',
    dayBars(days, s.stalled, { tip: (i) => `${plural(s.counts[i], 'storm')}${s.counts[i] ? `, ${secs(s.stalled[i])} stalled` : ''}`, label: 'seconds stalled at a memory limit a day' }),
    { tone: live || stalledToday >= 60 ? 'warn' : null, key: 'memory-limits', chart: `seconds stalled a day: ${perDay(days, s.stalled)}; storms a day: ${perDay(days, s.counts)}` });
}

/** Backup freshness (#1142): the last database backup, the last off-box pull, and each app yes or no. Red when a night is missing. */
function backupTile(b, now) {
  const bad = b.problems.length > 0;
  return tile('Backups', !b.db ? 'No database backup' : `Database ${ago(b.db.at)}`,
    `${b.db ? `${bytes(b.db.size)} · ` : ''}off-box copy ${b.pulledAt === null ? 'not pulled yet' : `pulled ${ago(b.pulledAt)}`}${bad ? ` · ${b.problems.join('; ')}` : ''}`,
    h('ul', { class: 'st-list' }, ...b.apps.map((a) => h('li', {}, a.title, toneChip(a.ok ? 'ok' : a.day ? 'danger' : 'neutral', a.ok ? `yes, ${a.day}` : a.day ? `no, last ${a.day}` : 'no')))),
    { tone: bad ? 'bad' : null, wide: true, key: 'backups', chart: b.apps.map((a) => `${a.title} ${a.ok ? `yes, ${a.day}` : a.day ? `no, last ${a.day}` : 'no'}`).join(', ') });
}

function appTiles(a, days, ships, redraw) {
  const today = days.length - 1;
  const d = a.deploys;
  const kinds = Object.entries(a.errors.kinds).sort((x, y) => y[1] - x[1]);
  const svc = a.service;
  return [
    tile('Service', !svc ? 'Unknown' : !svc.installed ? 'Not installed' : svc.active === 'active' ? 'Running' : svc.active, svc ? svc.unit : 'Its state can\'t be read here',
      null, { tone: svc && svc.installed && svc.active !== 'active' ? 'bad' : null, key: 'service' }),
    tile('Deploys', `${plural(sum(d.counts), 'deploy')} this week`,
      d.last ? `Last ${ago(d.last.at)} by ${d.last.by}, ${d.last.outcome}${d.last.took !== null ? ` in ${secs(d.last.took)}` : ''} · median ${secs(d.median)}, longest ${secs(d.longest)}` : 'Never deployed from Citadel',
      dayBars(days, d.counts, { bad: d.failed, tip: (i) => `${plural(d.counts[i], 'deploy')}${d.failed[i] ? `, ${d.failed[i]} failed` : ''}`, label: 'deploys a day, failed ones in red' }),
      { tone: d.tone !== 'ok' ? d.tone : null, key: 'deploys', chart: `deploys a day: ${perDay(days, d.counts)}; failed: ${perDay(days, d.failed)}` }),
    ...ships.filter((t) => t.key === `app:${a.name}`).map((t) => shipChart(t, days, redraw)),
    tile('Errors', `${a.errors.lastDay} in the last day`, kinds.length ? kinds.map(([k, n]) => `${n} ${k}`).join(' · ') + ' this week' : 'None this week',
      dayBars(days, a.errors.counts, { tip: (i) => plural(a.errors.counts[i], 'error'), label: 'errors a day' }), { tone: a.verdict.reasons.some((r) => r.includes('errors')) ? 'warn' : null, key: 'errors', chart: `errors a day: ${perDay(days, a.errors.counts)}` }),
    tile('Agent turns', `${plural(sum(a.turns.counts), 'turn')} this week`, `${tokens(sum(a.turns.tokens))} tokens · ${a.turns.people.length} ${a.turns.people.length === 1 ? 'person' : 'people'}`,
      dayBars(days, a.turns.counts, { tip: (i) => `${plural(a.turns.counts[i], 'turn')}, ${tokens(a.turns.tokens[i])} tokens`, label: 'agent turns a day' }),
      { key: 'turns', chart: `turns a day: ${perDay(days, a.turns.counts)}` }),
    tile('Who used it', a.turns.people.length ? a.turns.people.slice(0, 2).map((p) => p.name).join(', ') + (a.turns.people.length > 2 ? ` +${a.turns.people.length - 2}` : '') : 'Nobody this week', 'By agent turns this week',
      h('ul', { class: 'st-list' }, ...a.turns.people.slice(0, 6).map((p) => h('li', {}, p.name, h('span', { class: 'muted' }, plural(p.turns, 'turn'))))),
      { key: 'people', chart: a.turns.people.map((p) => `${p.name} ${p.turns}`).join(', ') }),
    tile('Disk', a.disk ? bytes(a.disk.bytes) : 'Not measured yet', a.disk ? `Its data folder, measured ${ago(a.disk.at)}${a.disk.warn_gb ? ` · warns at ${a.disk.warn_gb} GB` : ''}` : 'Measured every 30 minutes',
      null, { tone: a.verdict.reasons.some((r) => r.includes('GB')) ? 'warn' : null, key: 'disk' }),
    a.errors.top.length ? tile('Top errors this week', `${a.errors.top[0].count}× ${a.errors.top[0].kind}`, `last ${ago(a.errors.top[0].last_at)}`,
      h('ul', { class: 'st-list st-errors' }, ...a.errors.top.map((e) => h('li', {}, h('span', { class: 'st-err' }, e.sample || e.kind), h('span', { class: 'muted' }, `${e.count}× ${e.kind}`)))),
      { wide: true, key: 'top-errors', chart: a.errors.top.map((e) => `${e.count}× ${e.kind}: ${e.sample.slice(0, 120)}`).join(' | ') }) : null,
    tile('Last backup', a.backup.day ? (a.backup.ok ? 'Yes' : 'Stale') : 'None yet', a.backup.day ? `Its newest nightly folder is ${a.backup.day}` : 'It has not written backups/<day>/ under its data folder',
      null, { tone: a.backup.day && !a.backup.ok ? 'warn' : null, key: 'backup' }),
  ].filter(Boolean);
}

const LINES_MS = 3_000;

/**
 * The ship lines (#1168; Josh picked it 2026-11-19 from #1093's ideas): who holds each line you can see, for how long and
 * doing what, and who waits behind, read every 3 s while the page is open. "Stop this ship" ends the holder's land.sh
 * cleanly (it leaves the line and main stays as it was): it shows "Stopping…" at once, and a refusal puts the button back
 * with a toast and a Retry. The tile is last and wide, so rows coming and going move nothing above it.
 */
function shipLinePanel(page) {
  let lines = null;
  let failed = null;
  const stopping = new Set(); // "<projectId>:<seq>" sent and not yet gone from the line
  const el = h('section', { class: 'st-tile wide st-lines' });
  const key = (l, r) => `${l.projectId}:${r.seq}`;
  const stop = (l, r) => optimistic({
    apply: () => { stopping.add(key(l, r)); draw(); },
    send: () => api('api/ship-lines/stop', { method: 'POST', body: { projectId: l.projectId, seq: r.seq } }),
    undo: () => { stopping.delete(key(l, r)); draw(); },
    label: `stop ${r.name}'s ship`,
  }).catch(() => {});
  const row = (l, r) => {
    const gone = stopping.has(key(l, r));
    const name = r.ticketId != null ? h('a', { href: `#/t/${r.ticketId}`, 'data-key': `a${key(l, r)}` }, r.name) : h('span', {}, r.name);
    const time = r.holds ? `held ${shortAgo(r.heldSince)}` : `waiting ${shortAgo(r.since)}`;
    const act = !r.holds ? null
      : gone ? h('button', { type: 'button', class: 'cui-btn cui-small', disabled: true }, 'Stopping…')
        : r.noStop ? h('span', { class: 'muted small st-nostop', title: r.noStop }, 'Ends by itself')
          : h('button', { type: 'button', class: 'cui-btn cui-small cui-danger', 'data-key': `b${key(l, r)}`, title: 'End this land.sh run: it leaves the line and lets go of the lock, main stays as it was, and its minion is told who stopped it', onclick: () => stop(l, r) }, 'Stop this ship');
    return hueRow({ hue: r.holds ? 'running' : 'waiting', lead: r.place, meta: h('span', { class: 'st-line-meta' }, h('span', { class: 'muted small' }, time), act) },
      schemeTag(l.scheme), ' ', name, ' ', h('span', { class: 'muted' }, r.text));
  };
  const draw = () => {
    const all = lines ?? [];
    const holders = all.flatMap((l) => l.rows.filter((r) => r.holds).map((r) => `${r.name} holds ${l.scheme}'s`));
    const waiting = all.reduce((n, l) => n + l.rows.filter((r) => !r.holds).length, 0);
    // The redraw every 3 s would drop the keyboard focus: it goes back to the same link or button.
    const focused = el.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
    const value = lines === null ? 'Reading…' : !all.length ? 'Nobody is shipping' : holders.length ? `${holders.join(', ')} line` : `${plural(waiting, 'ship')} waiting`;
    el.replaceChildren(h('h4', {}, 'Ship lines'), h('b', { class: 'st-value' }, value),
      h('div', { class: 'st-sub muted' }, failed ? `Couldn't read the lines: ${failed}` : `${holders.length && waiting ? `${plural(waiting, 'ship')} waiting behind · ` : ''}Read every 3 s. Any member can stop a ship until it moves main.`),
      all.length ? h('div', { class: 'hue-rows st-line-rows' }, ...all.flatMap((l) => l.rows.map((r) => row(l, r)))) : h('div', { class: 'st-line-rows' }));
    if (focused) el.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  };
  const load = async () => {
    if (!page.isConnected && lines !== null) return;
    if (!document.hidden && (el.isConnected || lines === null)) {
      try {
        lines = (await api('api/ship-lines')).lines;
        failed = null;
        const there = new Set(lines.flatMap((l) => l.rows.map((r) => key(l, r))));
        for (const k of stopping) if (!there.has(k)) stopping.delete(k);
      } catch (err) {
        failed = err.message;
      }
      draw();
    }
    setTimeout(load, LINES_MS);
  };
  draw();
  load();
  return el;
}

/** "4 min", "1 h 5 min": how long since `ms`. */
const shortAgo = (ms) => (Date.now() - ms < 60_000 ? `${Math.max(0, Math.round((Date.now() - ms) / 1000))} s` : span(Date.now() - ms));

/** The Status page for scheme `projectId`: Citadel first, then the apps you can see, this scheme's first. */
/**
 * The Releases page's Status tab (#1423; it was its own page): Citadel's server and the picked scheme's apps as a row of chips
 * (every app on All), the one picked showing its tiles. The page's list picks the scheme, so other schemes' apps are a click
 * there. `onData` gets each read, for the list's dots on this tab; `show` points it at a scheme.
 */
export function statusPane(onData = () => {}) {
  let scope = null;
  let picked = 'citadel';
  let data = null;
  const pills = h('nav', { class: 'chips st-apps', 'aria-label': 'Citadel and the apps' });
  const detail = h('div', { class: 'st-detail' }, h('p', { class: 'muted' }, 'Reading status…'));
  const el = h('div', { class: 'st-page' }, pills, detail);
  const lines = shipLinePanel(el);
  const pill = (key, name, v) => h('button', { type: 'button', class: `chip st-app${picked === key ? ' on' : ''}`, 'aria-pressed': String(picked === key), 'data-key': key, title: v.reasons[0] ?? WORD[v.tone],
    onclick: () => { picked = key; draw(); } },
  h('span', { class: `dot ${DOT[v.tone]}` }), name);
  const draw = () => {
    const { citadel, apps, days, now, shipTimes = [] } = data;
    const mine = apps.filter((a) => scope === 'all' || a.scheme === scope).sort((x, y) => x.title.localeCompare(y.title));
    const app = mine.find((a) => `app:${a.name}` === picked);
    if (!app) picked = 'citadel';
    pills.replaceChildren(pill('citadel', 'Citadel', citadel.verdict), ...mine.map((a) => pill(`app:${a.name}`, a.title, a.verdict)),
      mine.length ? '' : h('span', { class: 'muted small st-none' }, 'No app in this scheme.'));
    const v = app ? app.verdict : citadel.verdict;
    ix = { target: app ? `app:${app.name}` : 'citadel', looks: (app ?? citadel).looks ?? {}, verdict: v, ask: !!app || citadel.canInvestigate !== false };
    // Each reason names the minion on its tile (#1273), the way the CI page names a red's fix minion.
    const why = v.reasons.flatMap((r, i) => {
      const m = ix.looks[v.tiles?.[i]]?.minion;
      return [i ? ' · ' : '', r, ...(m ? [' (', h('a', { href: `#/p/${m.project}/t/${m.number}`, title: m.title }, `#${m.number}`), ')'] : [])];
    });
    detail.replaceChildren(
      h('div', { class: 'ci-head' }, h('h3', {}, app ? app.title : 'Citadel'), toneChip(CHIP[v.tone], WORD[v.tone]),
        app ? h('a', { href: `/apps/${app.name}/`, target: '_blank', rel: 'noopener' }, 'Open it') : '',
        h('span', { class: 'muted small' }, `read ${ago(now)}`)),
      h('p', { class: 'st-why' }, ...(v.reasons.length ? why : [app ? 'Running, deployed and quiet.' : 'Up, no failed service, no long stalls, memory, disk and CI fine.'])),
      h('div', { class: 'st-tiles' }, ...(app ? appTiles(app, days, shipTimes, draw) : [...citadelTiles(citadel, days, now, shipTimes, draw), lines])));
  };
  let timer = null, busy = false, tried = false;
  const load = async () => {
    timer = null;
    if (tried && !el.isConnected) return; // read again once the tab shows again; the first read may start before the page is attached
    tried = true;
    busy = true;
    try {
      data = await api('api/status');
      if (data) { draw(); onData(data); }
      else detail.replaceChildren(h('p', { class: 'muted' }, 'This server keeps no status.'));
    } catch (err) {
      if (!data) detail.replaceChildren(h('p', { class: 'error' }, `Couldn't read status: ${err.message}`));
    }
    busy = false;
    timer = setTimeout(() => whenShown(load), REFRESH_MS);
  };
  /** Show it for `to` (a scheme's id or 'all'), once it's on the page: the first call reads, and the reads go on while it shows. */
  el.show = (to) => {
    if (to !== scope) { scope = to; picked = 'citadel'; if (data) draw(); }
    if (!timer && !busy) load();
  };
  return el;
}

/** The worst verdict on the page: Citadel's or any of your apps'. */
export function worstOf(data) {
  return [data.citadel.verdict, ...data.apps.map((a) => a.verdict)].reduce((w, v) => (RANK[v.tone] > RANK[w.tone] ? v : w), { tone: 'ok' });
}

// The chips (the shelf's and the top bar's) share one read a minute, like CI's.
const chips = new Set();
let chipTimer = null, chipBusy = false; // a chip made while a read runs or is due takes its answer: no second read
let chipRead = null;
const paintChip = (c, { title, tone }) => {
  c.title = title;
  c.setAttribute('aria-label', title);
  c.querySelector('.dot').className = `dot ${DOT[tone]}`;
};
async function readChips() {
  chipTimer = null;
  for (const c of chips) if (!c.isConnected && c.dataset.placed) chips.delete(c);
  if (!chips.size) return;
  chipBusy = true;
  try {
    const data = await api('api/status');
    if (data) {
      const bad = [['Citadel', data.citadel.verdict], ...data.apps.map((a) => [a.title, a.verdict])].filter(([, v]) => v.tone !== 'ok');
      chipRead = { tone: worstOf(data).tone, title: bad.length ? `Status: ${bad.map(([n, v]) => `${n} ${WORD[v.tone].toLowerCase()}`).join('; ')}` : 'Status: Citadel and your apps are OK' };
      for (const c of chips) paintChip(c, chipRead);
    }
  } catch {
    // The last colour stays: the next minute asks again.
  }
  chipBusy = false;
  chipTimer = setTimeout(() => whenShown(readChips), 60_000);
}

/** The Status chip: a dot and "Status", opening the page for the scheme on screen (or `projectId`). */
export function statusChip(projectId = null) {
  const c = h('a', { class: 'ci-chip status-chip', href: projectId ? `#/p/${projectId}/status` : '#/',
    onclick: () => { opening(); c.href = scopedPageHash('status', projectId ?? view?.projectId, localStorage.getItem(LAST_SCHEME) ?? 2); } },
  h('span', { class: 'dot asleep' }), h('span', { class: 'label' }, 'Status'));
  c.dataset.placed = '1';
  chips.add(c);
  if (chipRead) paintChip(c, chipRead);
  if (!chipTimer && !chipBusy) chipTimer = setTimeout(readChips, 0);
  return c;
}
