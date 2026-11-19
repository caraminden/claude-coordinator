// The scheme's scheduled minions (src/schedules.ts), shown in the Minions panel in place of the list
// by the clock in its header.
import { ago, api, h, view } from './base.js';
import { modelName } from './composer.js';
import { optimistic } from './ui/optimistic.js';

const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const money = (n) => `$${n.toFixed(n < 10 ? 2 : 0)}`;

/** A run's outcome chip: what the minion found (its state), "running" while it works, "error" if it broke. */
function outcome(status, state) {
  if (status === 'running') return ['info', 'running', 'Its last run is working now'];
  if (status === 'error' || state === 'error') return ['danger', 'error', 'Its last run ended in an error'];
  if (state) return [state === 'complete' ? 'ok' : 'warn', state, `Its last run ended ${state}`];
  return ['neutral', 'started', 'Its last run started; it has not reported a state'];
}

/** A collapsed section opened by its button; its body is built when first opened. */
function toggle(label, body) {
  const box = h('div', { class: 'schedule-toggle-body', hidden: true });
  const btn = h('button', { type: 'button', class: 'secondary small', 'aria-expanded': 'false', onclick: () => {
    const open = box.hidden;
    if (open && !box.childElementCount) box.append(body());
    box.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  } }, label);
  return h('div', { class: 'schedule-toggle' }, btn, box);
}

function runLine(s, r) {
  if (r.skip) return h('li', { class: 'muted' }, ago(r.at), ' · skipped by the gate');
  const [tone, word] = outcome(r.status, r.state);
  return h('li', {}, r.number != null ? h('a', { href: `#/p/${s.project_id}/t/${r.number}` }, `#${r.number}`) : 'a deleted minion', ' ', ago(r.at), ' ',
    h('span', { class: 'cui-chip state-chip', 'data-tone': tone }, word), r.note ? ` ${r.note}` : '', r.cost ? [' · ', h('span', { class: 'tnum' }, money(r.cost))] : '');
}

/** Each kit template against this scheme's rows: flags a missing one and two for one, and shows a deliberate omission as such. */
function auditsCheck(audits) {
  const bad = audits.filter((a) => a.state !== 'ok');
  if (!bad.length) return '';
  const line = (a) => {
    const ids = a.rows.map((r) => `"${r.name}"${r.template ? '' : ' (hand-made)'}`).join(' and ');
    if (a.state === 'left-out') return h('li', { class: 'muted' }, `${a.name}: left out on purpose`);
    if (a.state === 'duplicate') return h('li', {}, `${a.name}: two rows, ${ids}. Delete the hand-made one.`);
    return h('li', {}, `${a.name}: no row. `, h('button', { type: 'button', class: 'secondary small', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try { await api(`api/projects/${view.projectId}/schedules`, { method: 'POST', body: { template: a.slug } }); } catch (ex) { e.currentTarget.disabled = false; alert(ex.message); }
    } }, 'Add from template'));
  };
  return h('div', { class: 'schedule-audits small' }, h('strong', {}, 'Standard audits'), h('ul', {}, bad.map(line)));
}

function scheduleRow(s) {
  const last = s.last_number != null
    ? h('a', { href: `#/p/${s.project_id}/t/${s.last_number}` }, `#${s.last_number}`, ' ', ago(s.last_run_at))
    : s.last_run_at ? ago(s.last_run_at) : '';
  // One status chip leads the row (#492); the facts stay as quiet text under the name.
  const [tone, word, tip] = s.paused ? ['warn', 'Paused', 'It starts nothing until resumed']
    : s.last_error ? ['danger', 'Failed', "Its last run didn't start"]
    : s.last_run_at ? outcome(s.last_status, s.last_state)
    : ['neutral', 'New', 'It has not run yet'];
  const cron = `${s.when} (server time) · cron: ${s.cron}`;
  return h('li', { class: `schedule${s.paused ? ' paused' : ''}`, 'data-schedule': s.id },
    h('div', { class: 'row' }, h('strong', { class: 'name' }, s.name), h('span', { class: 'spacer' }),
      // A standard audit (#799) follows the kit's template: each run gets its current text plus this scheme's notes.
      s.template ? h('span', { class: 'cui-chip', 'data-tone': 'info', title: `Follows the kit's ${s.template} template; each run gets its current text${s.notes ? ', plus this scheme\'s notes' : ''}` }, 'Standard') : '',
      h('span', { class: 'cui-chip state-chip', 'data-tone': tone, title: tip }, word)),
    h('div', { class: 'muted small', title: cron }, s.paused ? ['Would run ', s.when] : ['Next ', h('span', { title: new Date(s.next_run_at).toString() }, when(s.next_run_at)), ' · ', s.when]),
    h('div', { class: 'muted small' }, runsAs(s), s.last_run_at || s.last_number != null ? ['last run ', last] : 'not run yet'),
    s.last_note || s.last_cost ? h('div', { class: 'muted small schedule-found' }, s.last_note ? [`“${s.last_note}”`, ' '] : '', s.last_cost ? h('span', { class: 'tnum', title: 'What its last run cost, at API prices' }, money(s.last_cost)) : '') : '',
    s.skips14 ? h('div', { class: 'muted small', title: 'Slots the activity gate skipped in the last 14 days' }, `${s.skips14} skipped in 14 days`) : '',
    s.last_skip ? h('div', { class: 'muted small', title: 'The activity gate skipped this slot: no minion was made' }, s.last_skip) : '',
    s.last_error ? h('p', { class: 'error small' }, "Last run didn't start: ", s.last_error) : '',
    gateFields(s),
    toggle('Brief', () => h('pre', { class: 'schedule-brief small' }, s.brief)),
    s.runs.length ? toggle(`Last ${s.runs.length} runs`, () => h('ul', { class: 'schedule-runs small' }, s.runs.map((r) => runLine(s, r)))) : '',
    h('div', { class: 'row schedule-actions' },
      h('button', { type: 'button', class: 'secondary small', onclick: (e) => pause(s, e.currentTarget.closest('li')) }, s.paused ? 'Resume' : 'Pause'),
      h('button', { type: 'button', class: 'secondary small', onclick: (e) => confirm(`Delete the schedule "${s.name}"? Minions it already started stay.`) && remove(s, e.currentTarget.closest('li')) }, 'Delete')));
}

/**
 * The activity gate and one-off (#745): "Skip unless N minions since the last run" (blank always runs), whose minions
 * it counts once N is set, and Run once. Each change shows at once and saves behind.
 */
function gateFields(s) {
  const scope = h('select', { class: 'small', 'aria-label': 'Whose minions count', onchange: (e) => save(s, { gate_scope: e.target.value }) },
    h('option', { value: 'scheme', selected: s.gate_scope !== 'all' }, 'in this scheme'),
    h('option', { value: 'all', selected: s.gate_scope === 'all' }, 'in all schemes'));
  const n = h('input', {
    type: 'number', min: 1, max: 10000, step: 1, inputmode: 'numeric', placeholder: 'any', value: s.min_minions ?? '', 'aria-label': 'Minions needed',
    onchange: (e) => {
      const v = e.target.value.trim();
      if (v !== '' && !(Number.isInteger(Number(v)) && Number(v) >= 1)) return e.target.reportValidity();
      save(s, { min_minions: v === '' ? null : Number(v) });
    },
  });
  return h('div', { class: 'schedule-gate small' },
    h('label', { title: 'Each due slot checks first: with fewer minions made since its last real run, it skips at no cost' }, 'Skip unless ', n, ' minions since the last run'),
    s.min_minions != null ? scope : '',
    h('label', { title: 'Pause after its first real run, for a one-off' }, h('input', { type: 'checkbox', checked: !!s.once, onchange: (e) => save(s, { once: e.target.checked }) }), ' Run once'));
}

/**
 * Save a gate change: the row redraws with it at once, and a refusal puts the old values back. Edits to one field share
 * `sets`, so after several quick ones fail it ends at what the server last took; each redraw finds the row shown now.
 */
function save(s, patch) {
  const was = Object.fromEntries(Object.keys(patch).map((k) => [k, s[k]]));
  const show = (values) => {
    Object.assign(s, values);
    document.querySelector(`li.schedule[data-schedule="${s.id}"]`)?.replaceWith(scheduleRow(s));
  };
  optimistic({
    key: `schedule:${s.id}`,
    sets: `schedule-${Object.keys(patch).join()}:${s.id}`,
    apply: () => show(patch),
    send: () => api(`api/schedules/${s.id}`, { method: 'PATCH', body: patch }),
    undo: () => show(was),
    label: `change the schedule "${s.name}"`,
  });
}

// Both show at once and send behind; the server's broadcast then redraws the list, and a refusal puts the row back.
function pause(s, row) {
  const was = s.paused;
  const show = (paused) => {
    s.paused = paused;
    const next = scheduleRow(s);
    row.replaceWith(next);
    row = next;
  };
  optimistic({
    key: `schedule:${s.id}`,
    sets: `schedule-paused:${s.id}`,
    apply: () => show(!was),
    send: () => api(`api/schedules/${s.id}`, { method: 'PATCH', body: { paused: !was } }),
    undo: () => s.paused !== was && show(was), // unless something else changed it since
    label: `${was ? 'resume' : 'pause'} the schedule "${s.name}"`,
  });
}

function remove(s, row) {
  const list = row.parentNode;
  const after = row.nextSibling;
  optimistic({
    key: `schedule:${s.id}`,
    apply: () => row.remove(),
    send: () => api(`api/schedules/${s.id}`, { method: 'DELETE' }),
    undo: () => list.isConnected && list.insertBefore(row, after?.parentNode === list ? after : null),
    label: `delete the schedule "${s.name}"`,
  });
}

/** The model and effort each run starts with, when the schedule sets them; nothing for the scheme's defaults. */
function runsAs(s) {
  const set = [s.model && modelName(s.model), s.effort && `${s.effort} effort`].filter(Boolean);
  return set.length ? [h('span', { title: 'What each run starts with' }, set.join(', ')), ' · '] : '';
}

/** Someone added, changed or ran a schedule: redraw the list if it is open on that scheme. */
export function onSchedulesChanged(projectId) {
  const sidebar = document.querySelector('.sidebar.show-schedules');
  if (sidebar && view?.projectId === projectId) showSchedules(sidebar);
}

// Whether the Minions panel shows the schedules in place of the list; kept while you move between chats.
let showing = false;

/** The clock in the Minions header: swaps the minion list for the schedules and back. */
export function schedulesButton() {
  return h('button', { type: 'button', class: 'rename schedules-btn', onclick: (e) => { showing = !showing; showSchedules(e.currentTarget.closest('.sidebar')); } }, '◷');
}

/** Show the list or the schedules in `sidebar`, as `showing` says; the schedules are fetched each time they open. */
export async function showSchedules(sidebar) {
  sidebar.classList.toggle('show-schedules', showing);
  const btn = sidebar.querySelector('.schedules-btn');
  const label = showing ? 'Back to the minions' : 'Scheduled minions';
  Object.entries({ 'aria-pressed': String(showing), 'aria-label': label, title: label }).forEach(([k, v]) => btn.setAttribute(k, v));
  sidebar.querySelector(':scope > summary .label').textContent = showing ? 'Scheduled' : 'Minions';
  const pane = sidebar.querySelector('.schedules-pane');
  if (!showing) return pane.replaceChildren();
  if (!pane.childElementCount) pane.replaceChildren(h('p', { class: 'muted small' }, 'Loading…'));
  try {
    const [{ schedules }, { audits }] = await Promise.all([api(`api/projects/${view.projectId}/schedules`), api(`api/projects/${view.projectId}/schedule-audits`)]);
    pane.replaceChildren(auditsCheck(audits), schedules.length
      ? h('ul', { class: 'schedule-list' }, schedules.map(scheduleRow))
      : h('p', { class: 'muted' }, 'Nothing scheduled in this scheme yet.'));
  } catch (ex) {
    pane.replaceChildren(h('p', { class: 'error' }, ex.message));
  }
}
