// Shared by every view: state, API and DOM helpers, live updates, routing and sign-in.
import { onAppInstructionsUpdate, onMachinesUpdate, onProjectUpdate, pushOff } from './settings.js';
import { costChip, renderCost } from './cost.js';
import { openStartScheme, renderSidebar } from './sidebar.js';
import { showProject, showTicket } from './project.js';
import { closeViewer, onArtifactsChanged, setArtifacts, showArtifact, showFile, showSharedFile } from './artifacts.js';
import { onArtifactData } from './bridge-host.js';
import { appendEvent, jumpToEvent, refreshBranch, renderBranch, renderTicketHead } from './thread.js';
import { replaceHash } from './navstack.js';
import { onPropertiesChanged, onViewsChanged } from './properties.js';
import { forgetOtherSchemes, inboxEvent, inboxOtherTicket, inboxTicket, refreshInbox, refreshSchemeCounts } from './inbox.js';
import { onSchedulesChanged } from './schedules.js';
import { onHiddenChanged } from './hidden.js';
import { inAppHash, jumpParts, linkThreadRefs, linkUrls, prLinkOpen, prNumberRoute, prOwnerRoute } from './threadrefs.js';
import { renderModelPicker, uploadsRunning } from './composer.js';
import { markdownElement } from './ui/markdown.js';
import { iconSrc } from './schemes.js';
import { hideRail, showRail } from './rail.js';
import { dropFrames, framed, hideFrames, shareTarget, showFrame } from './frames.js';
import { toast } from './ui/status.js';
import { initAppSwitch } from './appswitch.js';
import { codexHigh, codexLevel, codexTop, codexWindows, windowName } from './codexusage.js';

export const app = document.getElementById('app');
export const crumbs = document.getElementById('crumbs');
const meEl = document.getElementById('me');

const STATUS_LABEL = { running: 'Running', idle: 'Waiting for you', new: 'Starting', error: 'Error', closed: 'Dismissed' };
// Thread naming and the threads list follow Delve's Custom view: threads are grouped by their `type`
// property, and each is one compact row of number + short ask, a state, and a terse note.
// In the list's order; `other` has no emoji or header word, as a minion of no particular kind.
export const TYPES = {
  feature: { emoji: '🛠️', label: 'Feature', section: 'Features' },
  bug: { emoji: '🐛', label: 'Bug', section: 'Bugs' },
  design: { emoji: '🎨', label: 'Design', section: 'Design' },
  art: { emoji: '🖌️', label: 'Art', section: 'Art' },
  research: { emoji: '🔬', label: 'Research', section: 'Research' },
  chore: { emoji: '⚙️', label: 'Chore', section: 'Chores' },
  other: { section: 'Other' },
  ideation: { emoji: '💡', label: 'Idea', section: 'Ideas' },
};
/** A scheme's promoted list groups, "key: value" each (#253). */
export function listGroupsOf(p) {
  try {
    return JSON.parse(p?.list_groups || '[]');
  } catch {
    return [];
  }
}
export const STATES = {
  ready: { emoji: '✅', label: 'Ready to merge or pick up' },
  try: { emoji: '🧪', label: 'Ready for you to try' },
  parked: { emoji: '🧊', label: 'Parked' },
  blocked: { emoji: '⛔', label: 'Blocked on something outside the minion' },
  outside: { emoji: '⏳', label: 'Waiting on work running elsewhere' },
  'pending-deploy': { emoji: '🚀', label: 'Deployed; dismissed once it is live' },
  limited: { emoji: '⌛', label: 'Hit the usage limit; waiting for it to reset' },
};

export let me = null;
/** The signed-in person as api/me gives it: { name, login, admin, turns }. */
export let account = null;
export let view = null; // { kind, id, ... } for the current screen
let stream = null;
let assetVersion = null;
// Other modules read `view` live but can't assign it, so they replace it through this.
export function setView(next) {
  view = next;
}

// ---------- helpers ----------

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'api/login') {
    me = null;
    renderLogin();
    throw new Error('Not logged in');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/**
 * A scheme's favicon (#222), only ever as an <img> (an SVG there can't run scripts); hidden when it has
 * none, so refreshSchemeCounts can swap it in once a merge brings one.
 */
export function schemeIcon(p) {
  const src = iconSrc(p);
  const img = h('img', { class: 'scheme-icon', 'data-scheme-icon': p.id, src, alt: '', hidden: !src, onerror: () => { img.hidden = true; } });
  return img;
}

const ICONS = { back: 'M10.25 3.5 5.75 8l4.5 4.5', forward: 'M5.75 3.5 10.25 8l-4.5 4.5', close: 'M4 4l8 8M12 4l-8 8', pin: 'M5.5 2.5h5M6.5 2.5v4l-2 3h7l-2-3v-4M8 9.5V14' };
/** A line icon in the text colour. Drawn on its own centre, so it sits dead centre in its button, as a font's glyph doesn't. */
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

/** A cost at API prices, marked as an estimate: "≈ $0.42", "≈ $12". Not a bill on a subscription. */
export function costText(usd) {
  return `≈ $${usd >= 10 ? Math.round(usd) : usd.toFixed(2)}`;
}

export function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function unescapeHtml(s) {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
}

// ---------- files threads show ----------

// What the server will serve from a thread's folders, by extension (mirrors src/artifacts.ts).
const FILE_KINDS = {
  md: 'markdown', markdown: 'markdown', canvas: 'canvas', html: 'html', htm: 'html', pdf: 'pdf', txt: 'text', csv: 'text',
  js: 'text', mjs: 'text', css: 'text', json: 'text',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image',
  mp4: 'video', webm: 'video', mov: 'video', mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio',
  zip: 'download', '7z': 'download', tar: 'download', gz: 'download', tgz: 'download',
};
export const fileKind = (path) => FILE_KINDS[(path.split(/[?#]/)[0].split('.').pop() || '').toLowerCase()] ?? null;
export const baseName = (path) => path.split('/').filter(Boolean).pop() ?? path;
export const fileExt = (path) => (baseName(path).includes('.') ? baseName(path).split('.').pop().slice(0, 5).toUpperCase() : 'FILE');
/** A link target that is a path on disk, not a URL, a fragment or a mail address. */
export const isLocalPath = (href) => !/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href);
export const fileUrl = (ticketId, path) => `api/tickets/${ticketId}/file?path=${encodeURIComponent(path)}`;
export const fileHref = (ticketId, path) => `#/f/${ticketId}/${encodeURIComponent(path)}`;
/** A file people attached to a message, by its name in the thread's uploads folder. */
export const uploadUrl = (ticketId, name) => `api/tickets/${ticketId}/uploads/${encodeURIComponent(name)}`;
export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export const sharedUrl = (projectId, path) => `api/projects/${projectId}/shared/file?path=${encodeURIComponent(path)}`;
export const sharedHref = (projectId, path) => `#/s/${projectId}/${encodeURIComponent(path)}`;
/** A linked path short enough for a card: a thread's shared folder by name, other absolute paths by their tail. */
export function shortPath(path) {
  const projectShared = /\/shared\/project\/(.+)$/.exec(path);
  if (projectShared) return `scheme shared/${projectShared[1]}`;
  const shared = /\/shared\/\d+\/(.+)$/.exec(path);
  if (shared) return `shared files/${shared[1]}`;
  return path.startsWith('/') ? `…/${path.split('/').slice(-2).join('/')}` : path;
}

/** `[title](path)` in a thread's reply: a card that opens the file full screen beside the chat. */
function fileCardHtml(ticketId, path, title) {
  const kind = isLocalPath(path) && fileKind(path);
  if (!kind) return null;
  // An archive has nothing to preview: the card saves it.
  const href = kind === 'download' ? `${fileUrl(ticketId, path)}&download` : fileHref(ticketId, path);
  return `<a class="file-card checking" data-file="${escapeHtml(path)}" href="${escapeHtml(href)}"${kind === 'download' ? ' download' : ''} title="${escapeHtml(path)}">`
    + (kind === 'image' ? `<img src="${escapeHtml(fileUrl(ticketId, path))}" alt="" loading="lazy">` : `<span class="badge k-${kind}">${escapeHtml(fileExt(path))}</span>`)
    + `<span class="text"><span class="name">${title}</span><span class="meta">${escapeHtml(shortPath(path))}</span></span></a>`;
}

/** `![caption](path)` in a thread's reply: the image or video itself (a card for anything else). */
function filePreviewHtml(ticketId, path, caption) {
  const kind = isLocalPath(path) && fileKind(path);
  if (!kind) return null;
  const src = escapeHtml(fileUrl(ticketId, path));
  let media;
  if (kind === 'image') media = `<img src="${src}" alt="${caption}" loading="lazy">`;
  // Muted and looping like a GIF; the file view has the controls.
  else if (kind === 'video') media = `<video src="${src}" muted autoplay loop playsinline preload="metadata"></video>`;
  else return fileCardHtml(ticketId, path, caption || escapeHtml(baseName(path)));
  return `<a class="file-preview checking" data-file="${escapeHtml(path)}" href="${escapeHtml(fileHref(ticketId, path))}" title="${escapeHtml(path)}">${media}`
    + `${caption ? `<span class="caption">${caption}</span>` : ''}</a>`;
}

// What the server found for each file a thread links, by "<thread> <path>": its details, null when
// there's no such file, or undefined when it couldn't say (offline, a restart) (#281).
const linkInfo = new Map();
function fileLinkInfo(ticketId, path) {
  const key = `${ticketId} ${path}`;
  let info = linkInfo.get(key);
  if (!info) {
    info = fetch(`${fileUrl(ticketId, path)}&info&fix`).then((res) => (res.ok ? res.json() : res.status === 404 ? null : undefined)).catch(() => undefined);
    linkInfo.set(key, info);
    // A file that isn't there may be written soon, so ask again after a while.
    info.then((found) => found || setTimeout(() => linkInfo.delete(key), 30_000));
  }
  return info;
}

/**
 * Settle a message's file cards and previews, which can't be clicked until the server has found
 * their file (#281): one with the wrong folders points at the one file of its name the server found
 * instead, and one with no file becomes plain text marked "file not found".
 */
function checkFileLinks(root, ticketId) {
  for (const el of root.querySelectorAll('[data-file]')) {
    const path = el.dataset.file;
    const card = el.classList.contains('file-card');
    const title = card ? el.querySelector('.name').innerHTML : el.querySelector('.caption')?.innerHTML ?? '';
    fileLinkInfo(ticketId, path).then((info) => {
      const t = document.createElement('template');
      if (info?.fixed) t.innerHTML = card ? fileCardHtml(ticketId, info.abs, title) : filePreviewHtml(ticketId, info.abs, title);
      else if (info === null) t.innerHTML = `<span class="file-missing" title="${escapeHtml(`Not found: ${path}`)}">${title || escapeHtml(baseName(path))} <span class="mark">(file not found)</span></span>`;
      const fresh = t.content.firstElementChild ?? el;
      fresh.classList.remove('checking');
      if (fresh !== el) el.replaceWith(fresh);
    });
  }
}

/** Resolve `rel` against the folder `dir` (both "/"-separated), as a document's relative links are. */
export function joinPath(dir, rel) {
  if (rel.startsWith('/')) return rel;
  const parts = dir ? dir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '..' && parts.length && parts[parts.length - 1] !== '..' && parts[parts.length - 1] !== '') parts.pop();
    else if (seg === '..') parts.push('..');
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/') || '.';
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Link "#12" in some HTML to thread 12 of the project on screen, titled with its name when known,
 * "Delve #12" to Delve's, and "PR #186" to the minion owning that PR (see linkPrRefs).
 */
function threadRefsHtml(html) {
  if (view?.kind !== 'project') return html;
  return linkThreadRefs(html, view.projectId, (n) => {
    for (const t of view.tickets.values()) if (t.number === n) return threadLabel(t);
    return null;
  }, view.projects, prRefRoute);
}

/** Plain text as nodes, with its "#12"s linked (see threadRefsHtml). */
export function threadRefs(text) {
  const span = document.createElement('span');
  span.innerHTML = threadRefsHtml(escapeHtml(String(text ?? '')));
  return [...span.childNodes];
}

/**
 * Markdown in chat messages: the document renderer below (tables, headings, lists, quotes…), with
 * single line breaks kept as typed. With `ticketId`, links to paths in that thread's folders become
 * file cards and `![…](path)` an inline preview; both open the file full screen beside the chat.
 */
export function markdown(src, ticketId = null) {
  return markdownDoc(src, { ticketId, breaks: true });
}

/**
 * Fuller Markdown for documents threads write (see renderMarkdown): `imageUrl` maps an image's path to
 * a URL (or null to show the alt text instead), and `linkHref` a link to another file to the route
 * that opens it (or null to leave it inert). A link to "#a-heading" scrolls to that heading.
 */
export function markdownDoc(src, opts = {}) {
  const { imageUrl = () => null, linkHref = () => null, ticketId = null, breaks = false } = typeof opts === 'function' ? { imageUrl: opts } : opts;
  const link = (href, text) => {
    // In a thread's messages, files in its folders become cards (see fileCardHtml).
    const card = ticketId != null && fileCardHtml(ticketId, href, text);
    if (card) return card;
    // Links into this app (a thread, an artifact…) switch view in place; others open a new tab.
    const route = inAppHash(href, location) ?? (isLocalPath(href) && fileKind(href) ? linkHref(href.split('#')[0]) : null);
    if (route) return `<a href="${escapeHtml(route)}">${text}</a>`;
    const pr = prLinkOpen(escapeHtml(href), prUrlRoute(href));
    if (pr) return `${pr}${text}</a>`;
    if (/^https?:\/\//i.test(href)) return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${text}</a>`;
    if (/^#[^/]/.test(href)) return `<a href="${escapeHtml(href)}" class="anchor">${text}</a>`;
    return `<span class="link" title="${escapeHtml(href)}">${text}</span>`;
  };
  const image = (href, alt) => {
    const preview = ticketId != null && filePreviewHtml(ticketId, href, alt);
    if (preview) return preview;
    const url = imageUrl(href);
    return url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt="${alt}" title="${alt}" loading="lazy"></a>`
      : `<span class="muted">[image: ${alt}]</span>`;
  };
  const text = (html) => threadRefsHtml(linkUrls(html, location, (url) => prUrlRoute(unescapeHtml(url))));
  // Citadel UI's element (ui/markdown.js), so Citadel and the apps draw markdown with one stylesheet;
  // .md carries Citadel's own extras (file cards, chat headings in style.css). Headings as written.
  const div = markdownElement(src, { link, image, text, breaks, headingBase: 1 });
  div.classList.add('md');
  if (ticketId != null) checkFileLinks(div, ticketId);
  // "#a-heading" would change the app's route, so scroll to the heading instead.
  div.addEventListener('click', (e) => {
    const a = e.target.closest?.('a.anchor');
    if (!a) return;
    e.preventDefault();
    let id = a.getAttribute('href').slice(1);
    try { id = decodeURIComponent(id); } catch {}
    div.querySelector(`[data-slug="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  return div;
}

// The chat follows new output only while you are at the bottom. Tracked on scroll rather than
// measured when output arrives, so a burst of events can't misjudge it, and kept tight so that
// scrolling up even a little leaves you where you are.
const BOTTOM_SLACK = 24;
// In the full-screen file viewer the chat scrolls in its own column instead of the page.
export const chatScroller = () => document.querySelector('dialog.viewer[open] > .chat');
const atBottom = () => {
  const el = chatScroller();
  return el ? el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_SLACK
    : window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - BOTTOM_SLACK;
};
export let followChat = true;
// Captured, so the viewer's chat column (whose scroll events don't bubble) counts too.
document.addEventListener('scroll', (e) => {
  if (e.target !== document && e.target !== chatScroller()) return;
  followChat = atBottom();
  document.querySelector('.to-latest')?.toggleAttribute('hidden', followChat);
}, { passive: true, capture: true });
export function scrollToBottom() {
  const el = chatScroller();
  if (el) el.scrollTop = el.scrollHeight;
  else window.scrollTo(0, document.documentElement.scrollHeight);
  followChat = true;
}
// Images finish loading after they are added; stay pinned to the bottom if you were following.
document.addEventListener('load', (e) => {
  if (followChat && e.target.tagName === 'IMG' && e.target.closest('#log')) scrollToBottom();
}, true);

/** Which side panels (artifacts shelf, threads list) are open on wide screens. */
export function loadPanelState() {
  try { return JSON.parse(localStorage.getItem('cc-panels')) ?? {}; } catch { return {}; }
}
export function savePanelState(state) {
  try { localStorage.setItem('cc-panels', JSON.stringify(state)); } catch {}
}

/** Where each thread was scrolled to, so coming back lands in the same place. */
function saveScroll() {
  if (view?.kind !== 'project' || !view.id) return;
  try { sessionStorage.setItem(`cc-scroll:${view.id}`, JSON.stringify(followChat ? 'bottom' : window.scrollY)); } catch {}
}

export function restoreScroll(ticketId) {
  let saved = 'bottom';
  try { saved = JSON.parse(sessionStorage.getItem(`cc-scroll:${ticketId}`)) ?? 'bottom'; } catch {}
  if (saved === 'bottom') scrollToBottom();
  else window.scrollTo(0, saved);
}

/**
 * Open a chat at its first unread message, just under the thread bar, unless all that's new fits at
 * the bottom. The thread bar fills in (readout, branch) and images load just after opening, so it
 * keeps the message there for a moment, until you scroll yourself.
 */
export function scrollToUnread(el) {
  scrollToBottom();
  const headEl = document.getElementById('ticket-head');
  const align = () => {
    const head = headEl?.getBoundingClientRect().bottom ?? 0;
    const top = el.getBoundingClientRect().top;
    if (top < head || !followChat) window.scrollTo(0, top + window.scrollY - head - 8);
    // Set now, not on the scroll event, so events caught up right after don't pull you back down.
    if (top < head) followChat = false;
  };
  align();
  if (followChat) return;
  const settle = new ResizeObserver(align);
  const stop = () => {
    settle.disconnect();
    for (const type of USER_SCROLL) removeEventListener(type, stop, true);
  };
  for (const type of USER_SCROLL) addEventListener(type, stop, { capture: true, passive: true });
  for (const target of [headEl, document.getElementById('log')]) if (target) settle.observe(target);
  setTimeout(stop, 3000);
}
export const USER_SCROLL = ['wheel', 'touchstart', 'keydown', 'pointerdown'];

window.addEventListener('pagehide', saveScroll);

// ---------- live updates ----------

let streamRetry = 0;
let streamTimer = null;

function connectStream(catchUp = false) {
  if (stream || !me) return;
  clearTimeout(streamTimer);
  const es = new EventSource('api/stream');
  stream = es;
  es.onopen = () => {
    streamRetry = 0;
    // Anything broadcast while we were disconnected was missed; fetch it.
    if (catchUp) resync();
    catchUp = true;
  };
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'hello') {
      // The server restarted with a different front end; load it instead of running stale code.
      if (assetVersion && msg.version !== assetVersion) {
        reloadPending = true;
        reloadWhenIdle();
      }
      assetVersion ??= msg.version;
    }
    if (msg.type === 'hello' || msg.type === 'codex') {
      codex = msg.codex ?? null;
      if (msg.type === 'codex') renderUsage();
      renderModelPicker();
    }
    if (msg.type === 'hello' || msg.type === 'usage') {
      renderUsage(msg.usage);
      // Rows of minions that hit the usage limit count down to its reset.
      if (view?.kind === 'project') renderSidebar();
    }
    if (msg.type === 'turn') renderCost();
    if (msg.type === 'ticket') onTicketUpdate(msg.ticket);
    if (msg.type === 'person_note') onPersonNote(msg);
    if (msg.type === 'ticket_pin') onTicketPin(msg);
    if (msg.type === 'event') {
      onEvent(msg.event);
      inboxEvent(msg.event);
    }
    if (msg.type === 'artifacts') onArtifactsChanged(msg.projectId);
    if (msg.type === 'artifact-data') onArtifactData(msg.store);
    if (msg.type === 'project') onProjectUpdate(msg.project);
    if (msg.type === 'app-instructions') onAppInstructionsUpdate(msg.instructions);
    if (msg.type === 'properties') onPropertiesChanged(msg.projectId);
    if (msg.type === 'schedules') onSchedulesChanged(msg.projectId);
    if (msg.type === 'views') onViewsChanged(msg.projectId, msg.name);
    if (msg.type === 'hidden') onHiddenChanged(msg.name);
    if (msg.type === 'machines') onMachinesUpdate(msg.machines);
    if (msg.type === 'branch' && view?.kind === 'project' && view.id === msg.ticketId) renderBranch(msg.status);
  };
  es.onerror = () => {
    // EventSource retries dropped connections itself, but gives up for good on a non-200
    // reply (e.g. Caddy's 502 while the server restarts), so reconnect by hand then.
    if (es.readyState !== EventSource.CLOSED) return;
    es.close();
    if (stream === es) stream = null;
    streamTimer = setTimeout(() => connectStream(true), Math.min(30_000, 1000 * 2 ** streamRetry++));
  };
}

// ---------- front-end updates ----------

// A new front end only loads between messages: never while something is half-written or
// being typed, so an update can't yank the page out from under you.
let reloadPending = false;
let lastInputAt = 0;
export let sending = 0;
export function setSending(n) {
  sending = n;
}
const QUIET_MS = 5000;

document.addEventListener('input', () => { lastInputAt = Date.now(); }, true);
document.addEventListener('keydown', () => { lastInputAt = Date.now(); }, true);

function hasUnsentWork() {
  if (sending || Date.now() - lastInputAt < QUIET_MS) return true;
  if (document.querySelector('.attachments:not([hidden])') || uploadsRunning()) return true;
  return [...app.querySelectorAll('[data-draft]')].some((el) => el.value.trim());
}

export function reloadNow() {
  // Put the cursor back in the composer if that is where it was.
  if (document.activeElement?.matches('.composer textarea')) {
    try { sessionStorage.setItem('cc-refocus', '1'); } catch {}
  }
  location.reload();
}

export function reloadWhenIdle() {
  if (!reloadPending) return;
  if (!hasUnsentWork()) return reloadNow();
  if (!document.getElementById('update-banner')) {
    const banner = h('div', { class: 'update-banner', id: 'update-banner' },
      'A new version is ready and will load once you have sent or cleared what you are writing. ',
      h('button', { class: 'secondary small', onclick: reloadNow }, 'Refresh now'),
      h('span', { class: 'muted' }, ' (drafts are kept)'));
    document.querySelector('.topbar').after(banner);
    // Sticky bars and panels sit below the banner (style.css, --banner-h); it wraps on narrow screens.
    new ResizeObserver(() => document.documentElement.style.setProperty('--banner-h', `${banner.getBoundingClientRect().height}px`)).observe(banner);
  }
}

setInterval(reloadWhenIdle, 2000);

// ---------- account usage ----------

export let usage = null;
/** The person's Codex (#337): { ready, why, on, usage }, or null when nobody is signed in. */
export let codex = null;
let codexHint = '';

/** A weekly-limit bar; one lives in the top bar and one in a project's side panel. */
export const usageMeter = () => h('div', { class: 'usage', hidden: true },
  h('span', { class: 'label' }), h('span', { class: 'track' }, h('span', { class: 'fill' })), costChip());

/** Fill in every usage bar from the latest usage report from Claude turns. */
export function renderUsage(next = usage) {
  usage = next;
  const week = usage?.weekly;
  for (const el of document.querySelectorAll('.usage:not(.codex)')) {
    el.hidden = !week;
    if (!week) continue;
    const pct = Math.round(Math.min(1, Math.max(0, week.utilization)) * 100);
    el.querySelector('.label').textContent = `Week ${pct}%`;
    el.style.setProperty('--pct', `${pct}%`);
    el.dataset.level = week.status && week.status !== 'allowed' ? 'error' : pct >= 90 ? 'error' : pct >= 75 ? 'warn' : '';
    const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    el.title = [
      `Weekly usage of your Claude plan: ${pct}%${week.resetsAt ? `, resets ${when(week.resetsAt)}` : ''}`,
      usage.session ? `5-hour window: ${Math.round(usage.session.utilization * 100)}%${usage.session.resetsAt ? `, resets ${when(usage.session.resetsAt)}` : ''}` : null,
      `As of the last turn, ${ago(usage.updatedAt)}`,
    ].filter(Boolean).join('\n');
  }
  for (const el of document.querySelectorAll('.usage:not(.codex)')) renderCodexSwitch(renderCodexMeter(el));
  for (const el of document.querySelectorAll('.codex-toggle')) syncToggle(el);
  for (const el of document.querySelectorAll('.codex-windows')) fillCodexWindows(el);
}

/** A bar in the Claude bar's look (#342); `.codex` keeps it out of the Claude bars' loops. */
const codexBar = () => h('div', { class: 'usage codex', hidden: true }, h('span', { class: 'label' }), h('span', { class: 'track' }, h('span', { class: 'fill' })), h('span', { class: 'which' }));
const setBar = (bar, pct, label) => {
  bar.querySelector('.label').textContent = label;
  bar.style.setProperty('--pct', `${pct}%`);
  bar.dataset.level = codexLevel(pct);
};
const windowText = (w) => `${windowName(w.windowDurationMins)}: ${w.pct}%${w.resetsAt && w.pct ? `, resets ${when(w.resetsAt * 1000)}` : ''}`;

/** Directly under each Claude bar, Codex's own while either of its windows is above 75% (Josh, 2026-11-05). */
function renderCodexMeter(meter) {
  let bar = meter.nextElementSibling?.matches('.usage.codex') ? meter.nextElementSibling : null;
  if (!bar) meter.after((bar = codexBar()));
  bar.hidden = !codex || !codexHigh(codex.usage);
  if (bar.hidden) return bar;
  const top = codexTop(codex.usage);
  setBar(bar, top, `Codex ${top}%`);
  // Which window it is, where the Claude bar has its cost chip.
  bar.querySelector('.which').textContent = windowName(codexWindows(codex.usage).find((w) => w.pct === top)?.windowDurationMins).replace(' window', '');
  bar.title = [...codexWindows(codex.usage).map(windowText), `As of the last Codex read, ${ago(codex.usage.updatedAt)}`].join('\n');
  return bar;
}

/** Settings' Codex card: a bar for each window and when it resets, or "No usage yet". */
export function codexWindowsBlock() {
  const el = h('div', { class: 'codex-windows' });
  fillCodexWindows(el);
  return el;
}

function fillCodexWindows(el) {
  const ws = codexWindows(codex?.usage);
  if (!ws.length) return el.replaceChildren(h('p', { class: 'muted small' }, 'Codex usage: no usage yet. It fills in after your first Codex turn.'));
  el.replaceChildren(h('dl', { class: 'kv' }, ...ws.flatMap((w) => {
    const bar = codexBar();
    bar.hidden = false;
    setBar(bar, w.pct, `${w.pct}%`);
    return [h('dt', {}, windowName(w.windowDurationMins)), h('dd', {}, bar, w.resetsAt && w.pct ? h('span', { class: 'muted' }, `resets ${when(w.resetsAt * 1000)}`) : '')];
  })), h('p', { class: 'muted small' }, `Codex usage as of ${ago(codex.usage.updatedAt)}.`));
}

const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const live = (w) => w && (!w.resetsAt || w.resetsAt > Date.now());
/** A Claude window is past 90% (or out): the left panel offers the override then (Josh, 2026-11-05). */
const claudeHigh = () => [usage?.session, usage?.weekly].some((w) => live(w) && (w.status === 'rejected' || w.utilization >= 0.9));

/** "Enable Codex override" (#337): runs the person's turns on Codex. Settings has one; the left panel shows one past 90%. */
export function codexToggle() {
  const box = h('input', { type: 'checkbox', onchange: () => flipCodex(box) });
  const el = h('span', { class: 'codex-toggle' },
    h('label', { class: 'toggle', title: 'Run your turns on Codex (OpenAI) instead of Claude: minions, Taskmasters and apps. A Claude model picked for a minion runs as the Codex model of the same tier.' }, box, 'Enable Codex override'),
    h('span', { class: 'hint', hidden: true }));
  syncToggle(el);
  return el;
}

function syncToggle(el) {
  const box = el.querySelector('input');
  box.checked = !!codex?.on;
  box.disabled = !codex || (!codex.on && !codex.ready);
  const hint = codexHint || (codex && !codex.on && !codex.ready ? `Codex isn't ready: ${codex.why}.` : '');
  el.querySelector('.hint').textContent = hint;
  el.querySelector('.hint').hidden = !hint;
}

/** The Settings card's fresh view of the override (it changes when Codex signs in or out). */
export function setCodex(next) {
  codex = next ?? null;
  renderUsage();
  renderModelPicker();
}

/** Under each usage bar (after Codex's), past 90% or while on: the override, Codex's own usage, and after Claude's reset a word that Claude is back. */
function renderCodexSwitch(bar) {
  let sw = bar.nextElementSibling?.classList.contains('codex-switch') ? bar.nextElementSibling : null;
  if (!sw) {
    sw = h('div', { class: 'codex-switch', hidden: true }, codexToggle(), h('span', { class: 'codex-usage' }), h('span', { class: 'claude-back' }, "Claude's back"));
    bar.after(sw);
  }
  sw.hidden = !codex || !(codex.on || claudeHigh());
  if (sw.hidden) return;
  sw.querySelector('.claude-back').hidden = !codex.on || claudeHigh();
  const ws = [codex.usage?.primary, codex.usage?.secondary].filter(Boolean);
  const cu = sw.querySelector('.codex-usage');
  // Codex's own bar above says it already.
  cu.hidden = !codex.on || !ws.length || !bar.hidden;
  if (cu.hidden) return;
  const top = Math.round(Math.max(...ws.map((w) => w.usedPercent)));
  cu.textContent = `Codex ${top}%`;
  cu.dataset.level = top >= 90 ? 'error' : top >= 75 ? 'warn' : '';
  const span = (m) => (m === 300 ? '5-hour window' : m === 10080 ? 'Weekly' : m ? `${Math.round(m / 60)}-hour window` : 'Window');
  cu.title = [...ws.map((w) => `${span(w.windowDurationMins)}: ${Math.round(w.usedPercent)}%${w.resetsAt ? `, resets ${when(w.resetsAt * 1000)}` : ''}`), `As of the last Codex turn, ${ago(codex.usage.updatedAt)}`].join('\n');
}

async function flipCodex(box) {
  box.disabled = true;
  codexHint = '';
  try {
    codex = await api('api/me/codex/switch', { method: 'PUT', body: { on: box.checked } });
  } catch (err) {
    codexHint = err.message;
  }
  renderUsage();
  renderModelPicker();
}

// Phones and sleeping laptops drop connections quietly; recheck when the page comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !me) return;
  if (!stream) connectStream(true);
  else if (view?.kind === 'project') resync();
});

async function resync() {
  if (view?.kind !== 'project') return route();
  // Refresh in place so a half-typed message in the composer survives.
  try {
    const [{ coordinator, tickets, seen, person_notes, pins }, artifacts, chat] = await Promise.all([
      api(`api/projects/${view.projectId}`),
      api(`api/projects/${view.projectId}/artifacts`),
      view.id ? api(`api/tickets/${view.id}`) : null,
    ]);
    view.coordinator = coordinator;
    view.tickets = new Map(tickets.map((t) => [t.id, t]));
    view.seen = seen ?? view.seen;
    view.personNotes = person_notes ?? view.personNotes;
    view.pins = pins ?? view.pins;
    if (view.id) markSeen(view.id);
    renderSidebar();
    // Cards raised or settled while the stream was down, here or in other schemes.
    forgetOtherSchemes();
    refreshInbox();
    refreshSchemeCounts();
    setArtifacts(artifacts);
    if (!chat) return;
    view.ticket = chat.ticket;
    renderTicketHead();
    if (view.ticket.branch) refreshBranch(view.id);
    await catchUpEvents();
  } catch {}
}

// Threads' histories downloaded this session, each its newest page or more ({ events, more, tasks },
// as the events route gives it), so reopening one only fetches what is new. Events are append-only,
// so the cached part never goes stale. Most recently used last.
const eventCache = new Map();
const EVENT_CACHE_THREADS = 12;

function remember(ticketId, page) {
  eventCache.delete(ticketId);
  eventCache.set(ticketId, page);
  if (eventCache.size > EVENT_CACHE_THREADS) eventCache.delete(eventCache.keys().next().value);
}

/** A thread's newest page of history, from the cache topped up with what came since, or fetched. */
export async function loadEvents(ticketId) {
  // A prefetch already on its way is the head start: wait for it, then fetch only what came after.
  await prefetching.get(ticketId);
  const cached = eventCache.get(ticketId);
  const page = cached ?? await api(`api/tickets/${ticketId}/events`);
  if (cached) {
    const fresh = await api(`api/tickets/${ticketId}/events?after=${page.events.at(-1)?.id ?? 0}`);
    // Another load, or live events, may have added some of these while this one was on its way.
    const last = page.events.at(-1)?.id ?? 0;
    page.events = page.events.concat(fresh.filter((e) => e.id > last));
  }
  remember(ticketId, page);
  return page;
}

/** Add the page before the oldest loaded event to a thread's history; with `from`, reach back to that event. */
export async function loadEarlier(ticketId, page, from) {
  const older = await api(`api/tickets/${ticketId}/events?before=${page.events[0].id}${from ? `&from=${from}` : ''}`);
  Object.assign(page, { events: older.events.concat(page.events), more: older.more, tasks: older.tasks });
  remember(ticketId, page);
  return page;
}

// Prefetching: a thread's newest page starts downloading when you point at (or touch) its row, and
// the top two rows load quietly once a project page settles, so a first click opens from the cache.
// A prefetch only fills a free cache slot, never evicting a thread you actually opened.
const prefetching = new Map(); // ticket id -> its download in flight
const PREFETCH_ROWS = 2;

function prefetchEvents(ticketId) {
  if (eventCache.has(ticketId) || prefetching.has(ticketId) || eventCache.size >= EVENT_CACHE_THREADS) return prefetching.get(ticketId) ?? Promise.resolve(); // always a promise: prefetchTopRows chains on it
  const p = api(`api/tickets/${ticketId}/events`)
    .then((page) => { if (!eventCache.has(ticketId) && eventCache.size < EVENT_CACHE_THREADS) eventCache.set(ticketId, page); })
    .catch(() => {})
    .finally(() => prefetching.delete(ticketId));
  prefetching.set(ticketId, p);
  return p;
}

const rowTicketId = (el) => Number(el?.closest?.('a.thread-row[data-id]')?.dataset.id) || null;
for (const type of ['pointerover', 'touchstart']) {
  document.addEventListener(type, (e) => {
    const id = rowTicketId(e.target);
    if (id && id !== view?.id) prefetchEvents(id);
  }, { passive: true });
}

/** Once the page is idle, load the first two minions in the list. Not on data saver. */
export function prefetchTopRows() {
  if (navigator.connection?.saveData) return;
  const whenIdle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500));
  whenIdle(async () => {
    const ids = [...document.querySelectorAll('#threads > section a.thread-row[data-id]')]
      .map(rowTicketId).filter((id) => id && id !== view?.id).slice(0, PREFETCH_ROWS);
    const next = () => (ids.length ? prefetchEvents(ids.shift()).then(next) : null);
    await Promise.all([next(), next()]);
  });
}

export async function catchUpEvents() {
  if (!view.id) return;
  const events = await api(`api/tickets/${view.id}/events?after=${view.lastEventId}`);
  for (const ev of events) if (ev.id > view.lastEventId) appendEvent(ev);
}

function onTicketUpdate(ticket) {
  if (view?.kind !== 'project') return;
  if (view.projectId !== ticket.project_id) return inboxOtherTicket(ticket);
  const before = ticket.kind === 'coordinator' ? view.coordinator : view.tickets.get(ticket.id);
  if (ticket.kind === 'coordinator') view.coordinator = ticket;
  else view.tickets.set(ticket.id, ticket);
  inboxTicket(before, ticket);
  renderSidebar();
  if (view.id === ticket.id) {
    view.ticket = ticket;
    renderTicketHead();
    // You're looking at it, so whatever it changed to is seen too.
    if (document.visibilityState === 'visible') markSeen(ticket.id);
  }
}

/** You pinned or unpinned a minion, maybe in another tab (#179); others' pins aren't yours to show. */
export function onTicketPin({ name, projectId, ticketId, pinned }) {
  if (name !== me || view?.kind !== 'project' || view.projectId !== projectId || !view.pins) return;
  view.pins = view.pins.filter((id) => id !== ticketId);
  if (pinned) view.pins.push(ticketId);
  renderSidebar();
  if (view.id === ticketId) renderTicketHead();
}

/** Someone set or cleared people's note on a minion (#146). */
function onPersonNote({ projectId, ticketId, note }) {
  if (view?.kind !== 'project' || view.projectId !== projectId || !view.personNotes) return;
  if (note) view.personNotes[ticketId] = note;
  else delete view.personNotes[ticketId];
  renderSidebar();
  if (view.id === ticketId) renderTicketHead();
}

// ---------- seen ----------

const seenTimers = new Map();
/** Record that you have looked at a thread as it is now (shortly, so a burst of updates sends one). */
export function markSeen(ticketId) {
  if (seenTimers.has(ticketId)) return;
  seenTimers.set(ticketId, setTimeout(async () => {
    seenTimers.delete(ticketId);
    try {
      const { seen_at } = await api(`api/tickets/${ticketId}/seen`, { method: 'POST', body: {} });
      if (view?.kind !== 'project') return;
      view.seen[ticketId] = seen_at;
      renderSidebar();
    } catch {}
  }, 800));
}

/** A thread you have opened since it last changed. */
export const isSeen = (t) => (view.seen?.[t.id] ?? 0) >= t.updated_at;

function onEvent(event) {
  if (view?.kind !== 'project' || view.id !== event.ticket_id) return;
  if (event.id <= view.lastEventId) return;
  appendEvent(event);
}

// ---------- routing ----------

// Bumped on every navigation, so a slow load that another click has overtaken is dropped.
export let routeSeq = 0;

async function route() {
  if (!me) return;
  const jump = jumpParts(location.hash);
  if (jump) {
    // Open the chat at its plain address, so Back and a reload don't jump again; its mountChat takes the jump.
    pendingJump = jump;
    return replaceHash(jump.hash);
  }
  // Under a contraption's frame the page keeps its scroll; it's saved when you left it for the frame.
  if (!framed()) saveScroll();
  const seq = ++routeSeq;
  const hash = location.hash || '#/';
  let m;
  // A contraption in Citadel's window (frames.js): Citadel's page stays as it was underneath.
  if ((m = hash.match(/^#\/apps\/([a-z0-9][a-z0-9-]{0,31})$/))) return showFrame(m[1]);
  if ((m = hash.match(/^#\/share(\?.*)?$/))) return takeShare(m[1] ?? '');
  hideFrames();
  // A jump left by a route that never opened its chat mustn't fire on a later, ordinary visit.
  if (pendingJump?.hash !== hash) pendingJump = null;
  // Answer the click straight away: highlight the thread being opened and dim the old view.
  for (const a of document.querySelectorAll('#coordinator-row .thread-row, #threads .thread-row')) a.classList.toggle('active', a.getAttribute('href') === hash);
  document.body.classList.add('navigating');
  try {
    // Leaving the file viewer for the chat under it just closes it; anywhere else goes on from there.
    if (!hash.startsWith('#/f/') && closeViewer() === hash) {
      const jump = takeJump();
      if (jump) jumpToEvent(jump);
      return;
    }
    if ((m = hash.match(/^#\/p\/(\d+)$/))) await showProject(Number(m[1]));
    else if ((m = hash.match(/^#\/p\/(\d+)\/artifacts$/))) await showProject(Number(m[1]), { kind: 'artifacts' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/(?:settings|instructions)$/))) await showProject(Number(m[1]), { kind: 'instructions' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/app-instructions$/))) await showProject(Number(m[1]), { kind: 'app-instructions' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/approvals$/))) await showProject(Number(m[1]), { kind: 'approvals' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/properties$/))) await showProject(Number(m[1]), { kind: 'properties' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/(members|people|contraptions|account)$/))) await showProject(Number(m[1]), { kind: m[2] });
    else if ((m = hash.match(/^#\/p\/(\d+)\/machines$/))) await showProject(Number(m[1]), { kind: 'machines' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/shared$/))) await showProject(Number(m[1]), { kind: 'sharedList' });
    else if ((m = hash.match(/^#\/a\/(\d+)$/))) await showArtifact(Number(m[1]));
    else if ((m = hash.match(/^#\/s\/(\d+)\/(.+)$/))) await showSharedFile(Number(m[1]), decodeURIComponent(m[2]));
    else if ((m = hash.match(/^#\/f\/(\d+)\/(.+)$/))) await showFile(Number(m[1]), decodeURIComponent(m[2]));
    else if ((m = hash.match(/^#\/p\/(\d+)\/t\/(\d+)$/))) await showProject(Number(m[1]), { kind: 'chat', number: Number(m[2]) });
    else if ((m = hash.match(/^#\/t\/(\d+)$/))) await showTicket(Number(m[1]));
    else await openStartScheme();
  } catch (err) {
    if (err.message !== 'Not logged in' && seq === routeSeq) app.replaceChildren(h('p', { class: 'error' }, err.message));
  } finally {
    if (seq === routeSeq) document.body.classList.remove('navigating');
  }
}

/** A share from the phone's Share sheet (#375): the contraption that takes it, filled in; else home, saying so. */
async function takeShare(search) {
  let mine = [];
  try {
    mine = await api('api/contraptions/mine');
  } catch (err) {
    if (err.message === 'Not logged in') return; // the login is showing; the share is still in the address for after
  }
  const to = shareTarget(search, mine);
  if (!to) {
    toast('Nothing here takes shares');
    return replaceHash('#/');
  }
  showFrame(to.name, to.src);
  replaceHash(`#/apps/${to.name}`);
}

window.addEventListener('hashchange', route);

// A plain click on any link into this app (even a full https://… one, or one marked to open a new
// tab) switches view through the router instead of opening a tab or reloading the page.
// Ctrl/Cmd/Shift/middle-click still open it in a new tab or window.
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.('a[href]');
  if (!a || a.hasAttribute('download')) return;
  pointPrLink(a);
  const hash = inAppHash(a.getAttribute('href'), location);
  if (!hash) return;
  e.preventDefault();
  openHash(hash);
});

// A pull request goes to the minion that owns it instead of GitHub: PR links and "PR #186"s are
// rendered that way once api/prs has loaded. Ones rendered before it are re-pointed when it
// arrives, and a GitHub link's href is also swapped as the pointer or focus reaches it.
let prRepos = null;
let prList = null; // the same, as a list: two schemes may share a repo
let prsAt = 0;
function loadPrs() {
  if (Date.now() - prsAt < 5 * 60_000) return;
  prsAt = Date.now();
  api('api/prs').then((r) => {
    prList = r;
    prRepos = new Map(r.map((x) => [x.repo, x]));
    linkPrRefs();
  }).catch(() => {});
}
/** Where a GitHub PR link should go instead (see prOwnerRoute); null until api/prs has loaded. */
const prUrlRoute = (href) => prOwnerRoute(prRepos, href);
/** Where "PR #n" said in scheme `projectId` goes (see prNumberRoute); one not known yet looks again, at most every 5 minutes. */
function prRefRoute(projectId, n) {
  const to = prNumberRoute(prList, projectId, n);
  if (!to) loadPrs();
  return to;
}
/** Point the PR links, "PR #186"s and "#N"s that are no minion at their owners or GitHub, now that api/prs is known. */
function linkPrRefs() {
  for (const a of document.querySelectorAll('a[href^="https://github.com/"]')) pointPrLink(a);
  for (const span of document.querySelectorAll('span.pr-ref')) {
    const to = prRefRoute(Number(span.dataset.project), Number(span.dataset.pr));
    if (to?.hash) span.replaceWith(h('a', { class: 'thread-ref', href: to.hash, title: to.title }, ...span.childNodes));
    else if (to?.url) span.replaceWith(h('a', { href: to.url, target: '_blank', rel: 'noopener', title: to.title }, ...span.childNodes));
  }
}
function pointPrLink(a) {
  if (!a.href.startsWith('https://github.com/') || a.dataset.github != null) return;
  loadPrs();
  const to = prOwnerRoute(prRepos, a.getAttribute('href'));
  if (!to) return;
  a.dataset.prUrl = a.getAttribute('href');
  a.setAttribute('href', to.hash);
  a.removeAttribute('target');
  a.title = to.title;
}
for (const type of ['pointerover', 'focusin']) {
  document.addEventListener(type, (e) => { const a = e.target.closest?.('a[href^="https://github.com/"]'); if (a) pointPrLink(a); });
}

// ---------- login ----------

function renderLogin() {
  view = null;
  hideRail();
  dropFrames();
  crumbs.replaceChildren();
  meEl.replaceChildren();
  app.replaceChildren(document.getElementById('login-tpl').content.cloneNode(true));
  const form = document.getElementById('login-form');
  // A saved login that is really the site's address (filled in by a phone's password manager) is dropped.
  try { const saved = localStorage.getItem('cc-login') || ''; form.login.value = /^https?\W|\//i.test(saved) ? '' : saved; } catch {}
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('login-error');
    try {
      await api('api/login', { method: 'POST', body: { login: form.login.value, password: form.password.value } });
      try { localStorage.setItem('cc-login', form.login.value.trim()); } catch {}
      // A contraption's page sent here by /apps/'s login gate (src/apps.ts) goes back to it.
      const next = new URLSearchParams(location.search).get('next');
      if (next && /^\/apps\/[a-z0-9-]+\//.test(next)) return void location.assign(next);
      start(await api('api/me'));
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
}

/** The page an invite or reset link opens: it names who the link is for and sets their password. */
export function renderInvite(token) {
  view = null;
  crumbs.replaceChildren();
  meEl.replaceChildren();
  app.replaceChildren(document.getElementById('invite-tpl').content.cloneNode(true));
  const form = document.getElementById('invite-form');
  const who = document.getElementById('invite-who');
  const err = document.getElementById('invite-error');
  const path = `api/invite/${encodeURIComponent(token)}`;
  api(path).then((r) => {
    who.replaceChildren('This sets the password for ', h('strong', {}, r.name), ', who signs in as ', h('strong', {}, r.login), '.');
    form.login.value = r.login;
    form.querySelector('button').disabled = false;
  }).catch((ex) => { who.textContent = ex.message; who.className = 'error'; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (form.password.value !== form.again.value) {
      err.textContent = 'The two passwords differ.';
      err.hidden = false;
      return;
    }
    try {
      await api(path, { method: 'POST', body: { password: form.password.value } });
      try { localStorage.setItem('cc-login', form.login.value); } catch {}
      history.replaceState(null, '', location.pathname);
      start(await api('api/me'));
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
}

export function start(who) {
  account = who;
  me = who.name;
  meEl.replaceChildren(me, h('button', { class: 'secondary', onclick: logout }, 'Sign out'));
  connectStream();
  loadPrs();
  route();
  showRail();
  initAppSwitch(me);
}

export async function logout() {
  initAppSwitch(null);
  // Notifications on this device were for the person signing out.
  await pushOff().catch(() => {});
  await api('api/logout', { method: 'POST', body: {} });
  eventCache.clear();
  clearTimeout(streamTimer);
  stream?.close();
  stream = null;
  me = null;
  account = null;
  renderLogin();
}

// ---------- project: threads sidebar + chat ----------

export const isCoordinator = (t) => t.kind === 'coordinator';

export function statusLabel(t) {
  if (isCoordinator(t) && t.status === 'new') return 'Ready';
  return STATUS_LABEL[t.status];
}

/**
 * Threads are numbered per project and live at #/p/<project>/t/<number>. A server from before
 * per-project numbers sends no number, so fall back to the global id there.
 */
export const threadHref = (t) =>
  isCoordinator(t) ? `#/p/${t.project_id}` : t.number == null ? `#/t/${t.id}` : `#/p/${t.project_id}/t/${t.number}`;

/** A link that opens `t`'s chat scrolled to one thing in it (threadrefs.js jumpParts). */
export const jumpHref = (t, target) => `${threadHref(t)}?e=${target}`;
let pendingJump = null; // { hash, target }: a jump for the chat route() is opening

/** The jump waiting for the chat now open at its address, once (mountChat). */
export function takeJump() {
  const jump = pendingJump;
  pendingJump = null;
  return jump?.hash === location.hash ? jump.target : null;
}

/** Go to an in-app address; a jump within the chat already open scrolls it in place, with no reload and no history entry. */
export function openHash(hash) {
  const jump = jumpParts(hash);
  if (jump && jump.hash === location.hash && view?.kind === 'project' && view.main === 'chat' && view.ticket && threadHref(view.ticket) === jump.hash) return void jumpToEvent(jump.target);
  if (location.hash !== hash) location.hash = hash;
}
/** A scheme's Taskmaster goes by the scheme's name: "Delve Taskmaster". */
export function taskmasterName(projectId = view?.projectId) {
  const p = view?.projects?.find((x) => x.id === projectId) ?? (view?.project?.id === projectId ? view.project : null);
  return p?.name ? `${p.name} Taskmaster` : 'Taskmaster';
}
/** taskmasterName in a span that follows renames of the scheme. */
export const taskmasterLabel = (projectId = view?.projectId) => h('span', { 'data-taskmaster-name': projectId }, taskmasterName(projectId));
export const threadLabel = (t) => (isCoordinator(t) ? taskmasterName(t.project_id) : `#${t.number ?? t.id} ${t.title}`);
/** The full name, Delve style: "🛠️ 12 FEATURE: Usage bar ✅". */
export function threadFullName(t) {
  if (isCoordinator(t)) return taskmasterName(t.project_id);
  const type = TYPES[t.properties?.type];
  const state = t.status !== 'running' && STATES[t.state];
  return [type?.emoji, t.number ?? t.id, type?.label ? `${type.label.toUpperCase()}: ${t.title}` : t.title, state?.emoji].filter(Boolean).join(' ');
}

/** threadFullName in parts; phones hide the type word and state emoji, which the emoji and state label already say. */
export function threadTitleParts(t) {
  if (isCoordinator(t)) return taskmasterLabel(t.project_id);
  const type = TYPES[t.properties?.type];
  const state = t.status !== 'running' && STATES[t.state];
  return [type?.emoji ? `${type.emoji} ` : '', `${t.number ?? t.id} `, type?.label ? h('span', { class: 'wide-only' }, `${type.label.toUpperCase()}: `) : '', t.title,
    state ? h('span', { class: 'wide-only' }, ` ${state.emoji}`) : ''];
}

/** Wrap matches of the text inside el in <mark>, returning the marks in document order. */
export function highlight(el, text) {
  const marks = [];
  if (!text) return marks;
  const needle = text.toLowerCase();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (let node of nodes) {
    let i;
    while ((i = node.data.toLowerCase().indexOf(needle)) >= 0) {
      const match = node.splitText(i);
      node = match.splitText(needle.length);
      const mark = h('mark', { class: 'find' });
      match.replaceWith(mark);
      mark.append(match);
      marks.push(mark);
    }
  }
  return marks;
}

export function clearHighlights(el) {
  for (const mark of el.querySelectorAll('mark.find')) mark.replaceWith(...mark.childNodes);
  el.normalize();
}
