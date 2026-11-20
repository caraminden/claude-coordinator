// The contraption proxy (shared/project/specs/contraptions/citadel-apps-brief.md, section 2): a contraption's own
// service, on 127.0.0.1:<port>, behind Citadel's login. /apps/<name>/... goes to http://127.0.0.1:<port>/apps/<name>/...
// with the prefix kept, so the contraption is configured with its base path and nothing is rewritten.
//
// Where it is served (#709, docs/adr/0005-contraptions-on-subdomains.md). With APPS_DOMAIN set (live: citadel.zip)
// each contraption has its own origin, <name>.<APPS_DOMAIN>, still under /apps/<name>/, so its page can't reach
// Citadel's API or cc_session. That host serves only its contraption, Citadel UI's files and /_citadel/enter;
// Citadel's own hosts send /apps/<name>/ there through a one-time sign-in token (Auth.appToken), which the app
// host swaps for its own cookie (cc_app). Without APPS_DOMAIN (dev copies, previews, tests) it is served at
// /apps/<name>/ on Citadel's host, as before #709, where a contraption's page shares Citadel's origin.
//
// Every request, whatever path or gate it takes, first loses any X-Citadel-* header the client sent.
// Then: an open path (the contraption's open_paths, like Peek Auras' /link) goes through with no identity;
// any other path needs a person signed in and enabled for the contraption, and carries X-Citadel-Identity
// signed with the contraption's key (src/contraptions.ts), which the contraption checks. The proxy never
// hands the contraption's server either login cookie, nor lets it set one, nor a cookie for another host.
import { join } from 'node:path';
import { connect } from 'node:net';
import { request, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { APP_NAME } from './appname.ts';
import { APP_COOKIE, COOKIE, type Auth, type Session } from './auth.ts';
import { IMAGE_FILE, MANIFEST_FILE, installCheck } from './pwa-check.ts';
import type { Contraptions } from './contraptions.ts';
import type { ContraptionRow, Store } from './db.ts';
import { HttpError, isSecure, readJson, requestUrl } from './http.ts';
import { answerRaw, forward, forwardUpgrade, type ForwardOptions } from './proxy.ts';
import { place, type ChunkedUploads, type Meta } from './chunked-uploads.ts';
import { capped } from './contraption-read.ts';
import { safeFileName } from './uploads.ts';

export const APPS_PATH = /^\/apps\/([^/]*)(\/.*)?$/;
export const MAX_BODY = 20 * 1024 * 1024;
/** A contraption page's big uploads (#832): /apps/_citadel/uploads/<app>[/<id>], the protocol in src/chunked-uploads.ts. */
const UPLOADS = /^\/apps\/_citadel\/uploads\/([a-z0-9-]+)(?:\/([^/]+))?$/;
/** A phone's push registration from the Android shell (#1138, src/fcm.ts): POST or DELETE { token }. */
const PUSH = /^\/apps\/_citadel\/push\/([a-z0-9-]+)$/;
/** How often open streams and websockets are checked against who the contraption is enabled for. */
const SWEEP_MS = 2000;

/** How long a request waits for a restarting app's port (#1118); the server's own socket hold is the precedent. */
export const HOLD_MS = 5000;

/**
 * Apps restarting now (#1118): from a deploy's or restart's drain until its release, and HOLD_MS after (a restart's
 * systemctl returns before the app listens). Meanwhile a request waits until the app's port takes a connection, up
 * to HOLD_MS, before it is forwarded, so a deploy isn't a burst of 502s. Nothing goes to the app before its port is
 * open, so nothing is replayed, bodies included; an app that isn't restarting fails fast as before.
 */
export class RestartHolds {
  private holdMs: number;
  /** Past this many waiting on one app, a request goes on at once (and fails fast if the app is down). */
  private maxWaiting: number;
  private apps = new Map<string, { holds: number; ended: number; waiting: number; stopped?: boolean }>();

  constructor(holdMs = HOLD_MS, maxWaiting = 200) {
    this.holdMs = holdMs;
    this.maxWaiting = maxWaiting;
  }

  /** The app is restarting until the returned release is called (once; again does nothing). */
  hold(name: string): () => void {
    const app = this.apps.get(name) ?? { holds: 0, ended: 0, waiting: 0 };
    this.apps.set(name, app);
    app.holds++;
    app.stopped = false;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      app.holds--;
      app.ended = Date.now();
    };
  }

  /** The app was stopped on purpose: what is left of a restart's grace ends, so it fails fast. */
  stopped(name: string) {
    const app = this.apps.get(name) ?? { holds: 0, ended: 0, waiting: 0 };
    this.apps.set(name, app);
    app.ended = 0;
    app.stopped = true;
  }

  /** Whether the app was stopped on purpose and hasn't answered since: the proxy's retry (#1173) skips it, so it fails fast. */
  isStopped(name: string): boolean {
    return !!this.apps.get(name)?.stopped;
  }

  /** The app answered a request: it's running, so a stop's mark is gone. */
  answered(name: string) {
    const app = this.apps.get(name);
    if (app) app.stopped = false;
  }

  /**
   * Run `go` now, or once a restarting app's port is open or the hold's time is up; never for an asker who left meanwhile.
   * `held` says it waited here, so the proxy needn't ask again on top (#1173's retry).
   */
  whenUp(name: string, port: number, conn: { once(e: 'close', f: () => void): unknown }, go: (held?: boolean) => void) {
    const app = this.apps.get(name);
    if (!app || (app.holds === 0 && Date.now() - app.ended >= this.holdMs) || app.waiting >= this.maxWaiting) return go();
    let gone = false;
    conn.once('close', () => (gone = true));
    app.waiting++;
    const until = Date.now() + this.holdMs;
    const poll = async () => {
      while (!gone && Date.now() < until && !(await accepts(port, until - Date.now()))) await new Promise((r) => setTimeout(r, Math.min(100, Math.max(0, until - Date.now()))));
    };
    void poll().finally(() => {
      app.waiting--;
      if (!gone) go(true);
    });
  }
}

/** Whether something takes connections on 127.0.0.1:port within ms (the connection is closed at once). */
const accepts = (port: number, ms: number) => new Promise<boolean>((ok) => {
  const s = connect(port, '127.0.0.1');
  // A full backlog leaves a connect pending: give up at the hold's end.
  s.setTimeout(Math.max(1, ms), () => {
    s.destroy();
    ok(false);
  });
  s.once('connect', () => {
    s.destroy();
    ok(true);
  });
  s.once('error', () => ok(false));
});

/** Whether a path under the contraption (after /apps/<name>) is one of its open paths, or under one. */
export function isOpenPath(openPaths: string[], rest: string): boolean {
  // An encoded dot, slash or backslash could read as another path once the contraption decodes it.
  if (/%2e|%2f|%5c|\\/i.test(rest)) return false;
  return openPaths.some((p) => rest === p || rest.startsWith(p.endsWith('/') ? p : `${p}/`));
}

/** The manifest names installers try without reading the page. */
const STANDARD_MANIFESTS = ['/manifest.webmanifest', '/manifest.json', '/site.webmanifest'];

/**
 * Whether a GET or HEAD of `rest` (after /apps/<name>) is one of the static files an installer fetches with no login
 * (#987): a standard manifest name, the rail icon, or what a deploy read from its page (manifest and its icons, see
 * installCheck). Exact files only, never a prefix, and images or manifests by extension: start_url, share_target and
 * every other route stay behind the login.
 */
export function staticOpen(row: Pick<ContraptionRow, 'icon' | 'static_paths'>, method: string | undefined, rest: string): boolean {
  if ((method !== 'GET' && method !== 'HEAD') || /%2e|%2f|%5c|\\/i.test(rest)) return false;
  if (STANDARD_MANIFESTS.includes(rest)) return true;
  if (!IMAGE_FILE.test(rest) && !MANIFEST_FILE.test(rest)) return false;
  if (row.icon === rest) return true;
  try { return (JSON.parse(row.static_paths ?? '[]') as string[]).includes(rest); } catch { return false; }
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/**
 * What a person sees when an app can't open: a panel in Citadel's look (its tokens and light/dark), the words, an optional
 * link on (`more`, such as Settings → Contraptions) and a "Back to Citadel" button. Inside Citadel's frame the button asks
 * the frame to leave (public/frames.js, type "leave"), which returns to Citadel's last own view; on its own it opens /c/.
 */
const page = (title: string, text: string, more?: { href: string; label: string }, home = '') =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(title)}</title>` +
  `<style>:root{--bg:#f6f5f2;--panel:#fff;--ink:#1d1c1a;--muted:#6b6862;--line:#e2dfd8;--accent:#c2410c}` +
  `@media(prefers-color-scheme:dark){:root{--bg:#161514;--panel:#201f1d;--ink:#ecebe7;--muted:#9b978f;--line:#34322e;--accent:#fb923c}}` +
  `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:1rem;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}` +
  `main{max-width:26rem;width:100%;box-sizing:border-box;padding:1.5rem;background:var(--panel);border:1px solid var(--line);border-radius:12px}` +
  `h1{margin:0 0 .5rem;font-size:1.2rem}p{margin:0 0 1rem;color:var(--muted)}a{color:var(--accent)}` +
  `.row{display:flex;flex-wrap:wrap;align-items:center;gap:1rem}` +
  `button{font:inherit;min-height:2.5rem;padding:.5rem 1rem;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}` +
  `@media(prefers-color-scheme:dark){button{color:#1d1c1a}}</style>` +
  `<body><main><h1>${escape(title)}</h1><p>${escape(text)}</p><div class="row"><button type="button" id="back">Back to ${APP_NAME}</button>` +
  (more ? `<a href="${escape(more.href)}" target="_top">${escape(more.label)}</a>` : '') +
  `</div></main><script>document.getElementById('back').onclick=function(){if(parent!==window)parent.postMessage({protocol:'citadel-frame-1',type:'leave'},'*');else location.href='${home}/c/'}</script></body>`;

type Refusal = { status: number; reason: string; headers: OutgoingHttpHeaders; body: string };
/** renewed: a fresh session cookie for the person (Auth.renewal), added to the contraption's answer. */
type Admitted = { row: ContraptionRow; path: string; headers: OutgoingHttpHeaders; uid: number | null; renewed?: string | null; sandboxed?: boolean };

const html = { 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
const text = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
/** A sign-in handoff's answers: never cached, and the token in the address never sent on as a Referer. */
const handoff = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const notFound: Refusal = { status: 404, reason: 'Not Found', headers: html, body: page('Not found', 'There is no app here.') };
const redirect = (to: string, headers: OutgoingHttpHeaders = { 'Cache-Control': 'no-store' }): Refusal => ({ status: 302, reason: 'Found', headers: { Location: to, ...headers }, body: '' });

/** The contraption a request's host names (<name>.<domain>), or null on any other host: one of Citadel's own. */
export function appHost(req: IncomingMessage, domain: string | null): string | null {
  if (!domain) return null;
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').toLowerCase();
  const suffix = `.${domain.toLowerCase()}`;
  return host.endsWith(suffix) ? host.slice(0, -suffix.length) : null;
}

/** Where a contraption's page goes after its sign-in handoff: one of its own paths, else its root. */
export function enterNext(next: string | null, name: string): string {
  const own = `/apps/${name}/`;
  return next?.startsWith(own) && !/[\\\r\n]/.test(next) ? next : own;
}

/** A browser asking for a page (where a login redirect makes sense), not a script's fetch or a websocket. */
const isPage = (req: IncomingMessage) => req.method === 'GET' && /text\/html/.test(String(req.headers.accept ?? '')) && !req.headers.upgrade;

/** A write or websocket from a page on another origin: refused on a contraption's host, whose cookie is SameSite=None. */
function crossOrigin(req: IncomingMessage): boolean {
  const write = (req.method !== 'GET' && req.method !== 'HEAD') || !!req.headers.upgrade;
  const origin = req.headers.origin;
  if (!write || !origin) return false;
  try {
    return new URL(origin).host !== (req.headers['x-forwarded-host'] ?? req.headers.host);
  } catch {
    return true; // "null": a sandboxed page or a redirect chain from elsewhere
  }
}

export class AppProxy {
  private store: Store;
  private contraptions: Contraptions;
  private auth: Auth;
  /** APPS_DOMAIN: each contraption at <name>.<domain>; null serves them at /apps/<name>/ on Citadel's host. */
  private domain: string | null;
  /** Gated requests and websockets still open, so disabling someone also ends what they have open. */
  private open = new Map<{ destroy(): void }, { name: string; uid: number }>();
  /** A 5xx answer from a contraption, for the daily error digest (src/contraption-errors.ts, #835): set by server.ts. */
  onServerError: (row: ContraptionRow, status: number, method: string, path: string, note?: string) => void = () => {};
  /** Apps restarting now, whose requests wait for them (#1118): server.ts holds one around each drain. */
  readonly restarts = new RestartHolds();
  /** Big uploads, and the home folder apps' DATA_DIRs are under (~/.local/share/<name>); null: no uploads. */
  private uploads: { chunked: ChunkedUploads; home: string } | null;

  constructor(store: Store, contraptions: Contraptions, auth: Auth, domain: string | null = null, uploads: { chunked: ChunkedUploads; home: string } | null = null) {
    this.store = store;
    this.contraptions = contraptions;
    this.auth = auth;
    this.domain = domain;
    this.uploads = uploads;
    setInterval(() => this.sweep(), SWEEP_MS).unref();
  }

  /**
   * Read the manifest and icon paths of every contraption that has none recorded yet (#987), as its first enabled
   * person, so apps deployed before this need no redeploy. One that isn't up is left for the next start.
   */
  async backfillStatics() {
    for (const row of this.store.listContraptions()) {
      if (row.static_paths !== null) continue;
      const user = this.store.contraptionUsers(row.id).map((id) => this.store.getUser(id)).find((u) => u && this.contraptions.enabled(row.name, u.id));
      const header = user && this.contraptions.signIdentity(row.name, user);
      if (!header) continue;
      try {
        const found = await installCheck(row.name, (path) => fetch(`http://127.0.0.1:${row.port}${path}`, { headers: { 'x-citadel-identity': header, accept: 'text/html' }, signal: AbortSignal.timeout(5000) }));
        if (found.statics.length) this.store.updateContraption(row.name, { static_paths: JSON.stringify(found.statics) });
      } catch { /* not up: next start */ }
    }
  }

  /** Whether a request is for a contraption's own host (everything on it is the proxy's). */
  onAppHost(req: IncomingMessage): boolean {
    return appHost(req, this.domain) !== null;
  }

  /** End open streams and websockets of people the contraption is no longer enabled for. */
  sweep() {
    for (const [conn, { name, uid }] of this.open) {
      if (this.contraptions.enabled(name, uid)) continue;
      this.open.delete(conn);
      conn.destroy();
    }
  }

  /** Serve a request on a contraption's host, or one under /apps/ on Citadel's. */
  serve(req: IncomingMessage, res: ServerResponse) {
    const host = appHost(req, this.domain);
    let url: URL;
    try {
      url = requestUrl(req);
    } catch {
      return void res.writeHead(400, text).end('Bad request');
    }
    if (url.pathname.startsWith('/apps/_citadel/')) return void this.kit(req, res, url, host).catch(() => res.headersSent ? res.destroy() : res.writeHead(500, text).end('Internal error'));
    const a = host !== null && url.pathname.startsWith('/_citadel/') ? this.enter(req, url, host) : this.admit(req, url, host);
    if ('status' in a) return void res.writeHead(a.status, a.headers).end(a.body);
    this.track(res, a);
    const failed = (status: number, note?: string) => this.onServerError(a.row, status, req.method ?? 'GET', a.path, note);
    const go = (held?: boolean) => forward(req, res, a.row.port, a.path, a.headers, { ...this.options(a.row, a.renewed, a.sandboxed), failed, ...(held || this.restarts.isStopped(a.row.name) ? { retryMs: 0 } : {}) });
    this.restarts.whenUp(a.row.name, a.row.port, res, go);
  }

  /** Serve a request that asks to upgrade (a websocket): the same gate, then a tunnel. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on('error', () => socket.destroy());
    let url: URL;
    try {
      url = requestUrl(req);
    } catch {
      return answerRaw(socket, 400, 'Bad Request', text, 'Bad request');
    }
    const a = this.admit(req, url, appHost(req, this.domain));
    if ('status' in a) return answerRaw(socket, a.status, a.reason, a.headers, a.body);
    this.track(socket, a);
    this.restarts.whenUp(a.row.name, a.row.port, socket, () => forwardUpgrade(req, socket, head, a.row.port, a.path, a.headers, this.options(a.row, null, a.sandboxed)));
  }

  private track(conn: { destroy(): void; once(e: 'close', f: () => void): unknown }, a: Admitted) {
    if (a.uid === null) return;
    this.open.set(conn, { name: a.row.name, uid: a.uid });
    conn.once('close', () => this.open.delete(conn));
  }

  private options(row: ContraptionRow, renewed?: string | null, sandboxed?: boolean): ForwardOptions {
    return {
      what: row.title,
      maxBody: MAX_BODY,
      // A contraption may set its own cookies, never a login, nor one for a wider domain (Citadel's, or the other apps').
      answer: (h) => {
        this.restarts.answered(row.name);
        if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].filter((c) => !/^\s*(cc_session|cc_app)=/.test(c) && !/;\s*domain\s*=/i.test(c));
        if (renewed) h['set-cookie'] = [...(h['set-cookie'] ?? []), renewed];
        // An open path's answer on Citadel's host can't open as a document there (an <object> asks with Accept */*).
        if (sandboxed) Object.assign(h, { 'content-security-policy': 'sandbox', 'x-content-type-options': 'nosniff' });
      },
    };
  }

  private origin(req: IncomingMessage, host: string | null): string {
    return `${isSecure(req) ? 'https' : 'http'}://${host === null ? '' : `${host}.`}${this.domain}`;
  }

  /** The person signed in where the request is: a contraption's host cookie there, else Citadel's (the cookie only: a bearer is the contraption's business). */
  private who(req: IncomingMessage, host: string | null): Session | null {
    const s = host !== null ? this.auth.appSession(req, host) : this.auth.session({ headers: { cookie: req.headers.cookie } } as IncomingMessage);
    return s && s.uid !== undefined ? s : null;
  }

  /**
   * A contraption's host's sign-in: /_citadel/enter?t=<token>&next=<path> swaps a token Citadel's host minted (moved) for
   * this host's own cookie, then checks at /_citadel/entered that the browser kept it, so one that blocks it gets a page
   * saying so instead of a loop of redirects through Citadel's host.
   */
  private enter(req: IncomingMessage, url: URL, host: string): Refusal {
    const row = this.store.getContraption(host);
    if (!row || req.method !== 'GET') return notFound;
    const next = enterNext(url.searchParams.get('next'), row.name);
    if (url.pathname === '/_citadel/enter') {
      const uid = this.auth.redeemAppToken(url.searchParams.get('t') ?? '', row.name);
      // A spent or stale token (the address reloaded from history): on to the page, which signs in afresh if it must.
      if (uid === null) return redirect(next, handoff);
      return redirect(`/_citadel/entered?next=${encodeURIComponent(next)}`, { ...handoff, 'Set-Cookie': this.auth.issueAppCookie(row.name, { id: uid }, isSecure(req)) });
    }
    if (url.pathname === '/_citadel/entered') {
      if (this.who(req, host)) return redirect(next, handoff);
      return { status: 403, reason: 'Forbidden', headers: html, body: page(row.title, `This browser blocked ${row.title}'s sign-in cookie, so it can't open here. Allow cookies for ${url.host}, or open ${APP_NAME} at ${this.domain} instead.`) };
    }
    return notFound;
  }

  /** On Citadel's host with APPS_DOMAIN set: a page under /apps/<name>/ goes to the contraption's own host, signed in. */
  private moved(req: IncomingMessage, row: ContraptionRow, path: string, open: boolean): Refusal {
    const there = this.origin(req, row.name);
    if (!isPage(req)) return { status: 404, reason: 'Not Found', headers: text, body: `${row.title} has moved to ${there}${path}` };
    // An open path's page needs no sign-in there either.
    if (open) return redirect(`${there}${path}`);
    const session = this.who(req, null);
    if (!session) return redirect(`/c/?next=${encodeURIComponent(path)}`);
    if (!this.contraptions.enabled(row.name, session.uid!)) return { status: 403, reason: 'Forbidden', headers: html, body: page(row.title, `You don't have access to ${row.title}.`) };
    return redirect(`${there}/_citadel/enter?t=${this.auth.appToken(row.name, session.uid!)}&next=${encodeURIComponent(path)}`, handoff);
  }

  /** The gate: strip, find the contraption, then either an open path or a signed-in person it's enabled for. */
  private admit(req: IncomingMessage, url: URL, host: string | null): Admitted | Refusal {
    // First, on every path: a client never gets to say who it is to a contraption.
    for (const k of Object.keys(req.headers)) if (k.startsWith('x-citadel-')) delete req.headers[k];

    const m = APPS_PATH.exec(url.pathname);
    let row: ContraptionRow | undefined;
    if (host !== null) {
      // A contraption's host serves only that contraption: no Citadel, and no other app.
      row = this.store.getContraption(host);
      if (!row) return notFound;
      if (url.pathname === '/') return redirect(`/apps/${row.name}/${url.search}`);
      if (!m || m[1] !== row.name) {
        // Links on a contraption's page to Citadel or another app are relative (Mandate's /c/#/p/5/t/12, /c/?next=,
        // /apps/toc/...): a page load of one goes to Citadel's host, which shows it or hands it to that app's host (the
        // browser keeps the #). Anything else stays a 404: Citadel's API isn't here.
        return isPage(req) ? redirect(`${this.origin(req, null)}${url.pathname}${url.search}`) : notFound;
      }
    } else {
      row = (m && this.store.getContraption(m[1])) || undefined;
      if (!m || !row) return notFound;
    }
    if (!m[2]) return redirect(`/apps/${row.name}/${url.search}`, {});
    const path = url.pathname + url.search;
    const listed = isOpenPath(JSON.parse(row.open_paths) as string[], m[2]);
    const open = listed || staticOpen(row, req.method, m[2]);
    // Citadel's host still passes an open path's websockets and fetches (Peek Auras' PC link dials /apps/peek-auras/link
    // there): they carry no login or identity, and no page of the contraption's opens on Citadel's origin.
    if (host === null && this.domain && !(open && !isPage(req))) return this.moved(req, row, path, open);

    // The login cookies stay with Citadel; the contraption's own cookies go through.
    const headers: OutgoingHttpHeaders = { ...req.headers };
    const cookies = (req.headers.cookie ?? '').split(/;\s*/).filter((c) => c && !c.startsWith(`${COOKIE}=`) && !c.startsWith(`${APP_COOKIE}=`));
    if (cookies.length) headers.cookie = cookies.join('; ');
    else delete headers.cookie;

    // A static file (#987) is anonymous only for someone with no login: a signed-in, enabled person's request carries
    // their identity as before, since an app may refuse any request without one (Peek Auras' icon did).
    const signedIn = open && !listed ? this.who(req, host) : null;
    if (open && !(signedIn && this.contraptions.enabled(row.name, signedIn.uid!))) return { row, path, headers, uid: null, sandboxed: host === null && !!this.domain };

    const session = this.who(req, host);
    if (!session) {
      // A contraption's host signs in through Citadel's (its apex, which shares the domain), which sends the page back here.
      if (isPage(req)) return redirect(host !== null ? `${this.origin(req, null)}${path}` : `/c/?next=${encodeURIComponent(path)}`);
      return { status: 401, reason: 'Unauthorized', headers: text, body: 'Not logged in' };
    }
    if (host !== null && crossOrigin(req)) return { status: 403, reason: 'Forbidden', headers: text, body: 'Cross-origin request' };
    const user = this.contraptions.enabled(row.name, session.uid!) ? this.store.getUser(session.uid!) : undefined;
    if (!user) return { status: 403, reason: 'Forbidden', headers: html, body: page(row.title, `You don't have access to ${row.title}.`) };
    const identity = this.contraptions.signIdentity(row.name, user);
    if (!identity) {
      if (!isPage(req)) return { status: 503, reason: 'Service Unavailable', headers: text, body: `${row.title}'s keys don't open; an admin can rotate them in Settings → Contraptions` };
      const scheme = row.home_scheme ?? this.store.listProjects()[0]?.id;
      const home = host !== null ? this.origin(req, null) : '';
      const more = scheme === undefined ? undefined : { href: `${home}/c/#/p/${scheme}/contraptions`, label: 'Settings → Contraptions' };
      return { status: 503, reason: 'Service Unavailable', headers: html, body: page(`${row.title} can't open`, `Citadel can't prove who you are to ${row.title} because its keys don't open. An admin can rotate them in Settings → Contraptions.`, more, home) };
    }
    headers['x-citadel-identity'] = identity;
    const renewed = host !== null ? this.auth.appRenewal(row.name, session, isSecure(req)) : this.auth.renewal(session, isSecure(req));
    return { row, path, headers, uid: user.id, renewed };
  }

  /**
   * Citadel UI's two answers that need a login, on any host, for the rail on a contraption's page (public/rail.js):
   * /apps/_citadel/api/mine, the person's apps and where Citadel is, and /apps/_citadel/icon/<name>, an app's icon,
   * fetched here so the rail never loads another app's host. Only images go out, sandboxed, so an SVG can't run as Citadel.
   */
  private async kit(req: IncomingMessage, res: ServerResponse, url: URL, host: string | null) {
    if (host !== null && !this.store.getContraption(host)) return void res.writeHead(404, text).end('Not found');
    const upload = UPLOADS.exec(url.pathname);
    if (upload) return this.upload(req, res, url, host, upload[1], upload[2]);
    const push = PUSH.exec(url.pathname);
    if (push) return this.pushDevice(req, res, host, push[1]);
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405, text).end('Method not allowed');
    const session = this.who(req, host);
    if (!session) return void res.writeHead(401, text).end('Not logged in');
    if (url.pathname === '/apps/_citadel/api/mine') {
      const body = JSON.stringify({ name: session.name, citadel: host !== null ? `${this.origin(req, null)}/c/` : null, apps: await this.contraptions.mine(session.uid!) });
      return void res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(body);
    }
    const m = /^\/apps\/_citadel\/icon\/([a-z0-9-]+)$/.exec(url.pathname);
    const row = m && this.store.getContraption(m[1]);
    const user = row && row.icon && this.contraptions.enabled(row.name, session.uid!) ? this.store.getUser(session.uid!) : undefined;
    if (!row || !user) return void res.writeHead(404, text).end('No icon');
    if (/^https?:/.test(row.icon!)) return void res.writeHead(302, { Location: row.icon! }).end();
    const path = row.icon!.startsWith('/apps/') ? row.icon! : `/apps/${row.name}/${row.icon!.replace(/^\//, '')}`;
    const identity = this.contraptions.signIdentity(row.name, user);
    const up = request({ host: '127.0.0.1', port: row.port, path, headers: identity ? { 'x-citadel-identity': identity, accept: 'image/*' } : { accept: 'image/*' } }, (r) => {
      const type = String(r.headers['content-type'] ?? '');
      if (r.statusCode !== 200 || !/^image\/[\w.+-]+(;|$)/.test(type)) {
        r.resume();
        return void res.writeHead(404, text).end('No icon');
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" });
      r.on('error', () => res.destroy());
      r.pipe(res);
    });
    up.setTimeout(10_000, () => up.destroy());
    up.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502, text).end(`${row.title} is not answering`)));
    up.end();
  }
  /**
   * A big upload from a contraption's page, into its DATA_DIR/uploads/<login>/ (the folder the page names under it).
   * The same gate as the app's own requests: signed in, enabled for it, same origin. On the last chunk Citadel tells
   * the app, POST $BASE_PATH/app-api/uploaded as the uploader, and the page gets the app's answer with the file's.
   */
  private async upload(req: IncomingMessage, res: ServerResponse, url: URL, host: string | null, name: string, id: string | undefined) {
    const answer = (status: number, body?: unknown) =>
      void (body === undefined ? res.writeHead(status, { 'Cache-Control': 'no-store' }).end() : res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body)));
    const row = this.store.getContraption(name);
    // On a contraption's host only its own; with APPS_DOMAIN set its pages are there, so Citadel's host takes none.
    if (!this.uploads || !row || (host !== null ? host !== name : this.domain !== null)) return answer(404, { error: 'Not found' });
    if (id === undefined ? req.method !== 'POST' : !['GET', 'PUT', 'DELETE'].includes(req.method!)) return answer(405, { error: 'Method not allowed' });
    const session = this.who(req, host);
    if (!session) return answer(401, { error: 'Not logged in' });
    if (host !== null && crossOrigin(req)) return answer(403, { error: 'Cross-origin request' });
    const user = this.contraptions.enabled(row.name, session.uid!) ? this.store.getUser(session.uid!) : undefined;
    if (!user) return answer(403, { error: `You don't have access to ${row.title}` });
    const { chunked, home } = this.uploads;
    const who = { uid: user.id, login: user.login };
    const target = { kind: 'app', app: row.name } as const;
    try {
      if (id === undefined) return answer(201, await chunked.start(who, target, (await readJson(req, 16 * 1024)) ?? {}));
      if (req.method === 'GET') return answer(200, await chunked.status(who, target, id));
      if (req.method === 'DELETE') return answer(204, await chunked.cancel(who, target, id));
      const offset = Number(url.searchParams.get('offset') ?? NaN);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'offset must be the byte the chunk starts at');
      answer(200, await chunked.put(who, target, id, offset, req, async (meta, part) => {
        const rel = ['uploads', safeFileName(user.login), ...meta.folder];
        const saved = await place(part, join(home, '.local/share', row.name, ...rel), meta.name);
        const file = { path: [...rel, saved.slice(saved.lastIndexOf('/') + 1)].join('/'), name: saved.slice(saved.lastIndexOf('/') + 1), size: meta.size };
        return { ...file, app: await this.tellUploaded(row, user, file, meta) };
      }));
    } catch (err) {
      if (res.headersSent) return void res.destroy();
      answer(err instanceof HttpError ? err.status : 500, { error: err instanceof HttpError ? err.message : 'Internal error' });
    }
  }

  /**
   * The Android shell registers (POST) or forgets (DELETE) a phone's FCM token for the person signed in, on the app's
   * own host (cc_app) or Citadel's (cc_session). The same gate as uploads: signed in, enabled for it, same origin.
   */
  private async pushDevice(req: IncomingMessage, res: ServerResponse, host: string | null, name: string) {
    const answer = (status: number, error?: string) =>
      void (error === undefined ? res.writeHead(status, { 'Cache-Control': 'no-store' }).end() : res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error })));
    const row = this.store.getContraption(name);
    if (!row || (host !== null && host !== name)) return answer(404, 'Not found');
    if (req.method !== 'POST' && req.method !== 'DELETE') return answer(405, 'Method not allowed');
    const session = this.who(req, host);
    if (!session) return answer(401, 'Not logged in');
    if (host !== null && crossOrigin(req)) return answer(403, 'Cross-origin request');
    if (!this.contraptions.enabled(row.name, session.uid!)) return answer(403, `You don't have access to ${row.title}`);
    try {
      const body = await readJson(req, 16 * 1024);
      if (typeof body.token !== 'string' || !body.token || body.token.length > 4096) throw new HttpError(400, 'token must be a string of 1 to 4096 characters');
      if (req.method === 'DELETE') return void (await this.store.deletePushDevice(body.token, session.uid!), answer(204));
      if ((body.platform ?? 'android') !== 'android') throw new HttpError(400, 'platform must be android');
      await this.store.savePushDevice(row.id, session.uid!, body.token, 'android');
      answer(204);
    } catch (err) {
      answer(err instanceof HttpError ? err.status : 500, err instanceof HttpError ? err.message : 'Internal error');
    }
  }

  /** Tell the app a file arrived; what it answers (64 KB at most) goes back to the page. Never fails the upload. */
  private async tellUploaded(row: ContraptionRow, user: Parameters<Contraptions['signIdentity']>[1], file: { path: string; name: string; size: number }, meta: Meta) {
    const identity = this.contraptions.signIdentity(row.name, user);
    if (!identity) return { status: 503, answer: null };
    try {
      const r = await fetch(`http://127.0.0.1:${row.port}/apps/${row.name}/app-api/uploaded`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { 'X-Citadel-Identity': identity, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...file, folder: meta.folder.join('/') }),
      });
      const body = await capped(r);
      let answer: unknown = body.cut ? null : body.text;
      try {
        answer = body.cut ? null : JSON.parse(body.text);
      } catch {}
      return { status: r.status, answer };
    } catch {
      return { status: 502, answer: null };
    }
  }
}
