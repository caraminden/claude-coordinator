// Who sees what: a person sees the schemes they own or are a member of (an admin sees all), the
// live stream only carries a scheme's news to its people, and a Taskmaster writes only to schemes its person is in (and Citadel).
import type { Session } from './auth.ts';
import type { TurnPlace } from './claude-link.ts';
import type { Machine, Project, Store, Ticket, TicketFields, User } from './db.ts';
import { APP_NAME } from './appname.ts';
import type { Role } from './machine-roles.ts';
import { GLOBAL_OWNER } from './properties.ts';

/** Stream messages only admins get: Citadel-wide instructions. (The machines list goes to each person filtered: server.ts broadcast.) */
const ADMIN_ONLY = new Set(['app-instructions']);

/** What messageScope reads of a stream message: each kind (`type`) carries its own. */
interface StreamMessage {
  type: string;
  projectId?: unknown;
  ticketId?: unknown;
  ticket?: { project_id: number };
  project?: { id: number };
  event?: { ticket_id?: unknown };
}

/** The scheme a stream message is about, 'admin' for admin-only news, or null for everyone's. */
export function messageScope(store: Store, message: object): number | 'admin' | null {
  const msg = message as StreamMessage;
  if (ADMIN_ONLY.has(msg.type)) return 'admin';
  if (typeof msg.projectId === 'number') return msg.projectId;
  if (msg.projectId === undefined && 'projectId' in msg) return 'admin'; // its minion is gone
  if (msg.type === 'ticket') return msg.ticket!.project_id;
  if (msg.type === 'project') return msg.project!.id;
  const ticketId = msg.type === 'event' ? msg.event!.ticket_id : msg.ticketId;
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
 * Who pays for a turn: whose Claude login it runs on, and whose GitHub login it pushes as. The one rule every start path
 * asks (#1270): src/runner.ts turnPerson (a queued start, held mail, a keepalive, a resume) and turnRefusal below.
 * Sender pays: the first person in its messages. A relay counts as its sender's asker, a person's own Taskmaster (#919)
 * runs for its person unless someone else wrote there, and a split scheme's Overlord is nobody's own (Cara's R4,
 * "Starter, else owner", #921). A resume (`resuming`) carries on the interrupted turn, so it runs for that turn's person.
 * With none of those, the minion's last person, else the scheme's owner. Anyone picked by a fallback rather than by
 * their own message (a relay's asker, a Taskmaster's person, the minion's last person) must still be in the scheme:
 * someone taken out of it (or deleted) no longer pays for its turns, its owner does (#211, #1270). A disabled person
 * is still picked, so their turn is refused (turnPlace) rather than moved onto someone else's plan. A message whose author
 * names no person but which carries an `asker` (a contraption's ask to the Taskmaster, sent under the contraption's label)
 * is that asker's, checked like a relay's (#1449). Held mail rides along after what woke the turn and doesn't pick who pays
 * for it: a wake from no person runs on the minion's last person, not on a held message's author (#1509). Held mail names
 * the payer only with nothing else waiting ("Deliver now"), when its author is disabled (so it is refused, above), and on
 * a person's own Taskmaster, where a held ask from someone else runs on theirs (below). A plain list is all what woke it.
 */
export function turnPayer(store: Store, ticket: TicketFields, project: Project, waiting: PayerMsg[] | { msgs: PayerMsg[]; held: PayerMsg[] }, personOf: (author: string, from?: number) => number | null, resuming = false): number | null {
  const { msgs, held } = Array.isArray(waiting) ? { msgs: waiting, held: [] } : waiting;
  const batch = [...msgs, ...held];
  const inScheme = (p: number | null) => payerInScheme(store, project, p);
  // Whose ask a message is, and whether that was picked for it (a relay's or a contraption's asker) rather than written by them.
  const askOf = (m: { author: string; from?: number; asker?: number | null }) => {
    const p = personOf(m.author, m.from);
    if (p) return { p, picked: !!m.from };
    return m.asker != null ? { p: m.asker, picked: true } : null;
  };
  if (resuming && ticket.person_id != null) return inScheme(ticket.person_id);
  // A message from someone disabled after it queued is still theirs (personOf drops them): its turn is refused, not moved onto another login.
  // The runner drops such messages before it asks (Runner.dropDisabled, #1509); this still refuses a single message's check.
  const disabled = batch.map((m) => disabledAuthor(store, m)).find((u) => u);
  if (disabled) return disabled.id;
  // A person's own Taskmaster runs for its person, but never on someone else's request: a turn another person starts
  // there (a card answer, R5, a plan verdict, a file comment, /backup) runs on their login. Relays and held mail name
  // no person, so they leave it on its person's.
  if (ticket.kind === 'coordinator' && ticket.coordinator_of != null) {
    const starter = batch
      .filter((m) => !m.from)
      .map(askOf)
      .find((a) => a);
    return inScheme(starter?.p ?? ticket.coordinator_of);
  }
  for (const m of msgs.length ? msgs : held) {
    const a = askOf(m);
    if (a) return a.picked ? inScheme(a.p) : a.p;
  }
  const overlord = ticket.kind === 'coordinator' && ticket.coordinator_of == null && store.isSplit(ticket.project_id);
  return !overlord && ticket.person_id != null ? inScheme(ticket.person_id) : project.owner_id;
}

type PayerMsg = { author: string; from?: number; asker?: number | null };

/** The person who wrote `m` themselves (not a relay), when their login is disabled (#1270 C3). */
export function disabledAuthor(store: Store, m: PayerMsg): User | undefined {
  const u = m.from ? undefined : store.findUser('name', m.author);
  return u?.disabled_at ? u : undefined;
}

/** `person` while they may still be paid for in this scheme (a member, its owner, or an admin), else the scheme's owner (#211, #1270). */
export function payerInScheme(store: Store, project: Project, person: number | null): number | null {
  const user = person === null ? undefined : store.getUser(person);
  return user && store.canSee({ uid: user.id, admin: !!user.admin }, project.id) ? person : project.owner_id;
}

/**
 * Why a message can't start or steer a turn yet, or null when it can. Until people link their own
 * Claude accounts, turns run on the server's login, which only people an admin allowed may use (Pro
 * and Max plans are per person). A message is checked against whoever its turn would run for, by turnPayer's rule
 * (#468 S02-2, #1270); a disabled person's own message is refused as theirs.
 */
export function turnRefusal(store: Store, ticket: Ticket, author: string, linked: ClaudeLinked = () => null, from?: number, asker?: number | null): string | null {
  const project = store.getProject(ticket.project_id);
  const named = from ? undefined : store.findUser('name', author);
  const id = project ? turnPayer(store, ticket, project, [{ author, from, asker }], messagePerson(store)) : null;
  const who = store.getUser(id ?? -1);
  if (!who) return "Turns in this scheme start once its owner links their Claude account, so this message waits here and Claude hasn't seen it.";
  // Worded for the owner when it runs on their plan for a message they didn't write (GitHub, a schedule, a relay).
  return claudeRefusal(who, linked, who.id === project?.owner_id && who.id !== named?.id);
}

/**
 * Where `person`'s turn runs (src/runner.ts placeFor), or why it can't: sender pays (#213), so the server login's owner
 * runs on the host and everyone else in their own container. No person (a scheme with no owner) runs on the host.
 */
export function turnPlace(store: Store, link: { place(uid: number, warm?: string, taskmaster?: boolean, only?: number[]): TurnPlace | null; linked: ClaudeLinked }, person: number | null, warm?: string, taskmaster = false, only?: number[]): TurnPlace | { refused: string } {
  const user = person ? store.getUser(person) : undefined;
  if (!user) return { host: true };
  // Disabled first (#1270 C3): a linked Claude would place the turn, and a resume, held mail or a queued start would run it.
  if (user.disabled_at) return { refused: claudeRefusal(user, (uid) => link.linked(uid))! };
  return link.place(user.id, warm, taskmaster, only) ?? { refused: claudeRefusal(user, (uid) => link.linked(uid)) ?? `${user.name}'s Claude isn't ready, so this message waits here.` };
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

/** Who may see and change a machine on the Machines page: its owner, and admins (all of them). */
export function managesMachine(who: Pick<Session, 'uid' | 'admin'>, machine: Pick<Machine, 'owner_id'>): boolean {
  return !!who.admin || (machine.owner_id !== null && machine.owner_id === who.uid);
}

/** The machines a person's Machines page and stream list: an admin's all, anyone else's their own. */
export function machinesFor<T extends Pick<Machine, 'owner_id'>>(who: Pick<Session, 'uid' | 'admin'>, machines: T[]): T[] {
  return who.admin ? machines : machines.filter((m) => managesMachine(who, m));
}

/**
 * Whether its owner lent this role to every turn in its schemes, not only the turns they ask for (Build 10 H1,
 * `caps.everyone`): the owner's "for my schemes". Minion turns never: a turn runs only on its sender's own Claude login.
 */
export function lendsToEveryone(store: Store, machine: Pick<Machine, 'id'>, role: Role): boolean {
  return role !== 'turns' && !!store.machineRoles(machine.id).find((r) => r.role === role)?.caps.everyone;
}

/**
 * Whether a machine lends this role to this scheme, for a turn `askers` asked for (Build 7 M1): only if the role is
 * switched on and its list of schemes has this one (#438's one list, a list per role since M1), and its owner is in the
 * scheme. Every machine has an owner (Build 10 H1); a role it lent to everyone (lendsToEveryone) goes to any turn there,
 * else only to turns its owner asked for (#306, Josh: "any scheme they are in ... can use their machine to do stuff on
 * their behalf"). CI runners and builds (H2: a build runs no Claude), which no turn asks for, need only the owner in the scheme. A row with no owner (one the
 * backfill could name no one for) lends nothing. */
export function lendsRole(store: Store, machine: Machine, role: Role, project: Project, askers: readonly number[] = []): boolean {
  if (!store.roleGrants(machine.id, role, project.id)) return false;
  if (role === 'ci' || role === 'builds') return ownerAsked(store, machine.owner_id, [machine.owner_id ?? -1], project.id);
  if (lendsToEveryone(store, machine, role)) return ownerAsked(store, machine.owner_id, [machine.owner_id ?? -1], project.id);
  return ownerAsked(store, machine.owner_id, askers, project.id);
}

/**
 * Whether a Taskmaster's turn may list and check this machine (#307): any machine for an admin's ask, else
 * one whose tools a turn its asker started in this scheme would get (lendsRole).
 */
export function taskmasterSeesMachine(store: Store, machine: Machine, project: Project, askerId: number | null): boolean {
  const asker = askerId === null ? undefined : store.getUser(askerId);
  if (store.isAdmin(asker)) return true;
  return lendsRole(store, machine, 'tools', project, askerId === null ? [] : [askerId]);
}

/** Whether a machine's owner is among a turn's askers and, for a scheme's turn, in that scheme. No owner: never. */
export function ownerAsked(store: Store, ownerId: number | null, askers: readonly number[], projectId: number | null): boolean {
  const owner = store.getUser(ownerId ?? -1);
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
  const who = { uid: user?.id, admin: store.isAdmin(user) };
  const inFrom = store.canSee(who, from);
  return store.listProjects().filter((p) => p.id !== from && (p.id === GLOBAL_OWNER || (inFrom && store.canSee(who, p.id)) || (from === GLOBAL_OWNER && now - (store.getSetting<number>(askedCitadelKey(p.id)) ?? -Infinity) < CITADEL_REPLY_MS)));
}

/**
 * Why a Taskmaster's turn may not use an admin-only tool or route (#255), or null when an admin asked
 * for it (Store.turnAsker). Whom it runs as doesn't count: a non-member's relay runs as the scheme's owner.
 */
export function adminAskRefusal(store: Store, ticketId: number): string | null {
  const id = store.turnAsker(ticketId);
  const user = id === null ? undefined : store.getUser(id);
  if (store.isAdmin(user)) return null;
  return `Only a turn a ${APP_NAME} admin asked for may do this, and this one is ${user ? `${user.name}'s` : "no one's"} ask. Ask a ${APP_NAME} admin or a member of the ${APP_NAME} scheme to send the request in this chat.`;
}

/** Whose ask a message is (src/runner.ts personOf): a person by name, or for a relay the asker of the turn that sent it. */
export const messagePerson =
  (store: Store) =>
  (author: string, from?: number): number | null => {
    if (from) return store.turnAsker(from);
    const u = store.findUser('name', author);
    return u && !u.disabled_at ? u.id : null;
  };

/**
 * A cabal's board as one reader sees it (#2094), `sees` saying which schemes they are in. A member of the lead's scheme
 * sees the whole board, members in other schemes included. A reader in only a member's scheme sees the lead's name and
 * the rows and asks of the schemes they are in, without its log or red-run line. A chat opens only for its scheme's members.
 */
export function cabalBoardFor<B extends { lead: { project_id: number; open: boolean }; members: { project_id: number | null; scheme: string | null; number: number | null; open: boolean }[]; asks: { number: number | null; scheme: string | null }[]; log: unknown[]; red: unknown }>(
  board: B,
  sees: (projectId: number) => boolean,
): B {
  const lead = board.lead.project_id;
  const whole = sees(lead);
  const members = board.members.filter((m) => whole || (m.project_id != null && sees(m.project_id))).map((m) => ({ ...m, open: sees(m.project_id ?? lead) }));
  if (whole) return { ...board, lead: { ...board.lead, open: true }, members };
  const mine = new Set(members.map((m) => `${m.scheme}#${m.number}`));
  return { ...board, lead: { ...board.lead, open: false }, members, asks: board.asks.filter((a) => a.scheme != null && mine.has(`${a.scheme}#${a.number}`)), log: [], red: null };
}
