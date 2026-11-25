// The settings keys a minion's turn, session and dismissal are kept under, shared by src/runner.ts and the files split out of it (#1840).
import type { Ticket } from './db.ts';

/** A minion's context size at its last turn's last API call (tokens), for what switching its payer costs. */
export const contextKey = (ticketId: number) => `context:${ticketId}`;
/** The model's context window (tokens) as its last result reported it, for the chat's size meter (#1193). */
export const windowKey = (ticketId: number) => `ctxwin:${ticketId}`;
export const freshKey = (ticketId: number) => `fresh:${ticketId}`;
/** The handoff a fresh session's first turn starts from, kept until that session exists. */
export const handoffKey = (ticketId: number) => `handoff:${ticketId}`;
/** A claim holder whose work shipped (#1334): its claims pass on as shipped when it is dismissed. */
export const shippedKey = (ticketId: number) => `claim-shipped:${ticketId}`;
/** The note the server last wrote about a failed or stopped turn, which the next turn that ends well clears (#428). */
export const failNoteKey = (ticketId: number) => `failnote:${ticketId}`;
/** Why a minion's close_self was cancelled at its turn's end, told to its next turn (#619). */
export const closeCancelledKey = (ticketId: number) => `close-cancelled:${ticketId}`;
export const turnKey = (ticketId: number) => `turn:${ticketId}`;
/** A minion's session as the account pick knows it (#793): only one it resumes can be warm, so a fresh start goes where new work goes. */
export const warmKey = (ticket: Ticket) => (ticket.session_id ? `ticket:${ticket.id}` : undefined);
/** Set when a person writes to a minion waiting in pending-deploy: its deploy then leaves it open. */
export const talkedKey = (ticketId: number) => `talked-since-deploy:${ticketId}`;
/** A turn's end-of-turn session save that hasn't finished yet: the config dir it reads, so a restart redoes it (#259). */
export const savingKey = (ticketId: number) => `saving:${ticketId}`;
export const commandsKey = (ticketId: number) => `commands:${ticketId}`;
export const schemeCommandsKey = (projectId: number) => `commands-scheme:${projectId}`;
