/**
 * The citadel-heavy nudge (PreToolUse on Bash, every Citadel turn that loads the kit, Grunts included; the first heavy call in a turn runs bare, since it advises and never blocks): when a command is a heavy build, adds the line on
 * `citadel-heavy` that used to sit in every minion prompt (#1577; the tokens lens T3, #1277, Cara 2026-11-22: "Moving").
 * Covered: a whole-workspace cargo build, test, check or clippy (--workspace or --all), any cargo build, test, check
 * or clippy with --release or --target, and a full `npm test` (no file arguments). Silent for single-crate checks, dev
 * servers, watchers, tools/land.sh, citadel-test and anything already wrapped in citadel-heavy. Never blocks (the line
 * itself says to leave quick checks out); a command it can't read says nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HookInput } from './hook-input.ts';

export const HEAVY_NUDGE =
  "[citadel heavy] Long CPU work (a whole-workspace `cargo build`, `test`, `check` or `clippy`, a cross-target or release build, a full `npm test`) goes through `citadel-heavy <command...>`, as in `citadel-heavy cargo test --workspace`. It judges each job by its past runs: minutes of busy CPU take a heavy slot (the scheme's CI runners when the repo has a citadel-heavy workflow, else perigee's one small slot) and may queue; shorter or idle jobs, Claude-bound ones and unseen ones run here at once, so add `--heavy` to a first run you expect to be long. A heavy job may run elsewhere: its build outputs stay there and the variables you set in your shell do not go along (put them in the command: `citadel-heavy env FOO=1 cargo test`), so use `citadel-heavy --here` for a build whose files you need here (an APK to install, a binary to run) or a job that reads data only perigee has. For one past about two minutes use `citadel-job <command...>`, which goes through citadel-heavy by itself: it outlives your turn and you are woken with how it went. Otherwise give it a long timeout. For CI jobs of an hour or more, `citadel-heavy --long <command...>` runs it at night and wakes you with the result: end your turn (state outside). Leave quick single-crate checks, evals, dev servers and watchers out, and don't wrap a script that takes its own lock (tools/land.sh) in it.";

/** Words of each segment of a command (split at ; & | and newlines, quotes kept simple). */
function segments(command: string): string[][] {
  return command
    .replace(/\d*>&\d*|&>>?|\d*>>?\s*\S+|<\s*\S+/g, ' ')
    .replace(/\b(?:sh|bash|zsh|fish)\s+-c\s+/g, ' ')
    .replace(/[()'"]/g, ' ')
    .split(/\|\||&&|[;&|\n]/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((w) => w.length);
}

/** A segment's words past leading VAR=val, env, time, nice and timeout N. */
function strip(words: string[]): string[] {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w === 'env' || w === 'time' || w === 'command') i++;
    else if (w === 'nice' || w === 'timeout') {
      i++;
      while (words[i] !== undefined && (words[i].startsWith('-') || /^\d+[smhd]?$/.test(words[i]))) i++;
    } else break;
  }
  return words.slice(i);
}

const CARGO_SUBS = new Set(['build', 'b', 'test', 't', 'check', 'c', 'clippy']);

/** Whether one segment is a covered heavy build. */
function heavy(words: string[]): boolean {
  const w = strip(words);
  if (w[0] === 'cargo') {
    const rest = w.slice(1);
    const dd = rest.indexOf('--');
    if (dd >= 0) rest.length = dd;
    if (rest[0]?.startsWith('+')) rest.shift();
    if (!rest[0] || !CARGO_SUBS.has(rest[0])) return false;
    return rest.some((a) => /^(--workspace|--all|--release|-r|--target(=.*)?)$/.test(a));
  }
  if (w[0] === 'npm' || w[0] === 'pnpm' || w[0] === 'yarn') {
    const rest = w.slice(1);
    const test = (rest[0] === 'run' || rest[0] === 'run-script' ? rest[1] : rest[0]) === 'test' || rest[0] === 't' || rest[0] === 'tst';
    const extra = rest.slice(rest[0] === 'run' || rest[0] === 'run-script' ? 2 : 1);
    return test && extra.every((a) => a.startsWith('-'));
  }
  return false;
}

/** One hook call; returns what to print (a context line), or null. */
export function heavyNudgeHook(input: HookInput): string | null {
  if (input?.tool_name !== 'Bash') return null;
  const command = String(input?.tool_input?.command ?? '');
  if (!command || /^\s*(?:\S+=\S*\s+)*(?:env\s+)?citadel-heavy\b/.test(command)) return null;
  if (!segments(command).some(heavy)) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: HEAVY_NUDGE } });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const out = heavyNudgeHook(JSON.parse(readFileSync(0, 'utf8')));
    if (out) process.stdout.write(out);
  } catch {
    // A call it can't read says nothing.
  }
}
