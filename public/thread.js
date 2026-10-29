// A minion's chat: its head, history, readout, cards and the working line.
import { api, baseName, catchUpEvents, clearHighlights, fileHref, fileKind, fileUrl, followChat, h, highlight, isCoordinator, markdown, markSeen, me, restoreScroll, scrollToBottom, statusLabel, taskmasterName, threadFullName, threadRefs, threadTitleParts, view } from './core.js';
import { alertNote, composer, composerPlaceholder, renderModelPicker } from './composer.js';
import { rowState, SHIP } from './sidebar.js';
import { propertyChip } from './properties.js';
import { recapEvent, showRecap } from './recap.js';
import { struckSource } from './strike.js';
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
    cards: new Map(), // question card id -> { markAnswered }; approval card id -> { settle }
    branchEl: h('span', { class: 'branch-status', hidden: true }), // PR / branch state, on the newest turn-end line
  };
}

/** Fill in a chat section just put on the page: its head, its history, and where you were in it. */
export async function mountChat(chatId, ticket, events) {
  renderTicketHead();
  for (const ev of events) appendEvent(ev, false);
  if (ticket.branch) refreshBranch(chatId);
  markSeen(chatId);
  restoreScroll(chatId);
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

export function chatSection(chatId, ticket, events) {
  const form = composer(chatId, ticket);
  const log = h('div', { class: 'log', id: 'log' });
  if (isCoordinator(ticket) && !events.length) {
    log.append(h('div', { class: 'note' },
      'This is the Taskmaster for this scheme. It keeps track of the minions on the left and can create, message, rename and dismiss them for you.'));
  }
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
      h('a', { href: pr.url, target: '_blank', rel: 'noopener', title: pr.title, onclick: (e) => e.stopPropagation() }, `PR #${pr.number}`),
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
  const actions = [];
  // The minion's branch, running on a copy of the data (start_preview, src/previews.ts).
  if (t.preview && t.status !== 'closed') {
    actions.push(h('button', { class: 'secondary', title: 'Open this minion\'s preview in a new tab', onclick: () => window.open(`preview/${t.id}/`, '_blank', 'noopener') }, 'Preview'));
  }
  if (t.status === 'running') {
    actions.push(h('button', { class: 'secondary', onclick: () => api(`api/tickets/${t.id}/stop`, { method: 'POST', body: {} }).catch((e) => alertNote(e.message)) }, 'Stop'));
  } else if (coord) {
    // The coordinator stays open for the life of the project.
  } else if (t.status === 'closed') {
    actions.push(h('button', { class: 'secondary', onclick: () => setStatus(t.id, 'idle') }, 'Reopen minion'));
  } else {
    actions.push(h('button', { class: 'secondary', onclick: async () => {
      if (await setStatus(t.id, 'closed')) location.hash = `#/p/${t.project_id}`;
    }, title: 'Dismiss minion' }, 'Dismiss', h('span', { class: 'wide-only' }, ' minion')));
  }
  const state = (coord ? statusLabel(t) : rowState(t).label) + (t.queued ? ` · ${t.queued} queued` : '');
  // Titled too, since phones may cut it short to keep the buttons beside it.
  const stateLabel = h('span', { class: 'muted', title: state }, state);
  el.replaceChildren(
    h('div', { class: 'row' },
      h('span', { class: `dot ${t.status}` }),
      h('h2', { title: threadFullName(t) }, threadTitleParts(t)),
      stateLabel,
      h('span', { class: 'spacer' }), coord ? '' : propertyChip(t), ...actions, view.findEl ?? '',
      // Leaves the thread as it is and goes back to the project's coordinator.
      coord ? '' : h('a', { class: 'close-view', href: `#/p/${t.project_id}`, title: 'Back to the Taskmaster', 'aria-label': 'Back to the Taskmaster' }, '×')),
    shipLine(t),
    view.progressEl);
  renderTyping();
  // While a turn runs, a sent message waits for it; said on hover rather than in a line of its own.
  const send = document.querySelector('.composer button[type=submit]');
  if (send) send.title = t.status === 'running' ? 'Runs after the current turn' : '';
  scheduleProgress();
}

/** Where the minion's change is, branch to live, and why it is stuck when it is (src/branch.ts). */
function shipLine(t) {
  const stage = !isCoordinator(t) && SHIP[t.ship?.stage];
  if (!stage) return '';
  return h('div', { class: `ship f-${stage.fam}`, title: t.ship.detail ?? t.ship.text },
    h('i', { class: 'ship-dot' }), h('span', { class: 'text' }, t.ship.text), h('code', {}, t.ship.commit));
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
    view.turnTexts = [];
    view.narrationEl = null;
    // Messages queued since the last turn are what this turn works on.
    if (view.pendingRequest?.length) view.turnRequest = view.pendingRequest;
    view.pendingRequest = [];
  }
  if (event.kind === 'claude' && data.type === 'assistant') {
    for (const b of data.message?.content ?? []) if (b.type === 'text' && b.text.trim()) view.turnNote = b.text.trim();
  }
  for (const { block, taskId } of applyEvent(view.progress, event.kind, data)) {
    const action = { block, taskId, result: null };
    view.actions.set(block.id, action);
    view.turnActions.push(action);
  }
  if (event.kind === 'claude') scheduleProgress();
  const nodes = [];
  let fold = false;

  if (event.kind === 'user_message') {
    if (data.author === me && view.pendingMessages.length) {
      // Our own message, already shown when it was sent: swap in the server's copy.
      const i = Math.max(0, view.pendingMessages.findIndex((m) => m.text === (data.text ?? '')));
      view.pendingMessages.splice(i, 1)[0].el.remove();
    }
    if (data.answer) {
      // An answer to a question card: the card shows the picks, so the message only needs a short line.
      view.cards.get(data.answer.questionId)?.markAnswered(data.answer.answers, data.author);
      nodes.push(h('div', { class: 'msg user answer' }, h('div', { class: 'who' }, data.author), answerSummary(data.answer.answers)));
    } else {
      const bubble = userBubble(data.author, data.text,
        (data.images ?? []).map((name) => `api/tickets/${event.ticket_id}/images/${encodeURIComponent(name)}`),
        data.comment ? { ticketId: event.ticket_id, path: data.comment.path, name: baseName(data.comment.about) } : null,
        { id: event.id, strikes: data.strikes });
      bubble.dataset.event = event.id;
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
    nodes.push(questionCard(event.ticket_id, data));
  } else if (event.kind === 'approval') {
    nodes.push(approvalCard(event.ticket_id, data));
  } else if (event.kind === 'plan') {
    nodes.push(planCard(event.ticket_id, data));
  } else if (event.kind === 'question_result') {
    view.cards.get(data.id)?.markSettled();
  } else if (event.kind === 'strike') {
    // strike_text: redraw the message it struck, wherever it shows now (a bubble or a folded update).
    for (const el of log.querySelectorAll(`[data-body="${data.event}"]`)) el.replaceWith(messageBody(el.source, data.strikes, el.ticketId, data.event));
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
    const short = shortNote(data.text);
    if (short != null) nodes.push(h('div', { class: 'note', title: short === data.text ? null : data.text }, threadRefs(short)));
  } else if (event.kind === 'error') {
    nodes.push(h('div', { class: 'note error' }, data.text));
  } else if (event.kind === 'claude') {
    if (data.type === 'system' && data.subtype === 'init') {
      // Every turn re-inits the same session; only announce the first.
      if (!view.sawInit) nodes.push(h('div', { class: 'note' }, `Session started${data.model ? ` · ${data.model}` : ''}`));
      view.sawInit = true;
    } else if (data.type === 'assistant') {
      for (const block of data.message?.content ?? []) {
        if (block.type === 'text' && block.text.trim()) {
          const body = messageBody(block.text, data.strikes, event.ticket_id, event.id);
          const msg = h('div', { class: 'msg' }, h('div', { class: 'who' }, 'Claude'), body);
          nodes.push(msg);
          (view.turnTexts ??= []).push({ el: msg, body });
        } else if (block.type === 'tool_use') {
          // Words followed by more work were narration; words that lead into a question card stay.
          if (block.name === 'mcp__thread__ask_question' || block.name === 'mcp__thread__propose_plan') view.turnTexts = [];
          else fold = true;
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

  log.append(...nodes);
  if (fold) foldNarration(event.ticket_id);
  renderTyping();
  if (scroll && followChat) scrollToBottom();
}

/**
 * Claude's in-between remarks ("Worktree is behind main; merging.") leave the chat for one folded
 * "updates along the way" row per turn, where the first of them was; the turn's last words stay a
 * bubble. While the turn runs, the newest remark also shows in the working line.
 */
function foldNarration(ticketId) {
  const texts = view.turnTexts?.splice(0) ?? [];
  if (!texts.length) return;
  if (!view.narrationEl?.isConnected) {
    view.narrationEl = h('details', { class: 'narration' }, h('summary', {}), h('div', { class: 'notes' }));
    texts[0].el.before(view.narrationEl);
  }
  const notes = view.narrationEl.querySelector('.notes');
  for (const t of texts) {
    t.el.remove();
    notes.append(h('div', { class: 'note-text' }, t.body));
  }
  const n = notes.childElementCount;
  view.narrationEl.querySelector('summary').replaceChildren(
    h('span', { class: 'st' }, '⋯'), ` ${n} update${n === 1 ? '' : 's'} along the way`);
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

/** "✓ Approved by Cara", "✗ Denied by Cara", "⌛ Expired, not run: …". */
function approvalOutcome(r) {
  if (r.state === 'allowed') return `✓ Approved by ${r.by}`;
  if (r.state === 'denied') return `✗ Denied by ${r.by}`;
  return `⌛ Expired, not run: ${r.reason}`;
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
  const approve = h('button', { type: 'button', class: 'small' }, 'Approve');
  const deny = h('button', { type: 'button', class: 'small secondary' }, 'Deny');
  const el = h('div', { class: 'qcard acard' },
    h('div', { class: 'who' }, 'Claude asks to run'),
    h('div', { class: 'qtitle' }, h('span', { class: 'chip' }, card.tripwire ? 'Tripwire' : 'Needs approval'), toolTitle(card.tool)),
    typeof input.description === 'string' ? h('div', { class: 'desc' }, card.tripwire ? `Why: ${input.description}` : input.description) : '',
    h('pre', { class: 'acmd' }, lead ? input[lead] : JSON.stringify(input, null, 2)),
    Object.keys(rest).length ? h('pre', { class: 'acmd extra' }, JSON.stringify(rest, null, 2)) : '',
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
      status.textContent = approvalOutcome(r);
    },
  });
  return el;
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
    h('div', { class: 'who' }, 'Claude proposes a plan'),
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
        scrollToBottom();
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
        scrollToBottom();
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
    h('div', { class: 'who' }, 'Claude asks'),
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
  const scheme = author.match(/^Taskmaster of (.+)$/)?.[1];
  if (scheme) return `${scheme} Taskmaster`;
  return author === APP_AUTHOR || author === GITHUB_NAME || /^#\d+ /.test(author) ? author : null;
}

/** A chat message from a person; `about`, for a comment on a file, links that file. */
/** A message still queued for the next turn says so, with a ✕ to take it back; it loses both once sent. */
function markQueued(bubble, ticket) {
  const id = Number(bubble.dataset.event);
  const queued = !!ticket?.queued_ids?.includes(id);
  const tag = bubble.querySelector('.queued-tag');
  if (!queued) return tag?.remove();
  if (tag) return;
  bubble.querySelector('.who').append(h('span', { class: 'msg-tag queued-tag' }, 'queued for the next turn',
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

export function userBubble(author, text, imageSrcs, about = null, event = null) {
  const github = author === GITHUB_NAME;
  const preview = (text ?? '').replace(/[#*_`>\[\]~]/g, '').replace(/\s+/g, ' ').trim();
  const msg = h('div', { class: github ? 'msg user github' : 'msg user' }, h('div', { class: 'who' }, author,
    about ? [' on ', h('a', { class: 'about', href: fileHref(about.ticketId, about.path), title: about.path }, about.name)] : ''));
  // GitHub's messages end lines with bare URLs, which Markdown alone would leave as text.
  if (github && text) text = text.replace(/(^|\s)(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]])/g, '$1[$2]($2)');
  if (text) msg.append(event ? messageBody(text, event.strikes, null, event.id) : markdown(text));
  if (imageSrcs.length) {
    msg.append(h('div', { class: 'images' }, imageSrcs.map((src) =>
      h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { src, alt: 'Attached image', loading: 'lazy' })))));
  }
  // Messages between Claudes and from the app aren't meant for people, so they start folded to one line.
  const who = machineAuthor(author);
  if (who) {
    msg.querySelector('.who').remove();
    return h('details', { class: 'msg user coord' }, h('summary', {}, h('span', { class: 'who' }, who), h('span', { class: 'preview' }, preview)), msg);
  }
  return msg;
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
 * The working line under the chat while a turn runs: what's running right now, how long the turn
 * has gone, and Claude's newest remark below. The plan step sits in the thread bar's readout just
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
  const current = running && initSeen();
  const last = current && view.turnActions.at(-1);
  const busy = last && !last.result;
  const doing = busy ? actionLabel(last.block) : 'thinking…';
  const sep = () => h('span', { class: 'sep' }, '·');
  el.title = 'Show the work so far';
  // Only once folded away, so a remark that is still a bubble isn't said twice.
  const said = current && view.turnNote && !view.turnTexts?.length ? firstSentence(view.turnNote, 200) : '';
  el.replaceChildren(
    h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
    h('span', { class: 'lines' },
      h('span', { class: 'line' },
        h('span', { class: 'lead' }, t.approvals ? 'Waiting for someone to approve or deny' : running ? 'Claude is working' : 'Claude is thinking…'),
        running && !t.approvals ? [sep(), h('span', { class: 'what' }, doing)] : '',
        running && t.turnStartedAt ? [sep(), h('span', { class: 'time', 'aria-hidden': 'true' }, elapsedText(Date.now() - t.turnStartedAt))] : '',
        t.queued ? [sep(), h('span', { class: 'queued', title: `${t.queued} message${t.queued === 1 ? '' : 's'} queued for the next turn` }, `${t.queued} queued`)] : ''),
      said ? h('span', { class: 'said' }, said) : ''));
  if (wasHidden && followChat) scrollToBottom();
}

/** Ticks the turn timer without rebuilding the line (and without re-announcing it to screen readers). */
setInterval(() => {
  const time = view?.typingEl?.querySelector('.time');
  const at = view?.ticket?.turnStartedAt;
  if (time && at && !view.typingEl.hidden) time.textContent = elapsedText(Date.now() - at);
}, 1000);
