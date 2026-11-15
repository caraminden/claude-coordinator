// The status trailer (#711): a minion ends its final reply with `<!-- status: {"state":…,"note":…,"replies":[…]} -->`
// in place of a lone set_thread_status call before it, which cost a whole round trip. The runner strips it from what
// people see and applies the turn's last one when the turn's result comes in, through the same checks as the tool.

// Only at the very end of the text, so an example quoted earlier in a reply stays put; its body can't cross a `-->`.
const TRAILER = /\s*`?<!--\s*status:\s*((?:(?!-->)[\s\S])*?)\s*-->`?\s*$/;

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
  let parsed: any;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return { text: rest, status: null, bad: `not JSON: ${m[1].slice(0, 80)}` };
  }
  const status: StatusFields = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) for (const k of ['state', 'note', 'replies'] as const) if (k in parsed) status[k] = parsed[k];
  return Object.keys(status).length ? { text: rest, status, bad: null } : { text: rest, status: null, bad: `no state, note or replies in ${m[1].slice(0, 80)}` };
}
