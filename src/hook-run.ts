/**
 * Every PreToolUse check of a turn in one node process (#1296): the side question's guard, the tripwire, the wording
 * check, the scheme-refs check and the kit's big-read guard used to start a node each, up to five per tool call, and
 * under load a slow start timed the tripwire out, which blocks the call. Each check still runs on its own matcher, in
 * that order, from the same code its standalone hook runs (tripwireResult, sideGuardResult, hookResult), and fails the
 * way it did alone:
 *
 * - The tripwire and the side guard are hard: one that can't even load crashes the runner (after the other checks
 *   ran), and the hook's `onFailure: 'block'` blocks the call, as their own hooks did.
 * - Wording, scheme-refs and big-read are soft: one that can't load or throws lets the call through, as before. A
 *   soft check also passes when the runner is already past SOFT_UNTIL_S of its 10 s, so a slow start under load
 *   can't make a soft check time the call out: alone, it would have timed out and passed.
 * - The turn registers the runner twice with one matcher each (hookRunMatchers): the tools a hard check reads, with
 *   `onFailure: 'block'`, and the message and card tools only the soft checks read, without it, so those still go
 *   through when the runner times out. A call matches one of the two, so it still starts one process.
 *
 * Every matching check runs, even after one blocks, since wording and scheme-refs record what they sent back.
 * Their answers merge: any exit 2 blocks with the blockers' messages and every deny's reason after them (Claude Code
 * showed only one of the two when they were separate hooks, so a refusal wording had recorded as sent could go
 * unseen); otherwise one JSON answer is written as it is, a deny beats an ask, and several denies become one deny
 * with every reason. The checks load with dynamic imports, so a Read call never loads the wording check. Node
 * built-ins only, besides the pinned files beside it.
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

/** Seconds into the runner's life (node's start included) after which a soft check passes unrun: well inside the hook's 10 s. */
export const SOFT_UNTIL_S = 6;

const body = (m: string) => m.replace(/^\^|\$$/g, '');
const anyOf = (ms: string[]) => `^(?:${ms.map(body).join('|')})$`;

/**
 * The runner's two matchers: `hard` (registered with onFailure 'block') takes every tool on a side question, else the
 * tools the tripwire reads (big-read's and wording's file tools are among them); `soft` (no onFailure) takes the
 * message and card tools only wording and scheme-refs read, or null when the hard one takes everything.
 */
export function hookRunMatchers(side: boolean): { hard: string; soft: string | null } {
  if (side) return { hard: SIDE_GUARD_MATCHER, soft: null };
  const hard = anyOf([TRIPWIRE_MATCHER, BIG_READ_MATCHER]);
  return { hard, soft: `^(?!${body(hard)}$)${anyOf([WORDING_MATCHER, SCHEME_REFS_MATCHER]).slice(1)}` };
}

/** Every tool the runner takes, hard and soft. */
export function hookRunMatcher(side: boolean): string {
  if (side) return SIDE_GUARD_MATCHER;
  return anyOf([TRIPWIRE_MATCHER, WORDING_MATCHER, SCHEME_REFS_MATCHER, BIG_READ_MATCHER]);
}

function checks(stdin: string, cfg: HookRunConfig, softUntil: number): Check[] {
  const soft = async (load: () => Promise<HookResult>): Promise<HookResult> => {
    if (process.uptime() > softUntil) return {};
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
    // The kit's citadel-heavy nudge (kit/hooks/heavy-nudge.ts, #1577): a context line on a covered heavy build.
    list.push({
      matcher: '^Bash$',
      run: () =>
        soft(async () => {
          const { heavyNudgeHook } = await import(pathToFileURL(join(kit, 'hooks', 'heavy-nudge.ts')).href);
          const out = heavyNudgeHook(JSON.parse(stdin));
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
  const answers = results.map((r) => r.stdout).filter((s): s is string => !!s);
  const decision = (s: string) => {
    try {
      return JSON.parse(s)?.hookSpecificOutput?.permissionDecision;
    } catch {
      return undefined;
    }
  };
  const denies = answers.filter((s) => decision(s) === 'deny');
  if (results.some((r) => r.code === 2)) return { stderr: stderr + denies.map((s) => JSON.parse(s).hookSpecificOutput.permissionDecisionReason + '\n').join(''), code: 2 };
  const out: HookResult = stderr ? { stderr } : {};
  if (answers.length <= 1) return answers.length ? { ...out, stdout: answers[0] } : out;
  if (denies.length === 1) return { ...out, stdout: denies[0] };
  if (denies.length > 1) {
    const reason = denies.map((s) => JSON.parse(s).hookSpecificOutput.permissionDecisionReason).join('\n\n');
    return { ...out, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) };
  }
  return { ...out, stdout: answers.find((s) => decision(s) === 'ask') ?? answers[0] };
}

/** The runner's answer to one raw call: every check whose matcher takes the call's tool, in order, merged. A hard check that failed to load throws once the rest have run. */
export async function hookRun(stdin: string, cfg: HookRunConfig, softUntil = SOFT_UNTIL_S): Promise<HookResult> {
  const tool = toolName(stdin);
  const results: HookResult[] = [];
  const failed: unknown[] = [];
  for (const c of checks(stdin, cfg, softUntil)) {
    if (!new RegExp(c.matcher).test(tool)) continue;
    try {
      results.push(await c.run());
    } catch (e) {
      failed.push(e); // only a hard check throws: the runner dies below, and the hook's onFailure blocks the call
    }
  }
  if (failed.length) throw failed[0];
  return mergeResults(results);
}

// In a function, never awaited at the top level: a thread that loads this module would abort the process if it were terminated mid-start (test/worker-tla.test.ts).
if (process.argv[1] === fileURLToPath(import.meta.url)) void (async () => {
  let stdin = '';
  try {
    stdin = readFileSync(0, 'utf8');
  } catch {
    // Read as no call: the hard checks then decide as they did on an unreadable call.
  }
  emit(await hookRun(stdin, JSON.parse(process.argv[2]) as HookRunConfig));
})();
