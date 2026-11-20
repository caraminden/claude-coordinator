// The artifact bridge, page side (#168). The server inlines this function as the first script of every
// HTML page it serves under a file token, called with what the page saved (`cfg.entries`) and the token
// path it was served under (`cfg.page`). It gives the page:
// - `citadel`: storage for this page, `send(text, { images })`, which sends text to the minion that showed
//   the page, as the person who clicked (#417), and `draw(src)`, which opens one of its pictures to draw on (#946);
// - `window.claude.use('db')`, `window.storage` and a working `localStorage`, the claude.ai APIs Delve's
//   pages were written for (the sandbox makes the real localStorage throw).
// It talks only to the viewer that framed it, or the Citadel tab whose Open button opened it
// (public/bridge-host.js); opened any other way, saved values still show but nothing new is kept or sent.
(function (cfg) {
  'use strict';
  const TAG = 'citadel-bridge-1';
  const NO_VIEWER = 'This tab isn\'t connected to Citadel: open the page from Citadel (its viewer or its Open button)';
  const host = window.parent !== window ? window.parent : window.opener;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const data = new Map(cfg.entries.map((e) => [e.key, e.value]));

  // Requests to the viewer, answered by id.
  const pending = new Map();
  let seq = 0;
  function request(op, extra, ms = 15000) {
    return new Promise((resolve, reject) => {
      if (!host) return reject(new Error(NO_VIEWER));
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        if (op !== 'hello' && op !== 'link') cutOff();
        reject(new Error(op === 'hello' ? NO_VIEWER : 'Citadel did not answer'));
      }, ms);
      pending.set(id, { resolve, reject, timer });
      host.postMessage({ bridge: TAG, id, op, page: cfg.page, ...extra }, '*');
    });
  }

  // The viewer answered once and now doesn't (its Citadel tab reloaded or closed): what the page shows
  // as kept isn't saved, so say so on the page, once.
  let cutOffShown = false;
  function cutOff() {
    if (cutOffShown || !document.body) return;
    cutOffShown = true;
    const bar = document.createElement('div');
    bar.setAttribute('role', 'alert');
    bar.textContent = 'Not connected to Citadel any more, so changes here are not saved: reopen this page from Citadel.';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:0.4rem 1rem;background:Canvas;color:CanvasText;border-bottom:1px solid GrayText;font:0.9em system-ui,sans-serif;text-align:center';
    document.body.append(bar);
  }

  // Who is looking and who made the page, once the viewer answers; false when there is no viewer.
  let info = null;
  const hello = (tries) => request('hello', {}, 5000).catch((err) => (tries > 1 ? hello(tries - 1) : Promise.reject(err)));
  const ready = host ? hello(2).then((r) => {
    info = { person: r.person, file: r.file, owner: r.owner, draw: !!r.draw };
    replace(r.entries);
    return true;
  }, () => false) : Promise.resolve(false);

  // Watchers of keys (`key`) or of every key under a prefix (`prefix`), told after any change.
  const watchers = new Set();
  function notify(keys) {
    for (const w of watchers) if (keys.some((k) => (w.prefix ? k.startsWith(w.key) : k === w.key))) w.fn();
  }
  function watch(key, fn, prefix = false) {
    const w = { key, fn, prefix };
    watchers.add(w);
    setTimeout(() => watchers.has(w) && fn());
    return () => watchers.delete(w);
  }

  // Writes: applied here at once, sent to the viewer at most every 100 ms with each key's latest value,
  // so a slider moving fast stays under the viewer's 20 writes a second and its last value always lands.
  let queue = new Map();
  let flushing = null;
  // The last flush's requests: the next waits for them, so a later value never reaches the server first.
  let sending = Promise.resolve();
  // Flushed but not yet answered: a refresh meanwhile keeps them on top, as it does the queue.
  const inFlight = new Map();
  function write(key, value) {
    // null (NaN and the like clone to it) is the wire's delete, so it deletes here too.
    const v = value === undefined ? undefined : clone(value) ?? undefined;
    if (v === undefined) data.delete(key);
    else data.set(key, v);
    notify([key]);
    queue.set(key, v === undefined ? null : v);
    flushing ??= new Promise((r) => setTimeout(r, 100)).then(() => {
      const entries = [...queue].map(([k, val]) => ({ key: k, value: val }));
      queue = new Map();
      flushing = null;
      for (const e of entries) inFlight.set(e.key, e.value);
      sending = sending.catch(() => {}).then(async () => {
        if (!(await ready)) throw new Error(NO_VIEWER);
        for (let i = 0; i < entries.length; i += 100) await keep(entries.slice(i, i + 100));
      }).finally(() => {
        for (const e of entries) if (inFlight.get(e.key) === e.value) inFlight.delete(e.key);
        saves();
      });
      saves();
      return sending;
    });
    saves();
    return flushing;
  }

  // A write Citadel couldn't take because it was down or restarting (the viewer says `retry`) is sent again,
  // 1 s, 2 s, 4 s … 15 s apart, until it lands (#821): it stays on top of refreshes meanwhile, as in flight.
  let retrying = false;
  async function keep(entries) {
    for (let gap = 1000; ; gap = Math.min(gap * 2, 15000)) {
      try {
        await request('write', { entries });
        retrying = false;
        return;
      } catch (err) {
        if (!err.retry) {
          retrying = false;
          throw err;
        }
        retrying = true;
        saves();
        await new Promise((r) => setTimeout(r, gap));
      }
    }
  }

  // Whether what the page shows is saved (#821): 'saved', 'saving' (on its way) or 'retrying' (Citadel is
  // down or restarting; it is sent again until it lands). Watchers hear each change.
  const saveWatchers = new Set();
  let saveState = 'saved';
  const nowSaving = () => (retrying ? 'retrying' : queue.size || inFlight.size || flushing ? 'saving' : 'saved');
  function saves() {
    const s = nowSaving();
    if (s === saveState) return;
    saveState = s;
    for (const fn of saveWatchers) fn(s);
  }
  let warned = false;
  const warn = (err) => {
    if (!warned) console.warn(`Citadel: ${err.message}`);
    warned = true;
  };

  // The store as the server has it now (another person's or an agent's write); writes not yet sent or answered stay on top.
  function replace(entries) {
    const next = new Map(entries.map((e) => [e.key, e.value]));
    for (const [k, v] of [...inFlight, ...queue]) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    const changed = [...new Set([...data.keys(), ...next.keys()])].filter((k) => JSON.stringify(data.get(k)) !== JSON.stringify(next.get(k)));
    data.clear();
    for (const [k, v] of next) data.set(k, v);
    if (changed.length) notify(changed);
  }

  addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== host || !m || m.bridge !== TAG) return;
    if (m.op === 'changed') return replace(m.entries);
    const p = pending.get(m.re);
    if (!p) return;
    pending.delete(m.re);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else p.reject(Object.assign(new Error(m.error), { retry: m.retry === true }));
  });

  // Typing here never reaches Citadel's own document, which waits for a quiet moment before it loads a new
  // front end (and with it this frame, afresh): tell the viewer, at most once a second (#821).
  let typedAt = 0;
  const typing = () => {
    if (!host || Date.now() - typedAt < 1000) return;
    typedAt = Date.now();
    host.postMessage({ bridge: TAG, id: ++seq, op: 'typing', page: cfg.page }, '*');
  };
  addEventListener('input', typing, true);
  addEventListener('keydown', typing, true);

  // localStorage kept in the page's store (`localStorage/<key>`); sessionStorage only for this page's life.
  function storageShim(prefix) {
    const mem = new Map();
    const keys = () => (prefix ? [...data.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)) : [...mem.keys()]);
    const get = (k) => {
      const v = prefix ? data.get(prefix + k) : mem.get(String(k));
      return v === undefined ? null : String(v);
    };
    const set = (k, v) => (prefix ? write(prefix + k, String(v)).catch(warn) : mem.set(String(k), String(v)));
    const del = (k) => (prefix ? write(prefix + k, undefined).catch(warn) : mem.delete(String(k)));
    const api = {
      getItem: (k) => get(k),
      setItem: (k, v) => void set(k, v),
      removeItem: (k) => void del(k),
      clear: () => keys().forEach(del),
      key: (i) => keys()[i] ?? null,
      get length() { return keys().length; },
    };
    // Like the real thing, `localStorage.x` and `localStorage.x = 1` work too.
    return new Proxy(api, {
      get: (t, p) => (typeof p === 'symbol' || p in t ? Reflect.get(t, p) : get(p) ?? undefined),
      set: (t, p, v) => (typeof p === 'symbol' || p in t ? Reflect.set(t, p, v) : (set(p, v), true)),
      deleteProperty: (t, p) => (del(p), true),
      has: (t, p) => p in t || get(p) !== null,
      ownKeys: () => keys(),
      getOwnPropertyDescriptor: (t, p) => (get(p) === null ? undefined : { value: get(p), enumerable: true, configurable: true, writable: true }),
    });
  }
  for (const [name, prefix] of [['localStorage', 'localStorage/'], ['sessionStorage', '']]) {
    try {
      void window[name];
    } catch {
      Object.defineProperty(window, name, { configurable: true, enumerable: true, value: storageShim(prefix) });
    }
  }

  // claude.ai's artifact database, Firestore-like: each doc is the key `db/<collection>/<doc>`.
  const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
  const docSnap = (key, id) => {
    const v = data.get(key);
    return { id, exists: v !== undefined, data: () => clone(v) };
  };
  function collection(name) {
    const pre = `db/${name}/`;
    const query = () => {
      const docs = [...data.keys()].filter((k) => k.startsWith(pre)).map((k) => docSnap(k, k.slice(pre.length)));
      return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
    };
    const doc = (id = randomId()) => {
      const key = pre + id;
      return {
        id: String(id),
        get: async () => docSnap(key, String(id)),
        set: async (v, opts) => void await write(key, opts?.merge ? { ...data.get(key), ...v } : v),
        update: async (patch) => void await write(key, { ...data.get(key), ...patch }),
        delete: async () => void await write(key, undefined),
        onSnapshot: (fn) => watch(key, () => fn(docSnap(key, String(id)))),
      };
    };
    return {
      id: String(name),
      doc,
      add: async (v) => {
        const d = doc();
        await d.set(v);
        return d;
      },
      get: async () => query(),
      onSnapshot: (fn) => watch(pre, () => fn(query()), true),
    };
  }
  const db = { collection };
  if (window.claude === undefined) {
    window.claude = {
      // Only the database: a page reading the scheme's files or calling tools is past what a page should do.
      use: async (what) => (what === 'db' && (await ready) ? db : null),
      complete: () => Promise.reject(new Error('window.claude.complete is not available in Citadel')),
    };
  }

  // claude.ai's persistent storage: `storage/<key>`. Everything here is shared, so `shared` is always true.
  const ST = 'storage/';
  if (window.storage === undefined) {
    window.storage = {
      get: async (key) => (data.has(ST + key) ? { key, value: clone(data.get(ST + key)), shared: true } : null),
      set: async (key, value) => (await write(ST + key, value), { key, value, shared: true }),
      delete: async (key) => (await write(ST + key, undefined), { key, deleted: true, shared: true }),
      list: async (prefix = '') => ({ keys: [...data.keys()].filter((k) => k.startsWith(ST + prefix)).map((k) => k.slice(ST.length)), prefix, shared: true }),
    };
  }

  window.citadel = {
    /** Resolves true once the viewer answers, false when the page is open on its own. */
    ready,
    info: async () => ((await ready) ? { ...info } : null),
    storage: {
      get: async (key) => clone(data.get(key)) ?? null,
      set: (key, value) => write(String(key), value),
      delete: (key) => write(String(key), undefined),
      list: async (prefix = '') => [...data.keys()].filter((k) => k.startsWith(prefix)),
      watch: (fn) => watch('', () => fn(), true),
    },
    /** 'saved', 'saving' or 'retrying' (Citadel is down or restarting, and it is sent again until it lands). */
    saveState: () => saveState,
    /** Call `fn(state)` now and on each change of saveState; returns the unwatch. */
    watchSaves: (fn) => {
      saveWatchers.add(fn);
      fn(saveState);
      return () => saveWatchers.delete(fn);
    },
    /**
     * Send `text` to the minion that showed this page (a shared page: the one that linked it, else the
     * Taskmaster), as the person, from a click or key press only. Resolves { sent: true, to: '#N' }.
     * In Citadel's viewer a sent page closes, showing the chat; `keepOpen: true` leaves it open (a page that sends
     * several times on purpose).
     */
    send: async (text, { images, keepOpen, items } = {}) => {
      // A click in a tab never reaches the viewer, so the page checks it here too: a page never sends by itself.
      if (navigator.userActivation && !navigator.userActivation.isActive) throw new Error('citadel.send works only from a click or key press');
      if (!(await ready)) throw new Error(NO_VIEWER);
      // `images`: marked pictures from draw ({ mediaType, data }), at most 6; they take longer to post.
      // `items`: the page's pick items ({ collection, id, title, label }), for the scheme's ideas ledger (#1150).
      const extra = { ...(keepOpen ? { keepOpen: true } : {}), ...(Array.isArray(items) && items.length ? { items } : {}) };
      const r = images?.length ? await request('send', { text: String(text), images, ...extra }, 60000) : await request('send', { text: String(text), ...extra });
      // Pages made before #417 (kit v1, hand-rolled ones) then say the text waits in the comment box; it was sent.
      setTimeout(() => {
        const walk = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue.trim().startsWith('In the comment box')) n.nodeValue = `Sent to ${r.to}.`;
      });
      return r;
    },
    /**
     * Open one of this page's pictures (`src`, from its own files) in Citadel to draw on, from a click. Resolves
     * null when closed unchanged, { marked: false } when every mark was taken off, or { marked: true, mediaType,
     * data } (base64), ready for send's images. Only in Citadel's viewer: info().draw says whether it can.
     */
    draw: async (src) => {
      if (navigator.userActivation && !navigator.userActivation.isActive) throw new Error('citadel.draw works only from a click or key press');
      if (!(await ready)) throw new Error(NO_VIEWER);
      // Drawing takes as long as it takes: an hour before the page gives up on an answer.
      return request('draw', { src: new URL(String(src), document.baseURI).href }, 3600000);
    },
  };

  // A link to another site would load inside this frame, where Citadel can't show it: open it in a tab.
  addEventListener('click', (e) => {
    const a = e.target?.closest?.('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || !['', '_self', '_top', '_parent'].includes(a.getAttribute('target') ?? '')) return;
    let url;
    try {
      url = new URL(a.getAttribute('href'), document.baseURI);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || url.origin === location.origin) return;
    e.preventDefault();
    const tab = () => window.open(url.href, '_blank', 'noopener');
    // The viewer opens it in Firefox when the person's device is set to (#988); else, or if it doesn't answer, a tab.
    (host ? ready.then((ok) => (ok ? request('link', { url: url.href }, 3000) : Promise.reject())) : Promise.reject()).then((r) => r.opened || tab(), tab);
  });
})
