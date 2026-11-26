// A minion's chat: its head, history, readout, cards and the working line.
/** @import { ChatEvent, EventsPage, NarrationSorter, Ticket, View } from './types.js' */
/** @typedef {NonNullable<View['merged']>} Merged */
/** @typedef {Parameters<typeof markQueued>[0] & import('./thread-head.js').Bubble & { source?: string, ticketId?: number }} Bubble A chat bubble with the fields composer.js and this file hang on it. */
import { account, api, baseName, noAutofill, clearHighlights, h, highlight, isCoordinator, jumpHref, me, openView, uploadUrl, view } from './base.js';
import { mergedView, TM_VIEW } from './mine.js';
import { toast } from './ui/status.js';
import { cachedEvents, catchUpEvents, chatScroller, loadEvents, followChat, loadEarlier, markdown, restoreScroll, scrollToBottom, scrollToUnread, sending, setSending, USER_SCROLL, takeJump, threadRefs, usage } from './core.js';
import { markSeen } from './seen.js';
import { alertNote, composer, outbox } from './composer.js';
import { TRACKING } from './heldmsg.js';
import { jobOf, rowState, workerWaitLabel, workingBy, workingLabel } from './threadstate.js';
import { jobCard, jobMovedNote } from './jobs.js';
import { recapEvent, showRecap } from './recap.js';
import { narrationSorter } from './narration.js';
import { gist, groupTitle, gruntName, gruntOf } from './grunts.js';
import { stepMark } from './ui/chat.js';
import { replyStartsOpen } from './cardreply.js';
import { pushNote, pushRun, pushRunParts, senderTone, shortDuration, shortNote } from './chattext.js';
import { ultraCard, ultraResult } from './ultrareview.js';
import { payerLine } from './payer.js';
import { sideEvent } from './sidethread.js';
import { selectActions } from './selectact.js';
import { chatWelcome, refreshWelcome } from './welcome.js';
import { applyEvent, createProgress, nowDoing, planEstimate, runningFor } from './progress.js';
import { asSpeaker, authorKind } from './avatars.js';
import { clamp, markQueued, messageBody, previewNodes, showTakenBack, strikeNote, unclamp, userBubble } from './bubbles.js';
import { initSeen, leftText, narrow, phaseRows, progressUi, renderProgress, scheduleProgress } from './progress-ui.js';
import { answerRef, answerSummary, approvalCard, loopCard, messagesBelow, planCard, questionCard, settleSpend, speaker, speakerKind, spendCard } from './cards.js';
import { markHeld, refreshBranch, renderTicketHead, unpark } from './thread-head.js';
import { openLine, startNowLine } from './worker-line.js';

// Mine or Everyone (#920): how this device opens your Taskmaster in a scheme with several.
export function tmViewMode() {
  try {
    return localStorage.getItem(TM_VIEW) === 'everyone' ? 'everyone' : 'mine';
  } catch {
    return 'mine';
  }
}

/** Mine and Everyone, in your Taskmaster's title row: the pick shows at once and the history follows. */
export function tmViewSwitch() {
  const now = /** @type {Merged} */ (openView().merged).mode;
  /** @param {string} mode @param {string} label @param {string} title */
  const pick = (mode, label, title) => h('button', { type: 'button', class: `chip${mode === now ? ' on' : ''}`, 'aria-pressed': String(mode === now), title, onclick: () => mode !== now && setTmView(mode) }, label);
  return h('span', { class: 'tm-views', role: 'group', 'aria-label': 'Which Taskmaster chats' }, pick('mine', 'Mine', "Your Taskmaster, with the Overlord's cards and alerts for everyone"), pick('everyone', 'Everyone', 'Every Taskmaster in this scheme and the Overlord, in time order'));
}

/** Mine's line under the title (board C): whose chats it leaves out, and a way there. */
export function tmBanner() {
  const rest = (openView().taskmasters ?? []).filter((t) => t.id !== openView().id);
  const names = rest.filter((t) => t.person_id != null).map((t) => `${t.person_name ?? 'Someone'}'s`);
  const whose = names.length ? `${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} Taskmasters` : `${names[0]} Taskmaster`}` : '';
  const said = [whose, rest.some((t) => t.person_id == null) ? 'the Overlord' : ''].filter(Boolean).join(' and ');
  return said && h('div', { class: 'tm-banner' }, `${said} ${rest.length > 1 ? 'are' : 'is'} in `, h('button', { type: 'button', class: 'link', onclick: () => setTmView('everyone') }, 'Everyone'), '.');
}

/** @param {string} mode */
async function setTmView(mode) {
  const v = openView();
  const before = /** @type {Merged} */ (v.merged).mode;
  try {
    localStorage.setItem(TM_VIEW, mode);
  } catch {}
  v.merged = mergedView(v.projectId, v.id, v.taskmasters, mode);
  renderTicketHead();
  const { src } = /** @type {Merged} */ (v.merged);
  try {
    const page = cachedEvents(src) ?? (await loadEvents(src));
    if (view !== v || /** @type {Merged} */ (v.merged).src !== src) return; // another view, or another flip, overtook this one
    v.page = page;
    renderHistory();
    scrollToBottom();
    await catchUpEvents().catch(() => {}); // tried again by itself (resync.js)
  } catch {
    if (view !== v || /** @type {Merged} */ (v.merged).src !== src) return;
    try {
      localStorage.setItem(TM_VIEW, before);
    } catch {}
    v.merged = mergedView(v.projectId, v.id, v.taskmasters, before);
    renderTicketHead();
    toast(`Couldn't load ${mode === 'everyone' ? 'Everyone' : 'Mine'}. Try again in a moment.`, { tone: 'warn' });
  }
}

/**
 * Per-thread state for the chat in the main panel; empty when the main panel shows something else.
 * @param {number | null} chatId
 * @param {Ticket | null} ticket
 * @param {ReturnType<typeof mergedView>} [merged]
 */
export function chatView(chatId, ticket, merged = null) {
  return {
    id: chatId,
    ticket,
    lastEventId: 0,
    merged, // your Taskmaster's chat as Mine or Everyone, several sessions in one log (#920, mine.js mergedView)
    progress: createProgress(),
    progressEl: h('div', { class: 'progress', hidden: true }), // lives in the thread bar
    findEl: chatId ? chatFindBox() : null, // lives in the thread bar too, so it survives re-renders
    ui: progressUi(chatId),
    actions: new Map(), // tool_use_id -> { block, taskId, result }
    turnActions: [], // actions of the current (or last) turn, in order
    startNowEl: h('span', { class: 'typing-act' }), // beside it: Start now, or whose worker it has and Release
    typingEl: h('button', { type: 'button', class: 'typing', hidden: true, title: 'Show the work so far' }), // below the chat log
    folds: [], // the running turn's settled words, { text, fate } in order, folded when its answer arrives (#551)
    sendingTo: /** @type {number | null} */ (null), // ticket id while a message is on its way, before the server confirms the turn
    pendingMessages: chatId ? outbox(chatId) : [], // messages on their way or not sent (composer.js), replaced by the server's copy
    sideThreads: new Map(), // side thread id -> its row (sidethread.js)
    cards: new Map(), // question card id -> { el, markAnswered }; plan card id -> { el, settle }; approval card id -> { settle }
    heldCards: [], // this turn's question and plan cards, kept below the words that explain them
    branchEl: h('span', { class: 'branch-status', hidden: true }), // PR / branch state, on the newest turn-end line
    scrolledByYou: false, // you've scrolled (or keyed, tapped) in this chat since it opened: see loadWhenReached
  };
}

/**
 * Scrolling into "Load earlier" loads it, as a click would (#288). Only once you've scrolled yourself, so
 * a chat that opens at the top, or a jump to an old message, doesn't load on its own. A wheel up with it
 * already in sight counts too: there's nowhere left to scroll.
 */
/** @param {HTMLButtonElement & { inView?: boolean }} button */
function loadWhenReached(button) {
  watchYourScrolling();
  earlierSeen?.disconnect(); // the last redraw's button is gone
  earlierSeen = new IntersectionObserver(([e]) => {
    button.inView = e.isIntersecting;
    if (e.isIntersecting && openView().scrolledByYou && !button.disabled && button.isConnected) showEarlier(button);
  });
  earlierSeen.observe(button);
}
/** @type {IntersectionObserver | null} */
let earlierSeen = null;
let watching = false;
// On first use, not at load: core.js imports this module before its own USER_SCROLL is set.
function watchYourScrolling() {
  if (watching) return;
  watching = true;
  for (const type of USER_SCROLL) {
    addEventListener(
      type,
      (/** @type {Event} */ e) => {
        if (!view?.page) return;
        view.scrolledByYou = true;
        const button = /** @type {(HTMLButtonElement & { inView?: boolean }) | null} */ (document.querySelector('#log > .load-earlier > button'));
        if (type === 'wheel' && /** @type {WheelEvent} */ (e).deltaY < 0 && /** @type {HTMLElement} */ (e.target).closest?.('#log') && button?.inView && !button.disabled) showEarlier(button);
      },
      { capture: true, passive: true },
    );
  }
}

/**
 * Fill in a chat section just put on the page: its head, its history, and where you were in it. `fromCache`: the
 * history came from this session's cache (#527), so what came since is still to come.
 */
/** @param {number} chatId @param {Ticket} ticket @param {EventsPage} page @param {boolean} [fromCache] */
export async function mountChat(chatId, ticket, page, fromCache) {
  renderTicketHead();
  openView().page = page;
  openView().openedSeenAt = openView().seen?.[chatId] ?? 0;
  renderHistory();
  if (ticket.branch) refreshBranch(chatId);
  markSeen(chatId);
  // Opened by a link to one thing in it (an inbox item, a notification), at that thing.
  const jump = takeJump();
  // Open at the first thing you haven't seen, marked New; a minion you've never opened, at the top of
  // what's loaded. Unread from before the loaded page also opens there, under "Load earlier".
  const place = async () => {
    const jumped = jump && (await jumpToEvent(jump));
    if (view?.id !== chatId || jumped) return;
    const divider = document.querySelector('#log > .unread-divider');
    if (!divider) restoreScroll(chatId);
    // A Taskmaster's history runs long; past that much unread, its newest matters more than where you left off.
    else if (isCoordinator(ticket) && /** @type {HTMLElement} */ (divider.parentElement).querySelectorAll(':scope > .unread-divider ~ [data-at]').length > TASKMASTER_UNREAD_LIMIT) scrollToBottom();
    else scrollToUnread(divider);
  };
  await place();
  if (view?.id !== chatId) return; // you moved on while it loaded back
  const v = view;
  if (fromCache) watchYourScrolling(); // a short chat has no Load earlier to have started it
  try {
    if (sessionStorage.getItem('cc-refocus')) {
      sessionStorage.removeItem('cc-refocus');
      /** @type {HTMLElement | null} */ (document.querySelector('.composer textarea'))?.focus();
    }
  } catch {}
  // What came since the cached copy, or was broadcast while the snapshot was loading (before `view` existed): one
  // request, its events added below what's drawn (#1531). Not awaited: the chat is drawn, so the route's dim
  // (body.navigating) clears now rather than after this round trip (#494).
  catchUpEvents()
    .then(async (added) => {
      // From the cache, it opens at the first unread as a fresh load would, unless you've scrolled meanwhile.
      if (!fromCache || !added || view !== v || openView().page !== page) return;
      markUnread();
      if (!openView().scrolledByYou) await place();
    })
    .then(() => void (isCoordinator(ticket) && view?.id === chatId && showRecap()))
    .catch(() => {}); // a missed catch-up is made good by the stream's next resync
}

/** Mark the first item you haven't seen New, unless one is marked already. */
function markUnread() {
  const log = document.getElementById('log');
  if (!log || log.querySelector(':scope > .unread-divider')) return;
  const at = [...log.children].find((el) => Number(/** @type {HTMLElement} */ (el).dataset.at) > openView().openedSeenAt);
  at?.before(h('div', { class: 'unread-divider', role: 'separator' }, h('span', {}, 'New')));
}

/**
 * Draw the log from the loaded history (view.page), from scratch: earlier pages go above, and a card
 * answered or a message struck by a later event has to see that event after its own. Messages still
 * on their way and the recap stay where they are.
 */
function renderHistory() {
  const log = document.getElementById('log');
  const page = openView().page;
  const recap = document.getElementById('recap');
  Object.assign(openView(), {
    lastEventId: 0,
    progress: { ...createProgress(), ...page.plan, tasks: structuredClone(page.tasks) },
    actions: new Map(),
    turnActions: [],
    cards: new Map(),
    sideThreads: new Map(),
    lastPlan: null,
    heldCards: [],
    gruntStarts: new Map(),
    // The session started on an earlier page, if there is one.
    sawInit: page.more,
    latestReply: null,
    turnNote: null,
    turnInitAt: undefined,
    narration: /** @type {NarrationSorter} */ (narrationSorter()),
    narrationEl: null,
    folds: [],
    pendingRequest: [],
    turnRequest: undefined,
  });
  const merged = openView().merged;
  if (merged) Object.assign(merged, { states: new Map(), last: openView().id });
  const earlier = page.more && h('button', { type: 'button', class: 'small secondary', onclick: (/** @type {MouseEvent} */ e) => showEarlier(/** @type {HTMLButtonElement} */ (e.currentTarget)) }, 'Load earlier');
  /** @type {HTMLElement} */ (log).replaceChildren(...(earlier ? [h('div', { class: 'load-earlier' }, earlier)] : []));
  if (earlier) loadWhenReached(earlier);
  if (isCoordinator(openView().ticket) && !page.events.length) {
    /** @type {HTMLElement} */ (log).append(h('div', { class: 'note' }, 'This is the Taskmaster for this scheme. It keeps track of the minions on the left and can create, message, rename and dismiss them for you.'));
  }
  for (const ev of page.events) appendEvent(ev, false);
  renderCardJump();
  markUnread();
  // Messages still on their way or not sent; the replay swapped out any that reached the server meanwhile, by sendId.
  /** @type {HTMLElement} */ (log).append(...openView().pendingMessages.map((m) => m.el), ...(recap ? [recap] : []));
  renderProgress();
  syncHeldBrief();
}

/** Keep `el` at `top` px down the screen as what's above it lays out, until you scroll yourself. */
/** @param {HTMLElement} el @param {number} top */
function holdInPlace(el, top) {
  const scroller = /** @type {Element} */ (chatScroller() ?? document.scrollingElement);
  const align = () => {
    scroller.scrollTop += el.getBoundingClientRect().top - top;
  };
  align();
  const settle = new ResizeObserver(align);
  const stop = () => {
    settle.disconnect();
    for (const type of USER_SCROLL) removeEventListener(type, stop, true);
  };
  for (const type of USER_SCROLL) addEventListener(type, stop, { capture: true, passive: true });
  settle.observe(/** @type {HTMLElement} */ (document.getElementById('log')));
  setTimeout(stop, 3000);
}

/**
 * Scroll the open chat to event `target` (an id, or 'latest' for the minion's latest reply) and flash it,
 * loading back to it if it's older than the loaded page (#236). False when it isn't there: gone, or
 * collapsed away with nothing to show.
 */
/** @param {string} target */
export async function jumpToEvent(target) {
  const id = target === 'latest' ? openView().latestReply : Number(target);
  if (!id) return false;
  const find = () => /** @type {HTMLElement | null} */ (document.querySelector(`#log [data-eid="${id}"]`));
  if (!find() && openView().page?.more && id < openView().page.events[0].id) await showEarlier(null, id);
  const found = find();
  if (!found) return false;
  // A line collapsed into the turn's updates opens its row (#578); a collapsed Taskmaster message shows as its row.
  for (let d = /** @type {HTMLElement} */ (found.parentElement).closest('#log details'); d; d = /** @type {HTMLElement} */ (d.parentElement).closest('#log details')) /** @type {HTMLDetailsElement} */ (d).open = true;
  const el = found;
  el.scrollIntoView({ block: 'center' });
  holdInPlace(el, el.getBoundingClientRect().top);
  el.classList.remove('jumped');
  void el.offsetWidth; // restart the flash on a second jump to the same thing
  el.classList.add('jumped');
  return true;
}

/** Load the page before what's shown (or back to event `from`) and redraw, keeping your place. */
/** @param {HTMLButtonElement | null} button @param {number} [from] @param {{ reachBack?: boolean }} [opts] */
export async function showEarlier(button, from, { reachBack = false } = {}) {
  const { id, page } = openView();
  const src = /** @type {string | number} */ (openView().merged?.src ?? id);
  const label = button?.textContent;
  // A spinner in place of the button until the older messages are in (#288); the redraw replaces it.
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.replaceChildren(h('span', { class: 'cui-spin', 'aria-hidden': 'true' }), 'Loading earlier…');
  }
  try {
    // Held a moment, so a quick load shows the spinner rather than a flash.
    await Promise.all([loadEarlier(src, page, from), button && new Promise((r) => setTimeout(r, 300))]);
  } catch (err) {
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = /** @type {string | null} */ (label);
    }
    return alertNote(`Couldn't load earlier messages: ${/** @type {Error} */ (err).message}`);
  }
  if (openView().id !== id) return;
  // Everything below what was added draws the same, so the first item in sight is the same one
  // counted from the end: keep it where it was while the older part (and its images) lays out.
  // (Load earlier and the New divider move about, so they don't count.)
  const items = () => /** @type {HTMLElement[]} */ ([...document.querySelectorAll('#log > :not(.load-earlier, .unread-divider)')]);
  const head = document.getElementById('ticket-head')?.getBoundingClientRect().bottom ?? 0;
  const old = items();
  const seen = old.find((el) => el.getBoundingClientRect().bottom > head);
  const fromEnd = old.length - old.indexOf(/** @type {HTMLElement} */ (seen));
  const top = seen?.getBoundingClientRect().top ?? 0;
  renderHistory();
  const anchor = seen && items().at(-fromEnd);
  // Find (from) goes on to scroll to its match, so it isn't held back here.
  if (anchor && !from) holdInPlace(anchor, top);
  // The redraw dropped find's highlights; find again over the longer history.
  const find = openView().findEl?.querySelector('input');
  // Only Find's own reach back goes on to the newest match; any other load keeps the one you are on.
  if (find?.value.trim()) find.dispatchEvent(new Event(reachBack ? 'input' : 'refind'));
}

// Unread chat items (messages, cards, notes) past which a Taskmaster opens at the bottom.
const TASKMASTER_UNREAD_LIMIT = 40;

/** @param {number} chatId @param {Ticket} ticket */
export function chatSection(chatId, ticket) {
  const form = composer(chatId, ticket);
  const log = h('div', { class: 'log', id: 'log' });
  // The working line is a shortcut to the readout in the thread bar.
  const openReadout = () => {
    openView().ui.open = true;
    renderProgress();
    openView().progressEl.scrollIntoView({ block: 'nearest' });
  };
  openView().typingEl.onclick = () => (openView().ticket?.worker_wait ? openLine(/** @type {Ticket} */ (openView().ticket).id) : openReadout());
  // Opening at the first unread message leaves the newest out of sight; this takes you there.
  // It sits in the composer's button row at every width, where it covers no chat words.
  const latest = h('button', { type: 'button', class: 'small secondary to-latest', title: 'Jump to the latest', 'aria-label': 'Jump to the latest', hidden: true }, h('span', { 'aria-hidden': 'true' }, '↓'), h('span', { class: 'wide-only' }, ' Latest'));
  latest.addEventListener('click', scrollToBottom);
  // A card still waiting on people, out of sight (#382): this takes you to it, oldest first.
  const toCard = h('button', { type: 'button', class: 'small secondary to-card', title: 'Jump to a card waiting on you', 'aria-label': 'Jump to a card waiting on you', hidden: true }, h('span', { 'aria-hidden': 'true' }, '↑'), ' Card');
  toCard.addEventListener('click', jumpToOpenCard);
  /** @type {HTMLElement} */ (form.querySelector('.row > .add-image')).after(latest, toCard);
  // A parked minion's Unpark sits just left of Send (#726), filled by renderTicketHead.
  /** @type {HTMLElement} */ (form.querySelector('.row > .send-group')).before(h('span', { class: 'unpark-slot', hidden: true }));
  // One-tap replies sit at the top of the composer, so they stay in view with it (renderTicketHead fills them).
  // Whose plan your message runs on, only when that's news (public/payer.js); under the replies, right over the box.
  form.prepend(h('div', { id: 'chat-payer', hidden: true }));
  // A parked minion reads nothing until it's unparked: said over the box before you send, not only after (renderTicketHead).
  form.prepend(h('div', { class: 'parked-hint', hidden: true }));
  form.prepend(h('div', { class: 'replies-bar', id: 'chat-replies', hidden: true }));
  // The Taskmaster's cards still waiting on people, as links, on top (public/waiting.js).
  form.prepend(h('div', { id: 'chat-waiting', hidden: true }));
  // The board this minion leads, as Overseer of a cabal (public/cabal.js, #2090).
  form.prepend(h('div', { id: 'chat-cabal', hidden: true }));
  selectActions(log, form);
  // A new person's first-day welcome (#1151), over their Taskmaster's chat only.
  return h('section', { class: 'chat' }, h('div', { class: 'ticket-head', id: 'ticket-head' }), chatWelcome(ticket), log, h('div', { class: 'typing-row' }, openView().typingEl, openView().startNowEl), form);
}

/** Find in the open conversation: highlights every match, Enter / ↓ for the next, Shift+Enter / ↑ for the previous. */
function chatFindBox() {
  const input = h('input', { type: 'search', class: 'chat-find', placeholder: matchMedia('(max-width: 800px)').matches ? '🔍 Find' : 'Find in chat', 'aria-label': 'Find in chat', ...noAutofill('chat-find') });
  const count = h('span', { class: 'find-count muted' });
  /** @type {{ marks: HTMLElement[], at: number }} */
  const state = { marks: [], at: -1 };
  /** @param {number} i */
  const show = (i, scroll = true) => {
    if (!state.marks.length) return;
    state.marks[state.at]?.classList.remove('current');
    state.at = (i + state.marks.length) % state.marks.length;
    const mark = state.marks[state.at];
    mark.classList.add('current');
    // Open any collapsed block it is in, then bring it to the middle of the screen.
    for (let d = mark.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true;
    const clamped = mark.closest('.clamped');
    if (clamped) unclamp(/** @type {HTMLElement} */ (clamped));
    if (scroll) mark.scrollIntoView({ block: 'center' });
    count.textContent = `${state.at + 1}/${state.marks.length}`;
  };
  const run = (keep = false) => {
    const log = document.getElementById('log');
    if (!log) return;
    timer = null;
    // Older history loaded under you: the match you are on counts the same from the end.
    const fromEnd = keep && state.at >= 0 ? state.marks.length - state.at : 0;
    if (state.marks.length) clearHighlights(log);
    const q = input.value.trim();
    state.marks = q.length >= 2 ? [...log.querySelectorAll('.msg, .note')].flatMap((m) => highlight(m, q)) : [];
    state.at = -1;
    count.textContent = q.length >= 2 ? (state.marks.length ? `0/${state.marks.length}` : 'none') : '';
    // Start from the newest match, nearest where you usually are.
    if (state.marks.length) {
      if (fromEnd && fromEnd <= state.marks.length) show(state.marks.length - fromEnd, false);
      else show(state.marks.length - 1);
    }
    if (q.length >= 2 && openView().page?.more) reachBack(q);
  };
  // Matches older than the loaded history: load back to the oldest of them (showEarlier finds again).
  /** @param {string} q */
  const reachBack = async (q) => {
    const { id, projectId, page } = openView();
    const hits = await api(`api/projects/${projectId}/search?q=${encodeURIComponent(q)}&ticket=${id}`).catch(() => []);
    const oldest = hits[0]?.oldestId;
    if (oldest && openView().page === page && input.value.trim() === q && oldest < page.events[0].id) await showEarlier(null, oldest, { reachBack: true });
  };
  // Highlighting a long chat on every key is wasted work; wait for a pause, and for 2+ characters.
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer ?? undefined);
    timer = setTimeout(run, 150);
  });
  input.addEventListener('refind', () => {
    clearTimeout(timer ?? undefined);
    run(true);
  });
  input.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') && timer) {
      // A step right after typing goes to the fresh results.
      clearTimeout(timer);
      timer = null;
      run();
      if (e.key !== 'ArrowUp' && !(e.key === 'Enter' && e.shiftKey)) return e.preventDefault();
    }
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      show(state.at + (e.key === 'Enter' && e.shiftKey ? -1 : 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      show(state.at - 1);
    } else if (e.key === 'Escape') {
      input.value = '';
      run();
    }
  });
  /** @param {number} d */
  const step = (d) => h('button', { type: 'button', class: 'secondary find-step', title: d < 0 ? 'Previous match' : 'Next match', onclick: () => show(state.at + d) }, d < 0 ? '↑' : '↓');
  return h('span', { class: 'find-box' }, input, count, step(-1), step(1));
}

// Phones put ‹ › × on the line under the title, so turning a tablet across the breakpoint redraws the bar.
narrow.addEventListener('change', () => {
  if (view?.ticket) renderTicketHead();
});

// Mine and Everyone (#920): each other Taskmaster session's drawing state, swapped into `view` while one of
// its events is drawn, so its turns fold, hold cards and count actions on their own. Yours stays in `view`.
/** @type {(keyof View)[]} */
const SESSION_STATE = ['ticket', 'part', 'progress', 'actions', 'turnActions', 'lastPlan', 'heldCards', 'gruntStarts', 'sawInit', 'latestReply', 'turnNote', 'turnInitAt', 'narration', 'narrationEl', 'folds', 'pendingRequest', 'turnRequest'];
/** @param {View} o @returns {Partial<View>} */
const sessionState = (o) => /** @type {Partial<View>} */ (Object.fromEntries(SESSION_STATE.map((k) => [k, o[k]])));

/** @param {Merged['parts'][number]} part */
function newSessionState(part) {
  const tm = openView().taskmasters?.find((t) => t.id === part.id);
  const ticket = tm?.ticket ?? { id: part.id, kind: 'coordinator', project_id: openView().projectId, status: 'idle', queued_ids: tm?.queued_ids, held_ids: tm?.held_ids };
  return {
    ticket,
    part,
    progress: createProgress(),
    actions: new Map(),
    turnActions: [],
    lastPlan: null,
    heldCards: [],
    gruntStarts: new Map(),
    sawInit: true,
    latestReply: null,
    turnNote: null,
    turnInitAt: undefined,
    narration: /** @type {NarrationSorter} */ (narrationSorter()),
    narrationEl: null,
    folds: [],
    pendingRequest: [],
    turnRequest: undefined,
  };
}

/** @param {ChatEvent} event @param {boolean} [scroll] */
export function appendEvent(event, scroll = true) {
  // "Say hi" ticks as you send (#1151): only live items, and only while the welcome is still yours.
  if (scroll && event.kind === 'user_message' && account?.welcome && JSON.parse(event.data).author === me) refreshWelcome();
  const m = openView().merged;
  if (!m) return drawEvent(event, scroll);
  const id = event.ticket_id;
  const part = m.parts.find((p) => p.id === id);
  if (!part) return;
  if (m.last !== id) {
    // Another session's items start here, so the last one's words don't run on or collapse across them.
    const left = m.last === openView().id ? view : /** @type {View | undefined} */ (m.states.get(m.last)); // a saved session holds every SESSION_STATE field
    if (left?.folds.length) left.folds.push({ fate: 'break' });
    else if (left) left.narrationEl = null;
    if (left) left.heldCards = [];
    m.last = id;
  }
  if (id === openView().id) return drawEvent(event, scroll);
  const own = sessionState(openView());
  Object.assign(openView(), m.states.get(id) ?? newSessionState(part));
  try {
    drawEvent(event, false);
  } finally {
    m.states.set(id, sessionState(openView()));
    Object.assign(openView(), own);
  }
  renderTyping(); // the typing line is your own Taskmaster's
  if (scroll) afterLiveDraw();
}

// Live events drawn in one frame scroll and look for out-of-sight cards once, both reading layout, not once each (#1531).
let liveDrawn = false;
function afterLiveDraw() {
  if (liveDrawn) return;
  liveDrawn = true;
  requestAnimationFrame(() => {
    liveDrawn = false;
    if (replyHold) replyHold.align();
    else if (followChat) scrollToBottom();
    renderCardJump();
  });
}

/**
 * A new reply that arrives while you're at the bottom scrolls so its first line sits just under the thread bar,
 * and stays there as it grows, its progress lines and cards arrive, until you scroll yourself or send. A reply
 * that fits shows in full at the bottom as before. Scrolled up, nothing moves. Each newer reply of the turn takes over.
 */
/** @type {{ align: () => void, settle: ResizeObserver, stop: () => void } | null} */
let replyHold = null;
/** @param {HTMLElement} el */
function holdReply(el) {
  releaseReply();
  const scroller = /** @type {Element} */ (chatScroller() ?? document.scrollingElement);
  const align = () => {
    if (!el.isConnected) return releaseReply();
    const head = document.getElementById('ticket-head')?.getBoundingClientRect().bottom ?? 0;
    scroller.scrollTop += el.getBoundingClientRect().top - head - 8;
  };
  const settle = new ResizeObserver(align);
  const stop = () => releaseReply();
  const hold = { align, settle, stop };
  replyHold = hold;
  for (const type of USER_SCROLL) addEventListener(type, stop, { capture: true, passive: true });
  const log = document.getElementById('log');
  if (log) settle.observe(log);
}
function releaseReply() {
  if (!replyHold) return;
  replyHold.settle.disconnect();
  for (const type of USER_SCROLL) removeEventListener(type, replyHold.stop, true);
  replyHold = null;
}

/** @param {ChatEvent} event @param {boolean} [scroll] */
function drawEvent(event, scroll) {
  // Live events join the loaded history, so a redraw (Load earlier) and the cache keep them.
  if (openView().page && event.id > (openView().page.events.at(-1)?.id ?? 0)) openView().page.events.push(event);
  openView().lastEventId = Math.max(openView().lastEventId, event.id);
  const log = document.getElementById('log');
  if (!log) return;
  const data = JSON.parse(event.data);
  recapEvent(event, data);
  // A steer was read by the turn already running, so it isn't part of what the next turn works on.
  if (event.kind === 'user_message' && !data.steered) (openView().pendingRequest ??= []).push({ id: event.id, author: data.author, text: data.text || '(image)' });
  if (event.kind === 'claude' && data.type === 'system' && data.subtype === 'init') {
    openView().turnActions = [];
    openView().turnNote = null;
    openView().turnInitAt = event.created_at;
    openView().narration = narrationSorter();
    flushFolds();
    openView().narrationEl = null;
    // Messages queued since the last turn are what this turn works on.
    if (openView().pendingRequest?.length) openView().turnRequest = openView().pendingRequest;
    openView().pendingRequest = [];
  }
  // A Grunt's words collapse into its own line, so they aren't the minion's reply or its working line.
  const grunt = gruntOf(event.kind, data);
  if (grunt && !openView().gruntStarts.has(grunt)) openView().gruntStarts.set(grunt, event.created_at);
  if (event.kind === 'claude' && data.type === 'assistant' && !grunt) {
    for (const b of data.message?.content ?? []) if (b.type === 'text' && b.text.trim()) openView().turnNote = b.text.trim();
  }
  for (const { block, taskId } of applyEvent(openView().progress, event.kind, data, event.created_at)) {
    // Which event it came from, so an opened row can fetch it whole when the page sent it cut (eventcut.js).
    const action = { block, taskId, result: null, startedAt: event.created_at, event: { id: event.id, ticket: event.ticket_id } };
    openView().actions.set(block.id, action);
    openView().turnActions.push(action);
  }
  if (event.kind === 'claude') scheduleProgress();
  const nodes = [];
  // The turn's words the sorter has settled, to collapse or keep once they're in the log.
  const settle = [];
  // The newest line of the minion's own words this event added, if any.
  let spoke = null;

  if (event.kind === 'user_message') {
    // Narration after a message goes in a row below it, not back into the one above. A line still
    // waiting to collapse joins the row above first, so the break waits its turn behind it.
    if (openView().folds.length) openView().folds.push({ fate: 'break' });
    else openView().narrationEl = null;
    if (data.author === me && data.sendId) {
      // Our own message, already shown when it was sent: swap in the server's copy, found by its sendId (#392).
      const i = openView().pendingMessages.findIndex((m) => m.sendId === data.sendId);
      // null, not false, when it isn't ours to swap (a reload replays every message): ?. passes false through.
      const m = i >= 0 ? openView().pendingMessages.splice(i, 1)[0] : null;
      m?.el.remove();
      for (const url of m?.urls ?? []) URL.revokeObjectURL(url);
      // Marked not sent (or waiting to send) when its reply was lost, yet it went: nothing left to send, and a Retry now does nothing.
      if (m?.state === 'failed' || m?.state === 'waiting') {
        m.state = 'sent';
        setSending(sending - 1);
      }
    }
    // An answer to a question card or a plan's go shows in the card itself; the chat only gets a
    // line pointing back up when messages below have pushed the card out of the way.
    const card = openView().cards.get(data.answer?.questionId ?? (data.plan?.verdict === 'approve' ? data.plan.planId : null));
    // A secret card's answer (#838) carries only the name it was saved as; its question_result shuts the card.
    if (data.answer?.answers)
      card?.markAnswered(
        data.answer.answers,
        data.author,
        (data.images ?? []).map((/** @type {string} */ name) => `api/tickets/${event.ticket_id}/images/${encodeURIComponent(name)}`),
      );
    if (card) {
      if (messagesBelow(card.el)) nodes.push(stamped(answerRef(card.el, data), event));
      // Someone else's answer counts as new, so the unread divider can still land on the card.
      else if (data.author !== me) card.el.dataset.at = event.created_at;
    } else if (data.answer) {
      // The card is in history not loaded yet.
      nodes.push(stamped(h('div', { class: 'msg user answer' }, asSpeaker(h('div', { class: 'who' }, data.author), authorKind(data.author), data.author), data.answer.secret ? h('div', { class: 'answer-lines' }, `→ saved the secret as ${data.answer.secret}`) : answerSummary(data.answer.answers)), event));
    } else {
      const bubble = /** @type {Bubble} */ (
        userBubble(
          data.author,
          data.text,
          (data.images ?? []).map((/** @type {string} */ name) => `api/tickets/${event.ticket_id}/images/${encodeURIComponent(name)}`),
          data.comment ? { ticketId: event.ticket_id, path: data.comment.path, name: baseName(data.comment.about) } : null,
          { id: event.id, strikes: data.strikes, brief: data.brief, schedule: data.schedule, ask: data.ask, mentions: data.mentions },
          (data.files ?? []).map((/** @type {{ name: string }} */ f) => ({ ...f, href: uploadUrl(event.ticket_id, f.name) })),
        )
      );
      bubble.dataset.event = String(event.id);
      // What its ✎ puts back in the message box while it waits in the queue (markQueued); a comment on a file would lose its file.
      if (data.author === me && !data.comment) bubble.sent = { text: data.text ?? '', images: data.images ?? [], files: data.files ?? [] };
      stamped(bubble, event);
      if (data.steered) /** @type {Element} */ (bubble.querySelector('.who')).append(h('span', { class: 'msg-tag', title: 'Sent into the turn that was running: Claude read it between steps' }, 'into the running turn'));
      if (data.mail) {
        bubble.heldData = data;
        markHeld(bubble, /** @type {Ticket} */ (openView().ticket));
      }
      if (data.need) /** @type {Element} */ (bubble.querySelector('.who')).append(h('span', { class: 'msg-tag', title: 'What the sender said this message needs' }, `need: ${data.need}`));
      markQueued(bubble, /** @type {Ticket} */ (openView().ticket));
      if (data.mail && TRACKING.test(data.text ?? '')) {
        // A run of "for your tracking" notes from one minion is one collapsed row, each note behind it (#1001).
        const pending = new Set(openView().pendingMessages.map((m) => m.el));
        let prev = /** @type {HTMLElement | null} */ (log.lastElementChild);
        while (prev && pending.has(prev)) prev = /** @type {HTMLElement | null} */ (prev.previousElementSibling);
        bubble.dataset.tracking = data.author;
        // A note inside a group row is stamped itself (a jump link finds it) and dates the group: the whole row reads as new (T5).
        /** @param {HTMLElement} group */
        const join = (group) => {
          bubble.dataset.eid = String(event.id);
          group.dataset.at = String(event.created_at);
          return addTracked(group, bubble);
        };
        if (prev?.matches('.mcopies.tracked') && prev.dataset.author === data.author) join(prev);
        else if (prev?.dataset.tracking === data.author) {
          // The second note: the lone one above joins a new group row.
          const group = newTracked(data.author);
          /** @type {HTMLElement} */ (prev).replaceWith(group);
          group.dataset.at = /** @type {HTMLElement} */ (prev).dataset.at;
          join(addTracked(group, /** @type {HTMLElement} */ (prev)));
        } else nodes.push(bubble);
      } else nodes.push(bubble);
    }
  } else if (event.kind === 'unqueued') {
    // Taken back before its turn: not what the next turn works on.
    openView().pendingRequest = openView().pendingRequest?.filter((m) => m.id !== data.id);
    const bubble = /** @type {HTMLElement | null} */ (log.querySelector(`[data-event="${data.id}"]`));
    if (bubble) showTakenBack(bubble, data.by, false);
  } else if (event.kind === 'question') {
    if (replyShows(data)) nodes.push(cardReply(data.reply, event.ticket_id));
    const qcard = /** @type {HTMLElement} */ (stamped(questionCard(event.ticket_id, data, { at: event.created_at }), event));
    qcard.dataset.cardEvent = String(event.id); // the right-click menu's Copy link to card (#1663)
    nodes.push(qcard);
  } else if (event.kind === 'job') {
    // The card follows the bottom of the chat (Cara's pick, 2026-11-17): each time the job starts, pauses or ends
    // it comes down here, and where it was keeps a one-line note.
    const old = /** @type {HTMLElement | null} */ (log.querySelector(`.jobcard[data-job-card="${data.job}"]`));
    if (old) {
      const note = jobMovedNote(data, jumpHref(/** @type {Ticket} */ (openView().ticket), event.id));
      Object.assign(note.dataset, old.dataset);
      old.replaceWith(note);
    }
    nodes.push(jobCard(data.job, data.view, 'chat'));
  } else if (event.kind === 'approval') {
    nodes.push(stamped(approvalCard(event.ticket_id, data), event));
  } else if (event.kind === 'plan') {
    if (replyShows(data)) nodes.push(cardReply(data.reply, event.ticket_id));
    nodes.push(stamped(planCard(event.ticket_id, data, { at: event.created_at }), event));
  } else if (event.kind === 'card_reply') {
    // The reply an everyone card belongs to (#1581), added once its turn ends; a page that drew the card from history has it already.
    const card = /** @type {HTMLElement | null} */ (log.querySelector(`[data-eid="${data.event}"]:not(.card-reply)`));
    if (card && replyShows(data) && !card.previousElementSibling?.matches('.card-reply')) card.before(cardReply(data.reply, event.ticket_id));
  } else if (event.kind === 'question_more') {
    openView().cards.get(data.id)?.extend(data.questions);
  } else if (event.kind === 'question_result') {
    openView().cards.get(data.id)?.markSettled(data.settled);
  } else if (event.kind === 'strike') {
    // strike_text: redraw the message it struck, wherever it shows now (a bubble or a collapsed update).
    for (const el of /** @type {NodeListOf<HTMLElement & { source?: string, ticketId?: number }>} */ (log.querySelectorAll(`[data-body="${data.event}"]`))) {
      const row = el.closest('.coord');
      el.replaceWith(messageBody(/** @type {string} */ (el.source), data.strikes, /** @type {number} */ (el.ticketId), data.event));
      if (row?.matches('.narration')) narrationSummary(/** @type {HTMLElement} */ (row));
      else row?.querySelector('summary .preview')?.replaceChildren(...previewNodes(/** @type {string} */ (el.source), data.strikes));
    }
  } else if (event.kind === 'note_edit') {
    // A note rewritten in place (the day's worktree cleanup, #1055): its line and list change, its open state stays.
    for (const el of log.querySelectorAll(`[data-note="${data.event}"]`)) {
      el.querySelector('summary')?.replaceChildren(...[threadRefs(data.text)].flat());
      el.querySelector('pre')?.replaceChildren(data.detail ?? '');
    }
  } else if (event.kind === 'replaced') {
    // A reply the link check sent back gives way to its rewrite (#281): the bubble, or its line in the collapsed row.
    for (const el of /** @type {NodeListOf<HTMLElement>} */ (log.querySelectorAll(`[data-body="${data.event}"]`))) {
      const row = el.closest('details.narration');
      (el.closest('.note-text') ?? el.closest('.msg') ?? el).remove();
      if ((row && /** @type {Element} */ (row.querySelector('.notes')).childElementCount) === 0) /** @type {Element} */ (row).remove();
      else if (row) narrationSummary(/** @type {HTMLElement} */ (row));
    }
  } else if (event.kind === 'plan_result') {
    openView().cards.get(data.id)?.settle(data);
  } else if (event.kind === 'ultrareview') {
    const card = ultraCard(data);
    openView().cards.set(data.id, card);
    nodes.push(card);
  } else if (event.kind === 'ultrareview_result') {
    const card = openView().cards.get(data.id);
    if (card?.settle) card.settle(data);
    else nodes.push(ultraResult(data));
  } else if (event.kind === 'minion_copy') {
    // A run of copies of minion-to-minion messages is one collapsed row (#924); any other event ends it.
    // Messages still on their way sit last in the log, so the run's row is the last child before them.
    const pending = new Set(openView().pendingMessages.map((m) => m.el));
    let prev = /** @type {HTMLElement | null} */ (log.lastElementChild);
    while (prev && pending.has(prev)) prev = /** @type {HTMLElement | null} */ (prev.previousElementSibling);
    if (prev?.matches('.mcopies:not(.tracked)')) addMinionCopy(prev, data, event);
    else nodes.push(addMinionCopy(newMinionCopies(), data, event));
  } else if (event.kind === 'side' || event.kind === 'side_answer') {
    // A side question and its answers share one row (#932, sidethread.js).
    const row = sideEvent(openView().sideThreads, event, data, /** @type {Ticket} */ (openView().ticket), scroll);
    if (row) nodes.push(row);
  } else if (event.kind === 'loop_paused') {
    nodes.push(loopCard(data));
  } else if (event.kind === 'loop_continued') {
    for (const card of log.querySelectorAll(`.lcard[data-minion="${data.minion}"]:has(button)`)) {
      card.classList.add('answered');
      /** @type {Element} */ (card.querySelector('button')).remove();
      /** @type {Element} */ (card.querySelector('[role=status]')).textContent = `Continued by ${data.by}`;
    }
  } else if (event.kind === 'spend') {
    nodes.push(spendCard(data, event.ticket_id, /** @type {number} */ (openView().ticket?.turnStartedAt)));
  } else if (event.kind === 'spend_muted') {
    settleSpend(log, data);
  } else if (event.kind === 'approval_result') {
    // The card itself records who decided, or why it expired.
    openView().cards.get(data.id)?.settle(data);
  } else if (event.kind === 'note') {
    const struck = strikeNote(data);
    const short = struck ? null : shortNote(data.text);
    if (struck) nodes.push(struck);
    // A note with output under it (a CI runner add or remove, #339) keeps it collapsed, line breaks and all.
    else if (short != null && data.detail) nodes.push(h('details', { class: 'note detail', 'data-note': event.id }, h('summary', {}, threadRefs(short)), h('pre', {}, data.detail)));
    else if (short != null && pushNote(data.text)) nodes.push(pushLine(data.text));
    else if (short != null) nodes.push(h('div', { class: 'note', title: short === data.text ? null : data.text }, threadRefs(short)));
  } else if (event.kind === 'fresh') {
    // A Taskmaster's or a minion's fresh Claude session (#406, #937), with the handoff it starts from behind the toggle.
    nodes.push(
      h(
        'details',
        { class: 'note detail fresh', title: data.why ? `Why: ${data.why}` : null },
        h('summary', {}, h('span', { class: 'rule' }), data.why ? `Started fresh: ${data.why}` : 'Started fresh', h('span', { class: 'rule' })),
        h('div', { class: 'fresh-from' }, 'The handoff it started from:'),
        markdown(data.summary, event.ticket_id),
      ),
    );
  } else if (event.kind === 'error') {
    nodes.push(h('div', { class: 'note error' }, threadRefs(data.text)));
  } else if (grunt && data.type === 'assistant') {
    for (const block of data.message?.content ?? []) if (block.type === 'text' && block.text.trim()) addGruntText(log, grunt, block.text, data, event);
  } else if (event.kind === 'claude') {
    if (data.type === 'system' && data.subtype === 'init') {
      // Every turn re-inits the same session; only announce the first.
      if (!openView().sawInit) nodes.push(h('div', { class: 'note' }, `Session started${data.model ? ` · ${data.model}` : ''}`));
      openView().sawInit = true;
    } else if (data.type === 'assistant') {
      for (const block of data.message?.content ?? []) {
        // A reply the link check sent back, which its rewrite replaced (#281).
        if (block.type === 'text' && block.text.trim() && !data.replaced) {
          const body = messageBody(block.text, data.strikes, event.ticket_id, event.id);
          const msg = stamped(h('div', { class: 'msg reply', 'data-reply-event': event.id }, asSpeaker(h('div', { class: 'who' }, speaker()), speakerKind()), body), event);
          nodes.push(msg);
          spoke = msg;
          openView().latestReply = event.id;
          settle.push(...openView().narration.text({ el: msg, body, text: block.text }));
        } else if (block.type === 'tool_use') {
          settle.push(...openView().narration.tool(block.name));
        }
      }
    } else if (data.type === 'user') {
      for (const block of data.message?.content ?? []) {
        const action = block.type === 'tool_result' && openView().actions.get(block.tool_use_id);
        if (action) Object.assign(action, { result: { content: block.content, is_error: block.is_error, cut: block.cut, event: { id: event.id, ticket: event.ticket_id } }, doneAt: event.created_at });
      }
    } else if (data.type === 'result') {
      // Tool calls stay out of the chat; each turn gets one collapsed line listing them.
      const acts = openView().turnActions;
      const bits = [];
      if (data.duration_ms) bits.push(shortDuration(data.duration_ms));
      if (acts.length) bits.push(`${acts.length} action${acts.length === 1 ? '' : 's'}`);
      const title = [data.is_error ? 'Turn failed' : 'Turn finished', ...bits, data.total_cost_usd ? `$${data.total_cost_usd.toFixed(2)}` : ''].filter(Boolean).join(' · ');
      const summary = [openView().branchEl, h('span', { class: 'bits', title }, h('span', { class: data.is_error ? 'fail' : 'ok', 'aria-label': data.is_error ? 'Turn failed' : 'Turn finished' }, data.is_error ? '✗' : '✓'), ` ${bits.join(' · ')}`)];
      // The branch status rides on the newest turn's line, so it moves down as turns finish.
      if (acts.length) {
        const end = h('details', { class: 'turn-end' }, h('summary', {}, ...summary));
        end.addEventListener('toggle', () => {
          if (end.open && !end.querySelector('.phases')) end.append(...phaseRows(acts, false));
        });
        nodes.push(end);
      } else {
        nodes.push(h('div', { class: 'turn-end' }, ...summary));
      }
      if (data.is_error && data.result) nodes.push(h('div', { class: 'note error' }, data.result));
    }
  }

  // Unread starts at the first thing someone else added; your own messages don't count.
  if (!(event.kind === 'user_message' && data.author === me)) for (const n of nodes) n.dataset.at = String(event.created_at);
  // What a jump link (#236) finds it by.
  for (const n of nodes) n.dataset.eid = String(event.id);
  // Another session's items in Mine or Everyone (#920): the Overlord's on a purple band, each named by whose it is.
  const part = openView().part;
  if (part)
    for (const n of nodes) {
      n.classList.toggle('ovl', !!part.overlord);
      n.dataset.session = part.label;
      n.dataset.tm = String(openView().ticket?.id); // whose queue marks it (thread-head.js)
      if (n.matches('.msg.user')) n.querySelector('.who')?.append(h('span', { class: 'msg-tag' }, `to ${part.label}`));
    }
  // A for-everyone card a person's Taskmaster asked through the Overlord (#921) says whose it was.
  const asker = data.asker && openView().taskmasters?.find((t) => t.id === data.asker);
  if (asker?.person_name && (event.kind === 'question' || event.kind === 'plan')) for (const n of nodes) n.querySelector('.who')?.append(h('span', { class: 'msg-tag' }, `asked by ${asker.person_name}'s Taskmaster`));
  // A minion explains its card in the reply it writes after asking, so the card stays below that
  // turn's words until someone answers or the turn ends.
  const held = openView().heldCards.find((el) => el.isConnected);
  if (held && event.kind === 'claude' && data.type === 'assistant') /** @type {ChildNode} */ (held).before(...nodes);
  // Your messages not in the server's history yet (on their way, or not sent) stay below everything that is.
  else log.append(...nodes, ...openView().pendingMessages.map((m) => m.el));
  if (event.kind === 'question' || event.kind === 'plan') openView().heldCards.push(...nodes);
  else if (event.kind === 'user_message' || (event.kind === 'claude' && data.type === 'result')) openView().heldCards = [];
  // While the turn runs, its newest milestone line stays in the chat; the ones above it collapse as each
  // newer line arrives (#578), and the last at its answer (#551).
  for (const s of settle) {
    if (turnLive()) openView().folds.push(s);
    if (s.fate !== 'fold' || !turnLive()) settleText(s.text, s.fate);
  }
  if (spoke && turnLive()) {
    // The newest line stays out even when the work in the same message has settled it already.
    const newest = openView().folds.at(-1)?.text?.el === spoke ? openView().folds.pop() : null;
    flushFolds();
    if (newest) openView().folds.push(newest);
  }
  if (event.kind === 'claude' && data.type === 'result') flushFolds();
  mergePushNotes(log);
  renderTyping();
  if (scroll && event.kind === 'user_message' && data.author === me) releaseReply(); // only your own message ends the hold (T9)
  if (scroll && spoke && (followChat || replyHold)) holdReply(spoke);
  if (scroll) afterLiveDraw();
}

/** The chat's cards still waiting on people that are out of sight (above the thread bar or under the composer), oldest first. */
function openCardsOutOfView() {
  const log = document.getElementById('log');
  if (!log) return [];
  const top = document.getElementById('ticket-head')?.getBoundingClientRect().bottom ?? 0;
  const bottom = /** @type {HTMLElement} */ (log.parentElement).querySelector('.composer')?.getBoundingClientRect().top ?? innerHeight;
  // An ultra review's card waits on its review, not on a person.
  return /** @type {HTMLElement[]} */ ([...log.querySelectorAll('.qcard:not(.answered, .ur-card)')]).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom <= top || r.top >= bottom;
  });
}

/** Show the composer's Card button while a waiting card is out of sight, pointing the way to it. */
export function renderCardJump() {
  const btn = /** @type {HTMLElement | null} */ (document.querySelector('.composer .to-card'));
  if (!btn) return;
  const card = openCardsOutOfView()[0];
  btn.hidden = !card;
  if (card) /** @type {ChildNode} */ (btn.firstChild).textContent = card.getBoundingClientRect().top < 0 ? '↑' : '↓';
}

/** Scroll the oldest waiting card that's out of sight to just under the thread bar, and flash it. */
function jumpToOpenCard() {
  const card = openCardsOutOfView()[0];
  if (!card) return;
  const top = document.getElementById('ticket-head')?.getBoundingClientRect().bottom ?? 0;
  (chatScroller() ?? window).scrollBy({ top: card.getBoundingClientRect().top - top - 8, behavior: 'smooth' });
  card.classList.remove('jumped');
  void card.offsetWidth; // restart the flash on a second jump to the same card
  card.classList.add('jumped');
}

/**
 * A Grunt's report as one collapsed line (its name, gist and how long it ran), merged with the lines just
 * above it into one "8 Grunts finished" block when several report in a row (a fan-out). More words
 * from a Grunt whose line is in that block go into the same line.
 */
/** @typedef {HTMLDetailsElement & { start?: number, end?: number, gruntLabel?: string }} GruntLine */
/** @param {HTMLElement} log @param {string} id @param {string} text @param {{ strikes?: { text: string }[] | null }} data @param {ChatEvent} event */
function addGruntText(log, id, text, data, event) {
  const held = openView().heldCards.find((el) => el.isConnected);
  const prev = /** @type {HTMLElement | null} */ (held ? /** @type {HTMLElement} */ (held).previousElementSibling : log.lastElementChild);
  const body = messageBody(text, data.strikes, event.ticket_id, event.id);
  const start = openView().gruntStarts.get(id) ?? event.created_at;
  openView().gruntStarts.delete(id);
  /** @type {GruntLine[]} */
  let lines = prev?.matches('.grunts') ? /** @type {GruntLine[]} */ ([...prev.querySelectorAll('.grunt')]) : prev?.matches('.grunt') ? [/** @type {GruntLine} */ (prev)] : [];
  /** @type {GruntLine | undefined} */
  let line = lines.find((l) => l.dataset.grunt === id);
  // A fan-out is Grunts that ran alongside each other: one started after the block's last report
  // (the critics after the drawers) starts a block of its own.
  if (!line && !(start <= Math.max(...lines.map((l) => /** @type {number} */ (l.end))))) lines = [];
  if (line) {
    /** @type {Element} */ (line.querySelector('.grunt-body')).append(body);
  } else {
    const name = gruntName(openView().actions.get(id)?.block.input);
    line = h(
      'details',
      { class: 'msg coord grunt', 'data-grunt': id, 'data-at': event.created_at },
      h('summary', {}, stepMark('done'), asSpeaker(h('span', { class: 'who' }, h('span', { class: 'name' }, `Grunt · ${name}`)), 'grunt'), h('span', { class: 'preview' }), h('span', { class: 'dur' })),
      h('div', { class: 'msg grunt-body' }, body),
    );
    // Not `name`: on a <details> that makes same-named lines one group, opening one closing the rest.
    Object.assign(line, { start, gruntLabel: name });
  }
  line.end = event.created_at;
  const lineStart = /** @type {number} */ (line.start);
  /** @type {Element} */ (line.querySelector('.preview')).textContent = gist(text);
  /** @type {Element} */ (line.querySelector('.dur')).textContent = line.end > lineStart ? shortDuration(line.end - lineStart) : '';
  if (line === prev) return;
  if (!lines.length) return held ? /** @type {ChildNode} */ (held).before(line) : log.append(line);
  let group = /** @type {HTMLElement} */ (prev);
  if (!group.matches('.grunts')) {
    group = h('details', { class: 'msg coord grunts', 'data-at': /** @type {HTMLElement} */ (prev).dataset.at }, h('summary', {}), h('div', { class: 'grunt-list' }));
    /** @type {HTMLElement} */ (prev).replaceWith(group);
    /** @type {HTMLElement} */ (group.lastChild).append(/** @type {HTMLElement} */ (prev));
  }
  if (!line.isConnected) /** @type {HTMLElement} */ (group.lastChild).append(line);
  const all = /** @type {GruntLine[]} */ ([.../** @type {HTMLElement} */ (group.lastChild).children]);
  /** @type {HTMLElement} */ (group.firstChild).replaceChildren(
    asSpeaker(h('span', { class: 'who' }, groupTitle(all.length, Math.max(...all.map((l) => /** @type {number} */ (l.end))) - Math.min(...all.map((l) => /** @type {number} */ (l.start))), shortDuration)), 'grunt'),
    h('span', { class: 'preview' }, all.map((l) => l.gruntLabel).join(', ')),
  );
}

/** An empty group row for copies of minion-to-minion messages; addMinionCopy fills it. */
function newMinionCopies() {
  return h('details', { class: 'msg coord mcopies' }, h('summary', {}, asSpeaker(h('span', { class: 'who' }), 'minion'), h('span', { class: 'preview' })), h('div', { class: 'mc-list' }));
}

/** One copy into its group row: a line in the list, and the count and the numbers in the summary, updated in place. */
/** @param {HTMLElement} group @param {{ author?: string, unparked?: unknown, to?: number, from?: number, text?: string }} data @param {ChatEvent} event */
function addMinionCopy(group, data, event) {
  const list = /** @type {HTMLElement} */ (group.querySelector('.mc-list'));
  const sender = data.author?.replace(/^#\d+\s*/, '') ?? '';
  const who = `${data.unparked ? 'unsealed' : '→'} #${data.to}`;
  list.append(h('div', { class: 'mc-row', 'data-eid': event.id }, h('span', { class: 'mc-who' }, `${data.from ? '#' + data.from : data.author} ${who}`), h('span', { class: 'mc-text', title: sender }, data.text)));
  const nums = new Set(group.dataset.nums ? group.dataset.nums.split(',').map(Number) : []);
  for (const n of [data.from, data.to]) if (n) nums.add(n);
  group.dataset.nums = [...nums].join(',');
  const count = list.children.length;
  const all = [...nums]
    .sort((a, b) => a - b)
    .map((n) => `#${n}`)
    .join(', ');
  /** @type {Element} */ (group.querySelector('.who')).textContent = `${count} message${count === 1 ? '' : 's'} between ${all}`;
  group.dataset.at ??= String(event.created_at);
  return group;
}

/** An empty group row for one sender's tracking notes; addTracked fills it. */
/** @param {string} author */
function newTracked(author) {
  return h('details', { class: 'msg coord mcopies tracked', 'data-author': author }, h('summary', {}, asSpeaker(h('span', { class: 'who' }), authorKind(author), author), h('span', { class: 'preview' })), h('div', { class: 'mc-list' }));
}

/** One tracking note's own row into its group: the count and the sender in the summary, the newest note as the preview. */
/** @param {HTMLElement} group @param {HTMLElement} bubble */
function addTracked(group, bubble) {
  const list = /** @type {HTMLElement} */ (group.querySelector('.mc-list'));
  list.append(bubble);
  const count = list.children.length;
  const sender = /** @type {string} */ (group.dataset.author).replace(/\s.*$/, '');
  /** @type {Element} */ (group.querySelector('.who')).textContent = `${count} tracking note${count === 1 ? '' : 's'} from ${sender}`;
  /** @type {Element} */ (group.querySelector('.preview')).textContent = bubble.querySelector('.preview')?.textContent?.replace(TRACKING, '').trim() ?? '';
  return group;
}

/**
 * Whether an everyone card carries its reply here (#1581): only where the chat that holds the reply isn't drawn whole, which is
 * the Overlord's filtered part of Mine, and not when the asker is the viewer's own Taskmaster (drawn whole in Mine).
 */
/** @param {{ reply?: string, asker?: number }} data */
function replyShows(data) {
  return !!data.reply && !!openView().part?.mine && data.asker !== openView().coordinator?.id;
}

/** The reply an everyone card was asked in, above the card wherever it shows (#1581); open from the first render (#1630). */
/** @param {string} text @param {number} ticketId */
function cardReply(text, ticketId) {
  const el = h('details', { class: 'card-reply' }, h('summary', {}, 'The reply this card belongs to'), markdown(text, ticketId));
  el.open = replyStartsOpen(text);
  return el;
}

/** The time a message or card was posted, after its who-line; the full date shows on hover. */
/** @template {HTMLElement} E @param {E} el @param {ChatEvent} event @returns {E} */
function stamped(el, event) {
  if (!event.created_at) return el;
  const d = new Date(event.created_at);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // Today: just the time. This week: the weekday too. Older: the date.
  const text = d.toDateString() === now.toDateString() ? time : +now - +d < 6 * 86_400_000 ? `${d.toLocaleDateString([], { weekday: 'short' })} ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })}, ${time}`;
  el.querySelector('.who')?.append(h('time', { class: 'stamp', datetime: d.toISOString(), title: d.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' }) }, text));
  return el;
}

/**
 * Collapse or keep one of the turn's words, as narrationSorter settled it. Collapsed remarks go in an
 * "N updates" row, one per stretch between kept messages, where the first of them was.
 */
/** @param {{ el: HTMLElement, body?: Node }} t @param {string} fate */
function settleText(t, fate) {
  if (fate !== 'fold') {
    if (fate === 'clamp') clamp(t.el);
    openView().narrationEl = null;
    return;
  }
  // A reply the link check replaced while it waited in the folds is gone: nothing to collapse (T6).
  if (!t.el.isConnected) return;
  // A strike redrew the body in place while the turn ran; fold the one on screen, not the one first drawn.
  const body = t.el.querySelector('[data-body]') ?? t.body;
  if (!openView().narrationEl?.isConnected) {
    openView().narrationEl = h('details', { class: 'msg coord narration', 'data-at': t.el.dataset.at }, h('summary', {}), h('div', { class: 'notes' }));
    t.el.before(/** @type {HTMLElement} */ (openView().narrationEl));
  }
  t.el.remove();
  // Its event id goes with it, so a jump link (?e=) still finds the line inside the row.
  /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (openView().narrationEl).querySelector('.notes')).append(h('div', { class: 'note-text', 'data-eid': t.el.dataset.eid }, body));
  narrationSummary(/** @type {HTMLElement} */ (openView().narrationEl));
}

/** A collapsed row's one line (#578): how many updates are in it, then the newest of them. */
/** @param {HTMLElement} row */
function narrationSummary(row) {
  const bodies = /** @type {NodeListOf<HTMLElement & { source: string, strikes?: { text: string }[] | null }>} */ (row.querySelectorAll(':scope > .notes > .note-text > [data-body]'));
  const n = bodies.length;
  const last = bodies[n - 1];
  /** @type {Element} */ (row.querySelector('summary')).replaceChildren(asSpeaker(h('span', { class: 'who' }, h('span', { class: 'name' }, `${n} update${n === 1 ? '' : 's'}`)), speakerKind()), h('span', { class: 'preview' }, last ? previewNodes(last.source, last.strikes) : ''));
}

/**
 * A chained minion's held brief (#728), read-only in its chat above the messages left for it, until the brief is sent.
 * Idempotent: the head's redraw calls it, so it draws, replaces or removes the block as the ticket says.
 */
export function syncHeldBrief() {
  const log = document.getElementById('log');
  if (!log || !view?.ticket) return;
  const b = view.ticket.held_brief;
  const old = /** @type {HTMLElement | null} */ (log.querySelector(':scope > .held-brief'));
  if (!b) return old?.remove();
  const key = `${b.leader}|${b.when}|${b.from}|${b.text}`;
  if (old?.dataset.key === key) return;
  old?.remove();
  const body = markdown(b.text, view.ticket.id);
  const el = h(
    'div',
    { class: `msg user held-brief ${senderTone(b.from)}`.trim(), 'data-key': key },
    asSpeaker(h('div', { class: 'who' }, h('span', { class: 'name' }, b.from), h('span', { class: 'msg-tag' }, threadRefs(`Brief, held until #${b.leader} ${b.is ?? (b.when === 'live' ? 'is live' : 'has shipped')}`))), authorKind(b.from), b.from),
    body,
  );
  if (b.text.length > 500 || b.text.split('\n').length > 8) {
    el.classList.add('clamped');
    el.append(
      h(
        'button',
        {
          type: 'button',
          class: 'show-all small secondary',
          onclick: (/** @type {MouseEvent} */ e) => {
            const open = el.classList.toggle('clamped');
            /** @type {HTMLElement} */ (e.currentTarget).textContent = open ? 'Show more' : 'Show less';
          },
        },
        'Show more',
      ),
    );
  }
  // Above the messages left for it, which come after the brief.
  const first = /** @type {Bubble[]} */ ([...log.children]).find((c) => c.classList.contains('user') && /** @type {{ parked?: unknown } | undefined} */ (c.heldData)?.parked);
  const after = log.querySelector(':scope > #recap, :scope > .pending');
  if (first) first.before(el);
  else if (after) after.before(el);
  else log.append(el);
}

/** Whether the running turn is under way here: its init event has arrived (initSeen). */
function turnLive() {
  return openView().ticket?.status === 'running' && initSeen();
}

/**
 * Collapse the running turn's settled milestone lines into their "N updates" rows, as a reload would show
 * them: each time a newer line arrives (#578), at its answer, or when it stops without one. Words kept
 * whole break the run, as they do on a reload.
 */
function flushFolds() {
  const folds = openView().folds;
  openView().folds = [];
  // No reset of view.narrationEl here: mid-turn, a line joins the row its stretch already has (#578).
  for (const { text, fate } of folds) {
    if (fate !== 'fold') openView().narrationEl = null;
    else if (text.el.isConnected) settleText(text, fate); // not one replaced by its rewrite (#281)
  }
}

/**
 * The working line under the chat while a turn runs: who's working and what's queued. The step, what's
 * running and the time are in the readout in the thread bar just above, which clicking the line opens.
 */
export function renderTyping() {
  const el = view?.typingEl;
  const t = el && openView().ticket;
  if (!el || !t) return;
  const running = t.status === 'running';
  // A turn that stopped without its answer (stopped, crashed) folds its lines all the same.
  if (!running && openView().folds.length) flushFolds();
  // The server working for it with no turn (#727: a handed-off land) gets the line too, in its own words.
  const server = workingBy(t) === 'server';
  const show = running || !!t.approvals || openView().sendingTo === t.id || server;
  const wasHidden = el.hidden;
  el.hidden = !show;
  // A redraw mustn't drop the focus on its button.
  const focused = openView().startNowEl.contains(document.activeElement);
  openView().startNowEl.replaceChildren(...(startNowLine(t) ?? []));
  if (focused) openView().startNowEl.querySelector('button')?.focus();
  if (!show) return;
  el.classList.toggle('in-line', !!t.worker_wait);
  el.title = t.worker_wait ? 'See the line for workers' : 'Show the work so far';
  const lead = t.approvals ? 'Waiting for someone to approve or deny' : t.worker_wait ? workerWaitLabel(t.worker_wait, t.start_now) : running ? workingLabel(t) : openView().sendingTo === t.id ? workingLabel(t, 'thinking…') : (jobOf(t)?.text ?? rowState(t, usage).label);
  // Held mail counts as queued while it works (#1067): it has no card then, and its bubble may be above the loaded history.
  const queued = (t.queued ?? 0) + (running ? (t.held_mail?.items?.length ?? 0) : 0);
  const key = `${lead}|${queued}`;
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.replaceChildren(h('span', { class: 'dots' }, h('i'), h('i'), h('i')), h('span', { class: 'lead' }, lead), ...(queued ? [h('span', { class: 'sep' }, '·'), h('span', { class: 'queued', title: `${queued} message${queued === 1 ? '' : 's'} queued for the next turn` }, `${queued} queued`)] : []));
  }
  if (wasHidden && followChat) scrollToBottom();
}

/** The cold-wake hint (#413) shows up an hour after the last turn and counts on, without waiting for a broadcast; other payer lines are left alone. */
setInterval(() => {
  const t = view?.ticket;
  const chat = document.getElementById('ticket-head')?.closest('.chat');
  const slot = /** @type {HTMLElement | null | undefined} */ (chat?.querySelector('#chat-payer'));
  const form = /** @type {Bubble | null | undefined} */ (chat?.querySelector('.composer'));
  if (!t || !slot || !form || (slot.firstChild && !slot.querySelector('.cold'))) return;
  const line = payerLine(t, /** @type {(text: string) => Promise<unknown>} */ (form.sendText));
  slot.hidden = !line;
  slot.replaceChildren(line ?? '');
}, 60_000);

/** Turns the readout's running call to "Thinking…" once nothing has run for a while (its time ticks in wait.js). */
setInterval(() => {
  const el = /** @type {HTMLElement | null | undefined} */ (view?.progressEl?.querySelector('.progress-line .doing'));
  const ran = /** @type {HTMLElement | null | undefined} */ (view?.progressEl?.querySelector('.progress-line .ran'));
  if (el && el.dataset.doing && (el.dataset.doing !== nowDoing(openView().turnActions, Date.now()) || /** @type {HTMLElement} */ (ran).textContent !== runningFor(openView().turnActions, Date.now()))) scheduleProgress();
  // What's left of the plan's guesses runs down while a long call runs, with no event to redraw it.
  const left = view?.progressEl?.querySelector('.progress-cap .left');
  const est = left && planEstimate(openView().progress, openView().ticket?.status === 'running', Date.now(), openView().ticket?.step_ratio);
  if (left && (!est || left.textContent !== leftText(est))) scheduleProgress();
}, 1000);

/** A push note's line (#996): one push says it as stored; mergePushNotes counts it up when more follow back to back. */
/** @param {string} text */
function pushLine(text) {
  return h('div', { class: 'note', 'data-push': text, 'data-count': '1' }, text);
}

/**
 * Back-to-back push notes show as one line with a count. Run after every event, once the folds have had their
 * say: the updates group, which holds the minion's working lines, doesn't break a run; a person's message or the
 * minion's reply does. The stored notes stay as they are, so a redraw gives the same result.
 */
/** @param {HTMLElement} log */
function mergePushNotes(log) {
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (log.querySelectorAll('.note[data-push]'))) {
    let prev = /** @type {HTMLElement | null} */ (el.previousElementSibling);
    while (prev?.matches('.narration')) prev = /** @type {HTMLElement | null} */ (prev.previousElementSibling);
    if (!prev?.matches('.note[data-push]') || prev.dataset.session !== el.dataset.session || !pushRun({ text: /** @type {string} */ (prev.dataset.push), count: 1 }, /** @type {string} */ (el.dataset.push)).joined) continue;
    const run = { text: /** @type {string} */ (prev.dataset.push), count: Number(prev.dataset.count) + Number(el.dataset.count) };
    prev.dataset.count = String(run.count);
    prev.replaceChildren(...pushRunParts(run).map((p) => (typeof p === 'string' ? p : h('span', { class: 'push-count' }, String(p.count)))));
    el.remove();
  }
}
