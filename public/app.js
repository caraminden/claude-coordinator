// Claude Coordinator front end: hash-routed views over the JSON API, live via SSE.
import { actionLabel, applyEvent, createProgress, progressLine, stepInfo } from './progress.js';

const app = document.getElementById('app');
const crumbs = document.getElementById('crumbs');
const meEl = document.getElementById('me');
const progressEl = document.getElementById('progress');

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
  progressEl.hidden = true;
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
  progressEl.hidden = true;
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
  view = {
    kind: 'ticket', id: ticketId, ticket, project, lastEventId: 0,
    progress: createProgress(),
    actions: new Map(), // tool_use_id -> { block, taskId, result }
    turnActions: [], // actions of the current (or last) turn, in order
    progressOpen: false,
    openSteps: new Set(),
  };
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
  scheduleProgress();
}

async function setStatus(id, status) {
  try {
    await api(`/api/tickets/${id}/status`, { method: 'POST', body: { status } });
  } catch (e) {
    alertNote(e.message);
  }
}

// ---------- work progress (top-bar readout) ----------

const STEP_ICON = { completed: '✓', in_progress: '◐', pending: '○' };

/** A collapsed tool call; its input and output are only built when it is opened. */
function actionEl(action) {
  const { block, result } = action;
  const state = !result ? 'pending' : result.is_error ? 'err' : 'ok';
  const el = h('details', { class: `tool ${state}` },
    h('summary', {}, h('span', { class: 'st' }, state === 'pending' ? '…' : state === 'err' ? '✗' : '·'), ' ', actionLabel(block)));
  el.addEventListener('toggle', () => {
    if (!el.open || el.querySelector('.body')) return;
    const body = h('div', { class: 'body' }, h('pre', {}, JSON.stringify(block.input, null, 2)));
    if (action.result) {
      const out = typeof action.result.content === 'string' ? action.result.content : JSON.stringify(action.result.content);
      body.append(h('div', { class: 'muted' }, action.result.is_error ? 'Error:' : 'Result:'), h('pre', {}, out));
    }
    el.append(body);
  });
  return el;
}

function actionList(actions) {
  return h('div', { class: 'actions' }, actions.map(actionEl));
}

let progressFrame = 0;
function scheduleProgress() {
  if (!progressFrame) progressFrame = requestAnimationFrame(() => { progressFrame = 0; renderProgress(); });
}

function renderProgress() {
  if (view?.kind !== 'ticket') return;
  const p = view.progress;
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

  const bar = h('button', { class: 'progress-line', 'aria-expanded': String(view.progressOpen), onclick: () => {
    view.progressOpen = !view.progressOpen;
    renderProgress();
  } },
    h('span', { class: `dot ${running ? 'running' : view.ticket.status}` }),
    h('span', { class: 'text' }, text),
    count ? h('span', { class: 'count' }, count) : '',
    h('span', { class: 'chev' }, view.progressOpen ? '▴' : '▾'));
  const meter = total ? h('progress', { class: 'meter', max: total, value: done }) : '';

  const prevDetail = progressEl.querySelector('.progress-detail');
  const scrollTop = prevDetail?.scrollTop ?? 0;
  let detail = '';
  if (view.progressOpen) {
    const all = [...view.actions.values()];
    const steps = p.tasks.map((t) => {
      const acts = all.filter((a) => a.taskId === t.id);
      const isCurrent = t === current;
      const el = h('details', { class: `step ${t.status}`, open: view.openSteps.has(t.id) || null },
        h('summary', {},
          h('span', { class: 'icon' }, STEP_ICON[t.status] ?? '○'),
          h('span', { class: 'subject' }, t.subject),
          isCurrent && t.activeForm ? h('span', { class: 'muted' }, ` — ${t.activeForm}…`) : '',
          h('span', { class: 'muted n' }, acts.length ? `${acts.length} action${acts.length === 1 ? '' : 's'}` : t.status === 'pending' ? 'not started' : '')),
        acts.length ? actionList(acts) : h('p', { class: 'muted empty' }, 'No actions yet.'));
      el.addEventListener('toggle', () => (el.open ? view.openSteps.add(t.id) : view.openSteps.delete(t.id)));
      return el;
    });
    const loose = view.turnActions.filter((a) => a.taskId == null || !p.tasks.some((t) => t.id === a.taskId));
    const looseEl = loose.length
      ? h('details', { class: 'step loose', open: !p.tasks.length || view.openSteps.has('loose') || null },
          h('summary', {}, h('span', { class: 'icon' }, '⋯'),
            h('span', { class: 'subject' }, p.tasks.length ? 'Other actions this turn' : running ? 'Actions this turn' : 'Actions last turn'),
            h('span', { class: 'muted n' }, String(loose.length))),
          actionList(loose))
      : '';
    if (looseEl) looseEl.addEventListener('toggle', () => (looseEl.open ? view.openSteps.add('loose') : view.openSteps.delete('loose')));
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
  if (event.kind === 'claude' && data.type === 'system' && data.subtype === 'init') view.turnActions = [];
  for (const { block, taskId } of applyEvent(view.progress, event.kind, data)) {
    const action = { block, taskId, result: null };
    view.actions.set(block.id, action);
    view.turnActions.push(action);
  }
  if (event.kind === 'claude') scheduleProgress();
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
          if (end.open && !end.querySelector('.actions')) end.append(actionList(acts));
        });
        nodes.push(end);
      } else {
        nodes.push(h('div', { class: 'turn-end' }, bits.join(' · ')));
      }
      if (data.is_error && data.result) nodes.push(h('div', { class: 'note error' }, data.result));
    }
  }

  log.append(...nodes);
  if (scroll && nearBottom) window.scrollTo(0, document.body.scrollHeight);
}

// ---------- boot ----------

api('/api/me').then((r) => start(r.name)).catch(() => {});
