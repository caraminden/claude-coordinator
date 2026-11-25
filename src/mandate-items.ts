// Schemes put items in the asking person's Mandate (#268; shared/project/specs/contraptions/
// scheme-items-brief.md, and scheme-items-contract.md for Mandate's side). A minion's or Taskmaster's
// mandate_item tool calls PUT | DELETE /api/mandate/items/<key>; Citadel makes the call itself, so no key
// reaches a worktree:
//   - only for the one person whose own typed message the turn answers (Runner.typedBy): never on a GitHub
//     or system message, a relay, a wake, a resume or a contraption's ask; that person must be on the
//     scheme and have Mandate enabled. The tool takes no person, so it can't aim at anyone else. Clearing an
//     item the chat put works on any turn, for everyone it was put for (#532): a fix landing or a PR merging
//     is news from GitHub or a wake, and an item left open after its cause is gone keeps nagging her.
//   - straight to Mandate's own service (no relay hop), at /apps/mandate/app-api/items/<number>.<key>,
//     with an identity signed by Mandate's key whose `from` is scheme-<id> and `fromTitle` the scheme's name;
//     hook: true always, and link the minion's page. The number routes her ticks back (relay.ts schemeHook).
//   - Mandate's status and body come back as { status, answer }; Citadel's own refusals are HTTP errors.
import { APP_NAME } from './appname.ts';
import type { ContraptionRow, Ticket } from './db.ts';
import { HttpError, json, readJson, type App, type Ctx } from './http.ts';
import { thrown } from './thrown.ts';

/** Contraption names Citadel keeps for its schemes when it calls Mandate for one. */
export const SCHEME_CALLER = /^scheme-\d+$/;
/** Mandate's item key, which ours (`<minion number>.<key>`) must fit. */
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const TIMEOUT_MS = 10_000;
const FIELDS = ['title', 'day', 'time', 'at', 'alert'] as const;

/** Settings key for an item's title, which a hook (carrying only the key) quotes back to the minion. */
// shortcut: a ticked or deleted item's row stays until the minion clears its key; prune if settings ever grows from it.
export const titleKey = (projectId: number, person: number, key: string) => `mandate-title:${projectId}:${person}:${key}`;

/** Who has item `key` (with its minion number) open from this scheme: the people whose titles are kept for it. */
function holders(store: App['store'], projectId: number, key: string): number[] {
  const prefix = `mandate-title:${projectId}:`; // titleKey's, up to the person
  return store
    .settingKeys(prefix)
    .map((k) => /^(\d+):(.*)$/s.exec(k.slice(prefix.length)))
    .filter((m) => m && m[2] === key)
    .map((m) => Number(m![1]));
}

/**
 * The person whose own typed message the caller's turn answers (Runner.typedBy), checked for a call into
 * contraption `name` on their behalf: on the scheme, the contraption registered and enabled for them, and an
 * identity for them signed with its key, `from` scheme-<id>. Shared by mandate_item and contraption_read (#295).
 */
export function typedPersonFor(app: App, ticket: Ticket, name: string, doing: string) {
  return personFor(app, ticket, app.runner.typedBy(ticket.id), name, doing);
}

function personFor(app: App, ticket: Ticket, uid: number | null, name: string, doing: string) {
  const { store, contraptions } = app;
  const user = uid === null ? undefined : store.getUser(uid);
  if (!user || user.disabled_at) throw new HttpError(403, `Only a turn answering a person's own typed message may ${doing}, and this one isn't (a GitHub or system message, a relay, a wake, or several people). Ask them to send the request in this chat.`);
  if (!store.canSee({ uid: user.id, admin: !!user.admin }, ticket.project_id)) throw new HttpError(403, `${user.name} isn't on this scheme`);
  const c = store.getContraption(name);
  if (!c) throw new HttpError(404, `${name} isn't registered in ${APP_NAME}`);
  if (!contraptions.enabled(c.name, user.id)) throw new HttpError(403, `${user.name} doesn't have ${c.title} enabled`);
  const project = store.getProject(ticket.project_id)!;
  const identity = contraptions.signIdentity(c.name, user, { name: `scheme-${project.id}`, title: project.name });
  if (!identity) throw new HttpError(503, `${c.title}'s keys don't open; an admin can rotate them in Settings → Contraptions`);
  return { user, project, contraption: c, identity };
}

export async function mandateItem({ req, res, app, params, caller }: Ctx) {
  const { store } = app;
  const ticket = caller!;
  // The Taskmaster has no number: 0 stands for it.
  const prefix = `${ticket.number ?? 0}.`;
  const key = prefix + params.key;
  if (!KEY.test(key) || !params.key) throw new HttpError(400, `key must be 1 to ${128 - prefix.length} letters, digits, dots, underscores, colons or dashes`);

  // A typed turn acts for its typist, as ever; any other may clear the item for everyone this chat put it for.
  const typed = app.runner.typedBy(ticket.id);
  const has = req.method === 'DELETE' && typed === null ? holders(store, ticket.project_id, key) : [];
  const given = req.method === 'PUT' ? await readJson(req, 16 * 1024) : null;
  let last: { status: number; answer: unknown } | undefined;
  for (const uid of has.length ? has : [typed]) {
    const { user, project, contraption: mandate, identity } = personFor(app, ticket, uid, 'mandate', has.length ? 'clear items in their Mandate' : 'put items in their Mandate');
    let body: Record<string, unknown> | undefined;
    if (given) {
      body = { hook: true, link: `/c/#/p/${project.id}${ticket.number === null ? '' : `/t/${ticket.number}`}` };
      for (const f of FIELDS) if (given[f] !== undefined) body[f] = given[f];
    }
    const { status, answer } = (last = await callMandate(mandate, identity, key, body));
    // A put on a ticked or deleted item changes nothing in Mandate, so neither does it here.
    if (status === 200 && body && typeof body.title === 'string' && (answer as { state?: unknown } | null | undefined)?.state === 'open') store.setSetting(titleKey(project.id, user.id, key), body.title);
    if (status === 200 && !body) store.deleteSetting(titleKey(project.id, user.id, key));
  }
  json(res, 200, last);
}

/**
 * One put (with `body`) or clear (without) of item `key` in a person's Mandate, signed as `identity`, straight to
 * Mandate's own service. Mandate's status and answer come back; a Mandate that is down or slow throws an HttpError.
 */
export async function callMandate(mandate: Pick<ContraptionRow, 'name' | 'title' | 'port'>, identity: string, key: string, body?: Record<string, unknown>): Promise<{ status: number; answer: unknown }> {
  try {
    const r = await fetch(`http://127.0.0.1:${mandate.port}/apps/${mandate.name}/app-api/items/${key}`, {
      method: body ? 'PUT' : 'DELETE',
      headers: { 'X-Citadel-Identity': identity, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body && JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    try {
      return { status: r.status, answer: JSON.parse(text) };
    } catch {
      return { status: r.status, answer: text.slice(0, 2000) };
    }
  } catch (err) {
    if (thrown(err).name === 'TimeoutError') throw new HttpError(504, `${mandate.title} didn't answer within ${TIMEOUT_MS / 1000} s`);
    throw new HttpError(502, `${mandate.title} is not answering`);
  }
}
