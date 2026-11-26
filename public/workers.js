// The worker pool (#1868): the Status page's Workers tile (how many minion turns run at once, who has them, the size
// and the pause), and each waiting minion's place as the line moves.
import { ago, api, h, view } from './base.js';
import { hueRow, meter, toneChip } from './look.js';
import { renderProgress } from './progress-ui.js';
import { renderTyping } from './thread.js';
import { tooCold, waitsLine } from './threadstate.js';
import { optimistic } from './ui/optimistic.js';
import { lineMoved, openLine, quickLane } from './worker-line.js';

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
  const limitsOpen = new Set(); // the collapsed Limits sections that are open, by place
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
    if (how === 'stop' && !confirm(`Stop the ${plural(w.running, 'running minion turn')} now? Each carries on where it was after Resume. Taskmasters keep running.`)) return;
    set({ pause: how }, { paused: how ? { by: 'you', at: Date.now(), ...(how === 'stop' ? { stop: true } : {}) } : null }, how ? 'pause minions' : 'resume minions');
  };
  /** A change to one place's size or limits: perigee's (id 0) are the tile's own, a machine's its row's. */
  const setPlace = (place, body, next, label) => (place.id ? set({ ...body, place: place.id }, { machines: w.machines.map((m) => (m.id === place.id ? { ...m, ...next } : m)) }, `${label} on ${place.name}`) : set(body, next, label));
  const setLimit = (place, row, value) => {
    const limits = place.limits.map((l) => (l.key === row.key ? { ...l, value: value ?? l.default, ...(value === null ? { by: undefined, at: undefined } : { by: 'you', at: Date.now() }) } : l));
    return setPlace(place, { limits: { [row.key]: value } }, { limits }, `set ${row.label.toLowerCase()}`);
  };
  /** One limit: its number, what the last 7 days did against it, who set it, and Reset to default. */
  const limitRow = (place, row) => {
    const input = h('input', {
      type: 'number',
      class: 'small',
      'data-key': `limit-${place.id}-${row.key}`,
      'aria-label': row.label,
      min: row.lo,
      max: row.hi,
      step: row.unit === 'GB' ? 0.5 : 1,
      value: String(row.value),
      onchange: (e) => {
        const n = Number(e.target.value);
        if (e.target.value === '' || !Number.isFinite(n) || n === row.value) return draw();
        setLimit(place, row, n === row.default ? null : n);
      },
    });
    const crossed = row.share === undefined ? '' : `${row.unit === 'GB' ? 'under' : 'at or over'} this ${row.share}% of the last 7 days`;
    const changed = row.by ? `${row.by} changed it ${ago(row.at)}` : `default ${row.default} ${row.unit}`;
    return h(
      'div',
      { class: 'st-limit' },
      h('label', {}, h('span', {}, row.label), h('span', { class: 'st-limit-in' }, input, h('span', { class: 'muted st-limit-unit' }, row.unit))),
      h('div', { class: 'st-limit-note muted small' }, [crossed, changed].filter(Boolean).join(' · ')),
      row.by ? button(`reset-${place.id}-${row.key}`, 'Reset to default', `Put back ${row.default} ${row.unit}`, () => setLimit(place, row, null)) : '',
    );
  };
  const limitsOf = (place, line) => {
    const changed = place.limits.filter((l) => l.by).length;
    return h(
      'details',
      { class: 'st-limits', open: limitsOpen.has(place.id), ontoggle: (e) => limitsOpen[e.target.open ? 'add' : 'delete'](place.id) },
      h('summary', {}, 'Limits ', changed ? toneChip('info', `${changed} changed`) : toneChip('neutral', 'all defaults')),
      h('p', { class: 'muted small' }, line),
      ...place.limits.map((row) => limitRow(place, row)),
    );
  };
  const sizePick = (place, most) => {
    const { pool } = place;
    const sizes = [...new Set([...SIZES.slice(0, most), ...(pool.fixed ? [pool.fixed.size] : [])])].sort((a, b) => a - b);
    return h(
      'select',
      {
        class: 'small',
        'data-key': `size-${place.id}`,
        onpointerdown: () => (open = true),
        onkeydown: () => (open = true),
        onblur: () => (open = false),
        onchange: (e) => {
          open = false;
          const n = e.target.value === 'auto' ? null : Number(e.target.value);
          const { fixed: _, ...auto } = pool;
          setPlace(place, { size: n }, { size: n ?? pool.size, pool: n === null ? auto : { ...pool, fixed: { size: n, by: 'you' } } }, 'set the workers');
        },
      },
      h('option', { value: 'auto', selected: !pool.fixed }, `Auto (${pool.size})`),
      ...sizes.map((n) => h('option', { value: String(n), selected: pool.fixed?.size === n }, String(n))),
    );
  };
  /** One place's row (Josh, 2026-11-25, take S-tile): its workers, why Auto moved, and what keeps new turns off it. */
  const placeRow = (p, chip, notes, controls) =>
    h(
      'div',
      { class: 'st-place', 'data-hue': chip ? 'waiting' : 'running', 'data-place': String(p.id) },
      h('div', { class: 'st-place-head' }, h('b', {}, p.name), chip ?? ''),
      meter(p.size ? p.used / p.size : 0, `${p.used} of ${p.size} ${p.size === 1 ? 'worker' : 'workers'}`),
      ...notes.map((line) => h('div', { class: 'st-sub muted' }, line.filter(Boolean).join(' · '))),
      controls ? h('div', { class: 'st-place-act' }, ...controls) : '',
    );
  const autoLine = (m) => {
    const { pool } = m;
    if (pool.fixed) return `Set to ${pool.fixed.size} by ${pool.fixed.by}`;
    if (m.pressed && m.size <= m.min) return `Auto: at its fewest, though ${m.pressed} (CI's tests there count too)`;
    return pool.why ? `Auto: moved to ${pool.size} workers ${ago(pool.at)}, ${pool.why}` : 'Auto';
  };
  const machineRow = (m) =>
    placeRow(
      m,
      m.block && toneChip(m.away === null ? 'warn' : 'neutral', m.away === null ? 'No new turns' : m.away ? 'Away' : 'Not connected'),
      [
        [m.block && `${m.block[0].toUpperCase()}${m.block.slice(1)}`, m.waiting && `${m.waiting} waiting for it`, autoLine(m)],
        [`Cap ${m.cap}`, m.owner && (m.used ? `${m.owner}'s ${plural(m.used, 'turn')} in it, and only theirs` : `${m.owner}'s turns only`)],
      ],
      m.mine && [h('label', { class: 'small' }, 'Turns at once', sizePick(m, m.cap)), limitsOf(m, `What Auto steers by on ${m.name}. The number it takes is never over ${m.cap}, the cap set on that computer.`)],
    );
  const button = (key, text, title, onclick) => h('button', { type: 'button', class: 'cui-btn cui-small', 'data-key': key, title, onclick }, text);
  const draw = () => {
    const focused = el.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
    if (!w) return el.replaceChildren(h('h4', {}, 'Workers'), h('b', { class: 'st-value' }, failed ? `Couldn't read it: ${failed}` : 'Reading…'));
    const { pool } = w;
    page.dispatchEvent(new CustomEvent('pool', { detail: w.size })); // the mark on How many minions fit (box-capacity.js)
    const home = { id: 0, name: 'perigee', used: w.used, size: w.size, pool, limits: w.limits };
    const elsewhere = w.machines.reduce((n, m) => n + m.used, 0);
    const value = `${w.used} of ${w.size} working${elsewhere ? `, ${elsewhere} on other computers` : ''}${w.forced ? `, ${w.forced} forced` : ''}${w.lent ? ` · ${w.lent} waiting on a card` : ''}${w.waiting ? ` · ${w.waiting} waiting` : ''}`;
    const size = pool.fixed ? `Set to ${pool.fixed.size} by ${pool.fixed.by}` : `Auto, between ${w.min} and ${w.max}${pool.why ? `: moved to ${pool.size} workers ${ago(pool.at)}, ${pool.why}` : ''}`;
    const limits = limitsOf(home, "What Auto steers by. A change takes effect within 10 seconds; a set that can't work is refused with the reason.");
    // With a computer connected, perigee is one place of several and its controls are in its row.
    const places = w.machines.length
      ? h('div', { class: 'hue-rows st-places' }, placeRow(home, null, [[size], ['Takes turns first. While it is full, or someone with no computer connected waits for it, those with their own use that']], [h('label', { class: 'small' }, 'Turns at once', sizePick(home)), limits]), ...w.machines.map(machineRow))
      : null;
    el.replaceChildren(
      h('h4', {}, 'Workers'),
      h('b', { class: 'st-value' }, value),
      w.paused ? h('div', {}, toneChip('warn', `${w.paused.stop ? 'Paused and stopped' : 'Paused'} by ${w.paused.by}, ${ago(w.paused.at)}`)) : '',
      h('div', { class: 'st-sub muted' }, failed ? `Couldn't read it: ${failed}` : places ? 'Taskmasters always run' : `${size} · Taskmasters always run`),
      h('div', { class: 'st-sub muted' }, quickLane(w.lane)),
      h('div', { class: 'st-sub muted' }, waitsLine(w.waits), tooCold(w.waits) ? ' ' : '', tooCold(w.waits) ? toneChip('warn', 'over 10% cold') : ''),
      places ?? '',
      h(
        'div',
        { class: 'st-workers-act' },
        places ? '' : h('label', {}, 'Minion turns at once', sizePick(home)),
        button('line', w.waiting ? `See the line (${w.waiting})` : 'See the line', 'Who waits for a worker, next first, and who is Urgent', () => openLine()),
        ...(w.paused
          ? [button('resume', 'Resume minions', 'Waiting turns start again, and stopped ones carry on', () => pause(false)), w.paused.stop ? '' : button('stop', 'Stop running ones', 'Stop the running turns too; they carry on after Resume', () => pause('stop'))]
          : [button('pause', 'Pause new turns', 'Running turns finish; no new minion turn starts until Resume', () => pause(true)), button('stop', 'Pause and stop running ones', 'Running turns stop and carry on where they were after Resume', () => pause('stop'))]),
      ),
      places ? '' : limits,
      h(
        'div',
        { class: 'hue-rows st-line-rows' },
        ...w.people.map((p) =>
          hueRow(
            { hue: p.used || p.lane ? 'running' : 'waiting', lead: String(p.used), meta: h('span', { class: 'muted small' }, [p.lane && `${p.lane} in the quick lane`, p.lent && `${p.lent} waiting on a card`, p.waiting && `${p.waiting} waiting`, p.stalled && 'held: container full'].filter(Boolean).join(' · ')) },
            p.name,
            h('span', { class: 'muted' }, p.used ? ' working' : ''),
          ),
        ),
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
