// Citadel mock kit (v4): boards of takes, pick bars, a Send dock and contents for documents and mocks.
// Copy it beside the page with mockkit.css. No dependencies. In Citadel's viewer (or a tab its Open button
// opened), picks save through the artifact bridge (`window.claude.use('db')`, keys `db/<collection>/<id>`,
// read by agents with artifact_data) and Send posts them straight to the minion's chat as the person. Only
// a tab with no way back to Citadel (opened from disk, or from a pasted link) falls back to Copy. In the viewer, a
// click on a picture on a page with a dock opens it to draw on, and Send carries the marked copies (#946).
//
//   mock.boards('#takes', { boards, size, state, render, on, pick })   one board per take, each with its own state
//   mock.picks({ collection, options, one })                          pick bars on every [data-pick] element
//   mock.toc()                                                        contents from the page's h2s
//   mock.esc(text)                                                    escape text for render's HTML
// By itself, once the page has loaded, it gives each section with an h2 a hue and a drawn shape (#874).
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const $ = (sel, root = document) => (typeof sel === 'string' ? root.querySelector(sel) : sel);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
    n.append(...kids.filter((k) => k != null && k !== false));
    return n;
  };
  const ago = (iso) => {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (!(s >= 0)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return new Date(iso).toLocaleDateString();
  };

  // Where picks go: the bridge's db in Citadel's viewer, else this tab only.
  const store = (async () => {
    let db = null;
    try { db = window.claude?.use ? await window.claude.use('db') : null; } catch { db = null; }
    const info = db && window.citadel ? await window.citadel.info().catch(() => null) : null;
    return { db, person: info?.person ?? null, draw: !!info?.draw };
  })();
  const ready = store.then((s) => ({ saving: !!s.db, person: s.person }));

  // Every picks set on the page, for the dock.
  const sets = [];

  /**
   * Pick bars. `options` are the choices (strings or { v, label, done }, done being how a made choice reads); `one` makes them exclusive across items
   * (choose one take). Each item's doc is { v, note, by, at }; an item with neither v nor note is deleted.
   */
  function picks({ collection = 'picks', options = [{ v: 'pick', label: 'Pick this', done: 'Picked' }], one = false, root = document } = {}) {
    const opts = options.map((o) => (typeof o === 'string' ? { v: o, label: o[0].toUpperCase() + o.slice(1) } : o));
    const docs = new Map();
    const items = new Map(); // id -> { host, title, bar }
    let db = null;
    let person = null;

    async function save(id, doc) {
      const empty = !doc.v && !doc.note;
      if (empty) docs.delete(id);
      else docs.set(id, doc);
      paint();
      if (!db) return;
      const ref = db.collection(collection).doc(id);
      await (empty ? ref.delete() : ref.set(doc)).catch((e) => console.warn(`mockkit: ${e.message}`));
    }
    const stamp = (d) => ({ ...d, by: person, at: new Date().toISOString() });

    function choose(id, v) {
      const cur = docs.get(id) ?? {};
      const next = cur.v === v ? null : v;
      if (one && next) for (const [other, d] of docs) if (other !== id && d.v) save(other, stamp({ ...d, v: null }));
      save(id, stamp({ ...cur, v: next }));
    }

    function add(id, host, title) {
      const note = el('input', { type: 'text', placeholder: 'Note (optional)', 'aria-label': `Note on ${title}`, maxlength: 2000 });
      let timer = null;
      const keep = () => { clearTimeout(timer); save(id, stamp({ ...docs.get(id), note: note.value.trim() })); };
      note.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(keep, 400);
      });
      note.addEventListener('change', keep); // leaving the box (say, for Send) saves now, so the summary has it
      const buttons = opts.map((o) => {
        const b = el('button', { type: 'button', 'data-v': o.v, 'aria-pressed': 'false' }, o.label);
        b.addEventListener('click', () => choose(id, o.v));
        return b;
      });
      const bar = el('div', { class: 'mk-pickbar' }, el('span', { class: 'mk-opts' }, ...buttons), note, el('div', { class: 'mk-who', 'aria-live': 'polite' }));
      if (!host.matches('.mk-board, .mk-option, .mk-callout, .mk-take')) host.classList.add('mk-take'); // a take is one boxed unit
      host.append(bar);
      items.set(id, { host, title, bar, note, buttons });
      paint();
    }

    function paint() {
      for (const [id, it] of items) {
        const d = docs.get(id) ?? {};
        for (const b of it.buttons) b.setAttribute('aria-pressed', String(b.dataset.v === d.v));
        if (document.activeElement !== it.note) it.note.value = d.note ?? '';
        const o = opts.find((x) => x.v === d.v);
        const what = d.v ? o?.done ?? o?.label ?? d.v : d.note ? 'Noted' : '';
        it.bar.querySelector('.mk-who').textContent = what ? `${what}${d.by ? ` by ${d.by}` : ''}${d.at ? ` · ${ago(d.at)}` : ''}` : '';
        it.host.classList.toggle('picked', !!d.v && !['cut', 'no'].includes(d.v));
        if (d.v) it.host.dataset.mkV = d.v;
        else delete it.host.dataset.mkV;
      }
      dock.paint();
    }

    const set = {
      collection, opts, docs, items, add,
      lines: () => [...items].filter(([id]) => docs.has(id)).map(([id, it]) => {
        const d = docs.get(id);
        const o = opts.find((x) => x.v === d.v);
        const label = d.v ? o?.done ?? o?.label ?? d.v : 'note only';
        return `- ${it.title}: ${label}${d.note ? `. "${d.note}"` : ''}`;
      }),
      // Every item with its title (picked or not), for the scheme's ideas ledger (#1150): it keeps sets with a Later option.
      items: () => [...items].map(([id, it]) => {
        const d = docs.get(id) ?? {};
        const o = opts.find((x) => x.v === d.v);
        return { collection, id, title: it.title, ...(d.v ? { label: o?.done ?? o?.label ?? d.v } : {}) };
      }),
    };
    sets.push(set);

    for (const host of root.querySelectorAll('[data-pick]')) add(host.dataset.pick, host, host.dataset.title || host.querySelector('h2, h3, h4')?.textContent.trim() || host.dataset.pick);

    store.then((s) => {
      ({ db, person } = s);
      if (db) db.collection(collection).onSnapshot((snap) => {
        docs.clear();
        for (const d of snap.docs) docs.set(d.id, d.data());
        paint();
      });
      dock.mount(!!db);
    });
    return set;
  }

  // A toast for a Send that failed, with Retry (none when there's nothing to try again). One at a time.
  let toastNode = null;
  function toast(message, retry) {
    toastNode?.remove();
    const again = el('button', { type: 'button', class: 'mk-btn primary' }, 'Retry');
    const close = el('button', { type: 'button', class: 'mk-btn', 'aria-label': 'Dismiss' }, '×');
    toastNode = el('div', { class: 'mk-toast', role: 'alert' }, el('span', {}, message), retry && again, close);
    const node = toastNode;
    again.addEventListener('click', () => { node.remove(); retry?.(); });
    close.addEventListener('click', () => node.remove());
    document.body.append(node);
  }

  // The dock: counts and Send (Copy only in a tab Citadel can't reach). One per page, under the content.
  const dock = (() => {
    let node = null;
    let text = null;
    let sent = null;
    let saving = false;
    let btn = null;
    // Whether what's picked has reached Citadel (#821): saved, saving, or retrying while Citadel restarts.
    // Pages under an older bridge (no watchSaves) just say they save.
    let saveState = 'saved';
    // The text last sent, kept across reloads (the bridge scopes localStorage to this page; the title keeps a
    // plain tab apart): the same picks are never posted twice from one page. `pending` is the post in flight,
    // kept in memory only, so a reload mid-send doesn't leave picks marked Sent that never went.
    const KEY = `mockkit-sent:${document.title}`;
    let lastSent = null;
    let pending = null;
    try { lastSent = localStorage.getItem(KEY); } catch { /* storage blocked: stays in memory only */ }
    // Pictures drawn on (#946), by the src they were drawn from: { name, mediaType, data }. They live in this tab
    // only until Send, which carries them; a message takes at most 6.
    const marked = new Map();
    const MAX_MARKED = 6;
    const images = () => [...marked.values()].map(({ mediaType, data }) => ({ mediaType, data }));
    const remember = (v) => {
      lastSent = v;
      try { localStorage.setItem(KEY, v); } catch { /* as above */ }
    };

    // Shows Sent at once and stays Sent until a pick or note changes; a failure takes it back and says why, with Retry.
    async function send(body) {
      if (pending === body || lastSent === body) return;
      pending = body;
      toastNode?.remove();
      dock.paint();
      try {
        const r = await window.citadel.send(body, { items: sets.flatMap((s) => s.items()), ...(marked.size ? { images: images() } : {}) });
        remember(body);
        if (pending === body) sent.textContent = `Sent to ${r?.to ?? 'the minion'} ✓`;
      } catch (e) {
        sent.textContent = '';
        if (pending === body) toast(`Couldn't send your picks: ${e.message}`, () => send(body));
      } finally {
        if (pending === body) pending = null;
        dock.paint();
      }
    }

    return {
      mount(isSaving) {
        saving = isSaving;
        if (node) return this.paint();
        btn = el('button', { type: 'button', class: 'mk-btn primary' }, '');
        text = el('span', { class: 'mk-dock-text' });
        sent = el('span', { class: 'mk-sent', 'aria-live': 'polite' });
        node = el('div', { class: 'mk-dock' }, el('div', { class: 'mk-dock-msg' }, text, sent), btn);
        btn.addEventListener('click', async () => {
          const body = summary();
          if (!body) return void (sent.textContent = 'Nothing picked yet');
          try {
            if (saving) {
              await send(body);
            } else {
              // Last resort: this tab has no way back to Citadel, so it can't send as anyone.
              const ta = el('textarea', { style: 'position:fixed;opacity:0' });
              ta.value = body;
              document.body.append(ta);
              ta.select();
              document.execCommand('copy');
              ta.remove();
              sent.textContent = 'Copied. Paste it in the chat.';
            }
          } catch (e) {
            sent.textContent = e.message;
          }
        });
        ($('.mk-page') ?? document.body).append(node);
        if (saving) window.citadel?.watchSaves?.((st) => { saveState = st; dock.paint(); });
        if (saving) store.then((s) => s.draw && drawing());
        this.paint();
      },
      /** A line for the summary naming the marked pictures, or nothing. */
      markedLine: () => (marked.size ? [`Marked pictures (attached): ${[...marked.values()].map((m) => m.name).join(', ')}`] : []),
      paint() {
        if (!node) return;
        let picked = 0;
        let notes = 0;
        for (const s of sets) for (const d of s.docs.values()) { if (d.v) picked++; if (d.note) notes++; }
        const drawn = marked.size ? `, <b>${marked.size}</b> picture${marked.size > 1 ? 's' : ''} marked` : '';
        const where = !saving ? 'not saved or sent: open this page from Citadel to send'
          : saveState === 'retrying' ? 'not saved yet: Citadel is restarting, so it keeps trying'
          : saveState === 'saving' ? 'saving…'
          : 'saved for the minion to read';
        node.classList.toggle('mk-unsaved', saving && saveState === 'retrying');
        node.classList.toggle('stuck', picked + notes + marked.size > 0);
        const now = summary();
        const done = saving && now !== '' && (now === lastSent || now === pending);
        btn.disabled = done;
        btn.textContent = done ? 'Sent ✓' : saving ? 'Send picks' : 'Copy picks';
        if (!done && /^Sent/.test(sent.textContent)) sent.textContent = '';
        text.innerHTML = picked || notes || marked.size
          ? `<b>${picked}</b> picked${notes ? `, <b>${notes}</b> with notes` : ''}${drawn} · ${where}`
          : `Nothing picked yet · ${saving ? 'picks save as you make them' : where}`;
      },
    };

    // Drawing is the modal's "Draw on it" button (below); Done puts the marked copy in its place on the page,
    // and Send carries it. Marks taken off restore the picture.
    function drawing() {
      document.documentElement.classList.add('mk-draw');
      drawOn = drawImage;
    }
    async function drawImage(img) {
      const src = img.dataset.mkSrc ?? img.currentSrc ?? img.src;
      if (!marked.has(src) && marked.size >= MAX_MARKED) return toast(`At most ${MAX_MARKED} marked pictures go with one Send`);
      let r;
      try {
        r = await window.citadel.draw(src);
      } catch (err) {
        return toast(`Couldn't open the picture to draw on: ${err.message}`, () => drawImage(img));
      }
      if (!r) return;
      // Every copy of the picture on the page shows the marks.
      const copies = [...document.querySelectorAll('img')].filter((i) => (i.dataset.mkSrc ?? i.currentSrc ?? i.src) === src);
      if (r.marked) {
        const name = img.alt || decodeURIComponent(new URL(src).pathname.split('/').pop() || 'picture');
        marked.set(src, { name, mediaType: r.mediaType, data: r.data });
        for (const i of copies) { i.dataset.mkSrc = src; i.src = `data:${r.mediaType};base64,${r.data}`; i.classList.add('mk-marked'); }
      } else {
        marked.delete(src);
        for (const i of copies) { i.src = src; delete i.dataset.mkSrc; i.classList.remove('mk-marked'); }
      }
      // New marks are a new answer, even when the picks read the same.
      lastSent = null;
      dock.paint();
    }
  })();

  // A click on a picture opens it in a modal over the page (dimmed behind, X, click outside or Esc to close),
  // never the bare image file. A picture in a link to an image file counts; a link to a page stays a link.
  let drawOn = null; // set once Citadel's viewer can draw on pictures (drawing())
  function viewer(img) {
    const src = img.dataset.mkSrc ?? img.currentSrc ?? img.src;
    const opener = document.activeElement;
    const dlg = el('dialog', { class: 'mk-viewer', 'aria-label': img.alt || 'Picture' });
    const big = el('img', { src, alt: img.alt });
    const close = el('button', { type: 'button', class: 'mk-viewer-x', 'aria-label': 'Close' }, '\u00d7');
    dlg.append(close, big);
    if (drawOn) {
      const d = el('button', { type: 'button', class: 'mk-btn mk-viewer-draw' }, 'Draw on it');
      d.addEventListener('click', () => { dlg.close(); drawOn(img); });
      dlg.append(d);
    }
    close.addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => { dlg.remove(); opener?.focus?.({ preventScroll: true }); });
    document.body.append(dlg);
    dlg.showModal();
  }
  document.addEventListener('click', (e) => {
    const img = e.target?.closest?.('img');
    if (!img || e.defaultPrevented || e.button !== 0 || img.closest('button, .mk-dock, .mk-pickbar, .mk-viewer')) return;
    const a = img.closest('a[href]');
    if (a && !/\.(png|jpe?g|gif|webp|avif|svg)([?#].*)?$/i.test(a.pathname) && a.href !== img.src) return;
    e.preventDefault();
    viewer(img);
  });

  function summary() {
    const parts = [...sets.map((s) => s.lines()), dock.markedLine()].filter((l) => l.length);
    if (!parts.length) return '';
    return [`Picks on "${document.title}":`, ...parts.flat()].join('\n');
  }

  // Events a board's markup can name in data-on="click:fold input:find" (with data-arg for a value).
  const EVENTS = ['click', 'input', 'change', 'keydown', 'pointerover', 'pointerout', 'focusin', 'focusout'];

  /**
   * Boards: one per take. `render(board, state)` returns the screen's HTML; `on[name](state, ctx)` handles
   * data-on events and returns a patch (or changes state in place); a changed board re-renders. `size`
   * { w, h } draws each screen at a fixed size, scaled down to fit a narrow window. `pick` is the picks
   * options ({ collection, options, one }, default: choose one take) or false; a board with pick: false
   * (like "Today") gets no bar.
   */
  function boards(target, { boards: list, size, state = {}, render, on = {}, pick = {} }) {
    const wrap = $(target);
    wrap.classList.add('mk-boards');
    if (size?.w) wrap.style.setProperty('--mk-board-w', `${size.w + 32}px`);
    const ps = pick === false ? null : picks({ collection: 'picks', one: true, ...pick, root: el('div') });
    const live = new Map();

    for (const b of list) {
      const s = structuredClone({ ...state, ...b.state });
      const screen = el('div', { class: 'mk-screen' });
      const sz = b.size ?? size;
      const stage = el('div', { class: `mk-stage${sz?.w ? ' fixed' : ''}` }, screen);
      if (sz?.w) {
        screen.style.setProperty('--mk-w', `${sz.w}px`);
        screen.style.setProperty('--mk-h', `${sz.h}px`);
        new ResizeObserver(() => screen.style.setProperty('--mk-zoom', Math.min(1, stage.clientWidth / sz.w))).observe(stage);
      }
      const card = el('article', { class: `mk-board${b.rec ? ' rec' : ''}`, id: `board-${b.id}` },
        el('header', {},
          el('div', { class: 'mk-board-title' }, el('span', { class: 'mk-board-id' }, b.label ?? b.id), el('span', {}, b.title ?? '')),
          b.note ? el('p', {}, b.note) : null),
        stage);
      wrap.append(card);
      const entry = { b, s, screen, draw: () => { screen.innerHTML = render(b, s); } };
      live.set(b.id, entry);
      entry.draw();
      for (const type of EVENTS) {
        screen.addEventListener(type, (ev) => {
          const hit = ev.target.closest?.('[data-on]');
          if (!hit || !screen.contains(hit)) return;
          const name = hit.dataset.on.split(/\s+/).map((p) => p.split(':')).find(([t]) => t === type)?.[1];
          if (!name || !on[name]) return;
          const before = JSON.stringify(s);
          const patch = on[name](s, { arg: hit.dataset.arg, value: hit.value, checked: hit.checked, el: hit, ev, board: b });
          if (patch) Object.assign(s, patch);
          if (JSON.stringify(s) !== before) redraw(entry);
        });
      }
      if (ps && b.pick !== false) ps.add(b.id, card, `${b.label ?? b.id}${b.title ? ` · ${b.title}` : ''}`);
    }

    // Re-render one board, keeping focus and the caret on the control that had them.
    function redraw(entry) {
      const a = document.activeElement;
      const key = a && entry.screen.contains(a) ? (a.dataset.key ?? `${a.dataset.on}|${a.dataset.arg}`) : null;
      const caret = key && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null;
      entry.draw();
      if (!key) return;
      const back = [...entry.screen.querySelectorAll('[data-on]')].find((n) => (n.dataset.key ?? `${n.dataset.on}|${n.dataset.arg}`) === key);
      if (!back) return;
      back.focus();
      if (caret) try { back.setSelectionRange(...caret); } catch {}
    }

    return {
      state: (id) => live.get(id)?.s,
      /** Patch one board's state (or every board's, with id '*') from a control outside the boards. */
      set(id, patch) {
        for (const [bid, e] of live) if (id === '*' || bid === id) { Object.assign(e.s, patch); redraw(e); }
      },
    };
  }

  /** Contents: a link per h2 in the page, into `.mk-toc` (or `target`), each in its section's hue. */
  function toc(target = '.mk-toc') {
    const nav = $(target);
    if (!nav) return;
    for (const h of document.querySelectorAll('.mk-page h2')) {
      h.id ||= h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      nav.append(el('a', { href: `#${h.id}` }, h.textContent.trim()));
    }
    hueLinks();
  }

  // Each section with an h2 gets a hue (the six category hues in turn, unless the page set --mk-hue on it) and a
  // shape beside its heading, so a page is colour-coded with no markup of its own.
  const SHAPES = ['circle', 'diamond', 'square', 'triangle', 'hex', 'star'];
  function hueLinks() {
    for (const a of document.querySelectorAll('.mk-toc a[href^="#"]')) {
      const sec = document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)))?.closest('.mk-sec');
      if (sec) a.style.setProperty('--mk-hue', sec.style.getPropertyValue('--mk-hue') || getComputedStyle(sec).getPropertyValue('--mk-hue'));
    }
  }
  function sections() {
    const secs = [...document.querySelectorAll('.mk-page section')].filter((s) => s.querySelector(':scope > h2'));
    secs.forEach((s, i) => {
      if (!s.style.getPropertyValue('--mk-hue')) s.style.setProperty('--mk-hue', `var(--mk-cat-${(i % 6) + 1})`);
      s.classList.add('mk-sec');
      const h = s.querySelector(':scope > h2');
      if (!h.querySelector(':scope > .mk-glyph')) h.prepend(el('span', { class: 'mk-glyph', 'aria-hidden': 'true' }));
      h.dataset.shape ||= SHAPES[i % SHAPES.length];
    });
    hueLinks();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sections);
  else sections();

  window.mock = { boards, picks, toc, esc, ready };
})();
