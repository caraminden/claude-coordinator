/**
 * What the PreToolUse hooks that send a call back once (wording.ts, scheme-refs.ts) share. They run pinned inside
 * a minion's turn (runner.ts pinnedCopy follows the ./ imports), so this imports only node built-ins.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Every string in a tool call's input, nested ones too. */
export function toolStrings(input: any): string[] {
  const strings: string[] = [];
  const walk = (v: any) => (typeof v === 'string' ? strings.push(v) : v && typeof v === 'object' && Object.values(v).forEach(walk));
  walk(input);
  return strings;
}

/** The keys already sent back this turn; none when the file isn't there yet. */
export function readSent<T>(file: string): T[] {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** Record keys as sent (the last 200 kept); false when it can't be written, so the caller lets the call through rather than loop. */
export function saveSent<T>(file: string, keys: T[]): boolean {
  try {
    writeFileSync(file, JSON.stringify(keys.slice(-200)));
    return true;
  } catch {
    return false;
  }
}

/** The PreToolUse answer that sends the call back with this reason. */
export function deny(reason: string) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

/** The main guard of a hook script: run `check` on the call from stdin and the config in argv[2], print its deny. */
export function runHook(meta: ImportMeta, check: (input: any, cfg: any) => unknown): void {
  if (process.argv[1] !== fileURLToPath(meta.url)) return;
  try {
    const verdict = check(JSON.parse(readFileSync(0, 'utf8')), JSON.parse(process.argv[2]));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch {
    // A check that can't run never holds up the call.
  }
}
