// Codex as a fallback for turns (#337): its models, how a Claude pick maps onto them, and the
// verbatim hand-over logs that carry a conversation from Claude to Codex and back. Shared by the
// runner, contraption turns and the turn shim (src/codex-turn.ts); no local imports, so it pins on its own.
import { constants, copyFileSync, existsSync, writeFileSync } from 'node:fs';

/** The Codex models a person can pick, best first, as [id, name]. Pinned with Codex 0.166.0 (deploy/claude-container). */
export const CODEX_MODELS = [
  ['gpt-6-astra', 'GPT-6 Astra'],
  ['gpt-6.1-sol', 'GPT-6.1 Sol'],
  ['gpt-6-luna', 'GPT-6 Luna'],
] as const;
/** Codex's own default, for a turn with no model picked. */
export const CODEX_DEFAULT = 'gpt-6.1-sol';

export const isCodexModel = (model: string | null | undefined): boolean => !!model && CODEX_MODELS.some(([id]) => id === model);

/**
 * The Codex model for a turn's pick (Josh, 2026-11-05: "On codex with an equivalent relative
 * strength/value model"): Opus and Fable get the frontier model, Sonnet the workhorse, Haiku the
 * fast one; a Codex pick stays; none gets Codex's default.
 */
export function codexModelFor(model: string | null | undefined): string {
  if (!model) return CODEX_DEFAULT;
  if (isCodexModel(model)) return model;
  if (/opus|fable/i.test(model)) return 'gpt-6-astra';
  if (/haiku/i.test(model)) return 'gpt-6-luna';
  return CODEX_DEFAULT;
}

/** Past this, a hand-over log cuts its biggest tool outputs first (~150k tokens at 4 characters each). */
export const HANDOVER_MAX = 600_000;

export type Part = { text: string; output?: boolean };

/** Join log parts, cutting the biggest outputs to one shared size (head and tail kept) until it fits in `max`. */
export function fitLog(parts: Part[], max = HANDOVER_MAX): string {
  const total = parts.reduce((n, p) => n + p.text.length + 1, 0);
  if (total <= max) return parts.map((p) => p.text).join('\n');
  const fixed = parts.reduce((n, p) => n + (p.output ? 0 : p.text.length + 1), 0);
  const outs = parts.filter((p) => p.output).map((p) => p.text.length);
  // The largest per-output size that fits: binary search over the cap.
  let [lo, hi] = [0, Math.max(0, ...outs)];
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fixed + outs.reduce((n, l) => n + Math.min(l, mid) + 60, 0) <= max) lo = mid;
    else hi = mid - 1;
  }
  return parts
    .map((p) => {
      if (!p.output || p.text.length <= lo) return p.text;
      const half = Math.floor(lo / 2);
      return `${p.text.slice(0, half)}\n[… ${p.text.length - 2 * half} characters cut to fit the hand-over …]\n${p.text.slice(p.text.length - half)}`;
    })
    .join('\n');
}

export const blockText = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? String(b.text ?? '') : b?.type === 'image' ? '[image]' : `[${b?.type ?? 'block'}]`)).join('\n') : '';

/**
 * The [System] note that opens each turn message with a minion's own lines, or the Citadel Taskmaster's every-scheme
 * line (promptParts().turn, #878). Each turn's message carries a fresh one, so a hand-over's log leaves the old ones out.
 * Plain prefixes here because the pinned Codex shim imports this file; app-facts and every-scheme keep them in step.
 */
export const isTurnNote = (text: string): boolean =>
  ['You are a minion working on #', 'You can read every scheme, read-only', "git in other schemes' folders"].some((p) => text.startsWith(`[System]: ${p}`));

/** A tool call as one log line: a Bash command as it is, anything else as its JSON input. */
export function callLine(name: string, input: any): string {
  if (name === 'Bash' && typeof input?.command === 'string') return `[Bash] ${input.command}`;
  return `[${name}] ${JSON.stringify(input ?? {})}`;
}

/**
 * Claude's transcript (its .jsonl) from the last compaction on, summary included, as a readable log:
 * people's messages, Claude's words, each tool call and its full output. Thinking and Grunts' own
 * steps are left out (a Grunt's report comes back as its Agent call's output).
 */
export function claudeLog(jsonl: string, max = HANDOVER_MAX): string {
  return fitLog(claudeParts(jsonl), max);
}

/** claudeLog's parts, before fitting. */
export function claudeParts(jsonl: string): Part[] {
  const lines = jsonl.split('\n');
  let from = 0;
  lines.forEach((l, i) => {
    if (l.includes('"compact_boundary"')) from = i + 1;
  });
  const parts: Part[] = [];
  for (const l of lines.slice(from)) {
    let e: any;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.isSidechain || !e.message) continue;
    const c = e.message.content;
    if (e.type === 'user') {
      if (e.isCompactSummary) parts.push({ text: `[Summary of the conversation before this point]\n${blockText(c)}` });
      else if (typeof c === 'string') parts.push({ text: `[Message] ${c}` });
      else if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === 'tool_result') parts.push({ text: `${b.is_error ? '[error] ' : ''}${blockText(b.content)}`, output: true });
          else if (b?.type === 'text' && !isTurnNote(String(b.text ?? ''))) parts.push({ text: `[Message] ${b.text}` });
          else if (b?.type === 'image') parts.push({ text: '[Message] [image]' });
        }
      }
    } else if (e.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'text' && String(b.text ?? '').trim()) parts.push({ text: `[Claude] ${b.text}` });
        else if (b?.type === 'tool_use') parts.push({ text: callLine(String(b.name), b.input) });
      }
    }
  }
  return parts;
}

/** What a Codex turn starts with when it takes over from Claude: the log, then the new message. */
export function toCodexPreamble(log: string): string {
  return `You are taking over this conversation from Claude, which ran it until now. Here it is verbatim from its last compaction (Claude's summary of what came before, then every message, reply, tool call and output; very long outputs may be cut in the middle). Carry on from where it left off: don't redo finished steps. The new message follows the log.\n\n<conversation>\n${log}\n</conversation>`;
}

/** What Claude's first turn after Codex starts with: the Codex turns, then the new message. */
export function toClaudePreamble(log: string): string {
  return `While Claude was unavailable or a person picked Codex, the last turns of this conversation ran on Codex (OpenAI). Here they are verbatim (every message, Codex's replies, its tool calls and their outputs; very long outputs may be cut in the middle). Carry on from where they left off: don't redo finished steps. The new message follows the log.\n\n<codex-turns>\n${log}\n</codex-turns>`;
}

/**
 * Developer instructions every Codex turn gets after Citadel's system prompt: how the Claude-shaped
 * instructions map onto Codex's tools.
 */
export const CODEX_NOTE = `## Running on Codex
You are running as Codex (OpenAI) inside Citadel, in place of Claude Code. The instructions above were written for Claude Code; read them with these swaps:
- Bash, Read, Grep and Glob: use the shell (exec_command). Edit, Write and MultiEdit: use apply_patch.
- Plan with your own plan updates, not the plan tool (mcp__thread__plan) nor TaskCreate, TaskUpdate or TodoWrite: the progress readout follows your plan updates. Keep working through the steps.
- The Agent tool (Grunts) is not available: do the work yourself.
- Skills ("use the citadel:… skill"): the citadel-… skills in your skills list are the same skills; open the SKILL.md and follow it.
- MCP tools keep their names (mcp__thread__set_thread_status is the thread server's set_thread_status). Call them as the instructions say.
- Citadel's tripwire checks every shell command, patch and tool call. When it blocks one, it says why: take that as final. Calls that would need a person's Approve / Deny card are blocked here; ask with ask_question instead, or say what you needed.
- Images you generate (image_gen) are copied into the worktree's generated/ folder; the tool result gives the absolute path. Link it in your reply as ![caption](/abs/path) so people see it.
- There is no interactive terminal: run commands to completion (no tty, no write_stdin).`;

/** What a turn says when it waits over a few seconds for the person's Codex lock (src/codex-lock.ts). */
export const CODEX_WAITING = "Waiting for this person's other Codex run: it is checking their login, or their Codex is set to run one at a time.";

/** A person's "Enable Codex override" (Settings, and the usage bar past 90%): true while on. */
export const codexSwitchKey = (uid: number) => `codex:on:user:${uid}`;
/** A person's Codex usage windows, from their turns' account/rateLimits notifications. */
export const codexUsageKey = (uid: number) => `codex:usage:user:${uid}`;
/** A minion's Codex thread while its turns run on Codex: { thread, person, log }. Dropped on the first Claude turn after. */
export const codexThreadKey = (ticketId: number) => `codex:thread:${ticketId}`;
export interface CodexThread {
  /** Codex's thread id, once the first turn has started it. */
  thread: string | null;
  /** Whose Codex (CODEX_HOME) holds it. */
  person: number;
  /** The Codex turns' log parts (one JSON { text, output? } a line), for the way back. */
  log: string;
}
export interface CodexUsage {
  primary: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
  secondary: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
  updatedAt: number;
}

/** A Codex log file's parts. */
export function readParts(jsonl: string): Part[] {
  return jsonl.split('\n').flatMap((l) => {
    try {
      const p = JSON.parse(l);
      return typeof p?.text === 'string' ? [{ text: p.text, output: !!p.output }] : [];
    } catch {
      return [];
    }
  });
}

/** When a person's full Codex window resets (ms), from their stored usage. */
export function codexResetAt(u: CodexUsage | null | undefined): number | null {
  const ws = [u?.primary, u?.secondary].filter((w): w is NonNullable<typeof w> => !!w?.resetsAt);
  const full = ws.filter((w) => w.usedPercent >= 100);
  const at = Math.max(0, ...(full.length ? full : ws).map((w) => w.resetsAt! * 1000));
  return at > Date.now() ? at : null;
}

/**
 * Write the picture of a Codex imageGeneration item to `to`: the file Codex saved in its own folder, or the
 * inline base64 (#716, #733). Without `overwrite`, never over anything already at `to`, a link included.
 * Throws why there is none, a used-up image limit included.
 */
export function saveGenerated(item: any, to: string, overwrite = true): void {
  if (typeof item?.savedPath === 'string' && existsSync(item.savedPath)) return copyFileSync(item.savedPath, to, overwrite ? 0 : constants.COPYFILE_EXCL);
  if (typeof item?.result === 'string' && item.result) return writeFileSync(to, Buffer.from(item.result, 'base64'), { flag: overwrite ? 'w' : 'wx' });
  const at = item?.failure?.resetsAt ? ` until ${new Date(item.failure.resetsAt * 1000).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}` : ''; // pacific-ok: codex.ts is pinned alone into a turn folder, so it imports no other src file
  if (item?.failure?.type === 'usageLimitExceeded') throw new Error(`Codex's image generation limit is used up${at}`);
  // An item with only a fileId (Codex's attachment store) has no bytes here to copy.
  throw new Error(item?.status === 'completed' ? 'Codex gave no image file' : `image generation ${item?.status ?? 'failed'}`);
}
