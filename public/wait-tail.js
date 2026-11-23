// A waiting heavy run's newest output line under the readout, and a toggle for its last 20 (#1681). The server redacts
// the lines (src/wait-tail.ts). The readout is rebuilt on every change, so the lines and the toggle live here by minion,
// and one poller refreshes whatever .wait-tail is on the page every few seconds.
import { api, h, poller } from './base.js';

const state = new Map(); // ticket id -> { lines, open }
const REFRESH_MS = 4000;

const loop = poller(() => refresh(), REFRESH_MS); // waits while the tab is hidden, one read at a time (#1610)

const paint = (el) => {
  const s = state.get(Number(el.dataset.ticket)) ?? { lines: [], open: false };
  const shown = s.open ? s.lines : s.lines.slice(-1);
  el.hidden = !s.lines.length;
  el.querySelector('pre').textContent = shown.join('\n');
  el.querySelector('button').textContent = s.open ? 'Hide' : 'Last 20 lines';
};

/** The tail of the heavy run this wait is, or '' for any other wait. */
export function waitTail(ticketId, w) {
  if (!w || w.kind !== 'heavy' || w.stage !== 'run') return '';
  const s = state.get(ticketId) ?? state.set(ticketId, { lines: [], open: false }).get(ticketId);
  const el = h('div', { class: 'wait-tail', 'data-ticket': ticketId, 'aria-label': 'Latest output of the run' },
    h('pre', {}),
    h('button', { type: 'button', onclick: () => { s.open = !s.open; paint(el); } }));
  paint(el);
  if (typeof document !== 'undefined') loop.now();
  return el;
}

async function refresh() {
  const els = [...document.querySelectorAll('.wait-tail')];
  if (!els.length) return false; // no tail on screen: the loop rests until the next one is built
  const ids = new Set(els.map((el) => Number(el.dataset.ticket)));
  for (const id of [...state.keys()]) if (!ids.has(id)) state.delete(id); // the run ended or the chat moved on: nothing stays
  for (const el of els) {
    const id = Number(el.dataset.ticket);
    try {
      const { lines } = await api(`api/tickets/${id}/wait-tail`);
      const s = state.get(id);
      if (s) { s.lines = lines; paint(el); }
    } catch { /* the next look tries again */ }
  }
}
