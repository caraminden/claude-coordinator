// Claude Coordinator front end: hash-routed views over the JSON API, live via SSE.
import { actionLabel, applyEvent, createProgress, progressLine, stepInfo, summarizeActions } from './progress.js';

const app = document.getElementById('app');
const crumbs = document.getElementById('crumbs');
const meEl = document.getElementById('me');

const STATUS_LABEL = { running: 'Running', idle: 'Waiting for you', new: 'Starting', error: 'Error', closed: 'Closed' };
const COLUMNS = [
  { key: 'waiting', label: 'Waiting for you', match: (s) => s === 'idle' || s === 'new' },
  { key: 'running', label: 'Running', match: (s) => s === 'running' },
  { key: 'error', label: 'Error', match: (s) => s === 'error' },
  { key: 'closed', label: 'Closed', match: (s) => s === 'closed' },
];

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

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Small, safe Markdown subset: code fences, inline code, bold, headings, lists, links, paragraphs. */
function markdown(src) {
  const out = [];
  const parts = src.split(/^```[^\n]*\n([\s\S]*?)^```\s*$/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre><code>${escapeHtml(part)}</code></pre>`);
      return;
    }
    for (const block of part.split(/\n{2,}/)) {
      if (!block.trim()) continue;
      const inline = (t) =>
        escapeHtml(t)
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
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

/** The weekly-limit bar in the top bar, fed by usage reports from Claude turns. */
function renderUsage(next = usage) {
  usage = next;
  const el = document.getElementById('usage');
  const week = usage?.weekly;
  el.hidden = !week;
  if (!week) return;
  const pct = Math.round(Math.min(1, Math.max(0, week.utilization)) * 100);
  el.querySelector('.label').textContent = `Week ${pct}%`;
  el.querySelector('.fill').style.width = `${pct}%`;
  el.dataset.level = week.status && week.status !== 'allowed' ? 'error' : pct >= 90 ? 'error' : pct >= 75 ? 'warn' : '';
  const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  el.title = [
    `Weekly usage of this Claude account: ${pct}%${week.resetsAt ? `, resets ${when(week.resetsAt)}` : ''}`,
    usage.session ? `5-hour window: ${Math.round(usage.session.utilization * 100)}%${usage.session.resetsAt ? `, resets ${when(usage.session.resetsAt)}` : ''}` : null,
    `As of the last turn, ${ago(usage.updatedAt)}`,
  ].filter(Boolean).join('\n');
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

async function showTicket(ticketId) {
  const { ticket } = await api(`/api/tickets/${ticketId}`);
  // The coordinator lives at the project's own address.
  if (isCoordinator(ticket)) return location.replace(`#/p/${ticket.project_id}`);
  await showProject(ticket.project_id, { kind: 'chat', ticketId });
}

async function showArtifact(artifactId) {
  const { artifact } = await api(`/api/artifacts/${artifactId}`);
  await showProject(artifact.project_id, { kind: 'artifact', artifact });
}

/**
 * A project page: artifacts and threads on the side, and in the main panel a chat with the
 * coordinator (or the chosen ticket), the artifact browser, or one artifact.
 */
async function showProject(projectId, main = { kind: 'chat', ticketId: null }) {
  const [{ project, coordinator, tickets }, artifacts] = await Promise.all([
    api(`/api/projects/${projectId}`),
    // An empty shelf beats a broken page if the server is older than this front end.
    api(`/api/projects/${projectId}/artifacts`).catch(() => []),
  ]);
  const chatId = main.kind === 'chat' ? main.ticketId ?? coordinator.id : null;
  const [{ ticket }, events] = chatId
    ? await Promise.all([api(`/api/tickets/${chatId}`), api(`/api/tickets/${chatId}/events`)])
    : [{ ticket: null }, []];
  view = {
    kind: 'project', main: main.kind, projectId, project, coordinator, tickets: new Map(tickets.map((t) => [t.id, t])),
    artifacts, artifactId: main.artifact?.id ?? null,
    id: chatId, ticket, lastEventId: 0,
    stats: { messages: 0, turns: 0, cost: 0, lastAt: 0 },
    progress: createProgress(),
    progressEl: h('div', { class: 'progress', hidden: true }), // lives in the thread bar
    ui: progressUi(chatId),
    actions: new Map(), // tool_use_id -> { block, taskId, result }
    turnActions: [], // actions of the current (or last) turn, in order
    typingEl: h('div', { class: 'typing', hidden: true, 'aria-live': 'polite' }), // below the chat log
    sendingTo: null, // ticket id while a message is on its way, before the server confirms the turn
  };
  const projectLink = h('a', { href: `#/p/${project.id}` }, project.name);
  const artifactsLink = h('a', { href: `#/p/${project.id}/artifacts` }, 'Artifacts');
  crumbs.replaceChildren(h('a', { href: '#/' }, 'Projects'), ' / ', ...(
    main.kind === 'artifacts' ? [projectLink, ' / ', 'Artifacts']
      : main.kind === 'artifact' ? [projectLink, ' / ', artifactsLink, ' / ', main.artifact.name]
        : main.ticketId ? [projectLink, ' / ', `#${ticket.id}`]
          : [project.name]));

  // On phones the side panels fold away above the main panel; on wider screens the thread list
  // is always open and its toggle is hidden by CSS.
  const narrowQuery = matchMedia('(max-width: 800px)');
  const shelf = h('details', { class: 'shelf', open: !narrowQuery.matches },
    h('summary', {}, 'Artifacts', h('span', { class: 'muted', id: 'artifact-count' })),
    h('div', { id: 'artifact-shelf' }));
  const sidebar = h('details', { class: 'sidebar', open: !narrowQuery.matches },
    h('summary', {}, 'Threads'),
    newTicketForm(projectId),
    h('div', { id: 'threads' }));
  // Don't hide a half-written new thread behind a collapsed sidebar on phones.
  if (sidebar.querySelector('details.new').open) sidebar.open = true;
  narrowQuery.onchange = () => {
    if (narrowQuery.matches) return;
    sidebar.open = true;
    shelf.open = true;
  };
  const section = main.kind === 'artifacts' ? artifactBrowser()
    : main.kind === 'artifact' ? artifactViewer(main.artifact)
      : chatSection(chatId, ticket, events);

  app.replaceChildren(h('div', { class: 'split' }, shelf, sidebar, section));
  renderShelf();
  renderSidebar();
  if (main.kind === 'artifacts') renderArtifactResults();
  if (main.kind === 'artifact') renderArtifactHead();
  if (!chatId) return window.scrollTo(0, 0);
  renderTicketHead();
  for (const ev of events) appendEvent(ev, false);
  restoreScroll(chatId);
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
      h('span', { class: 'muted', id: 'composer-hint' }), h('span', { class: 'spacer' }), sendBtn));
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
    // Acknowledge the message straight away; the server's reply and the stream catch up after.
    view.sendingTo = chatId;
    renderTyping();
    if (followChat) scrollToBottom();
    try {
      const sent = attachments.items.slice();
      const images = sent.map(({ mediaType, data }) => ({ mediaType, data }));
      const ticket = await api(`/api/tickets/${chatId}/messages`, { method: 'POST', body: { text, images } });
      // Keep anything typed or attached while the message was on its way.
      if (textarea.value.trim() === text) textarea.value = '';
      saveDraft(draftKey, textarea.value);
      attachments.remove(sent);
      // Show the message now even if the live stream is down; duplicates are skipped by id.
      if (view?.kind === 'project' && view.id === chatId) {
        // You just sent something, so follow the reply.
        scrollToBottom();
        view.ticket = ticket;
        renderTicketHead();
        catchUpEvents().catch(() => {});
      }
    } catch (ex) {
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
    h('label', {}, 'Title', h('input', { name: 'title', required: true, maxlength: 120, 'data-draft': true })),
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
  }
  const fields = () => ({ title: form.title.value, message: form.message.value, permissionMode: form.permissionMode.value });
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
      location.hash = `#/t/${t.id}`;
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
  const tickets = [...view.tickets.values()].sort((a, b) => b.updated_at - a.updated_at);
  el.replaceChildren(
    ticketCard(view.coordinator, `#/p/${view.projectId}`),
    ...COLUMNS.map((col) => {
      const items = tickets.filter((t) => col.match(t.status));
      if (!items.length) return '';
      const heading = [h('span', { class: `dot ${col.key === 'waiting' ? 'idle' : col.key}` }), col.label, h('span', { class: 'count' }, items.length)];
      if (col.key === 'closed') {
        // Closed threads stay out of the way but can still be opened and reopened.
        const closed = h('details', { class: 'column closed', open: view.showClosed }, h('summary', {}, heading), items.map((t) => ticketCard(t)));
        closed.addEventListener('toggle', () => { view.showClosed = closed.open; });
        return closed;
      }
      return h('section', { class: 'column' }, h('h3', {}, heading), items.map((t) => ticketCard(t)));
    }),
    tickets.length ? '' : h('p', { class: 'muted' }, 'No threads yet. Ask the coordinator to start one, or use New thread.'));
}

function ticketCard(t, href = `#/t/${t.id}`) {
  const coord = isCoordinator(t);
  return h('a', { class: `card ticket-card s-${t.status}${coord ? ' coordinator' : ''}${view.id === t.id ? ' active' : ''}`, href },
    h('div', { class: 'title' }, coord ? 'Coordinator' : `#${t.id} ${t.title}`),
    t.last_activity ? h('div', { class: 'activity' }, t.last_activity) : '',
    h('div', { class: 'meta' }, [
      statusLabel(t),
      t.queued ? `${t.queued} queued` : '',
      coord ? '' : `by ${t.created_by}`,
      ago(t.updated_at),
    ].filter(Boolean).join(' · ')));
}

// ---------- artifacts ----------

const RECENT_ARTIFACTS = 12;
const MAX_TEXT_PREVIEW = 2 * 1024 * 1024;
const ARTIFACT_FILTERS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'pinned', label: 'Pinned', match: (a) => !!a.pinned_at },
  { key: 'docs', label: 'Documents', match: (a) => ['markdown', 'text', 'pdf'].includes(a.kind) },
  { key: 'images', label: 'Images', match: (a) => a.kind === 'image' },
  { key: 'media', label: 'Video & audio', match: (a) => a.kind === 'video' || a.kind === 'audio' },
  { key: 'web', label: 'Web pages', match: (a) => a.kind === 'html' },
];

const rawUrl = (a) => `/api/artifacts/${a.id}/raw?v=${a.mtime}`;
const extOf = (a) => (a.name.includes('.') ? a.name.split('.').pop() : a.kind).slice(0, 5).toUpperCase();
const threadName = (a) => (a.ticket_kind === 'coordinator' ? 'Coordinator' : `#${a.ticket_id} ${a.ticket_title}`);

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
  document.getElementById('artifact-count').textContent = all.length ? ` · ${all.length}` : '';
  const item = (a) => h('a', { class: `artifact-item${view.artifactId === a.id ? ' active' : ''}${a.missing ? ' missing' : ''}`, href: `#/a/${a.id}`, title: a.path },
    h('span', { class: `badge k-${a.kind}` }, extOf(a)),
    h('span', { class: 'text' },
      h('span', { class: 'name' }, a.name),
      h('span', { class: 'meta' }, `${a.ticket_kind === 'coordinator' ? 'Coordinator' : `#${a.ticket_id}`} · ${a.missing ? 'missing' : ago(a.mtime)}`)));
  el.replaceChildren(
    h('a', { class: `view-all${view.main === 'artifacts' ? ' active' : ''}`, href: `#/p/${view.projectId}/artifacts` },
      'Browse all', all.length ? h('span', { class: 'count' }, all.length) : ''),
    h('section', { class: 'column' },
      h('h3', {}, 'Pinned', pinned.length ? h('span', { class: 'count' }, pinned.length) : ''),
      pinned.length ? pinned.map(item) : h('p', { class: 'muted small' }, 'Pin artifacts with ☆ to keep them here.')),
    h('section', { class: 'column' },
      h('h3', {}, 'Recent'),
      recent.length ? recent.map(item) : h('p', { class: 'muted small' }, 'Files threads create (docs, images, videos, pages…) show up here.')));
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
    const hay = `${a.path} ${threadName(a)} ${a.kind}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  document.getElementById('artifact-summary').textContent =
    `${results.length === view.artifacts.length ? '' : `${results.length} of `}${view.artifacts.length} file${view.artifacts.length === 1 ? '' : 's'}`;
  if (!results.length) {
    el.replaceChildren(h('p', { class: 'muted' }, view.artifacts.length
      ? 'Nothing matches.'
      : 'No artifacts yet. When threads create documents, images, videos or web pages in their folders, they appear here.'));
    return;
  }
  el.replaceChildren(...results.map((a) => {
    const dir = a.path.includes('/') ? a.path.slice(0, a.path.lastIndexOf('/') + 1) : '';
    return h('a', { class: `artifact-card${a.missing ? ' missing' : ''}`, href: `#/a/${a.id}`, title: a.path },
      h('div', { class: 'preview' }, a.kind === 'image' && !a.missing
        ? h('img', { src: rawUrl(a), alt: '', loading: 'lazy' })
        : h('span', { class: `badge big k-${a.kind}` }, extOf(a))),
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
  const src = rawUrl(a);
  if (a.missing) {
    body.append(h('p', { class: 'muted' }, 'This file is no longer in the thread\'s folder. Unpin it to remove it from the list.'));
  } else if (a.kind === 'image') {
    body.append(h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { class: 'artifact-media', src, alt: a.name })));
  } else if (a.kind === 'video') {
    body.append(h('video', { class: 'artifact-media', src, controls: true, preload: 'metadata' }));
  } else if (a.kind === 'audio') {
    body.append(h('audio', { src, controls: true, preload: 'metadata' }));
  } else if (a.kind === 'html') {
    // Sandboxed (here and by the server's CSP) so a page a thread wrote can't act as the app.
    body.append(h('iframe', { class: 'artifact-frame', src, sandbox: 'allow-scripts allow-popups allow-forms allow-modals', title: a.name }));
  } else if (a.kind === 'pdf') {
    body.append(h('iframe', { class: 'artifact-frame', src, title: a.name }));
  } else if (a.size > MAX_TEXT_PREVIEW) {
    body.append(h('p', { class: 'muted' }, `Too large to preview (${formatSize(a.size)}). Open or download it instead.`));
  } else {
    body.append(h('p', { class: 'muted' }, 'Loading…'));
    fetch(src).then(async (res) => {
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const text = await res.text();
      // Images a document links to by relative path load from next to it, in the thread's folder.
      const imageUrl = (href) => (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href) || href.startsWith('/')
        ? null
        : `/api/artifacts/${a.id}/rel?path=${encodeURIComponent(href.split('#')[0])}&v=${a.mtime}`);
      body.replaceChildren(a.kind === 'markdown'
        ? h('div', { class: 'msg doc' }, markdownDoc(text, imageUrl))
        : h('pre', { class: 'artifact-text' }, text));
    }).catch((err) => body.replaceChildren(h('p', { class: 'error' }, `Could not load: ${err.message}`)));
  }
  return section;
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
      a.path, ' · from ',
      h('a', { href: a.ticket_kind === 'coordinator' ? `#/p/${a.project_id}` : `#/t/${a.ticket_id}` }, threadName(a)),
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
    const restored = saved.map(({ mediaType, data }) => ({ url: `data:${mediaType};base64,${data}`, mediaType, data }));
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

function renderTicketHead() {
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
      h('h2', {}, coord ? 'Coordinator' : `#${t.id} ${t.title}`),
      h('span', { class: 'muted' }, statusLabel(t) + (t.queued ? ` · ${t.queued} queued` : '')),
      h('span', { class: 'spacer' }), ...actions),
    h('div', { class: 'meta', title: coord ? '' : t.cwd }, (coord
      ? ["Manages this project's threads"]
      : [t.branch ? `branch ${t.branch}` : null, `permissions: ${t.permission_mode}`, `started by ${t.created_by}`]
    ).filter(Boolean).join(' · ')),
    h('div', { class: 'stats', id: 'ticket-stats' }),
    view.progressEl);
  renderStats();
  renderTyping();
  const hint = document.getElementById('composer-hint');
  if (hint) hint.textContent = t.status === 'running' ? 'Messages sent now run after the current turn.' : '';
  scheduleProgress();
}

/** The summary line in the thread bar, tallied from the events shown in the log. */
function renderStats() {
  const el = document.getElementById('ticket-stats');
  if (!el) return;
  const s = view.stats;
  el.replaceChildren(...[
    `${s.messages} message${s.messages === 1 ? '' : 's'}`,
    `${s.turns} turn${s.turns === 1 ? '' : 's'}`,
    s.cost ? `$${s.cost.toFixed(2)} spent` : null,
    s.lastAt ? `last activity ${ago(s.lastAt)}` : null,
  ].filter(Boolean).map((text) => h('span', {}, text)));
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
    const steps = p.tasks.map((t) => {
      const acts = all.filter((a) => a.taskId === t.id);
      const isCurrent = t === current;
      const recap = summarizeActions(acts) || (t.status === 'pending' ? 'Not started yet' : 'Nothing done yet');
      const el = h('details', { class: `step ${t.status}${isCurrent && !running ? ' paused' : ''}`, open: view.ui.openSteps.has(t.id) || null },
        h('summary', {},
          h('span', { class: 'icon' }, STEP_ICON[t.status] ?? '○'),
          h('span', { class: 'subject' }, t.subject),
          isCurrent ? h('span', { class: 'muted' }, running ? (t.activeForm ? ` — ${t.activeForm}…` : '') : ' — paused') : '',
          acts.length ? h('span', { class: 'muted n' }, `${acts.length} action${acts.length === 1 ? '' : 's'}`) : '',
          h('span', { class: 'recap' }, recap)),
        t.note ? stepNote(t.note) : '',
        acts.length ? actionList(acts) : '');
      el.addEventListener('toggle', () => (el.open ? view.ui.openSteps.add(t.id) : view.ui.openSteps.delete(t.id)));
      return el;
    });
    const loose = view.turnActions.filter((a) => a.taskId == null || !p.tasks.some((t) => t.id === a.taskId));
    const looseEl = loose.length
      ? h('details', { class: 'step loose', open: (view.ui.looseOpen ?? !p.tasks.length) || null },
          h('summary', {}, h('span', { class: 'icon' }, '⋯'),
            h('span', { class: 'subject' }, p.tasks.length ? 'Other work this turn' : running ? 'Work this turn' : 'Work last turn'),
            h('span', { class: 'muted n' }, `${loose.length} action${loose.length === 1 ? '' : 's'}`),
            h('span', { class: 'recap' }, summarizeActions(loose))),
          actionList(loose))
      : '';
    if (looseEl) looseEl.addEventListener('toggle', () => (view.ui.looseOpen = looseEl.open));
    detail = h('div', { class: 'progress-detail' },
      steps.length ? h('div', { class: 'steps' }, steps) : '',
      looseEl,
      !steps.length && !looseEl ? h('p', { class: 'muted empty' }, 'Nothing has run yet.') : '');
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
  const stats = view.stats;
  stats.lastAt = Math.max(stats.lastAt, event.created_at);
  if (event.kind === 'user_message') stats.messages++;
  if (event.kind === 'claude' && data.type === 'result') {
    stats.turns++;
    stats.cost += data.total_cost_usd || 0;
  }
  renderStats();
  if (event.kind === 'claude' && data.type === 'system' && data.subtype === 'init') view.turnActions = [];
  for (const { block, taskId } of applyEvent(view.progress, event.kind, data)) {
    const action = { block, taskId, result: null };
    view.actions.set(block.id, action);
    view.turnActions.push(action);
  }
  if (event.kind === 'claude') scheduleProgress();
  const nodes = [];

  if (event.kind === 'user_message') {
    const msg = h('div', { class: 'msg user' }, h('div', { class: 'who' }, data.author));
    if (data.text) msg.append(markdown(data.text));
    if (data.images?.length) {
      msg.append(h('div', { class: 'images' }, data.images.map((name) => {
        const src = `/api/tickets/${event.ticket_id}/images/${encodeURIComponent(name)}`;
        return h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { src, alt: 'Attached image', loading: 'lazy' }));
      })));
    }
    nodes.push(msg);
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
          msg.append(markdown(block.text));
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
      if (acts.length) {
        const end = h('details', { class: 'turn-end' }, h('summary', {}, bits.join(' · ')));
        end.addEventListener('toggle', () => {
          if (end.open && !end.querySelector('.actions')) end.append(h('p', { class: 'recap' }, summarizeActions(acts)), actionList(acts));
        });
        nodes.push(end);
      } else {
        nodes.push(h('div', { class: 'turn-end' }, bits.join(' · ')));
      }
      if (data.is_error && data.result) nodes.push(h('div', { class: 'note error' }, data.result));
    }
  }

  log.append(...nodes);
  renderTyping();
  if (scroll && followChat) scrollToBottom();
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
const topbar = document.querySelector('.topbar');
// Use the exact height: at fractional display scaling (e.g. 175%) a rounded one leaves a sliver
// where scrolled chat text shows through.
new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${topbar.getBoundingClientRect().height}px`)).observe(topbar);
// Keep "last activity 3m ago" honest.
setInterval(() => {
  if (view?.kind === 'project') renderStats();
  if (usage) renderUsage();
}, 30_000);

api('/api/me').then((r) => start(r.name)).catch(() => {});
