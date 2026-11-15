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
  return `# Retro log: ${session}\n\nWritten by the Citadel kit's hooks (kit/hooks). One line per tripwire or guard.sh refusal, red test, failed push, refused stop, would-refuse stop or "Process:" line from a self-review.${where ? `\n${where}.` : ''}\n\n`;
}

/** The test runners whose summaries it reads; `any` is a wrapper (npm test, a check script) that could run any of them. */
export type Runner = 'node' | 'dotnet' | 'pytest' | 'jest' | 'mocha' | 'cargo' | 'go' | 'any';

/** Each runner's own summary line, as [pattern, how to read its count]. */
const SUMMARIES: Record<Exclude<Runner, 'any'>, (text: string) => number> = {
  node: (t) => sum(t, /^\s*(?:ℹ|#) fail (\d+)\s*$/gm),
  // `dotnet test` prints one "Failed!" line per test project; newer SDKs add one overall "Test summary".
  dotnet: (t) => sum(t, /^\s*Test summary: total: \d+, failed: (\d+)/gim) || sum(t, /\bFailed!\s+-\s+Failed:\s+(\d+)/g),
  pytest: (t) => sum(t, /^[=\s]*(?:\d+ \w+, )*(\d+) failed\b.* in [\d.]+s\b/gm),
  jest: (t) => sum(t, /^\s*Tests:?\s+(\d+) failed\b/gm),
  mocha: (t) => sum(t, /^\s*(\d+) failing\s*$/gm),
  cargo: (t) => sum(t, /^test result: FAILED\. \d+ passed; (\d+) failed;/gm),
  go: (t) => [...t.matchAll(/^--- FAIL: /gm)].length,
};

const sum = (text: string, re: RegExp) => [...text.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);

/** How many tests a run's output says failed, read from the given runners' summaries (all of them by default), or 0. */
export function failedTests(text: string, runners: Runner[] = ['any']): number {
  const kinds = runners.includes('any') ? (Object.keys(SUMMARIES) as (keyof typeof SUMMARIES)[]) : [...new Set(runners)] as (keyof typeof SUMMARIES)[];
  return kinds.reduce((n, k) => n + SUMMARIES[k](text), 0);
}

/** What a simple command starts with when it runs tests, after env assignments and wrappers like `timeout 300`. */
const RUNNERS: [RegExp, Runner][] = [
  [/^(?:\S*\/)?(?:citadel-)?node\b[^|]*\s--test\b/, 'node'],
  [/^dotnet\s+test\b/, 'dotnet'],
  [/^(?:(?:python3?|py)\s+-m\s+|(?:uv|poetry|pipenv)\s+run\s+)?(?:pytest|py\.test)\b/, 'pytest'],
  [/^(?:(?:npx|pnpm\s+exec|yarn|bunx)\s+)?(?:\S*\/)?(?:jest|vitest)\b/, 'jest'],
  [/^(?:(?:npx|pnpm\s+exec|yarn|bunx)\s+)?(?:\S*\/)?mocha\b/, 'mocha'],
  [/^cargo\s+(?:test|nextest)\b/, 'cargo'],
  [/^go\s+test\b/, 'go'],
  [/^(?:npm|pnpm|yarn|bun)(?:\s+--?[\w-]+(?:[= ](?!test\b|t\b|run\b)[^\s-]\S*)?)*\s+(?:t|test|(?:run(?:-script)?\s+)?(?:test|check)[\w:-]*)(?:\s|$)/, 'any'],
  [/^make\s+(?:test|check)\w*\b/, 'any'],
  // A check script: its name says test or check (tools/check.sh, run-tests.py), or Citadel's land.sh, which runs npm test.
  [/^(?:(?:bash|sh|node|python3?)\s+)?(?:\S*\/)?(?:(?:[\w.-]*[-_.])?(?:test|check)s?(?:[-_.][\w.-]*)?|land)\.(?:sh|ts|js|mjs|py)\b/i, 'any'],
];

/** Wrappers and keywords a simple command can start with before the program it runs. */
const PREFIX = /^(?:(?:\w+=(?:'[^']*'|"[^"]*"|\S*)|if|elif|while|until|then|do|else|time|exec|env|nice|command|!|timeout(?:\s+-[ks](?:\s+|=)\S+|\s+-\S+)*\s+\S+)\s+)*/;

/**
 * A copy of a shell command with quoted text, comments and heredoc bodies blanked out (same length, so
 * positions still match), so a runner's name inside a string or an edit script never reads as a run.
 */
export function mask(command: string): string {
  const out = command.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out[k] = '_';
  };
  const pending: { word: string; tabs: boolean }[] = [];
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === '\\') {
      i += 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== c) j += c === '"' && command[j] === '\\' ? 2 : 1;
      blank(i + 1, Math.min(j, command.length));
      i = j + 1;
    } else if (c === '#' && (i === 0 || /[\s;&|(]/.test(command[i - 1]))) {
      const end = command.indexOf('\n', i);
      const stop = end < 0 ? command.length : end;
      blank(i, stop);
      i = stop;
    } else if (command.startsWith('<<<', i)) {
      i += 3;
    } else if (command.startsWith('<<', i)) {
      const m = command.slice(i).match(/^<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/);
      if (m) pending.push({ word: m[3], tabs: m[1] === '-' });
      i += m ? m[0].length : 2;
    } else if (c === '\n' && pending.length) {
      // The heredoc bodies start on the next line, one after another, each ending at its delimiter alone on a line.
      let at = i + 1;
      for (const { word, tabs } of pending.splice(0)) {
        const end = new RegExp(`^${tabs ? '\\t*' : ''}${word}[ \\t]*$`, 'gm');
        end.lastIndex = at;
        const close = end.exec(command);
        at = close ? close.index + close[0].length : command.length;
      }
      blank(i + 1, at);
      i = at;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** The simple commands in a shell command that run tests, as written, with the runner each is. */
export function testRuns(command: string): [string, Runner][] {
  const masked = mask(command);
  const runs: [string, Runner][] = [];
  // Command separators; the "&" of a redirection (2>&1, &>log) is not one.
  const sep = /&&|\|\||(?<![<>&])&(?![>&])|[;|\n()`{}]|\$\(/g;
  let from = 0;
  for (const m of [...masked.matchAll(sep), { index: masked.length, 0: '' } as unknown as RegExpMatchArray]) {
    // shortcut: a simple command is read from its first 500 characters, enough for any runner and its wrappers.
    const body = masked.slice(from, m.index).trim().slice(0, 500);
    const prefix = body.match(PREFIX)?.[0].length ?? 0;
    const runner = RUNNERS.find(([re]) => re.test(body.slice(prefix)))?.[1];
    if (runner) runs.push([command.slice(from, m.index).trim(), runner]);
    from = m.index! + m[0].length;
  }
  return runs;
}

/** True when a command touches a retro log folder: its output holds old "N failed" lines, never a run's. */
const readsRetroLog = (command: string) => /retro-log(?:\/|['"\s;|&)]|$)/.test(command);

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
  const runs = readsRetroLog(command) ? [] : testRuns(command);
  const failed = runs.length ? failedTests(out, runs.map(([, r]) => r)) : 0;
  if (failed > 0) lines.push(['red test', `${failed} failed: ${runs.map(([c]) => c).join('; ').slice(0, 160)}`]);
  // A push in quoted text isn't one, and a red test before it means the chain stopped there.
  if (input.hook_event_name === 'PostToolUseFailure' && !failed && /\bgit(?:\s+-C\s+\S+|\s+-\S+)*\s+push\b/.test(mask(command))) {
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
