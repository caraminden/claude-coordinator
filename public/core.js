// The app shell: markdown and chat scrolling, live updates, usage, routing and sign-in. What every
// module shares without needing the shell (state, api, h, helpers) is base.js.
import { accountLine, combineWindows } from './claudeusage.js';
import { shouldReload } from './update-when.js';
import { inMerged } from './mine.js';
import { KEPT_EVENTS, reloadQuietly, ago, api, baseName, fileExt, fileHref, fileKind, fileUrl, h, isLocalPath, keepChat, me, missedNews, newsArrived, replayKept, setAccount, setShowLogin, setView, shortPath, threadHref, threadLabel, view } from './base.js';
import { mergeOpen, noteTicketChange } from './closedlist.js';
import { cutEvent } from './eventcut.js';
import { plainKinds } from './settings-pages.js';
import { DESKTOP_PUSH, onAppInstructionsUpdate, onProjectUpdate, pushOff } from './settings.js';
import { onMachinesUpdate } from './settings-machines.js';
import { costSoon } from './cost.js';
import { homeScheme, openStartScheme, renderSidebar, scheduleSidebar } from './sidebar.js';
import { openBroken } from './home.js';
import { forgetSchemes, showProject, showReleases, showTicket } from './project.js';
import { closeViewer, onArtifactsChanged, setArtifacts, showArtifact, showFile, showSharedFile } from './artifacts.js';
import { bridgeTypedAt, bridgeUnsaved, onArtifactData, tabBridgeOpen } from './bridge-host.js';
import { appendEvent, jumpToEvent, renderCardJump } from './thread.js';
import { refreshBranch, renderBranch, renderTicketHead } from './thread-head.js';
import { replaceHash } from './navstack.js';
import { onPropertiesChanged, onViewsChanged } from './properties.js';
import { countsIfOwed, forgetOtherSchemes, holdAnswered, inboxEvent, inboxOtherTicket, inboxTicket, onSeenItems, refreshSchemeCounts } from './inbox.js';
import { onSchedulesChanged } from './schedules.js';
import { onReviewsChanged } from './reviews.js';
import { onHiddenChanged } from './hidden.js';
import { schedulePaintRefs, watchRefs } from './refstate.js';
import { loadReleases, onClaimHolder, onClaims, onReleases } from './releases.js';
import { ciChip, releasesChip, tabOf } from './ci.js';
import { statusChip } from './status.js';
import { inAppHash, jumpParts, showParts, linkThreadRefs, linkUrls, prLinkOpen, prNumberRoute, prOwnerRoute } from './threadrefs.js';
import { attachImage, renderModelPicker, uploadsRunning } from './composer.js';
import { filesUploading } from './files.js';
import { onJobUpdate } from './jobs.js';
import { linkifyHtml, markdownElement } from './ui/markdown.js';
import { lightbox } from './ui/media.js';
import { annotator, canvasBlob, drawable } from './annotate.js';
import { parseMarks } from './ui/marks.js';
import { hideRail, showRail } from './rail.js';
import { appDeployed, deploysMissed, dropFrames, framed, hideFrames, shareTarget, showFrame } from './frames.js';
import { appSrc } from './extlinks.js';
import { toast } from './ui/status.js';
import { optimistic } from './ui/optimistic.js';
import { showPart } from './show-part.js';
import { initAppSwitch } from './appswitch.js';
import { onPresenceMsg, presenceHello, reportPresence } from './presence.js';
import { codexLevel, codexTop, codexWindows, windowName } from './codexusage.js';
import { mountLoginMap } from './login-map.js';

/** Every Settings and Orders page's route, built from the one table of pages (settings-pages.js). */
const PAGE_ROUTE = new RegExp(`^#/p/(\\d+)/(${plainKinds().join('|')})$`);
export const app = document.getElementById('app');
export const crumbs = document.getElementById('crumbs');
const meEl = document.getElementById('me');

let stream = null;
let heardAt = 0; // when the stream last said anything (the focus gate, #1528)
// The front end's version: the page's own (index.html fills it in, #1144), so a page the service worker kept from before
// a ship finds itself stale at the stream's first hello. A page the server didn't fill in takes the first hello's.
let assetVersion = /^[0-9a-f]+$/.test(document.querySelector('meta[name=citadel-version]')?.content ?? '') ? document.querySelector('meta[name=citadel-version]').content : null;

function unescapeHtml(s) {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
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
    holdPicSize(el.querySelector('img'));
    const path = el.dataset.file;
    const card = el.classList.contains('file-card');
    const title = card ? el.querySelector('.name').innerHTML : el.querySelector('.caption')?.innerHTML ?? '';
    fileLinkInfo(ticketId, path).then((info) => {
      const t = document.createElement('template');
      if (info?.fixed) t.innerHTML = card ? fileCardHtml(ticketId, info.abs, title) : filePreviewHtml(ticketId, info.abs, title);
      else if (info === null) t.innerHTML = `<span class="file-missing" title="${escapeHtml(`Not found: ${path}`)}">${title || escapeHtml(baseName(path))} <span class="mark">(file not found)</span></span>`;
      const fresh = t.content.firstElementChild ?? el;
      fresh.classList.remove('checking');
      if (fresh !== el) holdPicSize(fresh.querySelector('img'));
      if (fresh !== el) el.replaceWith(fresh);
    });
  }
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

/** Plain text as nodes, with its URLs, DOIs and "#12"s linked (see threadRefsHtml and linkUrls). */
export function threadRefs(text) {
  const span = document.createElement('span');
  span.innerHTML = threadRefsHtml(linkifyHtml(linkUrls(escapeHtml(String(text ?? '')), location, (url) => prUrlRoute(unescapeHtml(url)))));
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
  // Bare URLs and DOIs already came through `link` (ui/markdown.js), so only #N is left to link.
  const text = threadRefsHtml;
  // Citadel UI's element (ui/markdown.js), so Citadel and the apps draw markdown with one stylesheet;
  // .md carries Citadel's own extras (file cards, chat headings in style.css). Headings as written.
  const div = markdownElement(src, { link, image, text, breaks, headingBase: 1, drawMarks: ticketId != null });
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
  renderCardJump();
}, { passive: true, capture: true });
export function scrollToBottom() {
  const el = chatScroller();
  if (el) el.scrollTop = el.scrollHeight;
  else window.scrollTo(0, document.documentElement.scrollHeight);
  followChat = true;
}
// Images finish loading after they are added; stay pinned to the bottom if you were following.
document.addEventListener('load', (e) => {
  if (e.target.tagName !== 'IMG' || !e.target.closest('#log')) return;
  if (e.target.naturalWidth) picSizes.set(e.target.getAttribute('src'), [e.target.naturalWidth, e.target.naturalHeight]);
  if (followChat) scrollToBottom();
}, true);

// Chat pictures' sizes once one has loaded this session: drawn again (Load earlier, a chat reopened), it holds its box
// before it loads, so nothing under it moves (#1531). shortcut: only seen ones; a size from the server would cover a first load.
const picSizes = new Map(); // src -> [width, height]
export function holdPicSize(img) {
  const size = img && picSizes.get(img.getAttribute('src'));
  if (!size) return;
  img.style.setProperty('--pic-w', `${size[0]}px`);
  img.style.setProperty('--pic-r', `${size[0] / size[1]}`);
  img.classList.add('pic-held');
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
 * Open a chat at its first unread message, just under the thread bar (or as near as the bottom allows,
 * when all that's new fits). The thread bar fills in (readout, branch), images load and the catch-up
 * draws in just after opening, so it keeps the message there for a moment, until you scroll yourself:
 * also when it fitted, or that growth would follow the bottom and push it out of sight (#737).
 */
export function scrollToUnread(el) {
  const headEl = document.getElementById('ticket-head');
  const align = () => {
    if (!el.isConnected) return stop(); // redrawn: the new divider has its own hold
    const head = headEl?.getBoundingClientRect().bottom ?? 0;
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - head - 8);
    // Set now, not on the scroll event, so events caught up right after don't pull you back down.
    followChat = false;
  };
  const settle = new ResizeObserver(align);
  const stop = () => {
    settle.disconnect();
    for (const type of USER_SCROLL) removeEventListener(type, stop, true);
  };
  align();
  for (const type of USER_SCROLL) addEventListener(type, stop, { capture: true, passive: true });
  for (const target of [headEl, document.getElementById('log')]) if (target) settle.observe(target);
  setTimeout(stop, 3000);
}
export const USER_SCROLL = ['wheel', 'touchstart', 'keydown', 'pointerdown'];

window.addEventListener('pagehide', saveScroll);

// ---------- live updates ----------

let streamRetry = 0;
let streamTimer = null;

// While the live stream is down (a restart, mostly) the page stays as it is, clicks wait for the next server,
// and after a moment this chip says why, until the stream is back (#493).
let reconnectChip = null;
let reconnectTimer = null;
// A deploy's warm handover (#1170) says so as it ends the stream: the next server is up, so no chip for a while.
let quietUntil = 0;
function reconnecting(on) {
  if (on && (reconnectChip || reconnectTimer || catchUpChip)) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (on) {
    reconnectTimer = setTimeout(() => {
      reconnectChip = h('div', { class: 'cui-chip reconnecting', 'data-tone': 'warn', role: 'status' },
        h('span', { class: 'cui-spin', 'aria-hidden': 'true' }), 'Reconnecting…');
      document.body.append(reconnectChip);
    }, Math.max(1500, quietUntil - Date.now()));
  } else {
    reconnectChip?.remove();
    reconnectChip = null;
  }
}

// The kept chat drawn at launch (#1144) says so until the live answers replace it; it stands in for Reconnecting….
let catchUpChip = null;
let keptOpen = false; // the kept chat's answers are on screen: no stream (its events would skip the gap), nothing kept anew

/** Open the app on the kept chat (base.js keptChat) while the live answers come; resolves once it's drawn. */
export function startKept(kept) {
  reconnecting(false);
  catchUpChip = h('div', { class: 'cui-chip reconnecting', 'data-tone': 'warn', role: 'status' },
    h('span', { class: 'cui-spin', 'aria-hidden': 'true' }), 'Catching up…');
  document.body.append(catchUpChip);
  keptOpen = true;
  replayKept(kept);
  return start(kept.me).finally(() => replayKept(null));
}

/** The live answer to api/me came: refresh the kept chat in place (a draft survives) and drop the chip. */
export async function goLive(who) {
  replayKept(null);
  keptOpen = false;
  setAccount(who);
  prsAt = 0;
  loadPrs();
  initAppSwitch(me);
  // The stream first: resync holds what it sends until the catch-up has fetched what came before.
  connectStream();
  try {
    await resync();
  } finally {
    catchUpChip?.remove();
    catchUpChip = null;
  }
  keepOpenChat();
}

// Keeping it stringifies and stores up to 1.5 MB, which blocks: after a route, wait for the page to be idle (#1531).
let keepSoon = false;
function keepOpenChatSoon() {
  if (keepSoon) return;
  keepSoon = true;
  (window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500)))(() => { keepSoon = false; keepOpenChat(); }, { timeout: 5000 });
}

/** Keep the open chat on the device for the next launch (base.js keepChat): the newest of its history and what opening it asked for. */
function keepOpenChat() {
  const v = view;
  if (v?.kind !== 'project' || !v.id || keptOpen || !/^#\/p\/\d+(\/t\/\d+)?$/.test(location.hash)) return;
  const src = v.merged?.src ?? v.id;
  const page = eventCache.get(src);
  if (!page) return;
  // Cut as the page is (eventcut.js): live events join the page whole.
  const events = page.events.slice(-KEPT_EVENTS).map(cutEvent);
  keepChat(location.hash, v.projectId, v.id, { [eventsUrl(src)]: JSON.stringify({ ...page, events, more: page.more || events.length < page.events.length }) });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') keepOpenChat();
});

/** A ping for this desktop app's device (#1186; Electron has no Web Push), shown as sw.js shows one; a click opens its thread. */
function desktopNotify({ endpoint, msg }) {
  if (!window.citadelDesktop || endpoint !== `desktop:${localStorage.getItem(DESKTOP_PUSH)}`) return;
  const n = new Notification(msg.title || 'Citadel', { body: msg.body || '', tag: msg.tag, renotify: !!msg.tag && !msg.silent, silent: !!msg.silent, icon: 'icon-192.png' });
  n.onclick = () => {
    window.citadelDesktop.show();
    const hash = new URL(msg.url || '/c/', location.href).hash;
    if (hash) openHash(hash);
  };
}

function connectStream(catchUp = false) {
  if (stream || !me || keptOpen) return;
  clearTimeout(streamTimer);
  const es = new EventSource('api/stream');
  stream = es;
  es.onopen = () => {
    streamRetry = 0;
    reconnecting(false);
    // Anything broadcast while we were disconnected was missed; fetch it.
    if (catchUp) {
      resync();
      deploysMissed();
    }
    catchUp = true;
  };
  es.onmessage = (e) => {
    heardAt = Date.now();
    newsArrived();
    const msg = JSON.parse(e.data);
    if (msg.type === 'handover') quietUntil = Date.now() + 15_000;
    if (msg.type === 'hello') {
      // The server restarted with a different front end; load it instead of running stale code.
      if (assetVersion && msg.version !== assetVersion) {
        reloadPending = msg.version;
        reloadWhenIdle();
      } else if (msg.version) {
        try { sessionStorage.removeItem('cc-stale'); } catch {}
      }
      assetVersion ??= msg.version;
      // Each connect's own hello (it carries usage; a deploy's broadcast one doesn't), so a reconnect catches up (#626).
      if ('usage' in msg) loadReleases().then((rows) => { schedulePaintRefs(); if (rows && view?.kind === 'project') scheduleSidebar(); });
      if (msg.stream) {
        presenceHello(msg.stream);
        if (view?.kind === 'project') scheduleSidebar();
      }
    }
    if (msg.type === 'hello' || msg.type === 'codex') {
      // The broadcast hello of a front-end-only deploy carries only `version`: it leaves Codex as it was.
      if ('codex' in msg) codex = msg.codex ?? null;
      if (msg.type === 'codex') renderUsage();
      renderModelPicker();
    }
    if (msg.type === 'hello' || msg.type === 'usage') {
      // Rows of minions that hit the usage limit count down to its reset: they redraw only when the numbers changed (#1532).
      const same = msg.usage === undefined || JSON.stringify(msg.usage) === JSON.stringify(usage);
      renderUsage(same ? undefined : msg.usage); // an unchanged one keeps the object, so the dismissed rows' cache holds
      if (!same && view?.kind === 'project') scheduleSidebar();
    }
    if (msg.type === 'turn') costSoon();
    if (msg.type === 'notify') desktopNotify(msg);
    if (msg.type === 'ticket') {
      onTicketUpdate(msg.ticket);
      onClaimHolder(msg.ticket);
    }
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
    if (msg.type === 'app-deployed' && typeof msg.name === 'string') appDeployed(msg.name);
    if (msg.type === 'properties') onPropertiesChanged(msg.projectId);
    if (msg.type === 'schedules') onSchedulesChanged(msg.projectId);
    if (msg.type === 'reviews') onReviewsChanged(msg.projectId);
    if (msg.type === 'views') onViewsChanged(msg.projectId, msg.name);
    if (msg.type === 'hidden') onHiddenChanged(msg.name);
    if (msg.type === 'claims') onClaims(msg);
    if (msg.type === 'releases') Promise.resolve(onReleases(msg)).then((rows) => { if (rows && view?.kind === 'project') { scheduleSidebar(); schedulePaintRefs(); } });
    if (msg.type === 'presence' && onPresenceMsg(msg)) {
      scheduleSidebar();
      if (view.id) renderTicketHead();
    }
    if (msg.type === 'seen-items' && msg.name === me) onSeenItems(msg.projectId);
    if (msg.type === 'machines') onMachinesUpdate(msg.machines);
    if (msg.type === 'machine_job') onJobUpdate(msg.job);
    if (msg.type === 'builds' && view?.kind === 'project' && view.projectId === msg.projectId) { view.builds = msg.builds; scheduleSidebar(); }
    if (msg.type === 'branch' && view?.kind === 'project' && view.id === msg.ticketId) renderBranch(msg.status);
  };
  es.onerror = () => {
    reconnecting(true);
    // EventSource retries dropped connections itself, but gives up for good on a non-200
    // reply (e.g. Caddy's 502 while the server restarts), so reconnect by hand then.
    if (es.readyState !== EventSource.CLOSED) return;
    es.close();
    if (stream === es) stream = null;
    streamTimer = setTimeout(() => connectStream(true), Math.min(30_000, 1000 * 2 ** streamRetry++));
  };
}

// ---------- front-end updates ----------

// A new front end loads out of sight, and never while something is half-written or being typed.
let reloadPending = false; // or the version the server now runs
let lastInputAt = 0;
export let sending = 0;
export function setSending(n) {
  sending = n;
}
const QUIET_MS = 5000;

document.addEventListener('input', () => { lastInputAt = Date.now(); }, true);
document.addEventListener('keydown', () => { lastInputAt = Date.now(); }, true);

/** What holds a new front end back, in the banner's words, or null when it can load now. */
function unsentWork() {
  const writing = 'once you have sent or cleared what you are writing';
  if (sending || Date.now() - Math.max(lastInputAt, bridgeTypedAt()) < QUIET_MS) return writing;
  // A page's picks that couldn't save while Citadel restarted are sent again from the page; a reload would lose them (#821).
  if (bridgeUnsaved()) return 'once the page you have open has saved';
  // A contraption's typing never reaches this document, and a reload would rebuild its frame at its start.
  if (framed()) return 'once you leave this app';
  // A page opened with Open saves through this tab, which a reload would forget.
  if (tabBridgeOpen()) return 'once you close the page you opened with Open';
  if (document.querySelector('.attachments:not([hidden])') || uploadsRunning()) return writing;
  if (filesUploading()) return 'once your files finish uploading';
  return [...app.querySelectorAll('[data-draft]')].some((el) => el.value.trim()) ? writing : null;
}

let reloading = false;
export async function reloadNow(ev) {
  if (reloading) return; // reloadWhenIdle asks every 2 s while the worker is fetching
  reloading = true;
  // Put the cursor back in the composer if that is where it was.
  if (document.activeElement?.matches('.composer textarea')) {
    try { sessionStorage.setItem('cc-refocus', '1'); } catch {}
  }
  // Only a ship waits on the worker; a ↻ reloads at once (the stream's hello catches a ship it missed).
  if (typeof reloadPending === 'string') {
    await freshShell(reloadPending).catch(() => {});
    if (unsentWork()) return void (reloading = false); // something started while the worker fetched: wait for it (the dim comes off)
  }
  // ↻ passes its click; every other caller (a ship, the next navigation) is automatic and skips the splash.
  if (ev instanceof Event) location.reload(); else reloadQuietly();
}

/**
 * Before a reload (#1144): the service worker fetches its newest copy and, for a ship, keeps the new front end's files,
 * so the reload opens the new version. A page already reloaded for this version and still stale (the worker couldn't
 * keep the files) drops the kept ones, and loads from the network.
 */
async function freshShell(to) {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg) return;
  let again = false;
  try {
    again = sessionStorage.getItem('cc-stale') === to;
    sessionStorage.setItem('cc-stale', to);
  } catch {}
  if (again) return Promise.all((await caches.keys()).filter((k) => k.startsWith('shell-')).map((k) => caches.delete(k)));
  const settled = () => new Promise((done) => {
    const w = reg.installing ?? reg.waiting;
    if (!w) return done();
    w.addEventListener('statechange', () => ['activated', 'redundant'].includes(w.state) && done());
  });
  await Promise.race([reg.update().then(settled), new Promise((done) => setTimeout(done, 8000))]);
}

/**
 * A new front end loads out of sight (Josh, 2026-11-20, "Reload out of sight"): while the tab is hidden, or on the next
 * in-app navigation (route()). A tab you are looking at never refreshes on its own, so a visible one left untouched
 * catches up the next time it is hidden. Unsent work still holds it back. ↻ reloads at once.
 */
export function reloadWhenIdle() {
  if (shouldReload({ pending: !!reloadPending, hidden: document.hidden, navigating: false, unsent: !!(reloadPending && unsentWork()) })) reloadNow();
}

/** The next navigation opens its target with a full load, so it comes up on the new version. */
function reloadOnNavigate() {
  if (!shouldReload({ pending: !!reloadPending, hidden: document.hidden, navigating: true, unsent: !!(reloadPending && unsentWork()) })) return false;
  // The click answers at once: the page dims as it does for any navigation, and the target opens after the reload.
  document.body.classList.add('navigating');
  reloadNow().then(() => {
    if (reloading) return;
    document.body.classList.remove('navigating');
    route(); // held back by unsent work: open what was clicked on this version
  });
  return true;
}

document.addEventListener('visibilitychange', reloadWhenIdle);

setInterval(reloadWhenIdle, 2000);

// ---------- account usage ----------

export let usage = null;
/** The person's Codex (#337): { ready, why, on, usage }, or null when nobody is signed in. */
export let codex = null;
let codexHint = '';

// The usage bars link to Settings → Usage (Cara, 2026-11-17). Settings pages take any scheme's id, so the link uses the one last open.
let usageProject = null;
const usageHref = () => `#/p/${usageProject ?? view?.projectId ?? ''}/usage`.replace('/p//', '/');
function syncUsageLinks() {
  const id = location.hash.match(/^#\/p\/(\d+)/)?.[1];
  if (id) usageProject = Number(id);
  for (const a of document.querySelectorAll('a.usage')) a.setAttribute('href', usageHref());
}
addEventListener('hashchange', syncUsageLinks);

/** A weekly-limit bar; one lives in the top bar and one in a project's side panel. */
export const usageMeter = () => h('a', { class: 'usage', href: usageHref(), hidden: true },
  h('span', { class: 'label' }), h('span', { class: 'track' }, h('span', { class: 'fill' })));

export { combineWindows };

/** Where a person's new minions start and why (#793), from usageOf's account, why and pinned. */
export function pickLine(u, accounts) {
  const a = accounts.find((x) => x.n === u.account);
  if (!a) return 'No Claude account is ready for new minions.';
  const reset = a.usage?.weekly?.resetsAt > Date.now() ? ` (${new Date(a.usage.weekly.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })})` : '';
  const why = u.why === 'pinned' ? 'you pinned it'
    : u.pinned ? `account ${u.pinned}, which you pinned, isn't ready`
    : u.why === 'full' ? 'every account is close to its limit'
    : `of the accounts with room, its week resets first${reset}`;
  return `New minions start on ${a.label}: ${why}. Running minions stay on their account while warm, until it's nearly out.`;
}

/** Fill in every usage bar from the latest usage report from Claude turns. */
export function renderUsage(next = usage) {
  usage = next;
  syncUsageLinks();
  const accounts = usage?.accounts?.length > 1 ? usage.accounts : null;
  const week = accounts ? combineWindows(accounts, 'weekly') : usage?.weekly;
  const session = accounts ? combineWindows(accounts, 'session') : usage?.session;
  for (const el of document.querySelectorAll('.usage:not(.codex)')) {
    el.hidden = !week;
    if (!week) continue;
    const pct = Math.round(Math.min(1, Math.max(0, week.utilization)) * 100);
    el.querySelector('.label').textContent = `Week ${pct}%`;
    el.setAttribute('aria-label', `Usage details: week ${pct}%`);
    el.style.setProperty('--pct', `${pct}%`);
    // Several accounts: out only once every one is (turns move to the next by themselves).
    const out = accounts ? accounts.every((a) => high(a.usage)) : week.status && week.status !== 'allowed';
    el.dataset.level = out || pct >= 90 ? 'error' : pct >= 75 ? 'warn' : '';
    const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const sess = (w) => `${Math.round(w.utilization * 100)}%${w.resetsAt ? `, resets ${when(w.resetsAt)}` : ''}`;
    el.title = [
      accounts
        ? `Weekly usage combined across ${accounts.length} Claude accounts: ${pct}%${week.resetsAt ? `, next reset ${when(week.resetsAt)}` : ''}`
        : `Weekly usage of your Claude plan: ${pct}%${week.resetsAt ? `, resets ${when(week.resetsAt)}` : ''}`,
      session ? `5-hour window${accounts ? ' (combined)' : ''}: ${sess(session)}` : null,
      `As of the last turn, ${ago(usage.updatedAt)}`,
      // Several Claude accounts (#779): the bar combines them; the tooltip says where new minions start (#793) and lists each, ▸ on that one.
      ...(accounts ? ['', pickLine(usage, accounts), ...accounts.map((a) => accountLine(a, a.n === usage.account))] : []),
    ].filter((line) => line != null).join('\n');
  }
  for (const el of document.querySelectorAll('.usage:not(.codex)')) renderCodexSwitch(el);
  for (const el of document.querySelectorAll('.codex-toggle')) syncToggle(el);
  for (const el of document.querySelectorAll('.codex-windows')) fillCodexWindows(el);
}

/** A bar in the Claude bar's look (#342), for Settings' Codex windows; `.codex` keeps it out of the Claude bars' loops. */
const codexBar = () => h('a', { class: 'usage codex', href: usageHref(), 'aria-label': 'Usage details', hidden: true }, h('span', { class: 'label' }), h('span', { class: 'track' }, h('span', { class: 'fill' })));
const setBar = (bar, pct, label) => {
  bar.querySelector('.label').textContent = label;
  bar.style.setProperty('--pct', `${pct}%`);
  bar.dataset.level = codexLevel(pct);
};
const windowText = (w) => `${windowName(w.windowDurationMins)}: ${w.pct}%${w.resetsAt && w.pct ? `, resets ${when(w.resetsAt * 1000)}` : ''}`;

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
const high = (u) => [u?.session, u?.weekly].some((w) => live(w) && (w.status === 'rejected' || w.utilization >= 0.9));
// With several Claude accounts (#779), only once every one of them is high: turns move to the next by themselves.
const claudeHigh = () => usage?.accounts?.length > 1 ? usage.accounts.every((a) => high(a.usage)) : high(usage);

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

/** Under each usage bar, past 90% or while on: the override, Codex's own usage, and after Claude's reset a word that Claude is back. */
function renderCodexSwitch(meter) {
  let sw = meter.nextElementSibling?.classList.contains('codex-switch') ? meter.nextElementSibling : null;
  if (!sw) {
    sw = h('div', { class: 'codex-switch', hidden: true }, codexToggle(), h('span', { class: 'codex-usage' }), h('span', { class: 'claude-back' }, "Claude's back"));
    meter.after(sw);
  }
  sw.hidden = !codex || !(codex.on || claudeHigh());
  if (sw.hidden) return;
  sw.querySelector('.claude-back').hidden = !codex.on || claudeHigh();
  const top = codexTop(codex.usage);
  const cu = sw.querySelector('.codex-usage');
  cu.hidden = !codex.on || top == null;
  if (cu.hidden) return;
  cu.textContent = `Codex ${top}%`;
  cu.dataset.level = codexLevel(top);
  cu.title = [...codexWindows(codex.usage).map(windowText), `As of the last Codex turn, ${ago(codex.usage.updatedAt)}`].join('\n');
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

// Phones and sleeping laptops drop connections quietly; recheck when the page comes back. A tab hidden under a
// minute whose stream spoke since it hid missed nothing, so it asks for nothing (#1528). Not on the stream's
// readyState: a frozen phone page can show OPEN on a dead stream. A stream that broke and came back resyncs on
// its open (connectStream), and a page the browser froze resyncs whatever the time.
let hiddenAt = Date.now(), frozen = false;
document.addEventListener('freeze', () => { frozen = true; });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') return void ((hiddenAt = Date.now()), (frozen = false));
  if (!me) return;
  if (!stream) connectStream(true);
  else if (missedNews(hiddenAt, heardAt, Date.now(), frozen)) {
    deploysMissed();
    if (view?.kind === 'project') resync();
    else countsIfOwed();
  } else countsIfOwed();
});

async function resync() {
  if (view?.kind !== 'project') return route();
  // Refresh in place so a half-typed message in the composer survives.
  const v = view;
  // The stream has no replay: live events for the open chat wait until the catch-up has fetched what
  // came before them, or the catch-up (after the newest shown) would skip what was missed offline.
  const hold = v.id ? (held?.view === v ? held : { view: v, events: [], owed: 0 }) : null;
  if (hold) {
    hold.owed++;
    held = hold;
  }
  try {
    const [{ coordinator, tickets, dismissed, seen, person_notes, pins, builds }, artifacts, chat] = await Promise.all([
      api(`api/projects/${view.projectId}?tickets=open`),
      api(`api/projects/${view.projectId}/artifacts`),
      view.id ? api(`api/tickets/${view.id}`) : null,
    ]);
    if (view !== v) return; // you went to another view meanwhile; its own load is fresh
    view.coordinator = coordinator;
    view.tickets = mergeOpen(tickets, dismissed); // the dismissed rows already read stay (closedlist.js)
    schedulePaintRefs(); // links already in the chat take the fresh states
    view.seen = seen ?? view.seen;
    view.personNotes = person_notes ?? view.personNotes;
    view.pins = pins ?? view.pins;
    view.builds = builds ?? view.builds;
    if (view.id) markSeen(view.id);
    renderSidebar();
    // Cards raised or settled while the stream was down, here or in other schemes (the counts fetch the inbox after them).
    forgetOtherSchemes();
    refreshSchemeCounts();
    setArtifacts(artifacts);
    if (!chat) return;
    view.ticket = chat.ticket;
    renderTicketHead();
    if (view.ticket.branch) refreshBranch(view.id);
    await catchUpEvents();
  } catch {} finally {
    if (hold && !--hold.owed) releaseHeld(hold);
  }
}

/** Live events for the open chat held while resync catches up (see resync). */
let held = null;
function releaseHeld(hold) {
  if (held === hold) held = null;
  if (view === hold.view) for (const ev of hold.events) if (ev.id > view.lastEventId) appendEvent(ev);
}

// Threads' histories downloaded this session, each its newest page or more ({ events, more, tasks },
// as the events route gives it), so reopening one only fetches what is new. Events are append-only,
// so the cached part never goes stale. Most recently used last.
const eventCache = new Map();
const EVENT_CACHE_THREADS = 12;

/**
 * Where a chat's history comes from: a ticket id, or a merged Taskmaster view's URL (Mine and Everyone, #920,
 * thread.js mergedView) that pages several sessions as one. `query` is added to it.
 */
const eventsUrl = (src, query = '') => typeof src === 'number' ? `api/tickets/${src}/events${query && `?${query}`}` : `${src}${query && `&${query}`}`;

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
  const page = cached ?? await api(eventsUrl(ticketId));
  if (cached) {
    const fresh = await api(eventsUrl(ticketId, `after=${page.events.at(-1)?.id ?? 0}`));
    // Another load, or live events, may have added some of these while this one was on its way.
    const last = page.events.at(-1)?.id ?? 0;
    page.events = page.events.concat(fresh.filter((e) => e.id > last));
  }
  remember(ticketId, page);
  return page;
}

/**
 * A thread's history from the cache, to draw at once (#527), or null when it isn't cached (or is still prefetching).
 * What came since is the chat's own catch-up once it is drawn (mountChat): one request, appended, not drawn again (#1531).
 */
export function cachedEvents(ticketId) {
  const page = eventCache.get(ticketId);
  if (!page || prefetching.has(ticketId)) return null;
  remember(ticketId, page);
  return page;
}

/** Add the page before the oldest loaded event to a thread's history; with `from`, reach back to that event. */
export function loadEarlier(ticketId, page, from) {
  // One at a time per page (Load earlier and Find can both ask), each going on from where the last got to.
  const load = (earlierLoads.get(page) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const first = page.events[0].id;
    const older = await api(eventsUrl(ticketId, `before=${first}${from ? `&from=${from}` : ''}`));
    Object.assign(page, { events: older.events.filter((e) => e.id < first).concat(page.events), more: older.more, tasks: older.tasks });
    remember(ticketId, page);
    return page;
  });
  earlierLoads.set(page, load);
  return load;
}
const earlierLoads = new WeakMap(); // page -> its load of earlier events in flight (or done)

// Prefetching: a thread's newest page starts downloading when you point at (or touch) its row, and
// the top two rows load quietly once a project page settles, so a first click opens from the cache.
// A prefetch only fills a free cache slot, never evicting a thread you actually opened.
const prefetching = new Map(); // ticket id -> its download in flight
const PREFETCH_ROWS = 2;

function prefetchEvents(ticketId) {
  if (eventCache.has(ticketId) || prefetching.has(ticketId) || eventCache.size >= EVENT_CACHE_THREADS) return prefetching.get(ticketId) ?? Promise.resolve(); // always a promise: prefetchTopRows chains on it
  const p = api(eventsUrl(ticketId))
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

/** Draw what the open chat's history is missing since its newest event; how many were added. */
export async function catchUpEvents() {
  const v = view;
  if (!v?.id) return 0;
  // Live events wait until this has what came before them, or the first would move the cursor past the rest (see resync).
  const hold = held?.view === v ? held : { view: v, events: [], owed: 0 };
  hold.owed++;
  held = hold;
  try {
    const events = await api(eventsUrl(v.merged?.src ?? v.id, `after=${v.lastEventId}`));
    if (view !== v) return 0; // another view (or chat) opened meanwhile: these aren't its events
    let added = 0;
    for (const ev of events) if (ev.id > view.lastEventId) { appendEvent(ev); added++; }
    return added;
  } finally {
    if (!--hold.owed) releaseHeld(hold);
  }
}

export function onTicketUpdate(ticket) {
  if (view?.kind !== 'project') return;
  if (view.projectId !== ticket.project_id) return inboxOtherTicket(ticket);
  holdAnswered(ticket); // #1409
  // Each person has their own Taskmaster (#919): the others' updates only refresh their entry in view.taskmasters.
  if (ticket.kind === 'coordinator' && view.coordinator && ticket.id !== view.coordinator.id) {
    // Another person's Taskmaster or the Overlord: its cards still count in Needs you.
    const tm = view.taskmasters?.find((t) => t.id === ticket.id);
    const before = tm?.ticket;
    if (tm) tm.ticket = ticket;
    if (view.id === ticket.id) { view.ticket = ticket; renderTicketHead(); }
    return void inboxTicket(before, ticket);
  }
  const before = ticket.kind === 'coordinator' ? view.coordinator : view.tickets.get(ticket.id);
  if (ticket.kind !== 'coordinator') noteTicketChange(before, ticket);
  if (ticket.kind === 'coordinator') view.coordinator = ticket;
  else view.tickets.set(ticket.id, ticket);
  schedulePaintRefs(); // chat links to minions show their state (refstate.js)
  inboxTicket(before, ticket);
  scheduleSidebar();
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
  // The unread mark goes at once (Cara, 2026-11-08: "assume things will work instantly"); the server's time replaces ours when it answers.
  const t = view?.kind === 'project' ? (view.tickets?.get(ticketId) ?? (view.coordinator?.id === ticketId ? view.coordinator : null)) : null;
  if (t && view.seen && (view.seen[ticketId] ?? 0) < t.updated_at) {
    view.seen[ticketId] = t.updated_at;
    renderSidebar();
  }
  if (seenTimers.has(ticketId)) return;
  seenTimers.set(ticketId, setTimeout(async () => {
    seenTimers.delete(ticketId);
    try {
      const { seen_at } = await api(`api/tickets/${ticketId}/seen`, { method: 'POST', body: {} });
      if (view?.kind !== 'project') return;
      if (view.seen[ticketId] === seen_at) return; // nothing changed: no second redraw per update (#1532)
      view.seen[ticketId] = seen_at;
      scheduleSidebar();
    } catch {}
  }, 800));
}

/** You've left a thread (another page, a hidden tab, a closed page): a finished minion you had open at its last update closes (#811). */
function leaveSeen(ticketId) {
  if (!ticketId) return;
  fetch(`api/tickets/${ticketId}/seen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ left: true }), keepalive: true }).catch(() => {});
}
addEventListener('pagehide', () => view?.kind === 'project' && leaveSeen(view.id));
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && view?.kind === 'project' && leaveSeen(view.id));

function onEvent(event) {
  if (view?.kind !== 'project' || (view.id !== event.ticket_id && !inMerged(view.merged, event))) return;
  if (event.id <= view.lastEventId) return;
  if (held?.view === view) return void held.events.push(event);
  appendEvent(event);
}

// ---------- routing ----------

// Bumped on every navigation, so a slow load that another click has overtaken is dropped.
export let routeSeq = 0;
let routedHash = null; // the address the newest finished route opened (a "show me where" link waits for it)

// The usage ledger (#1306): one count per page opened; the server drops the numbers. A failure is ignored.
let lastCounted = '';
function countPage(hash) {
  const name = (hash || '#/').replace(/[?].*$/, '').replace(/\d+/g, 'n');
  if (name === lastCounted) return;
  lastCounted = name;
  api('api/usage/page', { method: 'POST', body: { name } }).catch(() => {});
}

async function route() {
  if (!me) return;
  const jump = jumpParts(location.hash);
  if (jump) {
    // Open the chat at its plain address, so Back and a reload don't jump again; its mountChat takes the jump.
    pendingJump = jump;
    return replaceHash(jump.hash);
  }
  // A "show me where" link (#1122): open the page at its plain address, then outline the part once a later route is done.
  const show = showParts(location.hash);
  if (show) {
    const from = routeSeq;
    // Ready once a route has finished on the address now showing: #/t/<id> hands on to the minion's own address first.
    showPart(show.name, () => routeSeq > from && routedHash === location.hash && !document.body.classList.contains('navigating'));
    return replaceHash(show.hash);
  }
  // A new front end is waiting: this navigation is the moment to load it (the address is already the target).
  if (reloadOnNavigate()) return;
  countPage(location.hash);
  // Under a contraption's frame the page keeps its scroll; it's saved when you left it for the frame.
  if (!framed()) saveScroll();
  const seq = ++routeSeq;
  const hash = location.hash || '#/';
  if (view?.kind === 'project' && view.id && !/^#\/(f|apps|share)\b/.test(hash) && !new RegExp(`/t/${view.ticket?.number}(?!\\d)`).test(hash)) leaveSeen(view.id);
  let m;
  // A contraption in Citadel's window (frames.js): Citadel's page stays as it was underneath.
  if ((m = hash.match(/^#\/apps\/([a-z0-9][a-z0-9-]{0,31})(?:\?to=([^#]*))?$/))) {
    // A link into an app (extlinks.js appHash): the page it names, checked to be inside that app on Citadel's origin.
    let src = null;
    if (m[2] != null) {
      try { src = appSrc(m[1], decodeURIComponent(m[2]), location.origin); } catch {}
    }
    showFrame(m[1], src ?? undefined);
    if (m[2] != null) replaceHash(`#/apps/${m[1]}`);
    return;
  }
  if ((m = hash.match(/^#\/share(\?.*)?$/))) return takeShare(m[1] ?? '', seq);
  hideFrames();
  // A jump left by a route that never opened its chat mustn't fire on a later, ordinary visit.
  if (pendingJump?.hash !== hash) pendingJump = null;
  // Answer the click straight away: highlight the thread being opened and dim the old view.
  for (const a of document.querySelectorAll('#coordinator-row .thread-row, #threads .thread-row')) a.classList.toggle('active', a.getAttribute('href') === hash);
  document.body.classList.add('navigating');
  document.getElementById('app')?.classList.add('nav-dim');
  try {
    // Leaving the file viewer for the chat under it just closes it; anywhere else goes on from there.
    if (!hash.startsWith('#/f/') && closeViewer() === hash) {
      const jump = takeJump();
      if (jump) jumpToEvent(jump);
      return;
    }
    // Home (#1140): its overview, or a chat opened from its list with the list kept beside it.
    if (hash === '#/home' || hash === '#/home/broken') { if (hash === '#/home/broken') openBroken(); const id = await homeScheme(); if (seq !== routeSeq) return; if (id == null) await openStartScheme(); else await showProject(id, { kind: 'home', home: true }); }
    else if ((m = hash.match(/^#\/home\/p\/(\d+)(?:\/t\/(\d+))?$/))) await showProject(Number(m[1]), { kind: 'chat', number: m[2] ? Number(m[2]) : null, home: true });
    else if ((m = hash.match(/^#\/p\/(\d+)$/))) await showProject(Number(m[1]));
    else if ((m = hash.match(/^#\/p\/(\d+)\/artifacts$/))) await showProject(Number(m[1]), { kind: 'files', folder: '@minions' });
    // Settings and Orders open on their list of pages on a phone (#1018); on a desktop Settings opens on Members beside
    // its menu, and Orders on Instructions with the panel's Orders tab showing (#1071).
    else if ((m = hash.match(/^#\/p\/(\d+)\/(settings|orders)$/))) await showProject(Number(m[1]), matchMedia('(max-width: 800px)').matches ? { kind: m[2] } : m[2] === 'settings' ? { kind: 'members' } : { kind: 'instructions', orders: true });
    // The Machines page at one machine (#1638): lending cards and list_machines link here; its row opens and scrolls into view.
    else if ((m = hash.match(/^#\/p\/(\d+)\/machines\/([a-z0-9-]{1,30})$/))) await showProject(Number(m[1]), { kind: 'machines', machine: m[2] });
    else if ((m = hash.match(PAGE_ROUTE))) await showProject(Number(m[1]), { kind: m[2] }); // every Settings and Orders page in the table (settings-pages.js)
    else if ((m = hash.match(/^#\/p\/(\d+)\/schedules(?:\/(\d+))?$/))) await showProject(Number(m[1]), { kind: 'schedules', schedule: Number(m[2]) || null });
    else if ((m = hash.match(/^#\/p\/(\d+)\/chains(?:\/(\d+))?$/))) await showProject(Number(m[1]), { kind: 'chains', focus: Number(m[2]) || null });
    // Releases, CI and Status are one page's tabs (#1423): their old addresses open it on their tab. CI's All (Home's) opens the
    // last scheme's Overview beside every scheme's dot, since All has no one CI; Status's All lists every app.
    else if ((m = hash.match(/^#\/p\/(\d+)\/status(?:\/(all))?$/))) await showReleases(Number(m[1]), { scope: m[2] ? 'all' : Number(m[1]), tab: 'status' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/ci(?:\/(overview|history|runs|runners|health|numbers|all))?$/))) await showReleases(Number(m[1]), { scope: Number(m[1]), tab: tabOf(!m[2] || m[2] === 'all' ? 'overview' : m[2]) });
    else if ((m = hash.match(/^#\/p\/(\d+)\/shared$/))) await showProject(Number(m[1]), { kind: 'files' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/releases(?:\/(all|\d+)(?:\/(\d+|overview|history|health|numbers|status|target\/[^/]+))?)?$/))) {
      const hl = /^\d+$/.test(m[3] ?? '') ? Number(m[3]) : null; // a change to highlight, else a tab's name
      const target = m[3]?.startsWith('target/') ? decodeURIComponent(m[3].slice(7)) : null; // a release target to scroll to (#1647)
      await showReleases(Number(m[1]), { scope: m[2] === 'all' ? 'all' : Number(m[2] ?? m[1]), tab: hl == null && target == null && m[3] ? m[3] : 'releases', hl, target });
    }
    else if ((m = hash.match(/^#\/a\/(\d+)$/))) await showArtifact(Number(m[1]));
    else if ((m = hash.match(/^#\/s\/(\d+)\/(.+)$/))) await showSharedFile(Number(m[1]), decodeURIComponent(m[2]));
    else if ((m = hash.match(/^#\/f\/(\d+)\/(.+)$/))) await showFile(Number(m[1]), decodeURIComponent(m[2]));
    else if ((m = hash.match(/^#\/p\/(\d+)\/t\/(\d+)$/))) await showProject(Number(m[1]), { kind: 'chat', number: Number(m[2]) });
    else if ((m = hash.match(/^#\/t\/(\d+)$/))) await showTicket(Number(m[1]));
    else await openStartScheme();
    if (seq === routeSeq) keepOpenChatSoon();
  } catch (err) {
    if (err.message !== 'Not logged in' && seq === routeSeq) {
      // A notice with a way out, not a bare red line on a blank page.
      const scheme = hash.match(/^#\/[ps]\/(\d+)/)?.[1];
      app.replaceChildren(h('div', { class: 'cui-notice route-error', role: 'alert', 'data-tone': 'danger' },
        h('p', {}, err.message),
        h('p', {}, scheme ? h('a', { href: `#/p/${scheme}` }, 'Back to the scheme') : null, scheme ? ' · ' : null,
          h('a', { href: '#/' }, 'Home'), ' · ', h('a', { href: location.hash, onclick: (e) => { e.preventDefault(); route(); } }, 'Try again'))));
      // The old view is gone from the page, so the next resync routes again instead of refreshing it in place.
      setView(null);
    }
  } finally {
    if (seq === routeSeq) {
      document.body.classList.remove('navigating');
      document.getElementById('app')?.classList.remove('nav-dim');
      routedHash = hash;
    }
    reportPresence();
  }
}

/** A share from the phone's Share sheet (#375): the contraption that takes it, filled in; else home, saying so. */
async function takeShare(search, seq) {
  let mine;
  try {
    mine = await api('api/contraptions/mine');
  } catch (err) {
    // The login is showing, or Citadel didn't answer: the share stays in the address, for after or a reload.
    if (err.message !== 'Not logged in') toast(`Couldn't open the share: ${err.message}. Reload to try again.`, { tone: 'warn', ms: 8000 });
    return;
  }
  if (seq !== routeSeq) return; // you went elsewhere meanwhile
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
    schedulePaintRefs();
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
watchRefs();
for (const type of ['pointerover', 'focusin']) {
  document.addEventListener(type, (e) => { const a = e.target.closest?.('a[href^="https://github.com/"]'); if (a) pointPrLink(a); });
}

// ---------- login ----------

setShowLogin(renderLogin);

/** Signed out, the top bar shows no usage meter or chips: they are one person's, and start() brings them back. */
export function clearTopbarMeters() {
  const meters = document.querySelector('.topbar .meters');
  if (!meters) return;
  for (const el of meters.querySelectorAll('.usage, .ci-chip, .status-chip, .releases-chip')) {
    if (el.matches('.usage')) el.hidden = true; // the markup's own bar stays, hidden, for renderUsage to show again
    else el.remove();
  }
}

function renderLogin() {
  reconnecting(false); // signed out: the stream's 401s aren't a restart
  setView(null);
  hideRail();
  dropFrames();
  crumbs.replaceChildren();
  meEl.replaceChildren();
  clearTopbarMeters();
  app.replaceChildren(document.getElementById('login-tpl').content.cloneNode(true));
  mountLoginMap(app);
  const form = document.getElementById('login-form');
  // A saved login that is really the site's address (filled in by a phone's password manager) is dropped.
  try { const saved = localStorage.getItem('cc-login') || ''; form.login.value = /^https?\W|\//i.test(saved) ? '' : saved; } catch {}
  const desk = desktopLogin(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('login-error');
    try {
      await api('api/login', { method: 'POST', body: { login: form.login.value, password: form.password.value } });
      try { localStorage.setItem('cc-login', form.login.value.trim()); } catch {}
      await desk.signedIn();
      // A contraption's page sent here by /apps/'s login gate (src/apps.ts) goes back to it.
      const next = new URLSearchParams(location.search).get('next');
      if (next && /^\/apps\/[a-z0-9-]+\//.test(next)) return void location.assign(next);
      start(await api('api/me'));
    } catch (ex) {
      desk.refused(ex);
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
}

/**
 * The desktop app's saved password (#1754; Cara, 2026-11-24, "Citadel's own sign-in"): a Remember tick saves it in Windows'
 * locked storage for this Windows account (desktop/saved-login.cjs), and the next sign-in page fills it and waits for the
 * click, never signing in by itself ("if I log out and want to log back in, like to test the sign in page"). Signing out
 * keeps it; Forget, or signing in unticked, drops it, and so does the server refusing it. A browser or phone sees none of this.
 */
function desktopLogin(form) {
  const bridge = window.citadelDesktop;
  const none = { signedIn: async () => {}, refused: () => {} };
  if (!bridge?.savedLogin) return none;
  let filled = null; // the saved password, while the box still holds it
  const tick = h('input', { type: 'checkbox', name: 'remember' });
  const forget = h('button', { type: 'button', class: 'link', hidden: true }, 'Forget');
  const row = h('div', { class: 'login-remember', hidden: true },
    h('label', {}, tick, ' Remember my password on this PC'), forget);
  form.querySelector('#login-error').before(row);
  const drop = () => {
    filled = null;
    forget.hidden = true;
    tick.checked = false;
    return bridge.forgetLogin().catch(() => {});
  };
  forget.addEventListener('click', () => {
    if (form.password.value === filled) form.password.value = '';
    drop();
    toast('Saved password forgotten on this PC');
    form.password.focus();
  });
  bridge.savedLogin().then((r) => {
    if (!r?.canSave || !form.isConnected) return;
    row.hidden = false;
    const saved = r.login;
    // What she's already typing wins over the fill.
    if (!saved || form.password.value || (form.login.value && form.login.value.trim() !== saved.login)) return;
    form.login.value = saved.login;
    form.password.value = filled = saved.password;
    tick.checked = true;
    forget.hidden = false;
  }, () => {});
  return {
    async signedIn() {
      if (row.hidden) return;
      if (tick.checked) await bridge.saveLogin(form.login.value, form.password.value).catch(() => {});
      else if (!forget.hidden) await drop();
    },
    /** A saved password the server turned down (not a lockout or a network failure) is dropped; the form shows as usual. */
    refused(ex) {
      if (ex?.status !== 401 || filled === null || form.password.value !== filled) return;
      drop();
      form.password.value = '';
    },
  };
}

/** The page an invite or reset link opens: it names who the link is for and sets their password. */
export function renderInvite(token) {
  setView(null);
  crumbs.replaceChildren();
  meEl.replaceChildren();
  clearTopbarMeters();
  app.replaceChildren(document.getElementById('invite-tpl').content.cloneNode(true));
  mountLoginMap(app);
  const form = document.getElementById('invite-form');
  const who = document.getElementById('invite-who');
  const err = document.getElementById('invite-error');
  const path = `api/invite/${encodeURIComponent(token)}`;
  api(path).then((r) => {
    who.replaceChildren('This sets the password for ', h('strong', {}, r.name), ', who signs in as ', h('strong', {}, r.login), '.');
    form.login.value = r.login;
    form.querySelector('button').disabled = false;
  }).catch((ex) => {
    // A dead link: say so, and the way on is signing in (or asking for a new link), not a form that can't send.
    for (const el of form.querySelectorAll('label, button')) el.remove();
    who.replaceWith(h('p', { class: 'cui-notice', 'data-tone': 'danger', role: 'alert' }, ex.message));
    form.append(h('a', { class: 'button secondary', href: location.pathname }, 'Go to sign in'));
  });
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
  setAccount(who);
  meEl.replaceChildren(me, h('button', { class: 'secondary', onclick: logout }, 'Sign out'));
  connectStream();
  loadPrs();
  // The top bar's CI, Status and Releases chips (#968, #1423), beside its usage meter: the ones phones see.
  const meters = document.querySelector('.topbar .meters');
  if (!meters.querySelector('.status-chip')) meters.append(statusChip());
  if (!meters.querySelector('.ci-chip[data-kind="ci"]')) meters.append(ciChip());
  if (!meters.querySelector('.releases-chip')) meters.append(releasesChip());
  const routed = route();
  showRail();
  initAppSwitch(me);
  return routed;
}

export async function logout() {
  initAppSwitch(null);
  // Notifications on this device were for the person signing out.
  await pushOff().catch(() => {});
  await api('api/logout', { method: 'POST', body: {} });
  eventCache.clear();
  forgetSchemes();
  clearTimeout(streamTimer);
  stream?.close();
  stream = null;
  reconnecting(false);
  setAccount(null);
  renderLogin();
}

// ---------- jumps ----------

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

// A picture in a chat message (a pasted or uploaded image, or a markdown one) opens in the kit's lightbox, a modal over
// the chat, not a browser tab (#945). Ctrl/⌘/Shift/middle-click still open the tab.
// A minion's marked picture (#960) opens with its marks on, as marks people can undo, when its Marks toggle is on; its
// "Draw on it" button opens it the same way.
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const el = e.target instanceof Element ? e.target : null;
  const marked = el?.closest('.cui-marked');
  // Draw on it takes the picture itself: a file preview's link is the file viewer's route, not the picture.
  const draw = el?.closest('.cui-marks-draw');
  const img = draw ? marked?.querySelector('img') : el?.closest('.msg a > img, .md a > img, .msg a .cui-marked-pic > img, .md a .cui-marked-pic > img');
  const src = draw ? img?.src : img?.closest('a')?.href;
  if (!src) return;
  e.preventDefault();
  const own = marked?.querySelector('.cui-marks-toggle > input')?.checked ? parseMarks(marked.dataset.marks) : null;
  // Ready to draw on (#946), as an image waiting to send: Done puts the marked copy in this chat's message box.
  const chatId = view?.kind === 'project' && view.main === 'chat' && img.closest('#log') ? view.id : null;
  const lb = lightbox([{ src, alt: img.alt || 'Picture' }], chatId == null || !drawable(src) ? {} : {
    render: (item, stage) => annotator(stage, item.src, {
      ...(own ? { marks: own.marks, size: { w: own.w, h: own.h } } : {}),
      doneLabel: 'Add to message',
      onDone: async (canvas) => {
        lb.close();
        if (canvas) attachImage(chatId, await canvasBlob(canvas));
      },
    }),
  });
});

/** Minions whose Stop was clicked and that haven't stopped yet: the head and the row's menu say "Stopping…" until the status moves on (a stop takes up to 15 s on the server). */
export const stoppingIds = new Set();
/** Stop shows "Stopping…" at once (`redraw` draws it) and the request runs behind it; a refusal (nothing to stop) or an error puts the button back with a toast and a Retry. */
export function stopChat(t, redraw = () => {}) {
  return optimistic({
    sets: `stop:${t.id}`,
    apply: () => { stoppingIds.add(t.id); redraw(); },
    send: async () => {
      const r = await api(`api/tickets/${t.id}/stop`, { method: 'POST', body: {} });
      if (r?.stopped === false) throw new Error('nothing was running');
      if (r?.ship) toast(r.ship, { ms: 8000 });
    },
    undo: () => { stoppingIds.delete(t.id); redraw(); },
    label: `stop #${t.number ?? t.id}`,
  }).catch(() => {});
}
