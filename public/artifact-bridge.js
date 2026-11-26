// The artifact bridge, page side (#168). The server inlines this function as the first script of every
// HTML page it serves under a file token, called with what the page saved (`cfg.entries`) and the token
// path it was served under (`cfg.page`). It gives the page:
// - `citadel`: storage for this page, `send(text, { images })`, which sends text to the minion that showed
//   the page, as the person who clicked (#417), and `draw(src)`, which opens one of its pictures to draw on (#946);
// - `window.claude.use('db')`, `window.storage` and a working `localStorage`, the claude.ai APIs Delve's
//   pages were written for (the sandbox makes the real localStorage throw).
// It talks only to the viewer that framed it, or the Citadel tab whose Open button opened it
// (public/bridge-host.js); opened any other way, saved values still show but nothing new is kept or sent.
/** @typedef {{ key: string, value: unknown }} Entry */
/** What the viewer answers with: a hello (who is looking), a read (entries) or a send (who it went to); each caller reads only its own part. @typedef {{ person?: string, file?: string, owner?: string | null, draw?: boolean, entries: Entry[], to: string }} Answer */
/** The globals this page script adds for the page. @typedef {Window & typeof globalThis & { claude?: unknown, storage?: unknown, citadel?: unknown }} PageWindow */
/** @typedef {{ resolve: (value: Answer) => void, reject: (reason: unknown) => void, acked: boolean, onAck?: (known?: Answer) => void, timer?: ReturnType<typeof setTimeout> }} Pending */
/** @type {(cfg: { entries: Entry[], page: string }) => void} */
// biome-ignore format: the server slices this file from the start of the function below (src/artifact-data.ts), and the formatter would move it
(function (cfg) {
  'use strict';
  const TAG = 'citadel-bridge-1';
  const NO_VIEWER = "This tab isn't connected to Citadel: open the page from Citadel (its viewer or its Open button)";
  const host = window.parent !== window ? window.parent : window.opener;
  /** @param {unknown} v */
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const data = new Map(cfg.entries.map((e) => [e.key, e.value]));

  // Requests to the viewer, answered by id. Ids start anywhere, so an answer meant for this frame before it
  // reloaded is never taken for one of this page's. The viewer also says at once that it has a request (`ack`): past the
  // limit one it has is asked after (`alive`) rather than given up on, so Citadel being slow never reads as a
  // viewer that is gone, and nothing is sent beside a copy still on its way (#1862).
  /** @type {Map<number, Pending>} */
  const pending = new Map();
  let seq = Math.floor(Math.random() * 1e9);
  let heard = false; // the viewer has spoken to this page
  /**
   * @param {string} op @param {Record<string, unknown>} [extra] @param {number} [ms]
   * @param {{ onAck?: (known?: Answer) => void, onLate?: () => void }} [hooks]
   * @returns {Promise<Answer>}
   */
  function request(op, extra, ms = 15000, { onAck, onLate } = {}) {
    return new Promise((/** @type {(value: Answer) => void} */ resolve, reject) => {
      if (!host) return reject(new Error(NO_VIEWER));
      const id = ++seq;
      /** @param {Record<string, unknown>} m */
      const post = (m) => host.postMessage({ bridge: TAG, id, page: cfg.page, ...m }, '*');
      /** @type {Pending} */
      const p = { resolve, reject, acked: false, onAck };
      const late = () => {
        if (p.acked) {
          onLate?.();
          p.acked = false;
          p.timer = setTimeout(late, Math.min(ms, 15000));
          return post({ op: 'alive' });
        }
        pending.delete(id);
        if (op !== 'hello') cutOff();
        reject(new Error(op === 'hello' ? NO_VIEWER : 'Citadel did not answer'));
      };
      p.timer = setTimeout(late, ms);
      pending.set(id, p);
      post({ op, ...extra });
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

  // Who is looking and who made the page, once the viewer answers; false when there is no viewer. A viewer that
  // can't reach Citadel (it is down or restarting) says who all the same, so the page opens on what it was served
  // with and takes picks; its writes wait for `joined`, the hello that lands, tried as often as a write is (#1862).
  /** @type {{ person?: string, file?: string, owner?: string | null, draw: boolean } | null} */
  let info = null;
  let joining = false; // the viewer is there, Citadel isn't yet
  /** @type {(value: boolean) => void} */
  let opened;
  /** @type {Promise<boolean>} */
  const early = new Promise((r) => (opened = r));
  /** @param {Answer} r */
  const open = (r) => {
    info = { person: r.person, file: r.file, owner: r.owner, draw: !!r.draw };
    opened(true);
  };
  /** @returns {Promise<Answer>} */
  async function hello() {
    /** @type {Answer | null} */
    let known = null;
    const meanwhile = () => {
      joining = true;
      if (known) open(known);
      saves();
    };
    let tries = 2;
    for (let gap = 1000; ; gap = Math.min(gap * 2, 15000)) {
      try {
        return await request('hello', {}, 5000, { onAck: (k) => (known = k ?? known), onLate: meanwhile });
      } catch (err) {
        if (!(/** @type {{ retry?: boolean }} */ (err).retry)) {
          if (!--tries) throw err;
          continue;
        }
        meanwhile();
        await new Promise((r) => setTimeout(r, gap));
      }
    }
  }
  const joined = host
    ? hello().then(
        (r) => {
          joining = false;
          open(r);
          replace(r.entries);
          saves();
          return true;
        },
        () => {
          joining = false;
          saves();
          return false;
        },
      )
    : Promise.resolve(false);
  const ready = Promise.race([early, joined]);

  // Watchers of keys (`key`) or of every key under a prefix (`prefix`), told after any change.
  /** @type {Set<{ key: string, fn: () => void, prefix: boolean }>} */
  const watchers = new Set();
  /** @param {string[]} keys */
  function notify(keys) {
    for (const w of watchers) if (keys.some((k) => (w.prefix ? k.startsWith(w.key) : k === w.key))) w.fn();
  }
  /** @param {string} key @param {() => void} fn @param {boolean} [prefix] */
  function watch(key, fn, prefix = false) {
    const w = { key, fn, prefix };
    watchers.add(w);
    setTimeout(() => watchers.has(w) && fn());
    return () => watchers.delete(w);
  }

  // Writes: applied here at once, sent to the viewer at most every 100 ms with each key's latest value,
  // so a slider moving fast stays under the viewer's 20 writes a second and its last value always lands.
  /** @type {Map<string, unknown>} */
  let queue = new Map();
  /** @type {Promise<void> | null} */
  let flushing = null;
  // The last flush's requests: the next waits for them, so a later value never reaches the server first.
  let sending = Promise.resolve();
  // Flushed but not yet answered: a refresh meanwhile keeps them on top, as it does the queue.
  /** @type {Map<string, unknown>} */
  const inFlight = new Map();
  // Refused for good, with what the page shows and why (#1940): on top of refreshes too, and not saved until its key lands.
  /** @type {Map<string, { value: unknown, why: string }>} */
  const refused = new Map();
  const refusedWhy = () => [...refused.values()].at(-1)?.why;
  /** @param {string} key @param {unknown} value */
  function write(key, value) {
    // null (NaN and the like clone to it) is the wire's delete, so it deletes here too.
    const v = value === undefined ? undefined : (clone(value) ?? undefined);
    if (v === undefined) data.delete(key);
    else data.set(key, v);
    notify([key]);
    queue.set(key, v === undefined ? null : v);
    flushing ??= new Promise((r) => setTimeout(r, 100)).then(() => {
      const entries = [...queue].map(([k, val]) => ({ key: k, value: val }));
      queue = new Map();
      flushing = null;
      for (const e of entries) inFlight.set(e.key, e.value);
      const left = [...entries];
      sending = sending
        .catch(() => {})
        .then(async () => {
          if (!(await joined)) {
            if (heard) cutOff(); // a viewer is there but won't keep this page's changes; with none, the page says so itself
            throw new Error(NO_VIEWER);
          }
          while (left.length) {
            await keep(left.slice(0, 100));
            for (const e of left.splice(0, 100)) refused.delete(e.key);
          }
        })
        .catch((err) => {
          for (const e of left) refused.set(e.key, { value: e.value, why: err.message });
          throw err;
        })
        .finally(() => {
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
  /** @param {Entry[]} entries */
  async function keep(entries) {
    for (let gap = 1000; ; gap = Math.min(gap * 2, 15000)) {
      try {
        await request('write', { entries });
        retrying = false;
        return;
      } catch (err) {
        if (!(/** @type {{ retry?: boolean }} */ (err).retry)) {
          retrying = false;
          throw err;
        }
        retrying = true;
        saves();
        await new Promise((r) => setTimeout(r, gap));
      }
    }
  }

  // Whether what the page shows is saved (#821): 'saved', 'saving' (on its way), 'retrying' (Citadel is
  // down or restarting; it is sent again until it lands) or 'failed' (refused, #1940). Watchers hear each change, and why it failed.
  /** @type {Set<(state: string, why?: string) => void>} */
  const saveWatchers = new Set();
  let saveState = 'saved';
  const nowSaving = () => {
    const busy = queue.size || inFlight.size || flushing;
    return retrying || (joining && busy) ? 'retrying' : busy ? 'saving' : refused.size ? 'failed' : 'saved';
  };
  function saves() {
    const s = nowSaving();
    if (s === saveState) return;
    saveState = s;
    for (const fn of saveWatchers) fn(s, s === 'failed' ? refusedWhy() : undefined);
  }
  let warned = false;
  /** @param {Error} err */
  const warn = (err) => {
    if (!warned) console.warn(`Citadel: ${err.message}`);
    warned = true;
  };

  // The store as the server has it now (another person's or an agent's write); writes not yet sent or answered stay on top.
  /** @param {Entry[]} entries */
  function replace(entries) {
    const next = new Map(entries.map((e) => [e.key, e.value]));
    // One the server has after all (its answer was lost) is saved.
    for (const [k, { value }] of refused) if (JSON.stringify(next.get(k) ?? null) === JSON.stringify(value)) refused.delete(k);
    for (const [k, v] of [...[...refused].map(([k, { value }]) => /** @type {[string, unknown]} */ ([k, value])), ...inFlight, ...queue]) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    const changed = [...new Set([...data.keys(), ...next.keys()])].filter((k) => JSON.stringify(data.get(k)) !== JSON.stringify(next.get(k)));
    data.clear();
    for (const [k, v] of next) data.set(k, v);
    if (changed.length) notify(changed);
    saves();
  }

  addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== host || !m || m.bridge !== TAG) return;
    heard = true;
    if (m.op === 'changed') return replace(m.entries);
    const acked = pending.get(m.ack);
    if (acked) {
      acked.acked = true;
      acked.onAck?.(m.known);
      return;
    }
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
  /** @param {string} prefix */
  function storageShim(prefix) {
    /** @type {Map<string, string>} */
    const mem = new Map();
    const keys = () => (prefix ? [...data.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)) : [...mem.keys()]);
    /** @param {string} k */
    const get = (k) => {
      const v = prefix ? data.get(prefix + k) : mem.get(String(k));
      return v === undefined ? null : String(v);
    };
    /** @param {string} k @param {unknown} v */
    const set = (k, v) => (prefix ? write(prefix + k, String(v)).catch(warn) : mem.set(String(k), String(v)));
    /** @param {string} k */
    const del = (k) => (prefix ? write(prefix + k, undefined).catch(warn) : mem.delete(String(k)));
    const api = {
      getItem: (/** @type {string} */ k) => get(k),
      setItem: (/** @type {string} */ k, /** @type {unknown} */ v) => void set(k, v),
      removeItem: (/** @type {string} */ k) => void del(k),
      clear: () => keys().forEach(del),
      key: (/** @type {number} */ i) => keys()[i] ?? null,
      get length() {
        return keys().length;
      },
    };
    // Like the real thing, `localStorage.x` and `localStorage.x = 1` work too.
    return new Proxy(api, {
      get: (t, p) => (typeof p === 'symbol' || p in t ? Reflect.get(t, p) : (get(p) ?? undefined)),
      set: (t, p, v) => (typeof p === 'symbol' || p in t ? Reflect.set(t, p, v) : (set(p, v), true)),
      deleteProperty: (t, p) => (del(/** @type {string} */ (p)), true),
      has: (t, p) => p in t || get(/** @type {string} */ (p)) !== null,
      ownKeys: () => keys(),
      getOwnPropertyDescriptor: (t, p) => (get(/** @type {string} */ (p)) === null ? undefined : { value: get(/** @type {string} */ (p)), enumerable: true, configurable: true, writable: true }),
    });
  }
  for (const [name, prefix] of /** @type {['localStorage' | 'sessionStorage', string][]} */ ([
    ['localStorage', 'localStorage/'],
    ['sessionStorage', ''],
  ])) {
    try {
      void window[name];
    } catch {
      Object.defineProperty(window, name, { configurable: true, enumerable: true, value: storageShim(prefix) });
    }
  }

  // claude.ai's artifact database, Firestore-like: each doc is the key `db/<collection>/<doc>`.
  const randomId = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(36).padStart(2, '0'))
      .join('')
      .slice(0, 20);
  /** @param {string} key @param {string} id */
  const docSnap = (key, id) => {
    const v = data.get(key);
    return { id, exists: v !== undefined, data: () => clone(v) };
  };
  /** @param {string} name */
  function collection(name) {
    const pre = `db/${name}/`;
    const query = () => {
      const docs = [...data.keys()].filter((k) => k.startsWith(pre)).map((k) => docSnap(k, k.slice(pre.length)));
      return { docs, size: docs.length, empty: !docs.length, forEach: (/** @type {(doc: (typeof docs)[number]) => void} */ f) => docs.forEach(f) };
    };
    /** @param {string | number} [id] */
    const doc = (id = randomId()) => {
      const key = pre + id;
      return {
        id: String(id),
        get: async () => docSnap(key, String(id)),
        /** @param {unknown} v @param {{ merge?: boolean }} [opts] */
        set: async (v, opts) => void (await write(key, opts?.merge ? { .../** @type {Record<string, unknown>} */ (data.get(key)), .../** @type {Record<string, unknown>} */ (v) } : v)),
        update: async (/** @type {Record<string, unknown>} */ patch) => void (await write(key, { .../** @type {Record<string, unknown>} */ (data.get(key)), ...patch })),
        delete: async () => void (await write(key, undefined)),
        onSnapshot: (/** @type {(snap: ReturnType<typeof docSnap>) => void} */ fn) => watch(key, () => fn(docSnap(key, String(id)))),
      };
    };
    return {
      id: String(name),
      doc,
      add: async (/** @type {unknown} */ v) => {
        const d = doc();
        await d.set(v);
        return d;
      },
      get: async () => query(),
      onSnapshot: (/** @type {(snap: ReturnType<typeof query>) => void} */ fn) => watch(pre, () => fn(query()), true),
    };
  }
  const db = { collection };
  if (/** @type {PageWindow} */ (window).claude === undefined) {
    /** @type {PageWindow} */ (window).claude = {
      // Only the database: a page reading the scheme's files or calling tools is past what a page should do.
      use: async (/** @type {string} */ what) => (what === 'db' && (await ready) ? db : null),
      complete: () => Promise.reject(new Error('window.claude.complete is not available in Citadel')),
    };
  }

  // claude.ai's persistent storage: `storage/<key>`. Everything here is shared, so `shared` is always true.
  const ST = 'storage/';
  if (/** @type {PageWindow} */ (window).storage === undefined) {
    /** @type {PageWindow} */ (window).storage = {
      get: async (/** @type {string} */ key) => (data.has(ST + key) ? { key, value: clone(data.get(ST + key)), shared: true } : null),
      set: async (/** @type {string} */ key, /** @type {unknown} */ value) => (await write(ST + key, value), { key, value, shared: true }),
      delete: async (/** @type {string} */ key) => (await write(ST + key, undefined), { key, deleted: true, shared: true }),
      list: async (prefix = '') => ({ keys: [...data.keys()].filter((k) => k.startsWith(ST + prefix)).map((k) => k.slice(ST.length)), prefix, shared: true }),
    };
  }

  /** @type {PageWindow} */ (window).citadel = {
    /** Resolves true once the viewer answers, false when the page is open on its own. */
    ready,
    info: async () => ((await ready) ? { ...info } : null),
    storage: {
      get: async (/** @type {string} */ key) => clone(data.get(key)) ?? null,
      set: (/** @type {unknown} */ key, /** @type {unknown} */ value) => write(String(key), value),
      delete: (/** @type {unknown} */ key) => write(String(key), undefined),
      list: async (prefix = '') => [...data.keys()].filter((k) => k.startsWith(prefix)),
      watch: (/** @type {() => void} */ fn) => watch('', () => fn(), true),
    },
    /** 'saved', 'saving', 'retrying' (Citadel is down or restarting, and it is sent again until it lands) or 'failed' (refused, and not sent again). */
    saveState: () => saveState,
    /** Call `fn(state, why)` now and on each change of saveState (`why`: a 'failed' one's reason); returns the unwatch. */
    watchSaves: (/** @type {(state: string, why?: string) => void} */ fn) => {
      saveWatchers.add(fn);
      fn(saveState, saveState === 'failed' ? refusedWhy() : undefined);
      return () => saveWatchers.delete(fn);
    },
    /**
     * Send `text` to the minion that showed this page (a shared page: the one that linked it, else the
     * Taskmaster), as the person, from a click or key press only. Resolves { sent: true, to: '#N' }.
     * In Citadel's viewer a sent page closes, showing the chat; `keepOpen: true` leaves it open (a page that sends
     * several times on purpose).
     */
    send: async (/** @type {unknown} */ text, /** @type {{ images?: unknown[], keepOpen?: boolean, items?: unknown[] }} */ { images, keepOpen, items } = {}) => {
      // A click in a tab never reaches the viewer, so the page checks it here too: a page never sends by itself.
      if (navigator.userActivation && !navigator.userActivation.isActive) throw new Error('citadel.send works only from a click or key press');
      if (!(await ready)) throw new Error(NO_VIEWER);
      // `images`: marked pictures from draw ({ mediaType, data }), at most 6; they take longer to post.
      // `items`: the page's pick items ({ collection, id, title, label }), for the scheme's ideas ledger (#1150).
      const extra = { ...(keepOpen ? { keepOpen: true } : {}), ...(Array.isArray(items) && items.length ? { items } : {}) };
      const r = images?.length ? await request('send', { text: String(text), images, ...extra }, 60000) : await request('send', { text: String(text), ...extra });
      // Once what the page wrote on this answer is stored, the viewer may close (#1940): not with something refused.
      setTimeout(async () => {
        while (flushing || inFlight.size) await (flushing ?? sending).catch(() => {});
        host.postMessage({ bridge: TAG, id: ++seq, op: 'kept', page: cfg.page, all: !refused.size }, '*');
      });
      // Pages made before #417 (kit v1, hand-rolled ones) then say the text waits in the comment box; it was sent.
      setTimeout(() => {
        const walk = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) if (/** @type {string} */ (n.nodeValue).trim().startsWith('In the comment box')) n.nodeValue = `Sent to ${r.to}.`;
      });
      return r;
    },
    /**
     * Open one of this page's pictures (`src`, from its own files) in Citadel to draw on, from a click. Resolves
     * null when closed unchanged, { marked: false } when every mark was taken off, or { marked: true, mediaType,
     * data } (base64), ready for send's images. Only in Citadel's viewer: info().draw says whether it can.
     */
    draw: async (/** @type {unknown} */ src) => {
      if (navigator.userActivation && !navigator.userActivation.isActive) throw new Error('citadel.draw works only from a click or key press');
      if (!(await ready)) throw new Error(NO_VIEWER);
      // Drawing takes as long as it takes: an hour before the page gives up on an answer.
      return request('draw', { src: new URL(String(src), document.baseURI).href }, 3600000);
    },
  };

  // A link to another site would load inside this frame, where Citadel can't show it: open it in a tab.
  addEventListener('click', (e) => {
    const a = /** @type {Element | null} */ (e.target)?.closest?.('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || !['', '_self', '_top', '_parent'].includes(a.getAttribute('target') ?? '')) return;
    let url;
    try {
      url = new URL(/** @type {string} */ (a.getAttribute('href')), document.baseURI);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || url.origin === location.origin) return;
    e.preventDefault();
    window.open(url.href, '_blank', 'noopener');
  });
});
