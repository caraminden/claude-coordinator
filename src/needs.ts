// What a message to a Taskmaster needs (#851): message_coordinator and message_taskmaster both require it.
// `fyi` is always held mail, whatever `wake` says: the server decides, not the prompt.
// No imports: mcp.ts is copied pinned into each turn, with every local file it imports, so this stays a leaf.

export const NEEDS = ['start', 'unpark', 'decision', 'relay', 'ask', 'fyi'] as const;
export type Need = (typeof NEEDS)[number];

export const NEED_LINES: Record<Need, string> = {
  start: 'start a minion',
  unpark: 'unseal one',
  decision: 'a decision only the Taskmaster or a person can make',
  relay: 'pass something to another scheme',
  ask: 'anything else it must act on now',
  fyi: 'status, shipped, live, tracking, no action',
};

/** Why this body's `need` is refused (missing, unknown, or urgent on a fyi; the text names the field and the values), or null with the need. */
export function checkNeed(body: { need?: unknown; urgent?: unknown }): { need: Need } | { error: string } {
  const need = typeof body.need === 'string' ? body.need.trim().toLowerCase() : '';
  if (!(NEEDS as readonly string[]).includes(need)) {
    return { error: `need is required: one of ${NEEDS.map((n) => `${n} (${NEED_LINES[n]})`).join('; ')}. Resend the message with it.` };
  }
  if (need === 'fyi' && body.urgent === true) return { error: 'urgent wakes the receiver, and a fyi never does: pick the need it really is (ask, decision) or drop urgent' };
  return { need: need as Need };
}

/** The word people and agents read for a minion's state: 'parked' (the stored value, unchanged) reads "sealed" (Cara, 2026-11-22). */
export const stateWord = (s: string | null | undefined): string | null | undefined => (s === 'parked' ? 'sealed' : s);
