// What a minion's progress line opens to (#1991, Josh's pick of 2026-11-25): where its time went, as a ribbon of working,
// waiting and lost time over its steps. src/time-log.ts cuts it; time-log.js fits it. The panel's element outlives a
// redraw of the progress line, so a click, a scroll or focus in it isn't lost to the next event.
import { api, h, heldWhilePressed, jumpHref, pacificClock, pacificClockBare, pacificDate, pacificIso, pacificStamp, view } from './base.js';
import { firstSentence, shortDuration } from './chattext.js';
import { grow, rowKey, tiles } from './time-log.js';
import { heldStep } from './progress.js';
import { failedLine } from './ui/state.js';
import { mountTips } from './ui/tip.js';

const FRESH_MS = 10_000;
/** With no turn running the last stretch only grows, which the page does itself. */
const IDLE_MS = 60_000;
/** Rows past this start behind a button, the newest showing. */
const ROWS = 30;
const ICON = { completed: '✓', in_progress: '◐', pending: '○' };
const KIND = { work: 'working', wait: 'waiting', lost: 'lost', gone: 'finished' };

/** The last log read per chat, so reopening shows it at once: {log, at, sig, busy, failed}. */
const logs = new Map();
const entryOf = (id) => {
  if (!logs.has(id)) logs.set(id, { log: null, at: 0, sig: '', busy: false, failed: '' });
  if (logs.size > 30) logs.delete(logs.keys().next().value);
  return logs.get(id);
};
/** What a change of means the log was cut too early. */
const signature = () => {
  const t = view.ticket;
  return [t.status, t.state, t.closed_at, t.wait?.stage, !!t.worker_wait, ...view.progress.tasks.map((s) => `${s.id}${s.status}${s.subject}`)].join('|');
};
const isRunning = () => view.ticket.status === 'running' && !view.ticket.worker_wait;

/** Read a minion's log unless the one held is fresh. Hovering or focusing the line reads it, so the click has it. */
export async function readLog(force = false) {
  const id = view?.ticket?.id;
  if (!id) return;
  const e = entryOf(id);
  const sig = signature();
  const age = Date.now() - e.at;
  if (e.busy || (!force && e.log && e.sig === sig && age < (isRunning() ? FRESH_MS : IDLE_MS))) return;
  if (!force && e.failed && age < FRESH_MS) return;
  e.busy = true;
  try {
    const log = await api(`/api/tickets/${id}/time-log`);
    Object.assign(e, { log, sig, failed: '' });
  } catch (err) {
    // A kept chat opens before the network is asked (`replay`, base.js): not a failure, and asked again on the next redraw.
    e.failed = err.message === 'Catching up' ? '' : err.message;
  }
  Object.assign(e, { busy: false, at: Date.now() });
  if (panel?.id === id && panel.el.isConnected) draw();
}

let panel = null;
let tips = null;
let clock = 0;

/** The panel for the chat in view, kept while that chat is. */
export function timeLogPanel() {
  const id = view.ticket.id;
  if (panel?.id !== id || panel.ui !== view.ui) {
    const top = h('div', { class: 'tl-top' });
    const list = h('div', { class: 'tl-rows' });
    panel = { id, ui: view.ui, top, list, el: h('div', { class: 'time-log' }, top, list), drawn: '' };
  }
  tips ??= mountTips(document.body, { selector: '.tl-tile[data-tip], .tl-guess[data-tip]' });
  clearInterval(clock);
  clock = setInterval(() => {
    if (!panel.el.isConnected) return clearInterval(clock);
    readLog();
    draw();
  }, FRESH_MS);
  return panel.el;
}

/** Draw the panel again, once it is on the page (the ribbon fits its width). */
export function drawTimeLog() {
  readLog();
  draw();
}

const swatch = (kind, guess = false) => h('i', { class: `tl-k ${kind}${guess ? ' guess' : ''}`, 'aria-hidden': 'true' });
const bit = (kind, ms, word = '') => h('span', { class: 'tl-bit' }, swatch(kind), shortDuration(ms), word);
const probably = (r) => r.guess && r.sub !== 'unknown' && h('span', { class: 'tl-guess', tabindex: 0, 'data-tip': 'Worked out from what is recorded around it, not recorded itself' }, 'probably');

/** The rows before a log has arrived: the plan the page already holds, with no times. */
const planRows = () => view.progress.tasks.map((t) => ({ type: 'step', title: t.subject, kind: 'work', status: t.status, outcome: t.outcome, start: null, end: null, work: 0, wait: 0, lost: 0 }));

/** A step's one line: what came of it, or where it is. */
function stepLine(r) {
  const t = view.progress.tasks.find((x) => x.subject === r.title);
  if (r.outcome) return r.outcome;
  if (r.status === 'completed') return (t?.note && firstSentence(t.note)) || t?.description || '';
  if (r.status === 'pending') return t?.description || 'Not started yet';
  if (t && heldStep(view.progress, t)) return 'Done so far, kept open in case a test sends it back';
  return isRunning() ? t?.description || '' : 'Paused here when the turn ended';
}

function rowEl(r, isLast, log) {
  const key = rowKey(r);
  const on = key && panel.ui.tlSel === key;
  const going = isLast && !log?.closed && r.type !== 'step';
  const ms = r.work + r.wait + r.lost;
  const icon = r.type === 'step' ? (ICON[r.status] ?? '○') : r.type === 'line' ? '·' : '‖';
  const line = r.type === 'step' && stepLine(r);
  const when = r.start && `${at(r.start, log)} to ${going || (r.status === 'in_progress' && isRunning()) ? 'now' : at(r.end, log)}`;
  const head = [
    h('span', { class: 'icon', 'aria-hidden': 'true' }, icon),
    h('span', { class: 'subject' }, r.type === 'line' ? firstSentence(r.title, 200) : r.title, ' ', probably(r) || ''),
    h(
      'span',
      { class: 'tl-meta' },
      r.start ? h('span', { class: 'tl-at' }, at(r.start, log)) : '',
      ms ? h('span', { class: 'tl-ms' }, shortDuration(ms)) : r.status === 'pending' ? h('span', { class: 'tl-ms' }, 'up next') : '',
      r.type !== 'wait' && r.wait > 5000 ? bit('wait', r.wait, ' waiting') : '',
      r.type !== 'wait' && r.lost > 0 ? bit('lost', r.lost, ' lost') : '',
    ),
  ];
  return h(
    'div',
    { class: `tl-row tl-${r.type}${r.status ? ` ${r.status}` : ''}${r.kind === 'lost' ? ' lost' : ''}${r.guess ? ' guess' : ''}${r.status === 'in_progress' && !isRunning() ? ' paused' : ''}${on ? ' on' : ''}`, 'data-row': key },
    key ? h('button', { class: 'tl-head', 'aria-pressed': String(!!on), title: `${when}. ${on ? 'Show the whole ribbon' : 'Show on the ribbon'}`, 'data-focus': key, onclick: () => pick(on ? null : key) }, head) : h('div', { class: 'tl-head' }, head),
    r.event ? h('a', { class: 'tl-jump', href: jumpHref(view.ticket, r.event), title: 'Show in the chat', 'aria-label': 'Show in the chat', 'data-focus': `jump ${key}` }, 'Chat ↗') : '',
    line ? h('p', { class: 'tl-note' }, line) : '',
  );
}

/** A time in the log: its day too when that isn't the day the log starts on. */
const at = (ms, log) => `${pacificIso(ms) === pacificIso(log.start) ? '' : `${pacificDate(ms)}, `}${pacificClockBare(ms)}`;

/** Pick a row (or none): its stretches light up. From a tile, `seg` is the stretch, and the row scrolls into sight. */
function pick(key, seg = null) {
  Object.assign(panel.ui, { tlSel: key, tlSeg: seg?.start ?? null });
  draw();
  if (seg && key) panel.list.querySelector('.tl-row.on')?.scrollIntoView({ block: 'nearest' });
}

const partsOf = (t) =>
  Object.entries(t.ms)
    .filter(([, ms]) => ms >= 1000)
    .sort((a, b) => b[1] - a[1])
    .map(([k, ms]) => `${KIND[k]} ${shortDuration(ms)}`)
    .join(', ');
const said = (t, log) => t.main.title ?? log.rows[t.main.row]?.title ?? '';

function ribbon(log) {
  const width = panel.el.clientWidth || 340;
  const fit = tiles(log.segs, Math.floor(width / 5));
  const key = (t) => rowKey(log.rows[t.main.row]);
  const sel = panel.ui.tlSel;
  // A long gap shows its length where it is squeezed.
  return h(
    'div',
    { class: `tl-ribbon${fit.length > width / 12 ? ' tight' : ''}${log.running ? ' live' : ''}`, role: 'group', 'aria-label': 'Where the time went, oldest first; each row below says the same' },
    fit.map((t) => {
      const words = `${at(t.start, log)} to ${at(t.end, log)} · ${partsOf(t)}${said(t, log) ? ` · ${firstSentence(said(t, log), 90)}` : ''}${t.guess && t.main.sub !== 'unknown' ? ' (probably)' : ''}`;
      const el = h(
        'button',
        {
          class: `tl-tile ${t.kind}${t.guess ? ' guess' : ''}${t.squeezed ? ' squeezed' : ''}${sel && !log.segs.some((s) => s.start >= t.start && s.end <= t.end && rowKey(log.rows[s.row]) === sel) ? ' dim' : ''}${panel.ui.tlSeg != null && panel.ui.tlSeg >= t.start && panel.ui.tlSeg < t.end ? ' sel' : ''}`,
          tabindex: -1,
          'data-tip': words,
          'aria-label': words,
          onclick: () => pick(key(t), t.main),
        },
        t.squeezed ? h('em', {}, shortDuration(t.end - t.start)) : '',
      );
      el.style.flexGrow = String(Math.max(1, Math.round(t.flex / 1000)));
      return el;
    }),
  );
}

/** The stretch a tap picked, in words: a phone has no hover. */
function picked(log) {
  if (panel.ui.tlSeg == null) return '';
  const s = log.segs.find((x) => x.start <= panel.ui.tlSeg && x.end > panel.ui.tlSeg);
  if (!s) return '';
  const title = s.title ?? log.rows[s.row]?.title ?? '';
  return h(
    'p',
    { class: 'tl-picked' },
    swatch(s.kind, s.guess),
    h('b', {}, `${at(s.start, log)} to ${s === log.segs.at(-1) && !log.closed ? 'now' : at(s.end, log)}`),
    ` ${KIND[s.kind]} ${shortDuration(s.end - s.start)}${title ? ` · ${firstSentence(title, 120)}` : ''} `,
    s.event && s.row === undefined ? h('a', { class: 'tl-jump', href: jumpHref(view.ticket, s.event) }, 'Chat ↗') : '',
    h('button', { class: 'tl-clear', 'aria-label': 'Show the whole ribbon', onclick: () => pick(null) }, '×'),
  );
}

function topOf(e, log) {
  const retry = e.failed && failedLine(`Couldn't read the time log: ${e.failed}`, { retry: () => readLog(true) });
  if (!log) return [h('div', { class: 'tl-total' }, h('b', {}, 'Where the time went'), e.failed ? '' : h('span', { class: 'muted' }, 'reading…')), h('div', { class: `tl-ribbon none${e.failed ? '' : ' busy'}` }), retry || ''];
  const { work, wait, lost, guess } = log.totals;
  if (!log.segs.length) return [h('div', { class: 'tl-total' }, 'Nothing recorded yet'), retry || ''];
  const last = log.segs.at(-1);
  return [
    h(
      'div',
      { class: 'tl-total' },
      h('b', {}, shortDuration(work + wait + lost)),
      bit('work', work, ' working'),
      bit('wait', wait, ' waiting'),
      lost >= 1000 ? bit('lost', lost, ' lost') : '',
      guess >= 60_000 ? h('span', { class: 'tl-bit tl-guess', tabindex: 0, 'data-tip': 'No record says what these stretches were: they are worked out from what is around them, and drawn paler' }, swatch('wait', true), `${shortDuration(guess)} of it guessed`) : '',
    ),
    ribbon(log),
    h('div', { class: 'tl-axis' }, h('span', {}, (pacificIso(log.start) === pacificIso(Date.now()) ? pacificClock : pacificStamp)(log.start)), h('span', {}, last.kind === 'gone' ? (log.closed ? 'dismissed' : 'finished') : log.closed ? `${at(log.end, log)}, dismissed` : 'now')),
    picked(log),
    // Explain's slot: the minion after this fills it.
    retry || '',
  ];
}

function draw() {
  if (heldWhilePressed(draw)) return;
  const e = entryOf(panel.id);
  const log = e.log && grow(e.log, Date.now() - e.at);
  const rows = log?.rows.length ? log.rows : planRows();
  const { ui, list, top } = panel;
  // A pick made on a row behind the button opens the rest.
  const cut = ui.tlAll || rows.length <= ROWS + 5 || rows.slice(0, -ROWS).some((r) => rowKey(r) && rowKey(r) === ui.tlSel) ? 0 : rows.length - ROWS;
  // Nothing changed but a second's growth: leave what the pointer is on alone.
  const drawn = JSON.stringify([rows, e.failed, !!log, ui.tlSel, ui.tlSeg, cut, isRunning(), panel.el.clientWidth, log && Math.round(log.end / FRESH_MS), view.progress.tasks.map((t) => [t.status, t.description, t.note])], (k, v) => (['work', 'wait', 'lost', 'end'].includes(k) ? Math.round(v / FRESH_MS) : v));
  if (drawn === panel.drawn) return;
  panel.drawn = drawn;
  const focus = panel.el.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  const scroller = panel.el.parentElement;
  const scroll = scroller?.scrollTop;
  top.replaceChildren(...topOf(e, log).filter(Boolean));
  const lastTimed = rows.findLastIndex((r) => r.start);
  list.replaceChildren(
    ...(cut
      ? [
          h(
            'button',
            {
              class: 'show-more tl-more',
              onclick: () => {
                ui.tlAll = true;
                draw();
              },
            },
            `Show ${cut} earlier`,
          ),
        ]
      : []),
    ...rows.slice(cut).map((r, i) => rowEl(r, i + cut === lastTimed, log)),
    ...(!rows.length && log ? [h('p', { class: 'muted empty' }, 'Nothing has run yet.')] : []),
  );
  if (scroller) scroller.scrollTop = scroll;
  if (focus) panel.el.querySelector(`[data-focus="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
}
