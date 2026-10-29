// HTTP plumbing for the API: one error type, JSON in and out, and the checks on what a request sends.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzip } from 'node:zlib';

/** An answer with a status: what any route or module throws to refuse a request. */
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const SECURITY_HEADERS = {
  // blob: lets the composer preview pasted images before they are sent.
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

// Responses to browsers that accept gzip. Caddy passes bodies through as they are, and a long
// thread's history is megabytes of JSON that gzips about 4x.
export const acceptsGzip = new WeakSet<ServerResponse>();
const MIN_GZIP_BYTES = 1400;

/** Send a whole body, gzipped when the browser accepts it and it is big enough to be worth it. */
export function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  if (buf.length < MIN_GZIP_BYTES || !acceptsGzip.has(res)) {
    res.writeHead(status, { Vary: 'Accept-Encoding', ...headers });
    return res.end(buf);
  }
  gzip(buf, { level: 6 }, (err, zipped) => {
    if (res.destroyed) return;
    if (err) {
      res.writeHead(status, { Vary: 'Accept-Encoding', ...headers });
      return res.end(buf);
    }
    res.writeHead(status, { Vary: 'Accept-Encoding', ...headers, 'Content-Encoding': 'gzip' });
    res.end(zipped);
  });
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  send(res, status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }, JSON.stringify(body));
}

export async function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<any> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Expected application/json');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/** A request's URL; a 400 for one that can't be parsed or decoded (`//`, `/%`) rather than a crash. */
export function requestUrl(req: IncomingMessage): URL {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    decodeURIComponent(url.pathname);
    return url;
  } catch {
    throw new HttpError(400, 'Bad request');
  }
}

export function clientIp(req: IncomingMessage): string {
  // Caddy appends the real client address, so only the right-most entry is trustworthy.
  const fwd = req.headers['x-forwarded-for'];
  const last = typeof fwd === 'string' ? fwd.split(',').pop()!.trim() : '';
  return last || req.socket.remoteAddress || '?';
}

export function isSecure(req: IncomingMessage): boolean {
  return req.headers['x-forwarded-proto'] === 'https';
}

/** One of a fixed set of values, or null when empty. */
export function oneOf(v: unknown, allowed: readonly string[], field: string): string | null {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !allowed.includes(v)) throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}`);
  return v;
}

export function buildNumber(v: unknown): number | null {
  if (v === null || v === '') return null;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 9999) throw new HttpError(400, 'Build must be a whole number from 1 to 9999');
  return v as number;
}

/** One-tap replies: up to 3 short texts, stored as JSON; none (null or []) clears them. */
export function replyList(v: unknown): string | null {
  if (v === null || (Array.isArray(v) && !v.length)) return null;
  if (!Array.isArray(v) || v.length > 3) throw new HttpError(400, 'Replies must be a list of at most 3');
  return JSON.stringify(v.map((r) => str(r, 'Reply', 40)));
}

export function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is too long`);
  return v.trim();
}
