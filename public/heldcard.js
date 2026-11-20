// The held-mail inbox card over a chat's message box (#1067, Josh picked "C · A next-turn inbox card", 2026-11-19): what
// the next turn will read, grouped by sender, a "Needs you" row with Continue for a loop-guard hold, Deliver now (Unpark
// for a parked minion), and per sender a ⋯ menu that stops a kind of mail being held in this scheme (Josh's "By kind,
// scheme-wide"). The data is heldModel (heldmsg.js); thread.js mounts it in #chat-held from renderTicketHead.
import { api, h, view } from './base.js';
import { optimistic } from './ui/optimistic.js';
import { toast } from './ui/status.js';
import { heldModel, kindLabel } from './heldmsg.js';
import { pacific } from './threadstate.js';

/** Sections opened by hand, by chat and sender, so a redraw keeps them open. */
const opened = new Set();

/** Fill `slot` with `t`'s card, or hide it. `unpark(t)` is the chat's own Unpark. */
export function renderHeldCard(slot, t, unpark) {
  const m = heldModel(t, view.project?.msg_never_hold ?? '', (ms) => pacific(ms));
  slot.hidden = !m;
  if (!m) return slot.replaceChildren();
  const head = h('div', { class: 'hc-head' },
    h('span', { class: 'hc-count', 'aria-label': `${m.count} waiting` }, String(m.count)),
    h('div', { class: 'hc-title' }, h('b', {}, m.title), h('span', {}, m.sub)));
  const loop = m.loop ? h('div', { class: 'hc-sec hc-need' }, h('div', { class: 'hc-row' },
    h('b', {}, 'Needs you · loop guard'),
    h('span', { class: 'hc-pv', title: m.loop.text }, `${m.loop.n === 1 ? '' : `${m.loop.n} held: `}"${m.loop.text}"`),
    h('button', { type: 'button', class: 'small', title: 'Let the held messages through; the loop count starts again', onclick: (e) => cont(t, e.currentTarget) }, 'Continue'))) : '';
  const secs = m.sections.map((s) => section(t, s, () => renderHeldCard(slot, view.ticket ?? t, unpark)));
  const foot = m.footer ? h('div', { class: 'hc-foot' }, h('span', {}, m.footer.text),
    m.footer.action === 'deliver' ? h('button', { type: 'button', class: 'small', title: 'Run a turn now that reads all of these', onclick: (e) => deliver(t, e.currentTarget) }, 'Deliver now')
      : m.footer.action === 'unpark' ? h('button', { type: 'button', class: 'small', title: 'Wake it now: it reads these', onclick: () => unpark(t) }, 'Unpark') : '') : '';
  slot.replaceChildren(h('div', { class: 'held-card', role: 'region', 'aria-label': 'Held mail' }, head, loop, ...secs, foot));
}

function section(t, s, redraw) {
  const key = `${t.id}:${s.author}`;
  const open = opened.has(key);
  const list = h('div', { class: 'hc-msgs', hidden: !open }, s.items.map((i) => h('div', { class: 'hc-msg' },
    h('time', {}, i.at ? pacific(i.at).replace(/ P[SD]T$/, '') : ''), i.need ? h('span', { class: 'msg-tag' }, `need: ${i.need}`) : '', i.text)));
  const toggle = h('button', { type: 'button', class: 'hc-row hc-toggle', 'aria-expanded': String(open), onclick: () => {
    const now = !opened.delete(key);
    if (now) opened.add(key);
    list.hidden = !now;
    toggle.setAttribute('aria-expanded', String(now));
  } }, h('span', { class: 'hc-chev', 'aria-hidden': 'true' }, '▸'), h('b', {}, s.author), h('span', { class: 'hc-n' }, String(s.items.length)), h('span', { class: 'hc-pv' }, s.preview));
  const menu = s.kinds.length ? h('details', { class: 'hc-menu' },
    h('summary', { 'aria-label': `More for ${s.author}'s mail`, title: 'More' }, '⋯'),
    h('div', { class: 'hc-pop', role: 'menu' }, s.kinds.map((k) => h('button', { type: 'button', role: 'menuitem', onclick: (e) => { e.currentTarget.closest('details').open = false; neverHold(k, redraw); } },
      `Never hold ${kindLabel(k)} in this scheme`)))) : '';
  return h('div', { class: 'hc-sec' }, h('div', { class: 'hc-line' }, toggle, menu), list);
}

/** Deliver now: the mail goes from the card at once (a loop hold's row stays) and the turn starts behind it; a refusal, or none
 * delivered because its Claude can't run a turn, puts it back with a toast and a retry. */
function deliver(t, btn) {
  const card = btn.closest('.held-card');
  const loop = card.querySelector('.hc-need:not([hidden])');
  const mail = [...card.querySelectorAll('.hc-sec:not(.hc-need), .hc-foot')];
  const show = (on) => { if (loop) mail.forEach((n) => { n.hidden = !on; }); else card.hidden = !on; };
  optimistic({
    key: `deliver:${t.id}`,
    apply: () => show(false),
    send: async () => {
      const r = await api(`api/tickets/${t.id}/deliver-mail`, { method: 'POST', body: {} });
      if (!r?.delivered) throw new Error("its Claude can't run a turn right now");
    },
    undo: () => show(true),
    label: 'deliver the held mail',
  });
}

/** Continue a loop-guard hold, as the hold's card in the log does. */
function cont(t, btn) {
  const row = btn.closest('.hc-need');
  optimistic({
    key: `continue:${t.id}`,
    apply: () => { row.hidden = true; },
    send: () => api(`api/tickets/${t.id}/continue`, { method: 'POST' }),
    undo: () => { row.hidden = false; },
    label: 'let the held messages through',
  });
}

/** Add `kind` to the scheme's never-hold list (the Messages setting in Minion rules shows and undoes it). */
function neverHold(kind, redraw) {
  const p = view.project;
  if (!p) return;
  const was = p.msg_never_hold ?? '';
  const next = [...new Set([...was.split(',').filter(Boolean), kind])].sort();
  optimistic({
    key: `never-hold:${p.id}`,
    apply: () => { p.msg_never_hold = next.join(','); redraw(); toast(`${kindLabel(kind)} now wakes its reader in this scheme (Minion rules, Messages, turns it back)`); },
    send: () => api(`api/projects/${p.id}`, { method: 'PATCH', body: { msg_never_hold: next } }),
    undo: () => { p.msg_never_hold = was; redraw(); },
    label: `never hold ${kindLabel(kind)}`,
  });
}
