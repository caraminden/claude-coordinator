// The app shell: markdown and chat scrolling, live updates, usage, routing and sign-in. What every
// module shares without needing the shell (state, api, h, helpers) is base.js.
import { inMerged } from './mine.js';
import { ago, api, baseName, fileExt, fileHref, fileKind, fileUrl, h, isLocalPath, me, setAccount, setShowLogin, setView, shortPath, threadHref, threadLabel, view } from './base.js';
import { onAppInstructionsUpdate, onMachinesUpdate, onProjectUpdate, pushOff } from './settings.js';
import { costChip, renderCost } from './cost.js';
import { openStartScheme, renderSidebar } from './sidebar.js';
import { forgetSchemes, showProject, showReleases, showTicket } from './project.js';
import { closeViewer, onArtifactsChanged, setArtifacts, showArtifact, showFile, showSharedFile } from './artifacts.js';
import { bridgeTypedAt, bridgeUnsaved, onArtifactData, tabBridgeOpen } from './bridge-host.js';
import { appendEvent, jumpToEvent, refreshBranch, renderBranch, renderCardJump, renderTicketHead } from './thread.js';
import { replaceHash } from './navstack.js';
import { onPropertiesChanged, onViewsChanged } from './properties.js';
import { forgetOtherSchemes, inboxEvent, inboxOtherTicket, inboxTicket, onSeenItems, refreshInbox, refreshSchemeCounts } from './inbox.js';
import { onSchedulesChanged } from './schedules.js';
import { onHiddenChanged } from './hidden.js';
import { loadReleases, onReleases } from './releases.js';
import { inAppHash, jumpParts, linkThreadRefs, linkUrls, prLinkOpen, prNumberRoute, prOwnerRoute } from './threadrefs.js';
import { renderModelPicker, uploadsRunning } from './composer.js';
import { filesUploading } from './files.js';
import { onJobUpdate } from './jobs.js';
import { linkifyHtml, markdownElement } from './ui/markdown.js';
import { lightbox } from './ui/media.js';
import { hideRail, showRail } from './rail.js';
import { dropFrames, framed, hideFrames, shareTarget, showFrame } from './frames.js';
import { toast } from './ui/status.js';
import { initAppSwitch } from './appswitch.js';
import { onPresenceMsg, presenceHello, reportPresence } from './presence.js';
import { codexHigh, codexLevel, codexTop, codexWindows, windowName } from './codexusage.js';

export const app = document.getElementById('app');
export const crumbs = document.getElementById('crumbs');
const meEl = document.getElementById('me');

let stream = null;
let assetVersion = null;

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
  if (followChat && e.target.tagName === 'IMG' && e.target.closest('#log')) scrollToBottom();
}, true);

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
function reconnecting(on) {
  if (on && (reconnectChip || reconnectTimer)) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (on) {
    reconnectTimer = setTimeout(() => {
      reconnectChip = h('div', { class: 'cui-chip reconnecting', 'data-tone': 'warn', role: 'status' },
        h('span', { class: 'cui-spin', 'aria-hidden': 'true' }), 'Reconnecting…');
      document.body.append(reconnectChip);
    }, 1500);
  } else {
    reconnectChip?.remove();
    reconnectChip = null;
  }
}

function connectStream(catchUp = false) {
  if (stream || !me) return;
  clearTimeout(streamTimer);
  const es = new EventSource('api/stream');
  stream = es;
  es.onopen = () => {
    streamRetry = 0;
    reconnecting(false);
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
      // Each connect's own hello (it carries usage; a deploy's broadcast one doesn't), so a reconnect catches up (#626).
      if ('usage' in msg) loadReleases().then((rows) => rows && view?.kind === 'project' && renderSidebar());
      if (msg.stream) {
        presenceHello(msg.stream);
        if (view?.kind === 'project') renderSidebar();
      }
    }
    if (msg.type === 'hello' || msg.type === 'codex') {
      // The broadcast hello of a front-end-only deploy carries only `version`: it leaves Codex as it was.
      if ('codex' in msg) codex = msg.codex ?? null;
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
    if (msg.type === 'releases') Promise.resolve(onReleases(msg)).then((rows) => rows && view?.kind === 'project' && renderSidebar());
    if (msg.type === 'presence' && onPresenceMsg(msg)) {
      renderSidebar();
      if (view.id) renderTicketHead();
    }
    if (msg.type === 'seen-items' && msg.name === me) onSeenItems(msg.projectId);
    if (msg.type === 'machines') onMachinesUpdate(msg.machines);
    if (msg.type === 'machine_job') onJobUpdate(msg.job);
    if (msg.type === 'builds' && view?.kind === 'project' && view.projectId === msg.projectId) { view.builds = msg.builds; renderSidebar(); }
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

export function reloadNow() {
  // Put the cursor back in the composer if that is where it was.
  if (document.activeElement?.matches('.composer textarea')) {
    try { sessionStorage.setItem('cc-refocus', '1'); } catch {}
  }
  location.reload();
}

export function reloadWhenIdle() {
  if (!reloadPending) return;
  const until = unsentWork();
  if (!until) return reloadNow();
  const words = `A new version is ready and will load ${until}. `;
  const said = document.querySelector('#update-banner .update-until');
  if (said) said.textContent = words;
  else {
    const banner = h('div', { class: 'update-banner', id: 'update-banner' },
      h('span', { class: 'update-until' }, words),
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
  h('span', { class: 'label' }), h('span', { class: 'track' }, h('span', { class: 'fill' })), costChip());

/**
 * One window combined across a person's accounts (Cara, 2026-11-16: "just combine all accounts into a single bar"):
 * the average utilization, equal weight. An account with no report, or whose window already reset, counts as 0%.
 * resetsAt is the soonest still-ahead reset. Null when no account has reported that window at all.
 */
export function combineWindows(accounts, key) {
  const ws = accounts.map((a) => a.usage?.[key]);
  if (!ws.some(Boolean)) return null;
  const now = Date.now();
  const util = ws.map((w) => (w && (!w.resetsAt || w.resetsAt > now) ? Math.min(1, Math.max(0, w.utilization)) : 0));
  const resets = ws.filter((w) => w?.resetsAt > now).map((w) => w.resetsAt);
  return { utilization: util.reduce((x, y) => x + y, 0) / accounts.length, resetsAt: resets.length ? Math.min(...resets) : null };
}

/** Where a person's new minions start and why (#793), from usageOf's account, why and pinned. */
export function pickLine(u, accounts) {
  const a = accounts.find((x) => x.n === u.account);
  if (!a) return 'No Claude account is ready for new minions.';
  const reset = a.usage?.weekly?.resetsAt > Date.now() ? ` (${new Date(a.usage.weekly.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })})` : '';
  const why = u.why === 'pinned' ? 'you pinned it'
    : u.pinned ? `account ${u.pinned}, which you pinned, isn't ready`
    : u.why === 'full' ? 'every account is close to its limit'
    : `of the accounts with room, its week resets first${reset}`;
  return `New minions start on ${a.label}: ${why}. Running minions stay on their account while warm.`;
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
      ...(accounts ? ['', pickLine(usage, accounts), ...accounts.map((a) => `${a.n === usage.account ? '▸ ' : ''}${a.label}: ${a.usage?.weekly ? `week ${Math.round(a.usage.weekly.utilization * 100)}%` : 'no turns yet'}${a.usage?.session ? `, 5 hours ${Math.round(a.usage.session.utilization * 100)}%` : ''}`)] : []),
    ].filter((line) => line != null).join('\n');
  }
  for (const el of document.querySelectorAll('.usage:not(.codex)')) renderCodexSwitch(renderCodexMeter(el));
  for (const el of document.querySelectorAll('.codex-toggle')) syncToggle(el);
  for (const el of document.querySelectorAll('.codex-windows')) fillCodexWindows(el);
}

/** A bar in the Claude bar's look (#342); `.codex` keeps it out of the Claude bars' loops. */
const codexBar = () => h('a', { class: 'usage codex', href: usageHref(), 'aria-label': 'Usage details', hidden: true }, h('span', { class: 'label' }), h('span', { class: 'track' }, h('span', { class: 'fill' })), h('span', { class: 'which' }));
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
  const top = codexTop(codex.usage);
  const cu = sw.querySelector('.codex-usage');
  // Codex's own bar above says it already.
  cu.hidden = !codex.on || top == null || !bar.hidden;
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

// Phones and sleeping laptops drop connections quietly; recheck when the page comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !me) return;
  if (!stream) connectStream(true);
  else if (view?.kind === 'project') resync();
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
    const [{ coordinator, tickets, seen, person_notes, pins, builds }, artifacts, chat] = await Promise.all([
      api(`api/projects/${view.projectId}`),
      api(`api/projects/${view.projectId}/artifacts`),
      view.id ? api(`api/tickets/${view.id}`) : null,
    ]);
    if (view !== v) return; // you went to another view meanwhile; its own load is fresh
    view.coordinator = coordinator;
    view.tickets = new Map(tickets.map((t) => [t.id, t]));
    view.seen = seen ?? view.seen;
    view.personNotes = person_notes ?? view.personNotes;
    view.pins = pins ?? view.pins;
    view.builds = builds ?? view.builds;
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
 * A thread's history from the cache, to draw at once, with what came since on its way (#527): `fresh`
 * resolves true once newer events have joined the page. Null when it isn't cached (or is still prefetching).
 */
export function cachedEvents(ticketId) {
  const page = eventCache.get(ticketId);
  if (!page || prefetching.has(ticketId)) return null;
  remember(ticketId, page);
  const fresh = api(eventsUrl(ticketId, `after=${page.events.at(-1)?.id ?? 0}`)).then((events) => {
    // Live events may have joined the page while this was on its way, so go by id, not by position.
    const have = new Set(page.events.map((e) => e.id));
    const added = events.filter((e) => !have.has(e.id));
    if (added.length) page.events = page.events.concat(added).sort((a, b) => a.id - b.id);
    return added.length > 0;
  }).catch(() => false); // the chat's catch-up fetches them again
  return { page, fresh };
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

export async function catchUpEvents() {
  const v = view;
  if (!v?.id) return;
  const events = await api(eventsUrl(v.merged?.src ?? v.id, `after=${v.lastEventId}`));
  if (view !== v) return; // another view (or chat) opened meanwhile: these aren't its events
  for (const ev of events) if (ev.id > view.lastEventId) appendEvent(ev);
}

export function onTicketUpdate(ticket) {
  if (view?.kind !== 'project') return;
  if (view.projectId !== ticket.project_id) return inboxOtherTicket(ticket);
  // Each person has their own Taskmaster (#919): the others' updates only refresh their entry in view.taskmasters.
  if (ticket.kind === 'coordinator' && view.coordinator && ticket.id !== view.coordinator.id) {
    // Another person's Taskmaster or the Overlord: its cards still count in Needs you.
    const tm = view.taskmasters?.find((t) => t.id === ticket.id);
    const before = tm?.ticket;
    if (tm) tm.ticket = ticket;
    return void inboxTicket(before, ticket);
  }
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
  if (view?.kind === 'project' && view.id && !/^#\/(f|apps|share)\b/.test(hash) && !new RegExp(`/t/${view.ticket?.number}(?!\\d)`).test(hash)) leaveSeen(view.id);
  let m;
  // A contraption in Citadel's window (frames.js): Citadel's page stays as it was underneath.
  if ((m = hash.match(/^#\/apps\/([a-z0-9][a-z0-9-]{0,31})$/))) return showFrame(m[1]);
  if ((m = hash.match(/^#\/share(\?.*)?$/))) return takeShare(m[1] ?? '', seq);
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
    else if ((m = hash.match(/^#\/p\/(\d+)\/artifacts$/))) await showProject(Number(m[1]), { kind: 'files', folder: '@minions' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/(?:settings|instructions)$/))) await showProject(Number(m[1]), { kind: 'instructions' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/app-instructions$/))) await showProject(Number(m[1]), { kind: 'app-instructions' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/my-instructions$/))) await showProject(Number(m[1]), { kind: 'my-instructions' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/approvals$/))) await showProject(Number(m[1]), { kind: 'approvals' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/properties$/))) await showProject(Number(m[1]), { kind: 'properties' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/(members|people|contraptions|account|usage)$/))) await showProject(Number(m[1]), { kind: m[2] });
    else if ((m = hash.match(/^#\/p\/(\d+)\/machines$/))) await showProject(Number(m[1]), { kind: 'machines' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/shared$/))) await showProject(Number(m[1]), { kind: 'files' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/releases\/(all|\d+)(?:\/(\d+))?$/))) await showReleases(Number(m[1]), m[2] === 'all' ? 'all' : Number(m[2]), m[3] ? Number(m[3]) : null);
    else if ((m = hash.match(/^#\/a\/(\d+)$/))) await showArtifact(Number(m[1]));
    else if ((m = hash.match(/^#\/s\/(\d+)\/(.+)$/))) await showSharedFile(Number(m[1]), decodeURIComponent(m[2]));
    else if ((m = hash.match(/^#\/f\/(\d+)\/(.+)$/))) await showFile(Number(m[1]), decodeURIComponent(m[2]));
    else if ((m = hash.match(/^#\/p\/(\d+)\/t\/(\d+)$/))) await showProject(Number(m[1]), { kind: 'chat', number: Number(m[2]) });
    else if ((m = hash.match(/^#\/t\/(\d+)$/))) await showTicket(Number(m[1]));
    else await openStartScheme();
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
    if (seq === routeSeq) document.body.classList.remove('navigating');
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

setShowLogin(renderLogin);

function renderLogin() {
  reconnecting(false); // signed out: the stream's 401s aren't a restart
  setView(null);
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
  setView(null);
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
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const img = e.target instanceof Element ? e.target.closest('.msg a > img, .md a > img') : null;
  const link = img?.parentElement;
  if (!link?.href) return;
  e.preventDefault();
  lightbox([{ src: link.href, alt: img.alt || 'Picture' }]);
});
