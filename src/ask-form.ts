/**
 * The form for an ask to another scheme's Taskmaster (#1165): what I saw, what I checked on my side,
 * what I need, by when. A plain fyi stays free text. Other schemes' Taskmasters sent Citadel 320
 * messages in a month, some blaming Citadel for their own bug; "what I checked" is what stops that.
 */
export type AskFields = { saw: string; checked: string; wanted: string; by: string; extra: string };

const EMPTY_CHECK = /^\W*(nothing|none|no|nope|n\/?a|na|not yet|nil|-+|\?+|tbd|didn'?t|haven'?t)\W*$/i;

export function checkAsk(body: Record<string, unknown>): { ask: AskFields } | { error: string } {
  const f = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  const ask = { saw: f('saw'), checked: f('checked'), wanted: f('wanted'), by: f('by'), extra: f('text') || f('message') };
  if (!ask.saw) return { error: 'An ask needs saw: what you saw, with the error text or a link' };
  if (!ask.checked || EMPTY_CHECK.test(ask.checked)) return { error: 'An ask needs checked: what you checked on your own side first (logs, your code, a repro). "nothing" is refused: look first, then ask' };
  if (!ask.wanted) return { error: 'An ask needs wanted: what you need that Taskmaster to do' };
  if (!ask.by) return { error: 'An ask needs by: by when you need it ("today", "before #N ships", "no rush")' };
  return { ask };
}

/** The same four lines every time, so the reader finds them in the same place. */
export function formatAsk(a: AskFields): string {
  return `What I saw: ${a.saw}\nWhat I checked on my side: ${a.checked}\nWhat I need: ${a.wanted}\nBy when: ${a.by}${a.extra ? `\n\n${a.extra}` : ''}`;
}
