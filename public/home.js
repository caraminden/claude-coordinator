// Home (#1140, #1217): every minion waiting on you across the schemes you're in, as a scheme's own minions list
// draws them, with the chat you open from it beside it. Josh, 2026-11-20: "home should just use the normal minion
// list render, but have all of the minions waiting on you in all schemes ... drop the working and shipped columns.
// Untill you open one of the minions, that space could show a high level summary of what is going on and what
// shipped, but not the individual minons". His picks that day: "Same as Needs you", "Counts per scheme" ("Maybe some
// nice activity graphs or something?") and "Grouped by scheme". Kept from #1140: "After you answer a card: Move to
// the next card", and the list as one element kept across pages, so moving between its chats keeps its scroll.
// It's drawn at once from the last answer this browser had, then refreshed behind. Rows keep their place for the
// whole visit: an answered one is gone at once (Josh, 2026-11-20), and one that arrives joins the bottom of its scheme with
// a "new" tag (no reflow without input).
import { HOME_LINE, api, h, isCoordinator, jumpHref, me, threadHref, view, pacificWeekdayClock } from './base.js';
import { usage } from './core.js';
import { mentionMap } from './inbox.js';
import { emptyCard, schemeHue, schemeTag, statTiles, toneChip } from './look.js';
import { rowTarget } from './schemecounts.js';
import { threadRow } from './sidebar.js';
import { byUrgency, mentions } from './threadstate.js';

const CACHE = 'cc-home'; // the last /api/home answer, for the next first paint

let data = null; // the last answer: { items, tickets, seen, schemes, since, days, me }, only ever drawn for the person it was fetched for
try { data = JSON.parse(localStorage.getItem(CACHE)); } catch {}
if (!Array.isArray(data?.days)) data = null; // an answer cached before the bars (#1217) can't draw them
let failed = false; // the last fetch failed: the list says so, with a retry, rather than "Loading…" for good
// This visit: each list's ids in the order shown, the ones there when it opened (the rest are "new"), and the rows as last seen.
const visit = { rows: [], first: null, last: new Map(), fresh: false, shown: [] };
let next = null; // the chat whose card you just answered, to move on from once the list agrees
let timer = 0;
let panel = null;
let overview = null;

/** `#/p/…` as Home's address for the same chat: `#/home/p/…` (core.js routes both). */
export const homeHash = (hash) => (hash.startsWith('#/p/') ? `#/home${hash.slice(1)}` : hash);

/** The shelf says whether it shows the Home line, for the next start. */
export function rememberHomeLine(shown) {
  try { if (shown) localStorage.setItem(HOME_LINE, '1'); else localStorage.removeItem(HOME_LINE); } catch {}
}

/** A new visit to Home (from anywhere but Home): rows start in the server's order again, with nothing ticked or new. */
export function startVisit() {
  Object.assign(visit, { rows: [], first: null, last: new Map(), fresh: false });
  next = null;
}

/** The list for the side panel (or the page itself on a phone): one element for the whole session. */
export function homePanel() {
  panel ??= h('div', { class: 'home-panel', 'data-part': 'home-list' });
  drawPanel();
  return panel;
}

/**
 * What fills the chat's space until a row is picked: counts across your schemes and a row per scheme with its
 * activity bars, no minion's own row. The side panel's title already says Home, so this has no heading of its own
 * (Josh, 2026-11-20: "It shouldnt say home twice in the header"); on a phone it holds the list first.
 */
export function homeOverview(list = null) {
  overview = h('div', { class: 'home-overview-body' });
  drawOverview();
  // On a phone the list sits here and the panel's summary (which says "Home" on a desktop) isn't shown, so the page says it.
  return h('section', { class: 'home-overview', 'data-part': 'home-overview' }, list ? h('h2', { class: 'home-title' }, 'Home') : '', list, overview);
}

/** Fetch Home again (a burst of news fetches once). */
export function refreshHomeSoon() {
  clearTimeout(timer);
  timer = setTimeout(refreshHome, 300);
}

export async function refreshHome() {
  if (!view?.home) return;
  const got = await api('api/home').catch(() => null);
  if (!view?.home) return;
  failed = !got;
  if (!got) return void drawPanel();
  data = { ...got, me };
  try { localStorage.setItem(CACHE, JSON.stringify(data)); } catch {}
  // The first answer of a visit sorts it as the server does; the cached paint before it was only a stand-in.
  if (!visit.fresh) Object.assign(visit, { rows: [], first: null, fresh: true });
  drawPanel();
  drawOverview();
  moveOn();
}

/** A chat event from the stream: your own answer to a card in the chat open from Home moves you on once the list agrees. */
export function homeEvent(event) {
  if (!view?.home || event.ticket_id !== view.id) return;
  let d = {};
  try { d = JSON.parse(event.data); } catch {}
  const who = event.kind === 'user_message' && d.answer ? d.author : ['plan_result', 'approval_result'].includes(event.kind) ? d.by
    : event.kind === 'question_result' ? d.settled?.by : null; // a notice's "Got it" and a page's Send settle this way
  if (who && me && String(who).toLowerCase() === me.toLowerCase()) {
    next = event.ticket_id;
    refreshHomeSoon();
  }
}

// ---- drawing ----

/** `ids` in the order this visit shows them: the ones already shown keep their place (gone ones keep theirs, so a returning row sits where it was), new ones join the bottom. */
const stable = (shown, ids) => [...shown, ...ids.filter((id) => !shown.includes(id))];

/** Forget an answer fetched for someone else (a sign-out and in on this browser doesn't reload the page). */
const own = () => { if (data && data.me !== me) data = null; };

/** Each waiting minion's items, by ticket id. */
function groups() {
  const rows = new Map();
  for (const i of data?.items ?? []) {
    if (!rows.has(i.ticketId)) rows.set(i.ticketId, []);
    rows.get(i.ticketId).push(i);
  }
  return rows;
}

const CARDS = new Set(['question', 'plan', 'approval']);

/** A row's address: Home's own for its chat, at its oldest card, else the oldest thing it waits on you for. */
const rowHref = (t, items) => {
  // A card (question, plan, approval) wins over an older mention or reply offer: Josh, 2026-11-20, "clicking a question card
  // on the home screen should go to the card".
  const cards = (items ?? []).filter((i) => CARDS.has(i.kind));
  const target = cards.length ? rowTarget(cards) : items?.length ? rowTarget(items) : null;
  return homeHash(target ? jumpHref(t, target) : threadHref(t));
};

/** The schemes' order: the server's (your shelf's), then any a row kept from earlier in the visit came from. */
const schemeOrder = () => (data?.schemes ?? []).map((s) => ({ id: s.id, name: s.name }));

function drawPanel() {
  if (!panel) return;
  own();
  const rows = groups();
  const tickets = new Map((data?.tickets ?? []).map((t) => [t.id, t]));
  // A scheme's rows read seen times and mentions from the open scheme; Home's come from every scheme (ticket ids are global).
  // Seen times only grow, so the newer of the two wins.
  if (view) for (const [id, at] of Object.entries(data?.seen ?? {})) if (!(view.seen?.[id] >= at)) (view.seen ??= {})[id] = at;
  for (const [id, m] of mentionMap(data?.items ?? [])) if (!mentions.has(id)) mentions.set(id, m);
  // The first answer of a visit sorts each scheme as its own list does: Taskmaster first, then by urgency.
  const order = [...rows.keys()].filter((id) => tickets.has(id))
    .sort((a, b) => Number(isCoordinator(tickets.get(b))) - Number(isCoordinator(tickets.get(a))) || byUrgency(tickets.get(a), tickets.get(b), usage));
  visit.rows = stable(visit.rows, order);
  visit.first ??= new Set(order);
  for (const id of order) visit.last.set(id, { t: tickets.get(id), items: rows.get(id) });
  const names = schemeOrder();
  for (const id of visit.rows) {
    const t = visit.last.get(id)?.t;
    if (t && !names.some((s) => s.id === t.project_id)) names.push({ id: t.project_id, name: view?.projects?.find((p) => p.id === t.project_id)?.name ?? '' });
  }
  visit.shown = []; // the rows top to bottom, scheme by scheme, for moveOn
  const sections = names.map((s) => {
    const all = visit.rows.filter((id) => visit.last.get(id)?.t.project_id === s.id);
    visit.shown.push(...all); // gone ones too: moveOn needs the answered row's place
    // A row that left Home's list (answered, a mention opened, withdrawn) is gone at once; Josh, 2026-11-20: "these should just be gone once done".
    const ids = all.filter((id) => rows.has(id));
    if (!ids.length) return null;
    return h('section', { class: 'thread-group home-group', 'data-cat': schemeHue(s.name) }, h('h3', {}, s.name), ...ids.map((id) => {
      const t = tickets.get(id), items = rows.get(id);
      // The row's card and spend badges open on Home too, not in the scheme.
      const row = threadRow({ ...t, open_cards: t.open_cards?.map((c) => ({ ...c, href: homeHash(c.href) })), spend_alert: t.spend_alert && { ...t.spend_alert, href: homeHash(t.spend_alert.href) } }, rowHref(t, items));
      if (visit.fresh && !visit.first.has(id)) row.querySelector('.name')?.prepend(h('span', { class: 'new-tag' }, 'new'));
      return row;
    }));
  }).filter(Boolean);
  const retry = h('button', { type: 'button', class: 'link', onclick: () => { failed = false; drawPanel(); refreshHome(); } }, 'Try again');
  panel.replaceChildren(...(sections.length ? sections
    : [failed && !data ? emptyCard('Couldn\'t load Home', h('span', {}, 'What waits on you didn\'t load. ', retry), { mark: '!', hue: 'danger' })
      : emptyCard('Nothing needs you', data ? 'Minions in any of your schemes that wait on you show here.' : 'Loading what waits on you…')]));
}

function drawOverview() {
  if (!overview) return;
  own();
  const schemes = data?.schemes ?? [];
  const sum = (k) => schemes.reduce((n, s) => n + s[k], 0);
  const days = data?.days ?? [];
  // One scale for every scheme's bars, so a tall bar means the same in each.
  const top = Math.max(1, ...schemes.flatMap((s) => s.daily));
  const since = data?.since;
  overview.replaceChildren(
    statTiles([sum('waiting'), 'waiting on you', 'waiting'], [sum('working'), 'working now', 'running'],
      [sum('shipped'), since ? `shipped since ${when(since)}` : 'shipped since your last visit', 'done']),
    h('h3', { class: 'settings-section', 'data-hue': 'accent' }, 'Your schemes', h('span', { class: 'home-days muted' }, `minions shipped each day, last ${days.length || 14} days`)),
    schemes.length ? h('div', { class: 'hue-rows' }, ...schemes.map((s) => schemeRow(s, days, top)))
      : emptyCard(data ? 'No schemes yet' : 'Loading', data ? 'The schemes you\'re in show here, with what\'s going on in each.' : 'Counting what\'s going on…', { mark: '·', hue: 'held' }));
}

/** A scheme's line: its tag, what's going on in it as chips, and its last days' ships as bars; it opens the scheme. */
function schemeRow(s, days, top) {
  // Always the three counts, in fixed slots (dim at zero), so the line's height doesn't change when a count does.
  const slot = (n, tone, text) => { const c = toneChip(n ? tone : 'neutral', text); c.classList.add('home-count'); if (!n) c.classList.add('zero'); return c; };
  const chips = [
    slot(s.waiting, 'warn', `${s.waiting} need${s.waiting === 1 ? 's' : ''} you`),
    slot(s.working, 'info', `${s.working} working`),
    slot(s.shipped, 'ok', `${s.shipped} shipped`),
  ];
  const total = s.daily.reduce((a, b) => a + b, 0);
  const bars = h('span', { class: 'home-bars', role: 'img', 'aria-label': `${total} shipped in the last ${s.daily.length} days` }, ...s.daily.map((n, i) => {
    const bar = h('i', { title: `${dayLabel(days[i])}: ${n} shipped`, class: n ? null : 'none' });
    bar.style.setProperty('--v', String(n / top));
    return bar;
  }));
  return h('a', { class: 'hue-row home-scheme', href: `#/p/${s.id}`, 'data-cat': schemeHue(s.name) },
    h('span', { class: 'hue-row-text' }, schemeTag(s.name), h('span', { class: 'home-counts' }, ...chips)),
    h('span', { class: 'hue-row-meta' }, bars));
}

/** A Pacific day key ("2026-11-18") as "Tue Nov 18". */
function dayLabel(day) {
  if (!day) return '';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}

/** A time as people read it (Pacific, as the rest of Citadel shows it), e.g. "Tue 2:10 PM". */
function when(at) {
  return pacificWeekdayClock(at);
}

/** After your answer: once the list has no card left on that chat, open the next row's chat as shown (below it, else the first). */
function moveOn() {
  if (next == null || view?.id !== next) return void (next = null);
  const rows = groups();
  if (rows.has(next)) return; // it still asks something else: stay
  const at = visit.shown.indexOf(next);
  const after = [...visit.shown.slice(at + 1), ...visit.shown.slice(0, Math.max(at, 0))].find((id) => rows.has(id));
  const from = next;
  next = null;
  if (after == null) return;
  const t = (data?.tickets ?? []).find((x) => x.id === after);
  if (!t) return;
  // Long enough to see the card settle (Josh's "Move to the next card"); a row you click meanwhile wins.
  setTimeout(() => { if (view?.home && view.id === from) location.hash = rowHref(t, rows.get(after)); }, 800);
}
