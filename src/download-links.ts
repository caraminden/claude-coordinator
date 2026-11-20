// Short-lived download links (#1184). With "Open links in Firefox" on, a download clicked in Citadel goes to Firefox
// (public/extlinks.js), which has no Citadel login. So the page asks for a link to that one file: a random token, kept
// here in memory, naming the person and the file's address, good for DOWNLOAD_LINK_MS. Opening /api/dl/<token> replays
// that one GET as that person through the API's own routes (server.ts), so every access check still runs, as of the
// moment Firefox asks. A restart forgets every link, which costs at most a click again.
import { randomBytes } from 'node:crypto';
import type { Session } from './auth.ts';
import type { Store } from './db.ts';

/** How long a link works after it's made: long enough for Firefox to start cold, short enough to be useless later. */
export const DOWNLOAD_LINK_MS = 2 * 60_000;

/**
 * The file routes a link may stand for, as GET paths: a minion's file and its uploads, an artifact, a scheme's shared
 * file and a CI file. Nothing else: no listing, no JSON, nothing that changes anything.
 */
const FILES = [
  /^\/api\/tickets\/\d+\/file$/,
  /^\/api\/tickets\/\d+\/uploads\/[^/]+$/,
  /^\/api\/artifacts\/\d+\/raw$/,
  /^\/api\/projects\/\d+\/shared\/file$/,
  /^\/api\/projects\/\d+\/ci-files\/\d+\/[^/]+$/,
];

/** The token's own path, after any /c or preview prefix. */
const LINK = /^\/api\/dl\/([\w-]{32})$/;

/**
 * Split a file address the page sent (`/c/api/…?…`, `/preview/7/api/…`, `/api/…`) into its prefix and the API path with
 * `download` asked for, or null when it isn't one of FILES.
 */
export function downloadTarget(address: string): { prefix: string; path: string } | null {
  if (typeof address !== 'string' || address.length > 4000) return null;
  const m = /^(\/c|\/preview\/(?:build\/)?\d+)?(\/api\/.*)$/.exec(address);
  if (!m) return null;
  let url: URL;
  try {
    url = new URL(m[2], 'http://localhost');
  } catch {
    return null;
  }
  // The URL parser folds `..`: what it resolved to is what's checked and what's replayed.
  if (!FILES.some((re) => re.test(url.pathname))) return null;
  url.searchParams.set('download', '');
  return { prefix: m[1] ?? '', path: url.pathname + url.search };
}

interface Link { uid: number; path: string; exp: number }

export class DownloadLinks {
  private links = new Map<string, Link>();
  private ttl: number;

  constructor(ttl = DOWNLOAD_LINK_MS) {
    this.ttl = ttl;
  }

  /** A new link's token for person `uid` to `path` (an API path from downloadTarget). */
  mint(uid: number, path: string, now = Date.now()): string {
    for (const [t, l] of this.links) if (l.exp <= now) this.links.delete(t);
    const token = randomBytes(24).toString('base64url');
    this.links.set(token, { uid, path, exp: now + this.ttl });
    return token;
  }

  /** The person and file an unexpired link's token names, or null. */
  redeem(token: string, now = Date.now()): { uid: number; path: string } | null {
    const l = this.links.get(token);
    if (!l) return null;
    if (l.exp <= now) {
      this.links.delete(token);
      return null;
    }
    return { uid: l.uid, path: l.path };
  }

  /** The token in a request path that is a download link (`/api/dl/<token>`), else null. */
  static token(pathname: string): string | null {
    return LINK.exec(pathname)?.[1] ?? null;
  }
}

/** The session a link's person has now, as their cookie would give it, or null if they're gone or disabled. */
export function linkSession(store: Store, uid: number): Session | null {
  const user = store.getUser(uid);
  return user && !user.disabled_at ? { name: user.name, uid: user.id, admin: store.isAdmin(user), exp: Date.now() + 60_000 } : null;
}

/** The one store a server keeps (DOWNLOAD_LINK_MS shortens its links for a test). */
export const downloadLinks = new DownloadLinks(Number(process.env.DOWNLOAD_LINK_MS) || DOWNLOAD_LINK_MS);
