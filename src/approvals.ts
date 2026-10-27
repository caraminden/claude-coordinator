// Per-project approval rules and plugin folders, and the Approve / Deny cards that ask people
// before a thread runs a tool matching one of the rules.
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';

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
 * Permission flags for a thread turn. Without rules: deny anything that would prompt, as nobody can
 * answer in a headless turn. With rules: the rules become `ask` rules, which Claude Code still
 * checks in bypassPermissions, and their prompts go to the approval tool, which shows a card.
 */
export function permissionArgs(rules: string[]): string[] {
  if (!rules.length) return ['--permission-prompts', 'none'];
  return [
    '--permission-prompts', 'host',
    '--permission-prompt-tool', APPROVAL_TOOL,
    '--settings', JSON.stringify({ permissions: { ask: rules } }),
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
  decision: Decision;
  wake: Set<() => void>;
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
  request(ticketId: number, tool: string, input: unknown): string {
    const id = randomBytes(8).toString('hex');
    this.requests.set(id, { ticketId, decision: { state: 'pending' }, wake: new Set() });
    let shown = JSON.stringify(input ?? {});
    if (shown.length > MAX_INPUT) shown = JSON.stringify({ truncated: shown.slice(0, MAX_INPUT) });
    this.emit(ticketId, 'approval', { id, tool, input: JSON.parse(shown) });
    return id;
  }

  /** How many of a thread's cards are waiting on a person. */
  waiting(ticketId: number): number {
    let n = 0;
    for (const r of this.requests.values()) if (r.ticketId === ticketId && r.decision.state === 'pending') n++;
    return n;
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
