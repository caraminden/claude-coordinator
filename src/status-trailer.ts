// The status trailer (#711): a minion ends its final reply with `<!-- status: {"state":…,"note":…,"replies":[…]} -->`
// in place of a lone set_thread_status call before it, which cost a whole round trip. The runner strips it from what
// people see and applies the turn's last one when the turn's result comes in, through the same checks as the tool.

// Only at the very end of the text, so an example quoted earlier in a reply stays put; its body can't cross a `-->`.
const TRAILER = /\s*`?<!--\s*status:\s*((?:(?!-->)[\s\S])*?)\s*-->`?\s*$/;

/** The limits the tool descriptions and the prompt state: a note's characters, and a reply button's. */
export const NOTE_MAX = 60;
export const REPLY_MAX = 40;

/** The label fields a trailer may set; title and build stay with set_thread_status. */
export type StatusFields = { state?: unknown; note?: unknown; replies?: unknown };

/**
 * A reply's text without its closing status trailer, and its fields: `status` is null when there's none, and `bad`
 * says why one was there but couldn't be read (not JSON, or not an object with state, note or replies).
 */
export function takeStatus(text: string): { text: string; status: StatusFields | null; bad: string | null } {
  const m = TRAILER.exec(text);
  if (!m) return { text, status: null, bad: null };
  const rest = text.slice(0, m.index);
  let parsed: StatusFields | null;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return { text: rest, status: null, bad: `not JSON: ${m[1].slice(0, 80)}` };
  }
  // `<!-- status: null -->` means "state null": the only shape ignored live in the week to 2026-11-19 (#1154), so it's read, not refused.
  if (parsed === null) return { text: rest, status: { state: null }, bad: null };
  const status: StatusFields = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) for (const k of ['state', 'note', 'replies'] as const) if (k in parsed) status[k] = parsed[k];
  // An over-long note or reply is clipped, not refused: a refusal arrives after the turn is over, too late to fix, and drops the state with it.
  if (typeof status.note === 'string' && status.note.length > NOTE_MAX) status.note = `${status.note.slice(0, NOTE_MAX - 1).trimEnd()}…`;
  if (Array.isArray(status.replies)) status.replies = status.replies.map((r) => (typeof r === 'string' && r.length > REPLY_MAX ? `${r.slice(0, REPLY_MAX - 1).trimEnd()}…` : r));
  return Object.keys(status).length ? { text: rest, status, bad: null } : { text: rest, status: null, bad: `no state, note or replies in ${m[1].slice(0, 80)}` };
}
