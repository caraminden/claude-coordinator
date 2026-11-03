// A contraption's page script on Citadel UI. Imports come from Citadel, live (citadel:contraption-ui).
import { initDrawers } from '/apps/_citadel/drawers.js';
import { mountChat } from '/apps/_citadel/ui/chat.js';
import { mountComposer } from '/apps/_citadel/ui/composer.js';

// Phones: the sections slide in from the left edge; a swipe past them opens the app switcher.
initDrawers({ left: { el: document.getElementById('sections'), label: 'Sections' }, main: document.getElementById('main') });

const chat = mountChat(document.getElementById('chat'), {
  empty: 'Send a message to see a sample reply.',
  // A step's words, worded to read right running and done; anything else gets its tool's short name.
  stepLabel: (name, input) => (name === 'mcp__my_app__save_note' ? `Saving “${input.title}”` : undefined),
  onReply: (message) => run(message),
});

// A stand-in for your server: the turn-API events it would relay, one every 400 ms. Yours POSTs the
// text to your server, which calls Citadel's turn API and streams each event back to chat.push().
const SAMPLE = [
  ['text', { delta: 'Let me look at your **notes**.', parent: null, message: 'm1' }],
  ['tool', { id: 't1', name: 'mcp__my_app__list_notes', input: {}, parent: null }],
  ['tool_result', { id: 't1', ok: true, parent: null }],
  ['tool', { id: 'g', name: 'Agent', input: { description: 'Check the calendar' }, parent: null }],
  ['tool', { id: 'g1', name: 'mcp__my_app__calendar', input: {}, parent: 'g' }],
  ['tool_result', { id: 'g1', ok: true, parent: 'g' }],
  ['tool_result', { id: 'g', ok: true, parent: null }],
  ['tool', { id: 't2', name: 'mcp__my_app__save_note', input: { title: 'Thursday' }, parent: null }],
  ['tool_result', { id: 't2', ok: true, parent: null }],
  ['text', { delta: 'Saved **Thursday**:\n\n1. dentist at 9\n2. ', parent: null, message: 'm2' }],
  ['text', { delta: 'errands after\n\nAnything else?', parent: null, message: 'm2' }],
  ['end', { stop: 'end_turn' }],
];
let tick = null;
const finish = (event) => {
  clearInterval(tick);
  if (event) chat.push(event);
  box.busy(false);
};
// Your app POSTs `text` here; a rejection puts it back in the box with the error.
async function run(text) {
  chat.ask(text);
  box.busy(true);
  let n = 0;
  tick = setInterval(() => {
    const [type, data] = SAMPLE[n++];
    chat.push({ type, data });
    if (type === 'end') {
      finish();
      chat.replies([{ label: 'Add one more', recommended: true }, { label: 'That\'s all' }]);
    }
  }, document.getElementById('quick').checked ? 100 : 400);
}
const box = mountComposer(document.getElementById('compose'), {
  placeholder: 'Ask something…',
  draftKey: 'my-app:draft',
  send: run,
  // Stop: yours calls the turn API's cancel; the `canceled` error it streams ends the turn in the chat.
  stop: () => finish({ type: 'error', data: { code: 'canceled', message: 'turn canceled' } }),
});
