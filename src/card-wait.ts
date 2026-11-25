// What a turn held open on approval cards is doing besides (#1916): whether it still needs its worker, and whether its process could end.
import { isDeepStrictEqual } from 'node:util';
import { blocks, type ClaudeEvent } from './claude-events.ts';
import { WaitList, type WaitStore } from './resumes.ts';

/** One turn's calls and background work, from its stream. */
export interface TurnCalls {
  /** Calls with no result yet, by id; `parent` is the Agent call of the Grunt that made it. */
  open: Map<string, { name: string; parent: string | null }>;
  /** The kinds of its background tasks that run now (`local_bash`, `local_agent`), as Claude Code last listed them. */
  background: string[];
  /** A command of its may have left a job that Claude Code doesn't list. */
  detached: boolean;
}

/** `working`: it keeps its worker. `lend`: only the worker goes back, as ending its process would kill something. `end`: the process may end too. */
export type CardWait = 'working' | 'lend' | 'end';

export const newCalls = (background: string[] = []): TurnCalls => ({ open: new Map(), background, detached: false });

// shortcut: by its words, so a job long over still keeps its turn's process; ask the kernel for the turn's other processes if many turns stay loaded for it.
const DETACHES = /(?:^|[^&|><])&(?![&>])|\b(?:setsid|nohup|disown|systemd-run|citadel-dev-copy(?! (?:stop|status|env|seed)\b)|start-emulator)\b/;
// What runs a command inside quotes, whose `&` then counts too.
const NESTS = /\$\(|`|<<|\b(?:ba|z|fi|da)?sh\b|\beval\b|\bxargs\b/;
const QUOTED = /\\.|'[^']*'|"(?:\\.|[^"\\])*"/gs;
const detaches = (command: string) => DETACHES.test(NESTS.test(command) ? command : command.replace(QUOTED, ' '));

/** Take in one line of the turn's stream, stored or fresh. */
export function noteCalls(turn: TurnCalls, ev: ClaudeEvent) {
  if (ev.type === 'system' && ev.subtype === 'background_tasks_changed' && Array.isArray(ev.tasks)) {
    turn.background = ev.tasks.map((t) => String(t?.task_type));
    return;
  }
  for (const b of blocks(ev.message?.content)) {
    if (b?.type === 'tool_use' && typeof b.id === 'string') {
      turn.open.set(b.id, { name: String(b.name), parent: ev.parent_tool_use_id ?? null });
      const command = b.input?.command;
      if (typeof command === 'string' && detaches(command)) turn.detached = true;
    } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') turn.open.delete(b.tool_use_id);
  }
}

/** Whether this line, already taken in, has claude read what it was steered: its own calls' results are all in, a Grunt's aside. */
export function readsSteers(turn: TurnCalls, ev: ClaudeEvent): boolean {
  return ev.type === 'user' && !ev.parent_tool_use_id && ![...turn.open.values()].some((c) => !c.parent);
}

/** What the turn does while these cards wait on people. A card asked without its call's id (a turn from before #1916) takes an open call of its tool, and never ends the process. */
export function cardWait(turn: TurnCalls, cards: { tool: string; use?: string }[]): CardWait {
  if (!cards.length || turn.background.some((kind) => kind !== 'local_bash')) return 'working';
  const held = new Set<string>();
  for (const c of cards) {
    const id = c.use ?? [...turn.open].find(([id, call]) => call.name === c.tool && !held.has(id))?.[0];
    // Not read from its stream yet: what else runs isn't known either.
    if (!id || !turn.open.has(id)) return 'working';
    held.add(id);
  }
  // A Grunt's own call waits when all it runs waits.
  const waits = (id: string): boolean => {
    if (held.has(id)) return true;
    const inside = [...turn.open].filter(([, call]) => call.parent === id);
    return inside.length > 0 && inside.every(([child]) => waits(child));
  };
  if (![...turn.open.keys()].every(waits)) return 'working';
  const alone = turn.open.size === 1 && cards.length === 1 && !!cards[0].use;
  return alone && !turn.background.length && !turn.detached ? 'end' : 'lend';
}

/** A steer this fresh may not have reached claude yet, or the line read now may be older than it. */
export const STEER_LAG_MS = 5_000;

/** How long a turn that only waits on a card keeps its process: the Taskmaster's number, as #1890's. None while the box or its person's container is short. */
export const CARD_HOLD_MS = 2 * 60_000;

/** An approval card as the chat shows it. */
export interface ShownCard {
  id: string;
  tool: string;
  use?: string;
  input?: unknown;
  tripwire?: { reason: string };
  merge?: object;
}

/** All of a call that an approval stands for: its exact input, where it runs, why the tripwire asked, and the pull request it merges. */
export interface CardCall {
  tool: string;
  input: unknown;
  cwd: string;
  tripwire: string | null;
  pr: string | null;
}

/** A card whose turn's process ended while it waited: saved, so that its answer resumes the minion. */
export interface KeptCard {
  ticket: number;
  id: string;
  call: CardCall;
  /** Whose turn it was: the resumed one runs as them too. */
  person: number | null;
  /** The relay the turn came from (TurnState.from). */
  from?: number;
  at: number;
  answer?: { allow: boolean; by: string };
}

/** An approved card's one run, for the turn that resumes: spent by the call, or lost once that turn does anything else. */
export interface CardPass {
  id: string;
  by: string;
  call: CardCall;
}

export const keptCards = (store: WaitStore) => new WaitList<KeptCard>(store, 'card-waits');

/** Whether a minion with no process waits for a person to answer its card: nothing else starts a turn of it. */
export function cardHeld(store: WaitStore, ticketId: number): boolean {
  const kept = keptCards(store).get(ticketId);
  return !!kept && !kept.answer;
}

/** The pull request a merge card showed, its head commit included: a push since then needs a new answer. */
export function prOf(merge: object | undefined): string | null {
  if (!merge) return null;
  const pr = ((merge as { pr?: unknown }).pr ?? {}) as Record<string, unknown>;
  return JSON.stringify(['number', 'url', 'state', 'head', 'base', 'oid'].map((k) => pr[k] ?? null));
}

/** The call a card asks about, or null when the card holds only part of it, or a merge whose pull request couldn't be read. */
export function callOf(card: ShownCard, cwd: string): CardCall | null {
  const input = card.input as { truncated?: unknown } | undefined;
  if (!input || 'truncated' in input) return null;
  // Two failed lookups would read as the same pull request.
  if (card.merge && !(card.merge as { pr?: { oid?: unknown } | null }).pr?.oid) return null;
  return { tool: card.tool, input, cwd, tripwire: card.tripwire?.reason ?? null, pr: prOf(card.merge) };
}

export const sameCall = (a: CardCall, b: CardCall) => isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));

/** Whether a line of the resumed turn's stream shows it doing something other than the approved call, read before noteCalls takes the line in. */
export function losesPass(pass: CardPass, calls: TurnCalls, ev: ClaudeEvent): boolean {
  return blocks(ev.message?.content).some((b) => {
    // ToolSearch only loads the approved tool's schema.
    if (b?.type === 'tool_use') return b.name !== pass.call.tool && b.name !== 'ToolSearch';
    return b?.type === 'tool_result' && typeof b.tool_use_id === 'string' && calls.open.get(b.tool_use_id)?.name === pass.call.tool;
  });
}

const SAYS_REJECTED = 'The call reads as rejected or interrupted in your session only because your process was ended to free its memory while the card waited.';

/** What the resumed turn is told of its card's answer. */
export function answerPrompt(kept: KeptCard): string {
  const { call, answer } = kept;
  const input = JSON.stringify(call.input);
  if (answer?.allow)
    return `${answer.by} approved your waiting ${call.tool} call. ${SAYS_REJECTED} It did not run. Make exactly that call again now, before anything else; it runs without another card, once. Any other call first, or a changed input, asks again. Its input, as JSON:\n${input}\nThen carry on with your work.`;
  return `${answer?.by} denied your waiting ${call.tool} call in the chat. ${SAYS_REJECTED} It was not run. Do not retry it or work around it; say what you needed it for, carry on with anything that does not need it, and hand the commands it needed to a person in your reply. Its input, as JSON:\n${input}`;
}

/** What goes ahead of a person's message that came instead of an answer. */
export function repliedPrompt(kept: KeptCard, by: string): string {
  return `${by} replied below instead of answering the approval card for your waiting ${kept.call.tool} call, so the card expired and the call was not run. ${SAYS_REJECTED} Follow their reply; if the call is still needed, make it again and it asks again.`;
}
