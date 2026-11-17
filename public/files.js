// The Files view (#676): a scheme's shared folder and the files its minions linked, in one place. Folders down the
// left, the newest of each folder as sections on All, a list with search and kind filters, a preview on the right,
// and an upload into the shared folder. Cara, 2026-11-14, picking from the takes: "Can we combine A and B? I like the
// upload option and folder sorting from B, but everything else from A looks nicer" and "One Files view".
import { ago, fileExt, fileKind, formatSize, h, sharedHref, sharedUrl, threadLabel, view } from './base.js';
import { pinButton, previewBody } from './artifacts.js';
import { optimistic } from './ui/optimistic.js';
import { toast } from './ui/status.js';
import { startUpload } from './ui/upload.js';

/** Folders the README names, in its order; the rest follow by name, then the top level. */
const ORDER = ['inbox', 'handoffs', 'reports', 'specs', 'mockups'];
/** Folders tooling writes (the retro log, rule drafts): kept out of All and its sections, still a folder of their own. */
const TOOLING = new Set(['retro-log', 'rule-drafts']);
const TOP = '';
// What the server lists (sharedListable in src/artifacts.ts): any known kind in inbox/, else no code or data.
const listed = (path) => (path.startsWith('inbox/') ? !!fileKind(path) : !!fileKind(path) && fileKind(path) !== 'text');
const MINIONS = '@minions';
const SECTION = 5; // files each folder shows on All
const PAGE = 200; // rows a folder or search draws before "Show more"
const KINDS = [
  ['all', 'All kinds', () => true],
  ['docs', 'Docs', (k) => k === 'markdown' || k === 'pdf' || k === 'canvas' || k === 'text'],
  ['pages', 'Pages', (k) => k === 'html'],
  ['images', 'Images', (k) => k === 'image'],
  ['media', 'Video and sound', (k) => k === 'video' || k === 'audio'],
  ['downloads', 'Downloads', (k) => k === 'download'],
];

// What the view shows, kept while the scheme stays open: the folder, search, kind, the file previewed, and
// uploads on their way. A different scheme starts afresh.
let st = null;
const state = () => (st?.projectId === view.projectId ? st : (st = { projectId: view.projectId, sel: 'all', q: '', kind: 'all', open: null, limit: PAGE, pending: [], staged: null }));

/** Whether a file is still uploading here; a reload now would lose it. */
export const filesUploading = () => !!st?.pending.some((p) => !p.failed);

const label = (folder) => (folder === MINIONS ? 'Linked by minions' : folder === TOP ? 'Top level' : folder === 'all' ? 'All' : folder === 'pinned' ? 'Pinned' : ORDER.includes(folder) ? folder[0].toUpperCase() + folder.slice(1) : folder);
const folderOf = (path) => (path.includes('/') ? path.slice(0, path.indexOf('/')) : TOP);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');

/** Every file the view lists, newest first: the shared folder's, the minions' artifacts, and uploads on their way. */
function items() {
  const s = state();
  const shared = (view.shared ?? []).map((f) => ({ key: `s:${f.path}`, folder: folderOf(f.path), where: dirOf(f.path) || 'top level', href: sharedHref(view.projectId, f.path), src: `${sharedUrl(view.projectId, f.path)}&v=${f.mtime}`, file: f, ...pick(f) }));
  const linked = (view.artifacts ?? []).map((a) => ({ key: `a:${a.id}`, folder: MINIONS, where: threadLabel({ id: a.ticket_id, kind: a.ticket_kind, project_id: a.project_id, number: a.ticket_number, title: a.ticket_title }), href: `#/a/${a.id}`, src: `api/artifacts/${a.id}/raw?v=${a.mtime}`, file: a, ...pick(a) }));
  const pending = s.pending.map((p) => ({ key: `u:${p.path}`, folder: folderOf(p.path), where: dirOf(p.path) || 'top level', pending: p, name: p.file.name, kind: fileKind(p.file.name) ?? 'text', size: p.file.size, mtime: p.at, path: p.path }));
  return [...pending, ...[...shared, ...linked].sort((a, b) => b.mtime - a.mtime)];
}
/** Files whose body 404ed in the preview: their Open and Download stay off (#882). */
const goneKeys = new Set();
const pick = (f) => ({ name: f.name, kind: f.kind, size: f.size, mtime: f.mtime, path: f.path, missing: !!f.missing, pinned: !!f.pinned_at });

/** The folders, in the README's order, with their counts. */
function folders(all) {
  const n = new Map();
  for (const it of all) n.set(it.folder, (n.get(it.folder) ?? 0) + 1);
  const named = [...n.keys()].filter((f) => f !== TOP && f !== MINIONS && !TOOLING.has(f));
  const shared = [...ORDER.filter((f) => n.has(f)), ...named.filter((f) => !ORDER.includes(f)).sort(), ...(n.has(TOP) ? [TOP] : [])];
  return { n, shared, minions: n.has(MINIONS), tooling: [...TOOLING].filter((f) => n.has(f)) };
}

/** Where an upload goes by default: the shared folder you're in, else inbox/. */
const uploadFolder = () => {
  const { sel } = state();
  return sel === 'all' || sel === 'pinned' || sel === MINIONS ? 'inbox' : sel;
};

export function filesView(folder) {
  const s = state();
  if (folder) Object.assign(s, { sel: folder, q: '', open: null, limit: PAGE });
  const picker = h('input', { type: 'file', multiple: true, hidden: true, id: 'files-picker' });
  picker.addEventListener('change', () => {
    stage([...picker.files]);
    picker.value = '';
  });
  // The section is the size container; the grid inside it picks rail, chips and preview by the room it gets.
  const section = h('section', { class: 'files-view', id: 'files-view' }, picker, h('div', { class: 'files-grid' },
    h('nav', { class: 'files-rail', id: 'files-rail', 'aria-label': 'Folders' }),
    h('div', { class: 'files-main' },
      h('div', { class: 'files-head', id: 'files-head' }),
      h('div', { class: 'files-chips', id: 'files-chips' }),
      h('div', { class: 'files-tools' },
        searchBox(),
        h('div', { class: 'chips', id: 'files-kinds' })),
      h('div', { id: 'files-stage' }),
      h('div', { class: 'files-list', id: 'files-list' })),
    h('aside', { class: 'files-preview', id: 'files-preview' })));
  // Files dropped anywhere on the view go into the upload panel.
  let depth = 0;
  const dragging = (e) => e.dataTransfer?.types?.includes('Files');
  section.addEventListener('dragenter', (e) => {
    if (!dragging(e)) return;
    depth++;
    section.classList.add('dropping');
  });
  section.addEventListener('dragleave', () => {
    if (--depth <= 0) depth = 0, section.classList.remove('dropping');
  });
  section.addEventListener('dragover', (e) => dragging(e) && e.preventDefault());
  section.addEventListener('drop', (e) => {
    if (!dragging(e)) return;
    e.preventDefault();
    depth = 0;
    section.classList.remove('dropping');
    stage([...e.dataTransfer.files]);
  });
  return section;
}

function searchBox() {
  const input = h('input', { type: 'search', id: 'files-search', placeholder: 'Search names, folders and minions…', 'aria-label': 'Search files', autocomplete: 'off', value: state().q });
  input.addEventListener('input', () => {
    Object.assign(state(), { q: input.value, limit: PAGE });
    renderFiles();
  });
  return input;
}

/** Draw the view from view.shared and view.artifacts; called again whenever either changes. */
export function renderFiles() {
  const el = document.getElementById('files-view');
  if (!el) return;
  const s = state();
  const all = items();
  const f = folders(all);
  if (s.sel !== 'all' && s.sel !== 'pinned' && !f.n.has(s.sel)) s.sel = 'all'; // its last file went, or its upload failed
  const terms = s.q.toLowerCase().split(/\s+/).filter(Boolean);
  const inScope = (it) => (terms.length
    ? (!TOOLING.has(it.folder) || s.sel === it.folder) && terms.every((t) => `${it.path} ${it.where}`.toLowerCase().includes(t))
    : s.sel === 'all' ? !TOOLING.has(it.folder) : s.sel === 'pinned' ? it.pinned : it.folder === s.sel);
  const scoped = all.filter(inScope);
  const kind = KINDS.find(([k]) => k === s.kind) ?? KINDS[0];
  const shown = scoped.filter((it) => kind[2](it.kind));
  const pinned = all.filter((it) => it.pinned).length;

  // The rail on a wide screen, the same folders as chips on a narrow one.
  const railButton = (key, n) => h('button', { type: 'button', 'aria-pressed': String(s.sel === key && !terms.length), onclick: () => choose(key) },
    h('span', { class: 'name' }, label(key)), h('span', { class: 'count' }, n));
  const total = all.filter((it) => !TOOLING.has(it.folder)).length;
  document.getElementById('files-rail').replaceChildren(
    railButton('all', total),
    pinned ? railButton('pinned', pinned) : '',
    f.shared.length ? h('h5', {}, 'Shared folder') : '',
    ...f.shared.map((k) => railButton(k, f.n.get(k))),
    f.minions ? h('h5', {}, 'Minions') : '',
    f.minions ? railButton(MINIONS, f.n.get(MINIONS)) : '',
    f.tooling.length ? h('h5', {}, 'Tooling') : '',
    ...f.tooling.map((k) => railButton(k, f.n.get(k))));
  document.getElementById('files-chips').replaceChildren(...['all', ...(pinned ? ['pinned'] : []), ...f.shared, ...(f.minions ? [MINIONS] : []), ...f.tooling].map((k) =>
    h('button', { type: 'button', class: `chip${s.sel === k && !terms.length ? ' on' : ''}`, onclick: () => choose(k) }, label(k), h('span', { class: 'count' }, k === 'all' ? total : k === 'pinned' ? pinned : f.n.get(k)))));

  const title = terms.length ? 'Search' : label(s.sel);
  document.getElementById('files-head').replaceChildren(
    h('h2', {}, title), h('span', { class: 'muted' }, String(shown.length)), h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'upload', onclick: () => document.getElementById('files-picker').click() }, 'Upload'));
  document.getElementById('files-kinds').replaceChildren(...KINDS.map(([k, name, match]) => {
    const n = scoped.filter((it) => match(it.kind)).length;
    if (!n && k !== 'all' && k !== s.kind) return '';
    return h('button', { type: 'button', class: `chip${k === s.kind ? ' on' : ''}`, onclick: () => {
      Object.assign(state(), { kind: k, limit: PAGE });
      renderFiles();
    } }, name, h('span', { class: 'count' }, n));
  }));
  renderStage();

  const list = document.getElementById('files-list');
  const drop = () => h('button', { type: 'button', class: 'files-drop', onclick: () => document.getElementById('files-picker').click() },
    'Drop files here or ', h('u', {}, 'choose files'), ' · they go to ', h('b', {}, `${uploadFolder()}/`), ', or a folder you pick');
  if (!terms.length && s.sel === 'all') {
    // All: the newest few of each folder, as sections, each opening its folder.
    const section = (key, rows) => {
      const of = rows.filter((it) => kind[2](it.kind));
      if (!of.length && key !== 'inbox') return '';
      return h('section', { class: 'files-section' },
        h('header', {}, h('b', {}, label(key)), h('span', { class: 'count' }, of.length), h('span', { class: 'spacer' }),
          of.length > SECTION ? h('button', { type: 'button', class: 'link', onclick: () => choose(key) }, `All ${of.length} →`) : ''),
        key === 'inbox' ? drop() : '',
        ...of.slice(0, SECTION).map((it) => row(it, key !== TOP && it.where.split('/').length > 2)));
    };
    const byFolder = (k) => all.filter((it) => it.folder === k);
    const sections = [
      pinned ? section('pinned', all.filter((it) => it.pinned)) : '',
      ...['inbox', ...f.shared.filter((k) => k !== 'inbox')].map((k) => section(k, byFolder(k))),
      f.minions ? section(MINIONS, byFolder(MINIONS)) : '',
    ];
    list.replaceChildren(...sections);
  } else {
    const rows = shown.slice(0, s.limit).map((it) => row(it, true));
    list.replaceChildren(
      s.sel !== MINIONS && !terms.length ? drop() : '',
      ...(rows.length ? rows : [h('p', { class: 'muted' }, terms.length ? 'Nothing matches.' : 'Nothing here yet.')]),
      shown.length > s.limit ? h('button', { type: 'button', class: 'secondary more', onclick: () => {
        state().limit += PAGE;
        renderFiles();
      } }, `Show ${Math.min(PAGE, shown.length - s.limit)} more of ${shown.length - s.limit}`) : '');
  }
  renderPreview(all);
}

function choose(key) {
  Object.assign(state(), { sel: key, q: '', limit: PAGE });
  const search = document.getElementById('files-search');
  if (search) search.value = '';
  renderFiles();
  document.getElementById('files-list')?.scrollTo(0, 0);
}

/** One file: its badge (or the picture itself), name, where it is, when, size and pin. */
function row(it, where) {
  const s = state();
  const thumb = it.kind === 'image' && !it.pending && !it.missing
    ? h('span', { class: 'badge thumb' }, h('img', { src: it.src, alt: '', loading: 'lazy' }))
    : h('span', { class: `badge k-${it.kind}` }, fileExt(it.name));
  const when = it.pending ? (it.pending.failed ? 'failed' : `${Math.round(it.pending.progress * 100)}%`) : it.missing ? 'missing' : ago(it.mtime);
  const a = h(it.href ? 'a' : 'div', {
    class: `artifact-item files-row${s.open === it.key ? ' active' : ''}${it.missing ? ' missing' : ''}${it.pending ? ' pending' : ''}`,
    href: it.href, title: it.path, 'data-key': it.key,
  },
    thumb,
    h('span', { class: 'text' }, h('span', { class: 'name' }, it.name), where ? h('span', { class: 'meta' }, it.where) : ''),
    h('span', { class: 'when' }, when, h('br'), formatSize(it.size)),
    it.file ? pinButton(it.file) : h('span', { class: 'pin-space' }));
  if (it.href) a.addEventListener('click', (e) => {
    // With room for the preview, a plain click shows it there; otherwise the link opens the full viewer.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (getComputedStyle(document.getElementById('files-preview')).display === 'none') return;
    e.preventDefault();
    s.open = it.key;
    renderFiles();
  });
  return a;
}

function renderPreview(all) {
  const el = document.getElementById('files-preview');
  const s = state();
  const it = s.open && all.find((x) => x.key === s.open);
  if (!it?.file) {
    if (el.dataset.key !== '') el.replaceChildren(h('p', { class: 'muted empty' }, 'Pick a file to preview it here.'));
    el.dataset.key = '';
    return;
  }
  // Redrawn only when another file (or a newer copy of it) is picked, so a page in its frame keeps its place.
  const id = `${it.key}@${it.mtime}`;
  const head = h('div', { class: 'files-preview-head' },
    h('h3', {}, it.name),
    h('div', { class: 'meta' }, `${it.where} · ${formatSize(it.size)} · ${ago(it.mtime)}`),
    h('div', { class: 'row' },
      goneKeys.has(it.key) ? '' : h('a', { class: 'button secondary', href: it.href }, 'Open'),
      goneKeys.has(it.key) ? '' : h('a', { class: 'button secondary', href: `${it.src}&download` }, 'Download'),
      h('span', { class: 'spacer' }),
      pinButton(it.file)));
  if (el.dataset.key === id) return el.firstChild.replaceWith(head);
  el.dataset.key = id;
  el.replaceChildren(head, previewBody(it.file, it.src, () => {
    goneKeys.add(it.key);
    const now = el.querySelector('.files-preview-head .row');
    now?.querySelectorAll('a.button').forEach((a) => a.remove());
  }));
}

// ---------- upload ----------

/** Files picked or dropped wait in a panel naming where they'll go, until Upload. */
function stage(files) {
  if (!files.length) return;
  const s = state();
  s.staged = { files: [...(s.staged?.files ?? []), ...files], folder: s.staged?.folder ?? uploadFolder() };
  renderStage();
}

function renderStage() {
  const el = document.getElementById('files-stage');
  if (!el) return;
  const s = state();
  if (!s.staged) return el.replaceChildren();
  const { files } = s.staged;
  const known = folders(items()).shared.filter((k) => k !== TOP);
  const input = h('input', { type: 'text', list: 'files-folders', value: s.staged.folder, 'aria-label': 'Folder', spellcheck: 'false', autocomplete: 'off' });
  input.addEventListener('input', () => (s.staged.folder = input.value));
  const go = () => {
    const folder = input.value.trim().replace(/^\/+|\/+$/g, '');
    s.staged = null;
    // Show the folder they're going to, so the new rows are in sight.
    Object.assign(s, { sel: folder.split('/')[0] || TOP, q: '', kind: 'all', limit: PAGE });
    const search = document.getElementById('files-search');
    if (search) search.value = '';
    renderStage();
    for (const file of files) upload(file, folder);
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  el.replaceChildren(h('div', { class: 'files-stage' },
    h('b', {}, `Upload ${files.length} file${files.length === 1 ? '' : 's'}`),
    h('ul', {}, ...files.map((f) => h('li', {}, h('span', { class: 'name' }, f.name), h('span', { class: 'muted' }, formatSize(f.size))))),
    h('label', {}, 'To the shared folder\'s', input, '/'),
    h('datalist', { id: 'files-folders' }, ...known.map((k) => h('option', { value: k }))),
    h('p', { class: 'muted small' }, 'Kept byte for byte, never recompressed, any size: a big file goes in pieces and picks up where it left off if the connection drops. A name already there gets a number, so nothing is overwritten.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: go }, 'Upload'),
      h('button', { type: 'button', class: 'secondary', onclick: () => {
        s.staged = null;
        renderStage();
      } }, 'Cancel'))));
}

/** One file, shown in its folder at once with its progress; a failure takes it back out, with a toast and Retry. */
function upload(file, folder) {
  const s = state();
  const projectId = view.projectId;
  const p = { file, path: `${folder ? `${folder}/` : ''}${file.name}`, at: Date.now(), progress: 0 };
  optimistic({
    label: `upload ${file.name}`,
    apply: () => {
      p.progress = 0;
      s.pending.unshift(p);
      redraw();
    },
    send: () => put(projectId, folder, file, (progress) => {
      p.progress = progress;
      const when = document.querySelector(`.files-row[data-key="u:${CSS.escape(p.path)}"] .when`);
      if (when) when.firstChild.textContent = `${Math.round(progress * 100)}%`;
    }),
    undo: () => {
      s.pending = s.pending.filter((x) => x !== p);
      redraw();
    },
  }).then((saved) => {
    s.pending = s.pending.filter((x) => x !== p);
    if (!listed(saved.path)) toast(`Uploaded ${saved.path}. Minions can read it, but this view lists only docs, pages, pictures, clips, sound and archives outside inbox/.`, { ms: 10000 });
    // Listed now, as the server will list it; the shared folder's next scan brings the same row.
    else if (view.projectId === projectId && !view.shared?.some((f) => f.path === saved.path)) {
      view.shared = [{ path: saved.path, name: saved.name, kind: fileKind(saved.name) ?? 'text', display_path: `scheme shared/${saved.path}`, size: saved.size, mtime: saved.mtime, pinned_at: null, pinned_by: null, missing: 0 }, ...(view.shared ?? [])];
    }
    redraw();
  }, () => {});
  function redraw() {
    if (view.projectId === projectId) renderFiles();
  }
}

/** Send it in chunks (ui/upload.js); a stop after its own retries fails the action, and Retry carries on from the server's offset. */
function put(projectId, folder, file, onProgress) {
  return new Promise((resolve, reject) => {
    const up = startUpload(`api/projects/${projectId}/shared/uploads`, file, { folder, onChange: (u) => {
      if (u.size) onProgress(u.sent / u.size);
      if (u.state === 'paused') reject(new Error(u.error || 'the upload stopped'));
    } });
    up.done.then(resolve);
  });
}
