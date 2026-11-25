// A first-day welcome (#1151, src/welcome.ts): five steps over a new person's Taskmaster chat, each ticked from what the
// server knows, with the three words a newcomer meets first. It renders from api/me's `welcome`, loaded at boot, so it
// is there with the chat and never pops in over it; later looks only tick rows in place. Gone for good once every step
// is done (after one "You're set") or it is dismissed. Every scheme: the steps name no scheme, and the words list yours.
import { account, api, h, me, view } from './base.js';
import { WORDS } from './help-words.js';
import { toast } from './ui/status.js';

const HIDDEN = 'cc-welcome-hidden'; // a person who folded it to its top line keeps it folded on this device

/** The steps (src/welcome.ts's STEPS), each with where "show me" goes; null where there is nowhere yet (no scheme). */
function steps(pid) {
  const at = (page, part) => (pid == null ? null : `#/p/${pid}${page}?show=${part}`);
  return [
    { key: 'password', title: 'Set your password', sub: 'Done when you took your invite.', href: at('/account', 'password') },
    { key: 'claude', title: 'Link your Claude', sub: pid == null ? "Once you're in a scheme, under Settings → Your account." : "Until you do, your messages don't start any work.", href: at('/account', 'claude-login') },
    { key: 'phone', title: 'Put Citadel on your phone', sub: 'Install it and allow notifications, so cards reach you.', href: at('/notifications', 'notify-this-device') },
    { key: 'hi', title: 'Say hi to your Taskmaster', sub: pid == null ? "You're not in a scheme yet: ask whoever invited you to add you, or make one below." : 'It answers with what your schemes are doing right now.', href: at('', 'message-box') },
    { key: 'card', title: 'Answer a practice card', sub: 'A practice one. Nothing ships.', href: null },
  ];
}

/** The practice card's answers; the server takes only these (src/welcome.ts CARD_OPTIONS). */
const OPTIONS = ['Ask my Taskmaster for something small', 'Read along with a minion', 'Just look around for now'];

let live = null; // { el, draw } of the panel on screen, so a later look ticks it in place

/**
 * The panel for `account.welcome`, or nothing when it's gone. `pid` is the scheme whose pages the steps link into
 * (null on the no-scheme page); `schemes` are the names of the schemes you're in, for the words.
 */
export function welcomePanel(pid, schemes) {
  const w = account?.welcome;
  if (!w) return (live = null);
  const list = steps(pid);
  const ring = h('div', { class: 'welcome-ring', role: 'img' }, h('span', { 'aria-hidden': 'true' }));
  const sub = h('span', { class: 'welcome-sub muted' });
  let folded = false;
  try {
    folded = localStorage.getItem(HIDDEN) === '1';
  } catch {}
  const fold = h('button', { type: 'button', class: 'small secondary welcome-fold' });
  const close = h('button', { type: 'button', class: 'small secondary welcome-close', title: "Don't show this again", 'aria-label': 'Dismiss the welcome for good' }, '×');
  const rows = list.map((s) => {
    const box = h('span', { class: 'welcome-box', 'aria-hidden': 'true' }, '✓');
    const text = h('span', { class: 'welcome-text' }, h('b', {}, s.title), h('span', { class: 'welcome-step-sub muted' }, s.sub));
    const row = s.href ? h('a', { class: 'welcome-step', href: s.href }, box, text) : s.key === 'card' ? h('button', { type: 'button', class: 'welcome-step' }, box, text) : h('div', { class: 'welcome-step' }, box, text);
    return { s, row, text };
  });
  const practice = practiceCard();
  const cardRow = rows.find((r) => r.s.key === 'card').row;
  cardRow.setAttribute('aria-expanded', 'false');
  cardRow.addEventListener('click', () => {
    const open = practice.hidden;
    practice.hidden = !open;
    cardRow.setAttribute('aria-expanded', String(open));
  });
  const yours = schemes.length ? `You're in ${schemes.join(' and ')}.` : "You're not in one yet.";
  // Open beside the steps on a wide screen; on a phone, under them behind a toggle, so the steps fit the screen.
  const words = h(
    'details',
    { class: 'welcome-words', open: !matchMedia('(max-width: 800px)').matches },
    h('summary', {}, 'What the words mean'),
    h('p', {}, h('b', {}, WORDS.scheme.word), ': ', WORDS.scheme.def, ' ', yours),
    h('p', {}, h('b', {}, WORDS.taskmaster.word), ': ', WORDS.taskmaster.def),
    h('p', {}, h('b', {}, WORDS.minion.word), ': ', WORDS.minion.def),
  );
  const body = h('div', { class: 'welcome-body' }, h('div', { class: 'welcome-steps' }, ...rows.map((r) => r.row), practice), words);
  const el = h('section', { class: 'welcome', 'aria-label': 'Welcome to Citadel' }, h('div', { class: 'welcome-head' }, ring, h('div', { class: 'welcome-title' }, h('h3', {}, `Welcome, ${me}`), sub), fold, close), body);

  const draw = (w) => {
    const n = list.filter((s) => w.steps[s.key]).length;
    ring.firstChild.textContent = `${n}/5`;
    ring.style.setProperty('--p', String(n * 20));
    ring.setAttribute('aria-label', `${n} of 5 done`);
    sub.textContent = w.done ? "You're set. This panel goes away now." : "Five small things and you're running. About 4 minutes.";
    el.classList.toggle('done', w.done);
    for (const r of rows) r.row.classList.toggle('ticked', !!w.steps[r.s.key]);
    practice.answer(w.card);
  };
  const setFolded = (f) => {
    folded = f;
    body.hidden = f;
    fold.textContent = f ? 'Show' : 'Hide';
    fold.setAttribute('aria-expanded', String(!f));
    try {
      f ? localStorage.setItem(HIDDEN, '1') : localStorage.removeItem(HIDDEN);
    } catch {}
  };
  fold.addEventListener('click', () => setFolded(!folded));
  close.addEventListener('click', () => {
    // Gone at once; the server hears behind it, and a failure brings it back with a retry.
    const before = account.welcome;
    account.welcome = null;
    el.hidden = true;
    wrote++;
    api('api/welcome', { method: 'POST', body: { dismiss: true } }).then(
      () => {
        el.remove();
        if (live?.el === el) live = null;
      },
      () => {
        el.hidden = false; // still mounted, so it really is back
        account.welcome = before;
        toast("Couldn't hide the welcome. It's back for now.", { tone: 'danger' });
      },
    );
  });
  setFolded(folded);
  draw(w);
  live = { el, draw };
  return el;

  /** The practice card: the three answers as buttons, your pick shown on its button. */
  function practiceCard() {
    const buttons = OPTIONS.map((o) => h('button', { type: 'button', class: 'small secondary', 'data-option': o }, o));
    const card = h('div', { class: 'welcome-card', hidden: true }, h('p', {}, h('b', {}, 'Practice card. '), 'What would you like to do first? Nothing ships, whichever you pick.'), h('div', { class: 'welcome-options' }, ...buttons));
    card.answer = (picked) => {
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.option === picked));
    };
    for (const b of buttons)
      b.addEventListener('click', () => {
        const o = b.dataset.option;
        if (!account.welcome || account.welcome.card) return; // answered, or finished: it's a practice card, not a setting
        const before = account.welcome;
        wrote++;
        account.welcome = { ...before, card: o, steps: { ...before.steps, card: true } };
        draw(account.welcome);
        api('api/welcome', { method: 'POST', body: { card: o } })
          .then((r) => welcomeLooked(r.welcome))
          .catch(() => {
            account.welcome = before;
            draw(before);
            toast("Couldn't send your answer. Pick it again.", { tone: 'danger' });
          });
      });
    return card;
  }
}

/** Take a fresh look from the server and tick the panel in place; once it says done, the next mount shows nothing. */
function welcomeLooked(w) {
  if (!account) return;
  account.welcome = w?.done ? null : w;
  if (!live?.el.isConnected) return;
  if (w) live.draw(w);
  else {
    live.el.remove();
    live = null;
  } // finished or dismissed elsewhere (another tab, your phone)
}

let asking = null;
let wrote = 0; // counts the hides and picks sent: a read that began before one is older than it and is dropped
/** Ask the server again (on mount, on focus, after you write): a step done elsewhere ticks here. */
export function refreshWelcome() {
  if (!account?.welcome || asking) return;
  const at = wrote;
  asking = api('api/welcome')
    .then((r) => at === wrote && welcomeLooked(r.welcome))
    .catch(() => {})
    .finally(() => (asking = null));
}

/** The welcome for the chat open now: only over your Taskmaster's chat, in a scheme you're in. */
export function chatWelcome(ticket) {
  if (ticket?.kind !== 'coordinator' || !account?.welcome) return null;
  const schemes = (view.projects ?? []).filter((p) => p.member !== false && !p.hidden).map((p) => p.name);
  const el = welcomePanel(ticket.project_id, schemes);
  if (el) queueMicrotask(refreshWelcome);
  return el;
}

addEventListener('focus', refreshWelcome);
