// Schemes put items in the asking person's Mandate (#268; shared/project/specs/contraptions/
// scheme-items-brief.md, and scheme-items-contract.md for Mandate's side). A minion's or Taskmaster's
// mandate_item tool calls PUT | DELETE /api/mandate/items/<key>; Citadel makes the call itself, so no key
// reaches a worktree:
//   - only for the one person whose own typed message the turn answers (Runner.typedBy): never on a GitHub
//     or system message, a relay, a wake, a resume or a contraption's ask; that person must be on the
//     scheme and have Mandate enabled. The tool takes no person, so it can't aim at anyone else.
//   - straight to Mandate's own service (no relay hop), at /apps/mandate/app-api/items/<number>.<key>,
//     with an identity signed by Mandate's key whose `from` is scheme-<id> and `fromTitle` the scheme's name;
//     hook: true always, and link the minion's page. The number routes her ticks back (relay.ts schemeHook).
//   - Mandate's status and body come back as { status, answer }; Citadel's own refusals are HTTP errors.
import { APP_NAME } from './appname.ts';
import { HttpError, json, readJson, type Ctx } from './http.ts';

/** Contraption names Citadel keeps for its schemes when it calls Mandate for one. */
export const SCHEME_CALLER = /^scheme-\d+$/;
/** Mandate's item key, which ours (`<minion number>.<key>`) must fit. */
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const TIMEOUT_MS = 10_000;
const FIELDS = ['title', 'day', 'time', 'at', 'alert'] as const;

/** Settings key for an item's title, which a hook (carrying only the key) quotes back to the minion. */
// shortcut: a ticked or deleted item's row stays until the minion clears its key; prune if settings ever grows from it.
export const titleKey = (projectId: number, person: number, key: string) => `mandate-title:${projectId}:${person}:${key}`;

export async function mandateItem({ req, res, app, params, caller }: Ctx) {
  const { store, contraptions, runner } = app;
  const ticket = caller!;
  // The Taskmaster has no number: 0 stands for it.
  const prefix = `${ticket.number ?? 0}.`;
  const key = prefix + params.key;
  if (!KEY.test(key) || !params.key) throw new HttpError(400, `key must be 1 to ${128 - prefix.length} letters, digits, dots, underscores, colons or dashes`);

  const uid = runner.typedBy(ticket.id);
  const user = uid === null ? undefined : store.getUser(uid);
  if (!user || user.disabled_at) throw new HttpError(403, "Only a turn answering a person's own typed message may put items in their Mandate, and this one isn't (a GitHub or system message, a relay, a wake, or several people). Ask them to send the request in this chat.");
  if (!store.canSee({ uid: user.id, admin: !!user.admin }, ticket.project_id)) throw new HttpError(403, `${user.name} isn't on this scheme`);
  const mandate = store.getContraption('mandate');
  if (!mandate) throw new HttpError(404, `Mandate isn't registered in ${APP_NAME}`);
  if (!contraptions.enabled(mandate.name, user.id)) throw new HttpError(403, `${user.name} doesn't have Mandate enabled`);
  const project = store.getProject(ticket.project_id)!;
  const identity = contraptions.signIdentity(mandate.name, user, { name: `scheme-${project.id}`, title: project.name });
  if (!identity) throw new HttpError(503, `${mandate.title}'s keys don't open; an admin can rotate them in Settings → Contraptions`);

  let body: Record<string, unknown> | undefined;
  if (req.method === 'PUT') {
    const given = await readJson(req, 16 * 1024);
    body = { hook: true, link: `/#/p/${project.id}${ticket.number === null ? '' : `/t/${ticket.number}`}` };
    for (const f of FIELDS) if (given[f] !== undefined) body[f] = given[f];
  }
  let status: number, answer: unknown;
  try {
    const r = await fetch(`http://127.0.0.1:${mandate.port}/apps/${mandate.name}/app-api/items/${key}`, {
      method: req.method,
      headers: { 'X-Citadel-Identity': identity, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body && JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = r.status;
    const text = await r.text();
    try {
      answer = JSON.parse(text);
    } catch {
      answer = text.slice(0, 2000);
    }
  } catch (err: any) {
    if (err?.name === 'TimeoutError') throw new HttpError(504, `${mandate.title} didn't answer within ${TIMEOUT_MS / 1000} s`);
    throw new HttpError(502, `${mandate.title} is not answering`);
  }
  // A put on a ticked or deleted item changes nothing in Mandate, so neither does it here.
  if (status === 200 && body && typeof body.title === 'string' && (answer as any)?.state === 'open') store.setSetting(titleKey(project.id, user.id, key), body.title);
  if (status === 200 && !body) store.deleteSetting(titleKey(project.id, user.id, key));
  json(res, 200, { status, answer });
}
