// The release monitor (#626, specs/release-monitor.md; data from #625's GET /api/releases and `releases` event): each
// scheme's targets under its row in the Schemes list (take A's stage track, the whole release's estimate, the current version,
// a hover with the detail), the Releases page over the chat (a scheme's cards, take D; All's stage board, take E, on
// desktop and every member scheme's cards on a phone) and the chip beside a minion's PR info (take F).
// Bars follow the spec's rule: by stage, sized by usual time, the current one stopping at 90% (waitBar's cap) and
// amber past LATE, a wait hatched with its reason, and no estimate while anything ahead waits.
import { ago, api, fileUrl, h, view } from './base.js';
import { mountTips } from './ui/tip.js';
import { optimistic } from './ui/optimistic.js';
import { changeEta, COLUMNS, columnOf, segments, shortSpan } from './releasemath.js';
import { TRACK, waitBar } from './wait.js';

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
  member = new Set(got[1].schemes.map((s) => s.projectId));
  loaded = true;
  redraw();
}

/** One scheme's part changed (the `releases` event); a scheme seen for the first time may be a member one, so ask again. */
export function onReleases(msg) {
  if (!loaded) return;
  const s = msg.releases;
  const had = schemes.has(msg.projectId);
  // A deploy pressed here shows as one until the server's own view stops offering it (it's running, or done).
  for (const tv of s.targets) if (!tv.deploy?.can) deploying.delete(`${msg.projectId}/${tv.target.id}`);
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
  tips?.refresh();
}

// ---------- words and numbers ----------

const schemeName = (id) => view?.projects?.find((p) => p.id === id)?.name ?? (view?.project?.id === id ? view.project.name : `Scheme ${id}`);
/** A stage's name as the land track says it, else the stage itself, capitalised. */
const stageName = (key) => {
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

/** A version, linked to its commit or release when it has a link (a new tab: it leaves Citadel). */
function versionLink(r, cls = 'rel-ver') {
  const text = isSha(r.version) ? r.version.slice(0, 7) : r.version;
  return r.link ? h('a', { class: cls, href: r.link, target: '_blank', rel: 'noopener', title: r.version, onclick: (e) => e.stopPropagation() }, text)
    : h('span', { class: cls, title: r.version }, text);
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
      class: `rel-row${tv.next ? ' moving' : ''}`, 'data-rel-tip': `${projectId}/${tv.target.id}`,
      // The whole row opens the scheme's page (Josh: "clicking any of the releases would take you to that schemes detail page"); its version link goes to the commit.
      onclick: (e) => { if (!e.target.closest('a')) { opening(); location.hash = href; } },
    },
    h('a', { class: 'rel-name', href, onclick: opening }, tv.target.name),
    tv.next ? estimate(tv.next) : '',
    tv.current ? versionLink(tv.current) : '',
    tv.next ? stageTrack(tv.next.stages, tv.next) : '');
  }));
}

/** The Releases link beside the Schemes heading, styled as Browse beside Artifacts: opens All. */
export function releasesLink() {
  return h('a', { class: `browse${view?.main === 'releases' && page?.scope === 'all' ? ' active' : ''}`, href: pageHref('all'), onclick: opening, title: 'Releases of every scheme you\'re a member of' }, 'Releases');
}

/** The hover's detail for a target: next release, its stage n/N with time or what it waits on, the estimate, the changes, the current release. */
function tipBody(key) {
  const [pid, ...rest] = key.split('/');
  const projectId = Number(pid);
  const tv = schemes.get(projectId)?.targets.find((t) => t.target.id === rest.join('/'));
  if (!tv) return null;
  const n = tv.next;
  const line = (label, ...v) => h('div', {}, h('span', { class: 'muted' }, label, ' '), ...v);
  const out = [h('div', {}, h('b', {}, `${schemeName(projectId)} ${tv.target.name}`))];
  if (n) {
    const list = segments(n.stages);
    const at = list.findIndex((s) => s.name === n.stage);
    const elapsed = shortSpan(Date.now() - n.since);
    out.push(line('Stage', h('b', {}, stageName(n.stage)), at >= 0 ? ` ${at + 1}/${list.length}` : '', ' · ',
      n.waitingOn ? h('span', { class: 'waits' }, n.waitingOn) : n.usual ? `${elapsed} of ~${shortSpan(n.usual * 1000)}` : `${elapsed}, ${n.text}`));
    out.push(line('Whole release', n.eta ? etaText(n.eta, ' left') : n.waitingOn ? 'no estimate while it waits' : 'no estimate yet'));
    out.push(line('In it', ...n.changes.flatMap((c, i) => [i ? ', ' : '', h('a', { href: minionHref(projectId, c) }, `#${c.number ?? c.ticketId}`), ` ${c.title}`])));
  } else out.push(h('div', { class: 'muted' }, 'Nothing on its way.'));
  if (tv.current) out.push(line('Current', versionLink(tv.current), tv.current.live ? `, live ${ago(tv.current.live)}` : ''));
  return h('div', { class: 'rel-tip' }, out);
}

// ---------- tracks ----------

/**
 * The stage track (takes D, E, F): a segment per stage, as wide as its usual time (with a floor, so a 1-second rebase
 * still shows); done ones full, the current one by elapsed over usual up to 90% or by its count, hatched while it
 * waits; `labels` names them under.
 */
function stageTrack(stages, p, { mini = false, labels = false } = {}) {
  const list = segments(stages);
  const at = list.findIndex((s) => s.name === p.stage);
  const total = list.reduce((sum, s) => sum + (s.usual ?? 0), 0);
  const floor = Math.max(1, total * 0.08);
  return h('ol', { class: `rel-track${mini ? ' mini' : ''}`, 'aria-label': `${stageName(p.stage)}, stage ${at + 1} of ${list.length}` }, list.map((s, i) => {
    const now = i === at;
    const bar = (now && !p.waitingOn && waitBar({ stage: p.stage, since: p.since, usual: p.usual, done: p.done, total: p.total }, 'wait-bar', 90)) || h('span', { class: 'wait-bar' }, h('i'));
    const li = h('li', { class: i < at ? 'done' : now ? (p.waitingOn ? 'now waits' : 'now') : '', title: s.usual ? `${stageName(s.name)}: usually ~${shortSpan(s.usual * 1000)}` : stageName(s.name) },
      bar, labels ? h('span', { class: 'lbl' }, stageName(s.name)) : '');
    li.style.flexGrow = String(Math.max(s.usual ?? floor, floor)); // CSP drops style attributes, not the property
    return li;
  }));
}

/** A change's stage and its wait or time left: "Deploy ~50s left", "Line 2nd in line, behind #620". */
function changeNow(next, c) {
  const eta = changeEta(next, c);
  return [h('b', { class: c.waitingOn ? 'waits' : 'work' }, stageName(c.stage)), ' ',
    h('span', { class: 'muted' }, c.waitingOn ? c.waitingOn : eta ? etaText(eta, ' left') : c.text)];
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
    ...s.targets.map((tv) => targetCard(projectId, tv)),
    s.testCopies.length ? h('article', { class: 'rel-card' },
      h('header', {}, h('h3', {}, 'Test copies'), h('span', { class: 'tag' }, schemeName(projectId))), copyList(s.testCopies)) : '',
  ];
}

function targetCard(projectId, tv) {
  const n = tv.next, cur = tv.current, hl = page?.hl;
  const recent = tv.recent.slice(0, 3).filter(tookText);
  const curTook = cur && tookText(cur);
  return h('article', { class: `rel-card${hl && n?.changes.some((c) => c.ticketId === hl) ? ' hl' : ''}` },
    h('header', {}, h('h3', {}, tv.target.name), h('span', { class: 'tag' }, schemeName(projectId))),
    h('p', { class: 'rel-current' }, 'Current: ', cur ? versionLink(cur) : 'none yet', cur?.live ? ` · live ${ago(cur.live)}` : '', curTook ? ` · took ${curTook}` : '',
      recent.length ? h('span', { class: 'muted' }, ' · before: ', recent.flatMap((r, i) => [i ? ', ' : '', versionLink(r, 'rel-ver old'), ` took ${tookText(r)}`])) : ''),
    deployBar(projectId, tv),
    h('h4', {}, 'Next release'),
    n ? [
      stageTrack(n.stages, n, { labels: true }),
      h('p', { class: 'rel-now' }, h('b', {}, stageName(n.stage)), ' · ', n.waitingOn ? h('span', { class: 'waits' }, n.waitingOn) : n.eta ? etaText(n.eta, ' left') : n.text,
        n.changes.length > 1 ? h('span', { class: 'muted' }, ` · +${n.changes.length - 1} more`) : ''),
      h('ul', { class: 'rel-changes' }, n.changes.map((c) => h('li', { class: `rel-change${c.ticketId === hl ? ' hl' : ''}` },
        h('span', { class: 'what' }, h('a', { href: minionHref(projectId, c) }, `#${c.number ?? c.ticketId}`), ' ', c.title),
        h('span', { class: 'where' }, stageTrack(n.stages, c, { mini: true }), ...changeNow(n, c))))),
    ] : h('p', { class: 'muted' }, 'Nothing on its way.'),
    tv.line.length ? [h('h4', {}, 'Land line'), lineList(projectId, tv.line)] : '',
    tv.testCopies.length ? [h('h4', {}, 'Test copies'), copyList(tv.testCopies)] : '');
}

// ---------- deploying (#629) ----------

/** Targets whose Deploy was pressed here and whose deploy the server hasn't shown yet: "projectId/target". */
const deploying = new Set();

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
  const flip = (on) => optimistic({
    sets: `auto-deploy:${key}`,
    apply: () => { d.auto = on; redraw(); },
    send: () => api('api/releases/auto-deploy', { method: 'PUT', body: { ...body, on } }),
    undo: () => { d.auto = !on; redraw(); },
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
  const midnight = new Date().setHours(0, 0, 0, 0);
  const rows = ids.flatMap((id) => schemes.get(id).targets.map((tv) => ({ id, tv })));
  const card = (id, next, c) => h('a', { class: `rel-card-sm${c.ticketId === page?.hl ? ' hl' : ''}`, href: minionHref(id, c) },
    h('span', { class: 'what' }, h('span', { class: 'num' }, `#${c.number ?? c.ticketId}`), ' ', c.title),
    stageTrack(next.stages, c, { mini: true }), h('span', { class: 'where' }, ...changeNow(next, c)));
  const liveCard = (id, r, c) => h('a', { class: 'rel-card-sm live', href: minionHref(id, c) },
    h('span', { class: 'what' }, h('span', { class: 'num' }, `#${c.number ?? c.ticketId}`), ' ', c.title), h('span', { class: 'where' }, `live ${ago(r.live)}`));
  const grid = h('div', { class: 'rel-grid', role: 'table', 'aria-label': 'Releases of every scheme' },
    h('div', { class: 'rel-grid-row head', role: 'row' }, ['Target', ...COLUMNS].map((c) => h('span', { role: 'columnheader' }, c))),
    rows.map(({ id, tv }) => {
      const cells = COLUMNS.map(() => []);
      for (const c of tv.next?.changes ?? []) cells[columnOf(tv.next.stages, c)].push(card(id, tv.next, c));
      for (const r of [tv.current, ...tv.recent]) if (r?.live >= midnight) for (const c of r.changes) cells[3].push(liveCard(id, r, c));
      return h('div', { class: 'rel-grid-row', role: 'row' },
        h('a', { class: 'rel-target', role: 'rowheader', href: pageHref(id) }, h('b', {}, `${schemeName(id)} ${tv.target.name}`),
          tv.current ? h('span', { class: 'muted' }, isSha(tv.current.version) ? tv.current.version.slice(0, 7) : tv.current.version, tv.current.live ? ` · ${ago(tv.current.live).replace(/ ago$/, '')}` : '') : ''),
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
      return h('a', { class: 'rel-chip', href: pageHref(t.project_id, t.id), onclick: (e) => { e.stopPropagation(); opening(); }, title: `${tv.target.name}: ${c.waitingOn ?? c.text}. Open its release` },
        stageTrack(tv.next.stages, c, { mini: true }), ...changeNow(tv.next, c), h('span', { 'aria-hidden': 'true' }, '›'));
    }
  }
  if (t.ship?.stage === 'build' && t.build) {
    return h('a', { class: 'rel-chip', href: pageHref(t.project_id), onclick: (e) => { e.stopPropagation(); opening(); }, title: t.ship.text },
      h('span', { class: 'muted' }, `folded into Build ${t.build}`), h('span', { 'aria-hidden': 'true' }, '›'));
  }
  return null;
}

// ---------- live ----------

let tips = null;
if (typeof document !== 'undefined') {
  tips = mountTips(document.body, { selector: '[data-rel-tip]', role: 'dialog', label: 'Release', className: 'rel-tipbox', acts: '.rel-row', body: (el) => tipBody(el.dataset.relTip) });
  setInterval(() => {
    for (const el of document.querySelectorAll('.rel-eta[data-eta]')) el.textContent = etaWords(Number(el.dataset.eta), el.dataset.suffix);
  }, 1000);
}
