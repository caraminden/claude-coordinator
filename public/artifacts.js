// Artifacts and files: the shelf, the browser, and viewers for artifacts and linked or shared files.
import { ago, api, baseName, fileExt, fileKind, fileUrl, fileHref, formatSize, h, icon, isCoordinator, isLocalPath, joinPath, loadPanelState, me, savePanelState, sharedHref, sharedUrl, shortPath, taskmasterName, threadHref, threadLabel, view } from './base.js';
import { followChat, markdownDoc, reloadWhenIdle, routeSeq, scrollToBottom, sending, setSending } from './core.js';
import { attachBridge, openWithBridge } from './bridge-host.js';
import { attachImage, loadDraft, saveDraft, sendableImage } from './composer.js';
import { annotator, canvasBlob } from './annotate.js';
import { showProject } from './project.js';
import { replaceHash } from './navstack.js';
import { continueList } from './ui/composer.js';
import { linkify } from './ui/markdown.js';
import { parseMarks } from './ui/marks.js';
import { lightbox } from './ui/media.js';
import { optimistic } from './ui/optimistic.js';
import { renderFiles } from './files.js';
import { ARTIFACT_ALLOW, ARTIFACT_SANDBOX } from './frames.js';
import { loadingLine } from './ui/state.js';

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
  const seq = routeSeq;
  const file = await api(`api/projects/${projectId}/shared/file?info&path=${encodeURIComponent(path)}`).catch((err) => ({
    missing: err.message, name: baseName(path), kind: fileKind(path) ?? 'text', display_path: `scheme shared/${path}`,
  }));
  if (seq !== routeSeq) return; // overtaken by another click while loading
  await showProject(projectId, { kind: 'shared', file: { ...file, path } });
}

export async function showArtifact(artifactId) {
  const seq = routeSeq;
  const { artifact } = await api(`api/artifacts/${artifactId}`);
  if (seq !== routeSeq) return; // overtaken by another click while loading
  await showProject(artifact.project_id, { kind: 'artifact', artifact });
}

// ---------- artifacts ----------

const RECENT_ARTIFACTS = 5;
const MAX_TEXT_PREVIEW = 2 * 1024 * 1024;

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
  if (view.main === 'files') renderFiles();
  if (view.main === 'artifact') renderArtifactHead();
  renderViewerBar();
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

export function pinButton(a) {
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
      h('a', { class: `browse${view.main === 'files' ? ' active' : ''}`, href: `#/p/${view.projectId}/shared`, title: 'Every file: the shared folder and what minions linked' }, 'All files')),
    sub('Pinned', pinned.length, pinned, 'Pin artifacts with ☆ to keep them here.'),
    recentFold));
}

// What a page's bridge says the viewer opened: a file a chat linked, or a file in the scheme's shared folder.
/**
 * A choices page's picture, open over the viewer ready to draw (#946, bridge-host's draw): resolves null when
 * closed without Done, else { marks, image } with the marked copy as a message carries it (null with no marks).
 */
function drawForPage(src, marks) {
  return new Promise((resolve, reject) => {
    let done = null;
    const lb = lightbox([{ src, caption: 'Picture on the page' }], {
      label: 'Draw on the picture',
      render: (_, stage) => annotator(stage, src, { marks, onDone: (canvas, kept) => { done = { canvas, marks: kept }; lb.close(); } }),
      onClose: () => {
        if (!done) return resolve(null);
        if (!done.canvas) return resolve({ marks: [], image: null });
        canvasBlob(done.canvas).then(sendableImage).then((image) => resolve({ marks: done.marks, image }), reject);
      },
    });
  });
}

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
    // The head reads the list's copy of the artifact, not this one.
    const onMissing = () => { a.missing = 1; const listed = view.artifacts.find((x) => x.id === a.id); if (listed) listed.missing = 1; comment.remove(); renderArtifactHead(); };
    renderFileBody(body, { ...a, src: rawUrl(a), ticketId: a.ticket_id, bridge, onMissing });
    section.append(comment);
  }
  return section;
}

// The open full-screen viewer: the chat section lives inside it until it closes.
let viewer = null; // { dialog, stage, bar, chat, placeholder, ticket, file, inPlace, scrollY }
// A question card's picture options (#634), set as one is opened: the bar steps between them and picks one.
let gallery = null; // { ticketId, at, answered(), options: [{ path, label, picked(), pick() }] }

/** Browse a question card's picture options in the viewer (cards.js), until it closes. */
export function setViewerGallery(g) {
  gallery = g;
  renderViewerBar();
}
/** Redraw the bar after a pick changed somewhere else (the card beside it). */
export const refreshViewerBar = () => renderViewerBar();

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
    viewer.stopKeyboard = watchKeyboard(dialog);
    // Keep the clicked embed in sight in the narrower chat, unless you were following the end.
    const link = [...chat.querySelectorAll('#log a[href]')].reverse().find((a) => a.getAttribute('href') === location.hash);
    // A card's picture keeps the card in sight, so its pick shows beside the picture.
    if ((followChat && !gallery) || !link) scrollToBottom();
    else link.scrollIntoView({ block: 'center' });
  }
  Object.assign(viewer, { ticket, file });
  viewer.dialog.setAttribute('aria-label', file.name);
  // Stepping in the lightbox changed the address: it already shows this file, so only the bar changes.
  const shown = viewer.media?.paths.indexOf(file.path) ?? -1;
  if (shown >= 0 && viewer.media.ticketId === ticket.id && viewer.media.lb.el.isConnected) {
    if (viewer.media.lb.at !== shown) viewer.media.lb.go(shown);
    return renderViewerBar();
  }
  viewer.media?.lb.destroy();
  viewer.media = null;
  viewer.stage.className = `viewer-stage k-${file.kind}`;
  viewer.stage.replaceChildren();
  viewer.stage.textLoad = null; // a text file still loading for the last file is dropped
  if (file.missing) viewer.stage.append(h('p', { class: 'muted' }, `${file.missing}.`));
  else {
    // A page's Send goes to the chat beside it.
    // After a send the viewer closes on the chat it went to (a page can opt out: send's keepOpen).
    const bridge = { ...viewerBridge(ticket, file), afterSend: () => { if (viewer?.file === file) leaveViewer(); } };
    if (!showMedia(ticket, file)) renderFileBody(viewer.stage, { ...file, src: `${fileUrl(ticket.id, file.path)}&v=${file.mtime}`, ticketId: ticket.id, bridge, onMissing: (message) => { file.missing = message; renderViewerBar(); } });
  }
  renderViewerBar();
}

/**
 * A picture or clip opens in the kit's lightbox (#833): clips get the scrubber, pictures whole (a wide screenshot is not panned), and
 * the other pictures and clips of the message it was linked from come along, stepped with ‹ ›, ←/→ or the
 * filmstrip. A card's picture options keep their own stepping (galleryControls), so they don't come here.
 */
function showMedia(ticket, file) {
  if (file.kind !== 'image' && file.kind !== 'video') return false;
  if (gallery?.ticketId === ticket.id && gallery.options.some((o) => o.path === file.path)) return false;
  const prefix = `#/f/${ticket.id}/`;
  const pathOf = (a) => a.dataset.file ?? decodeURIComponent(a.getAttribute('href').slice(prefix.length));
  const link = [...viewer.chat.querySelectorAll(`#log a[href^="${prefix}"]`)].find((a) => pathOf(a) === file.path);
  const links = [...(link?.closest('.msg')?.querySelectorAll(`a[href^="${prefix}"]`) ?? [])];
  const paths = [...new Set(links.map(pathOf))].filter((p) => ['image', 'video'].includes(fileKind(p)));
  // A minion's marked picture (#960) opens with its marks, as marks people can undo, while its Marks toggle is on.
  const minionMarks = new Map();
  for (const a of links) {
    const marked = a.closest('.cui-marked');
    const own = marked?.querySelector('.cui-marks-toggle > input')?.checked && parseMarks(marked.dataset.marks);
    if (own && !minionMarks.has(pathOf(a))) minionMarks.set(pathOf(a), own);
  }
  if (!paths.includes(file.path)) paths.splice(0, paths.length, file.path);
  const items = paths.map((p) => ({
    src: p === file.path ? `${fileUrl(ticket.id, p)}&v=${file.mtime}` : fileUrl(ticket.id, p),
    kind: fileKind(p), alt: baseName(p), marks: minionMarks.get(p),
  }));
  viewer.stage.className = 'viewer-stage k-media';
  const kept = new Map();
  const lb = lightbox(items, { at: paths.indexOf(file.path), into: viewer.stage, autoplay: true, label: 'Pictures and clips in this message',
    onChange: (at) => replaceHash(fileHref(ticket.id, paths[at])),
    // A picture is ready to draw on (#946): Done puts the marked copy in the chat's message box and goes back to it.
    // Each picture's marks outlive stepping to another one, while the viewer stays open.
    render: (item, stage, _, show) => {
      if (item.kind !== 'image') return show();
      const a = annotator(stage, item.src, {
        ...(kept.has(item.src) ? { marks: kept.get(item.src) } : item.marks ? { marks: item.marks.marks, size: { w: item.marks.w, h: item.marks.h } } : {}),
        doneLabel: 'Add to message',
        onDone: async (canvas) => {
          if (canvas) attachImage(ticket.id, await canvasBlob(canvas));
          leaveViewer();
        },
      });
      return { destroy: () => { kept.set(item.src, a.marks); a.destroy(); } };
    } });
  viewer.media = { ticketId: ticket.id, paths, lb };
  return true;
}

/** Put the chat back where it was and drop the viewer. The chat's address it was over, or null. */
export function closeViewer() {
  if (!viewer) return null;
  const { dialog, chat, placeholder, ticket, scrollY } = viewer;
  const follow = followChat;
  viewer.media?.lb.destroy();
  viewer.stopKeyboard?.();
  viewer = gallery = null;
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

/**
 * Phones: while the keyboard is up for a field inside the viewed page (focus is on its frame), the page gets the
 * whole screen: `kb-page` hides the chat under it and sizes the dialog to the visual viewport. Both come back when
 * the keyboard closes. Only a class and a height change, so nothing else moves.
 */
function watchKeyboard(dialog) {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  let tallest = Math.max(vv.height, innerHeight);
  const stop = () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); removeEventListener('focusin', update); removeEventListener('blur', onBlur, true); screen.orientation?.removeEventListener('change', onTurn); };
  const update = () => {
    if (!dialog.isConnected) return stop();
    tallest = Math.max(tallest, vv.height, innerHeight);
    const typing = document.activeElement?.classList.contains('artifact-frame') && matchMedia('(max-width: 800px)').matches
      && vv.height < tallest - 120;
    dialog.classList.toggle('kb-page', !!typing);
    // Chrome on Android shrinks only the visual viewport: size and place the dialog to it.
    dialog.style.height = typing ? `${vv.height}px` : '';
    dialog.style.top = typing ? `${vv.offsetTop}px` : '';
    dialog.style.bottom = typing ? 'auto' : '';
  };
  const onBlur = () => setTimeout(update);
  // A rotated phone has a new tallest height.
  const onTurn = () => { tallest = 0; update(); };
  screen.orientation?.addEventListener('change', onTurn);
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  addEventListener('focusin', update);
  addEventListener('blur', onBlur, true);
  return stop; // closeViewer calls it: left on screen.orientation, the listener would keep every closed viewer (#1760)
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
  const options = gallery?.ticketId === t.id ? gallery.options : [];
  // By place, not path alone: two options may share one picture.
  const at = options[gallery?.at]?.path === file.path ? gallery.at : options.findIndex((o) => o.path === file.path);
  if (at >= 0) gallery.at = at;
  const open = file.missing ? '' : openButton(src, file, viewerBridge(t, file));
  if (open && at >= 0) open.classList.add('wide-only'); // a phone's bar keeps its room for the option's controls
  // ‹ › on the picture's own edges too, so it steps like a carousel (Cara, 2026-11-14).
  viewer.stage.querySelector(':scope > .edge-steps')?.remove();
  if (at >= 0 && options.length > 1) viewer.stage.append(h('div', { class: 'edge-steps' }, stepLink(t, options, at, -1, 'prev'), stepLink(t, options, at, 1, 'next')));
  viewer.bar.replaceChildren(
    at >= 0 ? '' : h('span', { class: `badge k-${file.kind}` }, fileExt(file.name)),
    h('div', { class: 'name' }, h('h2', { title: file.display_path }, at >= 0 ? options[at].label : file.name),
      h('span', { class: 'meta' }, file.missing ? 'not found' : `${formatSize(file.size)} · updated ${ago(file.mtime)}`)),
    at >= 0 ? galleryControls(t, options, at) : '',
    a ? pinButton(a) : '',
    file.missing || file.kind !== 'html' ? '' : fullScreenButton(() => viewer?.stage),
    open,
    file.missing ? '' : h('a', { class: 'button secondary wide-only', href: `${src}&download` }, 'Download'),
    h('button', { type: 'button', class: 'close-view', title: 'Back to the chat', 'aria-label': 'Back to the chat', onclick: leaveViewer }, icon('close')));
}

/**
 * A picture option's controls in the bar: ‹ › to the card's other pictures (swapped in place, as a link
 * from the chat is) and Pick this, which only picks: the card's Send still sends. Read-only once answered.
 */
function stepLink(t, options, at, by, cls = '') {
  if (options.length < 2) return '';
  const to = (at + by + options.length) % options.length;
  return h('a', {
    class: `button secondary step ${cls}`, href: fileHref(t.id, options[to].path), 'aria-label': by < 0 ? 'Previous option' : 'Next option',
    onclick: (e) => {
      gallery.at = to;
      // The same picture under another option: no new address to go to, so only the bar changes.
      if (options[to].path === options[at].path) { e.preventDefault(); renderViewerBar(); }
    },
  }, by < 0 ? '‹' : '›');
}

function galleryControls(t, options, at) {
  const o = options[at];
  const picked = o.picked();
  const pick = gallery.answered()
    ? (picked ? h('span', { class: 'picked' }, '✓ Picked') : '')
    : h('button', {
      type: 'button', class: `small pick${picked ? ' secondary' : ''}`, 'aria-pressed': String(picked),
      onclick: () => {
        o.pick();
        viewer?.bar.querySelector('.pick')?.focus(); // the pick redrew the bar
      },
    }, picked ? '✓ Picked' : 'Pick this');
  // Pick leads, so its width changing ("Pick this", "✓ Picked", nothing) never moves the arrows.
  return h('div', { class: 'gallery-controls' },
    pick, stepLink(t, options, at, -1), options.length < 2 ? '' : h('span', { class: 'count' }, `${at + 1} / ${options.length}`), stepLink(t, options, at, 1));
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
  const onMissing = (message) => { file.missing = message; comment?.remove(); renderSharedHead(); };
  if (!file.missing) renderFileBody(body, { ...file, onMissing, src: `${sharedUrl(view.projectId, file.path)}&v=${file.mtime}`, urlFor: (p) => sharedUrl(view.projectId, p), hrefFor: (p) => sharedHref(view.projectId, p), bridge });
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
 * to files beside it open them (`hrefFor`).
 */
function renderFileBody(body, { kind, src, size, name, path, ticketId, bridge, onMissing, urlFor = (p) => fileUrl(ticketId, p), hrefFor = (p) => fileHref(ticketId, p) }) {
  // The full-screen viewer reuses its stage: a text answer for a file opened before the one showing is dropped.
  const load = (body.textLoad = {});
  if (kind === 'image') {
    body.append(h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { class: 'artifact-media', src, alt: name })));
  } else if (kind === 'video') {
    body.append(h('video', { class: 'artifact-media', src, controls: true, autoplay: true, muted: true, loop: true, playsinline: true }));
  } else if (kind === 'audio') {
    body.append(h('audio', { src, controls: true, preload: 'metadata' }));
  } else if (kind === 'html') {
    // Sandboxed (here and by the server's CSP) so a page a thread wrote can't act as the app.
    // Its page reaches the app only through the artifact bridge (bridge-host.js), as the person viewing it.
    const frame = h('iframe', { class: 'artifact-frame', src, sandbox: ARTIFACT_SANDBOX, allow: ARTIFACT_ALLOW, allowfullscreen: true, title: name });
    if (bridge) attachBridge(frame, { ...bridge, name, api, draw: drawForPage });
    body.append(frame);
  } else if (kind === 'pdf') {
    body.append(h('iframe', { class: 'artifact-frame', src, title: name }));
  } else if (kind === 'download') {
    body.append(h('p', {}, h('a', { class: 'button', href: `${src}&download`, download: '' }, `Download ${name} (${formatSize(size)})`)));
  } else if (size > MAX_TEXT_PREVIEW) {
    body.append(h('p', { class: 'muted' }, `Too large to preview (${formatSize(size)}). Open or download it instead.`));
  } else {
    body.append(loadingLine('Loading…'));
    const show = (el) => body.textLoad === load && body.replaceChildren(el);
    fetch(src).then(async (res) => {
      if (!res.ok) {
        const message = (await res.json().catch(() => ({}))).error || `HTTP ${res.status}`;
        // Listed but gone: the viewer's Open, Download and Comment have nothing to act on (#882).
        if (res.status === 404 && onMissing && body.textLoad === load) {
          body.replaceChildren(h('p', { class: 'muted' }, `${message}.`));
          return onMissing(message);
        }
        throw new Error(message);
      }
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
      // Plain text keeps its URLs clickable too (#440): linkify escapes everything else.
      const pre = h('pre', { class: 'artifact-text' });
      if (!doc) pre.innerHTML = linkify(shown);
      show(doc ? h('div', { class: 'msg doc' }, doc) : pre);
    }).catch((err) => show(h('p', { class: 'error' }, `Could not load: ${err.message}`)));
  }
}

/** A file's body for the Files view's preview: a minion's artifact (it has an id) or a shared-folder file. */
export function previewBody(file, src, onMissing) {
  const body = h('div', { class: 'artifact-body' });
  if (file.missing) body.append(h('p', { class: 'muted' }, 'This file no longer exists. Unpin it to take it off the list.'));
  else if (file.id) renderFileBody(body, { ...file, src, ticketId: file.ticket_id, bridge: { open: { artifact: file.id }, owner: threadName(file) }, onMissing });
  else renderFileBody(body, { ...file, src, urlFor: (p) => sharedUrl(view.projectId, p), hrefFor: (p) => sharedHref(view.projectId, p), bridge: sharedBridge(file), onMissing });
  return body;
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
