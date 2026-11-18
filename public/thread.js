// A minion's chat: its head, history, readout, cards and the working line.
import { presenceHead } from './presence.js';
import { account, ago, api, baseName, clearHighlights, fileHref, formatSize, h, noAutofill, highlight, icon, isCoordinator, jumpHref, me, statusLabel, taskmasterName, threadFullName, threadLabel, threadTitleParts, uploadUrl, view } from './base.js';
import { mergedView } from './mine.js';
import { toast } from './ui/status.js';
import { cachedEvents, catchUpEvents, chatScroller, loadEvents, followChat, loadEarlier, markdown, markSeen, onTicketPin, restoreScroll, scrollToBottom, scrollToUnread, sending, setSending, USER_SCROLL, takeJump, threadRefs, usage } from './core.js';
import { alertNote, composer, composerPlaceholder, loadDraft, outbox, renderModelPicker, saveDraft } from './composer.js';
import { renderSidebar } from './sidebar.js';
import { refreshInbox } from './inbox.js';
import { composerHint, heldLine } from './heldmsg.js';
import { EMPTY_TRACK, rowState, SHIP, workingBy, workingLabel } from './threadstate.js';
import { progressTrack, waitClock, waitLate, waitNow, waitTrack } from './wait.js';
import { propertyChip } from './properties.js';
import { onboardingStrip } from './settings.js';
import { jobCard, jobMovedNote } from './jobs.js';
import { recapEvent, showRecap } from './recap.js';
import { noteStrike, struckSource } from './strike.js';
import { narrationSorter } from './narration.js';
import { gist, groupTitle, gruntName, gruntOf } from './grunts.js';
import { stepMark } from './ui/chat.js';
import { optimistic } from './ui/optimistic.js';
import { threadNumberHref } from './threadrefs.js';
import { replyChips } from './replies.js';
import { releaseChip } from './releases.js';
import { askHeader } from './askcard.js';
import { firstSentence, GITHUB_NAME, machineAuthor, senderTone, shortDuration, shortNote, ticketActionRef } from './chattext.js';
import { ultraButton, ultraCard, ultraResult } from './ultrareview.js';
import { payerLine } from './payer.js';
import { sideEvent } from './sidethread.js';
import { waitingStrip } from './waiting.js';
import { canBack, canForward, goBack, goForward } from './navstack.js';
import { actionLabel, applyEvent, createProgress, nowDoing, planEstimate, planTrack, progressLine, stepInfo, stepName, withoutCount, workPhases } from './progress.js';
import { answerRef, answerSummary, approvalCard, loopCard, messagesBelow, planCard, questionCard, settleSpend, speaker, spendCard } from './cards.js';

// Mine or Everyone (#920): how this device opens your Taskmaster in a scheme with several.
const TM_VIEW = 'cc-tm-view';
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
    const cached = cachedEvents(src);
    const page = cached?.page ?? await loadEvents(src);
    if (view !== v || v.merged.src !== src) return; // another view, or another flip, overtook this one
    v.page = page;
    renderHistory();
    scrollToBottom();
    if (cached && await cached.fresh && view === v && v.page === page) renderHistory();
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

/** Fill in a chat section just put on the page: its head, its history, and where you were in it. */
export async function mountChat(chatId, ticket, page, fresh) {
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
  // Drawn from the cache (#527): what came since is drawn in once it arrives, opening at the first unread
  // as a fresh load would, unless you've scrolled meanwhile.
  const v = view;
  if (fresh) watchYourScrolling(); // a short chat has no Load earlier to have started it
  const settled = (fresh ?? Promise.resolve(false)).then(async (added) => {
    if (!added || view !== v || view.page !== page) return;
    renderHistory();
    if (!view.scrolledByYou) await place();
  });
  try {
    if (sessionStorage.getItem('cc-refocus')) {
      sessionStorage.removeItem('cc-refocus');
      document.querySelector('.composer textarea')?.focus();
    }
  } catch {}
  // Events broadcast while the snapshot was loading arrived before `view` existed. Not awaited: the chat is
  // drawn, so the route's dim (body.navigating) clears now rather than after these round trips (#494).
  settled.then(catchUpEvents)
    .then(() => isCoordinator(ticket) && view?.id === chatId && showRecap())
    .catch(() => {}); // a missed catch-up is made good by the stream's next resync
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
  const at = [...log.children].find((el) => Number(el.dataset.at) > view.openedSeenAt);
  at?.before(h('div', { class: 'unread-divider', role: 'separator' }, h('span', {}, 'New')));
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
  return h('section', { class: 'chat' }, h('div', { class: 'ticket-head', id: 'ticket-head' }), log, view.typingEl, form);
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

/** "PR #12 · merged" (linked), or for work merged without a PR, the branch and whether main has it. */
export function renderBranch(status) {
  const el = view.branchEl;
  const parts = [];
  if (status?.pr) {
    const { pr } = status;
    const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.draft ? 'draft' : 'open';
    parts.push(
      // data-github: this chip is the way to the PR on GitHub, so pointPrLink leaves it be (as the merge card's).
      h('a', { href: pr.url, target: '_blank', rel: 'noopener', title: pr.title, 'data-github': '', onclick: (e) => e.stopPropagation() }, `PR #${pr.number}`),
      h('span', { class: `state ${state}` }, state));
    if (pr.state === 'OPEN' && status.merged) parts.push(h('span', { title: `Merged into ${status.base}` }, '✓ in main'));
  } else if (status && !status.empty) {
    parts.push(h('span', { class: 'branch', title: status.branch }, status.branch));
    parts.push(status.merged
      ? h('span', { class: 'state merged', title: `Merged into ${status.base}` }, 'merged')
      : h('span', { class: 'state open', title: `${status.ahead} commit${status.ahead === 1 ? '' : 's'} not in ${status.base}` }, `${status.ahead} unmerged`));
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

export function renderTicketHead() {
  renderModelPicker();
  const el = document.getElementById('ticket-head');
  if (!el) return;
  const t = view.ticket;
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
  for (const bubble of chat?.querySelectorAll('.log [data-event]') ?? []) {
    markQueued(bubble, t);
    if (bubble.heldData) markHeld(bubble, t);
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
  // Waiting on the usage limit, Stop ends the wait (src/runner.ts, stop).
  if (t.status === 'running' || t.limit_resume_at) {
    actions.push(h('button', { class: 'secondary act-stop', title: t.limit_resume_at ? 'Don\'t resume after the usage limit resets' : undefined, onclick: () => api(`api/tickets/${t.id}/stop`, { method: 'POST', body: {} }).catch((e) => alertNote(e.message)) }, 'Stop'));
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
  const stateLabel = h('span', { class: 'muted head-state', title: state }, h('span', { class: 'state-text' }, state),
    working ? h('span', { class: 'state-dots', 'aria-hidden': 'true' }, h('i', {}, '.'), h('i', {}, '.'), h('i', {}, '.')) : '');
  stateFit?.disconnect();
  if (working) stateFit?.observe(stateLabel);
  const phone = narrow.matches;
  // Leaves the thread as it is and goes back to the project's coordinator.
  const close = coord ? '' : h('a', { class: 'close-view', href: `#/p/${t.project_id}`, title: 'Back to the Taskmaster', 'aria-label': 'Back to the Taskmaster' }, icon('close'));
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
  const more = h('button', { type: 'button', class: 'nav-btn head-more', title: 'More', 'aria-label': 'More', 'aria-expanded': String(menuOpen), onclick: () => {
    menuFor = menuOpen ? null : t.id;
    renderTicketHead();
  } }, '⋯');
  // ‹ › × sit right of Find (Josh, 2026-11-13); on phones × stays on the title's line.
  const sub = h('div', { class: 'head-sub', hidden: phone && !menuOpen }, phone ? '' : stateLabel, shipLine(t), coord ? '' : personNoteButton(t), coord ? '' : pinButton(t), coord ? '' : propertyChip(t),
    h('span', { class: 'spacer' }), ...actions.filter((a) => a !== main), view.findEl ?? '', nav);
  el.replaceChildren(
    h('div', { class: phone ? 'row head-top' : 'row' },
      h('span', { class: `dot ${working ? 'running' : t.status}` }),
      h('h2', { title: threadFullName(t) }, threadTitleParts(t)),
      presenceHead(t),
      coord && view.merged ? tmViewSwitch() : '',
      phone ? h('span', { class: 'spacer' }) : '',
      phone ? more : '',
      phone ? close : ''),
    coord ? (view.project ? onboardingStrip(view.project) : '') : personNoteLine(t),
    coord && view.merged?.mode === 'mine' ? tmBanner() : '',
    phone ? h('div', { class: 'head-line' }, stateLabel, view.progressEl, main ?? '') : '',
    sub,
    phone ? '' : view.progressEl);
  if (had?.isConnected && document.activeElement !== had) had.focus({ preventScroll: true });
  renderTyping();
  syncHeldBrief();
  // While a turn runs, Send steers it (composer.js); said on hover rather than in a line of its own.
  const send = document.querySelector('.composer button[type=submit]');
  if (send) send.title = t.status === 'running' ? 'Claude reads it between steps of the running turn; ▾ sends it after this turn' : '';
  scheduleProgress();
}

/** The chat whose ⋯ menu is open on a phone: the head redraws often, so it is kept here. */
let menuFor = null;

/** A chat's state in words, as its head shows it. */
function headState(t) {
  return (isCoordinator(t) && !workingBy(t) ? statusLabel(t) : rowState(t, usage).label) + (t.queued ? ` · ${t.queued} queued` : '');
}

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
const narrow = matchMedia('(max-width: 800px)');
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
  return h('button', { type: 'button', class: 'note-btn', title: 'Add a note only people see', 'aria-label': 'Add a note', onclick: () => editPersonNote(t) },
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
  return h('button', { type: 'button', class: `note-btn pin-btn${pinned ? ' on' : ''}`, title: pinned ? 'Unpin from the top of your list' : 'Pin to the top of your list (only you see your pins)', 'aria-label': pinned ? 'Unpin' : 'Pin', 'aria-pressed': String(!!pinned), onclick: toggle },
    icon('pin'), h('span', { class: 'wide-only' }, pinned ? 'Pinned' : 'Pin'));
}

/** Where the minion's change is, branch to live, in a word or two; the full line and why it is stuck are on hover (src/branch.ts). */
function shipLine(t) {
  const stage = !isCoordinator(t) && SHIP[t.ship?.stage];
  if (!stage) return '';
  return h('span', { class: `ship f-${stage.fam}`, title: `${t.ship.detail ?? t.ship.text} · ${t.ship.commit}` },
    h('i', { class: 'ship-dot' }), h('span', { class: 'text' }, stage.badge || 'on branch'));
}

/**
 * A message held for a minion says so in its bubble, in place: "Not sent yet" with a dashed look (and, for a parked
 * minion, Unpark and send) while the ticket still lists it as held, then a plain "Read" line once a turn took it.
 * The line is one fixed row either way, so nothing moves when it flips.
 */
function markHeld(bubble, ticket) {
  const line = heldLine(bubble.heldData, Number(bubble.dataset.event), ticket);
  if (!line) return;
  bubble.classList.add('held-msg');
  bubble.classList.toggle('held-waiting', line.waiting);
  let el = bubble.querySelector(':scope > .held-line');
  if (!el) bubble.append(el = h('div', { class: 'held-line', role: 'status' }));
  el.replaceChildren(
    h('span', { class: 'held-icon', 'aria-hidden': 'true' }, line.waiting ? '⏸' : '✓'),
    h('span', { class: 'held-text' }, line.text),
    ...(line.unpark ? [h('button', { type: 'button', class: 'secondary small', onclick: () => unpark(ticket) }, 'Unpark and send')] : []));
}

/** Unpark (#718): the row and header drop parked at once; a refusal puts them back with a toast and a retry. */
function unpark(t) {
  const was = { state: t.state, parked_for: t.parked_for, held_brief: t.held_brief };
  const show = (v) => {
    for (const x of new Set([t, view?.tickets?.get(t.id)])) if (x) Object.assign(x, v);
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
    for (const x of new Set([t, view?.tickets?.get(t.id)])) if (x) x.status = s;
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

// ---------- work progress (thread-bar readout) ----------

const STEP_ICON = { completed: '✓', in_progress: '◐', pending: '○' };

function resultString(result) {
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
}

/**
 * One tool call as a plain sentence ("Edited runner.ts", "Run the tests — failed: …"). The raw
 * command and output sit one click deeper and are only built when opened.
 */
function actionEl(action) {
  const { block, result } = action;
  const state = !result ? 'pending' : result.is_error ? 'err' : 'ok';
  const why = state === 'err' ? resultString(result).replace(/<\/?tool_use_error>/g, '').trim().split('\n')[0].slice(0, 120) : '';
  const el = h('details', { class: `act ${state}` },
    h('summary', {},
      stepMark({ pending: 'running', err: 'failed', ok: 'done' }[state]),
      h('span', { class: 'what' }, threadRefs(actionLabel(block))),
      why ? h('span', { class: 'why' }, ` — failed: ${why}`) : '',
      ticketActionRef(action) ? [' → ', ...threadRefs(`#${ticketActionRef(action).number}`)] : ''));
  el.addEventListener('toggle', () => {
    if (!el.open || el.querySelector('.body')) return;
    const input = block.input || {};
    const body = h('div', { class: 'body' },
      h('pre', {}, block.name === 'Bash' && input.command ? `$ ${input.command}` : JSON.stringify(input, null, 2)));
    if (action.result) body.append(h('pre', { class: action.result.is_error ? 'err' : '' }, threadRefs(resultString(action.result) || '(no output)')));
    el.append(body);
  });
  return el;
}

/** "Created #15 · Messaged #12": links to the threads some work created or messaged, or null. */
function ticketActionLinks(acts) {
  const refs = acts.map(ticketActionRef).filter(Boolean);
  if (!refs.length) return null;
  return h('li', { class: 'thread-refs' }, h('span', { class: 'st' }, '→'),
    refs.flatMap((r, i) => [i ? ' · ' : '', `${r.verb} `, ...threadRefs(`#${r.number}`)]));
}

/** Claude's own words from while a step was underway, shortened to a couple of lines. */
function stepNote(text) {
  const short = text.length > 280 ? `${text.slice(0, 279).replace(/\s+\S*$/, '')}…` : text;
  return h('p', { class: 'step-note' }, short.replace(/[*`#]/g, ''));
}

function actionList(actions) {
  return h('div', { class: 'actions' }, actions.map(actionEl));
}

/** Which parts of a ticket's readout are expanded; kept per ticket so re-renders and reconnects don't collapse it. */
const progressUiState = new Map();
function progressUi(ticketId) {
  if (!progressUiState.has(ticketId)) progressUiState.set(ticketId, { open: false, openSteps: new Set() });
  return progressUiState.get(ticketId);
}

/** The phases of some work as rows ("✓ Looked through the code · 4 actions"), plus its commands behind a toggle. */
function phaseRows(acts, running) {
  const phases = workPhases(acts, running);
  const cmds = h('details', { class: 'cmds' }, h('summary', {}, `Show the ${acts.length} individual action${acts.length === 1 ? '' : 's'}`));
  cmds.addEventListener('toggle', () => {
    if (cmds.open && !cmds.querySelector('.actions')) cmds.append(actionList(acts));
  });
  return [
    h('ul', { class: 'phases' }, phases.map((ph) => h('li', { class: ph.ongoing ? 'ongoing' : '' },
      stepMark(ph.ongoing ? 'running' : 'done'), ph.text,
      h('span', { class: 'muted' }, ` · ${ph.count} action${ph.count === 1 ? '' : 's'}${ph.failed ? `, ${ph.failed} failed along the way` : ''}`))),
      ticketActionLinks(acts)),
    cmds,
  ];
}

/** One step of Claude's plan: its title, one plain line about it, and on opening, how the work went. */
function planStep(t, acts, running) {
  const now = t.status === 'in_progress';
  const live = now && running;
  const phases = workPhases(acts, live);
  // The one line: what it achieved once done, where it's at while underway, what it's for before then.
  let line;
  if (t.status === 'completed') line = t.outcome || (t.note && firstSentence(t.note)) || t.description || phases.map((ph) => ph.text).join(', ');
  else if (now) line = live ? (phases.length ? `Now: ${phases[phases.length - 1].text.toLowerCase()}` : 'Just started') : 'Paused here when the turn ended';
  else line = t.description || 'Not started yet';
  const el = h('details', { class: `step ${t.status}${now && !running ? ' paused' : ''}`, open: view.ui.openSteps.has(t.id) || null },
    h('summary', {},
      h('span', { class: 'icon' }, STEP_ICON[t.status] ?? '○'),
      h('span', { class: 'subject' }, t.subject),
      h('span', { class: 'recap' }, firstSentence(line, 220))),
    t.description && line !== t.description ? h('p', { class: 'step-desc' }, h('span', { class: 'muted' }, 'Plan: '), t.description) : '',
    t.note && !t.outcome ? stepNote(t.note) : '',
    acts.length ? phaseRows(acts, live) : '');
  el.addEventListener('toggle', () => (el.open ? view.ui.openSteps.add(t.id) : view.ui.openSteps.delete(t.id)));
  return el;
}

/** Work done outside any plan step, told as phases. */
function looseWork(acts, running, onlyWork) {
  const phases = workPhases(acts, running);
  const el = h('details', { class: 'step loose', open: (view.ui.looseOpen ?? onlyWork) || null },
    h('summary', {}, h('span', { class: 'icon' }, '⋯'),
      h('span', { class: 'subject' }, !onlyWork ? 'Other work this turn' : running ? 'Work so far' : 'Work last turn'),
      h('span', { class: 'recap' }, phases.map((ph) => ph.text).join(' → '))),
    view.turnNote ? stepNote(view.turnNote) : '',
    phaseRows(acts, running));
  el.addEventListener('toggle', () => (view.ui.looseOpen = el.open));
  return el;
}

let progressFrame = 0;
function scheduleProgress() {
  if (!progressFrame) progressFrame = requestAnimationFrame(() => { progressFrame = 0; renderProgress(); });
}

function renderProgress() {
  if (view?.kind !== 'project' || !view.ticket) return;
  const p = view.progress;
  const progressEl = view.progressEl;
  // A new minion not parked on start_after reads as working while its first turn sets up, as its list row does (#696);
  // a Taskmaster that hasn't run yet is only waiting for a message.
  const running = view.ticket.status === 'running' || (view.ticket.status === 'new' && !view.ticket.parked_for && !isCoordinator(view.ticket));
  const line = progressLine(p, running);
  // One line (#551, Josh's pick): the step › what's happening now · steps done · time. While it waits on
  // something (#544: the land line, a heavy slot, the restart), the wait takes the "now" part and its time,
  // and its bar replaces the meter. A wait shows after the turn has ended too (outside, pending-deploy).
  const w = view.ticket.status !== 'closed' && view.ticket.wait;
  if (!line && !w) {
    progressEl.replaceChildren();
    progressEl.hidden = true;
    return;
  }
  const live = running && initSeen();
  const { total, done, current } = stepInfo(p, running);
  const planned = total && (current || done < total);
  const stripped = withoutCount(line);
  // Phones show this line in place of the state (#492), so an idle chat's line leads with it.
  // The server working for it (#727) leads the line in place of the finished plan's step: "Server" and its land stage.
  const server = !running && workingBy(view.ticket) === 'server';
  const step = server || !line ? '' : live ? stepName(p, running) : narrow.matches && !running ? `${headState(view.ticket)} · ${stripped}` : stripped;
  const doing = !w && live ? nowDoing(view.turnActions, Date.now()) : '';
  const now = w ? waitNow(w) : doing;
  // The step count sits in its own chip, so a phone's cut-off text never hides it; the turn's action
  // count shows only when no plan is underway.
  const count = stripped !== line ? `${done}/${total}` : !planned && live && p.turnActions ? `${p.turnActions} action${p.turnActions === 1 ? '' : 's'}` : '';
  // The minion's own guesses for its steps (#551, Josh's pick). Only while no wait has a real estimate of its own.
  const est = !w && live ? planEstimate(p, running, Date.now(), view.ticket.step_ratio) : null;
  // The turn's clock is neither the step's time nor the plan's, so it gives way to the captions under the bar (#630).
  const time = w ? waitClock(w, 'time wait-time of-wait') : running && !est && view.ticket.turnStartedAt ? waitClock({ since: view.ticket.turnStartedAt }, 'time wait-time') : '';
  const left = est && h('span', { class: 'left', title: view.ticket.step_ratio && view.ticket.step_ratio !== 1 ? `The minion's guesses for the steps left, times ${view.ticket.step_ratio.toFixed(2)}: what steps have really taken against their guesses` : "The minion's own guess for the steps left" }, leftText(est));

  const bar = h('button', { class: 'progress-line', 'aria-expanded': String(view.ui.open), onclick: () => {
    view.ui.open = !view.ui.open;
    renderProgress();
  } },
    // No dot of its own: the title's dot just above says the same (Josh, 2026-11-13: "we've duplicated the dots").
    h('span', { class: 'text' },
      server ? h('span', { class: 'stepname' }, h('b', { class: 'f-work' }, 'Server'), w ? '' : ' · landing…') : step ? h('span', { class: 'stepname' }, step) : '',
      (step || server) && now ? h('span', { class: 'arrow', 'aria-hidden': 'true' }, ' › ') : '',
      now ? h('span', { class: 'doing', 'data-doing': doing }, now) : ''),
    count ? h('span', { class: 'count', title: count.includes('/') ? `${done} of ${total} steps done` : '' }, count) : '',
    time,
    h('span', { class: 'chev' }, view.ui.open ? '▴' : '▾'));
  // With no plan the meter keeps its room, hidden, so a plan arriving doesn't push the chat (rule 13); while it works, an
  // empty track shows the line before the plan exists (#696).
  // The plan as a track of its steps (#630), the one underway filling against its guess or by the wait; with no step
  // underway, a landing's stages or the wait's bar; after the turn, a wait drops the plan (as the list row's rowBar does).
  const meter = progressTrack({ track: total && (running || !w) ? planTrack(p) : running && !w ? EMPTY_TRACK : null, since: est?.since, usual: est?.usual, wait: w || null }, 'big') || h('progress', { class: 'meter blank', max: 1, value: 0 });
  // Which time is which (#630, Cara's pick "1"): the step's against its guess under the bar's left, the whole plan's at its end.
  const stepClock = est && waitClock({ since: est.since, usual: est.usual }, `wait-time${waitLate(est) ? ' late' : ''}`);
  const caption = est ? h('div', { class: 'progress-cap' },
    h('span', { class: 'cap-step' }, 'This step: ', stepClock),
    h('span', { class: 'cap-plan' }, h('b', {}, h('span', { class: 'wide' }, 'Whole plan:'), h('span', { class: 'narrow' }, 'Plan')), ' ',
      h('span', { class: 'wide' }, waitClock({ since: est.planSince }), ' in · '), left))
    // Until a step with a guess is underway, its caption's line is held empty, so the head doesn't grow when it starts (#696).
    : running && !w ? h('div', { class: 'progress-cap blank', 'aria-hidden': 'true' }, h('span', { class: 'cap-step' }, '\u00a0')) : '';

  const prevDetail = progressEl.querySelector('.progress-detail');
  const scrollTop = prevDetail?.scrollTop ?? 0;
  let detail = '';
  if (view.ui.open) {
    const all = [...view.actions.values()];
    const groups = { completed: [], in_progress: [], pending: [] };
    for (const t of p.tasks) (groups[t.status] ?? groups.pending).push(t);
    // A step an earlier turn left underway reads as paused until this turn moves the plan.
    const stepEl = (t) => planStep(t, all.filter((a) => a.taskId === t.id), running && !!current);
    const section = (title, tasks) => (tasks.length ? h('section', { class: 'plan-group' }, h('h4', {}, title), tasks.map(stepEl)) : '');
    const loose = view.turnActions.filter((a) => a.taskId == null || !p.tasks.some((t) => t.id === a.taskId));
    const req = view.turnRequest;
    detail = h('div', { class: 'progress-detail' },
      // The wait in full, its words uncut, with a landing's whole track above it.
      w ? h('div', { class: 'wait-line' }, waitTrack(w), h('p', { class: 'wait-full' }, waitNow(w, true), ' · ', waitClock(w))) : '',
      req?.length ? h('p', { class: 'request' }, h('span', { class: 'muted' }, running ? 'Working on ' : 'Last worked on '),
        req.flatMap((m, n) => [n ? ' and ' : '', `${m.author}'s request: `, h('q', {}, firstSentence(m.text, 160))])) : '',
      section('Done', groups.completed),
      section(running && current ? 'Now' : 'Stopped at', groups.in_progress),
      section('Up next', groups.pending),
      loose.length ? looseWork(loose, running, !p.tasks.length) : '',
      !p.tasks.length && !loose.length ? h('p', { class: 'muted empty' }, 'Nothing has run yet.') : '');
  }
  progressEl.replaceChildren(bar, meter, caption, detail);
  if (detail) detail.scrollTop = scrollTop;
  progressEl.hidden = false;
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
  if (scroll && followChat) scrollToBottom();
  if (scroll) renderCardJump();
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
    const action = { block, taskId, result: null };
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
      // Marked not sent when its reply was lost, yet it went: nothing left to send, and a Retry now does nothing.
      if (m?.state === 'failed') {
        m.state = 'sent';
        setSending(sending - 1);
      }
    }
    // An answer to a question card or a plan's go shows in the card itself; the chat only gets a
    // line pointing back up when messages below have pushed the card out of the way.
    const card = view.cards.get(data.answer?.questionId ?? (data.plan?.verdict === 'approve' ? data.plan.planId : null));
    // A secret card's answer (#838) carries only the name it was saved as; its question_result shuts the card.
    if (data.answer?.answers) card?.markAnswered(data.answer.answers, data.author);
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
        { id: event.id, strikes: data.strikes, brief: data.brief, schedule: data.schedule, ask: data.ask },
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
      nodes.push(bubble);
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
    else if (short != null && data.detail) nodes.push(h('details', { class: 'note detail' }, h('summary', {}, threadRefs(short)), h('pre', {}, data.detail)));
    else if (short != null) nodes.push(h('div', { class: 'note', title: short === data.text ? null : data.text }, threadRefs(short)));
  } else if (event.kind === 'fresh') {
    // A Taskmaster's or a minion's fresh Claude session (#406, #937), with the handoff it starts from behind the toggle.
    nodes.push(h('details', { class: 'note detail fresh', title: data.why ? `Why: ${data.why}` : null }, h('summary', {}, 'Fresh session started; summary'), markdown(data.summary, event.ticket_id)));
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
          const msg = stamped(h('div', { class: 'msg reply' }, h('div', { class: 'who' }, speaker()), body), event);
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
        if (action) Object.assign(action, { result: { content: block.content, is_error: block.is_error }, doneAt: event.created_at });
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
  renderTyping();
  if (scroll && followChat) scrollToBottom();
  if (scroll) renderCardJump();
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
    h('div', { class: 'who' }, h('span', { class: 'name' }, b.from), h('span', { class: 'msg-tag' }, threadRefs(`Brief, held until #${b.leader} is ${b.when === 'live' ? 'live' : 'merged'}`))),
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

/** Show a long message's first lines, with a button for the rest. */
function clamp(msg) {
  msg.classList.add('clamped');
  msg.append(h('button', { type: 'button', class: 'show-all small secondary', onclick: () => unclamp(msg) }, 'Show all'));
}

function unclamp(msg) {
  msg.classList.remove('clamped');
  msg.querySelector(':scope > .show-all')?.remove();
}

/** A message's rendered text, keeping its source so a strike_text that lands later can redraw it. */
function messageBody(text, strikes, ticketId, eventId) {
  const body = markdown(struckSource(text, strikes), ticketId);
  body.dataset.body = eventId;
  Object.assign(body, { source: text, ticketId, strikes });
  return body;
}

/** An object URL for base64 image data (the page's CSP allows blob: images but not data: ones). */
export function base64Url(mediaType, data) {
  return URL.createObjectURL(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mediaType }));
}

/** A sent image fetched back as { mediaType, data }, the way the composer holds one. */
async function imageData(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Could not load its image (HTTP ${res.status})`);
  const blob = await res.blob();
  const data = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  return { mediaType: blob.type, data };
}

/**
 * A strike_text note, or null: "Struck through in #116: ~~the wrong words~~ → the reason", linking the
 * chat that shows the message when that's another one.
 */
function strikeNote(data) {
  const s = noteStrike(data);
  if (!s) return null;
  const c = s.chat;
  const where = c === null ? ' above' : c ? [' in ', h('a', { class: 'thread-ref', href: c.number == null ? `#/p/${c.project}` : threadNumberHref(c.project, c.number) },
    c.number == null ? `the ${taskmasterName(c.project)}'s chat` : `#${c.number}`)] : '';
  return h('div', { class: 'note strike-note' }, `✎ Struck through`, where, ': ', h('del', {}, s.quote), ' → ', threadRefs(s.reason));
}

/** A chat message from a person; `about`, for a comment on a file, links that file. */
/**
 * A message still queued for the next turn says so, with a ✕ to take it back and, on your own, a ✎ to
 * take it back into the message box to fix and resend; it loses them once sent.
 */
function markQueued(bubble, ticket) {
  if (bubble.classList.contains('withdrawn')) return; // taken back, or being taken back from this tab
  const id = Number(bubble.dataset.event);
  const queued = !!ticket?.queued_ids?.includes(id);
  const tag = bubble.querySelector('.queued-tag');
  if (!queued) return tag?.remove();
  if (tag) return;
  // Both show at once and send behind; a refusal (the turn took it meanwhile) puts the bubble back as it is now.
  const takeBack = (label, apply, send, undo = () => {}) => optimistic({
    key: `unqueue:${id}`,
    apply: () => {
      showTakenBack(bubble, me);
      apply();
    },
    send,
    undo: () => {
      if (!bubble.querySelector('.taken-back-tag.mine')) return; // the server's own "taken back" came meanwhile
      bubble.classList.remove('withdrawn');
      bubble.querySelector('.taken-back-tag')?.remove();
      markQueued(bubble, view?.id === ticket.id ? view.ticket : ticket);
      undo();
    },
    label,
  });
  const unqueue = () => api(`api/tickets/${ticket.id}/unqueue`, { method: 'POST', body: { id } });
  const sent = bubble.sent;
  let takeOut;
  const edit = sent && h('button', { type: 'button', class: 'take-back', title: 'Take back to edit', 'aria-label': 'Take back to edit',
    onclick: (e) => {
      e.preventDefault();
      takeBack('take back the message to edit', () => {
        const form = view?.id === ticket.id && document.querySelector('.composer');
        // Its files go in now; its images once they have loaded, below.
        if (form) takeOut = form.editBack(sent.text, sent.files.map((upload) => ({ upload })));
        else {
          // A Retry from another chat: the text waits in this chat's draft (attachments stay in the struck bubble).
          const draft = loadDraft(`cc-draft:${ticket.id}`)?.trim();
          saveDraft(`cc-draft:${ticket.id}`, draft ? `${sent.text}\n${draft}` : sent.text);
          takeOut = null;
        }
      }, async () => {
        // Images first: if one won't load, the message stays queued rather than coming back without it.
        const images = await Promise.all(sent.images.map((name) => imageData(`api/tickets/${ticket.id}/images/${encodeURIComponent(name)}`)));
        await unqueue();
        if (takeOut && view?.id === ticket.id) document.querySelector('.composer')?.attach(images);
      }, () => takeOut?.());
    } }, '✎');
  bubble.querySelector('.who').append(h('span', { class: 'msg-tag queued-tag' }, 'queued for the next turn', edit ?? '',
    h('button', { type: 'button', class: 'take-back', title: 'Take back this message', 'aria-label': 'Take back this message',
      onclick: (e) => {
        e.preventDefault(); // a Taskmaster message's ✕ sits in its <summary>
        takeBack('take back the message', () => {}, unqueue);
      } }, '✕')));
}

/** A message struck through as taken back, by the server's word or (class mine) this tab's click while it sends. */
function showTakenBack(bubble, by, mine = true) {
  bubble.querySelector('.queued-tag')?.remove();
  bubble.querySelector('.taken-back-tag')?.remove();
  bubble.classList.add('withdrawn');
  bubble.querySelector('.who').append(h('span', { class: `msg-tag taken-back-tag${mine ? ' mine' : ''}` }, `taken back by ${by}`));
}

export function userBubble(author, text, imageSrcs, about = null, event = null, files = []) {
  const github = author === GITHUB_NAME;
  const msg = h('div', { class: github ? 'msg user github' : 'msg user' }, h('div', { class: 'who' }, author,
    about ? [' on ', h('a', { class: 'about', href: fileHref(about.ticketId, about.path), title: about.path }, about.name)] : ''));
  // GitHub's messages end lines with bare URLs, which Markdown alone would leave as text.
  if (github && text) text = text.replace(/(^|\s)(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]])/g, '$1[$2]($2)');
  if (text) msg.append(event ? messageBody(text, event.strikes, null, event.id) : markdown(text));
  if (imageSrcs.length) {
    msg.append(h('div', { class: 'images' }, imageSrcs.map((src) =>
      h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { src, alt: 'Attached image', loading: 'lazy' })))));
  }
  if (files.length) msg.append(h('div', { class: 'files' }, files.map(fileChip)));
  // A contraption's ask: its header and summary, the full text behind the toggle (askcard.js).
  if (event?.ask) {
    msg.querySelector('.who').remove();
    return h('details', { class: 'msg user ask' },
      h('summary', {}, h('div', { class: 'who' }, askHeader(event.ask)), h('div', { class: 'ask-summary' }, event.ask.summary)), msg);
  }
  // Messages between Claudes and from the app aren't meant for people, so they start collapsed to one line,
  // except the brief that started the minion: it says what the minion is for.
  const who = machineAuthor(author);
  // Sent by another agent: it takes its sender's colour (#693), a Taskmaster's (this scheme's or another's) or a minion's.
  const tone = senderTone(author) ? ` ${senderTone(author)}` : '';
  // A schedule's brief starts collapsed (Cara, 2026-11-16: "scheduled briefs can start collapsed"), its row naming the schedule; the rest keep the brief open.
  if (who && event?.brief && !event.schedule) {
    msg.querySelector('.who').textContent = who;
    msg.className += tone;
  } else if (who) {
    msg.querySelector('.who').remove();
    return h('details', { class: `msg user coord${tone}` }, h('summary', {}, h('span', { class: 'who' }, h('span', { class: 'name' }, event?.schedule ? `${who}: ${event.schedule}` : who)), h('span', { class: 'preview' }, previewNodes(text, event?.strikes))), msg);
  }
  return msg;
}

/** A collapsed message's one line: its text without Markdown marks, struck words keeping their line. */
function previewNodes(text, strikes) {
  // A heading's # marks go, but not a #575 reference's.
  const flat = (t) => t.replace(/(^|\s)#{1,6}(?=\s)/g, '$1').replace(/[*_`>\[\]~]/g, '').replace(/\s+/g, ' ');
  // A URL in the one-line preview is still a link (Citadel-wide: links are clickable); it opens without toggling the message.
  // URLs are found before the marks go, so a link with _ or # in it keeps them.
  const links = (t) => t.split(/(https?:\/\/[^\s()<>\[\]`]+[^\s()<>\[\]`.,;:!?'"*_~])/).map((bit, i) => (i % 2
    ? h('a', { href: bit, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, bit) : flat(bit)));
  return struckSource((text ?? '').trim(), strikes).split(/~~(.+?)~~/).flatMap((part, i) => (i % 2 ? h('del', {}, flat(part)) : links(part)));
}

/** An attached file in a message: images and PDFs open in a tab (the server says so), anything else downloads. */
export function fileChip({ name, size, href }) {
  const opens = /\.(png|jpe?g|gif|webp|avif|pdf)$/i.test(name); // the same list as INLINE in src/uploads.ts
  return h('a', { class: 'file-chip', href, title: opens ? `Open ${name}` : `Download ${name}`, ...(opens ? { target: '_blank', rel: 'noopener' } : { download: name }) },
    h('span', { class: 'icon', 'aria-hidden': 'true' }, '📄'), h('span', { class: 'name' }, name), h('span', { class: 'size' }, formatSize(size)));
}

/** Whether the running turn's init event has arrived: until then the per-turn state is still the last turn's. */
function initSeen() {
  return view.turnInitAt >= view.ticket.turnStartedAt;
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
  const key = `${lead}|${t.queued ?? 0}`;
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.replaceChildren(
      h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
      h('span', { class: 'lead' }, lead),
      ...(t.queued ? [h('span', { class: 'sep' }, '·'), h('span', { class: 'queued', title: `${t.queued} message${t.queued === 1 ? '' : 's'} queued for the next turn` }, `${t.queued} queued`)] : []));
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

/** "~26 min left" of the plan's guesses, "~1h 5m left", or past them. */
function leftText(est) {
  return est.left ? `~${est.left >= 60 ? `${Math.floor(est.left / 60)}h ${est.left % 60}m` : `${est.left} min`} left` : 'past its guess';
}
