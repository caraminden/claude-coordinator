// Artifacts and files: the shelf, the browser, and viewers for artifacts and linked or shared files.
import { ago, api, baseName, fileExt, fileKind, fileUrl, followChat, h, isCoordinator, isLocalPath, joinPath, markdownDoc, reloadWhenIdle, routeSeq, scrollToBottom, sending, setSending, sharedHref, sharedUrl, shortPath, taskmasterName, threadHref, threadLabel, view } from './core.js';
import { loadDraft, saveDraft } from './composer.js';
import { showProject } from './project.js';

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
];

const rawUrl = (a) => `api/artifacts/${a.id}/raw?v=${a.mtime}`;
const extOf = (a) => (a.name.includes('.') ? a.name.split('.').pop() : a.kind).slice(0, 5).toUpperCase();
const artifactThread = (a) => ({ id: a.ticket_id, kind: a.ticket_kind, project_id: a.project_id, number: a.ticket_number, title: a.ticket_title });
const threadName = (a) => threadLabel(artifactThread(a));

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

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
}

async function setPinned(a, pinned) {
  try {
    await api(`api/artifacts/${a.id}/pin`, { method: 'POST', body: { pinned } });
    await refreshArtifacts();
  } catch (e) {
    alert(`Could not ${pinned ? 'pin' : 'unpin'}: ${e.message}`);
  }
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
  const pinned = all.filter((a) => a.pinned_at).sort((a, b) => b.pinned_at - a.pinned_at);
  const recent = all.filter((a) => !a.pinned_at && !a.missing).slice(0, RECENT_ARTIFACTS);
  const item = (a) => h('a', { class: `artifact-item${view.artifactId === a.id ? ' active' : ''}${a.missing ? ' missing' : ''}`, href: `#/a/${a.id}`, title: a.display_path ?? a.path },
    h('span', { class: `badge k-${a.kind}` }, extOf(a)),
    h('span', { class: 'text' },
      h('span', { class: 'name' }, a.name),
      h('span', { class: 'meta' }, `${a.ticket_kind === 'coordinator' ? taskmasterName() : `#${a.ticket_number ?? a.ticket_id}`} · ${a.missing ? 'missing' : ago(a.mtime)}`)));
  const sub = (title, count, items, empty, render = item) => h('div', { class: 'sub' },
    h('h4', {}, title, count ? h('span', { class: 'count' }, count) : ''),
    items.length ? items.map(render) : h('p', { class: 'muted small' }, empty));
  el.replaceChildren(h('section', { class: 'column' },
    h('h3', {}, 'Artifacts', h('span', { class: 'spacer' }),
      h('a', { class: `browse${view.main === 'artifacts' ? ' active' : ''}`, href: `#/p/${view.projectId}/artifacts`, title: `Browse all ${all.length} artifacts` }, 'Browse')),
    sub('Pinned', pinned.length, pinned, 'Pin artifacts with ☆ to keep them here.'),
    sub('Recent', 0, recent, 'Documents, pages and canvases that minions create show up here.'),
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
  document.getElementById('shared-summary').textContent = `${view.shared.length} in the scheme's shared folder`;
  el.replaceChildren(...(view.shared.length ? view.shared.map(sharedItem) : [h('p', { class: 'muted' }, 'Handoffs and notes minions put in the scheme\'s shared folder show up here.')]));
}

/** A document or page in the project's shared folder, as a row of the Shared files list. */
function sharedItem(f) {
  return h('a', { class: `artifact-item${view.main === 'shared' && view.file?.path === f.path ? ' active' : ''}`, href: sharedHref(view.projectId, f.path), title: f.display_path },
    h('span', { class: `badge k-${f.kind}` }, extOf(f)),
    h('span', { class: 'text' },
      h('span', { class: 'name' }, f.name),
      h('span', { class: 'meta' }, f.path.includes('/') ? `${f.path.slice(0, f.path.lastIndexOf('/'))} · ${ago(f.mtime)}` : ago(f.mtime))));
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

/** Main panel: one artifact, shown inline according to its type. */
export function artifactViewer(a) {
  const body = h('div', { class: 'artifact-body' });
  const section = h('section', { class: 'artifacts-main' }, h('div', { class: 'ticket-head', id: 'artifact-head' }), body);
  if (a.missing) {
    body.append(h('p', { class: 'muted' }, 'This file is no longer in the minion\'s folder. Unpin it to remove it from the list.'));
  } else {
    renderFileBody(body, { ...a, src: rawUrl(a), ticketId: a.ticket_id });
    section.append(commentBox(artifactThread(a), a.path, a.name, body));
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
      location.replace(a.getAttribute('href'));
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
  else renderFileBody(viewer.stage, { ...file, src: `${fileUrl(ticket.id, file.path)}&v=${file.mtime}`, ticketId: ticket.id });
  renderViewerBar();
}

/** Put the chat back where it was and drop the viewer. The chat's address it was over, or null. */
export function closeViewer() {
  if (!viewer) return null;
  const { dialog, chat, placeholder, ticket, scrollY } = viewer;
  const follow = followChat;
  viewer = null;
  placeholder.replaceWith(chat);
  dialog.close();
  dialog.remove();
  if (follow) scrollToBottom();
  else window.scrollTo(0, scrollY);
  return threadHref(ticket);
}

/** × or Esc: back to the chat, as the browser's back button would when it was opened from there. */
function leaveViewer() {
  if (viewer.inPlace) history.back();
  else location.replace(threadHref(viewer.ticket));
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
    file.missing ? '' : h('a', { class: 'button secondary', href: src, target: '_blank', rel: 'noopener' }, 'Open'),
    file.missing ? '' : h('a', { class: 'button secondary wide-only', href: `${src}&download` }, 'Download'),
    h('button', { type: 'button', class: 'close-view', title: 'Back to the chat', 'aria-label': 'Back to the chat', onclick: leaveViewer }, '×'));
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
  else renderFileBody(body, { ...file, src: `${sharedUrl(view.projectId, file.path)}&v=${file.mtime}`, urlFor: (p) => sharedUrl(view.projectId, p) });
  return h('section', { class: 'artifacts-main' }, h('div', { class: 'ticket-head', id: 'shared-head' }), body);
}

export function renderSharedHead() {
  const el = document.getElementById('shared-head');
  if (!el) return;
  const { file } = view;
  const src = `${sharedUrl(view.projectId, file.path)}&v=${file.mtime}`;
  el.replaceChildren(
    h('div', { class: 'row' },
      h('span', { class: `badge k-${file.kind}` }, fileExt(file.name)),
      h('h2', {}, file.name),
      h('span', { class: 'spacer' }),
      file.missing ? '' : h('a', { class: 'button secondary', href: src, target: '_blank', rel: 'noopener' }, 'Open'),
      file.missing ? '' : h('a', { class: 'button secondary', href: `${src}&download` }, 'Download')),
    h('div', { class: 'meta' },
      file.display_path, ' · in the folder every minion and the Taskmaster share',
      file.missing ? ' · not found' : ` · ${formatSize(file.size)} · updated ${ago(file.mtime)}`));
}

/** Show a file in `body` by its kind. Markdown's relative image links load from next to it. */
function renderFileBody(body, { kind, src, size, name, path, ticketId, urlFor = (p) => fileUrl(ticketId, p) }) {
  if (kind === 'image') {
    body.append(h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { class: 'artifact-media', src, alt: name })));
  } else if (kind === 'video') {
    body.append(h('video', { class: 'artifact-media', src, controls: true, autoplay: true, muted: true, loop: true, playsinline: true }));
  } else if (kind === 'audio') {
    body.append(h('audio', { src, controls: true, preload: 'metadata' }));
  } else if (kind === 'html') {
    // Sandboxed (here and by the server's CSP) so a page a thread wrote can't act as the app.
    body.append(h('iframe', { class: 'artifact-frame', src, sandbox: 'allow-scripts allow-popups allow-forms allow-modals', title: name }));
  } else if (kind === 'pdf') {
    body.append(h('iframe', { class: 'artifact-frame', src, title: name }));
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
      body.replaceChildren(kind === 'markdown'
        ? h('div', { class: 'msg doc' }, markdownDoc(text, imageUrl))
        : h('pre', { class: 'artifact-text' }, shown));
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
      a.missing ? '' : h('a', { class: 'button secondary', href: rawUrl(a), target: '_blank', rel: 'noopener' }, 'Open'),
      a.missing ? '' : h('a', { class: 'button secondary', href: `${rawUrl(a)}&download` }, 'Download')),
    h('div', { class: 'meta' },
      a.display_path ?? a.path, ' · from ',
      h('a', { href: threadHref(artifactThread(a)) }, threadName(a)),
      a.missing ? ' · missing' : ` · ${formatSize(a.size)} · updated ${ago(a.mtime)}`,
      a.pinned_at ? ` · pinned by ${a.pinned_by}` : ''));
}
