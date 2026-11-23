// A minion's head: its branch and pull request, people's note, pins, and the held-message, unpark and status actions.
import { presenceHead } from './presence.js';
import { gloss } from './help-words.js';
import { reloadQuietly, ago, api, dismissedWhen, h, icon, isCoordinator, me, threadFullName, threadLabel, threadTitleParts, view } from './base.js';
import { stopChat, stoppingIds, catchUpEvents, onTicketPin, threadRefs } from './core.js';
import { composerPlaceholder, renderModelPicker } from './composer.js';
import { renderSidebar } from './sidebar.js';
import { refreshInbox } from './inbox.js';
import { asleepChat, composerHint, heldLine } from './heldmsg.js';
import { SHIP, workingBy } from './threadstate.js';
import { propertyChip } from './properties.js';
import { onboardingStrip } from './settings.js';
import { optimistic } from './ui/optimistic.js';
import { replyChips } from './replies.js';
import { releaseChip } from './releases.js';
import { ultraButton } from './ultrareview.js';
import { payerLine } from './payer.js';
import { waitingStrip } from './waiting.js';
import { canBack, canForward, goBack, goForward } from './navstack.js';
import { markQueued } from './bubbles.js';
import { headState, narrow, scheduleProgress } from './progress-ui.js';
import { renderTyping, syncHeldBrief, tmBanner, tmViewSwitch } from './thread.js';

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
      const title = t.parked_for ? 'Start it now with its held brief and the messages left for it, without waiting for its leader\'s work' : 'Wake it now: it reads the messages left for it while sealed';
      unparkSlot.hidden = !parked;
      unparkSlot.replaceChildren(...(parked ? [
        h('button', { type: 'button', class: 'secondary act-unpark', title, onclick: () => unpark(t) }, 'Unseal'),
        h('button', { type: 'button', class: 'secondary act-send-unpark', title: 'Send your message and unseal it, so it reads the message now', onclick: () => form.sendAndUnpark?.() }, 'Send and unseal'),
      ] : []));
    }
    const hint = form.querySelector('.parked-hint');
    if (hint) {
      const text = coord ? null : composerHint(t);
      hint.hidden = !text;
      hint.replaceChildren(text ? h('span', { 'aria-hidden': 'true' }, asleepChat(t) && !text.includes('sealed') ? '🌙 ' : '⏸ ') : '', text ?? '');
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
  // Sleep (#1636) took Leave's place (Cara, 2026-11-22, "Replace Leave with Sleep"); /leave itself stays for the Taskmaster's routing.
  if (!coord && t.status !== 'closed') actions.unshift(sleepButton(t));
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
  const sigs = want.map(sigOf);
  want.forEach((c, i) => {
    let at = parent.childNodes[i];
    if (at === c) return;
    const sig = sigs[i];
    // A part gone from before this one: drop it, so this one and the rest line up again.
    while (at && !live.has(at) && at.sig !== sig && at.nextSibling?.sig === sig && !sigs.includes(at.sig, i + 1)) {
      const next = at.nextSibling;
      at.remove();
      at = next;
    }
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
    } else if (sigs.includes(at.sig, i + 1)) parent.insertBefore(c, at); // a part added before one that's kept
    else at.replaceWith(c);
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
  if (ticket.id !== ticketId && isCoordinator(ticket)) return void reloadQuietly();
  view.ticket = ticket;
  renderTicketHead();
  catchUpEvents().catch(() => {});
}

function sleepButton(t) {
  return t.asleep
    ? h('button', { type: 'button', class: 'secondary act-wake', title: 'Wake it: its cards and replies count in Needs you again, and keepalives resume', onclick: () => setAsleep(t, false) }, 'Wake')
    : h('button', { type: 'button', class: 'secondary act-sleep', title: "Put it to sleep: out of Needs you and no keepalives. Its cards stay answerable here, and a message or a card's answer wakes it", onclick: () => setAsleep(t, true) }, 'Sleep');
}

/** Sleep or wake (#1636): the head, the list and Needs you change at once; a refusal puts them back with a toast and a retry. */
export function setAsleep(t, on) {
  const was = t.asleep ?? null;
  const show = (v) => {
    for (const x of new Set([t, view?.tickets?.get(t.id), view?.ticket?.id === t.id && view.ticket])) if (x) x.asleep = v;
    renderSidebar();
    if (view?.id === t.id) renderTicketHead();
    refreshInbox();
  };
  return optimistic({
    sets: `sleep:${t.id}`,
    apply: () => show(on ? { at: Date.now(), by: me?.name ?? '' } : null),
    send: () => api(`api/tickets/${t.id}/sleep`, { method: 'POST', body: { asleep: on } }),
    undo: () => show(was),
    label: `${on ? 'put' : 'wake'} ${threadLabel(t)}${on ? ' to sleep' : ''}`,
  }).catch(() => {});
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
export function markHeld(bubble, ticket, last = true) {
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
    row.replaceChildren(h('span', { class: 'held-text' }, parked ? "Not sent yet: this minion is sealed, so it reads this when it's unsealed." : line.text));
    if (last) {
      const btn = parked
        ? h('button', { type: 'button', class: 'secondary small held-act', title: 'Wake it now: it reads the messages left for it' }, 'Unseal and send')
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
export function unpark(t) {
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
    label: `unseal ${threadLabel(t)}`,
  }).catch(() => {});
}

/** Dismiss (closed) or reopen (idle) a minion: shown at once in its head and the list, put back if the server says no. */
export function setStatus(t, status) {
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
