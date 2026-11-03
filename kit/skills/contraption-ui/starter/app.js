// A contraption's page script on Citadel UI. Imports come from Citadel, live (citadel:contraption-ui).
import { initDrawers } from '/apps/_citadel/drawers.js';
import { updateMarkdown } from '/apps/_citadel/ui/markdown.js';

// Phones: the sections slide in from the left edge; a swipe past them opens the app switcher.
initDrawers({ left: { el: document.getElementById('sections'), label: 'Sections' }, main: document.getElementById('main') });

const reply = document.getElementById('reply');
const sample = '## A reply\n\nThe agent writes **markdown**:\n\n1. numbered lists\n2. tables\n\n| Piece | Gives |\n|---|---|\n| Wand | Spell damage |\n\nand [links](https://example.com) that open a new tab.';

// Stream it in as an agent's reply would arrive, then draw it whole.
document.getElementById('ask').addEventListener('click', () => {
  let n = 0;
  const tick = setInterval(() => {
    n = Math.min(n + 6, sample.length);
    updateMarkdown(reply, sample.slice(0, n), { streaming: n < sample.length });
    if (n === sample.length) clearInterval(tick);
  }, 30);
});
updateMarkdown(reply, 'Press **Ask** to stream a sample reply.');
