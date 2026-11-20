// Orders → Ideas (#1150): the scheme's ideas ledger. Every idea a choices page showed with a Later option, and every
// handoff in the shared folder, as one row: its pick in the picker's words, its handoff and the minion that built it.
// Rows fill themselves (src/ideas.ts); a person can fix a status or a minion link by hand, and that sticks.
import { api, h, icon, view } from './base.js';
import { emptyCard, toneChip } from './look.js';
import { settingsRow, settingsTabs, settingsTitle } from './settings.js';
import { toast } from './ui/status.js';

const STATUSES = ['proposed', 'picked', 'later', 'skipped', 'started', 'built', 'declined'];
const HUE = { proposed: 'accent', picked: 'running', later: 'waiting', skipped: 'held', started: 'teal', built: 'done', declined: 'held' };
const TONE = { proposed: 'neutral', picked: 'info', later: 'warn', skipped: 'neutral', started: 'violet', built: 'ok', declined: 'danger' };
const day = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
const cap = (s) => s[0].toUpperCase() + s.slice(1);
let status = '';
const openRows = new Set();

export function ideasPage() {
  const p = view.project;
  let data = null;
  const meta = h('p', { class: 'meta' }, 'Reading the pages and handoffs…');
  const search = h('input', { type: 'search', placeholder: 'Search ideas', 'aria-label': 'Search ideas', oninput: () => filter() });
  const pick = h('div', { class: 'range-pick idea-status', role: 'group', 'aria-label': 'Which ideas' });
  const pinned = h('div', { class: 'settings-rows idea-pinned' });
  const pinHead = h('h3', { class: 'settings-section', 'data-hue': 'waiting', hidden: true }, 'Later, waiting over two weeks');
  const allHead = h('h3', { class: 'settings-section', hidden: true }, 'All ideas');
  const list = h('div', { class: 'settings-rows idea-list' });
  const empty = h('p', { class: 'muted', hidden: true }, 'No idea matches.');
  const none = h('div', { hidden: true }, emptyCard('No ideas yet', 'A choices page with Build it / Later / Cut bars, or a handoff in the shared folder, starts the ledger.', { mark: '·', hue: 'accent' }));
  const rows = [];

  const save = (r, body, undo) =>
    api(`api/projects/${p.id}/ideas/${r.id}`, { method: 'POST', body }).then((res) => { replace(res.idea); },
      (err) => { undo(); toast(`Couldn't save ${r.card}: ${err.message}`, { action: { label: 'Retry', run: () => save(r, body, undo) } }); });

  /** Swap one idea in place after a save, keeping its row open. */
  const replace = (idea) => {
    const i = data.ideas.findIndex((x) => x.id === idea.id);
    if (i >= 0) data.ideas[i] = idea;
    render();
  };

  const row = (r) => {
    const statusPick = h('select', { 'aria-label': `Status of ${r.card}`, onchange: () => {
      const was = r.status_manual;
      const next = statusPick.value || null;
      chip.textContent = cap(next ?? r.status);
      chip.dataset.tone = TONE[next ?? r.status];
      save(r, { status: next }, () => { statusPick.value = was ?? ''; chip.textContent = cap(r.status); chip.dataset.tone = TONE[r.status]; });
    } },
      h('option', { value: '' }, `Automatic (${r.status_manual ? 'from the pick and minion' : r.status})`),
      STATUSES.map((s) => h('option', { value: s, selected: r.status_manual === s }, cap(s))));
    const minionIn = h('input', { type: 'text', inputmode: 'numeric', placeholder: '#N', 'aria-label': `Minion for ${r.card}`, value: r.minion ? `#${r.minion.number}` : '', size: 6 });
    const link = (ticket) => (ev) => {
      ev.preventDefault();
      const n = ticket === 'set' ? Number(minionIn.value.replace(/^#/, '')) : ticket;
      if (ticket === 'set' && !(n > 0)) { toast('Type a minion number, like #1150'); return; }
      const was = minionIn.value;
      if (ticket === null) minionIn.value = '';
      save(r, { ticket: n }, () => { minionIn.value = was; });
    };
    const chip = toneChip(TONE[r.status], cap(r.status));
    const who = r.decided_by ? `${r.pick_label ?? r.pick ?? 'Picked'} · ${r.decided_by}, ${day(r.decided_at)}` : r.handoff ? 'Handoff written, no pick on a page' : 'Not picked yet';
    const summary = `${who}${r.minion ? ` · #${r.minion.number}` : ''}${r.status_manual ? ' · set by hand' : ''}`;
    const body = [
      r.words ? h('blockquote', { class: 'decision-quote' }, `“${r.words}”`) : '',
      h('p', { class: 'small idea-links' },
        r.page_label ? ['Page: ', r.page_href ? h('a', { href: r.page_href }, r.page_label) : r.page_label, r.page ? ` (card ${r.card})` : ''] : '',
        r.source_number ? [r.page_label ? ' · ' : '', 'From ', h('a', { href: `#/p/${p.id}/t/${r.source_number}` }, `#${r.source_number}`)] : '',
        r.handoff ? [' · Handoff: ', r.handoff_href ? h('a', { href: r.handoff_href }, r.handoff) : `${r.handoff} (gone)`] : '',
        r.minion ? [' · Built by ', h('a', { href: `#/p/${p.id}/t/${r.minion.number}` }, `#${r.minion.number}${r.minion.title ? ` ${r.minion.title}` : ''}`)] : ''),
      h('div', { class: 'row idea-edit' },
        h('label', { class: 'small' }, 'Status ', statusPick),
        h('label', { class: 'small' }, 'Minion ', minionIn),
        h('button', { type: 'button', class: 'secondary', onclick: link('set') }, 'Link'),
        r.minion ? h('button', { type: 'button', class: 'secondary', onclick: link(null) }, 'Unlink') : '',
        r.link_manual ? h('button', { type: 'button', class: 'secondary', onclick: link('auto'), title: 'Go back to the minion started from its handoff' }, 'Automatic') : ''),
      r.status_manual ? h('p', { class: 'small muted' }, `Status set by ${r.manual_by}, ${day(r.manual_at)}.`) : '',
    ];
    const [el] = settingsRow({ icon: r.handoff ? 'doc' : 'check', hue: HUE[r.status], title: h('span', {}, chip, ' ', r.title), summary, open: openRows.has(r.id) }, ...body);
    el.addEventListener('toggle', () => openRows[el.open ? 'add' : 'delete'](r.id));
    return el;
  };

  const filter = () => {
    if (!data) return;
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const { el, r, pin } of rows) {
      const hay = `${r.title} ${r.card} ${r.words ?? ''} ${r.handoff ?? ''} ${r.decided_by ?? ''} ${r.pick_label ?? ''} ${r.minion ? `#${r.minion.number}` : ''} ${r.source_number ? `#${r.source_number}` : ''}`.toLowerCase();
      el.hidden = (!pin && status && r.status !== status) || !words.every((w) => hay.includes(w));
      if (!el.hidden && !pin) shown++;
    }
    pinHead.hidden = ![...pinned.children].some((c) => !c.hidden);
    allHead.hidden = pinHead.hidden;
    empty.hidden = shown > 0 || !data.ideas.length;
    none.hidden = data.ideas.length > 0;
    meta.textContent = data.ideas.length
      ? `${words.length || status ? `${shown} of ` : ''}${data.ideas.length} idea${data.ideas.length === 1 ? '' : 's'} · from choices pages with a Later option and the handoffs folder · noted picks also show in Decisions`
      : '';
  };

  const render = () => {
    rows.length = 0;
    const waiting = new Set(data.waiting);
    const pins = data.ideas.filter((r) => waiting.has(r.id) && r.status === 'later');
    pinned.replaceChildren(...pins.map((r) => { const el = row(r); rows.push({ el, r, pin: true }); return el; }));
    list.replaceChildren(...data.ideas.map((r) => { const el = row(r); rows.push({ el, r }); return el; }));
    const counts = Object.fromEntries(STATUSES.map((s) => [s, data.ideas.filter((r) => r.status === s).length]));
    pick.replaceChildren(...[['', `All ${data.ideas.length}`], ...STATUSES.filter((s) => counts[s]).map((s) => [s, `${cap(s)} ${counts[s]}`])]
      .map(([key, label]) => h('button', { type: 'button', 'aria-pressed': String(key === status), onclick: () => {
        status = key;
        for (const b of pick.children) b.setAttribute('aria-pressed', 'false');
        pick.children[[...pick.children].findIndex((b) => b.textContent === label)].setAttribute('aria-pressed', 'true');
        filter();
      } }, label)));
    filter();
  };
  api(`api/projects/${p.id}/ideas`).then((d) => {
    data = d;
    if (status && !d.counts[status]) status = '';
    render();
  }, (err) => { meta.textContent = `Couldn't read the ideas: ${err.message}`; });

  return h('section', { class: 'artifacts-main people-main decisions-main ideas-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }),
        h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(), meta),
    h('div', { class: 'row decision-tools' }, search, h('a', { href: `#/p/${p.id}/decisions`, class: 'small' }, 'Decisions')),
    pick, pinHead, pinned, allHead, list, empty, none);
}
