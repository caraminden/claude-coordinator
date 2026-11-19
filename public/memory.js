// Settings → Memory (#1058): the Claude Code memory notes this scheme's Taskmaster and minions read at every start,
// read and written in place (src/memory-files.ts). Not search over chats.
import { api, h, view } from './base.js';
import { settingsRow, settingsTabs, settingsTitle } from './settings.js';
import { icon } from './base.js';
import { optimistic } from './ui/optimistic.js';
import { emptyCard, statTiles, toneChip } from './look.js';

const kb = (b) => (b < 1024 ? `${b} B` : `${Math.round(b / 1024)} KB`);
const day = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
const openRows = new Set();

/** The reasons a note may be stale, as chips. */
export function flagChips(f) {
  return [
    f.closed.length && `Names ${f.closed.length === 1 ? 'a closed minion' : `${f.closed.length} closed minions`}: ${f.closed.map((n) => `#${n}`).join(', ')}`,
    f.datesPast.length && `Date passed: ${f.datesPast.join(', ')}`,
    f.datesSoon.length && `Date soon: ${f.datesSoon.join(', ')}`,
  ].filter(Boolean);
}

export function memoryPage() {
  const p = view.project;
  const url = `api/projects/${p.id}/memory-files`;
  let folders = null;
  const meta = h('div', { class: 'meta' }, 'Loading…');
  const search = h('input', { type: 'search', placeholder: 'Search memory', 'aria-label': 'Search memory', oninput: () => filter() });
  const list = h('div', { class: 'memory-list' });
  const note = (f, n) => {
    const body = h('pre', { class: 'memory-text' }, n.text);
    const edit = h('textarea', { class: 'memory-edit', rows: 14, hidden: true, spellcheck: false });
    edit.value = n.text;
    edit.setAttribute('aria-label', `Edit ${n.name}`);
    const save = h('button', { type: 'button', hidden: true, onclick: () => {
      const text = edit.value;
      const was = n.text;
      optimistic({
        key: `memory:${p.id}:${f.id}:${n.file}`,
        apply: () => { n.text = text; edit.hidden = save.hidden = cancel.hidden = true; editBtn.hidden = false; body.hidden = false; body.textContent = text; },
        send: () => api(url, { method: 'PUT', body: { folder: f.id, file: n.file, text } }),
        undo: () => { n.text = was; body.textContent = was; edit.value = text; edit.hidden = save.hidden = cancel.hidden = false; editBtn.hidden = true; body.hidden = true; },
        label: `save ${n.name}`,
      }).catch(() => {});
    } }, 'Save');
    const cancel = h('button', { type: 'button', class: 'secondary', hidden: true, onclick: () => { edit.value = n.text; edit.hidden = save.hidden = cancel.hidden = true; body.hidden = false; editBtn.hidden = false; } }, 'Cancel');
    const editBtn = h('button', { type: 'button', class: 'secondary', onclick: () => { edit.hidden = save.hidden = cancel.hidden = false; body.hidden = true; editBtn.hidden = true; } }, 'Edit');
    const del = h('button', { type: 'button', class: 'danger', onclick: () => {
      if (!confirm(`Delete "${n.name}"? Its line leaves MEMORY.md too.`)) return;
      optimistic({
        key: `memory:${p.id}:${f.id}:${n.file}`,
        apply: () => { row.hidden = true; n.gone = true; count(); },
        send: () => api(`${url}?folder=${f.id}&file=${encodeURIComponent(n.file)}`, { method: 'DELETE' }),
        undo: () => { row.hidden = false; n.gone = false; count(); },
        label: `delete ${n.name}`,
      }).catch(() => {});
    } }, 'Delete');
    const chips = flagChips(n.flags).map((t) => toneChip('warn', t));
    const key = `${f.id}:${n.file}`;
    const stale = n.flags.closed.length || n.flags.datesPast.length;
    // Closed line: a toned chip for the note's state, then what it is and when it changed.
    const state = chips.length ? toneChip(stale ? 'warn' : 'info', stale ? 'Stale?' : 'Date soon') : toneChip('ok', 'Current');
    const [row] = settingsRow({ icon: 'doc', hue: stale ? 'held' : chips.length ? 'waiting' : 'running', title: n.name,
      summary: [state, ` ${n.description ? `${n.description} · ` : ''}${day(n.modified)}`], open: openRows.has(key) },
      statTiles([kb(n.bytes), 'size', 'accent'], [day(n.modified), 'last changed', 'done']),
      chips.length ? h('div', { class: 'chips' }, ...chips) : '', body, edit,
      h('div', { class: 'memory-actions' }, editBtn, save, cancel, del),
      h('p', { class: 'muted small look-prose' }, `${n.file} · ${kb(n.bytes)}. The Taskmaster and minions read this on their next session.`));
    row.addEventListener('toggle', () => openRows[row.open ? 'add' : 'delete'](key));
    rows.push({ row, n });
    return row;
  };
  // Rows are built once per load and filtered with `hidden`, so a draft in an open editor survives a search or another note's save.
  const rows = [];
  const count = () => {
    const live = folders.flatMap((f) => f.notes).filter((n) => !n.gone);
    const total = live.length;
    meta.textContent = total ? `${total} note${total === 1 ? '' : 's'} the Taskmaster and minions read at every start · ${kb(live.reduce((s, n) => s + n.bytes, 0))}` : 'No memory notes yet. The Taskmaster and minions add them as they work.';
  };
  const filter = () => {
    const q = search.value.trim().toLowerCase();
    for (const { row, n } of rows) row.hidden = !!n.gone || (!!q && !`${n.name} ${n.description} ${n.text}`.toLowerCase().includes(q));
    empty.hidden = !q || rows.some(({ row }) => !row.hidden);
  };
  const empty = h('div', { hidden: true }, emptyCard('No note matches', 'Try another word from its name, description or text.', { mark: '∅', hue: 'waiting' }));
  const render = () => {
    rows.length = 0;
    count();
    list.replaceChildren(...folders.flatMap((f) => [
      folders.length > 1 && h('h3', { class: 'settings-section', 'data-hue': 'accent' }, f.label),
      !f.reachable ? emptyCard('Not reachable', 'This login has no memory folder for the scheme yet.', { mark: '!', hue: 'held' })
        : f.notes.length ? h('div', { class: 'settings-rows' }, ...f.notes.map((n) => note(f, n)))
        : emptyCard('No notes in this folder', 'The Taskmaster and minions add them as they work.', { mark: '∅', hue: 'accent' }),
    ].filter(Boolean)), empty);
    filter();
  };
  const load = () => api(url).then((d) => { folders = d.folders; render(); }, (err) => { meta.textContent = `Couldn't read the notes: ${err.message}`; });
  load();
  const wrap = h('section', { class: 'artifacts-main people-main memory-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }),
        h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(), meta),
    search, list);
  return wrap;
}
