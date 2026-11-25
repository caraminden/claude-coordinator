// Speaker avatars in chat (#1976; Josh, 2026-11-25): each speaker's avatar beside their name, for a person who turned
// it on in their account (off for everyone else). Every speaker's name is marked with who it is; avatars.css draws
// from the marks only under html.speaker-avatars, so off draws nothing and the switch needs no redraw.
import { GITHUB_NAME, machineAuthor, senderTone } from './chattext.js';

/** What api/me says: on, your own picture, and every person by display name with their picture's URL or null. */
let now = { on: false, pic: null, people: {} };
export const avatars = () => now;

/** How many hues people's names take (avatars.css); by place in the list of people, so a small group never shares one. */
const HUES = 4;

export function setAvatars(next) {
  now = next ?? { on: false, pic: null, people: {} };
  // Node tests sign in with no page.
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('speaker-avatars', now.on);
  for (const el of document.querySelectorAll('[data-speaker="person"]')) dress(el);
}

function dress(el) {
  const name = el.dataset.person;
  const at = Object.keys(now.people).indexOf(name);
  // Someone removed since still gets a steady hue, from their name.
  el.dataset.personHue = (at >= 0 ? at : [...name].reduce((sum, c) => sum + c.codePointAt(0), 0)) % HUES;
  const pic = now.people[name];
  el.classList.toggle('has-pic', !!pic);
  if (pic) el.style.setProperty('--avatar', `url("${new URL(pic, document.baseURI)}")`);
  else el.style.removeProperty('--avatar');
}

/** Mark a speaker's name element: kind is minion, taskmaster, overlord, grunt, citadel, github or person (then `name` is theirs). */
export function asSpeaker(el, kind, name = '') {
  el.dataset.speaker = kind;
  if (kind === 'person') {
    el.dataset.person = name;
    el.dataset.initial = [...name.trim()][0]?.toUpperCase() ?? '?';
    dress(el);
  }
  return el;
}

/** The kind of speaker a message's author is (src/server authors, as senderTone and machineAuthor read them). */
export function authorKind(author) {
  const tone = { 'from-tm': 'taskmaster', 'from-minion': 'minion', 'from-app': 'citadel' }[senderTone(author)];
  // What machineAuthor knows and senderTone doesn't: GitHub, and a contraption's ask from before #316.
  return tone ?? (author === GITHUB_NAME ? 'github' : machineAuthor(author) ? 'citadel' : 'person');
}
