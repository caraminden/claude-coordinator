// The release monitor (#626, specs/release-monitor.md; data from #625's GET /api/releases and `releases` event): each
// scheme's targets under its row in the Schemes list (take A's stage track, the whole release's estimate, the current version,
// a hover with the detail), the Releases page over the chat (a scheme's cards, take D; All's stage board, take E, on
// desktop and every member scheme's cards on a phone) and the chip beside a minion's PR info (take F).
// Bars follow the spec's rule: by stage, sized by usual time, the current one stopping at 90% (waitBar's cap) and
// amber past LATE, a wait hatched with its reason, and no estimate while anything ahead waits.
import { ago, api, fileUrl, h, icon, schemeIcon, view } from './base.js';
import { canBack, canForward, goBack, goForward } from './navstack.js';
import { iconSrc } from './schemes.js';
import { openDialog } from './ui/dialog.js';
import { optimistic } from './ui/optimistic.js';
import { changeEta, COLUMNS, columnOf, releaseName, segments, shortSpan, stuckFor } from './releasemath.js';
import { claimsBlock, loadClaims, loadWatch, onHolderTicket, watchBlock } from './release-extras.js';
import { segTrack, TRACK } from './wait.js';
import { progressWhy } from './threadstate.js';
import { mountTips } from './ui/tip.js';
import { dragReorder, inOrder, moved } from './reorder.js';

/** projectId → { projectId, targets: TargetView[], testCopies } for every scheme this person can see (src/releases.ts). */
let schemes = new Map();
/** Schemes the person is a member of, hidden ones included: what All covers (Josh, 2026-11-13). */
let member = new Set();
let loaded = false;
/** What the open page shows ('all' or a scheme's id) and the change it highlights. */
let page = null;
/** Where × goes back to: the hash the page was opened from. */
let returnTo = null;

/** Fetch every scheme's releases (on the stream's hello, so after a reconnect too) and redraw what shows them. */
export async function loadReleases() {
  const got = await Promise.all([api('api/releases'), api('api/releases?scope=member')]).catch(() => null);
  if (!got) return; // an older server, or a restart's gap: the next hello asks again
  schemes = new Map(got[0].schemes.map((s) => [s.projectId, s]));
  for (const s of schemes.values()) settleDeploys(s);
  member = new Set(got[1].schemes.map((s) => s.projectId));
  loaded = true;
  refreshExtras();
  redraw();
  return rowsChanged();
}

/** Claims for every scheme the page can show (a scheme with only a claim has no releases entry), and the watch. */
function refreshExtras() {
  for (const id of new Set([...schemes.keys(), ...(view?.projects ?? []).map((p) => p.id)])) loadClaims(id, redraw);
  loadWatch(redraw);
}

/** A `claims` event: that scheme's claims changed. */
export function onClaims(msg) { loadClaims(msg.projectId, redraw); }

/** A `ticket` event: a claim holder's stage may have moved (#1334). */
export function onClaimHolder(ticket) { if (loaded) onHolderTicket(ticket, redraw); }

/** One scheme's part changed (the `releases` event); a scheme seen for the first time may be a member one, so ask again. True (or a promise of it) when a minion row's release changed. */
export function onReleases(msg) {
  if (!loaded) return;
  const s = msg.releases;
  const had = schemes.has(msg.projectId);
  settleDeploys(s);
  if (s.targets.some((t) => t.target.id === CITADEL_TARGET_ID)) loadWatch(redraw);
  if (s.targets.length || s.testCopies.length) schemes.set(msg.projectId, s);
  else schemes.delete(msg.projectId);
  if (!had && schemes.has(msg.projectId)) return loadReleases();
  redraw();
  return rowsChanged();
}

function redraw() {
  // Not under a row being dragged in the land line: it would drop the row from the finger. Again once it's let go.
  if (pageEl?.querySelector('.rel-changes.reorder-active')) return void setTimeout(redraw, 250);
  for (const el of document.querySelectorAll('[data-rel-scheme]')) el.replaceWith(releaseRows(Number(el.dataset.relScheme)));
  if (pageEl?.isConnected) fillPage();
  const slot = view?.branchEl?.querySelector('.rel-chip-slot');
  if (slot) {
    slot.replaceChildren(releaseChip(view.ticket) ?? '');
    view.branchEl.hidden = !view.branchEl.querySelector(':scope > :not(.rel-chip-slot)') && !slot.firstChild;
  }
}

// ---------- words and numbers ----------

const schemeOf = (id) => view?.projects?.find((p) => p.id === id) ?? (view?.project?.id === id ? view.project : null);
const schemeName = (id) => schemeOf(id)?.name ?? `Scheme ${id}`;
/** The scheme's icon as the sidebar shows it, beside its targets' names (Cara, 2026-11-12: "maybe also the scheme icons?"). */
const iconOf = (id) => (schemeOf(id) ? schemeIcon(schemeOf(id)) : '');
/** Stages whose key reads wrong to a person: a contraption's wait for someone to start its deploy, and a PR's wait for its go (Cara, 2026-11-19, picked "Ship" on #1020's card). */
const STAGE_NAMES = { call: 'Start', merge: 'Ship', land: 'Ship' };
/** A stage's name as the land track says it, else the stage itself, capitalised. */
const stageName = (key) => {
  if (STAGE_NAMES[key]) return STAGE_NAMES[key];
  const t = TRACK.find(([k]) => k === key);
  // A short key is an initialism ("ci" → "CI").
  return t ? t[2] ?? t[1] : key.length <= 3 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
};
const isSha = (v) => /^[0-9a-f]{7,40}$/.test(v);
const minionHref = (projectId, c) => (c.number != null ? `#/p/${projectId}/t/${c.number}` : `#/t/${c.ticketId}`);
/** Where Releases opens from scheme `id` with no scope named (Josh, 2026-11-19): that scheme's own, and every scheme's only from Citadel (project 2). */
export const defaultScope = (id) => (Number(id) === 2 ? 'all' : Number(id));

const pageHref = (scope, hl) => `#/p/${view?.projectId ?? ''}/releases/${scope}${hl ? `/${hl}` : ''}`;
/** "50s", "3m", "1h 5m": an estimate's size, rounded. */
const tookText = (r) => {
  if (!(r.started && r.live)) return null;
  const total = r.live - r.started, line = Number(r.stages?.line) * 1000;
  // Cara, 2026-11-20: "took 5m after 29m in line": the ship-line wait is pulled out of the release's own work (a wait under a minute stays in "took")
  return line >= 60000 && line < total ? `${shortSpan(total - line)} after ${shortSpan(line)} in line` : shortSpan(total);
};

/**
 * "~3m" that counts down on the ticker. Past the estimate it says what's happening rather than "due now", which read as a
 * deadline (Cara, 2026-11-14: "What does this due now thing mean?"): "running long · usually ~2m", the usual span being
 * from `since` (the current stage's start) to the estimate; `full` false leaves the usual time to the hover, for narrow
 rows under a stage line that says it. With no `since` (auto-deploy's timer) it's "any moment".
 */
function etaText(eta, { suffix = '', since = null, full = true } = {}) {
  return h('span', { class: 'rel-eta', 'data-eta': eta, 'data-suffix': suffix, 'data-since': since ?? '', 'data-full': full ? '1' : '', title: etaTitle(eta, since) },
    etaWords(eta, suffix, since, full));
}
const etaWords = (eta, suffix, since, full) => {
  if (eta > Date.now()) return `~${shortSpan(eta - Date.now())}${suffix}`;
  if (!since) return 'any moment';
  return full ? `running long · usually ~${shortSpan(eta - since)}` : 'running long';
};
/** The hover past the estimate: the usual time spelled out, and how long this stage has run. */
const etaTitle = (eta, since) => (eta <= Date.now() && since
  ? `Taking longer than usual: this stage and the rest usually take ~${shortSpan(eta - since)}; this stage started ${shortSpan(Date.now() - since)} ago`
  : '');

/** The commit or version name behind it, shown small on its card for whoever wants it (no hover: Cara, 2026-11-12, "if you want more info, click"). */
const releaseDetail = (r) => (r.version ? (isSha(r.version) ? `commit ${r.version.slice(0, 7)}` : `version ${r.version}`) : '');

/** A release by its number, linked to the release itself (the live site, its file) when it has one: a new tab, as it may leave Citadel. */
function versionLink(r, cls = 'rel-ver', short = false) {
  return r.link ? h('a', { class: cls, href: r.link, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, releaseName(r, short))
    : h('span', { class: cls }, releaseName(r, short));
}

// ---------- the Schemes list ----------

/** The whole release's estimate: "~3m", "waiting" while a stage waits, else the stage it's at. */
let relTips = null;
/** A row's estimate, whose tap or hover says why (#906): what it waits on, since when, against usual. */
function estimate(next) {
  relTips ??= mountTips(document.body, { selector: '.rel-row .rel-est[data-tip]', tapOpens: true });
  const tip = { tabindex: 0, 'data-tip': progressWhy(next, stageName(next.stage)) };
  if (next.waitingOn) return h('span', { class: 'rel-est waits', ...tip }, 'waiting');
  const el = h('span', { class: 'rel-est', ...tip }, next.eta ? etaText(next.eta, { since: next.since, full: false }) : stageName(next.stage));
  el.querySelector('.rel-eta')?.removeAttribute('title'); // the popover says it, on a phone too
  return el;
}

/** Remember where the page was opened from, for its ×. */
function opening() {
  if (!/\/releases\//.test(location.hash)) returnTo = location.hash;
}

/**
 * A scheme's targets with something queued or on its way, one indented row each, under its row in the Schemes list;
 * an idle target shows none (Josh, 2026-11-13: "only show up if there is something in the release queue"). The empty
 * container stays, hidden by CSS, so redraw() finds it when a change enters the queue.
 */
export function releaseRows(projectId) {
  const s = schemes.get(projectId);
  return h('div', { class: 'rel-rows', 'data-rel-scheme': projectId }, (s?.targets ?? []).filter((tv) => tv.next).map((tv) => {
    const href = pageHref(projectId);
    return h('div', {
      class: 'rel-row',
      // The whole row opens the scheme's page (Josh: "clicking any of the releases would take you to that schemes detail page"); its release link opens the release.
      onclick: (e) => { if (!e.target.closest('a') && !e.defaultPrevented) { opening(); location.hash = href; } }, // a tap on the estimate opens its why
    },
    h('a', { class: 'rel-name', href, onclick: opening }, tv.target.name),
    estimate(tv.next),
    // The release being made (Cara, 2026-11-17): its number, linked to its preview or download when it has one, plain when not; never the current release.
    versionLink(tv.next.number != null ? tv.next : { ...tv.next, link: null }, 'rel-ver', true),
    stageTrack(tv.next.stages, tv.next));
  }));
}

/** The Releases link beside the Schemes heading, styled as Browse beside Artifacts: opens All. */
export function releasesLink() {
  return h('a', { class: `browse${view?.main === 'releases' && page?.scope === defaultScope(view.projectId) ? ' active' : ''}`, href: pageHref(defaultScope(view?.projectId)), onclick: opening, title: Number(view?.projectId) === 2 ? 'Releases of every scheme you\'re a member of' : 'This scheme\'s releases' }, 'Releases');
}

// ---------- tracks ----------

/** The stage track (takes D, E, F): wait.js segTrack, a segment per stage; `labels` names them under. */
function stageTrack(stages, p, { mini = false, labels = false } = {}) {
  const list = segments(stages);
  const at = list.findIndex((s) => s.name === p.stage);
  return segTrack(list.map((s, i) => ({
    size: s.usual, name: stageName(s.name), state: i < at ? 'done' : i === at ? 'now' : '', waits: !!p.waitingOn,
    clock: { stage: p.stage, since: p.since, usual: p.usual, done: p.done, total: p.total },
  })), { cls: `rel-track${mini ? ' mini' : ''}`, labels, label: `${stageName(p.stage)}, stage ${at + 1} of ${list.length}` });
}

/**
 * Where a change or release is, in a few words: its short ones first (Josh, 2026-11-13: "the line should be apparent
 * from the list you are looking at"): "Line · 2nd", "Test · CI: the full suite" (#630's), then its wait, time left or text.
 */
const nowWords = (p, eta, full = false) => {
  const stuck = stuckFor(p);
  if (stuck) return `stuck ${shortSpan(stuck)}: ${p.waitingOn}`;
  return p.brief ?? p.waitingOn ?? (eta ? etaText(eta, { suffix: ' left', since: p.since, full }) : p.text);
};

/** A row's "now" words with its ship train: the front says how many ride, a rider whose train it is in, a waiter which train it will be in. */
function trainNow(next, c, waits) {
  const t = c.train;
  if (!t) return waits ? [waits] : changeNow(next, c);
  const members = `Releasing now: ${t.members?.join(', ')}`;
  if (t.role === 'rider') return [h('b', { class: 'work' }, 'Riding'), ' ', h('span', { class: 'muted', title: members }, `in ${t.front}'s train`)];
  if (t.role === 'front') return [h('span', { title: members }, changeNow(next, c))];
  return [h('b', { class: 'waits' }, t.label)];
}

/** A change's stage and its short words: "Deploy ~50s left", "Line 2nd". */
function changeNow(next, c) {
  return [h('b', { class: c.waitingOn ? 'waits' : 'work' }, stageName(c.stage)), ' ', h('span', { class: 'muted' }, nowWords(c, changeEta(next, c)))];
}

// ---------- the page ----------

let pageEl = null;

/** Open the page on `scope` ('all' or a scheme's id), with change `hl` (a ticket id) highlighted. */
export function setReleasesPage(scope, hl) {
  page = { scope, hl };
}

/** The Releases page over the chat column (on a phone, the whole screen with a back arrow). */
export function releasesPage() {
  if (loaded) refreshExtras();
  pageEl = h('section', { class: 'releases-main', onkeydown: (e) => { if (e.key === 'Escape') closePage(); } });
  fillPage();
  return pageEl;
}

function closePage() {
  location.hash = returnTo ?? `#/p/${view.projectId}`;
  returnTo = null;
}

/** The schemes All covers, in the Schemes list's order, then any it doesn't list. */
function allSchemes() {
  const order = (view?.projects ?? []).map((p) => p.id);
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length + id);
  return [...schemes.keys()].filter((id) => member.has(id)).sort((a, b) => rank(a) - rank(b));
}

function fillPage() {
  const scope = page?.scope ?? 'all';
  const ids = allSchemes();
  const chipIds = scope !== 'all' && !ids.includes(scope) ? [...ids, scope] : ids;
  const chip = (s, label) => h('a', { class: `chip${scope === s ? ' on' : ''}`, href: pageHref(s), 'aria-current': scope === s ? 'page' : undefined }, label);
  // The chat header's ‹ › × (thread.js renderTicketHead): its buttons, icons and history, at the end of the pills' line.
  const close = (cls, name) => h('button', { type: 'button', class: `close-view ${cls}`, 'aria-label': 'Close', title: 'Close', onclick: closePage }, icon(name));
  const body = !loaded ? [h('p', { class: 'muted' }, 'Loading releases…')]
    : scope === 'all' ? allView(ids)
      : schemeCards(scope, true);
  // On a phone the chips give way to one box naming the scheme you're on, which opens the list of them (#820, Cara
  // picked take A, 2026-11-16): a strip of 11 chips showed 3 and could hide the one you were on.
  const picker = h('button', { type: 'button', class: 'rel-pick', 'aria-haspopup': 'dialog', title: 'Pick a scheme', onclick: () => openPicker(scope, chipIds) },
    pickIcon(scope), h('span', { class: 'rel-pick-name' }, scopeName(scope)),
    h('span', { class: 'rel-pick-sub' }, scope === 'all' ? `${ids.length} schemes` : targetNames(scope)), h('span', { class: 'rel-pick-caret', 'aria-hidden': 'true' }, '▾'));
  pageEl.replaceChildren(
    h('div', { class: 'ticket-head rel-head' },
      h('div', { class: 'row' }, close('narrow-only', 'back'), h('h2', {}, 'Releases', h('span', { class: 'wide-only' }, ` · ${scopeName(scope)}`))),
      h('div', { class: 'head-sub rel-sub' },
        h('nav', { class: 'chips rel-chips', 'aria-label': 'Schemes' }, chip('all', 'All'), chipIds.map((id) => chip(id, schemeName(id)))),
        picker,
        h('span', { class: 'spacer' }),
        h('span', { class: 'head-nav' },
          h('button', { type: 'button', class: 'nav-btn nav-back', title: 'Back', 'aria-label': 'Back', disabled: !canBack(), onclick: goBack }, icon('back')),
          h('button', { type: 'button', class: 'nav-btn nav-forward', title: 'Forward', 'aria-label': 'Forward', disabled: !canForward(), onclick: goForward }, icon('forward')),
          close('wide-only', 'close')))),
    h('div', { class: 'rel-body' }, body));
  // Brings the highlighted change into view once, so a later update doesn't pull back someone who scrolled away.
  const hl = page?.hl != null && !page.shown && pageEl.querySelector('.rel-card.hl, .rel-change.hl');
  if (hl) { page.shown = true; hl.scrollIntoView({ block: 'nearest' }); }
}

const scopeName = (scope) => (scope === 'all' ? 'All' : schemeName(scope));
const targetNames = (id) => (schemes.get(id)?.targets ?? []).map((tv) => tv.target.name).join(' · ');
/** The scheme's icon for the picker, its initial when it has none (so the names line up), a mark for All. */
function pickIcon(scope) {
  if (scope === 'all') return h('span', { class: 'rel-pick-icon all', 'aria-hidden': 'true' }, '∗');
  // The initial sits under the icon, so it shows while the icon loads or if it fails (TripPresenter's 404s).
  const p = schemeOf(scope);
  return h('span', { class: 'rel-pick-icon', 'aria-hidden': 'true' }, schemeName(scope).slice(0, 1), p && iconSrc(p) ? schemeIcon(p) : '');
}

/** The phone's list of schemes: a sheet along the bottom (the kit's dialog), the one you're on ticked. */
function openPicker(scope, ids) {
  const row = (s) => h('a', { class: `rel-opt${scope === s ? ' on' : ''}`, href: pageHref(s), 'aria-current': scope === s ? 'page' : undefined, onclick: () => dialog.close() },
    pickIcon(s), h('span', { class: 'rel-opt-name' }, scopeName(s)),
    h('span', { class: 'rel-opt-sub' }, s === 'all' ? 'every scheme' : targetNames(s)), h('span', { class: 'rel-opt-check', 'aria-hidden': 'true' }, scope === s ? '✓' : ''));
  // new-scheme: project.css's sizing, a sheet along the bottom on phones, as briefstart.js and ultrareview.js use it.
  const dialog = openDialog({ title: 'Releases of', className: 'new-scheme rel-sheet',
    body: h('nav', { class: 'rel-opts', 'aria-label': 'Schemes' }, row('all'), ids.map(row)) });
}

/** The server's own deploy: the post-deploy watch is this server's, so only Citadel's card shows it. */
const CITADEL_TARGET_ID = 'citadel-server';

/** A scheme's cards (take D): one per target, then its test copies of no target. */
function schemeCards(projectId, alone) {
  const s = schemes.get(projectId);
  if (!s) return alone ? [claimsBlock(projectId, redraw), h('p', { class: 'muted rel-empty' }, `Nothing ships from ${schemeName(projectId)} yet: no release, preview or test copy.`)] : [claimsBlock(projectId, redraw)];
  return [
    claimsBlock(projectId, redraw),
    ...s.targets.flatMap((tv) => [targetCard(projectId, tv, alone), tv.target.id === CITADEL_TARGET_ID ? watchBlock() : '']),
    // On its own page the scheme's name is in the heading; among every scheme's cards, it leads each card's title.
    s.testCopies.length ? h('article', { class: 'rel-card' },
      h('header', {}, h('h3', {}, iconOf(projectId), alone ? 'Test copies' : `${schemeName(projectId)} test copies`)), copyList(s.testCopies)) : '',
  ];
}

function targetCard(projectId, tv, alone) {
  const n = tv.next, cur = tv.current, hl = page?.hl;
  const curTook = cur && tookText(cur);
  return h('article', { class: `rel-card${hl && n?.changes.some((c) => c.ticketId === hl) ? ' hl' : ''}` },
    h('header', {}, h('h3', {}, iconOf(projectId), alone ? tv.target.name : `${schemeName(projectId)} ${tv.target.name}`)),
    h('p', { class: 'rel-current' }, 'Current: ', cur ? versionLink(cur) : 'none yet', cur?.live ? ` · live ${ago(cur.live)}` : '', curTook ? ` · took ${curTook}` : '',
      cur && releaseDetail(cur) ? h('span', { class: 'muted rel-detail' }, ` · ${releaseDetail(cur)}`) : ''),
    deployBar(projectId, tv),
    rollbackBar(projectId, tv),
    keyBar(projectId, tv),
    h('h4', {}, n?.number != null ? ['Next: ', n.link ? h('a', { class: 'rel-ver', href: n.link, target: '_blank', rel: 'noopener' }, releaseName(n), ' (try it)') : releaseName(n)] : n?.name ?? 'Next release'),
    n ? [
      stageTrack(n.stages, n, { labels: true }),
      h('p', { class: 'rel-now' }, h('b', {}, stageName(n.stage)), ' · ', h('span', { class: n.waitingOn ? 'waits' : '' }, nowWords(n, n.eta, true))),
    ] : h('p', { class: 'muted' }, 'Nothing on its way.'),
    changeList(projectId, tv),
    previousList(projectId, tv),
    tv.testCopies.length ? [h('h4', {}, 'Test copies'), copyList(tv.testCopies)] : '');
}

/** The cards whose Previous releases are open ("projectId/target"): every event redraws the cards, so it's kept here. */
const openPrevious = new Set();

/**
 * A target's earlier releases, collapsed until clicked (Cara, 2026-11-12: "maybe we have a "Previous Releases" tab ...
 * Previous releases could have links to old builds and how long the build took to deploy"): each one's number (linked
 * to its file or site while one still exists), when it went live, how long it took and the minions it carried.
 */
function previousList(projectId, tv) {
  if (!tv.recent.length) return '';
  const key = `${projectId}/${tv.target.id}`;
  const label = (r) => (r.number != null ? releaseName(r) : r.outcome === 'signed' ? 'Signed build' : r.outcome === 'live' ? 'Earlier release' : 'Failed try');
  return h('details', { class: 'rel-prev', open: openPrevious.has(key), ontoggle: (e) => (e.target.open ? openPrevious.add(key) : openPrevious.delete(key)) },
    h('summary', {}, `Previous releases (${tv.recent.length})`),
    h('ul', { class: 'rel-prev-list' }, tv.recent.map((r) => {
      const failed = r.outcome !== 'live' && r.outcome !== 'signed';
      const took = tookText(r) ?? (r.stages?.sign != null ? shortSpan(r.stages.sign * 1000) : null); // a signed APK never goes live: its signing is the whole run
      const when = r.live ? `live ${ago(r.live)}` : r.started ? `${failed ? 'tried' : 'built'} ${ago(r.started)}` : '';
      return h('li', {},
        r.link ? h('a', { class: 'rel-ver', href: r.link, target: '_blank', rel: 'noopener' }, label(r)) : h('span', { class: 'rel-prev-name' }, label(r)),
        failed ? h('span', { class: 'rel-failed' }, r.outcome) : '',
        h('span', { class: 'muted' }, [when, took ? `took ${took}` : '', releaseDetail(r)].filter(Boolean).join(' · ')),
        r.changes.length > 1 ? h('span', { class: 'rel-together muted' }, `${r.changes.length} ships went out together`) : '',
        r.changes.length ? h('span', { class: 'rel-prev-changes' }, r.changes.length > 1 ? r.changes.map((c) => h('span', { class: 'rel-prev-ship' }, h('a', { href: minionHref(projectId, c) }, `#${c.number ?? c.ticketId}`), ' ', c.title)) : r.changes.flatMap((c) => [h('a', { href: minionHref(projectId, c) }, `#${c.number ?? c.ticketId}`), ' ', c.title])) : '');
    })));
}

// ---------- deploying (#629) ----------

/** Targets whose Deploy was pressed here and whose deploy the server hasn't shown yet: "projectId/target". */
const deploying = new Set();

/** A deploy pressed here shows as one until the server's own view stops offering it (it's running, or done). */
function settleDeploys(s) {
  for (const tv of s.targets) {
    if (!tv.deploy?.can) deploying.delete(`${s.projectId}/${tv.target.id}`);
    if (!tv.rollback?.can) rollingBack.delete(`${s.projectId}/${tv.target.id}`);
  }
}

/** A target's deploy as last drawn: events replace the objects, so actions look it up again rather than keep one. */
const deployOf = (projectId, id) => schemes.get(projectId)?.targets.find((t) => t.target.id === id)?.deploy;

/**
 * A deployable target's Deploy button and auto-deploy switch (Cara, 2026-11-12: "Yes, on any target that can deploy").
 * The button shows while a next release waits and no deploy runs; pressing it shows "Deploying…" at once and sends
 * behind it, and a refusal puts the button back with a toast and Retry. Busy shows on this card alone.
 */
function deployBar(projectId, tv) {
  const d = tv.deploy;
  if (!d) return '';
  const key = `${projectId}/${tv.target.id}`;
  const body = { projectId, target: tv.target.id };
  const press = () => optimistic({
    key: `deploy:${key}`,
    apply: () => { deploying.add(key); redraw(); },
    send: () => api('api/releases/deploy', { method: 'POST', body }),
    undo: () => { deploying.delete(key); redraw(); },
    label: `deploy ${schemeName(projectId)} ${tv.target.name}`,
  });
  const show = (on) => {
    const cur = deployOf(projectId, tv.target.id);
    if (cur) cur.auto = on;
    redraw();
  };
  const flip = (on) => optimistic({
    sets: `auto-deploy:${key}`,
    apply: () => show(on),
    send: () => api('api/releases/auto-deploy', { method: 'PUT', body: { ...body, on } }),
    undo: () => show(!on),
    label: `turn ${on ? 'on' : 'off'} auto-deploy for ${schemeName(projectId)} ${tv.target.name}`,
  });
  const busy = deploying.has(key) && d.can;
  return h('div', { class: 'rel-deploy' },
    busy ? h('span', { class: 'rel-deploying', role: 'status' }, 'Deploying…')
      : d.can ? h('button', { type: 'button', class: 'secondary', onclick: press, title: 'Deploy the next release now' }, 'Deploy') : '',
    h('label', { class: 'rel-auto', title: 'Deploys by itself about 5 minutes after main last moved' },
      h('input', { type: 'checkbox', checked: d.auto, onchange: (e) => flip(e.target.checked) }), 'Auto-deploy'),
    d.due && !busy ? h('span', { class: 'muted' }, 'deploys by itself ', etaText(d.due)) : '');
}

/** Targets whose Roll back to last green was pressed here, until the server's view stops offering it: "projectId/target". */
const rollingBack = new Set();

/**
 * Roll back to last green (#1016, docs/adr/0010-roll-back-to-last-green.md): offered while what runs is newer than the
 * scheme's last green (Cara, 2026-11-18: "Last green only"). Pressing it shows "Rolling back…" at once and deploys last
 * green behind it; a refusal puts the button back with a toast and Retry. Once there, the target stays pinned until main
 * has a newer green commit ("Hold until the fix"), and the line says so; a roll back that didn't go live says why.
 */
function rollbackBar(projectId, tv) {
  const rb = tv.rollback;
  if (!rb) return '';
  const key = `${projectId}/${tv.target.id}`;
  const to = rb.sha.slice(0, 7);
  const press = () => optimistic({
    key: `rollback:${key}`,
    apply: () => { rollingBack.add(key); redraw(); },
    send: () => api('api/releases/rollback', { method: 'POST', body: { projectId, target: tv.target.id } }),
    undo: () => { rollingBack.delete(key); redraw(); },
    label: `roll ${schemeName(projectId)} ${tv.target.name} back to last green`,
  });
  const busy = rb.running || (rollingBack.has(key) && rb.can);
  const pin = rb.pin;
  const line = busy ? h('span', { class: 'rel-deploying', role: 'status' }, `Rolling back to ${to}…`)
    : pin ? h('span', { class: 'muted' }, `Rolled back to ${pin.sha.slice(0, 7)} from ${pin.from.slice(0, 7)} by ${pin.by} ${ago(pin.at)}: `,
      // Citadel's server has no Deploy: the fix's own land deploys it, and land.sh holds every other land until then.
      tv.deploy ? 'it stays there until main has a newer commit that passes the full suite. Deploy takes main live now.'
        : tv.target.kind === 'citadel-server' ? `changes wait to ship until a fix to ${pin.from.slice(0, 7)} goes live.`
        : `${pin.code ? `signed as build ${pin.code}, ` : ''}it stays there until main has a newer commit that passes the full suite.`)
      : rb.failed ? h('span', { class: 'waits' }, `Roll back to ${rb.failed.sha.slice(0, 7)} didn't go live ${ago(rb.failed.at)}: ${rb.failed.why}`) : '';
  const button = !busy && rb.can
    ? h('button', { type: 'button', class: 'secondary', onclick: press, title: rollbackTitle(tv.target.kind, to) }, `Roll back to last green ${to}`)
    : '';
  if (!line && !button) return '';
  return h('div', { class: 'rel-deploy rel-rollback' }, button, line);
}

/** What the roll back button does on each kind of card (ADR 0012): an APK goes out as the next version, a CI package hands out an existing build. */
function rollbackTitle(kind, to) {
  const hold = 'and hold it there until a newer one passes';
  if (kind === 'apk') return `Sign ${to}, the newest commit on main that passed the full suite, as the next Android build and publish it, so phones update to it, ${hold}`;
  if (kind === 'ci') return `Hand out the build made at or before ${to}, the newest commit on main that passed the full suite, in place of the newest, ${hold}`;
  return `Deploy ${to}, the newest commit on main that passed the full suite, ${hold}`;
}

/** Apps whose Make release key was pressed here, until the server's view stops offering it: "projectId/app". */
const makingKeys = new Set();

/**
 * A keyless Capacitor app's Make release key button (#837; Cara, 2026-11-17, "Both"): any member of its scheme makes the
 * key on the server, which never sends it or its password back. "Making the key…" shows at once; a refusal puts the
 * button back with a toast and Retry.
 */
function keyBar(projectId, tv) {
  const app = tv.releaseKey;
  if (!app) return '';
  const key = `${projectId}/${app}`;
  const press = () => optimistic({
    key: `release-key:${key}`,
    apply: () => { makingKeys.add(key); redraw(); },
    send: () => api('api/releases/release-key', { method: 'POST', body: { projectId, contraption: app } }),
    undo: () => { makingKeys.delete(key); redraw(); },
    label: `make ${schemeName(projectId)} ${tv.target.name}'s release key`,
  }).then(() => makingKeys.delete(key), () => {});
  return h('div', { class: 'rel-deploy rel-key' },
    makingKeys.has(key) ? h('span', { class: 'rel-deploying', role: 'status' }, 'Making the key…')
      : h('button', { type: 'button', class: 'secondary', onclick: press, title: 'Make its Android signing key on the server. It is never replaced, and it goes off-box nightly.' }, 'Make release key'),
    h('span', { class: 'muted' }, 'No release key yet, so its Android app isn\'t built.'));
}

/** A target's changes in the order its list shows them: the ones under way (-1), furthest along first, then the land line in its order. */
function changeRows(tv) {
  const changes = tv.next?.changes ?? [];
  const at = (id) => tv.line.findIndex((e) => e.ticketId === id);
  // A rider goes right behind its front, whatever waiters sit between them in the line (the server's order for the release).
  const frontAt = at(changes.find((c) => c.train?.role === 'front')?.ticketId);
  const place = (c, k) => (c.train?.role === 'rider' && frontAt >= 0 ? frontAt + (k + 1) / (changes.length + 1) : at(c.ticketId));
  return [
    ...changes.map((c, k) => ({ c, i: at(c.ticketId), key: place(c, k) })),
    ...tv.line.flatMap((e, i) => (e.ticketId != null && changes.some((c) => c.ticketId === e.ticketId) ? [] : [{ e, i, key: i }])),
  ].sort((a, b) => a.key - b.key); // stable: the changes past the line (-1) keep their furthest-along-first order
}

/** Each minion's place in that order across the targets (the minions list's Deploying section sorts by it, #1003): ticketId → index. */
export function releaseOrder() {
  const order = new Map();
  for (const s of schemes.values()) for (const tv of s.targets) for (const { c, e } of changeRows(tv)) {
    const id = (c ?? e).ticketId;
    if (id != null && !order.has(id)) order.set(id, order.size);
  }
  return (t) => order.get(t.id);
}

/**
 * The changes on their way and the land line as one list (Josh, 2026-11-13: "this feels like we wrote the same UI twice?
 * can we consolidate into one list?"): those past the line first, then the line in its order, the lock's holder at its
 * head. A line entry that isn't one of the changes (a deploy run alone, another branch) gets a row of its own.
 * Each row is numbered from the front (Josh, 2026-11-13: "the far left could just number the line"), the front one
 * coloured, the rest shaded in turn; a place in the line then just says "waiting", and each change offers what it can
 * be tried on (tryIt).
 */
function changeList(projectId, tv) {
  const n = tv.next, hl = page?.hl;
  const line = lineInOrder(projectId, tv.line);
  const rows = changeRows({ ...tv, line })
    // a landing from a branch (or a scheme's land script) older than reordering can't move
    .map((r) => ({ ...r, wait: r.i >= 0 && line[r.i].movable ? line[r.i] : null, why: r.i >= 0 && !line[r.i].holds ? line[r.i].why : null }));
  if (!rows.length) return '';
  const waiting = () => h('b', { class: 'waits' }, 'waiting');
  // Only the changes in the release under way sit under its name; the ones past it say what they wait behind (no number).
  const firstLater = rows.findIndex((r) => r.c?.later);
  const inLine = ['line', 'land'].includes(rows[firstLater]?.c?.stage) && !rows[firstLater]?.c?.train ? ': in line' : '';
  const next = rows[firstLater]?.c?.train;
  const after = firstLater > 0 ? `${next ? 'Releasing next, after' : 'After'} ${n.number != null ? releaseName(n).toLowerCase() : 'this release'}${inLine}` : '';
  const now = rows[0]?.c?.train?.role === 'front' ? `Releasing now: train of ${rows[0].c.train.size}` : '';
  const waiters = rows.filter((r) => r.wait);
  const list = h('ol', { class: 'rel-changes' }, rows.flatMap((r, i) => [...(i === 0 && now ? [h('li', { class: 'rel-after muted' }, now)] : []), ...(i === firstLater && after ? [h('li', { class: 'rel-after muted' }, after)] : []), row(r, i)]));
  // The landings waiting in line move (#1002): dragged, or sent to the front of the waiters with Land next. The holder
  // and the changes past the line stay put.
  if (waiters.length > 1) {
    dragReorder(list, {
      items: () => [...list.querySelectorAll(':scope > li[data-seq]')],
      onDrop: (from, to) => {
        const seqs = [...list.querySelectorAll(':scope > li[data-seq]')].map((li) => Number(li.dataset.seq));
        reorderLine(projectId, line, moved(seqs, from, to), seqs[from]);
      },
    });
  }
  return list;
  /** A waiter that can't move says why in its row (#1007), when there is a line to move in. */
  function stuck(why) {
    return why && line.filter((x) => !x.holds).length > 1 ? h('span', { class: 'stuck muted' }, why) : '';
  }
  function row({ c, e, wait, why }, i) {
    const cls = `rel-change${i === 0 ? ' front' : ''}${c && c.ticketId === hl ? ' hl' : ''}${wait && waiters.length > 1 ? ' movable' : ''}`;
    const pos = h('span', { class: 'rel-pos' }, String(i + 1));
    const seq = wait ? { 'data-seq': wait.seq } : {};
    if (c) {
      return h('li', { class: cls, ...seq }, pos, h('div', { class: 'body' },
        h('span', { class: 'what' }, h('a', { href: minionHref(projectId, c) }, `#${c.number ?? c.ticketId}`), ' ', c.title),
        h('span', { class: 'where' }, stageTrack(n.stages, c, { mini: true }), ...trainNow(n, c, i > 0 && (c.stage === 'line' || (c.stage === 'land' && c.waitingOn)) ? waiting() : null)),
        landNext(wait), stuck(why), tryIt(projectId, tv, c)));
    }
    return h('li', { class: cls, ...seq }, pos, h('div', { class: 'body' },
      h('span', { class: 'what' }, e.ticketId != null ? h('a', { href: `#/t/${e.ticketId}` }, e.name) : e.name),
      h('span', { class: 'where' }, n ? stageTrack(n.stages, { stage: e.stage, since: e.since, usual: null, waitingOn: e.holds ? null : e.place }, { mini: true }) : '',
        e.holds ? [h('b', { class: 'work' }, stageName(e.stage)), ' ', h('span', { class: 'muted' }, 'holds the lock')]
          : i > 0 ? waiting() : [h('b', { class: 'waits' }, 'Line'), ' ', h('span', { class: 'muted' }, e.place)]),
      landNext(wait), stuck(why)));
  }
  /** Land next: the waiter goes to the front of the waiting landings (for a phone or a keyboard, where dragging is clumsy). */
  function landNext(wait) {
    if (!wait || wait === line.find((e) => !e.holds)) return '';
    const seqs = waiters.map((r) => r.wait.seq);
    return h('button', { type: 'button', class: 'secondary land-next', title: 'Move it to the front of the changes waiting to ship: it ships once the one shipping now is done',
      onclick: () => reorderLine(projectId, line, [wait.seq, ...seqs.filter((s) => s !== wait.seq)], wait.seq) }, 'Ship next');
  }
}

/** projectId → the waiting landings' line tickets in the order last set here, shown until the server's line says it (#1002). */
const lineOrders = new Map();
let lineDrops = 0;

/** The line with its waiters in the order set here, if that's still on its way; the holder stays in front. */
function lineInOrder(projectId, line) {
  const order = lineOrders.get(projectId);
  if (!order) return line;
  const waiting = line.filter((e) => !e.holds);
  // Once the server's line has the waiters in this order (or none of them wait any more), it speaks for itself.
  const keys = order.filter((s) => waiting.some((e) => e.seq === s));
  if (keys.every((s, i) => waiting[i]?.seq === s)) {
    lineOrders.delete(projectId);
    return line;
  }
  return [...line.filter((e) => e.holds), ...inOrder(waiting, (e) => e.seq, keys)];
}

/**
 * Set the waiting landings' order (#1002): the rows move at once, and the server's land line (tools/deploy-queue.sh's
 * queue/.order) follows; a refusal puts the rows back with a toast and Retry. `moved` is the row dragged or sent next.
 */
function reorderLine(projectId, line, seqs, movedSeq) {
  const drop = ++lineDrops;
  const name = line.find((e) => e.seq === movedSeq)?.name ?? 'the change';
  let before;
  optimistic({
    sets: `land-order:${projectId}`,
    apply: () => {
      before = lineOrders.get(projectId);
      lineOrders.set(projectId, seqs);
      redraw();
    },
    send: () => api('api/releases/land-order', { method: 'POST', body: { projectId, order: seqs, moved: movedSeq } }),
    undo: () => {
      if (before) lineOrders.set(projectId, before);
      else lineOrders.delete(projectId);
      redraw();
    },
    label: `move ${name} in the ship line`,
  }).then(() => setTimeout(() => {
    // The server's releases event has come by now: from here its line speaks, a move someone else made since included.
    if (drop !== lineDrops) return;
    lineOrders.delete(projectId);
    redraw();
  }, 3000), () => {});
}

/** Citadel changes whose preview was requested here and isn't in the server's test copies yet: their ticket ids. */
const requested = new Set();

/**
 * What a change can be tried on before it's live (Josh, 2026-11-13: "a link to the file for and build/preview that might
 * exist"): its preview or a build its minion left in its files, linked to itself. A Citadel change without one offers
 * Request preview: it shows "Starting preview…" at once, POSTs start_preview's route behind it, and turns into the
 * link once the server lists the preview. Other kinds have nothing per change to start yet (#638's notes).
 */
function tryIt(projectId, tv, c) {
  const copies = [...tv.testCopies, ...(schemes.get(projectId)?.testCopies ?? [])].filter((x) => x.ticketId === c.ticketId);
  const preview = copies.find((x) => x.kind === 'preview');
  if (preview) {
    requested.delete(c.ticketId);
    return h('span', { class: 'try' }, h('a', { href: `../${preview.path}`, target: '_blank', rel: 'noopener' }, 'Try the preview'),
      h('span', { class: 'muted' }, preview.running ? ' · stops after an hour unused' : ' · stopped, starts when opened'));
  }
  const file = copies.find((x) => x.kind === 'download');
  if (file) return h('span', { class: 'try' }, h('a', { href: `${fileUrl(file.ticketId, file.file)}&download`, download: '' }, `Download ${file.name}`));
  if (!c.canPreview) return '';
  if (requested.has(c.ticketId)) return h('span', { class: 'try muted', role: 'status' }, 'Starting preview…');
  const ask = () => optimistic({
    key: `preview:${c.ticketId}`,
    apply: () => { requested.add(c.ticketId); redraw(); },
    // The POST alone decides success. The server lists the preview once it's up: ask again rather than wait for the next
    // poll's event, then let the row draw from the list (the link, or the button if it somehow isn't there).
    send: async () => {
      await api(`api/tickets/${c.ticketId}/preview`, { method: 'POST' });
      void loadReleases().finally(() => { requested.delete(c.ticketId); redraw(); });
    },
    undo: () => { requested.delete(c.ticketId); redraw(); },
    label: `start #${c.number ?? c.ticketId}'s preview`,
  });
  return h('span', { class: 'try' }, h('button', { type: 'button', class: 'secondary', onclick: ask }, 'Request preview'));
}

/** Each kind of test copy: where it opens, what it's called and the line beside it. Previews open in a new tab (a stopped one starts again when opened); a download saves. */
function copyLink(c) {
  const state = c.running ? (c.commit ? `running ${c.commit.slice(0, 7)}` : 'running') : 'stopped';
  const made = [c.commit?.slice(0, 7), c.at ? ago(c.at) : ''].filter(Boolean).join(' · ');
  const tab = { target: '_blank', rel: 'noopener' };
  switch (c.kind) {
    // Its name carries its commit; the line says whose it is.
    case 'download': return [h('a', { href: `${fileUrl(c.ticketId, c.file)}&download`, download: '' }, c.name), [h('a', { href: minionHref(null, { ticketId: c.ticketId }) }, `#${c.number}`), ` · ${ago(c.at)}`]];
    // The host people reached Citadel on, which reaches the site too (both on the tailnet).
    case 'site': return [h('a', { href: `${location.protocol}//${location.hostname}:${c.port}/`, ...tab }, `${c.name} (port ${c.port})`), c.running ? 'up' : 'down'];
    // Linked only to its file on perigee (#673): until it is mirrored, just its name.
    case 'debug-apk': return [c.link ? h('a', { href: c.link, ...tab }, `Debug APK, ${c.name}`) : h('span', {}, `Debug APK, ${c.name}`), made];
    case 'build-preview': return [h('a', { href: `../${c.path}`, ...tab }, `${c.name} standing preview`), state];
    default: return [h('a', { href: `../${c.path}`, ...tab }, `Preview of ${c.name}`), state];
  }
}

function copyList(copies) {
  return h('ul', { class: 'rel-list' }, copies.map((c) => {
    const [link, line] = copyLink(c);
    return h('li', {}, link, h('span', { class: 'muted' }, ...[line].flat()));
  }));
}

// ---------- All (take E) ----------

function allView(ids) {
  if (!ids.length) return [h('p', { class: 'muted rel-empty' }, 'Nothing ships yet from the schemes you\'re a member of.')];
  const rows = ids.flatMap((id) => schemes.get(id).targets.map((tv) => ({ id, tv })));
  const card = (id, next, c) => h('a', { class: `rel-card-sm${c.ticketId === page?.hl ? ' hl' : ''}`, href: minionHref(id, c) },
    h('span', { class: 'what' }, h('span', { class: 'num' }, `#${c.number ?? c.ticketId}`), ' ', c.title),
    stageTrack(next.stages, c, { mini: true }), h('span', { class: 'where' }, ...changeNow(next, c)));
  // The newest live release: its number (linked to the release itself), its age and the minions it carried.
  const lastCard = (id, r) => h('div', { class: 'rel-card-sm live' },
    h('span', { class: 'what' }, versionLink(r), r.live ? h('span', { class: 'where' }, ` · live ${ago(r.live)}`) : ''),
    r.changes.length ? h('ul', { class: 'rel-carried' }, r.changes.map((c) => h('li', {}, h('a', { class: 'num', href: minionHref(id, c) }, `#${c.number ?? c.ticketId}`), ' ', c.title))) : '');
  const grid = h('div', { class: 'rel-grid', role: 'table', 'aria-label': 'Releases of every scheme' },
    h('div', { class: 'rel-grid-row head', role: 'row' }, ['Target', ...COLUMNS].map((c) => h('span', { role: 'columnheader' }, c))),
    rows.map(({ id, tv }) => {
      const cells = COLUMNS.map(() => []);
      for (const c of tv.next?.changes ?? []) cells[columnOf(tv.next.stages, c)].push(card(id, tv.next, c));
      if (tv.current) cells[3].push(lastCard(id, tv.current));
      return tint(h('div', { class: 'rel-grid-row', role: 'row', 'data-scheme': id },
        h('div', { class: 'rel-target', role: 'rowheader', onclick: (e) => { if (!e.target.closest('a')) { opening(); location.hash = pageHref(id); } } },
          h('a', { href: pageHref(id), onclick: opening }, iconOf(id), h('b', {}, `${schemeName(id)} ${tv.target.name}`))),
        cells.map((list) => h('div', { class: 'cell', role: 'cell' }, list))), id);
    }));
  const copies = ids.flatMap((id) => {
    const s = schemes.get(id);
    return [...s.targets.flatMap((tv) => tv.testCopies), ...s.testCopies].map((c) => ({ id, c }));
  });
  return [
    // Desktop: the board, then every test copy. A phone: every member scheme's cards (Josh: "The all grid view doesnt really work on mobile").
    h('div', { class: 'rel-all-wide' }, grid,
      copies.length ? [h('h4', {}, 'Test copies'), h('ul', { class: 'rel-list' }, copies.map(({ id, c }) => h('li', {}, copyList([c]).firstChild.firstChild, h('span', { class: 'muted' }, schemeName(id)))))] : ''),
    h('div', { class: 'rel-all-narrow' }, ids.flatMap((id) => schemeCards(id, false))),
  ];
}

/** Each icon's colour for its scheme's All grid row, keyed by icon URL (it carries the icon's version, so a new icon is read again):
 *  its coloured pixels, averaged; grey for an icon without colour; null while reading or unreadable. */
const tints = new Map();

/** Give `row` its scheme's tint (Cara, 2026-11-12: "Tint per scheme"), reading each icon once. */
function tint(row, id) {
  const src = schemeOf(id) && iconSrc(schemeOf(id));
  if (!src) return row;
  if (tints.get(src)) row.style.setProperty('--tint', tints.get(src));
  if (tints.has(src)) return row;
  tints.set(src, null);
  const img = new Image();
  img.onerror = () => tints.delete(src); // a failed load is tried again on the next render
  img.onload = () => {
    try {
      const g = Object.assign(document.createElement('canvas'), { width: 24, height: 24 }).getContext('2d');
      g.drawImage(img, 0, 0, 24, 24);
      const px = g.getImageData(0, 0, 24, 24).data;
      const sum = [0, 0, 0];
      let n = 0;
      for (let i = 0; i < px.length; i += 4) {
        // Only opaque, coloured pixels: an icon's white or black outline would grey it out.
        if (px[i + 3] < 128 || Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) < 40) continue;
        for (let k = 0; k < 3; k++) sum[k] += px[i + k];
        n++;
      }
      tints.set(src, n ? `rgb(${sum.map((v) => Math.round(v / n)).join(' ')})` : 'var(--muted)');
      for (const el of document.querySelectorAll(`.rel-grid-row[data-scheme="${CSS.escape(String(id))}"]`)) el.style.setProperty('--tint', tints.get(src));
    } catch { /* an icon the canvas can't read leaves its row plain */ }
  };
  img.src = src;
  return row;
}

// ---------- the chip beside the PR info (take F) ----------

/** The chip for minion `t`: its change's mini track, stage and wait or time left, opening its scheme's page at it; or "merged into Build N". */
export function releaseChip(t) {
  if (!t || !loaded) return null;
  for (const tv of schemes.get(t.project_id)?.targets ?? []) {
    const c = tv.next?.changes.find((x) => x.ticketId === t.id);
    if (c) {
      // A change past the build under way isn't in it, so it carries no number (#764).
      const n = c.later ? null : tv.next.number;
      // Only the number opens the release itself (its test copy); the rest of the chip opens the scheme's page at this change.
      return h('span', { class: 'rel-chip' },
        n != null ? versionLink(tv.next, 'rel-ver', true) : '',
        h('a', { class: 'rel-chip-open', href: pageHref(t.project_id, t.id), onclick: (e) => { e.stopPropagation(); opening(); }, 'aria-label': `${tv.target.name}${n != null ? ` ${releaseName(tv.next)}` : ''}: ${c.waitingOn ?? c.text}. Open its release` },
          stageTrack(tv.next.stages, c, { mini: true }), ...(c.later && (c.stage === 'line' || c.stage === 'land') ? [h('b', { class: 'waits' }, c.train?.label ?? 'in line'), ...(c.train ? [] : [' ', h('span', { class: 'muted' }, c.brief ?? 'next release')])] : changeNow(tv.next, c)), h('span', { 'aria-hidden': 'true' }, '›')));
    }
  }
  if (t.ship?.stage === 'build' && t.build) {
    return h('a', { class: 'rel-chip', href: pageHref(t.project_id), onclick: (e) => { e.stopPropagation(); opening(); } },
      h('span', { class: 'muted' }, `merged into Build ${t.build}`), h('span', { 'aria-hidden': 'true' }, '›'));
  }
  return null;
}

// ---------- minion rows ----------

/** The release minion `t`'s change is on its way in (#764): its name ("Build 997", "Next build"), target and stage; null when none. */
export function pendingRelease(t) {
  if (!t || !loaded) return null;
  for (const tv of schemes.get(t.project_id)?.targets ?? []) {
    const c = tv.next?.changes.find((x) => x.ticketId === t.id);
    if (!c || c.idle) continue;
    // A change past the build under way (`later`) goes out in the one after, which has no number yet.
    const tpl = tv.target.numbering?.name;
    const next = tpl ? `Next ${tpl.replace(/\{n\}/g, '').replace(/\s+/g, ' ').trim().toLowerCase()}` : 'Next release';
    // Still in the line past the one under way: many releases may stand between, so no release is named (the row's subtitle says the place).
    const inLine = c.later && (c.stage === 'line' || (c.stage === 'land' && c.waitingOn));
    return { name: inLine ? c.train?.label ?? 'In line' : c.later ? next : tv.next.number != null ? releaseName(tv.next) : tv.next.name ?? next, target: tv.target.name, stage: stageName(c.stage), text: c.waitingOn ?? c.text, since: c.since, stuck: stuckFor(c) > 0 };
  }
  return null;
}

/** Each minion's pending release as rows show it, so a releases event redraws the list only when one changed. */
let rowsKey = '';
function rowsChanged() {
  const key = JSON.stringify([...schemes.values()].flatMap((s) => s.targets.flatMap((tv) => (tv.next?.changes ?? []).map((c) => [c.ticketId, tv.next.number, tv.next.name, c.later, c.stage, c.waitingOn ?? c.text, stuckFor(c) > 0]))));
  const changed = key !== rowsKey;
  rowsKey = key;
  return changed;
}

// ---------- live ----------

if (typeof document !== 'undefined') {
  setInterval(() => {
    for (const el of document.querySelectorAll('.rel-eta[data-eta]')) {
      const [eta, since] = [Number(el.dataset.eta), Number(el.dataset.since) || null];
      el.textContent = etaWords(eta, el.dataset.suffix, since, !!el.dataset.full);
      el.title = etaTitle(eta, since);
    }
  }, 1000);
}
