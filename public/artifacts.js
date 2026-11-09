// Artifacts and files: the shelf, the browser, and viewers for artifacts and linked or shared files.
import { ago, api, baseName, fileExt, fileKind, fileUrl, fileHref, followChat, formatSize, h, icon, isCoordinator, isLocalPath, joinPath, loadPanelState, markdownDoc, me, reloadWhenIdle, routeSeq, savePanelState, scrollToBottom, sending, setSending, sharedHref, sharedUrl, shortPath, taskmasterName, threadHref, threadLabel, view } from './core.js';
import { addBriefButtons } from './briefstart.js';
import { attachBridge, openWithBridge } from './bridge-host.js';
import { loadDraft, saveDraft } from './composer.js';
import { showProject } from './project.js';
import { replaceHash } from './navstack.js';
import { continueList } from './ui/composer.js';
import { optimistic } from './ui/optimistic.js';

/** A file a thread linked in its reply, shown full screen over its chat, which stays beside it. */
export async function showFile(ticketId, path) {
  const seq = routeSeq;
  const [{ ticket }, file] = await Promise.all([
    api(`api/tickets/${ticketId}`),
    // A file that has gone (or never could be shown) still opens the view, saying so.
    api(`api/tickets/${ticketId}/file?info&path=${encodeURIComponent(path)}`).catch((err) => ({
      missing: err.message, name: baseName(path), kind: fileKind(path) ?? 'text', display_path: shortPath(path),
    })),
  ]);
  if (seq !== routeSeq) return;
  // Opened from its own chat, the chat stays as it is and closing comes straight back to it.
  const inPlace = view?.kind === 'project' && view.main === 'chat' && view.id === ticketId && !!document.getElementById('log');
  if (!inPlace) {
    closeViewer();
    await showProject(ticket.project_id, { kind: 'chat', id: ticketId });
    if (seq !== routeSeq) return;
  }
  openViewer(ticket, { ...file, path }, inPlace);
}

/** A file in the project's shared folder, opened from the Shared group of the artifacts panel. */
export async function showSharedFile(projectId, path) {
  const file = await api(`api/projects/${projectId}/shared/file?info&path=${encodeURIComponent(path)}`).catch((err) => ({
    missing: err.message, name: baseName(path), kind: fileKind(path) ?? 'text', display_path: `scheme shared/${path}`,
  }));
  await showProject(projectId, { kind: 'shared', file: { ...file, path } });
}

export async function showArtifact(artifactId) {
  const { artifact } = await api(`api/artifacts/${artifactId}`);
  await showProject(artifact.project_id, { kind: 'artifact', artifact });
}

// ---------- artifacts ----------

const RECENT_ARTIFACTS = 5;
const MAX_TEXT_PREVIEW = 2 * 1024 * 1024;
const ARTIFACT_FILTERS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'pinned', label: 'Pinned', match: (a) => !!a.pinned_at },
  { key: 'docs', label: 'Documents', match: (a) => a.kind === 'markdown' || a.kind === 'pdf' },
  { key: 'web', label: 'Web pages', match: (a) => a.kind === 'html' },
  { key: 'canvas', label: 'Canvases', match: (a) => a.kind === 'canvas' },
  { key: 'downloads', label: 'Downloads', match: (a) => a.kind === 'download' },
];

const rawUrl = (a) => `api/artifacts/${a.id}/raw?v=${a.mtime}`;
const extOf = (a) => (a.name.includes('.') ? a.name.split('.').pop() : a.kind).slice(0, 5).toUpperCase();
const artifactThread = (a) => ({ id: a.ticket_id, kind: a.ticket_kind, project_id: a.project_id, number: a.ticket_number, title: a.ticket_title });
const threadName = (a) => threadLabel(artifactThread(a));

let artifactRefresh = null;
export function onArtifactsChanged(projectId) {
  if (view?.kind !== 'project' || view.projectId !== projectId) return;
  // Scans of several tickets can land together; fetch once for the lot.
  clearTimeout(artifactRefresh);
  artifactRefresh = setTimeout(refreshArtifacts, 300);
}

async function refreshArtifacts() {
  if (view?.kind !== 'project') return;
  const projectId = view.projectId;
  try {
    const [artifacts, shared] = await Promise.all([
      api(`api/projects/${projectId}/artifacts`),
      api(`api/projects/${projectId}/shared`).catch(() => []),
    ]);
    if (view?.kind === 'project' && view.projectId === projectId) setArtifacts(artifacts, shared);
  } catch {}
}

export function setArtifacts(artifacts, shared = view.shared) {
  view.artifacts = artifacts;
  view.shared = shared;
  renderShelf();
  if (view.main === 'artifacts') renderArtifactResults();
  if (view.main === 'artifact') renderArtifactHead();
  renderViewerBar();
  if (view.main === 'sharedList') renderSharedList();
  if (view.main === 'shared') renderSharedHead();
}

/** Pin or unpin an artifact, or a shared-folder file (which has no id, only its path). */
function setPinned(a, pinned) {
  const was = { pinned_at: a.pinned_at, pinned_by: a.pinned_by };
  const show = (pin) => {
    Object.assign(a, pin);
    setArtifacts(view.artifacts, view.shared);
  };
  const projectId = view.projectId;
  optimistic({
    sets: `artifact-pin:${a.id ?? a.path}`,
    apply: () => show(pinned ? { pinned_at: Date.now(), pinned_by: me } : { pinned_at: null, pinned_by: null }),
    send: () => (a.id
      ? api(`api/artifacts/${a.id}/pin`, { method: 'POST', body: { pinned } })
      : api(`api/projects/${projectId}/shared/pin`, { method: 'POST', body: { path: a.path, pinned } })),
    undo: () => !!a.pinned_at === pinned && show(was), // unless something else changed it since
    label: `${pinned ? 'pin' : 'unpin'} ${a.name}`,
  }).then(() => refreshArtifacts(), () => {}); // a failure already said so in its toast
}

function pinButton(a) {
  const pinned = !!a.pinned_at;
  return h('button', {
    type: 'button',
    class: `pin${pinned ? ' on' : ''}`,
    title: pinned ? `Pinned by ${a.pinned_by}; click to unpin` : 'Pin to the top of the artifacts panel',
    'aria-pressed': String(pinned),
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPinned(a, !pinned);
    },
  }, pinned ? '★' : '☆');
}

/** The far-left panel: pinned artifacts, then the most recent ones from any thread. */
export function renderShelf() {
  const el = document.getElementById('artifact-shelf');
  if (!el) return;
  const all = view.artifacts;
  // Pinned shared-folder files sit with pinned artifacts; they have no id.
  const pinned = [...all, ...(view.shared ?? [])].filter((a) => a.pinned_at).sort((a, b) => b.pinned_at - a.pinned_at);
  const recent = all.filter((a) => !a.pinned_at && !a.missing).slice(0, RECENT_ARTIFACTS);
  const item = (a) => h('a', {
    class: `artifact-item${(a.id ? view.artifactId === a.id : view.main === 'shared' && view.file?.path === a.path) ? ' active' : ''}${a.missing ? ' missing' : ''}`,
    href: a.id ? `#/a/${a.id}` : sharedHref(view.projectId, a.path), title: a.display_path ?? a.path,
  },
    h('span', { class: `badge k-${a.kind}` }, extOf(a)),
    h('span', { class: 'text' },
      h('span', { class: 'name' }, a.name),
      h('span', { class: 'meta' }, `${!a.id ? 'Shared' : a.ticket_kind === 'coordinator' ? taskmasterName() : `#${a.ticket_number ?? a.ticket_id}`} · ${a.missing ? 'missing' : ago(a.mtime)}`)));
  const sub = (title, count, items, empty, render = item) => h('div', { class: 'sub' },
    h('h4', {}, title, count ? h('span', { class: 'count' }, count) : ''),
    items.length ? items.map(render) : h('p', { class: 'muted small' }, empty));
  // Recent starts collapsed; opening it is remembered with the panels' own open state.
  const recentFold = h('details', { class: 'sub fold', open: loadPanelState().recent === true },
    h('summary', {}, 'Recent', recent.length ? h('span', { class: 'count' }, recent.length) : ''),
    recent.length ? recent.map(item) : h('p', { class: 'muted small' }, 'Documents, pages and canvases that minions create show up here.'));
  recentFold.addEventListener('toggle', () => savePanelState({ ...loadPanelState(), recent: recentFold.open }));
  el.replaceChildren(h('section', { class: 'column' },
    h('h3', {}, 'Artifacts', h('span', { class: 'spacer' }),
      h('a', { class: `browse${view.main === 'artifacts' ? ' active' : ''}`, href: `#/p/${view.projectId}/artifacts`, title: `Browse all ${all.length} artifacts` }, 'Browse')),
    sub('Pinned', pinned.length, pinned, 'Pin artifacts with ☆ to keep them here.'),
    recentFold,
    // The shared folder gets one link, not a list: its files are listed on their own page.
    h('a', { class: `shared-link${view.main === 'sharedList' ? ' active' : ''}`, href: `#/p/${view.projectId}/shared`, title: 'Handoffs and notes in the scheme\'s shared folder' }, 'Shared files')));
}

/** Main panel: every document and page in the project's shared folder, newest first. */
export function sharedList() {
  return h('section', { class: 'artifacts-main' },
    h('div', { class: 'ticket-head' }, h('div', { class: 'row' }, h('h2', {}, 'Shared files'), h('span', { class: 'muted', id: 'shared-summary' }))),
    h('div', { class: 'shared-list', id: 'shared-results' }));
}

export function renderSharedList() {
  const el = document.getElementById('shared-results');
  if (!el) return;
  document.getElementById('shared-summary').textContent = `${view.shared.filter((f) => !f.missing).length} in the scheme's shared folder`;
  el.replaceChildren(...(view.shared.length ? view.shared.map(sharedItem) : [h('p', { class: 'muted' }, 'Handoffs and notes minions put in the scheme\'s shared folder show up here.')]));
}

/** A document or page in the project's shared folder, as a row of the Shared files list. */
function sharedItem(f) {
  const when = f.missing ? 'missing' : ago(f.mtime);
  return h('a', { class: `artifact-item${view.main === 'shared' && view.file?.path === f.path ? ' active' : ''}${f.missing ? ' missing' : ''}`, href: sharedHref(view.projectId, f.path), title: f.display_path },
    h('span', { class: `badge k-${f.kind}` }, extOf(f)),
    h('span', { class: 'text' },
      h('span', { class: 'name' }, f.name),
      h('span', { class: 'meta' }, f.path.includes('/') ? `${f.path.slice(0, f.path.lastIndexOf('/'))} · ${when}` : when)),
    pinButton(f));
}

/** Main panel: every artifact in the project, searchable, with pin toggles. */
export function artifactBrowser() {
  view.artifactFilter = 'all';
  const search = h('input', { type: 'search', id: 'artifact-search', placeholder: 'Search by name, folder or minion…', autocomplete: 'off' });
  search.addEventListener('input', renderArtifactResults);
  const chips = h('div', { class: 'chips', id: 'artifact-filters' });
  const section = h('section', { class: 'artifacts-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, h('h2', {}, 'Artifacts'), h('span', { class: 'muted', id: 'artifact-summary' })),
      search, chips),
    h('div', { class: 'artifact-grid', id: 'artifact-results' }));
  setTimeout(() => search.focus());
  return section;
}

export function renderArtifactResults() {
  const el = document.getElementById('artifact-results');
  if (!el) return;
  const terms = document.getElementById('artifact-search').value.toLowerCase().split(/\s+/).filter(Boolean);
  const filter = ARTIFACT_FILTERS.find((f) => f.key === view.artifactFilter) ?? ARTIFACT_FILTERS[0];
  document.getElementById('artifact-filters').replaceChildren(...ARTIFACT_FILTERS.map((f) => {
    const n = view.artifacts.filter(f.match).length;
    if (!n && f.key !== 'all' && f.key !== view.artifactFilter) return '';
    return h('button', { type: 'button', class: `chip${f === filter ? ' on' : ''}`, onclick: () => {
      view.artifactFilter = f.key;
      renderArtifactResults();
    } }, f.label, h('span', { class: 'count' }, n));
  }));
  const results = view.artifacts.filter((a) => {
    if (!filter.match(a)) return false;
    const hay = `${a.display_path ?? a.path} ${threadName(a)} ${a.kind}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  document.getElementById('artifact-summary').textContent =
    `${results.length === view.artifacts.length ? '' : `${results.length} of `}${view.artifacts.length} file${view.artifacts.length === 1 ? '' : 's'}`;
  if (!results.length) {
    el.replaceChildren(h('p', { class: 'muted' }, view.artifacts.length
      ? 'Nothing matches.'
      : 'No artifacts yet. When minions create documents, web pages or canvases in their folders, they appear here.'));
    return;
  }
  el.replaceChildren(...results.map((a) => {
    const shown = a.display_path ?? a.path;
    const dir = shown.includes('/') ? shown.slice(0, shown.lastIndexOf('/') + 1) : '';
    return h('a', { class: `artifact-card${a.missing ? ' missing' : ''}`, href: `#/a/${a.id}`, title: shown },
      h('div', { class: 'preview' }, h('span', { class: `badge big k-${a.kind}` }, extOf(a))),
      pinButton(a),
      h('div', { class: 'name' }, a.name),
      dir ? h('div', { class: 'meta path' }, dir) : '',
      h('div', { class: 'meta' }, threadName(a)),
      h('div', { class: 'meta' }, a.missing ? 'File no longer exists' : `${formatSize(a.size)} · ${ago(a.mtime)}`));
  }));
}

// What a page's bridge says the viewer opened: a file a chat linked, or a file in the scheme's shared folder.
const viewerBridge = (ticket, file) => ({ open: { ticket: ticket.id, path: file.path }, owner: threadLabel(ticket) });
const sharedBridge = (file) => ({ open: { project: view.projectId, path: file.path }, owner: null });

/**
 * The Open button. An HTML page opens in a tab that keeps its bridge to this one, so the page can still
 * save and send (#417); a modified click, or a browser that blocks the tab, follows the plain link.
 */
function openButton(src, file, bridge) {
  const link = h('a', { class: 'button secondary', href: src, target: '_blank', rel: 'noopener' }, 'Open');
  if (file.kind === 'html') {
    link.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (openWithBridge(src, { ...bridge, name: file.name }, api)) e.preventDefault();
    });
  }
  return link;
}

/** Main panel: one artifact, shown inline according to its type. */
export function artifactViewer(a) {
  const body = h('div', { class: 'artifact-body' });
  const section = h('section', { class: 'artifacts-main' }, h('div', { class: 'ticket-head', id: 'artifact-head' }), body);
  if (a.missing) {
    body.append(h('p', { class: 'muted' }, 'This file is no longer in the minion\'s folder. Unpin it to remove it from the list.'));
  } else {
    const comment = commentBox(artifactThread(a), a.path, a.name, body);
    const bridge = { open: { artifact: a.id }, owner: threadName(a) };
    renderFileBody(body, { ...a, src: rawUrl(a), ticketId: a.ticket_id, brief: { projectId: a.project_id, path: a.abs ?? a.path, name: a.name }, bridge });
    section.append(comment);
  }
  return section;
}

// The open full-screen viewer: the chat section lives inside it until it closes.
let viewer = null; // { dialog, stage, bar, chat, placeholder, ticket, file, inPlace, scrollY }

/**
 * Show a file a chat linked full screen: the file as big as it fits, and the chat itself (moved,
 * so it stays live and keeps its draft) in a compact column beside it, with nothing else.
 */
function openViewer(ticket, file, inPlace) {
  if (!viewer) {
    const chat = document.querySelector('#app .chat');
    if (!chat) return;
    const placeholder = document.createComment('chat');
    const scrollY = window.scrollY;
    const stage = h('div', { class: 'viewer-stage' });
    const bar = h('div', { class: 'viewer-bar' });
    chat.replaceWith(placeholder);
    const dialog = h('dialog', { class: 'viewer', 'aria-label': file.name }, h('div', { class: 'viewer-file' }, bar, stage), chat);
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      leaveViewer();
    });
    // Browsers may close a dialog past a refused cancel (Esc pressed twice); still go back properly.
    dialog.addEventListener('close', () => { if (viewer?.dialog === dialog) leaveViewer(); });
    // Another file from the chat swaps in place, so closing still goes straight back to the chat.
    dialog.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[href^="#/f/"]');
      if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      replaceHash(a.getAttribute('href'));
    });
    document.body.append(dialog);
    dialog.showModal();
    viewer = { dialog, stage, bar, chat, placeholder, inPlace, scrollY };
    // Keep the clicked embed in sight in the narrower chat, unless you were following the end.
    const link = [...chat.querySelectorAll('#log a[href]')].reverse().find((a) => a.getAttribute('href') === location.hash);
    if (followChat || !link) scrollToBottom();
    else link.scrollIntoView({ block: 'center' });
  }
  Object.assign(viewer, { ticket, file });
  viewer.dialog.setAttribute('aria-label', file.name);
  viewer.stage.className = `viewer-stage k-${file.kind}`;
  viewer.stage.replaceChildren();
  if (file.missing) viewer.stage.append(h('p', { class: 'muted' }, `${file.missing}.`));
  else {
    // A page's Send goes to the chat beside it.
    const bridge = viewerBridge(ticket, file);
    renderFileBody(viewer.stage, { ...file, src: `${fileUrl(ticket.id, file.path)}&v=${file.mtime}`, ticketId: ticket.id, brief: { projectId: ticket.project_id, path: file.abs ?? file.display_path, name: file.name }, bridge });
  }
  renderViewerBar();
}

/** Put the chat back where it was and drop the viewer. The chat's address it was over, or null. */
export function closeViewer() {
  if (!viewer) return null;
  const { dialog, chat, placeholder, ticket, scrollY } = viewer;
  const follow = followChat;
  viewer = null;
  placeholder.replaceWith(chat);
  // Gone once its close event has been out on the page, which puts the caret back in the chat's box (ui/composer.js).
  if (dialog.open) {
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.close();
  } else dialog.remove();
  if (follow) scrollToBottom();
  else window.scrollTo(0, scrollY);
  return threadHref(ticket);
}

/** × or Esc: back to the chat, as the browser's back button would when it was opened from there. */
function leaveViewer() {
  if (viewer.inPlace) history.back();
  else replaceHash(threadHref(viewer.ticket));
}

function renderViewerBar() {
  if (!viewer) return;
  const { file, ticket: t } = viewer;
  // A file that is also an artifact can be pinned; keep its pin state live.
  const a = file.artifact && (view.artifacts.find((x) => x.id === file.artifact.id) ?? file.artifact);
  const src = `${fileUrl(t.id, file.path)}&v=${file.mtime}`;
  viewer.bar.replaceChildren(
    h('span', { class: `badge k-${file.kind}` }, fileExt(file.name)),
    h('div', { class: 'name' }, h('h2', { title: file.display_path }, file.name),
      h('span', { class: 'meta' }, file.missing ? 'not found' : `${formatSize(file.size)} · updated ${ago(file.mtime)}`)),
    a ? pinButton(a) : '',
    file.missing || file.kind !== 'html' ? '' : fullScreenButton(() => viewer?.stage),
    file.missing ? '' : openButton(src, file, viewerBridge(t, file)),
    file.missing ? '' : h('a', { class: 'button secondary wide-only', href: `${src}&download` }, 'Download'),
    h('button', { type: 'button', class: 'close-view', title: 'Back to the chat', 'aria-label': 'Back to the chat', onclick: leaveViewer }, icon('close')));
}

/**
 * Under a file's view: a comment that goes to the thread that made the file as a chat message
 * ("[Cara on report.md]: …"), waking it like any message. Text selected in the file can lead it as a quote.
 */
function commentBox(t, path, name, body) {
  const draftKey = `cc-comment:${t.id}:${path}`;
  const textarea = h('textarea', { rows: 1, placeholder: `Comment on ${name} to ${isCoordinator(t) ? 'the Taskmaster' : `#${t.number ?? t.id}`}…`, 'data-draft': true, maxlength: 10000 });
  textarea.value = loadDraft(draftKey) ?? '';
  const sendBtn = h('button', { type: 'submit', class: 'small' }, 'Comment');
  const status = h('span', { class: 'muted small status', 'aria-live': 'polite' });
  const quoteEl = h('div', { class: 'quote', hidden: true });
  let quote = '';
  let selected = '';
  const setQuote = (text) => {
    quote = text;
    quoteEl.hidden = !text;
    quoteEl.replaceChildren(h('span', { class: 'text' }, text),
      h('button', { type: 'button', class: 'secondary small', title: 'Remove the quote', 'aria-label': 'Remove the quote', onclick: () => setQuote('') }, '×'));
  };
  const quoteBtn = h('button', {
    type: 'button', class: 'secondary small', hidden: true, title: 'Quote the text selected in the file',
    // Keep the selection when the button is pressed, so there is still something to quote.
    onpointerdown: (e) => e.preventDefault(),
    onclick: () => {
      setQuote(selected);
      textarea.focus();
    },
  }, '❝ Quote selection');
  // Only text the file shows on this page can be quoted; pages and PDFs sit in frames of their own.
  const onSelection = () => {
    if (!body.isConnected) return document.removeEventListener('selectionchange', onSelection);
    const sel = getSelection();
    const inside = sel && !sel.isCollapsed && body.contains(sel.anchorNode) && body.contains(sel.focusNode);
    selected = inside ? sel.toString().trim().slice(0, 2000) : '';
    quoteBtn.hidden = !selected;
  };
  document.addEventListener('selectionchange', onSelection);
  const grow = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight + 2, 200)}px`;
  };
  textarea.addEventListener('input', () => {
    saveDraft(draftKey, textarea.value);
    status.replaceChildren();
    grow();
  });
  setTimeout(grow);
  const form = h('form', { class: 'file-comment' }, quoteEl, textarea,
    h('div', { class: 'row' }, quoteBtn, status, h('span', { class: 'spacer' }), sendBtn));
  textarea.addEventListener('keydown', (e) => {
    if (continueList(textarea, e, matchMedia('(max-width: 800px)').matches)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(max-width: 800px)').matches) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text) return textarea.focus();
    sendBtn.disabled = true;
    setSending(sending + 1);
    status.textContent = 'Sending…';
    try {
      await api(`api/tickets/${t.id}/comments`, { method: 'POST', body: { path, text, quote } });
      textarea.value = '';
      saveDraft(draftKey, '');
      setQuote('');
      grow();
      status.replaceChildren(`Sent to ${threadLabel(t)} · `, h('a', { href: threadHref(t) }, 'see the chat'));
    } catch (ex) {
      status.textContent = ex.message;
    } finally {
      sendBtn.disabled = false;
      setSending(sending - 1);
      reloadWhenIdle();
    }
  });
  return form;
}

/** Main panel: a file from the project's shared folder. */
export function sharedViewer(file) {
  const body = h('div', { class: 'artifact-body' });
  if (file.missing) body.append(h('p', { class: 'muted' }, `${file.missing}.`));
  // Comments on a shared page go to the Taskmaster; the page's own Send goes to the minion that linked it, if one did (the server knows).
  const comment = !file.missing && file.kind === 'html' && view.coordinator ? commentBox(view.coordinator, file.abs, file.name, body) : null;
  const bridge = sharedBridge(file);
  if (!file.missing) renderFileBody(body, { ...file, src: `${sharedUrl(view.projectId, file.path)}&v=${file.mtime}`, urlFor: (p) => sharedUrl(view.projectId, p), hrefFor: (p) => sharedHref(view.projectId, p), brief: { projectId: view.projectId, path: file.abs ?? file.display_path, name: file.name }, bridge });
  return h('section', { class: 'artifacts-main' }, h('div', { class: 'ticket-head', id: 'shared-head' }), body, comment ?? '');
}

export function renderSharedHead() {
  const el = document.getElementById('shared-head');
  if (!el) return;
  const { file } = view;
  // Its entry in the Shared list carries the pin, kept live as it changes.
  const listed = view.shared.find((f) => f.path === file.path);
  const src = `${sharedUrl(view.projectId, file.path)}&v=${file.mtime}`;
  el.replaceChildren(
    h('div', { class: 'row' },
      h('span', { class: `badge k-${file.kind}` }, fileExt(file.name)),
      h('h2', {}, file.name),
      h('span', { class: 'spacer' }),
      listed ? pinButton(listed) : '',
      file.missing || file.kind !== 'html' ? '' : fullScreenButton(() => el.closest('.artifacts-main')),
      file.missing ? '' : openButton(src, file, sharedBridge(file)),
      file.missing ? '' : h('a', { class: 'button secondary', href: `${src}&download` }, 'Download')),
    h('div', { class: 'meta' },
      file.display_path, ' · in the folder every minion and the Taskmaster share',
      file.missing ? ' · not found' : ` · ${formatSize(file.size)} · updated ${ago(file.mtime)}`,
      listed?.pinned_at ? ` · pinned by ${listed.pinned_by}` : ''));
}

/**
 * Full screen for the HTML page framed in `scope()`, in this tab so its bridge keeps saving (Open's new
 * tab has no viewer behind it). Where a frame can't go full screen (iPhone), it fills the window instead.
 */
function fullScreenButton(scope) {
  return h('button', { type: 'button', class: 'secondary full-screen', onclick: () => {
    const frame = scope()?.querySelector('iframe.artifact-frame');
    if (!frame) return;
    if (document.fullscreenEnabled && frame.requestFullscreen) frame.requestFullscreen().catch(() => fillWindow(frame));
    else fillWindow(frame);
  } }, 'Full screen');
}

function fillWindow(frame) {
  const close = h('button', { type: 'button', class: 'frame-fill-close', title: 'Leave full screen', 'aria-label': 'Leave full screen', onclick: () => leave() }, icon('close'));
  // Esc leaves the fill, not the viewer under it.
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    if (frame.isConnected) e.preventDefault(), e.stopPropagation();
    leave();
  };
  const leave = () => {
    frame.classList.remove('frame-fill');
    close.remove();
    removeEventListener('keydown', onKey, true);
    delete frame.leaveFill;
  };
  frame.classList.add('frame-fill');
  frame.after(close);
  addEventListener('keydown', onKey, true);
  frame.leaveFill = leave;
}

/**
 * Show a file in `body` by its kind. Markdown's relative image links load from next to it, its links
 * to files beside it open them (`hrefFor`), and its briefs get Start buttons (`brief` says where the
 * file is, see addBriefButtons).
 */
function renderFileBody(body, { kind, src, size, name, path, ticketId, brief, bridge, urlFor = (p) => fileUrl(ticketId, p), hrefFor = (p) => fileHref(ticketId, p) }) {
  if (kind === 'image') {
    body.append(h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { class: 'artifact-media', src, alt: name })));
  } else if (kind === 'video') {
    body.append(h('video', { class: 'artifact-media', src, controls: true, autoplay: true, muted: true, loop: true, playsinline: true }));
  } else if (kind === 'audio') {
    body.append(h('audio', { src, controls: true, preload: 'metadata' }));
  } else if (kind === 'html') {
    // Sandboxed (here and by the server's CSP) so a page a thread wrote can't act as the app.
    // Its page reaches the app only through the artifact bridge (bridge-host.js), as the person viewing it.
    const frame = h('iframe', { class: 'artifact-frame', src, sandbox: 'allow-scripts allow-popups allow-forms allow-modals allow-downloads', allow: 'clipboard-write *; fullscreen *', allowfullscreen: true, title: name });
    if (bridge) attachBridge(frame, { ...bridge, name, api });
    body.append(frame);
  } else if (kind === 'pdf') {
    body.append(h('iframe', { class: 'artifact-frame', src, title: name }));
  } else if (kind === 'download') {
    body.append(h('p', {}, h('a', { class: 'button', href: `${src}&download`, download: '' }, `Download ${name} (${formatSize(size)})`)));
  } else if (size > MAX_TEXT_PREVIEW) {
    body.append(h('p', { class: 'muted' }, `Too large to preview (${formatSize(size)}). Open or download it instead.`));
  } else {
    body.append(h('p', { class: 'muted' }, 'Loading…'));
    fetch(src).then(async (res) => {
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const text = await res.text();
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const imageUrl = (href) => (isLocalPath(href) ? urlFor(joinPath(dir, href.split('#')[0])) : null);
      let shown = text;
      if (kind === 'canvas') {
        // JSON Canvas files are JSON; lay them out readably.
        try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch {}
      }
      const linkHref = (href) => hrefFor(joinPath(dir, href));
      const doc = kind === 'markdown' && markdownDoc(text, { imageUrl, linkHref });
      if (doc && brief) addBriefButtons(doc, text, brief);
      body.replaceChildren(doc ? h('div', { class: 'msg doc' }, doc) : h('pre', { class: 'artifact-text' }, shown));
    }).catch((err) => body.replaceChildren(h('p', { class: 'error' }, `Could not load: ${err.message}`)));
  }
}

export function renderArtifactHead() {
  const el = document.getElementById('artifact-head');
  if (!el) return;
  const a = view.artifacts.find((x) => x.id === view.artifactId);
  if (!a) {
    el.replaceChildren(h('div', { class: 'row' }, h('h2', {}, 'Artifact removed'),
      h('span', { class: 'muted' }, 'The file was deleted from its minion\'s folder.')));
    return;
  }
  el.replaceChildren(
    h('div', { class: 'row' },
      h('span', { class: `badge k-${a.kind}` }, extOf(a)),
      h('h2', {}, a.name),
      h('span', { class: 'spacer' }),
      pinButton(a),
      a.missing || a.kind !== 'html' ? '' : fullScreenButton(() => el.closest('.artifacts-main')),
      a.missing ? '' : openButton(rawUrl(a), a, { open: { artifact: a.id }, owner: threadName(a) }),
      a.missing ? '' : h('a', { class: 'button secondary', href: `${rawUrl(a)}&download` }, 'Download')),
    h('div', { class: 'meta' },
      a.display_path ?? a.path, ' · from ',
      h('a', { href: threadHref(artifactThread(a)) }, threadName(a)),
      a.missing ? ' · missing' : ` · ${formatSize(a.size)} · updated ${ago(a.mtime)}`,
      a.pinned_at ? ` · pinned by ${a.pinned_by}` : ''));
}
