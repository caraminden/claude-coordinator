// Orders → Memory (#1058, regrouped in #1071, Josh picked "By kind, with numbers on top"): the Claude Code memory notes
// this scheme's Taskmaster and minions keep, read and written in place (src/memory-files.ts). Not search over chats.
// Only MEMORY.md loads at a start (its first 200 lines or 25 KB); notes are read when needed, so a note the index
// doesn't list, or one whose recheck date passed, is what "needs tidying" means here. A closed minion it names is history.
import { api, h, icon, view, pacificDate } from './base.js';
import { settingsRow, settingsSection, settingsTabs, settingsTitle } from './settings.js';
import { optimistic } from './ui/optimistic.js';
import { emptyCard, meter, showFirst, statTiles, toneChip } from './look.js';
import { loadingLine, tabs } from './ui/state.js';

const kb = (b) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`);
const day = pacificDate;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Claude Code's load limits for MEMORY.md (code.claude.com/docs/en/memory). */
const INDEX_LINES = 200;
const INDEX_BYTES = 25 * 1024;
/** Each kind's label, hue and what it holds, in the order the groups show. A note with no kind lands in Other. */
const KINDS = [
  ['feedback', 'Feedback', 'held', 'How to work: corrections and confirmed ways'],
  ['project', 'Project', 'running', 'Ongoing work, plans and owed steps'],
  ['reference', 'Reference', 'teal', 'Where things live'],
  ['user', 'People', 'accent', 'Who people are and how they like to work'],
  ['', 'Other', 'muted', 'No kind in its frontmatter'],
];
const kindOf = (n) => (KINDS.some(([k]) => k && k === n.type) ? n.type : '');
// Kept across visits to the page, like the rows a person left open.
const openRows = new Set();
const folded = new Set();
let pickedFolder = null;

/** Why a note needs tidying, or '' when it doesn't. */
export const tidyReason = (n) => (!n.inIndex ? 'Not in MEMORY.md, so sessions never find it'
  : n.flags.datesPast.length ? `Date passed: ${n.flags.datesPast.join(', ')}` : '');

// The curator's changes (#1111): each kind's chip tone and word.
const ACTION = { edit: ['info', 'Edit'], add: ['ok', 'New note'], delete: ['danger', 'Delete'], index: ['violet', 'Index line'], flag: ['warn', 'Flag'] };

/**
 * The memory curator's proposed tidy (#1111; Josh, 2026-11-19): a tick per change, deletes unticked until a person
 * ticks each ("Delete, each ticked"), flags only to read. Apply writes the ticked ones; Put back undoes an applied tidy
 * for 30 days. `changed` reloads the notes after either.
 */
function tidyReview(p, changed) {
  const url = `api/projects/${p.id}/memory-proposals`;
  const box = h('div', { class: 'memory-tidy', hidden: true });
  const draw = (d) => {
    box.hidden = !d.open && !d.kept.length;
    const rows = [];
    if (d.open) {
      const o = d.open;
      const ticks = new Map();
      const apply = h('button', { type: 'button' });
      const count = () => { const n = [...ticks.values()].filter((t) => t.checked).length; apply.textContent = `Apply ${n} ticked`; apply.disabled = !n; };
      const items = o.changes.map((c) => {
        const [tone, word] = ACTION[c.action];
        const tick = c.action === 'flag' ? null : h('input', { type: 'checkbox', checked: c.action !== 'delete' && !c.drifted, disabled: c.drifted, 'aria-label': `${word} ${c.file}`, onchange: count });
        if (tick) ticks.set(c.id, tick);
        const diff = c.diff.length ? h('details', { class: 'memory-change-diff' }, h('summary', {}, 'Show the change'),
          h('pre', { class: 'instructions-diff' }, ...c.diff.map((x) => h('div', { class: x.op === '+' ? 'add' : x.op === '-' ? 'del' : 'gap' }, x.op === '…' ? '…' : `${x.op} ${x.text}`)))) : null;
        return h('div', { class: 'memory-change', 'data-hue': c.action === 'delete' ? 'danger' : c.action === 'flag' ? 'waiting' : 'running' },
          h('label', { class: 'memory-change-head' }, tick ?? h('span', { class: 'memory-change-notick', 'aria-hidden': 'true' }, '!'),
            toneChip(tone, word), h('code', {}, c.file), c.drifted ? toneChip('neutral', 'Changed since') : null),
          h('div', { class: 'memory-change-why' }, c.reason), diff);
      });
      count();
      const status = h('span', { class: 'muted', role: 'status' });
      const buttons = [apply, h('button', { type: 'button', class: 'secondary' }, 'Turn it all down')];
      const decide = (ids) => optimistic({
        key: `memory-tidy:${o.id}`,
        apply: () => { for (const b of buttons) b.disabled = true; status.textContent = ids.length ? 'Applying…' : 'Turning it down…'; },
        send: () => api(`${url}/${o.id}/decide`, { method: 'POST', body: { apply: ids } }),
        undo: () => { for (const b of buttons) b.disabled = false; count(); status.textContent = ''; },
        label: ids.length ? 'apply the memory tidy' : 'turn the memory tidy down',
      }).then((r) => { draw(r.view); changed(); }, () => {});
      apply.onclick = () => decide([...ticks].filter(([, t]) => t.checked).map(([id]) => id));
      buttons[1].onclick = () => decide([]);
      const kinds = Object.keys(ACTION).map((a) => [a, o.changes.filter((c) => c.action === a).length]).filter(([, n]) => n);
      const [row] = settingsRow({ icon: 'doc', hue: 'waiting', title: `Proposed tidy${o.ticket ? ` from #${o.ticket}` : ''} · ${day(o.created_at)}`,
        summary: o.approved_by ? `${o.approved_by} approved it on the card: the curator applies all but the deletes in its next turn` : `${plural(o.changes.length, 'change')} waiting: nothing changes until you apply`, open: true },
        statTiles(...kinds.map(([a, n]) => [String(n), ACTION[a][1].toLowerCase() + (n === 1 ? '' : 's'), a === 'delete' ? 'danger' : a === 'flag' ? 'waiting' : 'running'])),
        showFirst({ key: `memory-tidy:${o.id}`, items: items, n: 8, noun: 'changes', wrap: (xs) => h('div', { class: 'memory-changes' }, ...xs) }),
        h('div', { class: 'memory-actions' }, status, h('span', { class: 'spacer' }), ...buttons),
        h('p', { class: 'muted small look-prose' }, 'Deletes start unticked: tick each one you want gone. Flags are for you to judge and change nothing. A note edited since the proposal is skipped.'));
      rows.push(row);
    }
    for (const k of d.kept) {
      const back = h('button', { type: 'button', class: 'secondary', onclick: () => {
        if (!confirm(`Put back every note this tidy changed, as it was on ${day(k.decided_at)}? Edits made since to those notes are lost.`)) return;
        optimistic({
          key: `memory-tidy:${k.id}`,
          apply: () => { back.disabled = true; },
          send: () => api(`${url}/${k.id}/restore`, { method: 'POST' }),
          undo: () => { back.disabled = false; },
          label: 'put the memory tidy back',
        }).then((r) => { draw(r.view); changed(); }, () => {});
      } }, 'Put back');
      const [row] = settingsRow({ icon: 'doc', hue: 'done', title: `Tidy applied by ${k.decided_by} · ${day(k.decided_at)}`, summary: `${k.counts || 'nothing took'} · can be put back until ${day(k.until)}` },
        h('div', { class: 'memory-actions' }, h('span', { class: 'muted' }, `Its old notes are kept until ${day(k.until)}.`), h('span', { class: 'spacer' }), back));
      rows.push(row);
    }
    box.replaceChildren(...settingsSection('Curator', ...rows));
    box.querySelector('.settings-section')?.setAttribute('data-hue', 'waiting');
  };
  const load = () => api(url).then(draw, () => {});
  load();
  return box;
}

export function memoryPage() {
  const p = view.project;
  const url = `api/projects/${p.id}/memory-files`;
  let folders = null;
  let filterBy = 'all';
  const meta = h('div', { class: 'meta memory-head' }, loadingLine());
  const folderBar = h('div', { class: 'memory-folder-bar', hidden: true });
  const stats = h('div', { class: 'memory-stats', role: 'group', 'aria-label': 'Filter notes' });
  const search = h('input', { type: 'search', placeholder: 'Search memory', 'aria-label': 'Search memory', oninput: () => filter() });
  const list = h('div', { class: 'memory-list' });
  const empty = h('div', { class: 'memory-empty', hidden: true }, emptyCard('No note matches', 'Try another word, or another filter.', { mark: '∅', hue: 'waiting' }));
  // Rows are built once per load and filtered with `hidden`, so a draft in an open editor survives a search, a filter or another note's save.
  const rows = [];
  const groups = [];
  const blocks = new Map();
  const current = () => folders.find((f) => f.id === pickedFolder) ?? folders.find((f) => f.reachable) ?? folders[0];
  const live = (f) => f.notes.filter((n) => !n.gone);

  const note = (f, n) => {
    const key = `${f.id}:${n.file}`;
    const body = h('pre', { class: 'memory-text' }, n.text);
    const edit = h('textarea', { class: 'memory-edit', rows: 14, hidden: true, spellcheck: false, 'aria-label': `Edit ${n.name}` });
    edit.value = n.text;
    const editing = (on) => { edit.hidden = save.hidden = cancel.hidden = !on; body.hidden = editBtn.hidden = on; };
    const save = h('button', { type: 'button', hidden: true, onclick: () => {
      const text = edit.value;
      const was = n.text;
      optimistic({
        key: `memory:${p.id}:${key}`,
        apply: () => { n.text = text; body.textContent = text; editing(false); },
        send: () => api(url, { method: 'PUT', body: { folder: f.id, file: n.file, text } }),
        undo: () => { n.text = was; body.textContent = was; edit.value = text; editing(true); },
        label: `save ${n.name}`,
      }).then((d) => sync(f, d), () => {});
    } }, 'Save');
    const cancel = h('button', { type: 'button', class: 'secondary', hidden: true, onclick: () => { edit.value = n.text; editing(false); } }, 'Cancel');
    const editBtn = h('button', { type: 'button', class: 'secondary', onclick: () => { editing(true); edit.focus(); } }, 'Edit');
    const del = h('button', { type: 'button', class: 'danger', onclick: () => {
      if (!confirm(`Delete "${n.name}"? Its line leaves MEMORY.md too.`)) return;
      optimistic({
        key: `memory:${p.id}:${key}`,
        apply: () => { n.gone = true; refresh(); },
        send: () => api(`${url}?folder=${f.id}&file=${encodeURIComponent(n.file)}`, { method: 'DELETE' }),
        undo: () => { n.gone = false; refresh(); },
        label: `delete ${n.name}`,
      }).then((d) => sync(f, d), () => {});
    } }, 'Delete');
    const addBtn = h('button', { type: 'button', onclick: () => {
      optimistic({
        key: `memory:${p.id}:${key}`,
        apply: () => { n.inIndex = true; mark(); refresh(); },
        send: () => api(url, { method: 'PUT', body: { folder: f.id, file: n.file, index: true } }),
        undo: () => { n.inIndex = false; mark(); refresh(); },
        label: `add ${n.name} to the index`,
      }).then((d) => sync(f, d), () => {});
    } }, 'Add to the index');
    const unlisted = h('div', { class: 'memory-warn' }, h('span', {}, "Not listed in MEMORY.md, so sessions don't know it exists."), addBtn);
    const past = h('div', { class: 'memory-warn' });
    const soon = h('p', { class: 'muted small' });
    const closed = n.flags.closed.length ? h('p', { class: 'muted small' }, `Names ${plural(n.flags.closed.length, 'closed minion')} (${n.flags.closed.map((x) => `#${x}`).join(', ')}): history, not a warning.`) : '';
    const dot = h('span', { class: 'memory-dot' });
    const [row] = settingsRow({ icon: 'doc', hue: KINDS.find(([k]) => k === kindOf(n))[2], title: n.name, summary: `${n.description ? `${n.description} · ` : ''}${day(n.modified)}`, open: openRows.has(key) },
      statTiles([kb(n.bytes), 'size', 'accent'], [day(n.modified), 'last changed', 'done']),
      unlisted, past, soon, closed, body, edit,
      h('div', { class: 'memory-actions' }, editBtn, save, cancel, del),
      h('p', { class: 'muted small look-prose' }, `${n.file}. ${n.inIndex ? 'Reached from MEMORY.md; sessions read it when it matters.' : ''}`));
    row.querySelector('summary').insertBefore(dot, row.querySelector('.settings-row-chev'));
    const mark = () => {
      const why = tidyReason(n);
      unlisted.hidden = n.inIndex;
      past.hidden = !n.flags.datesPast.length;
      past.textContent = `Its date ${n.flags.datesPast.join(', ')} has passed: edit or delete it.`;
      soon.hidden = !n.flags.datesSoon.length;
      soon.textContent = `Date coming up: ${n.flags.datesSoon.join(', ')}.`;
      dot.hidden = !why;
      dot.title = why;
      dot.setAttribute('aria-label', why ? `Needs tidying: ${why}` : '');
    };
    mark();
    row.addEventListener('toggle', () => openRows[row.open ? 'add' : 'delete'](key));
    rows.push({ row, n, f, mark });
    return row;
  };

  const group = (f, kind, label, hue, blurb, notes) => {
    const count = h('span', { class: 'memory-group-count' });
    const g = h('details', { class: 'memory-group', 'data-hue': hue, open: !folded.has(kind) },
      h('summary', {}, icon('forward'), h('span', { class: 'memory-group-name' }, label), count, h('span', { class: 'memory-group-why' }, blurb)),
      h('div', { class: 'settings-rows' }, ...notes.map((n) => note(f, n))));
    g.addEventListener('toggle', () => folded[g.open ? 'delete' : 'add'](kind));
    groups.push({ g, f, kind, count });
    return g;
  };

  // The header says what's true: the index is what loads, the notes wait until a session reads them.
  const header = () => {
    const f = current();
    if (!f?.reachable) { meta.textContent = 'Not reachable: this login has no memory folder for the scheme yet.'; return; }
    const ns = live(f);
    if (!ns.length && !f.index) { meta.textContent = 'No memory notes yet. The Taskmaster and minions add them as they work.'; return; }
    const lines = f.index ? f.index.replace(/\n$/, '').split('\n').length : 0;
    const bytes = new TextEncoder().encode(f.index).length;
    const used = Math.max(lines / INDEX_LINES, bytes / INDEX_BYTES);
    meta.replaceChildren(h('b', {}, 'MEMORY.md loads at every start'),
      h('span', { class: 'memory-meter', 'data-hue': used > 0.8 ? 'waiting' : 'running' }, meter(used, `${lines} of ${INDEX_LINES} lines · ${kb(bytes)} of 25 KB`)),
      h('span', { class: 'memory-rest' }, h('b', {}, plural(ns.length, 'note')), ` (${kb(ns.reduce((s, n) => s + n.bytes, 0))}) are read when needed`));
  };

  const stat = (key, n, label, hue) => h('button', { type: 'button', class: `memory-stat${filterBy === key ? ' on' : ''}`, 'data-hue': hue, 'aria-pressed': String(filterBy === key),
    onclick: () => { filterBy = filterBy === key && key !== 'all' ? 'all' : key; refresh(); } }, h('b', {}, String(n)), h('span', {}, label));

  const refresh = () => {
    const f = current();
    header();
    folderBar.hidden = folders.length < 2;
    folderBar.replaceChildren(tabs({ items: folders.map((x) => [x.id, x.reachable ? `${x.label} · ${live(x).length}` : x.label]), current: f.id, label: 'Memory folders',
      className: 'memory-folders', onSelect: (id, how) => { pickedFolder = id; refresh(); if (how?.keyboard) folderBar.querySelector('[aria-selected="true"]')?.focus(); } }).element);
    for (const [id, el] of blocks) el.hidden = id !== f.id;
    const ns = f.reachable ? live(f) : [];
    if (filterBy !== 'all' && filterBy !== 'tidy' && !ns.some((n) => kindOf(n) === filterBy)) filterBy = 'all';
    stats.hidden = !ns.length;
    stats.replaceChildren(stat('all', ns.length, ns.length === 1 ? 'note' : 'notes', 'ink'),
      ...KINDS.filter(([k]) => ns.some((n) => kindOf(n) === k)).map(([k, label, hue]) => stat(k, ns.filter((n) => kindOf(n) === k).length, label, hue)),
      stat('tidy', ns.filter(tidyReason).length, 'need tidying', 'waiting'));
    search.hidden = !ns.length;
    filter();
  };

  // A save, delete or add answers with the folder as the server now sees it: take its index and each note's flags from that.
  const sync = (f, d) => {
    const fresh = d?.folders?.find((x) => x.id === f.id);
    if (!fresh) return;
    f.index = fresh.index;
    for (const r of rows) {
      const m = r.f === f && fresh.notes.find((x) => x.file === r.n.file);
      if (m) { r.n.flags = m.flags; r.n.inIndex = m.inIndex; r.mark(); }
    }
    refresh();
  };

  const filter = () => {
    if (!folders) return;
    const q = search.value.trim().toLowerCase();
    for (const { row, n } of rows) {
      row.hidden = !!n.gone || (filterBy === 'tidy' ? !tidyReason(n) : filterBy !== 'all' && kindOf(n) !== filterBy)
        || (!!q && !`${n.name} ${n.description} ${n.text}`.toLowerCase().includes(q));
    }
    const f = current();
    let shown = 0;
    for (const { g, f: gf, kind, count } of groups) {
      const n = rows.filter((r) => r.f === gf && kindOf(r.n) === kind && !r.row.hidden).length;
      count.textContent = String(n);
      g.hidden = !n;
      if (gf === f) shown += n;
    }
    empty.hidden = !f?.reachable || !live(f).length || shown > 0;
  };

  const render = () => {
    rows.length = groups.length = 0;
    blocks.clear();
    list.replaceChildren(...folders.map((f) => {
      const el = h('div', { class: 'memory-folder' },
        !f.reachable ? emptyCard('Not reachable', 'This login has no memory folder for the scheme yet.', { mark: '!', hue: 'held' })
          : !f.notes.length ? emptyCard('No notes in this folder', 'The Taskmaster and minions add them as they work.', { mark: '∅', hue: 'accent' })
          : KINDS.map(([k, label, hue, blurb]) => {
            const ns = f.notes.filter((n) => kindOf(n) === k);
            return ns.length ? group(f, k, label, hue, blurb, ns) : '';
          }));
      blocks.set(f.id, el);
      return el;
    }), empty);
    refresh();
  };
  const load = () => api(url).then((d) => { folders = d.folders; if (folders.length) render(); else meta.textContent = 'No memory folder yet: the scheme has no repo or no login.'; },
    (err) => { meta.textContent = `Couldn't read the notes: ${err.message}`; });
  load();
  const review = tidyReview(p, load);
  return h('section', { class: 'artifacts-main people-main memory-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }),
        h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(), meta),
    review, folderBar, stats, search, list);
}
