// The base every module needs: who is signed in and what is on screen, the API and DOM helpers,
// file, path and name helpers and the type and state tables. It touches no document at load and
// imports no view, so node tests can import it; the app shell (router, stream, login) is core.js.
import { setAvatars } from './avatars.js';
import { iconSrc } from './schemes.js';

/** @type {Record<string, string>} */
const STATUS_LABEL = { running: 'Running', idle: 'Idle', new: 'Starting', error: 'Error', closed: 'Dismissed' };
// Thread naming and the threads list follow Delve's Custom view: threads are grouped by their `type`
// property, and each is one compact row of number + short ask, a state, and a terse note.
// In the list's order; `other` has no header word, as a minion of no particular kind.
/** @type {Record<string, { label?: string, section: string }>} */
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
/** A scheme's promoted list groups, "key: value" each (#253). @param {{ list_groups?: string | null } | null | undefined} p @returns {string[]} */
export function listGroupsOf(p) {
  try {
    return JSON.parse(p?.list_groups || '[]');
  } catch {
    return [];
  }
}
export const STATES = {
  ready: { label: 'Pending review' },
  complete: { label: 'Done, read it' },
  try: { label: 'Ready to try' },
  parked: { label: 'Sealed' },
  blocked: { label: 'Blocked on something outside the minion' },
  outside: { label: 'Waiting on work running elsewhere' },
  'pending-deploy': { label: 'Deployed; dismissed once it is live' },
  limited: { label: 'Hit the usage limit; waiting for it to reset' },
};

/** @import { Account, Ticket, View } from './types.js' */

/** A thread as the pages name it: a minion or a Taskmaster, or the parts of one that a file or a row carries. @typedef {{ kind: string, id: number, project_id: number | null, number?: number | null, title?: string, properties?: Ticket['properties'] }} ThreadRef */

/** The signed-in person's name, or null. @type {string | null} */
export let me = null;
/** The signed-in person as api/me gives it. @type {Account | null} */
export let account = null;
/** What is on screen (types.d.ts View), or null between screens. @type {View | null} */
export let view = null;

/** Other modules read `view` live but can't assign it, so they replace it through this. @param {View | null} next */
export function setView(next) {
  view = next;
}
/** `view` for code that only runs while a page is open: throws, as reading a field of null did, when none is. */
export function openView() {
  if (!view) throw new TypeError('no view is open');
  return view;
}
/** Signing in or out: `who` as api/me gives it, or null. @param {Account | null} who */
export function setAccount(who) {
  account = who;
  me = who?.name ?? null;
  setAvatars(who?.avatars);
  if (!who) forgetKept(), forgetHome(), answers.clear(); // signing out leaves nothing of theirs on the device, or for the next to keep
}
// The shell's login page (core.js renderLogin), shown when the server says you're signed out.
let showLogin = () => {};
/** @param {() => void} fn */
export function setShowLogin(fn) {
  showLogin = fn;
}

// ---------- helpers ----------

/**
 * Whether the open chat could be seen: the tab is showing, with no app over the page (frames.js `framed`), and Citadel
 * isn't put away in an app's installed window (rail.js `put-away`). Seen marks, leaving and presence all ask this (#1851).
 */
export const chatInSight = () => document.visibilityState === 'visible' && !document.documentElement.matches('.framed, .put-away');

// GETs on their way, by path: two asks for the same thing in one burst (a scheme's open asks for its properties and
// inbox twice) share one request (#1528). A GET asked after a write, or after any stream news (newsArrived), never
// joins one sent before it, since what it was sent for may have changed meanwhile.
const inflight = new Map();
/** The stream brought news: GETs from here on go to the server afresh (core.js connectStream). */
export const newsArrived = () => inflight.clear();

/** Run `fn` now, or once the tab is next shown while it's hidden: a hidden tab's polls ask for nothing (#1528). @param {() => unknown} fn */
export function whenShown(fn) {
  const doc = globalThis.document;
  if (!doc?.hidden) return void fn();
  doc.addEventListener('visibilitychange', function shown() {
    if (doc.hidden) return;
    doc.removeEventListener('visibilitychange', shown);
    fn();
  });
}
/**
 * Run `build`, which replaces nodes inside `root`, then give the keyboard focus and each inner scroll back to the node in the
 * same place of the new tree (#1922 WP14): a timed redraw otherwise drops them to the body.
 * @param {Element} root @param {() => void} build
 */
export function keepView(root, build) {
  /** @param {Element | null} n @returns {number[] | null} */
  const place = (n) => {
    /** @type {number[]} */
    const path = [];
    for (; n && n !== root; n = /** @type {Element | null} */ (n.parentNode)) path.unshift([.../** @type {Element} */ (n.parentNode).children].indexOf(n)); // a node under root always has a parent
    return n === root ? path : null;
  };
  /** @param {number[]} path @returns {HTMLElement | null | undefined} */
  const at = (path) => /** @type {HTMLElement | null | undefined} */ (path.reduce((/** @type {Element | null | undefined} */ n, i) => n?.children[i], root)); // the nodes this walks are the page's own elements
  const a = /** @type {HTMLElement | null} */ (document.activeElement);
  const focus = a && a !== root && root.contains(a) ? { path: place(a), tag: a.tagName } : null;
  const scrolls = [.../** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('*'))].filter((n) => n.scrollTop || n.scrollLeft).map((n) => /** @type {[number[] | null, number, number, string]} */ ([place(n), n.scrollTop, n.scrollLeft, n.tagName]));
  build();
  for (const [path, top, left, tag] of scrolls) {
    const n = path && at(path);
    if (n && n.tagName === tag) {
      n.scrollTop = top;
      n.scrollLeft = left;
    }
  }
  const n = focus?.path && at(focus.path);
  if (n && n.tagName === focus.tag && n !== document.activeElement) n.focus({ preventScroll: true });
}

/**
 * One poller for a page's refresh loop or a chip set's shared read: `read` runs, then again `every` ms later once the tab
 * is shown (whenShown), never twice at once. A read that returns `false` stops the loop (its element or chips are gone);
 * a throw is the read's own business (catch inside it). `now()` starts a read at once unless one is running or due, so
 * whoever joins while a read runs takes its answer: no second read (#1610).
 * @param {() => unknown} read @param {number} every
 */
export function poller(read, every) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null,
    busy = false;
  const tick = async () => {
    timer = null;
    busy = true;
    let go = true;
    try {
      go = (await read()) !== false;
    } catch {
      /* the next tick asks again */
    }
    busy = false;
    if (go) timer = setTimeout(() => whenShown(tick), every);
  };
  return {
    now() {
      if (!timer && !busy) timer = setTimeout(tick, 0);
    },
  };
}
/**
 * Whether a tab coming back may have missed stream news, so must resync (#1528): it was hidden a minute or more, the
 * browser froze it meanwhile, or the stream said nothing while it was hidden (`heardAt`, its last message: a dead
 * stream can still read OPEN).
 * @param {number} hiddenAt @param {number} heardAt @param {number} now @param {boolean} frozen
 */
export const missedNews = (hiddenAt, heardAt, now, frozen) => frozen || now - hiddenAt >= 60_000 || heardAt < hiddenAt;

/** A read not answered in this long fails, so the page shows its retry instead of loading forever (#2003). */
const GET_MS = 60_000;
// Each request is timed for the slow-load recorder (public/slow-moments.js, #1752), its answer read whole first.
/** @typedef {{ method?: string, body?: unknown }} ApiOpts */
/** @param {string} path @param {ApiOpts} opts */
const send = async (path, opts) => {
  const start = performance.now(),
    timed = (/** @type {Response | null} */ res) => /** @type {{ citadelSlow?: { request(method: string | undefined, path: string, start: number, res: Response | null): void } }} */ (globalThis).citadelSlow?.request(opts.method, path, start, res);
  const signal = opts.method && opts.method !== 'GET' ? undefined : AbortSignal.timeout(GET_MS);
  try {
    for (;;) {
      const res = await fetch(path, {
        signal,
        ...opts,
        headers: opts.body ? { 'Content-Type': 'application/json' } : {},
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const body = await res.json().catch(() => ({}));
      signal?.throwIfAborted(); // cut off while its body came
      // Every reader thread is waiting for the disk (src/front.ts): ask again until the time is up.
      if (signal && res.status === 503 && body.retry) {
        await new Promise((r) => setTimeout(r, 1000));
        if (!signal.aborted) continue;
      }
      timed(res);
      return { res, body };
    }
  } catch (err) {
    timed(null);
    throw signal?.aborted ? new Error('%APP_NAME% took too long to answer: try again in a moment') : err;
  }
};

/** @param {string} path @param {ApiOpts} [opts] */
export async function api(path, opts = {}) {
  const get = !opts.method || opts.method === 'GET';
  if (replay && get) {
    // Opening the kept chat: its answers as they were, and nothing else waits on the network meanwhile.
    if (path in replay.answers) return JSON.parse(replay.answers[path]);
    throw Object.assign(new Error('Catching up'), { status: 0 });
  }
  let sent = get ? inflight.get(path) : null;
  if (!sent) {
    if (!get) inflight.clear();
    sent = send(path, opts);
    if (get) {
      inflight.set(path, sent);
      const done = () => {
        if (inflight.get(path) === sent) inflight.delete(path);
      };
      sent.then(done, done);
    }
  }
  const { res, body } = await sent;
  // A copy for each caller, so callers that share a request can each change what they're given.
  const data = structuredClone(body);
  // A copy, as callers change what they're given; histories are kept from the chat's own page (core.js keepOpenChat).
  if (get && res.ok && !/events/.test(path) && replayable(path)) {
    answers.delete(path); // newest last, so the cap drops the longest unasked
    answers.set(path, JSON.stringify(data));
    if (answers.size > ANSWERS_MAX) answers.delete(answers.keys().next().value);
  }
  if (res.status === 401 && path !== 'api/login') {
    me = null;
    forgetKept();
    answers.clear();
    showLogin();
    throw new Error('Not logged in');
  }
  // Caddy's answer while nothing serves: a restart that outlasted systemd's socket, or a failed one (#493).
  // The status rides on the error, so a caller can tell a restart from a refusal (bridge-host.js, #821).
  if (!res.ok && !data.error && [502, 503, 504].includes(res.status)) throw Object.assign(new Error('%APP_NAME% is restarting, try again in a moment'), { status: res.status });
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

// ---------- the kept chat (#1144) ----------

// The last chat opened, kept on this device so the installed app opens to it at once, marked as catching up,
// while the live answers come (app.js boot). One chat, one person: signing out or a 401 forgets it.
const KEPT = 'cc-last-chat';
const KEPT_CHARS = 1_500_000; // localStorage holds about 5M characters per site, shared with drafts and settings
export const KEPT_EVENTS = 80;
/** Every GET answer this session, newest per path, as text: what a chat's opening asked for. Histories are kept apart. */
const answers = new Map();
const ANSWERS_MAX = 200;
/** Only these can be part of a chat's opening: a search or a filtered list never is. */
/** @param {string} path */
const replayable = (path) => !/\?/.test(path) || /\?tickets=(open|closed)$/.test(path);
/** @type {{ answers: Record<string, string> } | null} */
let replay = null;

/** The answers a cold open of chat `ticketId` in scheme `projectId` asks for, from this session's. @param {number} projectId @param {number} ticketId */
export function keptAnswers(projectId, ticketId) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [path, text] of answers) {
    if (!replayable(path)) continue;
    const p = path.match(/^api\/projects\/(\d+)/)?.[1];
    const t = path.match(/^api\/tickets\/(\d+)/)?.[1];
    if ((p && Number(p) !== projectId) || (t && Number(t) !== ticketId)) continue;
    out[path] = text;
  }
  return out;
}

/** Keep the chat at `hash` with its history (`history`: { path: text }); one too big to keep forgets the last instead. @param {string} hash @param {number} projectId @param {number} ticketId @param {Record<string, string>} history */
export function keepChat(hash, projectId, ticketId, history) {
  if (!account) return;
  const kept = JSON.stringify({ login: account.login, hash, at: Date.now(), me: account, answers: { ...keptAnswers(projectId, ticketId), ...history } });
  try {
    if (kept.length > KEPT_CHARS) throw new Error('too big');
    localStorage.setItem(KEPT, kept);
  } catch {
    forgetKept();
  }
}

/** The kept chat, if this launch (`hash`) opens it: its own address, or the app's start with none. @param {string} hash */
export function keptChat(hash) {
  try {
    const kept = JSON.parse(/** @type {string} */ (localStorage.getItem(KEPT))); // JSON.parse(null) is null, as before
    // The app's start opens Home for someone in two or more schemes (#1140), so a kept chat only reopens at its own address then.
    if (kept?.me && kept.answers && (hash === kept.hash || ((hash === '' || hash === '#/') && !homeFirst()))) return kept;
  } catch {}
  return null;
}

/** Set while the shelf shows the Home line (#1140): the app's start opens Home rather than the kept chat. */
export const HOME_LINE = 'cc-home-line';
const homeFirst = () => {
  try {
    return localStorage.getItem(HOME_LINE) === '1';
  } catch {
    return false;
  }
};

/** Home's cached answer and whether the shelf showed its line (home.js) are theirs too. */
const forgetHome = () => {
  try {
    localStorage.removeItem('cc-home');
    localStorage.removeItem(HOME_LINE);
  } catch {}
};

/** A reload nobody clicked: the next page skips the cold-open splash (Cara, 2026-11-21, "Lets not show the splash screen
 * when the app refreshes automatically"). One-shot, stamped, read and cleared by login-map-art.js. */
export function reloadQuietly() {
  try {
    sessionStorage.setItem('cc-no-splash', String(Date.now()));
  } catch {}
  location.reload();
}

export function forgetKept() {
  try {
    localStorage.removeItem(KEPT);
  } catch {}
}

/** While on, GETs answer from the kept chat's answers only (null turns it off). @param {{ answers: Record<string, string> } | null} kept */
export function replayKept(kept) {
  replay = kept;
}

/** A child h() appends: an element or text, nested lists of them, and null, undefined or false for none. @typedef {Node | string | number | boolean | null | undefined | readonly Child[]} Child */
/**
 * An element: `attrs` are attributes (true for a bare one, null or false for none), `class`, and `on<event>` listeners.
 * @template {keyof HTMLElementTagNameMap} K
 * @overload
 * @param {K} tag
 * @param {Record<string, unknown> | null} [attrs]
 * @param {...Child[]} children
 * @returns {HTMLElementTagNameMap[K]}
 */
/**
 * @overload
 * @param {string} tag
 * @param {Record<string, unknown> | null} [attrs]
 * @param {...Child[]} children
 * @returns {HTMLElement}
 */
/**
 * @param {string} tag
 * @param {Record<string, unknown> | null} [attrs]
 * @param {...Child} children
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), /** @type {EventListener} */ (v));
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of /** @type {unknown[]} */ (children).flat(Infinity)) // Child's own nesting makes flat's type recurse without end, so it is flattened as unknown
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/**
 * An SVG element, as h() makes an HTML one: an `on…` entry is a listener, any other is set as a string; a null
 * or undefined one is left off.
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {...(Node | string)} kids
 */
export function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), /** @type {EventListener} */ (v));
    else el.setAttribute(k, String(v));
  }
  el.append(...kids);
  return el;
}

/** Puts `el`'s looping animation (`ms` per turn) at the page's shared clock, so a redrawn element rejoins its phase instead of restarting (#1532). Set through the CSSOM: the page's CSP blocks a style attribute. */
/** @template {HTMLElement | SVGElement} E @param {E} el @param {number} ms @returns {E} */
export const phase = (el, ms) => {
  el.style.animationDelay = `-${Date.now() % ms}ms`;
  return el;
};

/**
 * A redraw of the sidebar (or Home's list, its own page on a phone, or the Schemes shelf's release rows: #1548) while a pointer is pressed in it waits for the release
 * (#1499): it swaps the pressed row for a new one, the release lands on that, and the click reaches neither link (Cara,
 * 2026-11-21: "it didnt open the minion").
 * A redraw calls this first and returns when it says true; the held ones run once the click has gone through.
 */
let pressedAt = 0;
/** @type {Set<() => void>} */
const held = new Set();
/** @param {() => void} redraw */
export function heldWhilePressed(redraw) {
  if (!pressedAt || performance.now() - pressedAt > 5000) return false; // a press whose release never came holds nothing
  held.add(redraw);
  return true;
}
const release = () => {
  if (!pressedAt) return;
  pressedAt = 0;
  // After the click, which the browser sends right after the pointerup.
  setTimeout(() => {
    const due = [...held];
    held.clear();
    for (const fn of due) fn();
  });
};
globalThis.addEventListener?.(
  'pointerdown',
  (e) => {
    if (e.target instanceof Element && e.target.closest('.sidebar, .home-overview, #schemes-shelf, .time-log')) pressedAt = performance.now();
  },
  true,
);
for (const type of ['pointerup', 'pointercancel']) globalThis.addEventListener?.(type, release, true);
globalThis.addEventListener?.('blur', release); // the window's own, not captured: a press moves focus, and that blur mustn't count

/**
 * Attributes for a search or filter box so no browser or password manager fills it (#934: a person's name
 * landed in Find in chat unasked). Chromium's address autofill and the managers ignore autocomplete=off, so the
 * token is one nothing recognises (a password field gets new-password, which stops a saved login being filled), the name is neutral, and each manager's own opt-out is set.
 */
/** @param {string} name @param {string} [token] */
export const noAutofill = (name, token = 'nope') => ({ autocomplete: token, name, 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other' });

/**
 * A scheme's favicon (#222), only ever as an <img> (an SVG there can't run scripts); hidden when it has
 * none, so refreshSchemeCounts can swap it in once a merge brings one.
 * @param {(Parameters<typeof iconSrc>[0] & { id: number }) | null} scheme Never null at runtime: its callers check first (releases.js iconOf looks the scheme up twice, so tsc can't see it).
 */
export function schemeIcon(scheme) {
  const p = /** @type {Parameters<typeof iconSrc>[0] & { id: number }} */ (scheme);
  const src = iconSrc(p);
  const img = h('img', {
    class: 'scheme-icon',
    'data-scheme-icon': p.id,
    src,
    alt: '',
    hidden: !src,
    onerror: () => {
      img.hidden = true;
    },
  });
  return img;
}

const ICONS = {
  back: 'M10.25 3.5 5.75 8l4.5 4.5',
  forward: 'M5.75 3.5 10.25 8l-4.5 4.5',
  close: 'M4 4l8 8M12 4l-8 8',
  pin: 'M5.5 2.5h5M6.5 2.5v4l-2 3h7l-2-3v-4M8 9.5V14',
  tag: 'M2.5 2.5h5l6 6-5 5-6-6zM5.25 5.25h.01',
  // Settings' side menu and rows (#995)
  shield: 'M8 1.8 13 3.6v4c0 3-2.2 5.4-5 6.6-2.8-1.2-5-3.6-5-6.6v-4zM5.8 8l1.5 1.5L10.4 6.4',
  plug: 'M6 1.8v3M10 1.8v3M4.2 4.8h7.6v2.6a3.8 3.8 0 0 1-7.6 0zM8 11.2v3',
  plugplus: 'M6 1.8v3M10 1.8v3M4.2 4.8h7.6v2a3.8 3.8 0 0 1-3.8 3.8M8 10.6v1M11.5 11v4M9.5 13h4',
  rows: 'M2.5 3.5h11M2.5 8h11M2.5 12.5h7',
  bell: 'M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3zM6.6 13.5a1.6 1.6 0 0 0 2.8 0',
  belloff: 'M4 11.5V7a4 4 0 0 1 6.5-3.1M12 7v4.5H5.5M6.6 13.5a1.6 1.6 0 0 0 2.8 0M2 2l12 12',
  eye: 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8zM6 8a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
  doc: 'M4 1.8h5.2L12 4.6v9.6H4zM6 7.5h4M6 10h4',
  users: 'M3.7 5.5a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0 -4.6 0M1.8 13.5c.5-2.4 2.2-3.8 4.2-3.8s3.7 1.4 4.2 3.8M9.5 5.8a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0M11.2 9.7c1.6.1 2.6 1.3 3 3.3',
  user: 'M5.2 5.5a2.8 2.8 0 1 0 5.6 0a2.8 2.8 0 1 0 -5.6 0M2.8 14c.6-2.8 2.7-4.4 5.2-4.4s4.6 1.6 5.2 4.4',
  pen: 'M10.5 2.5 13.5 5.5 5.5 13.5H2.5V10.5z',
  monitor: 'M1.8 2.5h12.4v8.5h-12.4zM5.5 14h5M8 11v3',
  chart: 'M2.5 13.5h11M4.5 11V7.5M8 11V4M11.5 11V8.5',
  globe: 'M1.8 8a6.2 6.2 0 1 0 12.4 0a6.2 6.2 0 1 0 -12.4 0M1.8 8h12.4M8 1.8c1.8 2 2.6 4 2.6 6.2S9.8 12.2 8 14.2C6.2 12.2 5.4 10.2 5.4 8S6.2 3.8 8 1.8z',
  people: 'M3 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M9 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M1.5 12.5c.4-2 1.7-3.2 3.5-3.2S8 10.5 8.5 12.5M7.5 12.5c.4-2 1.7-3.2 3.5-3.2s3.1 1.2 3.5 3.2',
  box: 'M8 1.8 14 5v6L8 14.2 2 11V5zM2 5l6 3.2L14 5M8 8.2v6',
  key: 'M2 10.5a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M7.2 8.3l6-6M11 4.5l1.5 1.5',
  spark: 'M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2.1 2.1M10.5 10.5l2.1 2.1M3.4 12.6l2.1-2.1M10.5 5.5l2.1-2.1',
  branch: 'M2.9 3.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0M2.9 12.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0M9.9 5.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0M4.5 5.1v5.8M11.5 7.1c0 2.4-3 2.4-5.8 4',
  lock: 'M3 7h10v7h-10zM5.2 7V5a2.8 2.8 0 0 1 5.6 0v2',
  vault: 'M2 2.5h12v11h-12zM5.6 8a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0 -4.8 0M8 5.6V4.4M10.4 8h1.2',
  check: 'm3 8.5 3.2 3L13 4.5',
};
/** A line icon in the text colour. Drawn on its own centre, so it sits dead centre in its button, as a font's glyph doesn't. @param {string | undefined} name */
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', /** @type {Record<string, string>} */ (ICONS)[/** @type {string} */ (name)]);
  svg.append(path);
  return svg;
}

/**
 * In the desktop app (#637) the window controls sit on the page's theme colour (index.html's metas), so a
 * contraption's top bar colours them (frames.js, with its computed background colour); null puts the plain colour back.
 * A canvas pixel turns any CSS colour into the hex a theme colour surely takes; a see-through one keeps the plain colour (#694).
 * `over`, a modal's backdrop (#772), is laid over the colour, so the controls dim with the page under it.
 */
/** @type {CanvasRenderingContext2D | null} */
let pixel = null;
/** @param {string | null | undefined} color @param {string} [over] */
export function tintTitleBar(color, over) {
  for (const m of /** @type {NodeListOf<HTMLMetaElement>} */ (document.querySelectorAll('meta[name=theme-color][media*=window-controls-overlay]'))) {
    m.dataset.base ??= m.content;
    if (!color || !matchMedia(m.media).matches) {
      m.content = m.dataset.base;
      continue;
    }
    pixel ??= /** @type {CanvasRenderingContext2D} */ (h('canvas', { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true })); // a canvas always has a 2d context
    /** @param {string} c */
    const fill = (c) => {
      const px = /** @type {CanvasRenderingContext2D} */ (pixel); // set above before this runs
      px.fillStyle = 'transparent';
      px.fillStyle = c;
      px.fillRect(0, 0, 1, 1);
    };
    pixel.clearRect(0, 0, 1, 1);
    fill(color);
    if (pixel.getImageData(0, 0, 1, 1).data[3] < 255) fill(/** @type {string} */ (m.dataset.base));
    if (over) fill(over);
    const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data;
    m.content = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }
}

/** A cost at API prices, marked as an estimate: "≈ $0.42", "≈ $12". Not a bill on a subscription. @param {number} usd */
export function costText(usd) {
  return `≈ $${usd >= 10 ? Math.round(usd) : usd.toFixed(2)}`;
}

/** @param {number | null | undefined} ms */
export function ago(ms) {
  const s = Math.round((Date.now() - /** @type {number} */ (ms)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * When a minion was dismissed (#1072), in Pacific: "2:14 PM PST" today, "Nov 17" before today; `full` is the date and time for a tooltip.
 * Null when the time isn't known (dismissed before it was kept, and no close note to read it from).
 * @param {number | null | undefined} ms
 */
export function dismissedWhen(ms) {
  if (!ms) return null;
  /** @param {number} t */
  const day = (t) => DAY.format(t);
  /** @param {number} t */
  const year = (t) => day(t).slice(0, 4);
  return {
    short: day(ms) === day(Date.now()) ? TIME.format(ms) : (year(ms) !== year(Date.now()) ? DATE_YEAR : DATE).format(ms),
    full: FULL.format(ms),
  };
}
// Made once: a formatter built per call (toLocaleString) cost a quarter second per redraw of a thousand dismissed rows (#1077).
const PT = { timeZone: 'America/Los_Angeles' };
const DAY = new Intl.DateTimeFormat('en-CA', PT);
/** Today's Pacific date: a dismissed row's stamp changes words when it changes. */
export const todayPacific = () => DAY.format(Date.now());
const TIME = new Intl.DateTimeFormat('en-US', { ...PT, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const DATE = new Intl.DateTimeFormat('en-US', { ...PT, month: 'short', day: 'numeric' });
const DATE_YEAR = new Intl.DateTimeFormat('en-US', { ...PT, month: 'short', day: 'numeric', year: 'numeric' });
const FULL = new Intl.DateTimeFormat('en-US', { ...PT, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

// The one home of Pacific formats on the front end (test/one-pacific.test.ts keeps it that way). Each variant keeps the look its page had.
/** `ms` as its Pacific day, "2026-11-16". */
/** @param {number} ms */
export const pacificIso = (ms) => DAY.format(ms);
/** `ms` as "Nov 16" (a "YYYY-MM-DD" string is read as noon UTC, so it keeps its own day). */
/** @param {number | string | null} ms */
export const pacificDate = (ms) => (typeof ms === 'string' ? new Date(`${ms}T12:00:00Z`) : new Date(/** @type {number} */ (ms))).toLocaleDateString('en-US', { ...PT, month: 'short', day: 'numeric' });
/** `ms` as "Nov 16, 11:00 PM PST". */
/** @param {number | string} ms */
export const pacificStamp = (ms) => new Date(ms).toLocaleString('en-US', { ...PT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
/** `ms` as "11:00 PM PST". */
/** @param {number} ms */
export const pacificClock = (ms) => new Date(ms).toLocaleTimeString('en-US', { ...PT, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
/** `ms` as "11:00 PM", the zone left off for a list whose header names it. */
/** @param {number} ms */
export const pacificClockBare = (ms) => new Date(ms).toLocaleTimeString('en-US', { ...PT, hour: 'numeric', minute: '2-digit' });
/** `ms` as "Mon, 11:30 PM PST". */
/** @param {number} ms */
export const pacificWeekdayClock = (ms) => new Date(ms).toLocaleString('en-US', { ...PT, weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
/** The zone's short name right now, "PST" or "PDT". */
export const pacificZone = () =>
  new Date()
    .toLocaleTimeString('en-US', { ...PT, timeZoneName: 'short' })
    .split(' ')
    .pop();
/** Pacific minutes since midnight at `ms`. @param {number} ms */
export function pacificMinutes(ms) {
  const p = new Intl.DateTimeFormat('en-US', { ...PT, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  return Number(/** @type {Intl.DateTimeFormatPart} */ (p.find((x) => x.type === 'hour')).value) * 60 + Number(/** @type {Intl.DateTimeFormatPart} */ (p.find((x) => x.type === 'minute')).value);
}

// ---------- files threads show ----------

// What the server will serve from a thread's folders, by extension (mirrors src/artifacts.ts).
const FILE_KINDS = {
  md: 'markdown',
  markdown: 'markdown',
  canvas: 'canvas',
  html: 'html',
  htm: 'html',
  pdf: 'pdf',
  txt: 'text',
  csv: 'text',
  js: 'text',
  mjs: 'text',
  css: 'text',
  json: 'text',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  zip: 'download',
  '7z': 'download',
  tar: 'download',
  gz: 'download',
  tgz: 'download',
  apk: 'download',
  xpi: 'download',
  crx: 'download',
};
/** @param {string} path */
export const fileKind = (path) => /** @type {Record<string, string | undefined>} */ (FILE_KINDS)[(path.split(/[?#]/)[0].split('.').pop() || '').toLowerCase()] ?? null;
/** @param {string} path */
export const baseName = (path) => path.split('/').filter(Boolean).pop() ?? path;
/** @param {string} path */
export const fileExt = (path) => (baseName(path).includes('.') ? /** @type {string} */ (baseName(path).split('.').pop()).slice(0, 5).toUpperCase() : 'FILE');
/** A link target that is a path on disk, not a URL, a fragment or a mail address. */
/** @param {string} href */
export const isLocalPath = (href) => !/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href);
/** @param {number | string | undefined} ticketId @param {string | undefined} path (String() writes undefined as encodeURIComponent always did) */
export const fileUrl = (ticketId, path) => `api/tickets/${ticketId}/file?path=${encodeURIComponent(String(path))}`;
/** @param {number | string} ticketId @param {string} path */
export const fileHref = (ticketId, path) => `#/f/${ticketId}/${encodeURIComponent(path)}`;
/** A file people attached to a message, by its name in the thread's uploads folder. */
/** @param {number | string} ticketId @param {string} name */
export const uploadUrl = (ticketId, name) => `api/tickets/${ticketId}/uploads/${encodeURIComponent(name)}`;
/** @param {number} n */
export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
/** @param {number | string} projectId @param {string} path */
export const sharedUrl = (projectId, path) => `api/projects/${projectId}/shared/file?path=${encodeURIComponent(path)}`;
/** @param {number | string} projectId @param {string} path */
export const sharedHref = (projectId, path) => `#/s/${projectId}/${encodeURIComponent(path)}`;
/** A linked path short enough for a card: a thread's shared folder by name, other absolute paths by their tail. */
/** @param {string} path */
export function shortPath(path) {
  const projectShared = /\/shared\/project\/(.+)$/.exec(path);
  if (projectShared) return `scheme shared/${projectShared[1]}`;
  const shared = /\/shared\/\d+\/(.+)$/.exec(path);
  if (shared) return `shared files/${shared[1]}`;
  return path.startsWith('/') ? `…/${path.split('/').slice(-2).join('/')}` : path;
}

/** Resolve `rel` against the folder `dir` (both "/"-separated), as a document's relative links are. @param {string} dir @param {string} rel */
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
/** @returns {Record<string, boolean | undefined>} */
export function loadPanelState() {
  try {
    return JSON.parse(/** @type {string} */ (localStorage.getItem('cc-panels'))) ?? {};
  } catch {
    return {};
  }
}
/** @param {Record<string, boolean | undefined>} state */
export function savePanelState(state) {
  try {
    localStorage.setItem('cc-panels', JSON.stringify(state));
  } catch {}
}

/** A thread you have opened since it last changed. */
/** @param {Pick<Ticket, 'id' | 'updated_at'>} t */
export const isSeen = (t) => {
  const { seen } = /** @type {View} */ (view); // only asked with a scheme open, as before
  return (seen?.[t.id] ?? 0) >= t.updated_at;
};

/** @param {{ kind: string } | null | undefined} t a chat, never null here at runtime: a null throws, as it always did */
export const isCoordinator = (t) => /** @type {{ kind: string }} */ (t).kind === 'coordinator';

/** @param {Pick<Ticket, 'kind' | 'status'>} t */
export function statusLabel(t) {
  if (isCoordinator(t) && t.status === 'new') return 'Ready';
  return STATUS_LABEL[t.status];
}

/**
 * Threads are numbered per project and live at #/p/<project>/t/<number>. A server from before
 * per-project numbers sends no number, so fall back to the global id there.
 */
/** @param {ThreadRef} t */
export const threadHref = (t) => (isCoordinator(t) ? `#/p/${t.project_id}` : t.number == null ? `#/t/${t.id}` : `#/p/${t.project_id}/t/${t.number}`);

/** A link that opens `t`'s chat scrolled to one thing in it (threadrefs.js jumpParts). */
/** @param {ThreadRef | null} t never null at runtime (only asked with a chat open) @param {string | number} target */
export const jumpHref = (t, target) => `${threadHref(/** @type {ThreadRef} */ (t))}?e=${target}`;

/** A scheme's Taskmaster goes by the scheme's name: "Delve Taskmaster". */
/** @param {number | null | undefined} [projectId] */
export function taskmasterName(projectId = view?.projectId) {
  const p = view?.projects?.find((x) => x.id === projectId) ?? (view?.project?.id === projectId ? /** @type {View} */ (view).project : null);
  return p?.name ? `${p.name} Taskmaster` : 'Taskmaster';
}
/** taskmasterName in a span that follows renames of the scheme. */
/** @param {number | null | undefined} [projectId] */
export const taskmasterLabel = (projectId = view?.projectId) => h('span', { 'data-taskmaster-name': projectId }, taskmasterName(projectId));
/** @param {ThreadRef} t */
export const threadLabel = (t) => (isCoordinator(t) ? taskmasterName(t.project_id) : `#${t.number ?? t.id} ${t.title}`);
/** The full name: "12 FEATURE: Usage bar". No type or state emoji (Josh, 2026-11-13: "leftover from a bygone era"). */
/** @param {ThreadRef} t */
export function threadFullName(t) {
  if (isCoordinator(t)) return taskmasterName(t.project_id);
  const type = TYPES[/** @type {string} */ (t.properties?.type)];
  return `${t.number ?? t.id} ${type?.label ? `${type.label.toUpperCase()}: ${t.title}` : t.title}`;
}

/** threadFullName in parts; phones hide the type word for room (the properties chip has it). */
/** @param {ThreadRef} t */
export function threadTitleParts(t) {
  if (isCoordinator(t)) return taskmasterLabel(t.project_id);
  const type = TYPES[/** @type {string} */ (t.properties?.type)];
  return [`${t.number ?? t.id} `, type?.label ? h('span', { class: 'wide-only' }, `${type.label.toUpperCase()}: `) : '', t.title];
}

/** Wrap matches of the text inside el in <mark>, returning the marks in document order. */
/** @param {Element} el @param {string | null | undefined} text */
export function highlight(el, text) {
  /** @type {HTMLElement[]} */
  const marks = [];
  if (!text) return marks;
  const needle = text.toLowerCase();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  /** @type {Text[]} */
  const nodes = [];
  while (walker.nextNode()) nodes.push(/** @type {Text} */ (walker.currentNode)); // SHOW_TEXT yields only text nodes
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

/** @param {Element} el */
export function clearHighlights(el) {
  for (const mark of el.querySelectorAll('mark.find')) mark.replaceWith(...mark.childNodes);
  el.normalize();
}
