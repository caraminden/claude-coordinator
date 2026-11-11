// The CI desktop panel on the Machines page (#534): each PC that hosts CI runners, as src/ci-load.ts sees it: a
// verdict, what it is doing now, the last 24 hours, and each pool of runners with its queue. It reads
// /api/ci-desktop when shown and every minute while it stays on screen; it changes nothing.
import { ago, api, h } from './base.js';

const REFRESH_MS = 60_000;
const GB = 1024 ** 3;
// Hyper-V lists WSL's own VM under an id, not a name.
const VM_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DOT = { fine: 'ready', more: 'fix', full: 'fix', over: 'down', crash: 'down', none: 'asleep' };
const mins = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
/** An element with its style set through the CSSOM: the page's CSP refuses style attributes. */
const styled = (el, props) => Object.assign(el.style, props) && el;
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** A bar filled to `pct`, with its number and what it is beside it. */
function meter(label, pct, detail) {
  return h('div', { class: 'ci-meter' },
    h('span', { class: 'ci-meter-label' }, label),
    h('span', { class: 'ci-meter-bar', role: 'img', 'aria-label': `${label} ${Math.round(pct)}%` }, styled(h('span'), { width: `${Math.min(100, Math.max(0, pct))}%` })),
    h('span', { class: 'ci-meter-value' }, `${Math.round(pct)}%`),
    h('span', { class: 'ci-meter-detail muted' }, detail));
}

/** One small chart over the 24 hours: `lines` are { key, label, values, step }, sharing one y axis up to `max`. */
function chart(pc, title, lines, max, unit) {
  const W = 600, H = 96, L = 30, B = 16, T = 4;
  const n = pc.series.length;
  const x = (i) => L + (i / (n - 1)) * (W - L - 2);
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const path = (values, step) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += pen ? (step ? `H${x(i).toFixed(1)}V${y(v).toFixed(1)}` : `L${x(i).toFixed(1)} ${y(v).toFixed(1)}`) : `M${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const t0 = pc.series[0][0], t1 = pc.series[n - 1][0];
  const xt = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - 2);
  const hours = [];
  // A label too near the right edge would run off the chart.
  for (let t = Math.ceil(t0 / 21_600_000) * 21_600_000; t <= t1 - 3_600_000; t += 21_600_000) hours.push(t);
  const el = h('div', { class: 'ci-chart' });
  // Numbers only go into this markup: every label is set as text below.
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="none">
    ${[0, max / 2, max].map((v) => `<line class="grid" x1="${L}" x2="${W - 2}" y1="${y(v)}" y2="${y(v)}"/>`).join('')}
    ${pc.restarts.filter((t) => t >= t0).map((t) => `<line class="restart" x1="${xt(t)}" x2="${xt(t)}" y1="${T}" y2="${H - B}"/>`).join('')}
    ${lines.map((l) => `<path class="line ${l.key}" d="${path(l.values, l.step)}"/>`).join('')}
    <line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
  </svg>`;
  const svg = el.firstElementChild;
  svg.setAttribute('aria-label', `${title}, last 24 hours`);
  const axis = h('div', { class: 'ci-axis muted', 'aria-hidden': 'true' },
    ...[max, max / 2, 0].map((v, i) => styled(h('span', { class: 'y' }, `${v}${i === 0 ? unit : ''}`), { top: `${(y(v) / H) * 100}%` })),
    ...hours.map((t) => styled(h('span', { class: 'x' }, clock(t)), { left: `${(xt(t) / W) * 100}%` })));
  const tip = h('div', { class: 'ci-tip', hidden: true });
  const cross = svg.querySelector('.cross');
  const show = (ev) => {
    const box = svg.getBoundingClientRect();
    const i = Math.min(n - 1, Math.max(0, Math.round((((ev.clientX - box.left) / box.width) * W - L) / (W - L - 2) * (n - 1))));
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.replaceChildren(h('strong', {}, clock(pc.series[i][0])), ...lines.map((l) => h('span', {}, h('i', { class: `key ${l.key}` }), `${l.label} ${l.values[i] === null ? '–' : `${l.values[i]}${unit}`}`)));
    tip.style.left = `${Math.min(box.width - 150, Math.max(0, (x(i) / W) * box.width + 8))}px`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', hide);
  el.append(axis, tip);
  return h('figure', { class: 'ci-figure' },
    h('figcaption', {}, h('span', { class: 'ci-title' }, title),
      lines.length > 1 ? h('span', { class: 'ci-legend' }, ...lines.map((l) => h('span', {}, h('i', { class: `key ${l.key}` }), l.label))) : '',
      pc.restarts.some((t) => t >= t0) ? h('span', { class: 'ci-legend' }, h('span', {}, h('i', { class: 'key restart' }), 'hard restart')) : ''),
    el);
}

function pools(pc) {
  if (!pc.pools.length) return h('p', { class: 'muted small' }, 'No CI jobs read from GitHub for this PC yet: CI health reads them every 5 minutes.');
  const cell = (text, cls = '') => h('td', { class: cls }, text);
  return h('div', { class: 'ci-pools-wrap' }, h('table', { class: 'ci-pools' },
    h('thead', {}, h('tr', {}, ...['Pool', 'Busy', 'Waiting', 'Jobs, 24 h', 'Typical wait', 'Worst wait', 'CPU, 15 min'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
    h('tbody', {}, ...pc.pools.map((p) => h('tr', {},
      h('td', {}, h('span', { class: 'ci-pool-name' }, p.title), h('span', { class: 'muted ci-pool-labels' }, p.labels || 'no jobs yet')),
      cell(`${p.busy} of ${p.runners.length}`, 'num'),
      cell(p.waiting ? `${p.waiting}, oldest ${mins(p.oldest_ms)}` : '0', `num${p.waiting && p.busy >= p.runners.length ? ' ci-stuck' : ''}`),
      cell(String(p.jobs), 'num'), cell(p.jobs ? mins(p.wait_p50_ms) : '–', 'num'), cell(p.jobs ? mins(p.wait_max_ms) : '–', 'num'),
      cell(p.cpu === null ? '–' : `${Math.round(p.cpu)}%`, 'num'))))));
}

function pcCard(pc) {
  const now = pc.now;
  const shares = now ? [`CI runners ${Math.round(now.runners)}%`, now.wsl === null ? '' : `WSL ${Math.round(now.wsl)}%`, ...Object.entries(now.vms).map(([name, pct]) => `${VM_ID.test(name) ? 'WSL VM' : name} ${Math.round(pct)}%`)].filter(Boolean).join(' · ') : '';
  const facts = now ? [
    now.idle_sec === null ? 'can\'t tell if someone is at the PC' : now.idle_sec < 300 ? 'someone is at the PC' : 'nobody at the PC',
    now.queue === null ? '' : `${now.queue} thread${now.queue === 1 ? '' : 's'} waiting for a core`,
    now.temp === null ? '' : `${Math.round(now.temp)} °C`,
    now.disk_free === null ? '' : `${Math.round(now.disk_free / GB)} GB free on disk`,
    `sampled ${ago(now.at)}`,
  ].filter(Boolean).join(' · ') : '';
  const cpu = pc.series.map((s) => s[1]);
  const jobsMax = Math.max(4, ...pc.series.map((s) => Math.max(s[3], s[4])));
  return h('div', { class: 'card ci-desktop' },
    h('div', { class: 'ci-verdict' }, h('span', { class: `dot ${DOT[pc.verdict.kind] ?? 'asleep'}` }), h('span', {}, h('strong', {}, pc.host), ` ${pc.verdict.text}`)),
    now ? h('div', { class: 'ci-now' },
      meter('CPU', now.cpu, `${now.cores} threads${shares ? ` · ${shares}` : ''}`),
      meter('Memory', (1 - now.mem_free / now.mem_total) * 100, `${Math.round((now.mem_total - now.mem_free) / GB)} of ${Math.round(now.mem_total / GB)} GB`),
      h('p', { class: 'muted small ci-facts' }, facts)) : '',
    cpu.some((v) => v !== null) ? chart(pc, 'CPU', [{ key: 'cpu', label: 'average', values: cpu }, { key: 'peak', label: 'peak', values: pc.series.map((s) => s[2]) }], 100, '%') : '',
    pc.pools.length ? chart(pc, 'CI jobs', [{ key: 'running', label: 'running', values: pc.series.map((s) => s[3]), step: true }, { key: 'waiting', label: 'waiting', values: pc.series.map((s) => s[4]), step: true }], jobsMax % 2 ? jobsMax + 1 : jobsMax, '') : '',
    pools(pc));
}

/** What the overview warns of (Cara, 2026-11-11): CI overloading the PC, a crash under load, or a PC that stopped reporting in the last day. */
function trouble(pc) {
  if (pc.verdict.kind === 'over') return 'CI is overloading its desktop';
  if (pc.verdict.kind === 'crash') return 'CI desktop crashed under load';
  if (pc.verdict.kind === 'none' && pc.series.some((s) => s[1] !== null)) return 'CI desktop is offline';
  return '';
}

/** The overview's warning lines under the usage bar, one per PC in trouble and none otherwise; each opens the Machines page. */
export function ciWarning(href) {
  const el = h('div', { class: 'ci-warnings' });
  const load = async () => {
    if (el.dataset.loaded && !el.isConnected) return;
    el.dataset.loaded = '1';
    try {
      const { pcs } = await api('api/ci-desktop');
      el.replaceChildren(...pcs.filter(trouble).map((pc) => h('div', { class: 'machine-warning' },
        h('span', { class: `dot ${pc.verdict.kind === 'none' ? 'fix' : 'down'}` }),
        h('a', { href, title: `${pc.host}: ${pc.verdict.text}` }, trouble(pc)))));
    } catch {
      // The last answer stays: the next minute asks again.
    }
    setTimeout(load, REFRESH_MS);
  };
  load();
  return el;
}

/** The panel: empty (and no heading) until a PC with a runner agent is there for this person to see. */
export function ciDesktopPanel() {
  const el = h('div', { class: 'ci-desktops' });
  const load = async () => {
    // Off the page: stop asking.
    if (el.dataset.loaded && !el.isConnected) return;
    el.dataset.loaded = '1';
    try {
      const { pcs } = await api('api/ci-desktop');
      el.replaceChildren(...(pcs.length ? [h('h4', { class: 'machine-group' }, 'CI desktop load'), ...pcs.map(pcCard)] : []));
    } catch {
      // The last view stays: the next minute asks again.
    }
    setTimeout(load, REFRESH_MS);
  };
  load();
  return el;
}
