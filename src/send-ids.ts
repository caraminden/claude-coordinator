// A person's message box tags each message with a sendId, the same on every retry of it (#392). A retry of
// one the server already took (its reply lost on the way back) is answered without sending it twice.
// shortcut: kept in memory for ten minutes, so a restart between a send and its retry, or a retry more than
// ten minutes after a lost reply, sends it again; persist it if that bites.

const SEND_ID_MS = 10 * 60_000;
const seen = new Map<string, { at: number; done: Promise<void> }>(); // `${ticket}:${sendId}`, oldest first

/** A sendId worth keeping: a short string (else the message goes untagged, as before #392). */
export const sendIdOf = (v: unknown): string | undefined => (typeof v === 'string' && v && v.length <= 100 ? v : undefined);

/**
 * Run `send` unless this chat already took `sendId`. A repeat waits for the first one's outcome and shares
 * it: done when it went, the same error when it failed (and then forgotten, so the next retry goes).
 * Untagged messages always run.
 */
export async function sendOnce(ticketId: number, sendId: string | undefined, send: () => Promise<void>, now = Date.now()): Promise<void> {
  for (const [k, { at }] of seen) {
    if (now - at < SEND_ID_MS) break;
    seen.delete(k);
  }
  if (!sendId) return send();
  const key = `${ticketId}:${sendId}`;
  const first = seen.get(key);
  if (first) return first.done;
  const done = send();
  const entry = { at: now, done };
  seen.set(key, entry);
  try {
    await done;
  } catch (err) {
    if (seen.get(key) === entry) seen.delete(key);
    throw err;
  }
}
