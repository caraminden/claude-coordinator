// A contraption's page script on Citadel UI. Imports come from Citadel, live (citadel:contraption-ui).
import { initDrawers } from '/apps/_citadel/drawers.js';
import { mountComposer } from '/apps/_citadel/ui/composer.js';
import { updateMarkdown } from '/apps/_citadel/ui/markdown.js';

// Phones: the sections slide in from the left edge; a swipe past them opens the app switcher.
initDrawers({ left: { el: document.getElementById('sections'), label: 'Sections' }, main: document.getElementById('main') });

const reply = document.getElementById('reply');
const sample = '## A reply\n\nThe agent writes **markdown**:\n\n1. numbered lists\n2. tables\n\n| Piece | Gives |\n|---|---|\n| Wand | Spell damage |\n\nand [links](https://example.com) that open a new tab.';

// The message box: send() streams the sample in as an agent's reply would arrive; Stop ends it early.
let tick = null;
const done = () => {
  clearInterval(tick);
  box.busy(false);
};
const box = mountComposer(document.getElementById('compose'), {
  placeholder: 'Ask something…',
  draftKey: 'my-app:draft',
  send: async (text) => {
    // Your app POSTs `text` here; a rejection puts it back in the box with the error.
    box.busy(true);
    let n = 0;
    tick = setInterval(() => {
      n = Math.min(n + 6, sample.length);
      updateMarkdown(reply, sample.slice(0, n), { streaming: n < sample.length });
      if (n === sample.length) done();
    }, 30);
  },
  stop: done,
});
updateMarkdown(reply, 'Send a message to stream a sample reply.');
