// A minion's chat: its head, history, readout, cards and the working line.
import { ago, api, baseName, catchUpEvents, chatScroller, clearHighlights, fileHref, fileKind, fileUrl, followChat, formatSize, h, highlight, icon, isCoordinator, loadEarlier, markdown, markSeen, me, onTicketPin, restoreScroll, scrollToBottom, scrollToUnread, USER_SCROLL, statusLabel, takeJump, taskmasterLabel, taskmasterName, threadFullName, threadRefs, threadTitleParts, uploadUrl, view } from './core.js';
import { alertNote, composer, composerPlaceholder, loadDraft, renderModelPicker, saveDraft } from './composer.js';
import { rowState, SHIP } from './sidebar.js';
import { propertyChip } from './properties.js';
import { onboardingStrip } from './settings.js';
import { recapEvent, showRecap } from './recap.js';
import { noteStrike, struckSource } from './strike.js';
import { narrationSorter } from './narration.js';
import { gist, groupTitle, gruntName, gruntOf } from './grunts.js';
import { threadNumberHref } from './threadrefs.js';
import { replyChips } from './replies.js';
import { payerChip, payerLine } from './payer.js';
import { canBack, canForward, goBack, goForward } from './navstack.js';
import { actionLabel, applyEvent, createProgress, progressLine, stepInfo, workPhases } from './progress.js';

/** Per-thread state for the chat in the main panel; empty when the main panel shows something else. */
export function chatView(chatId, ticket) {
  return {
    id: chatId, ticket, lastEventId: 0,
    progress: createProgress(),
    progressEl: h('div', { class: 'progress', hidden: true }), // lives in the thread bar
    findEl: chatId ? chatFindBox() : null, // lives in the thread bar too, so it survives re-renders
    ui: progressUi(chatId),
    actions: new Map(), // tool_use_id -> { block, taskId, result }
    turnActions: [], // actions of the current (or last) turn, in order
    typingEl: h('div', { class: 'typing', hidden: true, 'aria-live': 'polite', role: 'button', tabindex: '0' }), // below the chat log
    sendingTo: null, // ticket id while a message is on its way, before the server confirms the turn
    pendingMessages: [], // { el, text } shown on send, replaced by the server's copy
    cards: new Map(), // question card id -> { el, markAnswered }; plan card id -> { el, settle }; approval card id -> { settle }
    heldCards: [], // this turn's question and plan cards, kept below the words that explain them
    branchEl: h('span', { class: 'branch-status', hidden: true }), // PR / branch state, on the newest turn-end line
  };
}

/** Fill in a chat section just put on the page: its head, its history, and where you were in it. */
export async function mountChat(chatId, ticket, page) {
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
  const jumped = jump && await jumpToEvent(jump);
  if (view.id !== chatId) return; // you moved on while it loaded back
  if (!jumped) {
    const divider = document.querySelector('#log > .unread-divider');
    if (!divider) restoreScroll(chatId);
    // A Taskmaster's history runs long; past that much unread, its newest matters more than where you left off.
    else if (isCoordinator(ticket) && divider.parentElement.querySelectorAll(':scope > .unread-divider ~ [data-at]').length > TASKMASTER_UNREAD_LIMIT) scrollToBottom();
    else scrollToUnread(divider);
  }
  try {
    if (sessionStorage.getItem('cc-refocus')) {
      sessionStorage.removeItem('cc-refocus');
      document.querySelector('.composer textarea')?.focus();
    }
  } catch {}
  // Events broadcast while the snapshot was loading arrived before `view` existed.
  await catchUpEvents();
  if (isCoordinator(ticket)) await showRecap();
}

/**
 * Draw the log from the loaded history (view.page), from scratch: earlier pages go above, and a card
 * answered or a message struck by a later event has to see that event after its own. Messages still
 * on their way and the recap stay where they are.
 */
function renderHistory() {
  const log = document.getElementById('log');
  const page = view.page;
  // Held aside while replaying, so an older message of yours can't be taken for one still on its way.
  const pending = view.pendingMessages;
  const keep = [...pending.map((m) => m.el), document.getElementById('recap')].filter(Boolean);
  Object.assign(view, {
    lastEventId: 0, progress: { ...createProgress(), tasks: structuredClone(page.tasks) },
    actions: new Map(), turnActions: [], cards: new Map(), heldCards: [], gruntStarts: new Map(),
    // The session started on an earlier page, if there is one.
    sawInit: page.more, latestReply: null, turnNote: null, turnInitAt: undefined, narration: narrationSorter(), narrationEl: null, pendingRequest: [], turnRequest: undefined,
    pendingMessages: [],
  });
  log.replaceChildren(...(page.more ? [h('div', { class: 'load-earlier' },
    h('button', { type: 'button', class: 'small secondary', onclick: (e) => showEarlier(e.currentTarget) }, 'Load earlier'))] : []));
  if (isCoordinator(view.ticket) && !page.events.length) {
    log.append(h('div', { class: 'note' },
      'This is the Taskmaster for this scheme. It keeps track of the minions on the left and can create, message, rename and dismiss them for you.'));
  }
  for (const ev of page.events) appendEvent(ev, false);
  view.pendingMessages = pending;
  const at = [...log.children].find((el) => Number(el.dataset.at) > view.openedSeenAt);
  at?.before(h('div', { class: 'unread-divider', role: 'separator' }, h('span', {}, 'New')));
  log.append(...keep);
  renderProgress();
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
 * folded away with nothing to show.
 */
export async function jumpToEvent(target) {
  const id = target === 'latest' ? view.latestReply : Number(target);
  if (!id) return false;
  const find = () => document.querySelector(`#log [data-eid="${id}"]`);
  if (!find() && view.page?.more && id < view.page.events[0].id) await showEarlier(null, id);
  const found = find();
  if (!found) return false;
  // A reply folded into the turn's narration or a Taskmaster update shows as that fold.
  const el = found.parentElement.closest('#log details:not([open])') ?? found;
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
  if (button) button.disabled = true;
  try {
    await loadEarlier(id, page, from);
  } catch (err) {
    if (button) button.disabled = false;
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
  view.typingEl.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReadout(); }
  };
  // Opening at the first unread message leaves the newest out of sight; this takes you there.
  // It sits in the composer's button row at every width, where it covers no chat words.
  const latest = h('button', { type: 'button', class: 'small secondary to-latest', title: 'Jump to the latest', 'aria-label': 'Jump to the latest', hidden: true },
    h('span', { 'aria-hidden': 'true' }, '↓'), h('span', { class: 'wide-only' }, ' Latest'));
  latest.addEventListener('click', scrollToBottom);
  form.querySelector('.row > .add-image').after(latest);
  // One-tap replies sit at the top of the composer, so they stay in view with it (renderTicketHead fills them).
  // Whose plan your message runs on, only when that's news (public/payer.js); under the replies, right over the box.
  form.prepend(h('div', { id: 'chat-payer', hidden: true }));
  form.prepend(h('div', { class: 'replies-bar', id: 'chat-replies', hidden: true }));
  return h('section', { class: 'chat' }, h('div', { class: 'ticket-head', id: 'ticket-head' }), log, view.typingEl, form);
}


/** Find in the open conversation: highlights every match, Enter / ↓ for the next, Shift+Enter / ↑ for the previous. */
function chatFindBox() {
  const input = h('input', { type: 'search', class: 'chat-find', placeholder: matchMedia('(max-width: 800px)').matches ? '🔍 Find' : 'Find in chat', 'aria-label': 'Find in chat', autocomplete: 'off' });
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
  el.replaceChildren(...parts);
  el.hidden = !parts.length;
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
  for (const bubble of chat?.querySelectorAll('.log [data-event]') ?? []) markQueued(bubble, t);
  const box = chat?.querySelector('.composer textarea');
  if (box) box.placeholder = composerPlaceholder(t);
  const form = chat?.querySelector('.composer');
  const bar = chat?.querySelector('#chat-replies');
  if (bar && form) {
    // Above the composer, sent the way the composer sends (shown at once, "Claude is thinking…").
    const chips = replyChips(t, form.sendText);
    bar.hidden = !chips;
    bar.replaceChildren(chips);
    const slot = chat.querySelector('#chat-payer');
    const line = payerLine(t, form.sendText);
    slot.hidden = !line;
    slot.replaceChildren(line ?? '');
  }
  const actions = [];
  // The minion's branch, running on a copy of the data (start_preview, src/previews.ts).
  if (t.preview && t.status !== 'closed') {
    actions.push(h('button', { class: 'secondary', title: 'Open this minion\'s preview in a new tab', onclick: () => window.open(`preview/${t.id}/`, '_blank', 'noopener') }, 'Preview'));
  }
  // Parked on start_after (#261): a message only gets an answer; this starts the work, its held brief first.
  if (t.parked_for && t.status !== 'closed' && t.status !== 'running') {
    actions.push(h('button', { class: 'secondary act-start', title: 'Start it now with its held brief, without waiting for its leader\'s work', onclick: () => api(`api/tickets/${t.id}/start`, { method: 'POST', body: {} }).catch((e) => alertNote(e.message)) }, 'Start now'));
  }
  // Waiting on the usage limit, Stop ends the wait (src/runner.ts, stop).
  if (t.status === 'running' || t.limit_resume_at) {
    actions.push(h('button', { class: 'secondary act-stop', title: t.limit_resume_at ? 'Don\'t resume after the usage limit resets' : undefined, onclick: () => api(`api/tickets/${t.id}/stop`, { method: 'POST', body: {} }).catch((e) => alertNote(e.message)) }, 'Stop'));
  } else if (coord) {
    // The coordinator stays open for the life of the project.
  } else if (t.status === 'closed') {
    actions.push(h('button', { class: 'secondary act-reopen', onclick: () => setStatus(t.id, 'idle') }, 'Reopen minion'));
  } else {
    actions.push(h('button', { class: 'secondary act-dismiss', onclick: async () => {
      if (await setStatus(t.id, 'closed')) location.hash = `#/p/${t.project_id}`;
    }, title: 'Dismiss minion' }, 'Dismiss', h('span', { class: 'wide-only' }, ' minion')));
  }
  const state = (coord ? statusLabel(t) : rowState(t).label) + (t.queued ? ` · ${t.queued} queued` : '');
  // Titled too, since a narrow line may cut it short. While Claude works,
  // a cut-short state shows dots that count up instead of "Cla…".
  const working = t.status === 'running';
  const stateLabel = h('span', { class: 'muted head-state', title: state }, h('span', { class: 'state-text' }, state),
    working ? h('span', { class: 'state-dots', 'aria-hidden': 'true' }, h('i', {}, '.'), h('i', {}, '.'), h('i', {}, '.')) : '');
  stateFit?.disconnect();
  if (working) stateFit?.observe(stateLabel);
  const nav = h('span', { class: 'head-nav' },
    // Through the views opened in this tab, never off the site (public/navstack.js).
    h('button', { type: 'button', class: 'nav-btn nav-back', title: 'Back', 'aria-label': 'Back', disabled: !canBack(), onclick: goBack }, icon('back')),
    h('button', { type: 'button', class: 'nav-btn nav-forward', title: 'Forward', 'aria-label': 'Forward', disabled: !canForward(), onclick: goForward }, icon('forward')),
    // Leaves the thread as it is and goes back to the project's coordinator.
    coord ? '' : h('a', { class: 'close-view', href: `#/p/${t.project_id}`, title: 'Back to the Taskmaster', 'aria-label': 'Back to the Taskmaster' }, icon('close')));
  // The title's line keeps who it is (and on wider screens the way out); the line under it takes the
  // state, where the change is, the tools and the buttons, and on phones ‹ › × after Find (#158), so the title has room.
  const phone = narrow.matches;
  el.replaceChildren(
    h('div', { class: 'row' },
      h('span', { class: `dot ${t.status}` }),
      h('h2', { title: threadFullName(t) }, threadTitleParts(t)),
      h('span', { class: 'spacer' }),
      phone ? '' : payerChip(t),
      phone ? '' : nav),
    coord ? (view.project ? onboardingStrip(view.project) : '') : personNoteLine(t),
    // Phones give the title its own line (#158), so the payer chip leads the line under it.
    h('div', { class: 'head-sub' }, phone ? payerChip(t) : '', stateLabel, shipLine(t), coord ? '' : personNoteButton(t), coord ? '' : pinButton(t), coord ? '' : propertyChip(t),
      h('span', { class: 'spacer' }), ...actions, view.findEl ?? '', phone ? nav : ''),
    view.progressEl);
  renderTyping();
  // While a turn runs, a sent message waits for it; said on hover rather than in a line of its own.
  const send = document.querySelector('.composer button[type=submit]');
  if (send) send.title = t.status === 'running' ? 'Runs after the current turn' : '';
  scheduleProgress();
}

// Phones put ‹ › × on the line under the title, so turning a tablet across the breakpoint redraws the bar.
const narrow = matchMedia('(max-width: 800px)');
narrow.addEventListener('change', () => { if (view.ticket) renderTicketHead(); });

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
  const save = async () => {
    try {
      const { note } = await api(`api/tickets/${t.id}/person-note`, { method: 'PUT', body: { text: input.value } });
      const notes = view.personNotes ?? {}; // none if the person left the scheme while it saved
      if (note) notes[t.id] = note;
      else delete notes[t.id];
      done();
    } catch (e) {
      alertNote(e.message);
    }
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
  const toggle = async () => {
    try {
      await api(`api/tickets/${t.id}/pin`, { method: 'PUT', body: { pinned: !pinned } });
      onTicketPin({ name: me, projectId: t.project_id, ticketId: t.id, pinned: !pinned }); // the stream says so too, maybe later
    } catch (e) {
      alertNote(e.message);
    }
  };
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

async function setStatus(id, status) {
  try {
    await api(`api/tickets/${id}/status`, { method: 'POST', body: { status } });
    return true;
  } catch (e) {
    alertNote(e.message);
    return false;
  }
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
      h('span', { class: 'st', title: { pending: 'In progress', err: 'Failed', ok: 'Done' }[state] }, state === 'pending' ? '…' : state === 'err' ? '✗' : '·'),
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

/**
 * The thread a coordinator tool call created or messaged, from its result ("Created #15 …",
 * "Sent. #12 …"), as { verb, number }; null for other calls and failures.
 */
function ticketActionRef({ block, result }) {
  if (!result || result.is_error || !block.name.startsWith('mcp__coordinator__')) return null;
  const text = Array.isArray(result.content) ? result.content.map((c) => c?.text ?? '').join('\n') : String(result.content ?? '');
  const m = /^(Created|Sent\.|Updated\.) #(\d+)\b/.exec(text);
  return m ? { verb: { Created: 'Created', 'Sent.': 'Messaged', 'Updated.': 'Updated' }[m[1]], number: Number(m[2]) } : null;
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

/** Which parts of a ticket's readout are expanded; kept per ticket so re-renders and reconnects don't fold it up. */
const progressUiState = new Map();
function progressUi(ticketId) {
  if (!progressUiState.has(ticketId)) progressUiState.set(ticketId, { open: false, openSteps: new Set() });
  return progressUiState.get(ticketId);
}

function firstSentence(text, max = 200) {
  const flat = String(text ?? '').replace(/[*`#>]/g, '').replace(/\s+/g, ' ').trim();
  const sentence = flat.match(/^.*?[.!?](\s|$)/)?.[0].trim() ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : sentence;
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
      h('span', { class: 'st' }, ph.ongoing ? '◐' : '✓'), ph.text,
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
  const running = view.ticket.status === 'running';
  const line = progressLine(p, running);
  if (!line) {
    progressEl.hidden = true;
    return;
  }
  const { total, done, current } = stepInfo(p);
  // The line carries its own worded step count; the turn's action count shows only when no plan is underway.
  const planned = total && (current || done < total);
  const count = !planned && running && initSeen() && p.turnActions ? `${p.turnActions} action${p.turnActions === 1 ? '' : 's'}` : '';

  const bar = h('button', { class: 'progress-line', 'aria-expanded': String(view.ui.open), onclick: () => {
    view.ui.open = !view.ui.open;
    renderProgress();
  } },
    h('span', { class: `dot ${running ? 'running' : view.ticket.status}` }),
    h('span', { class: 'text' }, line),
    count ? h('span', { class: 'count' }, count) : '',
    h('span', { class: 'chev' }, view.ui.open ? '▴' : '▾'));
  const meter = total ? h('progress', { class: 'meter', max: total, value: done }) : '';

  const prevDetail = progressEl.querySelector('.progress-detail');
  const scrollTop = prevDetail?.scrollTop ?? 0;
  let detail = '';
  if (view.ui.open) {
    const all = [...view.actions.values()];
    const groups = { completed: [], in_progress: [], pending: [] };
    for (const t of p.tasks) (groups[t.status] ?? groups.pending).push(t);
    const stepEl = (t) => planStep(t, all.filter((a) => a.taskId === t.id), running);
    const section = (title, tasks) => (tasks.length ? h('section', { class: 'plan-group' }, h('h4', {}, title), tasks.map(stepEl)) : '');
    const loose = view.turnActions.filter((a) => a.taskId == null || !p.tasks.some((t) => t.id === a.taskId));
    const req = view.turnRequest;
    detail = h('div', { class: 'progress-detail' },
      req?.length ? h('p', { class: 'request' }, h('span', { class: 'muted' }, running ? 'Working on ' : 'Last worked on '),
        req.flatMap((m, n) => [n ? ' and ' : '', `${m.author}'s request: `, h('q', {}, firstSentence(m.text, 160))])) : '',
      section('Done', groups.completed),
      section(running ? 'Now' : 'Stopped at', groups.in_progress),
      section('Up next', groups.pending),
      loose.length ? looseWork(loose, running, !p.tasks.length) : '',
      !p.tasks.length && !loose.length ? h('p', { class: 'muted empty' }, 'Nothing has run yet.') : '');
  }
  progressEl.replaceChildren(bar, meter, detail);
  if (detail) detail.scrollTop = scrollTop;
  progressEl.hidden = false;
}

export function appendEvent(event, scroll = true) {
  // Live events join the loaded history, so a redraw (Load earlier) and the cache keep them.
  if (view.page && event.id > (view.page.events.at(-1)?.id ?? 0)) view.page.events.push(event);
  view.lastEventId = Math.max(view.lastEventId, event.id);
  const log = document.getElementById('log');
  if (!log) return;
  const data = JSON.parse(event.data);
  recapEvent(event, data);
  // A steer was read by the turn already running, so it isn't part of what the next turn works on.
  if (event.kind === 'user_message' && !data.steered) (view.pendingRequest ??= []).push({ author: data.author, text: data.text || '(image)' });
  if (event.kind === 'claude' && data.type === 'system' && data.subtype === 'init') {
    view.turnActions = [];
    view.turnNote = null;
    view.turnInitAt = event.created_at;
    view.narration = narrationSorter();
    view.narrationEl = null;
    // Messages queued since the last turn are what this turn works on.
    if (view.pendingRequest?.length) view.turnRequest = view.pendingRequest;
    view.pendingRequest = [];
  }
  // A Grunt's words fold into its own line, so they aren't the minion's reply or its working line.
  const grunt = gruntOf(event.kind, data);
  if (grunt && !view.gruntStarts.has(grunt)) view.gruntStarts.set(grunt, event.created_at);
  if (event.kind === 'claude' && data.type === 'assistant' && !grunt) {
    for (const b of data.message?.content ?? []) if (b.type === 'text' && b.text.trim()) view.turnNote = b.text.trim();
  }
  for (const { block, taskId } of applyEvent(view.progress, event.kind, data)) {
    const action = { block, taskId, result: null };
    view.actions.set(block.id, action);
    view.turnActions.push(action);
  }
  if (event.kind === 'claude') scheduleProgress();
  const nodes = [];
  // The turn's words the sorter has settled, to fold or keep once they're in the log.
  const settle = [];

  if (event.kind === 'user_message') {
    // Narration after a message goes in a row below it, not back into the one above.
    view.narrationEl = null;
    if (data.author === me && view.pendingMessages.length) {
      // Our own message, already shown when it was sent: swap in the server's copy.
      const i = Math.max(0, view.pendingMessages.findIndex((m) => m.text === (data.text ?? '')));
      view.pendingMessages.splice(i, 1)[0].el.remove();
    }
    // An answer to a question card or a plan's go shows in the card itself; the chat only gets a
    // line pointing back up when messages below have pushed the card out of the way.
    const card = view.cards.get(data.answer?.questionId ?? (data.plan?.verdict === 'approve' ? data.plan.planId : null));
    if (data.answer) card?.markAnswered(data.answer.answers, data.author);
    if (card) {
      if (messagesBelow(card.el)) nodes.push(stamped(answerRef(card.el, data), event));
      // Someone else's answer counts as new, so the unread divider can still land on the card.
      else if (data.author !== me) card.el.dataset.at = event.created_at;
    } else if (data.answer) {
      // The card is in history not loaded yet.
      nodes.push(stamped(h('div', { class: 'msg user answer' }, h('div', { class: 'who' }, data.author), answerSummary(data.answer.answers)), event));
    } else {
      const bubble = userBubble(data.author, data.text,
        (data.images ?? []).map((name) => `api/tickets/${event.ticket_id}/images/${encodeURIComponent(name)}`),
        data.comment ? { ticketId: event.ticket_id, path: data.comment.path, name: baseName(data.comment.about) } : null,
        { id: event.id, strikes: data.strikes, brief: data.brief },
        (data.files ?? []).map((f) => ({ ...f, href: uploadUrl(event.ticket_id, f.name) })));
      bubble.dataset.event = event.id;
      // What its ✎ puts back in the message box while it waits in the queue (markQueued); a comment on a file would lose its file.
      if (data.author === me && !data.comment) bubble.sent = { text: data.text ?? '', images: data.images ?? [], files: data.files ?? [] };
      stamped(bubble, event);
      if (data.steered) bubble.querySelector('.who').append(h('span', { class: 'msg-tag', title: 'Sent into the turn that was running: Claude read it between steps' }, 'into the running turn'));
      markQueued(bubble, view.ticket);
      nodes.push(bubble);
    }
  } else if (event.kind === 'unqueued') {
    const bubble = log.querySelector(`[data-event="${data.id}"]`);
    if (bubble) {
      bubble.querySelector('.queued-tag')?.remove();
      bubble.classList.add('withdrawn');
      bubble.querySelector('.who').append(h('span', { class: 'msg-tag' }, `taken back by ${data.by}`));
    }
  } else if (event.kind === 'question') {
    nodes.push(stamped(questionCard(event.ticket_id, data), event));
  } else if (event.kind === 'approval') {
    nodes.push(stamped(approvalCard(event.ticket_id, data), event));
  } else if (event.kind === 'plan') {
    nodes.push(stamped(planCard(event.ticket_id, data), event));
  } else if (event.kind === 'question_result') {
    view.cards.get(data.id)?.markSettled();
  } else if (event.kind === 'strike') {
    // strike_text: redraw the message it struck, wherever it shows now (a bubble or a folded update).
    for (const el of log.querySelectorAll(`[data-body="${data.event}"]`)) {
      el.closest('.coord')?.querySelector('summary .preview')?.replaceChildren(...previewNodes(el.source, data.strikes));
      el.replaceWith(messageBody(el.source, data.strikes, el.ticketId, data.event));
    }
  } else if (event.kind === 'replaced') {
    // A reply the link check sent back gives way to its rewrite (#281): the bubble, or its line in a fold.
    for (const el of log.querySelectorAll(`[data-body="${data.event}"]`)) (el.closest('.note-text') ?? el.closest('.msg') ?? el).remove();
  } else if (event.kind === 'plan_result') {
    view.cards.get(data.id)?.settle(data);
  } else if (event.kind === 'loop_paused') {
    nodes.push(loopCard(data));
  } else if (event.kind === 'loop_continued') {
    for (const card of log.querySelectorAll(`.lcard[data-minion="${data.minion}"]:not(.answered)`)) {
      card.classList.add('answered');
      card.querySelector('button').remove();
      card.querySelector('[role=status]').textContent = `Continued by ${data.by}`;
    }
  } else if (event.kind === 'approval_result') {
    // The card itself records who decided, or why it expired.
    view.cards.get(data.id)?.settle(data);
  } else if (event.kind === 'note') {
    const struck = strikeNote(data);
    const short = struck ? null : shortNote(data.text);
    if (struck) nodes.push(struck);
    else if (short != null) nodes.push(h('div', { class: 'note', title: short === data.text ? null : data.text }, threadRefs(short)));
  } else if (event.kind === 'error') {
    nodes.push(h('div', { class: 'note error' }, data.text));
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
          const msg = stamped(h('div', { class: 'msg' }, h('div', { class: 'who' }, speaker()), body), event);
          nodes.push(msg);
          view.latestReply = event.id;
          settle.push(...view.narration.text({ el: msg, body, text: block.text }));
        } else if (block.type === 'tool_use') {
          settle.push(...view.narration.tool(block.name));
        }
      }
    } else if (data.type === 'user') {
      for (const block of data.message?.content ?? []) {
        const action = block.type === 'tool_result' && view.actions.get(block.tool_use_id);
        if (action) action.result = { content: block.content, is_error: block.is_error };
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
  // A minion explains its card in the reply it writes after asking, so the card stays below that
  // turn's words until someone answers or the turn ends.
  const held = view.heldCards.find((el) => el.isConnected);
  if (held && event.kind === 'claude' && data.type === 'assistant') held.before(...nodes);
  else log.append(...nodes);
  if (event.kind === 'question' || event.kind === 'plan') view.heldCards.push(...nodes);
  else if (event.kind === 'user_message' || (event.kind === 'claude' && data.type === 'result')) view.heldCards = [];
  for (const { text, fate } of settle) settleText(text, fate);
  renderTyping();
  if (scroll && followChat) scrollToBottom();
}

/**
 * A Grunt's report as one folded line (its name, gist and how long it ran), merged with the lines just
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
      h('summary', {}, h('span', { class: 'who' }, `Grunt · ${name}`), h('span', { class: 'preview' }), h('span', { class: 'dur' })),
      h('div', { class: 'msg grunt-body' }, body));
    Object.assign(line, { start, name });
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
    h('span', { class: 'preview' }, all.map((l) => l.name).join(', ')));
}

/**
 * Who Claude speaks as in this chat: the scheme's Taskmaster in its own chat ("The Delve Taskmaster
 * asks"), else the minion ("Your Minion asks").
 */
function speaker(doing = '') {
  if (!view.ticket || !isCoordinator(view.ticket)) return doing ? `Your Minion ${doing}` : 'Your Minion';
  return doing ? ['The ', taskmasterLabel(view.ticket.project_id), ` ${doing}`] : taskmasterLabel(view.ticket.project_id);
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
 * Fold or keep one of the turn's words, as narrationSorter settled it. Folded remarks go in an
 * "updates along the way" row, one per stretch between kept messages, where the first of them
 * was.
 */
function settleText(t, fate) {
  if (fate !== 'fold') {
    if (fate === 'clamp') clamp(t.el);
    view.narrationEl = null;
    return;
  }
  if (!view.narrationEl?.isConnected) {
    view.narrationEl = h('details', { class: 'narration', 'data-at': t.el.dataset.at }, h('summary', {}), h('div', { class: 'notes' }));
    t.el.before(view.narrationEl);
  }
  t.el.remove();
  const notes = view.narrationEl.querySelector('.notes');
  notes.append(h('div', { class: 'note-text' }, t.body));
  const n = notes.childElementCount;
  view.narrationEl.querySelector('summary').replaceChildren(
    h('span', { class: 'st' }, '⋯'), ` ${n} update${n === 1 ? '' : 's'} along the way`);
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
  Object.assign(body, { source: text, ticketId });
  return body;
}

/** "45s", "1m 47s", "12m", "1h 5m". */
function shortDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
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

/** Short wording for the notes the server writes often (null hides one); anything else stays as it is. */
function shortNote(text) {
  let m;
  // Older threads stored a note on every session restore; restores are silent now.
  if (/^Restored this thread's Claude session from the app's database/.test(text)) return null;
  if (text === 'The server restarted during this turn, so it was interrupted.') return '⚠ Interrupted by a server restart';
  if ((m = text.match(/^(.+?) renamed this (?:ticket|minion) from ".*" to "(.*)"\.$/s))) return `✎ ${m[1] === 'Claude' ? 'Renamed' : `${m[1]} renamed it`} “${m[2]}”`;
  if ((m = text.match(/^(.+?) set this (?:thread|minion) to (.+?) (from the next turn|from now on)\.$/))) return `⚙ ${m[1]}: ${m[2]}${m[3] === 'from the next turn' ? ' next turn' : ''}`;
  if ((m = text.match(/^(.+?) (updated|cleared) the (?:project|scheme) instructions; they apply from each (?:thread|minion)'s next turn\.$/))) return `📋 ${m[1]} ${m[2]} the scheme instructions`;
  if ((m = text.match(/^(.+?) set the (approval rules|plugin folders) to: (.*)\. They apply from each (?:thread|minion)'s next turn\.$/s))) return `🔒 ${m[1]} set the ${m[2]}: ${m[3]}`;
  if ((m = text.match(/^(.+?) reopened this (?:ticket|minion)\.$/))) return `↻ ${m[1]} reopened it`;
  return text;
}

// ---------- approval cards ----------

/** "merge_pull_request (github)" for an MCP tool, else the tool's own name. */
function toolTitle(name) {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[2]} (${m[1]})` : name;
}

/** "✓ Approved by Cara", "✓ Approved on Cara's go in #42" (linked to her message), "✗ Denied by Cara", "⌛ Expired, not run: …". */
function approvalOutcome(r) {
  const v = r.state === 'allowed' && r.via;
  if (v?.scheme && v.message) {
    const here = view?.projectId === v.scheme && view.ticket?.number === v.ticket;
    const where = here ? '' : v.ticket == null ? ` in the ${taskmasterName(v.scheme)} chat` : ` in #${v.ticket}`;
    const href = `#/p/${v.scheme}${v.ticket == null ? '' : `/t/${v.ticket}`}?e=${v.message}`;
    return ['✓ Approved on ', h('a', { href, title: v.text }, `${r.by}'s go${where}`)];
  }
  if (r.state === 'allowed') return [`✓ Approved by ${r.by}`];
  if (r.state === 'denied') return [`✗ Denied by ${r.by}`];
  return [`⌛ Expired, not run: ${r.reason}`];
}

/**
 * A tool call that matches one of the project's approval rules, or that the tripwire stopped (then the
 * card also shows its reason), waiting for a person. The turn is paused until someone clicks; a card
 * whose turn ended (stopped, failed, server restart) expires.
 */
function approvalCard(ticketId, card) {
  const input = card.input ?? {};
  // Show what will actually run: the command for Bash, the path for file tools, else the whole input.
  const lead = typeof input.command === 'string' ? 'command' : typeof input.file_path === 'string' ? 'file_path' : null;
  const rest = lead ? Object.fromEntries(Object.entries(input).filter(([k]) => k !== lead && k !== 'description')) : {};
  const status = h('span', { class: 'muted', role: 'status' });
  const m = card.merge;
  const approve = h('button', { type: 'button', class: m ? 'go' : 'small' }, m ? MERGE_GO[m.method] ?? 'Approve merge' : 'Approve');
  const deny = h('button', { type: 'button', class: 'small secondary' }, 'Deny');
  const desc = typeof input.description === 'string' ? h('div', { class: 'desc' }, card.tripwire ? `Why: ${input.description}` : input.description) : '';
  const call = [
    h('pre', { class: 'acmd' }, lead ? input[lead] : JSON.stringify(input, null, 2)),
    Object.keys(rest).length ? h('pre', { class: 'acmd extra' }, JSON.stringify(rest, null, 2)) : '',
  ];
  const el = h('div', { class: `qcard acard${m ? ' mcard' : ''}` },
    ...(m ? mergeHead(m, desc, call) : [
      h('div', { class: 'who' }, speaker('asks to run')),
      h('div', { class: 'qtitle' }, h('span', { class: 'chip' }, card.tripwire ? 'Tripwire' : 'Needs approval'), toolTitle(card.tool)),
      desc, ...call,
    ]),
    card.tripwire ? h('div', { class: 'anote' }, `Blocked because: ${card.tripwire.reason}`) : '',
    h('div', { class: 'anote' }, `Approve runs this one call once. If the turn ends first, it expires and doesn't run.`),
    h('div', { class: 'row' }, status, h('span', { class: 'spacer' }), deny, approve));
  let settled = false;
  const decide = async (allow) => {
    if (settled) return;
    approve.disabled = deny.disabled = true;
    status.textContent = allow ? 'Approving…' : 'Denying…';
    try {
      await api(`api/tickets/${ticketId}/approve`, { method: 'POST', body: { approvalId: card.id, allow } });
      if (view?.id === ticketId) catchUpEvents().catch(() => {});
    } catch (ex) {
      status.textContent = ex.message;
      // An expired or already-settled card stays shut; anything else can be tried again.
      if (!/expired|already/.test(ex.message)) approve.disabled = deny.disabled = false;
    }
  };
  approve.addEventListener('click', () => decide(true));
  deny.addEventListener('click', () => decide(false));
  view.cards.set(card.id, {
    settle(r) {
      settled = true;
      el.classList.add('answered', `a-${r.state}`);
      approve.hidden = deny.hidden = true;
      status.replaceChildren(...approvalOutcome(r));
    },
  });
  return el;
}

const MERGE_METHOD = { squash: 'Squash', merge: 'Merge commit', rebase: 'Rebase' };
const MERGE_GO = { squash: 'Squash and merge', merge: 'Merge', rebase: 'Rebase and merge' };

/**
 * The top of a `gh pr merge` card (#200, src/merge-card.ts): the PR's title, branches, method, size and
 * checks as GitHub gave them when the card was posted, or what the command says if GitHub couldn't
 * be asked. The minion's description and the full command sit behind Show command.
 */
function mergeHead(m, desc, call) {
  const pr = m.pr;
  const name = pr ? `#${pr.number}` : m.target == null ? "this branch's PR" : /^\d+$/.test(m.target) ? `PR #${m.target}` : m.target;
  const shown = h('div', { class: 'mcall', hidden: true }, desc, call);
  const toggle = h('button', { type: 'button', class: 'mtoggle', 'aria-expanded': 'false' }, '▸ Show command');
  toggle.addEventListener('click', () => {
    shown.hidden = !shown.hidden;
    toggle.setAttribute('aria-expanded', String(!shown.hidden));
    toggle.textContent = shown.hidden ? '▸ Show command' : '▾ Hide command';
  });
  const checks = { passed: ['ok', '✓ checks passed'], failed: ['bad', '✗ checks failed'], pending: ['', '○ checks running'] }[pr?.checks];
  const warn = [
    m.auto && '--auto: GitHub merges it by itself once its checks pass, not straight away.',
    m.admin && "--admin: skips the branch's protection rules.",
    pr && pr.state && pr.state !== 'OPEN' && `This PR is already ${pr.state.toLowerCase()}.`,
    pr?.draft && 'This PR is still a draft.',
    !pr && (m.moved && !m.repo ? "The command changes folder first, so the PR wasn't looked up." : "Couldn't look the PR up on GitHub; this is what the command says."),
  ].filter(Boolean);
  return [
    h('div', { class: 'who' }, speaker('asks to merge')),
    h('div', { class: 'qtitle' }, h('span', { class: 'chip' }, 'Merge'),
      pr?.url ? h('a', { class: 'mnum', href: pr.url, target: '_blank', rel: 'noopener', 'data-github': '' }, name) : h('span', { class: 'mnum' }, name),
      pr ? ` ${pr.title}` : m.repo ? h('span', { class: 'muted' }, ` in ${m.repo}`) : ''),
    pr?.head ? h('div', { class: 'mbranch' }, h('code', {}, pr.head), ' → ', h('code', {}, pr.base)) : '',
    h('div', { class: 'mmeta' },
      h('span', { class: 'mmethod' }, MERGE_METHOD[m.method] ?? 'Merge method not set'),
      pr ? [
        h('span', {}, h('span', { class: 'ok' }, `+${pr.additions}`), ' ', h('span', { class: 'bad' }, `−${pr.deletions}`)),
        h('span', {}, `${pr.files} ${pr.files === 1 ? 'file' : 'files'}`),
        h('span', {}, `${pr.commits} ${pr.commits === 1 ? 'commit' : 'commits'}`),
        checks ? h('span', { class: checks[0] }, checks[1]) : '',
      ] : ''),
    ...warn.map((w) => h('div', { class: 'mwarn' }, w)),
    toggle, shown,
  ];
}

// A plan only moves forward: pending, then sent back, then superseded; approved is final.
const PLAN_RANK = { pending: 0, revising: 1, approved: 2, superseded: 2 };

/** "✓ Approved by Cara · Tue 14:05", "✎ Cara asked for changes", "Superseded by a newer plan". */
function planOutcome(r) {
  const when = r.at ? ` · ${new Date(r.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
  if (r.status === 'approved') return `✓ Approved by ${r.by}${when}`;
  if (r.status === 'revising') return `✎ ${r.by} asked for changes${when}`;
  return 'Superseded by a newer plan';
}

/**
 * A plan from Claude waiting for a go: Approve sends it, Revise opens a box for notes that go back
 * to Claude, which answers with a new card. Only people can decide; the card keeps its outcome.
 */
function planCard(ticketId, card) {
  const status = h('span', { class: 'muted', role: 'status' });
  const approve = h('button', { type: 'button', class: 'small' }, 'Approve');
  const revise = h('button', { type: 'button', class: 'small secondary' }, 'Revise');
  const notes = h('textarea', { class: 'pnotes', rows: 3, maxlength: 10000, placeholder: 'What should change?', hidden: true });
  const cancel = h('button', { type: 'button', class: 'small secondary', hidden: true }, 'Cancel');
  const sendNotes = h('button', { type: 'button', class: 'small', hidden: true, disabled: true }, 'Send notes');
  const el = h('div', { class: 'qcard pcard' },
    h('div', { class: 'who' }, speaker('proposes a plan')),
    h('div', { class: 'qtitle' }, h('span', { class: 'chip' }, 'Plan'), card.summary),
    h('div', { class: 'pbody' }, markdown(card.plan, ticketId)),
    notes,
    h('div', { class: 'row' }, status, h('span', { class: 'spacer' }), revise, approve, cancel, sendNotes));
  let rank = 0;
  const editing = (on) => {
    notes.hidden = cancel.hidden = sendNotes.hidden = !on;
    approve.hidden = revise.hidden = on;
    if (!on) return;
    notes.focus({ preventScroll: true });
    // Centre the box so its buttons clear the sticky message box at the bottom.
    notes.scrollIntoView({ block: 'center' });
  };
  const decide = async (verdict) => {
    if (rank) return;
    approve.disabled = revise.disabled = sendNotes.disabled = cancel.disabled = true;
    status.textContent = verdict === 'approve' ? 'Approving…' : 'Sending…';
    try {
      const ticket = await api(`api/tickets/${ticketId}/verdict`, { method: 'POST', body: { planId: card.id, verdict, notes: notes.value.trim() } });
      if (view?.id === ticketId) {
        view.ticket = ticket;
        renderTicketHead();
        catchUpEvents().catch(() => {});
      }
    } catch (ex) {
      status.textContent = ex.message;
      approve.disabled = revise.disabled = cancel.disabled = false;
      sendNotes.disabled = !notes.value.trim();
    }
  };
  approve.addEventListener('click', () => decide('approve'));
  revise.addEventListener('click', () => editing(true));
  cancel.addEventListener('click', () => editing(false));
  sendNotes.addEventListener('click', () => decide('revise'));
  notes.addEventListener('input', () => { sendNotes.disabled = !notes.value.trim(); });
  notes.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && notes.value.trim()) { e.preventDefault(); decide('revise'); }
  });
  const handle = {
    el,
    settle(r) {
      // The stored card already has its latest outcome, so replayed older results are ignored.
      if ((PLAN_RANK[r.status] ?? 0) <= rank) return;
      rank = PLAN_RANK[r.status];
      editing(false);
      el.classList.add('answered', `p-${r.status}`);
      approve.hidden = revise.hidden = true;
      status.textContent = planOutcome(r);
    },
  };
  view.cards.set(card.id, handle);
  if (card.status !== 'pending') handle.settle(card);
  return el;
}

/** The loop guard held a Taskmaster↔minion message: what it held, and Continue to let it through. */
function loopCard(data) {
  const status = h('span', { class: 'muted', role: 'status' });
  const go = h('button', { type: 'button', class: 'small' }, 'Continue');
  go.addEventListener('click', async () => {
    go.disabled = true;
    status.textContent = 'Continuing…';
    try {
      await api(`api/tickets/${data.minion}/continue`, { method: 'POST' });
    } catch (ex) {
      status.textContent = ex.message;
      go.disabled = false;
    }
  });
  return h('div', { class: 'qcard lcard', 'data-minion': data.minion },
    h('div', { class: 'qtitle' }, h('span', { class: 'chip' }, 'Needs a person'), threadRefs(data.text)),
    h('div', { class: 'row' }, status, h('span', { class: 'spacer' }), go));
}

// ---------- question cards ----------

/** "Answered: Tabs · Other: keep both" lines for an answer message. */
function answerSummary(answers) {
  return h('div', { class: 'answer-lines' }, answers.map((a) =>
    h('div', {}, '→ ', [...a.selected, ...(a.other ? [`Other: ${a.other}`] : [])].join(' · '))));
}

/** Whether any message or card sits below this card in the chat. */
function messagesBelow(el) {
  for (let n = el.nextElementSibling; n; n = n.nextElementSibling) if (n.matches('.msg, .qcard')) return true;
  return false;
}

/** "Cara picked Tabs ↑" at the bottom of the chat, jumping back up to the card it answered. */
function answerRef(cardEl, data) {
  const picks = data.answer?.answers.map((a) => [...a.selected, ...(a.other ? [a.other] : [])].join(', ')).join(' · ');
  const text = picks == null ? `${data.author} approved the plan` : `${data.author} picked ${picks}`;
  return h('div', { class: 'answer-ref' }, h('button', {
    type: 'button', title: 'Show the card',
    onclick: () => cardEl.scrollIntoView({ block: 'center', behavior: 'smooth' }),
  }, `${text} ↑`));
}

/**
 * A card of multiple-choice questions from Claude. Click options to pick (several when the question
 * allows), or type an answer under Other; a single one-pick question sends on the first click.
 */
// Picks not yet sent, by card id, so a card keeps them while you look at an option's picture.
const cardPicks = new Map();

function questionCard(ticketId, card) {
  if (!cardPicks.has(card.id)) cardPicks.set(card.id, card.questions.map(() => ({ selected: new Set(), other: '' })));
  const picks = cardPicks.get(card.id);
  const single = card.questions.length === 1 && !card.questions[0].multiSelect;
  const sendBtn = h('button', { type: 'button', class: 'small', disabled: true }, single ? 'Send' : 'Send answers');
  const status = h('span', { class: 'muted' });
  const el = h('div', { class: 'qcard' });
  let answered = false;

  const ready = () => picks.every((p) => p.selected.size || p.other.trim());
  const refresh = () => {
    for (const [i, q] of card.questions.entries()) {
      for (const btn of el.querySelectorAll(`[data-q="${i}"] .opt`)) btn.classList.toggle('picked', picks[i].selected.has(btn.dataset.label));
    }
    sendBtn.disabled = answered || !ready();
  };
  const send = async () => {
    if (answered || !ready()) return;
    el.classList.add('sending');
    sendBtn.disabled = true;
    status.textContent = 'Sending…';
    try {
      const answers = picks.map((p) => ({ selected: [...p.selected], other: p.other.trim() }));
      const ticket = await api(`api/tickets/${ticketId}/answer`, { method: 'POST', body: { questionId: card.id, answers } });
      if (view?.id === ticketId) {
        view.ticket = ticket;
        renderTicketHead();
        catchUpEvents().catch(() => {});
      }
    } catch (ex) {
      status.textContent = ex.message;
      el.classList.remove('sending');
      refresh();
    }
  };
  sendBtn.addEventListener('click', send);

  el.append(
    h('div', { class: 'who' }, speaker('asks')),
    ...card.questions.map((q, i) => {
      const other = h('input', { type: 'text', class: 'other', placeholder: 'Other: type your own answer', maxlength: 2000, value: picks[i].other });
      other.addEventListener('input', () => {
        picks[i].other = other.value;
        // A typed answer replaces the pick on a one-answer question.
        if (!q.multiSelect && other.value.trim()) picks[i].selected.clear();
        refresh();
      });
      other.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send(); }
      });
      const pickBtn = (o) => h('button', {
        type: 'button', class: 'opt', 'data-label': o.label,
        onclick: () => {
          if (answered) return;
          const sel = picks[i].selected;
          if (q.multiSelect) sel.has(o.label) ? sel.delete(o.label) : sel.add(o.label);
          else {
            sel.clear();
            sel.add(o.label);
            other.value = '';
            picks[i].other = '';
          }
          refresh();
          if (single) send();
        },
      }, h('span', { class: 'label' }, o.label, o.recommended ? h('span', { class: 'rec' }, ' (Recommended)') : ''), o.description ? h('span', { class: 'desc' }, o.description) : '');
      // With pictures, the options are a gallery: each thumbnail opens the full view, its button picks it.
      const gallery = q.options.some((o) => o.image);
      return h('div', { class: 'q', 'data-q': i },
        h('div', { class: 'qtitle' }, q.header ? h('span', { class: 'chip' }, q.header) : '', q.question,
          q.multiSelect ? h('span', { class: 'muted' }, ' (pick any)') : ''),
        gallery
          ? h('div', { class: 'opts gallery' }, q.options.map((o) => h('div', { class: 'tile' },
            o.image ? optionThumb(ticketId, o) : h('div', { class: 'thumb none' }, 'No picture'), pickBtn(o))))
          : h('div', { class: 'opts' }, q.options.map(pickBtn)),
        other);
    }),
    h('div', { class: 'row' }, status, h('span', { class: 'spacer' }), sendBtn));
  refresh();

  view.cards.set(card.id, {
    el,
    markAnswered(answers, author) {
      answered = true;
      el.classList.remove('sending');
      el.classList.add('answered');
      answers.forEach((a, i) => {
        picks[i].selected = new Set(a.selected);
        const other = el.querySelector(`[data-q="${i}"] .other`);
        other.value = a.other ?? '';
        other.hidden = !a.other;
        other.disabled = true;
      });
      for (const btn of el.querySelectorAll('.opt')) btn.disabled = true;
      sendBtn.hidden = true;
      status.textContent = `Answered by ${author}`;
      refresh();
    },
    // The minion took a typed reply as the answer (settle_question).
    markSettled() {
      answered = true;
      el.classList.remove('sending');
      el.classList.add('answered');
      for (const input of el.querySelectorAll('.opt, .other')) input.disabled = true;
      for (const other of el.querySelectorAll('.other')) other.hidden = true;
      sendBtn.hidden = true;
      status.textContent = 'Answered in the chat';
    },
  });
  if (card.settled) view.cards.get(card.id).markSettled();
  return el;
}

/** A question option's picture: a thumbnail (muted and looping for video) that opens the file's full view. */
function optionThumb(ticketId, o) {
  const src = fileUrl(ticketId, o.image);
  let media = h('img', { src, alt: o.label, loading: 'lazy' });
  if (fileKind(o.image) === 'video') {
    media = h('video', { src, muted: true, autoplay: true, loop: true, playsinline: true, preload: 'metadata' });
    media.muted = true; // the attribute alone doesn't let it autoplay in every browser
  }
  return h('a', { class: 'thumb', href: fileHref(ticketId, o.image), title: `Open “${o.label}” full size` }, media);
}

// Messages the app sends a thread about its pull request (see src/github.ts).
const GITHUB_NAME = 'GitHub';
const COORDINATOR_NAME = 'Coordinator';
// APP_NAME in src/appname.ts: wake-ups and chained-minion notices.
const APP_AUTHOR = 'Citadel';

/**
 * Who sent a message that isn't from a person (authors from server.ts), as the fold shows them:
 * the Taskmaster, another scheme's ("Taskmaster of Delve"), a minion ("#12 Title"), the app or
 * GitHub. null for a person.
 */
function machineAuthor(author) {
  author ??= '';
  if (author === COORDINATOR_NAME || author === 'Taskmaster') return taskmasterName();
  // Citadel's Taskmaster also hears whose ask it is: "Taskmaster of Delve, for Josh, a Citadel member".
  const [, scheme, whose = ''] = author.match(/^Taskmaster of (.+?)(, for .+)?$/) ?? [];
  if (scheme) return `${scheme} Taskmaster${whose}`;
  return author === APP_AUTHOR || author === GITHUB_NAME || /^#\d+ /.test(author) ? author : null;
}

/** A chat message from a person; `about`, for a comment on a file, links that file. */
/**
 * A message still queued for the next turn says so, with a ✕ to take it back and, on your own, a ✎ to
 * take it back into the message box to fix and resend; it loses them once sent.
 */
function markQueued(bubble, ticket) {
  const id = Number(bubble.dataset.event);
  const queued = !!ticket?.queued_ids?.includes(id);
  const tag = bubble.querySelector('.queued-tag');
  if (!queued) return tag?.remove();
  if (tag) return;
  const edit = bubble.sent && h('button', { type: 'button', class: 'take-back', title: 'Take back to edit', 'aria-label': 'Take back to edit',
    onclick: async (e) => {
      e.preventDefault();
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        // Images first: if one won't load, the message stays queued rather than coming back without it.
        const images = await Promise.all(bubble.sent.images.map((name) => imageData(`api/tickets/${ticket.id}/images/${encodeURIComponent(name)}`)));
        await api(`api/tickets/${ticket.id}/unqueue`, { method: 'POST', body: { id } });
        const form = view?.id === ticket.id && document.querySelector('.composer');
        if (form) form.editBack(bubble.sent.text, [...images, ...bubble.sent.files.map((upload) => ({ upload }))]);
        else {
          // Moved to another chat meanwhile: the text waits in this chat's draft (attachments stay in the struck bubble).
          const draft = loadDraft(`cc-draft:${ticket.id}`)?.trim();
          saveDraft(`cc-draft:${ticket.id}`, draft ? `${bubble.sent.text}\n${draft}` : bubble.sent.text);
        }
      } catch (err) {
        btn.disabled = false;
        alertNote(err.message);
      }
    } }, '✎');
  bubble.querySelector('.who').append(h('span', { class: 'msg-tag queued-tag' }, 'queued for the next turn', edit ?? '',
    h('button', { type: 'button', class: 'take-back', title: 'Take back this message', 'aria-label': 'Take back this message',
      onclick: (e) => {
        e.preventDefault(); // a Taskmaster message's ✕ sits in its <summary>
        const btn = e.currentTarget;
        btn.disabled = true;
        api(`api/tickets/${ticket.id}/unqueue`, { method: 'POST', body: { id } }).catch((err) => {
          btn.disabled = false;
          alertNote(err.message);
        });
      } }, '✕')));
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
  // Messages between Claudes and from the app aren't meant for people, so they start folded to one line,
  // except the brief that started the minion: it says what the minion is for.
  const who = machineAuthor(author);
  if (who && event?.brief) msg.querySelector('.who').textContent = who;
  else if (who) {
    msg.querySelector('.who').remove();
    return h('details', { class: 'msg user coord' }, h('summary', {}, h('span', { class: 'who' }, who), h('span', { class: 'preview' }, previewNodes(text, event?.strikes))), msg);
  }
  return msg;
}

/** A folded message's one line: its text without Markdown marks, struck words keeping their line. */
function previewNodes(text, strikes) {
  const flat = (t) => t.replace(/[#*_`>\[\]~]/g, '').replace(/\s+/g, ' ');
  return struckSource((text ?? '').trim(), strikes).split(/~~(.+?)~~/).map((part, i) => (i % 2 ? h('del', {}, flat(part)) : flat(part)));
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

/** "1m 05s" style, for how long a turn has run. */
function elapsedText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}

/**
 * The working line under the chat while a turn runs, on one line: what's running right now, how
 * long the turn has gone and what's queued. The plan step sits in the thread bar's readout just
 * above, so it isn't repeated here; clicking the line opens that readout.
 */
export function renderTyping() {
  const el = view?.typingEl;
  if (!el || !view.ticket) return;
  const t = view.ticket;
  const show = t.status === 'running' || view.sendingTo === t.id;
  const wasHidden = el.hidden;
  el.hidden = !show;
  if (!show) return;
  const running = t.status === 'running';
  const last = running && initSeen() && view.turnActions.at(-1);
  const doing = last && !last.result ? actionLabel(last.block) : 'thinking…';
  const sep = () => h('span', { class: 'sep' }, '·');
  el.title = 'Show the work so far';
  el.replaceChildren(
    h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
    h('span', { class: 'line' },
      h('span', { class: 'lead' }, t.approvals ? 'Waiting for someone to approve or deny' : running ? 'Claude is working' : 'Claude is thinking…'),
      running && !t.approvals ? [sep(), h('span', { class: 'what' }, doing)] : '',
      running && t.turnStartedAt ? [sep(), h('span', { class: 'time', 'aria-hidden': 'true' }, elapsedText(Date.now() - t.turnStartedAt))] : '',
      t.queued ? [sep(), h('span', { class: 'queued', title: `${t.queued} message${t.queued === 1 ? '' : 's'} queued for the next turn` }, `${t.queued} queued`)] : ''));
  if (wasHidden && followChat) scrollToBottom();
}

/** Ticks the turn timer without rebuilding the line (and without re-announcing it to screen readers). */
setInterval(() => {
  const time = view?.typingEl?.querySelector('.time');
  const at = view?.ticket?.turnStartedAt;
  if (time && at && !view.typingEl.hidden) time.textContent = elapsedText(Date.now() - at);
}, 1000);
