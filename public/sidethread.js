// Side threads (#932): a question asked on the side of a minion ('side' event) and its answer ('side_answer'), in one
// collapsed blue row. A read-only copy of the minion's session answered it, so nothing here is in the minion's history.
/** @import { ChatEvent, Ticket } from './types.js' */
import { asSpeaker } from './avatars.js';
import { api, h, me } from './base.js';
import { markdown } from './core.js';

/**
 * @typedef {{ thread?: number, q?: string, by?: string, ask?: number, ok?: boolean, text?: string, cost_usd?: number }} SideData A 'side' or 'side_answer' event's data.
 * @typedef {{ el: HTMLDetailsElement, list: HTMLElement, cost: number, state: string, at: number | null, draw: () => void }} SideRow One thread's row.
 */

/** @param {number | null} at */
const clock = (at) => new Date(at ?? 0).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * Put one side event into its thread's row. Returns the row when it is new (the caller adds it to the log), or null when
 * the event went into a row already drawn. Your own question asked just now opens. `rows` maps a thread's id (its first 'side' event's id) to its row.
 */
/**
 * @param {Map<number, SideRow>} rows
 * @param {ChatEvent} event
 * @param {SideData} data
 * @param {Ticket} ticket
 * @param {boolean} [live]
 */
export function sideEvent(rows, event, data, ticket, live) {
  const id = event.kind === 'side' ? (data.thread ?? event.id) : /** @type {number} */ (data.thread);
  let row = /** @type {SideRow} */ (rows.get(id)); // undefined until drawn: `fresh` says so
  const fresh = !row;
  if (fresh) {
    if (event.kind !== 'side') return null; // an answer whose question is on an earlier page
    row = sideRow(id, data, ticket, live);
    rows.set(id, row);
  }
  if (event.kind === 'side') {
    const a = h('div', { class: 'side-a waiting' }, 'Looking…');
    row.list.append(h('div', { class: 'side-item', 'data-ask': event.id }, h('div', { class: 'side-q' }, data.q), a));
    row.state = 'asking';
  } else {
    const a = row.list.querySelector(`[data-ask="${data.ask}"] .side-a`);
    a?.classList.remove('waiting');
    a?.classList.toggle('failed', !data.ok);
    a?.replaceChildren(data.ok ? markdown(/** @type {string} */ (data.text), event.ticket_id) : h('span', {}, data.text));
    if (typeof data.cost_usd === 'number') row.cost += data.cost_usd;
    row.state = data.ok ? 'answered' : 'failed';
    row.at = event.created_at;
  }
  row.draw();
  return fresh ? row.el : null;
}

// A half-typed follow-up, kept per thread: the row is drawn again when older history loads or the chat reopens (T8).
const drafts = new Map();

/** @param {number} id @param {SideData} first @param {Ticket} ticket @param {boolean | undefined} live @returns {SideRow} */
function sideRow(id, first, ticket, live) {
  const mine = first.by === me;
  const who = asSpeaker(h('span', { class: 'who' }), 'person', first.by);
  const preview = h('span', { class: 'preview' }, first.q);
  const list = h('div', { class: 'side-list' });
  const foot = h('div', { class: 'side-foot' });
  const box = h('textarea', { rows: 2, placeholder: 'Follow up on the side…' });
  const ask = h('button', { type: 'button', class: 'small side-go' }, 'Ask');
  const follow = h(
    'form',
    { class: 'side-follow', hidden: true },
    box,
    h(
      'span',
      { class: 'row' },
      ask,
      h(
        'button',
        {
          type: 'button',
          class: 'small secondary',
          onclick: () => {
            follow.hidden = true;
            box.value = '';
            drafts.delete(key);
          },
        },
        'Cancel',
      ),
    ),
  );
  const followBtn =
    mine &&
    h(
      'button',
      {
        type: 'button',
        class: 'small secondary',
        onclick: () => {
          follow.hidden = false;
          box.focus();
        },
      },
      'Follow up',
    );
  const toMinion = h('button', { type: 'button', class: 'small secondary', title: 'Posts this question and answer to the minion as a message from you' }, 'Send to the minion');
  const actions = h('span', { class: 'row side-actions' }, followBtn || '', toMinion);
  const el = h('details', { class: 'msg coord side-thread', 'data-thread': id, open: (mine && live) || null }, h('summary', {}, who, preview), list, follow, h('div', { class: 'side-bottom' }, foot, actions));
  /** @type {SideRow} */
  const row = { el, list, cost: 0, state: 'asking', at: null, draw: () => {} };
  const key = `${ticket.id}:${id}`;
  if (drafts.has(key)) {
    box.value = drafts.get(key);
    follow.hidden = false;
  }
  box.addEventListener('input', () => (box.value ? drafts.set(key, box.value) : drafts.delete(key)));

  follow.onsubmit = (e) => {
    e.preventDefault();
    const text = box.value.trim();
    if (!text) return;
    box.value = '';
    drafts.delete(key);
    follow.hidden = true;
    api(`api/tickets/${ticket.id}/side`, { method: 'POST', body: { text, thread: id } }).catch((ex) => {
      box.value ||= text;
      drafts.set(key, box.value);
      follow.hidden = false;
      foot.textContent = `Not asked: ${ex.message}`;
    });
  };
  ask.onclick = () => follow.requestSubmit();
  box.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      follow.requestSubmit();
    }
  };
  toMinion.onclick = () => {
    const send = /** @type {(HTMLElement & { sendText?: (text: string) => void }) | null} */ (document.querySelector('.chat .composer'))?.sendText;
    const lines = [...list.children].map((x) => `> ${/** @type {Element} */ (x.querySelector('.side-q')).textContent.replace(/\n/g, '\n> ')}\n\n${/** @type {HTMLElement} */ (x.querySelector('.side-a')).innerText.trim()}`);
    send?.(`From a side question:\n\n${lines.join('\n\n')}`);
  };

  row.draw = () => {
    const asking = row.state === 'asking';
    const state = asking ? 'looking…' : row.state === 'failed' ? `no answer ${clock(row.at)}` : `answered ${clock(row.at)}`;
    who.replaceChildren(h('span', { class: 'name' }, `Side question · ${first.by} · ${state}`));
    el.classList.toggle('asking', asking);
    if (followBtn) followBtn.disabled = asking;
    toMinion.disabled = asking;
    const n = ticket.number ?? ticket.id;
    foot.textContent = `Not in #${n}'s history. Ran on ${mine ? 'your' : `${first.by}'s`} login${row.cost ? `, $${row.cost.toFixed(2)}` : ''}.`;
  };
  return row;
}
