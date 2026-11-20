// Plain-words help (#1131): Citadel's own words, said once. The hover and tap tips on labels in the app's chrome
// (gloss) and the "How Citadel works" page (help.js) both read WORDS, so they can't drift. Not for chat text: agents'
// replies and people's messages never get these underlines (Josh's handoff, 2026-11-19). Every scheme: the words
// describe Citadel, not any one scheme. A member reads the copy before it ships.
import { h } from './base.js';
import { mountTips } from './ui/tip.js';

/** key: the word as a label shows it, and one sentence (two at most) of what it is. */
export const WORDS = {
  scheme: { word: 'Scheme', def: "A scheme is one project's workspace: its own Taskmaster, minions, rules and members. What you see is always inside one scheme." },
  taskmaster: { word: 'Taskmaster', def: 'The Taskmaster is the Claude you talk to in a scheme. Tell it what you want; it starts minions to do the work and keeps track of them.' },
  minion: { word: 'Minion', def: 'A minion is one Claude session working on one job, with its own chat. You can read along, steer it, or leave it to finish.' },
  grunt: { word: 'Grunt', def: 'A Grunt is a small helper a minion starts for a side job, like searching the code or reviewing a change. It reports back to its minion.' },
  card: { word: 'Card', def: 'A card is a question a minion needs you to answer: a choice, a plan to approve, or a go to ship. The minion waits until someone answers.' },
  turn: { word: 'Turn', def: 'A turn is one stretch of Claude working. It starts when a message reaches it and ends when it has answered or is waiting on you.' },
  ship: { word: 'Ship', def: "To ship is to put a finished change into the project's main code. Whether it is live right after depends on the project." },
  parked: { word: 'Parked', def: 'A parked minion is on hold on purpose. Messages to it wait until you, its Taskmaster or the thing it waits for wakes it.' },
  contraption: { word: 'Contraption', def: 'A contraption is a small app that runs inside Citadel, with its own page and often its own agent.' },
};

/**
 * `children` as a label that explains itself: a tip on hover and a tap (a long press on a button or
 * link). `more` adds a second line under the sentence. The element carries no title, so only one box ever opens.
 */
export function gloss(key, children, more) {
  return h('span', { class: 'gloss', 'data-gloss': key, 'data-gloss-more': more ?? null }, children);
}

let tips = null;
/** Start the glossary's tips on every `.gloss` in the page, once. */
export function mountGloss() {
  tips ??= mountTips(document.body, {
    selector: '[data-gloss]',
    body: (el) => {
      const w = WORDS[el.dataset.gloss];
      if (!w) return null;
      const box = h('div', { class: 'gloss-tip' }, h('strong', {}, w.word), h('p', { class: 'cui-tip-text' }, w.def));
      if (el.dataset.glossMore) box.append(h('p', { class: 'cui-tip-text muted' }, el.dataset.glossMore));
      return box;
    },
  });
}
