// The cards in a chat that wait on a person: approval (and merge), plan, loop and question cards.
// appendEvent in thread.js builds them, and each registers itself in view.cards so later events settle it.
import { account, ago, api, fileHref, fileKind, fileUrl, h, isCoordinator, me, taskmasterLabel, taskmasterName, view } from './base.js';
import { catchUpEvents, markdown, threadRefs } from './core.js';
import { optimistic } from './ui/optimistic.js';
import { changesLine, collapseRuns, planChanges } from './plan-diff.js';
import { adoptTicket } from './thread.js';
import { refreshViewerBar, setViewerGallery } from './artifacts.js';

/**
 * Who Claude speaks as in this chat: the scheme's Taskmaster in its own chat ("The Delve Taskmaster
 * asks"), else the minion ("Your Minion asks").
 */
export function speaker(doing = '') {
  if (!view.ticket || !isCoordinator(view.ticket)) return doing ? `Your Minion ${doing}` : 'Your Minion';
  return doing ? ['The ', taskmasterLabel(view.ticket.project_id), ` ${doing}`] : taskmasterLabel(view.ticket.project_id);
}

/**
 * A card's header line: who asks, and on a card addressed to one person (#687) whom, with how long it has
 * waited on them ("Your Minion asks Josh · waiting on Josh, 4m"), until done() says how it ended. `opts.at` is
 * when the card was posted.
 */
function whoLine(doing, card, opts = {}) {
  const verb = card.to ? `${doing} ${card.to === me ? 'you' : card.to}` : doing;
  const wait = h('span', { class: 'to-wait' }, card.to ? ` · waiting on ${card.to === me ? 'you' : card.to}${opts.at ? `, ${ago(opts.at).replace(/ ago$/, '')}` : ''}` : '');
  return {
    el: h('div', { class: 'who' }, speaker(verb), wait),
    done(text) {
      if (!card.to) return;
      wait.textContent = ` · ${text}`;
      wait.classList.add('done');
    },
  };
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
export function approvalCard(ticketId, card) {
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
  // Shown as decided at once; the server's outcome (settle) replaces it, and a refusal opens the card again.
  const decide = (allow) => {
    if (settled) return;
    optimistic({
      key: `card:${card.id}`,
      apply: () => {
        approve.hidden = deny.hidden = true;
        status.textContent = allow ? 'Approved' : 'Denied';
      },
      send: () => api(`api/tickets/${ticketId}/approve`, { method: 'POST', body: { approvalId: card.id, allow } }),
      undo: (ex) => {
        if (settled) return;
        // An expired or already-settled card stays shut; anything else can be tried again.
        if (/expired|already/.test(ex?.message)) return void (status.textContent = ex.message);
        approve.hidden = deny.hidden = false;
        status.textContent = '';
      },
      label: allow ? 'approve that call' : 'deny that call',
    }).then(() => view?.id === ticketId && catchUpEvents().catch(() => {}), () => {});
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

// A plan only moves forward: pending, then sent back, then superseded; approved (and a machine's notes rejected) is final.
const PLAN_RANK = { pending: 0, revising: 1, approved: 2, rejected: 2, superseded: 2 };

/** "✓ Approved by Cara · Tue 14:05", "✎ Cara asked for changes", "✗ Rejected by Cara", "Superseded by a newer plan". */
function planOutcome(r, machine) {
  const when = r.at ? ` · ${new Date(r.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
  if (r.status === 'approved') return `✓ Approved by ${r.by}${when}`;
  if (r.status === 'revising') return `✎ ${r.by} asked for changes${when}`;
  if (r.status === 'rejected') return `✗ Rejected by ${r.by}${when}`;
  return machine ? 'Superseded by a newer proposal' : 'Superseded by a newer plan';
}

/** A machine's notes card (#617): what changes, with the whole new text behind a toggle. */
function notesBody(card) {
  const diff = card.diff ?? [];
  const n = (op) => diff.filter((d) => d.op === op).length;
  return [
    h('div', { class: 'muted small' }, `What every scheme using ${card.machine.name} reads as its owner's notes. +${n('+')} −${n('-')} lines`),
    h('pre', { class: 'instructions-diff' }, ...diff.map((d) => h('div', { class: d.op === '+' ? 'add' : d.op === '-' ? 'del' : 'gap' }, d.op === '…' ? '…' : `${d.op} ${d.text}`))),
    h('details', {}, h('summary', {}, 'The whole new notes'), h('pre', { class: 'instructions-diff' }, card.plan || '(none)')),
  ];
}

/** A revised plan (#907): what changed against the plan it replaces, the unchanged stretches behind a toggle, the whole plan one tap away. */
function revisionBody(card, prev, ticketId) {
  const c = planChanges(prev.plan, card.plan, prev.summary, card.summary);
  const row = (op, text) => h('div', { class: op === '+' ? 'add' : op === '-' ? 'del' : 'same' }, `${op === ' ' ? '\u00a0' : op} ${text}`);
  const runs = collapseRuns(c.ops).map((r) => r.gap
    ? h('details', { class: 'gap' }, h('summary', {}, `${r.gap.length} unchanged line${r.gap.length === 1 ? '' : 's'}`), ...r.gap.map((o) => row(' ', o.text)))
    : row(r.op, r.text));
  return [
    h('div', { class: 'rev-head' }, h('b', {}, 'Changed since the last version'), ` · ${changesLine(c)}`),
    c.summaryChanged ? h('div', { class: 'rev-summary' }, h('s', {}, prev.summary), ' → ', card.summary) : null,
    h('div', { class: 'instructions-diff rev-diff' }, ...runs),
    h('details', {}, h('summary', {}, 'The whole plan'), h('div', {}, markdown(card.plan, ticketId))),
  ];
}

/**
 * A plan from Claude waiting for a go: Approve sends it, Revise opens a box for notes that go back
 * to Claude, which answers with a new card. Only people can decide; the card keeps its outcome.
 */
export function planCard(ticketId, card, opts = {}) {
  // A machine's notes card (#617): only its owner or an admin approves; anyone may reject, with an optional reason.
  const m = card.machine;
  // A release key card (#837): approved or rejected like a machine's notes, by any member of the app's scheme.
  const k = card.releaseKey;
  const fixed = m || k;
  const mayApprove = !m || !!account?.admin || (m.owner != null && m.owner === me);
  // Said beside the greyed-out Approve, not only in its tooltip, so a phone or keyboard shows why.
  const hint = mayApprove ? '' : `Only ${m.owner ? `${m.owner} (its owner)` : 'an admin'}${m.owner ? ' or an admin' : ''} can approve`;
  const status = h('span', { class: 'muted', role: 'status' });
  const why = h('div', { class: 'muted small', hidden: !hint }, hint);
  const approve = h('button', { type: 'button', class: 'small', disabled: !mayApprove, title: hint || null }, 'Approve');
  const revise = h('button', { type: 'button', class: 'small secondary' }, fixed ? 'Reject' : 'Revise');
  const notes = h('textarea', { class: 'pnotes', rows: 3, maxlength: 10000, placeholder: fixed ? 'Why? (optional)' : 'What should change?', hidden: true });
  const cancel = h('button', { type: 'button', class: 'small secondary', hidden: true }, 'Cancel');
  const sendNotes = h('button', { type: 'button', class: 'small', hidden: true, disabled: !fixed }, fixed ? 'Reject' : 'Send notes');
  // Diffed against the plan before it unless that one was approved: a later plan after a go is new work, not a revision.
  const prev = fixed || view.lastPlan?.handle.status === 'approved' ? null : view.lastPlan;
  const mine = { plan: card.plan ?? '', summary: card.summary ?? '', handle: null };
  if (!fixed) view.lastPlan = mine;
  const head = whoLine(m ? 'proposes machine notes' : k ? 'asks for a release key' : card.to ? 'proposes a plan to' : 'proposes a plan', card, opts);
  const el = h('div', { class: 'qcard pcard' },
    head.el,
    h('div', { class: 'qtitle' }, h('span', { class: 'chip' }, m ? 'Machine notes' : k ? 'Release key' : 'Plan'), card.summary),
    h('div', { class: 'pbody' }, m ? notesBody(card) : prev ? revisionBody(card, prev, ticketId) : markdown(card.plan, ticketId)),
    notes, why,
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
  // Shown as decided at once; the server's outcome (settle) replaces it, and a refusal opens the card again as it was.
  let deciding = false;
  const decide = (verdict) => {
    if (rank || deciding) return;
    const text = notes.value.trim();
    optimistic({
      key: `card:${card.id}`,
      apply: () => {
        deciding = true;
        editing(false);
        approve.hidden = revise.hidden = true;
        el.classList.add('answered');
        why.hidden = true;
        status.textContent = verdict === 'approve' ? (k ? 'Making the key…' : 'Approved') : fixed ? 'Rejected' : 'Revision sent';
      },
      send: () => api(`api/tickets/${ticketId}/verdict`, { method: 'POST', body: { planId: card.id, verdict, notes: text } }),
      undo: () => {
        deciding = false;
        if (rank) return;
        el.classList.remove('answered');
        approve.hidden = revise.hidden = false;
        why.hidden = !hint;
        status.textContent = '';
        if (verdict === 'revise') editing(true);
      },
      label: m ? `${verdict === 'approve' ? 'approve' : 'reject'} the notes for ${m.name}` : k ? `${verdict === 'approve' ? 'make' : 'reject'} ${k.title}'s release key` : verdict === 'approve' ? `approve the plan "${card.summary}"` : `send the revision notes`,
    }).then((ticket) => adoptTicket(ticketId, ticket), () => {}); // a failure already said so in its toast
  };
  approve.addEventListener('click', () => decide('approve'));
  revise.addEventListener('click', () => editing(true));
  cancel.addEventListener('click', () => editing(false));
  sendNotes.addEventListener('click', () => decide('revise'));
  notes.addEventListener('input', () => { sendNotes.disabled = !fixed && !notes.value.trim(); });
  notes.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (fixed || notes.value.trim())) { e.preventDefault(); decide('revise'); }
  });
  const handle = {
    el,
    status: card.status,
    settle(r) {
      // The stored card already has its latest outcome, so replayed older results are ignored.
      if ((PLAN_RANK[r.status] ?? 0) <= rank) return;
      rank = PLAN_RANK[r.status];
      handle.status = r.status;
      editing(false);
      el.classList.add('answered', `p-${r.status}`);
      why.hidden = true;
      approve.hidden = revise.hidden = true;
      status.textContent = planOutcome(r, fixed);
      if (r.by) head.done(`${r.status === 'approved' ? 'approved' : 'sent back'} by ${r.by}`);
    },
  };
  mine.handle = handle;
  view.cards.set(card.id, handle);
  if (card.status !== 'pending') handle.settle(card);
  return el;
}

/** The loop guard held a Taskmaster↔minion message: what it held, and Continue to let it through. */
export function loopCard(data) {
  const status = h('span', { class: 'muted', role: 'status' });
  const go = h('button', { type: 'button', class: 'small' }, 'Continue');
  go.addEventListener('click', () => optimistic({
    key: `continue:${data.minion}`,
    apply: () => {
      go.closest('.qcard').classList.add('answered');
      go.hidden = true;
      status.textContent = 'Continued';
    },
    send: () => api(`api/tickets/${data.minion}/continue`, { method: 'POST' }),
    undo: () => {
      go.closest('.qcard').classList.remove('answered');
      go.hidden = false;
      status.textContent = '';
    },
    label: 'let that message through',
  }));
  return h('div', { class: 'qcard lcard', 'data-minion': data.minion },
    h('div', { class: 'qtitle' }, h('span', { class: 'chip' }, 'Needs a person'), threadRefs(data.text)),
    h('div', { class: 'row' }, status, h('span', { class: 'spacer' }), go));
}

/**
 * A running turn passed a spend stage (#723): its estimated cost, Stop (the chat's own stop) and Keep going (no more
 * alerts this turn). The buttons show only while its own turn runs (`stale` from thread.js, cards.css), and both name
 * that turn so the server refuses them on a later one; a `spend_muted` event settles every card of its turn.
 */
export function spendCard(data, ticketId, current) {
  const status = h('span', { class: 'muted', role: 'status' });
  const stop = h('button', { type: 'button', class: 'small secondary' }, 'Stop');
  const keep = h('button', { type: 'button', class: 'small' }, 'Keep going');
  const el = h('div', { class: `qcard scard${data.turn === current ? '' : ' stale'}`, 'data-turn': data.turn },
    h('div', { class: 'qtitle' }, h('span', { class: 'chip' }, `Over $${data.stage}`), data.text),
    h('div', { class: 'row' }, status, h('span', { class: 'spacer' }), stop, keep));
  const act = (word, path, label) => optimistic({
    key: `spend:${path}:${ticketId}:${data.turn}`,
    apply: () => {
      el.classList.add('answered');
      stop.hidden = keep.hidden = true;
      status.textContent = word;
    },
    send: () => api(`api/tickets/${ticketId}/${path}`, { method: 'POST', body: { turn: data.turn } }),
    undo: () => {
      el.classList.remove('answered');
      stop.hidden = keep.hidden = false;
      status.textContent = '';
    },
    label,
  });
  stop.addEventListener('click', () => act('Stopping…', 'spend-stop', 'stop the turn'));
  keep.addEventListener('click', () => act('Keeping going: no more alerts this turn', 'spend-mute', 'mute the spend alerts'));
  return el;
}

/** Keep going was picked on a turn's spend card, here or on another device: settle all of that turn's cards. */
export function settleSpend(log, data) {
  for (const el of log.querySelectorAll(`.scard[data-turn="${Number(data.turn)}"]`)) {
    el.classList.add('answered');
    for (const b of el.querySelectorAll('button')) b.hidden = true;
    el.querySelector('[role=status]').textContent = `${data.by} picked Keep going: no more alerts this turn`;
  }
}

// ---------- question cards ----------

/** "→ Tabs · keep both" lines for an answer message: the picks, then any text typed with them. */
export function answerSummary(answers) {
  return h('div', { class: 'answer-lines' }, answers.map((a) =>
    h('div', {}, '→ ', [...a.selected, ...(a.other ? [a.other] : [])].join(' · '))));
}

/** Whether any message or card sits below this card in the chat. */
export function messagesBelow(el) {
  for (let n = el.nextElementSibling; n; n = n.nextElementSibling) if (n.matches('.msg, .qcard')) return true;
  return false;
}

/** "Cara picked Tabs ↑" at the bottom of the chat, jumping back up to the card it answered. */
export function answerRef(cardEl, data) {
  if (data.answer?.secret) return answerRefButton(cardEl, `${data.author} saved the secret as ${data.answer.secret}`);
  const picks = data.answer?.answers.map((a) => [...a.selected, ...(a.other ? [a.other] : [])].join(', ')).join(' · ');
  return answerRefButton(cardEl, picks == null ? `${data.author} approved the plan` : `${data.author} picked ${picks}`);
}

function answerRefButton(cardEl, text) {
  return h('div', { class: 'answer-ref' }, h('button', {
    type: 'button', title: 'Show the card',
    onclick: () => cardEl.scrollIntoView({ block: 'center', behavior: 'smooth' }),
  }, `${text} ↑`));
}

/**
 * A card of multiple-choice questions from Claude. Click options to pick (several when the question
 * allows), and type your own answer or add to the pick in the box under them; only Send (or Enter in the box)
 * sends, so text can follow a click (Cara, 2026-11-14, "Wait for Send"). On a card with pictures (#634; Cara,
 * 2026-11-12: "clicking it anywhere should show the image to you"; Josh, 2026-11-13: "clicking should still
 * select them") a click selects the option and opens its picture.
 */
// Picks not yet sent, by card id, so a card keeps them while you look at an option's picture.
const cardPicks = new Map();

export function questionCard(ticketId, card, opts = {}) {
  if (card.notice) return noticeCard(ticketId, card, opts);
  if (card.doc) return docCard(ticketId, card, opts);
  if (card.secret) return secretCard(ticketId, card, opts);
  if (!cardPicks.has(card.id)) cardPicks.set(card.id, card.questions.map(() => ({ selected: new Set(), other: '' })));
  const picks = cardPicks.get(card.id);
  const single = card.questions.length === 1 && !card.questions[0].multiSelect;
  const pictures = card.questions.some((q) => q.options.some((o) => o.image));
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
    if (pictures) refreshViewerBar();
  };
  // Shown as answered at once; the server's echo (markAnswered) confirms it, and a refusal opens the card again with the picks kept.
  let confirmed = false; // answered or settled by the server, so a failed send leaves it shut
  const lock = (on) => {
    answered = on;
    el.classList.toggle('answered', on);
    for (const input of el.querySelectorAll('.opt:not(.pic), .other')) input.disabled = on;
    sendBtn.hidden = on;
    if (pictures) refreshViewerBar();
  };
  // Once the picks are complete, bring the Send button clear of the sticky message box: on a phone it
  // sat under it, and the only Send on screen sent a chat message instead of the answer.
  const revealSend = () => {
    if (sendBtn.disabled) return;
    const box = document.querySelector('.composer');
    sendBtn.style.scrollMarginBottom = `${(box?.offsetHeight || 0) + 12}px`;
    sendBtn.scrollIntoView({ block: 'nearest' });
  };
  const send = () => {
    if (answered || !ready()) return;
    const answers = picks.map((p) => ({ selected: [...p.selected], other: p.other.trim() }));
    optimistic({
      key: `card:${card.id}`,
      apply: () => {
        lock(true);
        status.textContent = `Answered by ${me}`;
      },
      send: () => api(`api/tickets/${ticketId}/answer`, { method: 'POST', body: { questionId: card.id, answers } }),
      undo: () => {
        if (confirmed) return;
        lock(false);
        status.textContent = '';
        refresh();
      },
      label: 'send your answer',
    }).then((ticket) => adoptTicket(ticketId, ticket), () => {}); // a failure already said so in its toast
  };
  sendBtn.addEventListener('click', send);

  const head = whoLine('asks', card, opts);
  el.append(
    head.el,
    ...card.questions.map((q, i) => {
      // Sent along with the pick, or alone (Cara, 2026-11-14: "Cards should always pass along the text in addition to the selection").
      const other = h('input', { type: 'text', class: 'other', placeholder: 'Type your own answer or expand on the selection', maxlength: 2000, value: picks[i].other });
      other.addEventListener('input', () => {
        picks[i].other = other.value;
        refresh();
      });
      other.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send(); }
      });
      const choose = (o) => {
        if (answered) return;
        const sel = picks[i].selected;
        // A picked option unpicks on a second click, on single-pick questions too (Cara, 2026-11-16).
        if (q.multiSelect || sel.has(o.label)) sel.has(o.label) ? sel.delete(o.label) : sel.add(o.label);
        else {
          sel.clear();
          sel.add(o.label);
        }
        refresh();
        revealSend();
      };
      // Opening a picture hands the viewer this question's pictures, to step through and pick from; a
      // click that opens it in a new tab instead leaves the viewer as it is.
      const pictured = q.options.filter((o) => o.image);
      const browse = (o) => (e) => {
        if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        // Selects, never unselects: a second look at a picked option on a pick-any question keeps it.
        if (!picks[i].selected.has(o.label)) choose(o);
        setViewerGallery({
          ticketId, at: pictured.indexOf(o), answered: () => answered,
          options: pictured.map((o) => ({
            path: o.image, label: o.label, picked: () => picks[i].selected.has(o.label), pick: () => { if (q.multiSelect || !picks[i].selected.has(o.label)) choose(o); },
          })),
        });
      };
      // A picture option's button selects it and opens its picture, as its thumbnail does; the rest only pick.
      // A picked option's button unpicks it in place, like a checkbox (Cara, 2026-11-14:
      // "Multi select image cards cant be unselected"); its thumbnail still only looks.
      const pickBtn = (o, thumb) => h('button', {
        type: 'button', class: `opt${thumb ? ' pic' : ''}`, 'data-label': o.label,
        onclick: () => {
          const unpick = !answered && picks[i].selected.has(o.label);
          thumb && !unpick ? thumb.click() : choose(o);
        },
      }, h('span', { class: 'label' }, o.label, o.recommended ? h('span', { class: 'rec' }, ' (Recommended)') : ''), o.description ? h('span', { class: 'desc' }, o.description) : '');
      // With pictures, the options are a gallery of tiles, each a thumbnail over its label.
      const gallery = q.options.some((o) => o.image);
      return h('div', { class: 'q', 'data-q': i },
        h('div', { class: 'qtitle' }, q.header ? h('span', { class: 'chip' }, q.header) : '', q.question,
          q.multiSelect ? h('span', { class: 'muted' }, ' (pick any)') : ''),
        gallery
          ? h('div', { class: 'opts gallery' }, q.options.map((o) => {
            const thumb = o.image && optionThumb(ticketId, o, browse(o));
            return h('div', { class: 'tile' }, thumb || h('div', { class: 'thumb none' }, 'No picture'), pickBtn(o, thumb));
          }))
          : h('div', { class: 'opts' }, q.options.map((o) => pickBtn(o))),
        other);
    }),
    h('div', { class: 'row' }, status, h('span', { class: 'spacer' }), sendBtn));
  refresh();

  const handle = {
    el,
    markAnswered(answers, author) {
      answered = confirmed = true;
      el.classList.add('answered');
      answers.forEach((a, i) => {
        picks[i].selected = new Set(a.selected);
        const other = el.querySelector(`[data-q="${i}"] .other`);
        other.value = a.other ?? '';
        other.hidden = !a.other;
        other.disabled = true;
      });
      for (const btn of el.querySelectorAll('.opt:not(.pic)')) btn.disabled = true;
      sendBtn.hidden = true;
      status.textContent = `Answered by ${author}`;
      head.done(`answered by ${author}`);
      refresh();
    },
    // The minion took a typed reply as the answer (settle_question).
    markSettled() {
      answered = confirmed = true;
      el.classList.add('answered');
      for (const input of el.querySelectorAll('.opt:not(.pic), .other')) input.disabled = true;
      for (const other of el.querySelectorAll('.other')) other.hidden = true;
      sendBtn.hidden = true;
      status.textContent = 'Answered in the chat';
      head.done('settled in the chat');
      if (pictures) refreshViewerBar();
    },
  };
  view.cards.set(card.id, handle);
  if (card.settled) handle.markSettled();
  return el;
}

/**
 * A notice for one person (#687: ask_question with to and no questions): one line, and Got it for them, which
 * takes it out of their Needs-you list and sends the asker nothing. Anyone in the scheme can press it.
 */
function noticeCard(ticketId, card, opts) {
  const head = whoLine('tells', card, opts);
  const status = h('span', { class: 'muted' });
  const got = h('button', { type: 'button', class: 'small' }, 'Got it');
  const el = h('div', { class: 'qcard notice' }, head.el, h('div', { class: 'qtitle' }, card.notice),
    h('div', { class: 'row' }, status, h('span', { class: 'spacer' }), got));
  let seen = false;
  const handle = {
    el,
    markSettled(settled) {
      seen = true;
      got.hidden = true;
      el.classList.add('answered');
      status.textContent = '';
      head.done(settled?.by ? `seen by ${settled.by}` : 'settled in the chat');
    },
  };
  got.addEventListener('click', () => {
    if (seen) return;
    optimistic({
      key: `card:${card.id}`,
      apply: () => { seen = true; got.hidden = true; el.classList.add('answered'); head.done(`seen by ${me}`); },
      send: () => api(`api/tickets/${ticketId}/answer`, { method: 'POST', body: { questionId: card.id } }),
      undo: () => { seen = false; got.hidden = false; el.classList.remove('answered'); head.done(`waiting on ${card.to === me ? 'you' : card.to}`); },
      label: 'mark the notice seen',
    }).then((ticket) => adoptTicket(ticketId, ticket), () => {});
  });
  view.cards.set(card.id, handle);
  if (card.settled) handle.markSettled(card.settled);
  return el;
}

/**
 * A secret card (#838: ask_question with secret): a masked field whose value goes to the secret store
 * (POST /secret), never the chat; the minion hears only the name it was saved under. Not optimistic: the value
 * isn't kept anywhere to retry with, so the card waits for the server and keeps the field on a refusal.
 */
function secretCard(ticketId, card, opts) {
  const { name, scope, why } = card.secret;
  const head = whoLine('asks', card, opts);
  const input = h('input', { type: 'password', class: 'secret-value', autocomplete: 'off', spellcheck: 'false', 'aria-label': `The secret to save as ${name}`, placeholder: 'Paste or type it here' });
  const save = h('button', { type: 'button', class: 'small', disabled: true }, 'Save');
  const status = h('span', { class: 'muted' }, scope === 'scheme' ? 'Every turn in this scheme gets it' : 'Saved as yours: turns that run as you get it');
  const field = h('div', { class: 'row secret-row' }, input, save);
  const el = h('div', { class: 'qcard secret' }, head.el,
    h('div', { class: 'qtitle' }, 'A secret, saved as ', h('code', {}, name), why ? h('div', { class: 'desc' }, why) : ''),
    field, h('div', { class: 'row' }, status));
  let done = false;
  input.addEventListener('input', () => { save.disabled = done || !input.value; });
  const submit = () => {
    if (done || !input.value) return;
    done = true;
    save.disabled = input.disabled = true;
    status.textContent = 'Saving…';
    api(`api/tickets/${ticketId}/secret`, { method: 'POST', body: { questionId: card.id, value: input.value } }).then((ticket) => {
      input.value = '';
      adoptTicket(ticketId, ticket);
    }, (err) => {
      done = false;
      input.disabled = false;
      save.disabled = !input.value;
      status.textContent = `Not saved: ${err.message}`;
    });
  };
  save.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
  const handle = {
    el,
    markAnswered() {},
    markSettled(settled) {
      done = true;
      input.value = '';
      field.hidden = true;
      el.classList.add('answered');
      status.textContent = settled?.saved ? `Saved by ${settled.by}` : 'Settled in the chat';
      head.done(settled?.saved ? `saved by ${settled.by}` : 'settled in the chat');
    },
  };
  view.cards.set(card.id, handle);
  if (card.settled) handle.markSettled(card.settled);
  return el;
}

/**
 * A choices card (#804: ask_question with doc): it names a mock kit page and opens it in the viewer, where the
 * picks are made; it lists no options of its own, so it can't be mistaken for the page's choices. The page's
 * Send settles it (routes/files.ts, artifact-send).
 */
function docCard(ticketId, card, opts) {
  const head = whoLine('asks', card, opts);
  const status = h('div', { class: 'muted doc-status' }, 'Pick on the page, then press Send there');
  const href = fileHref(ticketId, card.doc.path);
  const open = h('a', { class: 'button doc-open', href }, 'Open the choices');
  // The page's top (#821, src/doc-preview.ts), its box kept from the start so the chat doesn't jump when
  // it loads; a page that can't be shot drops it and the card is just the button.
  const preview = h('a', { class: 'doc-preview', href, tabindex: '-1', 'aria-hidden': 'true' },
    h('img', { src: `api/tickets/${ticketId}/doc-preview?path=${encodeURIComponent(card.doc.path)}`, alt: '', onerror: () => preview.remove() }));
  const el = h('div', { class: 'qcard doc' }, head.el, h('div', { class: 'qtitle' }, card.doc.title), preview, open, status);
  const handle = {
    el,
    markSettled(settled) {
      el.classList.add('answered');
      open.classList.add('secondary');
      open.textContent = 'Open the page';
      status.textContent = settled?.sent ? `Picks sent by ${settled.by}` : 'Answered in the chat';
      head.done(settled?.sent ? `picks sent by ${settled.by}` : 'settled in the chat');
    },
  };
  view.cards.set(card.id, handle);
  if (card.settled) handle.markSettled(card.settled);
  return el;
}

/** A question option's picture: a thumbnail (muted and looping for video) that opens the file's full view. */
function optionThumb(ticketId, o, onclick) {
  const src = fileUrl(ticketId, o.image);
  let media = h('img', { src, alt: o.label, loading: 'lazy' });
  if (fileKind(o.image) === 'video') {
    media = h('video', { src, muted: true, autoplay: true, loop: true, playsinline: true, preload: 'metadata' });
    media.muted = true; // the attribute alone doesn't let it autoplay in every browser
  }
  return h('a', { class: 'thumb', href: fileHref(ticketId, o.image), title: `Open “${o.label}” full size`, onclick }, media);
}
