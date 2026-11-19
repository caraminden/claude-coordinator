// The base every module needs: who is signed in and what is on screen, the API and DOM helpers,
// file, path and name helpers and the type and state tables. It touches no document at load and
// imports no view, so node tests can import it; the app shell (router, stream, login) is core.js.
import { iconSrc } from './schemes.js';

const STATUS_LABEL = { running: 'Running', idle: 'Waiting for you', new: 'Starting', error: 'Error', closed: 'Dismissed' };
// Thread naming and the threads list follow Delve's Custom view: threads are grouped by their `type`
// property, and each is one compact row of number + short ask, a state, and a terse note.
// In the list's order; `other` has no header word, as a minion of no particular kind.
export const TYPES = {
  feature: { label: 'Feature', section: 'Features' },
  bug: { label: 'Bug', section: 'Bugs' },
  design: { label: 'Design', section: 'Design' },
  art: { label: 'Art', section: 'Art' },
  research: { label: 'Research', section: 'Research' },
  chore: { label: 'Chore', section: 'Chores' },
  other: { section: 'Other' },
  ideation: { label: 'Idea', section: 'Ideas' },
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
  ready: { label: 'Ready to land or pick up' },
  complete: { label: 'Complete: no work left' },
  try: { label: 'Ready for you to try' },
  parked: { label: 'Parked' },
  blocked: { label: 'Blocked on something outside the minion' },
  outside: { label: 'Waiting on work running elsewhere' },
  'pending-deploy': { label: 'Deployed; dismissed once it is live' },
  limited: { label: 'Hit the usage limit; waiting for it to reset' },
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
  // The status rides on the error, so a caller can tell a restart from a refusal (bridge-host.js, #821).
  if (!res.ok && !data.error && [502, 503, 504].includes(res.status)) throw Object.assign(new Error('%APP_NAME% is restarting, try again in a moment'), { status: res.status });
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
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
 * Attributes for a search or filter box so no browser or password manager fills it (#934: a person's name
 * landed in Find in chat unasked). Chromium's address autofill and the managers ignore autocomplete=off, so the
 * token is one nothing recognises (a password field gets new-password, which stops a saved login being filled), the name is neutral, and each manager's own opt-out is set.
 */
export const noAutofill = (name, token = 'nope') => ({ autocomplete: token, name, 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other' });

/**
 * A scheme's favicon (#222), only ever as an <img> (an SVG there can't run scripts); hidden when it has
 * none, so refreshSchemeCounts can swap it in once a merge brings one.
 */
export function schemeIcon(p) {
  const src = iconSrc(p);
  const img = h('img', { class: 'scheme-icon', 'data-scheme-icon': p.id, src, alt: '', hidden: !src, onerror: () => { img.hidden = true; } });
  return img;
}

const ICONS = { back: 'M10.25 3.5 5.75 8l4.5 4.5', forward: 'M5.75 3.5 10.25 8l-4.5 4.5', close: 'M4 4l8 8M12 4l-8 8', pin: 'M5.5 2.5h5M6.5 2.5v4l-2 3h7l-2-3v-4M8 9.5V14', tag: 'M2.5 2.5h5l6 6-5 5-6-6zM5.25 5.25h.01',
  // Settings' side menu and rows (#995)
  shield: 'M8 1.8 13 3.6v4c0 3-2.2 5.4-5 6.6-2.8-1.2-5-3.6-5-6.6v-4zM5.8 8l1.5 1.5L10.4 6.4', plug: 'M6 1.8v3M10 1.8v3M4.2 4.8h7.6v2.6a3.8 3.8 0 0 1-7.6 0zM8 11.2v3', plugplus: 'M6 1.8v3M10 1.8v3M4.2 4.8h7.6v2a3.8 3.8 0 0 1-3.8 3.8M8 10.6v1M11.5 11v4M9.5 13h4', rows: 'M2.5 3.5h11M2.5 8h11M2.5 12.5h7', bell: 'M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3zM6.6 13.5a1.6 1.6 0 0 0 2.8 0', belloff: 'M4 11.5V7a4 4 0 0 1 6.5-3.1M12 7v4.5H5.5M6.6 13.5a1.6 1.6 0 0 0 2.8 0M2 2l12 12', eye: 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8zM6 8a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', doc: 'M4 1.8h5.2L12 4.6v9.6H4zM6 7.5h4M6 10h4', users: 'M3.7 5.5a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0 -4.6 0M1.8 13.5c.5-2.4 2.2-3.8 4.2-3.8s3.7 1.4 4.2 3.8M9.5 5.8a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0M11.2 9.7c1.6.1 2.6 1.3 3 3.3', user: 'M5.2 5.5a2.8 2.8 0 1 0 5.6 0a2.8 2.8 0 1 0 -5.6 0M2.8 14c.6-2.8 2.7-4.4 5.2-4.4s4.6 1.6 5.2 4.4', pen: 'M10.5 2.5 13.5 5.5 5.5 13.5H2.5V10.5z', monitor: 'M1.8 2.5h12.4v8.5h-12.4zM5.5 14h5M8 11v3', chart: 'M2.5 13.5h11M4.5 11V7.5M8 11V4M11.5 11V8.5', globe: 'M1.8 8a6.2 6.2 0 1 0 12.4 0a6.2 6.2 0 1 0 -12.4 0M1.8 8h12.4M8 1.8c1.8 2 2.6 4 2.6 6.2S9.8 12.2 8 14.2C6.2 12.2 5.4 10.2 5.4 8S6.2 3.8 8 1.8z', people: 'M3 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M9 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M1.5 12.5c.4-2 1.7-3.2 3.5-3.2S8 10.5 8.5 12.5M7.5 12.5c.4-2 1.7-3.2 3.5-3.2s3.1 1.2 3.5 3.2', box: 'M8 1.8 14 5v6L8 14.2 2 11V5zM2 5l6 3.2L14 5M8 8.2v6', key: 'M2 10.5a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M7.2 8.3l6-6M11 4.5l1.5 1.5', spark: 'M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2.1 2.1M10.5 10.5l2.1 2.1M3.4 12.6l2.1-2.1M10.5 5.5l2.1-2.1', branch: 'M2.9 3.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0M2.9 12.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0M9.9 5.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0M4.5 5.1v5.8M11.5 7.1c0 2.4-3 2.4-5.8 4', lock: 'M3 7h10v7h-10zM5.2 7V5a2.8 2.8 0 0 1 5.6 0v2', vault: 'M2 2.5h12v11h-12zM5.6 8a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0 -4.8 0M8 5.6V4.4M10.4 8h1.2', check: 'm3 8.5 3.2 3L13 4.5' };
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

/**
 * In the desktop app (#637) the window controls sit on the page's theme colour (index.html's metas), so a
 * contraption's top bar colours them (frames.js, with its computed background colour); null puts the plain colour back.
 * A canvas pixel turns any CSS colour into the hex a theme colour surely takes; a see-through one keeps the plain colour (#694).
 * `over`, a modal's backdrop (#772), is laid over the colour, so the controls dim with the page under it.
 */
let pixel = null;
export function tintTitleBar(color, over) {
  for (const m of document.querySelectorAll('meta[name=theme-color][media*=window-controls-overlay]')) {
    m.dataset.base ??= m.content;
    if (!color || !matchMedia(m.media).matches) { m.content = m.dataset.base; continue; }
    pixel ??= h('canvas', { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
    const fill = (c) => { pixel.fillStyle = 'transparent'; pixel.fillStyle = c; pixel.fillRect(0, 0, 1, 1); };
    pixel.clearRect(0, 0, 1, 1);
    fill(color);
    if (pixel.getImageData(0, 0, 1, 1).data[3] < 255) fill(m.dataset.base);
    if (over) fill(over);
    const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data;
    m.content = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }
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
  zip: 'download', '7z': 'download', tar: 'download', gz: 'download', tgz: 'download', apk: 'download', xpi: 'download', crx: 'download',
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
/** The full name: "12 FEATURE: Usage bar". No type or state emoji (Josh, 2026-11-13: "leftover from a bygone era"). */
export function threadFullName(t) {
  if (isCoordinator(t)) return taskmasterName(t.project_id);
  const type = TYPES[t.properties?.type];
  return `${t.number ?? t.id} ${type?.label ? `${type.label.toUpperCase()}: ${t.title}` : t.title}`;
}

/** threadFullName in parts; phones hide the type word for room (the properties chip has it). */
export function threadTitleParts(t) {
  if (isCoordinator(t)) return taskmasterLabel(t.project_id);
  const type = TYPES[t.properties?.type];
  return [`${t.number ?? t.id} `, type?.label ? h('span', { class: 'wide-only' }, `${type.label.toUpperCase()}: `) : '', t.title];
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
