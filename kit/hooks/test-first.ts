/**
 * The test-first reminder (PostToolUse, never blocks): the first time a session edits a source file (not a test,
 * doc, config or UI file) with no red test run yet in that session, it adds one line to Claude's context saying to
 * write the failing test first (Cara, 2026-11-16, "Reminder hook"). Once per session; a red run (a test command,
 * as retro-log.ts reads them, that exits non-zero or reports a failure count) stops it for good. State: one file
 * per session in the turn's temp folder, like job-check.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failedTests, mask, testRuns } from './retro-log.ts';

export const REMINDER =
  '[citadel test-first] Logic or bug work: write the failing test first and see it red (citadel:test-quality, citadel:bug-fixing); refactors, config and UI skip this. Self-review later runs new tests against the base and flags any that pass there.';

const CODE = /\.(?:[cm]?[jt]s|rs|py|cs|go|java|kt|gd|c|cc|cpp|h|hpp|swift|rb|sh|ps1|lua|php|scala|zig)$/;
const TEST = /(?:^|\/)(?:test|tests|__tests__|spec|testdata|fixtures)\/|(?:\.(?:test|spec)|[-_]test)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$|Tests?\.cs$|(?:^|\/)tests?\.rs$/;
// Docs, config and UI: by folder, or by a name that says config.
const NOT_LOGIC = /(?:^|\/)(?:docs?|public|web|static|assets|styles|ui|components|pages|\.claude|\.github|\.githooks|kit\/skills)\/|(?:^|\/)\.[^/]+$|\.config\.[cm]?[jt]s$|(?:^|\/)(?:vite|vitest|eslint|prettier|tailwind|postcss|webpack|rollup|jest|playwright)[^/]*$/;

/** Whether an edit to this path (relative to the worktree) is to logic a test should drive. */
export function isSourceFile(path: string): boolean {
  return CODE.test(path) && !TEST.test(path) && !NOT_LOGIC.test(path);
}

/** Whether a finished Bash call ran tests that went red: a failure count in the output, or a failed exit. */
export function redRun(input: any): boolean {
  const command = String(input?.tool_input?.command ?? '');
  const runs = testRuns(command).length > 0 || /(?:^|[\s;&|(])(?:\S*\/)?citadel-test\b/.test(mask(command));
  if (!runs || input?.tool_input?.run_in_background) return false;
  if (input.hook_event_name === 'PostToolUseFailure') return true;
  const r = input.tool_response;
  const out = typeof r === 'string' ? r : `${r?.stdout ?? ''}\n${r?.stderr ?? ''}`;
  return failedTests(out) > 0 || /✖ \d+ passed, [1-9]\d* failed/.test(out);
}

/** One hook call; returns what to print (the reminder as context), or null. */
export function testFirstHook(input: any, stateDir = join(tmpdir(), 'citadel-kit')): string | null {
  const file = join(stateDir, `test-first-${String(input?.session_id ?? 'unknown').replace(/[^\w.-]/g, '_')}`);
  if (existsSync(file)) return null; // reminded already, or a red run came first
  const done = (why: string) => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(file, why);
  };
  if (input?.tool_name === 'Bash') {
    if (redRun(input)) done('red run');
    return null;
  }
  if (input?.hook_event_name !== 'PostToolUse') return null;
  const target = String(input?.tool_input?.file_path ?? input?.tool_input?.notebook_path ?? '');
  const cwd = String(input?.cwd ?? '');
  if (!target || !cwd) return null;
  const rel = isAbsolute(target) ? relative(cwd, target) : target;
  // Only the worktree's own files: scratch, memory and shared-folder notes aren't code under test.
  if (rel.startsWith('..') || isAbsolute(rel) || !isSourceFile(rel)) return null;
  done('reminded');
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: REMINDER } });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Fails open: a reminder that can't run says nothing.
  try {
    const out = testFirstHook(JSON.parse(readFileSync(0, 'utf8')));
    if (out) process.stdout.write(out);
  } catch {
    // See above.
  }
}
