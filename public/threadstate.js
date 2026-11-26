// A minion's state pill as plain data, so node tests can import it: the list rows and the chat's
// head (sidebar.js, thread.js) build the nodes. `usage` and `now` come in as arguments.
/** @import { CardLink, ListedTicket as Row, PlanUsage as Usage, RowState, TicketState, Wait, WorkerWait } from './types.js' */
/** @typedef {NonNullable<Row['activity']>} Activity */
/** @import { UsageWindow } from './types.js' */
import { isCoordinator, me, STATES, view, pacificClock, pacificWeekdayClock } from './base.js';
import { waitFam, waitShows, waitWords } from './wait.js';

/** Rows that need you first (longest waiting at the top), then working, then waiting elsewhere, then parked until woken, then parked. @param {Row} a @param {Row} b @param {Usage | null} [usage] @param {number} [now] */
export function byUrgency(a, b, usage, now = Date.now()) {
  const sa = rowState(a, usage, now),
    sb = rowState(b, usage, now);
  if (sa.rank !== sb.rank) return sa.rank - sb.rank;
  return sa.rank === 0 ? (sa.since ?? a.updated_at) - (sb.since ?? b.updated_at) : b.updated_at - a.updated_at;
}

/**
 * Whether a list row shows unread (a dot and a bold title): it changed since you last opened it and has something for a
 * person: your move, ready or complete, stuck or blocked. Never while it works, waits on a land, CI, a deploy or the usage
 * limit, or is parked or dismissed (#576; Cara, 2026-11-11: "isnt that for when there is something you need to do?").
 * By rank, not family: a wait recolours the chip (CI passed is green) without making it your move. `st` is its rowState.
 * @param {Row} t @param {RowState} st @param {unknown} seen
 */
export const rowUnread = (t, st, seen) => !seen && (st.rank === 0 || st.rank === LOOK || (st.rank === 2 && t.state === 'blocked'));

/**
 * A thread's state pill, coloured by family (one meaning each): you (amber: an answer of yours is owed, with how
 * long it has waited, and nothing else, #1121), done (green: done, read it), broken (red), work (blue: working, or
 * ready to try), wait (violet: waiting on another person's card, the usage reset, a deploy, CI, parked until
 * something wakes it), idle (grey: idle, parked, dismissed). `cell` is the pill's text and `pulse` says it gets the
 * working dot.
 * @param {Row} t @param {Usage | null} [usage] @param {number} [now] @returns {RowState}
 */
export function rowState(t, usage, now = Date.now()) {
  const st = baseState(t, usage, now);
  // While it works or waits elsewhere, the wait (#544) colours the chip; the chip keeps the plan's steps and the
  // row's subtitle says the wait in words (#551, Josh 2026-11-11: "What does "line 2nd" mean? that isnt a useful
  // progress indicator"), as its bar shows tests or jobs done.
  // The server's own work stays blue and pulsing all through, its line included: the track's hatched piece shows that (#727).
  if (!t.wait || t.status === 'closed' || (st.rank !== 1 && st.rank !== 2) || st.fam === 'broken' || st.server || st.quiet) return st;
  const fam = waitFam(t.wait);
  return { ...st, fam, pulse: fam === 'work' };
}

/**
 * Who is working on a minion or Taskmaster now (#727; Cara, 2026-11-14: "either of these (or any other potential
 * "working" in the future, would all still show in the minion list as an in progress working minion"): 'turn' while
 * its own turn runs (or a new minion's first turn sets up, not parked on start_after, #261), 'server' while the server
 * works for it with no turn (`t.server_work`: a handed-off land, or a job or wait it handed over, #1890), else null. A new kind of server work joins through
 * server_work, not here.
 * @param {Row} t @returns {'turn' | 'server' | null}
 */
export function workingBy(t) {
  // Nor one waiting on its start card (#1757): it hasn't run, and its card is a person's to answer.
  // Nor one waiting for the computer it is marked for (Build 7 T4): it is blocked.
  if (t.status === 'running' || (t.status === 'new' && !t.worker_wait?.machine && !t.parked_for && !t.start_hold && t.state !== 'parked' && !isCoordinator(t))) return 'turn';
  return t.status !== 'closed' && t.server_work ? 'server' : null;
}

/** Whose turn it is, in words (Cara, 2026-11-14: "This Minion is working" and "This Taskmaster is working"). */
/** @param {Row} t @param {string} [verb] */
export const workingLabel = (t, verb = 'working') => `This ${isCoordinator(t) ? 'Taskmaster' : 'Minion'} is ${verb}`;

/** @param {number} n */
const nth = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
/** A minion with a turn to start and no worker yet (#1868): it shows as working, and this is its one line of truth. `hold`: a person started it now (#1957). */
/** @param {WorkerWait} w @param {unknown} hold */
export const workerWaitLabel = (w, hold) =>
  hold && !w.machine ? (w.held ? `Waiting: ${w.held}` : 'Starting now, on a worker of its own') : w.paused ? `Waiting: ${w.paused} paused all minions` : w.machine ? `Waiting for ${w.machine.name}: ${w.machine.why}` : `Waiting for a worker, ${nth(w.place)} in line${w.quick ? ', or the quick lane' : ''}`;

/** @typedef {{ count: number, woken: number, cold: number, median: number | null }} WaitStats */

/** The waits that gave their worker back (#1890), and whether too many of their wakes came cold (past 10%). @param {WaitStats | null | undefined} w */
export function waitsLine(w) {
  /** @param {number} n @param {string} word */
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (!w?.count) return 'No waits handed over in the last 7 days';
  const cold = w.woken ? Math.round((w.cold / w.woken) * 100) : 0;
  return `${plural(w.count, 'wait')} gave their worker back in 7 days, the middle one ${span(/** @type {number} */ (w.median))}${w.woken ? ` · ${w.cold} of ${plural(w.woken, 'wake')} cold (${cold}%)` : ''}`;
}
/** @param {WaitStats | null | undefined} w */
export const tooCold = (w) => !!w?.woken && w.cold / w.woken > 0.1;

/** A job or a wait of its own that runs on past its turn (#1890, src/minion-jobs.ts): `{ text, since }`, or null. */
/** @param {Row} t */
export const jobOf = (t) => (t.status !== 'closed' && t.server_work?.kind === 'job' ? t.server_work : null);

/** The server's work in words, at its landing's stage (t.wait, src/waits.ts): "Server: testing (CI: the full suite)". */
/** @param {Wait | null} w */
export function serverLabel(w) {
  if (!w) return 'Server is shipping…';
  if (w.stage === 'line') return `Server: in the ship line${/ · (.+)$/.test(w.chip) ? ` (${w.chip.split(' · ').pop()})` : ''}`;
  if (w.stage === 'rebase') return 'Server: rebasing';
  if (['test', 'run', 'jobs', 'queued'].includes(w.stage)) return `Server: testing (${w.brief ?? w.text})`;
  if (w.stage === 'deploy') return 'Server: deploying';
  if (w.stage === 'restart' || w.stage === 'live') return 'Server: waiting for the restart';
  return 'Server is shipping…';
}

/** The rank of a row for a person to look at (ready, try it, done): after the answers owed (0), before working (1). */
export const LOOK = 0.5;

/** Whose answer a card waits on (#1121): its `to`, else whose the server says the minion is (#1449), else its assignee; '' for anyone's, which is yours. */
/** @param {{ to?: string } | null | undefined} c @param {Row} t */
const cardFor = (c, t) => String(c?.to || (t.assignee !== undefined ? t.assignee : t.properties?.assigned) || '').trim();
/** @param {string} who */
const isYou = (who) => !who || who.toLowerCase() === String(me ?? '').toLowerCase();
/** The minion's open cards that wait on you, oldest first. @param {Row} t */
export const cardsYours = (t) => (t.open_cards ?? []).filter((c) => isYou(cardFor(c, t)));

/** The open scheme's mentions of you (#1149), ticket id -> the newest's { by, at }: inbox.js fills it from your Needs you. */
/** @type {Map<number, { by: string, at: number }>} */
export const mentions = new Map();
/** A mention of you in this minion's chat that you haven't opened it since. */
/** @param {Row} t */
const mentionOf = (t) => {
  const m = mentions.get(t.id);
  return m && (view?.seen?.[t.id] ?? 0) < m.at ? m : null;
};

/** @param {Row} t @param {Usage | null | undefined} usage @param {number} now @returns {RowState} */
function baseState(t, usage, now) {
  const steps = t.steps ? ` ${t.steps.done}/${t.steps.total}` : '';
  // A wait shows its age alone, the colour saying whose and the chip what (#1692; Cara picked "The time alone" for every
  // word-plus-time cell, 2026-11-23): "answer 3h" and "ready 2h" read "3h" and "2h"; the label keeps the words for the popover and
  // screen readers. A wait on someone else keeps their name ("Josh 2h"), and a mention its "@": they say who, not what.
  /** @param {string} [who] */
  const waited = (who = '') => `${who ? `${who} ` : ''}${shortAgo(t.updated_at, now)}`;
  // An approval is its assignee's to answer, as the server's Needs you counts it (src/inbox.ts).
  if (t.approvals) {
    const who = cardFor(null, t);
    return isYou(who) ? { rank: 0, fam: 'you', cell: waited(), label: 'Answer needed: approve or deny' } : { rank: 2, fam: 'wait', cell: waited(who), label: `Waiting on ${who} to approve or deny` };
  }
  // A minion parked on start_after is new (it hasn't run) but not working (#261).
  const by = workingBy(t);
  // Gone quiet (#906; Cara picked "Running blue, dot stopped", 2026-11-17): no output well past its usual gap (src/quiet.ts).
  const quiet = by === 'turn' && t.activity?.quiet_since;
  if (quiet) return { rank: 1, fam: 'work', cell: shortAgo(/** @type {Activity} */ (t.activity).at, now), quiet: true, label: 'Quiet: no output for a while' };
  if (by === 'turn') return { rank: 1, fam: 'work', cell: steps.trim() || 'working', pulse: true, counted: !!steps, label: workingLabel(t) };
  // On its way in a release (#764, releases.js pendingRelease): the release's name where "landing" or "deploying" would be.
  const rel = t.release;
  const relLabel = rel ? `${rel.target} ${rel.name}: ${rel.stage}${rel.text ? `, ${rel.text}` : ''}` : '';
  // A job of its own runs on (#1890): working, unless it stopped on an error or a card of yours, which want you first.
  const job = by === 'server' && jobOf(t);
  if (job && t.status !== 'error' && !(t.pending_card_at && cardsYours(t).length)) return { rank: 1, fam: 'work', cell: steps.trim() || 'working', pulse: true, counted: !!steps, server: true, label: /** @type {string} */ (job.text) };
  if (by === 'server' && !job) return { rank: 1, fam: 'work', cell: rel?.name ?? 'shipping', pulse: true, server: true, label: rel ? `${serverLabel(t.wait)} · ${relLabel}` : serverLabel(t.wait) };
  if (t.status === 'error' && t.state === 'limited') return limitState(t, waited, usage, now);
  if (t.status === 'error') return { rank: 0, fam: 'broken', cell: waited(), label: 'Stuck: the last turn failed' };
  // Dismissed once landed, its change not live yet (on main waiting for CI, a deploy): still on its way.
  // A wait outside the pipeline past releasemath.js STUCK_MS (a CI runner that never came, a failed build) reads as stuck (#1019).
  if ((t.status === 'closed' || t.state === 'pending-deploy') && rel?.stuck) return { rank: 2, fam: 'broken', cell: 'stuck', label: `Stuck: ${relLabel}` };
  if (t.status === 'closed' && rel) return { rank: 2, fam: 'wait', cell: rel.name, label: `On its way: ${relLabel}` };
  if (t.status === 'closed') return { rank: 5, fam: 'idle', cell: 'dismissed', label: 'Dismissed' };
  // A mention of you (#1149) is yours to see to until you open its chat, as your Needs you counts it; a card of yours says more.
  const m = mentionOf(t);
  if (m && !(t.pending_card_at && cardsYours(t).length)) return { rank: 0, fam: 'you', cell: `@ ${shortAgo(m.at, now)}`, label: `${m.by} mentioned you`, since: m.at, mention: m };
  const state = STATES[/** @type {TicketState} */ (t.state)];
  // Parked until something wakes it by itself (start_after, wake_when_live, runners back) reads as waiting, not grey (Cara, 2026-11-14).
  if (t.state === 'parked' && t.wakes_on) return { rank: 3, fam: 'wait', cell: 'waiting', label: `Waiting: ${t.parked_for ? `starts when ${t.wakes_on}` : t.wakes_on}` };
  if (t.state === 'parked') return { rank: 4, fam: 'idle', cell: 'sealed', label: state.label };
  if (t.state === 'pending-deploy' && rel) return { rank: 2, fam: 'wait', cell: rel.name, label: `${state.label} · ${relLabel}` };
  if (t.state === 'outside' || t.state === 'pending-deploy') return { rank: 2, fam: 'wait', cell: `${t.state === 'outside' ? 'waiting' : 'deploying'}${steps}`, counted: !!steps, label: state.label };
  if (t.state === 'blocked') return { rank: 2, fam: 'broken', cell: 'blocked', label: state.label };
  // An open question or plan card is the more specific ask than ready, try it or reply; timed from when it was posted.
  // Amber only when one is yours (#1121; Josh picked "Say what is owed", 2026-11-19); else it waits on whose it is.
  if (t.pending_card_at) {
    /** @type {{ to?: string }[]} */
    const cards = t.open_cards?.length ? t.open_cards : [{}];
    const age = shortAgo(t.pending_card_at, now);
    if (cards.some((c) => isYou(cardFor(c, t)))) return { rank: 0, fam: 'you', cell: age, label: 'Answer needed', since: t.pending_card_at };
    const who = cardFor(cards[0], t);
    return { rank: 2, fam: 'wait', cell: `${who} ${age}`, label: `Waiting on ${who}`, since: t.pending_card_at };
  }
  // Pending review, ready to try and done, read it: for a person to look at, not an answer owed, so not amber and not in
  // Needs you (#1121; Josh, 2026-11-19: "Answers only", ready "Its own green state"). LOOK sorts them after the answers.
  if (t.state === 'ready') return { rank: LOOK, fam: 'done', cell: waited(), label: state.label };
  // Complete carries what's left (nothing, or what to read) in its note, so the label says it at a glance (#547).
  if (t.state === 'complete') return { rank: LOOK, fam: 'done', cell: waited(), label: t.note ? `${state.label}: ${t.note}` : state.label };
  if (t.state === 'try') return { rank: LOOK, fam: 'work', cell: waited(), label: state.label };
  // One-tap replies wait on a go, as a card does: its assignee's, else anyone's.
  if (t.replies?.length) {
    const who = cardFor(null, t);
    if (isYou(who)) return { rank: 0, fam: 'you', cell: waited(), label: 'Answer needed: it offered replies' };
    return { rank: 2, fam: 'wait', cell: waited(who), label: `Waiting on ${who}` };
  }
  // Nothing running and nothing asked: not your move, so grey, beside parked (#1121; before it, amber "Your move").
  return { rank: 4, fam: 'idle', cell: waited(), label: 'Idle' };
}

/** The words a minion link in chat carries in its hover title (refBucket): waiting on people, working, live; neutral has none. */
/** @type {Record<string, string>} */
export const REF_WORDS = { waiting: 'waiting', working: 'working', deployed: 'deployed' };

/**
 * Which bucket a minion link in chat belongs to (#1743; Cara, 2026-11-23: "color minion links in chats based on if the minion is
 * blocked/waiting, working, or deployed"). Not the sidebar's families: there ready, complete and try are green or blue, a deploy
 * violet and sealed grey, while here each reads as what it is to the person in the chat.
 *   working:  its turn runs or is queued, the server is landing it, it is deploying (state pending-deploy, or dismissed with its release on its way)
 *   waiting:  a card, approval or replies wait on people, state try/ready/complete/blocked/outside/parked/limited, a failed turn,
 *             the ship line, or a release or deploy that is stuck or failed
 *   deployed: its change is live, open and idle or dismissed (or shipped to main where nothing deploys it)
 *   neutral:  anything else, or no row (another scheme's list isn't loaded)
 * `t` carries `release` (releases.js pendingRelease) when its change is on its way, as the sidebar adds it.
 * @param {Row | null | undefined} t
 */
export function refBucket(t) {
  if (!t || isCoordinator(t)) return 'neutral';
  // Shipped to main in a scheme this server doesn't deploy (src/branch.ts shipLine, "Shipped to main"): main is as far as it goes,
  // so it's done (TripPresenter #73 stayed blue after it closed, 2026-11-23). Citadel's own reads "On main, not deployed" till it deploys.
  // A release still on its way (an APK, a desktop build, a contraption deploy) comes in as `release` and stays working.
  const stage = t.ship?.stage === 'main' && /^Shipped to /.test(t.ship.text ?? '') ? 'live' : t.ship?.stage;
  if (t.status === 'closed') {
    if (t.release) return t.release.stuck ? 'waiting' : 'working';
    if (stage === 'live') return 'deployed';
    return stage === 'failed' ? 'waiting' : stage === 'main' || stage === 'deploying' ? 'working' : 'neutral';
  }
  const by = workingBy(t);
  if (by === 'turn') return 'working';
  if (by === 'server') return t.wait?.stage === 'line' ? 'waiting' : 'working';
  if (t.state === 'pending-deploy') return 'working';
  if (t.status === 'error' || t.approvals || t.pending_card_at || t.replies?.length) return 'waiting';
  if (['try', 'ready', 'complete', 'blocked', 'outside', 'parked', 'limited'].includes(String(t.state)) || stage === 'failed') return 'waiting';
  return stage === 'live' ? 'deployed' : 'neutral';
}

/** A link's hover title with the state in words: "#12 · working · Title", "Delve #12 · working · Title", or "#12 · working" with no title. */
/** @param {string} base @param {number | string} number @param {string} word */
export function refTitle(base, number, word) {
  if (!word) return base;
  if (!base) return `#${number} · ${word}`;
  const m = /^(.*?#\d+) (.*)$/s.exec(base);
  return m ? `${m[1]} · ${word} · ${m[2]}` : `${base} · ${word}`;
}

/**
 * A minion that hit the usage limit: a countdown to its own resume when it has one, else a countdown while the account's limit is still hit, your move
 * once a later turn shows it has reset, and just "limit hit" when neither is known (the note says when).
 * @param {Row} t @param {(who?: string) => string} waited @param {Usage | null | undefined} usage @param {number} now @returns {RowState}
 */
function limitState(t, waited, usage, now) {
  if (t.limit_resume_at) return { rank: 2, fam: 'wait', cell: `resumes ${shortIn(t.limit_resume_at, now)}`, label: 'Usage limit: resumes by itself' };
  const hit = [usage?.session, usage?.weekly].find((/** @type {UsageWindow | null | undefined} */ w) => w?.status === 'rejected' && Number(w.resetsAt) > now);
  if (hit) return { rank: 2, fam: 'wait', cell: `resets ${shortIn(/** @type {number} */ (hit.resetsAt), now)}`, label: STATES.limited.label };
  if (Number(usage?.updatedAt) > t.updated_at) return { rank: 4, fam: 'idle', cell: waited(), label: 'Idle: the usage limit has reset; send a message to carry on' };
  return { rank: 2, fam: 'wait', cell: 'limit hit', label: STATES.limited.label };
}

/** "11:24 AM PST", with the day once it's over 20 hours ago: every clock time people read is Pacific. */
/** @param {number} ms @param {number} [now] */
export function pacific(ms, now = Date.now()) {
  return (now - ms > 20 * 3_600_000 ? pacificWeekdayClock : pacificClock)(ms);
}

/** "under a minute", "14m", "1h 5m", "2d 3h": a span in the popover's words. */
/** @param {number} ms */
export function span(ms) {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(m / 1440)}d${Math.floor(m / 60) % 24 ? ` ${Math.floor(m / 60) % 24}h` : ''}`;
}

/**
 * Why a row's chip says what it says (#906), for its popover: a title (what), lines (since when, Pacific, and how long;
 * the usual time where the server knows one), a muted aside and a link to what it waits on. Built from the minion as the
 * stream sent it, so opening it fetches nothing. `st` is its rowState; every state rowState gives has lines (the test).
 * @param {Row} t @param {RowState} st @param {number} [now]
 */
export function rowWhy(t, st, now = Date.now()) {
  /** @param {number} ms */
  const at = (ms) => `${pacific(ms, now)}, ${span(now - ms)} ago`;
  /** @type {string[]} */
  const lines = [];
  /** @type {string | null} */
  let more = null;
  /** @type {{ href: string, text: string } | null} */
  let link = null;
  const card = cardsYours(t)[0] ?? t.open_cards?.[0],
    w = t.status !== 'closed' && !st.quiet ? t.wait : null;
  if (st.quiet) {
    const a = /** @type {Activity} */ (t.activity),
      tool = a.tool;
    lines.push(`No output for ${span(now - a.at)}, since ${pacific(a.at, now)}.`);
    if (tool) {
      const over = tool.limit && now > tool.started + tool.limit ? `, now ${span(now - tool.started - tool.limit)} past it` : '';
      lines.push(`Last: ${tool.label}, started ${pacific(tool.started, now)}${tool.limit ? ` with a ${span(tool.limit)} timeout${over}` : ''}.`);
    }
    more = 'Turns go this quiet less than 0.1% of the time (5,620 turns, Nov 2026).';
  } else if (workingBy(t) === 'turn') {
    if (t.worker_wait) lines.push(`${workerWaitLabel(t.worker_wait, t.start_now)}.`, `Since ${at(t.worker_wait.since)}.`);
    else lines.push(t.turnStartedAt ? `Since ${at(t.turnStartedAt)}.` : t.status === 'new' ? 'Setting up its first turn.' : 'Its turn is running.');
    if (t.last_activity && !t.worker_wait) lines.push(`Now: ${t.last_activity}`);
    if (t.steps) lines.push(`${t.steps.done} of ${t.steps.total} steps done${t.steps.since && t.steps.usual ? `; this one ${span(now - t.steps.since)} of ~${span(t.steps.usual * 1000)} guessed` : ''}.`);
  } else if (t.limit_resume_at && t.state === 'limited') {
    lines.push(`Hit the usage limit at ${pacific(t.updated_at, now)}; resumes by itself at ${pacific(t.limit_resume_at, now)}.`);
  } else if (!w) {
    lines.push(`Since ${at(jobOf(t)?.since ?? st.since ?? t.updated_at)}.`);
    if (jobOf(t)) lines.push('The server runs it on and wakes this minion when it ends.');
  }
  if (w) {
    lines.push(`${waitWords(w)}.`);
    more = `${span((w.ended ?? now) - w.since)} so far${w.usual ? `; usually ~${span(w.usual * 1000)}` : ''}. Started ${pacific(w.since, now)}.`;
  }
  // The note says what's left or what it's stuck on; complete's label already has it.
  if (t.note && st.rank !== 1 && !st.label.includes(t.note)) lines.push(`Note: ${t.note}`);
  if (card && (st.rank === 0 || t.pending_card_at)) link = { href: card.href, text: `Open the ${card.what ?? card.kind} card →` };
  else if (t.release) link = { href: `#/p/${t.project_id}/releases/${t.project_id}${t.release.targetId ? `/target/${encodeURIComponent(t.release.targetId)}` : ''}`, text: 'Releases →' };
  return { title: st.quiet ? `Quiet ${shortAgo(/** @type {Activity} */ (t.activity).at, now)}` : st.label, lines, more, link, quiet: !!st.quiet };
}

/**
 * Why an item is in your Needs you (#906), for its inbox chip's popover: what it is, since when (Pacific) and when it
 * leaves. `item` is src/inbox.ts's; `t` its minion, when this page has it. Every kind the server sends has one (the test).
 * @param {{ at: number, kind: string, card?: { notice?: unknown, doc?: unknown, secret?: unknown, stage?: number, n?: number, text?: string, by?: string } }} item @param {Row | undefined} t @param {number} [now]
 */
export function askWhy(item, t, now = Date.now()) {
  const since = pacific(item.at, now);
  const card = item.card ?? {};
  const what = card.notice ? 'notice' : card.doc ? 'choices page' : card.secret ? 'secret' : item.kind;
  switch (item.kind) {
    case 'approval':
      return `An approval card since ${since}: its turn waits on it. Approvals count even while the minion is sealed.`;
    case 'question':
    case 'plan':
      return `A ${what} card for you since ${since}. It leaves once someone answers it.`;
    case 'spend':
      return `This turn passed $${card.stage} at ${since}. It leaves once someone answers the alert.`;
    case 'quiet':
      return `No output from its turn since ${since}, well past its usual gap. You asked for it, so it shows here until the turn talks again or ends.`;
    case 'loop':
      return `The loop guard has held ${card.n === 1 ? 'a message' : `${card.n} messages`} since ${since} ("${card.text}"). Continue in its chat sends ${card.n === 1 ? 'it' : 'them'}.`;
    case 'mention':
      return `${card.by} mentioned you at ${since}: "${card.text}". It leaves once you open its chat.`;
    case 'replies':
      return `It offered one-tap replies at ${since} and waits for a go. It stops counting once you open it.`;
    default:
      return `Answer needed since ${since}.`;
  }
}

/**
 * Why a release stands where it does (#906), for a Releases row's popover: its stage, what it waits on, since when
 * (Pacific) and its usual length. `p` is src/releases.ts's Progress; `stage` the stage's name in words.
 * @param {{ waitingOn?: string | null, text?: string, usual?: number | null, since: number }} p @param {string} stage @param {number} [now]
 */
export function progressWhy(p, stage, now = Date.now()) {
  const what = p.waitingOn ?? p.text; // waitingOn is already a sentence ("2 changes … wait on a version bump")
  const usual = p.usual ? `; usually ~${span(p.usual * 1000)}` : p.waitingOn ? '; no estimate while it waits' : '';
  return `${stage}${what ? `: ${what}` : ''}.\nSince ${pacific(p.since, now)}, ${span(now - p.since)} so far${usual}.`;
}

/** A track with one piece, not started: the bar's line while a working minion has no plan yet (#696). */
/** @type {[null, string][]} */
export const EMPTY_TRACK = [[null, 'p']];

/**
 * What a list row's bar (#573) is drawn from, or null for none: the plan's steps (`track`, and `done`/`total` from an
 * older server) while the minion works, and the `wait` (a land, CI, a deploy) while it works or after its turn. A row waiting on a person (a card,
 * an approval, ready, try it), blocked, parked or at the usage limit has none; the card badge flags a card (Cara,
 * 2026-11-11: "if a minion is asking a question it shouldnt have a progress bar right?"). `st` is its rowState.
 * @param {Row} t @param {RowState} st
 * @returns {{ track: [number | null, string][] | null, wait?: Wait, done?: number, total?: number, since?: number, usual?: number } | null}
 */
export function rowBar(t, st) {
  if (st.rank === 0 || t.status === 'closed') return null;
  // Rank 1 is working: running, or new and not parked on start_after (#261); the Taskmaster's idle row has no rank.
  const working = st.rank === 1,
    w = waitShows(t.wait) ? t.wait : null;
  // The plan's track and the wait together (#630): wait.js progressTrack draws the wait in the step underway.
  if (w && (working || t.state === 'outside' || t.state === 'pending-deploy')) return { ...(working && t.steps), track: working ? (t.step_track ?? null) : null, wait: w };
  if (!working) return null;
  // Before its task list exists, one empty piece holds the line's room, so the row doesn't grow when the steps arrive (#696).
  if (!t.steps) return { track: EMPTY_TRACK };
  return { ...t.steps, track: t.step_track ?? null };
}

/**
 * The open-card chip's text for a row's open_cards, oldest first (#575; Cara, 2026-11-11: "lets give them different
 * ones, question, merge, plan, etc"): the kind of ask (CardLink.what), counted when they're all one kind ("2 plans"),
 * else the oldest's kind and how many more ("plan +1"), as the chip opens the oldest.
 * @param {CardLink[]} cards
 */
export function cardChip(cards) {
  const first = cardWord(cards[0]);
  if (cards.length === 1) return first;
  if (!cards.every((c) => cardWord(c) === first)) return `${first} +${cards.length - 1}`;
  return CARD_WORDS[String(cards[0].what)] ? `${first} ×${cards.length}` : `${cards.length} ${first}s`;
}

/** A card's kind as its chip says it: the go card reads "Ship It" (Cara, 2026-11-19: "The Chip and card should say "Ship It""). */
/** @type {Record<string, string>} */
const CARD_WORDS = { ship: 'Ship It', merge: 'Merge' };
/** @param {CardLink} c */
export const cardWord = (c) => CARD_WORDS[String(c.what)] ?? c.what ?? c.kind;

/** Where a minion's change is (t.ship, src/branch.ts): its colour family, and its badge in the list (none on its branch). */
export const SHIP = {
  branch: { fam: 'idle', badge: '' },
  build: { fam: 'work', badge: 'in build' }, // merged into its build branch: done for now, live when the build lands
  main: { fam: 'work', badge: 'on main' },
  deploying: { fam: 'wait', badge: 'deploying' },
  live: { fam: 'done', badge: 'live' },
  failed: { fam: 'broken', badge: 'deploy failed' },
};

/** "40m", "1h40", "14h", "2d": time left, for tight spaces. */
/** @param {number} ms @param {number} now */
function shortIn(ms, now) {
  const m = Math.max(1, Math.ceil((ms - now) / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 600) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

/** A cell as a screen reader says it (#1692): its label, then a bare age in words ("Answer needed, 3 hours"); a cell with words of its own follows as it is. */
/** @param {RowState} st */
export function spokenCell(st) {
  const m = /^(@ )?(?:(now)|(\d+)([mhd]))$/.exec(st.cell ?? '');
  if (!m) return st.cell ? `${st.label}, ${st.cell}` : st.label;
  const n = Number(m[3]);
  return `${st.label}, ${m[2] ? 'just now' : `${n} ${/** @type {Record<string, string>} */ ({ m: 'minute', h: 'hour', d: 'day' })[m[4]]}${n === 1 ? '' : 's'}`}`;
}

/** "now", "5m", "3h", "2d": ages for tight spaces. */
/** @param {number} ms @param {number} now */
function shortAgo(ms, now) {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
