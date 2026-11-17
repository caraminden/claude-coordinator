// "Where it went" (#905): your own spend over the last 7 days against the 7 before, by model, scheme, kind of work,
// and the 10 costliest minions, from /api/costs/mine (src/costs.ts whereItWent). One series per table, so one hue and no legend.
import { api, costText, h, icon, threadHref, view } from './base.js';
import { settingsTabs } from './settings.js';

/** A share of the weekly limit (all your accounts together), "4.2%", or null while no meter can price it. */
function share(usd, weekUsd) {
  if (!weekUsd) return null;
  const p = (usd / weekUsd) * 100;
  return `${p && p < 0.1 ? '<0.1' : p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

/** The share first and the dollars beside it (Cara, 2026-11-17: "% first, $ beside"), or dollars alone. */
function amount(usd, weekUsd) {
  const s = share(usd, weekUsd);
  return s ? [h('b', {}, s), h('span', { class: 'usd' }, costText(usd))] : h('b', {}, usd ? costText(usd) : '–');
}

/** A bar `pct` wide; through the CSSOM, since the page's CSP refuses style attributes. */
function bar(pct) {
  const el = h('span', { class: 'bar' });
  el.style.setProperty('--pct', `${pct}%`);
  return el;
}

/** One table: a row per slice with a bar against the biggest this week, this week, and last week. */
function sliceTable(head, rows, weekUsd, name = (r) => r.name) {
  const max = Math.max(...rows.map((r) => r.usd), 0);
  return h('table', { class: 'where-table' },
    h('thead', {}, h('tr', {}, h('th', {}, head), h('th', { class: 'bar-col', 'aria-hidden': 'true' }), h('th', { class: 'num' }, 'This week'), h('th', { class: 'num' }, 'Last week'))),
    h('tbody', {}, rows.map((r) => h('tr', { title: `${r.name}: ${costText(r.usd)} this week${r.estimated ? ` (${costText(r.estimated)} estimated)` : ''}, ${costText(r.lastWeek)} last week` },
      h('th', { scope: 'row' }, name(r), r.estimated > 0.005 ? h('span', { class: 'est', title: "Partly estimated: turns from before 2026-11-17 kept no split, so they count under their minion's own model" }, ' est.') : ''),
      h('td', { class: 'bar-col' }, bar(max ? Math.max(2, (r.usd / max) * 100) : 0)),
      h('td', { class: 'num' }, amount(r.usd, weekUsd)),
      h('td', { class: 'num last' }, r.lastWeek ? (share(r.lastWeek, weekUsd) ?? costText(r.lastWeek)) : '–')))));
}

/** Fable's share of all spend, this week and last: the number "use it half as often" is checked by. */
function fableShare(w) {
  const sum = (k) => w.models.filter((m) => m.name.startsWith('Fable')).reduce((a, m) => a + m[k], 0);
  const pct = (part, all) => (all ? `${Math.round((part / all) * 100)}%` : '–');
  return h('p', { class: 'where-fable' }, 'Fable: ', h('b', {}, pct(sum('usd'), w.total)), ' of spend this week, ', h('b', {}, pct(sum('lastWeek'), w.lastWeek)), ' last week');
}

/** The whole view for one fetched summary. */
export function whereView(w) {
  const est = w.models.reduce((a, m) => a + m.estimated, 0);
  const top = w.top.map((m) => ({ ...m, name: m.kind === 'coordinator' ? 'Taskmaster' : `#${m.number} ${m.title}`, lastWeek: 0, estimated: 0 }));
  return h('div', { class: 'where' },
    h('div', { class: 'where-head' },
      h('div', { class: 'where-total' }, h('span', { class: 'label' }, 'Last 7 days'), amount(w.total, w.weekUsd)),
      h('div', { class: 'where-total' }, h('span', { class: 'label' }, 'The 7 before'), amount(w.lastWeek, w.weekUsd)),
      fableShare(w)),
    w.total || w.lastWeek ? [
      h('h4', {}, 'By model'), sliceTable('Model', w.models, w.weekUsd),
      h('h4', {}, 'By scheme'), sliceTable('Scheme', w.schemes, w.weekUsd),
      h('h4', {}, 'By kind of work'), sliceTable('Kind', w.kinds, w.weekUsd),
      h('h4', {}, 'Costliest minions this week'),
      sliceTable('Minion', top, w.weekUsd, (m) => h('a', { href: threadHref(m) }, m.name, h('span', { class: 'scheme' }, ` · ${m.scheme}`))),
    ] : h('p', { class: 'key' }, 'No turns on your plan in the last two weeks.'),
    h('p', { class: 'foot' },
      w.weekUsd ? `100% is the weekly limit of ${w.accounts > 1 ? `all ${w.accounts} of your Claude accounts together` : 'your Claude account'}, ≈ $${Math.round(w.weekUsd)} at API prices, priced from your weekly meter. ` : 'Dollars at API prices until your weekly meter reaches 3%; then shares of the week. ',
      "Your plan's turns only, Grunts counted under their own model. ",
      est > 0.005 ? `${costText(est).slice(2)} of this week is from turns before 2026-11-17, counted under each minion's own model (marked est.).` : ''));
}

/** Fetch your summary and draw it into `into`, which keeps its reserved height until then; a failure leaves a line saying so. */
export async function renderWhere(into) {
  try {
    into.replaceChildren(whereView(await api('api/costs/mine')));
  } catch (err) {
    into.replaceChildren(h('p', { class: 'key' }, `Couldn't load where it went: ${err.message}`));
  }
  into.classList.remove('loading');
}

/** Settings' Usage tab (Cara, 2026-11-17: "Settings → Usage"): where your own spend went. */
export function usagePage() {
  const slot = h('div', { class: 'where-slot loading' }, h('p', { class: 'key' }, 'Loading…'));
  setTimeout(() => renderWhere(slot));
  return h('section', { class: 'artifacts-main usage-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, h('h2', {}, 'Settings'), h('span', { class: 'spacer' }),
        h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, 'Where your own Claude spend went in every scheme: the last 7 days against the 7 before.')),
    slot);
}
