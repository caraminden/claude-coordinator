// A scheme's page: its side panels and the main panel, and switching between chats.
import { account, api, h, isCoordinator, loadPanelState, me, savePanelState, schemeIcon, setView, threadHref, view } from './base.js';
import { app, cachedEvents, crumbs, loadEvents, logout, onTicketUpdate, prefetchTopRows, renderUsage, routeSeq, usageMeter } from './core.js';
import { ciPage } from './ci.js';
import { statusPage } from './status.js';
import * as settings from './settings.js';
import { ordersMenu, projectTitle, renderGithubStrip, settingsHome } from './settings.js';
import * as settingsMachines from './settings-machines.js';
import { isOrdersPage, pageRow } from './settings-pages.js';
import { closedSnapshot, closedState, fetchClosedByNumber, restoreClosed, setClosedTotal } from './closedlist.js';
import { LAST_SCHEME, renderSidebar, revealActiveRow, threadSearchBox } from './sidebar.js';
import { startPick } from './pick.js';
import { artifactViewer, renderArtifactHead, setArtifacts, renderSharedHead, renderShelf, sharedViewer } from './artifacts.js';
import { filesView, renderFiles } from './files.js';
import { chatSection, chatView, mountChat, renderTicketHead, tmViewMode } from './thread.js';
import { mergedView } from './mine.js';
import * as properties from './properties.js';
import { preparePropFilter, renderSettingsCount } from './properties.js';
import { renderCost } from './cost.js';
import * as where from './where.js';
import * as skills from './skills.js';
import { fetchInbox, forgetOtherSchemes, inboxStrip, refreshInbox } from './inbox.js';
import { refreshSchemes, renderHiddenNote, renderSchemesShelf } from './hidden.js';
import { openSchedule, schedulesPage, schedulesPane } from './schedules.js';
import { replaceHash } from './navstack.js';
import * as memory from './memory.js';
import * as decisions from './decisions.js';
import * as ideas from './ideas.js';
import * as people from './people.js';
import * as contraptions from './contraptions.js';
import * as units from './units.js';
import * as unused from './unused.js';
import { releasesPage, setReleasesPage } from './releases.js';
import * as reviews from './reviews.js';
import * as help from './help.js';
import { gloss } from './help-words.js';
import { toast } from './ui/status.js';
import { homeOverview, homePanel, refreshHome, startVisit } from './home.js';
import { tabs } from './ui/state.js';

// The page modules the table of pages (settings-pages.js) names, by file name. A row's `page` is an export of its `module`.
const PAGE_MODULES = { 'settings.js': settings, 'settings-machines.js': settingsMachines, 'skills.js': skills, 'where.js': where, 'memory.js': memory,
  'decisions.js': decisions, 'ideas.js': ideas, 'people.js': people, 'contraptions.js': contraptions, 'units.js': units, 'unused.js': unused, 'reviews.js': reviews,
  'help.js': help, 'properties.js': properties };
/** The function that draws a Settings or Orders page, from its row. */
const pageFn = (kind) => PAGE_MODULES[pageRow(kind).module][pageRow(kind).page];

/**
 * The Releases page (#626) on `scope` ('all' or a scheme's id), `hl` a change to highlight. On the scheme already on
 * screen it swaps the main panel at once, the lists staying (its data is on the page already); else the scheme loads.
 */

// The desktop app (#1186, Josh 2026-11-20: "Windows PCs only"): Citadel in its own window, where copying doesn't trip
// Defender. Offered in a browser or the installed web app on Windows; the app itself says so through its preload.
// Its install zip is #1148's feed for the Citadel scheme (2), which publishes it as "citadel".
const DESKTOP_APP = 'api/desktop/2/citadel/install.zip';
export const offersApp = (nav = navigator, desktop = window.citadelDesktop) =>
  !desktop && /Windows/.test(nav.userAgentData?.platform ?? nav.userAgent ?? '');
const getApp = () => offersApp()
  ? h('a', { class: 'get-app', href: DESKTOP_APP, download: '', title: 'Download the Citadel app: Citadel in its own window on this PC. Unzip it and run citadel.exe', 'aria-label': 'Download the Citadel app' }, 'Get app')
  : null;

export async function showReleases(projectId, scope, hl) {
  setReleasesPage(scope, hl);
  if (!(view?.kind === 'project' && view.projectId === projectId && document.querySelector('#app .split'))) return showProject(projectId, { kind: 'releases' });
  const { kind, project, coordinator, taskmasters, tickets, seen, personNotes, pins, builds, buildPreviews, artifacts, shared, showClosed, machines, projects } = view;
  setView({
    kind, main: 'releases', projectId, project, coordinator, taskmasters, tickets, seen, personNotes, pins, builds, buildPreviews, artifacts, shared, showClosed, machines, projects,
    artifactId: null, file: null, ...chatView(null, null),
  });
  renderCrumbs({ kind: 'releases' });
  document.querySelector('#app .split').lastElementChild.replaceWith(releasesPage());
  // On phones the panels sit above the page; collapse them away as switchChat does.
  if (matchMedia('(max-width: 800px)').matches) for (const el of document.querySelectorAll('#app .panels > details:not(.citadel-drawer)')) el.open = false;
  renderShelf();
  renderSidebar();
  renderSchemesShelf();
  window.scrollTo(0, 0);
}

/** Old links address a thread by its global id (#/t/<id>); send them to its project address. */
export async function showTicket(ticketId) {
  const seq = routeSeq;
  const { ticket } = await api(`api/tickets/${ticketId}`);
  if (seq !== routeSeq) return; // overtaken by another click while loading
  if (isCoordinator(ticket) || ticket.number != null) return replaceHash(threadHref(ticket));
  await showProject(ticket.project_id, { kind: 'chat', id: ticketId });
}

/** The Minions | Orders tabs in the panel's header; a tab switches the panel, never collapses it (a button inside a summary doesn't toggle it). */
const panelTabs = (...labels) => {
  const box = tabs({ items: [['minions', labels[0]], ['orders', labels[1]]], current: 'minions', className: 'label panel-tabs',
    onSelect: (name) => clickPanelTab(box.element.closest('.sidebar'), name) });
  const [minionsTab, ordersTab] = box.element.querySelectorAll('button');
  minionsTab.dataset.part = 'minions-tab'; // literal names: test/show-parts.test.ts greps for them
  ordersTab.dataset.part = 'orders-tab';
  for (const b of [minionsTab, ordersTab]) b.classList.add('panel-tab', `${b.dataset.key}-tab`);
  return box.element;
};

/** Per scheme, the last chat hash and the last Orders hash you were on, so a tab click goes back to where you were. */
const lastHash = new Map();
function noteHash() {
  const m = location.hash.match(/^#\/p\/(\d+)(?:\/(t\/\d+|[a-z-]+))?(?:[?/].*)?$/);
  if (!m) return;
  const slot = lastHash.get(m[1]) ?? {};
  if (!m[2] || m[2].startsWith('t/')) slot.chat = location.hash.split('?')[0];
  else if (m[2] === 'orders' || isOrdersPage(m[2])) slot.orders = location.hash.split('?')[0];
  else return;
  lastHash.set(m[1], slot);
}
addEventListener('hashchange', noteHash);
noteHash();

/** A tab click: the tab that's already selected does nothing; the other swaps the panel and the main pane. */
function clickPanelTab(sidebar, name) {
  const orders = name === 'orders';
  if (sidebar.classList.contains('show-orders') === orders) return;
  showPanelTab(sidebar, name);
  const id = view?.projectId;
  if (id == null) return;
  const slot = lastHash.get(String(id)) ?? {};
  const to = orders ? slot.orders ?? `#/p/${id}/orders` : slot.chat ?? `#/p/${id}`;
  if (location.hash.split('?')[0] !== to) location.hash = to;
}

/** Show the minions or the Orders pages in the panel. */
function showPanelTab(sidebar, name) {
  const orders = name === 'orders';
  sidebar.classList.toggle('show-orders', orders);
  for (const t of sidebar.querySelectorAll(':scope > summary .panel-tab')) { const on = t.classList.contains('orders-tab') === orders; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; }
}

function renderCrumbs(main) {
  const { project } = view;
  // The scheme list's row carries the icon's version; the scheme's own doesn't.
  const icon = () => schemeIcon(view.projects?.find((p) => p.id === project.id) ?? project);
  const projectLink = h('a', { href: `#/p/${project.id}`, class: 'scheme-crumb' }, icon(), h('span', { 'data-project-name': project.id }, project.name));
  const filesLink = (to) => h('a', { href: `#/p/${project.id}/${to}` }, 'Files');
  // Orders pages (#1071) sit under Orders, the rest under Settings.
  const settingsLink = isOrdersPage(main.kind) ? h('a', { href: `#/p/${project.id}/orders` }, 'Orders') : h('a', { href: `#/p/${project.id}/settings` }, 'Settings');
  crumbs.replaceChildren(...(
    main.kind === 'home' ? ['Home'] // #1140
      : main.kind === 'files' ? [projectLink, ' / ', 'Files']
      : main.kind === 'settings' ? [projectLink, ' / ', 'Settings']
      : main.kind === 'orders' ? [projectLink, ' / ', 'Orders']
      : pageRow(main.kind) && !pageRow(main.kind).own ? [projectLink, ' / ', settingsLink, ' / ', pageRow(main.kind).crumb ?? pageRow(main.kind).label]
      : main.kind === 'artifact' ? [projectLink, ' / ', filesLink('artifacts'), ' / ', main.artifact.name]
      : main.kind === 'releases' ? [projectLink, ' / ', 'Releases']
      : main.kind === 'schedules' ? [projectLink, ' / ', settingsLink, ' / ', main.schedule ? h('a', { href: `#/p/${project.id}/schedules` }, 'Schedules') : 'Schedules']
      : main.kind === 'ci' ? [projectLink, ' / ', 'CI']
      : main.kind === 'status' ? [projectLink, ' / ', 'Status']
      : main.kind === 'shared' ? [projectLink, ' / ', filesLink('shared'), ' / ', main.file.name]
        : view.id !== view.coordinator.id ? [projectLink, ' / ', `#${view.ticket.number ?? view.ticket.id}`]
          : [h('span', { class: 'scheme-crumb' }, icon(), h('span', { 'data-project-name': project.id }, project.name))]));
}

/**
 * A project page: artifacts and threads on the side, and in the main panel a chat with the
 * coordinator (or the chosen ticket), the artifact browser, or one artifact.
 */
export async function showProject(projectId, main = { kind: 'chat', number: null }) {
  const seq = routeSeq;
  // Moving between chats of the project already on screen only swaps the chat; the side panels stay.
  // In and out of Home (#1140) redraws the side panel, so only a chat to a chat in the same mode swaps.
  if (main.kind === 'chat' && view?.kind === 'project' && view.projectId === projectId && !!view.home === !!main.home && document.getElementById('threads')) {
    if (await switchChat(main, seq)) return;
  }
  // Another schedule of the Schedules page on screen only swaps its page and the list's highlight (#1083).
  if (main.kind === 'schedules' && view?.kind === 'project' && view.main === 'schedules' && view.projectId === projectId && openSchedule(projectId, main.schedule)) {
    renderCrumbs(main);
    return;
  }
  // A scheme you were on earlier this session draws from its payload as you left it and refreshes in place
  // behind (#538), unless the link is to a minion that payload doesn't have.
  rememberScheme();
  const last = main.kind === 'chat' ? schemeCache.get(projectId) : null;
  const stale = last && (main.number == null || last.tickets.some((t) => t.number === main.number)) ? last : null;
  // The chat's history starts with the scheme when its id is known already: a link's, or the Taskmaster's from the
  // scheme list (#538), so a switch takes one round trip, not two. A wrong guess is dropped below.
  const early = main.kind !== 'chat' ? null : main.id ?? (main.number == null ? view?.projects?.find((p) => p.id === projectId)?.coordinator_id : null);
  const earlyCached = early ? cachedEvents(early) : null;
  const earlyPage = early && !earlyCached ? loadEvents(early).catch(() => null) : null;
  // The scheme list is redrawn behind on a switch (refreshSchemes below); only a first load waits for it, for the shelf.
  const known = view?.projects?.length ? view.projects : null;
  const [{ project, coordinator, taskmasters, tickets: open, dismissed, seen, person_notes, pins, builds, build_previews }, artifacts, shared, projects, machines] = stale
    ? [{ ...stale, dismissed: 0, person_notes: stale.personNotes, build_previews: stale.buildPreviews }, stale.artifacts, stale.shared, known, stale.machines]
    : await Promise.all([
    // The dismissed minions stay on the server until the Dismissed list is opened, searched or linked to: most of a big scheme's payload (#538), 8,000 elements.
    api(`api/projects/${projectId}?tickets=open`),
    // An empty shelf beats a broken page if the server is older than this front end.
    api(`api/projects/${projectId}/artifacts`).catch(() => []),
    api(`api/projects/${projectId}/shared`).catch(() => []),
    // A failed fetch keeps the list already shown and tries again below, rather than blanking it (#491).
    known ?? api('api/projects').catch(() => null),
    // Each person's own machines; an admin's list has every machine (#306).
    api('api/machines').catch(() => []),
    // The Needs-you strip and the Filters button come with the first paint, not after it: they'd push the list down (#989).
    fetchInbox(projectId),
    preparePropFilter(projectId),
  ]);
  if (stale) preparePropFilter(projectId);
  let tickets = open;
  // A link to a dismissed minion fetches that one minion; any other open draws without it.
  const findClosed = main.kind === 'chat' && main.number != null && dismissed && !open.some((t) => t.number === main.number);
  if (findClosed) tickets = open.concat((await api(`api/projects/${projectId}?tickets=closed&number=${main.number}`)).tickets);
  let chatId = null;
  if (main.kind === 'chat') {
    chatId = main.id ?? (main.number == null ? coordinator.id : tickets.find((t) => t.number === main.number)?.id);
    if (!chatId) {
      // An old or mistyped link: open the scheme, with the page around it, and say why.
      if (seq === routeSeq) { toast(`There is no minion #${main.number} in ${project.name}.`, { tone: 'warn', ms: 8000 }); replaceHash(`#/p/${projectId}`); }
      return;
    }
  }
  // The minion came with the scheme's list; its history is drawn from the cache when it's there (#527).
  const ticket = !chatId ? null : chatId === coordinator.id ? coordinator : tickets.find((t) => t.id === chatId) ?? (await api(`api/tickets/${chatId}`)).ticket;
  // Your Taskmaster in a scheme with several (#919) opens as Mine or Everyone, merged across them (#920).
  const merged = chatId === coordinator.id ? mergedView(projectId, chatId, taskmasters, tmViewMode()) : null;
  const src = merged?.src ?? chatId;
  const guessed = chatId && chatId === early && !merged;
  const cached = guessed ? earlyCached : chatId ? cachedEvents(src) : null;
  const page = cached?.page ?? (guessed ? await earlyPage : null) ?? (chatId ? await loadEvents(src) : null);
  if (seq !== routeSeq) return; // overtaken by another click while loading
  forgetOtherSchemes();
  // Coming to Home from elsewhere is a new visit: its rows start afresh.
  if (main.home && !view?.home) startVisit();
  setView({
    home: !!main.home, // Home's list in the side panel and its overview or a chat beside it (#1140)
    kind: 'project', main: main.kind, projectId, project, coordinator, tickets: new Map(tickets.map((t) => [t.id, t])),
    taskmasters: taskmasters ?? [], // every Taskmaster session once the scheme has several (#919): { id, person_id, person_name }
    seen: seen ?? {}, // ticket id -> when you last looked at it (server time)
    personNotes: person_notes ?? {}, // ticket id -> people's note on it { text, by, at } (#146)
    pins: pins ?? [], // ticket ids you pinned, oldest pin first (#179)
    builds: builds ?? [], // build branches' headers: { build, merged, open, behind } (src/builds.ts)
    buildPreviews: !!build_previews, // this server runs the scheme's code, so each build branch has a preview (src/previews.ts)
    artifacts, shared, artifactId: main.artifact?.id ?? null, machines, projects: projects ?? view?.projects ?? [],
    file: main.file ?? null,
    ...chatView(chatId, ticket, merged),
  });
  if (stale) restoreClosed(view.tickets, stale.closed);
  else setClosedTotal(view.tickets, dismissed);
  renderCrumbs(main);
  try { localStorage.setItem(LAST_SCHEME, String(projectId)); } catch {}

  // Both side panels collapse to a slim tab so the main panel can take their room. On wider
  // screens that choice is remembered; on phones they collapse away above the main panel instead.
  const narrowQuery = matchMedia('(max-width: 800px)');
  const panelOpen = (name) => !narrowQuery.matches && loadPanelState()[name] !== false;
  // The overview panel: account and usage (standing in for the top bar, which wider screens hide
  // on project pages), the projects, then this project's pinned and recent artifacts.
  const shelf = h('details', { class: 'shelf', open: panelOpen('shelf') },
    h('summary', { title: 'Show or hide the overview' }, projectTitle(project)),
    h('section', { class: 'account' },
      // The CI chip moved beside Releases over the scheme list (#1019, Cara 2026-11-18: "move the CI button with the dot next to the Releases button").
      h('div', { class: 'meter-row' }, usageMeter()),
      // Point at something (#1141, Josh picked "Yes, in the drawer"): phones only, as their pages without a chat have
      // no 🎯 and no keyboard. A link, so the drawer puts itself away on the tap (drawers.js).
      h('a', { href: '#', class: 'point-entry', 'data-part': 'point-at-drawer', onclick: (e) => { e.preventDefault(); startPick(); } },
        h('span', { 'aria-hidden': 'true' }, '🎯'), 'Point at something'),
      // Settings shows in the header beside the scheme; who is signed in sits with Sign out along the box's foot.
      h('div', { class: 'foot' },
        h('span', { class: 'who' }, me),
        getApp(),
        h('button', { type: 'button', class: 'sign-out', onclick: logout }, 'Sign out'))),
    h('section', { class: 'column', id: 'schemes-shelf' }),
    h('div', { id: 'artifact-shelf' }));
  // Home (#1140): its list takes the panel's place (on a phone, Home's own page holds it), the scheme's parts kept but hidden.
  const narrowHome = main.kind === 'home' && narrowQuery.matches;
  const sidebar = h('details', { class: `sidebar${main.home ? ' home-mode' : ''}`, open: panelOpen('threads') },
    main.home ? h('summary', { title: 'Show or hide Home' }, h('span', { class: 'label' }, 'Home'))
    // Minions | Orders (#1071, Josh picked "Minions | Orders tabs on the panel"): Orders swaps the list for its pages.
    : h('summary', { title: 'Show or hide minions' }, panelTabs(h('span', { class: 'tab-name' }, gloss('minion', 'Minions')), (() => { const f = document.createDocumentFragment(); f.append('Orders', h('span', { class: 'count props-count', hidden: true })); return f; })())),
    main.home && !narrowHome ? homePanel() : '',
    h('div', { id: 'github-strip', class: 'github-strip', hidden: true }),
    h('div', { id: 'hidden-note', class: 'hidden-note', hidden: true }),
    inboxStrip(),
    // The coordinator sits above the search so it stays one click away while searching.
    h('div', { id: 'coordinator-row' }),
    threadSearchBox(projectId),
    h('div', { id: 'saved-views', class: 'saved-views' }),
    h('div', { id: 'prop-filter', class: 'prop-filter' }),
    h('div', { id: 'threads', 'data-part': 'minion-list' }),
    // Orders → Schedules lists the schedules in the panel in place of the Orders menu (#1083); a row opens its page.
    main.kind === 'schedules' ? schedulesPane(projectId, main.schedule) : '',
    ordersMenu());
  sidebar.classList.toggle('show-schedules', main.kind === 'schedules');
  // An Orders page, or the Orders crumb, opens on the Orders tab; anything else on the minions.
  showPanelTab(sidebar, isOrdersPage(main.kind) || main.orders ? 'orders' : 'minions');
  if (main.orders) sidebar.open = true;
  for (const [name, el] of [['shelf', shelf], ['threads', sidebar]]) {
    el.addEventListener('toggle', () => {
      if (!narrowQuery.matches) savePanelState({ ...loadPanelState(), [name]: el.open });
    });
  }
  narrowQuery.onchange = () => {
    if (narrowQuery.matches) return;
    shelf.open = panelOpen('shelf');
    sidebar.open = panelOpen('threads');
  };
  const section = main.kind === 'home' ? homeOverview(narrowHome ? homePanel() : null)
    : main.kind === 'files' ? filesView(main.folder)
    : main.kind === 'settings' ? settingsHome()
    : main.kind === 'orders' ? settingsHome(true)
    : pageRow(main.kind) && !pageRow(main.kind).own ? pageFn(main.kind)()
    : main.kind === 'releases' ? releasesPage()
    : main.kind === 'schedules' ? schedulesPage(projectId, main.schedule)
    : main.kind === 'ci' ? ciPage(projectId, main.tab, main.all)
    : main.kind === 'status' ? statusPage(projectId, main.all)
    : main.kind === 'artifact' ? artifactViewer(main.artifact)
      : main.kind === 'shared' ? sharedViewer(main.file)
        : chatSection(chatId, ticket);

  // .panels only becomes a box of its own when both panels are collapsed, so their tabs can share
  // one slim sticky column; otherwise the panels sit directly in the grid.
  // Home's list keeps its scroll from one scheme's chat to another's (#1140).
  const homeScroll = main.home ? document.querySelector('#app .sidebar.home-mode')?.scrollTop ?? 0 : 0;
  app.replaceChildren(h('div', { class: 'split' }, h('div', { class: 'panels' }, shelf, sidebar), section));
  if (homeScroll) sidebar.scrollTop = homeScroll;
  renderUsage();
  renderCost();
  renderSettingsCount();
  renderShelf();
  renderSidebar();
  renderGithubStrip();
  renderSchemesShelf();
  if (!projects || known) refreshSchemes();
  if (stale) refreshScheme(projectId);
  renderHiddenNote();
  refreshInbox();
  if (main.home) refreshHome();
  prefetchTopRows();
  if (main.kind === 'files') renderFiles();
  if (main.kind === 'artifact') renderArtifactHead();
  if (main.kind === 'shared') renderSharedHead();
  if (!chatId) return window.scrollTo(0, 0);
  revealActiveRow();
  await mountChat(chatId, ticket, page, cached?.fresh);
}

// The schemes you've left this session, each as you left it, most recent last (#538).
const schemeCache = new Map();
const SCHEME_CACHE = 6;

function rememberScheme() {
  if (view?.kind !== 'project' || !view.tickets) return;
  const { projectId, project, coordinator, taskmasters, tickets, seen, personNotes, pins, artifacts, shared, machines } = view;
  schemeCache.delete(projectId);
  schemeCache.set(projectId, { project, coordinator, taskmasters, tickets: [...tickets.values()], closed: closedSnapshot(tickets), seen, personNotes, pins, artifacts, shared, machines });
  if (schemeCache.size > SCHEME_CACHE) schemeCache.delete(schemeCache.keys().next().value);
}

/** Signing out: the next person mustn't see this one's schemes drawn, even for a moment. */
export function forgetSchemes() {
  schemeCache.clear();
}

/**
 * Bring a scheme drawn from its last payload up to date in place (#538), with a ring by "Minions" meanwhile.
 * A failed fetch (a restart's gap) tries again, backing off to 30 s.
 */
async function refreshScheme(projectId) {
  const list = view.tickets;
  // The chat you're on, if the refresh brought a newer copy of it (one dismissed while you were away, say).
  const headUp = () => {
    const shown = view.id === view.coordinator.id ? view.coordinator : list.get(view.id);
    if (view.tickets !== list || !shown || shown === view.ticket) return;
    view.ticket = shown;
    renderTicketHead();
  };
  const panel = document.querySelector('#app .sidebar');
  panel?.setAttribute('aria-busy', 'true');
  let got = null, before;
  for (let wait = 1000; !got; wait = Math.min(30_000, wait * 2)) {
    before = new Map(list); // what the stream changes meanwhile is newer than the answer
    got = await Promise.all([
      api(`api/projects/${projectId}?tickets=open`),
      api(`api/projects/${projectId}/artifacts`).catch(() => view.artifacts),
      api(`api/projects/${projectId}/shared`).catch(() => view.shared),
      api('api/machines').catch(() => view.machines),
    ]).catch(() => null);
    if (view?.kind !== 'project' || view.tickets !== list) return; // a newer load of the scheme drew its own
    if (!got) await new Promise((r) => setTimeout(r, wait));
  }
  panel?.removeAttribute('aria-busy');
  const [{ project, coordinator, taskmasters, tickets: open, dismissed, seen, person_notes, pins, builds, build_previews }, artifacts, shared, machines] = got;
  closedState(list).total = dismissed ?? 0;
  const now = new Set(open.map((t) => t.id));
  // Dismissed since you left: gone until the Dismissed list brings it back as it is now.
  let gone = false;
  for (const [id, t] of list) if (t.status !== 'closed' && !now.has(id) && before.get(id) === t) { list.delete(id); gone = true; }
  // The pages read so far start below these: read from the newest again (the rows already in hand are skipped).
  if (gone) Object.assign(closedState(list), { cursor: null, more: true });
  for (const t of open) if (!(list.get(t.id)?.updated_at > t.updated_at)) list.set(t.id, t);
  if (!(view.coordinator.updated_at > coordinator.updated_at)) view.coordinator = coordinator;
  Object.assign(view, { project, taskmasters: taskmasters ?? view.taskmasters, seen: seen ?? view.seen, personNotes: person_notes ?? view.personNotes, pins: pins ?? view.pins, builds: builds ?? view.builds, buildPreviews: build_previews ?? view.buildPreviews, machines });
  headUp();
  renderSidebar();
  setArtifacts(artifacts, shared);
  renderGithubStrip();
  renderHiddenNote();
}

/**
 * Show another chat of the project on screen in place of the main panel, fetching only that thread
 * (and only its events not already cached). False when the thread is not one we know of yet.
 */
async function switchChat(main, seq) {
  let chatId = main.id ?? (main.number == null ? view.coordinator.id : [...view.tickets.values()].find((t) => t.number === main.number)?.id);
  // A dismissed minion the page hasn't read (one a search found, say): that one minion comes, not the list.
  if (!chatId && main.number != null) chatId = (await fetchClosedByNumber(main.number).catch(() => null))?.id;
  if (!chatId) return false;
  // The list already has the minion, kept current by the stream: draw the chat from it at once, with the
  // cached history when there is one, and fetch behind it (#527). Only a history not yet downloaded waits.
  const ticket = chatId === view.coordinator.id ? view.coordinator : view.tickets.get(chatId);
  if (!ticket) return false; // a dismissed one the page hasn't read: the full load fetches it
  const merged = chatId === view.coordinator.id ? mergedView(view.projectId, chatId, view.taskmasters, tmViewMode()) : null;
  const cached = cachedEvents(merged?.src ?? chatId);
  const page = cached?.page ?? await loadEvents(merged?.src ?? chatId);
  if (seq !== routeSeq) return true; // overtaken by another click while loading
  const { kind, home, projectId, project, coordinator, taskmasters, tickets, seen, personNotes, pins, artifacts, shared, showClosed, machines, projects } = view;
  setView({
    kind, home, main: 'chat', projectId, project, coordinator, taskmasters, tickets, seen, personNotes, pins, artifacts, shared, showClosed, machines, projects,
    artifactId: null, file: null,
    ...chatView(chatId, ticket, merged),
  });
  if (isCoordinator(ticket)) view.coordinator = ticket;
  else view.tickets.set(ticket.id, ticket);
  renderCrumbs(main);
  document.querySelector('#app .split').lastElementChild.replaceWith(chatSection(chatId, ticket));
  // On phones the panels sit above the chat; collapse them away as a fresh load would.
  if (matchMedia('(max-width: 800px)').matches) for (const el of document.querySelectorAll('#app .panels > details:not(.citadel-drawer)')) el.open = false;
  renderShelf();
  renderSidebar();
  if (view.home) homePanel(); // its row for the chat now open
  revealActiveRow();
  const v = view;
  api(`api/tickets/${chatId}`).then((r) => { if (view === v) onTicketUpdate(r.ticket); }).catch(() => {});
  await mountChat(chatId, ticket, page, cached?.fresh);
  return true;
}
