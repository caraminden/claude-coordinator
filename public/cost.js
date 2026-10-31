// Today's use beside the weekly meter, as a share of an even day (a seventh of the week), opening to the last 7 days.
import { account, api, costText, h, view } from './core.js';
import { closeOnClickAway } from './properties.js';
import { renderSidebar } from './sidebar.js';

let days = null;
// What an even day's share of the weekly limit comes to at API prices (src/costs.ts dayBudget), or null.
let budget = null;

/** "Day 38%" after the weekly bar: today against an even day's share of the week. It opens to the last 7 days. */
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
  if (!account?.admin) return; // costs are Citadel-wide, so only admins see them
  const before = budget;
  try {
    ({ days, dayBudget: budget } = await api('api/costs'));
  } catch {
    return; // keep the last figures; the next turn tries again
  }
  // Minion rows show their cost against the week, so they redraw when that estimate moves.
  if (budget !== before && view?.kind === 'project') renderSidebar();
  for (const chip of document.querySelectorAll('.cost-chip')) {
    chip.hidden = false;
    const today = days[0].total;
    const over = budget && today > budget;
    chip.querySelector('summary').replaceChildren(budget ? 'Day ' : 'Today ', h('b', { class: over ? 'warn' : '' }, budget ? pct(today) : costText(today)));
    chip.querySelector('summary').title = budget
      ? `Today's turns: ${costText(today)} at API prices, ${pct(today)} of an even day's share of the weekly limit (${costText(budget)}).${over ? '\nOver it: at this pace the week runs out early.' : ''}`
      : `Today's turns: ${costText(today)} at API prices. Shown against the weekly limit once its meter reaches 3%.`;
    if (chip.open) drawPop(chip);
  }
}

/** A cost as a share of the weekly limit, "0.4%", or null until the week can be priced. */
export function weekShare(usd) {
  if (!budget) return null;
  const pct = (usd / (budget * 7)) * 100;
  return `${pct < 0.1 ? '<0.1' : pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** A cost as a share of an even day: "38%". */
const pct = (usd) => `${Math.round((usd / budget) * 100)}%`;

function drawPop(chip) {
  if (!days) return;
  const pid = view?.projectId;
  const label = (day, i) => i === 0 ? 'Today' : i === 1 ? 'Yesterday'
    : new Date(`${day}T12:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  // The share of an even day first, the dollars beside it; a day over its share in amber.
  const cell = (usd, n = 1) => h('td', { class: `num${budget && usd > budget * n ? ' warn' : ''}` },
    !usd ? '–' : budget ? [pct(usd / n), h('span', { class: 'usd' }, costText(usd / n))] : costText(usd));
  const here = (d) => d.byProject[pid] ?? 0;
  const sum = (f) => days.reduce((s, d) => s + f(d), 0);
  chip.querySelector('.cost-pop').replaceChildren(
    h('h4', {}, budget ? "Each day against an even share of the week" : 'Cost at API prices, not a bill'),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}), h('th', { class: 'num' }, 'This scheme'), h('th', { class: 'num' }, 'All schemes'))),
      h('tbody', {}, days.map((d, i) => h('tr', {}, h('th', { scope: 'row' }, label(d.day, i)), cell(here(d)), cell(d.total)))),
      h('tfoot', {}, h('tr', {}, h('th', { scope: 'row' }, budget ? '7-day average' : '7 days'), cell(sum(here), budget ? days.length : 1), cell(sum((d) => d.total), budget ? days.length : 1)))),
    h('p', { class: 'foot' }, budget
      ? `100% is a seventh of the weekly limit, ≈ ${costText(budget).slice(2)} a day at API prices, worked out from the weekly meter and this week's turns (last week's, early in a week). Over it, the week runs out early. Taskmasters included; not a bill.`
      : "At API prices, not a bill. Taskmasters included. Shown against the weekly limit once its meter reaches 3%."));
}
