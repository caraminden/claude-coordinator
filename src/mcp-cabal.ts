// cabal_board (#2090): a cabal's board for its lead and members, one tool (src/routes/cabals.ts serves it). Listed only
// on the turns of a minion on a board or leading one (COORDINATOR_CABAL), so no other turn pays for its text.
import { C, call, NOT_HERE } from './mcp-call.ts';

export const CABAL_BOARD = {
  name: 'cabal_board',
  description:
    "Your Plot's board: the roster with each member's state, merges, claims, what it waits on, spend and risk (read from facts), plus members' notes, open asks and the lead's log. Read it at each wake instead of rereading chats. A member sets its own note (one line, at milestones) and files it expects to touch, and opens asks to the lead: a blocking ask wakes the lead, any other is held mail it answers at its next wake. The lead answers asks (the asker hears back the same way), adds and edits roster rows (each with its handoff, model, effort and cost before it can start), appends decisions to its log (who decided, quoted, with the time), sets or clears the red-run line, and posts the roster for people's go with form: one card for every row not yet approved; changing an approved row's title, handoff, model, effort, cost or after takes its approval back.",
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'timeline', 'note', 'ask', 'answer', 'row', 'log', 'red', 'form'], description: 'read (default); timeline: the starts, ships, ask waits, reds and spend a Plot retro is written from; a member: note, ask; the lead: answer, row, log, red, form' },
      note: { type: ['string', 'null'], maxLength: 200, description: 'note, or row: one line ("built, in review", "blocked on M1\'s table"); null clears' },
      files: { type: ['array', 'null'], items: { type: 'string' }, description: 'note, or row: the repo paths it expects to touch (a folder ends in /). A Plot has no claims file, so the board flags a file two members list' },
      text: { type: ['string', 'null'], maxLength: 2000, description: 'ask: the question or request; answer: your answer; log: the line; red: what is red (null clears it)' },
      blocking: { type: 'boolean', description: 'ask: true only when you cannot go on without the answer (wakes the lead)' },
      ask: { type: 'integer', description: 'answer: the ask id the board shows' },
      row: { type: 'integer', description: 'row: the row id to change; left out, a new row' },
      minion: { type: ['integer', 'null'], description: 'row: the #N started for it; null unlinks' },
      scheme: { type: ['string', 'null'], description: "row: the scheme its member runs and ships in when it isn't yours (a scheme your person is in); null or your own puts it back. Its people approve it on their own copy of the forming card, and its Taskmaster starts it when you ask with message_taskmaster" },
      label: { type: 'string', maxLength: 12, description: 'row: a short label (T1, M2)' },
      title: { type: 'string', maxLength: 120, description: 'row: the piece' },
      lane: { type: 'string', maxLength: 40, description: 'row: its lane' },
      after: { type: 'string', maxLength: 60, description: 'row: what it waits on, before it is started (a label or #N); a started one shows its start_after' },
      role: { type: 'string', maxLength: 40, description: 'row: e.g. fixer' },
      handoff: { type: ['string', 'null'], description: 'row: its handoff file in the shared folder (handoffs/….md, or the full path)' },
      model: { type: ['string', 'null'], description: 'row: the model it starts on, as create_ticket takes it' },
      effort: { type: ['string', 'null'], description: 'row: its effort, as create_ticket takes it' },
      cost: { type: ['number', 'null'], description: "row: its expected dollars; left out, form reads its handoff's Expected cost line" },
      width: { type: 'integer', minimum: 1, maximum: 20, description: 'form: how many members may be at work at once (default 4; one sealed on its chain, merged or dismissed holds no place); the rest wait as next up' },
      remove: { type: 'boolean', description: 'row: true deletes the row' },
    },
  },
};

/** How the message behind an ask or answer went (runner.relayMinion's answer). */
const delivered = (held: unknown, n: number | null | undefined, who: string) =>
  held === true ? `The loop guard held the message to ${who}: finish your turn.` : held === 'parked' ? `#${n} is sealed, so it reads it once unsealed.` : held === 'mail' ? `#${n} reads it as held mail at its next wake.` : `#${n} is woken for it now, or after its current turn.`;

const ROW_KEYS = ['row', 'minion', 'scheme', 'label', 'title', 'lane', 'after', 'role', 'note', 'files', 'remove', 'handoff', 'model', 'effort', 'cost'] as const;

export const CABAL_START = {
  name: 'cabal_start',
  description:
    "Start a member of your Plot from a row on your board that people approved on its forming card (cabal_board action form). It starts from the row's handoff on the row's model and effort, in your build and Goal, with you as parent and lead, chained on the row's after; the Taskmaster hears of it. A feature row nobody approved is refused: add it with a card; a fixer row (role: fixer) starts with none. Past your width it waits as next up and starts by itself once a member merges, is dismissed or is sealed.",
  inputSchema: {
    type: 'object',
    properties: {
      row: { type: ['integer', 'string'], description: 'The row id or label the board shows' },
      text: { type: 'string', maxLength: 4000, description: 'Optional words to put above its brief (the handoff is the brief)' },
    },
    required: ['row'],
  },
};

/** A lead's message_taskmaster (#2094): its own roster rows in other schemes only; the server writes the ask. */
export const CABAL_MESSAGE_TASKMASTER = {
  name: 'message_taskmaster',
  description:
    "For your Plot's rows in other schemes only: ask that scheme's Taskmaster to start the row's member (a row that scheme's people approved on the forming card), or to unseal, stop or seal the member it started. You never start or touch minions there yourself. The server writes the ask; the start ask carries the row's handoff into that scheme's shared folder, and the Taskmaster starts it with Plot \"<your scheme>#<your #N>\", which puts it on your board with its scheme's name. A started row holds a place in your width while the ask waits. In a Plot a member there ships to its own main, never into your build: when it must not go live first, ask seal now and unseal once the build is live. Any other use is refused: other work for a scheme goes to your Taskmaster with message_coordinator.",
  inputSchema: {
    type: 'object',
    properties: {
      row: { type: ['integer', 'string'], description: 'The row id or label the board shows' },
      action: { type: 'string', enum: ['start', 'unseal', 'stop', 'seal'] },
      scheme: { type: 'string', description: "Optional: the row's scheme, checked against the row" },
      text: { type: 'string', maxLength: 4000, description: 'Optional words for that Taskmaster after the ask' },
    },
    required: ['row', 'action'],
  },
};

export const CABAL_MEMBER = {
  name: 'cabal_member',
  description: "Unseal, stop or reseal one of your own Plot's members. Any other minion is refused. stop interrupts its turn and drops its queued messages (a running ship stops too); reseal holds what is sent to it until you unseal it.",
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['unseal', 'stop', 'reseal'] },
      minion: { type: 'integer', description: "The member's #N" },
    },
    required: ['action', 'minion'],
  },
};

/** Answers cabal_board; NOT_HERE for any other tool. */
export async function runCabalTool(name: string, args: Record<string, unknown>): Promise<string | typeof NOT_HERE> {
  if (name === 'message_taskmaster' && C().CABAL_LEAD) {
    const r = await call<{ asked?: string; held?: boolean; next?: number; text?: string }>('POST', `/api/tickets/${C().TICKET}/cabal/taskmaster`, { row: args.row, action: args.action, ...(args.scheme ? { scheme: args.scheme } : {}), ...(args.text ? { text: args.text } : {}) });
    if (r.text) return r.text;
    if (r.next != null) return `Next up, number ${r.next} in line: your width is full. The ask goes to its Taskmaster by itself once a member merges, is dismissed or is sealed.`;
    return r.held ? `The loop guard held your ask to ${r.asked}'s Taskmaster: finish your turn.` : `Asked ${r.asked}'s Taskmaster to start it. It shows on your board with ${r.asked}'s name once started; you get a held line then.`;
  }
  if (name === 'cabal_start') {
    const r = await call<{ started?: number; title?: string; next?: number; notes?: string[] }>('POST', `/api/tickets/${C().TICKET}/cabal/start`, { row: args.row, ...(args.text ? { text: args.text } : {}) });
    if (r.next != null) return `Next up, number ${r.next} in line: your width is full. It starts by itself once a member merges, is dismissed or is sealed.`;
    return [`Started #${r.started} ${r.title}.`, ...(r.notes ?? [])].join('\n');
  }
  if (name === 'cabal_member') return (await call<{ text: string }>('POST', `/api/tickets/${C().TICKET}/cabal/member`, { action: args.action, minion: args.minion })).text;
  if (name !== 'cabal_board') return NOT_HERE;
  const action = String(args.action ?? 'read');
  const path = `/api/tickets/${C().TICKET}/cabal`;
  if (action === 'read' || action === 'timeline') {
    const r = await call<{ text: string | null }>('GET', `${path}?${action === 'read' ? 'text' : 'timeline'}=1`);
    return r.text ?? 'You are not on a Plot board and lead none.';
  }
  const pick = (keys: readonly string[]) => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
  const body = { action, ...(action === 'row' ? pick(ROW_KEYS) : action === 'form' ? pick(['width']) : pick(['note', 'files', 'text', 'blocking', 'ask'])) };
  const r = await call<{ ask?: number; held?: unknown; lead?: number; to?: number | null; row?: number; removed?: boolean; log?: number; href?: string; rows?: number }>('POST', path, body);
  if (action === 'form') return `The forming card is posted for people (${r.href}), with ${r.rows} row${r.rows === 1 ? '' : 's'}. Link it in your reply; their go approves them, and then you start each with cabal_start.`;
  if (action === 'ask') return `Ask ${r.ask} is on the board. ${delivered(r.held, r.lead, 'the lead')}`;
  if (action === 'answer') return `Answered. ${r.to == null ? 'The asker is dismissed, so it is on the board only.' : delivered(r.held, r.to, 'the asker')}`;
  if (action === 'row') return r.removed ? `Row ${r.row} removed.` : `Row ${r.row} saved.`;
  return 'Saved on the board.';
}
