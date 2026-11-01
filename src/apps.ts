// The /apps/<name>/ proxy (shared/project/specs/contraptions/citadel-apps-brief.md, section 2): a
// contraption's own service, on 127.0.0.1:<port>, served under Citadel's host behind Citadel's login.
// /apps/<name>/... goes to http://127.0.0.1:<port>/apps/<name>/... with the prefix kept, so the
// contraption is configured with its base path and nothing is rewritten.
//
// Every request, whatever path or gate it takes, first loses any X-Citadel-* header the client sent.
// Then: an open path (the contraption's open_paths, like Peek Auras' /link) goes through with no identity;
// any other path needs a person signed in and enabled for the contraption, and carries X-Citadel-Identity
// signed with the contraption's key (src/contraptions.ts), which the contraption checks.
//
// Accepted risk (Cara, 2026-11-01, "Path on Citadel's host"): a contraption's page runs on Citadel's
// origin, so a script bug in one could call Citadel's API as the person (cc_session is HttpOnly, but
// same-origin requests carry it). Fine while Cara writes every contraption; revisit (subdomains) before
// one she didn't. The proxy still never hands the contraption's server the cc_session cookie.
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { APP_NAME } from './appname.ts';
import { COOKIE, type Auth } from './auth.ts';
import type { Contraptions } from './contraptions.ts';
import type { ContraptionRow, Store } from './db.ts';
import { requestUrl } from './http.ts';
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
  `<body style="font:16px system-ui;padding:2rem;text-align:center"><p>${escape(text)}</p><p><a href="/">Open ${APP_NAME}</a></p></body>`;

type Refusal = { status: number; reason: string; headers: OutgoingHttpHeaders; body: string };
type Admitted = { row: ContraptionRow; path: string; headers: OutgoingHttpHeaders; uid: number | null };

const html = { 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
const text = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };

export class AppProxy {
  private store: Store;
  private contraptions: Contraptions;
  private auth: Auth;
  /** Gated requests and websockets still open, so disabling someone also ends what they have open. */
  private open = new Map<{ destroy(): void }, { name: string; uid: number }>();

  constructor(store: Store, contraptions: Contraptions, auth: Auth) {
    this.store = store;
    this.contraptions = contraptions;
    this.auth = auth;
    setInterval(() => this.sweep(), SWEEP_MS).unref();
  }

  /** End open streams and websockets of people the contraption is no longer enabled for. */
  sweep() {
    for (const [conn, { name, uid }] of this.open) {
      if (this.contraptions.enabled(name, uid)) continue;
      this.open.delete(conn);
      conn.destroy();
    }
  }

  /** Serve an /apps/... request. */
  serve(req: IncomingMessage, res: ServerResponse) {
    const a = this.admit(req);
    if ('status' in a) return void res.writeHead(a.status, a.headers).end(a.body);
    this.track(res, a);
    forward(req, res, a.row.port, a.path, a.headers, this.options(a.row));
  }

  /** Serve an /apps/... request that asks to upgrade (a websocket): the same gate, then a tunnel. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on('error', () => socket.destroy());
    const a = this.admit(req);
    if ('status' in a) return answerRaw(socket, a.status, a.reason, a.headers, a.body);
    this.track(socket, a);
    forwardUpgrade(req, socket, head, a.row.port, a.path, a.headers, this.options(a.row));
  }

  private track(conn: { destroy(): void; once(e: 'close', f: () => void): unknown }, a: Admitted) {
    if (a.uid === null) return;
    this.open.set(conn, { name: a.row.name, uid: a.uid });
    conn.once('close', () => this.open.delete(conn));
  }

  private options(row: ContraptionRow): ForwardOptions {
    return {
      what: row.title,
      maxBody: MAX_BODY,
      // A contraption may set its own cookies, never Citadel's session.
      answer: (h) => {
        if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].filter((c) => !c.trimStart().startsWith(`${COOKIE}=`));
      },
    };
  }

  /** The gate: strip, find the contraption, then either an open path or a signed-in person it's enabled for. */
  private admit(req: IncomingMessage): Admitted | Refusal {
    // First, on every path: a client never gets to say who it is to a contraption.
    for (const k of Object.keys(req.headers)) if (k.startsWith('x-citadel-')) delete req.headers[k];

    let url: URL;
    try {
      url = requestUrl(req);
    } catch {
      return { status: 400, reason: 'Bad Request', headers: text, body: 'Bad request' };
    }
    const m = APPS_PATH.exec(url.pathname);
    const row = m && this.store.getContraption(m[1]);
    if (!m || !row) return { status: 404, reason: 'Not Found', headers: html, body: page('Not found', 'There is no app here.') };
    if (!m[2]) return { status: 302, reason: 'Found', headers: { Location: `/apps/${row.name}/${url.search}` }, body: '' };

    // Citadel's session cookie stays with Citadel; the contraption's own cookies go through.
    const headers: OutgoingHttpHeaders = { ...req.headers };
    const cookies = (req.headers.cookie ?? '').split(/;\s*/).filter((c) => c && !c.startsWith(`${COOKIE}=`));
    if (cookies.length) headers.cookie = cookies.join('; ');
    else delete headers.cookie;
    const path = url.pathname + url.search;

    if (isOpenPath(JSON.parse(row.open_paths) as string[], m[2])) return { row, path, headers, uid: null };

    // Only the cookie counts here: an Authorization header is the contraption's business, passed on as it is.
    const session = this.auth.session({ headers: { cookie: req.headers.cookie } } as IncomingMessage);
    if (!session || session.uid === undefined) {
      const isPage = req.method === 'GET' && /text\/html/.test(String(req.headers.accept ?? '')) && !req.headers.upgrade;
      if (isPage) return { status: 302, reason: 'Found', headers: { Location: `/?next=${encodeURIComponent(path)}`, 'Cache-Control': 'no-store' }, body: '' };
      return { status: 401, reason: 'Unauthorized', headers: text, body: 'Not logged in' };
    }
    const user = this.contraptions.enabled(row.name, session.uid) ? this.store.getUser(session.uid) : undefined;
    if (!user) return { status: 403, reason: 'Forbidden', headers: html, body: page(row.title, `You don't have access to ${row.title}.`) };
    const identity = this.contraptions.signIdentity(row.name, user);
    if (!identity) return { status: 503, reason: 'Service Unavailable', headers: text, body: `${row.title}'s keys don't open; an admin can rotate them in Settings → Contraptions` };
    headers['x-citadel-identity'] = identity;
    return { row, path, headers, uid: user.id };
  }
}
