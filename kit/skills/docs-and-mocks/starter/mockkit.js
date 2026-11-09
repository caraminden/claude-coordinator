// Citadel mock kit (v2): boards of takes, pick bars, a Send dock and contents for documents and mocks.
// Copy it beside the page with mockkit.css. No dependencies. In Citadel's viewer (or a tab its Open button
// opened), picks save through the artifact bridge (`window.claude.use('db')`, keys `db/<collection>/<id>`,
// read by agents with artifact_data) and Send posts them straight to the minion's chat as the person. Only
// a tab with no way back to Citadel (opened from disk, or from a pasted link) falls back to Copy.
//
//   mock.boards('#takes', { boards, size, state, render, on, pick })   one board per take, each with its own state
//   mock.picks({ collection, options, one })                          pick bars on every [data-pick] element
//   mock.toc()                                                        contents from the page's h2s
//   mock.esc(text)                                                    escape text for render's HTML
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
    return { db, person: info?.person ?? null };
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

  // A toast for a Send that failed, with Retry. One at a time.
  let toastNode = null;
  function toast(message, retry) {
    toastNode?.remove();
    const again = el('button', { type: 'button', class: 'mk-btn primary' }, 'Retry');
    const close = el('button', { type: 'button', class: 'mk-btn', 'aria-label': 'Dismiss' }, '×');
    toastNode = el('div', { class: 'mk-toast', role: 'alert' }, el('span', {}, message), again, close);
    const node = toastNode;
    again.addEventListener('click', () => { node.remove(); retry(); });
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
    // The text last sent, kept across reloads: the same picks are never posted twice from one page.
    const KEY = `mockkit-sent:${location.pathname}`;
    let lastSent = null;
    try { lastSent = localStorage.getItem(KEY); } catch { /* storage blocked: stays in memory only */ }
    const remember = (v) => {
      lastSent = v;
      try { v == null ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, v); } catch { /* as above */ }
    };

    // Shows Sent at once and stays Sent until a pick or note changes; a failure takes it back and says why, with Retry.
    async function send(body) {
      if (lastSent === body) return;
      remember(body);
      toastNode?.remove();
      dock.paint();
      try {
        const r = await window.citadel.send(body);
        sent.textContent = `Sent to ${r?.to ?? 'the minion'} ✓`;
      } catch (e) {
        if (lastSent === body) remember(null);
        sent.textContent = '';
        dock.paint();
        toast(`Couldn't send your picks: ${e.message}`, () => send(body));
      }
    }

    return {
      mount(isSaving) {
        saving = isSaving;
        if (node) return this.paint();
        btn = el('button', { type: 'button', class: 'mk-btn primary' }, '');
        text = el('span', { class: 'mk-dock-text' });
        sent = el('span', { class: 'mk-sent', 'aria-live': 'polite' });
        node = el('div', { class: 'mk-dock' }, text, sent, btn);
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
        this.paint();
      },
      paint() {
        if (!node) return;
        let picked = 0;
        let notes = 0;
        for (const s of sets) for (const d of s.docs.values()) { if (d.v) picked++; if (d.note) notes++; }
        const where = saving ? 'saved for the minion to read' : 'not saved or sent: open this page from Citadel to send';
        node.classList.toggle('stuck', picked + notes > 0);
        const done = saving && lastSent != null && summary() === lastSent;
        btn.disabled = done;
        btn.textContent = done ? 'Sent ✓' : saving ? 'Send picks to the minion' : 'Copy picks';
        if (!done && /^Sent/.test(sent.textContent)) sent.textContent = '';
        text.innerHTML = picked || notes
          ? `<b>${picked}</b> picked${notes ? `, <b>${notes}</b> with notes` : ''} · ${where}`
          : `Nothing picked yet · ${saving ? 'picks save as you make them' : where}`;
      },
    };
  })();

  function summary() {
    const parts = sets.map((s) => s.lines()).filter((l) => l.length);
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

  /** Contents: a link per h2 in the page, into `.mk-toc` (or `target`). */
  function toc(target = '.mk-toc') {
    const nav = $(target);
    if (!nav) return;
    for (const h of document.querySelectorAll('.mk-page h2')) {
      h.id ||= h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      nav.append(el('a', { href: `#${h.id}` }, h.textContent.trim()));
    }
  }

  window.mock = { boards, picks, toc, esc, ready };
})();
