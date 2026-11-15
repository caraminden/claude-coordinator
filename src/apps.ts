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
import { request, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { APP_NAME } from './appname.ts';
import { APP_COOKIE, COOKIE, type Auth, type Session } from './auth.ts';
import type { Contraptions } from './contraptions.ts';
import type { ContraptionRow, Store } from './db.ts';
import { isSecure, requestUrl } from './http.ts';
import { answerRaw, forward, forwardUpgrade, type ForwardOptions } from './proxy.ts';

export const APPS_PATH = /^\/apps\/([^/]*)(\/.*)?$/;
export const MAX_BODY = 20 * 1024 * 1024;
/** How often open streams and websockets are checked against who the contraption is enabled for. */
const SWEEP_MS = 2000;

/** Whether a path under the contraption (after /apps/<name>) is one of its open paths, or under one. */
export function isOpenPath(openPaths: string[], rest: string): boolean {
  // An encoded dot, slash or backslash could read as another path once the contraption decodes it.
  if (/%2e|%2f|%5c|\\/i.test(rest)) return false;
  return openPaths.some((p) => rest === p || rest.startsWith(p.endsWith('/') ? p : `${p}/`));
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(title)}</title>` +
  `<body style="font:16px system-ui;padding:2rem;text-align:center"><p>${escape(text)}</p><p><a href="/c/">Open ${APP_NAME}</a></p></body>`;

type Refusal = { status: number; reason: string; headers: OutgoingHttpHeaders; body: string };
/** renewed: a fresh session cookie for the person (Auth.renewal), added to the contraption's answer. */
type Admitted = { row: ContraptionRow; path: string; headers: OutgoingHttpHeaders; uid: number | null; renewed?: string | null };

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

  constructor(store: Store, contraptions: Contraptions, auth: Auth, domain: string | null = null) {
    this.store = store;
    this.contraptions = contraptions;
    this.auth = auth;
    this.domain = domain;
    setInterval(() => this.sweep(), SWEEP_MS).unref();
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
    forward(req, res, a.row.port, a.path, a.headers, this.options(a.row, a.renewed));
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
    forwardUpgrade(req, socket, head, a.row.port, a.path, a.headers, this.options(a.row));
  }

  private track(conn: { destroy(): void; once(e: 'close', f: () => void): unknown }, a: Admitted) {
    if (a.uid === null) return;
    this.open.set(conn, { name: a.row.name, uid: a.uid });
    conn.once('close', () => this.open.delete(conn));
  }

  private options(row: ContraptionRow, renewed?: string | null): ForwardOptions {
    return {
      what: row.title,
      maxBody: MAX_BODY,
      // A contraption may set its own cookies, never a login, nor one for a wider domain (Citadel's, or the other apps').
      answer: (h) => {
        if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].filter((c) => !/^\s*(cc_session|cc_app)=/.test(c) && !/;\s*domain\s*=/i.test(c));
        if (renewed) h['set-cookie'] = [...(h['set-cookie'] ?? []), renewed];
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
    const session = this.who(req, null);
    // An open path's page needs no sign-in there either.
    if (!session) return redirect(open ? `${there}${path}` : `/c/?next=${encodeURIComponent(path)}`);
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
    const open = isOpenPath(JSON.parse(row.open_paths) as string[], m[2]);
    // Citadel's host still passes an open path's websockets and fetches (Peek Auras' PC link dials /apps/peek-auras/link
    // there): they carry no login or identity, and no page of the contraption's opens on Citadel's origin.
    if (host === null && this.domain && !(open && !isPage(req))) return this.moved(req, row, path, open);

    // The login cookies stay with Citadel; the contraption's own cookies go through.
    const headers: OutgoingHttpHeaders = { ...req.headers };
    const cookies = (req.headers.cookie ?? '').split(/;\s*/).filter((c) => c && !c.startsWith(`${COOKIE}=`) && !c.startsWith(`${APP_COOKIE}=`));
    if (cookies.length) headers.cookie = cookies.join('; ');
    else delete headers.cookie;

    if (open) return { row, path, headers, uid: null };

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
    if (!identity) return { status: 503, reason: 'Service Unavailable', headers: text, body: `${row.title}'s keys don't open; an admin can rotate them in Settings → Contraptions` };
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
      r.pipe(res);
    });
    up.setTimeout(10_000, () => up.destroy());
    up.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502, text).end(`${row.title} is not answering`)));
    up.end();
  }
}
