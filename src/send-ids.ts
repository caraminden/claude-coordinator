// A person's message box tags each message with a sendId, the same on every retry of it (#392). A retry of
// one the server already took (its reply lost on the way back) is answered without sending it twice.
// shortcut: kept in memory, so a restart between a send and its retry forgets it; persist it if that bites.

const SEND_ID_MS = 10 * 60_000;
const seen = new Map<string, number>(); // `${ticket}:${sendId}` → when first seen, oldest first

/** A sendId worth keeping: a short string (else the message goes untagged, as before #392). */
export const sendIdOf = (v: unknown): string | undefined => (typeof v === 'string' && v && v.length <= 100 ? v : undefined);

/** Whether this is the first time this chat sees `sendId` (recording it); untagged messages are always first. */
export function firstSend(ticketId: number, sendId: string | undefined, now = Date.now()): boolean {
  for (const [k, at] of seen) {
    if (now - at < SEND_ID_MS) break;
    seen.delete(k);
  }
  if (!sendId) return true;
  const key = `${ticketId}:${sendId}`;
  if (seen.has(key)) return false;
  seen.set(key, now);
  return true;
}

/** Forget a sendId whose send then failed, so its retry goes. */
export const forgetSend = (ticketId: number, sendId: string | undefined) => sendId && seen.delete(`${ticketId}:${sendId}`);
