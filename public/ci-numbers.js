// The CI page's Numbers tab (#1369, Cara 2026-11-20: "Keep CI numbers per commit and flag a step up"; on #1369's card,
// "New tab on the CI page"): a row per series a scheme's CI sends (kit/skills/ci-store/ci-numbers.sh), with its chart
// over its runs. Each point links its commit; a step up that held (src/ci-numbers.ts) is marked where it started.
/** @import { CiNumbersView, CiNumberSeries, CiNumberStepRow, CiNumbersRules, ReadFailed } from './types.js' */
/** @typedef {CiNumberSeries['points'][number]} Point */
import { api, h, pacificDate, pacificStamp } from './base.js';
import { emptyCard, hueRow, showFirst, statTiles, toneChip } from './look.js';
import { settingsRow } from './settings.js';

/**
 * @param {number} id
 * @returns {Promise<CiNumbersView>}
 */
export const readNumbers = (id) => api(`api/projects/${id}/ci-numbers`);

/**
 * @param {number} v
 * @param {string} [unit]
 */
const fmt = (v, unit) => `${+Number(v).toPrecision(4)}${unit ? ` ${unit}` : ''}`;
/** @param {{ baseline: number; level: number }} s */
const pct = (s) => (s.baseline ? `+${Math.round(((s.level - s.baseline) / Math.abs(s.baseline)) * 100)}%` : 'up');
/**
 * @param {HTMLElement} el
 * @param {Record<string, string>} props
 */
const at = (el, props) => {
  for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v);
  return el;
};
/** @param {number[]} xs */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** One series' chart: a 2px line over its runs in order, a link per point, a dashed mark where each step started. */
/**
 * @param {CiNumberSeries} series
 * @param {(sha: string) => string} commit
 */
function chart(series, commit) {
  const W = 600,
    H = 120,
    L = 2,
    R = 2,
    T = 8,
    B = 18;
  const pts = series.points,
    n = pts.length,
    unit = series.unit;
  const vals = pts.map((p) => p.value);
  let lo = Math.min(...vals),
    hi = Math.max(...vals);
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.05 || 1;
  lo -= pad;
  hi += pad;
  const x = (/** @type {number} */ i) => (n === 1 ? W / 2 : L + (i / (n - 1)) * (W - L - R));
  const y = (/** @type {number} */ v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const stepAt = series.steps.map((s) => pts.findIndex((p) => p.run_id === s.run_id)).filter((i) => i >= 0);
  const el = h('div', { class: 'ci-chart ci-num-chart' });
  // Numbers only go into this markup: every label and link is set through the DOM below.
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="none">
    ${[hi - pad, (hi + lo) / 2, lo + pad].map((v) => `<line class="grid" x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>`).join('')}
    ${stepAt.map((i) => `<line class="step" x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H - B}"/>`).join('')}
    <path class="line running" d="${vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('')}"/>
    <line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
  </svg>`;
  const svg = /** @type {SVGSVGElement} */ (el.firstElementChild); // the innerHTML just set
  svg.setAttribute('aria-label', `${series.name} over its last ${n} runs${series.steps.length ? `, stepped up ${series.steps.length === 1 ? 'once' : `${series.steps.length} times`}` : ''}`);
  const left = (/** @type {number} */ i) => `${(x(i) / W) * 100}%`,
    top = (/** @type {number} */ v) => `${(y(v) / H) * 100}%`;
  const xs = n > 2 ? [0, (n - 1) >> 1, n - 1] : [0, n - 1].slice(0, n);
  const axis = h(
    'div',
    { class: 'ci-axis muted', 'aria-hidden': 'true' },
    ...[hi - pad, lo + pad].map((v) => at(h('span', { class: 'y' }, fmt(v, unit)), { top: top(v) })),
    ...xs.map((i, k) => at(h('span', { class: `x${k === 0 ? ' first' : k === xs.length - 1 && n > 1 ? ' last' : ''}` }, pacificDate(pts[i].at)), { left: left(i) })),
  );
  const tip = h('div', { class: 'ci-tip', hidden: true });
  const cross = /** @type {SVGLineElement} */ (svg.querySelector('.cross'));
  // A point is a real link to its commit, its hit box bigger than its dot.
  const dots = pts.map((p, i) =>
    at(h('a', { class: 'ci-pt', href: commit(p.sha), target: '_blank', rel: 'noopener', 'aria-label': `${fmt(p.value, unit)}, ${p.workflow} run ${p.run_id}, commit ${p.sha.slice(0, 9)}`, 'data-step': stepAt.includes(i) ? '' : null, onfocus: () => show(i), onblur: () => hide() }), { left: left(i), top: top(p.value) }),
  );
  let near = -1;
  const show = (/** @type {number} */ i) => {
    near = i;
    const p = pts[i],
      box = el.getBoundingClientRect();
    cross.setAttribute('x1', String(x(i)));
    cross.setAttribute('x2', String(x(i)));
    cross.setAttribute('visibility', 'visible');
    dots.forEach((d, k) => d.classList.toggle('on', k === i));
    const step = series.steps.find((s) => s.run_id === p.run_id);
    tip.replaceChildren(h('strong', {}, fmt(p.value, unit)), h('span', {}, pacificStamp(p.at)), h('span', {}, `run ${p.run_id} · ${p.sha.slice(0, 9)}`), step ? h('span', {}, toneChip('warn', `Stepped up ${pct(step)}`)) : '');
    tip.hidden = false;
    tip.style.left = `${Math.min(box.width - 150, Math.max(0, (x(i) / W) * box.width + 8))}px`;
  };
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.classList.remove('on'));
  };
  // Between dots, the nearest run shows (the crosshair the rest of the CI page's charts have).
  svg.addEventListener('pointermove', (ev) => {
    const b = svg.getBoundingClientRect();
    show(Math.min(n - 1, Math.max(0, Math.round(((((ev.clientX - b.left) / b.width) * W - L) / (W - L - R)) * (n - 1)))));
  });
  el.addEventListener('pointerleave', hide);
  // Dense points' links overlap, so a click opens the run the crosshair is on; keyboard and screen readers use the links.
  svg.addEventListener('click', () => {
    if (near >= 0) window.open(commit(pts[near].sha), '_blank', 'noopener');
  });
  el.append(axis, ...dots, tip);
  return h(
    'figure',
    { class: 'ci-figure' },
    h('figcaption', {}, h('span', { class: 'ci-title' }, `${series.name}${unit ? `, ${unit}` : ''}`), h('span', { class: 'ci-legend' }, h('span', {}, `${n} run${n === 1 ? '' : 's'} on ${series.ref.replace(/^refs\/heads\//, '')}`), stepAt.length ? h('span', {}, h('i', { class: 'key step' }), 'step up held') : '')),
    el,
  );
}

/**
 * @param {{ id: number }} s
 * @param {CiNumberSeries} view
 * @param {CiNumbersRules & { repo: string | null }} rules
 */
function seriesRow(s, view, rules) {
  const pts = view.points,
    unit = view.unit,
    last = /** @type {Point} */ (pts.at(-1));
  const commit = (/** @type {string} */ sha) => (rules.repo ? `${rules.repo}/commit/${sha}` : `#${sha}`);
  // A step is news while it's inside the runs the rule looks at; older ones stay marked on the chart.
  const recent = view.steps.filter((st) => pts.findIndex((p) => p.run_id === st.run_id) >= pts.length - (rules.held + rules.base));
  const before = pts.slice(-rules.held - rules.base, -rules.held).map((p) => p.value);
  const [row] = settingsRow(
    {
      key: `numbers-${s.id}-${view.name}`,
      icon: 'chart',
      hue: recent.length ? 'waiting' : 'done',
      title: view.name,
      summary: [recent.length ? toneChip('warn', `Stepped up ${pct(/** @type {CiNumberStepRow} */ (recent.at(-1)))}`) : toneChip('ok', 'Steady'), fmt(last.value, unit)],
    },
    statTiles([fmt(last.value, unit), 'latest run', recent.length ? 'waiting' : 'done'], recent.length ? [fmt(/** @type {CiNumberStepRow} */ (recent.at(-1)).baseline, unit), 'before the step', 'held'] : before.length && [fmt(median(before), unit), `usual, the ${before.length} runs before`, 'held'], [
      String(pts.length),
      `runs, kept ${rules.keepDays} days`,
    ]),
    chart(view, commit),
    view.steps.length
      ? h(
          'div',
          { class: 'hue-rows' },
          ...view.steps
            .slice()
            .reverse()
            .map((st) =>
              hueRow(
                { hue: 'waiting', lead: pct(st), meta: pacificDate(st.at) },
                h('strong', {}, `${fmt(st.baseline, unit)} → ${fmt(st.level, unit)}`),
                h('span', { class: 'ci-detail-line muted' }, 'held for ', String(rules.held), ' runs from run ', h('a', { href: commit(st.sha), target: '_blank', rel: 'noopener' }, `${st.run_id} (${st.sha.slice(0, 9)})`)),
              ),
            ),
        )
      : null,
    showFirst({
      key: `numbers-runs-${s.id}-${view.name}`,
      noun: 'runs',
      items: pts
        .slice()
        .reverse()
        .map((p) =>
          hueRow(
            { hue: view.steps.some((st) => st.run_id === p.run_id) ? 'waiting' : 'running', lead: fmt(p.value, unit), meta: pacificStamp(p.at) },
            h('a', { href: commit(p.sha), target: '_blank', rel: 'noopener', title: `${p.workflow} run ${p.run_id}` }, p.sha.slice(0, 9)),
            h('span', { class: 'muted' }, ` run ${p.run_id}`),
          ),
        ),
    }),
    h('p', { class: 'look-prose' }, `A step up is flagged once ${rules.held} runs in a row are over ${Math.round(rules.pct * 100)}% above the median of the ${rules.base} runs before, and past their usual run-to-run wobble. It wakes the Taskmaster; it never blocks a ship.`),
  );
  return row;
}

/** The tab: `data` is the scheme's read (null while reading, { error } when it failed). */
/**
 * @param {{ id: number }} s
 * @param {CiNumbersView | ReadFailed | null} data
 * @param {() => void} refresh
 */
export function numbersTab(s, data, refresh) {
  if (!data) return [h('p', { class: 'muted' }, 'Reading CI numbers…')];
  if (data.error) return [h('p', { class: 'error' }, "Couldn't read CI numbers. ", h('button', { type: 'button', class: 'secondary', onclick: refresh }, 'Try again'))];
  if (!data.series.length) {
    return [h('section', { class: 'ci-block' }, emptyCard('No CI numbers yet', 'A workflow sends them with a line like tools/ci-numbers.sh startup=412ms apk-size=12.5MB (the citadel:ci-store skill); each run adds a point here.', { mark: '∿', hue: 'held' }))];
  }
  const rules = { ...data.rules, repo: data.repo };
  /** @param {CiNumberSeries} v */
  const isNew = (v) => v.steps.some((st) => v.points.findIndex((p) => p.run_id === st.run_id) >= v.points.length - (rules.held + rules.base));
  const stepped = data.series.filter(isNew);
  return [h('section', { class: 'ci-block' }, h('h3', { class: 'settings-section', 'data-hue': stepped.length ? 'waiting' : 'done' }, 'Numbers per run'), h('div', { class: 'settings-rows' }, ...[...stepped, ...data.series.filter((v) => !isNew(v))].map((v) => seriesRow(s, v, rules))))];
}
