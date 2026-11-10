// A scheme's page: its side panels and the main panel, and switching between chats.
import { account, api, h, isCoordinator, loadPanelState, me, savePanelState, schemeIcon, setView, threadHref, view } from './base.js';
import { app, crumbs, loadEvents, logout, prefetchTopRows, renderUsage, routeSeq, usageMeter } from './core.js';
import { appInstructionsEditor, approvalsEditor, instructionsEditor, machinesPage, projectTitle, pushControls, renderGithubStrip, renderMachineWarning } from './settings.js';
import { LAST_SCHEME, newTicketForm, renderSidebar, revealActiveRow, threadSearchBox } from './sidebar.js';
import { artifactBrowser, artifactViewer, renderArtifactHead, renderArtifactResults, renderSharedHead, renderSharedList, renderShelf, sharedList, sharedViewer } from './artifacts.js';
import { chatSection, chatView, mountChat } from './thread.js';
import { propertiesPage, renderSettingsCount } from './properties.js';
import { renderCost } from './cost.js';
import { forgetOtherSchemes, inboxStrip, refreshInbox } from './inbox.js';
import { renderHiddenNote, renderSchemesShelf } from './hidden.js';
import { schedulesButton, showSchedules } from './schedules.js';
import { replaceHash } from './navstack.js';
import { accountPage, membersPage, peoplePage } from './people.js';
import { contraptionsPage } from './contraptions.js';

/** Old links address a thread by its global id (#/t/<id>); send them to its project address. */
export async function showTicket(ticketId) {
  const { ticket } = await api(`api/tickets/${ticketId}`);
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
  const [{ project, coordinator, tickets, seen, person_notes, pins }, artifacts, shared, projects, machines] = await Promise.all([
    api(`api/projects/${projectId}`),
    // An empty shelf beats a broken page if the server is older than this front end.
    api(`api/projects/${projectId}/artifacts`).catch(() => []),
    api(`api/projects/${projectId}/shared`).catch(() => []),
    api('api/projects').catch(() => []),
    // Each person's own machines; an admin's list has every machine (#306).
    api('api/machines').catch(() => []),
  ]);
  let chatId = null;
  if (main.kind === 'chat') {
    chatId = main.id ?? (main.number == null ? coordinator.id : tickets.find((t) => t.number === main.number)?.id);
    if (!chatId) throw new Error(`There is no minion #${main.number} in ${project.name}.`);
  }
  const [{ ticket }, page] = chatId
    ? await Promise.all([api(`api/tickets/${chatId}`), loadEvents(chatId)])
    : [{ ticket: null }, null];
  if (seq !== routeSeq) return; // overtaken by another click while loading
  forgetOtherSchemes();
  setView({
    kind: 'project', main: main.kind, projectId, project, coordinator, tickets: new Map(tickets.map((t) => [t.id, t])),
    seen: seen ?? {}, // ticket id -> when you last looked at it (server time)
    personNotes: person_notes ?? {}, // ticket id -> people's note on it { text, by, at } (#146)
    pins: pins ?? [], // ticket ids you pinned, oldest pin first (#179)
    artifacts, shared, artifactId: main.artifact?.id ?? null, machines, projects,
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
  await mountChat(chatId, ticket, page);
}

/**
 * Show another chat of the project on screen in place of the main panel, fetching only that thread
 * (and only its events not already cached). False when the thread is not one we know of yet.
 */
async function switchChat(main, seq) {
  const chatId = main.id ?? (main.number == null ? view.coordinator.id : [...view.tickets.values()].find((t) => t.number === main.number)?.id);
  if (!chatId) return false;
  const [{ ticket }, page] = await Promise.all([api(`api/tickets/${chatId}`), loadEvents(chatId)]);
  if (seq !== routeSeq) return true; // overtaken by another click while loading
  const { kind, projectId, project, coordinator, tickets, seen, personNotes, pins, artifacts, shared, showClosed, machines, projects } = view;
  setView({
    kind, main: 'chat', projectId, project, coordinator, tickets, seen, personNotes, pins, artifacts, shared, showClosed, machines, projects,
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
  await mountChat(chatId, ticket, page);
  return true;
}
