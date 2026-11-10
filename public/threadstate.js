// A minion's state pill as plain data, so node tests can import it: the list rows and the chat's
// head (sidebar.js, thread.js) build the nodes. `usage` and `now` come in as arguments.
import { STATES } from './base.js';

/** Rows that need you first (longest waiting at the top), then working, then waiting elsewhere, then parked. */
export function byUrgency(a, b, usage, now = Date.now()) {
  const sa = rowState(a, usage, now), sb = rowState(b, usage, now);
  if (sa.rank !== sb.rank) return sa.rank - sb.rank;
  return sa.rank === 0 ? (sa.since ?? a.updated_at) - (sb.since ?? b.updated_at) : b.updated_at - a.updated_at;
}

/**
 * A thread's state pill, coloured by family (one meaning each): you (amber, your move, with how
 * long it has waited), done (green), broken (red), work (blue, with steps done), wait (violet: the
 * usage reset, a deploy, CI), idle (grey: parked, dismissed). `cell` is the pill's text and `pulse`
 * says it gets the working dot.
 */
export function rowState(t, usage, now = Date.now()) {
  const steps = t.steps ? ` ${t.steps.done}/${t.steps.total}` : '';
  const waited = (word) => `${word} ${shortAgo(t.updated_at, now)}`;
  if (t.approvals) return { rank: 0, fam: 'you', cell: waited('approve'), label: 'Waiting for your approval' };
  // A minion parked on start_after is new (it hasn't run) but not working (#261).
  if (t.status === 'running' || (t.status === 'new' && !t.parked_for)) return { rank: 1, fam: 'work', cell: steps.trim() || 'working', pulse: true, counted: !!steps, label: 'Claude is working' };
  if (t.status === 'error' && t.state === 'limited') return limitState(t, waited, usage, now);
  if (t.status === 'error') return { rank: 0, fam: 'broken', cell: waited('stuck'), label: 'Stuck: the last turn failed' };
  if (t.status === 'closed') return { rank: 5, fam: 'idle', cell: 'dismissed', label: 'Dismissed' };
  const state = STATES[t.state];
  if (t.state === 'parked') return { rank: 4, fam: 'idle', cell: 'parked', label: state.label };
  if (t.state === 'outside' || t.state === 'pending-deploy') return { rank: 2, fam: 'wait', cell: `${t.state === 'outside' ? 'waiting' : 'deploying'}${steps}`, counted: !!steps, label: state.label };
  if (t.state === 'blocked') return { rank: 2, fam: 'broken', cell: 'blocked', label: state.label };
  // An open question or plan card is the more specific ask than ready, try it or reply; timed from when it was posted.
  if (t.pending_card_at) return { rank: 0, fam: 'you', cell: `? ${shortAgo(t.pending_card_at, now)}`, label: 'Waiting for you to answer a question or plan', since: t.pending_card_at };
  if (t.state === 'ready') return { rank: 0, fam: 'done', cell: waited('ready'), label: state.label };
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

/** Where a minion's change is (t.ship, src/branch.ts): its colour family, and its badge in the list (none on its branch). */
export const SHIP = {
  branch: { fam: 'idle', badge: '' },
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
