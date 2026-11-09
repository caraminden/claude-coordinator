// The backup chat at /backup (#410): src/backup.html and these routes, for reaching the Citadel scheme's
// Taskmaster when the main front end is broken. Kept out of public/, the route table (src/routes/) and the
// front end's reload on purpose, so nothing they change can break it; test/backup.test.ts guards it.
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Auth } from './auth.ts';
import type { EventRow, Store } from './db.ts';
import { HttpError, json, readJson } from './http.ts';
import type { Runner } from './runner.ts';

export const BACKUP_PAGE = join(import.meta.dirname, 'backup.html');
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  // Its own policy: the app's (SECURITY_HEADERS) blocks the page's inline script and style.
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};
const LINES = 200;

export const isBackupPath = (path: string) => path === '/backup' || path.startsWith('/backup/');

/** One chat line as plain text: who said it and what, with no markdown or cards. */
export function chatLine(e: EventRow) {
  const data = JSON.parse(e.data);
  const base = { id: e.id, kind: e.kind, at: e.created_at };
  if (e.kind === 'user_message') return { ...base, author: String(data.author ?? ''), text: String(data.text ?? '') };
  if (e.kind === 'claude') {
    const text = (data.message?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => String(c.text ?? '')).join('\n\n');
    return { ...base, author: 'Taskmaster', text };
  }
  return { ...base, author: e.kind === 'error' ? 'Error' : 'Note', text: String(data.text ?? '') };
}

/** Serve /backup and its two calls for the scheme `projectId`, as the person signed in with the app's usual cookie. */
export async function serveBackup(app: { store: Store; runner: Runner; auth: Auth }, projectId: number, req: IncomingMessage, res: ServerResponse, url: URL) {
  const { store, runner, auth } = app;
  const method = req.method ?? 'GET';
  if (url.pathname === '/backup' || url.pathname === '/backup/') {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    const body = await readFile(BACKUP_PAGE);
    res.writeHead(200, { ...PAGE_HEADERS, 'Content-Length': body.length });
    return void res.end(method === 'HEAD' ? undefined : body);
  }
  const session = auth.session(req);
  if (!session || session.agent !== undefined) throw new HttpError(401, 'Not logged in');
  if (!store.canSee(session, projectId)) throw new HttpError(403, "You're not in the Citadel scheme");
  const taskmaster = store.getCoordinator(projectId);
  if (!taskmaster) throw new HttpError(404, "The Citadel scheme's Taskmaster hasn't started yet");

  if (url.pathname === '/backup/messages' && method === 'GET') {
    const rows = store.chatTextEvents(taskmaster.id, Number(url.searchParams.get('after')) || 0, LINES);
    return json(res, 200, { running: runner.isRunning(taskmaster.id), last: rows.at(-1)?.id ?? null, lines: rows.map(chatLine) });
  }
  if (url.pathname === '/backup/send' && method === 'POST') {
    // Cross-site writes are refused, as the route table does for /api/.
    const origin = req.headers.origin;
    if (origin) {
      let host: string | null = null;
      try {
        host = new URL(origin).host;
      } catch {}
      if (host !== (req.headers['x-forwarded-host'] ?? req.headers.host)) throw new HttpError(403, 'Cross-origin request');
    }
    const body = await readJson(req, 400_000);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HttpError(400, 'Type a message first');
    if (text.length > 100_000) throw new HttpError(413, 'That message is too long');
    // As the main chat sends a person's typed message: it steers a running turn, and lifts the loop guard.
    runner.send(taskmaster.id, session.name, text, [], { typed: true }, true);
    for (const t of store.listTickets(projectId)) runner.continueLoop(t.id, session.name);
    return json(res, 202, { running: runner.isRunning(taskmaster.id) });
  }
  throw new HttpError(404, 'Not found');
}
