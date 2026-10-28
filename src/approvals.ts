// Per-project approval rules and plugin folders, and the Approve / Deny cards that ask people
// before a thread runs a tool matching one of the rules.
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { explanation, tripwire, type TripwireConfig } from './tripwire.ts';

/** The thread MCP server's tool that Claude Code calls instead of showing a permission prompt. */
export const APPROVAL_TOOL = 'mcp__thread__approve';
// How long a thread's MCP tool calls may take before Claude Code gives up on them: a card can wait
// overnight. A call that times out fails, so the tool does not run.
export const APPROVAL_TIMEOUT_MS = 7 * 24 * 3600_000;
const MAX_RULES = 50;
const MAX_RULE = 500;
const MAX_PLUGIN_DIRS = 20;
const MAX_INPUT = 20_000;
// A Claude Code permission rule: a tool name (MCP names may use * wildcards) and an optional (specifier).
const RULE = /^[A-Za-z_][\w*.-]*(\(.+\))?$/s;

/** The non-empty lines of a stored list. */
export function lines(text: string | null | undefined): string[] {
  return (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
}

function list(raw: unknown, field: string): string[] {
  if (typeof raw === 'string') return lines(raw.replace(/\r\n/g, '\n'));
  if (Array.isArray(raw) && raw.every((r) => typeof r === 'string')) return raw.flatMap((r) => lines(r));
  throw new Error(`${field} must be a list of text lines`);
}

/** Validate approval rules from the API, one per line; returns them as stored. */
export function cleanRules(raw: unknown): string {
  const rules = [...new Set(list(raw, 'Approval rules'))];
  if (rules.length > MAX_RULES) throw new Error(`At most ${MAX_RULES} approval rules`);
  for (const r of rules) {
    if (r.length > MAX_RULE || !RULE.test(r)) {
      throw new Error(`"${r.slice(0, 80)}" is not a Claude Code permission rule, like Bash(gh pr merge:*) or mcp__github__merge_pull_request`);
    }
  }
  return rules.join('\n');
}

/** Validate plugin folders from the API: paths inside the repo, one per line; returns them as stored. */
export function cleanPluginDirs(raw: unknown): string {
  const dirs = [...new Set(list(raw, 'Plugin folders').map((d) => d.replace(/\/+$/, '').replace(/^\.\//, '')))].filter(Boolean);
  if (dirs.length > MAX_PLUGIN_DIRS) throw new Error(`At most ${MAX_PLUGIN_DIRS} plugin folders`);
  for (const d of dirs) {
    if (d.length > MAX_RULE || d.startsWith('/') || d.startsWith('~') || d.split('/').some((s) => s === '..' || s === '.' || !s)) {
      throw new Error(`"${d.slice(0, 80)}" must be a folder path relative to the repo root, like tools/mods/delve`);
    }
  }
  return dirs.join('\n');
}

/**
 * Permission flags for a turn. A minion's prompts go to the approval tool: the tripwire's asks, and
 * the project's approval rules, which the runner adds as `ask` rules to the turn's settings (Claude
 * Code still checks those in bypassPermissions). The tool shows a card for those and refuses any
 * other prompt (Approvals.ask). A Taskmaster's turn denies anything that would prompt.
 */
export function permissionArgs(cards: boolean): string[] {
  if (!cards) return ['--permission-prompts', 'none'];
  return [
    '--permission-prompts', 'host',
    '--permission-prompt-tool', APPROVAL_TOOL,
  ];
}

/** `--plugin-dir` for each of the project's plugin folders that exists in this worktree. */
export function pluginDirArgs(dirs: string[], cwd: string): string[] {
  return dirs.flatMap((d) => {
    const path = join(cwd, d);
    try {
      return statSync(path).isDirectory() ? ['--plugin-dir', path] : [];
    } catch {
      return [];
    }
  });
}

export type Decision =
  | { state: 'pending' }
  | { state: 'allowed' | 'denied'; by: string }
  | { state: 'expired'; reason: string };

interface Request {
  ticketId: number;
  /** A tripwire card rather than one for the project's approval rules. */
  tripwire: boolean;
  decision: Decision;
  wake: Set<() => void>;
  /** The card as the chat shows it, and when it was posted, for the Needs-you inbox. */
  card: unknown;
  at: number;
}

type Emit = (ticketId: number, kind: string, data: unknown) => void;

/**
 * Approval cards waiting on people. They live only in memory, with the turn that asked: when the
 * turn ends (or the server restarts), anything undecided expires and never counts as approval.
 */
export class Approvals {
  private requests = new Map<string, Request>();
  private emit: Emit;

  constructor(emit: Emit) {
    this.emit = emit;
  }

  /** Post a card in the thread's chat for one tool call; returns its id. */
  request(ticketId: number, tool: string, input: unknown, tripwire?: { reason: string; explanation: string }): string {
    const id = randomBytes(8).toString('hex');
    let shown = JSON.stringify(input ?? {});
    if (shown.length > MAX_INPUT) shown = JSON.stringify({ truncated: shown.slice(0, MAX_INPUT) });
    const card = { id, tool, input: JSON.parse(shown), ...(tripwire ? { tripwire } : {}) };
    this.requests.set(id, { ticketId, tripwire: !!tripwire, decision: { state: 'pending' }, wake: new Set(), card, at: Date.now() });
    this.emit(ticketId, 'approval', card);
    return id;
  }

  /**
   * Claude Code's permission prompt for a minion's tool call: a card, or a refusal saying why. The
   * tripwire's verdict is worked out again here, as the hook's reason doesn't reach the prompt; `cwd` is
   * the minion's, so a call whose shell had moved elsewhere may get a refusal, never a wrong card. A
   * tripwire card needs an explanation, shows the whole call, and is one at a time; after a deny, the
   * turn gets no more. Anything else gets a card only in a project with approval rules, as before.
   */
  ask(ticketId: number, tool: string, input: object, cwd: string, cfg: TripwireConfig, rules: boolean): { id: string } | { refused: string } {
    const verdict = tripwire({ tool_name: tool, tool_input: input, cwd }, { ...cfg, ask: true });
    if (verdict && !verdict.ask) return { refused: `The tripwire blocks this. ${verdict.reason}` };
    if (!verdict) {
      return rules ? { id: this.request(ticketId, tool, input) } : { refused: 'Nobody can answer a permission prompt in this turn, so this was not run.' };
    }
    const why = explanation(input);
    if (!why) return { refused: `${verdict.reason} An approval card needs a Bash description of why; it had none, so this was not run.` };
    if (JSON.stringify(input).length > MAX_INPUT) return { refused: 'This call is too long to show in full on an approval card, so it was not run. Hand the commands to a person.' };
    const mine = [...this.requests.values()].filter((r) => r.ticketId === ticketId && r.tripwire);
    if (mine.some((r) => r.decision.state === 'pending')) return { refused: 'An approval card for a tripwire block is already waiting in this chat; only one at a time. This was not run.' };
    if (mine.some((r) => r.decision.state === 'denied')) return { refused: 'A person denied a tripwire card earlier this turn, so no more are shown. This was not run: stop, and hand the commands to a person in your reply.' };
    return { id: this.request(ticketId, tool, input, { reason: verdict.reason, explanation: why }) };
  }

  /** How many of a thread's cards are waiting on a person. */
  waiting(ticketId: number): number {
    let n = 0;
    for (const r of this.requests.values()) if (r.ticketId === ticketId && r.decision.state === 'pending') n++;
    return n;
  }

  /** Every card still waiting on a person, in any thread. */
  pending(): { ticketId: number; at: number; card: unknown }[] {
    return [...this.requests.values()].filter((r) => r.decision.state === 'pending').map(({ ticketId, at, card }) => ({ ticketId, at, card }));
  }

  /** The card's outcome so far; unknown cards (another thread's, or from before a restart) are expired. */
  get(ticketId: number, id: string): Decision {
    const r = this.requests.get(id);
    return r && r.ticketId === ticketId ? r.decision : { state: 'expired', reason: 'This request is no longer waiting.' };
  }

  /** A person's click. Returns the card's outcome, which is the earlier one if it was already settled. */
  decide(ticketId: number, id: string, allow: boolean, by: string): Decision {
    const r = this.requests.get(id);
    if (!r || r.ticketId !== ticketId || r.decision.state !== 'pending') return this.get(ticketId, id);
    this.settle(id, r, { state: allow ? 'allowed' : 'denied', by });
    return r.decision;
  }

  /** Resolve once the card is settled or `ms` passes, with its outcome then. */
  wait(ticketId: number, id: string, ms: number): Promise<Decision> {
    const r = this.requests.get(id);
    if (!r || r.ticketId !== ticketId || r.decision.state !== 'pending') return Promise.resolve(this.get(ticketId, id));
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        r.wake.delete(done);
        resolve(r.decision);
      };
      const timer = setTimeout(done, ms);
      r.wake.add(done);
    });
  }

  /** Answer every waiting long-poll now with its card's state so far, for a server shutting down. */
  wakeAll() {
    for (const r of this.requests.values()) for (const done of [...r.wake]) done();
  }

  /** The thread's turn ended: expire its undecided cards and forget them all. */
  endTurn(ticketId: number, reason: string) {
    for (const [id, r] of this.requests) {
      if (r.ticketId !== ticketId) continue;
      if (r.decision.state === 'pending') this.settle(id, r, { state: 'expired', reason });
      this.requests.delete(id);
    }
  }

  private settle(id: string, r: Request, decision: Exclude<Decision, { state: 'pending' }>) {
    r.decision = decision;
    this.emit(r.ticketId, 'approval_result', { id, ...decision });
    for (const wake of [...r.wake]) wake();
  }
}

/** Cards in stored events that never got an outcome, e.g. because the server restarted while they waited. */
export function unsettledCards(events: { kind: string; data: string }[]): string[] {
  const open = new Set<string>();
  for (const e of events) {
    if (e.kind === 'approval') open.add(JSON.parse(e.data).id);
    else if (e.kind === 'approval_result') open.delete(JSON.parse(e.data).id);
  }
  return [...open];
}
