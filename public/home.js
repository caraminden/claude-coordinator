// Home (#1140): what waits on you across every scheme you're in, on one list, with the chat you open from it beside
// it. Josh, 2026-11-19, picked "B · One list, a status line on top" with "a split view where you could see the minion
// chat on the right", then "C · An overview until you pick" (Working now and Shipped since your last visit until a
// row is clicked), "After you answer a card: Move to the next card" and "What else opens beside the list: No, they
// go to the scheme". The page with his picks: shared/project/mockups/home-all-schemes/home-split-view.html.
// The list is one element kept across pages (like the Needs-you strip), so moving between its chats keeps its scroll.
// It's drawn at once from the last answer this browser had, then refreshed behind. Rows keep their place for the
// whole visit: an answered one is ticked off where it was, and one that arrives joins the bottom with a "new" tag
// (no reflow without input).
import { HOME_LINE, ago, api, h, me, view } from './base.js';
import { inboxRow } from './inbox.js';
import { emptyCard, schemeHue, schemeTag, toneChip } from './look.js';

const CACHE = 'cc-home'; // the last /api/home answer, for the next first paint

let data = null; // the last answer: { items, schemes, shipped, me }, only ever drawn for the person it was fetched for
try { data = JSON.parse(localStorage.getItem(CACHE)); } catch {}
let failed = false; // the last fetch failed: the list says so, with a retry, rather than "Loading…" for good
// This visit: each list's ids in the order shown, the ones there when it opened (the rest are "new"), and the rows as last seen.
const visit = { rows: [], working: [], shipped: [], first: null, last: new Map(), fresh: false };
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
  Object.assign(visit, { rows: [], working: [], shipped: [], first: null, last: new Map(), fresh: false });
  next = null;
}

/** The list for the side panel (or the page itself on a phone): one element for the whole session. */
export function homePanel() {
  panel ??= h('div', { class: 'home-panel', 'data-part': 'home-list' });
  drawPanel();
  return panel;
}

/** What fills the middle until a row is picked: Working now and Shipped since your last visit, each line off to its scheme. */
export function homeOverview(list = null) {
  overview = h('div', { class: 'home-overview-body' });
  drawOverview();
  return h('section', { class: 'home-overview', 'data-part': 'home-overview' },
    h('div', { class: 'ticket-head' }, h('div', { class: 'row' }, h('h2', {}, 'Home'), h('span', { class: 'spacer' }))), list, overview);
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
  if (!visit.fresh) Object.assign(visit, { rows: [], working: [], shipped: [], first: null, fresh: true });
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

/** `ids` in the order this visit shows them: the ones already shown keep their place (gone ones too), new ones join the bottom. */
const stable = (shown, ids) => [...shown, ...ids.filter((id) => !shown.includes(id))];

/** Forget an answer fetched for someone else (a sign-out and in on this browser doesn't reload the page). */
const own = () => { if (data && data.me !== me) data = null; };

function groups() {
  const rows = new Map();
  for (const i of data?.items ?? []) {
    if (!rows.has(i.ticketId)) rows.set(i.ticketId, []);
    rows.get(i.ticketId).push(i);
  }
  return rows;
}

const rowHref = (items) => inboxRow(items, { href: homeHash }).getAttribute('href');

function drawPanel() {
  if (!panel) return;
  own();
  const rows = groups();
  visit.rows = stable(visit.rows, [...rows.keys()]);
  visit.first ??= new Set(rows.keys());
  for (const [id, items] of rows) visit.last.set(id, items);
  const open = rows.size;
  const working = (data?.schemes ?? []).reduce((n, s) => n + s.working.length, 0);
  const shipped = data?.shipped?.total ?? 0;
  // One line, always there: the numbers change, the line doesn't move.
  const status = h('div', { class: 'home-status' },
    open ? toneChip('warn', `${open} need${open === 1 ? 's' : ''} you`) : data ? toneChip('ok', 'Nothing needs you')
      : toneChip(failed ? 'danger' : 'neutral', failed ? 'Not loaded' : 'Loading'),
    working ? toneChip('info', `${working} working`) : null,
    shipped ? toneChip('violet', `${shipped} shipped`) : null);
  const list = visit.rows.map((id) => {
    const items = rows.get(id) ?? visit.last.get(id);
    const row = inboxRow(items, { href: homeHash, scheme: schemeTag });
    row.classList.toggle('active', view?.home && view.id === id);
    if (!rows.has(id)) {
      // Gone from Home (answered, a mention opened, or withdrawn): ticked off where it was, until the next visit.
      row.classList.add('done');
      row.querySelector('.asks')?.replaceChildren(h('span', { class: 'chip done-chip' }, '✓ Done'));
    } else if (visit.fresh && !visit.first.has(id)) row.querySelector('.name')?.prepend(h('span', { class: 'new-tag' }, 'new'));
    return row;
  });
  const retry = h('button', { type: 'button', class: 'link', onclick: () => { failed = false; drawPanel(); refreshHome(); } }, 'Try again');
  panel.replaceChildren(status, list.length ? h('div', { class: 'inbox-rows home-rows' }, ...list)
    : failed && !data ? emptyCard('Couldn\'t load Home', h('span', {}, 'What waits on you didn\'t load. ', retry), { mark: '!', hue: 'danger' })
      : emptyCard('Nothing needs you', data ? 'Cards and questions from any of your schemes show here.' : 'Loading what waits on you…'));
}

function drawOverview() {
  if (!overview) return;
  own();
  const schemes = data?.schemes ?? [];
  const working = schemes.flatMap((s) => s.working.map((t) => ({ ...t, projectId: s.id, scheme: s.name })));
  visit.working = stable(visit.working, working.map((t) => t.id));
  for (const t of working) visit.last.set(`w${t.id}`, t);
  const busy = new Set(working.map((t) => t.id));
  const shipped = data?.shipped?.items ?? [];
  const shipKey = (s) => `${s.ticketId}:${s.at}`;
  visit.shipped = stable(visit.shipped, shipped.map(shipKey));
  const ships = new Map(shipped.map((s) => [shipKey(s), s]));
  for (const s of shipped) visit.last.set(`s${shipKey(s)}`, s);
  const since = data?.shipped?.since;
  overview.replaceChildren(
    h('div', { class: 'home-column' },
      h('h3', { class: 'settings-section', 'data-hue': 'running' }, 'Working now'),
      visit.working.length ? h('div', { class: 'hue-rows' }, ...visit.working.map((id) => {
        const t = visit.last.get(`w${id}`);
        return line(t.projectId, t, busy.has(id) ? toneChip('info', 'Working') : toneChip('neutral', 'Stopped'), !busy.has(id));
      })) : emptyCard('Nothing working', 'Minions with a turn running, in any of your schemes, show here.', { mark: '·', hue: 'held' })),
    h('div', { class: 'home-column' },
      h('h3', { class: 'settings-section', 'data-hue': 'done' }, since ? `Shipped since ${when(since)}` : 'Shipped since your last visit'),
      visit.shipped.length ? h('div', { class: 'hue-rows' }, ...visit.shipped.map((key) => {
        const s = ships.get(key) ?? visit.last.get(`s${key}`);
        return line(s.projectId, s, h('span', { class: 'muted' }, ago(s.at)), false, shipText(s.text));
      }), (data?.shipped?.total ?? 0) > shipped.length ? h('div', { class: 'muted home-more' }, `and ${data.shipped.total - shipped.length} more`) : null)
        : emptyCard('Nothing shipped yet', 'What goes live in your schemes while you\'re away shows here.', { mark: '·', hue: 'held' })));
}

/** A line off to the scheme: its tag, the minion (or Taskmaster) and a chip or time on the right. */
function line(projectId, t, meta, quiet, sub = null) {
  const scheme = data?.schemes?.find((s) => s.id === projectId)?.name ?? '';
  const href = t.kind === 'coordinator' ? `#/p/${projectId}` : `#/p/${projectId}/t/${t.number}`;
  return h('a', { class: `hue-row home-line${quiet ? ' quiet' : ''}`, href, 'data-cat': schemeHue(scheme) },
    h('span', { class: 'hue-row-text' }, schemeTag(scheme), ' ',
      t.kind === 'coordinator' ? 'Taskmaster' : [h('span', { class: 'num' }, `#${t.number}`), ' ', t.title],
      sub ? h('span', { class: 'home-sub muted' }, sub) : null),
    h('span', { class: 'hue-row-meta' }, meta));
}

/** "Shipped abc1234: the fix. Risk low: …" as just what shipped. */
const shipText = (text) => String(text ?? '').replace(/^Shipped (?:[0-9a-f]{7,40} ".*?"|the branch(?:'s new tip)?): /, '').replace(/\. Risk (low|medium|high)\b[\s\S]*$/, '');

/** A time as people read it (Pacific, as the rest of Citadel shows it), e.g. "Tue 2:10 PM". */
function when(at) {
  return new Date(at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

/** After your answer: once the list has no card left on that chat, open the next row's chat (below it, else the first). */
function moveOn() {
  if (next == null || view?.id !== next) return void (next = null);
  const rows = groups();
  if (rows.has(next)) return; // it still asks something else: stay
  const at = visit.rows.indexOf(next);
  const after = [...visit.rows.slice(at + 1), ...visit.rows.slice(0, Math.max(at, 0))].find((id) => rows.has(id));
  const from = next;
  next = null;
  if (after == null) return;
  // Long enough to see the card settle (Josh's "Move to the next card"); a row you click meanwhile wins.
  setTimeout(() => { if (view?.home && view.id === from) location.hash = rowHref(rows.get(after)); }, 800);
}
