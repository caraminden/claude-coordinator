// A scheme's page: its side panels and the main panel, and switching between chats.
import { account, api, h, isCoordinator, loadPanelState, me, savePanelState, schemeIcon, setView, threadHref, view } from './base.js';
import { app, cachedEvents, crumbs, loadEvents, logout, onTicketUpdate, prefetchTopRows, renderUsage, routeSeq, usageMeter } from './core.js';
import { appInstructionsEditor, approvalsEditor, instructionsEditor, machinesPage, projectTitle, pushControls, renderGithubStrip, renderMachineWarning } from './settings.js';
import { LAST_SCHEME, newTicketForm, renderSidebar, revealActiveRow, threadSearchBox } from './sidebar.js';
import { artifactBrowser, artifactViewer, renderArtifactHead, setArtifacts, renderArtifactResults, renderSharedHead, renderSharedList, renderShelf, sharedList, sharedViewer } from './artifacts.js';
import { chatSection, chatView, mountChat, renderTicketHead } from './thread.js';
import { propertiesPage, renderSettingsCount } from './properties.js';
import { renderCost } from './cost.js';
import { forgetOtherSchemes, inboxStrip, refreshInbox } from './inbox.js';
import { refreshSchemes, renderHiddenNote, renderSchemesShelf } from './hidden.js';
import { schedulesButton, showSchedules } from './schedules.js';
import { replaceHash } from './navstack.js';
import { accountPage, membersPage, peoplePage } from './people.js';
import { contraptionsPage } from './contraptions.js';
import { toast } from './ui/status.js';

/** Old links address a thread by its global id (#/t/<id>); send them to its project address. */
export async function showTicket(ticketId) {
  const seq = routeSeq;
  const { ticket } = await api(`api/tickets/${ticketId}`);
  if (seq !== routeSeq) return; // overtaken by another click while loading
  if (isCoordinator(ticket) || ticket.number != null) return replaceHash(threadHref(ticket));
  await showProject(ticket.project_id, { kind: 'chat', id: ticketId });
}

function renderCrumbs(main) {
  const { project } = view;
  // The scheme list's row carries the icon's version; the scheme's own doesn't.
  const icon = () => schemeIcon(view.projects?.find((p) => p.id === project.id) ?? project);
  const projectLink = h('a', { href: `#/p/${project.id}`, class: 'scheme-crumb' }, icon(), h('span', { 'data-project-name': project.id }, project.name));
  const artifactsLink = h('a', { href: `#/p/${project.id}/artifacts` }, 'Artifacts');
  const settingsLink = h('a', { href: `#/p/${project.id}/settings` }, 'Settings');
  crumbs.replaceChildren(...(
    main.kind === 'artifacts' ? [projectLink, ' / ', 'Artifacts']
      : main.kind === 'instructions' ? [projectLink, ' / ', settingsLink, ' / ', 'Instructions']
      : main.kind === 'app-instructions' ? [projectLink, ' / ', settingsLink, ' / ', 'Citadel-wide instructions']
      : main.kind === 'approvals' ? [projectLink, ' / ', settingsLink, ' / ', 'Needs approval']
      : main.kind === 'properties' ? [projectLink, ' / ', settingsLink, ' / ', 'Properties']
      : main.kind === 'members' ? [projectLink, ' / ', settingsLink, ' / ', 'Members']
      : main.kind === 'people' ? [projectLink, ' / ', settingsLink, ' / ', 'People']
      : main.kind === 'contraptions' ? [projectLink, ' / ', settingsLink, ' / ', 'Contraptions']
      : main.kind === 'account' ? [projectLink, ' / ', settingsLink, ' / ', 'Your account']
      : main.kind === 'machines' ? [projectLink, ' / ', settingsLink, ' / ', 'Machines']
      : main.kind === 'artifact' ? [projectLink, ' / ', artifactsLink, ' / ', main.artifact.name]
      : main.kind === 'sharedList' ? [projectLink, ' / ', 'Shared files']
      : main.kind === 'shared' ? [projectLink, ' / ', h('a', { href: `#/p/${project.id}/shared` }, 'Shared files'), ' / ', main.file.name]
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
  if (main.kind === 'chat' && view?.kind === 'project' && view.projectId === projectId && document.getElementById('threads')) {
    if (await switchChat(main, seq)) return;
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
  const [{ project, coordinator, tickets: open, dismissed, seen, person_notes, pins }, artifacts, shared, projects, machines] = stale
    ? [{ ...stale, dismissed: 0, person_notes: stale.personNotes }, stale.artifacts, stale.shared, known, stale.machines]
    : await Promise.all([
    // The dismissed minions come behind the first paint (loadDismissed): most of a big scheme's payload (#538).
    api(`api/projects/${projectId}?tickets=open`),
    // An empty shelf beats a broken page if the server is older than this front end.
    api(`api/projects/${projectId}/artifacts`).catch(() => []),
    api(`api/projects/${projectId}/shared`).catch(() => []),
    // A failed fetch keeps the list already shown and tries again below, rather than blanking it (#491).
    known ?? api('api/projects').catch(() => null),
    // Each person's own machines; an admin's list has every machine (#306).
    api('api/machines').catch(() => []),
  ]);
  let tickets = open;
  // A link to a dismissed minion waits for the dismissed list; any other open draws without it.
  const findClosed = main.kind === 'chat' && main.number != null && dismissed && !open.some((t) => t.number === main.number);
  if (findClosed) tickets = open.concat((await api(`api/projects/${projectId}?tickets=closed`)).tickets);
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
  const guessed = chatId && chatId === early;
  const cached = guessed ? earlyCached : chatId ? cachedEvents(chatId) : null;
  const page = cached?.page ?? (guessed ? await earlyPage : null) ?? (chatId ? await loadEvents(chatId) : null);
  if (seq !== routeSeq) return; // overtaken by another click while loading
  forgetOtherSchemes();
  setView({
    kind: 'project', main: main.kind, projectId, project, coordinator, tickets: new Map(tickets.map((t) => [t.id, t])),
    seen: seen ?? {}, // ticket id -> when you last looked at it (server time)
    personNotes: person_notes ?? {}, // ticket id -> people's note on it { text, by, at } (#146)
    pins: pins ?? [], // ticket ids you pinned, oldest pin first (#179)
    artifacts, shared, artifactId: main.artifact?.id ?? null, machines, projects: projects ?? view?.projects ?? [],
    file: main.file ?? null,
    ...chatView(chatId, ticket),
  });
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
      h('div', { class: 'row' }, h('strong', {}, me), h('span', { class: 'spacer' }),
        h('a', { class: 'button secondary settings-link', href: `#/p/${projectId}/settings`, title: 'Instructions, approvals, properties and machines for this scheme' },
          'Settings', h('span', { id: 'settings-count', class: 'count', hidden: true })),
        h('button', { class: 'secondary small', onclick: logout }, 'Sign out')),
      usageMeter(),
      pushControls(project),
      // Only while a machine this scheme's minions get needs a fix or is down (#437).
      h('div', { id: 'machine-warning', class: 'machine-warning', hidden: true })),
    h('section', { class: 'column', id: 'schemes-shelf' }),
    h('div', { id: 'artifact-shelf' }));
  const sidebar = h('details', { class: 'sidebar', open: panelOpen('threads') },
    h('summary', { title: 'Show or hide minions' }, h('span', { class: 'label' }, 'Minions'), schedulesButton()),
    newTicketForm(projectId),
    h('div', { id: 'github-strip', class: 'github-strip', hidden: true }),
    h('div', { id: 'hidden-note', class: 'hidden-note', hidden: true }),
    inboxStrip(),
    // The coordinator sits above the search so it stays one click away while searching.
    h('div', { id: 'coordinator-row' }),
    threadSearchBox(projectId),
    h('div', { id: 'saved-views', class: 'saved-views' }),
    h('div', { id: 'prop-filter', class: 'prop-filter' }),
    h('div', { id: 'threads' }),
    h('div', { class: 'schedules-pane' }));
  showSchedules(sidebar);
  // Don't hide a half-written new thread behind a collapsed sidebar.
  if (sidebar.querySelector('.new-thread textarea').value) sidebar.open = true;
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
  const section = main.kind === 'artifacts' ? artifactBrowser()
    : main.kind === 'instructions' ? instructionsEditor()
    : main.kind === 'app-instructions' ? appInstructionsEditor()
    : main.kind === 'approvals' ? approvalsEditor()
    : main.kind === 'properties' ? propertiesPage()
    : main.kind === 'members' ? membersPage()
    : main.kind === 'people' ? peoplePage()
    : main.kind === 'contraptions' ? contraptionsPage()
    : main.kind === 'account' ? accountPage()
    : main.kind === 'machines' ? machinesPage()
    : main.kind === 'sharedList' ? sharedList()
    : main.kind === 'artifact' ? artifactViewer(main.artifact)
      : main.kind === 'shared' ? sharedViewer(main.file)
        : chatSection(chatId, ticket);

  // .panels only becomes a box of its own when both panels are collapsed, so their tabs can share
  // one slim sticky column; otherwise the panels sit directly in the grid.
  app.replaceChildren(h('div', { class: 'split' }, h('div', { class: 'panels' }, shelf, sidebar), section));
  renderUsage();
  renderCost();
  renderSettingsCount();
  renderShelf();
  renderSidebar();
  renderGithubStrip();
  renderSchemesShelf();
  if (!projects || known) refreshSchemes();
  // The recap waits on it: it lists minions dismissed while you were away.
  if (stale) view.dismissedLoad = refreshScheme(projectId);
  else if (!findClosed && dismissed) view.dismissedLoad = loadDismissed(projectId);
  renderMachineWarning();
  renderHiddenNote();
  refreshInbox();
  prefetchTopRows();
  if (main.kind === 'artifacts') renderArtifactResults();
  if (main.kind === 'artifact') renderArtifactHead();
  if (main.kind === 'shared') renderSharedHead();
  if (main.kind === 'sharedList') renderSharedList();
  if (!chatId) return window.scrollTo(0, 0);
  revealActiveRow();
  await mountChat(chatId, ticket, page, cached?.fresh);
}

// The schemes you've left this session, each as you left it, most recent last (#538).
const schemeCache = new Map();
const SCHEME_CACHE = 6;

function rememberScheme() {
  if (view?.kind !== 'project' || !view.tickets) return;
  const { projectId, project, coordinator, tickets, seen, personNotes, pins, artifacts, shared, machines } = view;
  schemeCache.delete(projectId);
  schemeCache.set(projectId, { project, coordinator, tickets: [...tickets.values()], seen, personNotes, pins, artifacts, shared, machines });
  if (schemeCache.size > SCHEME_CACHE) schemeCache.delete(schemeCache.keys().next().value);
}

/** Signing out: the next person mustn't see this one's schemes drawn, even for a moment. */
export function forgetSchemes() {
  schemeCache.clear();
}

/**
 * Bring a scheme drawn from its last payload up to date in place (#538), with a ring by "Minions" meanwhile,
 * then fetch its dismissed minions. A failed fetch (a restart's gap) tries again, backing off to 30 s.
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
  const [{ project, coordinator, tickets: open, seen, person_notes, pins }, artifacts, shared, machines] = got;
  const now = new Set(open.map((t) => t.id));
  // Dismissed since you left: gone until the dismissed list below brings it back as it is now.
  for (const [id, t] of list) if (t.status !== 'closed' && !now.has(id) && before.get(id) === t) list.delete(id);
  for (const t of open) if (!(list.get(t.id)?.updated_at > t.updated_at)) list.set(t.id, t);
  if (!(view.coordinator.updated_at > coordinator.updated_at)) view.coordinator = coordinator;
  Object.assign(view, { project, seen: seen ?? view.seen, personNotes: person_notes ?? view.personNotes, pins: pins ?? view.pins, machines });
  headUp();
  renderSidebar();
  setArtifacts(artifacts, shared);
  renderGithubStrip();
  renderMachineWarning();
  renderHiddenNote();
  await loadDismissed(projectId);
  if (view?.kind === 'project') headUp();
}

/**
 * Fetch a scheme's dismissed minions behind its first paint and add them to the list (#538); a newer load of
 * the list wins. A failed fetch (a restart's gap) tries again, backing off to 30 s, as refreshSchemes does.
 */
async function loadDismissed(projectId) {
  const list = view.tickets;
  let closed = null;
  for (let wait = 1000; !closed; wait = Math.min(30_000, wait * 2)) {
    closed = await api(`api/projects/${projectId}?tickets=closed`).then((r) => r.tickets, () => null);
    if (view?.kind !== 'project' || view.tickets !== list) return;
    if (!closed) await new Promise((r) => setTimeout(r, wait));
  }
  // The stream may have brought a fresher copy meanwhile (one reopened, say): that one stays.
  for (const t of closed) if (!list.has(t.id)) list.set(t.id, t);
  renderSidebar();
}

/**
 * Show another chat of the project on screen in place of the main panel, fetching only that thread
 * (and only its events not already cached). False when the thread is not one we know of yet.
 */
async function switchChat(main, seq) {
  const chatId = main.id ?? (main.number == null ? view.coordinator.id : [...view.tickets.values()].find((t) => t.number === main.number)?.id);
  if (!chatId) return false;
  // The list already has the minion, kept current by the stream: draw the chat from it at once, with the
  // cached history when there is one, and fetch behind it (#527). Only a history not yet downloaded waits.
  const ticket = chatId === view.coordinator.id ? view.coordinator : view.tickets.get(chatId);
  if (!ticket) return false; // a dismissed one before the dismissed list has come (#538): the full load finds it
  const cached = cachedEvents(chatId);
  const page = cached?.page ?? await loadEvents(chatId);
  if (seq !== routeSeq) return true; // overtaken by another click while loading
  const { kind, projectId, project, coordinator, tickets, dismissedLoad, seen, personNotes, pins, artifacts, shared, showClosed, machines, projects } = view;
  setView({
    kind, main: 'chat', projectId, project, coordinator, tickets, dismissedLoad, seen, personNotes, pins, artifacts, shared, showClosed, machines, projects,
    artifactId: null, file: null,
    ...chatView(chatId, ticket),
  });
  if (isCoordinator(ticket)) view.coordinator = ticket;
  else view.tickets.set(ticket.id, ticket);
  renderCrumbs(main);
  document.querySelector('#app .split').lastElementChild.replaceWith(chatSection(chatId, ticket));
  // On phones the panels sit above the chat; collapse them away as a fresh load would.
  if (matchMedia('(max-width: 800px)').matches) for (const el of document.querySelectorAll('#app .panels > details:not(.citadel-drawer)')) el.open = false;
  renderShelf();
  renderSidebar();
  revealActiveRow();
  const v = view;
  api(`api/tickets/${chatId}`).then((r) => { if (view === v) onTicketUpdate(r.ticket); }).catch(() => {});
  await mountChat(chatId, ticket, page, cached?.fresh);
  return true;
}
