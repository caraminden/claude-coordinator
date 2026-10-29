// One-tap replies (#105): the short go-aheads a minion offers at the end of a turn (set_thread_status
// replies), as buttons that send their text as your message. They go once anyone writes or a turn starts.
import { api, h } from './core.js';
import { alertNote } from './composer.js';

/**
 * The minion's replies as a row of buttons, or '' when it offers none (or is running or dismissed).
 * `send` sends a reply's text; by default straight to the minion, for rows that aren't its chat.
 */
export function replyChips(t, send = (text) => api(`api/tickets/${t.id}/messages`, { method: 'POST', body: { text } })) {
  if (!t.replies?.length || t.status === 'running' || t.status === 'closed') return '';
  const box = h('span', { class: 'replies', role: 'group', 'aria-label': 'One-tap replies' });
  box.append(...t.replies.map((text) => h('button', { type: 'button', class: 'reply-chip', title: `Send "${text}" to the minion`, onclick: async (e) => {
    // The list and inbox rows are links; a tap on a chip sends without opening the chat.
    e.preventDefault();
    e.stopPropagation();
    const tapped = e.currentTarget;
    const buttons = [...box.children];
    if (buttons.some((b) => b.disabled)) return;
    for (const b of buttons) b.disabled = true;
    tapped.classList.add('sent');
    try {
      await send(text);
    } catch (ex) {
      for (const b of buttons) b.disabled = false;
      tapped.classList.remove('sent');
      alertNote(ex.message);
    }
  } }, text)));
  return box;
}
