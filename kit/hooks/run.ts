/**
 * The kit's after-call hooks in one node process (#1296): after a Bash call, retro-log.ts, test-first.ts and
 * flail-brake.ts (with the batch trial, batch-nudge.ts) used to start a node each. Here they run in that order, each
 * only on the calls its old hooks.json entry took, and each fails open on its own, as alone. Their context lines merge
 * into one answer, joined by newlines. Never blocks.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { retroHook } from './retro-log.ts';
import { testFirstHook } from './test-first.ts';
import { flailBrakeOutput } from './flail-brake.ts';

const BASH = new Set(['Bash']);
const READS = new Set(['Read', 'Grep', 'Glob']);
const EDITS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** The hooks a call runs, in order: Bash after it ran or failed; reads and edits only after they ran. */
function hooksFor(input: any): ((input: any) => string | null | void)[] {
  const tool = input?.tool_name;
  if (BASH.has(tool)) return [retroHook, testFirstHook, flailBrakeOutput];
  if (input?.hook_event_name !== 'PostToolUse') return [];
  if (READS.has(tool)) return [flailBrakeOutput];
  if (EDITS.has(tool)) return [testFirstHook, flailBrakeOutput];
  return [];
}

/** One answer from the hooks' answers: one is printed as it is, several merge their context lines. */
export function mergeContext(outs: string[], event: string): string | null {
  if (outs.length <= 1) return outs[0] ?? null;
  const lines = outs.map((o) => JSON.parse(o)?.hookSpecificOutput?.additionalContext).filter((l): l is string => !!l);
  return lines.length ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join('\n') } }) : null;
}

/** What the runner prints for one call, or null. */
export function postToolRun(input: any): string | null {
  const outs: string[] = [];
  for (const hook of hooksFor(input)) {
    try {
      const out = hook(input);
      if (out) outs.push(out);
    } catch {
      // Each fails open alone, as its own process did.
    }
  }
  try {
    return mergeContext(outs, input.hook_event_name);
  } catch {
    return outs[0] ?? null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const out = postToolRun(JSON.parse(readFileSync(0, 'utf8')));
    if (out) process.stdout.write(out);
  } catch {
    // An unreadable call says nothing.
  }
}
