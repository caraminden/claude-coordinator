// A minion's state pill as plain data, so node tests can import it: the list rows and the chat's
// head (sidebar.js, thread.js) build the nodes. `usage` and `now` come in as arguments.
import { isCoordinator, me, STATES, view } from './base.js';
import { waitFam, waitShows, waitWords } from './wait.js';

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
export const rowUnread = (t, st, seen) => !seen && (st.rank === 0 || st.rank === LOOK || (st.rank === 2 && t.state === 'blocked'));

/**
 * A thread's state pill, coloured by family (one meaning each): you (amber: an answer of yours is owed, with how
 * long it has waited, and nothing else, #1121), done (green: done, read it), broken (red), work (blue: working, or
 * ready to try), wait (violet: waiting on another person's card, the usage reset, a deploy, CI, parked until
 * something wakes it), idle (grey: idle, parked, dismissed). `cell` is the pill's text and `pulse` says it gets the
 * working dot.
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

/** Whose answer a card waits on (#1121): its `to`, else the minion's assignee; '' for anyone's, which is yours. */
const cardFor = (c, t) => String(c?.to || t.properties?.assigned || '').trim();
const isYou = (who) => !who || who.toLowerCase() === String(me ?? '').toLowerCase();
/** The minion's open cards that wait on you, oldest first. */
export const cardsYours = (t) => (t.open_cards ?? []).filter((c) => isYou(cardFor(c, t)));

/** The open scheme's mentions of you (#1149), ticket id -> the newest's { by, at }: inbox.js fills it from your Needs you. */
export const mentions = new Map();
/** A mention of you in this minion's chat that you haven't opened it since. */
const mentionOf = (t) => {
  const m = mentions.get(t.id);
  return m && (view?.seen?.[t.id] ?? 0) < m.at ? m : null;
};

function baseState(t, usage, now) {
  const steps = t.steps ? ` ${t.steps.done}/${t.steps.total}` : '';
  const waited = (word) => `${word} ${shortAgo(t.updated_at, now)}`;
  // An approval is its assignee's to answer, as the server's Needs you counts it (src/inbox.ts).
  if (t.approvals) { const who = cardFor(null, t);
    return isYou(who) ? { rank: 0, fam: 'you', cell: waited('approve'), label: 'Answer needed: approve or deny' } : { rank: 2, fam: 'wait', cell: waited(who), label: `Waiting on ${who} to approve or deny` }; }
  // A minion parked on start_after is new (it hasn't run) but not working (#261).
  const by = workingBy(t);
  // Gone quiet (#906; Cara picked "Running blue, dot stopped", 2026-11-17): no output well past its usual gap (src/quiet.ts).
  const quiet = by === 'turn' && t.activity?.quiet_since;
  if (quiet) return { rank: 1, fam: 'work', cell: `quiet ${shortAgo(t.activity.at, now)}`, quiet: true, label: 'Quiet: no output for a while' };
  if (by === 'turn') return { rank: 1, fam: 'work', cell: steps.trim() || 'working', pulse: true, counted: !!steps, label: workingLabel(t) };
  // On its way in a release (#764, releases.js pendingRelease): the release's name where "landing" or "deploying" would be.
  const rel = t.release;
  const relLabel = rel ? `${rel.target} ${rel.name}: ${rel.stage}${rel.text ? `, ${rel.text}` : ''}` : '';
  if (by === 'server') return { rank: 1, fam: 'work', cell: rel?.name ?? 'shipping', pulse: true, server: true, label: rel ? `${serverLabel(t.wait)} · ${relLabel}` : serverLabel(t.wait) };
  if (t.status === 'error' && t.state === 'limited') return limitState(t, waited, usage, now);
  if (t.status === 'error') return { rank: 0, fam: 'broken', cell: waited('stuck'), label: 'Stuck: the last turn failed' };
  // Dismissed once landed, its change not live yet (on main waiting for CI, a deploy): still on its way.
  // A wait outside the pipeline past releasemath.js STUCK_MS (a CI runner that never came, a failed build) reads as stuck (#1019).
  if ((t.status === 'closed' || t.state === 'pending-deploy') && rel?.stuck) return { rank: 2, fam: 'broken', cell: 'stuck', label: `Stuck: ${relLabel}` };
  if (t.status === 'closed' && rel) return { rank: 2, fam: 'wait', cell: rel.name, label: `On its way: ${relLabel}` };
  if (t.status === 'closed') return { rank: 5, fam: 'idle', cell: 'dismissed', label: 'Dismissed' };
  // A mention of you (#1149) is yours to see to until you open its chat, as your Needs you counts it; a card of yours says more.
  const m = mentionOf(t);
  if (m && !(t.pending_card_at && cardsYours(t).length)) return { rank: 0, fam: 'you', cell: `@ ${shortAgo(m.at, now)}`, label: `${m.by} mentioned you`, since: m.at, mention: m };
  const state = STATES[t.state];
  // Parked until something wakes it by itself (start_after, wake_when_live, runners back) reads as waiting, not grey (Cara, 2026-11-14).
  if (t.state === 'parked' && t.wakes_on) return { rank: 3, fam: 'wait', cell: 'waiting', label: `Waiting: ${t.parked_for ? `starts when ${t.wakes_on}` : t.wakes_on}` };
  if (t.state === 'parked') return { rank: 4, fam: 'idle', cell: 'parked', label: state.label };
  if (t.state === 'pending-deploy' && rel) return { rank: 2, fam: 'wait', cell: rel.name, label: `${state.label} · ${relLabel}` };
  if (t.state === 'outside' || t.state === 'pending-deploy') return { rank: 2, fam: 'wait', cell: `${t.state === 'outside' ? 'waiting' : 'deploying'}${steps}`, counted: !!steps, label: state.label };
  if (t.state === 'blocked') return { rank: 2, fam: 'broken', cell: 'blocked', label: state.label };
  // An open question or plan card is the more specific ask than ready, try it or reply; timed from when it was posted.
  // Amber only when one is yours (#1121; Josh picked "Say what is owed", 2026-11-19); else it waits on whose it is.
  if (t.pending_card_at) {
    const cards = t.open_cards?.length ? t.open_cards : [{}];
    const age = shortAgo(t.pending_card_at, now);
    if (cards.some((c) => isYou(cardFor(c, t)))) return { rank: 0, fam: 'you', cell: `answer ${age}`, label: 'Answer needed', since: t.pending_card_at };
    const who = cardFor(cards[0], t);
    return { rank: 2, fam: 'wait', cell: `${who} ${age}`, label: `Waiting on ${who}`, since: t.pending_card_at };
  }
  // Ready to ship, ready to try and done, read it: for a person to look at, not an answer owed, so not amber and not in
  // Needs you (#1121; Josh, 2026-11-19: "Answers only", ready "Its own green state"). LOOK sorts them after the answers.
  if (t.state === 'ready') return { rank: LOOK, fam: 'done', cell: waited('ready'), label: state.label };
  // Complete carries what's left (nothing, or what to read) in its note, so the label says it at a glance (#547).
  if (t.state === 'complete') return { rank: LOOK, fam: 'done', cell: waited('read it'), label: t.note ? `${state.label}: ${t.note}` : state.label };
  if (t.state === 'try') return { rank: LOOK, fam: 'work', cell: waited('try it'), label: state.label };
  // One-tap replies wait on a go, as a card does: its assignee's, else anyone's.
  if (t.replies?.length) {
    const who = cardFor(null, t);
    if (isYou(who)) return { rank: 0, fam: 'you', cell: waited('answer'), label: 'Answer needed: it offered replies' };
    return { rank: 2, fam: 'wait', cell: waited(who), label: `Waiting on ${who}` };
  }
  // Nothing running and nothing asked: not your move, so grey, beside parked (#1121; before it, amber "Your move").
  return { rank: 4, fam: 'idle', cell: waited('idle'), label: 'Idle' };
}

/**
 * A minion that hit the usage limit: a countdown to its own resume when it has one, else a countdown while the account's limit is still hit, your move
 * once a later turn shows it has reset, and just "limit hit" when neither is known (the note says when).
 */
function limitState(t, waited, usage, now) {
  if (t.limit_resume_at) return { rank: 2, fam: 'wait', cell: `resumes ${shortIn(t.limit_resume_at, now)}`, label: 'Usage limit: resumes by itself' };
  const hit = [usage?.session, usage?.weekly].find((w) => w?.status === 'rejected' && w.resetsAt > now);
  if (hit) return { rank: 2, fam: 'wait', cell: `resets ${shortIn(hit.resetsAt, now)}`, label: STATES.limited.label };
  if (usage?.updatedAt > t.updated_at) return { rank: 4, fam: 'idle', cell: waited('idle'), label: 'Idle: the usage limit has reset; send a message to carry on' };
  return { rank: 2, fam: 'wait', cell: 'limit hit', label: STATES.limited.label };
}

/** "11:24 AM PST", with the day once it's over 20 hours ago: every clock time people read is Pacific. */
export function pacific(ms, now = Date.now()) {
  return new Date(ms).toLocaleTimeString('en-US', { ...(now - ms > 20 * 3_600_000 && { weekday: 'short' }), hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles', timeZoneName: 'short' });
}

/** "under a minute", "14m", "1h 5m", "2d 3h": a span in the popover's words. */
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
 */
export function rowWhy(t, st, now = Date.now()) {
  const at = (ms) => `${pacific(ms, now)}, ${span(now - ms)} ago`;
  const lines = [];
  let more = null, link = null;
  const card = cardsYours(t)[0] ?? t.open_cards?.[0], w = t.status !== 'closed' && !st.quiet ? t.wait : null;
  if (st.quiet) {
    const a = t.activity, tool = a.tool;
    lines.push(`No output for ${span(now - a.at)}, since ${pacific(a.at, now)}.`);
    if (tool) {
      const over = tool.limit && now > tool.started + tool.limit ? `, now ${span(now - tool.started - tool.limit)} past it` : '';
      lines.push(`Last: ${tool.label}, started ${pacific(tool.started, now)}${tool.limit ? ` with a ${span(tool.limit)} timeout${over}` : ''}.`);
    }
    more = 'Turns go this quiet less than 0.1% of the time (5,620 turns, Nov 2026).';
  } else if (workingBy(t) === 'turn') {
    lines.push(t.turnStartedAt ? `Since ${at(t.turnStartedAt)}.` : t.status === 'new' ? 'Setting up its first turn.' : 'Its turn is running.');
    if (t.last_activity) lines.push(`Now: ${t.last_activity}`);
    if (t.steps) lines.push(`${t.steps.done} of ${t.steps.total} steps done${t.steps.since && t.steps.usual ? `; this one ${span(now - t.steps.since)} of ~${span(t.steps.usual * 1000)} guessed` : ''}.`);
  } else if (t.limit_resume_at && t.state === 'limited') {
    lines.push(`Hit the usage limit at ${pacific(t.updated_at, now)}; resumes by itself at ${pacific(t.limit_resume_at, now)}.`);
  } else if (!w) {
    lines.push(`Since ${at(st.since ?? t.updated_at)}.`);
  }
  if (w) {
    lines.push(`${waitWords(w)}.`);
    more = `${span((w.ended ?? now) - w.since)} so far${w.usual ? `; usually ~${span(w.usual * 1000)}` : ''}. Started ${pacific(w.since, now)}.`;
  }
  // The note says what's left or what it's stuck on; complete's label already has it.
  if (t.note && st.rank !== 1 && !st.label.includes(t.note)) lines.push(`Note: ${t.note}`);
  if (card && (st.rank === 0 || t.pending_card_at)) link = { href: card.href, text: `Open the ${card.what ?? card.kind} card →` };
  else if (t.release) link = { href: `#/p/${t.project_id}/releases/${Number(t.project_id) === 2 ? 'all' : t.project_id}`, text: 'Releases →' };
  return { title: st.quiet ? `Quiet ${shortAgo(t.activity.at, now)}` : st.label, lines, more, link, quiet: !!st.quiet };
}

/**
 * Why an item is in your Needs you (#906), for its inbox chip's popover: what it is, since when (Pacific) and when it
 * leaves. `item` is src/inbox.ts's; `t` its minion, when this page has it. Every kind the server sends has one (the test).
 */
export function askWhy(item, t, now = Date.now()) {
  const since = pacific(item.at, now);
  const card = item.card ?? {};
  const what = card.notice ? 'notice' : card.doc ? 'choices page' : card.secret ? 'secret' : item.kind;
  switch (item.kind) {
    case 'approval': return `An approval card since ${since}: its turn waits on it. Approvals count even while the minion is parked.`;
    case 'question': case 'plan': return `A ${what} card for you since ${since}. It leaves once someone answers it.`;
    case 'spend': return `This turn passed $${card.stage} at ${since}. It leaves once someone answers the alert.`;
    case 'quiet': return `No output from its turn since ${since}, well past its usual gap. You asked for it, so it shows here until the turn talks again or ends.`;
    case 'loop': return `The loop guard has held ${card.n === 1 ? 'a message' : `${card.n} messages`} since ${since} ("${card.text}"). Continue in its chat sends ${card.n === 1 ? 'it' : 'them'}.`;
    case 'mention': return `${card.by} mentioned you at ${since}: "${card.text}". It leaves once you open its chat.`;
    case 'replies': return `It offered one-tap replies at ${since} and waits for a go. It stops counting once you open it.`;
    default: return `Answer needed since ${since}.`;
  }
}

/**
 * Why a release stands where it does (#906), for a Releases row's popover: its stage, what it waits on, since when
 * (Pacific) and its usual length. `p` is src/releases.ts's Progress; `stage` the stage's name in words.
 */
export function progressWhy(p, stage, now = Date.now()) {
  const what = p.waitingOn ?? p.text; // waitingOn is already a sentence ("2 changes … wait on a version bump")
  const usual = p.usual ? `; usually ~${span(p.usual * 1000)}` : p.waitingOn ? '; no estimate while it waits' : '';
  return `${stage}${what ? `: ${what}` : ''}.\nSince ${pacific(p.since, now)}, ${span(now - p.since)} so far${usual}.`;
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
  const first = cardWord(cards[0]);
  if (cards.length === 1) return first;
  if (!cards.every((c) => cardWord(c) === first)) return `${first} +${cards.length - 1}`;
  return CARD_WORDS[cards[0].what] ? `${first} ×${cards.length}` : `${cards.length} ${first}s`;
}

/** A card's kind as its chip says it: the go card reads "Ship It" (Cara, 2026-11-19: "The Chip and card should say "Ship It""). */
const CARD_WORDS = { ship: 'Ship It' };
export const cardWord = (c) => CARD_WORDS[c.what] ?? c.what ?? c.kind;

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

/** Where a closed minion's change went, in the strip's words (t.ship, src/branch.ts); null when it shipped nothing. */
function shippedWords(t) {
  const stage = t.ship?.stage;
  if (stage === 'live') return 'Shipped and live';
  if (stage === 'build') return `Merged into ${t.build ? `Build ${t.build}` : 'its build'}; live when the build ships`;
  if (stage === 'main' || stage === 'deploying') return 'Shipped; on its way live';
  if (stage === 'failed') return 'Shipped, but its deploy failed';
  return null;
}

/**
 * The "where it stands" strip on top of a minion's chat (#1130; Josh picked it from #1091's ideas, 2026-11-19): its goal
 * (`t.goal`, a line the Taskmaster or the minion wrote, else its title; Josh, 2026-11-19: "Just summarize the goal of the
 * minion"), where it is now (rowState's label, #1121's names, with the wait or note that says why) and whose move it is
 * (the card waiting on you as a link, else "Nothing: …"). All from the minion as the stream sent it: no fetch, no model.
 * Each line is { text, fam, href?, title? }; fam colours it as the row's chip.
 */
export function standsLines(t, usage, now = Date.now()) {
  const st = rowState(t, usage, now);
  const w = t.status !== 'closed' && !st.quiet && waitShows(t.wait) ? t.wait : null;
  const shipped = t.status === 'closed' && !t.release ? shippedWords(t) : null;
  const extra = w ? waitWords(w) : st.rank === 1 && t.steps ? `${t.steps.done} of ${t.steps.total} steps done` : st.rank === 1 && t.last_activity ? t.last_activity : t.note && st.rank !== 1 && !st.label.includes(t.note) ? t.note : '';
  const nowText = shipped ?? [st.label, extra].filter(Boolean).join(' · ');
  return {
    goal: { text: t.goal || t.title, fam: 'none', title: t.goal ? '' : 'No goal written yet: its title stands in' },
    now: { text: nowText, fam: shipped ? SHIP[t.ship.stage].fam : st.fam },
    move: yourMove(t, st, now),
  };
}

/** The strip's "Your move" line: what is on you, linked to the card when there is one, else whose wait it is (#1121's names). */
function yourMove(t, st, now) {
  const nothing = (why) => ({ text: `Nothing: ${why}`, fam: 'idle' });
  const yours = cardsYours(t);
  // pending_card_at is the oldest open card's: say how long only when that one is yours.
  const waiting = t.pending_card_at && yours.length === (t.open_cards ?? []).length ? ` · waiting ${span(now - t.pending_card_at)}` : '';
  // A running turn's spend alert leads the list row's badge (#723), so it leads here too.
  if (t.spend_alert && t.status !== 'closed') return { text: `Answer its spend alert: it passed $${t.spend_alert.usd}`, fam: 'broken', href: t.spend_alert.href };
  if (t.approvals && st.rank === 0) {
    const card = (t.open_cards ?? []).find((c) => c.kind === 'approval');
    return { text: 'Approve or deny its approval card', fam: 'you', href: card?.href };
  }
  // A card addressed to you is your move whatever else it is doing (parked, working), as Needs you counts it.
  if (yours.length) {
    const card = yours[0];
    const more = yours.length > 1 ? ` (+${yours.length - 1} more)` : '';
    return { text: `Answer the ${cardWord(card)} card${more}${waiting}`, fam: 'you', href: card.href, title: card.label };
  }
  if (st.mention) return { text: `Read ${st.mention.by}'s message: it mentions you`, fam: 'you' };
  if (st.rank === 0 && st.fam === 'you') return { text: 'Answer: pick a reply over the message box, or write one', fam: 'you' };
  if (st.fam === 'broken' && t.status === 'error') return { text: 'Read why its last turn failed, then send a message to carry on', fam: 'broken' };
  if (st.quiet) return nothing('it is working, though quiet for a while');
  if (st.rank === 1) return nothing(st.server ? 'the server is shipping it' : 'it is working');
  if (st.rank === LOOK) {
    if (t.state === 'ready') return { text: 'Look it over: it is ready to ship', fam: 'done' };
    if (t.state === 'try') return { text: 'Try it, then say how it went', fam: 'work' };
    return { text: 'Read it; it closes once you have seen it', fam: 'done' };
  }
  // A card or a go that is someone else's (rowState's "Waiting on <name>").
  if (st.label.startsWith('Waiting on ')) return nothing(`waiting on ${st.label.slice('Waiting on '.length)}`);
  if (t.status === 'closed') return nothing(t.release || t.ship?.stage === 'main' || t.ship?.stage === 'deploying' ? 'it goes live by itself' : 'it is dismissed');
  if (t.state === 'parked') return nothing(t.wakes_on ? 'it wakes by itself' : 'it is parked; Unpark wakes it');
  if (t.state === 'blocked') return nothing('it is blocked on something outside the minion');
  if (st.rank === 2) return nothing('it carries on by itself');
  return { text: 'Nothing is asked: send a message to carry on', fam: 'idle' };
}
