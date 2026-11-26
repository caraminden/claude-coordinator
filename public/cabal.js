// A cabal's board for people (#2090): the ledger panel over the composer in the lead's chat, and the board's own page at
// #/p/N/cabal/M. Both draw the same ledger (Josh, 2026-11-25, picked "A · A ledger"): one row per member, open ones
// first and a blocking ask pinned on top, a red-run bar when the lead set one, and "Roster of N, nobody started yet"
// before anyone starts. It only reads: src/cabal-board.ts builds the board, and people answer by writing in the lead's chat.
import { api, h, threadHref, view } from './base.js';
import { emptyCard, toneChip } from './look.js';
import { loadingLine } from './ui/state.js';

/**
 * @typedef {'roster' | 'sealed' | 'running' | 'idle' | 'blocked' | 'merged' | 'shipped' | 'closed'} MemberState
 * @typedef {{ row: number, label: string, title: string, number: number | null, lane: string, role: string, state: MemberState, word: string, after: string | null, note: string, note_at: number | null, spend: number, risk: string | null, claims: string[], files: string[], doubled: string[] }} BoardMember
 * @typedef {{ id: number, from: string, number: number | null, text: string, blocking: boolean, opened_at: number }} BoardAsk
 * @typedef {{ lead: { id: number, number: number | null, title: string, spend: number }, name: string, kind: 'build' | 'goal', build: number | null, members: BoardMember[], asks: BoardAsk[], log: { at: number, by: string, text: string }[], red: { text: string, at: number } | null, counts: { members: number, started: number, merged: number, open: number, running: number, spend: number } }} Board
 * @typedef {'open' | 'all' | 'done'} Filter
 * @typedef {{ filter: Filter, open: number | null, shown: boolean }} LedgerState
 */

/** @type {Record<MemberState, string>} the chip's tone (public/ui/base.css) */
const TONE = { roster: 'neutral', sealed: 'neutral', running: 'info', idle: 'warn', blocked: 'danger', merged: 'ok', shipped: 'ok', closed: 'neutral' };
const DONE = new Set(['merged', 'shipped', 'closed']);
const money = (/** @type {number} */ n) => `$${n < 100 ? n.toFixed(2) : n.toFixed(0)}`;
const clock = (/** @type {number} */ ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** @param {number} projectId @param {number | null} number the lead's #N */
export const cabalHref = (projectId, number) => `#/p/${projectId}/cabal/${number}`;

/** "Build 7 cabal" and "Build 7's Overseer #1935": the names people read (code says lead). */
const overseer = (/** @type {Board} */ b) => `${b.name}'s Overseer${b.lead.number ? ` #${b.lead.number}` : ''}`;

/** The header line and the meter: one segment a member, in its state's colour. @param {Board} b @param {number} projectId */
function boardHead(b, projectId) {
  const k = b.counts;
  const done = b.kind === 'build' ? 'merged' : 'shipped';
  return [
    h('div', { class: 'cabal-head' }, h('b', {}, `${b.name} cabal`), h('span', { class: 'cabal-sub' }, h('a', { href: threadHref({ id: b.lead.id, project_id: projectId, number: b.lead.number, kind: 'ticket' }) }, overseer(b)), ` · ${k.merged} ${done} · ${k.open} open · ${k.running} running · ${money(k.spend)} spent`)),
    h('div', { class: 'cabal-meter', 'aria-hidden': 'true' }, ...b.members.map((m) => h('i', { 'data-s': m.state }))),
  ];
}

/** The red-run bar, then the open asks: blocking ones pinned (all of them on the page, the first in a chat). @param {Board} b @param {boolean} all @param {((a: BoardAsk) => void) | null} reply */
function pinned(b, all, reply) {
  const out = [];
  if (b.red) out.push(h('div', { class: 'cabal-red', role: 'status' }, h('b', {}, 'Red run '), h('span', { class: 'cabal-when' }, clock(b.red.at)), ' ', b.red.text));
  const blocking = b.asks.filter((a) => a.blocking);
  for (const a of all ? b.asks : blocking.slice(0, 1))
    out.push(h('div', { class: 'cabal-ask', 'data-blocking': a.blocking ? '' : null }, h('div', {}, h('b', {}, a.blocking ? 'Blocking ask' : 'Ask'), ` · ${a.from}${a.number ? ` #${a.number}` : ''}: `, a.text), reply ? h('button', { type: 'button', class: 'small secondary', onclick: () => reply(a) }, 'Reply') : null));
  const rest = b.asks.length - (all ? b.asks.length : Math.min(1, blocking.length));
  if (!all && rest > 0) out.push(h('div', { class: 'cabal-more' }, `${rest} more open ask${rest === 1 ? '' : 's'} on the board`));
  return out;
}

/** What a row says under "Note or waits on". @param {BoardMember} m */
const noteOf = (m) => m.note || (m.after ? `after ${m.after}` : DONE.has(m.state) && m.risk ? `${m.word} · risk ${m.risk}` : '');

/**
 * The ledger table, open members first (the board's own order), with a row opening to its claims and what it waits on.
 * @param {Board} b @param {LedgerState} s @param {number} projectId @param {() => void} redraw
 */
function ledger(b, s, projectId, redraw) {
  if (b.counts.started === 0 && b.members.length) return [emptyCard(`Roster of ${b.members.length}, nobody started yet.`, `${overseer(b)} starts the first ones once the go lands, then chains the rest.`, { mark: '▦', hue: 'running' }), table(b.members, b, s, projectId, redraw)];
  const rows = b.members.filter((m) => s.filter === 'all' || (s.filter === 'done') === DONE.has(m.state));
  if (!rows.length) return emptyCard(s.filter === 'done' ? `Nothing ${b.kind === 'build' ? 'merged' : 'shipped'} yet.` : 'Nobody open.', '', { mark: '·' });
  return table(rows, b, s, projectId, redraw);
}

/** @param {BoardMember[]} rows @param {Board} b @param {LedgerState} s @param {number} projectId @param {() => void} redraw */
function table(rows, b, s, projectId, redraw) {
  const toggle = (/** @type {number} */ row) => {
    s.open = s.open === row ? null : row;
    redraw();
  };
  return h(
    'table',
    { class: 'cabal-ledger' },
    h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, 'Piece'), h('th', {}, 'State'), h('th', { class: 'cabal-note-col' }, 'Note or waits on'), h('th', { class: 'num' }, 'Spent'))),
    h(
      'tbody',
      {},
      ...rows.flatMap((m) => {
        const open = s.open === m.row;
        const tr = h(
          'tr',
          { class: `cabal-row${open ? ' open' : ''}`, tabindex: '0', 'aria-expanded': String(open), onclick: () => toggle(m.row), onkeydown: (/** @type {KeyboardEvent} */ e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(m.row)) },
          h('td', {}, h('span', { class: 'cabal-dot', 'data-s': m.state })),
          h('td', {}, m.label ? h('b', {}, m.label, ' ') : null, m.title, ' ', h('span', { class: 'num' }, m.number ? `#${m.number}` : 'roster'), m.doubled.length ? h('span', { class: 'cabal-doubled', title: `Another member lists ${m.doubled.join(', ')}` }, ' ⚠ shared file') : null),
          h('td', {}, toneChip(TONE[m.state], m.word)),
          h('td', { class: 'cabal-note-col cabal-note' }, noteOf(m)),
          h('td', { class: 'num' }, m.spend ? money(m.spend) : '–'),
        );
        if (!open) return [tr];
        const files = m.claims.length ? m.claims : m.files;
        const ask = b.asks.find((a) => a.number != null && a.number === m.number);
        const det = h(
          'td',
          { colspan: '4', class: 'cabal-det' },
          h('div', { class: 'cabal-narrow' }, noteOf(m)),
          h('div', {}, m.claims.length ? 'Claims: ' : 'Expects to touch: ', ...(files.length ? files.map((f) => [h('code', {}, f), ' ']) : ['none yet'])),
          m.doubled.length ? h('div', { class: 'cabal-doubled' }, 'Also listed by another member: ', ...m.doubled.map((f) => [h('code', {}, f), ' '])) : null,
          m.after ? h('div', {}, `Starts when ${m.after} is ${b.kind === 'build' ? `merged into ${b.name}` : 'shipped'}.`) : null,
          m.state === 'merged' ? h('div', {}, `Merged: its head is in build/${b.build}.`) : null,
          m.risk ? h('div', {}, `Risk ${m.risk}.`) : null,
          m.note && m.note_at ? h('div', {}, `Note set ${clock(m.note_at)}.`) : null,
          ask ? h('div', { class: 'cabal-ask-line' }, h('b', {}, ask.blocking ? 'Ask, blocking: ' : 'Ask: '), ask.text) : null,
          m.number ? h('a', { href: `#/p/${projectId}/t/${m.number}` }, `Open #${m.number}'s chat →`) : null,
        );
        return [tr, h('tr', { class: 'cabal-det-row' }, h('td', {}), det)];
      }),
    ),
  );
}

/** Open / All / Merged: the filter row. @param {Board} b @param {LedgerState} s @param {() => void} redraw */
function filters(b, s, redraw) {
  /** @type {[Filter, string][]} */
  const tabs = [
    ['open', 'Open'],
    ['all', 'All'],
    ['done', b.kind === 'build' ? 'Merged' : 'Shipped'],
  ];
  return h(
    'span',
    { class: 'cabal-seg', role: 'group', 'aria-label': 'Show' },
    ...tabs.map(([f, word]) =>
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(s.filter === f),
          onclick: () => {
            s.filter = f;
            redraw();
          },
        },
        word,
      ),
    ),
  );
}

/** The lead's log, newest last. @param {Board} b */
const logList = (b) => (b.log.length ? h('ul', { class: 'cabal-log' }, ...b.log.map((l) => h('li', {}, h('span', { class: 'cabal-when' }, clock(l.at)), ' ', l.text))) : null);

// ——— The panel in the lead's chat ———

/** @typedef {{ ticket: number, board: Board | null, read: boolean, s: LedgerState }} Panel */
/** @type {Panel | null} */
let panel = null;

/** Fill #chat-cabal for the chat on show: the board this minion leads, else nothing. Reads it again when `fresh`. */
export async function renderCabalPanel(fresh = false) {
  const slot = document.getElementById('chat-cabal');
  const t = view?.ticket;
  if (!slot || !t) return;
  if (!panel || panel.ticket !== t.id) panel = { ticket: t.id, board: null, read: false, s: { filter: 'open', open: null, shown: false } };
  const mine = panel;
  if (fresh || !mine.read) {
    mine.read = true; // once a chat open, then on the stream's news: every head redraw calls this
    const r = await api(`api/tickets/${t.id}/cabal`).catch(() => null);
    if (panel !== mine) return; // another chat opened meanwhile
    mine.board = r && r.lead === t.id ? /** @type {Board} */ (r.board) : null;
  }
  drawPanel(slot, mine);
}

/** @param {HTMLElement} slot @param {Panel} p */
function drawPanel(slot, p) {
  const b = p.board;
  slot.hidden = !b;
  if (!b) return slot.replaceChildren();
  const projectId = view?.ticket?.project_id ?? 0;
  const redraw = () => drawPanel(slot, p);
  // Reply puts "About ask N" in the composer: people answer the Overseer in its own chat.
  const reply = (/** @type {BoardAsk} */ a) => {
    const box = slot.closest('form')?.querySelector('textarea');
    if (!box) return;
    box.value = `About ask ${a.id} (${a.from}): ${box.value}`;
    box.focus();
    box.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const toggle = h(
    'button',
    {
      type: 'button',
      class: 'small secondary',
      'aria-expanded': String(p.s.shown),
      onclick: () => {
        p.s.shown = !p.s.shown;
        redraw();
      },
    },
    p.s.shown ? 'Hide ledger' : 'Ledger',
  );
  slot.replaceChildren(
    h(
      'div',
      { class: 'cabal-panel' },
      h('div', { class: 'cabal-bar' }, ...boardHead(b, projectId), h('span', { class: 'cabal-acts' }, toggle, h('a', { class: 'small', href: cabalHref(projectId, b.lead.number) }, 'Board →'))),
      ...pinned(b, false, reply),
      p.s.shown ? h('div', { class: 'cabal-scroll' }, h('div', { class: 'cabal-tools' }, filters(b, p.s, redraw)), ledger(b, p.s, projectId, redraw)) : null,
    ),
  );
}

// ——— The board's own page ———

/** @type {{ el: HTMLElement, projectId: number, number: number, board: Board | null, error: string | null, s: LedgerState } | null} */
let page = null;

/** The page at #/p/N/cabal/M, M the lead's #N. @param {number} projectId @param {number} number */
export function cabalPage(projectId, number) {
  const el = h('section', { class: 'artifacts-main cabal-main' }, loadingLine('Reading the board…'));
  page = { el, projectId, number, board: null, error: null, s: { filter: 'all', open: null, shown: true } };
  readPage(page);
  return el;
}

/** @param {NonNullable<typeof page>} p */
async function readPage(p) {
  try {
    p.board = /** @type {{ board: Board }} */ (await api(`api/projects/${p.projectId}/cabal/${p.number}`)).board;
    p.error = null;
  } catch (ex) {
    p.error = ex instanceof Error ? ex.message : String(ex);
  }
  drawPage(p);
}

/** @param {NonNullable<typeof page>} p */
function drawPage(p) {
  const b = p.board;
  if (!b) return p.el.replaceChildren(emptyCard('No board here.', p.error ?? '', { mark: '?' }));
  const redraw = () => drawPage(p);
  p.el.replaceChildren(
    h(
      'div',
      { class: 'cabal-panel cabal-page' },
      h('div', { class: 'cabal-bar' }, ...boardHead(b, p.projectId), h('span', { class: 'cabal-acts' }, filters(b, p.s, redraw))),
      ...pinned(b, true, null),
      ledger(b, p.s, p.projectId, redraw),
      b.log.length ? h('h3', { class: 'cabal-log-head' }, `${overseer(b)}'s log`) : null,
      logList(b),
    ),
  );
}

/** The stream's { type: 'cabal', projectId, lead } (a board changed): read again what is on show. @param {{ projectId: number, lead: number }} msg */
export function onCabalNews(msg) {
  if (panel?.ticket === msg.lead && view?.ticket?.id === msg.lead) renderCabalPanel(true);
  if (page?.el.isConnected && page.projectId === msg.projectId && page.board?.lead.id === msg.lead) readPage(page);
}
