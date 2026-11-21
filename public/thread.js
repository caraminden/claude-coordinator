// A minion's chat: its head, history, readout, cards and the working line.
import { presenceHead } from './presence.js';
import { gloss } from './help-words.js';
import { account, ago, api, baseName, clearHighlights, dismissedWhen, h, noAutofill, highlight, icon, isCoordinator, jumpHref, me, threadFullName, threadLabel, threadTitleParts, uploadUrl, view } from './base.js';
import { mergedView, TM_VIEW } from './mine.js';
import { toast } from './ui/status.js';
import { stopChat, stoppingIds, cachedEvents, catchUpEvents, chatScroller, loadEvents, followChat, loadEarlier, markdown, markSeen, onTicketPin, restoreScroll, scrollToBottom, scrollToUnread, sending, setSending, USER_SCROLL, takeJump, threadRefs, usage } from './core.js';
import { alertNote, composer, composerPlaceholder, outbox, renderModelPicker } from './composer.js';
import { renderSidebar } from './sidebar.js';
import { refreshInbox } from './inbox.js';
import { composerHint, heldLine, TRACKING } from './heldmsg.js';
import { rowState, SHIP, workingBy, workingLabel } from './threadstate.js';
import { propertyChip } from './properties.js';
import { onboardingStrip } from './settings.js';
import { jobCard, jobMovedNote } from './jobs.js';
import { recapEvent, showRecap } from './recap.js';
import { narrationSorter } from './narration.js';
import { gist, groupTitle, gruntName, gruntOf } from './grunts.js';
import { stepMark } from './ui/chat.js';
import { optimistic } from './ui/optimistic.js';
import { replyChips } from './replies.js';
import { releaseChip } from './releases.js';
import { pushNote, pushRun, pushRunParts, senderTone, shortDuration, shortNote } from './chattext.js';
import { ultraButton, ultraCard, ultraResult } from './ultrareview.js';
import { payerLine } from './payer.js';
import { sideEvent } from './sidethread.js';
import { selectActions } from './selectact.js';
import { waitingStrip } from './waiting.js';
import { chatWelcome, refreshWelcome } from './welcome.js';
import { canBack, canForward, goBack, goForward } from './navstack.js';
import { applyEvent, createProgress, nowDoing, planEstimate } from './progress.js';
import { clamp, markQueued, messageBody, previewNodes, showTakenBack, strikeNote, unclamp, userBubble } from './bubbles.js';
import { headState, initSeen, leftText, narrow, phaseRows, progressUi, renderProgress, scheduleProgress } from './progress-ui.js';
import { answerRef, answerSummary, approvalCard, loopCard, messagesBelow, planCard, questionCard, settleSpend, speaker, spendCard } from './cards.js';

// Mine or Everyone (#920): how this device opens your Taskmaster in a scheme with several.
export function tmViewMode() {
  try { return localStorage.getItem(TM_VIEW) === 'everyone' ? 'everyone' : 'mine'; } catch { return 'mine'; }
}

/** Mine and Everyone, in your Taskmaster's title row: the pick shows at once and the history follows. */
function tmViewSwitch() {
  const now = view.merged.mode;
  const pick = (mode, label, title) => h('button', { type: 'button', class: `chip${mode === now ? ' on' : ''}`, 'aria-pressed': String(mode === now), title, onclick: () => mode !== now && setTmView(mode) }, label);
  return h('span', { class: 'tm-views', role: 'group', 'aria-label': 'Which Taskmaster chats' },
    pick('mine', 'Mine', 'Your Taskmaster, with the Overlord\'s cards and alerts for everyone'),
    pick('everyone', 'Everyone', 'Every Taskmaster in this scheme and the Overlord, in time order'));
}

/** Mine's line under the title (board C): whose chats it leaves out, and a way there. */
function tmBanner() {
  const rest = (view.taskmasters ?? []).filter((t) => t.id !== view.id);
  const names = rest.filter((t) => t.person_id != null).map((t) => `${t.person_name ?? 'Someone'}'s`);
  const whose = names.length ? `${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} Taskmasters` : `${names[0]} Taskmaster`}` : '';
  const said = [whose, rest.some((t) => t.person_id == null) ? 'the Overlord' : ''].filter(Boolean).join(' and ');
  return said && h('div', { class: 'tm-banner' }, `${said} ${rest.length > 1 ? 'are' : 'is'} in `,
    h('button', { type: 'button', class: 'link', onclick: () => setTmView('everyone') }, 'Everyone'), '.');
}

async function setTmView(mode) {
  const v = view;
  const before = v.merged.mode;
  try { localStorage.setItem(TM_VIEW, mode); } catch {}
  v.merged = mergedView(v.projectId, v.id, v.taskmasters, mode);
  renderTicketHead();
  const { src } = v.merged;
  try {
    const page = cachedEvents(src) ?? await loadEvents(src);
    if (view !== v || v.merged.src !== src) return; // another view, or another flip, overtook this one
    v.page = page;
    renderHistory();
    scrollToBottom();
    await catchUpEvents();
  } catch {
    if (view !== v || v.merged.src !== src) return;
    try { localStorage.setItem(TM_VIEW, before); } catch {}
    v.merged = mergedView(v.projectId, v.id, v.taskmasters, before);
    renderTicketHead();
    toast(`Couldn't load ${mode === 'everyone' ? 'Everyone' : 'Mine'}. Try again in a moment.`, { tone: 'warn' });
  }
}

/** Per-thread state for the chat in the main panel; empty when the main panel shows something else. */
export function chatView(chatId, ticket, merged = null) {
  return {
    id: chatId, ticket, lastEventId: 0,
    merged, // your Taskmaster's chat as Mine or Everyone, several sessions in one log (#920, mine.js mergedView)
    progress: createProgress(),
    progressEl: h('div', { class: 'progress', hidden: true }), // lives in the thread bar
    findEl: chatId ? chatFindBox() : null, // lives in the thread bar too, so it survives re-renders
    ui: progressUi(chatId),
    actions: new Map(), // tool_use_id -> { block, taskId, result }
    turnActions: [], // actions of the current (or last) turn, in order
    typingEl: h('button', { type: 'button', class: 'typing', hidden: true, title: 'Show the work so far' }), // below the chat log
    folds: [], // the running turn's settled words, { text, fate } in order, folded when its answer arrives (#551)
    sendingTo: null, // ticket id while a message is on its way, before the server confirms the turn
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
function loadWhenReached(button) {
  watchYourScrolling();
  earlierSeen?.disconnect(); // the last redraw's button is gone
  earlierSeen = new IntersectionObserver(([e]) => {
    button.inView = e.isIntersecting;
    if (e.isIntersecting && view.scrolledByYou && !button.disabled && button.isConnected) showEarlier(button);
  });
  earlierSeen.observe(button);
}
let earlierSeen = null;
let watching = false;
// On first use, not at load: core.js imports this module before its own USER_SCROLL is set.
function watchYourScrolling() {
  if (watching) return;
  watching = true;
  for (const type of USER_SCROLL) {
    addEventListener(type, (e) => {
      if (!view?.page) return;
      view.scrolledByYou = true;
      const button = document.querySelector('#log > .load-earlier > button');
      if (type === 'wheel' && e.deltaY < 0 && e.target.closest?.('#log') && button?.inView && !button.disabled) showEarlier(button);
    }, { capture: true, passive: true });
  }
}

/**
 * Fill in a chat section just put on the page: its head, its history, and where you were in it. `fromCache`: the
 * history came from this session's cache (#527), so what came since is still to come.
 */
export async function mountChat(chatId, ticket, page, fromCache) {
  renderTicketHead();
  view.page = page;
  view.openedSeenAt = view.seen?.[chatId] ?? 0;
  renderHistory();
  if (ticket.branch) refreshBranch(chatId);
  markSeen(chatId);
  // Opened by a link to one thing in it (an inbox item, a notification), at that thing.
  const jump = takeJump();
  // Open at the first thing you haven't seen, marked New; a minion you've never opened, at the top of
  // what's loaded. Unread from before the loaded page also opens there, under "Load earlier".
  const place = async () => {
    const jumped = jump && await jumpToEvent(jump);
    if (view?.id !== chatId || jumped) return;
    const divider = document.querySelector('#log > .unread-divider');
    if (!divider) restoreScroll(chatId);
    // A Taskmaster's history runs long; past that much unread, its newest matters more than where you left off.
    else if (isCoordinator(ticket) && divider.parentElement.querySelectorAll(':scope > .unread-divider ~ [data-at]').length > TASKMASTER_UNREAD_LIMIT) scrollToBottom();
    else scrollToUnread(divider);
  };
  await place();
  if (view?.id !== chatId) return; // you moved on while it loaded back
  const v = view;
  if (fromCache) watchYourScrolling(); // a short chat has no Load earlier to have started it
  try {
    if (sessionStorage.getItem('cc-refocus')) {
      sessionStorage.removeItem('cc-refocus');
      document.querySelector('.composer textarea')?.focus();
    }
  } catch {}
  // What came since the cached copy, or was broadcast while the snapshot was loading (before `view` existed): one
  // request, its events added below what's drawn (#1531). Not awaited: the chat is drawn, so the route's dim
  // (body.navigating) clears now rather than after this round trip (#494).
  catchUpEvents()
    .then(async (added) => {
      // From the cache, it opens at the first unread as a fresh load would, unless you've scrolled meanwhile.
      if (!fromCache || !added || view !== v || view.page !== page) return;
      markUnread();
      if (!view.scrolledByYou) await place();
    })
    .then(() => isCoordinator(ticket) && view?.id === chatId && showRecap())
    .catch(() => {}); // a missed catch-up is made good by the stream's next resync
}

/** Mark the first item you haven't seen New, unless one is marked already. */
function markUnread() {
  const log = document.getElementById('log');
  if (!log || log.querySelector(':scope > .unread-divider')) return;
  const at = [...log.children].find((el) => Number(el.dataset.at) > view.openedSeenAt);
  at?.before(h('div', { class: 'unread-divider', role: 'separator' }, h('span', {}, 'New')));
}

/**
 * Draw the log from the loaded history (view.page), from scratch: earlier pages go above, and a card
 * answered or a message struck by a later event has to see that event after its own. Messages still
 * on their way and the recap stay where they are.
 */
function renderHistory() {
  const log = document.getElementById('log');
  const page = view.page;
  const recap = document.getElementById('recap');
  Object.assign(view, {
    lastEventId: 0, progress: { ...createProgress(), tasks: structuredClone(page.tasks) },
    actions: new Map(), turnActions: [], cards: new Map(), sideThreads: new Map(), lastPlan: null, heldCards: [], gruntStarts: new Map(),
    // The session started on an earlier page, if there is one.
    sawInit: page.more, latestReply: null, turnNote: null, turnInitAt: undefined, narration: narrationSorter(), narrationEl: null, folds: [], pendingRequest: [], turnRequest: undefined,
  });
  if (view.merged) Object.assign(view.merged, { states: new Map(), last: view.id });
  const earlier = page.more && h('button', { type: 'button', class: 'small secondary', onclick: (e) => showEarlier(e.currentTarget) }, 'Load earlier');
  log.replaceChildren(...(earlier ? [h('div', { class: 'load-earlier' }, earlier)] : []));
  if (earlier) loadWhenReached(earlier);
  if (isCoordinator(view.ticket) && !page.events.length) {
    log.append(h('div', { class: 'note' },
      'This is the Taskmaster for this scheme. It keeps track of the minions on the left and can create, message, rename and dismiss them for you.'));
  }
  for (const ev of page.events) appendEvent(ev, false);
  renderCardJump();
  markUnread();
  // Messages still on their way or not sent; the replay swapped out any that reached the server meanwhile, by sendId.
  log.append(...view.pendingMessages.map((m) => m.el), ...(recap ? [recap] : []));
  renderProgress();
  syncHeldBrief();
}

/** Keep `el` at `top` px down the screen as what's above it lays out, until you scroll yourself. */
function holdInPlace(el, top) {
  const scroller = chatScroller() ?? document.scrollingElement;
  const align = () => { scroller.scrollTop += el.getBoundingClientRect().top - top; };
  align();
  const settle = new ResizeObserver(align);
  const stop = () => {
    settle.disconnect();
    for (const type of USER_SCROLL) removeEventListener(type, stop, true);
  };
  for (const type of USER_SCROLL) addEventListener(type, stop, { capture: true, passive: true });
  settle.observe(document.getElementById('log'));
  setTimeout(stop, 3000);
}

/**
 * Scroll the open chat to event `target` (an id, or 'latest' for the minion's latest reply) and flash it,
 * loading back to it if it's older than the loaded page (#236). False when it isn't there: gone, or
 * collapsed away with nothing to show.
 */
export async function jumpToEvent(target) {
  const id = target === 'latest' ? view.latestReply : Number(target);
  if (!id) return false;
  const find = () => document.querySelector(`#log [data-eid="${id}"]`);
  if (!find() && view.page?.more && id < view.page.events[0].id) await showEarlier(null, id);
  const found = find();
  if (!found) return false;
  // A line collapsed into the turn's updates opens its row (#578); a collapsed Taskmaster message shows as its row.
  for (let d = found.parentElement.closest('#log details'); d; d = d.parentElement.closest('#log details')) d.open = true;
  const el = found;
  el.scrollIntoView({ block: 'center' });
  holdInPlace(el, el.getBoundingClientRect().top);
  el.classList.remove('jumped');
  void el.offsetWidth; // restart the flash on a second jump to the same thing
  el.classList.add('jumped');
  return true;
}

/** Load the page before what's shown (or back to event `from`) and redraw, keeping your place. */
export async function showEarlier(button, from) {
  const { id, page } = view;
  const src = view.merged?.src ?? id;
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
      button.textContent = label;
    }
    return alertNote(`Couldn't load earlier messages: ${err.message}`);
  }
  if (view.id !== id) return;
  // Everything below what was added draws the same, so the first item in sight is the same one
  // counted from the end: keep it where it was while the older part (and its images) lays out.
  // (Load earlier and the New divider move about, so they don't count.)
  const items = () => [...document.querySelectorAll('#log > :not(.load-earlier, .unread-divider)')];
  const head = document.getElementById('ticket-head')?.getBoundingClientRect().bottom ?? 0;
  const old = items();
  const seen = old.find((el) => el.getBoundingClientRect().bottom > head);
  const fromEnd = old.length - old.indexOf(seen);
  const top = seen?.getBoundingClientRect().top ?? 0;
  renderHistory();
  const anchor = seen && items().at(-fromEnd);
  // Find (from) goes on to scroll to its match, so it isn't held back here.
  if (anchor && !from) holdInPlace(anchor, top);
  // The redraw dropped find's highlights; find again over the longer history.
  const find = view.findEl?.querySelector('input');
  if (find?.value.trim()) find.dispatchEvent(new Event('input'));
}

// Unread chat items (messages, cards, notes) past which a Taskmaster opens at the bottom.
const TASKMASTER_UNREAD_LIMIT = 40;

export function chatSection(chatId, ticket) {
  const form = composer(chatId, ticket);
  const log = h('div', { class: 'log', id: 'log' });
  // The working line is a shortcut to the readout in the thread bar.
  const openReadout = () => {
    view.ui.open = true;
    renderProgress();
    view.progressEl.scrollIntoView({ block: 'nearest' });
  };
  view.typingEl.onclick = openReadout;
  // Opening at the first unread message leaves the newest out of sight; this takes you there.
  // It sits in the composer's button row at every width, where it covers no chat words.
  const latest = h('button', { type: 'button', class: 'small secondary to-latest', title: 'Jump to the latest', 'aria-label': 'Jump to the latest', hidden: true },
    h('span', { 'aria-hidden': 'true' }, '↓'), h('span', { class: 'wide-only' }, ' Latest'));
  latest.addEventListener('click', scrollToBottom);
  // A card still waiting on people, out of sight (#382): this takes you to it, oldest first.
  const toCard = h('button', { type: 'button', class: 'small secondary to-card', title: 'Jump to a card waiting on you', 'aria-label': 'Jump to a card waiting on you', hidden: true },
    h('span', { 'aria-hidden': 'true' }, '↑'), ' Card');
  toCard.addEventListener('click', jumpToOpenCard);
  form.querySelector('.row > .add-image').after(latest, toCard);
  // A parked minion's Unpark sits just left of Send (#726), filled by renderTicketHead.
  form.querySelector('.row > .send-group').before(h('span', { class: 'unpark-slot', hidden: true }));
  // One-tap replies sit at the top of the composer, so they stay in view with it (renderTicketHead fills them).
  // Whose plan your message runs on, only when that's news (public/payer.js); under the replies, right over the box.
  form.prepend(h('div', { id: 'chat-payer', hidden: true }));
  // A parked minion reads nothing until it's unparked: said over the box before you send, not only after (renderTicketHead).
  form.prepend(h('div', { class: 'parked-hint', hidden: true }));
  form.prepend(h('div', { class: 'replies-bar', id: 'chat-replies', hidden: true }));
  // The Taskmaster's cards still waiting on people, as links, on top (public/waiting.js).
  form.prepend(h('div', { id: 'chat-waiting', hidden: true }));
  selectActions(log, form);
  // A new person's first-day welcome (#1151), over their Taskmaster's chat only.
  return h('section', { class: 'chat' }, h('div', { class: 'ticket-head', id: 'ticket-head' }), chatWelcome(ticket), log, view.typingEl, form);
}


/** Find in the open conversation: highlights every match, Enter / ↓ for the next, Shift+Enter / ↑ for the previous. */
function chatFindBox() {
  const input = h('input', { type: 'search', class: 'chat-find', placeholder: matchMedia('(max-width: 800px)').matches ? '🔍 Find' : 'Find in chat', 'aria-label': 'Find in chat', ...noAutofill('chat-find') });
  const count = h('span', { class: 'find-count muted' });
  const state = { marks: [], at: -1 };
  const show = (i) => {
    if (!state.marks.length) return;
    state.marks[state.at]?.classList.remove('current');
    state.at = (i + state.marks.length) % state.marks.length;
    const mark = state.marks[state.at];
    mark.classList.add('current');
    // Open any collapsed block it is in, then bring it to the middle of the screen.
    for (let d = mark.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
    const clamped = mark.closest('.clamped');
    if (clamped) unclamp(clamped);
    mark.scrollIntoView({ block: 'center' });
    count.textContent = `${state.at + 1}/${state.marks.length}`;
  };
  const run = () => {
    const log = document.getElementById('log');
    if (!log) return;
    timer = null;
    if (state.marks.length) clearHighlights(log);
    const q = input.value.trim();
    state.marks = q.length >= 2 ? [...log.querySelectorAll('.msg, .note')].flatMap((m) => highlight(m, q)) : [];
    state.at = -1;
    count.textContent = q.length >= 2 ? (state.marks.length ? `0/${state.marks.length}` : 'none') : '';
    // Start from the newest match, nearest where you usually are.
    if (state.marks.length) show(state.marks.length - 1);
    if (q.length >= 2 && view.page?.more) reachBack(q);
  };
  // Matches older than the loaded history: load back to the oldest of them (showEarlier finds again).
  const reachBack = async (q) => {
    const { id, projectId, page } = view;
    const hits = await api(`api/projects/${projectId}/search?q=${encodeURIComponent(q)}&ticket=${id}`).catch(() => []);
    const oldest = hits[0]?.oldestId;
    if (oldest && view.page === page && input.value.trim() === q && oldest < page.events[0].id) await showEarlier(null, oldest);
  };
  // Highlighting a long chat on every key is wasted work; wait for a pause, and for 2+ characters.
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 150);
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
  const step = (d) => h('button', { type: 'button', class: 'secondary find-step', title: d < 0 ? 'Previous match' : 'Next match', onclick: () => show(state.at + d) }, d < 0 ? '↑' : '↓');
  return h('span', { class: 'find-box' }, input, count, step(-1), step(1));
}

// ---------- branch and pull request ----------

export async function refreshBranch(ticketId) {
  try {
    const { status } = await api(`api/tickets/${ticketId}/branch`);
    if (view?.kind === 'project' && view.id === ticketId) renderBranch(status);
  } catch {}
}

/** "PR #12 · shipped" (linked), or for work shipped without a PR, the branch and whether main has it. */
export function renderBranch(status) {
  const el = view.branchEl;
  const parts = [];
  // Onto main it ships; a minion in a build merges into it (Cara, 2026-11-19, picked "Ship" on #1020's card). status.base is always main's.
  const done = status?.build ? 'merged' : 'shipped';
  if (status?.pr) {
    const { pr } = status;
    const state = pr.state === 'MERGED' ? done : pr.state === 'CLOSED' ? 'closed' : pr.draft ? 'draft' : 'open';
    parts.push(
      // data-github: this chip is the way to the PR on GitHub, so pointPrLink leaves it be (as the merge card's).
      h('a', { href: pr.url, target: '_blank', rel: 'noopener', title: pr.title, 'data-github': '', onclick: (e) => e.stopPropagation() }, `PR #${pr.number}`),
      h('span', { class: `state ${state === done ? 'merged' : state}` }, state));
    if (pr.state === 'OPEN' && status.merged) parts.push(h('span', { title: `Shipped to ${status.base}` }, '✓ in main'));
  } else if (status && !status.empty) {
    parts.push(h('span', { class: 'branch', title: status.branch }, status.branch));
    parts.push(status.merged
      ? h('span', { class: 'state merged', title: `Shipped to ${status.base}` }, 'shipped')
      : h('span', { class: 'state open', title: `${status.ahead} commit${status.ahead === 1 ? '' : 's'} not in ${status.base}` }, `${status.ahead} not shipped`));
  }
  // Where its change is on the way to release (#626, take F); releases.js redraws the slot as that moves.
  const chip = releaseChip(view.ticket);
  el.replaceChildren(...parts, h('span', { class: 'rel-chip-slot' }, chip ?? ''));
  el.hidden = !parts.length && !chip;
}

/** Fill the waiting-cards strip over the composer (public/waiting.js): a Taskmaster's cards, a minion's open choices cards. */
function renderWaiting() {
  const slot = document.getElementById('chat-waiting');
  if (!slot || !view.ticket) return;
  const strip = waitingStrip(view.ticket);
  slot.hidden = !strip;
  slot.replaceChildren(strip ?? '');
}

/** The chat's context meter (#1193): "84k / 200k", fixed width so a new number moves nothing. */
const kTokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
function contextMeter(t) {
  const used = t.context_live ?? t.context_tokens;
  const full = used && t.context_window ? used / t.context_window : 0;
  return h('span', { class: `ctx-meter muted${full >= 0.9 ? ' hot' : ''}`, title: used ? `${used.toLocaleString()} of ${t.context_window.toLocaleString()} tokens of context in use` : 'Context size shows after its first turn' },
    used ? `${kTokens(used)} / ${kTokens(t.context_window)}` : `– / ${kTokens(t.context_window || 200000)}`);
}

export function renderTicketHead() {
  renderModelPicker();
  const el = document.getElementById('ticket-head');
  if (!el) return;
  const t = headTicket(view.ticket);
  const coord = isCoordinator(t);
  // A dismissed minion's message box is tinted and says so (style.css), following reopen and dismiss live.
  const chat = el.closest('.chat');
  chat?.classList.toggle('dismissed', t.status === 'closed');
  chat?.classList.toggle('turn-running', t.status === 'running');
  // A spend card's buttons are for its own turn only (#723).
  for (const card of chat?.querySelectorAll('.scard') ?? []) card.classList.toggle('stale', Number(card.dataset.turn) !== t.turnStartedAt);
  // Whose chat it is, so you know at a glance who you're talking to (#360, style.css).
  chat?.classList.toggle('role-taskmaster', coord);
  chat?.classList.toggle('role-minion', !coord);
  const bubbles = [...chat?.querySelectorAll('.log [data-event]') ?? []];
  const lastHeld = bubbles.findLast((b) => b.heldData && t.held_ids?.includes(Number(b.dataset.event)));
  for (const bubble of bubbles) {
    markQueued(bubble, t);
    if (bubble.heldData) markHeld(bubble, t, bubble === lastHeld);
  }
  const box = chat?.querySelector('.composer textarea');
  if (box) box.placeholder = composerPlaceholder(t);
  const form = chat?.querySelector('.composer');
  const bar = chat?.querySelector('#chat-replies');
  if (bar && form) {
    // Above the composer, sent the way the composer sends (shown at once, "This Minion is thinking…").
    const chips = replyChips(t, form.sendText);
    bar.hidden = !chips;
    bar.replaceChildren(chips);
    const slot = chat.querySelector('#chat-payer');
    const line = payerLine(t, form.sendText);
    slot.hidden = !line;
    slot.replaceChildren(line ?? '');
    renderWaiting();
    // Parked (#718): messages wait unread until this, which wakes it with them (one chained on start_after starts, its brief first).
    const unparkSlot = form.querySelector('.unpark-slot');
    if (unparkSlot) {
      const parked = (t.parked_for || t.state === 'parked') && !coord && t.status !== 'closed' && t.status !== 'running';
      const title = t.parked_for ? 'Start it now with its held brief and the messages left for it, without waiting for its leader\'s work' : 'Wake it now: it reads the messages left for it while parked';
      unparkSlot.hidden = !parked;
      unparkSlot.replaceChildren(...(parked ? [
        h('button', { type: 'button', class: 'secondary act-unpark', title, onclick: () => unpark(t) }, 'Unpark'),
        h('button', { type: 'button', class: 'secondary act-send-unpark', title: 'Send your message and unpark it, so it reads the message now', onclick: () => form.sendAndUnpark?.() }, 'Send and unpark'),
      ] : []));
    }
    const hint = form.querySelector('.parked-hint');
    if (hint) {
      const text = coord ? null : composerHint(t);
      hint.hidden = !text;
      hint.replaceChildren(text ? h('span', { 'aria-hidden': 'true' }, '⏸ ') : '', text ?? '');
    }
  }
  const actions = [];
  // The minion's branch, running on a copy of the data (start_preview, src/previews.ts).
  if (t.preview && t.status !== 'closed') {
    actions.push(h('button', { class: 'secondary', title: 'Open this minion\'s preview in a new tab', onclick: () => window.open(`../preview/${t.id}/`, '_blank', 'noopener') }, 'Preview'));
  }
  if (t.status !== 'running' && !t.limit_resume_at) stoppingIds.delete(t.id); // it has stopped
  // Waiting on the usage limit, Stop ends the wait (src/runner.ts, stop).
  if (t.status === 'running' || t.limit_resume_at) {
    const stopping = stoppingIds.has(t.id);
    actions.push(h('button', { class: 'secondary act-stop', disabled: stopping, title: t.limit_resume_at ? 'Don\'t resume after the usage limit resets' : undefined, onclick: () => stopChat(t, renderTicketHead) }, stopping ? 'Stopping…' : 'Stop'));
  } else if (coord) {
    // The coordinator stays open for the life of the project; its Claude session can start fresh (#406).
    if (t.session_id && !t.fresh_pending) {
      actions.push(h('button', { class: 'secondary act-fresh', title: 'Start the Taskmaster on a fresh Claude session: it writes a handoff, then its next turn starts from that instead of this whole conversation', onclick: () => freshSession(t) }, 'Fresh', h('span', { class: 'wide-only' }, ' session')));
    }
  } else if (t.status === 'closed') {
    actions.push(h('button', { class: 'secondary act-reopen', onclick: () => setStatus(t, 'idle') }, 'Reopen minion'));
  } else {
    actions.push(h('button', { class: 'secondary act-dismiss', onclick: () => {
      setStatus(t, 'closed');
      location.hash = `#/p/${t.project_id}`;
    }, title: 'Dismiss minion' }, 'Dismiss', h('span', { class: 'wide-only' }, ' minion')));
  }
  // Out of a minion's touched set (#919): your Taskmaster stops hearing from it until you touch it again.
  if (!coord && account?.id != null && t.touched?.includes(account.id)) actions.unshift(leaveButton(t));
  actions.unshift(ultraButton(t));
  const state = headState(t);
  // Titled too, since a narrow line may cut it short. While it works (its turn or the server, #727),
  // a cut-short state shows dots that count up instead of "Thi…".
  const working = !!workingBy(t);
  const stateLabel = h('span', { class: 'muted head-state', title: t.status === 'closed' && t.closed_at ? `Dismissed ${dismissedWhen(t.closed_at).full}` : state }, h('span', { class: 'state-text' }, state),
    working ? h('span', { class: 'state-dots', 'aria-hidden': 'true' }, h('i', {}, '.'), h('i', {}, '.'), h('i', {}, '.')) : '');
  const phone = narrow.matches;
  // Leaves the thread as it is and goes back to the project's coordinator, or to Home for a chat opened from it (#1140).
  const close = view?.home ? h('a', { class: 'close-view', href: '#/home', title: 'Back to Home', 'aria-label': 'Back to Home' }, icon('close'))
    : coord ? '' : h('a', { class: 'close-view', href: `#/p/${t.project_id}`, title: 'Back to the Taskmaster', 'aria-label': 'Back to the Taskmaster' }, icon('close'));
  const nav = h('span', { class: 'head-nav' },
    // Through the views opened in this tab, never off the site (public/navstack.js).
    h('button', { type: 'button', class: 'nav-btn nav-back', title: 'Back', 'aria-label': 'Back', disabled: !canBack(), onclick: goBack }, icon('back')),
    h('button', { type: 'button', class: 'nav-btn nav-forward', title: 'Forward', 'aria-label': 'Forward', disabled: !canForward(), onclick: goForward }, icon('forward')),
    phone ? '' : close);
  // Wider screens: the title's line keeps who it is; the line under it takes the state, where the change
  // is, the tools, the buttons, Find and the way out.
  // Phones (#492): two rows. Title, ⋯ and ×; then the state or the progress line beside the one button
  // that matters now. Everything else waits behind ⋯.
  // Find's box is put back in the redrawn bar, which drops the caret from it: keep it there.
  const had = el.contains(document.activeElement) ? document.activeElement : null;
  const main = phone ? actions.findLast((a) => a && /\bact-(stop|dismiss|reopen)\b/.test(a.className)) : null;
  // A search in progress keeps the menu open: its box is in there.
  const menuOpen = phone && (menuFor === t.id || !!view.findEl?.querySelector('.chat-find')?.value);
  const more = h('button', { type: 'button', class: 'nav-btn head-more', 'data-part': 'minion-menu', title: 'More', 'aria-label': 'More', 'aria-expanded': String(menuOpen), onclick: () => {
    menuFor = menuOpen ? null : t.id;
    renderTicketHead();
  } }, '⋯');
  // ‹ › × sit right of Find (Josh, 2026-11-13); on phones × stays on the title's line.
  const sub = h('div', { class: 'head-sub', hidden: phone && !menuOpen, 'data-part': phone ? null : 'minion-menu', 'data-part-opener': phone ? 'minion-menu' : null }, phone ? '' : stateLabel, shipLine(t), coord ? '' : personNoteButton(t), coord ? '' : pinButton(t), coord ? '' : propertyChip(t), budgetChip(t),
    h('span', { class: 'spacer' }), ...actions.filter((a) => a !== main), view.findEl ?? '', nav);
  patchParts(el, [
    h('div', { class: phone ? 'row head-top' : 'row' },
      h('span', { class: `dot ${working ? 'running' : t.status}` }),
      h('h2', coord ? {} : { title: threadFullName(t) }, threadTitleParts(t)),
      presenceHead(t),
      contextMeter(t),
      coord && view.merged ? tmViewSwitch() : '',
      phone ? h('span', { class: 'spacer' }) : '',
      phone ? more : '',
      phone ? close : ''),
    coord ? (view.project ? onboardingStrip(view.project) : '') : personNoteLine(t),
    coord && view.merged?.mode === 'mine' ? tmBanner() : '',
    phone ? h('div', { class: 'head-line' }, stateLabel, view.progressEl, main ?? '') : '',
    sub,
    phone ? '' : view.progressEl], new Set([view.findEl, view.progressEl, noteEdit?.el]));
  stateFit?.disconnect();
  if (working) stateFit?.observe(el.querySelector('.head-state'));
  if (had?.isConnected && document.activeElement !== had) had.focus({ preventScroll: true });
  renderTyping();
  syncHeldBrief();
  // While a turn runs, Send steers it (composer.js); said on hover rather than in a line of its own.
  const send = document.querySelector('.composer button[type=submit]');
  if (send) send.title = t.status === 'running' ? 'Claude reads it between steps of the running turn; ▾ sends it after this turn' : '';
  scheduleProgress();
}

// The head's kept parts keep their handlers (patchParts), so every part closes over this one copy of its minion, kept current.
let headCopy = null;
function headTicket(t) {
  if (headCopy?.id !== t.id) headCopy = {};
  for (const k of Object.keys(headCopy)) if (!(k in t)) delete headCopy[k];
  return Object.assign(headCopy, t);
}

/**
 * Make `parent`'s children `want`, keeping each old part whose markup is as it was drawn (#1531): the head redraws
 * on every update to its minion, and a part kept keeps hover, focus and an open menu. A row or the line under the
 * title is opened up, a part in it compared on its own; `live` nodes (Find, the readout, a note being written) are
 * the same node each time, so they move rather than compare.
 */
function patchParts(parent, want, live, rows = true) {
  want = want.filter((c) => c != null && c !== false).map((c) => (c instanceof Node ? c : document.createTextNode(String(c))));
  const sigOf = (n) => (n.nodeType === 1 ? n.outerHTML : n.nodeValue);
  want.forEach((c, i) => {
    const at = parent.childNodes[i];
    if (at === c) return;
    const sig = sigOf(c);
    // A row's parts are compared one by one next time, so they remember how they were drawn too.
    if (rows) for (const k of c.childNodes ?? []) k.sig = sigOf(k);
    if (live.has(c) || !at || live.has(at)) parent.insertBefore(c, at ?? null);
    // Unchanged, unless it holds a live part: drawing it again moved that part into the new copy.
    else if (at.sig === sig && ![...live].some((l) => l && c.contains(l))) return;
    else if (rows && c.nodeType === 1 && at.nodeName === c.nodeName && at.className === c.className && /\b(row|head-sub|head-line)\b/.test(c.className)) {
      for (const { name } of [...at.attributes]) if (!c.hasAttribute(name)) at.removeAttribute(name);
      for (const { name, value } of c.attributes) if (at.getAttribute(name) !== value) at.setAttribute(name, value);
      patchParts(at, [...c.childNodes], live, false);
      return void (at.sig = sig);
    } else at.replaceWith(c);
    c.sig = sig;
  });
  while (parent.childNodes.length > want.length) parent.lastChild.remove();
}

/** The chat whose ⋯ menu is open on a phone: the head redraws often, so it is kept here. */
let menuFor = null;


/** Take the ticket the server returned after a send or a card's answer, if that chat is still open. */
export function adoptTicket(ticketId, ticket) {
  if (view?.id !== ticketId) return;
  // Your message went to your own Taskmaster instead (#919 makes it, splitting the scheme, on a member's first write):
  // open the scheme again, which now opens yours. shortcut: a whole reload, once per person per scheme; fine at that rate.
  if (ticket.id !== ticketId && isCoordinator(ticket)) return void location.reload();
  view.ticket = ticket;
  renderTicketHead();
  catchUpEvents().catch(() => {});
}

function leaveButton(t) {
  const mark = (inIt) => {
    const now = view.tickets?.get(t.id) ?? t;
    now.touched = inIt ? [...new Set([...(now.touched ?? []), account.id])] : (now.touched ?? []).filter((id) => id !== account.id);
    if (view.ticket?.id === t.id) renderTicketHead();
  };
  return h('button', { type: 'button', class: 'secondary act-leave', title: 'Stop hearing from this minion in your Taskmaster. Messaging it or answering its cards brings you back.', onclick: () => optimistic({
    label: 'leave this minion',
    apply: () => mark(false),
    send: () => api(`api/tickets/${t.id}/leave`, { method: 'POST', body: {} }),
    undo: () => mark(true),
  }) }, 'Leave');
}

/** Ask for a Taskmaster's fresh session (#406): the button goes at once, and comes back if the server refuses. */
function freshSession(t) {
  if (!confirm('Start the Taskmaster on a fresh session? It saves what lasts to memory and writes a handoff, then its context resets. The chat stays as it is.')) return;
  const mark = (on) => {
    if (view.ticket?.id !== t.id) return;
    view.ticket.fresh_pending = on;
    renderTicketHead();
  };
  optimistic({
    label: 'start a fresh session',
    apply: () => mark(true),
    send: () => api(`api/tickets/${t.id}/fresh-session`, { method: 'POST', body: {} }),
    undo: () => mark(false),
  });
}

// Phones put ‹ › × on the line under the title, so turning a tablet across the breakpoint redraws the bar.
narrow.addEventListener('change', () => { if (view?.ticket) renderTicketHead(); });

// Squeezed is measured against the text's own width, taken while it shows (the label itself may have
// grown into spare room): once the dots are in, the label is narrower than its text for as long as the room stays short.
const stateFit = typeof ResizeObserver === 'function' ? new ResizeObserver(([{ target: el }]) => {
  if (!el.classList.contains('squeezed')) el.need = el.firstChild.offsetWidth;
  el.classList.toggle('squeezed', el.clientWidth < el.need);
}) : null;

// ---------- people's note (#146) ----------

const PERSON_NOTE_MAX = 200; // the server's limit, PERSON_NOTE_MAX in src/db.ts
// The note being edited, { id, el }: kept across the head's re-renders, which a running turn makes often.
let noteEdit = null;

/** "✎ Note" after the ship status, under the title, while a minion has no note and none is being written. */
function personNoteButton(t) {
  if (view.personNotes?.[t.id] || noteEdit?.id === t.id) return '';
  return h('button', { type: 'button', class: 'note-btn', 'data-part': 'minion-note', title: 'Add a note only people see', 'aria-label': 'Add a note', onclick: () => editPersonNote(t) },
    '✎', h('span', { class: 'wide-only' }, 'Note'));
}

/** The note under the title, a click away from editing it, or its editor while someone writes it. */
function personNoteLine(t) {
  if (noteEdit?.id === t.id) return noteEdit.el;
  const note = view.personNotes?.[t.id];
  if (!note) return '';
  return h('div', { class: 'pnote', title: 'Only people see this note. Click to edit it.', onclick: (e) => { if (!e.target.closest('a')) editPersonNote(t); } },
    h('span', { class: 'pen', 'aria-hidden': 'true' }, '✎'), h('span', { class: 'text' }, threadRefs(note.text)),
    h('span', { class: 'who' }, `${note.by} · ${ago(note.at)}`));
}

function editPersonNote(t) {
  const input = h('input', { type: 'text', maxlength: PERSON_NOTE_MAX, placeholder: 'A note only people see', 'aria-label': 'Note only people see', autocomplete: 'off' });
  input.value = view.personNotes?.[t.id]?.text ?? '';
  const done = () => {
    noteEdit = null;
    renderTicketHead();
  };
  // Shown at once; the server's broadcast replaces it with its own copy, and a refusal puts the old note back.
  const show = (note) => {
    const notes = view.personNotes ?? {}; // none if the person left the scheme meanwhile
    if (note) notes[t.id] = note;
    else delete notes[t.id];
    renderSidebar();
    if (view.id === t.id) renderTicketHead();
  };
  const save = () => {
    const was = view.personNotes?.[t.id];
    const text = input.value.replace(/\s+/g, ' ').trim(); // as the server stores it
    noteEdit = null;
    const mine = text ? { text, by: me, at: Date.now() } : undefined;
    optimistic({
      sets: `note:${t.id}`,
      apply: () => show(mine),
      send: () => api(`api/tickets/${t.id}/person-note`, { method: 'PUT', body: { text } }),
      undo: () => view.personNotes?.[t.id] === mine && show(was), // unless something else changed it since
      label: `save the note on ${threadLabel(t)}`,
    });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(); }
    if (e.key === 'Escape') done();
  });
  const el = h('form', { class: 'pnote editing', onsubmit: (e) => { e.preventDefault(); save(); } },
    h('span', { class: 'pen', 'aria-hidden': 'true' }, '✎'), input,
    h('button', { type: 'submit', class: 'small' }, 'Save'),
    h('button', { type: 'button', class: 'secondary small', onclick: done }, 'Cancel'));
  noteEdit = { id: t.id, el };
  renderTicketHead();
  input.focus();
}

// ---------- your pins (#179) ----------

/** Pin or unpin the minion to the Pinned section atop your own list. */
function pinButton(t) {
  const pinned = view.pins?.includes(t.id);
  // The stream says so too, maybe later; a click after this one redraws first, so it unpins again.
  const show = (on) => onTicketPin({ name: me, projectId: t.project_id, ticketId: t.id, pinned: on });
  const toggle = () => optimistic({
    sets: `pin:${t.id}`,
    apply: () => show(!pinned),
    send: () => api(`api/tickets/${t.id}/pin`, { method: 'PUT', body: { pinned: !pinned } }),
    undo: () => !!view.pins?.includes(t.id) !== pinned && show(pinned), // unless something else changed it since
    label: `${pinned ? 'unpin' : 'pin'} ${threadLabel(t)}`,
  });
  return h('button', { type: 'button', 'data-part': 'pin-minion', class: `note-btn pin-btn${pinned ? ' on' : ''}`, title: pinned ? 'Unpin from the top of your list' : 'Pin to the top of your list (only you see your pins)', 'aria-label': pinned ? 'Unpin' : 'Pin', 'aria-pressed': String(!!pinned), onclick: toggle },
    icon('pin'), h('span', { class: 'wide-only' }, pinned ? 'Pinned' : 'Pin'));
}

/** "$14 of about $6.50" (#1114): what the minion has cost against what its kind of work usually does; amber once past the ask. */
function budgetChip(t) {
  const b = !isCoordinator(t) && t.budget;
  if (!b) return '';
  const usd = (n) => `$${n >= 10 ? Math.round(n) : n.toFixed(2)}`;
  const cost = t.cost ?? 0;
  return h('span', { class: `tag-chip budget-chip${cost >= b.ask ? ' over' : ''}`,
    title: `${b.basis} has usually cost about ${usd(b.usd)} (median of ${b.n} minions, last 4 weeks). Past ${usd(b.ask)} the minion is asked to say why or split the work; past ${usd(b.wake)} its Taskmaster hears. Never a stop.` },
  `${usd(cost)} of about ${usd(b.usd)}`);
}

/** Where the minion's change is, branch to live, in a word or two; the full line and why it is stuck are on hover (src/branch.ts). */
function shipLine(t) {
  const stage = !isCoordinator(t) && SHIP[t.ship?.stage];
  if (!stage) return '';
  return h('span', { class: `ship f-${stage.fam}`, title: `${t.ship.detail ?? t.ship.text} · ${t.ship.commit}` },
    h('i', { class: 'ship-dot' }), h('span', { class: 'text' }, gloss('ship', stage.badge || 'on branch')));
}

/**
 * A message held for a minion says so in its bubble, in place (Josh, 2026-11-20: "make the held mail messages we show to
 * users a lot less intense, maybe we go back to how it used to look with a small less intrusive "deliver" button"): a dashed
 * bubble with a quiet "Not sent yet" row while it waits (a small Deliver on the newest one, Unpark and send when parked), a
 * small tag once a turn read it. Queued into a working minion it shows dashed with the "not sent yet" tag instead.
 * The row is one fixed height either way, so nothing moves when it flips.
 */
function markHeld(bubble, ticket, last = true) {
  const line = heldLine(bubble.heldData, Number(bubble.dataset.event), ticket);
  if (!line) return;
  bubble.classList.add('held-msg');
  bubble.classList.toggle('held-waiting', line.waiting);
  bubble.classList.toggle('held-queued', line.queued);
  let row = bubble.querySelector(':scope > .held-line');
  // The button sits where it shows without opening anything: in the summary of a collapsed bubble or of the group row it's in.
  const host = bubble.parentElement?.closest('details.mcopies') ?? (bubble.matches('details') ? bubble : null);
  const act = host?.querySelector(':scope > summary') ?? row;
  for (const old of (host ?? bubble).querySelectorAll('.held-act')) if (old.dataset.for === String(bubble.dataset.event)) old.remove();
  if (line.waiting) {
    bubble.querySelector('.who .held-tag')?.remove();
    if (!row) bubble.append(row = h('div', { class: 'held-line', role: 'status' }));
    const parked = ticket.parked_for || ticket.state === 'parked';
    row.replaceChildren(h('span', { class: 'held-text' }, parked ? "Not sent yet: this minion is parked, so it reads this when it's unparked." : line.text));
    if (last) {
      const btn = parked
        ? h('button', { type: 'button', class: 'secondary small held-act', title: 'Wake it now: it reads the messages left for it' }, 'Unpark and send')
        : h('button', { type: 'button', class: 'secondary small held-act', title: 'Run a turn now that reads all the held mail' }, 'Deliver');
      btn.dataset.for = bubble.dataset.event;
      btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (parked) unpark(ticket); else deliverMail(ticket, btn); };
      (act ?? row).append(btn);
    }
    return;
  }
  row?.remove();
  let tag = bubble.querySelector('.held-tag');
  if (!tag) bubble.querySelector('.who')?.append(tag = h('span', { class: 'msg-tag held-tag' }));
  tag?.replaceChildren(line.queued ? 'not sent yet' : line.tag);
  tag?.setAttribute('title', line.queued ? line.text : line.title);
}

/** Deliver: the row says so at once and the turn starts behind it; a refusal, or none delivered because its Claude can't run a turn, puts it back with a toast and a retry. */
function deliverMail(t, btn) {
  const was = btn.textContent;
  optimistic({
    key: `deliver:${t.id}`,
    apply: () => { btn.disabled = true; btn.textContent = 'Delivering…'; },
    send: async () => {
      const r = await api(`api/tickets/${t.id}/deliver-mail`, { method: 'POST', body: {} });
      if (!r?.delivered) throw new Error("its Claude can't run a turn right now");
    },
    undo: () => { btn.disabled = false; btn.textContent = was; },
    label: 'deliver the held mail',
  });
}

/** Unpark (#718): the row and header drop parked at once; a refusal puts them back with a toast and a retry. */
function unpark(t) {
  const was = { state: t.state, parked_for: t.parked_for, held_brief: t.held_brief };
  const show = (v) => {
    for (const x of new Set([t, view?.tickets?.get(t.id), view?.ticket?.id === t.id && view.ticket])) if (x) Object.assign(x, v);
    renderSidebar();
    if (view?.id === t.id) renderTicketHead();
  };
  optimistic({
    sets: `unpark:${t.id}`,
    apply: () => show({ state: null, parked_for: null, held_brief: null }),
    send: () => api(`api/tickets/${t.id}/unpark`, { method: 'POST', body: {} }),
    undo: () => t.state === null && show(was),
    label: `unpark ${threadLabel(t)}`,
  }).catch(() => {});
}

/** Dismiss (closed) or reopen (idle) a minion: shown at once in its head and the list, put back if the server says no. */
function setStatus(t, status) {
  const was = t.status;
  const show = (s) => {
    for (const x of new Set([t, view?.tickets?.get(t.id), view?.ticket?.id === t.id && view.ticket])) if (x) x.status = s;
    renderSidebar();
    if (view?.id === t.id) renderTicketHead();
  };
  // The server's echo can't move Needs you here, since this page already changed the minion: fetch it once the server has it.
  optimistic({
    sets: `status:${t.id}`,
    apply: () => show(status),
    send: () => api(`api/tickets/${t.id}/status`, { method: 'POST', body: { status } }),
    undo: () => t.status === status && show(was), // unless something else changed it since
    label: `${status === 'closed' ? 'dismiss' : 'reopen'} ${threadLabel(t)}`,
  }).then(refreshInbox, () => {});
}

// Mine and Everyone (#920): each other Taskmaster session's drawing state, swapped into `view` while one of
// its events is drawn, so its turns fold, hold cards and count actions on their own. Yours stays in `view`.
const SESSION_STATE = ['ticket', 'part', 'progress', 'actions', 'turnActions', 'lastPlan', 'heldCards', 'gruntStarts', 'sawInit', 'latestReply', 'turnNote', 'turnInitAt', 'narration', 'narrationEl', 'folds', 'pendingRequest', 'turnRequest'];
const sessionState = (o) => Object.fromEntries(SESSION_STATE.map((k) => [k, o[k]]));

function newSessionState(part) {
  const ticket = view.taskmasters?.find((t) => t.id === part.id)?.ticket ?? { id: part.id, kind: 'coordinator', project_id: view.projectId, status: 'idle' };
  return {
    ticket, part, progress: createProgress(), actions: new Map(), turnActions: [], lastPlan: null, heldCards: [], gruntStarts: new Map(),
    sawInit: true, latestReply: null, turnNote: null, turnInitAt: undefined, narration: narrationSorter(), narrationEl: null, folds: [], pendingRequest: [], turnRequest: undefined,
  };
}

export function appendEvent(event, scroll = true) {
  // "Say hi" ticks as you send (#1151): only live items, and only while the welcome is still yours.
  if (scroll && event.kind === 'user_message' && account?.welcome && JSON.parse(event.data).author === me) refreshWelcome();
  const m = view.merged;
  if (!m) return drawEvent(event, scroll);
  const id = event.ticket_id;
  const part = m.parts.find((p) => p.id === id);
  if (!part) return;
  if (m.last !== id) {
    // Another session's items start here, so the last one's words don't run on or collapse across them.
    const left = m.last === view.id ? view : m.states.get(m.last);
    if (left?.folds.length) left.folds.push({ fate: 'break' });
    else if (left) left.narrationEl = null;
    if (left) left.heldCards = [];
    m.last = id;
  }
  if (id === view.id) return drawEvent(event, scroll);
  const own = sessionState(view);
  Object.assign(view, m.states.get(id) ?? newSessionState(part));
  try {
    drawEvent(event, false);
  } finally {
    m.states.set(id, sessionState(view));
    Object.assign(view, own);
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
    if (followChat) scrollToBottom();
    renderCardJump();
  });
}

function drawEvent(event, scroll) {
  // Live events join the loaded history, so a redraw (Load earlier) and the cache keep them.
  if (view.page && event.id > (view.page.events.at(-1)?.id ?? 0)) view.page.events.push(event);
  view.lastEventId = Math.max(view.lastEventId, event.id);
  const log = document.getElementById('log');
  if (!log) return;
  const data = JSON.parse(event.data);
  recapEvent(event, data);
  // A steer was read by the turn already running, so it isn't part of what the next turn works on.
  if (event.kind === 'user_message' && !data.steered) (view.pendingRequest ??= []).push({ id: event.id, author: data.author, text: data.text || '(image)' });
  if (event.kind === 'claude' && data.type === 'system' && data.subtype === 'init') {
    view.turnActions = [];
    view.turnNote = null;
    view.turnInitAt = event.created_at;
    view.narration = narrationSorter();
    flushFolds();
    view.narrationEl = null;
    // Messages queued since the last turn are what this turn works on.
    if (view.pendingRequest?.length) view.turnRequest = view.pendingRequest;
    view.pendingRequest = [];
  }
  // A Grunt's words collapse into its own line, so they aren't the minion's reply or its working line.
  const grunt = gruntOf(event.kind, data);
  if (grunt && !view.gruntStarts.has(grunt)) view.gruntStarts.set(grunt, event.created_at);
  if (event.kind === 'claude' && data.type === 'assistant' && !grunt) {
    for (const b of data.message?.content ?? []) if (b.type === 'text' && b.text.trim()) view.turnNote = b.text.trim();
  }
  for (const { block, taskId } of applyEvent(view.progress, event.kind, data, event.created_at)) {
    // Which event it came from, so an opened row can fetch it whole when the page sent it cut (eventcut.js).
    const action = { block, taskId, result: null, event: { id: event.id, ticket: event.ticket_id } };
    view.actions.set(block.id, action);
    view.turnActions.push(action);
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
    if (view.folds.length) view.folds.push({ fate: 'break' });
    else view.narrationEl = null;
    if (data.author === me && data.sendId) {
      // Our own message, already shown when it was sent: swap in the server's copy, found by its sendId (#392).
      const i = view.pendingMessages.findIndex((m) => m.sendId === data.sendId);
      // null, not false, when it isn't ours to swap (a reload replays every message): ?. passes false through.
      const m = i >= 0 ? view.pendingMessages.splice(i, 1)[0] : null;
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
    const card = view.cards.get(data.answer?.questionId ?? (data.plan?.verdict === 'approve' ? data.plan.planId : null));
    // A secret card's answer (#838) carries only the name it was saved as; its question_result shuts the card.
    if (data.answer?.answers) card?.markAnswered(data.answer.answers, data.author, (data.images ?? []).map((name) => `api/tickets/${event.ticket_id}/images/${encodeURIComponent(name)}`));
    if (card) {
      if (messagesBelow(card.el)) nodes.push(stamped(answerRef(card.el, data), event));
      // Someone else's answer counts as new, so the unread divider can still land on the card.
      else if (data.author !== me) card.el.dataset.at = event.created_at;
    } else if (data.answer) {
      // The card is in history not loaded yet.
      nodes.push(stamped(h('div', { class: 'msg user answer' }, h('div', { class: 'who' }, data.author), data.answer.secret ? h('div', { class: 'answer-lines' }, `→ saved the secret as ${data.answer.secret}`) : answerSummary(data.answer.answers)), event));
    } else {
      const bubble = userBubble(data.author, data.text,
        (data.images ?? []).map((name) => `api/tickets/${event.ticket_id}/images/${encodeURIComponent(name)}`),
        data.comment ? { ticketId: event.ticket_id, path: data.comment.path, name: baseName(data.comment.about) } : null,
        { id: event.id, strikes: data.strikes, brief: data.brief, schedule: data.schedule, ask: data.ask, mentions: data.mentions },
        (data.files ?? []).map((f) => ({ ...f, href: uploadUrl(event.ticket_id, f.name) })));
      bubble.dataset.event = event.id;
      // What its ✎ puts back in the message box while it waits in the queue (markQueued); a comment on a file would lose its file.
      if (data.author === me && !data.comment) bubble.sent = { text: data.text ?? '', images: data.images ?? [], files: data.files ?? [] };
      stamped(bubble, event);
      if (data.steered) bubble.querySelector('.who').append(h('span', { class: 'msg-tag', title: 'Sent into the turn that was running: Claude read it between steps' }, 'into the running turn'));
      if (data.mail) {
        bubble.heldData = data;
        markHeld(bubble, view.ticket);
      }
      if (data.need) bubble.querySelector('.who').append(h('span', { class: 'msg-tag', title: 'What the sender said this message needs' }, `need: ${data.need}`));
      markQueued(bubble, view.ticket);
      if (data.mail && TRACKING.test(data.text ?? '')) {
        // A run of "for your tracking" notes from one minion is one collapsed row, each note behind it (#1001).
        const pending = new Set(view.pendingMessages.map((m) => m.el));
        let prev = log.lastElementChild;
        while (prev && pending.has(prev)) prev = prev.previousElementSibling;
        bubble.dataset.tracking = data.author;
        if (prev?.matches('.mcopies.tracked') && prev.dataset.author === data.author) addTracked(prev, bubble);
        else if (prev?.dataset.tracking === data.author) {
          // The second note: the lone one above joins a new group row.
          const group = newTracked(data.author);
          prev.replaceWith(group);
          group.dataset.at = prev.dataset.at;
          addTracked(addTracked(group, prev), bubble);
        } else nodes.push(bubble);
      } else nodes.push(bubble);
    }
  } else if (event.kind === 'unqueued') {
    // Taken back before its turn: not what the next turn works on.
    view.pendingRequest = view.pendingRequest?.filter((m) => m.id !== data.id);
    const bubble = log.querySelector(`[data-event="${data.id}"]`);
    if (bubble) showTakenBack(bubble, data.by, false);
  } else if (event.kind === 'question') {
    nodes.push(stamped(questionCard(event.ticket_id, data, { at: event.created_at }), event));
  } else if (event.kind === 'job') {
    // The card follows the bottom of the chat (Cara's pick, 2026-11-17): each time the job starts, pauses or ends
    // it comes down here, and where it was keeps a one-line note.
    const old = log.querySelector(`.jobcard[data-job-card="${data.job}"]`);
    if (old) {
      const note = jobMovedNote(data, jumpHref(view.ticket, event.id));
      Object.assign(note.dataset, old.dataset);
      old.replaceWith(note);
    }
    nodes.push(jobCard(data.job, data.view, 'chat'));
  } else if (event.kind === 'approval') {
    nodes.push(stamped(approvalCard(event.ticket_id, data), event));
  } else if (event.kind === 'plan') {
    nodes.push(stamped(planCard(event.ticket_id, data, { at: event.created_at }), event));
  } else if (event.kind === 'question_more') {
    view.cards.get(data.id)?.extend(data.questions);
  } else if (event.kind === 'question_result') {
    view.cards.get(data.id)?.markSettled(data.settled);
  } else if (event.kind === 'strike') {
    // strike_text: redraw the message it struck, wherever it shows now (a bubble or a collapsed update).
    for (const el of log.querySelectorAll(`[data-body="${data.event}"]`)) {
      const row = el.closest('.coord');
      el.replaceWith(messageBody(el.source, data.strikes, el.ticketId, data.event));
      if (row?.matches('.narration')) narrationSummary(row);
      else row?.querySelector('summary .preview')?.replaceChildren(...previewNodes(el.source, data.strikes));
    }
  } else if (event.kind === 'note_edit') {
    // A note rewritten in place (the day's worktree cleanup, #1055): its line and list change, its open state stays.
    for (const el of log.querySelectorAll(`[data-note="${data.event}"]`)) {
      el.querySelector('summary')?.replaceChildren(...[].concat(threadRefs(data.text)));
      el.querySelector('pre')?.replaceChildren(data.detail ?? '');
    }
  } else if (event.kind === 'replaced') {
    // A reply the link check sent back gives way to its rewrite (#281): the bubble, or its line in the collapsed row.
    for (const el of log.querySelectorAll(`[data-body="${data.event}"]`)) {
      const row = el.closest('details.narration');
      (el.closest('.note-text') ?? el.closest('.msg') ?? el).remove();
      if (row?.querySelector('.notes').childElementCount === 0) row.remove();
      else if (row) narrationSummary(row);
    }
  } else if (event.kind === 'plan_result') {
    view.cards.get(data.id)?.settle(data);
  } else if (event.kind === 'ultrareview') {
    const card = ultraCard(data);
    view.cards.set(data.id, card);
    nodes.push(card);
  } else if (event.kind === 'ultrareview_result') {
    const card = view.cards.get(data.id);
    if (card?.settle) card.settle(data);
    else nodes.push(ultraResult(data));
  } else if (event.kind === 'minion_copy') {
    // A run of copies of minion-to-minion messages is one collapsed row (#924); any other event ends it.
    // Messages still on their way sit last in the log, so the run's row is the last child before them.
    const pending = new Set(view.pendingMessages.map((m) => m.el));
    let prev = log.lastElementChild;
    while (prev && pending.has(prev)) prev = prev.previousElementSibling;
    if (prev?.matches('.mcopies')) addMinionCopy(prev, data, event);
    else nodes.push(addMinionCopy(newMinionCopies(), data, event));
  } else if (event.kind === 'side' || event.kind === 'side_answer') {
    // A side question and its answers share one row (#932, sidethread.js).
    const row = sideEvent(view.sideThreads, event, data, view.ticket, scroll);
    if (row) nodes.push(row);
  } else if (event.kind === 'loop_paused') {
    nodes.push(loopCard(data));
  } else if (event.kind === 'loop_continued') {
    for (const card of log.querySelectorAll(`.lcard[data-minion="${data.minion}"]:has(button)`)) {
      card.classList.add('answered');
      card.querySelector('button').remove();
      card.querySelector('[role=status]').textContent = `Continued by ${data.by}`;
    }
  } else if (event.kind === 'spend') {
    nodes.push(spendCard(data, event.ticket_id, view.ticket?.turnStartedAt));
  } else if (event.kind === 'spend_muted') {
    settleSpend(log, data);
  } else if (event.kind === 'approval_result') {
    // The card itself records who decided, or why it expired.
    view.cards.get(data.id)?.settle(data);
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
    nodes.push(h('details', { class: 'note detail fresh', title: data.why ? `Why: ${data.why}` : null }, h('summary', {}, h('span', { class: 'rule' }), data.why ? `Started fresh: ${data.why}` : 'Started fresh', h('span', { class: 'rule' })), h('div', { class: 'fresh-from' }, 'The handoff it started from:'), markdown(data.summary, event.ticket_id)));
  } else if (event.kind === 'error') {
    nodes.push(h('div', { class: 'note error' }, threadRefs(data.text)));
  } else if (grunt && data.type === 'assistant') {
    for (const block of data.message?.content ?? []) if (block.type === 'text' && block.text.trim()) addGruntText(log, grunt, block.text, data, event);
  } else if (event.kind === 'claude') {
    if (data.type === 'system' && data.subtype === 'init') {
      // Every turn re-inits the same session; only announce the first.
      if (!view.sawInit) nodes.push(h('div', { class: 'note' }, `Session started${data.model ? ` · ${data.model}` : ''}`));
      view.sawInit = true;
    } else if (data.type === 'assistant') {
      for (const block of data.message?.content ?? []) {
        // A reply the link check sent back, which its rewrite replaced (#281).
        if (block.type === 'text' && block.text.trim() && !data.replaced) {
          const body = messageBody(block.text, data.strikes, event.ticket_id, event.id);
          const msg = stamped(h('div', { class: 'msg reply', 'data-reply-event': event.id }, h('div', { class: 'who' }, speaker()), body), event);
          nodes.push(msg);
          spoke = msg;
          view.latestReply = event.id;
          settle.push(...view.narration.text({ el: msg, body, text: block.text }));
        } else if (block.type === 'tool_use') {
          settle.push(...view.narration.tool(block.name));
        }
      }
    } else if (data.type === 'user') {
      for (const block of data.message?.content ?? []) {
        const action = block.type === 'tool_result' && view.actions.get(block.tool_use_id);
        if (action) Object.assign(action, { result: { content: block.content, is_error: block.is_error, cut: block.cut, event: { id: event.id, ticket: event.ticket_id } }, doneAt: event.created_at });
      }
    } else if (data.type === 'result') {
      // Tool calls stay out of the chat; each turn gets one collapsed line listing them.
      const acts = view.turnActions;
      const bits = [];
      if (data.duration_ms) bits.push(shortDuration(data.duration_ms));
      if (acts.length) bits.push(`${acts.length} action${acts.length === 1 ? '' : 's'}`);
      const title = [data.is_error ? 'Turn failed' : 'Turn finished', ...bits, data.total_cost_usd ? `$${data.total_cost_usd.toFixed(2)}` : ''].filter(Boolean).join(' · ');
      const summary = [view.branchEl, h('span', { class: 'bits', title },
        h('span', { class: data.is_error ? 'fail' : 'ok', 'aria-label': data.is_error ? 'Turn failed' : 'Turn finished' }, data.is_error ? '✗' : '✓'),
        ` ${bits.join(' · ')}`)];
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
  if (!(event.kind === 'user_message' && data.author === me)) for (const n of nodes) n.dataset.at = event.created_at;
  // What a jump link (#236) finds it by.
  for (const n of nodes) n.dataset.eid = event.id;
  // Another session's items in Mine or Everyone (#920): the Overlord's on a purple band, each named by whose it is.
  if (view.part) for (const n of nodes) {
    n.classList.toggle('ovl', !!view.part.overlord);
    n.dataset.session = view.part.label;
    if (n.matches('.msg.user')) n.querySelector('.who')?.append(h('span', { class: 'msg-tag' }, `to ${view.part.label}`));
  }
  // A for-everyone card a person's Taskmaster asked through the Overlord (#921) says whose it was.
  const asker = data.asker && view.taskmasters?.find((t) => t.id === data.asker);
  if (asker?.person_name && (event.kind === 'question' || event.kind === 'plan')) for (const n of nodes) n.querySelector('.who')?.append(h('span', { class: 'msg-tag' }, `asked by ${asker.person_name}'s Taskmaster`));
  // A minion explains its card in the reply it writes after asking, so the card stays below that
  // turn's words until someone answers or the turn ends.
  const held = view.heldCards.find((el) => el.isConnected);
  if (held && event.kind === 'claude' && data.type === 'assistant') held.before(...nodes);
  // Your messages not in the server's history yet (on their way, or not sent) stay below everything that is.
  else log.append(...nodes, ...view.pendingMessages.map((m) => m.el));
  if (event.kind === 'question' || event.kind === 'plan') view.heldCards.push(...nodes);
  else if (event.kind === 'user_message' || (event.kind === 'claude' && data.type === 'result')) view.heldCards = [];
  // While the turn runs, its newest milestone line stays in the chat; the ones above it collapse as each
  // newer line arrives (#578), and the last at its answer (#551).
  for (const s of settle) {
    if (turnLive()) view.folds.push(s);
    if (s.fate !== 'fold' || !turnLive()) settleText(s.text, s.fate);
  }
  if (spoke && turnLive()) {
    // The newest line stays out even when the work in the same message has settled it already.
    const newest = view.folds.at(-1)?.text?.el === spoke ? view.folds.pop() : null;
    flushFolds();
    if (newest) view.folds.push(newest);
  }
  if (event.kind === 'claude' && data.type === 'result') flushFolds();
  mergePushNotes(log);
  renderTyping();
  if (scroll) afterLiveDraw();
}

/** The chat's cards still waiting on people that are out of sight (above the thread bar or under the composer), oldest first. */
function openCardsOutOfView() {
  const log = document.getElementById('log');
  if (!log) return [];
  const top = document.getElementById('ticket-head')?.getBoundingClientRect().bottom ?? 0;
  const bottom = log.parentElement.querySelector('.composer')?.getBoundingClientRect().top ?? innerHeight;
  // An ultra review's card waits on its review, not on a person.
  return [...log.querySelectorAll('.qcard:not(.answered, .ur-card)')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom <= top || r.top >= bottom;
  });
}

/** Show the composer's Card button while a waiting card is out of sight, pointing the way to it. */
export function renderCardJump() {
  const btn = document.querySelector('.composer .to-card');
  if (!btn) return;
  const card = openCardsOutOfView()[0];
  btn.hidden = !card;
  if (card) btn.firstChild.textContent = card.getBoundingClientRect().top < 0 ? '↑' : '↓';
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
function addGruntText(log, id, text, data, event) {
  const held = view.heldCards.find((el) => el.isConnected);
  const prev = held ? held.previousElementSibling : log.lastElementChild;
  const body = messageBody(text, data.strikes, event.ticket_id, event.id);
  const start = view.gruntStarts.get(id) ?? event.created_at;
  view.gruntStarts.delete(id);
  let lines = prev?.matches('.grunts') ? [...prev.querySelectorAll('.grunt')] : prev?.matches('.grunt') ? [prev] : [];
  let line = lines.find((l) => l.dataset.grunt === id);
  // A fan-out is Grunts that ran alongside each other: one started after the block's last report
  // (the critics after the drawers) starts a block of its own.
  if (!line && !(start <= Math.max(...lines.map((l) => l.end)))) lines = [];
  if (line) {
    line.querySelector('.grunt-body').append(body);
  } else {
    const name = gruntName(view.actions.get(id)?.block.input);
    line = h('details', { class: 'msg coord grunt', 'data-grunt': id, 'data-at': event.created_at },
      h('summary', {}, stepMark('done'), h('span', { class: 'who' }, h('span', { class: 'name' }, `Grunt · ${name}`)), h('span', { class: 'preview' }), h('span', { class: 'dur' })),
      h('div', { class: 'msg grunt-body' }, body));
    // Not `name`: on a <details> that makes same-named lines one group, opening one closing the rest.
    Object.assign(line, { start, gruntLabel: name });
  }
  line.end = event.created_at;
  line.querySelector('.preview').textContent = gist(text);
  line.querySelector('.dur').textContent = line.end > line.start ? shortDuration(line.end - line.start) : '';
  if (line === prev) return;
  if (!lines.length) return held ? held.before(line) : log.append(line);
  let group = prev;
  if (!group.matches('.grunts')) {
    group = h('details', { class: 'msg coord grunts', 'data-at': prev.dataset.at }, h('summary', {}), h('div', { class: 'grunt-list' }));
    prev.replaceWith(group);
    group.lastChild.append(prev);
  }
  if (!line.isConnected) group.lastChild.append(line);
  const all = [...group.lastChild.children];
  group.firstChild.replaceChildren(
    h('span', { class: 'who' }, groupTitle(all.length, Math.max(...all.map((l) => l.end)) - Math.min(...all.map((l) => l.start)), shortDuration)),
    h('span', { class: 'preview' }, all.map((l) => l.gruntLabel).join(', ')));
}

/** An empty group row for copies of minion-to-minion messages; addMinionCopy fills it. */
function newMinionCopies() {
  return h('details', { class: 'msg coord mcopies' }, h('summary', {}, h('span', { class: 'who' }), h('span', { class: 'preview' })), h('div', { class: 'mc-list' }));
}

/** One copy into its group row: a line in the list, and the count and the numbers in the summary, updated in place. */
function addMinionCopy(group, data, event) {
  const list = group.querySelector('.mc-list');
  const sender = data.author?.replace(/^#\d+\s*/, '') ?? '';
  const who = `${data.unparked ? 'unparked' : '→'} #${data.to}`;
  list.append(h('div', { class: 'mc-row', 'data-eid': event.id }, h('span', { class: 'mc-who' }, `${data.from ? '#' + data.from : data.author} ${who}`), h('span', { class: 'mc-text', title: sender }, data.text)));
  const nums = new Set((group.dataset.nums ? group.dataset.nums.split(',').map(Number) : []));
  for (const n of [data.from, data.to]) if (n) nums.add(n);
  group.dataset.nums = [...nums].join(',');
  const count = list.children.length;
  const all = [...nums].sort((a, b) => a - b).map((n) => `#${n}`).join(', ');
  group.querySelector('.who').textContent = `${count} message${count === 1 ? '' : 's'} between ${all}`;
  group.dataset.at ??= event.created_at;
  return group;
}

/** An empty group row for one sender's tracking notes; addTracked fills it. */
function newTracked(author) {
  return h('details', { class: 'msg coord mcopies tracked', 'data-author': author }, h('summary', {}, h('span', { class: 'who' }), h('span', { class: 'preview' })), h('div', { class: 'mc-list' }));
}

/** One tracking note's own row into its group: the count and the sender in the summary, the newest note as the preview. */
function addTracked(group, bubble) {
  const list = group.querySelector('.mc-list');
  list.append(bubble);
  const count = list.children.length;
  const sender = group.dataset.author.replace(/\s.*$/, '');
  group.querySelector('.who').textContent = `${count} tracking note${count === 1 ? '' : 's'} from ${sender}`;
  group.querySelector('.preview').textContent = bubble.querySelector('.preview')?.textContent.replace(TRACKING, '').trim() ?? '';
  return group;
}

/** The time a message or card was posted, after its who-line; the full date shows on hover. */
function stamped(el, event) {
  if (!event.created_at) return el;
  const d = new Date(event.created_at);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // Today: just the time. This week: the weekday too. Older: the date.
  const text = d.toDateString() === now.toDateString() ? time
    : now - d < 6 * 86_400_000 ? `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })}, ${time}`;
  el.querySelector('.who')?.append(h('time', { class: 'stamp', datetime: d.toISOString(), title: d.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' }) }, text));
  return el;
}

/**
 * Collapse or keep one of the turn's words, as narrationSorter settled it. Collapsed remarks go in an
 * "N updates" row, one per stretch between kept messages, where the first of them was.
 */
function settleText(t, fate) {
  if (fate !== 'fold') {
    if (fate === 'clamp') clamp(t.el);
    view.narrationEl = null;
    return;
  }
  if (!view.narrationEl?.isConnected) {
    view.narrationEl = h('details', { class: 'msg coord narration', 'data-at': t.el.dataset.at }, h('summary', {}), h('div', { class: 'notes' }));
    t.el.before(view.narrationEl);
  }
  t.el.remove();
  // Its event id goes with it, so a jump link (?e=) still finds the line inside the row.
  view.narrationEl.querySelector('.notes').append(h('div', { class: 'note-text', 'data-eid': t.el.dataset.eid }, t.body));
  narrationSummary(view.narrationEl);
}

/** A collapsed row's one line (#578): how many updates are in it, then the newest of them. */
function narrationSummary(row) {
  const bodies = row.querySelectorAll(':scope > .notes > .note-text > [data-body]');
  const n = bodies.length;
  const last = bodies[n - 1];
  row.querySelector('summary').replaceChildren(
    h('span', { class: 'who' }, h('span', { class: 'name' }, `${n} update${n === 1 ? '' : 's'}`)),
    h('span', { class: 'preview' }, last ? previewNodes(last.source, last.strikes) : ''));
}

/**
 * A chained minion's held brief (#728), read-only in its chat above the messages left for it, until the brief is sent.
 * Idempotent: the head's redraw calls it, so it draws, replaces or removes the block as the ticket says.
 */
function syncHeldBrief() {
  const log = document.getElementById('log');
  if (!log || !view?.ticket) return;
  const b = view.ticket.held_brief;
  const old = log.querySelector(':scope > .held-brief');
  if (!b) return old?.remove();
  const key = `${b.leader}|${b.when}|${b.from}|${b.text}`;
  if (old?.dataset.key === key) return;
  old?.remove();
  const body = markdown(b.text, view.ticket.id);
  const el = h('div', { class: `msg user held-brief ${senderTone(b.from)}`.trim(), 'data-key': key },
    h('div', { class: 'who' }, h('span', { class: 'name' }, b.from), h('span', { class: 'msg-tag' }, threadRefs(`Brief, held until #${b.leader} ${b.is ?? (b.when === 'live' ? 'is live' : 'has shipped')}`))),
    body);
  if (b.text.length > 500 || b.text.split('\n').length > 8) {
    el.classList.add('clamped');
    el.append(h('button', { type: 'button', class: 'show-all small secondary', onclick: (e) => {
      const open = el.classList.toggle('clamped');
      e.currentTarget.textContent = open ? 'Show more' : 'Show less';
    } }, 'Show more'));
  }
  // Above the messages left for it, which come after the brief.
  const first = [...log.children].find((c) => c.classList.contains('user') && c.heldData?.parked);
  const after = log.querySelector(':scope > #recap, :scope > .pending');
  if (first) first.before(el); else if (after) after.before(el); else log.append(el);
}



/** Whether the running turn is under way here: its init event has arrived (initSeen). */
function turnLive() {
  return view.ticket?.status === 'running' && initSeen();
}

/**
 * Collapse the running turn's settled milestone lines into their "N updates" rows, as a reload would show
 * them: each time a newer line arrives (#578), at its answer, or when it stops without one. Words kept
 * whole break the run, as they do on a reload.
 */
function flushFolds() {
  const folds = view.folds;
  view.folds = [];
  // No reset of view.narrationEl here: mid-turn, a line joins the row its stretch already has (#578).
  for (const { text, fate } of folds) {
    if (fate !== 'fold') view.narrationEl = null;
    else if (text.el.isConnected) settleText(text, fate); // not one replaced by its rewrite (#281)
  }
}

/**
 * The working line under the chat while a turn runs: who's working and what's queued. The step, what's
 * running and the time are in the readout in the thread bar just above, which clicking the line opens.
 */
export function renderTyping() {
  const el = view?.typingEl;
  if (!el || !view.ticket) return;
  const t = view.ticket;
  const running = t.status === 'running';
  // A turn that stopped without its answer (stopped, crashed) folds its lines all the same.
  if (!running && view.folds.length) flushFolds();
  // The server working for it with no turn (#727: a handed-off land) gets the line too, in its own words.
  const server = workingBy(t) === 'server';
  const show = running || view.sendingTo === t.id || server;
  const wasHidden = el.hidden;
  el.hidden = !show;
  if (!show) return;
  const lead = t.approvals ? 'Waiting for someone to approve or deny' : running ? workingLabel(t) : view.sendingTo === t.id ? workingLabel(t, 'thinking…') : rowState(t, usage).label;
  // Held mail counts as queued while it works (#1067): it has no card then, and its bubble may be above the loaded history.
  const queued = (t.queued ?? 0) + (running ? t.held_mail?.items?.length ?? 0 : 0);
  const key = `${lead}|${queued}`;
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.replaceChildren(
      h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
      h('span', { class: 'lead' }, lead),
      ...(queued ? [h('span', { class: 'sep' }, '·'), h('span', { class: 'queued', title: `${queued} message${queued === 1 ? '' : 's'} queued for the next turn` }, `${queued} queued`)] : []));
  }
  if (wasHidden && followChat) scrollToBottom();
}

/** The cold-wake hint (#413) shows up an hour after the last turn and counts on, without waiting for a broadcast; other payer lines are left alone. */
setInterval(() => {
  const t = view?.ticket;
  const chat = document.getElementById('ticket-head')?.closest('.chat');
  const slot = chat?.querySelector('#chat-payer');
  const form = chat?.querySelector('.composer');
  if (!t || !slot || !form || (slot.firstChild && !slot.querySelector('.cold'))) return;
  const line = payerLine(t, form.sendText);
  slot.hidden = !line;
  slot.replaceChildren(line ?? '');
}, 60_000);

/** Turns the readout's running call to "Thinking…" once nothing has run for a while (its time ticks in wait.js). */
setInterval(() => {
  const el = view?.progressEl?.querySelector('.progress-line .doing');
  if (el && el.dataset.doing && el.dataset.doing !== nowDoing(view.turnActions, Date.now())) scheduleProgress();
  // What's left of the plan's guesses runs down while a long call runs, with no event to redraw it.
  const left = view?.progressEl?.querySelector('.progress-cap .left');
  const est = left && planEstimate(view.progress, view.ticket?.status === 'running', Date.now(), view.ticket?.step_ratio);
  if (left && (!est || left.textContent !== leftText(est))) scheduleProgress();
}, 1000);


/** A push note's line (#996): one push says it as stored; mergePushNotes counts it up when more follow back to back. */
function pushLine(text) {
  return h('div', { class: 'note', 'data-push': text, 'data-count': '1' }, text);
}

/**
 * Back-to-back push notes show as one line with a count. Run after every event, once the folds have had their
 * say: the updates group, which holds the minion's working lines, doesn't break a run; a person's message or the
 * minion's reply does. The stored notes stay as they are, so a redraw gives the same result.
 */
function mergePushNotes(log) {
  for (const el of log.querySelectorAll('.note[data-push]')) {
    let prev = el.previousElementSibling;
    while (prev?.matches('.narration')) prev = prev.previousElementSibling;
    if (!prev?.matches('.note[data-push]') || prev.dataset.session !== el.dataset.session || !pushRun({ text: prev.dataset.push, count: 1 }, el.dataset.push).joined) continue;
    const run = { text: prev.dataset.push, count: Number(prev.dataset.count) + Number(el.dataset.count) };
    prev.dataset.count = String(run.count);
    prev.replaceChildren(...pushRunParts(run).map((p) => (typeof p === 'string' ? p : h('span', { class: 'push-count' }, String(p.count)))));
    el.remove();
  }
}
