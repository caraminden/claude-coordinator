// What nobody has touched (#1306, the usage ledger src/usage-ledger.ts): every known page, route group, schedule, skill and
// Grunt type with its last use, nothing in 30 days first. Counts since the ledger began; items it never saw say "never".
import { api, h, icon, view } from './base.js';
import { settingsTabs, settingsTitle } from './settings.js';
import { loadingLine } from './ui/state.js';

/** One row of api/admin/usage (src/usage-ledger.ts unusedList). @typedef {{ kind: string, name: string, first: string, last: string, n: number, days: number, idle: boolean, never: boolean }} UsageItem */

/** @type {Record<string, string>} */
const KIND = { page: 'Page', route: 'Route group', tool: 'MCP tool', schedule: 'Schedule', setting: 'Setting changed', skill: 'Skill', grunt: 'Grunt type' };

/** @param {string} t */
const nw = (t) => t.replace(/-/g, '\u2011').replace(/ /g, '\u00a0'); // no break inside a date or a kind: the table's cells wrap whatever their style says

export function unusedPage() {
  const slot = h('div', { class: 'where-slot loading' }, loadingLine('Loading…'));
  api('api/admin/usage')
    .then((/** @type {{ since: string | null, items: UsageItem[] }} */ { since, items }) => {
      slot.classList.remove('loading');
      const idle = items.filter((i) => i.idle).length;
      slot.replaceChildren(
        h('p', { class: 'meta' }, `${idle} of ${items.length} items had nothing in the last 30 days. Counting began ${since ?? 'just now'}; anything used before that is not here.`),
        h(
          'div',
          { class: 'unused-scroll' },
          h(
            'table',
            { class: 'unused-table' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                ['Kind', 'Name', 'First seen', 'Last used', 'Uses'].map((t) => h('th', { scope: 'col' }, t)),
              ),
            ),
            h(
              'tbody',
              {},
              items.map((i) => h('tr', { class: i.idle ? 'idle' : '' }, h('td', {}, nw(KIND[i.kind] ?? i.kind)), h('td', {}, i.name), h('td', {}, nw(i.first)), h('td', {}, nw(i.never ? 'never' : i.last)), h('td', {}, String(i.n)))),
            ),
          ),
        ),
      );
    })
    .catch((err) => {
      slot.classList.remove('loading');
      slot.replaceChildren(h('p', { class: 'key' }, err.message));
    });
  return h(
    'section',
    { class: 'artifacts-main usage-main' },
    h(
      'div',
      { class: 'ticket-head' },
      h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), h('a', { class: 'close-view', href: `#/p/${/** @type {NonNullable<typeof view>} */ (view).projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, 'What nobody has used in 30 days, from the usage ledger: the first things to question.'),
    ),
    slot,
  );
}
