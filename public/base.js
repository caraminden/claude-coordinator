// The base every module needs: who is signed in and what is on screen, the API and DOM helpers,
// file, path and name helpers and the type and state tables. It touches no document at load and
// imports no view, so node tests can import it; the app shell (router, stream, login) is core.js.
import { iconSrc } from './schemes.js';

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
  complete: { emoji: '🏁', label: 'Complete: no work left' },
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

// Other modules read `view` live but can't assign it, so they replace it through this.
export function setView(next) {
  view = next;
}
/** Signing in or out: `who` as api/me gives it, or null. */
export function setAccount(who) {
  account = who;
  me = who?.name ?? null;
}
// The shell's login page (core.js renderLogin), shown when the server says you're signed out.
let showLogin = () => {};
export function setShowLogin(fn) {
  showLogin = fn;
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
    showLogin();
    throw new Error('Not logged in');
  }
  // Caddy's answer while nothing serves: a restart that outlasted systemd's socket, or a failed one (#493).
  if (!res.ok && !data.error && [502, 503, 504].includes(res.status)) throw new Error('%APP_NAME% is restarting, try again in a moment');
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

// ---------- files threads show ----------

// What the server will serve from a thread's folders, by extension (mirrors src/artifacts.ts).
const FILE_KINDS = {
  md: 'markdown', markdown: 'markdown', canvas: 'canvas', html: 'html', htm: 'html', pdf: 'pdf', txt: 'text', csv: 'text',
  js: 'text', mjs: 'text', css: 'text', json: 'text',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image',
  mp4: 'video', webm: 'video', mov: 'video', mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio',
  zip: 'download', '7z': 'download', tar: 'download', gz: 'download', tgz: 'download', apk: 'download',
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

/** Which side panels (artifacts shelf, threads list) are open on wide screens. */
export function loadPanelState() {
  try { return JSON.parse(localStorage.getItem('cc-panels')) ?? {}; } catch { return {}; }
}
export function savePanelState(state) {
  try { localStorage.setItem('cc-panels', JSON.stringify(state)); } catch {}
}

/** A thread you have opened since it last changed. */
export const isSeen = (t) => (view.seen?.[t.id] ?? 0) >= t.updated_at;

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
