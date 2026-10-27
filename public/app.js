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

function connectStream() {
  if (stream) return;
  stream = new EventSource('/api/stream');
  stream.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'ticket') onTicketUpdate(msg.ticket);
    if (msg.type === 'event') onEvent(msg.event);
  };
  stream.onerror = () => {
    // EventSource reconnects on its own; catch up on what was missed once it does.
    stream.onopen = resync;
  };
}

async function resync() {
  if (view?.kind !== 'ticket') return route();
  // Refresh in place so a half-typed message in the composer survives.
  try {
    const { ticket } = await api(`/api/tickets/${view.id}`);
    view.ticket = ticket;
    renderTicketHead();
    await catchUpEvents();
  } catch {}
}

async function catchUpEvents() {
  const events = await api(`/api/tickets/${view.id}/events?after=${view.lastEventId}`);
  for (const ev of events) if (ev.id > view.lastEventId) appendEvent(ev);
}

function onTicketUpdate(ticket) {
  if (view?.kind === 'board' && view.id === ticket.project_id) {
    view.tickets.set(ticket.id, ticket);
    renderBoard();
  } else if (view?.kind === 'ticket' && view.id === ticket.id) {
    view.ticket = ticket;
    renderTicketHead();
  }
}

function onEvent(event) {
  if (view?.kind !== 'ticket' || view.id !== event.ticket_id) return;
  if (event.id <= view.lastEventId) return;
  appendEvent(event);
}

// ---------- routing ----------

async function route() {
  if (!me) return;
  const hash = location.hash || '#/';
  let m;
  try {
    if ((m = hash.match(/^#\/p\/(\d+)$/))) await showBoard(Number(m[1]));
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

// ---------- board ----------

async function showBoard(projectId) {
  const { project, tickets } = await api(`/api/projects/${projectId}`);
  view = { kind: 'board', id: projectId, project, tickets: new Map(tickets.map((t) => [t.id, t])) };
  crumbs.replaceChildren(h('a', { href: '#/' }, 'Projects'), ' / ', project.name);

  const form = h('form', {},
    h('label', {}, 'Title', h('input', { name: 'title', required: true, maxlength: 120 })),
    h('label', {}, 'First message', h('textarea', { name: 'message', required: true, rows: 5, placeholder: 'What should this thread work on?' })),
    h('label', {}, 'Permissions',
      h('select', { name: 'permissionMode' },
        h('option', { value: 'acceptEdits' }, 'Edit files; ask before running commands (commands are refused for now)'),
        h('option', { value: 'bypassPermissions' }, 'Full access: edit files and run any command'),
        h('option', { value: 'plan' }, 'Plan only: read and plan, no changes'))),
    h('p', { class: 'error', hidden: true }),
    h('button', { type: 'submit' }, 'Start ticket'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    const err = form.querySelector('.error');
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

  app.replaceChildren(
    h('div', { class: 'row' }, h('h2', {}, project.name), h('span', { class: 'muted' }, project.repo_url || '')),
    h('details', { class: 'new', open: !tickets.length }, h('summary', {}, 'New ticket'), h('div', { class: 'card' }, form)),
    h('div', { class: 'board', id: 'board' }),
  );
  renderBoard();
}

function renderBoard() {
  const board = document.getElementById('board');
  if (!board) return;
  const tickets = [...view.tickets.values()].sort((a, b) => b.updated_at - a.updated_at);
  board.replaceChildren(...COLUMNS.map((col) => {
    const items = tickets.filter((t) => col.match(t.status));
    if (col.key === 'closed' && !items.length) return '';
    return h('section', { class: 'column' },
      h('h3', {}, h('span', { class: `dot ${col.key === 'waiting' ? 'idle' : col.key}` }), col.label, h('span', { class: 'count' }, items.length)),
      items.length ? items.map(ticketCard) : h('p', { class: 'muted' }, 'None'));
  }));
}

function ticketCard(t) {
  return h('a', { class: `card ticket-card s-${t.status}`, href: `#/t/${t.id}` },
    h('div', { class: 'title' }, `#${t.id} ${t.title}`),
    t.last_activity ? h('div', { class: 'activity' }, t.last_activity) : '',
    h('div', { class: 'meta' }, [
      STATUS_LABEL[t.status],
      t.queued ? `${t.queued} queued` : '',
      `by ${t.created_by}`,
      ago(t.updated_at),
    ].filter(Boolean).join(' · ')));
}

// ---------- ticket ----------

async function showTicket(ticketId) {
  const [{ ticket, project }, events] = await Promise.all([
    api(`/api/tickets/${ticketId}`),
    api(`/api/tickets/${ticketId}/events`),
  ]);
  view = { kind: 'ticket', id: ticketId, ticket, project, lastEventId: 0, tools: new Map() };
  crumbs.replaceChildren(
    h('a', { href: '#/' }, 'Projects'), ' / ',
    h('a', { href: `#/p/${project.id}` }, project.name), ' / ',
    `#${ticket.id}`);

  const textarea = h('textarea', { placeholder: 'Message this ticket… (Ctrl+Enter to send)' });
  const sendBtn = h('button', { type: 'submit' }, 'Send');
  const form = h('form', { class: 'composer' }, textarea,
    h('div', { class: 'row' }, h('span', { class: 'muted', id: 'composer-hint' }), h('span', { class: 'spacer' }), sendBtn));
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    try {
      await api(`/api/tickets/${ticketId}/messages`, { method: 'POST', body: { text } });
      textarea.value = '';
    } catch (ex) {
      alertNote(ex.message);
    } finally {
      sendBtn.disabled = false;
    }
  });

  app.replaceChildren(h('div', { class: 'ticket-head', id: 'ticket-head' }), h('div', { class: 'log', id: 'log' }), form);
  renderTicketHead();
  for (const ev of events) appendEvent(ev, false);
  window.scrollTo(0, document.body.scrollHeight);
  // Events broadcast while the snapshot was loading arrived before `view` existed.
  await catchUpEvents();
}

function alertNote(text) {
  document.getElementById('log')?.append(h('div', { class: 'note error' }, text));
}

function renderTicketHead() {
  const el = document.getElementById('ticket-head');
  if (!el) return;
  const t = view.ticket;
  const actions = [];
  if (t.status === 'running') {
    actions.push(h('button', { class: 'secondary', onclick: () => api(`/api/tickets/${t.id}/stop`, { method: 'POST', body: {} }).catch((e) => alertNote(e.message)) }, 'Stop'));
  } else if (t.status === 'closed') {
    actions.push(h('button', { class: 'secondary', onclick: () => setStatus(t.id, 'idle') }, 'Reopen'));
  } else {
    actions.push(h('button', { class: 'secondary', onclick: () => setStatus(t.id, 'closed') }, 'Close ticket'));
  }
  el.replaceChildren(
    h('div', { class: 'row' },
      h('span', { class: `dot ${t.status}` }),
      h('h2', {}, `#${t.id} ${t.title}`),
      h('span', { class: 'muted' }, STATUS_LABEL[t.status] + (t.queued ? ` · ${t.queued} queued` : '')),
      h('span', { class: 'spacer' }), ...actions),
    h('div', { class: 'meta' }, [
      t.branch ? `branch ${t.branch}` : null,
      `permissions: ${t.permission_mode}`,
      `started by ${t.created_by}`,
      t.cwd,
    ].filter(Boolean).join(' · ')));
  const hint = document.getElementById('composer-hint');
  if (hint) hint.textContent = t.status === 'running' ? 'Messages sent now run after the current turn.' : '';
}

async function setStatus(id, status) {
  try {
    await api(`/api/tickets/${id}/status`, { method: 'POST', body: { status } });
  } catch (e) {
    alertNote(e.message);
  }
}

function toolSummary(block) {
  const i = block.input || {};
  const arg = i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.description || i.prompt || '';
  return [h('b', {}, block.name), ' ', String(arg).split('\n')[0].slice(0, 140)];
}

function appendEvent(event, scroll = true) {
  view.lastEventId = Math.max(view.lastEventId, event.id);
  const log = document.getElementById('log');
  if (!log) return;
  const data = JSON.parse(event.data);
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 200;
  const nodes = [];

  if (event.kind === 'user_message') {
    const msg = h('div', { class: 'msg user' }, h('div', { class: 'who' }, data.author));
    msg.append(markdown(data.text));
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

api('/api/me').then((r) => start(r.name)).catch(() => {});
