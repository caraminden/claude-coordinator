// Per-project approval rules and plugin folders, and the Approve / Deny cards that ask people
// before a thread runs a tool matching one of the rules.
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { MergeCall, PrInfo } from './merge-card.ts';
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

/** Validate plugin folders from the API: paths relative to the repo root, or absolute, one per line; returns them as stored. */
export function cleanPluginDirs(raw: unknown): string {
  const dirs = [...new Set(list(raw, 'Plugin folders').map((d) => d.replace(/\/+$/, '').replace(/^\.\//, '')))].filter(Boolean);
  if (dirs.length > MAX_PLUGIN_DIRS) throw new Error(`At most ${MAX_PLUGIN_DIRS} plugin folders`);
  for (const d of dirs) {
    if (d.length > MAX_RULE || d.startsWith('~') || d.replace(/^\//, '').split('/').some((s) => s === '..' || s === '.' || !s)) {
      throw new Error(`"${d.slice(0, 80)}" must be a folder path relative to the repo root, like tools/mods/delve, or an absolute one`);
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

/** `--plugin-dir` for each of the project's plugin folders that exists: in this worktree, or at its absolute path. */
export function pluginDirArgs(dirs: string[], cwd: string): string[] {
  return dirs.flatMap((d) => {
    const path = isAbsolute(d) ? d : join(cwd, d);
    try {
      return statSync(path).isDirectory() ? ['--plugin-dir', path] : [];
    } catch {
      return [];
    }
  });
}

export type Decision =
  | { state: 'pending' }
  | { state: 'allowed' | 'denied'; by: string; via?: { message?: number; text: string } }
  | { state: 'expired'; reason: string };

// A message that is only a go to merge (#201): "merge it", "ok, fold it", "yes merge PR #191", "ship it".
const GO = /^(?:(?:ok|okay|yes|yep|great|lgtm|looks good|go ahead|go|please),? )?(?:and )?(?:merge|fold|land|squash|ship)(?: (?:it|this|the pr|pr #?(\d{1,7})|#(\d{1,7})|(\d{1,7})))?(?: in)?(?: (?:please|now))?$/;

/** The PR a message that says nothing but "merge it" means: its number, or null for the minion's own; null if it isn't one. */
export function mergeGo(text: string): { pr: number | null } | null {
  const m = GO.exec(text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').trimEnd());
  if (!m) return null;
  const n = m[1] ?? m[2] ?? m[3];
  return { pr: n ? Number(n) : null };
}

/** A person's go a turn read: who typed it, the PR it names (null: the minion's own) and the message. */
interface Go {
  by: string;
  pr: number | null;
  message?: number;
  text: string;
  /** A merge it covers was sent back once with the plain command to run (#209). */
  hinted?: boolean;
  /** The PR a merge it let through named: retries of that PR pass while it is still open (#209). */
  spent?: number;
}

/**
 * Whether a go covers a merge's PR: the one they named or, with none named, the minion's own. Once it
 * has let a merge through, only that PR again, and only while it is open: a merge GitHub refused (a
 * short --match-head-commit, a check still running) left nothing merged, so the go isn't used up.
 */
const covers = (go: Go, target: MergeTarget) =>
  (go.pr === null ? target.own : target.number === go.pr) && (go.spent === undefined || (go.spent === target.number && target.open === true));

/** A merge call's PR as a go is checked against: its number, and whether it is the minion's own branch's PR. */
export interface MergeTarget {
  number: number;
  own: boolean;
  /** The lookup found it open, so no merge of it has gone through yet. */
  open?: boolean;
}

// The gh pr merge switches a go lets through: squash or a merge commit, not rebase (nobody asked for it).
// Any flag with free text or a file (--body-file) gets the card.
const GO_SWITCH = /^(?:--(?:squash|merge|delete-branch|auto)|-[smd]+)$/;
const GO_VALUED = new Set(['--repo', '-R', '--match-head-commit']);

/**
 * Whether a Bash call is a go may let through: one `gh pr merge` of plain words and nothing else (no
 * chain, pipe, redirect, quote, variable, comment or `cd`, since Approve lets the whole input run), no
 * --admin, and the PR and its repo named outright: the server looks the PR up in the worktree, but the
 * shell may have moved on in an earlier call, and only --repo or a URL pins what gh merges.
 */
export function plainMerge(command: string, call: MergeCall | null): boolean {
  if (!call || call.admin || call.moved || !call.repo || !call.target) return false;
  const words = command.trim().split(/[ \t]+/);
  if (words.slice(0, 3).join(' ') !== 'gh pr merge') return false;
  for (let i = 3; i < words.length; i++) {
    const [flag, value] = words[i].startsWith('--') && words[i].includes('=') ? words[i].split(/=(.*)/s) : [words[i], undefined];
    if (GO_VALUED.has(flag)) {
      if (!/^[\w./-]+$/.test(value ?? words[++i] ?? '')) return false;
    } else if (flag.startsWith('-') ? !GO_SWITCH.test(flag) || value !== undefined : !/^[\w:/.-]+$/.test(flag)) return false;
  }
  return true;
}

const MCP_GO_KEYS = new Set(['owner', 'repo', 'pullNumber', 'pull_number', 'merge_method', 'mergeMethod', 'sha']);

/** The GitHub MCP's merge tools: the PR their input names, as `gh pr merge` would, or null. */
export function mcpMerge(tool: string, input: any): MergeCall | null {
  const m = tool.match(/^mcp__[^_].*__(merge_pull_request|enable_pr_auto_merge)$/);
  const n = input?.pullNumber ?? input?.pull_number;
  // Both spellings with different numbers: which one the server merges isn't ours to guess.
  if (input?.pullNumber !== undefined && input?.pull_number !== undefined && input.pullNumber !== input.pull_number) return null;
  if (!m || !Number.isInteger(n) || n < 1 || typeof input.owner !== 'string' || typeof input.repo !== 'string') return null;
  // As with gh: no commit title or message riding along, and squash or a merge commit (or the repo's default).
  if (Object.keys(input).some((k) => !MCP_GO_KEYS.has(k))) return null;
  for (const method of [input.merge_method, input.mergeMethod]) {
    if (method !== undefined && !(typeof method === 'string' && ['squash', 'merge'].includes(method.toLowerCase()))) return null;
  }
  if (!/^[\w.-]+$/.test(input.owner) || !/^[\w.-]+$/.test(input.repo)) return null;
  return { target: String(n), repo: `${input.owner}/${input.repo}`, method: null, auto: m[1] === 'enable_pr_auto_merge', admin: false, moved: false };
}

/** The target of a merge call whose looked-up PR is in the scheme's repo; null otherwise. */
export function mergeTarget(pr: PrInfo | null, schemeRepo: string | null, branch: string | null): MergeTarget | null {
  const repo = pr?.url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/)?.[1];
  if (!pr || !repo || !schemeRepo || repo.toLowerCase() !== schemeRepo.toLowerCase()) return null;
  return { number: pr.number, own: !!branch && pr.head === branch, open: pr.state === 'OPEN' };
}

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
 * Approval cards waiting on people. They live in memory, with the turn that asked: when the turn
 * ends, anything undecided expires and never counts as approval. A server restart puts back the
 * waiting cards of turns that survive it (restore), and expires the rest.
 */
export class Approvals {
  private requests = new Map<string, Request>();
  /** Outcomes of cards forgotten when their turn ended, for an asker that was between two polls then. */
  private ended = new Map<string, { ticketId: number; decision: Decision }>();
  /** Each running turn's standing go to merge, from a message a person typed into that minion's chat (#201). */
  private goes = new Map<number, Go>();
  private emit: Emit;

  constructor(emit: Emit) {
    this.emit = emit;
  }

  /** Post a card in the thread's chat for one tool call; returns its id. `merge` is the PR a `gh pr merge` names (src/merge-card.ts). */
  request(ticketId: number, tool: string, input: unknown, tripwire?: { reason: string; explanation: string }, merge?: object): string {
    const id = randomBytes(8).toString('hex');
    let shown = JSON.stringify(input ?? {});
    if (shown.length > MAX_INPUT) shown = JSON.stringify({ truncated: shown.slice(0, MAX_INPUT) });
    const card = { id, tool, input: JSON.parse(shown), ...(tripwire ? { tripwire } : {}), ...(merge ? { merge } : {}) };
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
  ask(ticketId: number, tool: string, input: object, cwd: string, cfg: TripwireConfig, rules: boolean, merge?: object, target?: MergeTarget | null, retry?: { target: MergeTarget; command: string } | null): { id: string } | { refused: string } {
    const verdict = tripwire({ tool_name: tool, tool_input: input, cwd }, { ...cfg, ask: true });
    if (verdict && !verdict.ask) return { refused: `The tripwire blocks this. ${verdict.reason}` };
    if (!verdict) {
      if (!rules) return { refused: 'Nobody can answer a permission prompt in this turn, so this was not run.' };
      // A go's PR merged in another shape (chained, a cd, no --repo): send it back once with the plain
      // command, which nothing rides along with; asked again, it gets the card (#209).
      const near = retry && this.goes.get(ticketId);
      if (near && !near.hinted && covers(near, retry.target)) {
        near.hinted = true;
        return { refused: `${near.by}'s go to merge covers PR #${retry.target.number}, but only as a lone plain merge, so this was not run. Run exactly \`${retry.command}\` as its own Bash call, with nothing before or after it (no cd, 2>&1, pipe, $( ) or chained check); --match-head-commit with the full SHA written out, and --delete-branch, may go on it. Check the result in a separate call. If you need what this call added, run it again unchanged and it gets the approval card.` };
      }
      const id = this.request(ticketId, tool, input, undefined, merge);
      // A person's go covers one merge: of the PR they named, or with none named, of this minion's own.
      const go = target && this.goes.get(ticketId);
      if (go && covers(go, target)) {
        go.spent = target.number;
        this.settle(id, this.requests.get(id)!, { state: 'allowed', by: go.by, via: { message: go.message, text: go.text } });
      }
      return { id };
    }
    const why = explanation(input);
    if (!why) return { refused: `${verdict.reason} An approval card needs a Bash description of why; it had none, so this was not run.` };
    if (JSON.stringify(input).length > MAX_INPUT) return { refused: 'This call is too long to show in full on an approval card, so it was not run. Hand the commands to a person.' };
    const mine = [...this.requests.values()].filter((r) => r.ticketId === ticketId && r.tripwire);
    if (mine.some((r) => r.decision.state === 'pending')) return { refused: 'An approval card for a tripwire block is already waiting in this chat; only one at a time. This was not run.' };
    if (mine.some((r) => r.decision.state === 'denied')) return { refused: 'A person denied a tripwire card earlier this turn, so no more are shown. This was not run: stop, and hand the commands to a person in your reply.' };
    return { id: this.request(ticketId, tool, input, { reason: verdict.reason, explanation: why }) };
  }

  /**
   * Messages a minion's turn read, in order (at its start or steered in). Only `typed` ones count: what a
   * signed-in person sent from the chat, as the messages route marks it. A go stands until that turn's
   * next typed message that isn't one, its PR no longer being open, or the turn's end. A turn's start (`start`) drops
   * any go left from before, so a go never outlives the turn that read it.
   */
  heard(ticketId: number, msgs: { author: string; text: string; id?: number; typed?: boolean }[], start = false) {
    if (start) this.goes.delete(ticketId);
    for (const m of msgs) {
      if (!m.typed) continue;
      const go = mergeGo(m.text);
      if (go) this.goes.set(ticketId, { by: m.author, pr: go.pr, message: m.id, text: m.text.trim().slice(0, 200) });
      else this.goes.delete(ticketId);
    }
  }

  /**
   * After a server restart, the cards a turn left waiting, from its stored events: its minion's
   * approve call is still polling for them (#209). The runner expires them again if the turn didn't survive.
   */
  restore(ticketId: number, events: { kind: string; data: string; created_at: number }[], since = 0) {
    const open = new Set(unsettledCards(events));
    for (const e of events) {
      if (e.kind !== 'approval' || e.created_at < since) continue;
      const card = JSON.parse(e.data);
      if (open.has(card.id)) this.requests.set(card.id, { ticketId, tripwire: !!card.tripwire, decision: { state: 'pending' }, wake: new Set(), card, at: e.created_at });
    }
  }

  /** Whether a turn holds a go to merge, so a merge call is worth looking up. */
  hasGo(ticketId: number): boolean {
    return this.goes.has(ticketId);
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

  /** The card's outcome so far; unknown cards (another thread's, or an ended turn's from before a restart) are expired. */
  get(ticketId: number, id: string): Decision {
    const r = this.requests.get(id) ?? this.ended.get(id);
    return r && r.ticketId === ticketId ? r.decision : { state: 'expired', reason: 'This request is no longer waiting.' };
  }

  /** Whether a waiting card is the tripwire's (those guard the server itself, so only admins settle them). */
  isTripwire(id: string): boolean {
    return !!this.requests.get(id)?.tripwire;
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
    this.goes.delete(ticketId);
    for (const [id, r] of this.requests) {
      if (r.ticketId !== ticketId) continue;
      if (r.decision.state === 'pending') this.settle(id, r, { state: 'expired', reason });
      this.requests.delete(id);
      this.ended.set(id, { ticketId, decision: r.decision });
    }
    for (const id of [...this.ended.keys()].slice(0, Math.max(0, this.ended.size - 100))) this.ended.delete(id);
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
