/**
 * Every PreToolUse check of a turn in one node process (#1296): the side question's guard, the tripwire, the wording
 * check, the scheme-refs check and the kit's big-read guard used to start a node each, up to five per tool call, and
 * under load a slow start timed the tripwire out, which blocks the call. Each check still runs on its own matcher, in
 * that order, from the same code its standalone hook runs (tripwireResult, sideGuardResult, hookResult), and fails the
 * way it did alone:
 *
 * - The tripwire and the side guard are hard: one that can't even load crashes the runner, and the hook's
 *   `onFailure: 'block'` blocks the call, as their own hooks did.
 * - Wording, scheme-refs and big-read are soft: one that can't load or throws lets the call through, as before.
 *
 * Every matching check runs, even after one blocks, since wording and scheme-refs record what they sent back.
 * Their answers merge: any exit 2 blocks with the blockers' messages; otherwise one JSON answer is written as it is, a
 * deny beats an ask, and several denies become one deny with every reason. The checks load with dynamic imports, so a
 * Read call never loads the wording check. Node built-ins only, besides the pinned files beside it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BIG_READ_MATCHER, SCHEME_REFS_MATCHER, SIDE_GUARD_MATCHER, TRIPWIRE_MATCHER, WORDING_MATCHER } from './hook-matchers.ts';
import { emit, hookResult, type HookResult } from './pre-tool-hook.ts';

/** The runner's one argument: each check's own config, as its standalone hook took it. */
export interface HookRunConfig {
  /** A side question's fork: the read-only guard runs first, on every tool. */
  side?: boolean;
  tripwire: object;
  wording: object;
  schemeRefs: object;
  /** The turn's pinned kit folder, when the turn loads the kit: its big-read guard runs here too. */
  kit?: string;
}

/** A check and the tools it reads. A hard one's `run` lets a load failure throw, so the runner dies and the hook's onFailure blocks the call; a soft one's catches it. */
interface Check {
  matcher: string;
  run: () => Promise<HookResult>;
}

/** The runner hook's matcher: every tool on a side question, else the tools any of its checks reads. */
export function hookRunMatcher(side: boolean): string {
  if (side) return SIDE_GUARD_MATCHER;
  return `^(?:${[TRIPWIRE_MATCHER, WORDING_MATCHER, SCHEME_REFS_MATCHER, BIG_READ_MATCHER].map((m) => m.replace(/^\^|\$$/g, '')).join('|')})$`;
}

function checks(stdin: string, cfg: HookRunConfig): Check[] {
  const soft = async (load: () => Promise<HookResult>): Promise<HookResult> => {
    try {
      return await load();
    } catch {
      return {};
    }
  };
  const list: Check[] = [];
  if (cfg.side) list.push({ matcher: SIDE_GUARD_MATCHER, run: async () => (await import('./side-guard.ts')).sideGuardResult(stdin) });
  list.push(
    { matcher: TRIPWIRE_MATCHER, run: async () => (await import('./tripwire.ts')).tripwireResult(stdin, JSON.stringify(cfg.tripwire)) },
    { matcher: WORDING_MATCHER, run: () => soft(async () => hookResult((await import('./wording.ts')).checkCall, stdin, JSON.stringify(cfg.wording))) },
    { matcher: SCHEME_REFS_MATCHER, run: () => soft(async () => hookResult((await import('./scheme-refs.ts')).checkCall, stdin, JSON.stringify(cfg.schemeRefs))) },
  );
  const kit = cfg.kit;
  if (kit) {
    list.push({
      matcher: BIG_READ_MATCHER,
      run: () =>
        soft(async () => {
          const { bigReadHook } = await import(pathToFileURL(join(kit, 'hooks', 'big-read.ts')).href);
          const out = bigReadHook(JSON.parse(stdin));
          return out ? { stdout: out } : {};
        }),
    });
  }
  return list;
}

/** The tool a call is for; '' when the call can't be read (only a side question's every-tool guard matches that). */
function toolName(stdin: string): string {
  try {
    return String(JSON.parse(stdin)?.tool_name ?? '');
  } catch {
    return '';
  }
}

/** One answer from several checks' answers (see the file comment). */
export function mergeResults(results: HookResult[]): HookResult {
  const stderr = results.map((r) => r.stderr ?? '').join('');
  if (results.some((r) => r.code === 2)) return { stderr, code: 2 };
  const out: HookResult = stderr ? { stderr } : {};
  const answers = results.map((r) => r.stdout).filter((s): s is string => !!s);
  if (answers.length <= 1) return answers.length ? { ...out, stdout: answers[0] } : out;
  const decision = (s: string) => {
    try {
      return JSON.parse(s)?.hookSpecificOutput?.permissionDecision;
    } catch {
      return undefined;
    }
  };
  const denies = answers.filter((s) => decision(s) === 'deny');
  if (denies.length === 1) return { ...out, stdout: denies[0] };
  if (denies.length > 1) {
    const reason = denies.map((s) => JSON.parse(s).hookSpecificOutput.permissionDecisionReason).join('\n\n');
    return { ...out, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) };
  }
  return { ...out, stdout: answers.find((s) => decision(s) === 'ask') ?? answers[0] };
}

/** The runner's answer to one raw call: every check whose matcher takes the call's tool, in order, merged. */
export async function hookRun(stdin: string, cfg: HookRunConfig): Promise<HookResult> {
  const tool = toolName(stdin);
  const results: HookResult[] = [];
  for (const c of checks(stdin, cfg)) {
    if (!new RegExp(c.matcher).test(tool)) continue;
    results.push(await c.run()); // a hard check's load failure throws out of here, on purpose
  }
  return mergeResults(results);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let stdin = '';
  try {
    stdin = readFileSync(0, 'utf8');
  } catch {
    // Read as no call: the hard checks then decide as they did on an unreadable call.
  }
  emit(await hookRun(stdin, JSON.parse(process.argv[2]) as HookRunConfig));
}
