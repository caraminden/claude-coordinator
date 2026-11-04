// Sessions read a person's data in a contraption (#295; the contract is in shared/project/specs/contraptions/
// app-rail.md, "Letting sessions read a person's data"). A minion's or Taskmaster's contraption_read tool
// calls POST /api/contraption-read/<app> with { command?, args? }, and Citadel calls the contraption itself:
//   - gated like mandate_item (typedPersonFor): only for the person whose own typed message the turn answers,
//     on the scheme, with the app enabled. The tool takes no person, so it can't aim at anyone else.
//   - no command: GET /apps/<app>/app-api/read, the app's read commands; else POST …/app-api/read/<command>
//     with args as the JSON body. Signed with the app's own key, `from` scheme-<id>. Read-only is the app's
//     contract to keep: Citadel only ever calls these two paths.
//   - the app's status and body come back as { status, answer }, the body cut at READ_MAX bytes (truncated: READ_MAX); the tool's description says 64 KB too.
import { CONTRAPTION_NAME } from './contraptions.ts';
import { HttpError, json, readJson, type Ctx } from './http.ts';
import { typedPersonFor } from './mandate-items.ts';

const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TIMEOUT_MS = 15_000;
/** Bytes of an answer passed back: about 16k tokens, so one big read can't flood the session's context. */
const READ_MAX = 64 * 1024;

export async function contraptionRead({ req, res, app, params, caller }: Ctx) {
  const given = await readJson(req, 64 * 1024);
  const { command, args } = (given ?? {}) as { command?: unknown; args?: unknown };
  if (!CONTRAPTION_NAME.test(params.app)) throw new HttpError(400, 'app must be a contraption name, like mandate');
  if (command !== undefined && (typeof command !== 'string' || !COMMAND.test(command))) throw new HttpError(400, 'command must be one of the names the app lists: letters, digits, . _ -');
  if (args !== undefined && (command === undefined || !args || typeof args !== 'object' || Array.isArray(args))) throw new HttpError(400, 'args must be a JSON object, and only with a command');

  const { contraption: c, identity } = typedPersonFor(app, caller!, params.app, `read their data in ${params.app}`);
  let status: number, answer: unknown, truncated = false;
  try {
    const r = await fetch(`http://127.0.0.1:${c.port}/apps/${c.name}/app-api/read${command ? `/${command}` : ''}`, {
      method: command ? 'POST' : 'GET',
      headers: { 'X-Citadel-Identity': identity, Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json' } : {}) },
      body: command ? JSON.stringify(args ?? {}) : undefined, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = r.status;
    const body = await capped(r);
    truncated = body.cut;
    try {
      answer = truncated ? body.text : JSON.parse(body.text);
    } catch {
      answer = body.text;
    }
  } catch (err: any) {
    if (err?.name === 'TimeoutError') throw new HttpError(504, `${c.title} didn't answer within ${TIMEOUT_MS / 1000} s`);
    throw new HttpError(502, `${c.title} is not answering`);
  }
  json(res, 200, { status, answer, ...(truncated ? { truncated: READ_MAX } : {}) });
}

/** A response's body as text, read no further than READ_MAX bytes. */
async function capped(r: Response): Promise<{ text: string; cut: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of r.body ?? []) {
    chunks.push(Buffer.from(chunk));
    size += chunk.length;
    if (size > READ_MAX) break; // leaving the loop cancels the rest of the body
  }
  // A cut can split a character: toString drops the broken tail into U+FFFD, which is fine for a preview.
  return { text: Buffer.concat(chunks).subarray(0, READ_MAX).toString('utf8'), cut: size > READ_MAX };
}
