// Settings > Units (#1216): deploy/'s systemd units against what is installed on this host, with the fish command for each that isn't.
import { api, h } from './base.js';
import { settingsRow, settingsTabs, settingsTitle } from './settings.js';
import { copyText } from './ui/markdown.js';

/** @typedef {{ name: string, state: 'installed' | 'missing' | 'different', fix: string | null }} UnitRow  src/unit-drift.ts UnitRow, from api/units */

export function unitsPage() {
  const list = h('div', { class: 'settings-rows' }, h('p', { class: 'muted' }, 'Checking…'));
  const meta = h('span', { role: 'status' }, '');
  api('api/units')
    .then(
      /** @param {{ rows: UnitRow[] }} res */ ({ rows }) => {
        /** @param {string} st */
        const n = (st) => rows.filter((r) => r.state === st).length;
        meta.textContent = `Units: ${n('installed')} installed, ${n('missing')} missing, ${n('different')} different`;
        list.replaceChildren(
          ...rows.map((r) => {
            const ok = r.state === 'installed';
            const [row] = settingsRow(
              { icon: ok ? 'check' : 'shield', hue: ok ? 'running' : 'held', title: r.name, summary: r.state, open: !ok, key: `unit:${r.name}` },
              ok
                ? h('p', { class: 'muted' }, 'Installed and the same as deploy/.')
                : [
                    h('p', {}, r.state === 'missing' ? 'Not installed on this host. In a fish shell on perigee:' : 'The installed copy differs from deploy/. In a fish shell on perigee:'),
                    h('pre', { class: 'instructions-diff' }, r.fix),
                    h('button', { type: 'button', onclick: () => copyText(/** @type {string} */ (r.fix)) }, 'Copy'),
                  ],
            );
            return row;
          }),
          h('p', { class: 'muted' }, 'A unit kept out on purpose goes in deploy/not-installed.txt and stops showing here.'),
        );
      },
    )
    .catch((err) => {
      meta.textContent = '';
      list.replaceChildren(h('p', { class: 'muted' }, `Couldn't check: ${err.message}`));
    });
  return h('section', { class: 'artifacts-main people-main' }, h('div', { class: 'ticket-head' }, h('div', { class: 'row' }, ...settingsTitle()), settingsTabs(), h('div', { class: 'meta' }, meta)), list);
}
