// One-tap replies (#105): the short go-aheads a minion offers at the end of a turn (set_thread_status
// replies), as buttons that send their text as your message. They go once anyone writes or a turn starts.
import { h } from './core.js';
import { optimistic } from './ui/optimistic.js';

/**
 * The minion's replies as a row of buttons, or '' when it offers none (or is running or dismissed).
 * `send` sends a reply's text. Only the minion's own chat shows them (#130), never the list or inbox rows.
 */
export function replyChips(t, send) {
  if (!t.replies?.length || t.status === 'running' || t.status === 'closed') return '';
  const box = h('span', { class: 'replies', role: 'group', 'aria-label': 'One-tap replies' });
  box.append(...t.replies.map((text) => h('button', { type: 'button', class: 'reply-chip', title: `Send "${text}" to the minion`, onclick: (e) => {
    // The message shows in the chat at once (send); the other replies stay tappable, and a refusal frees this one again.
    const tapped = e.currentTarget;
    const mark = (on) => {
      tapped.disabled = on;
      tapped.classList.toggle('sent', on);
    };
    optimistic({ key: 'reply', apply: () => mark(true), send: () => send(text), undo: () => mark(false), label: `send "${text}"` });
  } }, text)));
  return box;
}
