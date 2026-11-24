// Orders → Decisions (#1064): every dated, quoted decision, parsed live from where it is written (src/decisions.ts).
// Read-only: each row links to its source, where editing stays. A reversed decision links to the one that replaced it,
// and lists the copies still saying the old one, with a button that starts a minion to clean them up.
import { api, h, icon, view, pacificDate } from './base.js';
import { settingsRow, settingsTabs, settingsTitle } from './settings.js';
import { toast } from './ui/status.js';

const SCOPES = [
  ['scheme', 'This scheme'],
  ['citadel', 'Citadel-wide'],
  ['all', 'All'],
];
const day = pacificDate;
const external = (href) => /^https?:/.test(href);
let scope = 'scheme';
const openRows = new Set();
const SCHEME_KINDS = ['scheme', 'repo', 'adr', 'memory', 'ideas'];
/** In the picked tab: its own scope, or a copy written there (as inScope in src/decisions.ts). */
const shows = (d) => scope === 'all' || d.scope === scope || d.places.some((p) => (SCHEME_KINDS.includes(p.kind) ? 'scheme' : 'citadel') === scope);

/** Where a decision is written, as a link to the place (a line on GitHub, an instructions or memory page). */
function placeLink(p) {
  const text = `${p.label}${p.file && p.file !== p.label ? ` · ${p.file}` : ''}${p.line && p.kind !== 'citadel' && p.kind !== 'scheme' ? `:${p.line}` : ''}`;
  return p.href ? h('a', { href: p.href, ...(external(p.href) ? { target: '_blank', rel: 'noopener' } : {}) }, text) : h('span', {}, text);
}
const sourceName = (d) => [...new Set(d.places.map((p) => (p.kind === 'adr' ? p.file?.split('/').pop()?.replace(/\.md$/, '') : p.kind === 'memory' ? 'Memory' : p.kind === 'kit' ? 'The kit' : p.label)))].join(' · ');

/** The message that starts a chore minion to clean up a reversed decision's old copies. */
export function cleanupBrief(d, by) {
  const now = by ? `${by.rule}${by.quote ? `: "${by.quote}"` : ''} (${by.who}, ${by.date})` : d.reversed.byText;
  const where = d.reversed.stale.map((p) => `- ${p.label}${p.file && p.file !== p.label ? ` ${p.file}` : ''}${p.line ? `:${p.line}` : ''}${p.href ? ` (${p.href})` : ''}`).join('\n');
  return `A newer decision reversed an older one, but the older one is still written in this scheme. Bring these copies in line with the newer decision, quoting it with its date, or remove the old text where it no longer applies. Change only what the reversal touches.\n\nOld: ${d.rule}${d.quote ? `: "${d.quote}"` : ''} (${d.who}, ${d.date})\nNow: ${now}\n\nStill written in:\n${where}\n\nThe Decisions page (Orders → Decisions) shows both; it re-reads the sources, so the copies leave its list once fixed.`;
}

export function decisionsPage() {
  const p = view.project;
  let data = null;
  const meta = h('p', { class: 'meta' }, 'Reading the sources…');
  const counts = h('p', { class: 'muted small decision-counts' });
  const search = h('input', { type: 'search', placeholder: 'Search decisions', 'aria-label': 'Search decisions', oninput: () => filter() });
  const list = h('div', { class: 'settings-rows decision-list' });
  const empty = h('p', { class: 'muted', hidden: true }, 'No decision matches.');
  const pick = h(
    'div',
    { class: 'range-pick decision-scope', role: 'group', 'aria-label': 'Which decisions' },
    SCOPES.map(([key, label]) =>
      h(
        'button',
        {
          type: 'button',
          'data-scope': key,
          'aria-pressed': String(key === scope),
          onclick: () => {
            scope = key;
            for (const b of pick.children) b.setAttribute('aria-pressed', String(b.dataset.scope === key));
            filter();
          },
        },
        label,
      ),
    ),
  );
  const rows = [];

  const row = (d, byId) => {
    const by = d.reversed?.by ? byId.get(d.reversed.by) : null;
    const jump = (id) => (ev) => {
      ev.preventDefault();
      const target = rows.find((r) => r.d.id === id);
      if (!target) return;
      if (!shows(target.d)) {
        pick.querySelector('[data-scope="all"]').click();
      }
      search.value = '';
      filter();
      const el = rows.find((r) => r.d.id === id).row;
      el.open = true;
      el.scrollIntoView({ block: 'center' });
    };
    const body = [d.quote ? h('blockquote', { class: 'decision-quote' }, `“${d.quote}”`) : '', h('p', { class: 'decision-text' }, d.text), d.places.length ? h('p', { class: 'small decision-places' }, 'Written in: ', ...d.places.flatMap((pl, i) => [i ? ', ' : '', placeLink(pl)])) : ''];
    if (d.reversed) {
      const stale = d.reversed.stale;
      const clean = stale.length ? h('button', { type: 'button', class: 'secondary', onclick: () => cleanUp(d, by, clean) }, 'Clean up the old copies') : '';
      body.push(
        h(
          'div',
          { class: 'decision-reversed' },
          h(
            'p',
            {},
            h('span', { class: 'chip warn' }, 'Reversed'),
            ' by ',
            by ? h('a', { href: '#', onclick: jump(by.id) }, `${by.rule} (${by.who}, ${day(by.date)})`) : d.reversed.byText,
            d.reversed.href ? [' · ', h('a', { href: d.reversed.href, ...(external(d.reversed.href) ? { target: '_blank', rel: 'noopener' } : {}) }, 'the edit')] : '',
          ),
          stale.length ? h('p', { class: 'small' }, 'Still written in: ', ...stale.flatMap((pl, i) => [i ? ', ' : '', placeLink(pl)])) : '',
          clean,
        ),
      );
    }
    if (d.reverses.length) {
      body.push(
        h(
          'p',
          { class: 'small' },
          'Reverses: ',
          ...d.reverses
            .map((id) => byId.get(id))
            .filter(Boolean)
            .flatMap((o, i) => [i ? ', ' : '', h('a', { href: '#', onclick: jump(o.id) }, `${o.rule} (${o.who}, ${day(o.date)})`)]),
        ),
      );
    }
    const summary = `${d.reversed ? 'Reversed · ' : ''}${d.quote ? `“${d.quote.length > 90 ? `${d.quote.slice(0, 90)}…` : d.quote}” · ` : ''}${d.who}, ${day(d.date)} · ${sourceName(d) || 'no longer written'}`;
    const [el] = settingsRow({ icon: d.reversed ? 'close' : 'doc', hue: d.reversed ? 'held' : d.scope === 'citadel' ? 'teal' : 'running', title: d.rule || d.quote || 'Untitled', summary, open: openRows.has(d.id) }, ...body);
    if (d.reversed) el.classList.add('decision-row-reversed');
    el.addEventListener('toggle', () => openRows[el.open ? 'add' : 'delete'](d.id));
    rows.push({ row: el, d });
    return el;
  };

  /** Start a chore minion with the copies to fix; the button shows it at once and a failure puts it back with a retry. */
  const cleanUp = (d, by, btn) => {
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Starting a minion…';
    api(`api/projects/${p.id}/tickets`, { method: 'POST', body: { title: `Clean up copies of a reversed decision: ${d.rule}`.slice(0, 120), message: cleanupBrief(d, by), properties: { type: 'chore' } } }).then(
      (t) => btn.replaceWith(h('a', { href: `#/p/${p.id}/t/${t.number}` }, `Started #${t.number}`)),
      (err) => {
        btn.disabled = false;
        btn.textContent = was;
        toast(`Couldn't start the cleanup minion: ${err.message}`, { action: { label: 'Retry', run: () => cleanUp(d, by, btn) } });
      },
    );
  };

  const filter = () => {
    if (!data) return;
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const { row: el, d } of rows) {
      const inScope = shows(d);
      const hay = `${d.rule} ${d.quote} ${d.who} ${d.date} ${d.text} ${d.places.map((pl) => `${pl.label} ${pl.file ?? ''}`).join(' ')}`.toLowerCase();
      el.hidden = !inScope || !words.every((w) => hay.includes(w));
      if (!el.hidden) shown++;
    }
    empty.hidden = !words.length || shown > 0;
    const n = data.decisions.filter(shows).length;
    const rev = data.decisions.filter((d) => shows(d) && d.reversed).length;
    meta.textContent = `${words.length ? `${shown} of ` : ''}${n} decision${n === 1 ? '' : 's'}${rev ? ` · ${rev} reversed` : ''} · newest first · each links to where it's written`;
  };

  // Rows are built once per load and filtered with `hidden`, so an open row stays open across a search or a tab.
  const render = () => {
    if (!data) return;
    rows.length = 0;
    const byId = new Map(data.decisions.map((d) => [d.id, d]));
    list.replaceChildren(...data.decisions.map((d) => row(d, byId)));
    counts.replaceChildren(
      'Read from: ',
      ...data.counts.flatMap((c, i) => [i ? ' · ' : '', h('span', { class: c.count ? '' : 'decision-gap', title: c.count ? '' : 'Nothing parsed here: if this source has decisions, the parser misses their format' }, `${c.label} ${c.count}${c.files > 1 ? ` in ${c.files} files` : ''}`)]),
    );
    filter();
  };
  api(`api/projects/${p.id}/decisions?scope=all`).then(
    (d) => {
      data = d;
      render();
    },
    (err) => {
      meta.textContent = `Couldn't read the decisions: ${err.message}`;
    },
  );

  return h(
    'section',
    { class: 'artifacts-main people-main decisions-main' },
    h('div', { class: 'ticket-head' }, h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))), settingsTabs(), meta),
    h('div', { class: 'row decision-tools' }, search, pick, h('a', { href: `#/p/${p.id}/ideas`, class: 'small' }, 'Ideas ledger')),
    counts,
    list,
    empty,
  );
}
