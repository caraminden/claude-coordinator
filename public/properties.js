// The scheme's property registry: the Settings link's review count, the Properties tab and a minion's property chip.
import { api, h, icon, me, view } from './core.js';
import { settingsTabs, tuneUpButton } from './settings.js';
import { filterChoices, samePicks, valueCounts, viewPicks } from './propfilter.js';
import { renderSidebar } from './sidebar.js';

// ---------- properties (the scheme's property registry) ----------

/** A property as people read it: always with its key, since one word can be a value of two keys. */
const propertyValue = (v) => (Array.isArray(v) ? v.join(', ') : String(v));

/** The "🏷 N" chip in a minion's header; it opens to the minion's properties. */
export function propertyChip(t) {
  const entries = Object.entries(t.properties ?? {});
  const body = h('div', {});
  const chip = h('details', { class: 'prop-chip' },
    h('summary', { class: 'tag-chip', title: 'Properties', 'aria-label': `${entries.length} properties` }, h('span', { class: 'ic', 'aria-hidden': 'true' }, '🏷️'), String(entries.length)),
    h('div', { class: 'prop-pop' },
      h('h4', {}, 'Properties'),
      body,
      h('div', { class: 'foot' }, h('span', {}, 'Minions and the Taskmaster set these'), h('span', { class: 'spacer' }),
        h('a', { href: `#/p/${t.project_id}/properties` }, 'All keys'))));
  // Drawn on opening: which values the filter offers, and whether assigned exists, depend on the registry, which may load later.
  chip.addEventListener('toggle', () => {
    if (!chip.open) return;
    const assignable = propFilter.projectId === t.project_id && propFilter.keys?.some((k) => k.key === 'assigned' && k.status === 'active');
    const rows = entries.filter(([k]) => !(assignable && k === 'assigned')).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, filterLinks(t, k, v))]);
    if (assignable) rows.push(h('dt', {}, 'assigned'), h('dd', {}, assignPicker(t)));
    body.replaceChildren(rows.length ? h('dl', {}, rows) : h('p', { class: 'muted small' }, 'None yet. The minion sets its own as the work becomes clear.'));
  });
  return closeOnClickAway(chip);
}

/** Who the minion is assigned to: type a name or pick one people already go by; empty unassigns it. */
function assignPicker(t) {
  const current = t.properties?.assigned ?? '';
  const userKeys = propFilter.keys.filter((k) => k.value_kind === 'user').map((k) => k.key);
  // One spelling per person, the one already in use before the signed-in name, as the server matches them.
  const byLower = new Map();
  for (const n of [...[...view.tickets.values()].flatMap((m) => userKeys.map((k) => m.properties?.[k])), me]) if (n && !byLower.has(n.toLowerCase())) byLower.set(n.toLowerCase(), n);
  const names = [...byLower.values()].sort();
  const list = h('datalist', { id: `assign-names-${t.id}` }, names.map((n) => h('option', { value: n })));
  const note = h('span', { class: 'muted small', role: 'status' });
  const input = h('input', { type: 'text', class: 'assign-input', value: current, placeholder: 'Nobody', list: list.id, 'aria-label': 'Assigned to', maxlength: '60' });
  input.addEventListener('change', async () => {
    const name = input.value.trim();
    if (name === current) return;
    input.disabled = true;
    try {
      // The minions list and this header redraw from the broadcast that follows.
      await api(`api/tickets/${t.id}/properties`, { method: 'PUT', body: { properties: { assigned: name || null } } });
      note.textContent = name ? 'Saved' : 'Unassigned';
    } catch (err) {
      note.textContent = err.message;
    } finally {
      input.disabled = false;
    }
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  return [input, list, note];
}

/** A property's values, each a button that adds it to the minions list's filter when the filter offers it. */
function filterLinks(t, key, value) {
  const offered = propFilter.projectId === t.project_id
    && filterChoices(propFilter.keys ?? [], [t]).find((c) => c.key === key)?.values;
  if (!offered) return h('span', { class: 'pv' }, propertyValue(value));
  return [value].flat().map((v) => offered.includes(v)
    ? h('button', { type: 'button', class: 'pv pv-pick', title: `Filter the minions list by ${key}: ${v}`, onclick: (e) => {
      e.currentTarget.closest('details').open = false;
      pick(key, v, true);
    } }, String(v))
    : h('span', { class: 'pv' }, String(v)));
}

/** Close a <details> popover on a click elsewhere. */
export function closeOnClickAway(chip) {
  chip.addEventListener('toggle', () => {
    if (!chip.open) return;
    const away = (e) => {
      if (chip.contains(e.target)) return;
      chip.open = false;
      document.removeEventListener('click', away);
    };
    setTimeout(() => document.addEventListener('click', away));
  });
  return chip;
}

// ---------- the minions list's property filter ----------

// The scheme's keys, the values ticked per key, which parts of the panel are open, and the scheme's
// saved views (null until loaded), kept across minion switches like the search.
export const propFilter = { projectId: null, keys: null, picks: new Map(), open: false, openKeys: new Map(), views: null };

/**
 * Under the minions search: a Filters button that opens a panel with a collapsible checklist per
 * key, and the ticked values as chips that untick on a click.
 */
export async function renderPropFilter() {
  const el = document.getElementById('prop-filter');
  if (!el) return;
  const projectId = view.projectId;
  if (propFilter.projectId !== projectId) Object.assign(propFilter, { projectId, keys: null, picks: new Map(), open: false, openKeys: new Map(), views: null });
  if (!propFilter.keys || !propFilter.views) {
    const [reg, views] = await Promise.all([
      propFilter.keys ? { keys: propFilter.keys } : loadProperties(),
      // Views that fail to load leave the filter working without chips, and load again on the next redraw.
      propFilter.views ?? api(`api/projects/${projectId}/views`).catch(() => null),
    ]).catch(() => []);
    if (!reg || propFilter.projectId !== projectId) return;
    Object.assign(propFilter, { keys: reg.keys, views });
  }
  renderSavedViews();
  if (!el.isConnected) return;
  // Every list change redraws this, so put keyboard focus back where it was.
  const focused = el.contains(document.activeElement) ? document.activeElement.dataset.pf : null;
  const { picks } = propFilter;
  const tickets = [...view.tickets.values()];
  const open = tickets.filter((t) => t.status !== 'closed');
  const choices = filterChoices(propFilter.keys, tickets);
  if (!choices.length && !picks.size) return el.replaceChildren();
  const ticked = [...picks.values()].reduce((n, set) => n + set.size, 0);
  el.replaceChildren(
    h('button', { type: 'button', class: `tag-chip pf-toggle${ticked ? ' on' : ''}`, 'aria-expanded': String(propFilter.open), 'data-pf': 'toggle', onclick: () => {
      propFilter.open = !propFilter.open;
      renderPropFilter();
    } }, ticked ? `Filters · ${ticked}` : 'Filters'),
    ...[...picks].flatMap(([key, set]) => [...set].map((v) => h('button', { type: 'button', class: 'tag-chip pf-pick', title: `Stop filtering by ${key}: ${v}`, onclick: () => pick(key, v, false) }, `${key}: ${v} ×`))),
    picks.size ? h('button', { type: 'button', class: 'secondary small pf-clear', onclick: () => { picks.clear(); renderSidebar(); } }, 'Clear') : '',
    propFilter.open ? h('div', { class: 'pf-panel' }, choices.map((c) => filterSection(c, valueCounts(c.key, open, picks)))) : '',
  );
  if (focused) el.querySelector(`[data-pf="${CSS.escape(focused)}"]`)?.focus();
}

/** Tick or untick one value, then redraw the list (which redraws the filter). */
function pick(key, v, on) {
  const set = propFilter.picks.get(key) ?? new Set();
  if (on) set.add(v);
  else set.delete(v);
  if (set.size) propFilter.picks.set(key, set);
  else propFilter.picks.delete(key);
  renderSidebar();
}

/** A key's collapsible checklist; each value shows how many open minions it would let through, given the other keys' picks. */
function filterSection({ key, values }, counts) {
  const picked = propFilter.picks.get(key) ?? new Set();
  const sec = h('details', { class: 'pf-key', open: propFilter.openKeys.get(key) ?? picked.size > 0 },
    h('summary', { 'data-pf': `key:${key}` }, key, picked.size ? h('span', { class: 'pf-n' }, String(picked.size)) : ''),
    values.map((v) => {
      const n = counts.get(v) ?? 0;
      return h('label', { class: n ? 'pf-opt' : 'pf-opt none' },
        h('input', { type: 'checkbox', checked: picked.has(v), 'data-pf': `value:${key}:${v}`, onchange: (e) => pick(key, v, e.target.checked) }),
        String(v), h('span', { class: 'pf-n' }, String(n)));
    }));
  sec.addEventListener('toggle', () => propFilter.openKeys.set(key, sec.open));
  return sec;
}

/** This person's saved views in the scheme as chips above the filter: a click ticks a view's values, ＋ saves the ticks as one. */
function renderSavedViews() {
  const el = document.getElementById('saved-views');
  const { picks, keys, views } = propFilter;
  if (!el || !views) return;
  const apply = (next) => {
    propFilter.picks = next;
    renderSidebar();
  };
  const chips = views.map((v) => {
    const vp = viewPicks(v.picks, keys);
    const on = picks.size > 0 && samePicks(picks, vp);
    return h('span', { class: `tag-chip sv${on ? ' on' : ''}` },
      h('button', { type: 'button', class: 'sv-name', 'aria-pressed': String(on), title: on ? 'Show every minion again' : 'Show only these minions',
        onclick: () => apply(on ? new Map() : vp) }, v.name),
      on ? h('button', { type: 'button', class: 'sv-del', title: `Delete the view ${v.name}`, 'aria-label': `Delete the view ${v.name}`, onclick: () => deleteView(v) }, '🗑') : '');
  });
  const unsaved = picks.size > 0 && !views.some((v) => samePicks(picks, viewPicks(v.picks, keys)));
  el.replaceChildren(...chips, unsaved ? h('button', { type: 'button', class: 'secondary small sv-save', onclick: saveView }, '＋ Save view') : '');
}

async function saveView() {
  const name = prompt('Name this view (only you see it):')?.trim();
  if (!name) return;
  if (propFilter.views.some((v) => v.name === name) && !confirm(`Replace the view "${name}" with what's ticked now?`)) return;
  const picks = Object.fromEntries([...propFilter.picks].map(([k, set]) => [k, [...set]]));
  const projectId = propFilter.projectId;
  const views = await api(`api/projects/${projectId}/views`, { method: 'POST', body: { name, picks } }).catch((err) => alert(`Could not save the view: ${err.message}`));
  if (views && propFilter.projectId === projectId) {
    propFilter.views = views;
    renderSavedViews();
  }
}

async function deleteView(v) {
  if (!confirm(`Delete the view "${v.name}"? What's ticked stays ticked.`)) return;
  const projectId = propFilter.projectId;
  const views = await api(`api/projects/${projectId}/views/${v.id}`, { method: 'DELETE' }).catch((err) => alert(`Could not delete the view: ${err.message}`));
  if (views && propFilter.projectId === projectId) {
    propFilter.views = views;
    renderSavedViews();
  }
}

/** This person saved or deleted a view in this scheme, maybe in another tab. */
export function onViewsChanged(projectId, name) {
  if (name !== me || view?.kind !== 'project' || projectId !== view.projectId || propFilter.projectId !== projectId) return;
  propFilter.views = null;
  renderPropFilter();
}

/** Whether people on this scheme's page change a key: its own keys, and global ones only on Citadel's. */
const keyEditable = (reg, k) => k.scope === 'scheme' || reg.globalOwner === view.projectId;

/** What waits on a person: proposed keys and values, and values a Taskmaster added. */
function toReview(reg) {
  return reg.keys.filter((k) => keyEditable(reg, k)).flatMap((k) => [
    ...(k.status === 'proposed' ? [k.key] : []),
    ...k.values.filter((v) => v.status === 'proposed' || (v.status === 'active' && !v.reviewed)).map((v) => `${k.key}: ${v.value}`),
  ]);
}

async function loadProperties() {
  const projectId = view.projectId;
  const reg = await api(`api/projects/${projectId}/properties`);
  return view?.projectId === projectId ? reg : null;
}

/** The overview's Settings link and the Settings page's Properties tab: how many property proposals wait for a person's review. */
export async function renderSettingsCount() {
  const counts = () => [...document.querySelectorAll('#settings-count, .settings-tabs .props-count')];
  if (!counts().length) return;
  const reg = await loadProperties().catch(() => null);
  if (!reg) return;
  const waiting = toReview(reg).length;
  // Looked up again after the fetch: a route change meanwhile may have drawn new ones.
  for (const el of counts()) {
    el.textContent = waiting || '';
    el.title = waiting ? `${waiting} properties to review` : '';
    el.hidden = !waiting;
  }
}

export function onPropertiesChanged(projectId) {
  if (view?.kind !== 'project' || (projectId !== null && projectId !== view.projectId)) return;
  renderSettingsCount();
  propFilter.keys = null;
  renderPropFilter();
  if (view.main === 'properties') renderPropertiesPage();
}

/** Main panel: the registry as this scheme sees it, with proposals to settle and forms to add to it. */
export function propertiesPage() {
  const p = view.project;
  const section = h('section', { class: 'artifacts-main props-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, h('h2', {}, 'Settings'), h('span', { class: 'spacer' }), tuneUpButton(),
        h('a', { class: 'close-view', href: `#/p/${p.id}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, 'The keys and values minions and their files carry. Aliases resolve to their value; nothing else can be set.')),
    h('div', { id: 'props-body', class: 'props-body' }, h('p', { class: 'muted' }, 'Loading…')));
  setTimeout(renderPropertiesPage);
  return section;
}

async function renderPropertiesPage() {
  const body = document.getElementById('props-body');
  if (!body) return;
  let reg;
  try {
    reg = await loadProperties();
  } catch (err) {
    body.replaceChildren(h('p', { class: 'muted' }, err.message));
    return;
  }
  if (!reg || !body.isConnected) return;
  const status = h('p', { class: 'muted small', role: 'status' });
  const run = async (path, payload, done) => {
    status.textContent = '';
    try {
      const r = await api(`api/projects/${view.projectId}/properties/${path}`, { method: 'POST', body: payload });
      if (r.warnings?.length) return r.warnings;
      done?.();
      renderPropertiesPage();
      renderSettingsCount();
    } catch (err) {
      status.textContent = err.message;
    }
    return null;
  };
  const review = (k, v, action, extra = {}) => run('review', { key: k.key, value: v?.value, action, ...extra });
  const btn = (label, title, onclick) => h('button', { type: 'button', class: 'secondary small', title, onclick }, label);

  const keyBlock = (k) => {
    const edit = keyEditable(reg, k);
    const kind = k.value_kind === 'integer' ? 'a whole number' : k.value_kind === 'user' ? "a person's login name" : k.value_kind === 'text' ? 'free text' : k.multi ? 'one or more values' : 'one value';
    const values = k.values.filter((v) => v.status !== 'archived');
    const archived = k.values.filter((v) => v.status === 'archived');
    const valueChip = (v) => {
      const flag = v.status === 'proposed' ? 'proposed' : !v.reviewed ? 'new' : '';
      const actions = !edit ? [] : v.status === 'proposed'
        ? [btn('Approve', `Make ${k.key}: ${v.value} usable`, () => review(k, v, 'approve')), btn('Reject', 'Drop the proposal', () => review(k, v, 'reject'))]
        : [
          flag ? btn('Approve', `Mark ${k.key}: ${v.value} as reviewed`, () => review(k, v, 'approve')) : '',
          btn('Merge…', `Fold ${v.value} into another value: it becomes an alias, and what carries it moves over`, () => {
            const into = prompt(`Merge ${k.key}: ${v.value} into which value?\n${values.filter((o) => o !== v && o.status === 'active').map((o) => o.value).join(', ')}`);
            if (into) review(k, v, 'merge', { into: into.trim() });
          }),
          btn('Archive', 'Stop offering it; what has it keeps it', () => review(k, v, 'archive')),
        ];
      return h('div', { class: `pv-row${flag ? ` ${flag}` : ''}` },
        h('span', { class: 'pv' }, v.value),
        v.aliases.length ? h('span', { class: 'muted small' }, `also ${v.aliases.join(', ')}`) : '',
        flag ? h('span', { class: 'pv-flag' }, flag === 'new' ? `new · ${v.created_by}` : `proposed · ${v.created_by}`) : '',
        v.description ? h('span', { class: 'muted small pv-desc' }, v.description) : '',
        h('span', { class: 'spacer' }), ...actions);
    };
    const addForm = () => {
      const value = h('input', { type: 'text', placeholder: 'new value', 'aria-label': `New ${k.key} value`, autocomplete: 'off' });
      const aliases = h('input', { type: 'text', placeholder: 'aliases, comma-separated', 'aria-label': 'Aliases', autocomplete: 'off' });
      const warn = h('div', { class: 'pv-warn' });
      const add = async (force) => {
        const payload = { key: k.key, force, values: [{ value: value.value.trim(), aliases: aliases.value.split(',').map((a) => a.trim()).filter(Boolean) }] };
        const warnings = await run('values', payload);
        warn.replaceChildren(...(warnings ? [h('span', {}, warnings.join(' ')), btn('Add anyway', 'It really is different', () => add(true))] : []));
      };
      return h('form', { class: 'row pv-add', onsubmit: (e) => { e.preventDefault(); if (value.value.trim()) add(false); } },
        value, aliases, h('button', { type: 'submit', class: 'small' }, 'Add'), warn);
    };
    // Approving a key approves every value listed under it too.
    const waiting = values.filter((v) => v.status === 'proposed' || !v.reviewed).length;
    const approveKey = waiting ? `Approve key + ${waiting} value${waiting === 1 ? '' : 's'}` : 'Approve key';
    return h('div', { class: `prop-key${k.status === 'proposed' ? ' proposed' : ''}` },
      h('div', { class: 'row' },
        h('code', { class: 'prop-key-name' }, k.key), h('span', {}, k.label),
        h('span', { class: 'muted small' }, `${kind}${k.status === 'proposed' ? ` · proposed by ${k.created_by}` : ''}`),
        h('span', { class: 'spacer' }),
        edit && k.status === 'proposed' ? [btn(approveKey, waiting ? 'Make it and its values usable; archive or merge single values after' : 'Make it usable', () => review(k, null, 'approve')), btn('Reject', 'Drop the proposal', () => review(k, null, 'reject'))] : ''),
      k.description ? h('p', { class: 'muted small prop-desc' }, k.description) : '',
      values.length ? h('div', { class: 'pv-list' }, values.map(valueChip)) : '',
      archived.length ? h('p', { class: 'muted small' }, 'Archived: ', archived.map((v) => [v.value, ' ', edit ? btn('Restore', `Offer ${v.value} again`, () => review(k, v, 'restore')) : '', ' '])) : '',
      edit && k.value_kind === 'enum' && k.status !== 'archived' ? addForm() : '');
  };

  const newKeyForm = () => {
    const key = h('input', { type: 'text', placeholder: 'camelCase key', 'aria-label': 'Key', autocomplete: 'off' });
    const label = h('input', { type: 'text', placeholder: 'Label', 'aria-label': 'Label', autocomplete: 'off' });
    const description = h('input', { type: 'text', placeholder: 'What it means and when to set it', 'aria-label': 'Description', autocomplete: 'off' });
    const kind = h('select', { 'aria-label': 'Kind of value' }, ['enum', 'integer', 'user', 'text'].map((v) => h('option', { value: v }, { enum: 'a list of values', integer: 'a whole number', user: 'a login name', text: 'free text' }[v])));
    const multi = h('input', { type: 'checkbox' });
    const global = h('input', { type: 'checkbox' });
    const warn = h('div', { class: 'pv-warn' });
    const add = async (force) => {
      const warnings = await run('keys', { key: key.value.trim(), label: label.value, description: description.value, value_kind: kind.value, multi: multi.checked, global: global.checked, force });
      warn.replaceChildren(...(warnings ? [h('span', {}, warnings.join(' ')), btn('Add anyway', 'It really is different', () => add(true))] : []));
    };
    return h('form', { class: 'prop-new-key', onsubmit: (e) => { e.preventDefault(); if (key.value.trim()) add(false); } },
      h('h3', { class: 'settings-label' }, 'New key'),
      h('div', { class: 'row pv-add' }, key, label, kind, h('label', { class: 'small' }, multi, ' several'),
        reg.globalOwner === view.projectId ? h('label', { class: 'small' }, global, ' every scheme') : ''),
      h('div', { class: 'row pv-add' }, description, h('button', { type: 'submit', class: 'small' }, 'Add key')),
      warn);
  };

  const live = (k) => k.status !== 'archived';
  const global = reg.keys.filter((k) => k.scope === 'global' && live(k));
  const own = reg.keys.filter((k) => k.scope === 'scheme' && live(k));
  body.replaceChildren(...[
    status,
    h('h3', { class: 'settings-label' }, 'All schemes'),
    reg.globalOwner === view.projectId ? '' : h('p', { class: 'muted small' }, 'These belong to the whole app; change them from the Citadel scheme.'),
    ...global.map(keyBlock),
    h('h3', { class: 'settings-label' }, view.project.name),
    ...(own.length ? own.map(keyBlock) : [h('p', { class: 'muted small' }, 'No keys of its own yet.')]),
    newKeyForm(),
  ].filter(Boolean));
}
