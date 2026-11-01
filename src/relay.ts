// The relay between contraptions (Mandate #21's brief, 2026-11-01): one contraption's server calls
// another's for a person, through Citadel, which holds both keys and who has which enabled. A direct call
// between local ports could check neither.
//
// GET | PUT | POST | DELETE /api/contraptions/relay/<to>/<path>, from the caller's own server (the turn
// API's reachability rule and Bearer key: Contraptions.caller), naming the person in X-Citadel-Person.
// Checks, in order: <to> registered and not the caller (404 no_route); the person enabled for both
// (403 not_enabled); /<path> under one of <to>'s relay_paths (404 no_route); a JSON body of at most
// 64 KiB, none on a GET (415, 413, 400). Then it goes to <to>'s service under /apps/<to>/ with only
// Content-Type, Accept and a fresh X-Citadel-Identity signed with <to>'s key, whose `from` and `fromTitle` claims name the caller;
// nothing else the caller sent (its key, its X-Citadel-* headers) reaches <to>. <to>'s status,
// Content-Type and body come back untouched; no answer in 10 s is a 504. No body is kept or logged.
//
// One <to> isn't a contraption: scheme-<id>, which only Mandate calls, at /mandate-hook, to tell a scheme
// its person ticked one of its items (#268; schemeHook below, and src/mandate-items.ts for the put).
import { isOpenPath } from './apps.ts';
import type { ContraptionRow } from './db.ts';
import { HttpError, json, type Ctx } from './http.ts';
import { titleKey } from './mandate-items.ts';

/** Who Mandate's hook messages are from in a minion's chat. */
const MANDATE_NAME = 'Mandate';

export const RELAY_MAX_BODY = 64 * 1024;
export const RELAY_TIMEOUT_MS = 10_000;

async function jsonBody(req: Ctx['req']): Promise<Buffer | undefined> {
  if (Number(req.headers['content-length'] ?? 0) > RELAY_MAX_BODY) throw new HttpError(413, `Relayed bodies are limited to ${RELAY_MAX_BODY / 1024} KiB`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    if ((size += chunk.length) > RELAY_MAX_BODY) throw new HttpError(413, `Relayed bodies are limited to ${RELAY_MAX_BODY / 1024} KiB`);
    chunks.push(chunk);
  }
  if (!size) return undefined;
  if (req.method === 'GET') throw new HttpError(400, 'A GET carries no body');
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'The relay carries JSON bodies only (Content-Type: application/json)');
  const body = Buffer.concat(chunks);
  try {
    JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not valid JSON');
  }
  return body;
}

function personOf(req: Ctx['req']): number {
  const person = Number(/^\d{1,15}$/.exec(String(req.headers['x-citadel-person'] ?? ''))?.[0] ?? NaN);
  if (!(person > 0)) throw new HttpError(400, "X-Citadel-Person must be a person's id");
  return person;
}

export async function relay(ctx: Ctx, from: ContraptionRow) {
  const { req, res, app, url, params } = ctx;
  const scheme = /^scheme-(\d{1,9})$/.exec(params.to);
  if (scheme) return schemeHook(ctx, from, Number(scheme[1]));
  const to = app.store.getContraption(params.to);
  if (!to || to.id === from.id) throw new HttpError(404, 'no_route');
  const person = personOf(req);
  if (!app.contraptions.enabled(from.name, person) || !app.contraptions.enabled(to.name, person)) throw new HttpError(403, 'not_enabled');
  const rest = `/${params.rest}`;
  if (!isOpenPath(JSON.parse(to.relay_paths) as string[], rest)) throw new HttpError(404, 'no_route');
  const body = await jsonBody(req);
  const identity = app.contraptions.signIdentity(to.name, app.store.getUser(person)!, from);
  if (!identity) throw new HttpError(503, `${to.title}'s keys don't open; an admin can rotate them in Settings → Contraptions`);

  const headers: Record<string, string> = { 'X-Citadel-Identity': identity };
  if (body) headers['Content-Type'] = String(req.headers['content-type']);
  if (req.headers.accept) headers.Accept = req.headers.accept;
  let status: number, type: string | null, answer: Buffer;
  try {
    const r = await fetch(`http://127.0.0.1:${to.port}/apps/${to.name}${rest}${url.search}`, {
      method: req.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    answer = Buffer.from(await r.arrayBuffer());
    [status, type] = [r.status, r.headers.get('content-type')];
  } catch (err: any) {
    if (err?.name === 'TimeoutError') throw new HttpError(504, `${to.title} didn't answer within ${RELAY_TIMEOUT_MS / 1000} s`);
    throw new HttpError(502, `${to.title} is not answering`);
  }
  res.writeHead(status, type ? { 'Content-Type': type } : {}).end(answer);
}

const HOOK_EVENTS = new Set(['ticked', 'unticked', 'deleted', 'restored']);

/**
 * Mandate telling a scheme its person ticked, unticked, deleted or restored one of its items (#268): only
 * Mandate, only POST /mandate-hook, for a person on the scheme with Mandate enabled. The key's
 * `<minion number>.` (0 for the Taskmaster) picks the chat, which hears it as a [Mandate] message, quoting
 * the title from the put. A closed or missing minion drops it with a log line, still answering 200 so
 * Mandate doesn't retry.
 */
async function schemeHook({ req, res, app, params }: Ctx, from: ContraptionRow, schemeId: number) {
  if (from.name !== 'mandate' || params.rest !== 'mandate-hook' || req.method !== 'POST') throw new HttpError(404, 'no_route');
  const person = personOf(req);
  const project = app.store.getProject(schemeId);
  if (!project) throw new HttpError(404, 'no_route');
  const user = app.store.getUser(person);
  if (!user || !app.contraptions.enabled(from.name, person) || !app.store.canSee({ uid: person, admin: !!user.admin }, schemeId)) throw new HttpError(403, 'not_enabled');
  const body = await jsonBody(req);
  const hook = body && JSON.parse(body.toString('utf8'));
  const m = typeof hook?.key === 'string' ? /^(\d{1,9})\.(.+)$/.exec(hook.key) : null;
  if (!m || !HOOK_EVENTS.has(hook.event)) throw new HttpError(400, 'A hook is { key: "<minion number>.<key>", event: ticked | unticked | deleted | restored }');
  const n = Number(m[1]);
  const ticket = n ? app.store.getTicketByNumber(schemeId, n) : app.store.getCoordinator(schemeId);
  if (!ticket || ticket.status === 'closed') {
    console.log(`Mandate hook for ${project.name} ${n ? `#${n}` : 'Taskmaster'} dropped: ${ticket ? 'closed' : 'no such minion'} (${hook.event} ${hook.key})`);
    return json(res, 200, { delivered: false });
  }
  const title = app.store.getSetting<string>(titleKey(schemeId, hook.key));
  const what = title ? `"${title.replace(/\s+/g, ' ')}"` : 'an item';
  app.runner.send(ticket.id, MANDATE_NAME, `${user.name} ${hook.event} ${what} (key ${m[2]})`, [], { asker: null });
  json(res, 200, { delivered: true });
}
