/**
 * The batch-lookups nudge, a one-week trial (PostToolUse, never blocks; #1278, from tokens T4, picked by Cara
 * 2026-11-20 "Go"): after a minion's third single read-only call in a row (Read, Grep, Glob, or a Bash that only
 * reads), adds one line to the tool result saying independent lookups go in one message. Once per run.
 * Only on minions' own sessions (COORDINATOR_ROLE=thread, no agent_id) and only on half of them: the minions
 * whose number is even. The other half is the control; `reports/batch-lookups-trial-2026-11.md` (written a week after it is live) compares them.
 * A call sent together with others in one assistant message is not single, and ends the run. Anything else (an
 * edit, a Bash that writes, an Agent call) ends it too. It runs inside flail-brake.ts's process, which already
 * runs after Bash and edits, so there is no process of its own.
 * State: one file per session in the turn's temp folder.
 */
import { closeSync, mkdirSync, openSync, readFileSync, readSync, fstatSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Single lookups in a row that earn the line. */
export const BATCH_AT = 3;

export const BATCH_LINE =
  `[citadel batch] That is ${BATCH_AT} single lookups in a row. When the next lookups don't depend on each other's results, send them in one message (or one script) instead of one per turn.`;

const READ_TOOLS = /^(?:Read|Grep|Glob)$/;
const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/;
const READ_WORDS = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'stat', 'file', 'pwd', 'jq', 'tree', 'du', 'diff', 'sort', 'uniq', 'cut', 'awk', 'which', 'date', 'ss', 'sqlite3']);
const READ_GIT = new Set(['log', 'show', 'diff', 'status', 'ls-files', 'grep', 'blame', 'branch', 'rev-parse', 'merge-base', 'cat-file', 'ls-tree']);

/** True when a Bash command only reads: every piece starts with a reading word and nothing writes a file. */
export function readOnlyBash(command: string): boolean {
  const c = command.trim();
  if (!c || /[`]|\$\(/.test(c)) return false;
  // Redirects to a file write; 2>&1 and >/dev/null don't.
  if (/(?:^|[^>&\d])>{1,2}\s*(?!\/dev\/null)\S/.test(c.replace(/\d?>&\d/g, ''))) return false;
  const parts = c.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => {
    const words = p.replace(/^(?:\w+=\S*\s+)+/, '').split(/\s+/);
    const w = (words[0] ?? '').replace(/^.*\//, '');
    if (w === 'git') return READ_GIT.has(words.find((x, i) => i > 0 && !x.startsWith('-')) ?? '');
    if (w === 'sed') return !words.some((x) => /^-\w*i/.test(x));
    if (w === 'sqlite3') return words.includes('-readonly');
    if (w === 'find') return !words.some((x) => /^-(?:delete|exec|execdir|ok)$/.test(x));
    return READ_WORDS.has(w) && w !== 'sqlite3';
  });
}

/** How many tool calls the assistant message holding this call made (1 when it can't be read). */
export function callsInMessage(transcriptPath: unknown, toolUseId: unknown): number {
  if (typeof transcriptPath !== 'string' || typeof toolUseId !== 'string') return 1;
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      // The transcript stores one line per content block, parallel calls sharing message.id.
      const rows = buf.toString('utf8').split('\n').flatMap((l) => {
        if (!l.includes('"tool_use"')) return [];
        try {
          const m = JSON.parse(l)?.message;
          return Array.isArray(m?.content) ? [m] : [];
        } catch {
          return [];
        }
      });
      const mine = rows.find((m) => m.content.some((b: any) => b?.type === 'tool_use' && b.id === toolUseId));
      if (mine?.id) return new Set(rows.filter((m) => m.id === mine.id).flatMap((m) => m.content.filter((b: any) => b?.type === 'tool_use').map((b: any) => b.id))).size;
      if (mine) return mine.content.filter((b: any) => b?.type === 'tool_use').length;
    } finally {
      closeSync(fd);
    }
  } catch {
    // Unreadable: count it as single.
  }
  return 1;
}

/** Whether this minion is in the nudged half: the trial's arm, by minion number (COORDINATOR_NUMBER, the #N; COORDINATOR_TICKET is the row id). Until 2026-11-21 it split on the row id; the report groups earlier turns by row id. */
export function nudgedMinion(ticket: unknown): boolean {
  const n = Number(ticket);
  return Number.isInteger(n) && n % 2 === 0;
}

type State = { count: number; said: boolean };

/** One hook call; returns the line to add, or null. */
export function batchNudgeLine(input: any, env = process.env, stateDir = join(tmpdir(), 'citadel-kit')): string | null {
  if (env.COORDINATOR_ROLE !== 'thread' || input?.agent_id || !nudgedMinion(env.COORDINATOR_NUMBER)) return null;
  const tool = String(input?.tool_name ?? '');
  const file = join(stateDir, `batch-${String(input?.session_id ?? 'unknown').replace(/[^\w.-]/g, '_')}.json`);
  const write = (s: State) => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(file, JSON.stringify(s));
  };
  const lookup =
    READ_TOOLS.test(tool) || (tool === 'Bash' && !input?.tool_input?.run_in_background && readOnlyBash(String(input?.tool_input?.command ?? '')));
  if (!lookup || callsInMessage(input?.transcript_path, input?.tool_use_id) > 1) {
    if (lookup || EDIT_TOOLS.test(tool) || tool === 'Bash') write({ count: 0, said: false });
    return null;
  }
  let state: State = { count: 0, said: false };
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // No run yet.
  }
  const next: State = { count: state.count + 1, said: state.said };
  const say = next.count >= BATCH_AT && !next.said;
  if (say) next.said = true;
  write(next);
  return say ? BATCH_LINE : null;
}
