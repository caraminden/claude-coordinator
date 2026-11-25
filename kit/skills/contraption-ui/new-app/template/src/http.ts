// Server helpers every contraption needs: one error type, a size-limited JSON body reader that returns
// `unknown` (check its shape before use), JSON and text replies, and Citadel's env. Copy this file as it is.
import type { IncomingMessage, ServerResponse } from 'node:http';

/** An answer with a status: throw it anywhere in a handler and `sendError` turns it into the reply. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The largest request body `readJson` accepts, in bytes. Pass a bigger `limit` to a route that needs it. */
export const MAX_JSON_BYTES = 1_000_000;

/** Reads a JSON request body. Throws 413 past `limit` bytes and 400 on bad JSON; an empty body is `{}`. Narrow the result before use. */
export async function readJson(req: IncomingMessage, limit = MAX_JSON_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

export const send = (res: ServerResponse, status: number, body = '', type = 'text/plain; charset=utf-8') => void res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);

export const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body), 'application/json');

/** Answers a thrown HttpError with its status and message; anything else is a 500 that says nothing about the cause. */
export function sendError(res: ServerResponse, err: unknown) {
  if (res.headersSent) return;
  if (err instanceof HttpError) return json(res, err.status, { error: err.message });
  console.error(err);
  send(res, 500, 'Something went wrong');
}

/** A variable Citadel sets on the service (PORT, BASE_PATH, DATA_DIR, CITADEL_KEYS, CITADEL_URL). Throws when it is missing. */
export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: Citadel sets it on the service`);
  return value;
}

/**
 * Where to call Citadel. Read CITADEL_URL; never type Citadel's address. The one fallback is for a local dev run:
 * with NODE_ENV=development it is the dev default, anywhere else a missing CITADEL_URL throws.
 */
export function citadelUrl(): string {
  if (process.env.CITADEL_URL) return process.env.CITADEL_URL.replace(/\/$/, '');
  if (process.env.NODE_ENV === 'development') return 'http://127.0.0.1:8573';
  return env('CITADEL_URL');
}
