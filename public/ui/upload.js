// Citadel UI: big uploads (#832). Served to apps as /apps/_citadel/ui/upload.js (types: upload.d.ts beside it); its
// look is base.css's cui-upload. Docs: kit/skills/contraption-ui/references/upload.md.
//
// Every file in public/ui/ is standalone, because apps load it from outside Citadel's pages: no imports
// from outside ui/, nothing it writes carries style="" or <style>, and its exports are an API apps depend
// on (test/ui-contract.test.ts). Add, never rename.
//
// What it does: sends a file in 8 MiB chunks through Citadel's four upload calls (src/chunked-uploads.ts), so
// a file of any size goes, a dropped connection picks up where it broke off, and a reload can carry on: the
// same file picked again resumes from the server's offset (localStorage remembers the upload for 3 days).
// startUpload() is the client; mountUpload() is the drop zone with file and folder pickers, a row per file
// with its progress, pause and resume, a total, and a "left out" line for what it skipped.

const KEY = 'cui-upload:';
const KEEP = 3 * 24 * 3600 * 1000; // the server gives up an untouched upload after 3 days too
const CHUNK = 8 * 1024 * 1024;
const TRIES = 8; // network drops and 5xx in a row before an upload stops and waits for Resume

/** "1.2 GB", "340 KB", "12 B". */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do (n /= 1024), i++;
  while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

const store = {
  get(key) {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? 'null');
      return v && Date.now() - v.at < KEEP ? v.id : null;
    } catch {
      return null;
    }
  },
  set(key, id) {
    try {
      localStorage.setItem(key, JSON.stringify({ id, at: Date.now() }));
    } catch {}
  },
  drop(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

const failure = (status, data) => Object.assign(new Error(data?.error || (status ? `HTTP ${status}` : 'The connection broke off')), { status });

async function call(method, url, body) {
  let r;
  try {
    r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  } catch {
    throw failure(0);
  }
  const data = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw failure(r.status, data);
  return data;
}

/**
 * Upload one file to `endpoint` (a Citadel upload base: '/apps/_citadel/uploads/<app>' in an app). It starts at once
 * and returns a handle whose `done` resolves with the server's answer for the finished file, or null if cancelled.
 */
export function startUpload(endpoint, file, { folder = '', onChange } = {}) {
  const base = endpoint.replace(/\/+$/, '');
  const key = `${KEY}${base}|${folder}|${file.name}|${file.size}|${file.lastModified}`;
  let id = null;
  let xhr = null;
  let run = 0; // a pause or cancel leaves the run it interrupted to notice it's stale
  let settle;
  const u = {
    file,
    folder,
    size: file.size,
    sent: 0,
    state: 'sending',
    error: '',
    result: null,
    done: new Promise((resolve) => (settle = resolve)),
    pause() {
      if (u.state !== 'sending') return;
      run++;
      xhr?.abort();
      set('paused');
    },
    resume() {
      if (u.state === 'paused') go();
    },
    cancel() {
      if (u.state === 'done' || u.state === 'cancelled') return;
      run++;
      xhr?.abort();
      store.drop(key);
      if (id) call('DELETE', `${base}/${id}`).catch(() => {});
      set('cancelled');
      settle(null);
    },
  };
  const set = (state, error = '') => {
    Object.assign(u, { state, error });
    onChange?.(u);
  };

  function put(offset, chunk) {
    return new Promise((resolve, reject) => {
      xhr = new XMLHttpRequest();
      xhr.open('PUT', `${base}/${id}?offset=${offset}`);
      xhr.upload.onprogress = (e) => {
        u.sent = Math.min(u.size, offset + e.loaded);
        onChange?.(u);
      };
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(failure(xhr.status, data));
      };
      xhr.onerror = xhr.onabort = () => reject(failure(0));
      xhr.send(file.slice(offset, Math.min(u.size, offset + chunk)));
    });
  }

  async function go() {
    const me = ++run;
    set('sending');
    let tries = 0;
    for (;;) {
      try {
        let offset = 0;
        let chunk = CHUNK;
        id ??= store.get(key);
        if (id) {
          try {
            offset = (await call('GET', `${base}/${id}`)).offset;
          } catch (err) {
            if (err.status !== 404) throw err;
            // Gone from the server: it sat too long, or it finished and the answer never arrived. Start afresh.
            store.drop(key);
            id = null;
          }
        }
        if (me !== run) return;
        if (!id) {
          const r = await call('POST', base, { name: file.name || 'file', size: u.size, folder });
          if (me !== run) return void call('DELETE', `${base}/${r.id}`).catch(() => {});
          ({ id, chunk = CHUNK } = r);
          store.set(key, id);
        }
        let r;
        do {
          u.sent = offset;
          r = await put(offset, chunk);
          if (me !== run) return;
          offset = r.offset;
          tries = 0;
        } while (!r.done);
        store.drop(key);
        u.result = r;
        u.sent = u.size;
        set('done');
        return settle(r);
      } catch (err) {
        if (me !== run) return;
        // 409: a retry raced a chunk still landing, or the offset moved; the loop asks where it is and goes on.
        const again = err.status === 409 || err.status === 0 || (err.status >= 500 && err.status !== 507);
        if (!again || ++tries > TRIES) return set('paused', err.message);
        await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** tries)));
        if (me !== run) return;
      }
    }
  }

  go();
  return u;
}

// ---------- the drop zone ----------

/** Whether `file` fits an <input accept> list: ".jpg", "image/*", "video/mp4". Empty accepts all. */
function accepts(accept, file) {
  const list = accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  return !list.length || list.some((a) => (a.startsWith('.') ? name.endsWith(a) : a.endsWith('/*') ? type.startsWith(a.slice(0, -1)) : type === a));
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const hidden = (path) => path.split('/').some((p) => p.startsWith('.'));

/**
 * The files a drop carries, folders walked, each with its path relative to what was dropped. Hidden folders aren't
 * walked; they come back in `skipped`. Call it in the drop handler before any await (the browser empties the list).
 */
export async function droppedFiles(dataTransfer) {
  const entries = [...(dataTransfer.items ?? [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return { files: [...dataTransfer.files].map((file) => ({ file, path: file.name })), skipped: [] };
  const files = [];
  const skipped = [];
  const walk = async (entry) => {
    const path = entry.fullPath.replace(/^\/+/, '');
    if (entry.name.startsWith('.')) return void skipped.push({ path: entry.isFile ? path : `${path}/`, why: 'hidden' });
    if (entry.isFile) {
      try {
        files.push({ file: await new Promise((res, rej) => entry.file(res, rej)), path });
      } catch {
        skipped.push({ path, why: "couldn't be read" });
      }
      return;
    }
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => []);
      if (!batch.length) break;
      for (const e of batch) await walk(e);
    }
  };
  for (const e of entries) await walk(e);
  return { files, skipped };
}

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  node.append(...kids);
  return node;
}

const STATE = { waiting: 'Waiting', sending: '', paused: 'Paused', done: 'Done', cancelled: 'Cancelled' };

/**
 * A drop zone with file and folder pickers that uploads what it's given to `endpoint`, one file at a time, each row
 * with its progress, Pause and Resume, and Cancel; a total over them; and a line naming what it left out.
 */
export function mountUpload(root, { endpoint, folder = '', accept = '', folders = true, label = 'Drop files or folders here', onDone } = {}) {
  const rows = []; // { file, folder, up: the handle once started, held: paused before its turn, node }
  const pickFiles = el('input', { type: 'file', multiple: true, hidden: true, accept: accept || false });
  const pickFolder = el('input', { type: 'file', hidden: true, webkitdirectory: true });
  const left = el('p', { class: 'cui-upload-left', hidden: true });
  const totalText = el('span', { class: 'cui-upload-total-text' });
  const totalBar = el('progress', { class: 'cui-upload-bar', max: 1, value: 0 });
  const allBtn = el('button', { type: 'button', class: 'cui-btn cui-small', onclick: () => (anyRunning() ? pauseAll() : resumeAll()) });
  const total = el('div', { class: 'cui-upload-total', hidden: true, role: 'status' }, totalText, totalBar, allBtn);
  const list = el('ul', { class: 'cui-upload-list' });
  const zone = el(
    'div',
    { class: 'cui-upload-drop' },
    el('span', {}, label),
    el('span', { class: 'cui-upload-pick' }, el('button', { type: 'button', class: 'cui-btn', onclick: () => pickFiles.click() }, 'Choose files'), folders ? el('button', { type: 'button', class: 'cui-btn', onclick: () => pickFolder.click() }, 'Choose a folder') : ''),
  );
  const box = el('div', { class: 'cui-upload' }, zone, pickFiles, pickFolder, left, total, list);
  root.append(box);

  const picked = (input) => {
    add(
      [...input.files].map((file) => ({ file, path: file.webkitRelativePath || file.name })),
      [],
    );
    input.value = '';
  };
  pickFiles.addEventListener('change', () => picked(pickFiles));
  pickFolder.addEventListener('change', () => picked(pickFolder));
  let depth = 0;
  const dragging = (e) => e.dataTransfer?.types?.includes('Files');
  zone.addEventListener('dragenter', (e) => dragging(e) && (depth++, zone.classList.add('cui-dropping')));
  zone.addEventListener('dragleave', () => --depth <= 0 && ((depth = 0), zone.classList.remove('cui-dropping')));
  zone.addEventListener('dragover', (e) => dragging(e) && e.preventDefault());
  zone.addEventListener('drop', (e) => {
    if (!dragging(e)) return;
    e.preventDefault();
    depth = 0;
    zone.classList.remove('cui-dropping');
    droppedFiles(e.dataTransfer).then(({ files, skipped }) => add(files, skipped));
  });

  function add(files, skipped) {
    // A new batch clears the finished rows of the last one.
    for (const r of rows.filter((r) => ['done', 'cancelled'].includes(stateOf(r)))) {
      r.node.remove();
      rows.splice(rows.indexOf(r), 1);
    }
    const out = [...skipped];
    for (const { file, path } of files) {
      if (hidden(path)) out.push({ path, why: 'hidden' });
      else if (!accepts(accept, file)) out.push({ path, why: 'not a kind this takes' });
      else rows.push(row(file, [folder, dirOf(path)].filter(Boolean).join('/')));
    }
    left.hidden = !out.length;
    left.textContent = out.length
      ? `Left out ${out.length}: ${out
          .slice(0, 4)
          .map((o) => `${o.path} (${o.why})`)
          .join(', ')}${out.length > 4 ? ` and ${out.length - 4} more` : ''}`
      : '';
    next();
  }

  function row(file, dir) {
    const r = { file, folder: dir, up: null, held: false };
    const bar = el('progress', { class: 'cui-upload-bar', max: 1, value: 0 });
    const meta = el('span', { class: 'cui-upload-meta' });
    const error = el('span', { class: 'cui-upload-error', hidden: true });
    const toggle = el('button', {
      type: 'button',
      class: 'cui-btn cui-small',
      onclick: () => {
        if (!r.up) r.held = !r.held;
        else if (r.up.state === 'sending') r.up.pause();
        else if (r.queued)
          r.queued = false; // waiting for its turn: Pause leaves it paused
        else r.queued = true; // Resume: next() starts it when nothing else is sending

        draw(r);
        next();
      },
    });
    const cancel = el(
      'button',
      {
        type: 'button',
        class: 'cui-btn cui-small cui-ghost',
        'aria-label': `Cancel ${file.name}`,
        onclick: () => {
          r.cancelled = true;
          r.up?.cancel();
          draw(r);
          next();
        },
      },
      '✕',
    );
    r.parts = { bar, meta, error, toggle, cancel };
    r.node = el('li', { class: 'cui-upload-file' }, el('span', { class: 'cui-upload-name', title: dir ? `${dir}/${file.name}` : file.name }, dir ? `${dir}/${file.name}` : file.name), meta, toggle, cancel, bar, error);
    list.append(r.node);
    draw(r);
    return r;
  }

  const stateOf = (r) => (r.cancelled ? 'cancelled' : r.up ? (r.up.state === 'paused' && r.queued ? 'waiting' : r.up.state) : r.held ? 'paused' : 'waiting');
  const anyRunning = () => rows.some((r) => ['sending', 'waiting'].includes(stateOf(r)));

  function draw(r) {
    const s = stateOf(r);
    const sent = r.up?.sent ?? 0;
    const { bar, meta, error, toggle, cancel } = r.parts;
    r.node.dataset.state = s;
    bar.value = r.file.size ? sent / r.file.size : s === 'done' ? 1 : 0;
    meta.textContent = s === 'sending' ? `${Math.floor(bar.value * 100)}% · ${formatBytes(sent)} of ${formatBytes(r.file.size)}` : [STATE[s], formatBytes(r.file.size)].join(' · ');
    error.hidden = !r.up?.error;
    error.textContent = r.up?.error ?? '';
    toggle.hidden = cancel.hidden = s === 'done' || s === 'cancelled';
    toggle.textContent = s === 'paused' ? 'Resume' : 'Pause';
    drawTotal();
  }

  function drawTotal() {
    const live = rows.filter((r) => !r.cancelled);
    total.hidden = !live.length;
    if (!live.length) return;
    const size = live.reduce((n, r) => n + r.file.size, 0);
    const sent = live.reduce((n, r) => n + (r.up?.sent ?? 0), 0);
    const finished = live.filter((r) => r.up?.state === 'done').length;
    totalBar.value = size ? sent / size : finished / live.length;
    totalText.textContent = finished === live.length ? `Uploaded ${live.length} file${live.length === 1 ? '' : 's'} · ${formatBytes(size)}` : `${finished} of ${live.length} files · ${formatBytes(sent)} of ${formatBytes(size)}`;
    allBtn.hidden = finished === live.length;
    allBtn.textContent = anyRunning() ? 'Pause all' : 'Resume all';
  }

  /** Start the next waiting file when nothing is sending. */
  function next() {
    if (rows.some((r) => stateOf(r) === 'sending')) return drawTotal();
    const r = rows.find((r) => stateOf(r) === 'waiting');
    if (!r) return drawTotal();
    if (r.up) {
      // a paused file that was told to resume
      r.queued = false;
      r.up.resume();
      return draw(r);
    }
    // Once it stops sending (done, paused by hand or after its retries, cancelled) the next file gets its turn.
    r.up = startUpload(endpoint, r.file, { folder: r.folder, onChange: (u) => r.up && (draw(r), u.state !== 'sending' && next()) });
    r.up.done.then((result) => result && onDone?.(result, r.file));
    draw(r);
  }

  function pauseAll() {
    for (const r of rows) {
      if (!r.up && !r.cancelled) r.held = true;
      r.queued = false;
      if (r.up?.state === 'sending') r.up.pause();
      draw(r);
    }
  }
  function resumeAll() {
    for (const r of rows) {
      r.held = false;
      if (r.up?.state === 'paused') r.queued = true;
      draw(r);
    }
    next();
  }

  return {
    element: box,
    /** Queue files as if dropped: each { file, path } (path relative, its folders kept under `folder`). */
    add: (files) => add(files, []),
    pause: pauseAll,
    resume: resumeAll,
    /** Whether a file is still sending or waiting its turn (a reload now would stop it). */
    get busy() {
      return anyRunning();
    },
  };
}
