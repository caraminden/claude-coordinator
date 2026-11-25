// The worker pool (#1868): the Status page's Workers tile (how many minion turns run at once, who has them, the size
// and the pause), and each waiting minion's place as the line moves.
import { ago, api, h, view } from './base.js';
import { hueRow, toneChip } from './look.js';
import { renderProgress } from './progress-ui.js';
import { renderTyping } from './thread.js';
import { optimistic } from './ui/optimistic.js';
import { lineMoved, openLine } from './worker-line.js';

const READ_MS = 3_000;
const SIZES = Array.from({ length: 50 }, (_, i) => i + 1);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The line moved: `line` is every waiting minion's id, next first, `paused` who paused them all. */
export function onWorkers({ line, paused }) {
  lineMoved();
  if (view?.kind !== 'project') return;
  const place = new Map(line.map((id, i) => [id, i + 1]));
  for (const t of [...view.tickets.values(), view.ticket]) {
    if (t?.worker_wait && place.has(t.id)) Object.assign(t.worker_wait, { place: place.get(t.id), of: line.length, paused });
  }
  renderTyping();
  renderProgress();
}

/** The tile, reading the pool every 3 s while `page` shows. */
export function workersPanel(page) {
  let w = null;
  let failed = null;
  let first = true; // the page is put in after this returns
  let open = false; // the size list
  let limitsOpen = false; // the collapsed Limits section
  let sent = 0; // changes on their way: a read started before one lands would show the old state
  const el = h('section', { class: 'st-tile wide st-lines st-workers', 'data-tile': 'workers' });
  const set = (body, next, label) => {
    const was = w;
    sent++;
    return optimistic({
      key: el,
      apply: () => {
        w = { ...w, ...next };
        draw();
      },
      send: () => api('api/workers', { method: 'PUT', body }),
      undo: () => {
        w = was;
        draw();
      },
      label,
    })
      .then((now) => {
        w = now;
        draw();
      })
      .catch(() => {})
      .finally(() => sent--);
  };
  const pause = (how) => {
    if (how === 'stop' && !confirm(`Stop the ${plural(w.used, 'running minion turn')} now? Each carries on where it was after Resume. Taskmasters keep running.`)) return;
    set({ pause: how }, { paused: how ? { by: 'you', at: Date.now(), ...(how === 'stop' ? { stop: true } : {}) } : null }, how ? 'pause minions' : 'resume minions');
  };
  const setLimit = (row, value) => {
    const limits = w.limits.map((l) => (l.key === row.key ? { ...l, value: value ?? l.default, ...(value === null ? { by: undefined, at: undefined } : { by: 'you', at: Date.now() }) } : l));
    return set({ limits: { [row.key]: value } }, { limits }, `set ${row.label.toLowerCase()}`);
  };
  /** One limit: its number, what the last 7 days did against it, who set it, and Reset to default. */
  const limitRow = (row) => {
    const input = h('input', {
      type: 'number',
      class: 'small',
      'data-key': `limit-${row.key}`,
      'aria-label': row.label,
      min: row.lo,
      max: row.hi,
      step: row.unit === 'GB' ? 0.5 : 1,
      value: String(row.value),
      onchange: (e) => {
        const n = Number(e.target.value);
        if (e.target.value === '' || !Number.isFinite(n) || n === row.value) return draw();
        setLimit(row, n === row.default ? null : n);
      },
    });
    const crossed = row.share === undefined ? '' : `${row.unit === 'GB' ? 'under' : 'at or over'} this ${row.share}% of the last 7 days`;
    const changed = row.by ? `${row.by} changed it ${ago(row.at)}` : `default ${row.default} ${row.unit}`;
    return h(
      'div',
      { class: 'st-limit' },
      h('label', {}, h('span', {}, row.label), h('span', { class: 'st-limit-in' }, input, h('span', { class: 'muted st-limit-unit' }, row.unit))),
      h('div', { class: 'st-limit-note muted small' }, [crossed, changed].filter(Boolean).join(' · ')),
      row.by ? button(`reset-${row.key}`, 'Reset to default', `Put back ${row.default} ${row.unit}`, () => setLimit(row, null)) : '',
    );
  };
  const button = (key, text, title, onclick) => h('button', { type: 'button', class: 'cui-btn cui-small', 'data-key': key, title, onclick }, text);
  const draw = () => {
    const focused = el.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
    if (!w) return el.replaceChildren(h('h4', {}, 'Workers'), h('b', { class: 'st-value' }, failed ? `Couldn't read it: ${failed}` : 'Reading…'));
    const { pool } = w;
    const changed = w.limits.filter((l) => l.by).length;
    const value = `${w.used} of ${w.size} working${w.waiting ? ` · ${w.waiting} waiting` : ''}`;
    const size = pool.fixed ? `Set to ${pool.fixed.size} by ${pool.fixed.by}` : `Auto, between ${w.min} and ${w.max}${pool.why ? `: moved to ${pool.size} ${ago(pool.at)}, ${pool.why}` : ''}`;
    const sizes = [...new Set([...SIZES, ...(pool.fixed ? [pool.fixed.size] : [])])].sort((a, b) => a - b);
    const pick = h(
      'select',
      {
        class: 'small',
        'data-key': 'size',
        onpointerdown: () => (open = true),
        onkeydown: () => (open = true),
        onblur: () => (open = false),
        onchange: (e) => {
          open = false;
          const n = e.target.value === 'auto' ? null : Number(e.target.value);
          const { fixed: _, ...auto } = pool;
          set({ size: n }, { size: n ?? pool.size, pool: n === null ? auto : { ...pool, fixed: { size: n, by: 'you' } } }, 'set the workers');
        },
      },
      h('option', { value: 'auto', selected: !pool.fixed }, `Auto (${pool.size})`),
      ...sizes.map((n) => h('option', { value: String(n), selected: pool.fixed?.size === n }, String(n))),
    );
    el.replaceChildren(
      h('h4', {}, 'Workers'),
      h('b', { class: 'st-value' }, value),
      w.paused ? h('div', {}, toneChip('warn', `${w.paused.stop ? 'Paused and stopped' : 'Paused'} by ${w.paused.by}, ${ago(w.paused.at)}`)) : '',
      h('div', { class: 'st-sub muted' }, failed ? `Couldn't read it: ${failed}` : `${size} · Taskmasters always run`),
      h(
        'div',
        { class: 'st-workers-act' },
        h('label', {}, 'Minion turns at once', pick),
        button('line', w.waiting ? `See the line (${w.waiting})` : 'See the line', 'Who waits for a worker, next first, and who is Urgent', () => openLine()),
        ...(w.paused
          ? [button('resume', 'Resume minions', 'Waiting turns start again, and stopped ones carry on', () => pause(false)), w.paused.stop ? '' : button('stop', 'Stop running ones', 'Stop the running turns too; they carry on after Resume', () => pause('stop'))]
          : [button('pause', 'Pause new turns', 'Running turns finish; no new minion turn starts until Resume', () => pause(true)), button('stop', 'Pause and stop running ones', 'Running turns stop and carry on where they were after Resume', () => pause('stop'))]),
      ),
      h(
        'details',
        { class: 'st-limits', open: limitsOpen, ontoggle: (e) => (limitsOpen = e.target.open) },
        h('summary', {}, 'Limits ', changed ? toneChip('info', `${changed} changed`) : toneChip('neutral', 'all defaults')),
        h('p', { class: 'muted small' }, "What Auto steers by. A change takes effect within 10 seconds; a set that can't work is refused with the reason."),
        ...w.limits.map(limitRow),
      ),
      h(
        'div',
        { class: 'hue-rows st-line-rows' },
        ...w.people.map((p) => hueRow({ hue: p.used ? 'running' : 'waiting', lead: String(p.used), meta: h('span', { class: 'muted small' }, `${p.waiting ? `${p.waiting} waiting` : ''}${p.stalled ? ' · held: container full' : ''}`) }, p.name, h('span', { class: 'muted' }, p.used ? ' working' : ''))),
      ),
    );
    if (focused) el.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  };
  const load = async () => {
    if (!page.isConnected && !first) return;
    first = false;
    if (!document.hidden && !sent && (el.isConnected || w === null)) {
      try {
        const now = await api('api/workers');
        if (!sent) w = now;
        failed = null;
      } catch (err) {
        failed = err.message;
      }
      // An open size list would close under the redraw.
      if (!open && !el.querySelector('.st-limits input:focus')) draw();
    }
    setTimeout(load, READ_MS);
  };
  draw();
  load();
  return el;
}
