/**
 * The any nudge (PostToolUse after Write, Edit and MultiEdit, never blocks; Citadel #1789): when an edit to a
 * TypeScript file leaves it with more explicit `any` types, `as unknown as` casts or `@ts-ignore`-style comments than it had before, it adds
 * one line to Claude's context saying to use real types (Cara, 2026-11-24: "make sure citadel and the rest of our
 * typescript schemes don't cheat and use 'any'"). Every scheme, with or without the type check's gate. Counts with the
 * type check's own counter (scheme-setup/templates/typecheck.ts), on the whole file before and after the edit.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { countEscapes } from '../skills/scheme-setup/templates/typecheck.ts';

const TS = /\.(?:[cm]?ts|tsx)$/;

type Edit = { old_string?: unknown; new_string?: unknown; replace_all?: unknown };

/** The file as it was before the call: the edits undone on today's text, or for a Write what it replaced. */
export function before(input: { tool_name?: unknown; tool_input?: Record<string, unknown>; tool_response?: unknown }, now: string, path: string): string | null {
  const ti = input.tool_input ?? {};
  const undo = (text: string, e: Edit) => {
    const o = String(e.old_string ?? '');
    const n = String(e.new_string ?? '');
    if (!n) return null; // a deletion can't be put back from today's text alone
    return e.replace_all ? text.split(n).join(o) : text.replace(n, () => o);
  };
  if (input.tool_name === 'Edit') return undo(now, ti as Edit);
  if (input.tool_name === 'MultiEdit' && Array.isArray(ti.edits)) {
    let text: string | null = now;
    for (const e of [...(ti.edits as Edit[])].reverse()) text = text === null ? null : undo(text, e);
    return text;
  }
  if (input.tool_name === 'Write') {
    const r = input.tool_response as { originalFile?: unknown } | undefined;
    if (typeof r?.originalFile === 'string') return r.originalFile;
    try {
      const dir = dirname(path);
      const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return execFileSync('git', ['show', `HEAD:${relative(top, path)}`], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return ''; // a new file: every escape in it is new
    }
  }
  return null;
}

export function nudgeText(file: string, added: number, now: number): string {
  return `[citadel any-check] This edit added ${added} explicit \`any\`, \`as unknown as\` or @ts-ignore-style escape${added === 1 ? '' : 's'} to ${file} (${now} now). Use real types instead: \`unknown\` and a narrowing, a named type, or a generic (Cara, 2026-11-24: "don't cheat and use 'any'"). A scheme with the type check (tools/typecheck.ts) refuses a ship that raises the count.`;
}

/** One hook call; returns what to print (the nudge as context), or null. */
export function anyNudgeHook(input: { hook_event_name?: unknown; tool_name?: unknown; tool_input?: Record<string, unknown>; tool_response?: unknown; cwd?: unknown }): string | null {
  if (input?.hook_event_name !== 'PostToolUse') return null;
  if (!['Write', 'Edit', 'MultiEdit'].includes(String(input.tool_name))) return null;
  const target = String(input.tool_input?.file_path ?? '');
  if (!TS.test(target)) return null;
  const cwd = String(input.cwd ?? '');
  const path = isAbsolute(target) ? target : join(cwd, target);
  const now = readFileSync(path, 'utf8');
  const was = before(input, now, path);
  if (was === null) return null;
  // Both sides counted the same way: when the stripper can't read one (a file broken mid-edit), the pattern reads both.
  let after = countEscapes(now, path);
  let prior = countEscapes(was, path);
  if (after.by !== prior.by) [after, prior] = [countEscapes(now, path, true), countEscapes(was, path, true)];
  const added = after.n - prior.n;
  if (added <= 0) return null;
  const shown = cwd && !relative(cwd, path).startsWith('..') ? relative(cwd, path) : path;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudgeText(shown, added, after.n) } });
}
