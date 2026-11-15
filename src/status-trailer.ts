// The status trailer (#711): a minion ends its final reply with `<!-- status: {"state":…,"note":…,"replies":[…]} -->`
// in place of a lone set_thread_status call before it, which cost a whole round trip. The runner strips it from what
// people see and applies the turn's last one when the turn's result comes in, through the same checks as the tool.

const TRAILER = /[ \t]*`?<!--\s*status:\s*([\s\S]*?)\s*-->`?[ \t]*\n?/g;

/** The label fields a trailer may set; title and build stay with set_thread_status. */
export type StatusFields = { state?: unknown; note?: unknown; replies?: unknown };

/**
 * A reply's text without its status trailers, and the last one's fields: `status` is null when there's none, and
 * `bad` says why one was there but couldn't be read (not JSON, or not an object with state, note or replies).
 */
export function takeStatus(text: string): { text: string; status: StatusFields | null; bad: string | null } {
  let status: StatusFields | null = null;
  let bad: string | null = null;
  let found = false;
  const rest = text.replace(TRAILER, (_, body: string) => {
    found = true;
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      bad = `not JSON: ${body.slice(0, 80)}`;
      status = null;
      return '';
    }
    const fields: StatusFields = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) for (const k of ['state', 'note', 'replies'] as const) if (k in parsed) fields[k] = parsed[k];
    if (Object.keys(fields).length) [status, bad] = [fields, null];
    else [status, bad] = [null, `no state, note or replies in ${body.slice(0, 80)}`];
    return '';
  });
  return found ? { text: rest.trimEnd(), status, bad } : { text, status: null, bad: null };
}
