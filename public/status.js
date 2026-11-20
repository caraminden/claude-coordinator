// The Status page (#1123; Josh, 2026-11-19: app vitals "alongside CI in a new "Status" page", the Citadel page "Combine
// with A4", and layout "B · List and detail, like the CI page"): Citadel and each app you can see on the left, its
// tiles on the right, each with its last 8 days. It reads /api/status (src/status-page.ts) every 30 s and changes
// nothing. Every tile keeps its size whatever its numbers say, so a re-read moves nothing. The Status chip beside
// CI's opens it, its dot the worst verdict it shows.
import { ago, api, h, view } from './base.js';
import { toneChip } from './look.js';
import { pcWord } from './ci-desktop.js';
import { LAST_SCHEME } from './sidebar.js';

const REFRESH_MS = 30_000;
const LA = { timeZone: 'America/Los_Angeles' };
const when = (t) => new Date(t).toLocaleString('en-US', { ...LA, timeZoneName: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayLabel = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const DOT = { ok: 'ready', warn: 'fix', bad: 'down' };
const CHIP = { ok: 'ok', warn: 'warn', bad: 'danger' };
const WORD = { ok: 'OK', warn: 'Worth a look', bad: 'Needs a person' };
const RANK = { ok: 0, warn: 1, bad: 2 };
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

/** A week of hourly percentages as a line, 0 to 100, with a hover title per hour. */
export function hourLine(series, idx, { from, to, label }) {
  const W = 160, H = 36;
  const x = (t) => ((t - from) / (to - from)) * W;
  const y = (v) => H - (v / 100) * H;
  const pts = series.map((s) => `${x(s[0]).toFixed(1)},${y(s[idx]).toFixed(1)}`);
  const step = Math.max(1, W / ((to - from) / 3_600_000));
  return h('figure', { class: 'st-chart' },
    svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label },
      svg('line', { x1: 0, x2: W, y1: y(90), y2: y(90), class: 'st-rule' }),
      pts.length > 1 ? svg('polyline', { points: pts.join(' '), class: 'st-line' }) : '',
      ...series.map((s) => svg('rect', { x: x(s[0]) - step / 2, y: 0, width: step, height: H, class: 'st-hit' }, svg('title', {}, `${when(s[0])}: ${s[idx]}% used at worst`)))),
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
  const pick = shipPick.has(t.key) ? shipPick.get(t.key) : days[worst];
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
    plot, buttons, pick ? shipWaterfall(t, pick) : h('p', { class: 'muted small st-pick' }, 'Pick a day to see its ships step by step.'));
}

/** That day's ships, slowest first (at most 8), each a bar of its steps; the rest of its time, the steps don't name, is grey. */
function shipWaterfall(t, day) {
  const todays = t.ships.filter((s) => new Date(s.at).toLocaleDateString('en-CA', LA) === day).sort((a, b) => b.took - a.took);
  const shown = todays.slice(0, 8);
  const order = [...new Set(todays.flatMap((s) => Object.keys(s.stages)))].sort((a, b) => (STAGE_ORDER.indexOf(a) + 1 || 99) - (STAGE_ORDER.indexOf(b) + 1 || 99));
  const step = (name) => Math.min(order.indexOf(name) + 1, 6);
  const top = Math.max(1, ...shown.map((s) => s.took));
  const row = (s) => {
    const named = sum(Object.values(s.stages));
    const segs = [...order.filter((k) => s.stages[k]).map((k) => [k, s.stages[k], step(k)]), ...(s.took - named > 1 ? [['other', s.took - named, 0]] : [])];
    const bar = h('div', { class: 'st-wbar', role: 'img', 'aria-label': `${secs(s.took)}: ${segs.map(([k, v]) => `${k} ${secs(v)}`).join(', ')}` },
      ...segs.map(([k, v, i]) => { const el = h('i', { class: 'st-seg', 'data-step': i, title: `${k}: ${secs(v)}` }); el.style.setProperty('width', `${(v / top) * 100}%`); return el; }));
    return h('li', { class: s.took > SLOW_S ? 'slow' : '' }, h('span', { class: 'muted' }, new Date(s.at).toLocaleTimeString('en-US', { ...LA, hour: 'numeric', minute: '2-digit' })), bar, h('b', {}, secs(s.took)));
  };
  return h('div', { class: 'st-water' },
    h('div', { class: 'st-water-head' }, h('b', {}, dayLabel(day)), h('span', { class: 'muted' }, todays.length ? `${plural(todays.length, 'ship')}, slowest first` : 'No ships that day')),
    todays.length ? h('div', { class: 'st-legend' }, ...order.map((k) => h('span', { class: 'st-key', 'data-step': step(k) }, k)), h('span', { class: 'st-key', 'data-step': 0 }, 'other')) : '',
    h('ul', { class: 'st-wlist' }, ...shown.map(row)),
    todays.length > shown.length ? h('p', { class: 'muted small' }, `and ${todays.length - shown.length} quicker`) : '');
}

/** A tile: its name, the headline, one line under it, then a chart or a list. Fixed height, so a re-read moves nothing. */
const tile = (name, value, sub, body = null, { tone = null, wide = false } = {}) => h('section', { class: `st-tile${wide ? ' wide' : ''}`, 'data-tone': tone },
  h('h4', {}, name), h('b', { class: 'st-value' }, value), h('div', { class: 'st-sub muted' }, sub), body ?? h('div', { class: 'st-chart st-empty' }));
const slot = (s) => h('section', { class: 'st-tile st-slot', 'data-slot': s.key }, h('h4', {}, s.title), h('div', { class: 'st-sub muted' }, s.note));

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
    tile('Uptime', `up ${span(now - c.uptime.bootAt)}`, `Started ${when(c.uptime.bootAt)}: ${c.uptime.reason ?? 'no reason on record yet'}`,
      dayBars(days, c.uptime.restarts, { tip: (i) => plural(c.uptime.restarts[i], 'start'), label: 'starts a day' }),
    { tone: c.uptime.reason?.startsWith('a restart') && now - c.uptime.bootAt < 86_400_000 ? 'warn' : null }),
    tile('Stalls', plural(c.stalls.counts[today], 'stall') + ' today',
      lastStall ? `Longest today ${secs(c.stalls.longest[today])} · the last ${ago(lastStall.at)}${lastStall.seconds !== null ? `, ${lastStall.seconds} s` : ''}` : 'None this week',
      dayBars(days, c.stalls.counts, { tip: (i) => `${plural(c.stalls.counts[i], 'stall')}${c.stalls.counts[i] ? `, longest ${c.stalls.longest[i]} s` : ''}`, label: 'event-loop stalls a day' })),
    tile('Memory', mem === null ? 'No reading yet' : `${mem}% used`, host ? `${bytes(host.mem_avail)} free of ${bytes(host.mem_total)} · Citadel's server ${bytes(host.rss)}` : 'Read every 5 minutes',
      hourLine(c.host.series, 1, { from, to: now, label: 'memory used each hour, at its worst' }), { tone: mem !== null && mem >= 90 ? 'warn' : null }),
    tile('Disk', disk === null ? 'No reading yet' : `${disk}% used`, host ? `${bytes(host.disk_free)} free of ${bytes(host.disk_total)}` : 'Read every 5 minutes',
      hourLine(c.host.series, 2, { from, to: now, label: 'disk used each hour, at its worst' }), { tone: disk !== null && disk >= 90 ? 'warn' : null }),
    tile('Ships', plural(c.ships.counts[today], 'ship') + ' today',
      c.ships.last ? `Median today ${secs(c.ships.median[today])} · last ${ago(c.ships.last.at)}${c.ships.last.changes[0] ? `: ${c.ships.last.changes[0]}` : ''}` : 'None this week',
      dayBars(days, c.ships.counts, { tip: (i) => `${plural(c.ships.counts[i], 'ship')}${c.ships.median[i] !== null ? `, median ${secs(c.ships.median[i])} to live` : ''}`, label: 'ships a day' })),
    ...ships.filter((t) => t.key.startsWith('release:')).map((t) => shipChart(t, days, redraw)),
    tile('CI on main', !c.ciVisible ? 'Not yours to see' : !ci ? 'No reading yet' : red.length ? `Red: ${red.map((w) => w.name).join(', ')}` : 'Green',
      ci ? `${ci.green} of ${plural(ci.runs, 'run')} passed in the last day · read ${ago(ci.at)}` : c.ciVisible ? 'Read from GitHub every few minutes' : 'Only Citadel\'s members see its CI',
      ci ? h('ul', { class: 'st-list' }, ...ci.workflows.map((w) => h('li', {}, w.url ? h('a', { href: w.url, target: '_blank', rel: 'noopener' }, w.name) : w.name,
        toneChip(!w.conclusion ? 'neutral' : w.conclusion === 'success' ? 'ok' : 'danger', w.conclusion ?? w.status ?? 'no run')))) : null,
      { tone: red.length ? 'warn' : null }),
    tile('Services', c.unitsFailed ? 'Couldn\'t read them' : !c.units.length ? 'Not read here' : c.units.some((u) => u.active === 'failed') ? 'One has failed' : 'All running',
      c.unitsFailed ? 'Reading them failed; the next read tries again' : c.units.length ? `${c.units.filter((u) => u.load !== 'not-found').length} installed on this server` : 'This server can\'t read its services',
      h('ul', { class: 'st-list' }, ...c.units.map((u) => h('li', {}, h('code', {}, u.unit),
        toneChip(u.load === 'not-found' ? 'neutral' : u.active === 'failed' ? 'danger' : u.active === 'active' ? 'ok' : 'neutral', u.load === 'not-found' ? 'not installed' : u.sub || u.active)))),
      { tone: c.unitsFailed ? 'warn' : c.units.some((u) => u.active === 'failed') ? 'bad' : null }),
    tile('CI desktop', c.desktops.length ? c.desktops.map((pc) => pcWord(pc)[1]).join(', ') : 'None', 'Its load is on the CI page',
      h('ul', { class: 'st-list' }, ...c.desktops.map((pc) => { const [tone, word] = pcWord(pc); return h('li', {}, h('a', { href: `#/p/${view?.projectId ?? 2}/ci` }, pc.host), toneChip(tone, word)); }))),
    ...c.slots.map(slot),
  ];
}

function appTiles(a, days, ships, redraw) {
  const today = days.length - 1;
  const d = a.deploys;
  const kinds = Object.entries(a.errors.kinds).sort((x, y) => y[1] - x[1]);
  const svc = a.service;
  return [
    tile('Service', !svc ? 'Unknown' : !svc.installed ? 'Not installed' : svc.active === 'active' ? 'Running' : svc.active, svc ? svc.unit : 'Its state can\'t be read here',
      null, { tone: svc && svc.installed && svc.active !== 'active' ? 'bad' : null }),
    tile('Deploys', `${plural(sum(d.counts), 'deploy')} this week`,
      d.last ? `Last ${ago(d.last.at)} by ${d.last.by}, ${d.last.outcome}${d.last.took !== null ? ` in ${secs(d.last.took)}` : ''} · median ${secs(d.median)}, longest ${secs(d.longest)}` : 'Never deployed from Citadel',
      dayBars(days, d.counts, { bad: d.failed, tip: (i) => `${plural(d.counts[i], 'deploy')}${d.failed[i] ? `, ${d.failed[i]} failed` : ''}`, label: 'deploys a day, failed ones in red' }),
      { tone: d.last?.outcome === 'failed' ? 'bad' : sum(d.failed) ? 'warn' : null }),
    ...ships.filter((t) => t.key === `app:${a.name}`).map((t) => shipChart(t, days, redraw)),
    tile('Errors', `${a.errors.lastDay} in the last day`, kinds.length ? kinds.map(([k, n]) => `${n} ${k}`).join(' · ') + ' this week' : 'None this week',
      dayBars(days, a.errors.counts, { tip: (i) => plural(a.errors.counts[i], 'error'), label: 'errors a day' }), { tone: a.verdict.reasons.some((r) => r.includes('errors')) ? 'warn' : null }),
    tile('Agent turns', `${plural(sum(a.turns.counts), 'turn')} this week`, `${tokens(sum(a.turns.tokens))} tokens · ${a.turns.people.length} ${a.turns.people.length === 1 ? 'person' : 'people'}`,
      dayBars(days, a.turns.counts, { tip: (i) => `${plural(a.turns.counts[i], 'turn')}, ${tokens(a.turns.tokens[i])} tokens`, label: 'agent turns a day' })),
    tile('Who used it', a.turns.people.length ? a.turns.people.slice(0, 2).map((p) => p.name).join(', ') + (a.turns.people.length > 2 ? ` +${a.turns.people.length - 2}` : '') : 'Nobody this week', 'By agent turns this week',
      h('ul', { class: 'st-list' }, ...a.turns.people.slice(0, 6).map((p) => h('li', {}, p.name, h('span', { class: 'muted' }, plural(p.turns, 'turn')))))),
    tile('Disk', a.disk ? bytes(a.disk.bytes) : 'Not measured yet', a.disk ? `Its data folder, measured ${ago(a.disk.at)}${a.disk.warn_gb ? ` · warns at ${a.disk.warn_gb} GB` : ''}` : 'Measured every 30 minutes',
      null, { tone: a.verdict.reasons.some((r) => r.includes('GB')) ? 'warn' : null }),
    a.errors.top.length ? tile('Top errors this week', `${a.errors.top[0].count}× ${a.errors.top[0].kind}`, `last ${ago(a.errors.top[0].last_at)}`,
      h('ul', { class: 'st-list st-errors' }, ...a.errors.top.map((e) => h('li', {}, h('span', { class: 'st-err' }, e.sample || e.kind), h('span', { class: 'muted' }, `${e.count}× ${e.kind}`)))), { wide: true }) : null,
    slot({ key: 'backup', title: 'Last backup', note: 'When it last ran and whether it worked: coming in Build 5.' }),
  ].filter(Boolean);
}

/** The Status page for scheme `projectId`: Citadel first, then the apps you can see, this scheme's first. */
export function statusPage(projectId) {
  let picked = 'citadel';
  let data = null;
  const list = h('nav', { class: 'ci-list st-list-nav', 'aria-label': 'Citadel and your apps' });
  const detail = h('div', { class: 'ci-detail' }, h('p', { class: 'muted' }, 'Reading status…'));
  const el = h('section', { class: 'ci-page st-page' }, h('div', { class: 'ci-split' }, list, detail));
  const row = (key, name, v, sub) => h('button', { type: 'button', class: `ci-li${picked === key ? ' on' : ''}`, 'aria-current': picked === key ? 'true' : null, 'data-key': key,
    onclick: () => { picked = key; draw(); } },
  h('span', { class: `dot ${DOT[v.tone]}` }), h('span', { class: 'ci-li-name' }, name), h('span', { class: 'ci-li-state muted' }, sub ?? (v.reasons[0] ?? WORD[v.tone])));
  const draw = () => {
    const { citadel, apps, days, now, shipTimes = [] } = data;
    const sorted = [...apps].sort((x, y) => (y.scheme === projectId) - (x.scheme === projectId) || x.title.localeCompare(y.title));
    const app = sorted.find((a) => `app:${a.name}` === picked);
    if (!app) picked = 'citadel';
    list.replaceChildren(row('citadel', 'Citadel', citadel.verdict),
      h('div', { class: 'ci-list-head' }, 'Your apps'),
      ...(sorted.length ? sorted.map((a) => row(`app:${a.name}`, a.title, a.verdict)) : [h('p', { class: 'muted small st-none' }, 'No app in a scheme you\'re in.')]));
    const v = app ? app.verdict : citadel.verdict;
    detail.replaceChildren(
      h('div', { class: 'ci-head' }, h('h3', {}, app ? app.title : 'Citadel'), toneChip(CHIP[v.tone], WORD[v.tone]),
        app ? h('a', { href: `/apps/${app.name}/`, target: '_blank', rel: 'noopener' }, 'Open it') : '',
        h('span', { class: 'muted small' }, `read ${ago(now)}`)),
      h('p', { class: 'st-why' }, v.reasons.length ? v.reasons.join(' · ') : app ? 'Running, deployed and quiet.' : 'Up, no failed service, no long stalls, memory, disk and CI fine.'),
      h('div', { class: 'st-tiles' }, ...(app ? appTiles(app, days, shipTimes, draw) : citadelTiles(citadel, days, now, shipTimes, draw))));
  };
  let tried = false;
  const load = async () => {
    if (tried && !el.isConnected) return;
    tried = true;
    try {
      data = await api('api/status');
      if (data) draw();
      else detail.replaceChildren(h('p', { class: 'muted' }, 'This server keeps no status.'));
    } catch (err) {
      if (!data) detail.replaceChildren(h('p', { class: 'error' }, `Couldn't read status: ${err.message}`));
    }
    setTimeout(load, REFRESH_MS);
  };
  load();
  return el;
}

/** The worst verdict on the page: Citadel's or any of your apps'. */
export function worstOf(data) {
  return [data.citadel.verdict, ...data.apps.map((a) => a.verdict)].reduce((w, v) => (RANK[v.tone] > RANK[w.tone] ? v : w), { tone: 'ok' });
}

// The chips (the shelf's and the top bar's) share one read a minute, like CI's.
const chips = new Set();
let chipTimer = null;
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
  chipTimer = setTimeout(readChips, 60_000);
}

/** The Status chip: a dot and "Status", opening the page for the scheme on screen (or `projectId`). */
export function statusChip(projectId = null) {
  const c = h('a', { class: 'ci-chip status-chip', href: projectId ? `#/p/${projectId}/status` : '#/',
    onclick: () => { const id = projectId ?? view?.projectId ?? localStorage.getItem(LAST_SCHEME) ?? 2; c.href = `#/p/${id}/status`; } },
  h('span', { class: 'dot asleep' }), h('span', { class: 'label' }, 'Status'));
  c.dataset.placed = '1';
  chips.add(c);
  if (chipRead) paintChip(c, chipRead);
  if (chipTimer) clearTimeout(chipTimer);
  chipTimer = setTimeout(readChips, 0);
  return c;
}
