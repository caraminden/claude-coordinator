// Who sees what: a person sees the schemes they own or are a member of (an admin sees all), the
// live stream only carries a scheme's news to its people, and a Taskmaster writes only to schemes its person is in (and Citadel).
import type { Session } from './auth.ts';
import type { Machine, Project, Store, Ticket, User } from './db.ts';
import { APP_NAME } from './appname.ts';
import { storedCheck } from './machines.ts';
import { GLOBAL_OWNER } from './properties.ts';

/** Stream messages only admins get: Citadel-wide instructions. (The machines list goes to each person filtered: server.ts broadcast.) */
const ADMIN_ONLY = new Set(['app-instructions']);

/** The scheme a stream message is about, 'admin' for admin-only news, or null for everyone's. */
export function messageScope(store: Store, msg: any): number | 'admin' | null {
  if (ADMIN_ONLY.has(msg.type)) return 'admin';
  if (typeof msg.projectId === 'number') return msg.projectId;
  if (msg.projectId === undefined && 'projectId' in msg) return 'admin'; // its minion is gone
  if (msg.type === 'ticket') return msg.ticket.project_id;
  if (msg.type === 'project') return msg.project.id;
  const ticketId = msg.type === 'event' ? msg.event.ticket_id : msg.ticketId;
  // A message about a minion that is gone goes to nobody but admins.
  if (typeof ticketId === 'number') return store.getTicket(ticketId)?.project_id ?? 'admin';
  return null;
}

/** Whether a stream message may go to this person. */
export function mayReceive(store: Store, who: Session, scope: number | 'admin' | null): boolean {
  if (scope === null || who.admin) return true;
  return scope !== 'admin' && store.canSee(who, scope);
}

/**
 * Why a message can't start or steer a turn yet, or null when it can. Until people link their own
 * Claude accounts, turns run on the server's login, which only people an admin allowed may use (Pro
 * and Max plans are per person). A message from no person is checked against whoever its turn would
 * run for, as src/runner.ts turnPerson picks them: a relay (`from`, the sending thread) as the asker
 * of the turn that sent it, or the scheme owner when that asker isn't in this scheme (#211); GitHub
 * or a wake as the minion's last person, else the scheme owner (#468 S02-2).
 */
export function turnRefusal(store: Store, ticket: Ticket, author: string, linked: ClaudeLinked = () => null, from?: number): string | null {
  const ownerId = store.getProject(ticket.project_id)?.owner_id ?? null;
  let id: number | null = null;
  if (from) {
    const asker = store.turnAsker(from);
    const user = asker !== null ? store.getUser(asker) : undefined;
    id = user && !store.canSee({ uid: user.id, admin: !!user.admin }, ticket.project_id) ? ownerId : asker;
  } else {
    const person = store.findUser('name', author);
    if (person) return claudeRefusal(person, linked);
  }
  id ??= ticket.person_id ?? ownerId;
  const who = store.getUser(id ?? -1);
  if (!who) return "Turns in this scheme start once its owner links their Claude account, so this message waits here and Claude hasn't seen it.";
  return claudeRefusal(who, linked, who.id === ownerId);
}

/** Whether a person has linked their own Claude (src/claude-link.ts): linked, expired, or not at all. */
export type ClaudeLinked = (uid: number) => 'linked' | 'expired' | null;

/**
 * Why turns can't run on this person's Claude (#213), or null when they can: on the server's login
 * (the Turns switch), or in their own container once linked and still signed in. `asOwner` words it
 * for a scheme owner whose plan a message from no person (GitHub, a schedule) would run on.
 */
export function claudeRefusal(who: User, linked: ClaudeLinked, asOwner = false): string | null {
  if (who.disabled_at) return `${who.name}'s login is disabled, so this message waits here and Claude hasn't seen it.`;
  if (who.server_login) return null;
  const state = linked(who.id);
  if (state === 'linked') return null;
  if (state === 'expired') return `${who.name}'s Claude sign-in expired, so this message waits here and Claude hasn't seen it. Link Claude again in Settings → Your account.`;
  return asOwner
    ? `Turns in this scheme start once its owner, ${who.name}, links their Claude account in Settings → Your account, so this message waits here and Claude hasn't seen it.`
    : `Turns for ${who.name} start once they link their Claude account in Settings → Your account, so this message waits here and Claude hasn't seen it.`;
}

/** Whether an admin owns this scheme: its Taskmaster may then register plugin folders for an admin's ask. */
export function adminOwned(store: Store, project: Project): boolean {
  return !!store.getUser(project.owner_id ?? -1)?.admin;
}

/** Who may see and change a machine on the Machines page: its owner, and admins (all of them, ownerless ones too). */
export function managesMachine(who: Pick<Session, 'uid' | 'admin'>, machine: Pick<Machine, 'owner_id'>): boolean {
  return !!who.admin || (machine.owner_id !== null && machine.owner_id === who.uid);
}

/** The machines a person's Machines page and stream list: an admin's all, anyone else's their own. */
export function machinesFor<T extends Pick<Machine, 'owner_id'>>(who: Pick<Session, 'uid' | 'admin'>, machines: T[]): T[] {
  return who.admin ? machines : machines.filter((m) => managesMachine(who, m));
}

/**
 * Whether a turn in this scheme, asked for by `askers`, gets this machine: only if the machine's list of schemes
 * has this one (#438, Cara: "Yes, one list per machine"), whoever owns the scheme. A person's own (#306, Josh:
 * "any scheme they are in ... can use their machine to do stuff on their behalf") also needs its owner to have
 * asked for the turn and to be in the scheme. A CI runner host lends turns nothing: its rows are for runner tokens
 * (ci-runner.ts mayFetch).
 */
export function lendsMachine(store: Store, machine: Machine, project: Project, askers: readonly number[] = []): boolean {
  if (storedCheck(machine)?.runners || !store.machineGranted(machine.id, project.id)) return false;
  return machine.owner_id === null || ownerAsked(store, machine.owner_id, askers, project.id);
}

/**
 * Whether a Taskmaster's turn may list and check this machine (#307): any machine for an admin's ask, else
 * one that a turn its asker started in this scheme would get (lendsMachine).
 */
export function taskmasterSeesMachine(store: Store, machine: Machine, project: Project, askerId: number | null): boolean {
  const asker = askerId === null ? undefined : store.getUser(askerId);
  if (asker?.admin && !asker.disabled_at) return true;
  return lendsMachine(store, machine, project, askerId === null ? [] : [askerId]);
}

/** Whether a machine's owner is among a turn's askers and, for a scheme's turn, in that scheme. */
export function ownerAsked(store: Store, ownerId: number, askers: readonly number[], projectId: number | null): boolean {
  const owner = store.getUser(ownerId);
  if (!owner || owner.disabled_at || !askers.includes(owner.id)) return false;
  return projectId === null || store.canSee({ uid: owner.id, admin: !!owner.admin }, projectId);
}

/** How long Citadel's Taskmaster may answer a scheme after that scheme's Taskmaster last wrote to it. */
export const CITADEL_REPLY_MS = 7 * 24 * 60 * 60_000;
/** When a scheme's Taskmaster last wrote to Citadel's (settings table). */
export const askedCitadelKey = (projectId: number) => `taskmaster-asked:${projectId}`;

/**
 * The schemes a Taskmaster turn in scheme `from`, run for `personId`, may message with
 * message_taskmaster: those that person is in as well as `from` (an admin is in all), Citadel always
 * (for bug reports and feature asks), and for Citadel's own Taskmaster, any scheme whose Taskmaster
 * wrote to it in the last CITADEL_REPLY_MS, so it can answer but never start a conversation there.
 */
export function taskmasterTargets(store: Store, from: number, personId: number | null, now: number): Project[] {
  const user = personId === null ? undefined : store.getUser(personId);
  const who = { uid: user?.id, admin: !!user?.admin };
  const inFrom = store.canSee(who, from);
  return store.listProjects().filter((p) => p.id !== from && (p.id === GLOBAL_OWNER
    || (inFrom && store.canSee(who, p.id))
    || (from === GLOBAL_OWNER && now - (store.getSetting<number>(askedCitadelKey(p.id)) ?? -Infinity) < CITADEL_REPLY_MS)));
}

/**
 * Why a Taskmaster's turn may not use an admin-only tool or route (#255), or null when an admin asked
 * for it (Store.turnAsker). Whom it runs as doesn't count: a non-member's relay runs as the scheme's owner.
 */
export function adminAskRefusal(store: Store, ticketId: number): string | null {
  const id = store.turnAsker(ticketId);
  const user = id === null ? undefined : store.getUser(id);
  if (user?.admin && !user.disabled_at) return null;
  return `Only a turn a ${APP_NAME} admin asked for may do this, and this one is ${user ? `${user.name}'s` : "no one's"} ask. Ask a ${APP_NAME} admin to send the request in this chat.`;
}

/** Whose ask a message is (src/runner.ts personOf): a person by name, or for a relay the asker of the turn that sent it. */
export const messagePerson = (store: Store) => (author: string, from?: number): number | null => {
  if (from) return store.turnAsker(from);
  const u = store.findUser('name', author);
  return u && !u.disabled_at ? u.id : null;
};
