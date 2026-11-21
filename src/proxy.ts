// Streaming a request to a service on a local port and its answer back, for previews (src/previews.ts)
// and contraptions (src/apps.ts). Answers stream as they come (event streams arrive event by event), a
// closed tab ends the upstream request, and websocket upgrades are tunnelled both ways.
import { request, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

export interface ForwardOptions {
  /** Shown when the service doesn't answer. */
  what: string;
  /** Refuse request bodies over this many bytes with a 413. */
  maxBody?: number;
  /** Edit the service's answer headers in place before they go to the browser. */
  answer?: (headers: IncomingHttpHeaders) => void;
  /** Told of a 5xx answer, or a 502 with `note` when the service didn't answer (the error digest, #835). */
  failed?: (status: number, note?: string) => void;
  /** How long a GET or HEAD is asked again (RETRY_MS); tests shorten it. */
  retryMs?: number;
  /** How long an event stream is asked again (STREAM_HOLD_MS); tests shorten it. */
  streamHoldMs?: number;
  /** Answered (503) when the service doesn't answer, in place of a bare 502: set only for a browser's page load (#1376). */
  downPage?: string;
}

/** How long a GET or HEAD keeps asking an app that refuses or drops it, as a restart does (#1173). */
export const RETRY_MS = 5000;
/**
 * How long an event stream's request waits for a service that doesn't answer before it is told to come back (#1376).
 * A browser's EventSource gives up for good on a 502, so a stream is never answered one: it waits here (headers
 * unsent, the page still "connecting"), and past this it gets an empty 200 stream with `retry:` that ends at once,
 * which every EventSource answers by asking again. So an open page picks its stream back up after any restart.
 */
export const STREAM_HOLD_MS = 25_000;
/** The `retry:` a stream told to come back gets, in ms. */
export const STREAM_RETRY_MS = 3000;

export function forward(req: IncomingMessage, res: ServerResponse, port: number, path: string, headers: OutgoingHttpHeaders, opts: ForwardOptions) {
  const max = opts.maxBody ?? Infinity;
  if (Number(req.headers['content-length'] ?? 0) > max) return void tooBig(req, res, max);
  let ended = false;
  // Only a GET or HEAD with no body is asked again: never a POST, so a snap can't post twice.
  const again = (req.method === 'GET' || req.method === 'HEAD') && !Number(req.headers['content-length'] ?? 0) && !req.headers['transfer-encoding'];
  const stream = again && /text\/event-stream/.test(String(req.headers.accept ?? ''));
  const start = Date.now();
  // A stream waits on even when the service was held for or stopped on purpose: it's a page left open.
  const until = start + (stream ? (opts.streamHoldMs ?? STREAM_HOLD_MS) : (opts.retryMs ?? RETRY_MS));
  let gone = false;
  let upstream: ClientRequest;
  const send = () => {
    upstream = request({ host: '127.0.0.1', port, method: req.method, path, headers }, (up) => {
      const out = { ...up.headers };
      opts.answer?.(out);
      res.writeHead(up.statusCode ?? 502, out);
      if ((up.statusCode ?? 502) >= 500) opts.failed?.(up.statusCode ?? 502);
      // An event stream's headers go out now, not with its first event.
      res.flushHeaders();
      up.pipe(res);
      // The service dropped its answer part way (a restart): end the browser's too, so an EventSource reconnects.
      up.on('close', () => up.complete || res.destroy());
    });
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      // An asker who left (a reload, a closed tab) saw no 502: ending its request is what errored here.
      if (ended || gone) return;
      if (res.headersSent) return void res.destroy();
      // Refused (not listening yet) or dropped (stopping, or a kept-alive socket it closed): a restart, so ask again.
      if (again && Date.now() < until && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')) return void setTimeout(() => gone || send(), Date.now() - start < RETRY_MS ? 200 : 1000);
      // Nobody sees this one: the page's EventSource just asks again (so it isn't in the error digest either).
      if (stream) return void res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }).end(`retry: ${STREAM_RETRY_MS}\n\n`);
      opts.failed?.(502, err.code ? `not answering: ${err.code}` : 'not answering');
      if (opts.downPage) return void res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '5', 'X-Content-Type-Options': 'nosniff' }).end(opts.downPage);
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end(`${opts.what} is not answering`);
    });
    if (again) upstream.end();
    else req.pipe(upstream);
  };
  // A closed tab ends its long-lived stream on the service too.
  res.on('close', () => {
    gone = !res.writableFinished;
    upstream.destroy();
  });
  if (max !== Infinity) {
    let n = 0;
    req.on('data', (chunk: Buffer) => {
      if ((n += chunk.length) <= max || ended) return;
      ended = true;
      req.unpipe(upstream);
      upstream.destroy();
      tooBig(req, res, max);
    });
  }
  if (again) req.resume();
  send();
}

function tooBig(req: IncomingMessage, res: ServerResponse, max: number) {
  if (res.headersSent) return void res.destroy();
  const text = `Request bodies are limited to ${max / 1024 / 1024} MiB`;
  res.writeHead(413, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(text), Connection: 'close' }).write(text);
  // Close only once the rest of the body is read: closing with it unread resets the connection, and a client
  // still sending gets EPIPE instead of this answer. server.requestTimeout (30 min) bounds it, as for any upload.
  req.resume();
  if (req.readableEnded) res.end();
  else req.once('end', () => res.end());
}

/** A raw HTTP answer on a socket whose request asked for an upgrade, which has no ServerResponse. */
export function answerRaw(socket: Duplex, status: number, reason: string, headers: OutgoingHttpHeaders = {}, body = '') {
  const lines = [`HTTP/1.1 ${status} ${reason}`];
  for (const [k, v] of Object.entries({ ...headers, 'Content-Length': Buffer.byteLength(body), Connection: 'close' })) {
    for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${one}`);
  }
  socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
}

/** Tunnel a websocket (or any upgrade) to the service: its answer goes back as it is, then bytes flow both ways. */
export function forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number, path: string, headers: OutgoingHttpHeaders, opts: ForwardOptions) {
  const upstream = request({ host: '127.0.0.1', port, method: req.method, path, headers });
  const status = (up: IncomingMessage, closing = false) => {
    const out = { ...up.headers };
    opts.answer?.(out);
    // The body goes on as it comes, ended by closing the socket.
    if (closing) Object.assign(out, { 'transfer-encoding': undefined, connection: 'close' });
    const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`];
    for (const [k, v] of Object.entries(out)) for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${one}`);
    return `${lines.join('\r\n')}\r\n\r\n`;
  };
  upstream.on('upgrade', (up, upSocket, upHead) => {
    socket.write(status(up));
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    // Either side going ends the other.
    socket.on('close', () => upSocket.destroy());
    upSocket.on('close', () => socket.destroy());
    upSocket.on('error', () => socket.destroy());
  });
  // The service answered without upgrading: pass its answer on and close.
  upstream.on('response', (up) => {
    socket.write(status(up, true));
    up.pipe(socket);
  });
  upstream.on('error', () => answerRaw(socket, 502, 'Bad Gateway', { 'Content-Type': 'text/plain' }, `${opts.what} is not answering`));
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.end();
}
