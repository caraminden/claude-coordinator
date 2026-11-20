/**
 * What the PreToolUse hooks that send a call back once (wording.ts, scheme-refs.ts) share. They run pinned inside
 * a minion's turn (turn-launch.ts pinnedCopy follows the ./ imports), so this imports only node built-ins.
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

/** What one hook check answers: its stdout, its stderr and its exit code, as its own process would (hook-run.ts runs several in one). */
export interface HookResult {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/** Run `check` on the raw stdin call and the config argument, and turn its deny into the hook's answer. */
export function hookResult(check: (input: any, cfg: any) => unknown, stdin: string, cfgArg: string): HookResult {
  try {
    const verdict = check(JSON.parse(stdin), JSON.parse(cfgArg));
    return verdict ? { stdout: JSON.stringify(verdict) } : {};
  } catch {
    // A check that can't run never holds up the call.
    return {};
  }
}

/** Print a HookResult and exit as its process would. */
export function emit(r: HookResult): void {
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.code) process.exit(r.code);
}

/** The main guard of a hook script: run `check` on the call from stdin and the config in argv[2], print its deny. */
export function runHook(meta: ImportMeta, check: (input: any, cfg: any) => unknown): void {
  if (process.argv[1] !== fileURLToPath(meta.url)) return;
  let stdin = '';
  try {
    stdin = readFileSync(0, 'utf8');
  } catch {
    // An unreadable call parses as nothing, and so passes.
  }
  emit(hookResult(check, stdin, process.argv[2]));
}
