// Spend against an even day (a seventh of the week): the 7-day breakdown on the usage page, and the week share minion rows use.
import { account, api, costText, h, view } from './base.js';
import { toast } from './ui/status.js';
import { renderSidebar } from './sidebar.js';

let days = null;
// Every payer's spend by person and by scheme, week and month (src/costs.ts spendSplit, #689).
let split = null;
// What an even day's share of the weekly limit comes to at API prices (a seventh of src/costs.ts hostWeek's limit, every account together), or null.
let budget = null;
// Each Claude account's part of that limit (src/costs.ts hostWeek), for the chip's tooltip.
let parts = [];
// This month's spend on outside APIs and OpenRouter by scheme and service, with each scheme's cap (src/outside-spend.ts, #839).
let outside = [];

/** The 7-day breakdown, on Settings → Usage for admins (it used to open from a "Day 38%" chip beside the weekly bar). */
export function costDetail() {
  const el = h('section', { class: 'cost-detail cost-pop', hidden: true });
  renderCost();
  return el;
}

/** Fetch the daily totals again (a turn just ended) and redraw. */
export async function renderCost() {
  if (!account?.admin) return; // the server login's costs across Citadel, so only admins see them
  const before = budget;
  let limit;
  try {
    ({ days, week: { limit, parts }, split, outside } = await api('api/costs'));
    budget = limit && limit / 7;
  } catch {
    return; // keep the last figures; the next turn tries again
  }
  // Minion rows show their cost against the week, so they redraw when that estimate moves.
  if (budget !== before && view?.kind === 'project') renderSidebar();
  for (const el of document.querySelectorAll('.cost-detail')) {
    el.hidden = false;
    drawPop(el);
  }
}

/** A cost as a share of the weekly limit, "0.4%", or null until the week can be priced. */
export function weekShare(usd) {
  if (!budget) return null;
  const pct = (usd / (budget * 7)) * 100;
  return `${pct < 0.1 ? '<0.1' : pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** Who paid and where it went: every login's turns, not just the server login's, in dollars. */
function splitTables() {
  const table = (head, rows) => h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, head), h('th', { class: 'num' }, '7 days'), h('th', { class: 'num' }, '30 days'))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('th', { scope: 'row' }, r.name),
      h('td', { class: 'num' }, r.week ? costText(r.week) : '–'), h('td', { class: 'num' }, costText(r.month))))));
  return h('div', { class: 'spend-split' },
    h('h4', {}, 'Every login, by person and scheme'),
    table('Person', split.people), table('Scheme', split.schemes));
}

/** This month's bill for outside APIs, per scheme and service, with a cap field for the scheme you're in (#839). */
function outsideBill() {
  const pid = view?.projectId;
  const mine = outside.find((b) => b.project_id === pid);
  const cap = h('input', { type: 'number', min: '1', step: '1', class: 'cap-input', placeholder: 'none', 'aria-label': 'Monthly cap in dollars', value: mine?.cap_usd ?? '' });
  cap.addEventListener('change', async () => {
    const usd = cap.value === '' ? null : Number(cap.value);
    try {
      await api(`api/projects/${pid}/spend`, { method: 'PUT', body: { cap_usd: usd } });
      renderCost();
    } catch (err) {
      toast(`Couldn't set the cap: ${err.message}`, { tone: 'warn' });
    }
  });
  return h('div', { class: 'spend-split outside-bill' },
    h('h4', {}, 'Outside APIs this month, by scheme'),
    outside.length ? h('table', {},
      h('tbody', {}, outside.flatMap((b) => {
        const over = b.cap_usd !== null && b.month_usd >= b.cap_usd;
        return [
          h('tr', {}, h('th', { scope: 'row' }, b.name), h('td', { class: `num${over ? ' warn' : ''}` }, costText(b.month_usd), b.cap_usd === null ? '' : h('span', { class: 'usd' }, ` of ${costText(b.cap_usd)}`))),
          ...b.services.map((s) => h('tr', { class: 'service' }, h('td', { class: 'indent' }, s.service), h('td', { class: 'num' }, costText(s.usd)))),
        ];
      }))) : h('p', { class: 'key' }, 'Nothing reported this month.'),
    pid ? h('label', { class: 'cap-row' }, 'Cap for this scheme, $/month ', cap) : '',
    h('p', { class: 'foot' }, 'Reported by contraptions (POST /api/contraptions/spend) and minions (report_spend), with OpenRouter calls. Crossing a cap warns the scheme once a month; nothing stops.'));
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
  chip.replaceChildren(
    h('h4', {}, budget ? "Each day against an even share of the week" : 'Cost at API prices, not a bill'),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}), h('th', { class: 'num' }, 'This scheme'), h('th', { class: 'num' }, 'All schemes'))),
      h('tbody', {}, days.map((d, i) => h('tr', {}, h('th', { scope: 'row' }, label(d.day, i)), cell(here(d)), cell(d.total)))),
      h('tfoot', {}, h('tr', {}, h('th', { scope: 'row' }, budget ? '7-day average' : '7 days'), cell(sum(here), budget ? days.length : 1), cell(sum((d) => d.total), budget ? days.length : 1)))),
    budget ? h('p', { class: 'key' }, h('span', { class: 'warn' }, 'Amber'), ': over that day\'s even share.') : '',
    outsideBill(),
    split?.people.length ? splitTables() : '',
    h('p', { class: 'foot' }, budget
      ? `100% is a seventh of the weekly limit, ≈ ${costText(budget).slice(2)} a day at API prices, worked out from the weekly meter and this week's turns (last week's, early in a week). Over it, the week runs out early. The server login's turns only, Taskmasters included; not a bill.`
      : "The server login's turns at API prices, not a bill. Taskmasters included. Shown against the weekly limit once its meter reaches 3%."));
}
