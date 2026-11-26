// cabal_board (#2090): a cabal's board for its lead and members, one tool (src/routes/cabals.ts serves it). Listed only
// on the turns of a minion on a board or leading one (COORDINATOR_CABAL), so no other turn pays for its text.
import { C, call, NOT_HERE } from './mcp-call.ts';

export const CABAL_BOARD = {
  name: 'cabal_board',
  description:
    "Your cabal's board: the roster with each member's state, merges, claims, what it waits on, spend and risk (read from facts), plus members' notes, open asks and the lead's log. Read it at each wake instead of rereading chats. A member sets its own note (one line, at milestones) and files it expects to touch, and opens asks to the lead: a blocking ask wakes the lead, any other is held mail it answers at its next wake. The lead answers asks (the asker hears back the same way), adds and edits roster rows, appends decisions to its log (who decided, quoted, with the time) and sets or clears the red-run line.",
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'note', 'ask', 'answer', 'row', 'log', 'red'], description: 'read (default); a member: note, ask; the lead: answer, row, log, red' },
      note: { type: ['string', 'null'], maxLength: 200, description: 'note, or row: one line ("built, in review", "blocked on M1\'s table"); null clears' },
      files: { type: ['array', 'null'], items: { type: 'string' }, description: 'note, or row: the repo paths it expects to touch (a folder ends in /). A goal cabal has no claims file, so the board flags a file two members list' },
      text: { type: ['string', 'null'], maxLength: 2000, description: 'ask: the question or request; answer: your answer; log: the line; red: what is red (null clears it)' },
      blocking: { type: 'boolean', description: 'ask: true only when you cannot go on without the answer (wakes the lead)' },
      ask: { type: 'integer', description: 'answer: the ask id the board shows' },
      row: { type: 'integer', description: 'row: the row id to change; left out, a new row' },
      minion: { type: ['integer', 'null'], description: 'row: the #N started for it; null unlinks' },
      label: { type: 'string', maxLength: 12, description: 'row: a short label (T1, M2)' },
      title: { type: 'string', maxLength: 120, description: 'row: the piece' },
      lane: { type: 'string', maxLength: 40, description: 'row: its lane' },
      after: { type: 'string', maxLength: 60, description: 'row: what it waits on, before it is started (a label or #N); a started one shows its start_after' },
      role: { type: 'string', maxLength: 40, description: 'row: e.g. fixer' },
      remove: { type: 'boolean', description: 'row: true deletes the row' },
    },
  },
};

/** How the message behind an ask or answer went (runner.relayMinion's answer). */
const delivered = (held: unknown, n: number | null | undefined, who: string) =>
  held === true ? `The loop guard held the message to ${who}: finish your turn.` : held === 'parked' ? `#${n} is sealed, so it reads it once unsealed.` : held === 'mail' ? `#${n} reads it as held mail at its next wake.` : `#${n} is woken for it now, or after its current turn.`;

const ROW_KEYS = ['row', 'minion', 'label', 'title', 'lane', 'after', 'role', 'note', 'files', 'remove'] as const;

/** Answers cabal_board; NOT_HERE for any other tool. */
export async function runCabalTool(name: string, args: Record<string, unknown>): Promise<string | typeof NOT_HERE> {
  if (name !== 'cabal_board') return NOT_HERE;
  const action = String(args.action ?? 'read');
  const path = `/api/tickets/${C().TICKET}/cabal`;
  if (action === 'read') {
    const r = await call<{ text: string | null }>('GET', `${path}?text=1`);
    return r.text ?? 'You are not on a cabal board and lead none.';
  }
  const pick = (keys: readonly string[]) => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
  const body = { action, ...(action === 'row' ? pick(ROW_KEYS) : pick(['note', 'files', 'text', 'blocking', 'ask'])) };
  const r = await call<{ ask?: number; held?: unknown; lead?: number; to?: number | null; row?: number; removed?: boolean; log?: number }>('POST', path, body);
  if (action === 'ask') return `Ask ${r.ask} is on the board. ${delivered(r.held, r.lead, 'the lead')}`;
  if (action === 'answer') return `Answered. ${r.to == null ? 'The asker is dismissed, so it is on the board only.' : delivered(r.held, r.to, 'the asker')}`;
  if (action === 'row') return r.removed ? `Row ${r.row} removed.` : `Row ${r.row} saved.`;
  return 'Saved on the board.';
}
