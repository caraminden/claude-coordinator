// The line for a worker as a drawer, opened from any waiting minion's chip and the Workers tile, and the Urgent mark
// (#1889; Josh, 2026-11-24: "W1 · A drawer, opened from any waiting minion"; 'make that a button on a minion, mark it as
// "urgent"'). The server's order and what Urgent means: src/turn-line.ts, src/urgent.ts.
import { api, h, me, pacificClock, view } from './base.js';
import { renderSidebar } from './sidebar.js';
import { renderTyping } from './thread.js';
import { renderTicketHead } from './thread-head.js';
import { openDialog } from './ui/dialog.js';
import { optimistic } from './ui/optimistic.js';
import { toast } from './ui/status.js';
import { emptyCard, toneChip } from './look.js';
import { dragReorder } from './reorder.js';
import { applyMove, applyStart, dropped, laneSaid, lineGroups, lineWhy, nextUrgent, ownSaid } from './worker-linemath.js';

/** @import { LaneRow, LineData, LineGroups, LineRow, WorkersTile } from './types/workers.js' */
/** @import { Ticket } from './types.js' */
/** A press on its way: Urgent's move, or Start now and Release. @typedef {{ row: LineRow, on: boolean, before?: number | null, by: string | null, dead: boolean }} Op */
/** @typedef {{ row: LineRow, on: boolean, by: string | null, at: number, dead: boolean }} StartOp */
/** @typedef {{ dialog: HTMLDialogElement, list: HTMLElement, line: LineData | null, workers: WorkersTile | null, failed: string | null, from: number | null, drawn?: LineGroups | null, dropping?: boolean, later?: ReturnType<typeof setTimeout> | null }} Drawer */

const READ_MS = 10_000;
const HOW = 'Next first. Drag one into Urgent to send it ahead; drag it below to let the order choose. Start now: a worker of its own, two each.';
/** @type {StartOp[]} */
const starts = []; // the same for Start now and Release
/** @type {Op[]} */
const ops = []; // moves on their way to the server, or shown until a read has them
/** @type {Drawer | null} */
let open = null; // the drawer
/** Where only an open drawer reaches. */
const drawer = () => /** @type {Drawer} */ (open);
let reads = 0;
/** @type {Promise<void> | undefined} */
let latest;

// ---------- marking one Urgent ----------

const minionObjects = (/** @type {number} */ id) => new Set(/** @type {Ticket[]} */ ([view?.tickets?.get(id), view?.ticket?.id === id && view.ticket].filter(Boolean)));

/**
 * Mark or unmark `row` ({ ticket, number, title }): it shows at once here, in its header and its row, and the request
 * runs behind; a refusal puts it back with a toast and a Retry.
 * @param {LineRow} row
 * @param {boolean} on
 * @param {number | null} [before]
 * @param {{ undoing?: boolean }} [opts]
 */
export function setUrgent(row, on, before, { undoing = false } = {}) {
  const id = /** @type {number} */ (row.ticket); // a hidden minion's row has no control
  const g = shown();
  const wasOn = g ? g.urgent.some((r) => r.ticket === id) : [...minionObjects(id)].some((t) => t.urgent);
  const back = wasOn && g ? nextUrgent(g, id) : undefined;
  const was = new Map([...minionObjects(id)].map((t) => [t, t.urgent ?? null]));
  /** @type {Op} */
  const op = { row, on, before, by: me, dead: false };
  const name = `#${row.number}`;
  const others = [...was.values(), g?.urgent.find((r) => r.ticket === id)].some((u) => u?.kind && u.kind !== 'person'); // the server can't take its reason back from a press
  const show = (/** @type {Ticket['urgent'] | undefined} */ mark) => {
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
      show(on ? (marked?.kind === 'person' ? marked : { kind: 'person', by: /** @type {string} */ (me), at: Date.now() }) : null);
    },
    send: () => api(`api/tickets/${id}/urgent`, { method: 'PUT', body: { on, ...(before === undefined ? {} : { before }) } }),
    undo: () => {
      op.dead = true;
      drop(op);
      show(undefined);
    },
    label: `${on ? (wasOn ? 'move' : 'mark') : 'unmark'} ${name} ${on && wasOn ? 'in Urgent' : 'Urgent'}`,
  })
    .then(async (/** @type {{ urgent: Ticket['urgent'] }} */ { urgent }) => {
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

const drop = (/** @type {Op} */ op) => ops.includes(op) && ops.splice(ops.indexOf(op), 1);

/** The header's and the right-click menu's toggle for a minion. */
export const toggleUrgent = (/** @type {Ticket} */ t) => setUrgent({ ticket: t.id, project: t.project_id, number: t.number ?? t.id, title: t.title, waiting: !!t.worker_wait }, !t.urgent);

/** Who set it, and why, as words: "Urgent, by Josh". */
export const urgentSaid = (/** @type {{ by: string, reason?: string }} */ u) => `Urgent, by ${u.by}${u.reason ? `: ${u.reason}` : ''}`;

/**
 * The header's button: press to mark it, again to take it off; pressed, it names who set it.
 * @param {Ticket} t
 */
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
export const urgentMark = (/** @type {Ticket} */ t) => {
  const u = /** @type {NonNullable<Ticket['urgent']>} */ (t.urgent); // drawn only for a marked one
  return h('span', { class: 'urgent-mark', role: 'img', 'aria-label': urgentSaid(u), title: urgentSaid(u) }, '!');
};

// ---------- Start now: a worker of its own (#1957) ----------

/** Who gave it one, and when, as words: "Josh, since 3:05 PM PST". */
export const heldSaid = (/** @type {{ by?: string | null, since?: number }} */ u) => `${u.by}, since ${pacificClock(/** @type {number} */ (u.since))}`;

/**
 * Give `row` ({ ticket, project, number, title }) a worker of its own, or let it go: it shows at once, and the request
 * runs behind. Refused at two, a dialog names the two, each with a Release that starts this one in its place.
 * @param {LineRow} row
 * @param {boolean} on
 */
export function setStartNow(row, on) {
  const id = /** @type {number} */ (row.ticket); // as setUrgent's
  const name = `#${row.number}`;
  const was = new Map([...minionObjects(id)].map((t) => [t, t.start_now ?? null]));
  /** @type {StartOp} */
  const op = { row, on, by: me, at: Date.now(), dead: false };
  const show = (/** @type {Ticket['start_now'] | undefined} */ mark) => {
    for (const t of minionObjects(id)) t.start_now = mark === undefined ? (was.get(t) ?? null) : mark;
    renderSidebar();
    if (view?.id === id) {
      renderTicketHead();
      renderTyping();
    }
    draw();
  };
  const done = () => starts.includes(op) && starts.splice(starts.indexOf(op), 1);
  return optimistic({
    key: 'start-now', // a Release makes room for the Start now after it
    sets: `start-now:${id}`,
    apply: () => {
      op.dead = false;
      if (!starts.includes(op)) starts.push(op);
      show(on ? /** @type {NonNullable<Ticket['start_now']>} */ ({ by: me, since: op.at }) : null);
    },
    // At two it's no failure to retry: the dialog has what to do.
    send: () => api(`api/tickets/${id}/start-now`, { method: 'PUT', body: { on } }).catch((/** @type {Error & { data?: { holds?: Hold[] } }} */ err) => (err.data?.holds ? { full: err.data.holds } : Promise.reject(err))),
    undo: () => {
      op.dead = true;
      done();
      show(undefined);
    },
    label: on ? `start ${name} now` : `release ${name}'s worker`,
  })
    .then(async (/** @type {{ start_now?: Ticket['start_now'], full?: Hold[] }} */ { start_now, full }) => {
      if (full) {
        done();
        show(undefined);
        return askRelease(row, full);
      }
      if (!starts.some((o) => o !== op && !o.dead && o.row.ticket === id)) for (const t of minionObjects(id)) t.start_now = /** @type {Ticket['start_now']} */ (start_now); // a later press shows its own
      await read();
      done();
      draw();
      if (view?.id === id) {
        renderTicketHead();
        renderTyping();
      }
    })
    .catch(() => {
      done();
      draw();
    });
}

/** A worker of its own the person holds (src/routes/urgent.ts's 409). @typedef {{ ticket: number, project: number, number: number, title: string, since: number }} Hold */

/**
 * They hold two already: which to let go for `row`.
 * @param {LineRow} row
 * @param {Hold[]} holds
 */
function askRelease(row, holds) {
  const dialog = openDialog({
    title: 'You hold two workers already',
    className: 'own-full',
    body: [
      h('p', {}, `Two each is the most. Release one and #${row.number} gets a worker as soon as that one is not mid-turn.`),
      h(
        'ul',
        { class: 'line-rows' },
        holds.map((m) =>
          h(
            'li',
            { class: 'line-row own' },
            h('span', { class: 'line-t' }, h('span', { class: 'line-name' }, h('span', { class: 'num' }, `#${m.number}`), ` ${m.title}`), h('span', { class: 'line-meta' }, `yours since ${pacificClock(m.since)}`)),
            h(
              'button',
              {
                type: 'button',
                class: 'cui-btn cui-small',
                'aria-label': `Release #${m.number} and start #${row.number}`,
                onclick: () => {
                  dialog.close();
                  setStartNow(m, false);
                  setStartNow(row, true);
                },
              },
              'Release',
            ),
          ),
        ),
      ),
    ],
  });
}

const rowOfTicket = (/** @type {Ticket} */ t) => ({ ticket: t.id, project: t.project_id, number: t.number ?? t.id, title: t.title });

/** The right-click menu's, the header's and the waiting chip's press for a minion. */
export const toggleStartNow = (/** @type {Ticket} */ t) => setStartNow(rowOfTicket(t), !t.start_now);

const ownButton = (/** @type {Ticket} */ t, /** @type {string} */ said, /** @type {string} */ title) => h('button', { type: 'button', class: 'cui-btn cui-small', 'data-key': said, title, 'aria-label': title, onclick: () => toggleStartNow(t) }, said);
const releaseTitle = (/** @type {{ by?: string | null, since?: number }} */ u) => `Release the worker of its own (${heldSaid(u)}). A running turn finishes, and the next waits in the line`;

/**
 * Under the chat: Start now while it waits for a worker, or whose worker it has and Release; null for neither.
 * @param {Ticket} t
 */
export function startNowLine(t) {
  if (t.status === 'closed' || !(t.start_now || t.worker_wait)) return null;
  const u = t.start_now;
  if (u) return [toneChip('info', `Own worker: ${heldSaid(u)}`), ownButton(t, 'Release', releaseTitle(u))];
  const { held } = /** @type {NonNullable<Ticket['worker_wait']>} */ (t.worker_wait);
  return [ownButton(t, 'Start now', held ? `Start now: it starts once it can (${held})` : "Start now: a worker of its own, past the pool's size, for as long as you work with it")];
}

// ---------- the drawer ----------

const started = () => starts.reduce((data, op) => applyStart(data, op), /** @type {LineData} */ (drawer().line));
const shown = () => (open?.line ? ops.reduce(applyMove, lineGroups(started())) : null);

/** Someone's place changed (the server says so on every move and wait), so an open drawer reads again. */
export const lineMoved = () => open && read();

/**
 * Open the line; the minion it was opened from is outlined in it.
 * @param {number | null} [from]
 */
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
    onDrop: (/** @type {number} */ a, /** @type {number} */ b) => {
      const move = dropped(/** @type {LineGroups} */ (drawer().drawn), a, b); // the rows it was dropped among: a read since then waits for the drop
      if (!move) return toast('Below Urgent the order is automatic. Drop it in Urgent to send it ahead.');
      drawer().dropping = true; // the drag already slid the rows there
      setUrgent(move.row, move.on, move.before);
      if (open) open.dropping = false;
    },
  });
  list.addEventListener('click', (e) => /** @type {Element} */ (e.target).closest('a') && !(e.ctrlKey || e.metaKey || e.shiftKey) && dialog.close());
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
    open.failed = /** @type {Error} */ (err).message;
  }
  draw();
}

const waited = (/** @type {number} */ since) => {
  const min = Math.floor((Date.now() - since) / 60_000);
  return min < 1 ? 'just now' : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};

/** A person's colour, by their place among the pool's people: the bar, the key and their rows agree. */
const hueOf = (/** @type {string} */ name) =>
  String(
    (Math.max(
      0,
      (drawer().workers?.people ?? []).findIndex((p) => p.name === name),
    ) %
      6) +
      1,
  );

const LANE_HOW = "Beside the pool, for what people say and answer and the server's wake-ups, while every worker is taken. One still running after 2 minutes counts in the pool, up to 2 over its size.";

/** The quick lane's state, for the tile and the drawer. */
export const quickLane = (/** @type {WorkersTile['lane']} */ lane) => h('span', { title: LANE_HOW }, toneChip(lane.used ? 'info' : lane.size ? 'neutral' : 'warn', 'Quick lane'), ` ${laneSaid(lane)}`);

/** Whose workers are out, the quick lane's under them: a bar in people's colours, and each person's working and waiting beside it. */
function pool() {
  const w = drawer().workers;
  if (!w) return [];
  const bar = h('div', { class: 'line-bar', 'aria-hidden': 'true' });
  const part = (/** @type {Record<string, string>} */ attrs, /** @type {number} */ n) => {
    const i = h('i', attrs);
    i.style.setProperty('flex-grow', String(n));
    bar.append(i);
  };
  for (const p of w.people.filter((x) => x.used)) part({ 'data-cat': hueOf(p.name) }, p.used);
  const free = Math.max(0, w.size - w.used);
  if (free) part({ class: 'free' }, free);
  const keys = w.people.map((p) => h('span', { class: 'line-key', 'data-cat': hueOf(p.name) }, h('i'), `${p.name} ${p.used}`, p.lane ? h('span', { class: 'muted' }, ` · ${p.lane} quick`) : '', p.waiting ? h('span', { class: 'muted' }, ` · ${p.waiting} waiting`) : ''));
  return [h('b', {}, `${w.used} of ${w.size}`), ` working${w.forced ? `, ${w.forced} forced` : ''}`, w.paused ? h('span', { class: 'line-paused' }, ` · paused by ${w.paused.by}`) : '', bar, h('div', { class: 'line-keys' }, keys), h('div', { class: 'line-quick small' }, quickLane(w.lane))];
}

/**
 * @param {string} key
 * @param {string} label
 * @param {string} text
 * @param {() => unknown} onclick
 * @param {string} [cls]
 * @param {boolean} [pressed]
 */
function button(key, label, text, onclick, cls = 'ar', pressed) {
  return h('button', { type: 'button', class: `line-btn ${cls}`, 'data-key': key, 'aria-label': label, title: label, 'aria-pressed': pressed == null ? null : String(pressed), onclick }, text);
}

/**
 * @param {LineRow} r
 * @param {LineGroups} g
 * @param {number | null} i
 * @param {boolean} inUrgent
 */
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
  /** @param {number} from @param {number} [to] */
  const known = (from, to) =>
    u
      .slice(from, to)
      .filter((x) => x.ticket != null)
      .at(to === undefined ? 0 : -1);
  const step = (/** @type {number} */ d) => (d < 0 ? setUrgent(r, true, known(0, at)?.ticket) : setUrgent(r, true, known(at + 2)?.ticket ?? null));
  const now = id == null || r.waiting === false || r.forced ? '' : button(`now-${id}`, "Start now: a worker of its own, past the pool's size", 'Start now', () => setStartNow(r, true), 'now');
  const ctl =
    id == null
      ? []
      : inUrgent
        ? [
            now,
            at > 0 && known(0, at) ? button(`up-${id}`, 'Move up in Urgent', '↑', () => step(-1)) : h('span', { class: 'line-btn ar gap' }),
            button(`down-${id}`, at < u.length - 1 ? 'Move down in Urgent' : 'Move out of Urgent', '↓', () => (at < u.length - 1 ? step(1) : setUrgent(r, false))),
            button(`bang-${id}`, `${why ? `Urgent, ${why}. ` : ''}Take it off Urgent`, '!', () => setUrgent(r, false), 'bang on', true),
          ]
        : [now, button(`up-${id}`, 'Move it into Urgent', '↑', () => setUrgent(r, true, null)), button(`bang-${id}`, 'Mark it Urgent', '!', () => setUrgent(r, true, null), 'bang', false)];
  return h(
    'li',
    { class: `line-row${inUrgent ? ' urgent' : ''}${r.person === me ? ' mine' : ''}${id != null && id === drawer().from ? ' here' : ''}${id == null ? ' other' : ''}`, 'data-item': '', 'data-id': id ?? null, 'data-cat': r.person ? hueOf(r.person) : null },
    h('span', { class: 'line-who', 'aria-hidden': 'true' }),
    h('span', { class: 'line-n' }, i == null ? '' : String(i)),
    h('span', { class: 'line-t' }, name, meta),
    h('span', { class: 'line-ctl' }, ctl),
  );
}

/**
 * A turn that started in the quick lane, and whether it counts in the pool by now.
 * @param {LaneRow} t
 */
function laneRow(t) {
  const name = t.ticket == null ? h('span', { class: 'muted' }, 'A minion in another scheme') : h('a', { class: 'line-name', 'data-key': `name-${t.ticket}`, href: `#/p/${t.project}/t/${t.number}`, title: `#${t.number} ${t.title}` }, h('span', { class: 'num' }, `#${t.number}`), ` ${t.title}`);
  const meta = [t.person, `since ${pacificClock(t.since)}`].filter(Boolean).join(' · ');
  return h(
    'li',
    { class: `line-row lane${t.ticket != null && t.ticket === drawer().from ? ' here' : ''}${t.ticket == null ? ' other' : ''}`, 'data-cat': t.person ? hueOf(t.person) : null },
    h('span', { class: 'line-who', 'aria-hidden': 'true' }),
    h('span', { class: 'line-t' }, name, h('span', { class: 'line-meta' }, meta)),
    t.moved ? toneChip('neutral', 'In the pool') : toneChip('info', 'Quick'),
  );
}

/**
 * A minion on a worker of its own: whose, since when, and Release.
 * @param {LineRow} f
 * @param {string | false | null | undefined} held
 */
function ownRow(f, held) {
  const id = f.ticket;
  if (id == null) return h('li', { class: 'line-row own other' }, h('span', { class: 'line-t' }, h('span', { class: 'muted' }, 'A minion in another scheme'), h('span', { class: 'line-meta' }, `since ${pacificClock(/** @type {number} */ (f.since))}`)));
  return h(
    'li',
    { class: `line-row own${id === drawer().from ? ' here' : ''}` },
    h('span', { class: 'line-t' }, h('a', { class: 'line-name', 'data-key': `name-${id}`, href: `#/p/${f.project}/t/${f.number}`, title: `#${f.number} ${f.title}` }, h('span', { class: 'num' }, `#${f.number}`), ` ${f.title}`), h('span', { class: 'line-meta' }, `${heldSaid(f)} · ${ownSaid(f, held)}`)),
    h(
      'span',
      { class: 'line-ctl' },
      button(`now-${id}`, releaseTitle(f), 'Release', () => setStartNow(f, false), 'now'),
    ),
  );
}

function draw() {
  if (!open) return;
  // A redraw would drop what a person holds: let go first.
  if (open.list.classList.contains('reorder-active')) return void (open.later ??= setTimeout(() => open && ((open.later = null), draw()), 300));
  const { list, dialog } = open;
  const g = (open.drawn = shown());
  const focus = list.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).dataset.key : null;
  /** @type {Element} */ (dialog.querySelector('.line-pool')).replaceChildren(...pool());
  if (!g) {
    /** @type {Element} */ (dialog.querySelector('h2')).textContent = 'The line';
    return list.replaceChildren(h('li', { class: 'line-note muted' }, open.failed ? `Couldn't read it: ${open.failed}` : 'Reading…'));
  }
  /** @type {Element} */ (list.previousElementSibling).textContent = open.failed ? `Couldn't read it again, so this may be old: ${open.failed}` : HOW;
  const { forced, line } = started();
  const waiting = line.length;
  /** @type {Element} */ (dialog.querySelector('h2')).textContent = `The line · ${waiting} waiting`;
  const tops = new Map([.../** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll('[data-id]'))].map((el) => [el.dataset.id, el.offsetTop]));
  let n = 0;
  const num = (/** @type {LineRow} */ r) => (r.waiting === false ? null : ++n);
  list.replaceChildren(
    ...(forced.length ? [h('li', { class: 'line-head' }, 'Started now'), ...forced.map((f) => ownRow(f, f.ticket != null && line.find((w) => w.ticket === f.ticket)?.held))] : []),
    h('li', { class: 'line-head urgent' }, 'Urgent'),
    ...(g.urgent.length ? [] : [h('li', { class: 'line-lane' }, 'Nobody is Urgent. Drop a minion here, or press ! on it.')]),
    ...g.urgent.map((r) => rowOf(r, g, num(r), true)),
    h('li', { class: 'line-head', 'data-item': '', 'data-divider': '' }, 'Then, in order'),
    ...(g.rest.length ? g.rest.map((r) => rowOf(r, g, num(r), false)) : [h('li', { class: 'line-none' }, emptyCard(waiting ? 'Nobody else waits for a worker' : 'Nobody waits for a worker', 'Minions line up here when every worker is taken.'))]),
    // Below the order, so rows coming and going move nothing a person is about to press.
    ...(drawer().line?.lane?.length ? [h('li', { class: 'line-head' }, 'Started in the quick lane'), .../** @type {LaneRow[]} */ (drawer().line?.lane).map(laneRow)] : []),
  );
  // The heading and a minion nobody here can see are places to drop past, not rows to pick up.
  for (const el of list.querySelectorAll('[data-divider], .other')) el.addEventListener('pointerdown', (e) => e.stopPropagation());
  if (focus) /** @type {HTMLElement | null} */ (list.querySelector(`[data-key="${focus}"]`) ?? list.querySelector(`[data-key="bang-${focus.split('-')[1]}"]`))?.focus();
  // Rows slide to their new places, so a press or someone else's move reads as a move.
  if (open.dropping || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll('[data-id]'))) {
    const by = tops.has(el.dataset.id) ? /** @type {number} */ (tops.get(el.dataset.id)) - el.offsetTop : 0;
    if (by) el.animate([{ transform: `translateY(${by}px)` }, { transform: 'none' }], { duration: 160, easing: 'ease-out' });
  }
}
