// Front end: hash-routed views over the JSON API, live via SSE.
import { actionLabel, applyEvent, createProgress, progressLine, stepInfo, workPhases } from './progress.js';
import { inAppHash, linkThreadRefs } from './threadrefs.js';
import { initDrawers } from './drawers.js';
import { threadSections } from './threadgroups.js';

const app = document.getElementById('app');
const crumbs = document.getElementById('crumbs');
const meEl = document.getElementById('me');

const STATUS_LABEL = { running: 'Running', idle: 'Waiting for you', new: 'Starting', error: 'Error', closed: 'Dismissed' };
// Thread naming and the threads list follow Delve's Custom view: threads are grouped by kind of
// work, and each is one compact row of number + short ask, a state, and a terse note.
const TAGS = {
  feature: { emoji: '🛠️', label: 'Feature', section: 'Features' },
  bug: { emoji: '🐛', label: 'Bug', section: 'Bugs' },
  design: { emoji: '🎨', label: 'Design', section: 'Design' },
  process: { emoji: '⚙️', label: 'Process', section: 'Process' },
  idea: { emoji: '💡', label: 'Idea', section: 'Ideas' },
};
const STATES = {
  ready: { emoji: '✅', label: 'Ready to merge or pick up' },
  try: { emoji: '🧪', label: 'Ready for you to try' },
  parked: { emoji: '🧊', label: 'Parked' },
  blocked: { emoji: '⛔', label: 'Blocked on something outside the minion' },
  outside: { emoji: '⏳', label: 'Waiting on work running elsewhere' },
};

let me = null;
let view = null; // { kind, id, ... } for the current screen
let stream = null;
let assetVersion = null;

// ---------- helpers ----------

async function api(path, opts = {}) {
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

function h(tag, attrs = {}, ...children) {
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

function ago(ms) {
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
const fileKind = (path) => FILE_KINDS[(path.split(/[?#]/)[0].split('.').pop() || '').toLowerCase()] ?? null;
const baseName = (path) => path.split('/').filter(Boolean).pop() ?? path;
const fileExt = (path) => (baseName(path).includes('.') ? baseName(path).split('.').pop().slice(0, 5).toUpperCase() : 'FILE');
/** A link target that is a path on disk, not a URL, a fragment or a mail address. */
const isLocalPath = (href) => !/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href);
const fileUrl = (ticketId, path) => `/api/tickets/${ticketId}/file?path=${encodeURIComponent(path)}`;
const fileHref = (ticketId, path) => `#/f/${ticketId}/${encodeURIComponent(path)}`;
const sharedUrl = (projectId, path) => `/api/projects/${projectId}/shared/file?path=${encodeURIComponent(path)}`;
const sharedHref = (projectId, path) => `#/s/${projectId}/${encodeURIComponent(path)}`;
/** A linked path short enough for a card: a thread's shared folder by name, other absolute paths by their tail. */
function shortPath(path) {
  const projectShared = /\/shared\/project\/(.+)$/.exec(path);
  if (projectShared) return `scheme shared/${projectShared[1]}`;
  const shared = /\/shared\/\d+\/(.+)$/.exec(path);
  if (shared) return `shared files/${shared[1]}`;
  return path.startsWith('/') ? `…/${path.split('/').slice(-2).join('/')}` : path;
}

/** `[title](path)` in a thread's reply: a card that opens the file in place of the chat. */
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
function joinPath(dir, rel) {
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
function threadRefs(text) {
  const span = document.createElement('span');
  span.innerHTML = threadRefsHtml(escapeHtml(String(text ?? '')));
  return [...span.childNodes];
}

/**
 * Markdown in chat messages: the document renderer below (tables, headings, lists, quotes…), with
 * single line breaks kept as typed. With `ticketId`, links to paths in that thread's folders become
 * file cards and `![…](path)` an inline preview; both open the file in place of the chat.
 */
function markdown(src, ticketId = null) {
  return markdownDoc(src, { ticketId, breaks: true });
}

/**
 * Fuller Markdown for documents threads write: headings, nested lists, tables, quotes, rules,
 * italics, and images, which `imageUrl` maps to a URL (or null to show the alt text instead).
 */
function markdownDoc(src, opts = {}) {
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

// ---------- drafts ----------

// Unsent text survives reloads and switching threads: it is saved per thread as you type.
// Text goes to localStorage; images are too big for it, so they go to IndexedDB.
function loadDraft(key) {
  try { return JSON.parse(localStorage.getItem(key)) ?? null; } catch { return null; }
}

function saveDraft(key, value) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {}
}

let draftDb = null;
function draftStore(mode, fn) {
  draftDb ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('cc-drafts', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('images');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return draftDb.then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('images', mode);
    const req = fn(tx.objectStore('images'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  }));
}

const loadDraftImages = (ticketId) => draftStore('readonly', (s) => s.get(ticketId)).then((v) => v ?? [], () => []);
const saveDraftImages = (ticketId, items) =>
  draftStore('readwrite', (s) => (items.length ? s.put(items, ticketId) : s.delete(ticketId))).catch(() => {});

// The chat follows new output only while you are at the bottom. Tracked on scroll rather than
// measured when output arrives, so a burst of events can't misjudge it, and kept tight so that
// scrolling up even a little leaves you where you are.
const BOTTOM_SLACK = 24;
const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - BOTTOM_SLACK;
let followChat = true;
window.addEventListener('scroll', () => { followChat = atBottom(); }, { passive: true });
function scrollToBottom() {
  window.scrollTo(0, document.documentElement.scrollHeight);
  followChat = true;
}
// Images finish loading after they are added; stay pinned to the bottom if you were following.
document.addEventListener('load', (e) => {
  if (followChat && e.target.tagName === 'IMG' && e.target.closest('#log')) scrollToBottom();
}, true);

/** Which side panels (artifacts shelf, threads list) are open on wide screens. */
function loadPanelState() {
  try { return JSON.parse(localStorage.getItem('cc-panels')) ?? {}; } catch { return {}; }
}
function savePanelState(state) {
  try { localStorage.setItem('cc-panels', JSON.stringify(state)); } catch {}
}

/** Where each thread was scrolled to, so coming back lands in the same place. */
function saveScroll() {
  if (view?.kind !== 'project' || !view.id) return;
  try { sessionStorage.setItem(`cc-scroll:${view.id}`, JSON.stringify(followChat ? 'bottom' : window.scrollY)); } catch {}
}

function restoreScroll(ticketId) {
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
      renderUsage(msg.usage);
    }
    if (msg.type === 'usage') renderUsage(msg.usage);
    if (msg.type === 'ticket') onTicketUpdate(msg.ticket);
    if (msg.type === 'event') onEvent(msg.event);
    if (msg.type === 'artifacts') onArtifactsChanged(msg.projectId);
    if (msg.type === 'project') onProjectUpdate(msg.project);
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
let sending = 0;
const QUIET_MS = 5000;

document.addEventListener('input', () => { lastInputAt = Date.now(); }, true);
document.addEventListener('keydown', () => { lastInputAt = Date.now(); }, true);

function hasUnsentWork() {
  if (sending || Date.now() - lastInputAt < QUIET_MS) return true;
  if (document.querySelector('.attachments:not([hidden])')) return true;
  return [...app.querySelectorAll('[data-draft]')].some((el) => el.value.trim());
}

function reloadNow() {
  // Put the cursor back in the composer if that is where it was.
  if (document.activeElement?.matches('.composer textarea')) {
    try { sessionStorage.setItem('cc-refocus', '1'); } catch {}
  }
  location.reload();
}

function reloadWhenIdle() {
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

let usage = null;

/** A weekly-limit bar; one lives in the top bar and one in a project's side panel. */
const usageMeter = () => h('div', { class: 'usage', hidden: true },
  h('span', { class: 'label' }), h('span', { class: 'track' }, h('span', { class: 'fill' })));

/** Fill in every usage bar from the latest usage report from Claude turns. */
function renderUsage(next = usage) {
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

async function loadEvents(ticketId) {
  const cached = eventCache.get(ticketId) ?? [];
  const after = cached.length ? cached[cached.length - 1].id : 0;
  const fresh = await api(`/api/tickets/${ticketId}/events${after ? `?after=${after}` : ''}`);
  const events = fresh.length ? cached.concat(fresh) : cached;
  eventCache.delete(ticketId);
  eventCache.set(ticketId, events);
  if (eventCache.size > EVENT_CACHE_THREADS) eventCache.delete(eventCache.keys().next().value);
  return events;
}

async function catchUpEvents() {
  if (!view.id) return;
  const events = await api(`/api/tickets/${view.id}/events?after=${view.lastEventId}`);
  for (const ev of events) if (ev.id > view.lastEventId) appendEvent(ev);
}

function onTicketUpdate(ticket) {
  if (view?.kind !== 'project' || view.projectId !== ticket.project_id) return;
  if (ticket.kind === 'coordinator') view.coordinator = ticket;
  else view.tickets.set(ticket.id, ticket);
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
function markSeen(ticketId) {
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
const isSeen = (t) => (view.seen?.[t.id] ?? 0) >= t.updated_at;

function onEvent(event) {
  if (view?.kind !== 'project' || view.id !== event.ticket_id) return;
  if (event.id <= view.lastEventId) return;
  appendEvent(event);
}

// ---------- routing ----------

// Bumped on every navigation, so a slow load that another click has overtaken is dropped.
let routeSeq = 0;

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
    if ((m = hash.match(/^#\/p\/(\d+)$/))) await showProject(Number(m[1]));
    else if ((m = hash.match(/^#\/p\/(\d+)\/artifacts$/))) await showProject(Number(m[1]), { kind: 'artifacts' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/instructions$/))) await showProject(Number(m[1]), { kind: 'instructions' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/approvals$/))) await showProject(Number(m[1]), { kind: 'approvals' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/machines$/))) await showProject(Number(m[1]), { kind: 'machines' });
    else if ((m = hash.match(/^#\/p\/(\d+)\/shared$/))) await showProject(Number(m[1]), { kind: 'sharedList' });
    else if ((m = hash.match(/^#\/a\/(\d+)$/))) await showArtifact(Number(m[1]));
    else if ((m = hash.match(/^#\/s\/(\d+)\/(.+)$/))) await showSharedFile(Number(m[1]), decodeURIComponent(m[2]));
    else if ((m = hash.match(/^#\/f\/(\d+)\/(.+)$/))) await showFile(Number(m[1]), decodeURIComponent(m[2]));
    else if ((m = hash.match(/^#\/p\/(\d+)\/t\/(\d+)$/))) await showProject(Number(m[1]), { kind: 'chat', number: Number(m[2]) });
    else if ((m = hash.match(/^#\/t\/(\d+)$/))) await showTicket(Number(m[1]));
    else await showProjects();
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

function start(name) {
  me = name;
  meEl.replaceChildren(name, h('button', { class: 'secondary', onclick: logout }, 'Sign out'));
  connectStream();
  route();
}

async function logout() {
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

// ---------- push notifications ----------

// Web Push reaches this device with the app closed, for decisions, blockers and results only
// (question cards, failed turns, threads set ready, try or blocked); see src/push.ts.
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function pushSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** The browser's VAPID key as pushManager.subscribe wants it. */
function keyBytes(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Ask for permission (only ever from a click), subscribe this browser and register it for you. */
async function pushOn() {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked for this site in the browser settings');
  const { publicKey } = await api('/api/push/key');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another key (an older data dir) can't be used; start over.
  const key = sub?.options?.applicationServerKey;
  if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== publicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  return api('/api/push/subscription', { method: 'PUT', body: { subscription: sub.toJSON() } });
}

async function pushOff() {
  if (!pushSupported) return;
  const sub = await pushSubscription();
  if (!sub) return;
  await api('/api/push/subscription', { method: 'DELETE', body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}

/** "Notify me on this device", and once on, a mute for this project; in the account box. */
function pushControls(project) {
  if (!pushSupported) return null;
  const on = h('input', { type: 'checkbox' });
  const mute = h('input', { type: 'checkbox' });
  const hint = h('span', { class: 'hint', hidden: true });
  const muteRow = h('label', { class: 'toggle', hidden: true, title: 'Stop notifications from this scheme on this device' }, mute, `Mute ${project.name} here`);
  const el = h('div', { class: 'push' },
    h('label', { class: 'toggle', title: 'Questions for you, failed turns, and minions that are ready or blocked' }, on, 'Notify me on this device'),
    muteRow, hint);
  const show = (state, err) => {
    on.checked = state.subscribed;
    mute.checked = state.muted.includes(project.id);
    muteRow.hidden = !state.subscribed;
    const denied = Notification.permission === 'denied';
    on.disabled = denied && !state.subscribed;
    hint.textContent = err ?? (denied && !state.subscribed ? 'Blocked for this site in the browser settings' : '');
    hint.hidden = !hint.textContent;
  };
  const busy = async (fn) => {
    on.disabled = mute.disabled = true;
    try {
      show(await fn());
    } catch (ex) {
      await refresh(ex.message);
    } finally {
      mute.disabled = false;
      if (Notification.permission !== 'denied') on.disabled = false;
    }
  };
  /** Show where this browser stands (and `err`, if a change just failed). */
  async function refresh(err) {
    const sub = await pushSubscription().catch(() => null);
    const state = sub && await api('/api/push/subscription', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => null);
    show(state ?? { subscribed: false, muted: [] }, err);
  }
  on.addEventListener('change', () => busy(async () => {
    if (!on.checked) {
      await pushOff();
      return { subscribed: false, muted: [] };
    }
    return pushOn();
  }));
  mute.addEventListener('change', () => busy(async () => {
    const sub = await pushSubscription();
    return api('/api/push/subscription', { method: 'PATCH', body: { endpoint: sub.endpoint, projectId: project.id, muted: mute.checked } });
  }));
  refresh();
  return el;
}

// Clicking a notification while the app is open: the service worker asks this tab to show the thread.
if (pushSupported) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'open' || typeof e.data.url !== 'string') return;
    const hash = new URL(e.data.url, location.href).hash;
    if (hash && location.hash !== hash) location.hash = hash;
  });
}

// ---------- projects ----------

async function showProjects() {
  const projects = await api('/api/projects');
  view = { kind: 'projects' };
  crumbs.replaceChildren('Schemes');
  const form = h('form', {},
    h('label', {}, 'Name', h('input', { name: 'name', required: true, maxlength: 80, 'data-draft': true })),
    h('label', {}, 'Git repo URL (optional; each minion gets its own worktree)',
      h('input', { name: 'repoUrl', 'data-draft': true, placeholder: 'https://github.com/caraminden/gamedevtest.git' })),
    h('p', { class: 'error', hidden: true }),
    h('button', { type: 'submit' }, 'Create scheme'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    const err = form.querySelector('.error');
    btn.disabled = true;
    btn.textContent = form.repoUrl.value ? 'Cloning…' : 'Creating…';
    try {
      const p = await api('/api/projects', { method: 'POST', body: { name: form.name.value, repoUrl: form.repoUrl.value } });
      location.hash = `#/p/${p.id}`;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Create scheme';
    }
  });
  app.replaceChildren(
    h('h2', {}, 'Schemes'),
    projects.length
      ? h('div', { class: 'projects' }, projects.map((p) =>
          h('a', { class: 'card', href: `#/p/${p.id}` },
            h('div', { class: 'title' }, h('strong', { 'data-project-name': p.id }, p.name)),
            h('div', { class: 'muted' }, p.repo_url || 'No repo'),
            h('div', { class: 'muted' }, `${p.tickets} minion${p.tickets === 1 ? '' : 's'}`))))
      : h('p', { class: 'muted' }, 'No schemes yet.'),
    h('details', { class: 'new', open: !projects.length }, h('summary', {}, 'New scheme'), h('div', { class: 'card' }, form)),
  );
}

// ---------- project: threads sidebar + chat ----------

const isCoordinator = (t) => t.kind === 'coordinator';

function statusLabel(t) {
  if (isCoordinator(t) && t.status === 'new') return 'Ready';
  return STATUS_LABEL[t.status];
}

/**
 * Threads are numbered per project and live at #/p/<project>/t/<number>. A server from before
 * per-project numbers sends no number, so fall back to the global id there.
 */
const threadHref = (t) =>
  isCoordinator(t) ? `#/p/${t.project_id}` : t.number == null ? `#/t/${t.id}` : `#/p/${t.project_id}/t/${t.number}`;
const threadLabel = (t) => (isCoordinator(t) ? 'Taskmaster' : `#${t.number ?? t.id} ${t.title}`);
/** The full name, Delve style: "🛠️ 12 FEATURE: Usage bar ✅". */
function threadFullName(t) {
  if (isCoordinator(t)) return 'Taskmaster';
  const tag = TAGS[t.tag];
  const state = t.status !== 'running' && STATES[t.state];
  return [tag?.emoji, t.number ?? t.id, tag ? `${tag.label.toUpperCase()}: ${t.title}` : t.title, state?.emoji].filter(Boolean).join(' ');
}

/** threadFullName in parts; phones hide the tag word and state emoji, which the emoji and state label already say. */
function threadTitleParts(t) {
  if (isCoordinator(t)) return 'Taskmaster';
  const tag = TAGS[t.tag];
  const state = t.status !== 'running' && STATES[t.state];
  return [tag ? `${tag.emoji} ` : '', `${t.number ?? t.id} `, tag ? h('span', { class: 'wide-only' }, `${tag.label.toUpperCase()}: `) : '', t.title,
    state ? h('span', { class: 'wide-only' }, ` ${state.emoji}`) : ''];
}

/** Old links address a thread by its global id (#/t/<id>); send them to its project address. */
async function showTicket(ticketId) {
  const { ticket } = await api(`/api/tickets/${ticketId}`);
  if (isCoordinator(ticket) || ticket.number != null) return location.replace(threadHref(ticket));
  await showProject(ticket.project_id, { kind: 'chat', id: ticketId });
}

/** A file a thread linked in its reply, shown in place of the chat. */
async function showFile(ticketId, path) {
  const [{ ticket }, file] = await Promise.all([
    api(`/api/tickets/${ticketId}`),
    // A file that has gone (or never could be shown) still opens the view, saying so.
    api(`/api/tickets/${ticketId}/file?info&path=${encodeURIComponent(path)}`).catch((err) => ({
      missing: err.message, name: baseName(path), kind: fileKind(path) ?? 'text', display_path: shortPath(path),
    })),
  ]);
  await showProject(ticket.project_id, { kind: 'file', ticket, file: { ...file, path } });
}

/** A file in the project's shared folder, opened from the Shared group of the artifacts panel. */
async function showSharedFile(projectId, path) {
  const file = await api(`/api/projects/${projectId}/shared/file?info&path=${encodeURIComponent(path)}`).catch((err) => ({
    missing: err.message, name: baseName(path), kind: fileKind(path) ?? 'text', display_path: `scheme shared/${path}`,
  }));
  await showProject(projectId, { kind: 'shared', file: { ...file, path } });
}

async function showArtifact(artifactId) {
  const { artifact } = await api(`/api/artifacts/${artifactId}`);
  await showProject(artifact.project_id, { kind: 'artifact', artifact });
}

/** Per-thread state for the chat in the main panel; empty when the main panel shows something else. */
function chatView(chatId, ticket) {
  return {
    id: chatId, ticket, lastEventId: 0,
    progress: createProgress(),
    progressEl: h('div', { class: 'progress', hidden: true }), // lives in the thread bar
    findEl: chatId ? chatFindBox() : null, // lives in the thread bar too, so it survives re-renders
    ui: progressUi(chatId),
    actions: new Map(), // tool_use_id -> { block, taskId, result }
    turnActions: [], // actions of the current (or last) turn, in order
    typingEl: h('div', { class: 'typing', hidden: true, 'aria-live': 'polite', role: 'button', tabindex: '0' }), // below the chat log
    sendingTo: null, // ticket id while a message is on its way, before the server confirms the turn
    pendingMessages: [], // { el, text } shown on send, replaced by the server's copy
    cards: new Map(), // question card id -> { markAnswered }; approval card id -> { settle }
    branchEl: h('span', { class: 'branch-status', hidden: true }), // PR / branch state, on the newest turn-end line
  };
}

function renderCrumbs(main) {
  const { project } = view;
  const projectLink = h('a', { href: `#/p/${project.id}`, 'data-project-name': project.id }, project.name);
  const artifactsLink = h('a', { href: `#/p/${project.id}/artifacts` }, 'Artifacts');
  crumbs.replaceChildren(h('a', { href: '#/' }, 'Schemes'), ' / ', ...(
    main.kind === 'artifacts' ? [projectLink, ' / ', 'Artifacts']
      : main.kind === 'instructions' ? [projectLink, ' / ', 'Instructions']
      : main.kind === 'approvals' ? [projectLink, ' / ', 'Approvals']
      : main.kind === 'machines' ? [projectLink, ' / ', 'Machines']
      : main.kind === 'artifact' ? [projectLink, ' / ', artifactsLink, ' / ', main.artifact.name]
      : main.kind === 'sharedList' ? [projectLink, ' / ', 'Shared files']
      : main.kind === 'shared' ? [projectLink, ' / ', h('a', { href: `#/p/${project.id}/shared` }, 'Shared files'), ' / ', main.file.name]
      : main.kind === 'file' ? [projectLink, ' / ', h('a', { href: threadHref(main.ticket) }, isCoordinator(main.ticket) ? 'Taskmaster' : `#${main.ticket.number ?? main.ticket.id}`), ' / ', main.file.name]
        : view.id !== view.coordinator.id ? [projectLink, ' / ', `#${view.ticket.number ?? view.ticket.id}`]
          : [h('span', { 'data-project-name': project.id }, project.name)]));
}

/**
 * A project page: artifacts and threads on the side, and in the main panel a chat with the
 * coordinator (or the chosen ticket), the artifact browser, or one artifact.
 */
async function showProject(projectId, main = { kind: 'chat', number: null }) {
  const seq = routeSeq;
  // Moving between chats of the project already on screen only swaps the chat; the side panels stay.
  if (main.kind === 'chat' && view?.kind === 'project' && view.projectId === projectId && document.getElementById('threads')) {
    if (await switchChat(main, seq)) return;
  }
  const [{ project, coordinator, tickets, seen }, artifacts, shared, projects, machines] = await Promise.all([
    api(`/api/projects/${projectId}`),
    // An empty shelf beats a broken page if the server is older than this front end.
    api(`/api/projects/${projectId}/artifacts`).catch(() => []),
    api(`/api/projects/${projectId}/shared`).catch(() => []),
    api('/api/projects').catch(() => []),
    api('/api/machines').catch(() => []),
  ]);
  let chatId = null;
  if (main.kind === 'chat') {
    chatId = main.id ?? (main.number == null ? coordinator.id : tickets.find((t) => t.number === main.number)?.id);
    if (!chatId) throw new Error(`There is no minion #${main.number} in ${project.name}.`);
  }
  const [{ ticket }, events] = chatId
    ? await Promise.all([api(`/api/tickets/${chatId}`), loadEvents(chatId)])
    : [{ ticket: null }, []];
  if (seq !== routeSeq) return; // overtaken by another click while loading
  view = {
    kind: 'project', main: main.kind, projectId, project, coordinator, tickets: new Map(tickets.map((t) => [t.id, t])),
    seen: seen ?? {}, // ticket id -> when you last looked at it (server time)
    artifacts, shared, artifactId: main.artifact?.id ?? null, machines,
    file: main.file ?? null, fileTicket: main.ticket ?? null,
    ...chatView(chatId, ticket),
  };
  renderCrumbs(main);

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
        h('button', { class: 'secondary small', onclick: logout }, 'Sign out')),
      usageMeter(),
      pushControls(project)),
    h('section', { class: 'column' },
      h('h3', {}, 'Schemes', h('span', { class: 'spacer' }), h('a', { class: 'more', href: '#/' }, 'All')),
      projects.map((p) => h('a', { class: `nav-item${p.id === projectId ? ' active' : ''}`, href: `#/p/${p.id}` },
        h('span', { class: 'name', 'data-project-name': p.id }, p.name)))),
    h('div', { id: 'instructions-shelf' }),
    h('div', { id: 'approvals-shelf' }),
    h('div', { id: 'machines-shelf' }),
    h('div', { id: 'artifact-shelf' }));
  const sidebar = h('details', { class: 'sidebar', open: panelOpen('threads') },
    h('summary', { title: 'Show or hide minions' }, h('span', { class: 'label' }, 'Minions')),
    newTicketForm(projectId),
    // The coordinator sits above the search so it stays one click away while searching.
    h('div', { id: 'coordinator-row' }),
    threadSearchBox(projectId),
    h('div', { id: 'threads' }));
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
    : main.kind === 'machines' ? machinesPage()
    : main.kind === 'sharedList' ? sharedList()
    : main.kind === 'artifact' ? artifactViewer(main.artifact)
      : main.kind === 'file' ? fileViewer(main.ticket, main.file)
        : main.kind === 'shared' ? sharedViewer(main.file)
        : chatSection(chatId, ticket, events);

  // .panels only becomes a box of its own when both panels are collapsed, so their tabs can share
  // one slim sticky column; otherwise the panels sit directly in the grid.
  app.replaceChildren(h('div', { class: 'split' }, h('div', { class: 'panels' }, shelf, sidebar), section));
  renderUsage();
  renderInstructionsShelf();
  renderApprovalsShelf();
  renderMachinesShelf();
  renderShelf();
  renderSidebar();
  if (main.kind === 'artifacts') renderArtifactResults();
  if (main.kind === 'artifact') renderArtifactHead();
  if (main.kind === 'file') renderFileHead();
  if (main.kind === 'shared') renderSharedHead();
  if (main.kind === 'sharedList') renderSharedList();
  if (!chatId) return window.scrollTo(0, 0);
  await mountChat(chatId, ticket, events);
}

/**
 * Show another chat of the project on screen in place of the main panel, fetching only that thread
 * (and only its events not already cached). False when the thread is not one we know of yet.
 */
async function switchChat(main, seq) {
  const chatId = main.id ?? (main.number == null ? view.coordinator.id : [...view.tickets.values()].find((t) => t.number === main.number)?.id);
  if (!chatId) return false;
  const [{ ticket }, events] = await Promise.all([api(`/api/tickets/${chatId}`), loadEvents(chatId)]);
  if (seq !== routeSeq) return true; // overtaken by another click while loading
  const { kind, projectId, project, coordinator, tickets, seen, artifacts, shared, showClosed } = view;
  view = {
    kind, main: 'chat', projectId, project, coordinator, tickets, seen, artifacts, shared, showClosed,
    artifactId: null, file: null, fileTicket: null,
    ...chatView(chatId, ticket),
  };
  if (isCoordinator(ticket)) view.coordinator = ticket;
  else view.tickets.set(ticket.id, ticket);
  renderCrumbs(main);
  document.querySelector('#app .split').lastElementChild.replaceWith(chatSection(chatId, ticket, events));
  // On phones the panels sit above the chat; fold them away as a fresh load would.
  if (matchMedia('(max-width: 800px)').matches) for (const el of document.querySelectorAll('#app .panels > details:not(.as-drawer)')) el.open = false;
  renderInstructionsShelf();
  renderShelf();
  renderSidebar();
  await mountChat(chatId, ticket, events);
  return true;
}

/** Fill in a chat section just put on the page: its head, its history, and where you were in it. */
async function mountChat(chatId, ticket, events) {
  renderTicketHead();
  for (const ev of events) appendEvent(ev, false);
  if (ticket.branch) refreshBranch(chatId);
  markSeen(chatId);
  restoreScroll(chatId);
  if (pendingFind) {
    view.findEl?.find(pendingFind);
    pendingFind = '';
  }
  try {
    if (sessionStorage.getItem('cc-refocus')) {
      sessionStorage.removeItem('cc-refocus');
      document.querySelector('.composer textarea')?.focus();
    }
  } catch {}
  // Events broadcast while the snapshot was loading arrived before `view` existed.
  await catchUpEvents();
}

function chatSection(chatId, ticket, events) {
  const keys = matchMedia('(max-width: 800px)').matches ? '' : ' (Enter to send, Shift+Enter for a new line)';
  const textarea = h('textarea', {
    placeholder: (isCoordinator(ticket) ? 'Ask the Taskmaster to start, check on, or dismiss minions…' : 'Message this minion…') + keys,
    'data-draft': true,
  });
  const draftKey = `cc-draft:${chatId}`;
  textarea.value = loadDraft(draftKey) ?? '';
  textarea.addEventListener('input', () => saveDraft(draftKey, textarea.value));
  const sendBtn = h('button', { type: 'submit' }, 'Send');
  const attachments = createAttachments((items) => saveDraftImages(chatId, items));
  loadDraftImages(chatId).then((items) => attachments.restore(items));
  const picker = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  picker.addEventListener('change', () => {
    attachments.add(picker.files);
    picker.value = '';
  });
  const form = h('form', { class: 'composer' }, attachments.el, textarea, picker,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'secondary small add-image', title: 'Add image', 'aria-label': 'Add image', onclick: () => picker.click() },
        h('span', { 'aria-hidden': 'true' }, '📎'), h('span', { class: 'wide-only' }, ' Add image')),
      h('span', { class: 'spacer' }),
      modelPicker(chatId), sendBtn));
  textarea.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    attachments.add(files);
  });
  form.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) e.preventDefault();
  });
  form.addEventListener('drop', (e) => {
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    attachments.add(files);
  });
  textarea.addEventListener('keydown', (e) => {
    // Leave Enter alone while an IME is composing text, or it would send half a word.
    // On a phone Enter adds a line; the Send button sends.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(max-width: 800px)').matches) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (attachments.busy) return alertNote('Still preparing an image; try again in a moment.');
    if (!text && !attachments.items.length) return;
    sendBtn.disabled = true;
    sending++;
    const sent = attachments.items.slice();
    const images = sent.map(({ mediaType, data }) => ({ mediaType, data }));
    // Show the message and "Claude is thinking…" straight away, and clear the composer; the
    // server's copy of the message replaces this one when it arrives.
    const pending = userBubble(me, text, images.map(({ mediaType, data }) => base64Url(mediaType, data)));
    pending.classList.add('pending');
    view.pendingMessages.push({ el: pending, text });
    document.getElementById('log').append(pending);
    textarea.value = '';
    saveDraft(draftKey, '');
    attachments.remove(sent);
    view.sendingTo = chatId;
    renderTyping();
    scrollToBottom();
    try {
      const ticket = await api(`/api/tickets/${chatId}/messages`, { method: 'POST', body: { text, images } });
      // Show the message now even if the live stream is down; duplicates are skipped by id.
      if (view?.kind === 'project' && view.id === chatId) {
        // You just sent something, so follow the reply.
        scrollToBottom();
        view.ticket = ticket;
        renderTicketHead();
        catchUpEvents().catch(() => {});
      }
    } catch (ex) {
      // Not sent: take the message back out of the chat and put it back in the composer.
      pending.remove();
      if (view?.id === chatId) view.pendingMessages = view.pendingMessages.filter((m) => m.el !== pending);
      textarea.value = textarea.value.trim() ? `${text}\n${textarea.value}` : text;
      saveDraft(draftKey, textarea.value);
      attachments.restore(images);
      alertNote(ex.message);
    } finally {
      if (view?.sendingTo === chatId) {
        view.sendingTo = null;
        renderTyping();
      }
      sendBtn.disabled = false;
      sending--;
      reloadWhenIdle();
    }
  });

  const log = h('div', { class: 'log', id: 'log' });
  if (isCoordinator(ticket) && !events.length) {
    log.append(h('div', { class: 'note' },
      'This is the Taskmaster for this scheme. It keeps track of the minions on the left and can create, message, rename and dismiss them for you.'));
  }
  // The working line is a shortcut to the readout in the thread bar.
  const openReadout = () => {
    view.ui.open = true;
    renderProgress();
    view.progressEl.scrollIntoView({ block: 'nearest' });
  };
  view.typingEl.onclick = openReadout;
  view.typingEl.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReadout(); }
  };
  return h('section', { class: 'chat' }, h('div', { class: 'ticket-head', id: 'ticket-head' }), log, view.typingEl, form);
}

function newTicketForm(projectId) {
  // A one-line chat box: what you type becomes the new thread's first message. The thread names
  // and tags itself from it, and every thread gets full access.
  const box = h('textarea', { name: 'message', required: true, rows: 1, placeholder: 'New minion: what should it work on?', 'aria-label': 'Start a new minion', 'data-draft': true });
  const err = h('p', { class: 'error', hidden: true });
  const form = h('form', { class: 'new-thread' }, box, err);
  const fit = () => {
    box.style.height = 'auto';
    // Not laid out (a folded panel, or a phone's drawer still tucked away): keep the one-line default.
    if (!box.scrollHeight) { box.style.height = ''; return; }
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  };
  const draftKey = `cc-new-thread:${projectId}`;
  const draft = loadDraft(draftKey);
  if (draft) box.value = draft.message ?? '';
  requestAnimationFrame(fit);
  let busy = false;
  box.addEventListener('input', () => {
    fit();
    saveDraft(draftKey, box.value ? { message: box.value } : null);
  });
  box.addEventListener('keydown', (e) => {
    // Enter sends (on phones too, unlike the chat composer), Shift+Enter adds a line, IME composition is left alone.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !box.value.trim()) return;
    busy = true;
    box.readOnly = true;
    err.hidden = true;
    sending++;
    try {
      const t = await api(`/api/projects/${projectId}/tickets`, { method: 'POST', body: { message: box.value } });
      saveDraft(draftKey, null);
      box.value = '';
      fit();
      location.hash = threadHref(t);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      busy = false;
      box.readOnly = false;
      sending--;
    }
  });
  return form;
}

function renderSidebar() {
  const el = document.getElementById('threads');
  if (!el) return;
  const tickets = [...view.tickets.values()];
  document.getElementById('coordinator-row')?.replaceChildren(threadRow(view.coordinator, `#/p/${view.projectId}`));
  if (threadSearch.q) return renderThreadResults(el, tickets.sort((a, b) => b.updated_at - a.updated_at));
  const open = tickets.filter((t) => t.status !== 'closed');
  const closed = tickets.filter((t) => t.status === 'closed').sort((a, b) => b.updated_at - a.updated_at);
  const sections = threadSections(open, Object.keys(TAGS)).map((s) =>
    h('section', { class: `thread-group g-${s.build ? 'build' : s.key}` },
      h('h3', {}, s.build ? ['Build ', s.build, s.current ? h('span', { class: 'muted' }, ' current') : ''] : s.tag ? TAGS[s.tag].section : 'Other'),
      s.rows.sort(byUrgency).map((t) => threadRow(t))));
  let closedGroup = '';
  if (closed.length) {
    // Closed threads stay out of the way but can still be opened and reopened.
    closedGroup = h('details', { class: 'thread-group g-closed', open: view.showClosed }, h('summary', {}, 'Dismissed'), closed.map((t) => threadRow(t)));
    closedGroup.addEventListener('toggle', () => { view.showClosed = closedGroup.open; });
  }
  el.replaceChildren(
    ...sections, closedGroup,
    tickets.length ? '' : h('p', { class: 'muted' }, 'No minions yet. Ask the Taskmaster to start one, or type in the box above.'));
}

// ---------- search ----------

// The threads search, kept across thread switches within a project.
const threadSearch = { projectId: null, q: '', hits: new Map(), seq: 0, timer: null };
// Text to find in the next chat that opens, set when a search result is clicked.
let pendingFind = '';

function threadSearchBox(projectId) {
  if (threadSearch.projectId !== projectId) Object.assign(threadSearch, { projectId, q: '', hits: new Map() });
  const input = h('input', { type: 'search', class: 'thread-search', placeholder: 'Search minions and what was said…', value: threadSearch.q, autocomplete: 'off' });
  input.addEventListener('input', () => {
    threadSearch.q = input.value.trim();
    renderSidebar();
    clearTimeout(threadSearch.timer);
    threadSearch.timer = setTimeout(() => fetchThreadHits(projectId), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      input.value = '';
      input.dispatchEvent(new Event('input'));
    }
  });
  if (threadSearch.q) fetchThreadHits(projectId);
  return input;
}

/** Ask the server which threads mention the text anywhere in their conversation. */
async function fetchThreadHits(projectId) {
  const q = threadSearch.q;
  const seq = ++threadSearch.seq;
  let hits = [];
  if (q.length >= 2) {
    try {
      hits = await api(`/api/projects/${projectId}/search?q=${encodeURIComponent(q)}`);
    } catch {
      hits = [];
    }
  }
  if (seq !== threadSearch.seq || threadSearch.projectId !== projectId) return;
  threadSearch.hits = new Map(hits.map((hit) => [hit.ticketId, hit]));
  if (view?.kind === 'project' && view.projectId === projectId) renderSidebar();
}

/** Search results: threads whose title or details match, or whose conversation mentions the text. */
function renderThreadResults(el, tickets) {
  const q = threadSearch.q.toLowerCase();
  const results = [view.coordinator, ...tickets].filter((t) => {
    const fields = [threadLabel(t), t.created_by, t.last_activity];
    return fields.some((f) => f?.toLowerCase().includes(q)) || threadSearch.hits.has(t.id);
  });
  el.replaceChildren(
    h('section', { class: 'column' },
      h('h3', {}, 'Results', h('span', { class: 'count' }, results.length)),
      results.length
        ? results.map((t) => {
            const hit = threadSearch.hits.get(t.id);
            const card = threadRow(t, t === view.coordinator ? `#/p/${view.projectId}` : threadHref(t), hit);
            // Open the thread with its find box already on the text.
            card.addEventListener('click', () => { pendingFind = hit ? threadSearch.q : ''; });
            return card;
          })
        : h('p', { class: 'muted small' }, threadSearch.q.length < 2 ? 'Keep typing to search conversations too.' : 'No minions mention that.')));
}

/** Wrap matches of the text inside el in <mark>, returning the marks in document order. */
function highlight(el, text) {
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

function clearHighlights(el) {
  for (const mark of el.querySelectorAll('mark.find')) mark.replaceWith(...mark.childNodes);
  el.normalize();
}

/** Find in the open conversation: highlights every match, Enter / ↓ for the next, Shift+Enter / ↑ for the previous. */
function chatFindBox() {
  const input = h('input', { type: 'search', class: 'chat-find', placeholder: matchMedia('(max-width: 800px)').matches ? '🔍 Find' : 'Find in chat', 'aria-label': 'Find in chat', autocomplete: 'off' });
  const count = h('span', { class: 'find-count muted' });
  const state = { marks: [], at: -1 };
  const show = (i) => {
    if (!state.marks.length) return;
    state.marks[state.at]?.classList.remove('current');
    state.at = (i + state.marks.length) % state.marks.length;
    const mark = state.marks[state.at];
    mark.classList.add('current');
    // Open any collapsed block it is in, then bring it to the middle of the screen.
    for (let d = mark.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
    mark.scrollIntoView({ block: 'center' });
    count.textContent = `${state.at + 1}/${state.marks.length}`;
  };
  const run = () => {
    const log = document.getElementById('log');
    if (!log) return;
    timer = null;
    if (state.marks.length) clearHighlights(log);
    const q = input.value.trim();
    state.marks = q.length >= 2 ? [...log.querySelectorAll('.msg, .note')].flatMap((m) => highlight(m, q)) : [];
    state.at = -1;
    count.textContent = q.length >= 2 ? (state.marks.length ? `0/${state.marks.length}` : 'none') : '';
    // Start from the newest match, nearest where you usually are.
    if (state.marks.length) show(state.marks.length - 1);
  };
  // Highlighting a long chat on every key is wasted work; wait for a pause, and for 2+ characters.
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 150);
  });
  input.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') && timer) {
      // A step right after typing goes to the fresh results.
      clearTimeout(timer);
      timer = null;
      run();
      if (e.key !== 'ArrowUp' && !(e.key === 'Enter' && e.shiftKey)) return e.preventDefault();
    }
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      show(state.at + (e.key === 'Enter' && e.shiftKey ? -1 : 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      show(state.at - 1);
    } else if (e.key === 'Escape') {
      input.value = '';
      run();
    }
  });
  const step = (d) => h('button', { type: 'button', class: 'secondary find-step', title: d < 0 ? 'Previous match' : 'Next match', onclick: () => show(state.at + d) }, d < 0 ? '↑' : '↓');
  const box = h('span', { class: 'find-box' }, input, count, step(-1), step(1));
  box.find = (text) => {
    input.value = text;
    run();
  };
  return box;
}

/** Rows that need you first (longest waiting at the top), then working, then waiting elsewhere, then parked. */
function byUrgency(a, b) {
  const ra = rowState(a).rank, rb = rowState(b).rank;
  if (ra !== rb) return ra - rb;
  return ra === 0 ? a.updated_at - b.updated_at : b.updated_at - a.updated_at;
}

/**
 * A thread's state cell: ❓ / ✅ / 🧪 when it is your move (with how long it has waited), ● x/y while
 * Claude works, ⏳ ⛔ when it waits on something else, 🧊 parked, ⚠️ stuck.
 */
function rowState(t) {
  const steps = t.steps ? ` ${t.steps.done}/${t.steps.total}` : '';
  const waited = () => {
    const days = Date.now() - t.updated_at >= 86_400_000;
    return h('b', { class: days ? 'st' : 'm' }, shortAgo(t.updated_at));
  };
  if (t.approvals) return { rank: 0, cls: 'q', cell: ['✋ ', waited()], label: 'Waiting for your approval' };
  if (t.status === 'running' || t.status === 'new') return { rank: 1, cls: 'w', cell: [`●${steps}`], label: 'Claude is working' };
  if (t.status === 'error') return { rank: 0, cls: 'st', cell: ['⚠️'], label: 'Stuck: the last turn failed' };
  if (t.status === 'closed') return { rank: 5, cls: 'm', cell: ['✓'], label: 'Dismissed' };
  const state = STATES[t.state];
  if (t.state === 'parked') return { rank: 4, cls: 'm', cell: [state.emoji], label: state.label };
  if (t.state === 'outside') return { rank: 2, cls: 'w', cell: [`${state.emoji}${steps}`], label: state.label };
  if (t.state === 'blocked') return { rank: 2, cls: 'st', cell: [state.emoji], label: state.label };
  if (state) return { rank: 0, cls: 'ok', cell: [state.emoji, ' ', waited()], label: state.label };
  return { rank: 0, cls: 'q', cell: ['❓ ', waited()], label: 'Your move' };
}

/** One compact row: number + short ask and the state on top, the thread's note (or what it is doing) below. */
function threadRow(t, href = threadHref(t), hit = null) {
  const coord = isCoordinator(t);
  // The coordinator is always there to talk to; only show when it is busy.
  const st = coord && t.status !== 'running' ? { cls: '', cell: [], label: statusLabel(t) } : rowState(t);
  const working = st.cls === 'w' || st.cls === 'm';
  const note = (t.status === 'running' ? t.last_activity : t.note || t.last_activity) || '';
  const details = [
    threadFullName(t),
    [st.label, t.queued ? `${t.queued} queued` : '', coord ? '' : `started by ${t.created_by}`, `updated ${ago(t.updated_at)}`].filter(Boolean).join(' · '),
    note,
  ].filter(Boolean).join('\n');
  const active = (view.id ?? view.fileTicket?.id) === t.id;
  // Rows waiting on you get a tinted background (red when the thread is stuck), so they stand out.
  // Faint once you've opened the thread since it last changed; vibrant again when it changes.
  const yours = !coord && st.rank === 0 ? ` yours${st.cls === 'st' ? ' stuck' : ''}${isSeen(t) ? ' seen' : ''}` : '';
  return h('a', { class: `thread-row s-${t.status}${coord ? ' coordinator' : ''}${yours}${active ? ' active' : ''}`, href, title: details },
    h('span', { class: 'name' }, coord ? 'Taskmaster' : [h('span', { class: 'num' }, t.number ?? t.id), ' ', t.title]),
    t.queued ? h('span', { class: 'queued' }, `✉ ${t.queued}`) : '',
    h('span', { class: `state ${st.cls}` }, st.cell),
    hit ? snippetLine(hit) : note ? h('span', { class: `note${working ? ' t' : ''}` }, note) : '');
}

/** A search hit's snippet, with the searched text highlighted. */
function snippetLine(hit) {
  const el = h('span', { class: 'note hit' }, hit.snippet, hit.matches > 1 ? h('span', { class: 'more' }, ` +${hit.matches - 1}`) : '');
  highlight(el, threadSearch.q);
  return el;
}

/** "now", "5m", "3h", "2d": ages for tight spaces. */
function shortAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// ---------- branch and pull request ----------

async function refreshBranch(ticketId) {
  try {
    const { status } = await api(`/api/tickets/${ticketId}/branch`);
    if (view?.kind === 'project' && view.id === ticketId) renderBranch(status);
  } catch {}
}

/** "PR #12 · merged" (linked), or for work merged without a PR, the branch and whether main has it. */
function renderBranch(status) {
  const el = view.branchEl;
  const parts = [];
  if (status?.pr) {
    const { pr } = status;
    const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.draft ? 'draft' : 'open';
    parts.push(
      h('a', { href: pr.url, target: '_blank', rel: 'noopener', title: pr.title, onclick: (e) => e.stopPropagation() }, `PR #${pr.number}`),
      h('span', { class: `state ${state}` }, state));
    if (pr.state === 'OPEN' && status.merged) parts.push(h('span', { title: `Merged into ${status.base}` }, '✓ in main'));
  } else if (status && !status.empty) {
    parts.push(h('span', { class: 'branch', title: status.branch }, status.branch));
    parts.push(status.merged
      ? h('span', { class: 'state merged', title: `Merged into ${status.base}` }, 'merged')
      : h('span', { class: 'state open', title: `${status.ahead} commit${status.ahead === 1 ? '' : 's'} not in ${status.base}` }, `${status.ahead} unmerged`));
  }
  el.replaceChildren(...parts);
  el.hidden = !parts.length;
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

const rawUrl = (a) => `/api/artifacts/${a.id}/raw?v=${a.mtime}`;
const extOf = (a) => (a.name.includes('.') ? a.name.split('.').pop() : a.kind).slice(0, 5).toUpperCase();
const artifactThread = (a) => ({ id: a.ticket_id, kind: a.ticket_kind, project_id: a.project_id, number: a.ticket_number, title: a.ticket_title });
const threadName = (a) => threadLabel(artifactThread(a));

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

let artifactRefresh = null;
function onArtifactsChanged(projectId) {
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
      api(`/api/projects/${projectId}/artifacts`),
      api(`/api/projects/${projectId}/shared`).catch(() => []),
    ]);
    if (view?.kind === 'project' && view.projectId === projectId) setArtifacts(artifacts, shared);
  } catch {}
}

function setArtifacts(artifacts, shared = view.shared) {
  view.artifacts = artifacts;
  view.shared = shared;
  renderShelf();
  if (view.main === 'artifacts') renderArtifactResults();
  if (view.main === 'artifact') renderArtifactHead();
  if (view.main === 'file') renderFileHead();
  if (view.main === 'sharedList') renderSharedList();
}

async function setPinned(a, pinned) {
  try {
    await api(`/api/artifacts/${a.id}/pin`, { method: 'POST', body: { pinned } });
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
function renderShelf() {
  const el = document.getElementById('artifact-shelf');
  if (!el) return;
  const all = view.artifacts;
  const pinned = all.filter((a) => a.pinned_at).sort((a, b) => b.pinned_at - a.pinned_at);
  const recent = all.filter((a) => !a.pinned_at && !a.missing).slice(0, RECENT_ARTIFACTS);
  const item = (a) => h('a', { class: `artifact-item${view.artifactId === a.id ? ' active' : ''}${a.missing ? ' missing' : ''}`, href: `#/a/${a.id}`, title: a.display_path ?? a.path },
    h('span', { class: `badge k-${a.kind}` }, extOf(a)),
    h('span', { class: 'text' },
      h('span', { class: 'name' }, a.name),
      h('span', { class: 'meta' }, `${a.ticket_kind === 'coordinator' ? 'Taskmaster' : `#${a.ticket_number ?? a.ticket_id}`} · ${a.missing ? 'missing' : ago(a.mtime)}`)));
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
function sharedList() {
  return h('section', { class: 'artifacts-main' },
    h('div', { class: 'ticket-head' }, h('div', { class: 'row' }, h('h2', {}, 'Shared files'), h('span', { class: 'muted', id: 'shared-summary' }))),
    h('div', { class: 'shared-list', id: 'shared-results' }));
}

function renderSharedList() {
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
function artifactBrowser() {
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

function renderArtifactResults() {
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
function artifactViewer(a) {
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

/** Main panel: a file a thread linked, with a way back to its chat. */
function fileViewer(ticket, file) {
  const body = h('div', { class: 'artifact-body' });
  const section = h('section', { class: 'artifacts-main' }, h('div', { class: 'ticket-head', id: 'file-head' }), body);
  if (file.missing) body.append(h('p', { class: 'muted' }, `${file.missing}.`));
  else {
    renderFileBody(body, { ...file, src: `${fileUrl(ticket.id, file.path)}&v=${file.mtime}`, ticketId: ticket.id });
    section.append(commentBox(ticket, file.path, file.name, body));
  }
  return section;
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
    sending++;
    status.textContent = 'Sending…';
    try {
      await api(`/api/tickets/${t.id}/comments`, { method: 'POST', body: { path, text, quote } });
      textarea.value = '';
      saveDraft(draftKey, '');
      setQuote('');
      grow();
      status.replaceChildren(`Sent to ${threadLabel(t)} · `, h('a', { href: threadHref(t) }, 'see the chat'));
    } catch (ex) {
      status.textContent = ex.message;
    } finally {
      sendBtn.disabled = false;
      sending--;
      reloadWhenIdle();
    }
  });
  return form;
}

/** Main panel: a file from the project's shared folder. */
function sharedViewer(file) {
  const body = h('div', { class: 'artifact-body' });
  if (file.missing) body.append(h('p', { class: 'muted' }, `${file.missing}.`));
  else renderFileBody(body, { ...file, src: `${sharedUrl(view.projectId, file.path)}&v=${file.mtime}`, urlFor: (p) => sharedUrl(view.projectId, p) });
  return h('section', { class: 'artifacts-main' }, h('div', { class: 'ticket-head', id: 'shared-head' }), body);
}

function renderSharedHead() {
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

function renderFileHead() {
  const el = document.getElementById('file-head');
  if (!el) return;
  const { file, fileTicket: t } = view;
  // A file that is also an artifact can be pinned; keep its pin state live.
  const a = file.artifact && (view.artifacts.find((x) => x.id === file.artifact.id) ?? file.artifact);
  const src = `${fileUrl(t.id, file.path)}&v=${file.mtime}`;
  el.replaceChildren(
    h('div', { class: 'row' },
      h('a', { class: 'button secondary', href: threadHref(t) }, '← Back to chat'),
      h('span', { class: `badge k-${file.kind}` }, fileExt(file.name)),
      h('h2', {}, file.name),
      h('span', { class: 'spacer' }),
      a ? pinButton(a) : '',
      file.missing ? '' : h('a', { class: 'button secondary', href: src, target: '_blank', rel: 'noopener' }, 'Open'),
      file.missing ? '' : h('a', { class: 'button secondary', href: `${src}&download` }, 'Download')),
    h('div', { class: 'meta' },
      file.display_path, ' · from ',
      h('a', { href: threadHref(t) }, threadLabel(t)),
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

function renderArtifactHead() {
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

// ---------- project instructions ----------

const MAX_INSTRUCTIONS = 16000;
const count = (n) => n.toLocaleString('en');

function onProjectUpdate(project) {
  for (const el of document.querySelectorAll(`[data-project-name="${project.id}"]`)) el.textContent = project.name;
  if (view?.kind !== 'project' || view.projectId !== project.id) return;
  view.project = project;
  renderInstructionsShelf();
  renderApprovalsShelf();
  for (const [id, key] of [['approval-rules', 'approval_rules'], ['plugin-dirs', 'plugin_dirs']]) {
    const el = document.getElementById(id);
    if (el && !el.hasAttribute('data-draft')) el.value = project[key];
  }
  const text = document.getElementById('instructions-text');
  // Someone else saved: show their text unless this tab has edits of its own.
  if (text && !text.hasAttribute('data-draft')) text.value = project.instructions;
  renderInstructionsHead();
}

/**
 * The overview's header: the project name with a ✎ that turns it into a text field in place.
 * Enter or ✓ saves; Esc or tapping away cancels. It sits in the panel's <summary>, so its own
 * clicks and keys must not fold the panel or close the phone drawer.
 */
function projectTitle(project) {
  const wrap = h('span', { class: 'project-title' });
  const err = h('p', { class: 'error small rename-error', role: 'alert', hidden: true });
  const show = () => {
    err.hidden = true;
    err.remove();
    wrap.replaceChildren(
      h('span', { class: 'label', 'data-project-name': project.id }, view.project.name),
      h('button', { type: 'button', class: 'rename', 'aria-label': 'Rename scheme', title: 'Rename scheme (its repo stays as it is)', onclick: edit }, '✎'));
  };
  const edit = () => {
    let saving = false;
    const input = h('input', { class: 'rename-input', value: view.project.name, maxlength: '80', 'aria-label': 'Scheme name' });
    const save = async () => {
      if (saving) return;
      if (input.value.trim() === view.project.name) return show();
      saving = true;
      try {
        onProjectUpdate(await api(`/api/projects/${project.id}`, { method: 'PATCH', body: { name: input.value } }));
        show();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        wrap.closest('summary').after(err);
        input.focus();
      }
      saving = false;
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); show(); }
    });
    // A space let through to the <summary> would fold the panel in some browsers.
    input.addEventListener('keyup', (e) => { if (e.key === ' ') e.preventDefault(); });
    input.addEventListener('blur', () => { if (!saving) show(); });
    wrap.replaceChildren(input,
      // mousedown kept from blurring the field, so the tap reaches save instead of cancelling.
      h('button', { type: 'button', class: 'rename', 'aria-label': 'Save name', onmousedown: (e) => e.preventDefault(), onclick: save }, '✓'));
    input.focus();
    input.select();
  };
  wrap.addEventListener('click', (e) => {
    // Clicks inside the title edit it; they don't fold the panel or close the drawer.
    if (e.target.closest('button, input')) { e.preventDefault(); e.stopPropagation(); }
  });
  show();
  return wrap;
}

/** Overview panel: whether the project has instructions, and a way to edit them. */
function renderInstructionsShelf() {
  const el = document.getElementById('instructions-shelf');
  if (!el) return;
  const p = view.project;
  const text = p.instructions ?? '';
  const first = text.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean);
  el.replaceChildren(h('section', { class: 'column' },
    h('h3', {}, 'Instructions', h('span', { class: 'spacer' }),
      h('a', { class: `browse${view.main === 'instructions' ? ' active' : ''}`, href: `#/p/${view.projectId}/instructions` }, text ? 'Edit' : 'Add')),
    text
      ? h('a', { class: 'instructions-peek', href: `#/p/${view.projectId}/instructions` },
        h('span', { class: 'name' }, first ?? ''),
        h('span', { class: 'meta' }, `${count(text.length)} chars${p.instructions_updated_by ? ` · ${p.instructions_updated_by}, ${ago(p.instructions_updated_at)}` : ''}`))
      : h('p', { class: 'muted small' }, 'Standing rules every minion and the Taskmaster follow. Import them from Claude Code.')));
}

const splitLines = (text) => (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

/** Overview panel: which tool calls need a person's OK, and which plugin folders threads load. */
function renderApprovalsShelf() {
  const el = document.getElementById('approvals-shelf');
  if (!el) return;
  const p = view.project;
  const rules = splitLines(p.approval_rules);
  const dirs = splitLines(p.plugin_dirs);
  const href = `#/p/${view.projectId}/approvals`;
  el.replaceChildren(h('section', { class: 'column' },
    h('h3', {}, 'Needs approval', h('span', { class: 'spacer' }),
      h('a', { class: `browse${view.main === 'approvals' ? ' active' : ''}`, href }, rules.length || dirs.length ? 'Edit' : 'Add')),
    rules.length
      ? h('a', { class: 'rule-chips', href }, rules.map((r) => h('code', { class: 'rule' }, r)))
      : h('p', { class: 'muted small' }, 'Nothing: minions run every tool without asking.'),
    dirs.length ? h('p', { class: 'muted small' }, `Plugins: ${dirs.join(', ')}`) : ''));
}

/** Main panel: the project's approval rules and plugin folders. */
function approvalsEditor() {
  const p = view.project;
  const field = (id, key, placeholder) => {
    const t = h('textarea', { id, class: 'instructions-text settings-list', spellcheck: 'false', rows: 5, placeholder });
    t.value = p[key] ?? '';
    return t;
  };
  const rules = field('approval-rules', 'approval_rules', 'Bash(gh pr merge:*)\nmcp__*__merge_pull_request');
  const dirs = field('plugin-dirs', 'plugin_dirs', 'tools/mods/delve');
  const status = h('span', { class: 'muted', role: 'status' });
  const save = h('button', { type: 'button' }, 'Save');
  const discard = h('button', { type: 'button', class: 'secondary' }, 'Discard');
  const same = (a, b) => splitLines(a).join('\n') === splitLines(b).join('\n');
  const sync = () => {
    let dirty = false;
    for (const [t, key] of [[rules, 'approval_rules'], [dirs, 'plugin_dirs']]) {
      // Marked as a draft only while it differs, so someone else's save still shows otherwise.
      const d = !same(t.value, view.project[key]);
      t.toggleAttribute('data-draft', d);
      dirty ||= d;
    }
    save.disabled = discard.disabled = !dirty;
  };
  for (const t of [rules, dirs]) t.addEventListener('input', () => {
    status.textContent = '';
    sync();
  });
  save.onclick = async () => {
    save.disabled = true;
    status.textContent = 'Saving…';
    try {
      view.project = await api(`/api/projects/${p.id}`, { method: 'PATCH', body: { approval_rules: rules.value, plugin_dirs: dirs.value } });
      rules.value = view.project.approval_rules;
      dirs.value = view.project.plugin_dirs;
      status.textContent = 'Saved. Minions pick this up on their next turn.';
      renderApprovalsShelf();
    } catch (err) {
      status.textContent = err.message;
    }
    sync();
  };
  discard.onclick = () => {
    rules.value = view.project.approval_rules ?? '';
    dirs.value = view.project.plugin_dirs ?? '';
    status.textContent = '';
    sync();
  };
  const section = h('section', { class: 'artifacts-main instructions-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, h('h2', {}, 'Approvals and plugins'), h('span', { class: 'spacer' }),
        h('a', { class: 'close-view', href: `#/p/${p.id}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, '×')),
      h('div', { class: 'meta' }, 'Minions in this scheme use these from their next turn. The Taskmaster is not affected.')),
    h('h3', { class: 'settings-label' }, 'Needs approval'),
    h('p', { class: 'muted small' },
      'Claude Code permission rules, one per line. A minion\'s tool call that matches one waits in its chat with Approve and Deny buttons until someone signed in clicks; everything else runs without asking. ',
      'Examples: ', h('code', {}, 'Bash(gh pr merge:*)'), ', ', h('code', {}, 'mcp__*__merge_pull_request'), '. ',
      'Bash rules match how a command starts, so they catch mistakes rather than a determined workaround.'),
    rules,
    h('h3', { class: 'settings-label' }, 'Plugin folders'),
    h('p', { class: 'muted small' },
      'Folders relative to the repo root, one per line, like ', h('code', {}, 'tools/mods/delve'),
      '. Each minion loads the ones that exist in its worktree as Claude Code plugins (', h('code', {}, '--plugin-dir'), ').'),
    dirs,
    h('div', { class: 'row instructions-actions' }, save, discard, status));
  sync();
  return section;
}

function renderInstructionsHead() {
  const el = document.getElementById('instructions-head');
  if (!el) return;
  const p = view.project;
  el.replaceChildren(
    h('div', { class: 'row' }, h('h2', {}, 'Scheme instructions'), h('span', { class: 'spacer' }),
      h('a', { class: 'close-view', href: `#/p/${p.id}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, '×')),
    h('div', { class: 'meta' },
      'The Taskmaster and every minion get these in their system prompt, from their next turn.',
      p.instructions_updated_by ? ` Last changed by ${p.instructions_updated_by} ${ago(p.instructions_updated_at)}.` : ''));
}

/** Main panel: edit the project's instructions, or import them from Claude Code. */
function instructionsEditor() {
  const p = view.project;
  const textarea = h('textarea', {
    id: 'instructions-text', class: 'instructions-text', spellcheck: 'false',
    placeholder: 'What the scheme is for, where the work happens (branches, PR names), how a minion checks its work, what needs a go-ahead first…',
  });
  textarea.value = p.instructions ?? '';
  const counter = h('span', { class: 'muted counter' });
  const status = h('span', { class: 'muted', role: 'status' });
  const save = h('button', { type: 'button' }, 'Save');
  const discard = h('button', { type: 'button', class: 'secondary' }, 'Discard');
  const sync = () => {
    const dirty = textarea.value.trim() !== (view.project.instructions ?? '').trim();
    // Marked as a draft only while it differs, so the app still reloads for an update otherwise.
    textarea.toggleAttribute('data-draft', dirty);
    const n = textarea.value.trim().length;
    counter.textContent = `${count(n)} / ${count(MAX_INSTRUCTIONS)}`;
    counter.classList.toggle('over', n > MAX_INSTRUCTIONS);
    save.disabled = !dirty || n > MAX_INSTRUCTIONS;
    discard.disabled = !dirty;
  };
  textarea.addEventListener('input', () => {
    status.textContent = '';
    sync();
  });
  save.onclick = async () => {
    save.disabled = true;
    status.textContent = 'Saving…';
    try {
      view.project = await api(`/api/projects/${p.id}`, { method: 'PATCH', body: { instructions: textarea.value } });
      textarea.value = view.project.instructions;
      status.textContent = 'Saved. Minions pick this up on their next turn.';
      renderInstructionsShelf();
      renderInstructionsHead();
    } catch (err) {
      status.textContent = err.message;
    }
    sync();
  };
  discard.onclick = () => {
    textarea.value = view.project.instructions ?? '';
    status.textContent = '';
    sync();
  };

  /** Put imported text at the end of what's there (or in place of it), then let people review and save. */
  const insert = (parts, replace) => {
    const add = parts.map((x) => x.trim()).filter(Boolean).join('\n\n');
    if (!add) return;
    textarea.value = replace || !textarea.value.trim() ? add : `${textarea.value.trimEnd()}\n\n${add}`;
    textarea.focus();
    textarea.scrollTop = textarea.scrollHeight;
    status.textContent = 'Imported. Review it, then Save.';
    sync();
  };

  const fileInput = h('input', { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain', multiple: true, hidden: true });
  fileInput.onchange = async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    insert(await Promise.all(files.map((f) => f.text())), false);
  };
  const picker = h('div', { class: 'import-picker', hidden: true });
  const importButton = h('button', { type: 'button', class: 'secondary' }, 'Import from Claude Code…');
  importButton.onclick = () => {
    if (!picker.hidden) return (picker.hidden = true);
    picker.hidden = false;
    loadInstructionSources(picker, insert);
  };

  const section = h('section', { class: 'artifacts-main instructions-main' },
    h('div', { class: 'ticket-head', id: 'instructions-head' }),
    h('div', { class: 'instructions-tools' },
      importButton,
      h('button', { type: 'button', class: 'secondary', onclick: () => fileInput.click() }, 'Import a file…'),
      fileInput,
      h('span', { class: 'muted small' }, 'Or paste: from a Claude Code project at claude.ai/code, copy Project settings › Memory › Project instructions.')),
    picker,
    textarea,
    h('div', { class: 'row instructions-actions' }, save, discard, status, h('span', { class: 'spacer' }), counter));
  sync();
  setTimeout(() => {
    renderInstructionsHead();
    textarea.focus();
  });
  return section;
}

// ---------- machines ----------

// What the add form suggests running: Delve's Godot MCP, as its dock's Configure button set it up
// for Claude Code on that computer.
const DEFAULT_CLAUDE_MCP = 'godot-ai';

function onMachinesUpdate(machines) {
  if (view?.kind !== 'project') return;
  view.machines = machines;
  renderMachinesShelf();
  renderMachineList();
}

/** "online on cara-laptop · 2 threads using it" or "offline · seen 3h ago". */
function machineStatus(m) {
  if (m.online) return [`online${m.host ? ` on ${m.host}` : ''}`, m.sessions ? `${m.sessions} in use` : ''].filter(Boolean).join(' · ');
  return m.last_seen_at ? `offline · seen ${ago(m.last_seen_at)}` : 'not connected yet';
}

/** Overview panel: people's computers lending threads their MCP tools, with live status. */
function renderMachinesShelf() {
  const el = document.getElementById('machines-shelf');
  if (!el) return;
  const href = `#/p/${view.projectId}/machines`;
  el.replaceChildren(h('section', { class: 'column' },
    h('h3', {}, 'Machines', h('span', { class: 'spacer' }),
      h('a', { class: `browse${view.main === 'machines' ? ' active' : ''}`, href }, view.machines.length ? 'Manage' : 'Add')),
    view.machines.length
      ? view.machines.map((m) => h('a', { class: `machine-item${m.online ? ' online' : ''}`, href, title: m.command ? `Runs ${m.command}` : '' },
        h('span', { class: `dot${m.online ? ' online' : ''}` }),
        h('span', { class: 'text' }, h('span', { class: 'name' }, m.name), h('span', { class: 'meta' }, machineStatus(m)))))
      : h('p', { class: 'muted small' }, 'Lend minions MCP tools from your own computers, like a Godot editor that runs builds.')));
}

/** The lines to run on a machine to connect it, for its token and what it should run. */
function machineSetup(url, token, kind, what) {
  const run = kind === 'command' ? `-- ${what}` : `--claude-mcp ${what || DEFAULT_CLAUDE_MCP}`;
  return [
    `curl -fsSLO ${url}/machine-agent.mjs`,
    `node machine-agent.mjs ${url} ${token} ${run}`,
  ].join('\n');
}

/**
 * The same for Windows PowerShell, as a task that starts now and at every logon (in that person's
 * own session, so it can reach an open Godot editor), restarting if it ever stops. No reboot needed.
 */
function machineSetupWindows(url, name, token, kind, what) {
  const run = kind === 'command' ? `-- ${what}` : `--claude-mcp ${what || DEFAULT_CLAUDE_MCP}`;
  const task = `Coordinator agent (${name})`;
  return [
    '$dir = "$env:USERPROFILE\\coordinator-agent"; New-Item -ItemType Directory -Force $dir | Out-Null',
    `curl.exe -fsSLo "$dir\\machine-agent.mjs" ${url}/machine-agent.mjs`,
    `$action = New-ScheduledTaskAction -Execute (Get-Command node).Source -WorkingDirectory $dir -Argument "\`"$dir\\machine-agent.mjs\`" ${url} ${token} ${run.replace(/"/g, '`"')}"`,
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    `Register-ScheduledTask -Force -TaskName "${task}" -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) -Settings $settings | Out-Null`,
    `Start-ScheduledTask -TaskName "${task}"`,
  ].join('\n');
}

/** Main panel: add machines, show how to connect them, and remove them or replace their token. */
function machinesPage() {
  view.machineToken = null; // { id, name, token } just made, shown until you leave the page
  const name = h('input', { name: 'name', placeholder: 'godot-laptop', required: true, maxlength: 30, autocomplete: 'off', pattern: '[a-z0-9][a-z0-9\\-]*' });
  const kind = h('select', { name: 'kind' },
    h('option', { value: 'claude' }, 'Claude Code MCP server named'),
    h('option', { value: 'command' }, 'Command'));
  const command = h('input', { name: 'command', value: DEFAULT_CLAUDE_MCP, autocomplete: 'off', spellcheck: 'false' });
  kind.onchange = () => {
    command.value = kind.value === 'claude' ? DEFAULT_CLAUDE_MCP : '';
    command.placeholder = kind.value === 'claude' ? DEFAULT_CLAUDE_MCP : 'npx -y some-mcp-server';
    renderMachineSetup();
  };
  command.addEventListener('input', renderMachineSetup);
  const status = h('span', { class: 'muted', role: 'status' });
  const form = h('form', { class: 'machine-add' },
    h('label', {}, 'Name', name),
    h('label', { class: 'wide' }, 'MCP server to run there', h('span', { class: 'row' }, kind, command)),
    h('button', { type: 'submit' }, 'Add machine'),
    status);
  form.onsubmit = async (e) => {
    e.preventDefault();
    status.textContent = 'Adding…';
    try {
      const { machine, token, agent_url } = await api('/api/machines', { method: 'POST', body: { name: name.value.trim().toLowerCase() } });
      view.machineToken = { id: machine.id, name: machine.name, token, url: agent_url ?? location.origin };
      name.value = '';
      status.textContent = '';
      renderMachineSetup();
    } catch (err) {
      status.textContent = err.message;
    }
  };
  const section = h('section', { class: 'artifacts-main machines-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, h('h2', {}, 'Machines'), h('span', { class: 'spacer' }),
        h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, '×')),
      h('div', { class: 'meta' }, 'Computers that lend every minion their MCP tools while they are connected. They dial out to this app (over the tailnet, where one is set up), so it never has to reach them.')),
    form,
    h('div', { id: 'machine-setup' }),
    h('div', { id: 'machine-list', class: 'machine-list' }),
    h('p', { class: 'muted small' },
      'Each machine runs one MCP server; add another machine for a second one. It needs Node 18 or newer. ',
      '"Claude Code MCP server" runs one already set up for Claude Code on that computer, like godot-ai after its dock\'s Configure. ',
      'A minion gets the tools of machines online when its turn starts, named mcp__<name>__…, plus the machine\'s notes, and the tools act on that computer, ',
      'so only add servers you trust minions to run.'));
  setTimeout(() => {
    renderMachineSetup();
    renderMachineList();
    name.focus();
  });
  return section;
}

function renderMachineSetup() {
  const el = document.getElementById('machine-setup');
  if (!el) return;
  const t = view.machineToken;
  if (!t) return el.replaceChildren();
  const kind = document.querySelector('.machine-add select[name=kind]')?.value;
  const command = document.querySelector('.machine-add input[name=command]')?.value.trim();
  const block = (label, text) => {
    const copy = h('button', { type: 'button', class: 'secondary small' }, 'Copy');
    copy.onclick = async () => {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Copied';
    };
    return [h('div', { class: 'row' }, h('span', { class: 'small' }, label), h('span', { class: 'spacer' }), copy), h('pre', {}, text)];
  };
  el.replaceChildren(h('div', { class: 'machine-setup' },
    h('strong', {}, `Connect ${t.name}`),
    h('p', { class: 'small' }, 'The token is shown only now; if you lose it, make a new one. Run one of these on that computer:'),
    ...block('Windows PowerShell: starts now and at every logon, no reboot', machineSetupWindows(t.url, t.name, t.token, kind, command)),
    ...block('Any computer, in a terminal you leave open', machineSetup(t.url, t.token, kind, command))));
}

function renderMachineList() {
  const el = document.getElementById('machine-list');
  if (!el) return;
  el.replaceChildren(...view.machines.map((m) => {
    const newToken = h('button', { type: 'button', class: 'secondary small', title: 'Make a new token; the old one stops working and the machine disconnects' }, 'New token');
    newToken.onclick = async () => {
      if (!confirm(`Make a new token for ${m.name}? Its current connection stops and it has to be set up again.`)) return;
      const { token, agent_url } = await api(`/api/machines/${m.id}/token`, { method: 'POST' }).catch((err) => alert(err.message) ?? {});
      if (!token) return;
      view.machineToken = { id: m.id, name: m.name, token, url: agent_url ?? location.origin };
      renderMachineSetup();
    };
    const remove = h('button', { type: 'button', class: 'secondary small' }, 'Remove');
    remove.onclick = async () => {
      if (!confirm(`Remove ${m.name}? Minions lose its tools and its token stops working.`)) return;
      await api(`/api/machines/${m.id}`, { method: 'DELETE' }).catch((err) => alert(err.message));
      if (view.machineToken?.id === m.id) view.machineToken = null;
      renderMachineSetup();
    };
    const notes = h('textarea', { rows: 4, maxlength: 2000, placeholder: 'What minions should know: never restart it, where the repo is cloned, what to check first…' });
    notes.value = m.notes ?? '';
    const saved = h('span', { class: 'muted small', role: 'status' });
    const save = h('button', { type: 'button', class: 'small' }, 'Save notes');
    save.onclick = async () => {
      saved.textContent = 'Saving…';
      try {
        await api(`/api/machines/${m.id}`, { method: 'PATCH', body: { notes: notes.value } });
        saved.textContent = 'Saved; minions get them from their next turn.';
      } catch (err) {
        saved.textContent = err.message;
      }
    };
    // Keep an open notes editor open (and its draft) when the list re-renders for a status change.
    const old = document.querySelector(`.machine-notes[data-id="${m.id}"]`);
    const editing = old?.open;
    if (editing) notes.value = old.querySelector('textarea').value;
    return h('div', { class: `machine-row${m.online ? ' online' : ''}` },
      h('div', { class: 'row' },
        h('span', { class: `dot${m.online ? ' online' : ''}` }),
        h('span', { class: 'text' },
          h('span', { class: 'name' }, m.name),
          h('span', { class: 'meta' }, [machineStatus(m), m.command, `added by ${m.created_by}`].filter(Boolean).join(' · '))),
        newToken, remove),
      h('details', { class: 'machine-notes', 'data-id': m.id, open: editing },
        h('summary', {}, m.notes ? `Notes: ${m.notes.split('\n')[0]}` : 'Add notes for minions'),
        notes, h('div', { class: 'row' }, save, saved)));
  }));
}

/** The import picker: this app's Claude Code instruction and memory files, to tick and add. */
async function loadInstructionSources(el, insert) {
  el.replaceChildren(h('p', { class: 'muted small' }, 'Looking for Claude Code instructions and memory…'));
  let sources;
  try {
    ({ sources } = await api(`/api/projects/${view.projectId}/instructions/sources`));
  } catch (err) {
    el.replaceChildren(h('p', { class: 'error' }, `Could not list Claude Code files: ${err.message}`));
    return;
  }
  if (!sources.length) {
    el.replaceChildren(h('p', { class: 'muted small' }, 'No Claude Code instructions or memory files found for this login. Import a file or paste instead.'));
    return;
  }
  const picked = new Set();
  const add = h('button', { type: 'button', disabled: true }, 'Add to instructions');
  const replace = h('button', { type: 'button', class: 'secondary', disabled: true }, 'Replace instructions');
  const update = () => {
    add.disabled = replace.disabled = !picked.size;
    add.textContent = picked.size > 1 ? `Add ${picked.size} to instructions` : 'Add to instructions';
  };
  const chosen = () => sources.filter((s) => picked.has(s.id)).map((s) => s.content);
  add.onclick = () => insert(chosen(), false);
  replace.onclick = () => insert(chosen(), true);
  const groups = [...new Set(sources.map((s) => s.group))];
  el.replaceChildren(
    ...groups.map((g) => h('div', { class: 'sub' }, h('h4', {}, g),
      sources.filter((s) => s.group === g).map((s) => {
        const box = h('input', { type: 'checkbox', onchange: () => { box.checked ? picked.add(s.id) : picked.delete(s.id); update(); } });
        return h('details', { class: 'import-source' },
          h('summary', {},
            h('label', {}, box, h('span', { class: 'name' }, s.label)),
            h('span', { class: 'meta' }, `${s.path} · ${count(s.content.length)} chars${s.truncated ? ' (cut short)' : ''}`),
            s.note ? h('span', { class: 'meta hint' }, s.note) : ''),
          h('pre', {}, s.content));
      }))),
    h('div', { class: 'row' }, add, replace, h('span', { class: 'muted small' }, 'Click a name to preview it.')));
}

// ---------- pasted images ----------

const MAX_IMAGES = 6;
const MAX_IMAGE_EDGE = 2000;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024; // base64 adds a third; the server caps decoded images at 5 MB
const SENDABLE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Pending images in the composer: thumbnails with a remove button, read as base64 for sending. */
function createAttachments(onChange) {
  const el = h('div', { class: 'attachments', hidden: true });
  const state = { el, items: [], busy: 0 };
  const render = () => {
    onChange(state.items.map(({ mediaType, data }) => ({ mediaType, data })));
    el.hidden = !state.items.length;
    el.replaceChildren(...state.items.map((item) => h('div', { class: 'thumb' },
      h('img', { src: item.url, alt: 'Image to send' }),
      h('button', { type: 'button', title: 'Remove', onclick: () => {
        URL.revokeObjectURL(item.url);
        state.items.splice(state.items.indexOf(item), 1);
        render();
      } }, '×'))));
  };
  state.add = async (files) => {
    for (const file of files) {
      if (state.items.length + state.busy >= MAX_IMAGES) {
        alertNote(`At most ${MAX_IMAGES} images per message.`);
        break;
      }
      state.busy++;
      try {
        const blob = await prepareImage(file);
        const data = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1]);
          r.onerror = () => reject(r.error);
          r.readAsDataURL(blob);
        });
        state.items.push({ url: URL.createObjectURL(blob), mediaType: blob.type, data });
        render();
      } catch (err) {
        alertNote(`Could not add image: ${err.message}`);
      } finally {
        state.busy--;
      }
    }
  };
  state.remove = (items) => {
    for (const item of items) URL.revokeObjectURL(item.url);
    state.items = state.items.filter((item) => !items.includes(item));
    render();
  };
  /** Bring back images saved with a draft (they are already prepared and encoded). */
  state.restore = (saved) => {
    if (!saved.length) return;
    const restored = saved.map(({ mediaType, data }) => ({ url: base64Url(mediaType, data), mediaType, data }));
    state.items = [...restored, ...state.items].slice(0, MAX_IMAGES);
    render();
  };
  return state;
}

/** Shrink big images (and convert odd formats) so they fit the API's size limits. */
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_IMAGE_BYTES && SENDABLE_TYPES.includes(file.type)) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  // Screenshots stay sharp as PNG; fall back to JPEG when that is still too big.
  let blob = await encode('image/png');
  if (!blob || blob.size > MAX_IMAGE_BYTES) blob = await encode('image/jpeg', 0.85);
  if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error('image is too large');
  return blob;
}

function alertNote(text) {
  document.getElementById('log')?.append(h('div', { class: 'note error' }, text));
}

// ---------- model and effort ----------

const MODELS = [
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
  ['claude-fable-5-1', 'Fable 5.1'],
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const modelName = (id) => MODELS.find(([m]) => m === id)?.[1] ?? id;

/** Model and effort for this thread, beside Send; a change applies from its next turn. */
function modelPicker(chatId) {
  const save = (field) => async (e) => {
    const sel = e.target;
    sel.disabled = true;
    try {
      const ticket = await api(`/api/tickets/${chatId}`, { method: 'PATCH', body: { [field]: sel.value || null } });
      if (view?.kind === 'project' && view.id === chatId) {
        view.ticket = ticket;
        renderModelPicker();
      }
    } catch (err) {
      alertNote(err.message);
      renderModelPicker();
    } finally {
      sel.disabled = false;
    }
  };
  const model = h('select', { class: 'picker', id: 'model-picker', title: 'Model for this minion', 'aria-label': 'Model for this minion', onchange: save('model') });
  const effort = h('select', { class: 'picker', id: 'effort-picker', title: 'Effort for this minion', 'aria-label': 'Effort for this minion', onchange: save('effort') });
  return h('span', { class: 'pickers' }, model, effort);
}

/**
 * Fill the pickers from the thread: its choice, or with none, the default (named as what it came out
 * as on its last turn, else just "Model" / "Effort"). The default shows grey; a choice shows in full ink.
 */
function renderModelPicker() {
  const model = document.getElementById('model-picker');
  const effort = document.getElementById('effort-picker');
  if (!model || !effort || !view.ticket) return;
  const t = view.ticket;
  const defModel = !t.model && t.last_model ? modelName(t.last_model) : 'Model';
  model.replaceChildren(h('option', { value: '' }, defModel), ...MODELS.map(([id, name]) => h('option', { value: id }, name)));
  // A model set outside this list (say, by an older version) still shows as itself.
  if (t.model && !MODELS.some(([id]) => id === t.model)) model.append(h('option', { value: t.model }, t.model));
  model.value = t.model ?? '';
  const defEffort = !t.effort && t.last_effort ? t.last_effort : 'Effort';
  effort.replaceChildren(h('option', { value: '' }, defEffort), ...EFFORTS.map((e) => h('option', { value: e }, e)));
  effort.value = t.effort ?? '';
  model.classList.toggle('is-default', !t.model);
  effort.classList.toggle('is-default', !t.effort);
  const later = t.status === 'running' ? '; a change applies from the next turn' : '';
  model.title = t.model ? `Model for this minion: ${modelName(t.model)}${later}` : `Model for this minion: the default${t.last_model ? ` (${modelName(t.last_model)} on its last turn)` : ''}${later}`;
  effort.title = t.effort ? `Effort for this minion: ${t.effort}${later}` : `Effort for this minion: the default${t.last_effort ? ` (${t.last_effort} on its last turn)` : ''}${later}`;
  model.setAttribute('aria-label', model.title);
  effort.setAttribute('aria-label', effort.title);
}

function renderTicketHead() {
  renderModelPicker();
  const el = document.getElementById('ticket-head');
  if (!el) return;
  const t = view.ticket;
  const coord = isCoordinator(t);
  const actions = [];
  if (t.status === 'running') {
    actions.push(h('button', { class: 'secondary', onclick: () => api(`/api/tickets/${t.id}/stop`, { method: 'POST', body: {} }).catch((e) => alertNote(e.message)) }, 'Stop'));
  } else if (coord) {
    // The coordinator stays open for the life of the project.
  } else if (t.status === 'closed') {
    actions.push(h('button', { class: 'secondary', onclick: () => setStatus(t.id, 'idle') }, 'Reopen minion'));
  } else {
    actions.push(h('button', { class: 'secondary', onclick: async () => {
      if (await setStatus(t.id, 'closed')) location.hash = `#/p/${t.project_id}`;
    }, title: 'Dismiss minion' }, 'Dismiss', h('span', { class: 'wide-only' }, ' minion')));
  }
  const state = (coord ? statusLabel(t) : rowState(t).label) + (t.queued ? ` · ${t.queued} queued` : '');
  // Titled too, since phones may cut it short to keep the buttons beside it.
  const stateLabel = h('span', { class: 'muted', title: state }, state);
  el.replaceChildren(
    h('div', { class: 'row' },
      h('span', { class: `dot ${t.status}` }),
      h('h2', { title: threadFullName(t) }, threadTitleParts(t)),
      stateLabel,
      h('span', { class: 'spacer' }), ...actions, view.findEl ?? '',
      // Leaves the thread as it is and goes back to the project's coordinator.
      coord ? '' : h('a', { class: 'close-view', href: `#/p/${t.project_id}`, title: 'Back to the Taskmaster', 'aria-label': 'Back to the Taskmaster' }, '×')),
    view.progressEl);
  renderTyping();
  // While a turn runs, a sent message waits for it; said on hover rather than in a line of its own.
  const send = document.querySelector('.composer button[type=submit]');
  if (send) send.title = t.status === 'running' ? 'Runs after the current turn' : '';
  scheduleProgress();
}

async function setStatus(id, status) {
  try {
    await api(`/api/tickets/${id}/status`, { method: 'POST', body: { status } });
    return true;
  } catch (e) {
    alertNote(e.message);
    return false;
  }
}

// ---------- work progress (thread-bar readout) ----------

const STEP_ICON = { completed: '✓', in_progress: '◐', pending: '○' };

function resultString(result) {
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
}

/**
 * One tool call as a plain sentence ("Edited runner.ts", "Run the tests — failed: …"). The raw
 * command and output sit one click deeper and are only built when opened.
 */
function actionEl(action) {
  const { block, result } = action;
  const state = !result ? 'pending' : result.is_error ? 'err' : 'ok';
  const why = state === 'err' ? resultString(result).replace(/<\/?tool_use_error>/g, '').trim().split('\n')[0].slice(0, 120) : '';
  const el = h('details', { class: `act ${state}` },
    h('summary', {},
      h('span', { class: 'st', title: { pending: 'In progress', err: 'Failed', ok: 'Done' }[state] }, state === 'pending' ? '…' : state === 'err' ? '✗' : '·'),
      h('span', { class: 'what' }, threadRefs(actionLabel(block))),
      why ? h('span', { class: 'why' }, ` — failed: ${why}`) : '',
      ticketActionRef(action) ? [' → ', ...threadRefs(`#${ticketActionRef(action).number}`)] : ''));
  el.addEventListener('toggle', () => {
    if (!el.open || el.querySelector('.body')) return;
    const input = block.input || {};
    const body = h('div', { class: 'body' },
      h('pre', {}, block.name === 'Bash' && input.command ? `$ ${input.command}` : JSON.stringify(input, null, 2)));
    if (action.result) body.append(h('pre', { class: action.result.is_error ? 'err' : '' }, threadRefs(resultString(action.result) || '(no output)')));
    el.append(body);
  });
  return el;
}

/**
 * The thread a coordinator tool call created or messaged, from its result ("Created #15 …",
 * "Sent. #12 …"), as { verb, number }; null for other calls and failures.
 */
function ticketActionRef({ block, result }) {
  if (!result || result.is_error || !block.name.startsWith('mcp__coordinator__')) return null;
  const text = Array.isArray(result.content) ? result.content.map((c) => c?.text ?? '').join('\n') : String(result.content ?? '');
  const m = /^(Created|Sent\.|Updated\.) #(\d+)\b/.exec(text);
  return m ? { verb: { Created: 'Created', 'Sent.': 'Messaged', 'Updated.': 'Updated' }[m[1]], number: Number(m[2]) } : null;
}

/** "Created #15 · Messaged #12": links to the threads some work created or messaged, or null. */
function ticketActionLinks(acts) {
  const refs = acts.map(ticketActionRef).filter(Boolean);
  if (!refs.length) return null;
  return h('li', { class: 'thread-refs' }, h('span', { class: 'st' }, '→'),
    refs.flatMap((r, i) => [i ? ' · ' : '', `${r.verb} `, ...threadRefs(`#${r.number}`)]));
}

/** Claude's own words from while a step was underway, shortened to a couple of lines. */
function stepNote(text) {
  const short = text.length > 280 ? `${text.slice(0, 279).replace(/\s+\S*$/, '')}…` : text;
  return h('p', { class: 'step-note' }, short.replace(/[*`#]/g, ''));
}

function actionList(actions) {
  return h('div', { class: 'actions' }, actions.map(actionEl));
}

/** Which parts of a ticket's readout are expanded; kept per ticket so re-renders and reconnects don't fold it up. */
const progressUiState = new Map();
function progressUi(ticketId) {
  if (!progressUiState.has(ticketId)) progressUiState.set(ticketId, { open: false, openSteps: new Set() });
  return progressUiState.get(ticketId);
}

function firstSentence(text, max = 200) {
  const flat = String(text ?? '').replace(/[*`#>]/g, '').replace(/\s+/g, ' ').trim();
  const sentence = flat.match(/^.*?[.!?](\s|$)/)?.[0].trim() ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : sentence;
}

/** The phases of some work as rows ("✓ Looked through the code · 4 actions"), plus its commands behind a toggle. */
function phaseRows(acts, running) {
  const phases = workPhases(acts, running);
  const cmds = h('details', { class: 'cmds' }, h('summary', {}, `Show the ${acts.length} individual action${acts.length === 1 ? '' : 's'}`));
  cmds.addEventListener('toggle', () => {
    if (cmds.open && !cmds.querySelector('.actions')) cmds.append(actionList(acts));
  });
  return [
    h('ul', { class: 'phases' }, phases.map((ph) => h('li', { class: ph.ongoing ? 'ongoing' : '' },
      h('span', { class: 'st' }, ph.ongoing ? '◐' : '✓'), ph.text,
      h('span', { class: 'muted' }, ` · ${ph.count} action${ph.count === 1 ? '' : 's'}${ph.failed ? `, ${ph.failed} failed along the way` : ''}`))),
      ticketActionLinks(acts)),
    cmds,
  ];
}

/** One step of Claude's plan: its title, one plain line about it, and on opening, how the work went. */
function planStep(t, acts, running) {
  const now = t.status === 'in_progress';
  const live = now && running;
  const phases = workPhases(acts, live);
  // The one line: what it achieved once done, where it's at while underway, what it's for before then.
  let line;
  if (t.status === 'completed') line = t.outcome || (t.note && firstSentence(t.note)) || t.description || phases.map((ph) => ph.text).join(', ');
  else if (now) line = live ? (phases.length ? `Now: ${phases[phases.length - 1].text.toLowerCase()}` : 'Just started') : 'Paused here when the turn ended';
  else line = t.description || 'Not started yet';
  const el = h('details', { class: `step ${t.status}${now && !running ? ' paused' : ''}`, open: view.ui.openSteps.has(t.id) || null },
    h('summary', {},
      h('span', { class: 'icon' }, STEP_ICON[t.status] ?? '○'),
      h('span', { class: 'subject' }, t.subject),
      h('span', { class: 'recap' }, firstSentence(line, 220))),
    t.description && line !== t.description ? h('p', { class: 'step-desc' }, h('span', { class: 'muted' }, 'Plan: '), t.description) : '',
    t.note && !t.outcome ? stepNote(t.note) : '',
    acts.length ? phaseRows(acts, live) : '');
  el.addEventListener('toggle', () => (el.open ? view.ui.openSteps.add(t.id) : view.ui.openSteps.delete(t.id)));
  return el;
}

/** Work done outside any plan step, told as phases. */
function looseWork(acts, running, onlyWork) {
  const phases = workPhases(acts, running);
  const el = h('details', { class: 'step loose', open: (view.ui.looseOpen ?? onlyWork) || null },
    h('summary', {}, h('span', { class: 'icon' }, '⋯'),
      h('span', { class: 'subject' }, !onlyWork ? 'Other work this turn' : running ? 'Work so far' : 'Work last turn'),
      h('span', { class: 'recap' }, phases.map((ph) => ph.text).join(' → '))),
    view.turnNote ? stepNote(view.turnNote) : '',
    phaseRows(acts, running));
  el.addEventListener('toggle', () => (view.ui.looseOpen = el.open));
  return el;
}

let progressFrame = 0;
function scheduleProgress() {
  if (!progressFrame) progressFrame = requestAnimationFrame(() => { progressFrame = 0; renderProgress(); });
}

function renderProgress() {
  if (view?.kind !== 'project' || !view.ticket) return;
  const p = view.progress;
  const progressEl = view.progressEl;
  const running = view.ticket.status === 'running';
  const line = progressLine(p, running);
  if (!line) {
    progressEl.hidden = true;
    return;
  }
  const { total, done, current } = stepInfo(p);
  const m = total && line.match(/^(.*?)\s(\d+\/\d+)$/);
  const text = m ? m[1] : line;
  const count = m ? m[2] : running && p.turnActions ? `${p.turnActions} action${p.turnActions === 1 ? '' : 's'}` : '';

  const bar = h('button', { class: 'progress-line', 'aria-expanded': String(view.ui.open), onclick: () => {
    view.ui.open = !view.ui.open;
    renderProgress();
  } },
    h('span', { class: `dot ${running ? 'running' : view.ticket.status}` }),
    h('span', { class: 'text' }, text),
    count ? h('span', { class: 'count' }, count) : '',
    h('span', { class: 'chev' }, view.ui.open ? '▴' : '▾'));
  const meter = total ? h('progress', { class: 'meter', max: total, value: done }) : '';

  const prevDetail = progressEl.querySelector('.progress-detail');
  const scrollTop = prevDetail?.scrollTop ?? 0;
  let detail = '';
  if (view.ui.open) {
    const all = [...view.actions.values()];
    const groups = { completed: [], in_progress: [], pending: [] };
    for (const t of p.tasks) (groups[t.status] ?? groups.pending).push(t);
    const stepEl = (t) => planStep(t, all.filter((a) => a.taskId === t.id), running);
    const section = (title, tasks) => (tasks.length ? h('section', { class: 'plan-group' }, h('h4', {}, title), tasks.map(stepEl)) : '');
    const loose = view.turnActions.filter((a) => a.taskId == null || !p.tasks.some((t) => t.id === a.taskId));
    const req = view.turnRequest;
    detail = h('div', { class: 'progress-detail' },
      req?.length ? h('p', { class: 'request' }, h('span', { class: 'muted' }, running ? 'Working on ' : 'Last worked on '),
        req.flatMap((m, n) => [n ? ' and ' : '', `${m.author}'s request: `, h('q', {}, firstSentence(m.text, 160))])) : '',
      section('Done', groups.completed),
      section(running ? 'Now' : 'Stopped at', groups.in_progress),
      section('Up next', groups.pending),
      loose.length ? looseWork(loose, running, !p.tasks.length) : '',
      !p.tasks.length && !loose.length ? h('p', { class: 'muted empty' }, 'Nothing has run yet.') : '');
  }
  progressEl.replaceChildren(bar, meter, detail);
  if (detail) detail.scrollTop = scrollTop;
  progressEl.hidden = false;
}

function appendEvent(event, scroll = true) {
  view.lastEventId = Math.max(view.lastEventId, event.id);
  const log = document.getElementById('log');
  if (!log) return;
  const data = JSON.parse(event.data);
  if (event.kind === 'user_message') (view.pendingRequest ??= []).push({ author: data.author, text: data.text || '(image)' });
  if (event.kind === 'claude' && data.type === 'system' && data.subtype === 'init') {
    view.turnActions = [];
    view.turnNote = null;
    view.turnStartedAt = event.created_at;
    view.turnTexts = [];
    view.narrationEl = null;
    // Messages queued since the last turn are what this turn works on.
    if (view.pendingRequest?.length) view.turnRequest = view.pendingRequest;
    view.pendingRequest = [];
  }
  if (event.kind === 'claude' && data.type === 'assistant') {
    for (const b of data.message?.content ?? []) if (b.type === 'text' && b.text.trim()) view.turnNote = b.text.trim();
  }
  for (const { block, taskId } of applyEvent(view.progress, event.kind, data)) {
    const action = { block, taskId, result: null };
    view.actions.set(block.id, action);
    view.turnActions.push(action);
  }
  if (event.kind === 'claude') scheduleProgress();
  const nodes = [];
  let fold = false;

  if (event.kind === 'user_message') {
    if (data.author === me && view.pendingMessages.length) {
      // Our own message, already shown when it was sent: swap in the server's copy.
      const i = Math.max(0, view.pendingMessages.findIndex((m) => m.text === (data.text ?? '')));
      view.pendingMessages.splice(i, 1)[0].el.remove();
    }
    if (data.answer) {
      // An answer to a question card: the card shows the picks, so the message only needs a short line.
      view.cards.get(data.answer.questionId)?.markAnswered(data.answer.answers, data.author);
      nodes.push(h('div', { class: 'msg user answer' }, h('div', { class: 'who' }, data.author), answerSummary(data.answer.answers)));
    } else {
      nodes.push(userBubble(data.author, data.text,
        (data.images ?? []).map((name) => `/api/tickets/${event.ticket_id}/images/${encodeURIComponent(name)}`),
        data.comment ? { ticketId: event.ticket_id, path: data.comment.path, name: baseName(data.comment.about) } : null));
    }
  } else if (event.kind === 'question') {
    nodes.push(questionCard(event.ticket_id, data));
  } else if (event.kind === 'approval') {
    nodes.push(approvalCard(event.ticket_id, data));
  } else if (event.kind === 'approval_result') {
    // The card itself records who decided, or why it expired.
    view.cards.get(data.id)?.settle(data);
  } else if (event.kind === 'note') {
    const short = shortNote(data.text);
    if (short != null) nodes.push(h('div', { class: 'note', title: short === data.text ? null : data.text }, threadRefs(short)));
  } else if (event.kind === 'error') {
    nodes.push(h('div', { class: 'note error' }, data.text));
  } else if (event.kind === 'claude') {
    if (data.type === 'system' && data.subtype === 'init') {
      // Every turn re-inits the same session; only announce the first.
      if (!view.sawInit) nodes.push(h('div', { class: 'note' }, `Session started${data.model ? ` · ${data.model}` : ''}`));
      view.sawInit = true;
    } else if (data.type === 'assistant') {
      for (const block of data.message?.content ?? []) {
        if (block.type === 'text' && block.text.trim()) {
          const msg = h('div', { class: 'msg' }, h('div', { class: 'who' }, 'Claude'));
          msg.append(markdown(block.text, event.ticket_id));
          nodes.push(msg);
          (view.turnTexts ??= []).push({ el: msg, text: block.text });
        } else if (block.type === 'tool_use') {
          // Words followed by more work were narration; words that lead into a question card stay.
          if (block.name === 'mcp__thread__ask_question') view.turnTexts = [];
          else fold = true;
        }
      }
    } else if (data.type === 'user') {
      for (const block of data.message?.content ?? []) {
        const action = block.type === 'tool_result' && view.actions.get(block.tool_use_id);
        if (action) action.result = { content: block.content, is_error: block.is_error };
      }
    } else if (data.type === 'result') {
      // Tool calls stay out of the chat; each turn gets one collapsed line listing them.
      const acts = view.turnActions;
      const bits = [];
      if (data.duration_ms) bits.push(shortDuration(data.duration_ms));
      if (acts.length) bits.push(`${acts.length} action${acts.length === 1 ? '' : 's'}`);
      const title = [data.is_error ? 'Turn failed' : 'Turn finished', ...bits, data.total_cost_usd ? `$${data.total_cost_usd.toFixed(2)}` : ''].filter(Boolean).join(' · ');
      const summary = [view.branchEl, h('span', { class: 'bits', title },
        h('span', { class: data.is_error ? 'fail' : 'ok', 'aria-label': data.is_error ? 'Turn failed' : 'Turn finished' }, data.is_error ? '✗' : '✓'),
        ` ${bits.join(' · ')}`)];
      // The branch status rides on the newest turn's line, so it moves down as turns finish.
      if (acts.length) {
        const end = h('details', { class: 'turn-end' }, h('summary', {}, ...summary));
        end.addEventListener('toggle', () => {
          if (end.open && !end.querySelector('.phases')) end.append(...phaseRows(acts, false));
        });
        nodes.push(end);
      } else {
        nodes.push(h('div', { class: 'turn-end' }, ...summary));
      }
      if (data.is_error && data.result) nodes.push(h('div', { class: 'note error' }, data.result));
    }
  }

  log.append(...nodes);
  if (fold) foldNarration(event.ticket_id);
  renderTyping();
  if (scroll && followChat) scrollToBottom();
}

/**
 * Claude's in-between remarks ("Worktree is behind main; merging.") leave the chat for one folded
 * "updates along the way" row per turn, where the first of them was; the turn's last words stay a
 * bubble. While the turn runs, the newest remark also shows in the working line.
 */
function foldNarration(ticketId) {
  const texts = view.turnTexts?.splice(0) ?? [];
  if (!texts.length) return;
  if (!view.narrationEl?.isConnected) {
    view.narrationEl = h('details', { class: 'narration' }, h('summary', {}), h('div', { class: 'notes' }));
    texts[0].el.before(view.narrationEl);
  }
  const notes = view.narrationEl.querySelector('.notes');
  for (const t of texts) {
    t.el.remove();
    notes.append(h('div', { class: 'note-text' }, markdown(t.text, ticketId)));
  }
  const n = notes.childElementCount;
  view.narrationEl.querySelector('summary').replaceChildren(
    h('span', { class: 'st' }, '⋯'), ` ${n} update${n === 1 ? '' : 's'} along the way`);
}

/** "45s", "1m 47s", "12m", "1h 5m". */
function shortDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

/** An object URL for base64 image data (the page's CSP allows blob: images but not data: ones). */
function base64Url(mediaType, data) {
  return URL.createObjectURL(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mediaType }));
}

/** Short wording for the notes the server writes often (null hides one); anything else stays as it is. */
function shortNote(text) {
  let m;
  // Older threads stored a note on every session restore; restores are silent now.
  if (/^Restored this thread's Claude session from the app's database/.test(text)) return null;
  if (text === 'The server restarted during this turn, so it was interrupted.') return '⚠ Interrupted by a server restart';
  if ((m = text.match(/^(.+?) renamed this (?:ticket|minion) from ".*" to "(.*)"\.$/s))) return `✎ ${m[1] === 'Claude' ? 'Renamed' : `${m[1]} renamed it`} “${m[2]}”`;
  if ((m = text.match(/^(.+?) set this (?:thread|minion) to (.+?) (from the next turn|from now on)\.$/))) return `⚙ ${m[1]}: ${m[2]}${m[3] === 'from the next turn' ? ' next turn' : ''}`;
  if ((m = text.match(/^(.+?) (updated|cleared) the (?:project|scheme) instructions; they apply from each (?:thread|minion)'s next turn\.$/))) return `📋 ${m[1]} ${m[2]} the scheme instructions`;
  if ((m = text.match(/^(.+?) set the (approval rules|plugin folders) to: (.*)\. They apply from each (?:thread|minion)'s next turn\.$/s))) return `🔒 ${m[1]} set the ${m[2]}: ${m[3]}`;
  if ((m = text.match(/^(.+?) reopened this (?:ticket|minion)\.$/))) return `↻ ${m[1]} reopened it`;
  return text;
}

// ---------- approval cards ----------

/** "merge_pull_request (github)" for an MCP tool, else the tool's own name. */
function toolTitle(name) {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[2]} (${m[1]})` : name;
}

/** "✓ Approved by Cara", "✗ Denied by Cara", "⌛ Expired, not run: …". */
function approvalOutcome(r) {
  if (r.state === 'allowed') return `✓ Approved by ${r.by}`;
  if (r.state === 'denied') return `✗ Denied by ${r.by}`;
  return `⌛ Expired, not run: ${r.reason}`;
}

/**
 * A tool call that matches one of the project's approval rules, waiting for a person. The turn is
 * paused until someone clicks; a card whose turn ended (stopped, failed, server restart) expires.
 */
function approvalCard(ticketId, card) {
  const input = card.input ?? {};
  // Show what will actually run: the command for Bash, the path for file tools, else the whole input.
  const lead = typeof input.command === 'string' ? 'command' : typeof input.file_path === 'string' ? 'file_path' : null;
  const rest = lead ? Object.fromEntries(Object.entries(input).filter(([k]) => k !== lead && k !== 'description')) : {};
  const status = h('span', { class: 'muted', role: 'status' });
  const approve = h('button', { type: 'button', class: 'small' }, 'Approve');
  const deny = h('button', { type: 'button', class: 'small secondary' }, 'Deny');
  const el = h('div', { class: 'qcard acard' },
    h('div', { class: 'who' }, 'Claude asks to run'),
    h('div', { class: 'qtitle' }, h('span', { class: 'chip' }, 'Needs approval'), toolTitle(card.tool)),
    typeof input.description === 'string' ? h('div', { class: 'desc' }, input.description) : '',
    h('pre', { class: 'acmd' }, lead ? input[lead] : JSON.stringify(input, null, 2)),
    Object.keys(rest).length ? h('pre', { class: 'acmd extra' }, JSON.stringify(rest, null, 2)) : '',
    h('div', { class: 'row' }, status, h('span', { class: 'spacer' }), deny, approve));
  let settled = false;
  const decide = async (allow) => {
    if (settled) return;
    approve.disabled = deny.disabled = true;
    status.textContent = allow ? 'Approving…' : 'Denying…';
    try {
      await api(`/api/tickets/${ticketId}/approve`, { method: 'POST', body: { approvalId: card.id, allow } });
      if (view?.id === ticketId) catchUpEvents().catch(() => {});
    } catch (ex) {
      status.textContent = ex.message;
      // An expired or already-settled card stays shut; anything else can be tried again.
      if (!/expired|already/.test(ex.message)) approve.disabled = deny.disabled = false;
    }
  };
  approve.addEventListener('click', () => decide(true));
  deny.addEventListener('click', () => decide(false));
  view.cards.set(card.id, {
    settle(r) {
      settled = true;
      el.classList.add('answered', `a-${r.state}`);
      approve.hidden = deny.hidden = true;
      status.textContent = approvalOutcome(r);
    },
  });
  return el;
}

// ---------- question cards ----------

/** "Answered: Tabs · Other: keep both" lines for an answer message. */
function answerSummary(answers) {
  return h('div', { class: 'answer-lines' }, answers.map((a) =>
    h('div', {}, '→ ', [...a.selected, ...(a.other ? [`Other: ${a.other}`] : [])].join(' · '))));
}

/**
 * A card of multiple-choice questions from Claude. Click options to pick (several when the question
 * allows), or type an answer under Other; a single one-pick question sends on the first click.
 */
// Picks not yet sent, by card id, so a card keeps them while you look at an option's picture.
const cardPicks = new Map();

function questionCard(ticketId, card) {
  if (!cardPicks.has(card.id)) cardPicks.set(card.id, card.questions.map(() => ({ selected: new Set(), other: '' })));
  const picks = cardPicks.get(card.id);
  const single = card.questions.length === 1 && !card.questions[0].multiSelect;
  const sendBtn = h('button', { type: 'button', class: 'small', disabled: true }, single ? 'Send' : 'Send answers');
  const status = h('span', { class: 'muted' });
  const el = h('div', { class: 'qcard' });
  let answered = false;

  const ready = () => picks.every((p) => p.selected.size || p.other.trim());
  const refresh = () => {
    for (const [i, q] of card.questions.entries()) {
      for (const btn of el.querySelectorAll(`[data-q="${i}"] .opt`)) btn.classList.toggle('picked', picks[i].selected.has(btn.dataset.label));
    }
    sendBtn.disabled = answered || !ready();
  };
  const send = async () => {
    if (answered || !ready()) return;
    el.classList.add('sending');
    sendBtn.disabled = true;
    status.textContent = 'Sending…';
    try {
      const answers = picks.map((p) => ({ selected: [...p.selected], other: p.other.trim() }));
      const ticket = await api(`/api/tickets/${ticketId}/answer`, { method: 'POST', body: { questionId: card.id, answers } });
      if (view?.id === ticketId) {
        view.ticket = ticket;
        renderTicketHead();
        scrollToBottom();
        catchUpEvents().catch(() => {});
      }
    } catch (ex) {
      status.textContent = ex.message;
      el.classList.remove('sending');
      refresh();
    }
  };
  sendBtn.addEventListener('click', send);

  el.append(
    h('div', { class: 'who' }, 'Claude asks'),
    ...card.questions.map((q, i) => {
      const other = h('input', { type: 'text', class: 'other', placeholder: 'Other: type your own answer', maxlength: 2000, value: picks[i].other });
      other.addEventListener('input', () => {
        picks[i].other = other.value;
        // A typed answer replaces the pick on a one-answer question.
        if (!q.multiSelect && other.value.trim()) picks[i].selected.clear();
        refresh();
      });
      other.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send(); }
      });
      const pickBtn = (o) => h('button', {
        type: 'button', class: 'opt', 'data-label': o.label,
        onclick: () => {
          if (answered) return;
          const sel = picks[i].selected;
          if (q.multiSelect) sel.has(o.label) ? sel.delete(o.label) : sel.add(o.label);
          else {
            sel.clear();
            sel.add(o.label);
            other.value = '';
            picks[i].other = '';
          }
          refresh();
          if (single) send();
        },
      }, h('span', { class: 'label' }, o.label), o.description ? h('span', { class: 'desc' }, o.description) : '');
      // With pictures, the options are a gallery: each thumbnail opens the full view, its button picks it.
      const gallery = q.options.some((o) => o.image);
      return h('div', { class: 'q', 'data-q': i },
        h('div', { class: 'qtitle' }, q.header ? h('span', { class: 'chip' }, q.header) : '', q.question,
          q.multiSelect ? h('span', { class: 'muted' }, ' (pick any)') : ''),
        gallery
          ? h('div', { class: 'opts gallery' }, q.options.map((o) => h('div', { class: 'tile' },
            o.image ? optionThumb(ticketId, o) : h('div', { class: 'thumb none' }, 'No picture'), pickBtn(o))))
          : h('div', { class: 'opts' }, q.options.map(pickBtn)),
        other);
    }),
    h('div', { class: 'row' }, status, h('span', { class: 'spacer' }), sendBtn));
  refresh();

  view.cards.set(card.id, {
    markAnswered(answers, author) {
      answered = true;
      el.classList.remove('sending');
      el.classList.add('answered');
      answers.forEach((a, i) => {
        picks[i].selected = new Set(a.selected);
        const other = el.querySelector(`[data-q="${i}"] .other`);
        other.value = a.other ?? '';
        other.hidden = !a.other;
        other.disabled = true;
      });
      for (const btn of el.querySelectorAll('.opt')) btn.disabled = true;
      sendBtn.hidden = true;
      status.textContent = `Answered by ${author}`;
      refresh();
    },
  });
  return el;
}

/** A question option's picture: a thumbnail (muted and looping for video) that opens the file's full view. */
function optionThumb(ticketId, o) {
  const src = fileUrl(ticketId, o.image);
  let media = h('img', { src, alt: o.label, loading: 'lazy' });
  if (fileKind(o.image) === 'video') {
    media = h('video', { src, muted: true, autoplay: true, loop: true, playsinline: true, preload: 'metadata' });
    media.muted = true; // the attribute alone doesn't let it autoplay in every browser
  }
  return h('a', { class: 'thumb', href: fileHref(ticketId, o.image), title: `Open “${o.label}” full size` }, media);
}

// Messages the app sends a thread about its pull request (see src/github.ts).
const GITHUB_NAME = 'GitHub';
const COORDINATOR_NAME = 'Coordinator';

/** A chat message from a person; `about`, for a comment on a file, links that file. */
function userBubble(author, text, imageSrcs, about = null) {
  const github = author === GITHUB_NAME;
  const msg = h('div', { class: github ? 'msg user github' : 'msg user' }, h('div', { class: 'who' }, author,
    about ? [' on ', h('a', { class: 'about', href: fileHref(about.ticketId, about.path), title: about.path }, about.name)] : ''));
  // GitHub's messages end lines with bare URLs, which Markdown alone would leave as text.
  if (github && text) text = text.replace(/(^|\s)(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]])/g, '$1[$2]($2)');
  if (text) msg.append(markdown(text));
  if (imageSrcs.length) {
    msg.append(h('div', { class: 'images' }, imageSrcs.map((src) =>
      h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { src, alt: 'Attached image', loading: 'lazy' })))));
  }
  // The coordinator's hand-offs are rarely worth reading in full, so they start folded to one line.
  if (author === COORDINATOR_NAME || author === 'Taskmaster') {
    const preview = (text ?? '').replace(/[#*_`>\[\]]/g, '').replace(/\s+/g, ' ').trim();
    msg.querySelector('.who').remove();
    return h('details', { class: 'msg user coord' }, h('summary', {}, h('span', { class: 'who' }, author === COORDINATOR_NAME ? 'Taskmaster' : author), h('span', { class: 'preview' }, preview)), msg);
  }
  return msg;
}

/** "1m 05s" style, for how long a turn has run. */
function elapsedText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}

/**
 * The working line under the chat while a turn runs: what's running right now, how long the turn
 * has gone, and Claude's newest remark below. The plan step sits in the thread bar's readout just
 * above, so it isn't repeated here; clicking the line opens that readout.
 */
function renderTyping() {
  const el = view?.typingEl;
  if (!el || !view.ticket) return;
  const t = view.ticket;
  const show = t.status === 'running' || view.sendingTo === t.id;
  const wasHidden = el.hidden;
  el.hidden = !show;
  if (!show) return;
  const running = t.status === 'running';
  const last = view.turnActions.at(-1);
  const busy = running && last && !last.result;
  const doing = busy ? actionLabel(last.block) : 'thinking…';
  const sep = () => h('span', { class: 'sep' }, '·');
  el.title = 'Show the work so far';
  // Only once folded away, so a remark that is still a bubble isn't said twice.
  const said = running && view.turnNote && !view.turnTexts?.length ? firstSentence(view.turnNote, 200) : '';
  el.replaceChildren(
    h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
    h('span', { class: 'lines' },
      h('span', { class: 'line' },
        h('span', { class: 'lead' }, t.approvals ? 'Waiting for someone to approve or deny' : running ? 'Claude is working' : 'Claude is thinking…'),
        running && !t.approvals ? [sep(), h('span', { class: 'what' }, doing)] : '',
        running && view.turnStartedAt ? [sep(), h('span', { class: 'time', 'aria-hidden': 'true' }, elapsedText(Date.now() - view.turnStartedAt))] : '',
        t.queued ? [sep(), h('span', { class: 'queued', title: `${t.queued} message${t.queued === 1 ? '' : 's'} queued for the next turn` }, `${t.queued} queued`)] : ''),
      said ? h('span', { class: 'said' }, said) : ''));
  if (wasHidden && followChat) scrollToBottom();
}

/** Ticks the turn timer without rebuilding the line (and without re-announcing it to screen readers). */
setInterval(() => {
  const time = view?.typingEl?.querySelector('.time');
  if (time && view.turnStartedAt && !view.typingEl.hidden) time.textContent = elapsedText(Date.now() - view.turnStartedAt);
}, 1000);

// ---------- boot ----------

// Sticky elements sit just below the top bar, whose height changes with wrapping and safe areas.
// On wider screens it is a rail down the left edge instead, and nothing needs to clear it.
const topbar = document.querySelector('.topbar');
// Use the exact height: at fractional display scaling (e.g. 175%) a rounded one leaves a sliver
// where scrolled chat text shows through.
new ResizeObserver(() => {
  const r = topbar.getBoundingClientRect();
  document.documentElement.style.setProperty('--topbar-h', `${r.width > r.height ? r.height : 0}px`);
}).observe(topbar);
// Phones: edge swipes pull out the overview (left) and threads (right) panels as drawers.
initDrawers();
// Keep relative times in the usage readout honest.
setInterval(() => {
  if (usage) renderUsage();
}, 30_000);

api('/api/me').then((r) => start(r.name)).catch(() => {});
// The service worker makes the app installable (home screen, full screen) and shows push notifications; it caches nothing.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// Only in the installed app, so browser tabs look and behave as before: colour the title/status bar
// like the top bar, and on Android shrink the page when the keyboard opens so the composer stays in view.
if (matchMedia('(display-mode: standalone)').matches) {
  const viewport = document.querySelector('meta[name=viewport]');
  viewport.content += ', interactive-widget=resizes-content';
  for (const [scheme, color] of [['light', '#ffffff'], ['dark', '#201f1d']]) {
    document.head.append(h('meta', { name: 'theme-color', content: color, media: `(prefers-color-scheme: ${scheme})` }));
  }
}
