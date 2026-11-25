// What a turn held open on approval cards is doing besides (#1916): whether it still needs its worker, and whether its process could end.
import { blocks, type ClaudeEvent } from './claude-events.ts';

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
const DETACHES = /(?:^|[^&|>\d])&(?![&>\d])|\b(?:setsid|nohup|disown|systemd-run|citadel-dev-copy|citadel-heavy|start-emulator)\b/;

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
      if (typeof command === 'string' && DETACHES.test(command)) turn.detached = true;
    } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') turn.open.delete(b.tool_use_id);
  }
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
