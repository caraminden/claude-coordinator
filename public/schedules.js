// The scheme's scheduled minions (src/schedules.ts), under Orders → Schedules (#1083, Josh picked "List in the panel,
// page on the right"): the panel lists them, standard audits then the scheme's own, each split by category, and a
// row opens its page in the main pane at #/p/N/schedules/ID. The page leads with what it does, then its status.
/** @import { View } from './types.js' */
import { ago, api, h, icon, view } from './base.js';
import { modelName } from './composer.js';
import { emptyCard, hueRow, showFirst, statTiles, toneChip } from './look.js';
import { settingsRow, settingsTabs, settingsTitle } from './settings.js';
import { optimistic } from './ui/optimistic.js';
import { briefSkills, briefSummary, groupSchedules, nextSchedule, soon, when } from './schedule-text.js';
import { loadingLine } from './ui/state.js';

/** @import { Child } from './base.js' */
/** @import { ScheduleRow } from './schedule-text.js' */
/** @typedef {{ at: number, skip?: boolean, status?: string, state?: string, number?: number | null, note?: string, cost?: number }} ScheduleRun */
/** @typedef {{ name: string, template?: boolean | string, rows: { name: string, template?: unknown }[], state: string, slug: string }} Audit */
/**
 * A schedule as src/schedules.ts lists it: the fields this page reads.
 * @typedef {ScheduleRow & { name: string, project_id: number, when: string, cron: string, brief: string, type: string, once?: boolean | number, notes?: string, model?: string | null, effort?: string | null, last_error?: string | null, last_run_at?: number | null, last_status?: string, last_state?: string, last_number?: number | null, last_cost?: number, last_skip?: string, skips14?: number, runs?: ScheduleRun[], trigger_count?: number | null, trigger_kind?: string | null, trigger_so_far?: number, trigger_gap_hours?: number | null, min_minions?: number | null, gate_scope?: string }} Schedule
 */
/** @typedef {{ projectId: number, schedules: Schedule[], audits: Audit[], error?: string }} PageData */

// A chip's tone as the hue of its row's tile and bar (Citadel's look, #1068).
/** @type {Record<string, string>} */
const HUE = { ok: 'done', warn: 'waiting', danger: 'danger', info: 'running', neutral: 'held' };

/** @param {number} n */
const money = (n) => `$${n.toFixed(n < 10 ? 2 : 0)}`;

/** @param {number | null} id */
const href = (id) => `#/p/${/** @type {View} */ (view).projectId}/schedules${id ? `/${id}` : ''}`;

/** A run's outcome chip: what the minion found (its state), "running" while it works, "error" if it broke. */
/**
 * @param {string | undefined} status
 * @param {string | undefined} state
 * @returns {[string, string, string]}
 */
function outcome(status, state) {
  if (status === 'running') return ['info', 'running', 'Its last run is working now'];
  if (status === 'error' || state === 'error') return ['danger', 'error', 'Its last run ended in an error'];
  if (state) return [state === 'complete' ? 'ok' : 'warn', state, `Its last run ended ${state}`];
  return ['neutral', 'started', 'Its last run started; it has not reported a state'];
}

/** A schedule's one status: paused, failed to start, its last run's outcome, or new. */
/**
 * @param {Schedule} s
 * @returns {[string, string, string]}
 */
function status(s) {
  return s.paused ? ['warn', 'Paused', 'It starts nothing until resumed'] : s.last_error ? ['danger', 'Failed', "Its last run didn't start"] : s.last_run_at ? outcome(s.last_status, s.last_state) : ['neutral', 'New', 'It has not run yet'];
}

/** @param {string} tone @param {string} word @param {string} [tip] */
function chip(tone, word, tip) {
  const c = toneChip(tone, word);
  if (tip) c.title = tip;
  return c;
}

/** @param {Schedule} s @param {ScheduleRun} r */
function runLine(s, r) {
  if (r.skip) return hueRow({ hue: 'held', lead: '–', meta: ago(r.at) }, h('span', { class: 'muted' }, 'skipped by the gate'));
  const [tone, word] = outcome(r.status, r.state);
  return hueRow({ hue: HUE[tone], meta: ago(r.at) }, r.number != null ? h('a', { href: `#/p/${s.project_id}/t/${r.number}` }, `#${r.number}`) : 'a deleted minion', ' ', toneChip(tone, word), r.note ? ` ${r.note}` : '', r.cost ? [' · ', h('span', { class: 'tnum' }, money(r.cost))] : '');
}

/** Each kit template against this scheme's rows: flags a missing one and two for one, and shows a deliberate omission as such. */
/** @param {Audit[]} audits */
function auditsCheck(audits) {
  const bad = audits.filter((a) => a.state !== 'ok');
  if (!bad.length) return '';
  /** @param {Audit} a */
  const line = (a) => {
    const ids = a.rows.map((r) => `"${r.name}"${r.template ? '' : ' (hand-made)'}`).join(' and ');
    if (a.state === 'left-out') return hueRow({ hue: 'held', lead: '–' }, h('span', { class: 'muted' }, `${a.name}: left out on purpose`));
    if (a.state === 'duplicate') return hueRow({ hue: 'waiting', lead: '2' }, `${a.name}: two rows, ${ids}. Delete the hand-made one.`);
    return hueRow(
      {
        hue: 'danger',
        lead: '0',
        meta: h(
          'button',
          {
            type: 'button',
            class: 'secondary small',
            onclick: async (/** @type {Event} */ e) => {
              /** @type {HTMLButtonElement} */ (e.currentTarget).disabled = true;
              try {
                await api(`api/projects/${/** @type {View} */ (view).projectId}/schedules`, { method: 'POST', body: { template: a.slug } });
              } catch (ex) {
                /** @type {HTMLButtonElement} */ (e.currentTarget).disabled = false;
                alert(/** @type {Error} */ (ex).message);
              }
            },
          },
          'Add from template',
        ),
      },
      `${a.name}: no row`,
    );
  };
  const [row] = settingsRow({ key: 'schedule-audits', icon: 'check', hue: 'waiting', title: 'Standard audits', summary: [toneChip('warn', `${bad.length} to fix`), `of ${audits.length} kit templates`] }, h('div', { class: 'hue-rows' }, bad.map(line)));
  return h('div', { class: 'settings-rows schedule-audits' }, row);
}

/** The model and effort each run starts with, when the schedule sets them; nothing for the scheme's defaults. */
/** @param {Schedule} s */
function runsAs(s) {
  const set = [s.model && modelName(s.model), s.effort && `${s.effort} effort`].filter(Boolean);
  return set.length ? h('span', { title: 'What each run starts with' }, set.join(', ')) : '';
}

// ---------- the list, in the panel ----------

/** A compact row: name and status chip, then when it runs and when next. */
/** @param {Schedule} s */
function listRow(s) {
  const [tone, word, tip] = status(s);
  return h(
    'a',
    { class: `schedule-item${s.id === current ? ' active' : ''}${s.paused ? ' paused' : ''}`, href: href(s.id), 'data-hue': s.paused ? 'held' : HUE[tone], 'aria-current': s.id === current ? 'page' : null },
    h('span', { class: 'schedule-item-top' }, h('span', { class: 'schedule-item-name' }, s.name), chip(tone, word, tip)),
    h('span', { class: 'schedule-item-sub' }, s.when, s.trigger_count != null ? ` or after ${s.trigger_count} ${s.trigger_kind}` : '', s.paused ? '' : [' · next\u00a0', h('span', { class: 'tnum' }, soon(s.next_run_at))]),
  );
}

/** @param {Schedule[]} schedules */
function scheduleList(schedules) {
  if (!schedules.length) return emptyCard('Nothing scheduled yet', 'A schedule starts a minion on a timer; ask the Taskmaster to add one.', { mark: '◷', hue: 'muted' });
  return h(
    'div',
    { class: 'schedule-groups' },
    groupSchedules(schedules).map(([title, hue, cats]) =>
      h(
        'section',
        { class: 'schedule-group', 'data-hue': hue },
        h('h3', { class: 'settings-section', 'data-hue': hue }, title, h('span', { class: 'schedule-count' }, String(cats.reduce((n, [, xs]) => n + xs.length, 0)))),
        cats.map(([c, xs]) => h('div', { class: 'schedule-cat' }, h('h4', { class: 'schedule-cat-name' }, c), h('div', { class: 'schedule-items' }, xs.map(listRow)))),
      ),
    ),
  );
}

/** The panel's list: a way back to the Orders menu, the standard-audits check, then the groups. */
function drawPane() {
  if (!paneEl?.isConnected) return;
  const back = h(
    'a',
    {
      class: 'schedules-back',
      href: `#/p/${/** @type {View} */ (view).projectId}/orders`,
      onclick: (/** @type {Event} */ e) => {
        e.preventDefault();
        /** @type {HTMLElement} */ (e.currentTarget).closest('.sidebar')?.classList.remove('show-schedules');
      },
    },
    icon('back'),
    'Orders',
  );
  const head = h('div', { class: 'schedules-pane-head' }, back, h('b', {}, 'Schedules'));
  if (!data) return paneEl.replaceChildren(head, loadingLine('Loading…'));
  if (data.error) return paneEl.replaceChildren(head, h('p', { class: 'error' }, data.error));
  paneEl.replaceChildren(head, auditsCheck(data.audits), scheduleList(data.schedules));
}

// ---------- the page, in the main pane ----------

/** Its page: what it does, its status, its runs, then rows that open on the instructions, skills, model and gate. */
/** @param {Schedule} s */
function schedulePage(s) {
  const [tone, word, tip] = status(s);
  const hue = s.paused ? 'held' : HUE[tone];
  const cron = `${s.when} (server time) · cron: ${s.cron}`;
  const std = s.template ? chip('info', 'Standard', `Follows the kit's ${s.template} template; each run gets its current text${s.notes ? ", plus this scheme's notes" : ''}`) : '';
  const skills = briefSkills(s.brief);
  const runs = s.runs ?? [];
  const lastWord = s.last_number != null ? outcome(s.last_status, s.last_state)[1] : null;
  return [
    h(
      'div',
      { class: 'schedule-head', 'data-hue': hue },
      h('span', { class: 'settings-tile' }, icon('rows')),
      h('div', { class: 'schedule-head-text' }, h('h3', {}, s.name), h('div', { class: 'schedule-chips' }, chip(tone, word, tip), std, chip('violet', s.category || 'Other', 'Its group in the list'), chip('neutral', s.type, 'The type each run gets'), s.once ? chip('neutral', 'Runs once') : '')),
      h(
        'div',
        { class: 'schedule-actions' },
        h('button', { type: 'button', class: 'secondary small', onclick: () => pause(s) }, s.paused ? 'Resume' : 'Pause'),
        h('button', { type: 'button', class: 'secondary small danger', onclick: () => confirm(`Delete the schedule "${s.name}"? Minions it already started stay.`) && remove(s) }, 'Delete'),
      ),
    ),
    // Josh (2026-11-19, on the choices page): "have a short summary of what it does as the first thing".
    h('p', { class: 'schedule-summary' }, briefSummary(s.brief) || 'No brief.'),
    statTiles(
      [s.paused ? 'Paused' : soon(s.next_run_at), s.paused ? s.when : `next run · ${s.when}`, hue],
      [s.last_number != null ? `#${s.last_number}` : '–', s.last_number != null ? `last run · ${lastWord}` : 'no run yet', s.last_number != null ? HUE[outcome(s.last_status, s.last_state)[0]] : 'held'],
      [s.last_cost ? money(s.last_cost) : '–', 'last run cost', 'accent'],
      [String(s.skips14 ?? 0), 'skipped in 14 days', 'held'],
    ),
    s.last_error ? hueRow({ hue: 'danger', lead: 'Error' }, "Last run didn't start: ", s.last_error) : '',
    h('h3', { class: 'settings-section', 'data-hue': 'teal' }, 'Recent runs'),
    runs.length
      ? h(
          'div',
          { class: 'schedule-runs-box' },
          h(
            'div',
            { class: 'schedule-strip', 'aria-hidden': 'true' },
            [...runs].reverse().map((r) => h('i', { 'data-hue': r.skip ? 'held' : HUE[outcome(r.status, r.state)[0]], class: r.skip ? 'skip' : null, title: `${when(r.at)}: ${r.skip ? 'skipped' : outcome(r.status, r.state)[1]}` })),
          ),
          showFirst({ key: `schedule-runs:${s.id}`, items: runs.map((r) => runLine(s, r)), n: 5, noun: 'runs' }),
        )
      : emptyCard('No runs yet', s.paused ? 'It is paused; resume it to run.' : `Its first run is ${when(s.next_run_at)}.`, { mark: '◷', hue: 'muted' }),
    h('h3', { class: 'settings-section', 'data-hue': 'running' }, 'What it does'),
    h(
      'div',
      { class: 'settings-rows' },
      settingsRow({ key: `schedule-brief:${s.id}`, icon: 'doc', hue: 'running', title: 'Instructions', summary: [s.template ? toneChip('info', 'From the kit') : toneChip('neutral', 'Written here'), `${s.brief.length.toLocaleString()} characters`] }, h('pre', { class: 'schedule-brief small' }, s.brief))[0],
      settingsRow(
        { key: `schedule-skills:${s.id}`, icon: 'spark', hue: 'accent', title: 'Skills it uses', summary: skills.length ? [toneChip('violet', String(skills.length)), skills.slice(0, 2).join(', ') + (skills.length > 2 ? '…' : '')] : 'None named in its brief' },
        skills.length
          ? h(
              'div',
              { class: 'schedule-skills' },
              skills.map((k) => h('a', { class: 'cui-chip', 'data-tone': 'violet', href: `#/p/${/** @type {View} */ (view).projectId}/skills` }, k)),
            )
          : h('p', { class: 'look-prose' }, 'Its brief names no skill; the run uses whatever its minion picks.'),
      )[0],
      settingsRow(
        { key: `schedule-runs-as:${s.id}`, icon: 'user', hue: 'teal', title: 'Runs as', summary: [runsAs(s) || 'the scheme’s defaults', ` · ${s.type}`] },
        h(
          'div',
          { class: 'hue-rows schedule-facts' },
          hueRow({ hue: 'accent', lead: 'Model' }, s.model ? modelName(s.model) : 'the model table’s pick'),
          hueRow({ hue: 'accent', lead: 'Effort' }, s.effort ?? 'the model table’s pick'),
          hueRow({ hue: 'teal', lead: 'Type' }, s.type),
          hueRow({ hue, lead: 'When' }, h('span', { title: cron }, s.when, s.paused ? '' : [' · next ', h('span', { title: s.next_run_at == null ? '' : new Date(s.next_run_at).toString() }, when(s.next_run_at))])),
          hueRow({ hue: 'held', lead: 'Cron' }, h('code', {}, s.cron)),
          s.trigger_count != null ? hueRow({ hue: 'teal', lead: 'Early' }, triggerText(s), h('span', { class: 'muted tnum' }, ` · ${s.trigger_so_far ?? 0} so far`)) : '',
        ),
      )[0],
      settingsRow(
        { key: `schedule-gate:${s.id}`, icon: 'shield', hue: 'waiting', title: 'When it skips', summary: s.min_minions != null ? [toneChip('warn', `Under ${s.min_minions}`), `minions since its last run${s.gate_scope === 'all' ? ', all schemes' : ''}`] : [toneChip('ok', 'Always runs'), s.last_skip ?? ''] },
        gateFields(s),
        s.last_skip ? h('p', { class: 'look-prose' }, 'Last skip: ', s.last_skip) : '',
      )[0],
      settingsRow({ key: `schedule-trigger:${s.id}`, icon: 'chart', hue: 'teal', title: 'Runs early', summary: s.trigger_count != null ? [toneChip('ok', `${s.trigger_so_far ?? 0} of ${s.trigger_count}`), triggerText(s, false)] : [toneChip('held', 'Off'), 'only on its calendar'] }, triggerFields(s))[0],
      settingsRow({ key: `schedule-cat:${s.id}`, icon: 'tag', hue: 'held', title: 'Category', summary: [toneChip('violet', s.category || 'Other'), 'its group in the list'] }, categoryField(s))[0],
    ),
  ];
}

/** Every schedule at once: what runs on a timer, the next one, and what is paused; then where to pick one. */
/** @param {Schedule[]} schedules */
function overview(schedules) {
  const live = schedules.filter((s) => !s.paused);
  const next = nextSchedule(live);
  const failed = schedules.filter((s) => s.last_error).length;
  return [
    statTiles([String(live.length), 'on a timer', 'running'], [next ? soon(next.next_run_at) : '–', next ? `next · ${next.name}` : 'nothing due', 'teal'], [String(schedules.length - live.length), 'paused or done', 'held'], failed ? [String(failed), "didn't start", 'danger'] : null),
    h('div', { class: 'schedules-pick' }, emptyCard('Pick a schedule', 'Its page shows what it does, the skills it uses, its runs, and its pause and delete.', { mark: '◷', hue: 'muted' })),
    // A phone has no panel beside it: the list sits here, and a tap opens the page full screen.
    h('div', { class: 'schedules-narrow-list' }, auditsCheck(/** @type {PageData} */ (data).audits), scheduleList(schedules)),
  ];
}

let waitingOnBlur = false;
/** @type {number | null | undefined} */
let drawnFor; // the schedule the page shows now: a redraw for the same one waits for a field being edited
function drawPage() {
  if (!pageEl?.isConnected) return;
  // Fields save on change: a redraw under one in use drops the typed text and the focus (WP5, #1858), so it waits for the blur.
  const f = document.activeElement;
  if (drawnFor === current && f && pageEl.contains(f) && f.matches('input, textarea, select')) {
    if (!waitingOnBlur) {
      waitingOnBlur = true;
      // setTimeout: at blur the next field isn't focused yet, so the redraw would still drop its click
      f.addEventListener('blur', () => setTimeout(() => ((waitingOnBlur = false), drawPage()), 0), { once: true });
    }
    return;
  }
  drawnFor = current;
  const s = current && data?.schedules?.find((x) => x.id === current);
  const head = h(
    'div',
    { class: 'ticket-head' },
    h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), h('a', { class: 'close-view', href: `#/p/${/** @type {View} */ (view).projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
    settingsTabs(),
    current ? h('a', { class: 'schedules-up', href: href(null) }, icon('back'), 'All schedules') : '',
  );
  const body = !data ? [loadingLine('Loading…')] : data.error ? [h('p', { class: 'error' }, data.error)] : s ? schedulePage(s) : current ? [emptyCard('No such schedule', 'It may have been deleted. Pick another from the list.', { mark: '?', hue: 'muted' })] : overview(data.schedules);
  pageEl.replaceChildren(head, ...body);
}

// ---------- state, saving and redraws ----------

/** @type {PageData | null} */
let data = null; // { projectId, schedules, audits } or { error }
/** @type {number | null} */
let current = null; // the schedule whose page is open
/** @type {HTMLElement | null} */
let paneEl = null;
/** @type {HTMLElement | null} */
let pageEl = null;
let token = 0;

function draw() {
  drawPane();
  drawPage();
}

/** @param {number} projectId */
async function load(projectId) {
  const mine = ++token;
  try {
    const [{ schedules }, { audits }] = await Promise.all([api(`api/projects/${projectId}/schedules`), api(`api/projects/${projectId}/schedule-audits`)]);
    if (mine === token) data = { projectId, schedules, audits };
  } catch (ex) {
    if (mine === token) data = /** @type {PageData} */ ({ projectId, error: /** @type {Error} */ (ex).message });
  }
  if (mine === token) draw();
}

/** The panel's schedules list (Orders → Schedules); drawn from what was fetched last, then fresh. */
/** @param {number} projectId @param {number | null | undefined} [id] */
export function schedulesPane(projectId, id) {
  current = id ?? null;
  if (data?.projectId !== projectId) data = null;
  paneEl = h('div', { class: 'schedules-pane' });
  drawPane();
  return paneEl;
}

/** The main pane's Schedules page: the open schedule's page, or the overview with none picked. Fetches behind. */
/** @param {number} projectId @param {number | null | undefined} [id] */
export function schedulesPage(projectId, id) {
  current = id ?? null;
  if (data?.projectId !== projectId) data = null;
  pageEl = h('section', { class: 'artifacts-main schedules-main' });
  drawPage();
  load(projectId);
  return pageEl;
}

/** Another schedule of the scheme on screen: swap the page and the list's highlight in place, no reload. False if not on it. */
/** @param {number} projectId @param {number | null | undefined} [id] */
export function openSchedule(projectId, id) {
  if (!pageEl?.isConnected || !paneEl?.isConnected || data?.projectId !== projectId) return false;
  current = id ?? null;
  paneEl.closest('.sidebar')?.classList.add('show-schedules');
  draw();
  pageEl.scrollTop = 0;
  return true;
}

/** Someone added, changed or ran a schedule: refetch if its scheme's Schedules page is open. */
/** @param {number} projectId */
export function onSchedulesChanged(projectId) {
  if ((pageEl?.isConnected || paneEl?.isConnected) && view?.projectId === projectId) load(projectId);
}

/**
 * The activity gate and one-off (#745): "Skip unless N minions since the last run" (blank always runs), whose minions
 * it counts once N is set, and Run once. Each change shows at once and saves behind.
 */
/** @param {Schedule} s */
function gateFields(s) {
  const scope = h(
    'select',
    { class: 'small', 'aria-label': 'Whose minions count', onchange: (/** @type {Event} */ e) => save(s, { gate_scope: /** @type {HTMLSelectElement} */ (e.target).value }) },
    h('option', { value: 'scheme', selected: s.gate_scope !== 'all' }, 'in this scheme'),
    h('option', { value: 'all', selected: s.gate_scope === 'all' }, 'in all schemes'),
  );
  const n = h('input', {
    type: 'number',
    min: 1,
    max: 10000,
    step: 1,
    inputmode: 'numeric',
    placeholder: 'any',
    value: s.min_minions ?? '',
    'aria-label': 'Minions needed',
    onchange: (/** @type {Event} */ e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      const v = t.value.trim();
      if (v !== '' && !(Number.isInteger(Number(v)) && Number(v) >= 1)) return t.reportValidity();
      save(s, { min_minions: v === '' ? null : Number(v) });
    },
  });
  return h(
    'div',
    { class: 'schedule-gate small' },
    h('label', { title: 'Each due slot checks first: with fewer minions made since its last real run, it skips at no cost' }, 'Skip unless ', n, ' minions since the last run'),
    s.min_minions != null ? scope : '',
    h('label', { title: 'Pause after its first real run, for a one-off' }, h('input', { type: 'checkbox', checked: !!s.once, onchange: (/** @type {Event} */ e) => save(s, { once: /** @type {HTMLInputElement} */ (e.target).checked }) }), ' Run once'),
  );
}

/** "runs after 150 ships" (#1798): its activity trigger, counted in gate_scope; the server's describeTrigger says the same for tools. */
/** @param {Schedule} s @param {boolean} [count] */
function triggerText(s, count = true) {
  return `${count ? `runs after ${s.trigger_count} ` : ''}${s.trigger_kind}${s.gate_scope === 'all' ? ' across all schemes' : ''}${s.trigger_gap_hours != null ? `, at most every ${s.trigger_gap_hours} h` : ''}`;
}

/**
 * The activity trigger (#1798): "Also run after N ships|minions since the last run" (blank: calendar only), and its floor
 * in hours (blank: a day). Checked hourly; an early run takes the coming calendar slot. Each change shows at once and saves behind.
 */
/** @param {Schedule} s */
function triggerFields(s) {
  /** @param {string} v @param {number} max */
  const whole = (v, max) => v === '' || (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= max);
  const n = h('input', {
    type: 'number',
    min: 1,
    max: 100000,
    step: 1,
    inputmode: 'numeric',
    placeholder: 'off',
    value: s.trigger_count ?? '',
    'aria-label': 'Count that runs it early',
    onchange: (/** @type {Event} */ e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      const v = t.value.trim();
      if (!whole(v, 100000)) return t.reportValidity();
      save(s, v === '' ? { trigger_count: null, trigger_kind: null, trigger_gap_hours: null } : { trigger_count: Number(v), trigger_kind: s.trigger_kind ?? 'ships' });
    },
  });
  const kind = h(
    'select',
    { class: 'small', 'aria-label': 'What it counts', onchange: (/** @type {Event} */ e) => save(s, { trigger_kind: /** @type {HTMLSelectElement} */ (e.target).value }) },
    h('option', { value: 'ships', selected: s.trigger_kind !== 'minions' }, 'ships to main'),
    h('option', { value: 'minions', selected: s.trigger_kind === 'minions' }, 'minions made'),
  );
  const gap = h('input', {
    type: 'number',
    min: 1,
    max: 720,
    step: 1,
    inputmode: 'numeric',
    placeholder: '24',
    value: s.trigger_gap_hours ?? '',
    'aria-label': 'Hours between early runs',
    onchange: (/** @type {Event} */ e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      const v = t.value.trim();
      if (!whole(v, 720)) return t.reportValidity();
      save(s, { trigger_gap_hours: v === '' ? null : Number(v) });
    },
  });
  return h(
    'div',
    { class: 'schedule-gate small' },
    h('label', { title: "Checked every hour: once this many are counted since its last real run, it runs now and takes its coming slot's place" }, 'Also run after ', n),
    s.trigger_count != null ? [kind, h('span', {}, s.gate_scope === 'all' ? ' in all schemes,' : ' in this scheme,'), h('label', { title: 'Never early within this many hours of its last run (blank is a day), and never over a run still working' }, 'at most every ', gap, ' h')] : '',
  );
}

/** Its category (#1083): any short name, with the scheme's others offered; blank puts it under Other. */
/** @param {Schedule} s */
function categoryField(s) {
  const list = `schedule-cats-${s.id}`;
  const cats = [...new Set(/** @type {PageData} */ (data).schedules.map((x) => x.category).filter(Boolean))].sort();
  return h(
    'div',
    { class: 'schedule-gate small' },
    h('label', {}, 'Show it under ', h('input', { type: 'text', maxlength: 40, list, value: s.category, placeholder: 'Other', 'aria-label': 'Category', onchange: (/** @type {Event} */ e) => save(s, { category: /** @type {HTMLInputElement} */ (e.target).value.trim().replace(/\s+/g, ' ') }) })),
    h(
      'datalist',
      { id: list },
      cats.map((c) => h('option', { value: c })),
    ),
  );
}

/**
 * Save a change: the list and page redraw with it at once, and a refusal puts the old values back. Edits to one field
 * share `sets`, so after several quick ones fail it ends at what the server last took.
 */
/**
 * @param {Schedule} s
 * @param {Record<string, unknown>} patch
 */
function save(s, patch) {
  const was = Object.fromEntries(Object.keys(patch).map((k) => [k, s[/** @type {keyof Schedule} */ (k)]]));
  optimistic({
    key: `schedule:${s.id}`,
    sets: `schedule-${Object.keys(patch).join()}:${s.id}`,
    apply: () => {
      Object.assign(s, patch);
      draw();
    },
    send: () => api(`api/schedules/${s.id}`, { method: 'PATCH', body: patch }),
    undo: () => {
      Object.assign(s, was);
      draw();
    },
    label: `change the schedule "${s.name}"`,
  });
}

// Shows at once and sends behind; the server's broadcast then refetches, and a refusal puts it back.
/** @param {Schedule} s */
function pause(s) {
  const was = s.paused;
  optimistic({
    key: `schedule:${s.id}`,
    sets: `schedule-paused:${s.id}`,
    apply: () => {
      s.paused = was ? 0 : 1;
      draw();
    },
    send: () => api(`api/schedules/${s.id}`, { method: 'PATCH', body: { paused: !was } }),
    undo: () => {
      s.paused = was;
      draw();
    },
    label: `${was ? 'resume' : 'pause'} the schedule "${s.name}"`,
  });
}

/** Delete: gone from the list at once and back to the overview; a refusal puts it back. Only its own scheme's list changes. */
/** @param {Schedule} s */
function remove(s) {
  const mine = () => data?.schedules && data.projectId === s.project_id;
  optimistic({
    key: `schedule:${s.id}`,
    apply: () => {
      if (!mine()) return;
      const d = /** @type {PageData} */ (data);
      d.schedules = d.schedules.filter((x) => x.id !== s.id);
      if (current === s.id) location.hash = href(null);
      draw();
    },
    send: () => api(`api/schedules/${s.id}`, { method: 'DELETE' }),
    undo: () => {
      const d = /** @type {PageData} */ (data);
      if (mine() && !d.schedules.some((x) => x.id === s.id)) d.schedules = [...d.schedules, s];
      draw();
    },
    label: `delete the schedule "${s.name}"`,
  });
}
