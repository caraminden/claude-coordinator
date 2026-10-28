// The scheme's scheduled minions (src/schedules.ts), shown in the Minions panel in place of the list
// by the clock in its header.
import { ago, api, h, view } from './core.js';

const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function scheduleRow(s) {
  const last = s.last_number != null
    ? h('a', { href: `#/p/${s.project_id}/t/${s.last_number}` }, `#${s.last_number}`, ' ', ago(s.last_run_at))
    : s.last_run_at ? ago(s.last_run_at) : 'not yet';
  return h('li', { class: `schedule${s.paused ? ' paused' : ''}` },
    h('div', { class: 'row' }, h('strong', { class: 'name' }, s.name), h('span', { class: 'spacer' }),
      s.paused ? h('span', { class: 'chip' }, 'paused') : h('span', { class: 'muted small', title: new Date(s.next_run_at).toString() }, 'next ', when(s.next_run_at))),
    h('div', { class: 'muted small' }, h('span', { title: `cron: ${s.cron} (server time)` }, s.when), ' · last run ', last),
    s.last_error ? h('p', { class: 'error small' }, "Last run didn't start: ", s.last_error) : '');
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
  pane.replaceChildren(h('p', { class: 'muted small' }, 'Loading…'));
  try {
    const { schedules } = await api(`api/projects/${view.projectId}/schedules`);
    pane.replaceChildren(schedules.length
      ? h('ul', { class: 'schedule-list' }, schedules.map(scheduleRow))
      : h('p', { class: 'muted' }, 'Nothing scheduled in this scheme yet.'));
  } catch (ex) {
    pane.replaceChildren(h('p', { class: 'error' }, ex.message));
  }
}
