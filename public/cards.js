// The cards in a chat that wait on a person: approval (and merge), plan, loop and question cards.
// appendEvent in thread.js builds them, and each registers itself in view.cards so later events settle it.
import { account, api, fileHref, fileKind, fileUrl, h, isCoordinator, me, taskmasterLabel, taskmasterName, view } from './base.js';
import { catchUpEvents, markdown, threadRefs } from './core.js';
import { optimistic } from './ui/optimistic.js';
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

/**
 * A plan from Claude waiting for a go: Approve sends it, Revise opens a box for notes that go back
 * to Claude, which answers with a new card. Only people can decide; the card keeps its outcome.
 */
export function planCard(ticketId, card) {
  // A machine's notes card (#617): only its owner or an admin approves; anyone may reject, with an optional reason.
  const m = card.machine;
  const mayApprove = !m || !!account?.admin || (m.owner != null && m.owner === me);
  // Said beside the greyed-out Approve, not only in its tooltip, so a phone or keyboard shows why.
  const hint = mayApprove ? '' : `Only ${m.owner ? `${m.owner} (its owner)` : 'an admin'}${m.owner ? ' or an admin' : ''} can approve`;
  const status = h('span', { class: 'muted', role: 'status' });
  const why = h('div', { class: 'muted small', hidden: !hint }, hint);
  const approve = h('button', { type: 'button', class: 'small', disabled: !mayApprove, title: hint || null }, 'Approve');
  const revise = h('button', { type: 'button', class: 'small secondary' }, m ? 'Reject' : 'Revise');
  const notes = h('textarea', { class: 'pnotes', rows: 3, maxlength: 10000, placeholder: m ? 'Why? (optional)' : 'What should change?', hidden: true });
  const cancel = h('button', { type: 'button', class: 'small secondary', hidden: true }, 'Cancel');
  const sendNotes = h('button', { type: 'button', class: 'small', hidden: true, disabled: !m }, m ? 'Reject' : 'Send notes');
  const el = h('div', { class: 'qcard pcard' },
    h('div', { class: 'who' }, speaker(m ? 'proposes machine notes' : 'proposes a plan')),
    h('div', { class: 'qtitle' }, h('span', { class: 'chip' }, m ? 'Machine notes' : 'Plan'), card.summary),
    h('div', { class: 'pbody' }, m ? notesBody(card) : markdown(card.plan, ticketId)),
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
        status.textContent = verdict === 'approve' ? 'Approved' : m ? 'Rejected' : 'Revision sent';
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
      label: m ? `${verdict === 'approve' ? 'approve' : 'reject'} the notes for ${m.name}` : verdict === 'approve' ? `approve the plan "${card.summary}"` : `send the revision notes`,
    }).then((ticket) => adoptTicket(ticketId, ticket), () => {}); // a failure already said so in its toast
  };
  approve.addEventListener('click', () => decide('approve'));
  revise.addEventListener('click', () => editing(true));
  cancel.addEventListener('click', () => editing(false));
  sendNotes.addEventListener('click', () => decide('revise'));
  notes.addEventListener('input', () => { sendNotes.disabled = !m && !notes.value.trim(); });
  notes.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (m || notes.value.trim())) { e.preventDefault(); decide('revise'); }
  });
  const handle = {
    el,
    settle(r) {
      // The stored card already has its latest outcome, so replayed older results are ignored.
      if ((PLAN_RANK[r.status] ?? 0) <= rank) return;
      rank = PLAN_RANK[r.status];
      editing(false);
      el.classList.add('answered', `p-${r.status}`);
      why.hidden = true;
      approve.hidden = revise.hidden = true;
      status.textContent = planOutcome(r, m);
    },
  };
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

// ---------- question cards ----------

/** "Answered: Tabs · Other: keep both" lines for an answer message. */
export function answerSummary(answers) {
  return h('div', { class: 'answer-lines' }, answers.map((a) =>
    h('div', {}, '→ ', [...a.selected, ...(a.other ? [`Other: ${a.other}`] : [])].join(' · '))));
}

/** Whether any message or card sits below this card in the chat. */
export function messagesBelow(el) {
  for (let n = el.nextElementSibling; n; n = n.nextElementSibling) if (n.matches('.msg, .qcard')) return true;
  return false;
}

/** "Cara picked Tabs ↑" at the bottom of the chat, jumping back up to the card it answered. */
export function answerRef(cardEl, data) {
  const picks = data.answer?.answers.map((a) => [...a.selected, ...(a.other ? [a.other] : [])].join(', ')).join(' · ');
  const text = picks == null ? `${data.author} approved the plan` : `${data.author} picked ${picks}`;
  return h('div', { class: 'answer-ref' }, h('button', {
    type: 'button', title: 'Show the card',
    onclick: () => cardEl.scrollIntoView({ block: 'center', behavior: 'smooth' }),
  }, `${text} ↑`));
}

/**
 * A card of multiple-choice questions from Claude. Click options to pick (several when the question
 * allows), or type an answer under Other; a single one-pick question sends on the first click, unless the
 * card has pictures (#634; Cara, 2026-11-12: "Cards with images should never autosend, and clicking it anywhere
 * should show the image to you"; Josh, 2026-11-13: "clicking should still select them"): a click there selects
 * the option and opens its picture, and only Send sends.
 */
// Picks not yet sent, by card id, so a card keeps them while you look at an option's picture.
const cardPicks = new Map();

export function questionCard(ticketId, card) {
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
      const choose = (o) => {
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
        if (single && !pictures) send();
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
            path: o.image, label: o.label, picked: () => picks[i].selected.has(o.label), pick: () => choose(o),
          })),
        });
      };
      // A picture option's button selects it and opens its picture, as its thumbnail does; the rest only pick.
      const pickBtn = (o, thumb) => h('button', {
        type: 'button', class: `opt${thumb ? ' pic' : ''}`, 'data-label': o.label,
        onclick: () => (thumb ? thumb.click() : choose(o)),
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

  view.cards.set(card.id, {
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
      if (pictures) refreshViewerBar();
    },
  });
  if (card.settled) view.cards.get(card.id).markSettled();
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
