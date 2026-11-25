// The line for a worker as a drawer, opened from any waiting minion's chip and the Workers tile, and the Urgent mark
// (#1889; Josh, 2026-11-24: "W1 · A drawer, opened from any waiting minion"; 'make that a button on a minion, mark it as
// "urgent"'). The server's order and what Urgent means: src/turn-line.ts, src/urgent.ts.
import { api, h, me, view } from './base.js';
import { renderSidebar } from './sidebar.js';
import { renderTicketHead } from './thread-head.js';
import { openDialog } from './ui/dialog.js';
import { optimistic } from './ui/optimistic.js';
import { toast } from './ui/status.js';
import { emptyCard } from './look.js';
import { dragReorder } from './reorder.js';
import { applyMove, dropped, lineGroups, lineWhy, nextUrgent } from './worker-linemath.js';

const READ_MS = 10_000;
const HOW = 'Next first. Drag one into Urgent to send it ahead; drag it below to let the order choose.';
const ops = []; // moves on their way to the server, or shown until a read has them
let open = null; // the drawer: { dialog, list, line, workers, failed }
let reads = 0;
let latest = null;

// ---------- marking one Urgent ----------

const minionObjects = (id) => new Set([view?.tickets?.get(id), view?.ticket?.id === id && view.ticket].filter(Boolean));

/**
 * Mark or unmark `row` ({ ticket, number, title }): it shows at once here, in its header and its row, and the request
 * runs behind; a refusal puts it back with a toast and a Retry.
 */
export function setUrgent(row, on, before, { undoing = false } = {}) {
  const id = row.ticket;
  const g = shown();
  const wasOn = g ? g.urgent.some((r) => r.ticket === id) : [...minionObjects(id)].some((t) => t.urgent);
  const back = wasOn && g ? nextUrgent(g, id) : undefined;
  const was = new Map([...minionObjects(id)].map((t) => [t, t.urgent ?? null]));
  const op = { row, on, before, by: me, dead: false };
  const name = `#${row.number}`;
  const others = [...was.values(), g?.urgent.find((r) => r.ticket === id)].some((u) => u?.kind && u.kind !== 'person'); // the server can't take its reason back from a press
  const show = (mark) => {
    for (const t of minionObjects(id)) t.urgent = mark === undefined ? (was.get(t) ?? null) : mark;
    renderSidebar();
    if (view?.id === id) renderTicketHead();
    draw();
  };
  if (!undoing)
    toast(on && wasOn ? `Moved ${name} in Urgent` : on ? `${name} is Urgent: it goes ahead of the line` : `${name} is no longer Urgent${others ? '. Undo marks it as yours' : ''}`, {
      undo: { run: () => setUrgent(row, wasOn, wasOn ? back : undefined, { undoing: true }), live: () => !op.dead },
    });
  return optimistic({
    key: 'urgent', // each move's `before` counts on the ones ahead of it
    sets: `urgent:${id}`,
    apply: () => {
      op.dead = false;
      if (!ops.includes(op)) ops.push(op);
      const marked = [...minionObjects(id)].find((t) => t.urgent)?.urgent;
      show(on ? (marked?.kind === 'person' ? marked : { kind: 'person', by: me, at: Date.now() }) : null);
    },
    send: () => api(`api/tickets/${id}/urgent`, { method: 'PUT', body: { on, ...(before === undefined ? {} : { before }) } }),
    undo: () => {
      op.dead = true;
      drop(op);
      show(undefined);
    },
    label: `${on ? (wasOn ? 'move' : 'mark') : 'unmark'} ${name} ${on && wasOn ? 'in Urgent' : 'Urgent'}`,
  })
    .then(async ({ urgent }) => {
      if (!ops.some((o) => o !== op && !o.dead && o.row.ticket === id)) for (const t of minionObjects(id)) t.urgent = urgent; // a later press shows its own
      await read();
      drop(op);
      draw();
      renderSidebar();
      if (view?.id === id) renderTicketHead();
    })
    .catch(() => {
      drop(op); // a later press stands in its place, or it's rolled back
      draw();
    });
}

const drop = (op) => ops.includes(op) && ops.splice(ops.indexOf(op), 1);

/** The header's and the right-click menu's toggle for a minion. */
export const toggleUrgent = (t) => setUrgent({ ticket: t.id, project: t.project_id, number: t.number ?? t.id, title: t.title, waiting: !!t.worker_wait }, !t.urgent);

/** Who set it, and why, as words: "Urgent, by Josh". */
export const urgentSaid = (u) => `Urgent, by ${u.by}${u.reason ? `: ${u.reason}` : ''}`;

/** The header's button: press to mark it, again to take it off; pressed, it names who set it. */
export function urgentButton(t) {
  if (t.status === 'closed') return '';
  const u = t.urgent;
  return h(
    'button',
    {
      type: 'button',
      'data-part': 'urgent-minion',
      class: `note-btn urgent-btn${u ? ' on' : ''}`,
      title: u ? `${urgentSaid(u)}. Press to take it off` : 'Mark it Urgent: it goes to the top of the line when it wants a worker, until it ships',
      'aria-label': u ? `Urgent, set by ${u.by}` : 'Urgent',
      'aria-pressed': String(!!u),
      onclick: () => toggleUrgent(t),
    },
    h('span', { class: 'urgent-bang', 'aria-hidden': 'true' }, '!'),
    h('span', {}, u ? `Urgent · ${u.by}` : 'Urgent'),
  );
}

/** A minion row's red mark in the list. */
export const urgentMark = (t) => h('span', { class: 'urgent-mark', role: 'img', 'aria-label': urgentSaid(t.urgent), title: urgentSaid(t.urgent) }, '!');

// ---------- the drawer ----------

const shown = () => (open?.line ? ops.reduce(applyMove, lineGroups(open.line)) : null);

/** Someone's place changed (the server says so on every move and wait), so an open drawer reads again. */
export const lineMoved = () => open && read();

/** Open the line; the minion it was opened from is outlined in it. */
export function openLine(from = null) {
  if (open) return;
  const list = h('ol', { class: 'line-rows' });
  const body = h('div', { class: 'line-drawer-body' }, h('div', { class: 'line-pool' }), h('p', { class: 'line-how muted small' }, HOW), list);
  const onHash = () => dialog.close();
  const gutter = innerWidth - document.documentElement.clientWidth;
  const dialog = openDialog({
    title: 'The line',
    body,
    className: 'line-drawer',
    onClose: () => {
      removeEventListener('hashchange', onHash);
      open = null;
    },
  });
  addEventListener('hashchange', onHash);
  document.documentElement.style.setProperty('--line-gutter', `${gutter}px`);
  open = { dialog, list, line: null, workers: null, failed: null, from };
  dragReorder(list, {
    items: () => [...list.querySelectorAll(':scope > li[data-item]')],
    onDrop: (a, b) => {
      const move = dropped(open.drawn, a, b); // the rows it was dropped among: a read since then waits for the drop
      if (!move) return toast('Below Urgent the order is automatic. Drop it in Urgent to send it ahead.');
      open.dropping = true; // the drag already slid the rows there
      setUrgent(move.row, move.on, move.before);
      if (open) open.dropping = false;
    },
  });
  list.addEventListener('click', (e) => e.target.closest('a') && !(e.ctrlKey || e.metaKey || e.shiftKey) && dialog.close());
  draw();
  read();
  const mine = open;
  const timer = setInterval(() => (open === mine ? document.hidden || read() : clearInterval(timer)), READ_MS);
}

/** Read the line again; settles once a read started no earlier than this call shows. */
function read() {
  if (!open) return;
  latest = fetchLine();
  return latest;
}

async function fetchLine() {
  const n = ++reads;
  try {
    const [line, workers] = await Promise.all([api('api/line'), api('api/workers')]);
    if (n !== reads) return latest;
    if (!open) return;
    Object.assign(open, { line, workers, failed: null });
  } catch (err) {
    if (n !== reads) return latest;
    if (!open) return;
    open.failed = err.message;
  }
  draw();
}

const waited = (since) => {
  const min = Math.floor((Date.now() - since) / 60_000);
  return min < 1 ? 'just now' : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};

/** A person's colour, by their place among the pool's people: the bar, the key and their rows agree. */
const hueOf = (name) =>
  String(
    (Math.max(
      0,
      (open.workers?.people ?? []).findIndex((p) => p.name === name),
    ) %
      6) +
      1,
  );

/** Whose workers are out: a bar in people's colours, and each person's working and waiting beside it. */
function pool() {
  const w = open.workers;
  if (!w) return [];
  const bar = h('div', { class: 'line-bar', 'aria-hidden': 'true' });
  for (const p of w.people.filter((x) => x.used)) {
    const part = h('i', { 'data-cat': hueOf(p.name) });
    part.style.setProperty('flex-grow', String(p.used));
    bar.append(part);
  }
  const free = Math.max(0, w.size - w.used);
  if (free) {
    const rest = h('i', { class: 'free' });
    rest.style.setProperty('flex-grow', String(free));
    bar.append(rest);
  }
  const keys = w.people.map((p) => h('span', { class: 'line-key', 'data-cat': hueOf(p.name) }, h('i'), `${p.name} ${p.used}`, p.waiting ? h('span', { class: 'muted' }, ` · ${p.waiting} waiting`) : ''));
  return [h('b', {}, `${w.used} of ${w.size}`), ' working', w.paused ? h('span', { class: 'line-paused' }, ` · paused by ${w.paused.by}`) : '', bar, h('div', { class: 'line-keys' }, keys)];
}

function button(key, label, text, onclick, cls = 'ar', pressed) {
  return h('button', { type: 'button', class: `line-btn ${cls}`, 'data-key': key, 'aria-label': label, title: label, 'aria-pressed': pressed == null ? null : String(pressed), onclick }, text);
}

function rowOf(r, g, i, inUrgent) {
  const id = r.ticket;
  const name = id == null ? h('span', { class: 'muted' }, 'A minion in another scheme') : h('a', { class: 'line-name', 'data-key': `name-${id}`, href: `#/p/${r.project}/t/${r.number}`, title: `#${r.number} ${r.title}` }, h('span', { class: 'num' }, `#${r.number}`), ` ${r.title}`);
  const why = lineWhy(r);
  const other = id != null && r.project !== view?.projectId && view?.projects?.find((p) => p.id === r.project)?.name;
  const bits = [r.person, other, r.since && r.waiting !== false ? waited(r.since) : r.waiting === false ? 'not waiting now' : '', inUrgent ? '' : why].filter(Boolean);
  const meta = h('span', { class: 'line-meta', title: [...bits, why].filter(Boolean).join(' · ') }, bits.join(' · '), inUrgent ? [bits.length ? ' · ' : '', h('b', { class: 'line-urgent' }, 'urgent'), why ? ` ${why}` : ''] : '');
  // Rest rows have one move, into Urgent, so their ↑ goes there; the Urgent rows step through the group, and out of it at its end.
  const u = g.urgent;
  const at = inUrgent ? u.findIndex((x) => x === r) : -1;
  const known = (from, to) =>
    u
      .slice(from, to)
      .filter((x) => x.ticket != null)
      .at(to === undefined ? 0 : -1);
  const step = (d) => (d < 0 ? setUrgent(r, true, known(0, at)?.ticket) : setUrgent(r, true, known(at + 2)?.ticket ?? null));
  const ctl =
    id == null
      ? []
      : inUrgent
        ? [
            at > 0 && known(0, at) ? button(`up-${id}`, 'Move up in Urgent', '↑', () => step(-1)) : h('span', { class: 'line-btn ar gap' }),
            button(`down-${id}`, at < u.length - 1 ? 'Move down in Urgent' : 'Move out of Urgent', '↓', () => (at < u.length - 1 ? step(1) : setUrgent(r, false))),
            button(`bang-${id}`, `${why ? `Urgent, ${why}. ` : ''}Take it off Urgent`, '!', () => setUrgent(r, false), 'bang on', true),
          ]
        : [button(`up-${id}`, 'Move it into Urgent', '↑', () => setUrgent(r, true, null)), button(`bang-${id}`, 'Mark it Urgent', '!', () => setUrgent(r, true, null), 'bang', false)];
  return h(
    'li',
    { class: `line-row${inUrgent ? ' urgent' : ''}${r.person === me ? ' mine' : ''}${id != null && id === open.from ? ' here' : ''}${id == null ? ' other' : ''}`, 'data-item': '', 'data-id': id ?? null, 'data-cat': r.person ? hueOf(r.person) : null },
    h('span', { class: 'line-who', 'aria-hidden': 'true' }),
    h('span', { class: 'line-n' }, i == null ? '' : String(i)),
    h('span', { class: 'line-t' }, name, meta),
    h('span', { class: 'line-ctl' }, ctl),
  );
}

function draw() {
  if (!open) return;
  // A redraw would drop what a person holds: let go first.
  if (open.list.classList.contains('reorder-active')) return void (open.later ??= setTimeout(() => open && ((open.later = null), draw()), 300));
  const { list, dialog } = open;
  const g = (open.drawn = shown());
  const focus = list.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  dialog.querySelector('.line-pool').replaceChildren(...pool());
  if (!g) {
    dialog.querySelector('h2').textContent = 'The line';
    return list.replaceChildren(h('li', { class: 'line-note muted' }, open.failed ? `Couldn't read it: ${open.failed}` : 'Reading…'));
  }
  list.previousElementSibling.textContent = open.failed ? `Couldn't read it again, so this may be old: ${open.failed}` : HOW;
  const waiting = g.urgent.filter((r) => r.waiting !== false).length + g.rest.length;
  dialog.querySelector('h2').textContent = `The line · ${waiting} waiting`;
  const tops = new Map([...list.querySelectorAll('[data-id]')].map((el) => [el.dataset.id, el.offsetTop]));
  let n = 0;
  const num = (r) => (r.waiting === false ? null : ++n);
  list.replaceChildren(
    h('li', { class: 'line-head urgent' }, 'Urgent'),
    ...(g.urgent.length ? [] : [h('li', { class: 'line-lane' }, 'Nobody is Urgent. Drop a minion here, or press ! on it.')]),
    ...g.urgent.map((r) => rowOf(r, g, num(r), true)),
    h('li', { class: 'line-head', 'data-item': '', 'data-divider': '' }, 'Then, in order'),
    ...(g.rest.length ? g.rest.map((r) => rowOf(r, g, num(r), false)) : [h('li', { class: 'line-none' }, emptyCard('Nobody waits for a worker', 'Minions line up here when every worker is taken.'))]),
  );
  // The heading and a minion nobody here can see are places to drop past, not rows to pick up.
  for (const el of list.querySelectorAll('[data-divider], .other')) el.addEventListener('pointerdown', (e) => e.stopPropagation());
  if (focus) (list.querySelector(`[data-key="${focus}"]`) ?? list.querySelector(`[data-key="bang-${focus.split('-')[1]}"]`))?.focus();
  // Rows slide to their new places, so a press or someone else's move reads as a move.
  if (open.dropping || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of list.querySelectorAll('[data-id]')) {
    const by = tops.has(el.dataset.id) ? tops.get(el.dataset.id) - el.offsetTop : 0;
    if (by) el.animate([{ transform: `translateY(${by}px)` }, { transform: 'none' }], { duration: 160, easing: 'ease-out' });
  }
}
