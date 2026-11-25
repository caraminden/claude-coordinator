// {{title}}'s server: plain node:http, no dependencies. Citadel's proxy hands it every browser request for
// /apps/{{name}}/ with the path unchanged and a signed X-Citadel-Identity header (citadel:contraption-ui,
// references/api.md). It runs as Citadel writes it from citadel-app.json: PORT, BASE_PATH, DATA_DIR,
// CITADEL_KEYS and CITADEL_URL come from Citadel and are never hard-coded.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './src/db.ts';
import { env, json, send, sendError } from './src/http.ts';
import { identityChecker, type Person } from './src/identity.ts';

export const APP = '{{name}}';
const PUBLIC = join(import.meta.dirname, 'public');
/** Paths that answer with no identity: the deploy's health check, and the install files a phone fetches without cookies. */
const OPEN = new Set(['/healthz', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

export interface Options {
  port: number;
  base: string;
  dataDir: string;
  keysDir: string;
}

export interface Running {
  server: Server;
  db: DatabaseSync;
  url: string;
  close(): Promise<void>;
}

export async function start(opts: Options): Promise<Running> {
  const who = identityChecker(APP, opts.keysDir);
  const db = openDb(opts.dataDir);
  const seen = db.prepare(`INSERT INTO people (sub, login, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (sub) DO UPDATE SET login = excluded.login, name = excluded.name, last_seen = excluded.last_seen
    RETURNING first_seen`);

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://app');
    if (url.pathname === opts.base) return void res.writeHead(308, { location: `${opts.base}/${url.search}` }).end();
    if (!url.pathname.startsWith(`${opts.base}/`)) return send(res, 404, 'Not found');
    const path = url.pathname.slice(opts.base.length);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (path === '/healthz') {
      db.prepare('SELECT 1').get();
      return send(res, 204);
    }
    let person: Person | null = null;
    if (!OPEN.has(path)) {
      person = who(req.headers['x-citadel-identity'] as string | undefined);
      if (!person) return send(res, 401, 'Open this app from Citadel.');
    }
    if (path === '/api/me') {
      const { first_seen } = seen.get(person!.sub, person!.login, person!.name, Date.now(), Date.now()) as { first_seen: number };
      return json(res, 200, { login: person!.login, name: person!.name, firstSeen: first_seen });
    }
    return serveFile(res, path === '/' ? '/index.html' : path);
  }

  async function serveFile(res: ServerResponse, path: string) {
    const file = normalize(join(PUBLIC, decodeURIComponent(path)));
    if (!file.startsWith(PUBLIC + sep)) return send(res, 404, 'Not found');
    const body = await readFile(file).catch(() => null);
    if (!body) return send(res, 404, 'Not found');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(body);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err));
  });
  await new Promise<void>((ok) => server.listen(opts.port, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    db,
    url: `http://127.0.0.1:${port}${opts.base}`,
    close: () => new Promise<void>((ok) => server.close(() => (db.close(), ok()))),
  };
}

if (import.meta.main) {
  const running = await start({ port: Number(env('PORT')), base: env('BASE_PATH'), dataDir: env('DATA_DIR'), keysDir: env('CITADEL_KEYS') });
  console.log(`${APP} listening on ${running.url}`);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => void running.close().then(() => process.exit(0)));
}
