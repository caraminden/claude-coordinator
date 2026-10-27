// Claude Coordinator front end: hash-routed views over the JSON API, live via SSE.
import { actionLabel, applyEvent, createProgress, progressLine, stepInfo, workPhases } from './progress.js';

const app = document.getElementById('app');
const crumbs = document.getElementById('crumbs');
const meEl = document.getElementById('me');

const STATUS_LABEL = { running: 'Running', idle: 'Waiting for you', new: 'Starting', error: 'Error', closed: 'Closed' };
// Thread naming and the threads list follow Delve's Custom view: threads are grouped by kind of
// work, and each is one compact row of number + short ask, a state, and a terse note.
const TAGS = {
  feature: { emoji: '🛠️', label: 'Feature', section: 'Features' },
  bug: { emoji: '🐛', label: 'Bug', section: 'Bugs' },
  design: { emoji: '🎨', label: 'Design', section: 'Design' },
  process: { emoji: '⚙️', label: 'Process', section: 'Process' },
  idea: { emoji: '💡', label: 'Idea', section: 'Ideas' },
};
const SECTIONS = ['feature', 'bug', 'design', 'process', null, 'idea']; // null: untagged, "Other"
const STATES = {
  ready: { emoji: '✅', label: 'Ready to merge or pick up' },
  try: { emoji: '🧪', label: 'Ready for you to try' },
  parked: { emoji: '🧊', label: 'Parked' },
  blocked: { emoji: '⛔', label: 'Blocked on something outside the thread' },
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
/** A linked path short enough for a card: a thread's shared folder by name, other absolute paths by their tail. */
function shortPath(path) {
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

/** Small, safe Markdown subset: code fences, inline code, bold, headings, lists, links, paragraphs.
 * With `ticketId`, links to paths in that thread's folders become file cards and `![…](path)`
 * becomes an inline preview; both open the file in place of the chat. */
function markdown(src, ticketId = null) {
  const out = [];
  const parts = src.split(/^```[^\n]*\n([\s\S]*?)^```\s*$/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre><code>${escapeHtml(part)}</code></pre>`);
      return;
    }
    for (const block of part.split(/\n{2,}/)) {
      if (!block.trim()) continue;
      const inline = (t) => {
        // Code spans first, so nothing inside them is treated as Markdown.
        const codes = [];
        let html = escapeHtml(t).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
        if (ticketId != null) {
          html = html
            .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (all, alt, href) => filePreviewHtml(ticketId, unescapeHtml(href), alt) ?? all)
            .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, href) => fileCardHtml(ticketId, unescapeHtml(href), text) ?? all);
        }
        html = html
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        return html.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
      };
      const lines = block.replace(/^\n+|\n+$/g, '').split('\n');
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) {
        const ordered = /^\s*\d+\./.test(lines[0]);
        const items = lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>`).join('');
        out.push(ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`);
      } else if (/^#{1,6}\s/.test(lines[0]) && lines.length === 1) {
        out.push(`<p><strong>${inline(lines[0].replace(/^#+\s/, ''))}</strong></p>`);
      } else {
        out.push(`<p>${lines.map(inline).join('<br>')}</p>`);
      }
    }
  });
  const div = document.createElement('div');
  div.innerHTML = out.join('');
  return div;
}

/**
 * Fuller Markdown for documents threads write: headings, nested lists, tables, quotes, rules,
 * italics, and images, which `imageUrl` maps to a URL (or null to show the alt text instead).
 */
function markdownDoc(src, imageUrl) {
  const inline = (t) => {
    // Pull code spans out first so nothing inside them is treated as Markdown.
    const codes = [];
    let html = escapeHtml(t).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    html = html
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, href) => {
        const url = imageUrl(href.replace(/&amp;/g, '&'));
        return url
          ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt="${alt}" title="${alt}" loading="lazy"></a>`
          : `<span class="muted">[image: ${alt}]</span>`;
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => /^https?:\/\//.test(href)
        ? `<a href="${href}" target="_blank" rel="noopener">${text}</a>`
        : `<span class="link" title="${href}">${text}</span>`)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s](?:[^*]*?[^*\s])?)\*(?![\w*])/g, '$1<em>$2</em>');
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
      out.push(`<blockquote>${markdownDoc(quoted.join('\n'), imageUrl).innerHTML}</blockquote>`);
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
      out.push(`<p>${inline(para.join(' '))}</p>`);
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
    const [{ coordinator, tickets }, artifacts, chat] = await Promise.all([
      api(`/api/projects/${view.projectId}`),
      api(`/api/projects/${view.projectId}/artifacts`),
      view.id ? api(`/api/tickets/${view.id}`) : null,
    ]);
    view.coordinator = coordinator;
    view.tickets = new Map(tickets.map((t) => [t.id, t]));
    renderSidebar();
    setArtifacts(artifacts);
    if (!chat) return;
    view.ticket = chat.ticket;
    renderTicketHead();
    if (view.ticket.branch) refreshBranch(view.id);
    await catchUpEvents();
  } catch {}
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
  }
}

function onEvent(event) {
  if (view?.kind !== 'project' || view.id !== event.ticket_id) return;
  if (event.id <= view.lastEventId) return;
  appendEvent(event);
}

// ---------- routing ----------

async function route() {
  if (!me) return;
  saveScroll();
  const hash = location.hash || '#/';
  let m;
  try {
    if ((m = hash.match(/^#\/p\/(\d+)$/))) await showProject(Number(m[1]));
    else if ((m = hash.match(/^#\/p\/(\d+)\/artifacts$/))) await showProject(Number(m[1]), { kind: 'artifacts' });
    else if ((m = hash.match(/^#\/a\/(\d+)$/))) await showArtifact(Number(m[1]));
    else if ((m = hash.match(/^#\/f\/(\d+)\/(.+)$/))) await showFile(Number(m[1]), decodeURIComponent(m[2]));
    else if ((m = hash.match(/^#\/p\/(\d+)\/t\/(\d+)$/))) await showProject(Number(m[1]), { kind: 'chat', number: Number(m[2]) });
    else if ((m = hash.match(/^#\/t\/(\d+)$/))) await showTicket(Number(m[1]));
    else await showProjects();
  } catch (err) {
    if (err.message !== 'Not logged in') app.replaceChildren(h('p', { class: 'error' }, err.message));
  }
}

window.addEventListener('hashchange', route);

// ---------- login ----------

function renderLogin() {
  view = null;
  crumbs.replaceChildren();
  meEl.replaceChildren();
  app.replaceChildren(document.getElementById('login-tpl').content.cloneNode(true));
  const form = document.getElementById('login-form');
  try { form.name.value = localStorage.getItem('cc-name') || ''; } catch {}
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
  await api('/api/logout', { method: 'POST', body: {} });
  clearTimeout(streamTimer);
  stream?.close();
  stream = null;
  me = null;
  renderLogin();
}

// ---------- projects ----------

async function showProjects() {
  const projects = await api('/api/projects');
  view = { kind: 'projects' };
  crumbs.replaceChildren('Projects');
  const form = h('form', {},
    h('label', {}, 'Name', h('input', { name: 'name', required: true, maxlength: 80, 'data-draft': true })),
    h('label', {}, 'Git repo URL (optional; each ticket gets its own worktree)',
      h('input', { name: 'repoUrl', 'data-draft': true, placeholder: 'https://github.com/caraminden/gamedevtest.git' })),
    h('p', { class: 'error', hidden: true }),
    h('button', { type: 'submit' }, 'Create project'));
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
      btn.textContent = 'Create project';
    }
  });
  app.replaceChildren(
    h('h2', {}, 'Projects'),
    projects.length
      ? h('div', { class: 'projects' }, projects.map((p) =>
          h('a', { class: 'card', href: `#/p/${p.id}` },
            h('div', { class: 'title' }, h('strong', {}, p.name)),
            h('div', { class: 'muted' }, p.repo_url || 'No repo'),
            h('div', { class: 'muted' }, `${p.tickets} ticket${p.tickets === 1 ? '' : 's'}`))))
      : h('p', { class: 'muted' }, 'No projects yet.'),
    h('details', { class: 'new', open: !projects.length }, h('summary', {}, 'New project'), h('div', { class: 'card' }, form)),
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
const threadLabel = (t) => (isCoordinator(t) ? 'Coordinator' : `#${t.number ?? t.id} ${t.title}`);
/** The full name, Delve style: "🛠️ 12 FEATURE: Usage bar ✅". */
function threadFullName(t) {
  if (isCoordinator(t)) return 'Coordinator';
  const tag = TAGS[t.tag];
  const state = t.status !== 'running' && STATES[t.state];
  return [tag?.emoji, t.number ?? t.id, tag ? `${tag.label.toUpperCase()}: ${t.title}` : t.title, state?.emoji].filter(Boolean).join(' ');
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

async function showArtifact(artifactId) {
  const { artifact } = await api(`/api/artifacts/${artifactId}`);
  await showProject(artifact.project_id, { kind: 'artifact', artifact });
}

/**
 * A project page: artifacts and threads on the side, and in the main panel a chat with the
 * coordinator (or the chosen ticket), the artifact browser, or one artifact.
 */
async function showProject(projectId, main = { kind: 'chat', number: null }) {
  const [{ project, coordinator, tickets }, artifacts, projects] = await Promise.all([
    api(`/api/projects/${projectId}`),
    // An empty shelf beats a broken page if the server is older than this front end.
    api(`/api/projects/${projectId}/artifacts`).catch(() => []),
    api('/api/projects').catch(() => []),
  ]);
  let chatId = null;
  if (main.kind === 'chat') {
    chatId = main.id ?? (main.number == null ? coordinator.id : tickets.find((t) => t.number === main.number)?.id);
    if (!chatId) throw new Error(`There is no thread #${main.number} in ${project.name}.`);
  }
  const [{ ticket }, events] = chatId
    ? await Promise.all([api(`/api/tickets/${chatId}`), api(`/api/tickets/${chatId}/events`)])
    : [{ ticket: null }, []];
  view = {
    kind: 'project', main: main.kind, projectId, project, coordinator, tickets: new Map(tickets.map((t) => [t.id, t])),
    artifacts, artifactId: main.artifact?.id ?? null,
    file: main.file ?? null, fileTicket: main.ticket ?? null,
    id: chatId, ticket, lastEventId: 0,
    progress: createProgress(),
    progressEl: h('div', { class: 'progress', hidden: true }), // lives in the thread bar
    findEl: chatId ? chatFindBox() : null, // lives in the thread bar too, so it survives re-renders
    ui: progressUi(chatId),
    actions: new Map(), // tool_use_id -> { block, taskId, result }
    turnActions: [], // actions of the current (or last) turn, in order
    typingEl: h('div', { class: 'typing', hidden: true, 'aria-live': 'polite' }), // below the chat log
    sendingTo: null, // ticket id while a message is on its way, before the server confirms the turn
    pendingMessages: [], // { el, text } shown on send, replaced by the server's copy
    branchEl: h('span', { class: 'branch-status', hidden: true }), // PR / branch state, on the newest turn-end line
  };
  const projectLink = h('a', { href: `#/p/${project.id}` }, project.name);
  const artifactsLink = h('a', { href: `#/p/${project.id}/artifacts` }, 'Artifacts');
  crumbs.replaceChildren(h('a', { href: '#/' }, 'Projects'), ' / ', ...(
    main.kind === 'artifacts' ? [projectLink, ' / ', 'Artifacts']
      : main.kind === 'artifact' ? [projectLink, ' / ', artifactsLink, ' / ', main.artifact.name]
      : main.kind === 'file' ? [projectLink, ' / ', h('a', { href: threadHref(main.ticket) }, isCoordinator(main.ticket) ? 'Coordinator' : `#${main.ticket.number ?? main.ticket.id}`), ' / ', main.file.name]
        : chatId !== coordinator.id ? [projectLink, ' / ', `#${ticket.number ?? ticket.id}`]
          : [project.name]));

  // Both side panels collapse to a slim tab so the main panel can take their room. On wider
  // screens that choice is remembered; on phones they fold away above the main panel instead.
  const narrowQuery = matchMedia('(max-width: 800px)');
  const panelOpen = (name) => !narrowQuery.matches && loadPanelState()[name] !== false;
  // The overview panel: account and usage (standing in for the top bar, which wider screens hide
  // on project pages), the projects, then this project's pinned and recent artifacts.
  const shelf = h('details', { class: 'shelf', open: panelOpen('shelf') },
    h('summary', { title: 'Show or hide the overview' }, h('span', { class: 'label' }, project.name)),
    h('section', { class: 'account' },
      h('div', { class: 'row' }, h('strong', {}, me), h('span', { class: 'spacer' }),
        h('button', { class: 'secondary small', onclick: logout }, 'Sign out')),
      usageMeter()),
    h('section', { class: 'column' },
      h('h3', {}, 'Projects', h('span', { class: 'spacer' }), h('a', { class: 'more', href: '#/' }, 'All')),
      projects.map((p) => h('a', { class: `nav-item${p.id === projectId ? ' active' : ''}`, href: `#/p/${p.id}` },
        h('span', { class: 'name' }, p.name)))),
    h('div', { id: 'artifact-shelf' }));
  const sidebar = h('details', { class: 'sidebar', open: panelOpen('threads') },
    h('summary', { title: 'Show or hide threads' }, h('span', { class: 'label' }, 'Threads')),
    newTicketForm(projectId),
    threadSearchBox(projectId),
    h('div', { id: 'threads' }));
  // Don't hide a half-written new thread behind a collapsed sidebar.
  if (sidebar.querySelector('details.new').open) sidebar.open = true;
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
    : main.kind === 'artifact' ? artifactViewer(main.artifact)
      : main.kind === 'file' ? fileViewer(main.ticket, main.file)
        : chatSection(chatId, ticket, events);

  // .panels only becomes a box of its own when both panels are collapsed, so their tabs can share
  // one slim sticky column; otherwise the panels sit directly in the grid.
  app.replaceChildren(h('div', { class: 'split' }, h('div', { class: 'panels' }, shelf, sidebar), section));
  renderUsage();
  renderShelf();
  renderSidebar();
  if (main.kind === 'artifacts') renderArtifactResults();
  if (main.kind === 'artifact') renderArtifactHead();
  if (main.kind === 'file') renderFileHead();
  if (!chatId) return window.scrollTo(0, 0);
  renderTicketHead();
  for (const ev of events) appendEvent(ev, false);
  if (ticket.branch) refreshBranch(chatId);
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
  const textarea = h('textarea', {
    placeholder: isCoordinator(ticket)
      ? 'Ask the coordinator to start, check on, or close tickets… (Enter to send, Shift+Enter for a new line)'
      : 'Message this ticket… (Enter to send, Shift+Enter for a new line)',
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
      h('button', { type: 'button', class: 'secondary small', onclick: () => picker.click() }, 'Add image'),
      h('span', { class: 'muted', id: 'composer-hint' }), h('span', { class: 'spacer' }),
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
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
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
      'This is the project coordinator. It keeps track of the threads on the left and can create, message, rename and close them for you.'));
  }
  return h('section', { class: 'chat' }, h('div', { class: 'ticket-head', id: 'ticket-head' }), log, view.typingEl, form);
}

function newTicketForm(projectId) {
  const form = h('form', {},
    h('label', {}, 'Title', h('input', { name: 'title', required: true, maxlength: 120, placeholder: 'The short ask, about 30 characters', 'data-draft': true })),
    h('label', {}, 'Kind',
      h('select', { name: 'tag' },
        h('option', { value: '' }, 'Other (one-off question, review…)'),
        Object.entries(TAGS).map(([value, t]) => h('option', { value }, `${t.emoji} ${t.label}`)))),
    h('label', {}, 'First message', h('textarea', { name: 'message', required: true, rows: 5, placeholder: 'What should this thread work on? (Enter to send, Shift+Enter for a new line)', 'data-draft': true })),
    h('label', {}, 'Permissions',
      h('select', { name: 'permissionMode' },
        h('option', { value: 'bypassPermissions' }, 'Full access: edit files and run any command'),
        h('option', { value: 'acceptEdits' }, 'Edit files only; shell commands are refused'),
        h('option', { value: 'plan' }, 'Plan only: read and plan, no changes'))),
    h('p', { class: 'error', hidden: true }),
    h('button', { type: 'submit' }, 'Start thread'));
  const draftKey = `cc-new-thread:${projectId}`;
  const draft = loadDraft(draftKey);
  if (draft) {
    form.title.value = draft.title ?? '';
    form.message.value = draft.message ?? '';
    if (draft.permissionMode) form.permissionMode.value = draft.permissionMode;
    if (draft.tag) form.tag.value = draft.tag;
  }
  const fields = () => ({ title: form.title.value, tag: form.tag.value || null, message: form.message.value, permissionMode: form.permissionMode.value });
  form.addEventListener('input', () => saveDraft(draftKey, form.title.value || form.message.value ? fields() : null));
  form.message.addEventListener('keydown', (e) => {
    // Same as the chat composer: Enter sends, Shift+Enter adds a line, IME composition is left alone.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    const err = form.querySelector('.error');
    if (btn.disabled) return;
    btn.disabled = true;
    sending++;
    try {
      const t = await api(`/api/projects/${projectId}/tickets`, { method: 'POST', body: fields() });
      saveDraft(draftKey, null);
      form.reset();
      location.hash = threadHref(t);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    } finally {
      sending--;
    }
  });
  // A half-written thread stays open so it is not forgotten.
  return h('details', { class: 'new', open: !!(draft?.title || draft?.message) }, h('summary', {}, 'New thread'), form);
}

function renderSidebar() {
  const el = document.getElementById('threads');
  if (!el) return;
  const tickets = [...view.tickets.values()];
  if (threadSearch.q) return renderThreadResults(el, tickets.sort((a, b) => b.updated_at - a.updated_at));
  const open = tickets.filter((t) => t.status !== 'closed');
  const closed = tickets.filter((t) => t.status === 'closed').sort((a, b) => b.updated_at - a.updated_at);
  const sections = SECTIONS.map((tag) => {
    const rows = open.filter((t) => (TAGS[t.tag] ? t.tag : null) === tag).sort(byUrgency);
    if (!rows.length) return '';
    return h('section', { class: `thread-group g-${tag ?? 'other'}` },
      h('h3', {}, tag ? TAGS[tag].section : 'Other'), rows.map((t) => threadRow(t)));
  });
  let closedGroup = '';
  if (closed.length) {
    // Closed threads stay out of the way but can still be opened and reopened.
    closedGroup = h('details', { class: 'thread-group g-closed', open: view.showClosed }, h('summary', {}, 'Closed'), closed.map((t) => threadRow(t)));
    closedGroup.addEventListener('toggle', () => { view.showClosed = closedGroup.open; });
  }
  el.replaceChildren(
    threadRow(view.coordinator, `#/p/${view.projectId}`),
    ...sections, closedGroup,
    tickets.length ? '' : h('p', { class: 'muted' }, 'No threads yet. Ask the coordinator to start one, or use New thread.'));
}

// ---------- search ----------

// The threads search, kept across thread switches within a project.
const threadSearch = { projectId: null, q: '', hits: new Map(), seq: 0, timer: null };
// Text to find in the next chat that opens, set when a search result is clicked.
let pendingFind = '';

function threadSearchBox(projectId) {
  if (threadSearch.projectId !== projectId) Object.assign(threadSearch, { projectId, q: '', hits: new Map() });
  const input = h('input', { type: 'search', class: 'thread-search', placeholder: 'Search threads and what was said…', value: threadSearch.q, autocomplete: 'off' });
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
        : h('p', { class: 'muted small' }, threadSearch.q.length < 2 ? 'Keep typing to search conversations too.' : 'No threads mention that.')));
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
  const input = h('input', { type: 'search', class: 'chat-find', placeholder: 'Find in chat', autocomplete: 'off' });
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
    clearHighlights(log);
    const q = input.value.trim();
    state.marks = q ? [...log.querySelectorAll('.msg, .note')].flatMap((m) => highlight(m, q)) : [];
    state.at = -1;
    count.textContent = q ? (state.marks.length ? `0/${state.marks.length}` : 'none') : '';
    // Start from the newest match, nearest where you usually are.
    if (state.marks.length) show(state.marks.length - 1);
  };
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
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
  if (t.status === 'running' || t.status === 'new') return { rank: 1, cls: 'w', cell: [`●${steps}`], label: 'Claude is working' };
  if (t.status === 'error') return { rank: 0, cls: 'st', cell: ['⚠️'], label: 'Stuck: the last turn failed' };
  if (t.status === 'closed') return { rank: 5, cls: 'm', cell: ['✓'], label: 'Closed' };
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
  return h('a', { class: `thread-row s-${t.status}${coord ? ' coordinator' : ''}${active ? ' active' : ''}`, href, title: details },
    h('span', { class: 'name' }, coord ? 'Coordinator' : [h('span', { class: 'num' }, t.number ?? t.id), ' ', t.title]),
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
    if (pr.state === 'OPEN' && status.merged) parts.push(`merged into ${status.base}`);
  } else if (status && !status.empty) {
    parts.push(h('span', { class: 'branch', title: status.branch }, status.branch));
    parts.push(status.merged
      ? h('span', { class: 'state merged' }, `merged into ${status.base}`)
      : h('span', { class: 'state open' }, `${status.ahead} commit${status.ahead === 1 ? '' : 's'} not in ${status.base}`));
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
    const artifacts = await api(`/api/projects/${projectId}/artifacts`);
    if (view?.kind === 'project' && view.projectId === projectId) setArtifacts(artifacts);
  } catch {}
}

function setArtifacts(artifacts) {
  view.artifacts = artifacts;
  renderShelf();
  if (view.main === 'artifacts') renderArtifactResults();
  if (view.main === 'artifact') renderArtifactHead();
  if (view.main === 'file') renderFileHead();
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
      h('span', { class: 'meta' }, `${a.ticket_kind === 'coordinator' ? 'Coordinator' : `#${a.ticket_number ?? a.ticket_id}`} · ${a.missing ? 'missing' : ago(a.mtime)}`)));
  const sub = (title, count, items, empty) => h('div', { class: 'sub' },
    h('h4', {}, title, count ? h('span', { class: 'count' }, count) : ''),
    items.length ? items.map(item) : h('p', { class: 'muted small' }, empty));
  el.replaceChildren(h('section', { class: 'column' },
    h('h3', {}, 'Artifacts', h('span', { class: 'spacer' }),
      h('a', { class: `browse${view.main === 'artifacts' ? ' active' : ''}`, href: `#/p/${view.projectId}/artifacts`, title: `Browse all ${all.length} artifacts` }, 'Browse')),
    sub('Pinned', pinned.length, pinned, 'Pin artifacts with ☆ to keep them here.'),
    sub('Recent', 0, recent, 'Documents, pages and canvases that threads create show up here.')));
}

/** Main panel: every artifact in the project, searchable, with pin toggles. */
function artifactBrowser() {
  view.artifactFilter = 'all';
  const search = h('input', { type: 'search', id: 'artifact-search', placeholder: 'Search by name, folder or thread…', autocomplete: 'off' });
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
      : 'No artifacts yet. When threads create documents, web pages or canvases in their folders, they appear here.'));
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
    body.append(h('p', { class: 'muted' }, 'This file is no longer in the thread\'s folder. Unpin it to remove it from the list.'));
  } else {
    renderFileBody(body, { ...a, src: rawUrl(a), ticketId: a.ticket_id });
  }
  return section;
}

/** Main panel: a file a thread linked, with a way back to its chat. */
function fileViewer(ticket, file) {
  const body = h('div', { class: 'artifact-body' });
  if (file.missing) body.append(h('p', { class: 'muted' }, `${file.missing}.`));
  else renderFileBody(body, { ...file, src: `${fileUrl(ticket.id, file.path)}&v=${file.mtime}`, ticketId: ticket.id });
  return h('section', { class: 'artifacts-main' }, h('div', { class: 'ticket-head', id: 'file-head' }), body);
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
function renderFileBody(body, { kind, src, size, name, path, ticketId }) {
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
      const imageUrl = (href) => (isLocalPath(href) ? fileUrl(ticketId, joinPath(dir, href.split('#')[0])) : null);
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
      h('span', { class: 'muted' }, 'The file was deleted from its thread\'s folder.')));
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
  const model = h('select', { class: 'picker', id: 'model-picker', title: 'Model for this thread', onchange: save('model') });
  const effort = h('select', { class: 'picker', id: 'effort-picker', title: 'Effort for this thread', onchange: save('effort') });
  return h('span', { class: 'pickers' }, model, effort);
}

/** Fill the pickers from the thread: its choice, and for "Default", what that came out as on its last turn without one. */
function renderModelPicker() {
  const model = document.getElementById('model-picker');
  const effort = document.getElementById('effort-picker');
  if (!model || !effort || !view.ticket) return;
  const t = view.ticket;
  const defModel = !t.model && t.last_model ? `Default · ${modelName(t.last_model)}` : 'Default model';
  model.replaceChildren(h('option', { value: '' }, defModel), ...MODELS.map(([id, name]) => h('option', { value: id }, name)));
  // A model set outside this list (say, by an older version) still shows as itself.
  if (t.model && !MODELS.some(([id]) => id === t.model)) model.append(h('option', { value: t.model }, t.model));
  model.value = t.model ?? '';
  const defEffort = !t.effort && t.last_effort ? `Default · ${t.last_effort}` : 'Default effort';
  effort.replaceChildren(h('option', { value: '' }, defEffort), ...EFFORTS.map((e) => h('option', { value: e }, `${e} effort`)));
  effort.value = t.effort ?? '';
  model.title = `Model for this thread${t.last_model ? ` (default here: ${modelName(t.last_model)})` : ''}${t.status === 'running' ? '; a change applies from the next turn' : ''}`;
  effort.title = `Effort for this thread${t.last_effort ? ` (default here: ${t.last_effort})` : ''}${t.status === 'running' ? '; a change applies from the next turn' : ''}`;
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
    actions.push(h('button', { class: 'secondary', onclick: () => setStatus(t.id, 'idle') }, 'Reopen'));
  } else {
    actions.push(h('button', { class: 'secondary', onclick: async () => {
      if (await setStatus(t.id, 'closed')) location.hash = `#/p/${t.project_id}`;
    } }, 'Close ticket'));
  }
  el.replaceChildren(
    h('div', { class: 'row' },
      h('span', { class: `dot ${t.status}` }),
      h('h2', {}, threadFullName(t)),
      h('span', { class: 'muted' }, (coord ? statusLabel(t) : rowState(t).label) + (t.queued ? ` · ${t.queued} queued` : '')),
      h('span', { class: 'spacer' }), view.findEl ?? '', ...actions,
      // Leaves the thread as it is and goes back to the project's coordinator.
      coord ? '' : h('a', { class: 'close-view', href: `#/p/${t.project_id}`, title: 'Back to the coordinator', 'aria-label': 'Back to the coordinator' }, '×')),
    view.progressEl);
  renderTyping();
  const hint = document.getElementById('composer-hint');
  if (hint) hint.textContent = t.status === 'running' ? 'Messages sent now run after the current turn.' : '';
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
      h('span', { class: 'what' }, actionLabel(block)),
      why ? h('span', { class: 'why' }, ` — failed: ${why}`) : ''));
  el.addEventListener('toggle', () => {
    if (!el.open || el.querySelector('.body')) return;
    const input = block.input || {};
    const body = h('div', { class: 'body' },
      h('pre', {}, block.name === 'Bash' && input.command ? `$ ${input.command}` : JSON.stringify(input, null, 2)));
    if (action.result) body.append(h('pre', { class: action.result.is_error ? 'err' : '' }, resultString(action.result) || '(no output)'));
    el.append(body);
  });
  return el;
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
      h('span', { class: 'muted' }, ` · ${ph.count} action${ph.count === 1 ? '' : 's'}${ph.failed ? `, ${ph.failed} failed along the way` : ''}`)))),
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

  if (event.kind === 'user_message') {
    if (data.author === me && view.pendingMessages.length) {
      // Our own message, already shown when it was sent: swap in the server's copy.
      const i = Math.max(0, view.pendingMessages.findIndex((m) => m.text === (data.text ?? '')));
      view.pendingMessages.splice(i, 1)[0].el.remove();
    }
    nodes.push(userBubble(data.author, data.text,
      (data.images ?? []).map((name) => `/api/tickets/${event.ticket_id}/images/${encodeURIComponent(name)}`)));
  } else if (event.kind === 'note') {
    nodes.push(h('div', { class: 'note' }, data.text));
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
      const bits = [data.is_error ? 'Turn failed' : 'Turn finished'];
      if (data.duration_ms) bits.push(`${Math.round(data.duration_ms / 1000)}s`);
      if (acts.length) bits.push(`${acts.length} action${acts.length === 1 ? '' : 's'}`);
      if (data.total_cost_usd) bits.push(`$${data.total_cost_usd.toFixed(2)}`);
      // The branch status rides on the newest turn's line, so it moves down as turns finish.
      if (acts.length) {
        const end = h('details', { class: 'turn-end' }, h('summary', {}, view.branchEl, bits.join(' · ')));
        end.addEventListener('toggle', () => {
          if (end.open && !end.querySelector('.phases')) end.append(...phaseRows(acts, false));
        });
        nodes.push(end);
      } else {
        nodes.push(h('div', { class: 'turn-end' }, view.branchEl, bits.join(' · ')));
      }
      if (data.is_error && data.result) nodes.push(h('div', { class: 'note error' }, data.result));
    }
  }

  log.append(...nodes);
  renderTyping();
  if (scroll && followChat) scrollToBottom();
}

/** An object URL for base64 image data (the page's CSP allows blob: images but not data: ones). */
function base64Url(mediaType, data) {
  return URL.createObjectURL(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mediaType }));
}

function userBubble(author, text, imageSrcs) {
  const msg = h('div', { class: 'msg user' }, h('div', { class: 'who' }, author));
  if (text) msg.append(markdown(text));
  if (imageSrcs.length) {
    msg.append(h('div', { class: 'images' }, imageSrcs.map((src) =>
      h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { src, alt: 'Attached image', loading: 'lazy' })))));
  }
  return msg;
}

/** "Claude is thinking…" under the chat while a turn runs, so a sent message is visibly being worked on. */
function renderTyping() {
  const el = view?.typingEl;
  if (!el || !view.ticket) return;
  const t = view.ticket;
  const show = t.status === 'running' || view.sendingTo === t.id;
  const wasHidden = el.hidden;
  el.hidden = !show;
  if (!show) return;
  const last = view.turnActions.at(-1);
  const busy = t.status === 'running' && last && !last.result;
  el.replaceChildren(
    h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
    h('span', {}, busy ? `Claude is working · ${actionLabel(last.block)}` : 'Claude is thinking…'),
    t.queued ? h('span', { class: 'muted' }, ` · ${t.queued} message${t.queued === 1 ? '' : 's'} queued for the next turn`) : '');
  if (wasHidden && followChat) scrollToBottom();
}

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
// Keep relative times in the usage readout honest.
setInterval(() => {
  if (usage) renderUsage();
}, 30_000);

api('/api/me').then((r) => start(r.name)).catch(() => {});
