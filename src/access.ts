// Who sees what: a person sees the schemes they own or are a member of (an admin sees all), and the
// live stream only carries a scheme's news to its people.
import type { Session } from './auth.ts';
import type { Project, Store, Ticket } from './db.ts';

/** Stream messages only admins get: the Machines page and Citadel-wide instructions. */
const ADMIN_ONLY = new Set(['machines', 'app-instructions']);

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
 * and Max plans are per person). A message from no person (GitHub, a wake, another thread) counts
 * as the scheme owner's.
 */
export function turnRefusal(store: Store, ticket: Ticket, author: string): string | null {
  const person = store.findUser('name', author);
  const who = person ?? store.getUser(store.getProject(ticket.project_id)?.owner_id ?? -1);
  if (who?.server_login && !who.disabled_at) return null;
  return person
    ? `Turns for ${person.name} start once they link their Claude account, so this message waits here and Claude hasn't seen it.`
    : `Turns in this scheme start once its owner${who ? `, ${who.name},` : ''} links their Claude account, so this message waits here and Claude hasn't seen it.`;
}

/** The connected machines (Cara's laptop, perigee's GPU) are an admin's: only their schemes' minions get them. */
export function lendsMachines(store: Store, project: Project): boolean {
  return !!store.getUser(project.owner_id ?? -1)?.admin;
}
