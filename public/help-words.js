// Plain-words help (#1131): Citadel's own words, said once. The "How Citadel works" page (help.js) and the welcome page read WORDS. Every scheme: the words
// describe Citadel, not any one scheme. A member reads the copy before it ships.
import { h } from './base.js';

/** key: the word as a label shows it, and one sentence (two at most) of what it is. */
export const WORDS = {
  scheme: { word: 'Scheme', def: "A scheme is one project's workspace: its own Taskmaster, minions, rules and members. What you see is always inside one scheme." },
  taskmaster: { word: 'Taskmaster', def: 'The Taskmaster is the Claude you talk to in a scheme. Tell it what you want; it starts minions to do the work and keeps track of them.' },
  minion: { word: 'Minion', def: 'A minion is one Claude session working on one job, with its own chat. You can read along, steer it, or leave it to finish.' },
  grunt: { word: 'Grunt', def: 'A Grunt is a small helper a minion starts for a side job, like searching the code or reviewing a change. It reports back to its minion.' },
  card: { word: 'Card', def: 'A card is a question a minion needs you to answer: a choice, a plan to approve, or a go to ship. The minion waits until someone answers.' },
  turn: { word: 'Turn', def: 'A turn is one stretch of Claude working. It starts when a message reaches it and ends when it has answered or is waiting on you.' },
  ship: { word: 'Ship', def: "To ship is to put a finished change into the project's main code. Whether it is live right after depends on the project." },
  parked: { word: 'Sealed', def: 'A sealed minion is on hold on purpose. Messages to it wait until you, its Taskmaster or the thing it waits for wakes it.' },
  contraption: { word: 'Contraption', def: 'A contraption is a small app that runs inside Citadel, with its own page and often its own agent.' },
};

/** A label that names a Citadel word. No tip, no underline (Josh, 2026-11-20: "not worth the annoyance"); the help page keeps the definitions. */
export function gloss(_key, children) {
  return h('span', {}, children);
}
