// A minion's state pill as plain data, so node tests can import it: the list rows and the chat's
// head (sidebar.js, thread.js) build the nodes. `usage` and `now` come in as arguments.
import { isCoordinator, STATES } from './base.js';
import { waitFam, waitShows } from './wait.js';

/** Rows that need you first (longest waiting at the top), then working, then waiting elsewhere, then parked until woken, then parked. */
export function byUrgency(a, b, usage, now = Date.now()) {
  const sa = rowState(a, usage, now), sb = rowState(b, usage, now);
  if (sa.rank !== sb.rank) return sa.rank - sb.rank;
  return sa.rank === 0 ? (sa.since ?? a.updated_at) - (sb.since ?? b.updated_at) : b.updated_at - a.updated_at;
}

/**
 * Whether a list row shows unread (a dot and a bold title): it changed since you last opened it and has something for a
 * person: your move, ready or complete, stuck or blocked. Never while it works, waits on a land, CI, a deploy or the usage
 * limit, or is parked or dismissed (#576; Cara, 2026-11-11: "isnt that for when there is something you need to do?").
 * By rank, not family: a wait recolours the chip (CI passed is green) without making it your move. `st` is its rowState.
 */
export const rowUnread = (t, st, seen) => !seen && (st.rank === 0 || (st.rank === 2 && t.state === 'blocked'));

/**
 * A thread's state pill, coloured by family (one meaning each): you (amber, your move, with how
 * long it has waited), done (green), broken (red), work (blue, with steps done), wait (violet: the
 * usage reset, a deploy, CI, parked until something wakes it), idle (grey: parked, dismissed). `cell` is the pill's text and `pulse`
 * says it gets the working dot.
 */
export function rowState(t, usage, now = Date.now()) {
  const st = baseState(t, usage, now);
  // While it works or waits elsewhere, the wait (#544) colours the chip; the chip keeps the plan's steps and the
  // row's subtitle says the wait in words (#551, Josh 2026-11-11: "What does "line 2nd" mean? that isnt a useful
  // progress indicator"), as its bar shows tests or jobs done.
  // The server's own work stays blue and pulsing all through, its line included: the track's hatched piece shows that (#727).
  if (!t.wait || t.status === 'closed' || (st.rank !== 1 && st.rank !== 2) || st.fam === 'broken' || st.server) return st;
  const fam = waitFam(t.wait);
  return { ...st, fam, pulse: fam === 'work' };
}

/**
 * Who is working on a minion or Taskmaster now (#727; Cara, 2026-11-14: "either of these (or any other potential
 * "working" in the future, would all still show in the minion list as an in progress working minion"): 'turn' while
 * its own turn runs (or a new minion's first turn sets up, not parked on start_after, #261), 'server' while the server
 * works for it with no turn (`t.server_work`: a handed-off land), else null. A new kind of server work joins through
 * server_work, not here.
 */
export function workingBy(t) {
  if (t.status === 'running' || (t.status === 'new' && !t.parked_for && !isCoordinator(t))) return 'turn';
  return t.status !== 'closed' && t.server_work ? 'server' : null;
}

/** Whose turn it is, in words (Cara, 2026-11-14: "This Minion is working" and "This Taskmaster is working"). */
export const workingLabel = (t, verb = 'working') => `This ${isCoordinator(t) ? 'Taskmaster' : 'Minion'} is ${verb}`;

/** The server's work in words, at its landing's stage (t.wait, src/waits.ts): "Server: testing (CI: the full suite)". */
export function serverLabel(w) {
  if (!w) return 'Server is landing…';
  if (w.stage === 'line') return `Server: in the land line${/ · (.+)$/.test(w.chip) ? ` (${w.chip.split(' · ').pop()})` : ''}`;
  if (w.stage === 'rebase') return 'Server: rebasing';
  if (['test', 'run', 'jobs', 'queued'].includes(w.stage)) return `Server: testing (${w.brief ?? w.text})`;
  if (w.stage === 'deploy') return 'Server: deploying';
  if (w.stage === 'restart' || w.stage === 'live') return 'Server: waiting for the restart';
  return 'Server is landing…';
}

function baseState(t, usage, now) {
  const steps = t.steps ? ` ${t.steps.done}/${t.steps.total}` : '';
  const waited = (word) => `${word} ${shortAgo(t.updated_at, now)}`;
  if (t.approvals) return { rank: 0, fam: 'you', cell: waited('approve'), label: 'Waiting for your approval' };
  // A minion parked on start_after is new (it hasn't run) but not working (#261).
  const by = workingBy(t);
  if (by === 'turn') return { rank: 1, fam: 'work', cell: steps.trim() || 'working', pulse: true, counted: !!steps, label: workingLabel(t) };
  // On its way in a release (#764, releases.js pendingRelease): the release's name where "landing" or "deploying" would be.
  const rel = t.release;
  const relLabel = rel ? `${rel.target} ${rel.name}: ${rel.stage}${rel.text ? `, ${rel.text}` : ''}` : '';
  if (by === 'server') return { rank: 1, fam: 'work', cell: rel?.name ?? 'landing', pulse: true, server: true, label: rel ? `${serverLabel(t.wait)} · ${relLabel}` : serverLabel(t.wait) };
  if (t.status === 'error' && t.state === 'limited') return limitState(t, waited, usage, now);
  if (t.status === 'error') return { rank: 0, fam: 'broken', cell: waited('stuck'), label: 'Stuck: the last turn failed' };
  // Dismissed once landed, its change not live yet (on main waiting for CI, a deploy): still on its way.
  if (t.status === 'closed' && rel) return { rank: 2, fam: 'wait', cell: rel.name, label: `On its way: ${relLabel}` };
  if (t.status === 'closed') return { rank: 5, fam: 'idle', cell: 'dismissed', label: 'Dismissed' };
  const state = STATES[t.state];
  // Parked until something wakes it by itself (start_after, wake_when_live, runners back) reads as waiting, not grey (Cara, 2026-11-14).
  if (t.state === 'parked' && t.wakes_on) return { rank: 3, fam: 'wait', cell: 'waiting', label: `Waiting: ${t.parked_for ? `starts when ${t.wakes_on}` : t.wakes_on}` };
  if (t.state === 'parked') return { rank: 4, fam: 'idle', cell: 'parked', label: state.label };
  if (t.state === 'pending-deploy' && rel) return { rank: 2, fam: 'wait', cell: rel.name, label: `${state.label} · ${relLabel}` };
  if (t.state === 'outside' || t.state === 'pending-deploy') return { rank: 2, fam: 'wait', cell: `${t.state === 'outside' ? 'waiting' : 'deploying'}${steps}`, counted: !!steps, label: state.label };
  if (t.state === 'blocked') return { rank: 2, fam: 'broken', cell: 'blocked', label: state.label };
  // An open question or plan card is the more specific ask than ready, try it or reply; timed from when it was posted.
  if (t.pending_card_at) return { rank: 0, fam: 'you', cell: `? ${shortAgo(t.pending_card_at, now)}`, label: 'Waiting for you to answer a question or plan', since: t.pending_card_at };
  if (t.state === 'ready') return { rank: 0, fam: 'done', cell: waited('ready'), label: state.label };
  // Complete carries what's left (nothing, or what to read) in its note, so the label says it at a glance (#547).
  if (t.state === 'complete') return { rank: 0, fam: 'done', cell: waited('complete'), label: t.note ? `Complete: ${t.note}` : state.label };
  if (t.state === 'try') return { rank: 0, fam: 'you', cell: waited('try it'), label: state.label };
  return { rank: 0, fam: 'you', cell: waited('reply'), label: 'Your move' };
}

/**
 * A minion that hit the usage limit: a countdown to its own resume when it has one, else a countdown while the account's limit is still hit, your move
 * once a later turn shows it has reset, and just "limit hit" when neither is known (the note says when).
 */
function limitState(t, waited, usage, now) {
  if (t.limit_resume_at) return { rank: 2, fam: 'wait', cell: `resumes ${shortIn(t.limit_resume_at, now)}`, label: 'Usage limit: resumes by itself' };
  const hit = [usage?.session, usage?.weekly].find((w) => w?.status === 'rejected' && w.resetsAt > now);
  if (hit) return { rank: 2, fam: 'wait', cell: `resets ${shortIn(hit.resetsAt, now)}`, label: STATES.limited.label };
  if (usage?.updatedAt > t.updated_at) return { rank: 0, fam: 'you', cell: waited('resume'), label: 'The usage limit has reset: send a message to carry on' };
  return { rank: 2, fam: 'wait', cell: 'limit hit', label: STATES.limited.label };
}

/** A track with one piece, not started: the bar's line while a working minion has no plan yet (#696). */
export const EMPTY_TRACK = [[null, 'p']];

/**
 * What a list row's bar (#573) is drawn from, or null for none: the plan's steps (`track`, and `done`/`total` from an
 * older server) while the minion works, and the `wait` (a land, CI, a deploy) while it works or after its turn. A row waiting on a person (a card,
 * an approval, ready, try it), blocked, parked or at the usage limit has none; the card badge flags a card (Cara,
 * 2026-11-11: "if a minion is asking a question it shouldnt have a progress bar right?"). `st` is its rowState.
 */
export function rowBar(t, st) {
  if (st.rank === 0 || t.status === 'closed') return null;
  // Rank 1 is working: running, or new and not parked on start_after (#261); the Taskmaster's idle row has no rank.
  const working = st.rank === 1, w = waitShows(t.wait) ? t.wait : null;
  // The plan's track and the wait together (#630): wait.js progressTrack draws the wait in the step underway.
  if (w && (working || t.state === 'outside' || t.state === 'pending-deploy')) return { ...(working && t.steps), track: working ? t.step_track ?? null : null, wait: w };
  if (!working) return null;
  // Before its task list exists, one empty piece holds the line's room, so the row doesn't grow when the steps arrive (#696).
  if (!t.steps) return { track: EMPTY_TRACK };
  return { ...t.steps, track: t.step_track ?? null };
}

/**
 * The open-card chip's text for a row's open_cards, oldest first (#575; Cara, 2026-11-11: "lets give them different
 * ones, question, merge, plan, etc"): the kind of ask (CardLink.what), counted when they're all one kind ("2 plans"),
 * else the oldest's kind and how many more ("plan +1"), as the chip opens the oldest.
 */
export function cardChip(cards) {
  const word = (c) => c.what ?? c.kind;
  const first = word(cards[0]);
  if (cards.length === 1) return first;
  return cards.every((c) => word(c) === first) ? `${cards.length} ${first}s` : `${first} +${cards.length - 1}`;
}

/** Where a minion's change is (t.ship, src/branch.ts): its colour family, and its badge in the list (none on its branch). */
export const SHIP = {
  branch: { fam: 'idle', badge: '' },
  build: { fam: 'work', badge: 'folded' }, // into its build branch: done for now, live when the build lands
  main: { fam: 'work', badge: 'on main' },
  deploying: { fam: 'wait', badge: 'deploying' },
  live: { fam: 'done', badge: 'live' },
  failed: { fam: 'broken', badge: 'deploy failed' },
};

/** "40m", "1h40", "14h", "2d": time left, for tight spaces. */
function shortIn(ms, now) {
  const m = Math.max(1, Math.ceil((ms - now) / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 600) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

/** "now", "5m", "3h", "2d": ages for tight spaces. */
function shortAgo(ms, now) {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
