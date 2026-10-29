// A scheme's page: its side panels and the main panel, and switching between chats.
import { api, app, crumbs, h, isCoordinator, loadEvents, loadPanelState, logout, me, prefetchTopRows, renderUsage, routeSeq, savePanelState, setView, threadHref, usageMeter, view } from './core.js';
import { approvalsEditor, instructionsEditor, machinesPage, projectTitle, pushControls, renderMachinesShelf } from './settings.js';
import { LAST_SCHEME, newTicketForm, openNewScheme, renderSidebar, revealActiveRow, threadSearchBox } from './sidebar.js';
import { artifactBrowser, artifactViewer, renderArtifactHead, renderArtifactResults, renderSharedHead, renderSharedList, renderShelf, sharedList, sharedViewer } from './artifacts.js';
import { chatSection, chatView, mountChat } from './thread.js';
import { propertiesPage, renderSettingsCount } from './properties.js';
import { renderCost } from './cost.js';
import { inboxStrip, refreshInbox } from './inbox.js';
import { schedulesButton, showSchedules } from './schedules.js';

/** Old links address a thread by its global id (#/t/<id>); send them to its project address. */
export async function showTicket(ticketId) {
  const { ticket } = await api(`api/tickets/${ticketId}`);
  if (isCoordinator(ticket) || ticket.number != null) return location.replace(threadHref(ticket));
  await showProject(ticket.project_id, { kind: 'chat', id: ticketId });
}

function renderCrumbs(main) {
  const { project } = view;
  const projectLink = h('a', { href: `#/p/${project.id}`, 'data-project-name': project.id }, project.name);
  const artifactsLink = h('a', { href: `#/p/${project.id}/artifacts` }, 'Artifacts');
  const settingsLink = h('a', { href: `#/p/${project.id}/settings` }, 'Settings');
  crumbs.replaceChildren(...(
    main.kind === 'artifacts' ? [projectLink, ' / ', 'Artifacts']
      : main.kind === 'instructions' ? [projectLink, ' / ', settingsLink, ' / ', 'Instructions']
      : main.kind === 'approvals' ? [projectLink, ' / ', settingsLink, ' / ', 'Needs approval']
      : main.kind === 'properties' ? [projectLink, ' / ', settingsLink, ' / ', 'Properties']
      : main.kind === 'machines' ? [projectLink, ' / ', 'Machines']
      : main.kind === 'artifact' ? [projectLink, ' / ', artifactsLink, ' / ', main.artifact.name]
      : main.kind === 'sharedList' ? [projectLink, ' / ', 'Shared files']
      : main.kind === 'shared' ? [projectLink, ' / ', h('a', { href: `#/p/${project.id}/shared` }, 'Shared files'), ' / ', main.file.name]
        : view.id !== view.coordinator.id ? [projectLink, ' / ', `#${view.ticket.number ?? view.ticket.id}`]
          : [h('span', { 'data-project-name': project.id }, project.name)]));
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
  const [{ project, coordinator, tickets, seen }, artifacts, shared, projects, machines] = await Promise.all([
    api(`api/projects/${projectId}`),
    // An empty shelf beats a broken page if the server is older than this front end.
    api(`api/projects/${projectId}/artifacts`).catch(() => []),
    api(`api/projects/${projectId}/shared`).catch(() => []),
    api('api/projects').catch(() => []),
    api('api/machines').catch(() => []),
  ]);
  let chatId = null;
  if (main.kind === 'chat') {
    chatId = main.id ?? (main.number == null ? coordinator.id : tickets.find((t) => t.number === main.number)?.id);
    if (!chatId) throw new Error(`There is no minion #${main.number} in ${project.name}.`);
  }
  const [{ ticket }, events] = chatId
    ? await Promise.all([api(`api/tickets/${chatId}`), loadEvents(chatId)])
    : [{ ticket: null }, []];
  if (seq !== routeSeq) return; // overtaken by another click while loading
  setView({
    kind: 'project', main: main.kind, projectId, project, coordinator, tickets: new Map(tickets.map((t) => [t.id, t])),
    seen: seen ?? {}, // ticket id -> when you last looked at it (server time)
    artifacts, shared, artifactId: main.artifact?.id ?? null, machines, projects,
    file: main.file ?? null,
    ...chatView(chatId, ticket),
  });
  renderCrumbs(main);
  try { localStorage.setItem(LAST_SCHEME, String(projectId)); } catch {}

  // Both side panels collapse to a slim tab so the main panel can take their room. On wider
  // screens that choice is remembered; on phones they fold away above the main panel instead.
  const narrowQuery = matchMedia('(max-width: 800px)');
  const panelOpen = (name) => !narrowQuery.matches && loadPanelState()[name] !== false;
  // The overview panel: account and usage (standing in for the top bar, which wider screens hide
  // on project pages), the projects, then this project's pinned and recent artifacts.
  const shelf = h('details', { class: 'shelf', open: panelOpen('shelf') },
    h('summary', { title: 'Show or hide the overview' }, projectTitle(project)),
    h('section', { class: 'account' },
      h('div', { class: 'row' }, h('strong', {}, me), h('span', { class: 'spacer' }),
        h('a', { class: 'button secondary settings-link', href: `#/p/${projectId}/settings`, title: 'Instructions, approvals and properties for this scheme' },
          'Settings', h('span', { id: 'settings-count', class: 'count', hidden: true })),
        h('button', { class: 'secondary small', onclick: logout }, 'Sign out')),
      usageMeter(),
      pushControls(project)),
    h('section', { class: 'column' },
      h('h3', {}, 'Schemes'),
      projects.map((p) => h('a', { class: `nav-item${p.id === projectId ? ' active' : ''}`, href: `#/p/${p.id}` },
        h('span', { class: 'name', 'data-project-name': p.id }, p.name))),
      h('button', { type: 'button', class: 'nav-item add', onclick: openNewScheme }, '+ New scheme')),
    h('div', { id: 'machines-shelf' }),
    h('div', { id: 'artifact-shelf' }));
  const sidebar = h('details', { class: 'sidebar', open: panelOpen('threads') },
    h('summary', { title: 'Show or hide minions' }, h('span', { class: 'label' }, 'Minions'), schedulesButton()),
    newTicketForm(projectId),
    inboxStrip(),
    // The coordinator sits above the search so it stays one click away while searching.
    h('div', { id: 'coordinator-row' }),
    threadSearchBox(projectId),
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
    : main.kind === 'approvals' ? approvalsEditor()
    : main.kind === 'properties' ? propertiesPage()
    : main.kind === 'machines' ? machinesPage()
    : main.kind === 'sharedList' ? sharedList()
    : main.kind === 'artifact' ? artifactViewer(main.artifact)
      : main.kind === 'shared' ? sharedViewer(main.file)
        : chatSection(chatId, ticket, events);

  // .panels only becomes a box of its own when both panels are collapsed, so their tabs can share
  // one slim sticky column; otherwise the panels sit directly in the grid.
  app.replaceChildren(h('div', { class: 'split' }, h('div', { class: 'panels' }, shelf, sidebar), section));
  renderUsage();
  renderCost();
  renderSettingsCount();
  renderMachinesShelf();
  renderShelf();
  renderSidebar();
  refreshInbox();
  prefetchTopRows();
  if (main.kind === 'artifacts') renderArtifactResults();
  if (main.kind === 'artifact') renderArtifactHead();
  if (main.kind === 'shared') renderSharedHead();
  if (main.kind === 'sharedList') renderSharedList();
  if (!chatId) return window.scrollTo(0, 0);
  revealActiveRow();
  await mountChat(chatId, ticket, events);
}

/**
 * Show another chat of the project on screen in place of the main panel, fetching only that thread
 * (and only its events not already cached). False when the thread is not one we know of yet.
 */
async function switchChat(main, seq) {
  const chatId = main.id ?? (main.number == null ? view.coordinator.id : [...view.tickets.values()].find((t) => t.number === main.number)?.id);
  if (!chatId) return false;
  const [{ ticket }, events] = await Promise.all([api(`api/tickets/${chatId}`), loadEvents(chatId)]);
  if (seq !== routeSeq) return true; // overtaken by another click while loading
  const { kind, projectId, project, coordinator, tickets, seen, artifacts, shared, showClosed } = view;
  setView({
    kind, main: 'chat', projectId, project, coordinator, tickets, seen, artifacts, shared, showClosed,
    artifactId: null, file: null,
    ...chatView(chatId, ticket),
  });
  if (isCoordinator(ticket)) view.coordinator = ticket;
  else view.tickets.set(ticket.id, ticket);
  renderCrumbs(main);
  document.querySelector('#app .split').lastElementChild.replaceWith(chatSection(chatId, ticket, events));
  // On phones the panels sit above the chat; fold them away as a fresh load would.
  if (matchMedia('(max-width: 800px)').matches) for (const el of document.querySelectorAll('#app .panels > details:not(.as-drawer)')) el.open = false;
  renderShelf();
  renderSidebar();
  revealActiveRow();
  await mountChat(chatId, ticket, events);
  return true;
}
