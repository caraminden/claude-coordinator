/**
 * The flail brake (PostToolUse and PostToolUseFailure, never blocks): when the same test command goes red three
 * times in a row with no file edited in between, adds one line to Claude's context pointing at
 * citadel:diagnosing-bugs (Josh, 2026-11-19, "Repeat-failure nudge"; from Peek Auras #637, idea Z4). Once per
 * streak. An edit (Edit, Write, MultiEdit, NotebookEdit: the hook sees them, as test-first.ts does), a green test run
 * or a different test command resets (other Bash calls, like a grep of the output, do not) the count. A file changed by a Bash command (sed -i, git checkout) is
 * invisible here, so such a run counts as unedited. State: one file per session in the turn's temp folder.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mask, testRuns } from './retro-log.ts';
import { redRun } from './test-first.ts';
import { batchNudgeLine } from './batch-nudge.ts';
import type { HookInput } from './hook-input.ts';

/** Reds in a row that earn the line: a starting value. */
export const FLAIL_AT = 3;

export const FLAIL_LINE = `[citadel flail brake] The same test command has gone red ${FLAIL_AT} times with no file edited in between. Stop re-running it: open citadel:diagnosing-bugs, read the failure and change something before you run it again.`;

type State = { command: string; count: number; said: boolean };

/** One hook call; returns what to print (the line as context), or null. */
export function flailBrakeHook(input: HookInput, stateDir = join(tmpdir(), 'citadel-kit')): string | null {
  const file = join(stateDir, `flail-${String(input?.session_id ?? 'unknown').replace(/[^\w.-]/g, '_')}.json`);
  const write = (s: State | null) => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(file, JSON.stringify(s));
  };
  if (input?.tool_name !== 'Bash') {
    // Any edit starts the count over; other tools say nothing about it.
    if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(String(input?.tool_name))) write(null);
    return null;
  }
  const raw = String(input?.tool_input?.command ?? '');
  if (input?.tool_input?.run_in_background) return null;
  if (!redRun(input)) {
    // Only a green test run ends a streak: reading the output (grep, git status) between reds is the flail itself.
    if (testRuns(raw).length || /(?:^|[\s;&|(])(?:\S*\/)?citadel-test\b/.test(mask(raw))) write(null);
    return null;
  }
  // redRun knows what a test command is (citadel-test too); the runs only name it.
  const runs = testRuns(raw);
  const command = (runs.length ? runs.map(([c]) => c) : [raw]).join('; ').replace(/\s+/g, ' ');
  let state: State | null = null;
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // No streak yet.
  }
  const next: State = state && state.command === command ? { ...state, count: state.count + 1 } : { command, count: 1, said: false };
  const say = next.count >= FLAIL_AT && !next.said;
  if (say) next.said = true;
  write(next);
  return say ? JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: FLAIL_LINE } }) : null;
}

/** What the hook prints for one call: the brake's line, the batch trial's (batch-nudge.ts) or both, or null. */
export function flailBrakeOutput(input: HookInput): string | null {
  const out = flailBrakeHook(input);
  // The batch-lookups trial (batch-nudge.ts) rides this hook: it already runs after Bash and edits.
  let line: string | null = null;
  try {
    line = batchNudgeLine(input);
  } catch {
    // A broken trial never costs the brake its line.
  }
  if (line && out) {
    const o = JSON.parse(out);
    o.hookSpecificOutput.additionalContext += `\n${line}`;
    return JSON.stringify(o);
  }
  if (line) return JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: line } });
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Fails open: a nudge that can't run says nothing.
  try {
    const out = flailBrakeOutput(JSON.parse(readFileSync(0, 'utf8')));
    if (out) process.stdout.write(out);
  } catch {
    // See above.
  }
}
