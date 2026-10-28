// Shared by every view: state, API and DOM helpers, live updates, routing and sign-in.
import { onMachinesUpdate, onProjectUpdate, pushOff } from './settings.js';
import { openStartScheme, renderSidebar } from './sidebar.js';
import { showProject, showTicket } from './project.js';
import { closeViewer, onArtifactsChanged, setArtifacts, showArtifact, showFile, showSharedFile } from './artifacts.js';
import { appendEvent, refreshBranch, renderBranch, renderTicketHead } from './thread.js';
import { onPropertiesChanged } from './properties.js';
import { inboxEvent, inboxTicket } from './inbox.js';
import { inAppHash, linkThreadRefs } from './threadrefs.js';

export const app = document.getElementById('app');
export const crumbs = document.getElementById('crumbs');
const meEl = document.getElementById('me');

const STATUS_LABEL = { running: 'Running', idle: 'Waiting for you', new: 'Starting', error: 'Error', closed: 'Dismissed' };
// Thread naming and the threads list follow Delve's Custom view: threads are grouped by kind of
// work, and each is one compact row of number + short ask, a state, and a terse note.
export const TAGS = {
  feature: { emoji: '🛠️', label: 'Feature', section: 'Features' },
  bug: { emoji: '🐛', label: 'Bug', section: 'Bugs' },
  design: { emoji: '🎨', label: 'Design', section: 'Design' },
  process: { emoji: '⚙️', label: 'Process', section: 'Process' },
  idea: { emoji: '💡', label: 'Idea', section: 'Ideas' },
};
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
  if (res.status === 401 && path !== '/api/login') {
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
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image',
  mp4: 'video', webm: 'video', mov: 'video', mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio',
};
export const fileKind = (path) => FILE_KINDS[(path.split(/[?#]/)[0].split('.').pop() || '').toLowerCase()] ?? null;
export const baseName = (path) => path.split('/').filter(Boolean).pop() ?? path;
export const fileExt = (path) => (baseName(path).includes('.') ? baseName(path).split('.').pop().slice(0, 5).toUpperCase() : 'FILE');
/** A link target that is a path on disk, not a URL, a fragment or a mail address. */
export const isLocalPath = (href) => !/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href);
export const fileUrl = (ticketId, path) => `/api/tickets/${ticketId}/file?path=${encodeURIComponent(path)}`;
export const fileHref = (ticketId, path) => `#/f/${ticketId}/${encodeURIComponent(path)}`;
export const sharedUrl = (projectId, path) => `/api/projects/${projectId}/shared/file?path=${encodeURIComponent(path)}`;
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
  return `<a class="file-card" href="${escapeHtml(fileHref(ticketId, path))}" title="${escapeHtml(path)}">`
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
  return `<a class="file-preview" href="${escapeHtml(fileHref(ticketId, path))}" title="${escapeHtml(path)}">${media}`
    + `${caption ? `<span class="caption">${caption}</span>` : ''}</a>`;
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

/** Link "#12" in some HTML to thread 12 of the project on screen, titled with its name when known. */
function threadRefsHtml(html) {
  if (view?.kind !== 'project') return html;
  return linkThreadRefs(html, view.projectId, (n) => {
    for (const t of view.tickets.values()) if (t.number === n) return threadLabel(t);
    return null;
  });
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
 * Fuller Markdown for documents threads write: headings, nested lists, tables, quotes, rules,
 * italics, and images, which `imageUrl` maps to a URL (or null to show the alt text instead).
 */
export function markdownDoc(src, opts = {}) {
  const { imageUrl = () => null, ticketId = null, breaks = false } = typeof opts === 'function' ? { imageUrl: opts } : opts;
  const inline = (t) => {
    // Pull code spans out first so nothing inside them is treated as Markdown.
    const codes = [];
    let html = escapeHtml(t).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    if (ticketId != null) {
      // In a thread's messages, files in its folders become previews and cards (see filePreviewHtml).
      html = html
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (all, alt, href) => filePreviewHtml(ticketId, unescapeHtml(href), alt) ?? all)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, href) => fileCardHtml(ticketId, unescapeHtml(href), text) ?? all);
    }
    html = html
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, href) => {
        const url = imageUrl(href.replace(/&amp;/g, '&'));
        return url
          ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt="${alt}" title="${alt}" loading="lazy"></a>`
          : `<span class="muted">[image: ${alt}]</span>`;
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
        // Links into this app (a thread, an artifact…) switch view in place; others open a new tab.
        const route = inAppHash(unescapeHtml(href), location);
        if (route) return `<a href="${escapeHtml(route)}">${text}</a>`;
        return /^https?:\/\//.test(href)
          ? `<a href="${href}" target="_blank" rel="noopener">${text}</a>`
          : `<span class="link" title="${href}">${text}</span>`;
      })
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s](?:[^*]*?[^*\s])?)\*(?![\w*])/g, '$1<em>$2</em>');
    html = threadRefsHtml(html);
    return html.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  };
  const isItem = (l) => /^\s*([-*+]|\d+\.)\s+/.test(l);
  const startsBlock = (l) => /^(#{1,6}\s|```|>|\s*\|)/.test(l) || /^([-*+]|\d+\.)\s+/.test(l);

  const list = (lines) => {
    const root = { indent: -1, children: [] };
    const stack = [root];
    for (const l of lines) {
      const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(l);
      if (!m) {
        // A wrapped line carries on the item above it.
        stack[stack.length - 1].text += ` ${l.trim()}`;
        continue;
      }
      while (stack.length > 1 && m[1].length <= stack[stack.length - 1].indent) stack.pop();
      const item = { indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3], children: [] };
      stack[stack.length - 1].children.push(item);
      stack.push(item);
    }
    const render = (items) => {
      const tag = items[0].ordered ? 'ol' : 'ul';
      return `<${tag}>${items.map((it) => `<li>${inline(it.text)}${it.children.length ? render(it.children) : ''}</li>`).join('')}</${tag}>`;
    };
    return root.children.length ? render(root.children) : '';
  };

  const table = (rows) => {
    const cells = (r) => r.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, '|')));
    const hasHead = rows.length > 1 && /^[\s|:-]+$/.test(rows[1]);
    const head = hasHead ? `<thead><tr>${cells(rows[0]).map((c) => `<th>${c}</th>`).join('')}</tr></thead>` : '';
    const body = (hasHead ? rows.slice(2) : rows).map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table>${head}<tbody>${body}</tbody></table></div>`;
  };

  const lines = src.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) {
      i++;
    } else if (/^```/.test(line)) {
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line))) {
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      i++;
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
    } else if (/^\s*\|/.test(line)) {
      const rows = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i]);
      out.push(table(rows));
    } else if (/^>/.test(line)) {
      const quoted = [];
      for (; i < lines.length && /^>/.test(lines[i]); i++) quoted.push(lines[i].replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdownDoc(quoted.join('\n'), { imageUrl, ticketId, breaks }).innerHTML}</blockquote>`);
    } else if (isItem(line)) {
      const items = [];
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() && (isItem(l) || /^\s/.test(l))) items.push(l);
        // One blank line inside a list is fine if the list carries on after it.
        else if (!l.trim() && i + 1 < lines.length && (isItem(lines[i + 1]) || /^\s+\S/.test(lines[i + 1]))) continue;
        else if (l.trim() && !startsBlock(l) && items.length && lines[i - 1].trim()) items.push(l); // lazy wrap
        else break;
      }
      out.push(list(items));
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && (!para.length || !startsBlock(lines[i])); i++) para.push(lines[i].trim());
      out.push(`<p>${breaks ? para.map(inline).join('<br>') : inline(para.join(' '))}</p>`);
    }
  }
  const div = document.createElement('div');
  div.innerHTML = out.join('');
  return div;
}

// The chat follows new output only while you are at the bottom. Tracked on scroll rather than
// measured when output arrives, so a burst of events can't misjudge it, and kept tight so that
// scrolling up even a little leaves you where you are.
const BOTTOM_SLACK = 24;
// In the full-screen file viewer the chat scrolls in its own column instead of the page.
const chatScroller = () => document.querySelector('dialog.viewer[open] > .chat');
const atBottom = () => {
  const el = chatScroller();
  return el ? el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_SLACK
    : window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - BOTTOM_SLACK;
};
export let followChat = true;
// Captured, so the viewer's chat column (whose scroll events don't bubble) counts too.
document.addEventListener('scroll', (e) => {
  if (e.target === document || e.target === chatScroller()) followChat = atBottom();
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

window.addEventListener('pagehide', saveScroll);

// ---------- live updates ----------

let streamRetry = 0;
let streamTimer = null;

function connectStream(catchUp = false) {
  if (stream || !me) return;
  clearTimeout(streamTimer);
  const es = new EventSource('/api/stream');
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
    if (msg.type === 'hello' || msg.type === 'usage') {
      renderUsage(msg.usage);
      // Rows of minions that hit the usage limit count down to its reset.
      if (view?.kind === 'project') renderSidebar();
    }
    if (msg.type === 'ticket') onTicketUpdate(msg.ticket);
    if (msg.type === 'event') {
      onEvent(msg.event);
      inboxEvent(msg.event);
    }
    if (msg.type === 'artifacts') onArtifactsChanged(msg.projectId);
    if (msg.type === 'project') onProjectUpdate(msg.project);
    if (msg.type === 'properties') onPropertiesChanged(msg.projectId);
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
  if (document.querySelector('.attachments:not([hidden])')) return true;
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
    document.querySelector('.topbar').after(h('div', { class: 'update-banner', id: 'update-banner' },
      'A new version is ready and will load once you have sent or cleared what you are writing. ',
      h('button', { class: 'secondary small', onclick: reloadNow }, 'Refresh now'),
      h('span', { class: 'muted' }, ' (drafts are kept)')));
  }
}

setInterval(reloadWhenIdle, 2000);

// ---------- account usage ----------

export let usage = null;

/** A weekly-limit bar; one lives in the top bar and one in a project's side panel. */
export const usageMeter = () => h('div', { class: 'usage', hidden: true },
  h('span', { class: 'label' }), h('span', { class: 'track' }, h('span', { class: 'fill' })));

/** Fill in every usage bar from the latest usage report from Claude turns. */
export function renderUsage(next = usage) {
  usage = next;
  const week = usage?.weekly;
  for (const el of document.querySelectorAll('.usage')) {
    el.hidden = !week;
    if (!week) continue;
    const pct = Math.round(Math.min(1, Math.max(0, week.utilization)) * 100);
    el.querySelector('.label').textContent = `Week ${pct}%`;
    el.style.setProperty('--pct', `${pct}%`);
    el.dataset.level = week.status && week.status !== 'allowed' ? 'error' : pct >= 90 ? 'error' : pct >= 75 ? 'warn' : '';
    const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    el.title = [
      `Weekly usage of this Claude account: ${pct}%${week.resetsAt ? `, resets ${when(week.resetsAt)}` : ''}`,
      usage.session ? `5-hour window: ${Math.round(usage.session.utilization * 100)}%${usage.session.resetsAt ? `, resets ${when(usage.session.resetsAt)}` : ''}` : null,
      `As of the last turn, ${ago(usage.updatedAt)}`,
    ].filter(Boolean).join('\n');
  }
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
    const [{ coordinator, tickets, seen }, artifacts, chat] = await Promise.all([
      api(`/api/projects/${view.projectId}`),
      api(`/api/projects/${view.projectId}/artifacts`),
      view.id ? api(`/api/tickets/${view.id}`) : null,
    ]);
    view.coordinator = coordinator;
    view.tickets = new Map(tickets.map((t) => [t.id, t]));
    view.seen = seen ?? view.seen;
    if (view.id) markSeen(view.id);
    renderSidebar();
    setArtifacts(artifacts);
    if (!chat) return;
    view.ticket = chat.ticket;
    renderTicketHead();
    if (view.ticket.branch) refreshBranch(view.id);
    await catchUpEvents();
  } catch {}
}

// Threads' histories already downloaded this session, so reopening one only fetches what is new.
// Events are append-only, so the cached part never goes stale. Most recently used last.
const eventCache = new Map();
const EVENT_CACHE_THREADS = 12;

export async function loadEvents(ticketId) {
  // A prefetch already on its way is the head start: wait for it, then fetch only what came after.
  await prefetching.get(ticketId);
  const cached = eventCache.get(ticketId) ?? [];
  const after = cached.length ? cached[cached.length - 1].id : 0;
  const fresh = await api(`/api/tickets/${ticketId}/events${after ? `?after=${after}` : ''}`);
  const events = fresh.length ? cached.concat(fresh) : cached;
  eventCache.delete(ticketId);
  eventCache.set(ticketId, events);
  if (eventCache.size > EVENT_CACHE_THREADS) eventCache.delete(eventCache.keys().next().value);
  return events;
}

// Prefetching: a thread's history starts downloading when you point at (or touch) its row, and the
// top few rows load quietly once a project page settles, so a first click opens from the cache.
// A prefetch only fills a free cache slot, never evicting a thread you actually opened.
const prefetching = new Map(); // ticket id -> its download in flight
const PREFETCH_ROWS = 6;

function prefetchEvents(ticketId) {
  if (eventCache.has(ticketId) || prefetching.has(ticketId) || eventCache.size >= EVENT_CACHE_THREADS) return prefetching.get(ticketId);
  const p = api(`/api/tickets/${ticketId}/events`)
    .then((events) => { if (!eventCache.has(ticketId) && eventCache.size < EVENT_CACHE_THREADS) eventCache.set(ticketId, events); })
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

/** Once the page is idle, load the first few minions in the list, two at a time. Not on data saver. */
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
  const events = await api(`/api/tickets/${view.id}/events?after=${view.lastEventId}`);
  for (const ev of events) if (ev.id > view.lastEventId) appendEvent(ev);
}

function onTicketUpdate(ticket) {
  if (view?.kind !== 'project' || view.projectId !== ticket.project_id) return;
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

// ---------- seen ----------

const seenTimers = new Map();
/** Record that you have looked at a thread as it is now (shortly, so a burst of updates sends one). */
export function markSeen(ticketId) {
  if (seenTimers.has(ticketId)) return;
  seenTimers.set(ticketId, setTimeout(async () => {
    seenTimers.delete(ticketId);
    try {
      const { seen_at } = await api(`/api/tickets/${ticketId}/seen`, { method: 'POST', body: {} });
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
  saveScroll();
  const seq = ++routeSeq;
  const hash = location.hash || '#/';
  // Answer the click straight away: highlight the thread being opened and dim the old view.
  for (const a of document.querySelectorAll('#coordinator-row .thread-row, #threads .thread-row')) a.classList.toggle('active', a.getAttribute('href') === hash);
  document.body.classList.add('navigating');
  let m;
  try {
    // Leaving the file viewer for the chat under it just closes it; anywhere else goes on from there.
    if (!hash.startsWith('#/f/') && closeViewer() === hash) return;
    if ((m = hash.match(/^#\/p\/(\d+)$/))) await showProject(Number(m[1]));
    else if ((m = hash.match(/^#\/p\/(\d+)\/artifacts$/))) await showProject(Number(m[1]), { kind: 'artifacts' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/inbox$/))) await showProject(Number(m[1]), { kind: 'inbox' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/(?:settings|instructions)$/))) await showProject(Number(m[1]), { kind: 'instructions' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/approvals$/))) await showProject(Number(m[1]), { kind: 'approvals' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/properties$/))) await showProject(Number(m[1]), { kind: 'properties' });
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

window.addEventListener('hashchange', route);

// A plain click on any link into this app (even a full https://… one, or one marked to open a new
// tab) switches view through the router instead of opening a tab or reloading the page.
// Ctrl/Cmd/Shift/middle-click still open it in a new tab or window.
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.('a[href]');
  if (!a || a.hasAttribute('download')) return;
  const hash = inAppHash(a.getAttribute('href'), location);
  if (!hash) return;
  e.preventDefault();
  if (location.hash !== hash) location.hash = hash;
});

// ---------- login ----------

function renderLogin() {
  view = null;
  crumbs.replaceChildren();
  meEl.replaceChildren();
  app.replaceChildren(document.getElementById('login-tpl').content.cloneNode(true));
  const form = document.getElementById('login-form');
  // A saved name that is really the site's address (filled in by a phone's password manager) is dropped.
  try { const saved = localStorage.getItem('cc-name') || ''; form.name.value = /^https?\W|\//i.test(saved) ? '' : saved; } catch {}
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('login-error');
    try {
      const res = await api('/api/login', { method: 'POST', body: { name: form.name.value, password: form.password.value } });
      try { localStorage.setItem('cc-name', res.name); } catch {}
      start(res.name);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
}

export function start(name) {
  me = name;
  meEl.replaceChildren(name, h('button', { class: 'secondary', onclick: logout }, 'Sign out'));
  connectStream();
  route();
}

export async function logout() {
  // Notifications on this device were for the person signing out.
  await pushOff().catch(() => {});
  await api('/api/logout', { method: 'POST', body: {} });
  eventCache.clear();
  clearTimeout(streamTimer);
  stream?.close();
  stream = null;
  me = null;
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
  const tag = TAGS[t.tag];
  const state = t.status !== 'running' && STATES[t.state];
  return [tag?.emoji, t.number ?? t.id, tag ? `${tag.label.toUpperCase()}: ${t.title}` : t.title, state?.emoji].filter(Boolean).join(' ');
}

/** threadFullName in parts; phones hide the tag word and state emoji, which the emoji and state label already say. */
export function threadTitleParts(t) {
  if (isCoordinator(t)) return taskmasterLabel(t.project_id);
  const tag = TAGS[t.tag];
  const state = t.status !== 'running' && STATES[t.state];
  return [tag ? `${tag.emoji} ` : '', `${t.number ?? t.id} `, tag ? h('span', { class: 'wide-only' }, `${tag.label.toUpperCase()}: `) : '', t.title,
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
