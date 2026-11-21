// Judges (#1503): anything that alarms, refuses, flags, kills or wakes on real inputs. From Nov 7 to 21 about 2.2 fixes a
// day went to a judge that misjudged real inputs (the post-deploy watch four times, the flake counter four), each one
// found by the people it woke. So each judge is named here with the code that decides, pinned by symbol rather than by
// whole file, and its replay (tools/judge-replay.ts runs it over recent real history, with no model).
// test/judges.test.ts goes red when a pinned symbol changed since the judge's last recorded replay
// (test/judge-replays.json), and when a new caller appears at the places judges act with no entry here.
// A judge can run log-only: it notes what it would have done in the retro log and does nothing. A new one starts that way.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type JudgeMode = 'act' | 'log-only';

export interface Judge {
  id: string;
  name: string;
  /** What it does to people when it fires. */
  acts: string;
  /** Where its decision lives: each file with the symbols pinned (`name` for a top-level declaration, `Class.method` for a method). */
  pins: { path: string; symbols: string[] }[];
  /** True: tools/judge-replays/<id>.ts replays it. Otherwise why it has none yet; its pins still show what to replay later. */
  replay: true | { notYet: string };
  /** 'log-only' notes what it would have done and does nothing (judged() below); a new judge starts that way. */
  mode: JudgeMode;
  /** The places the new-caller test finds that belong to this judge: repo paths, or `standing-check:<name>`. */
  callers?: string[];
}

export const JUDGES: Judge[] = [
  {
    id: 'deploy-watch', name: 'Post-deploy watch (#724)', mode: 'act', replay: true,
    acts: 'wakes the minions whose commits went live, and mails the Taskmaster, when a health signal got worse after a deploy',
    pins: [
      { path: 'src/deploy-watch.ts', symbols: ['CHECKS', 'MIN_WINDOW', 'BOOT_QUIET_MS', 'SIGNALS', 'TURN_FLOOR', 'worse', 'countsAsServerFault', 'HARMLESS_CLIENT_ERRORS', 'DeployWatch.live', 'DeployWatch.tick', 'DeployWatch.readings', 'DeployWatch.compare', 'DeployWatch.suspects'] },
      { path: 'src/db.ts', symbols: ['Store.healthCount', 'Store.turnOutcomes', 'Store.shippedSince'] },
    ],
    callers: ['src/deploy-watch.ts'],
  },
  {
    id: 'flake-counter', name: 'Flake counter and same-flake alarm (#1120, #1245)', mode: 'act', replay: true,
    acts: 'wakes the Taskmaster on the same flake on 3 branches in 30 minutes, and starts a fix minion on a third sighting in 7 days',
    pins: [
      { path: 'src/flakes.ts', symbols: ['ALARM_BRANCHES', 'ALARM_WINDOW_MS', 'ALARM_QUIET_MS', 'sameFlake', 'FLAKE_WINDOW_MS', 'FLAKE_REPEAT', 'FLAKE_REPEAT_MS', 'parseRetroFlakes'] },
      { path: 'src/flake-fixes.ts', symbols: ['MAX_STARTS_PER_PASS', 'SAME_SIGHTING_MS', 'FlakeFixes.ingest', 'FlakeFixes.alarm', 'FlakeFixes.escalate'] },
    ],
    callers: ['src/flake-fixes.ts'],
  },
  {
    id: 'ci-red', name: 'CI health: a red on main (#774, #968, #983)', mode: 'act', replay: true,
    acts: "wakes the scheme's Taskmaster when a watched workflow goes red on main, and rings an hour later if no fix minion names the run (log-only covers the Taskmaster's wake and mail: the Mandate alert is shared with the other CI judges)",
    pins: [
      { path: 'src/ci-problems.ts', symbols: ['RED_FIX_MS', 'VERDICTS', 'workflowFile', 'HEAVY_WORKFLOW', 'quietWorkflow', 'redProblem', 'redProblemOf'] },
      { path: 'src/ci-health.ts', symbols: ['ACTIVE_MS', 'CiHealth.outsideRuns'] },
    ],
  },
  {
    id: 'ci-runners', name: 'CI health: stuck, hung and dead jobs (#368)', mode: 'act',
    replay: { notYet: 'needs runner-online history, which nothing keeps; GitHub keeps jobs, not when a runner was offline' },
    acts: "makes a Mandate alert for every admin and wakes the scheme's Taskmaster",
    pins: [{ path: 'src/ci-problems.ts', symbols: ['WAIT_MS', 'HUNG_MS', 'stuckProblems', 'hungProblems', 'neverStarted', 'deadGroups', 'deadProblem'] }],
  },
  {
    id: 'ci-land-gate', name: 'CI health: the land gate (#1342)', mode: 'act',
    replay: { notYet: 'the land line it reads is live only; no history of it is stored' },
    acts: 'rings when lands keep failing or crawl',
    pins: [{ path: 'src/ci-land-gate.ts', symbols: ['LAND_STREAK', 'LAND_SLOW_MS', 'landStep', 'landProblems'] }],
  },
  {
    id: 'land-verdicts', name: "land.sh's blame rules", mode: 'act',
    replay: { notYet: "#1484 builds their bench and the would-refuse shadow switch; land.sh is the pipeline lane's" },
    acts: 'refuses a ship, or blames it for a red', pins: [],
  },
  {
    id: 'tripwire', name: 'The tripwire', mode: 'act',
    replay: { notYet: 'register its replay after #1169, which is changing src/tripwire.ts, ships' },
    acts: 'blocks a tool call', pins: [],
  },
  {
    id: 'standing-checks', name: 'Standing checks (#1270)', mode: 'act',
    replay: { notYet: 'each check reads live state (turn folders, the runner queue) that only a snapshot could replay' },
    acts: 'records a standing-check health reading, which the Status page shows',
    pins: [{ path: 'src/standing-checks.ts', symbols: ['CHECKS'] }],
    callers: ['turn-record', 'one-place', 'fired-once', 'handoff-process', 'shipped-live', 'app-turn-ended', 'closed-processes', 'db-integrity'].map((c) => `standing-check:${c}`),
  },
  {
    id: 'stall-signals', name: 'Stall signals (#1139)', mode: 'act',
    replay: { notYet: 'a replay would read turn transcripts; their tool calls are kept, so this is next after the three' },
    acts: "messages the minion's Taskmaster with a model step-up",
    pins: [{ path: 'src/stall-signals.ts', symbols: ['RED_TIMES', 'CHURN_ROUNDS', 'SHIP_FAILS', 'failingTests'] }],
    callers: ['src/stall-signals.ts'],
  },
  {
    id: 'repeat-bugs', name: 'Third-fix flag (B4)', mode: 'act',
    replay: { notYet: 'its own replay report (reports/third-fix-replay) was run by hand; fold it in here' },
    acts: 'starts a bug minion with a diagnose-first block, one model tier up',
    pins: [{ path: 'src/repeat-bugs.ts', symbols: ['REPEAT_WINDOW_MS', 'REPEAT_FLAG_AT'] }],
    callers: ['src/repeat-bugs.ts'],
  },
  {
    id: 'decision-copies', name: 'Stale decision copies (#1064)', mode: 'act',
    replay: { notYet: 'reads the decision sources live' },
    acts: "leaves the scheme's Taskmaster held mail when a new reversal leaves copies behind",
    pins: [{ path: 'src/decisions-load.ts', symbols: ['tellStale'] }],
    callers: ['src/decisions-load.ts'],
  },
  {
    id: 'turn-placement', name: 'Turn placement refusal', mode: 'act',
    replay: { notYet: 'placement reads live machine load' },
    acts: "refuses to start a turn when no machine can take it, and notes why in the minion's chat",
    pins: [{ path: 'src/runner.ts', symbols: ['Runner.refused'] }],
    callers: ['src/runner.ts'],
  },
  {
    id: 'reaper', name: 'The reaper (#1365)', mode: 'act',
    replay: { notYet: 'needs a process snapshot' },
    acts: 'kills the processes a closed minion left running',
    pins: [{ path: 'src/reaper.ts', symbols: ['guardedCgroup', 'ownerOf', 'guardedPids'] }],
    callers: ['src/reaper.ts'],
  },
  {
    id: 'link-check', name: 'Link check (Stop hook)', mode: 'act',
    replay: { notYet: 'replays over kept transcripts; next after the three' },
    acts: 'sends a reply back before people see it: broken links, hand-rolled pages, a choice with no card',
    pins: [{ path: 'src/link-check.ts', symbols: ['brokenLinks', 'handRolledPages', 'cardlessChoices', 'proseChoice'] }],
    callers: ['src/link-check.ts'],
  },
  {
    id: 'job-check', name: 'Job check and answer check (Stop hooks)', mode: 'act',
    replay: { notYet: 'replays over kept transcripts' },
    acts: "refuses to end a turn while the session's own jobs run, or when the answer misses a rule",
    pins: [{ path: 'kit/hooks/job-check.ts', symbols: ['MAX_STOP_BLOCKS', 'jobCheck'] }, { path: 'kit/hooks/answer-check.ts', symbols: ['MIN_TOOL_CALLS', 'MIN_ANSWER_CHARS', 'proposalLine'] }],
    callers: ['kit/hooks/job-check.ts', 'kit/hooks/answer-check.ts'],
  },
  {
    id: 'flail-brake', name: 'Flail brake and batch nudge (PostToolUse)', mode: 'act',
    replay: { notYet: 'replays over kept transcripts' },
    acts: 'adds a line to the session after the same red three times, or three lookups in a row',
    pins: [{ path: 'kit/hooks/flail-brake.ts', symbols: ['FLAIL_AT', 'flailBrakeHook'] }, { path: 'kit/hooks/batch-nudge.ts', symbols: ['BATCH_AT', 'readOnlyBash'] }],
    callers: ['kit/hooks/flail-brake.ts', 'kit/hooks/batch-nudge.ts'],
  },
  {
    id: 'grunt-model', name: 'Grunt-model guard (PreToolUse)', mode: 'act',
    replay: { notYet: 'replays over kept transcripts' },
    acts: 'sends back an Agent call that leaves its model out',
    pins: [{ path: 'kit/hooks/grunt-model.ts', symbols: ['gruntModelHook'] }],
    callers: ['kit/hooks/grunt-model.ts'],
  },
  {
    id: 'test-first', name: 'Test-first reminder (PostToolUse)', mode: 'act',
    replay: { notYet: 'replays over kept transcripts' },
    acts: 'adds a reminder line the first time a session edits a source file',
    pins: [{ path: 'kit/hooks/test-first.ts', symbols: ['isSourceFile', 'testFirstHook'] }],
    callers: ['kit/hooks/test-first.ts'],
  },
  {
    id: 'big-read', name: 'Big-read guard (PreToolUse)', mode: 'act',
    replay: { notYet: 'replays over kept transcripts' },
    acts: 'sends back a whole read of a big file',
    pins: [{ path: 'kit/hooks/big-read.ts', symbols: ['bigReadHook'] }],
    callers: ['kit/hooks/big-read.ts'],
  },
];

export const judge = (id: string): Judge | undefined => JUDGES.find((j) => j.id === id);

/** The lines of `symbol`'s declaration in `source`: a top-level `name`, or `Class.method` at the class body's indent; null if not found. */
export function symbolLines(source: string, symbol: string): string[] | null {
  const lines = source.split('\n');
  const lead = (l: string) => l.length - l.trimStart().length;
  const decl = (name: string, indent: number, from: number, to: number) => {
    const re = indent === 0
      ? new RegExp(`^(?:export )?(?:default )?(?:declare )?(?:async )?(?:function\\*? |const |let |var |class |interface |type |enum )${name}\\b`)
      : new RegExp(`^ {${indent}}(?:(?:private|protected|public|static|async|readonly|get|set|override) )*#?${name}\\s*[(<=:]`);
    for (let i = from; i < to; i++) if (re.test(lines[i])) return i;
    return -1;
  };
  // From the declaration through its body: the lines indented deeper, and the closer at its own indent.
  const region = (i: number) => {
    const indent = lead(lines[i]);
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      if (lead(l) > indent) { end = j; continue; }
      if (lead(l) === indent && /^[}\])]/.test(l.trim())) end = j;
      break;
    }
    return [i, end] as const;
  };
  const [cls, method] = symbol.includes('.') ? symbol.split('.') : [null, symbol];
  if (!cls) {
    const i = decl(method, 0, 0, lines.length);
    if (i < 0) return null;
    const [a, b] = region(i);
    return lines.slice(a, b + 1);
  }
  const c = decl(cls, 0, 0, lines.length);
  if (c < 0) return null;
  const [, cEnd] = region(c);
  const i = decl(method, 2, c + 1, cEnd);
  if (i < 0) return null;
  const [a, b] = region(i);
  return lines.slice(a, b + 1);
}

/** A symbol's hash: its lines with comment-only lines and blank lines dropped and each line trimmed, so a comment or an indent change asks for no replay. */
export function symbolHash(source: string, symbol: string): string | null {
  const lines = symbolLines(source, symbol);
  if (!lines) return null;
  const code = lines.map((l) => l.trim()).filter((l) => l && !/^(\/\/|\/\*|\*)/.test(l)).join('\n');
  return createHash('sha256').update(code).digest('hex').slice(0, 16);
}

/** Every pinned symbol's hash, `path#symbol` → hash, or null for one that wasn't found; `root` is the repo. */
export function pinHashes(j: Judge, root: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const p of j.pins) {
    let source = '';
    try { source = readFileSync(join(root, p.path), 'utf8'); } catch { /* a missing file pins nothing: every symbol null */ }
    for (const s of p.symbols) out[`${p.path}#${s}`] = source ? symbolHash(source, s) : null;
  }
  return out;
}

/** One hash for the judge's whole decision: what a recorded replay is pinned to. */
export function judgeHash(j: Judge, root: string): string {
  const h = pinHashes(j, root);
  return createHash('sha256').update(Object.keys(h).sort().map((k) => `${k}=${h[k]}`).join('\n')).digest('hex').slice(0, 16);
}

/** A recorded replay (test/judge-replays.json): the judge's hash then, the window it read and what it found. */
export interface ReplayRecord {
  hash: string;
  at: string;
  days: number;
  inputs: string;
  hits: number;
  real: number;
  summary: string;
}

/** The retro-log line a log-only judge writes instead of acting, the shape of #1484's "would refuse" line. */
export const wouldLine = (id: string, act: string, text: string, now = Date.now()) =>
  `- ${new Date(now).toISOString().slice(11, 19)}Z · would · ${id} · ${act} · ${text.replace(/\s+/g, ' ').slice(0, 300)}`;

/** Appends a would-line to `<shared>/retro-log/<day>/judges.md`; never throws (it stands in for an act on an alert path). */
export function noteWould(sharedDir: string | null, line: string, now = Date.now()) {
  console.log(`[judge] ${line.slice(2)}`);
  if (!sharedDir) return;
  try {
    const dir = join(sharedDir, 'retro-log', new Date(now).toISOString().slice(0, 10));
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'judges.md'), `${line}\n`);
  } catch (err: any) {
    console.error(`Noting a log-only judge's act failed: ${err?.message ?? err}`);
  }
}

/**
 * `fn`, the act of judge `id`, unless the judge runs log-only: then a would-line goes to the retro log (`note`, given the act's arguments to find its scheme), and
 * `pretend` stands in for its result, so the judge carries on as if it had acted (and doesn't repeat itself every tick).
 */
export function judged<A extends unknown[], R>(id: string, act: string, fn: (...a: A) => R, pretend: (...a: A) => R, note: (line: string, ...a: A) => void, mode = judge(id)?.mode): (...a: A) => R {
  if (!judge(id)) throw new Error(`judged(): no judge ${id} in src/judges.ts`);
  if (mode !== 'log-only') return fn;
  return (...a: A) => {
    note(wouldLine(id, act, a.map((x) => (typeof x === 'string' ? x : typeof x === 'object' && x && 'name' in x ? String((x as { name: unknown }).name) : String(x))).join(' · ')), ...a);
    return pretend(...a);
  };
}
