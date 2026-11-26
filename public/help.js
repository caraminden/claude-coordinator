// "How Citadel works" (#1131): one short page, five steps with real screenshots, under Settings → You. Its words
// come from help-words.js, the same file the hover tips on labels read. It describes Citadel, not any one scheme;
// "Show me" links are #1122's (?show=<part>) and point at the real control in the scheme you have open.
import { h, view } from './base.js';
import { WORDS } from './help-words.js';
import { settingsTabs, settingsTitle } from './settings.js';
/** @import { Child } from './base.js' */

/**
 * A word in a sentence: lowercase, but Taskmaster and Grunt are names.
 * @param {keyof typeof WORDS} key
 * @param {string} [tail]
 */
const w = (key, tail = '') => h('strong', {}, (/^(taskmaster|grunt)$/.test(key) ? WORDS[key].word : WORDS[key].word.toLowerCase()) + tail);
/**
 * @param {string} part
 * @param {string} text
 */
const show = (part, text) => h('a', { class: 'help-show', href: `#/p/${/** @type {NonNullable<typeof view>} */ (view).projectId}?show=${part}` }, text);
/**
 * The screenshots are real ones from a dev copy (tools/ui-shot.ts), as public/help-<name>.png (the server serves public/ flat).
 * @param {string} name
 * @param {string} alt
 */
const shot = (name, alt) => h('img', { class: 'help-shot', src: `help-${name}.png`, alt, loading: 'lazy' });

/** The steps: [title, words, [screenshot, alt], link]. */
/** Each step: its title, its words, its screenshot [file, alt] and a Show me link. @type {() => [string, Child[], [string, string], Child?][]} */
const STEPS = () => [
  ['A scheme is one project', ['A ', w('scheme'), " is one project's workspace. Each has its own Taskmaster, minions, rules and members. The schemes you belong to sit in the strip on the left; click one to switch."], ['schemes', 'The strip of schemes on the left of Citadel'], null],
  ['You ask the Taskmaster', ['Say what you want in the message box. The ', w('taskmaster'), ' reads it, makes a plan and starts a ', w('minion'), ' for each job.'], ['ask', 'The Taskmaster chat with the message box at the bottom'], show('message-box', 'Show me the message box')],
  [
    'A minion does the work',
    ['A ', w('minion'), ' is one Claude session on one job. It has its own chat: read along, steer it, or leave it. It may start ', w('grunt', 's'), ' for side jobs. Each ', w('turn'), ' is one stretch of it working. A minion on hold is ', w('parked'), '.'],
    ['minions', 'The minions list on the left, grouped by what each is doing'],
    show('minion-list', 'Show me the minions list'),
  ],
  ['A card wants something from you', ['When a minion needs a choice, an approval or a go, it puts a ', w('card'), ' in its chat and in the "waits on you" strip. It waits until someone answers; nothing else of yours is blocked.'], ['card', 'A card in a minion chat with options to pick'], null],
  ['Shipped means it went in', ['When the work is tested and reviewed, the minion will ', w('ship'), ' it: the change goes into the real code. Its chat shows how far along it is, and the Releases page shows what is live.'], ['shipped', "A minion's header showing its shipping progress"], null],
];

export function helpPage() {
  return h(
    'section',
    { class: 'artifacts-main help-page' },
    h('div', { class: 'ticket-head' }, h('div', { class: 'row' }, ...settingsTitle()), settingsTabs(), h('div', { class: 'meta' }, 'Two minutes: what a scheme is, how you ask, what a minion does, what a card wants and what shipped means.')),
    h(
      'ol',
      { class: 'help-steps' },
      STEPS().map(([title, words, [img, alt], link]) => h('li', { class: 'help-step' }, h('h3', {}, title), h('p', {}, ...words), link ? h('p', {}, link) : '', shot(img, alt))),
    ),
    h('h3', { class: 'help-words-title' }, 'The words'),
    h(
      'dl',
      { class: 'help-words' },
      Object.values(WORDS).flatMap((x) => [h('dt', {}, x.word), h('dd', {}, x.def)]),
    ),
  );
}
