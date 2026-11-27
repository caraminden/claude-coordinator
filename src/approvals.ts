// Per-project approval rules and plugin folders, and the Approve / Deny cards that ask people
// before a thread runs a tool matching one of the rules.
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { callOf, type CardCall, type ShownCard } from './card-wait.ts';
import type { MergeCall, PrInfo } from './merge-card.ts';
import { explanation, tripwire, type TripwireConfig, type Verdict } from './tripwire.ts';

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
  return (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
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
    if (
      d.length > MAX_RULE ||
      d.startsWith('~') ||
      d
        .replace(/^\//, '')
        .split('/')
        .some((s) => s === '..' || s === '.' || !s)
    ) {
      throw new Error(`"${d.slice(0, 80)}" must be a folder path relative to the repo root, like tools/mods/delve, or an absolute one`);
    }
  }
  return dirs.join('\n');
}

/** Validate quiet CI workflows (#678) from the API: workflow file names, one per line (a .github/workflows/ path is cut to its name); returns them as stored. */
export function cleanWorkflows(raw: unknown, what = 'Quiet CI workflows'): string {
  const names = [...new Set(list(raw, what).map((w) => w.replace(/^\.?\/?\.github\/workflows\//, '')))];
  if (names.length > MAX_RULES) throw new Error(`At most ${MAX_RULES} ${what.toLowerCase()}`);
  for (const w of names) if (!/^[\w.-]{1,150}\.ya?ml$/.test(w)) throw new Error(`"${w.slice(0, 80)}" is not a workflow file name, like drift.yml`);
  return names.join('\n');
}

/** Screenshot widths (#1044) from the API: a comma list or an array of pixel widths, 1 to 8 of them, as stored ('1440,390'). */
export function cleanShotWidths(raw: unknown): string {
  const parts = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null)?.map((w) => String(w).trim()).filter(Boolean);
  if (!parts?.length) throw new Error('Screenshot widths are a list of pixel widths, like 1440,390');
  const widths = [...new Set(parts.map((w) => (/^\d{1,5}$/.test(w) ? Number(w) : NaN)))];
  if (widths.some((w) => !(w >= 200 && w <= 5000))) throw new Error('Each screenshot width is a number of pixels from 200 to 5000');
  if (widths.length > 8) throw new Error('At most 8 screenshot widths');
  return widths.join(',');
}

/** Screenshot themes (#1044): light, dark or both, as stored ('light', 'light,dark'). */
export function cleanShotThemes(raw: unknown): string {
  const parts = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null)?.map((t) => String(t).trim());
  if (!parts?.length || parts.some((t) => t !== 'light' && t !== 'dark')) throw new Error('Screenshot themes are light, dark or light,dark');
  return ['light', 'dark'].filter((t) => parts.includes(t)).join(',');
}

/** The free-text screenshot note (#1044): one line, at most 200 characters; '' clears it. */
export function cleanShotNote(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw !== 'string') throw new Error('The screenshot note must be text');
  const note = raw.replace(/\s+/g, ' ').trim();
  if (note.length > 200) throw new Error(`The screenshot note is ${note.length} characters; the limit is 200`);
  return note;
}

/**
 * Validate a minion's plugin picks (#361): folders from its scheme's optional list, as stored ('' for none).
 * Registering a folder there is admin-only (src/routes/projects.ts), so a pick never names a new path.
 */
export function cleanPluginPicks(raw: unknown, optional: string): string {
  if (raw == null || raw === '') return '';
  const picks = cleanPluginDirs(raw);
  const allowed = lines(optional);
  for (const d of lines(picks)) {
    if (!allowed.length) throw new Error('This scheme has no optional plugin folders to pick from; an admin adds them in its settings');
    if (!allowed.includes(d)) throw new Error(`"${d.slice(0, 80)}" is not one of this scheme's optional plugin folders: ${allowed.join(', ')}`);
  }
  return picks;
}

/** The plugin folders a turn loads besides the kit: its scheme's, then its minion's picks still on the optional list. A Taskmaster loads none. */
export function turnPluginDirs(project: { plugin_dirs: string; optional_plugin_dirs: string }, ticket: { kind: string; plugin_dirs: string }): string[] {
  if (ticket.kind === 'coordinator') return [];
  const optional = lines(project.optional_plugin_dirs);
  return [...new Set([...lines(project.plugin_dirs), ...lines(ticket.plugin_dirs).filter((d) => optional.includes(d))])];
}

/**
 * Permission flags for a turn. A minion's prompts go to the approval tool: the tripwire's asks, and
 * the project's approval rules, which the runner adds as `ask` rules to the turn's settings (Claude
 * Code still checks those in bypassPermissions). The tool shows a card for those and refuses any
 * other prompt (Approvals.ask). A Taskmaster's turn denies anything that would prompt.
 */
export function permissionArgs(cards: boolean): string[] {
  if (!cards) return ['--permission-prompts', 'none'];
  return ['--permission-prompts', 'host', '--permission-prompt-tool', APPROVAL_TOOL];
}

/** `--plugin-dir` for each of the project's plugin folders that exists: in this worktree, or at its absolute path. */
export async function pluginDirArgs(dirs: string[], cwd: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of dirs) {
    const path = isAbsolute(d) ? d : join(cwd, d);
    if (
      await stat(path)
        .then((s) => s.isDirectory())
        .catch(() => false)
    )
      out.push('--plugin-dir', path);
  }
  return out;
}

export type Decision =
  | { state: 'pending' }
  // via: the typed go that let it through, and the chat it was typed in (#260): scheme, and minion number or null for the Taskmaster.
  // to: for a go typed in the Taskmaster chat, the minion it covered (#939).
  | { state: 'allowed' | 'denied'; by: string; via?: { message?: number; text: string; scheme: number; ticket: number | null; to?: number } }
  | { state: 'expired'; reason: string };

// A message that is only a go to land (#201): "land it", "yes land PR #191", "ship it", and the older "merge it" and
// "ok, fold it" (Cara, 2026-11-19: fold is retired, but a person's old go still counts).
const GO = /^(?:(?:ok|okay|yes|yep|great|lgtm|looks good|go ahead|go|please|pls|plz),? )?(?:and )?(?:you can )?(?:merge|fold|land|squash|ship)(?: (?:it|this|the pr|pr #?(\d{1,7})|#(\d{1,7})|(\d{1,7})))?(?: in)?(?: (?:please|pls|plz|now))?$/;

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]+$/, '')
    .trimEnd();

/** A go and how it names its number: "PR 5", "#5", a bare "5", or none. */
function parseGo(text: string): { pr: number | null; named: 'pr' | 'hash' | 'bare' | null } | null {
  const m = GO.exec(words(text));
  if (!m) return null;
  const n = m[1] ?? m[2] ?? m[3];
  return { pr: n ? Number(n) : null, named: m[1] ? 'pr' : m[2] ? 'hash' : m[3] ? 'bare' : null };
}

/** The PR a message that says nothing but "merge it" means: its number, or null for the minion's own; null if it isn't one. */
export function mergeGo(text: string): { pr: number | null } | null {
  const go = parseGo(text);
  return go && { pr: go.pr };
}

// Text in double, curly or back quotes: a relay quotes a go word for word in one of these (#939). Not plain
// single quotes, which apostrophes would open.
const QUOTED = /"([^"\n]{1,200})"|“([^”\n]{1,200})”|‘([^’\n]{1,200})’|`([^`\n]{1,200})`/g;
const quotes = (text: string, go: string) => [...text.matchAll(QUOTED)].some((q) => words(q[1] ?? q[2] ?? q[3] ?? q[4]) === words(go));

/**
 * A person's typed go to merge, kept for its whole scheme (#260): who typed it, where, and the PR it
 * means: the one named, or with none named, the PR of the branch of the minion it was typed in.
 */
export interface Go {
  by: string;
  pr: number | null;
  /** The minion it was typed in: its id, its number in the scheme (null: the Taskmaster) and its branch. */
  ticket: number;
  number: number | null;
  branch: string | null;
  message?: number;
  text: string;
  /** A merge it covers was sent back once with the plain command to run (#209). */
  hinted?: boolean;
  /** Typed in the Taskmaster chat (#939): the minion it covers, named as "#N" or the one a relay quoted it to. */
  to?: number;
  /** A bare go typed in the Taskmaster chat: it covers nothing until the Taskmaster quotes it in a relay to one minion. */
  bare?: true;
}

/** The minion a message was typed in, as a go records it. */
export interface GoPlace {
  id: number;
  number: number | null;
  branch: string | null;
}

/**
 * Whether a go covers a merge's PR: the one named or, with none named, its minion's branch's PR, and
 * only while it is open. Bound to the number, not the head: a build that re-merges its tip and
 * pushes a new head is still what they meant; a merge GitHub refused left it open for the retry.
 */
const covers = (go: Go, target: MergeTarget) => target.open === true && (go.pr === null ? !!go.branch && go.branch === target.head : target.number === go.pr);

/** A merge call's PR as a go is checked against: its number, its head branch, and whether it is open. */
export interface MergeTarget {
  number: number;
  head: string;
  /** The lookup found it open, so no merge of it has gone through yet. */
  open?: boolean;
}

/** Where a scheme's standing gos are kept: the server keeps them in its settings, so a restart keeps them. */
export interface GoStore {
  get(scheme: number): Go[];
  set(scheme: number, goes: Go[]): void;
}

// shortcut: a go whose PR merges or closes without any minion trying it again stays until newer gos push it out; add an age limit if that ever matters.
const MAX_GOES = 50;

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
export function mcpMerge(tool: string, input: Record<string, unknown>): MergeCall | null {
  const m = tool.match(/^mcp__[^_].*__(merge_pull_request|enable_pr_auto_merge)$/);
  const n = input?.pullNumber ?? input?.pull_number;
  // Both spellings with different numbers: which one the server merges isn't ours to guess.
  if (input?.pullNumber !== undefined && input?.pull_number !== undefined && input.pullNumber !== input.pull_number) return null;
  if (!m || typeof n !== 'number' || !Number.isInteger(n) || n < 1 || typeof input.owner !== 'string' || typeof input.repo !== 'string') return null;
  // As with gh: no commit title or message riding along, and squash or a merge commit (or the repo's default).
  if (Object.keys(input).some((k) => !MCP_GO_KEYS.has(k))) return null;
  for (const method of [input.merge_method, input.mergeMethod]) {
    if (method !== undefined && !(typeof method === 'string' && ['squash', 'merge'].includes(method.toLowerCase()))) return null;
  }
  if (!/^[\w.-]+$/.test(input.owner) || !/^[\w.-]+$/.test(input.repo)) return null;
  return { target: String(n), repo: `${input.owner}/${input.repo}`, method: null, auto: m[1] === 'enable_pr_auto_merge', admin: false, moved: false };
}

/** The target of a merge call whose looked-up PR is in the scheme's repo; null otherwise. */
export function mergeTarget(pr: PrInfo | null, schemeRepo: string | null): MergeTarget | null {
  const repo = pr?.url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/)?.[1];
  if (!pr || !repo || !schemeRepo || repo.toLowerCase() !== schemeRepo.toLowerCase()) return null;
  return { number: pr.number, head: pr.head, open: pr.state === 'OPEN' };
}

interface Request {
  ticketId: number;
  /** A tripwire card rather than one for the project's approval rules. */
  tripwire: boolean;
  decision: Decision;
  wake: Set<() => void>;
  /** The card as the chat shows it, and when it was posted, for the Needs-you inbox. */
  card: ShownCard;
  at: number;
  /** Its turn's process ended while it waited (#1916): it outlives the turn, and its answer resumes the minion. */
  kept?: true;
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
  private emit: Emit;
  /** Spend the turn's pass on this call: the approved card's id and who approved it, or null when it has none for exactly this call. */
  usePass: (ticketId: number, call: CardCall) => { id: string; by: string } | null = () => null;
  /** A kept card was answered. */
  keptAnswered: (ticketId: number, id: string, allow: boolean, by: string) => void = () => {};
  /** Each scheme's standing gos to merge, from messages people typed into its chats (#201, #260). */
  private goes: GoStore;

  constructor(emit: Emit, goes?: GoStore) {
    this.emit = emit;
    const mem = new Map<number, Go[]>();
    this.goes = goes ?? { get: (s) => mem.get(s) ?? [], set: (s, g) => mem.set(s, g) };
  }

  /** Post a card in the thread's chat for one tool call; returns its id. `merge` is the PR a `gh pr merge` names (src/merge-card.ts). */
  request(ticketId: number, tool: string, input: unknown, tripwire?: { reason: string; explanation: string }, merge?: object, use?: string): string {
    const id = randomBytes(8).toString('hex');
    let shown = JSON.stringify(input ?? {});
    if (shown.length > MAX_INPUT) shown = JSON.stringify({ truncated: shown.slice(0, MAX_INPUT) });
    const card = { id, tool, input: JSON.parse(shown), ...(tripwire ? { tripwire } : {}), ...(merge ? { merge } : {}), ...(use ? { use } : {}) };
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
   * The server passes `judged`, the verdict worked out in a worker (src/tripwire-judge.ts, #2151); left out, it's
   * worked out here, on the caller's thread.
   */
  ask(ticketId: number, tool: string, input: object, cwd: string, cfg: TripwireConfig, rules: boolean, merge?: object, target?: MergeTarget | null, retry?: { target: MergeTarget; command: string } | null, use?: string, judged?: { verdict: Verdict | null }): { id: string } | { refused: string } {
    // A throwaway saves list: the hook already saved what a file checkout throws away (#1716), so it passes here too.
    const verdict = judged ? judged.verdict : tripwire({ tool_name: tool, tool_input: input, cwd }, { ...cfg, ask: true }, []);
    if (verdict && !verdict.ask) return { refused: `The tripwire blocks this. ${verdict.reason}` };
    const call = callOf({ id: '', tool, input, tripwire: verdict ?? undefined, merge }, cwd);
    const pass = call && this.usePass(ticketId, call);
    if (pass) {
      // Its card was answered already: the asker reads that answer (get), and no second card is posted.
      this.ended.set(pass.id, { ticketId, decision: { state: 'allowed', by: pass.by } });
      return { id: pass.id };
    }
    if (!verdict) {
      if (!rules) return { refused: 'Nobody can answer a permission prompt in this turn, so this was not run.' };
      const scheme = cfg.project;
      // A go's PR merged in another shape (chained, a cd, no --repo): send it back once with the plain
      // command, which nothing rides along with; asked again, it gets the card (#209).
      const near = retry && this.goFor(scheme, retry.target);
      if (near && !near.go.hinted) {
        near.go.hinted = true;
        this.goes.set(scheme, near.goes);
        return {
          refused: `${near.go.by}'s go to merge covers PR #${retry.target.number}, but only as a lone plain merge, so this was not run. Run exactly \`${retry.command}\` as its own Bash call, with nothing before or after it (no cd, 2>&1, pipe, $( ) or chained check); --match-head-commit with the full SHA written out, and --delete-branch, may go on it. Check the result in a separate call. If you need what this call added, run it again unchanged and it gets the approval card.`,
        };
      }
      const id = this.request(ticketId, tool, input, undefined, merge, use);
      // A person's go typed in any of the scheme's chats covers its PR until that merges or closes (#260).
      const found = target && this.goFor(scheme, target);
      const go = found?.go;
      if (found && go!.pr === null) {
        // "land it" means the PR its branch had then: a later PR from the same branch needs a new go.
        go!.pr = target!.number;
        this.goes.set(scheme, found.goes);
      }
      if (go) this.settle(id, this.requests.get(id)!, { state: 'allowed', by: go.by, via: { message: go.message, text: go.text, scheme, ticket: go.number, ...(go.to !== undefined ? { to: go.to } : {}) } });
      return { id };
    }
    const why = explanation(input);
    if (!why) return { refused: `${verdict.reason} An approval card needs a Bash description of why; it had none, so this was not run.` };
    if (JSON.stringify(input).length > MAX_INPUT) return { refused: 'This call is too long to show in full on an approval card, so it was not run. Hand the commands to a person.' };
    const mine = [...this.requests.values()].filter((r) => r.ticketId === ticketId && r.tripwire);
    if (mine.some((r) => r.decision.state === 'pending')) return { refused: 'An approval card for a tripwire block is already waiting in this chat; only one at a time. This was not run.' };
    if (mine.some((r) => r.decision.state === 'denied')) return { refused: 'A person denied a tripwire card earlier this turn, so no more are shown. This was not run: stop, and hand the commands to a person in your reply.' };
    return { id: this.request(ticketId, tool, input, { reason: verdict.reason, explanation: why }, undefined, use) };
  }

  /**
   * A message delivered to one of a scheme's chats. Only `typed` ones count: what a signed-in person sent
   * from the chat, as the messages route marks it. A go stands for the whole scheme until its PR is seen
   * merged or closed, or until a later typed message in the same chat that isn't one (newest word wins).
   * In the Taskmaster chat (#939) "#N" names minion N (`minion` looks it up), "PR N" a PR, and a bare
   * number nothing; a bare go waits for the Taskmaster to quote it to one minion (relayed).
   */
  said(scheme: number, where: GoPlace, m: { author: string; text: string; id?: number; typed?: boolean; from?: number }, minion?: (n: number) => GoPlace | null) {
    if (!m.typed) {
      if (m.from) this.relayed(scheme, where, m.text, m.from);
      return;
    }
    const go = parseGo(m.text);
    // A word in a minion's chat also takes back a go the Taskmaster chat handed it.
    const goes = this.goes.get(scheme).filter((g) => go || (g.ticket !== where.id && (where.number === null || g.to !== where.number)));
    const said = { by: m.author, ticket: where.id, number: where.number, message: m.id, text: m.text.trim().slice(0, 200) };
    if (go && where.number !== null) goes.push({ ...said, pr: go.pr, branch: where.branch });
    else if (go?.named === 'pr') goes.push({ ...said, pr: go.pr, branch: null });
    else if (go?.named === null) goes.push({ ...said, pr: null, branch: null, bare: true });
    else if (go) {
      const target = go.named === 'hash' ? minion?.(go.pr!) : null;
      if (target?.branch && target.number !== null) goes.push({ ...said, pr: null, branch: target.branch, to: target.number });
      else this.emit(where.id, 'note', { text: `${m.author}'s "${said.text}" names no minion with a branch, so it covers nothing: "ship #N" names minion N, "ship PR N" a PR.` });
    }
    this.goes.set(scheme, goes.slice(-MAX_GOES));
  }

  /**
   * The Taskmaster's relay to a minion (`from`: the chat it came from). A bare go typed in that chat which the
   * relay quotes word for word now covers this minion's PR, as if typed in its own chat; quoted to a second
   * minion, it covers neither. The Taskmaster's chat gets a note either way, so a misroute shows before a merge.
   */
  private relayed(scheme: number, where: GoPlace, text: string, from: number) {
    if (where.number === null || !where.branch) return;
    const goes = this.goes.get(scheme);
    const quoted = goes.filter((g) => g.bare && g.ticket === from && quotes(text, g.text));
    if (!quoted.length || quoted.some((g) => g.to === where.number)) return;
    // The same words typed again: the newest go not yet handed on goes to this minion, the others stay where they went.
    const free = quoted.findLast((g) => g.to === undefined);
    if (free) {
      free.to = where.number;
      free.branch = where.branch;
      this.emit(free.ticket, 'note', { text: `${free.by}'s go "${free.text}" now covers #${where.number}'s PR: the Taskmaster quoted it to #${where.number}.` });
      return this.goes.set(scheme, goes);
    }
    for (const g of quoted) this.emit(g.ticket, 'note', { text: `${g.by}'s go "${g.text}" was quoted to #${g.to}, then also quoted to #${where.number}, so it covers neither. Give the go again naming the minion ("ship #N"), or in its own chat.` });
    this.goes.set(
      scheme,
      goes.filter((g) => !quoted.includes(g)),
    );
  }

  /** A queued message taken back before any turn read it: a go it gave goes with it. */
  unsaid(scheme: number, message: number) {
    const goes = this.goes.get(scheme);
    const left = goes.filter((g) => g.message !== message);
    if (left.length !== goes.length) this.goes.set(scheme, left);
  }

  /**
   * The newest go covering a merge's PR, with the scheme's list it sits in. A PR found merged or closed
   * ends every go that meant it, so a reopened PR needs a new go.
   */
  private goFor(scheme: number, target: MergeTarget): { go: Go; goes: Go[] } | null {
    const goes = this.goes.get(scheme);
    if (target.open === false) {
      const left = goes.filter((g) => !covers(g, { ...target, open: true }));
      if (left.length !== goes.length) this.goes.set(scheme, left);
      return null;
    }
    const go = goes.findLast((g) => covers(g, target));
    return go ? { go, goes } : null;
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
      if (open.has(card.id) && !this.requests.has(card.id)) this.requests.set(card.id, { ticketId, tripwire: !!card.tripwire, decision: { state: 'pending' }, wake: new Set(), card, at: e.created_at });
    }
  }

  /** Whether a scheme holds a go to merge, so a merge call is worth looking up. */
  hasGo(scheme: number): boolean {
    return this.goes.get(scheme).length > 0;
  }

  /** How many of a thread's cards are waiting on a person. */
  waiting(ticketId: number): number {
    let n = 0;
    for (const r of this.requests.values()) if (r.ticketId === ticketId && r.decision.state === 'pending') n++;
    return n;
  }

  /** A thread's waiting cards: the tool each is for and its call's id, which cards from before #1916 lack. */
  cards(ticketId: number): (ShownCard & { at: number })[] {
    return [...this.requests.values()].filter((r) => r.ticketId === ticketId && r.decision.state === 'pending').map((r) => ({ ...r.card, at: r.at }));
  }

  /** Keep a waiting card past its turn, whose process ends now: from here on that process never learns the answer. */
  keep(id: string) {
    const r = this.requests.get(id);
    if (r) r.kept = true;
  }

  /** The turn that resumes after a kept card starts: the card is that turn's now, and ends with it. */
  resumed(ticketId: number) {
    for (const r of this.requests.values()) if (r.ticketId === ticketId) delete r.kept;
  }

  /** Nobody can answer a kept card any more. */
  expire(id: string, reason: string) {
    const r = this.requests.get(id);
    if (r?.decision.state === 'pending') this.settle(id, r, { state: 'expired', reason });
    if (r) this.ended.set(id, { ticketId: r.ticketId, decision: r.decision });
    this.requests.delete(id);
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
    if (r.kept) this.keptAnswered(ticketId, id, allow, by);
    return r.decision;
  }

  /** Resolve once the card is settled or `ms` passes, with its outcome then. */
  wait(ticketId: number, id: string, ms: number): Promise<Decision> {
    const r = this.requests.get(id);
    if (!r || r.ticketId !== ticketId || (r.decision.state !== 'pending' && !r.kept)) return Promise.resolve(this.get(ticketId, id));
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        r.wake.delete(done);
        // A kept card's only asker is the process that is ending: an answer to it would run the call there as well as in the resumed turn.
        resolve(r.kept ? { state: 'pending' } : r.decision);
      };
      const timer = setTimeout(done, ms);
      r.wake.add(done);
    });
  }

  /** Answer every waiting long-poll now with its card's state so far, for a server shutting down. */
  wakeAll() {
    for (const r of this.requests.values()) for (const done of [...r.wake]) done();
  }

  /** The thread's turn ended: expire its undecided cards and forget them all, but for a kept one. */
  endTurn(ticketId: number, reason: string) {
    for (const [id, r] of this.requests) {
      if (r.ticketId !== ticketId || r.kept) continue;
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
