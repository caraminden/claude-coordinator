// Judges (#1503): anything that alarms, refuses, flags, kills or wakes on real inputs. From Nov 7 to 21 about 2.2 fixes a
// day went to a judge that misjudged real inputs (the post-deploy watch four times, the flake counter four), each one
// found by the people it woke. So each judge is named here with the code that decides, pinned by symbol rather than by
// whole file, and its replay (tools/judge-replay.ts runs it over recent real history, with no model).
// test/judges.test.ts goes red when a pinned symbol changed since the judge's last recorded replay
// (test/judge-replays.json), and when a new caller appears at the places judges act with no entry here.
// A judge can run log-only: it notes what it would have done in the retro log and does nothing. A new one starts that way.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { thrown } from './thrown.ts';

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
    id: 'deploy-watch',
    name: 'Post-deploy watch (#724)',
    mode: 'act',
    replay: true,
    acts: 'wakes the minions whose commits went live, and mails the Taskmaster, when a health signal got worse after a deploy',
    pins: [
      { path: 'src/deploy-watch.ts', symbols: ['CHECKS', 'MIN_WINDOW', 'BOOT_QUIET_MS', 'SIGNALS', 'TURN_FLOOR', 'worse', 'countsAsServerFault', 'HARMLESS_CLIENT_ERRORS', 'DeployWatch.live', 'DeployWatch.tick', 'DeployWatch.readings', 'DeployWatch.compare', 'DeployWatch.suspects'] },
      { path: 'src/db.ts', symbols: ['Store.healthCount', 'Store.turnOutcomes', 'Store.shippedSince'] },
    ],
    callers: ['src/deploy-watch.ts'],
  },
  {
    id: 'flake-counter',
    name: 'Flake counter and same-flake alarm (#1120, #1245)',
    mode: 'act',
    replay: true,
    acts: 'wakes the Taskmaster on the same flake on 3 branches in 30 minutes, and starts a fix minion on a third sighting in 7 days',
    pins: [
      { path: 'src/flakes.ts', symbols: ['ALARM_BRANCHES', 'ALARM_WINDOW_MS', 'ALARM_QUIET_MS', 'sameFlake', 'FLAKE_WINDOW_MS', 'FLAKE_REPEAT', 'FLAKE_REPEAT_MS', 'parseRetroFlakes'] },
      { path: 'src/flake-fixes.ts', symbols: ['MAX_STARTS_PER_PASS', 'SAME_SIGHTING_MS', 'FlakeFixes.ingest', 'FlakeFixes.alarm', 'FlakeFixes.escalate'] },
    ],
    callers: ['src/flake-fixes.ts'],
  },
  {
    id: 'ci-red',
    name: 'CI health: a red on main (#774, #968, #983)',
    mode: 'act',
    replay: true,
    acts: "wakes the scheme's Taskmaster when a watched workflow goes red on main, and rings an hour later if no fix minion names the run (log-only covers the Taskmaster's wake and mail: the Mandate alert is shared with the other CI judges)",
    pins: [
      { path: 'src/ci-problems.ts', symbols: ['RED_FIX_MS', 'VERDICTS', 'workflowFile', 'HEAVY_WORKFLOW', 'quietWorkflow', 'redProblem', 'redProblemOf'] },
      { path: 'src/ci-health.ts', symbols: ['ACTIVE_MS', 'CiHealth.outsideRuns'] },
    ],
  },
  {
    id: 'ci-runners',
    name: 'CI health: stuck, hung and dead jobs (#368)',
    mode: 'act',
    replay: { notYet: 'needs runner-online history, which nothing keeps; GitHub keeps jobs, not when a runner was offline' },
    acts: "makes a Mandate alert for every admin and wakes the scheme's Taskmaster",
    pins: [{ path: 'src/ci-problems.ts', symbols: ['WAIT_MS', 'HUNG_MS', 'stuckProblems', 'hungProblems', 'neverStarted', 'deadGroups', 'deadProblem'] }],
  },
  {
    id: 'ci-hold',
    name: 'Deploys first: the CI desktop hold (#1902)',
    mode: 'act',
    replay: true,
    acts: "stops optional CI runs while a ship is in line, and all but one Citadel job at a time, and starts them again after, telling their minions, and wakes the scheme's Taskmaster once about what is still waiting 2 hours after it was first held",
    pins: [
      {
        path: 'src/ci-hold.ts',
        symbols: [
          'SETTLE_DAY_MS',
          'SETTLE_NIGHT_MS',
          'MAX_BACKOFF',
          'NIGHT',
          'MAIN_WAIT_MS',
          'MAIN_SETTLE_MS',
          'OTHERS_CAP_MS',
          'SLOT_HOLD_MS',
          'SLOT_WAIT_MS',
          'REPORT_MS',
          'RANK',
          'CHECK_WAIT_MS',
          'CiHold.taken',
          'CiHold.slotPast',
          'CiHold.unasked',
          'CiHold.shipsFirst',
          'CiHold.mainWhy',
          'CiHold.takeSlot',
          'CiHold.nextUp',
          'CiHold.slotWhy',
          'isNight',
          'kindOf',
          'CiHold.shipWhy',
          'CiHold.stopWhy',
          'CiHold.gate',
          'CiHold.capped',
          'CiHold.mainPast',
          'CiHold.mainMay',
          'CiHold.mainDue',
          'CiHold.oneMain',
          'CiHold.mainAlone',
          'CiHold.gap',
          'CiHold.look',
          'CiHold.follow',
          'CiHold.ask',
          'CiHold.report',
        ],
      },
    ],
  },
  {
    id: 'ci-land-gate',
    name: 'CI health: the land gate (#1342)',
    mode: 'act',
    replay: { notYet: 'the land line it reads is live only; no history of it is stored' },
    acts: 'rings when lands keep failing or crawl',
    pins: [{ path: 'src/ci-land-gate.ts', symbols: ['LAND_STREAK', 'LAND_SLOW_MS', 'landStep', 'landProblems'] }],
  },
  {
    id: 'ci-numbers',
    name: 'CI numbers: a step up that held (#1369)',
    mode: 'act',
    replay: { notYet: 'the stored ci_numbers rows could drive it; not built in #1503' },
    acts: "wakes the scheme's Taskmaster",
    callers: ['src/ci-numbers.ts'],
    pins: [{ path: 'src/ci-numbers.ts', symbols: ['STEP', 'stepUp', 'CiNumbers.check'] }],
  },
  {
    id: 'land-verdicts',
    name: "land.sh's blame rules",
    mode: 'act',
    replay: { notYet: "#1484 builds their bench and the would-refuse shadow switch; land.sh is the pipeline lane's" },
    acts: 'refuses a ship, or blames it for a red',
    pins: [],
  },
  {
    id: 'tripwire',
    name: 'The tripwire',
    mode: 'act',
    replay: { notYet: 'register its replay after #1169, which is changing src/tripwire.ts, ships' },
    acts: 'blocks a tool call',
    pins: [],
  },
  {
    id: 'standing-checks',
    name: 'Standing checks (#1270)',
    mode: 'act',
    replay: { notYet: 'each check reads live state (turn folders, the runner queue) that only a snapshot could replay' },
    acts: 'records a standing-check health reading, which the Status page shows',
    pins: [{ path: 'src/standing-checks.ts', symbols: ['CHECKS'] }],
    callers: ['turn-record', 'one-place', 'fired-once', 'handoff-process', 'shipped-live', 'app-turn-ended', 'closed-processes', 'db-integrity'].map((c) => `standing-check:${c}`),
  },
  {
    id: 'compactions',
    name: 'Compacting over and over (#1920)',
    mode: 'act', // Josh, 2026-11-24: "we cant have that kind of thing just silently going on"; replayed over 3 days first
    replay: true,
    acts: "says it in the minion's chat and mails its Taskmaster at a turn's second compaction within 15 minutes, and wakes the Taskmaster from the fourth",
    pins: [{ path: 'src/compactions.ts', symbols: ['BURST_MS', 'filesRead', 'CompactWatch.observe', 'CompactWatch.compacted'] }],
  },
  {
    id: 'stall-signals',
    name: 'Stall signals (#1139)',
    mode: 'act',
    replay: { notYet: 'a replay would read turn transcripts; their tool calls are kept, so this is next after the three' },
    acts: "messages the minion's Taskmaster with a model step-up",
    pins: [{ path: 'src/stall-signals.ts', symbols: ['RED_TIMES', 'CHURN_ROUNDS', 'SHIP_FAILS', 'failingTests'] }],
    callers: ['src/stall-signals.ts'],
  },
  {
    id: 'repeat-bugs',
    name: 'Third-fix flag (B4)',
    mode: 'act',
    replay: { notYet: 'its own replay report (reports/third-fix-replay) was run by hand; fold it in here' },
    acts: 'starts a bug minion with a diagnose-first block, one model tier up',
    pins: [{ path: 'src/repeat-bugs.ts', symbols: ['REPEAT_WINDOW_MS', 'REPEAT_FLAG_AT'] }],
    callers: ['src/repeat-bugs.ts'],
  },
  {
    id: 'decision-copies',
    name: 'Stale decision copies (#1064)',
    mode: 'act',
    replay: { notYet: 'reads the decision sources live' },
    acts: "leaves the scheme's Taskmaster held mail when a new reversal leaves copies behind",
    pins: [{ path: 'src/decisions-load.ts', symbols: ['tellStale'] }],
    callers: ['src/decisions-load.ts'],
  },
  {
    id: 'turn-placement',
    name: 'Turn placement refusal',
    mode: 'act',
    replay: { notYet: 'placement reads live machine load' },
    acts: "refuses to start a turn when no machine can take it, and notes why in the minion's chat",
    pins: [{ path: 'src/runner.ts', symbols: ['Runner.refused'] }],
    callers: ['src/runner.ts'],
  },
  {
    id: 'reaper',
    name: 'The reaper (#1365)',
    mode: 'act',
    replay: { notYet: 'needs a process snapshot' },
    acts: 'kills the processes a closed minion left running',
    pins: [{ path: 'src/reaper.ts', symbols: ['guardedCgroup', 'ownerOf', 'guardedPids'] }],
    callers: ['src/reaper.ts'],
  },
  {
    id: 'link-check',
    name: 'Link check (Stop hook)',
    mode: 'act',
    replay: { notYet: 'replays over kept transcripts; next after the three' },
    acts: 'sends a reply back before people see it: broken links, hand-rolled pages, a choice with no card',
    pins: [{ path: 'src/link-check.ts', symbols: ['brokenLinks', 'handRolledPages', 'cardlessChoices', 'proseChoice'] }],
    callers: ['src/link-check.ts'],
  },
  {
    id: 'job-check',
    name: 'Job check and answer check (Stop hooks)',
    mode: 'act',
    replay: { notYet: 'replays over kept transcripts' },
    acts: "refuses to end a turn while the session's own jobs run, or when the answer misses a rule",
    pins: [
      { path: 'kit/hooks/job-check.ts', symbols: ['MAX_STOP_BLOCKS', 'jobCheck'] },
      { path: 'kit/hooks/answer-check.ts', symbols: ['MIN_TOOL_CALLS', 'MIN_ANSWER_CHARS', 'proposalLine'] },
    ],
    callers: ['kit/hooks/job-check.ts', 'kit/hooks/answer-check.ts'],
  },
  {
    id: 'flail-brake',
    name: 'Flail brake and batch nudge (PostToolUse)',
    mode: 'act',
    replay: { notYet: 'replays over kept transcripts' },
    acts: 'adds a line to the session after the same red three times, or three lookups in a row',
    pins: [
      { path: 'kit/hooks/flail-brake.ts', symbols: ['FLAIL_AT', 'flailBrakeHook'] },
      { path: 'kit/hooks/batch-nudge.ts', symbols: ['BATCH_AT', 'readOnlyBash'] },
    ],
    callers: ['kit/hooks/flail-brake.ts', 'kit/hooks/batch-nudge.ts'],
  },
  {
    id: 'grunt-model',
    name: 'Grunt-model guard (PreToolUse)',
    mode: 'act',
    replay: { notYet: 'replays over kept transcripts' },
    acts: 'sends back an Agent call that leaves its model out',
    pins: [{ path: 'kit/hooks/grunt-model.ts', symbols: ['gruntModelHook'] }],
    callers: ['kit/hooks/grunt-model.ts'],
  },
  {
    id: 'test-first',
    name: 'Test-first reminder (PostToolUse)',
    mode: 'act',
    replay: { notYet: 'replays over kept transcripts' },
    acts: 'adds a reminder line the first time a session edits a source file',
    pins: [{ path: 'kit/hooks/test-first.ts', symbols: ['isSourceFile', 'testFirstHook'] }],
    callers: ['kit/hooks/test-first.ts'],
  },
  {
    id: 'any-nudge',
    name: 'Any nudge (PostToolUse, #1789)',
    mode: 'act',
    replay: true,
    acts: "adds a line to the session when an edit raises a TypeScript file's count of explicit any and @ts-ignore-style comments",
    pins: [
      { path: 'kit/hooks/any-nudge.ts', symbols: ['TS', 'before', 'anyNudgeHook'] },
      { path: 'kit/skills/scheme-setup/templates/typecheck.ts', symbols: ['strip', 'stripTypes', 'DIRECTIVE', 'TEXT', 'WORD', 'blankTypeText', 'blankText', 'anysByPattern', 'escapes', 'countEscapes'] },
    ],
    callers: ['kit/hooks/any-nudge.ts'],
  },
  {
    id: 'big-read',
    name: 'Big-read guard (PreToolUse)',
    mode: 'act',
    replay: { notYet: 'replays over kept transcripts' },
    acts: 'sends back a whole read of a big file',
    pins: [{ path: 'kit/hooks/big-read.ts', symbols: ['bigReadHook'] }],
    callers: ['kit/hooks/big-read.ts'],
  },
  {
    id: 'seen-guard',
    name: 'Seen guard (#1920, PostToolUse)',
    mode: 'act', // Josh, 2026-11-24: "we CERTAINLY shouldnt let a minion read the same file over and over"; replayed over 3 days first
    replay: true,
    acts: "leaves file lines the session already printed, unchanged, out of a Bash or Read call's output, and says at 100k chars of file text to write notes",
    pins: [{ path: 'kit/hooks/seen.ts', symbols: ['CUT_MIN', 'SMALL', 'CONTEXT', 'REREAD_CHARS', 'FRESH_MS', 'GULP', 'GULP_AGAIN', 'fileRuns', 'cuts', 'seenHook'] }],
    callers: ['kit/hooks/seen.ts'],
  },
  {
    id: 'effort-retros',
    name: 'Effort retros (#1751)',
    mode: 'act', // Cara, 2026-11-24: "Start for real now"
    replay: true,
    acts: "starts a citadel:retro minion in a scheme when every minion of a named effort (3+) or an unnamed start_after chain (4+) has closed for 6 hours (and every minion their asks moved into), unless a major build's retro covers it",
    pins: [{ path: 'src/effort-retros.ts', symbols: ['NAMED_FLOOR', 'CHAIN_FLOOR', 'QUIET_MS', 'AUTO', 'effortsDue', 'moveEffort', 'movedTo', 'EffortRetros.tick'] }],
    callers: ['src/effort-retros.ts'],
  },
  {
    id: 'trouble-retros',
    name: 'Trouble post-mortems (#1796)',
    mode: 'log-only',
    replay: { notYet: 'replays over the budget and pick history of real minions' },
    acts: 'starts a citadel:post-mortem minion for a closed minion that went past four times its budget or had its model stepped up by a Taskmaster, once per minion and trigger',
    pins: [{ path: 'src/effort-retros.ts', symbols: ['TroubleRetros.tick', 'TroubleRetros.due'] }],
    callers: ['src/effort-retros.ts'],
  },
  {
    id: 'container-relief',
    name: 'Container relief (#1876)',
    mode: 'act', // Josh, 2026-11-24: "Kill its biggest process"
    replay: true,
    acts: "SIGKILLs the process with the most anon memory in a person's container stuck at its memory limit for a minute, again each minute while it lasts, and notes it in the chat of the turn that ran it",
    pins: [{ path: 'src/container-relief.ts', symbols: ['RELIEF', 'KEEP', 'step', 'processes', 'ContainerRelief.look', 'ContainerRelief.relieve'] }],
    callers: ['src/container-relief.ts'],
  },
  {
    id: 'app-shots',
    name: 'Nightly contraption screenshots (#1783)',
    mode: 'log-only', // Josh, 2026-11-25: "Watch only for a week"
    replay: true,
    acts: "wakes a contraption's home scheme's Taskmaster when a page of it newly broke overnight; a layout change after a ship is held mail (log-only still mails Citadel's own Taskmaster when the run itself failed)",
    pins: [
      { path: 'src/shot-judge.ts', symbols: ['BIG_CHANGE', 'ERROR_PAGE', 'sameError', 'problems'] },
      { path: 'tools/app-shots/picture.ts', symbols: ['CELLS', 'CELL_DIFF', 'LEAST_CONTENT', 'flatShare', 'background', 'cells', 'differs', 'changed'] },
      { path: 'src/app-shots.ts', symbols: ['AppShots.read'] },
    ],
    callers: ['src/app-shots.ts', 'tools/app-shots/app-shots.ts', 'tools/app-shots/inner.ts'],
  },
];

export const judge = (id: string): Judge | undefined => JUDGES.find((j) => j.id === id);

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
export const wouldLine = (id: string, act: string, text: string, now = Date.now()) => `- ${new Date(now).toISOString().slice(11, 19)}Z · would · ${id} · ${act} · ${text.replace(/\s+/g, ' ').slice(0, 300)}`;

/** Appends a would-line to `<shared>/retro-log/<day>/judges.md` in the background; never throws (it stands in for an act on an alert path). */
export function noteWould(sharedDir: string | null, line: string, now = Date.now()): Promise<void> {
  console.log(`[judge] ${line.slice(2)}`);
  if (!sharedDir) return Promise.resolve();
  const dir = join(sharedDir, 'retro-log', new Date(now).toISOString().slice(0, 10));
  return mkdir(dir, { recursive: true })
    .then(() => appendFile(join(dir, 'judges.md'), `${line}\n`))
    .catch((err: unknown) => console.error(`Noting a log-only judge's act failed: ${thrown(err).message ?? err}`));
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
