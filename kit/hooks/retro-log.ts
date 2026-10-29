/**
 * The retro log: one line per tripwire (or repo guard.sh) refusal, red test, failed push or refused stop, appended to
 * $COORDINATOR_SHARED_DIR/retro-log/<date>/<session>.md for the retro skill to read. Hooks
 * (hooks.json): PostToolUse and PostToolUseFailure on Bash catch red tests and failed pushes. A
 * refusing PreToolUse hook fires no hook after it, so Stop and SubagentStop read it from the transcript.
 * job-check.ts writes the refused stops. Ported from Delve's mod (tools/mods/delve/hooks/retro-log.ts).
 * The log is a convenience: every failure here is swallowed, never breaking the call it describes.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const safe = (s: string) => s.replace(/[^\w.-]/g, '_') || 'unknown';

/** Where a session's log for `now`'s date (UTC) goes. */
export function logPath(sharedDir: string, session: string, now: Date): string {
  return join(sharedDir, 'retro-log', now.toISOString().slice(0, 10), `${safe(session)}.md`);
}

/** Appends one line to the session's log, starting the file with a header that says whose it is. */
export function note(input: { session_id?: string; cwd?: string }, kind: string, detail: string, env = process.env, now = new Date()): void {
  const shared = env.COORDINATOR_SHARED_DIR;
  if (!shared) return;
  try {
    const session = input.session_id ?? 'unknown';
    const path = logPath(shared, session, now);
    mkdirSync(join(path, '..'), { recursive: true });
    let fd: number | null = null;
    try {
      fd = openSync(path, 'wx');
    } catch {
      // Already started.
    }
    if (fd !== null) {
      writeFileSync(fd, header(session, input.cwd));
      closeSync(fd);
    }
    const line = detail.replace(/\s+/g, ' ').trim().slice(0, 400);
    appendFileSync(path, `- ${now.toISOString().slice(11, 19)}Z · ${kind} · ${line}\n`);
  } catch {
    // See the file comment.
  }
}

function header(session: string, cwd: string | undefined): string {
  let where = cwd ? `Worktree ${cwd}` : '';
  try {
    const branch = cwd ? execFileSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim() : '';
    if (branch) where += `, branch ${branch}`;
  } catch {
    // Not a git folder.
  }
  return `# Retro log: ${session}\n\nWritten by the Citadel kit's hooks (kit/hooks). One line per tripwire or guard.sh refusal, red test, failed push or refused stop.${where ? `\n${where}.` : ''}\n\n`;
}

/** How many tests a run's output says failed (node --test, dotnet, pytest and jest summaries), or 0. */
export function failedTests(text: string): number {
  const counts = [
    ...[...text.matchAll(/^\s*(?:ℹ|#) fail (\d+)\s*$/gm)].map((m) => m[1]),
    ...[...text.matchAll(/\bFailed:\s+(\d+)/g)].map((m) => m[1]),
    ...[...text.matchAll(/\b(\d+) failed\b/g)].map((m) => m[1]),
  ].map(Number);
  return counts.reduce((a, b) => a + b, 0);
}

/** A Bash call's output, from PostToolUse (tool_response) or PostToolUseFailure (error). */
function outputOf(input: any): string {
  if (typeof input.error === 'string') return input.error;
  const r = input.tool_response;
  if (typeof r === 'string') return r;
  return `${r?.stdout ?? ''}\n${r?.stderr ?? ''}`;
}

/** The retro lines one finished Bash call earns. */
export function bashLines(input: any): [string, string][] {
  const command = String(input?.tool_input?.command ?? '');
  if (!command || input?.tool_input?.run_in_background) return [];
  const out = outputOf(input);
  const lines: [string, string][] = [];
  const failed = failedTests(out);
  if (failed > 0) lines.push(['red test', `${failed} failed: ${command.slice(0, 160)}`]);
  if (input.hook_event_name === 'PostToolUseFailure' && /\bgit(?:\s+-C\s+\S+|\s+-\S+)*\s+push\b/.test(command)) {
    lines.push(['failed push', `${command.slice(0, 120)}: ${out.trim().split('\n').slice(-3).join(' ')}`]);
  }
  return lines;
}

/**
 * The refusals in a transcript (JSONL) of the tripwire, or of a repo's tools/guard.sh: the tool results
 * their PreToolUse hooks turned into errors, as [tool_use_id, who ("tripwire" or "guard"), tool, reason].
 * With `promptId`, only those of that prompt (this turn).
 */
export function refusals(transcript: string, promptId?: string): [string, string, string, string][] {
  const found: [string, string, string, string][] = [];
  for (const raw of transcript.split('\n')) {
    if (!/\[(tripwire|guard)\]/.test(raw) || !raw.includes('PreToolUse:')) continue;
    let entry: any;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (entry?.type !== 'user' || (promptId && entry.promptId !== promptId)) continue;
    const content = entry.message?.content;
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type !== 'tool_result' || !block.is_error) continue;
      const text = typeof block.content === 'string' ? block.content : (block.content ?? []).map((c: any) => c?.text ?? '').join('\n');
      const tool = text.match(/^PreToolUse:(\S+) hook error/)?.[1];
      const m = text.match(/\]: \[(tripwire|guard)\] ([^\n]*)/) ?? text.match(/\[(tripwire|guard)\] ([^\n]*)/);
      if (tool && m) found.push([String(block.tool_use_id ?? ''), m[1], tool, m[2]]);
    }
  }
  return found;
}

/** Logs the refusals a transcript holds, each once per session (a blocked Stop fires again). */
function logRefusals(input: any, transcriptPath: string | undefined, promptId?: string): void {
  if (!transcriptPath) return;
  const found = refusals(readFileSync(transcriptPath, 'utf8'), promptId);
  if (!found.length) return;
  const seenFile = join(tmpdir(), 'citadel-kit', `retro-${safe(String(input.session_id ?? 'unknown'))}.json`);
  let seen: string[] = [];
  try {
    seen = JSON.parse(readFileSync(seenFile, 'utf8'));
  } catch {
    // First refusal this session.
  }
  const fresh = found.filter(([id]) => !id || !seen.includes(id));
  for (const [, who, tool, reason] of fresh) note(input, `${who} refusal`, `${tool}: ${reason}`);
  mkdirSync(join(seenFile, '..'), { recursive: true });
  writeFileSync(seenFile, JSON.stringify([...seen, ...fresh.map(([id]) => id)].slice(-500)));
}

/** One hook call: `input` is Claude Code's hook input. */
export function retroHook(input: any): void {
  if (!process.env.COORDINATOR_SHARED_DIR) return;
  const event = input?.hook_event_name;
  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    if (input.tool_name === 'Bash') for (const [kind, detail] of bashLines(input)) note(input, kind, detail);
  } else if (event === 'Stop') {
    logRefusals(input, input.transcript_path, input.prompt_id);
  } else if (event === 'SubagentStop') {
    logRefusals(input, input.agent_transcript_path);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    retroHook(JSON.parse(readFileSync(0, 'utf8')));
  } catch {
    // See the file comment.
  }
}
