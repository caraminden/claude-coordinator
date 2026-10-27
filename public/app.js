// Claude Coordinator front end: hash-routed views over the JSON API, live via SSE.
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
      const lines = block.split('\n');
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
      if (assetVersion && msg.version !== assetVersion) location.reload();
      assetVersion = msg.version;
    }
    if (msg.type === 'ticket') onTicketUpdate(msg.ticket);
    if (msg.type === 'event') onEvent(msg.event);
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
    const [{ coordinator, tickets }, { ticket }] = await Promise.all([
      api(`/api/projects/${view.projectId}`),
      api(`/api/tickets/${view.id}`),
    ]);
    view.coordinator = coordinator;
    view.tickets = new Map(tickets.map((t) => [t.id, t]));
    view.ticket = ticket;
    renderSidebar();
    renderTicketHead();
    await catchUpEvents();
  } catch {}
}

async function catchUpEvents() {
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
  const hash = location.hash || '#/';
  let m;
  try {
    if ((m = hash.match(/^#\/p\/(\d+)$/))) await showProject(Number(m[1]));
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
    h('label', {}, 'Name', h('input', { name: 'name', required: true, maxlength: 80 })),
    h('label', {}, 'Git repo URL (optional; each ticket gets its own worktree)',
      h('input', { name: 'repoUrl', placeholder: 'https://github.com/caraminden/gamedevtest.git' })),
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
  await showProject(ticket.project_id, ticketId);
}

/** A project page: its threads on the side, and a chat with the coordinator (or the chosen ticket). */
async function showProject(projectId, ticketId = null) {
  const { project, coordinator, tickets } = await api(`/api/projects/${projectId}`);
  const chatId = ticketId ?? coordinator.id;
  const [{ ticket }, events] = await Promise.all([
    api(`/api/tickets/${chatId}`),
    api(`/api/tickets/${chatId}/events`),
  ]);
  view = {
    kind: 'project', projectId, project, coordinator, tickets: new Map(tickets.map((t) => [t.id, t])),
    id: chatId, ticket, lastEventId: 0, tools: new Map(),
    stats: { messages: 0, turns: 0, cost: 0, lastAt: 0 },
  };
  crumbs.replaceChildren(h('a', { href: '#/' }, 'Projects'), ' / ',
    ...(ticketId ? [h('a', { href: `#/p/${project.id}` }, project.name), ' / ', `#${ticket.id}`] : [project.name]));

  const narrow = matchMedia('(max-width: 800px)').matches;
  const sidebar = h('details', { class: 'sidebar', open: !narrow },
    h('summary', {}, project.name, h('span', { class: 'muted', id: 'thread-count' })),
    newTicketForm(projectId),
    h('div', { id: 'threads' }));

  const textarea = h('textarea', {
    placeholder: isCoordinator(ticket)
      ? 'Ask the coordinator to start, check on, or close tickets… (Enter to send, Shift+Enter for a new line)'
      : 'Message this ticket… (Enter to send, Shift+Enter for a new line)',
  });
  const sendBtn = h('button', { type: 'submit' }, 'Send');
  const attachments = createAttachments();
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
    try {
      const images = attachments.items.map(({ mediaType, data }) => ({ mediaType, data }));
      const ticket = await api(`/api/tickets/${chatId}/messages`, { method: 'POST', body: { text, images } });
      textarea.value = '';
      attachments.clear();
      // Show the message now even if the live stream is down; duplicates are skipped by id.
      if (view?.kind === 'project' && view.id === chatId) {
        view.ticket = ticket;
        renderTicketHead();
        catchUpEvents().catch(() => {});
      }
    } catch (ex) {
      alertNote(ex.message);
    } finally {
      sendBtn.disabled = false;
    }
  });

  const log = h('div', { class: 'log', id: 'log' });
  if (isCoordinator(ticket) && !events.length) {
    log.append(h('div', { class: 'note' },
      'This is the project coordinator. It keeps track of the threads on the left and can create, message, rename and close them for you.'));
  }
  app.replaceChildren(h('div', { class: 'split' }, sidebar,
    h('section', { class: 'chat' }, h('div', { class: 'ticket-head', id: 'ticket-head' }), log, form)));
  renderSidebar();
  renderTicketHead();
  for (const ev of events) appendEvent(ev, false);
  window.scrollTo(0, document.body.scrollHeight);
  // Events broadcast while the snapshot was loading arrived before `view` existed.
  await catchUpEvents();
}

function newTicketForm(projectId) {
  const form = h('form', {},
    h('label', {}, 'Title', h('input', { name: 'title', required: true, maxlength: 120 })),
    h('label', {}, 'First message', h('textarea', { name: 'message', required: true, rows: 5, placeholder: 'What should this thread work on? (Enter to send, Shift+Enter for a new line)' })),
    h('label', {}, 'Permissions',
      h('select', { name: 'permissionMode' },
        h('option', { value: 'bypassPermissions' }, 'Full access: edit files and run any command'),
        h('option', { value: 'acceptEdits' }, 'Edit files only; shell commands are refused'),
        h('option', { value: 'plan' }, 'Plan only: read and plan, no changes'))),
    h('p', { class: 'error', hidden: true }),
    h('button', { type: 'submit' }, 'Start thread'));
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
    try {
      const t = await api(`/api/projects/${projectId}/tickets`, {
        method: 'POST',
        body: { title: form.title.value, message: form.message.value, permissionMode: form.permissionMode.value },
      });
      location.hash = `#/t/${t.id}`;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
  return h('details', { class: 'new' }, h('summary', {}, 'New thread'), form);
}

function renderSidebar() {
  const el = document.getElementById('threads');
  if (!el) return;
  const tickets = [...view.tickets.values()].sort((a, b) => b.updated_at - a.updated_at);
  const open = tickets.filter((t) => t.status !== 'closed').length;
  document.getElementById('thread-count').textContent = ` · ${open} open`;
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

// ---------- pasted images ----------

const MAX_IMAGES = 6;
const MAX_IMAGE_EDGE = 2000;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024; // base64 adds a third; the server caps decoded images at 5 MB
const SENDABLE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Pending images in the composer: thumbnails with a remove button, read as base64 for sending. */
function createAttachments() {
  const el = h('div', { class: 'attachments', hidden: true });
  const state = { el, items: [], busy: 0 };
  const render = () => {
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
  state.clear = () => {
    for (const item of state.items) URL.revokeObjectURL(item.url);
    state.items = [];
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
    h('div', { class: 'stats', id: 'ticket-stats' }));
  renderStats();
  const hint = document.getElementById('composer-hint');
  if (hint) hint.textContent = t.status === 'running' ? 'Messages sent now run after the current turn.' : '';
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

function toolSummary(block) {
  const i = block.input || {};
  if (block.name.startsWith('mcp__coordinator__')) {
    const arg = [i.ticket_id ? `#${i.ticket_id}` : '', i.title || i.text || ''].filter(Boolean).join(' ');
    return [h('b', {}, block.name.slice('mcp__coordinator__'.length).replace(/_/g, ' ')), ' ', arg.split('\n')[0].slice(0, 140)];
  }
  const arg = i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.description || i.prompt || '';
  return [h('b', {}, block.name), ' ', String(arg).split('\n')[0].slice(0, 140)];
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
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 200;
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
        } else if (block.type === 'tool_use') {
          const body = h('div', { class: 'body' }, h('pre', {}, JSON.stringify(block.input, null, 2)));
          const tool = h('details', { class: 'tool' }, h('summary', {}, toolSummary(block)), body);
          view.tools.set(block.id, { tool, body });
          nodes.push(tool);
        }
      }
    } else if (data.type === 'user') {
      for (const block of data.message?.content ?? []) {
        if (block.type !== 'tool_result') continue;
        const entry = view.tools.get(block.tool_use_id);
        const out = h('pre', {}, typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
        if (entry) {
          entry.body.append(h('div', { class: 'muted' }, block.is_error ? 'Error:' : 'Result:'), out);
          if (block.is_error) entry.tool.classList.add('err');
        } else {
          nodes.push(h('details', { class: 'tool' }, h('summary', {}, 'Tool result'), h('div', { class: 'body' }, out)));
        }
      }
    } else if (data.type === 'result') {
      const bits = [data.is_error ? 'Turn failed' : 'Turn finished'];
      if (data.duration_ms) bits.push(`${Math.round(data.duration_ms / 1000)}s`);
      if (data.num_turns) bits.push(`${data.num_turns} steps`);
      if (data.total_cost_usd) bits.push(`$${data.total_cost_usd.toFixed(2)}`);
      nodes.push(h('div', { class: 'turn-end' }, bits.join(' · ')));
      if (data.is_error && data.result) nodes.push(h('div', { class: 'note error' }, data.result));
    }
  }

  log.append(...nodes);
  if (scroll && nearBottom) window.scrollTo(0, document.body.scrollHeight);
}

// ---------- boot ----------

// Sticky elements sit just below the top bar, whose height changes with wrapping and safe areas.
const topbar = document.querySelector('.topbar');
// Use the exact height: at fractional display scaling (e.g. 175%) a rounded one leaves a sliver
// where scrolled chat text shows through.
new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${topbar.getBoundingClientRect().height}px`)).observe(topbar);
// Keep "last activity 3m ago" honest.
setInterval(() => view?.kind === 'project' && renderStats(), 30_000);

api('/api/me').then((r) => start(r.name)).catch(() => {});
