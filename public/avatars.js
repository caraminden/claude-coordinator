// Speaker avatars in chat (#1976; Josh, 2026-11-25): each speaker's avatar beside their name, for a person who turned
// it on in their account (off for everyone else). Every speaker's name is marked with who it is; avatars.css draws
// from the marks only under html.speaker-avatars, so off draws nothing and the switch needs no redraw.
import { GITHUB_NAME, machineAuthor, senderTone } from './chattext.js';

/** @import { Account } from './types.js' */
/** @typedef {NonNullable<Account['avatars']>} Avatars */

/**
 * What api/me says: on, your own picture, and every person by display name with their picture's URL or null.
 * @type {Avatars}
 */
let now = { on: false, pic: null, people: {} };
export const avatars = () => now;

/** How many hues people's names take (avatars.css); by place in the list of people, so a small group never shares one. */
const HUES = 4;

/** @param {Avatars | null | undefined} next */
export function setAvatars(next) {
  now = next ?? { on: false, pic: null, people: {} };
  // Node tests sign in with no page.
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('speaker-avatars', now.on);
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-speaker="person"]'))) dress(el);
}

/** @param {HTMLElement} el */
function dress(el) {
  const name = /** @type {string} */ (el.dataset.person);
  const at = Object.keys(now.people).indexOf(name);
  // Someone removed since still gets a steady hue, from their name.
  el.dataset.personHue = String((at >= 0 ? at : [...name].reduce((sum, c) => sum + /** @type {number} */ (c.codePointAt(0)), 0)) % HUES);
  const pic = at >= 0 ? now.people[name] : null;
  el.classList.toggle('has-pic', !!pic);
  if (pic) el.style.setProperty('--avatar', `url("${new URL(pic, document.baseURI)}")`);
  else el.style.removeProperty('--avatar');
}

/**
 * Mark a speaker's name element: kind is minion, taskmaster, overlord, grunt, citadel, github or person (then `name` is theirs).
 * @template {HTMLElement} E
 * @param {E} el
 * @param {string} kind
 * @param {string} [name]
 * @returns {E}
 */
export function asSpeaker(el, kind, name = '') {
  el.dataset.speaker = kind;
  if (kind === 'person') {
    el.dataset.person = name;
    el.dataset.initial = [...name.trim()][0]?.toUpperCase() ?? '?';
    dress(el);
  }
  return el;
}

/**
 * The kind of speaker a message's author is (src/server authors, as senderTone and machineAuthor read them).
 * @param {string | null | undefined} author
 */
export function authorKind(author) {
  // A split scheme's Overlord signs what it sends another scheme (senderLabel, src/routes/projects.ts).
  if (/^Taskmaster of .+ \(the Overlord\)$/.test(author ?? '')) return 'overlord';
  const tone = /** @type {Record<string, string>} */ ({ 'from-tm': 'taskmaster', 'from-minion': 'minion', 'from-app': 'citadel' })[senderTone(author)];
  // What machineAuthor knows and senderTone doesn't: GitHub, and a contraption's ask from before #316.
  return tone ?? (author === GITHUB_NAME ? 'github' : machineAuthor(author) ? 'citadel' : 'person');
}
