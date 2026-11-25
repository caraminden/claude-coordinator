/**
 * The kit's after-call hooks in one node process (#1296): after a Bash call, retro-log.ts, test-first.ts and
 * flail-brake.ts (with the batch trial, batch-nudge.ts) used to start a node each. Here they run in that order, each
 * only on the calls its old hooks.json entry took, and each fails open on its own, as alone: each loads with its own
 * dynamic import, so one that can't load or throws leaves the others running. Their context lines merge into one
 * answer, joined by newlines. Never blocks. After an edit any-nudge.ts (#1789) runs between test-first and flail-brake. After
 * a Bash or Read call seen.ts (#1920) runs last, and may hand back the output with its repeats left out.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Hook = (input: any) => string | null | void;
const retroHook = async (): Promise<Hook> => (await import('./retro-log.ts')).retroHook;
const testFirstHook = async (): Promise<Hook> => (await import('./test-first.ts')).testFirstHook;
const anyNudgeHook = async (): Promise<Hook> => (await import('./any-nudge.ts')).anyNudgeHook;
const seenHook = async (): Promise<Hook> => (await import('./seen.ts')).seenHook;
const flailBrakeOutput = async (): Promise<Hook> => (await import('./flail-brake.ts')).flailBrakeOutput;

const BASH = new Set(['Bash']);
const READS = new Set(['Read', 'Grep', 'Glob']);
const EDITS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** The hooks a call runs, in order: Bash after it ran or failed; reads and edits only after they ran. */
function hooksFor(input: any): (() => Promise<Hook>)[] {
  const tool = input?.tool_name;
  if (BASH.has(tool)) return [retroHook, testFirstHook, flailBrakeOutput, seenHook];
  if (input?.hook_event_name !== 'PostToolUse') return [];
  if (READS.has(tool)) return tool === 'Read' ? [flailBrakeOutput, seenHook] : [flailBrakeOutput];
  if (EDITS.has(tool)) return [testFirstHook, anyNudgeHook, flailBrakeOutput];
  return [];
}

/** One answer from the hooks' answers: one is printed as it is, several merge their context lines and keep the output one of them rewrote. */
export function mergeContext(outs: string[], event: string): string | null {
  if (outs.length <= 1) return outs[0] ?? null;
  const all = outs.map((o) => JSON.parse(o)?.hookSpecificOutput ?? {});
  const lines = all.map((o) => o.additionalContext).filter((l): l is string => !!l);
  const updated = all.find((o) => o.updatedToolOutput !== undefined)?.updatedToolOutput;
  if (!lines.length && updated === undefined) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...(lines.length && { additionalContext: lines.join('\n') }), ...(updated !== undefined && { updatedToolOutput: updated }) } });
}

/** What the runner prints for one call, or null. */
export async function postToolRun(input: any): Promise<string | null> {
  const outs: string[] = [];
  for (const load of hooksFor(input)) {
    try {
      const out = (await load())(input);
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
    const out = await postToolRun(JSON.parse(readFileSync(0, 'utf8')));
    if (out) process.stdout.write(out);
  } catch {
    // An unreadable call says nothing.
  }
}
