// Streaming a request to a service on a local port and its answer back, for previews (src/previews.ts)
// and contraptions (src/apps.ts). Answers stream as they come (event streams arrive event by event), a
// closed tab ends the upstream request, and websocket upgrades are tunnelled both ways.
import { request, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

export interface ForwardOptions {
  /** Shown when the service doesn't answer. */
  what: string;
  /** Refuse request bodies over this many bytes with a 413. */
  maxBody?: number;
  /** Edit the service's answer headers in place before they go to the browser. */
  answer?: (headers: IncomingHttpHeaders) => void;
}

export function forward(req: IncomingMessage, res: ServerResponse, port: number, path: string, headers: OutgoingHttpHeaders, opts: ForwardOptions) {
  const max = opts.maxBody ?? Infinity;
  if (Number(req.headers['content-length'] ?? 0) > max) return void tooBig(req, res, max);
  let ended = false;
  const upstream = request({ host: '127.0.0.1', port, method: req.method, path, headers }, (up) => {
    const out = { ...up.headers };
    opts.answer?.(out);
    res.writeHead(up.statusCode ?? 502, out);
    // An event stream's headers go out now, not with its first event.
    res.flushHeaders();
    up.pipe(res);
    // The service dropped its answer part way (a restart): end the browser's too, so an EventSource reconnects.
    up.on('close', () => up.complete || res.destroy());
  });
  upstream.on('error', () => {
    if (ended) return;
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }).end(`${opts.what} is not answering`);
    else res.destroy();
  });
  // A closed tab ends its long-lived stream on the service too.
  res.on('close', () => upstream.destroy());
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
  req.pipe(upstream);
}

function tooBig(req: IncomingMessage, res: ServerResponse, max: number) {
  if (res.headersSent) return void res.destroy();
  const text = `Request bodies are limited to ${max / 1024 / 1024} MiB`;
  res.writeHead(413, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(text), Connection: 'close' }).write(text);
  // Close only once the rest of the body is read: closing with it unread resets the connection, and a client
  // still sending gets EPIPE instead of this answer. Node's requestTimeout bounds how long that takes.
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
