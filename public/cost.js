// Today's cost beside the usage meter, opening to the last 7 days (GET api/costs, src/costs.ts).
import { DAY_SHARE_WARN, api, costText, h, todayShare, view } from './core.js';
import { closeOnClickAway } from './properties.js';

let days = null;

/** "Today ≈ $25" after the weekly bar; it opens to each day of the last week, this scheme and all. */
export function costChip() {
  const chip = h('details', { class: 'cost-chip', hidden: true },
    h('summary', {}),
    h('div', { class: 'cost-pop', popover: 'manual' }));
  chip.addEventListener('toggle', () => {
    const pop = chip.querySelector('.cost-pop');
    if (!chip.open) return pop.hidePopover();
    drawPop(chip);
    // In the top layer, so neither the panel (or phone drawer) around it nor the minions list beside it covers it.
    pop.showPopover();
    const row = chip.closest('.usage').getBoundingClientRect();
    pop.style.top = `${row.bottom + 6}px`;
    pop.style.left = `${Math.max(8, Math.min(row.left, innerWidth - pop.offsetWidth - 8))}px`;
    // It would drift once the page or the panel scrolls (not the chat, which scrolls as turns run).
    for (const el of [window, chip.closest('.shelf')]) el?.addEventListener('scroll', () => (chip.open = false), { once: true });
  });
  return closeOnClickAway(chip);
}

/** Fetch the daily totals again (a turn just ended) and redraw. */
export async function renderCost() {
  try {
    ({ days } = await api('api/costs'));
  } catch {
    return; // keep the last figures; the next turn tries again
  }
  drawCost();
}

/** Redraw every cost chip from the last figures, e.g. when today's share of the week changes. */
export function drawCost() {
  if (!days) return;
  const warn = todayShare() > DAY_SHARE_WARN;
  for (const chip of document.querySelectorAll('.cost-chip')) {
    chip.hidden = false;
    const summary = chip.querySelector('summary');
    summary.replaceChildren('Today ', h('b', { class: warn ? 'warn' : '' }, costText(days[0].total)));
    summary.title = `What today's Claude turns would cost at API prices, every scheme${warn ? `.\nMore than a seventh of the week's limit used today` : ''}`;
    if (chip.open) drawPop(chip);
  }
}

function drawPop(chip) {
  if (!days) return;
  const pid = view?.projectId;
  const share = todayShare();
  const label = (day, i) => i === 0 ? 'Today' : i === 1 ? 'Yesterday'
    : new Date(`${day}T12:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const cell = (usd, cls = '') => h('td', { class: `num ${cls}` }, usd ? costText(usd) : '–');
  const sum = (f) => days.reduce((s, d) => s + f(d), 0);
  const here = (d) => d.byProject[pid] ?? 0;
  chip.querySelector('.cost-pop').replaceChildren(
    h('h4', {}, 'Cost at API prices, not a bill'),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}), h('th', { class: 'num' }, 'This scheme'), h('th', { class: 'num' }, 'All schemes'))),
      h('tbody', {}, days.map((d, i) => h('tr', {},
        h('th', { scope: 'row' }, label(d.day, i)), cell(here(d)), cell(d.total, i === 0 && share > DAY_SHARE_WARN ? 'warn' : '')))),
      h('tfoot', {}, h('tr', {}, h('th', { scope: 'row' }, '7 days'), cell(sum(here)), cell(sum((d) => d.total))))),
    h('p', { class: 'foot' },
      `Today has used ${Math.round(share * 100)}% of the week's limit; its total turns amber past a seventh. Taskmasters included.`));
}
