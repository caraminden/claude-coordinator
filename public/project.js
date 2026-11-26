// A scheme's page: its side panels and the main panel, and switching between chats.
/** @import { ArtifactFile, SharedFile, Ticket, View } from './types.js' */
/** @typedef {Pick<View, 'project' | 'coordinator' | 'taskmasters' | 'seen' | 'personNotes' | 'pins' | 'builds' | 'buildPreviews' | 'artifacts' | 'shared' | 'machines'> & { tickets: Ticket[], closed: ReturnType<typeof closedSnapshot> }} Cached A scheme as it was left (rememberScheme). */
/** @typedef {{ kind: string, number?: number | null, id?: number, home?: boolean, orders?: boolean, folder?: string, machine?: string, schedule?: number | null, focus?: number | null, artifact?: ArtifactFile, file?: SharedFile & { path: string } }} Main What the route asks the main panel to show. */
import { account, api, h, isCoordinator, loadPanelState, me, openView, savePanelState, schemeIcon, setView, threadHref, view } from './base.js';
import { app, cachedEvents, crumbs, loadEvents, logout, onTicketUpdate, prefetchTopRows, renderUsage, routeSeq, usageMeter } from './core.js';
import { goReleases, releasesShell } from './ci.js';
import * as settings from './settings.js';
import { ordersMenu, projectTitle, renderGithubStrip, settingsHome } from './settings.js';
import * as settingsMachines from './settings-machines.js';
import { isOrdersPage, pageRow } from './settings-pages.js';
import { closedSnapshot, closedState, fetchClosedByNumber, restoreClosed, setClosedTotal } from './closedlist.js';
import { LAST_SCHEME, renderSidebar, revealActiveRow, threadSearchBox } from './sidebar.js';
import { startPick } from './pick.js';
import { artifactViewer, renderArtifactHead, setArtifacts, renderSharedHead, renderShelf, sharedViewer } from './artifacts.js';
import { filesView, renderFiles } from './files.js';
import { chatSection, chatView, mountChat, tmViewMode } from './thread.js';
import { renderTicketHead } from './thread-head.js';
import { mergedView } from './mine.js';
import * as properties from './properties.js';
import { preparePropFilter, renderSettingsCount } from './properties.js';
import { renderCost } from './cost.js';
import * as where from './where.js';
import * as skills from './skills.js';
import { fetchInbox, forgetOtherSchemes, inboxStrip, refreshInbox, stripWaits, takeItems } from './inbox.js';
import { refreshSchemes, renderHiddenNote, renderSchemesShelf } from './hidden.js';
import { openSchedule, schedulesPage, schedulesPane } from './schedules.js';
import { chainsPage } from './chains.js';
import { replaceHash } from './navstack.js';
import * as memory from './memory.js';
import * as decisions from './decisions.js';
import * as ideas from './ideas.js';
import * as people from './people.js';
import * as contraptions from './contraptions.js';
import * as units from './units.js';
import * as unused from './unused.js';
import * as reviews from './reviews.js';
import * as help from './help.js';
import { gloss } from './help-words.js';
import { toast } from './ui/status.js';
import { homeOverview, homePanel, refreshHome, startVisit } from './home.js';
import { tabs } from './ui/state.js';

// The page modules the table of pages (settings-pages.js) names, by file name. A row's `page` is an export of its `module`.
const PAGE_MODULES = {
  'settings.js': settings,
  'settings-machines.js': settingsMachines,
  'skills.js': skills,
  'where.js': where,
  'memory.js': memory,
  'decisions.js': decisions,
  'ideas.js': ideas,
  'people.js': people,
  'contraptions.js': contraptions,
  'units.js': units,
  'unused.js': unused,
  'reviews.js': reviews,
  'help.js': help,
  'properties.js': properties,
};
/** The function that draws a Settings or Orders page, from its row. */
const pageFn = (kind) => PAGE_MODULES[/** @type {import('./settings-pages.js').PageRow} */ (pageRow(kind)).module][/** @type {import('./settings-pages.js').PageRow} */ (pageRow(kind)).page];

/**
 * The Releases page (#626) on `scope` ('all' or a scheme's id), `hl` a change to highlight. On the scheme already on
 * screen it swaps the main panel at once, the lists staying (its data is on the page already); else the scheme loads.
 */

// The desktop app (#1186, Josh 2026-11-20: "Windows PCs only"): Citadel in its own window, where copying doesn't trip
// Defender. Offered in a browser or the installed web app on Windows; the app itself says so through its preload.
// Its install zip is #1148's feed for the Citadel scheme (2), which publishes it as "citadel".
const DESKTOP_APP = 'api/desktop/2/citadel/install.zip';
export const offersApp = (nav = /** @type {Navigator & { userAgentData?: { platform?: string } }} */ (navigator), desktop = window.citadelDesktop) => !desktop && /Windows/.test(nav.userAgentData?.platform ?? nav.userAgent ?? '');
const getApp = () => (offersApp() ? h('a', { class: 'get-app', href: DESKTOP_APP, download: '', title: 'Download the Citadel app: Citadel in its own window on this PC. Unzip it and run citadel.exe', 'aria-label': 'Download the Citadel app' }, 'Get app') : null);

/** The Releases page (#1423: Releases, CI and Status as its tabs) on `to` = { scope, tab, hl }: an open one switches in place. @param {number} projectId @param {Parameters<typeof goReleases>[1]} to */
export async function showReleases(projectId, to) {
  if (goReleases(projectId, to) && view?.main === 'releases') return;
  if (!(view?.kind === 'project' && view.projectId === projectId && !view.home && document.querySelector('#app .split'))) return showProject(projectId, { kind: 'releases' });
  const { kind, project, coordinator, taskmasters, tickets, seen, personNotes, pins, builds, buildPreviews, artifacts, shared, showClosed, machines, projects } = view;
  setView({
    kind,
    main: 'releases',
    projectId,
    project,
    coordinator,
    taskmasters,
    tickets,
    seen,
    personNotes,
    pins,
    builds,
    buildPreviews,
    artifacts,
    shared,
    showClosed,
    machines,
    projects,
    artifactId: null,
    file: null,
    ...chatView(null, null),
  });
  renderCrumbs({ kind: 'releases' });
  mainPane().replaceWith(releasesShell());
  // On phones the panels sit above the page; collapse them away as switchChat does.
  if (matchMedia('(max-width: 800px)').matches) for (const el of /** @type {NodeListOf<HTMLDetailsElement>} */ (document.querySelectorAll('#app .panels > details:not(.citadel-drawer)'))) el.open = false;
  renderShelf();
  renderSidebar();
  renderSchemesShelf();
  window.scrollTo(0, 0);
}

/** The main panel's element, which a switch of chat or page replaces. */
const mainPane = () => /** @type {Element} */ (/** @type {Element} */ (document.querySelector('#app .split')).lastElementChild);

/** Old links address a thread by its global id (#/t/<id>); send them to its project address. @param {number} ticketId */
export async function showTicket(ticketId) {
  const seq = routeSeq;
  const { ticket } = await api(`api/tickets/${ticketId}`);
  if (seq !== routeSeq) return; // overtaken by another click while loading
  if (isCoordinator(ticket) || ticket.number != null) return replaceHash(threadHref(ticket));
  await showProject(ticket.project_id, { kind: 'chat', id: ticketId });
}

/** The Minions | Orders tabs in the panel's header; a tab switches the panel, never collapses it (a button inside a summary doesn't toggle it). */
const panelTabs = (/** @type {(Node | string)[]} */ ...labels) => {
  const box = tabs({
    items: [
      ['minions', labels[0]],
      ['orders', labels[1]],
    ],
    current: 'minions',
    className: 'label panel-tabs',
    onSelect: (/** @type {string} */ name) => clickPanelTab(/** @type {HTMLElement} */ (box.element.closest('.sidebar')), name),
  });
  const [minionsTab, ordersTab] = box.element.querySelectorAll('button');
  minionsTab.dataset.part = 'minions-tab'; // literal names: test/show-parts.test.ts greps for them
  ordersTab.dataset.part = 'orders-tab';
  for (const b of [minionsTab, ordersTab]) b.classList.add('panel-tab', `${b.dataset.key}-tab`);
  return box.element;
};

/** Per scheme, the last chat hash and the last Orders hash you were on, so a tab click goes back to where you were. */
/** @type {Map<string, { chat?: string, orders?: string }>} */ const lastHash = new Map();
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

/** A tab click: the tab that's already selected does nothing; the other swaps the panel and the main pane. @param {HTMLElement} sidebar @param {string} name */
function clickPanelTab(sidebar, name) {
  const orders = name === 'orders';
  if (sidebar.classList.contains('show-orders') === orders) return;
  showPanelTab(sidebar, name);
  const id = view?.projectId;
  if (id == null) return;
  const slot = lastHash.get(String(id)) ?? {};
  const to = orders ? (slot.orders ?? `#/p/${id}/orders`) : (slot.chat ?? `#/p/${id}`);
  if (location.hash.split('?')[0] !== to) location.hash = to;
}

/** Show the minions or the Orders pages in the panel. @param {HTMLElement} sidebar @param {string} name */
function showPanelTab(sidebar, name) {
  const orders = name === 'orders';
  sidebar.classList.toggle('show-orders', orders);
  for (const t of /** @type {NodeListOf<HTMLElement>} */ (sidebar.querySelectorAll(':scope > summary .panel-tab'))) {
    const on = t.classList.contains('orders-tab') === orders;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
}

/** @param {Main} main */
function renderCrumbs(main) {
  const v = openView();
  const { project } = v;
  // The scheme list's row carries the icon's version; the scheme's own doesn't.
  const icon = () => schemeIcon(v.projects?.find((p) => p.id === project.id) ?? project);
  const projectLink = h('a', { href: `#/p/${project.id}`, class: 'scheme-crumb' }, icon(), h('span', { 'data-project-name': project.id }, project.name));
  const filesLink = (/** @type {string} */ to) => h('a', { href: `#/p/${project.id}/${to}` }, 'Files');
  // Orders pages (#1071) sit under Orders, the rest under Settings.
  const settingsLink = isOrdersPage(main.kind) ? h('a', { href: `#/p/${project.id}/orders` }, 'Orders') : h('a', { href: `#/p/${project.id}/settings` }, 'Settings');
  crumbs.replaceChildren(
    ...(main.kind === 'home'
      ? ['Home'] // #1140
      : main.kind === 'files'
        ? [projectLink, ' / ', 'Files']
        : main.kind === 'settings'
          ? [projectLink, ' / ', 'Settings']
          : main.kind === 'orders'
            ? [projectLink, ' / ', 'Orders']
            : pageRow(main.kind) && !(/** @type {import('./settings-pages.js').PageRow} */ (pageRow(main.kind)).own)
              ? [projectLink, ' / ', settingsLink, ' / ', /** @type {import('./settings-pages.js').PageRow} */ (pageRow(main.kind)).crumb ?? /** @type {import('./settings-pages.js').PageRow} */ (pageRow(main.kind)).label]
              : main.kind === 'artifact'
                ? [projectLink, ' / ', filesLink('artifacts'), ' / ', /** @type {ArtifactFile} */ (main.artifact).name]
                : main.kind === 'releases'
                  ? [projectLink, ' / ', 'Releases']
                  : main.kind === 'chains'
                    ? [projectLink, ' / ', main.focus ? h('a', { href: `#/p/${project.id}/chains` }, 'Chains') : 'Chains']
                    : main.kind === 'schedules'
                      ? [projectLink, ' / ', settingsLink, ' / ', main.schedule ? h('a', { href: `#/p/${project.id}/schedules` }, 'Schedules') : 'Schedules']
                      : main.kind === 'shared'
                        ? [projectLink, ' / ', filesLink('shared'), ' / ', /** @type {SharedFile} */ (main.file).name]
                        : v.id !== v.coordinator.id
                          ? [projectLink, ' / ', `#${/** @type {Ticket} */ (v.ticket).number ?? /** @type {Ticket} */ (v.ticket).id}`]
                          : [h('span', { class: 'scheme-crumb' }, icon(), h('span', { 'data-project-name': project.id }, project.name))]),
  );
}

let phoneWidth = null;
/**
 * A project page: artifacts and threads on the side, and in the main panel a chat with the
 * coordinator (or the chosen ticket), the artifact browser, or one artifact. @param {number} projectId @param {Main} [main]
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
  // scheme list (#538), so a switch takes one round trip, not two. A link by number asks for that one minion beside the
  // list, so its history doesn't wait for the list either (#1533). A wrong guess is dropped below.
  const earlyId = main.kind !== 'chat' ? null : (main.id ?? (main.number == null ? view?.projects?.find((p) => p.id === projectId)?.coordinator_id : null));
  const numbered =
    !stale && !earlyId && main.kind === 'chat' && main.number != null
      ? api(`api/projects/${projectId}?number=${main.number}`).then(
          (r) => r.tickets?.[0] ?? null,
          () => null,
        )
      : null;
  const early = (async () => {
    const id = earlyId ?? (await numbered)?.id;
    if (!id) return null;
    const cached = cachedEvents(id);
    return { id, cached, page: cached ? null : loadEvents(id).catch(() => null) };
  })();
  // The list draws as soon as its own answer comes (#1533): requests sent with it queue on the server's one thread and hold
  // it back, so a chat or Home asks for the files and machines after its first paint. The Needs-you strip and the Filters
  // button still come with that paint (#989), from what this tab saw of the scheme, or the shut strip's line holding its
  // place; only a first sight of the filter or an opened strip waits, beside the list (both are small). So does the scheme
  // list on a tab's first open: it draws the schemes shelf and the crumb's icon, which would push things if they came late.
  const later = main.kind === 'chat' || main.kind === 'home';
  const known = view?.projects?.length ? view.projects : null;
  const schemes = known ?? api('api/projects').catch(() => null);
  const filter = preparePropFilter(projectId);
  const firstItems = !stale && stripWaits(projectId) ? fetchInbox(projectId) : null;
  const files = stale || later ? null : shelfFiles(projectId);
  const [{ project, coordinator, taskmasters, tickets: open, dismissed, seen, person_notes, pins, builds, build_previews }, items, projects] = stale
    ? [{ ...stale, dismissed: 0, person_notes: stale.personNotes, build_previews: stale.buildPreviews }, null, known]
    : // The dismissed minions stay on the server until the Dismissed list is opened, searched or linked to: most of a big scheme's payload (#538), 8,000 elements.
      await Promise.all([api(`api/projects/${projectId}?tickets=open`), firstItems, schemes, filter]);
  const [artifacts, shared, machines] = stale ? [stale.artifacts, stale.shared, stale.machines] : files ? await files : [[], [], []]; // null: that read failed
  let tickets = open;
  // A link to a dismissed minion fetches that one minion; any other open draws without it.
  const findClosed = main.kind === 'chat' && main.number != null && dismissed && !open.some((/** @type {Ticket} */ t) => t.number === main.number);
  const found = numbered && (await numbered);
  if (findClosed) tickets = open.concat(found?.status === 'closed' ? [found] : (await api(`api/projects/${projectId}?tickets=closed&number=${main.number}`)).tickets);
  let chatId = null;
  if (main.kind === 'chat') {
    chatId = main.id ?? (main.number == null ? coordinator.id : tickets.find((/** @type {Ticket} */ t) => t.number === main.number)?.id);
    if (!chatId) {
      // An old or mistyped link: open the scheme, with the page around it, and say why.
      if (seq === routeSeq) {
        toast(`There is no minion #${main.number} in ${project.name}.`, { tone: 'warn', ms: 8000 });
        replaceHash(`#/p/${projectId}`);
      }
      return;
    }
  }
  // The minion came with the scheme's list; its history is drawn from the cache when it's there (#527).
  const ticket = !chatId ? null : chatId === coordinator.id ? coordinator : (tickets.find((/** @type {Ticket} */ t) => t.id === chatId) ?? (await api(`api/tickets/${chatId}`)).ticket);
  // Your Taskmaster in a scheme with several (#919) opens as Mine or Everyone, merged across them (#920).
  const merged = chatId === coordinator.id ? mergedView(projectId, chatId, taskmasters, tmViewMode()) : null;
  const src = merged?.src ?? chatId;
  const head = await early;
  const guessed = chatId && chatId === head?.id && !merged;
  const cached = guessed ? head?.cached : chatId ? cachedEvents(/** @type {number | string} */ (src)) : null;
  const page = cached ?? (guessed ? await head?.page : null) ?? (chatId ? await loadEvents(/** @type {number | string} */ (src)) : null);
  if (seq !== routeSeq) return; // overtaken by another click while loading
  forgetOtherSchemes();
  // Coming to Home from elsewhere is a new visit: its rows start afresh.
  if (main.home && !view?.home) startVisit();
  setView({
    home: !!main.home, // Home's list in the side panel and its overview or a chat beside it (#1140)
    kind: 'project',
    main: main.kind,
    projectId,
    project,
    coordinator,
    tickets: new Map(tickets.map((/** @type {Ticket} */ t) => /** @type {[number, Ticket]} */ ([t.id, t]))),
    taskmasters: taskmasters ?? [], // every Taskmaster session once the scheme has several (#919): { id, person_id, person_name }
    seen: seen ?? {}, // ticket id -> when you last looked at it (server time)
    personNotes: person_notes ?? {}, // ticket id -> people's note on it { text, by, at } (#146)
    pins: pins ?? [], // ticket ids you pinned, oldest pin first (#179)
    builds: builds ?? [], // build branches' headers: { build, merged, open, behind } (src/builds.ts)
    buildPreviews: !!build_previews, // this server runs the scheme's code, so each build branch has a preview (src/previews.ts)
    artifacts: artifacts ?? [],
    shared: shared ?? [],
    filesFailed: artifacts === null, // the read failed: say so, not "no files" or "Artifact removed" (HP16)
    artifactId: main.artifact?.id ?? null,
    machines,
    projects: projects ?? view?.projects ?? [],
    file: main.file ?? null,
    ...chatView(chatId, ticket, merged),
  });
  if (stale) restoreClosed(openView().tickets, stale.closed);
  else setClosedTotal(openView().tickets, dismissed);
  renderCrumbs(main);
  try {
    localStorage.setItem(LAST_SCHEME, String(projectId));
  } catch {}

  // Both side panels collapse to a slim tab so the main panel can take their room. On wider
  // screens that choice is remembered; on phones they collapse away above the main panel instead.
  // One watcher for the page's life, its handler replaced by each draw: a watcher with a handler is never freed, so one
  // made per draw kept every scheme page ever drawn, and the tab grew until it froze (#1747).
  const narrowQuery = (phoneWidth ??= matchMedia('(max-width: 800px)'));
  const panelOpen = (/** @type {string} */ name) => !narrowQuery.matches && loadPanelState()[name] !== false;
  // The overview panel: account and usage (standing in for the top bar, which wider screens hide
  // on project pages), the projects, then this project's pinned and recent artifacts.
  const shelf = h(
    'details',
    { class: 'shelf', open: panelOpen('shelf') },
    h('summary', { title: 'Show or hide the overview' }, projectTitle(project)),
    h(
      'section',
      { class: 'account' },
      // The CI chip moved beside Releases over the scheme list (#1019, Cara 2026-11-18: "move the CI button with the dot next to the Releases button").
      h('div', { class: 'meter-row' }, usageMeter()),
      // Point at something (#1141, Josh picked "Yes, in the drawer"): phones only, as their pages without a chat have
      // no 🎯 and no keyboard. A link, so the drawer puts itself away on the tap (drawers.js).
      h(
        'a',
        {
          href: '#',
          class: 'point-entry',
          'data-part': 'point-at-drawer',
          onclick: (/** @type {Event} */ e) => {
            e.preventDefault();
            startPick();
          },
        },
        h('span', { 'aria-hidden': 'true' }, '🎯'),
        'Point at something',
      ),
      // Settings shows in the header beside the scheme; who is signed in sits with Sign out along the box's foot.
      h('div', { class: 'foot' }, h('span', { class: 'who' }, me), getApp(), h('button', { type: 'button', class: 'sign-out', onclick: logout }, 'Sign out')),
    ),
    h('section', { class: 'column', id: 'schemes-shelf' }),
    h('div', { id: 'artifact-shelf' }),
  );
  // Home (#1140): its list takes the panel's place (on a phone, Home's own page holds it), the scheme's parts kept but hidden.
  const narrowHome = main.kind === 'home' && narrowQuery.matches;
  const sidebar = h(
    'details',
    { class: `sidebar${main.home ? ' home-mode' : ''}`, open: panelOpen('threads') },
    main.home
      ? h('summary', { title: 'Show or hide Home' }, h('span', { class: 'label' }, 'Home'))
      : // Minions | Orders (#1071, Josh picked "Minions | Orders tabs on the panel"): Orders swaps the list for its pages.
        h(
          'summary',
          { title: 'Show or hide minions' },
          panelTabs(
            h('span', { class: 'tab-name' }, gloss('minion', 'Minions')),
            (() => {
              const f = document.createDocumentFragment();
              f.append('Orders', h('span', { class: 'count props-count', hidden: true }));
              return f;
            })(),
          ),
        ),
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
    ordersMenu(),
  );
  sidebar.classList.toggle('show-schedules', main.kind === 'schedules');
  // An Orders page, or the Orders crumb, opens on the Orders tab; anything else on the minions.
  showPanelTab(sidebar, isOrdersPage(main.kind) || main.orders ? 'orders' : 'minions');
  if (main.orders) sidebar.open = true;
  for (const [name, el] of /** @type {[string, HTMLDetailsElement][]} */ ([
    ['shelf', shelf],
    ['threads', sidebar],
  ])) {
    el.addEventListener('toggle', () => {
      if (!narrowQuery.matches) savePanelState({ ...loadPanelState(), [name]: el.open });
    });
  }
  narrowQuery.onchange = () => {
    if (narrowQuery.matches) return;
    shelf.open = panelOpen('shelf');
    sidebar.open = panelOpen('threads');
  };
  const section =
    main.kind === 'home'
      ? homeOverview(narrowHome ? homePanel() : null)
      : main.kind === 'files'
        ? filesView(main.folder)
        : main.kind === 'settings'
          ? settingsHome()
          : main.kind === 'orders'
            ? settingsHome(true)
            : pageRow(main.kind) && !(/** @type {import('./settings-pages.js').PageRow} */ (pageRow(main.kind)).own)
              ? pageFn(main.kind)(main)
              : main.kind === 'releases'
                ? releasesShell()
                : main.kind === 'schedules'
                  ? schedulesPage(projectId, main.schedule)
                  : main.kind === 'chains'
                    ? chainsPage(projectId, main.focus)
                    : main.kind === 'artifact'
                      ? artifactViewer(main.artifact)
                      : main.kind === 'shared'
                        ? sharedViewer(main.file)
                        : chatSection(chatId, ticket);

  // .panels only becomes a box of its own when both panels are collapsed, so their tabs can share
  // one slim sticky column; otherwise the panels sit directly in the grid.
  // Home's list keeps its scroll from one scheme's chat to another's (#1140).
  const homeScroll = main.home ? (document.querySelector('#app .sidebar.home-mode')?.scrollTop ?? 0) : 0;
  app.replaceChildren(h('div', { class: 'split' }, h('div', { class: 'panels' }, shelf, sidebar), section));
  if (homeScroll) sidebar.scrollTop = homeScroll;
  renderUsage();
  renderCost();
  renderSettingsCount();
  renderShelf();
  renderSidebar();
  renderGithubStrip();
  renderSchemesShelf();
  if (!projects || known) refreshSchemes(); // the list known before this open may be old; a failed fetch tries again
  if (stale) refreshScheme(projectId);
  else if (later) fillShelf(projectId);
  renderHiddenNote();
  // A fresh open fetched the items with the list: draw those rather than ask again (#1528).
  if (items) takeItems(projectId, items);
  else refreshInbox();
  if (main.home) refreshHome();
  prefetchTopRows();
  if (main.kind === 'files') renderFiles();
  if (main.kind === 'artifact') renderArtifactHead();
  if (main.kind === 'shared') renderSharedHead();
  if (!chatId) return window.scrollTo(0, 0);
  revealActiveRow();
  await mountChat(chatId, ticket, page, !!cached);
}

/** A scheme's artifacts and shared files, and your machines (an admin's: every one, #306). An empty shelf beats a broken page if the server is older than this front end. */
const shelfFiles = (/** @type {number} */ projectId) => Promise.all([api(`api/projects/${projectId}/artifacts`).catch(() => null), api(`api/projects/${projectId}/shared`).catch(() => null), api('api/machines').catch(() => [])]);

/** A chat's or Home's first paint left the files and machines till after (#1533): fill them in, unless the page has moved on. */
async function fillShelf(/** @type {number} */ projectId) {
  const [artifacts, shared, machines] = await shelfFiles(projectId);
  if (view?.kind !== 'project' || view.projectId !== projectId) return;
  view.machines = machines; // only the Machines page draws them, and it isn't one of these
  setArtifacts(artifacts, shared);
}

// The schemes you've left this session, each as you left it, most recent last (#538).
/** @type {Map<number, Cached>} */ const schemeCache = new Map();
const SCHEME_CACHE = 6;

function rememberScheme() {
  if (view?.kind !== 'project' || !view.tickets) return;
  const { projectId, project, coordinator, taskmasters, tickets, seen, personNotes, pins, builds, buildPreviews, artifacts, shared, machines } = view;
  schemeCache.delete(projectId);
  schemeCache.set(projectId, { project, coordinator, taskmasters, tickets: [...tickets.values()], closed: closedSnapshot(tickets), seen, personNotes, pins, builds, buildPreviews, artifacts, shared, machines });
  if (schemeCache.size > SCHEME_CACHE) schemeCache.delete(/** @type {number} */ (schemeCache.keys().next().value));
}

/** Signing out: the next person mustn't see this one's schemes drawn, even for a moment. */
export function forgetSchemes() {
  schemeCache.clear();
}

/**
 * Bring a scheme drawn from its last payload up to date in place (#538), with a ring by "Minions" meanwhile.
 * A failed fetch (a restart's gap) tries again, backing off to 30 s.
 */
async function refreshScheme(/** @type {number} */ projectId) {
  let list = openView().tickets;
  // The chat you're on, if the refresh brought a newer copy of it (one dismissed while you were away, say).
  const headUp = () => {
    const shown = openView().id === openView().coordinator.id ? openView().coordinator : list.get(/** @type {number} */ (openView().id));
    if (openView().tickets !== list || !shown || shown === openView().ticket) return;
    openView().ticket = shown;
    renderTicketHead();
  };
  const panel = document.querySelector('#app .sidebar');
  panel?.setAttribute('aria-busy', 'true');
  let got = null,
    before;
  for (let wait = 1000; !got; wait = Math.min(30_000, wait * 2)) {
    before = new Map(list); // what the stream changes meanwhile is newer than the answer
    got = await Promise.all([api(`api/projects/${projectId}?tickets=open`), api(`api/projects/${projectId}/artifacts`).catch(() => openView().artifacts), api(`api/projects/${projectId}/shared`).catch(() => openView().shared), api('api/machines').catch(() => openView().machines)]).catch(() => null);
    if (view?.kind !== 'project' || view.projectId !== projectId) return void panel?.removeAttribute('aria-busy'); // left the scheme; its page is gone
    list = openView().tickets; // a reconnect's resync may have swapped the list meanwhile: the answer goes onto the one shown
    if (!got) await new Promise((r) => setTimeout(r, wait));
  }
  panel?.removeAttribute('aria-busy');
  const [{ project, coordinator, taskmasters, tickets: open, dismissed, seen, person_notes, pins, builds, build_previews }, artifacts, shared, machines] = got;
  closedState(list).total = dismissed ?? 0;
  const now = new Set(open.map((/** @type {Ticket} */ t) => t.id));
  // Dismissed since you left: gone until the Dismissed list brings it back as it is now.
  let gone = false;
  for (const [id, t] of list)
    if (t.status !== 'closed' && !now.has(id) && /** @type {Map<number, Ticket>} */ (before).get(id) === t) {
      list.delete(id);
      gone = true;
    }
  // The pages read so far start below these: read from the newest again (the rows already in hand are skipped).
  if (gone) Object.assign(closedState(list), { cursor: null, more: true });
  for (const t of open) if (!((list.get(t.id)?.updated_at ?? 0) > t.updated_at)) list.set(t.id, t);
  if (!(openView().coordinator.updated_at > coordinator.updated_at)) openView().coordinator = coordinator;
  Object.assign(openView(), { project, taskmasters: taskmasters ?? openView().taskmasters, seen: seen ?? openView().seen, personNotes: person_notes ?? openView().personNotes, pins: pins ?? openView().pins, builds: builds ?? openView().builds, buildPreviews: build_previews ?? openView().buildPreviews, machines });
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
/** @param {Main} main @param {number} seq */
async function switchChat(main, seq) {
  let chatId = main.id ?? (main.number == null ? openView().coordinator.id : [...openView().tickets.values()].find((t) => t.number === main.number)?.id);
  // A dismissed minion the page hasn't read (one a search found, say): that one minion comes, not the list.
  if (!chatId && main.number != null) chatId = (await fetchClosedByNumber(main.number).catch(() => null))?.id;
  if (!chatId) return false;
  // The list already has the minion, kept current by the stream: draw the chat from it at once, with the
  // cached history when there is one, and fetch behind it (#527). Only a history not yet downloaded waits.
  const ticket = chatId === openView().coordinator.id ? openView().coordinator : openView().tickets.get(chatId);
  if (!ticket) return false; // a dismissed one the page hasn't read: the full load fetches it
  const merged = chatId === openView().coordinator.id ? mergedView(openView().projectId, chatId, openView().taskmasters, tmViewMode()) : null;
  const cached = cachedEvents(merged?.src ?? chatId);
  const page = cached ?? (await loadEvents(merged?.src ?? chatId));
  if (seq !== routeSeq) return true; // overtaken by another click while loading
  const { kind, home, projectId, project, coordinator, taskmasters, tickets, seen, personNotes, pins, builds, buildPreviews, artifacts, shared, showClosed, machines, projects } = openView();
  setView({
    kind,
    home,
    main: 'chat',
    projectId,
    project,
    coordinator,
    taskmasters,
    tickets,
    seen,
    personNotes,
    pins,
    builds,
    buildPreviews,
    artifacts,
    shared,
    showClosed,
    machines,
    projects,
    artifactId: null,
    file: null,
    ...chatView(chatId, ticket, merged),
  });
  if (isCoordinator(ticket)) openView().coordinator = ticket;
  else openView().tickets.set(ticket.id, ticket);
  renderCrumbs(main);
  mainPane().replaceWith(chatSection(chatId, ticket));
  // On phones the panels sit above the chat; collapse them away as a fresh load would.
  if (matchMedia('(max-width: 800px)').matches) for (const el of /** @type {NodeListOf<HTMLDetailsElement>} */ (document.querySelectorAll('#app .panels > details:not(.citadel-drawer)'))) el.open = false;
  renderShelf();
  renderSidebar();
  if (openView().home) homePanel(); // its row for the chat now open
  revealActiveRow();
  const v = view;
  api(`api/tickets/${chatId}`)
    .then((r) => {
      if (view === v) onTicketUpdate(r.ticket);
    })
    .catch(() => {});
  await mountChat(chatId, ticket, page, !!cached);
  return true;
}
