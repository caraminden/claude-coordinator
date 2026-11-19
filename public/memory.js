// Settings → Memory (#1058): the Claude Code memory notes this scheme's Taskmaster and minions read at every start,
// read and written in place (src/memory-files.ts). Not search over chats.
import { api, h, view } from './base.js';
import { settingsRow, settingsTabs, settingsTitle } from './settings.js';
import { icon } from './base.js';
import { optimistic } from './ui/optimistic.js';

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
  const search = h('input', { type: 'search', placeholder: 'Search memory', 'aria-label': 'Search memory', oninput: () => render() });
  const list = h('div', { class: 'memory-list' });
  const note = (fi, n) => {
    const body = h('pre', { class: 'memory-text' }, n.text);
    const edit = h('textarea', { class: 'memory-edit', rows: 14, hidden: true, spellcheck: false });
    edit.value = n.text;
    const save = h('button', { type: 'button', hidden: true, onclick: () => {
      const text = edit.value;
      const was = folders;
      optimistic({
        key: `memory:${p.id}:${fi}:${n.file}`,
        apply: () => { n.text = text; edit.hidden = save.hidden = cancel.hidden = true; body.hidden = false; body.textContent = text; },
        send: () => api(url, { method: 'PUT', body: { folder: fi, file: n.file, text } }),
        undo: () => { folders = was; load(); },
        label: `save ${n.name}`,
      }).then((d) => { if (d?.folders) { folders = d.folders; render(); } }, () => {});
    } }, 'Save');
    const cancel = h('button', { type: 'button', class: 'secondary', hidden: true, onclick: () => { edit.value = n.text; edit.hidden = save.hidden = cancel.hidden = true; body.hidden = false; editBtn.hidden = false; } }, 'Cancel');
    const editBtn = h('button', { type: 'button', class: 'secondary', onclick: () => { edit.hidden = save.hidden = cancel.hidden = false; body.hidden = true; editBtn.hidden = true; } }, 'Edit');
    const del = h('button', { type: 'button', class: 'danger', onclick: () => {
      if (!confirm(`Delete "${n.name}"? Its line leaves MEMORY.md too.`)) return;
      const was = folders;
      optimistic({
        key: `memory:${p.id}:${fi}:${n.file}`,
        apply: () => { folders = folders.map((f, i) => (i === fi ? { ...f, notes: f.notes.filter((x) => x.file !== n.file) } : f)); render(); },
        send: () => api(`${url}?folder=${fi}&file=${encodeURIComponent(n.file)}`, { method: 'DELETE' }),
        undo: () => { folders = was; render(); },
        label: `delete ${n.name}`,
      }).then((d) => { if (d?.folders) { folders = d.folders; render(); } }, () => {});
    } }, 'Delete');
    const chips = flagChips(n.flags).map((t) => h('span', { class: 'chip warn memory-flag' }, t));
    const key = `${fi}:${n.file}`;
    const [row] = settingsRow({ icon: 'doc', hue: n.flags.closed.length || n.flags.datesPast.length ? 'held' : 'running', title: n.name, summary: `${chips.length ? `⚠ ${chips[0].textContent.split(':')[0]} · ` : ''}${n.description ? `${n.description} · ` : ''}${day(n.modified)}`, open: openRows.has(key) },
      chips.length ? h('div', { class: 'chips' }, ...chips) : '', body, edit,
      h('div', { class: 'memory-actions' }, editBtn, save, cancel, del),
      h('p', { class: 'muted small' }, `${n.file} · ${kb(n.bytes)}. The Taskmaster and minions read this on their next session.`));
    row.addEventListener('toggle', () => openRows[row.open ? 'add' : 'delete'](key));
    return row;
  };
  const render = () => {
    if (!folders) return;
    const q = search.value.trim().toLowerCase();
    const total = folders.reduce((s, f) => s + f.notes.length, 0);
    meta.textContent = total ? `${total} note${total === 1 ? '' : 's'} the Taskmaster and minions read at every start · ${kb(folders.reduce((s, f) => s + f.bytes, 0))}` : 'No memory notes yet. The Taskmaster and minions add them as they work.';
    list.replaceChildren(...folders.flatMap((f, fi) => {
      const shown = f.notes.filter((n) => !q || `${n.name} ${n.description} ${n.text}`.toLowerCase().includes(q));
      return [
        folders.length > 1 && h('h3', { class: 'settings-section' }, f.label),
        !f.reachable ? h('p', { class: 'muted' }, 'Not reachable: this login has no memory folder for the scheme yet.')
          : shown.length ? h('div', { class: 'settings-rows' }, ...shown.map((n) => note(fi, n)))
          : h('p', { class: 'muted' }, q ? 'No note matches.' : 'No notes in this folder.'),
      ].filter(Boolean);
    }));
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
