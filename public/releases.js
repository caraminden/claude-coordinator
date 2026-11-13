// The release monitor (#626, specs/release-monitor.md; data from #625's GET /api/releases and `releases` event): each
// scheme's targets under its row in the Schemes list (take A's stage track, the whole release's estimate, the current version,
// a hover with the detail), the Releases page over the chat (a scheme's cards, take D; All's stage board, take E, on
// desktop and every member scheme's cards on a phone) and the chip beside a minion's PR info (take F).
// Bars follow the spec's rule: by stage, sized by usual time, the current one stopping at 90% (waitBar's cap) and
// amber past LATE, a wait hatched with its reason, and no estimate while anything ahead waits.
import { ago, api, fileUrl, h, schemeIcon, view } from './base.js';
import { optimistic } from './ui/optimistic.js';
import { changeEta, COLUMNS, columnOf, segments, shortSpan } from './releasemath.js';
import { segTrack, TRACK } from './wait.js';

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
  redraw();
}

/** One scheme's part changed (the `releases` event); a scheme seen for the first time may be a member one, so ask again. */
export function onReleases(msg) {
  if (!loaded) return;
  const s = msg.releases;
  const had = schemes.has(msg.projectId);
  settleDeploys(s);
  if (s.targets.length || s.testCopies.length) schemes.set(msg.projectId, s);
  else schemes.delete(msg.projectId);
  if (!had && schemes.has(msg.projectId)) return loadReleases();
  redraw();
}

function redraw() {
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
/** Stages whose key reads wrong to a person: a contraption's wait for someone to start its deploy. */
const STAGE_NAMES = { call: 'Start' };
/** A stage's name as the land track says it, else the stage itself, capitalised. */
const stageName = (key) => {
  if (STAGE_NAMES[key]) return STAGE_NAMES[key];
  const t = TRACK.find(([k]) => k === key);
  // A short key is an initialism ("ci" → "CI").
  return t ? t[2] ?? t[1] : key.length <= 3 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
};
const isSha = (v) => /^[0-9a-f]{7,40}$/.test(v);
const minionHref = (projectId, c) => (c.number != null ? `#/p/${projectId}/t/${c.number}` : `#/t/${c.ticketId}`);
const pageHref = (scope, hl) => `#/p/${view?.projectId ?? ''}/releases/${scope}${hl ? `/${hl}` : ''}`;
/** "50s", "3m", "1h 5m": an estimate's size, rounded. */
const tookText = (r) => (r.started && r.live ? shortSpan(r.live - r.started) : null);

/** "~3m" that counts down on the ticker, "due now" once it's past. */
function etaText(eta, suffix = '') {
  return h('span', { class: 'rel-eta', 'data-eta': eta, 'data-suffix': suffix }, etaWords(eta, suffix));
}
const etaWords = (eta, suffix) => (eta > Date.now() ? `~${shortSpan(eta - Date.now())}${suffix}` : 'due now');

/**
 * What people call a release (Cara, 2026-11-12: "a numbered build/release system instead of commit hashes"): "Release 14",
 * "#14" where space is short; a try that never went live has no number, so it's "a failed try".
 */
const releaseName = (r, short = false) => (r.number != null ? (short ? `#${r.number}` : `Release ${r.number}`) : r.outcome === 'signed' ? 'a signed build' : r.outcome === 'live' ? 'an earlier release' : 'a failed try');
/** The commit or version name behind it, shown small on its card for whoever wants it (no hover: Cara, 2026-11-12, "if you want more info, click"). */
const releaseDetail = (r) => (r.version ? (isSha(r.version) ? `commit ${r.version.slice(0, 7)}` : `version ${r.version}`) : '');

/** A release by its number, linked to the release itself (the live site, its file) when it has one: a new tab, as it may leave Citadel. */
function versionLink(r, cls = 'rel-ver', short = false) {
  return r.link ? h('a', { class: cls, href: r.link, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, releaseName(r, short))
    : h('span', { class: cls }, releaseName(r, short));
}

// ---------- the Schemes list ----------

/** The whole release's estimate: "~3m", "waiting" while a stage waits, else the stage it's at. */
function estimate(next) {
  if (next.waitingOn) return h('span', { class: 'rel-est waits' }, 'waiting');
  return h('span', { class: 'rel-est' }, next.eta ? etaText(next.eta) : stageName(next.stage));
}

/** Remember where the page was opened from, for its ×. */
function opening() {
  if (!/\/releases\//.test(location.hash)) returnTo = location.hash;
}

/** A scheme's targets, one indented row each, under its row in the Schemes list; empty when it ships nothing. */
export function releaseRows(projectId) {
  const s = schemes.get(projectId);
  return h('div', { class: 'rel-rows', 'data-rel-scheme': projectId }, (s?.targets ?? []).map((tv) => {
    const href = pageHref(projectId);
    return h('div', {
      class: `rel-row${tv.next ? ' moving' : ''}`,
      // The whole row opens the scheme's page (Josh: "clicking any of the releases would take you to that schemes detail page"); its release link opens the release.
      onclick: (e) => { if (!e.target.closest('a')) { opening(); location.hash = href; } },
    },
    h('a', { class: 'rel-name', href, onclick: opening }, tv.target.name),
    tv.next ? estimate(tv.next) : '',
    tv.current ? versionLink(tv.current, 'rel-ver', true) : '',
    tv.next ? stageTrack(tv.next.stages, tv.next) : '');
  }));
}

/** The Releases link beside the Schemes heading, styled as Browse beside Artifacts: opens All. */
export function releasesLink() {
  return h('a', { class: `browse${view?.main === 'releases' && page?.scope === 'all' ? ' active' : ''}`, href: pageHref('all'), onclick: opening, title: 'Releases of every scheme you\'re a member of' }, 'Releases');
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

/** A change's stage and its wait or time left: "Deploy ~50s left", "Line 2nd in line, behind #620"; under a card that already says its wait, `said` keeps it from repeating. */
function changeNow(next, c, said = false) {
  const eta = changeEta(next, c);
  return [h('b', { class: c.waitingOn ? 'waits' : 'work' }, stageName(c.stage)), ' ',
    h('span', { class: 'muted' }, c.waitingOn ? (said && c.waitingOn === next.waitingOn ? 'waits with the release, as above' : c.waitingOn) : eta ? etaText(eta, ' left') : c.text)];
}

// ---------- the page ----------

let pageEl = null;

/** Open the page on `scope` ('all' or a scheme's id), with change `hl` (a ticket id) highlighted. */
export function setReleasesPage(scope, hl) {
  page = { scope, hl };
}

/** The Releases page over the chat column (on a phone, the whole screen with a back arrow). */
export function releasesPage() {
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
  const close = (cls, label, text) => h('button', { type: 'button', class: `close-view ${cls}`, 'aria-label': label, title: label, onclick: closePage }, text);
  const body = !loaded ? [h('p', { class: 'muted' }, 'Loading releases…')]
    : scope === 'all' ? allView(ids)
      : schemeCards(scope, true);
  pageEl.replaceChildren(
    h('div', { class: 'ticket-head rel-head' },
      h('div', { class: 'row' }, close('narrow-only', 'Back', '‹'), h('h2', {}, `Releases · ${scope === 'all' ? 'All' : schemeName(scope)}`),
        h('span', { class: 'spacer' }), close('wide-only', 'Close', '×'))),
    h('nav', { class: 'chips rel-chips', 'aria-label': 'Schemes' }, chip('all', 'All'), chipIds.map((id) => chip(id, schemeName(id)))),
    h('div', { class: 'rel-body' }, body));
  // Brings the highlighted change into view once, so a later update doesn't pull back someone who scrolled away.
  const hl = page?.hl != null && !page.shown && pageEl.querySelector('.rel-card.hl, .rel-change.hl');
  if (hl) { page.shown = true; hl.scrollIntoView({ block: 'nearest' }); }
}

/** A scheme's cards (take D): one per target, then its test copies of no target. */
function schemeCards(projectId, alone) {
  const s = schemes.get(projectId);
  if (!s) return alone ? [h('p', { class: 'muted rel-empty' }, `Nothing ships from ${schemeName(projectId)} yet: no release, preview or test copy.`)] : [];
  return [
    ...s.targets.map((tv) => targetCard(projectId, tv, alone)),
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
    h('h4', {}, n?.number != null ? ['Next: ', n.link ? h('a', { class: 'rel-ver', href: n.link, target: '_blank', rel: 'noopener' }, releaseName(n), ' (try it)') : releaseName(n)] : 'Next release'),
    n ? [
      stageTrack(n.stages, n, { labels: true }),
      h('p', { class: 'rel-now' }, h('b', {}, stageName(n.stage)), ' · ', n.waitingOn ? h('span', { class: 'waits' }, n.waitingOn) : n.eta ? etaText(n.eta, ' left') : n.text,
        n.changes.length > 1 ? h('span', { class: 'muted' }, ` · +${n.changes.length - 1} more`) : ''),
      h('ul', { class: 'rel-changes' }, n.changes.map((c) => h('li', { class: `rel-change${c.ticketId === hl ? ' hl' : ''}` },
        h('span', { class: 'what' }, h('a', { href: minionHref(projectId, c) }, `#${c.number ?? c.ticketId}`), ' ', c.title),
        h('span', { class: 'where' }, stageTrack(n.stages, c, { mini: true }), ...changeNow(n, c, true))))),
    ] : h('p', { class: 'muted' }, 'Nothing on its way.'),
    tv.line.length ? [h('h4', {}, 'Land line'), lineList(projectId, tv.line)] : '',
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
  const label = (r) => (r.number != null ? releaseName(r) : r.outcome === 'signed' ? 'Signed build' : 'Failed try');
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
        r.changes.length ? h('span', { class: 'rel-prev-changes' }, r.changes.flatMap((c, i) => [i ? ', ' : '', h('a', { href: minionHref(projectId, c) }, `#${c.number ?? c.ticketId}`), ' ', c.title])) : '');
    })));
}

// ---------- deploying (#629) ----------

/** Targets whose Deploy was pressed here and whose deploy the server hasn't shown yet: "projectId/target". */
const deploying = new Set();

/** A deploy pressed here shows as one until the server's own view stops offering it (it's running, or done). */
function settleDeploys(s) {
  for (const tv of s.targets) if (!tv.deploy?.can) deploying.delete(`${s.projectId}/${tv.target.id}`);
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

/** Who holds the land line and who waits behind it. */
function lineList(projectId, line) {
  const who = (e) => (e.ticketId != null ? h('a', { href: `#/t/${e.ticketId}` }, e.name) : e.name);
  return h('ul', { class: 'rel-list' }, line.map((e) => h('li', {},
    h('span', {}, e.holds ? 'Holds the lock' : 'Waiting'), h('span', { class: 'muted' }, who(e), ' · ', e.holds ? stageName(e.stage) : `since ${ago(e.since).replace(/ ago$/, '')}`))));
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
    case 'debug-apk': return [h('a', { href: c.link, ...tab }, `Debug APK, ${c.name}`), made];
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
      return h('div', { class: 'rel-grid-row', role: 'row' },
        h('div', { class: 'rel-target', role: 'rowheader', onclick: (e) => { if (!e.target.closest('a')) { opening(); location.hash = pageHref(id); } } },
          h('a', { href: pageHref(id), onclick: opening }, iconOf(id), h('b', {}, `${schemeName(id)} ${tv.target.name}`))),
        cells.map((list) => h('div', { class: 'cell', role: 'cell' }, list)));
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

// ---------- the chip beside the PR info (take F) ----------

/** The chip for minion `t`: its change's mini track, stage and wait or time left, opening its scheme's page at it; or "folded into Build N". */
export function releaseChip(t) {
  if (!t || !loaded) return null;
  for (const tv of schemes.get(t.project_id)?.targets ?? []) {
    const c = tv.next?.changes.find((x) => x.ticketId === t.id);
    if (c) {
      const n = tv.next.number;
      // Only the number opens the release itself (its test copy); the rest of the chip opens the scheme's page at this change.
      return h('span', { class: 'rel-chip' },
        n != null ? versionLink(tv.next, 'rel-ver', true) : '',
        h('a', { class: 'rel-chip-open', href: pageHref(t.project_id, t.id), onclick: (e) => { e.stopPropagation(); opening(); }, 'aria-label': `${tv.target.name}${n != null ? ` ${releaseName(tv.next)}` : ''}: ${c.waitingOn ?? c.text}. Open its release` },
          stageTrack(tv.next.stages, c, { mini: true }), ...changeNow(tv.next, c), h('span', { 'aria-hidden': 'true' }, '›')));
    }
  }
  if (t.ship?.stage === 'build' && t.build) {
    return h('a', { class: 'rel-chip', href: pageHref(t.project_id), onclick: (e) => { e.stopPropagation(); opening(); } },
      h('span', { class: 'muted' }, `folded into Build ${t.build}`), h('span', { 'aria-hidden': 'true' }, '›'));
  }
  return null;
}

// ---------- live ----------

if (typeof document !== 'undefined') {
  setInterval(() => {
    for (const el of document.querySelectorAll('.rel-eta[data-eta]')) el.textContent = etaWords(Number(el.dataset.eta), el.dataset.suffix);
  }, 1000);
}
