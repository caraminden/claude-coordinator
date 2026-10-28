// The Schedules panel: the scheme's scheduled minions (src/schedules.ts), opened from the clock in
// the Minions header.
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

/** The panel in a modal: a centred box on desktop, a sheet along the bottom on phones. */
export async function openSchedules() {
  const list = h('div', { class: 'muted small' }, 'Loading…');
  const dialog = h('dialog', { class: 'schedules', 'aria-label': 'Scheduled minions' },
    h('div', { class: 'row' }, h('h2', {}, 'Scheduled minions'), h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'close', 'aria-label': 'Close', onclick: () => dialog.close() }, '×')),
    list);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  document.body.append(dialog);
  dialog.showModal();
  try {
    const { schedules } = await api(`api/projects/${view.projectId}/schedules`);
    list.replaceWith(schedules.length
      ? h('ul', { class: 'schedule-list' }, schedules.map(scheduleRow))
      : h('p', { class: 'muted' }, 'Nothing scheduled in this scheme yet.'));
  } catch (ex) {
    list.replaceWith(h('p', { class: 'error' }, ex.message));
  }
}
