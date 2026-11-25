// Runs ticket turns as headless `claude -p` processes, one turn per process. Each runs through
// src/turn-wrapper.mjs in a transient systemd unit of its own (or, without units, a detached child),
// with its input and output in a turn folder the server tails, so a server restart doesn't stop it.
import { execFile, spawn } from 'node:child_process';
import { oomKilled } from './host-job.ts';
import { jobMachinesFor } from './machine-jobs.ts';
import { createHash } from 'node:crypto';
import { appendFileSync, close, existsSync, fstatSync, open, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { AGENT_NAME } from './auth.ts';
import { MSG_DEFAULTS, msgSettings } from './msg-settings.ts';
import { Relay, loopHolds, LOOP_LIMIT, LOOP_WINDOW_MS } from './minion-relay.ts';
export { LOOP_LIMIT, LOOP_WINDOW_MS };
import { askerKey, buildOwnerKey, onboardingOpen, planKey, type EventRow, type FinishedStep, type Project, type Store, type Ticket, type TicketFields, type TicketState, type TurnResult } from './db.ts';
import { APP_NAME } from './appname.ts';
import { CompactWatch } from './compactions.ts';
import type { Claim } from './claims.ts';
import { fableMeter } from './costs.ts';
import { Approvals, lines, type Go } from './approvals.ts';
import type { TurnGithub } from './github-link.ts';
import { KEEP, SENT_BACK } from './link-check.ts';
import type { SchemeRefs } from './scheme-refs.ts';
import { cardHref, cardLabel, cardWhat, settledHow, type CardLink, type SettledCard } from './card-links.ts';
import type { Ship } from './branch.ts';
import type { Wait } from './waits.ts';
import { releaseEmulatorLease } from './emulator-lease.ts';
import { track } from './settled.ts';
import { claudeConfigDir, lastEffort, mergeTaskmasterMemory, projectSlug, restoreAhead, restoreSession, saveSession, storedPaths, transcriptPath, validSessionId } from './sessions.ts';
import { Fresh, roleWord, type FreshState } from './fresh.ts';
import { HeldMail } from './held-mail.ts';
import { KeepaliveRun } from './keepalive-run.ts';
import { Closing } from './closing.ts';
import { Lanes } from './lanes.ts';
import { DismissedCleanup } from './dismissed-cleanup.ts';
import { buildBranch, landsBuilds, projectDir, surveyReports } from './workspace.ts';
import { thrown } from './thrown.ts';
import type { ClaudeEvent, ContentBlock, LoadError, ModelUsage } from './claude-events.ts';
import { KillWaves } from './kill-wave.ts';
import { killedSpend, turnOf } from './turn-row.ts';
import { buildPreviewPath, previewKey } from './previews.ts';
import { readScope } from './read-scope.ts';
import { accountUsageKey, usageKey } from './account-pick.ts';
import { type TurnPlace } from './claude-link.ts';
import { asData } from './quote.ts';
import { runsRepo, type Chain } from './wake.ts';
import { dropTurnDir, makeTmpDir, sweepDroppedTurnDirs, sweepTmpDirs } from './turn-tmp.ts';
import { size } from './build-output.ts';
import { gradleCacheDir } from './build-cache.ts';
import { claudeParts, codexResetAt, codexSwitchKey, codexThreadKey, codexUsageKey, fitLog, isCodexModel, readParts, toClaudePreamble, CODEX_MODELS, CODEX_WAITING, HANDOVER_MAX, type CodexThread, type CodexUsage } from './codex.ts';
import { promptHashes, type PromptHashes } from './prompt-hashes.ts';
import { decideHold, Holds, type HoldDecision } from './prompt-hold.ts';
import { stuckList } from './stuck-list.ts';
import { armOf, SEAM_CONTEXT_TOKENS, SEAM_TRIAL_KEY, type SeamTrial, trialLine } from './seam-trial.ts';
import { COMPACT_COMMAND, freshStartText, LOST_DIGEST_ENTRIES, lostSessionText, promptMessage, promptParts, promptText, RESUME_CODEX_PROMPT, RESUME_PROMPT, TASKMASTER_LOOP_LIMIT, TASKMASTER_LOOP_WINDOW_MS, type PromptSections, type TurnMachine } from './prompts.ts';
import { fallbacks } from './fallbacks.ts';
import { ensureSupervisor, handTurn, supervisorSpec, type SupervisorSpec } from './supervisor-client.ts';
import { MachineTurn, placeTurn } from './machine-turn.ts';
import { offSkills, pruneKit } from './skills.ts';
import { alive, copyPinned, launchPlan, type EveryScheme, type LaunchPlan, TASKMASTER_SLICE, TURN_BUILD_JOBS, TURN_SLICE, turnEnv, turnPins, turnSettings, USAGE_LIMIT, wrapperSpec } from './turn-launch.ts';
import { hideTokens } from './hide-tokens.ts';
import { hideSecrets, hideSecretsIn, secretEnv } from './secrets.ts';
import { takeStatus, type StatusFields } from './status-trailer.ts';
import { appFolder, slotsOf } from './app-services.ts';
import { DEFAULT_CONTRAPTIONS_DIR } from './contraptions.ts';
import { GLOBAL_OWNER } from './properties.ts';
import { KEEPALIVE_TEXT, changedParts, claudeStamp, contextText, fingerprint, keepaliveKey, prefixParts, treeHash, turnDate, type KeepaliveSeries } from './keepalive.ts';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { answerPrompt, callOf, CARD_HOLD_MS, cardHeld, cardWait, keptCards, losesPass, newCalls, noteCalls, readsSteers, repliedPrompt, sameCall, STEER_LAG_MS, type CardPass, type KeptCard, type TurnCalls } from './card-wait.ts';
import { longestTool, noteEvent, quietAt, type Activity, type ProcCheck } from './quiet.ts';
import { applyEvent, createProgress, planEstimate, planTrack, progressLine, stepInfo } from '../public/progress.js';
import { packPlan, unpackPlan } from './history.ts';
import { readGrunts } from './grunts.ts';
import { ASK, askText, type Budget, budgetCard, budgetFor, budgetKey, type BudgetState, startHoldKey, CARD, chatNote, costReason, markOf, passed, REASON, turnLine, WAKE, wakeLevel, wakeText } from './minion-budget.ts';
import { openSpend, SpendMeter, type SpendState, spendText, STAGES_SETTING, stagesFrom } from './spend-alert.ts';
import { isAppTurnsRun } from './schedules.ts';
import { kitLine, readAgentFiles, renderSet, reviewSetLine, withoutGoneAgents } from './review-set.ts';
import { clockTime, parseResetTime } from './pacific.ts';
import { disabledAuthor, payerInScheme, turnPayer } from './access.ts';
import { MinionQueue, migrateQueues, queueKey, type OwedResume, type Steer } from './minion-queue.ts';
import { ACCOUNT_ERROR, isNetworkFailure, outcome, RETRIES, retriesOf, type Outcome, type Retries, type RetryKind, type TurnEnd } from './turn-outcome.ts';
import { KILL_HOLD_MAX_MS, LIMIT_RESUMES, nextLimitResume, Resumes, type KillResume, type LimitedAccount, type LimitResume, type NetResume, type WaitList } from './resumes.ts';
import type { MinionJobs } from './minion-jobs.ts';
import { LinePlaces, type OnAccount } from './line-place.ts';
import { runningTurn, START_GRACE_MS, wrapperAlive, type TurnAt } from './running-turn.ts';
import { TurnLine, type LineEntry, type LinePlace } from './turn-line.ts';
import { holdOver, StartNow } from './start-now.ts';
import { Urgent } from './urgent.ts';
import { realClock, type Clock, type ClockTimer } from './clock.ts';
import { describeActivity, DROPPED_TYPES, guessWindow, pushKind, slimEvent } from './stream-events.ts';
import { usageWindow, type CodexLimits, type CodexWindow, type LoadedCommands, type MessageFile, type MessageImage, type QueuedMessage, type RateLimitInfo, type Usage } from './turn-messages.ts';
import { contextKey, windowKey, freshKey, handoffKey, failNoteKey, closeCancelledKey, turnKey, warmKey, savingKey, commandsKey, schemeCommandsKey } from './turn-keys.ts';
import { sleepKey, type Sleep } from './needs.ts';

/** The most of a minion's Codex log kept for the way back, as characters (twice what a hand-over carries). */
const CODEX_LOG_MAX = 2 * HANDOVER_MAX;
/** Whether `path` is there, asked off the server's thread (#1808). */
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
/** A container turn's `container` file and first beat (spawnInContainer): it counts as running while its container starts. */
const containerFiles = async (dir: string, place: { container: string }) => {
  await writeFile(join(dir, 'container'), place.container);
  await writeFile(join(dir, 'beat'), '');
};

/** The scheme-refs snapshot for a turn of `project`: its name, the other schemes' names and its minions, plus its cards waiting on people (card-links.ts). */
export function schemeRefs(project: Project, projects: Project[], tickets: Ticket[], cards?: { self: number | null; cards: CardLink[] }): SchemeRefs {
  const minions: SchemeRefs['minions'] = {};
  for (const t of tickets) if (t.number != null) minions[t.number] = { title: t.title, closed: t.status === 'closed' };
  return { scheme: project.name, others: projects.filter((p) => p.id !== project.id).map((p) => p.name), minions, ...cards };
}

/** The chat event kinds that post or settle a card waiting on people (a person's message answers one). */
const CARD_KINDS = new Set(['question', 'question_more', 'plan', 'approval', 'question_result', 'plan_result', 'approval_result', 'user_message']);
/** The card kinds a turn posts itself: its own snapshot has them before its tool call returns (refreshRefs). */
const POSTED_KINDS = new Set(['question', 'question_more', 'plan', 'approval']);
const EVERYONES = new Set(['question', 'plan', 'approval']);

export type Broadcast = (msg: object) => void;

/**
 * What a running turn's restart recovery needs, kept in the settings table under `turn:<ticket id>`
 * from the turn's start until the server has handled its end. A restart re-attaches to the turn from
 * this, or resumes it if its process died too.
 */
export interface TurnState {
  /** Auto-resumes in a row that led to this turn, by kind (src/turn-outcome.ts); absent for a turn people or GitHub started. */
  retries?: Retries;
  /** A row saved before the retries record kept its counts in these four (read with retriesOf). */
  resumes?: number;
  stopped?: true;
  /** A pause stopped it, to carry on after it (#1868). */
  paused?: true;
  /** Ended while only its approval card waited, which is kept for its answer (#1916). */
  card?: true;
  /** As LiveTurn's. */
  unread?: number;
  /** The approved call it may make once without another card. */
  pass?: CardPass;
  /** Present (a reason or null) once the thread asked to close after this turn. */
  closing?: string | null;
  /** The turn's folder (see src/turn-wrapper.mjs); absent for turns from before they had one. */
  dir?: string;
  /** Its transient unit, or null when it runs as a child of the server (and dies with it). */
  unit?: string | null;
  /** Bytes of its stream.jsonl handled so far. */
  offset?: number;
  /** Whose own secrets it was launched with (#838); absent for the scheme's alone. */
  secretPerson?: number;
  startedAt?: number;
  configDir?: string;
  /** The ticket had an effort of its own when the turn started. */
  chosenEffort?: boolean;
  /** Its result event, once seen. */
  result?: { error: boolean; text: string | null };
  /** Its minion's deploy went live mid-turn (see deployLive). */
  deployed?: true;
  /** The minion whose relay started it (Runner.turnFrom): a restart mid-turn keeps whose minion a Taskmaster's create_ticket makes (R3, #1452). */
  from?: number;
  /** A held minion's state and note at its start (Runner.parkedAs, #261), put back at its end (R4, #1452). */
  parkedAs?: { state: TicketState | null; note: string | null };
  /** Its reply's last status trailer (Runner.statuses), applied with its result (R6, #1452). */
  status?: StatusFields;
  /** A reply of its was sent back (Runner.sentBack, #281): its rewrite replaces it at the result (#1452). */
  sentBack?: true;
  limitTries?: number;
  netTries?: number;
  killTries?: number;
  /** It runs on Codex (src/codex-turn.ts), not claude (#337). */
  codex?: true;
  /** A Claude turn that starts with the Codex turns before it: their thread is dropped once it succeeds. */
  handBack?: true;
  /** The person it runs for (turnPerson). */
  person?: number | null;
  /** Which of that person's Claude accounts it runs on (#779); absent on a Codex turn. */
  account?: number;
  /** Who asked for it (Store.turnAsker), which a non-member's relay keeps apart from `person`. */
  asker?: number | null;
  /** What it was launched with (#878), its Claude Code version added from the init event; saved with its row in turns. */
  hashes?: PromptHashes;
  /**
   * The one person whose own typed message it answers (#268): the only person mandate_item may post for.
   * null for a turn no one typed for (GitHub, a relay, a wake, a resume, a contraption's ask), 0 once
   * several people did, which a later steer can't undo.
   */
  typedBy?: number | null;
  /** Their GitHub login it pushes as; null when they haven't linked, absent with GitHub linking not set up. */
  github?: string | null;
  /** The person's Claude container it runs in (#213); absent on the host. */
  container?: string;
  /** The people's own machines it got at its start (#306): the only owned ones it may open (routes/machines.ts). */
  owned?: number[];
  /** A Taskmaster's fresh-start step (#406): messages wait behind it rather than steer in. */
  fresh?: 'handoff' | 'compact';
  /** Its prompt carried a fresh session's handoff, which goes once the session exists. */
  handoff?: true;
  /** Its estimated cost so far and the alerts fired (#723, src/spend-alert.ts). */
  spend?: SpendState;
  /** Since when it has been quiet (#906, src/quiet.ts), for the requester's Needs you; cleared by its next output. */
  quiet?: number;
  /** A hidden keepalive turn (#862): messages wait behind it, and a restart drops it. */
  keepalive?: true;
  /** The fingerprint of its cached prefix and its parts (src/keepalive.ts), which a real turn's end starts a keepalive series from. */
  fp?: string;
  fpParts?: Record<string, string>;
  /** It runs at low effort (#951): its batch was only machine notices of success, or it keeps such a turn's cache warm. */
  light?: true;
  /** The kinds of its background tasks that run now (TurnCalls.background), which its stored events don't keep. */
  background?: string[];
}

/** A turn this server follows: its folder, read up to `offset`. */
export interface LiveTurn {
  dir: string;
  unit: string | null;
  offset: number;
  startedAt: number;
  configDir: string;
  chosenEffort: boolean;
  container: string | null;
  timer: NodeJS.Timeout;
  ticks: number;
  stopTimer?: ClockTimer;
  /** A stop's SIGINT-to-SIGTERM wait. */
  stopGraceTimer?: ClockTimer;
  /** What it last did and the tool calls still open (#906): when it counts as quiet. */
  activity: Activity;
  /** Its open calls and background work, for what it does while a card waits (#1916). */
  calls: TurnCalls;
  /** When it was last steered, until claude has surely read it: a process that may hold an unread message isn't ended for a card. */
  unread?: number;
  /** Being ended for its card (TurnState.card). */
  card?: boolean;
  /** Stopped before its claude had started (no pid.json): signalled once it has. */
  stopPending?: boolean;
  /** Resolves once the turn has ended and its session is saved: its step on the minion's lane. */
  ended: Promise<void>;
  end: () => void;
  /** What the config dir held when the turn started, which its save may prune (null: nothing; a re-attached turn doesn't know). */
  had: Set<string> | null;
  /** Handed to the turn supervisor and its shell not yet running (#1343): starts its wrapper unit, should the supervisor give it back or lose it. */
  restart?: () => void;
  /**
   * Its stream.jsonl and its folder, kept open while it's followed (#1562): a tick asks their sizes and times with fstat,
   * which needs no file-name lookup (the part that blocked in btrfs at load). Closed by unfollow.
   */
  streamFd?: number;
  /** null while its open is under way (dirChanged). */
  dirFd?: number | null;
  /** No longer followed: an open that finishes now closes what it opened. */
  unfollowed?: boolean;
  /** The folder's mtime at the last look, and whether the next tick looks again (dirChanged). */
  dirSeen?: number;
  dirAgain?: boolean;
  /** exit.json was there at the last look: looked for again each tick, folder change or not (poll). */
  exitSeen?: boolean;
}

/** The stream reader's buffer: one for every followed turn, grown only for a line longer than it (readStream). */
const STREAM_CHUNK = 1 << 20;

export { commandsKey, schemeCommandsKey };
export { guessWindow, pushKind, slimEvent };
export type { LoadedCommands, MessageFile, MessageImage, QueuedMessage, Usage };
export { FRESH_CONTEXT_TOKENS, FRESH_IDLE_CONTEXT_TOKENS, FRESH_IDLE_MS, idleText, type FreshState } from './fresh.ts';

// Kept in src/account-pick.ts, which claude-link.ts reads them from too (#793).
export { accountUsageKey, usageKey };

// Kept in src/running-turn.ts; the tests and the turn files' comments know them from here.
export { wrapperAlive, wrapperInProc } from './running-turn.ts';

/** Whether a process this server can see has `arg` as one of its arguments; reads every process's cmdline. */
function argInProc(arg: string): boolean {
  try {
    return readdirSync('/proc').some((pid) => {
      try {
        return /^\d+$/.test(pid) && readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(arg);
      } catch {
        return false; // ended meanwhile
      }
    });
  } catch {
    return false;
  }
}

/** A turn's steers its wrapper never passed to claude (see src/turn-wrapper.mjs). */
export function unsentSteers(turn: { steered?: Steer[]; dir?: string }): QueuedMessage[] {
  if (!turn.steered?.length || !turn.dir) return [];
  let text: string;
  try {
    text = readFileSync(join(turn.dir, 'steer.sent'), 'utf8');
  } catch {
    text = '0'; // none passed on
  }
  const sent = /^\d+$/.test(text) ? Number(text) : NaN;
  // Unreadable (an older wrapper killed mid-write): some were passed on, so resending risks doubles.
  if (Number.isNaN(sent)) {
    console.error(`${turn.dir}: steer.sent reads ${JSON.stringify(text)}, so its turn's steers are taken as sent.`);
    return [];
  }
  return turn.steered.filter((s) => s.end > sent).map((s) => s.msg);
}

// A scheme's standing gos to merge (#260), kept in settings so they outlive turns and restarts.
const goesKey = (projectId: number) => `merge_goes:${projectId}`;
/** The longest a message held for a cold session waits before it wakes the session anyway: only mail held before #1603 dropped the cold hold. */
export const COLD_HOLD_MAX_MS = MSG_DEFAULTS.holdH * 3600_000;

// How a turn ended, and the caps on resuming it, are src/turn-outcome.ts's (#1379); these names stay for the tests.
export { ACCOUNT_ERROR, isNetworkFailure };
// The resume waits are src/resumes.ts's (#1476); these names stay for the tests and callers.
export { KILL_HOLD_MAX_MS, nextLimitResume };
export type { LimitedAccount };
/** Usage-limit resumes in a row before a minion waits for a person. */
export const MAX_LIMIT_RESUMES = RETRIES.limit.cap;
const RESUME_PAUSE_PROMPT = `A person paused all minions while you were working, which stopped your last turn; the pause is over. A command may have half-run when it stopped, so check the state of your work (git first, then files and background jobs) and continue where you left off. Don't redo finished steps.`;
const RESUME_ACCOUNT_PROMPT = `Your last turn stopped at a Claude account's usage limit (or its sign-in ran out), so this turn carries on with another of your person's Claude accounts. Check the state of your work (files, git, background jobs) and continue where you left off. Don't redo finished steps.`;

const RESUME_LIMIT_PROMPT = `Your last turn stopped at the account's usage limit, which has now reset. Check the state of your work (files, git, background jobs) and continue where you left off. Don't redo finished steps.`;

/** Every one of a person's accounts is limited (#779): when the first resets, and (#819) each one's own limit. */
export interface AllLimited {
  resetAt: number;
  accounts: LimitedAccount[];
}

/** The note for a minion whose accounts are all limited: which one is out until when, and which reset it waits for. */
export function allLimitedText(accounts: LimitedAccount[], at: number): string {
  const out = (a: LimitedAccount) => `${a.here ? `This account (${a.label})` : a.label} is out until ${clockTime(a.until)}${a.kind ? ` (${a.kind})` : ''}.`;
  const first = accounts.reduce((m, a) => (a.until < m.until ? a : m));
  const when = accounts.length > 1 ? `when ${first.label}'s limit resets` : 'when it resets';
  return `${[...accounts]
    .sort((a, b) => Number(!!b.here) - Number(!!a.here) || a.until - b.until)
    .map(out)
    .join(' ')} This minion carries on at ${clockTime(at)}, ${when} (or sooner once a turn gets through); a person's message tries now.`;
}

/** Network-outage resumes in a row before a thread is left in error for a person. */
export const MAX_NET_RESUMES = RETRIES.net.cap;
/** The minion's note while it waits: cleared by the next turn's start. */
const NET_NOTE = 'Network outage: resumes once it is back';
const RESUME_NET_PROMPT = `Your last turn died because the network or the model's API was unreachable; it is reachable again now. A command may have half-run when the connection dropped (a ship, a push, a deploy, a fetch), so check the state of your work (git first, then files and background jobs) before you continue where you left off. Don't redo finished steps.`;

/** A turn killed from outside (out of memory, a container stop, a stray signal) is resumed by the server once (RL1, #1364). */
export const MAX_KILL_RESUMES = RETRIES.kill.cap;
const KILL_NOTE = 'Killed: resumes by itself shortly';
const RESUME_KILL_PROMPT = `Your last turn was killed from outside before it finished (out of memory, a container stop or a stray signal), and Citadel resumed it by itself. A command may have half-run when it died (a ship, a push, a deploy, a test run), so check the state of your work (git first, then files and background jobs) before you continue where you left off. Don't redo finished steps, and don't restart whatever heavy job was running without thinking about why the turn was killed.`;

/** Whether the API answers at all: any HTTP response counts, only a failure to connect (DNS, socket, 10 s timeout) doesn't. */
export async function apiReachable(): Promise<boolean> {
  try {
    // shortcut: probes Anthropic's host only; a Codex turn that fails again on OpenAI's just waits once more.
    await fetch('https://api.anthropic.com/', { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
    return true;
  } catch {
    return false;
  }
}

/** Auto-resumes in a row before a thread is left alone, in case its own turn is what kills the server. */
export const MAX_RESUMES = RETRIES.restart.cap;

/** A resume owed until its turn is saved (seam 1's queue keeps the shape it had before the retries record). */
function owedOf(via: RetryKind, r: Retries): OwedResume {
  return { resumes: r.restart ?? 0, ...(r.limit ? { limitTries: r.limit } : {}), ...(r.kill ? { killTries: r.kill } : {}), ...(r.switch ? { switchTries: r.switch } : {}), ...(via === 'switch' ? { onAccount: true as const } : {}) };
}
/** The retries an owed resume's turn starts with. */
function owedRetries(o: OwedResume): Retries {
  return { ...retriesOf({ resumes: o.resumes, limitTries: o.limitTries, killTries: o.killTries }), ...(o.switchTries ? { switch: o.switchTries } : {}) };
}

/** How a turn's MCP server reaches the API; without `token` it mints the ticket's next turn token, which retires the one before. */
export type CoordinatorEnv = (ticket: TicketFields, token?: string) => Record<string, string>;

export class Runner {
  private turns = new Map<number, LiveTurn>();
  /** Each minion's lifecycle steps, one at a time (src/lanes.ts): a turn and its session save, a resume, a dismissal's cleanup. */
  private lanes = new Lanes();
  /** Every message for a minion, from its send until its turn is durably done (src/minion-queue.ts, #1378). */
  readonly queue: MinionQueue;
  /** Minions a message reached during a network or kill wait: their next free lane starts a turn now, as that message asked. */
  private wakeNow = new Set<number>();
  /** Tickets that asked to close when their current turn ends, with the reason they gave. */
  private closing = new Map<number, string | null>();
  /** Minions whose deploy went live mid-turn: dismissed when that turn ends, if still pending-deploy. */
  private deployedMidTurn = new Set<number>();
  private progress = new Map<number, ReturnType<typeof createProgress>>();
  private stepRatios = new Map<number, { at: number; ratio: number }>();
  /** The minion whose relayed message started each ticket's current turn, when a relay came before any person's message. */
  private turnFrom = new Map<number, number>();
  /** A sealed minion's state and note when a turn answering a message started: put back at its end, while still sealed (#261). */
  private parkedAs = new Map<number, { state: TicketState | null; note: string | null }>();
  private store: Store;
  private broadcast: Broadcast;
  private claudeBin: string;
  private coordinatorEnv: CoordinatorEnv;
  /** The clock the loop guard's window runs on; tests move it. */
  now = () => Date.now();
  /** Gap between auto-resumes after a restart, so they don't all start at once. */
  resumeGapMs = Number(process.env.CITADEL_RESUME_GAP_MS) || 3000; // the env knob lets a test shorten it
  /** After the usage limit resets, before the first minion resumes; then between resumes, so they don't all hit it again at once. */
  limitDelayMs = 60_000;
  limitGapMs = 30_000;
  /** The gap once a turn has got through: the limit is proven gone. */
  limitProvenGapMs = 5_000;
  /** When Claude's words don't say when the limit resets. */
  limitFallbackMs = 60 * 60 * 1000;
  /**
   * Limit waits whose resume is under way here (restoring the session, say), each with a token for that one resume:
   * kept saved until a turn takes them, so a restart still resumes. An earlier resume's end can't touch a later one's wait.
   */
  private limitStarting = new Map<number, object>();
  /** Whether the model's API can be reached; one probe for the whole server while any thread waits on the network (#366). */
  netProbe: () => Promise<boolean> = apiReachable;
  /** The first wait before probing, doubling after each failed probe up to netProbeMaxMs. */
  netProbeMs = 30_000;
  netProbeMaxMs = 5 * 60_000;
  /**
   * Whether the box is starved, which server.ts gives it: only the line of kill resumes holds for it (#1364). Nothing
   * a person or a Taskmaster starts reads it, so runner.ts never imports the reader (test/held-starts.test.ts).
   */
  killStarved: () => Promise<{ starved: boolean; why: string }> = async () => ({ starved: false, why: '' });
  killHoldMaxMs = KILL_HOLD_MAX_MS;
  /** Kill waits whose resume this server has started: the line moves past them; the wait goes once their turn takes it. */
  private killStarted = new Map<number, number>();
  /** Set once detachAll hands the turns to the next server: this one starts no more resumes. */
  private detached = false;
  /** The usage-limit, network and kill waits (src/resumes.ts). */
  private resumes: Resumes;
  /** The worker pool and the line of turns waiting for one (src/turn-line.ts, #1868). */
  readonly turnLine: TurnLine;
  readonly urgent: Urgent;
  readonly startNow: StartNow;
  readonly places: LinePlaces;
  /** The waits' timers and probe delay, read by tests. */
  private get limitTimer() {
    return this.resumes.limitTimer;
  }
  private get netTimer() {
    return this.resumes.netTimer;
  }
  get netDelay() {
    return this.resumes.netDelay;
  }
  /** When each account error last pushed: one push per error for everyone, not one per minion. */
  private accountPushes = new Map<string, number>();
  /** Copies a session into the database (src/sessions.ts); tests hold it open to race the next step against it. */
  saveSession = saveSession;
  /** How often a running turn's stream file is read. */
  pollMs = 250;
  /** How long a container turn's `podman exec -d` (or its systemd-run) may take to return before the start counts as failed. */
  containerStartMs = 60_000;
  /** Run turns in transient systemd user units, which outlive this server, rather than as its children. */
  units = false;
  /** Turns get their Citadel tools from their place's shared tool server (#1259, src/mcp-pool.ts) rather than helpers of their own; set by server.ts. */
  pool = false;
  /**
   * Host turns with units start in the shared turn supervisor (#1343, src/turn-supervisor.mjs), each in a scope of its
   * own, rather than each with a node wrapper of its own; a turn it doesn't take at once gets its wrapper unit. Set by server.ts.
   */
  supervisor = false;
  private supSpec: SupervisorSpec | null = null;
  /** Where turn folders go: beside the database, so a test's or dev copy's never mix with the live ones. */
  turnsDir: string;
  /** The data dir this runner's turns use (beside the database), so a test's or dev copy's stay apart. */
  private dataDir: string;
  /** Each warm session's held system prompt (#1276). */
  promptHolds: Holds;
  /** The repos found to hold the live checkout's code: their minions' prompts carry the deploy lines (buildLaunch). */
  private deploysRepos = new Set<string>();
  /** Tells this server's turn units apart from another server's (a dev copy) on the same user manager. */
  private unitTag: string;
  /** Set in a preview (server.ts, PREVIEW=1): messages are kept, but no turn ever starts. */
  noTurns = false;
  /** The commit the server runs now (server.ts: the waiters' head), to tell whether a scheme deploys here. */
  liveHead: () => string | null = () => null;
  /** Whether the minion's branch has an open GitHub PR, as the GitHub watcher last saw it: its prompt's PR line says more then (#760). */
  openPr: (ticketId: number) => boolean = () => false;
  /** Whether a scheme's chats are indexed for search_memory (server.ts, #331). */
  memoryScheme: (projectId: number) => boolean = () => false;
  /** A ticket was dismissed (its preview goes with it). */
  onClose: (ticketId: number) => Promise<void> | void = () => {};
  /** A turn started and saved the messages it carries (their event ids): the outbox marks what it handed over as sent (server.ts). */
  onTurnStart: (ticketId: number, eventIds: number[]) => void = () => {};
  /** A stop dropped the messages with these event ids from the minion's queue: the outbox settles the rows that handed them and answers with the ones whose message stays as held mail (server.ts). */
  onStop: (ticketId: number, eventIds: number[]) => number[] = () => [];
  /** A folder outside the repo where a ticket can put files it fetched or made to show people. */
  filesDir: (ticket: Ticket) => string | null = () => null;
  /** The folder every thread and the coordinator of a project can read and write, for handoffs and notes. */
  sharedDir: (project: Project) => string | null = () => null;
  /** The folder that holds a project's ticket folders, which the coordinator may read. */
  ticketsDir: (project: Project) => string = (project) => join(project.repo_dir ?? '.', '..', 'tickets');
  /** Machines online now and lent to this scheme (access.ts lendsMachine); a thread's turn gets each one's MCP tools. */
  /** The online machines a turn in this scheme gets, for these askers (#306: their own machines). */
  machines: (project: Project, askers: number[]) => TurnMachine[] = () => [];
  /**
   * The connected machine this turn is placed on (Build 7 T2, src/machine-turn.ts), or null: it runs here. Nothing places
   * one by default; server.ts sets it, and only ever for an ordinary minion's turn on Claude.
   */
  workerFor: (ticket: Ticket, person: number | null) => { id: number; name: string } | null = () => null;
  /** Files on disk may have changed. `soon`: a turn ended or a reply linked a file, so look within seconds; false: a tool result, looked at throttled (#1542). */
  onFilesMayChange: (ticketId: number, soon: boolean) => void = () => {};
  /** Where the minion's change is, branch to live (src/branch.ts), for its bar and its row's badge. */
  ship: (ticketId: number) => Ship | null = () => null;
  /** What it waits on now: the land line, a heavy slot, the restart (src/waits.ts), for its row's badge and bar. */
  wait: (ticketId: number) => Wait | null = () => null;
  /** What the server is doing for it with no turn of its own (#727): today its handed-off land (src/land.ts), set by the server. */
  serverWork: (ticketId: number, fresh?: boolean) => { kind: string; text?: string; since?: number } | null = () => null;
  /** The jobs it runs on the server past its turns (#1890, src/minion-jobs.ts), set by the server. */
  jobs: Pick<MinionJobs, 'stop' | 'running' | 'turnLine'> | null = null;
  /** Each stored stream event of a turn, after it is saved (the stall signals, #1139). */
  onStreamEvent: (ticketId: number, ev: ClaudeEvent) => void = () => {};
  /** Called when a turn's process has exited, however the turn ended. */
  onTurnEnd: (ticketId: number) => void = () => {};
  /** What a minion sealed on start_after waits for, or null (LiveWaiters.heldFor, set by the server). */
  heldFor: (ticketId: number) => string | null = () => null;
  /** The brief a chained minion holds, shown read-only in its chat (LiveWaiters.heldBrief, set by the server). */
  heldBrief: (ticketId: number) => { text: string; from: string; leader: number; when: 'live' | 'merged'; is: string } | null = () => null;
  /** What wakes a sealed minion by itself (an unheld start_after, wake_when_live, wake_when_runners_back), or null (set by the server). */
  wakesOn: (ticketId: number) => string | null = () => null;
  /** What the minion waits for, for the list's chip (src/waits-readout.ts, set by the server). */
  outboxWaits: (ticket: Ticket) => unknown[] = () => [];
  /** Approve / Deny cards waiting on people, for projects with approval rules. */
  approvals: Approvals;
  /** Cards whose minion's process ended while they waited (#1916). */
  private cardWaits: WaitList<KeptCard>;
  private relays: Relay;
  private held: HeldMail;
  private keepaliveRun: KeepaliveRun;
  private fresh: Fresh;
  private closer: Closing;
  private cleanup: DismissedCleanup;
  /** Where a turn for a person runs (#213, src/claude-link.ts): the host, their own container, or why it can't run at all. */
  placeFor?: (person: number | null, warm?: string, taskmaster?: boolean) => TurnPlace | { refused: string };
  /** The account such a turn would run on, moving nothing (ClaudeLink.accountFor, #1888): null for none. */
  accountFor?: (person: number, warm?: string) => number | null;
  /** The start_after chains still to fire (LiveWaiters.chains, set by the server): the minions that wait on another. */
  chains: () => Chain[] = () => [];
  /** A Claude turn of session `key` (warmKey) ended on `account`, so the session stays there while its cache is warm (ClaudeLink.ran, #793). */
  onRan?: (person: number, key: string, account: number) => void;
  /** Whether `person` has OpenRouter connected, so the turn's minion is offered the media tools (src/openrouter.ts, #717). */
  mediaFor?: (person: number | null) => boolean;
  /** Why a person's turns can't run on Codex (#337), or null when they can: their own container, signed in to Codex. */
  codexReady?: (person: number) => string | null;
  /** Where the server login's Codex turns run: its own container (#341), or null before there is one. */
  codexPlaceFor?: (person: number) => TurnPlace | null;
  /** Start the server login's Codex container if it isn't running, for its host turns' Codex reviews (#398). */
  wakeCodex?: (person: number) => void;
  /** A turn's Claude sign-in was refused, so that person has to link that account again. */
  onAuthFailure?: (person: number, account?: number) => void;
  /**
   * A person's Claude accounts (#779), in order, with the one turns run on now; null when they have none.
   * The ClaudeLink's, set by the server.
   */
  claudeAccounts?: (person: number) => { inUse: number | null; why?: string; pinned?: number; accounts: { n: number; label: string; same?: string }[] } | null;
  /**
   * A turn on `account` hit its limit, which resets at `until` (src/claude-link.ts, limited): the account turns
   * move on to, or null when none is ready, with the earliest reset of the person's accounts.
   */
  onLimit?: (person: number, account: number, until: number) => { next: { n: number; label: string } | null; resetAt: number; limits?: { n: number; label: string; until: number }[] } | null;
  /** A turn on `account` got through, so its limit is gone. */
  onCleared?: (person: number, account: number) => void;

  /**
   * The environment a host turn's tools get, for running a minion's tools/land.sh on the host (src/land.ts).
   * It carries the calling turn's own token: a fresh one would log that turn's tools out (#225).
   */
  hostEnv(ticket: TicketFields, token?: string): Record<string, string> {
    const project = this.store.getProject(ticket.project_id);
    // land.sh's retro_log and run-tests.sh's log_flake write there, as they do from a turn.
    const shared = project && this.sharedDir(project);
    // Its pushes and gh calls go out as the person the minion's turns run for, as from the turn (#911): the box's gh
    // login can't see a member's private repo. Its gh folder is the person's, since the land outlives the turn's folder.
    // Outside a turn (a fast-mode verify, a queued hand-off) its last person while still in the scheme (canSee, as turnPayer) and enabled, else the owner (#1449).
    const live = this.turns.has(ticket.id) ? this.store.getSetting<TurnState>(turnKey(ticket.id))?.person : null;
    const last = project ? payerInScheme(this.store, project, ticket.person_id) : ticket.person_id;
    const person = live ?? (project && this.store.getUser(last ?? -1)?.disabled_at ? project.owner_id : last);
    const github = this.githubFor?.(person, join(this.dataDir, 'people', String(person ?? 'nobody')))?.env;
    return {
      ...turnEnv(process.env),
      ...github,
      ...this.coordinatorEnv(ticket, token),
      ...this.heavyEnv(ticket, person),
      COORDINATOR_ROLE: 'thread',
      COORDINATOR_TICKET: String(ticket.id),
      ...(ticket.number == null ? {} : { COORDINATOR_NUMBER: String(ticket.number) }),
      ...(shared ? { COORDINATOR_SHARED_DIR: shared } : {}),
    };
  }

  /** citadel-heavy's slots (#325), in the projects folder every person's container mounts at the same path, and who a job runs for. */
  private heavyEnv(ticket: TicketFields, person: number | null): Record<string, string> {
    const payer = person ? this.store.getUser(person)?.login : undefined;
    const who = `${this.store.getProject(ticket.project_id)?.name ?? '?'} #${ticket.number}${payer ? ` (${payer})` : ''}`;
    // One Gradle build cache for every worktree (#1153, src/build-cache.ts).
    return { CARGO_BUILD_JOBS: TURN_BUILD_JOBS, CITADEL_HEAVY_DIR: join(this.dataDir, 'projects', '.heavy'), CITADEL_HEAVY_WHO: who, CITADEL_GRADLE_CACHE: gradleCacheDir(this.dataDir) };
  }

  /** How many turns run in this container now (it isn't restarted under them). */
  inContainer(container: string): number {
    return [...this.turns.values()].filter((t) => t.container === container).length;
  }
  /** A message (not an fyi notice) came for a minion: a handed-off land then leaves it open (server.ts, src/land.ts). */
  onMessage?: (ticketId: number) => void;
  /** Other children of this server a restart would kill: landings that fell back to a child (src/land.ts), contraption turns, app deploys, ultra reviews. */
  hostJobs?: () => number;
  /** Why a message can't start or steer a turn (src/access.ts turnRefusal), or null when it can. */
  refuseTurn?: (ticket: Ticket, author: string, from?: number, asker?: number | null) => string | null;
  /** The person a message speaks for: its author, or for a relay (`from`), the sending turn's person. */
  personOf?: (author: string, from?: number) => number | null;
  /** A turn's GitHub env and prompt line for its person (src/github-link.ts forTurn); null with linking not set up. */
  githubFor?: (person: number | null, turnDir: string, later?: boolean) => TurnGithub | null;
  /** The secrets a turn of `project` running as `person` gets (src/secrets.ts, #838): its env vars, and the values its output hides. */
  secretsFor?: (project: number, person: number | null) => Map<string, string>;
  /** Minions whose turn is launching (startTurn), and whether stop() was asked for meanwhile (#1808). */
  private launching = new Map<number, { stopped: boolean; keepalive?: true }>();
  /** Each running turn's secrets, read once per turn (or once after a restart, on its next line). */
  private turnSecrets = new Map<number, Map<string, string>>();
  /** Minions with a keepalive asked for by keepaliveSweep, waiting for their lane (#862); a real message goes first and drops it. */
  private keepalivePending = new Map<number, number>(); // → the sweep's clock less the runner's, for its re-check
  /** Minions running a keepalive turn now: its stream is costed, never shown. */
  private keepalives = new Set<number>();
  /** The contraptions' key folders (server.ts sets the live one's). */
  contraptionKeys = DEFAULT_CONTRAPTIONS_DIR;

  /**
   * What the Citadel scheme's Taskmaster may read in every scheme (#656): only on a turn a Citadel member or admin
   * asked for (isAdmin, as host_check's database read): git in other schemes' folders, the contraptions' folders and
   * other schemes' minions. The data folder's files (every scheme's) are readable on any Taskmaster turn, as before.
   * Other schemes' worktrees get git rules only for open minions: all of them would be ~30k rules.
   */
  everySchemeFor(project: Project, ticket: Ticket, asker: number | null): EveryScheme | null {
    if (ticket.kind !== 'coordinator' || project.id !== GLOBAL_OWNER || asker === null || !this.store.isAdmin(this.store.getUser(asker))) return null;
    const others = this.store.listProjects().filter((p) => p.id !== project.id && p.repo_dir);
    return {
      gitDirs: [
        ...new Set(
          others.flatMap((p) => [
            p.repo_dir!,
            ...this.store
              .listTickets(p.id)
              .filter((t) => t.status !== 'closed' && t.cwd)
              .map((t) => t.cwd!),
          ]),
        ),
      ],
      // The folder is a link into its two slots (#801): rules match the path read, so both are listed.
      apps: this.store.listContraptions().flatMap((c) => [appFolder(c, homedir()), slotsOf(appFolder(c, homedir()))]),
      data: dirname(this.store.path),
      keysDir: this.contraptionKeys,
    };
  }
  /** Called when a turn fails (not when someone stops it), with the error shown in the chat and its event, if it has one. */
  onTurnError: (ticketId: number, text: string, eventId?: number) => void = () => {};
  /** A running turn passed a spend stage (#723): push it to the usual people and the turn's person. */
  onSpendAlert: (ticketId: number, text: string, eventId: number, person: number | null) => void = () => {};
  /** Each running turn's spend meter, by the turn's start (a new turn starts a new one). */
  private spends = new Map<number, { startedAt: number; meter: SpendMeter; prior: number; budget: Budget | null }>();
  private killWaves: KillWaves;
  /** A minion passed four times its budget (#1114): the server tells its Taskmaster. */
  onBudgetWake: (ticketId: number, text: string) => void = () => {};
  /** A minion past 10x its budget (#1672): the server posts this card to its owner. */
  onBudgetCard: (ticketId: number, question: ReturnType<typeof budgetCard>) => void = () => {};
  /** Applies a turn's status trailer (src/status-trailer.ts) as set_thread_status would; the server wires it to the PATCH route's checks. */
  onStatusTrailer: (ticketId: number, fields: StatusFields) => void = () => {};
  /** The running turn's last status trailer, applied when its result comes in. */
  private statuses = new Map<number, StatusFields>();

  constructor(store: Store, broadcast: Broadcast, coordinatorEnv: CoordinatorEnv, claudeBin = 'claude') {
    this.store = store;
    this.killWaves = new KillWaves(store);
    const self = this;
    this.resumes = new Resumes({
      store,
      get resumeGapMs() {
        return self.resumeGapMs;
      },
      get limitDelayMs() {
        return self.limitDelayMs;
      },
      get limitGapMs() {
        return self.limitGapMs;
      },
      get limitProvenGapMs() {
        return self.limitProvenGapMs;
      },
      get netProbe() {
        return self.netProbe;
      },
      get netProbeMs() {
        return self.netProbeMs;
      },
      get netProbeMaxMs() {
        return self.netProbeMaxMs;
      },
      get killStarved() {
        return self.killStarved;
      },
      get killHoldMaxMs() {
        return self.killHoldMaxMs;
      },
      get detached() {
        return self.detached;
      },
      limitStarting: this.limitStarting,
      killStarted: this.killStarted,
      isRunning: (id) => self.isRunning(id),
      resume: (id, via, retries, onCodex) => self.resume(id, via, retries, onCodex),
      killResumeFailed: (id) => self.killResumeFailed(id),
      lined: (id) => self.turnLine.has(id),
    });
    this.broadcast = broadcast;
    // Saved queues and waits from before #1378 move into each minion's one queue on the first boot, never dropped.
    const moved = migrateQueues(store);
    if (moved) console.log(`Moved ${moved} minions' saved messages into their queues (#1378).`);
    this.queue = new MinionQueue(store);
    this.urgent = new Urgent(store, (ids) => {
      this.turnLine.reordered();
      this.lineChanged(ids);
    });
    this.startNow = new StartNow({ store, over: (id) => holdOver(store.getTicket(id), (t) => this.parked(t) && !this.turnLine.has(id) && !this.lanes.busy(id)), changed: (ids) => this.lineChanged(ids), now: () => this.now() });
    this.places = new LinePlaces({ store, urgent: this.urgent, chains: () => this.chains(), now: () => this.now() });
    this.turnLine = new TurnLine({
      store,
      exempt: (id) => (store.getTicket(id)?.kind ?? 'coordinator') === 'coordinator',
      busy: (id) => this.lanes.busy(id),
      asks: (id, via) => this.lineAsks(id, via),
      forced: (id) => this.startNow.get(id),
      start: (entry) => this.startLined(entry),
      pauseTurn: (id) => this.pauseTurn(id),
      changed: (ids) => this.lineChanged(ids),
      carded: () => this.cardWaits.all().flatMap((k) => (k.answer || !this.store.getTicket(k.ticket) ? [] : [{ ticket: k.ticket, person: k.person ?? 0 }])),
      get gapMs() {
        return self.resumeGapMs;
      },
      get detached() {
        return self.detached;
      },
    });
    this.approvals = new Approvals(
      (ticketId, kind, data) => {
        this.emit(ticketId, kind, data);
        this.lendWorker(ticketId);
        // The threads list shows which threads are waiting on an approval.
        this.broadcastTicket(ticketId);
      },
      { get: (p) => store.getSetting<Go[]>(goesKey(p)) ?? [], set: (p, goes) => store.setSetting(goesKey(p), goes) },
    );
    this.cardWaits = keptCards(store);
    this.approvals.keptAnswered = (id, card, allow, by) => this.cardAnswered(id, card, allow, by);
    this.approvals.usePass = (id, call) => {
      const pass = this.store.getSetting<TurnState>(turnKey(id))?.pass;
      if (!pass) return null;
      this.saveTurn(id, { pass: undefined });
      return sameCall(pass.call, call) ? pass : null;
    };
    this.relays = new Relay({
      store,
      approvals: this.approvals,
      emit: (id, kind, data, reserved) => this.emit(id, kind, data, reserved),
      now: () => this.now(),
      isRunning: (id) => this.isRunning(id),
      send: (id, author, text, images, extra, steer) => this.send(id, author, text, images, extra, steer),
      personOf: () => this.personOf,
      broadcastTicket: (id) => this.broadcastTicket(id),
      parked: (t) => this.parked(t),
      hold: (id, msg, coldAt) => this.queue.hold(id, msg, coldAt),
    });
    this.held = new HeldMail({
      store,
      queue: this.queue,
      relays: this.relays,
      lanes: this.lanes,
      now: () => this.now(),
      noTurns: () => this.noTurns,
      heldFor: (id) => this.heldFor(id),
      emit: (id, kind, data) => this.emit(id, kind, data),
      broadcastTicket: (id) => this.broadcastTicket(id),
      isRunning: (id) => this.isRunning(id),
      dropDisabled: (id) => this.dropDisabled(id),
      refused: (id, person) => this.refused(id, person),
      turnPerson: (t, p, waiting) => this.turnPerson(t, p, waiting),
      next: (id, now) => this.next(id, now),
      send: (id, author, text, images, extra, steer) => this.send(id, author, text, images, extra, steer),
    });
    this.keepaliveRun = new KeepaliveRun({
      store,
      now: () => this.now(),
      noTurns: () => this.noTurns,
      queued: (id) => this.queued(id),
      limitWait: (id) => this.limitWait(id),
      netWait: (id) => this.netWait(id),
      killWait: (id) => this.killWait(id),
      parked: (t) => this.parked(t),
      next: (id) => this.next(id),
      queue: this.queue,
      jobs: () => this.jobs,
      turnLine: this.turnLine,
      turns: this.turns,
      keepalivePending: this.keepalivePending,
      gateCounted: this.gateCounted,
      statuses: this.statuses,
      closing: this.closing,
      deployedMidTurn: this.deployedMidTurn,
      waiting: (id) => this.waiting(id),
      turnPerson: (t, p, waiting) => this.turnPerson(t, p, waiting),
      codexTurn: (t, p, person) => this.codexTurn(t, p, person),
      accountOf: (t, person) => this.accountOf(t, person),
      payerOf: (uid) => this.payerOf(uid),
      leaveMail: (to, author, text) => this.leaveMail(to, author, text),
      actOnDeferred: (id, closing, reason, deployed) => this.actOnDeferred(id, closing, reason, deployed),
      saveAfterTurn: (id, dir, had) => this.saveAfterTurn(id, dir, had),
    });
    this.fresh = new Fresh({
      store,
      now: () => this.now(),
      noTurns: () => this.noTurns,
      queued: (id) => this.queued(id),
      limitWait: (id) => this.limitWait(id),
      netWait: (id) => this.netWait(id),
      killWait: (id) => this.killWait(id),
      parked: (t) => this.parked(t),
      next: (id) => this.next(id),
      lanes: this.lanes,
      closing: this.closing,
      emit: (id, kind, data) => this.emit(id, kind, data),
      isRunning: (id) => this.isRunning(id),
      broadcastTicket: (id) => this.broadcastTicket(id),
      send: (id, author, text, images, extra) => this.send(id, author, text, images, extra),
      view: (...args) => this.view(...args),
      tellCitadel: (text) => this.keepaliveRun.tellCitadel(text),
    });
    this.coordinatorEnv = coordinatorEnv;
    this.claudeBin = claudeBin;
    // Messages that arrived while a step ran start a turn once the minion's lane is free.
    this.lanes.onIdle = (ticketId) => {
      this.next(ticketId);
      this.turnLine.pump();
    };
    this.turnsDir = join(dirname(store.path), 'run', 'turns');
    this.dataDir = resolve(dirname(store.path));
    this.cleanup = new DismissedCleanup({ store, dataDir: this.dataDir, turns: this.turns, lanes: this.lanes, emit: (id, kind, data) => this.emit(id, kind, data) });
    this.closer = new Closing({
      store,
      queue: this.queue,
      lanes: this.lanes,
      turnLine: this.turnLine,
      urgent: this.urgent,
      places: this.places,
      resumes: this.resumes,
      approvals: this.approvals,
      turns: this.turns,
      closing: this.closing,
      deployedMidTurn: this.deployedMidTurn,
      emit: (id, kind, data) => this.emit(id, kind, data),
      broadcast: (msg) => this.broadcast(msg),
      broadcastTicket: (id) => this.broadcastTicket(id),
      setStatus: (id, status) => this.setStatus(id, status),
      saveTurn: (id, patch) => this.saveTurn(id, patch),
      isRunning: (id) => this.isRunning(id),
      queued: (id) => this.queued(id),
      heldFor: (id) => this.heldFor(id),
      send: (id, author, text, images, extra, steer) => this.send(id, author, text, images, extra, steer),
      leaveMail: (to, author, text) => this.leaveMail(to, author, text),
      dropCard: (id, reason) => this.dropCard(id, reason),
      forgetMaps: (id) => this.forgetMaps(id),
      tmpRoot: (projectId) => this.tmpRoot(projectId),
      onClose: (id) => this.onClose(id),
      endStartNow: (id) => this.startNow.end(id),
      clearBuild: (t) => this.cleanup.clearBuild(t),
      restoreDir: (t, p) => this.restoreDir(t, p),
      cardLinks: (t) => this.cardLinks(t),
      ciHold: (id) => this.ciHold?.(id),
      probeHold: (id) => this.probeHold?.(id),
    });
    this.promptHolds = new Holds(store);
    this.unitTag = createHash('sha256').update(this.turnsDir).digest('hex').slice(0, 8);
  }

  /**
   * Where a scheme's minions keep their TMPDIRs (src/turn-tmp.ts): on disk, not the shared /tmp tmpfs,
   * and inside the scheme's own folder, which the tripwire lets its minions write.
   */
  tmpRoot(projectId: number): string {
    return join(projectDir(this.dataDir, projectId), 'tmp');
  }

  /** Run `step` on the minion's lane (src/lanes.ts): after a turn of its running now and that turn's save, before its next turn. */
  onLane(ticketId: number, what: string, step: () => unknown): Promise<void> {
    return this.lanes.run(ticketId, what, step);
  }

  /** The stuck list for a Taskmaster's turn (src/stuck-list.ts), or null; a fault in it never stops the turn. */
  stuckText(taskmaster: Ticket): string | null {
    try {
      return stuckList(this.store, this, taskmaster);
    } catch (err) {
      console.error(`Taskmaster ${taskmaster.id}: its stuck list could not be built:`, err);
      return null;
    }
  }

  /** Turns running now (the Status page's answer-time window records it). */
  runningCount(): number {
    return this.turns.size;
  }

  /** The minions whose turns are running now (src/reader-live.ts: what they last did changes with no broadcast). */
  runningIds(): number[] {
    return [...this.turns.keys()];
  }

  /** Whether a turn of its runs, or one is owed: messages or a worker it waits for, or a cut-off turn to carry on, after its approval card too (#1930). */
  busy(ticketId: number): boolean {
    const waits = this.limitWait(ticketId) || this.netWait(ticketId) || this.killWait(ticketId) || cardHeld(this.store, ticketId);
    return !!waits || this.isRunning(ticketId) || this.strayWaits.has(ticketId) || this.turnLine.has(ticketId) || this.queue.size(ticketId) > 0 || !!this.queue.get(ticketId).owed;
  }

  /** A turn launching (startTurn, #1808) counts: it is past the queue's take, so a message now waits for it as for a live one. */
  isRunning(ticketId: number): boolean {
    return this.turns.has(ticketId) || this.launching.has(ticketId);
  }

  /** How often a start waiting on a turn this server doesn't follow checks whether its wrapper has gone (#1464). */
  strayPollMs = 5_000;

  /** Minions whose next turn waits for a turn nothing here follows to end (liveTurn): their queue starts once it has. */
  private strayWaits = new Set<number>();

  /**
   * One live turn per minion (#1464): what a lane step that would start a turn of `ticketId` returns instead, or null
   * when no turn runs. The turn this server follows holds the lane until it ends. One whose wrapper still runs in its
   * folder though nothing follows it (#1284's first turn, after a second replaced it here), checked against /proc
   * (wrapperAlive) and not only this server's map or the database, frees the lane at once, so a dismissal or a sweep
   * isn't stuck behind a wrapper that may never exit; the queue waits and starts once that wrapper is gone.
   */
  private liveTurn(ticketId: number, none: () => unknown): unknown {
    const followed = this.turns.get(ticketId);
    if (followed) return followed.ended;
    if (this.strayWaits.has(ticketId)) return Promise.resolve();
    // Only a folder the last server left can hold a stray (recover noted them): a turn launches with no read of
    // the turns folder on the server's thread (#1808), and nothing between the queue's take and the send.
    if (!this.strays.has(ticketId)) return none();
    // Checked off the thread; it counts as launching meanwhile (isRunning), so a message sent now rides along.
    const mark = { stopped: false };
    this.launching.set(ticketId, mark);
    const done = () => void (this.launching.get(ticketId) === mark && this.launching.delete(ticketId));
    return this.strayTurnDir(ticketId)
      .then((stray) => (mark.stopped ? undefined : stray ? (done(), this.waitStray(ticketId, stray)) : none()))
      .finally(done);
  }

  /** Free the lane, and ask again once the stray turn in `stray` has ended. */
  private waitStray(ticketId: number, stray: string): Promise<void> {
    console.error(`Minion ${ticketId}: a turn nothing here follows still runs in ${stray}; its next turn waits for it to end (#1464).`);
    this.strayWaits.add(ticketId);
    const check = () => {
      if (wrapperAlive(stray) && !existsSync(join(stray, 'exit.json'))) return void setTimeout(check, this.strayPollMs).unref();
      this.strayWaits.delete(ticketId);
      this.next(ticketId);
    };
    setTimeout(check, this.strayPollMs).unref();
    return Promise.resolve();
  }

  /** Folders the last server left, by minion, that had no exit.json at boot (noteStrays): where a stray turn can be. */
  private strays = new Map<number, string[]>();

  /** Note the turn folders (<minion>-<ms>, host or container) with no exit.json at boot: a turn launched since is followed. */
  private noteStrays() {
    this.strays.clear();
    try {
      const dirs = readdirSync(this.turnsDir).flatMap((name) => {
        const dir = join(this.turnsDir, name);
        return /^person-\d+$/.test(name) ? readdirSync(dir).map((n) => join(dir, n)) : [dir];
      });
      for (const d of dirs) {
        if (!/^\d+-\d+$/.test(basename(d)) || existsSync(join(d, 'exit.json'))) continue;
        const id = Number(basename(d).split('-')[0]);
        this.strays.set(id, [...(this.strays.get(id) ?? []), d]);
      }
    } catch {
      // No turns yet.
    }
  }

  /** One of `ticketId`'s folders from noteStrays whose wrapper is alive (and hasn't written its exit) though this server follows none. */
  private async strayTurnDir(ticketId: number): Promise<string | null> {
    const live: string[] = [];
    for (const d of this.strays.get(ticketId) ?? []) {
      if (await exists(join(d, 'exit.json'))) continue;
      // shortcut: wrapperAlive's reads are sync, but only a folder the last server left still there gets them; make it async if strays become common.
      if (wrapperAlive(d) === true) live.push(d);
    }
    // One that has ended is never a stray again.
    if (live.length) this.strays.set(ticketId, live);
    else this.strays.delete(ticketId);
    return live[0] ?? null;
  }

  /** The message ids each of these minions would take into its next turn, a usage-limit wait's too (they wait in its queue, #1378), read only (the standing checks, #1415). */
  queuedIds(ticketIds: number[]): Record<number, number[]> {
    return Object.fromEntries(ticketIds.map((id) => [id, this.peekQueue(id).flatMap((m) => m.id ?? [])]).filter(([, ids]) => (ids as number[]).length));
  }

  /** gh's env for a lookup the server makes for a running turn (#200): the GitHub login that turn runs as; null with no turn. */
  turnGithubEnv(ticketId: number): Record<string, string> | null {
    const live = this.turns.get(ticketId);
    if (!live) return null;
    const person = this.store.getSetting<TurnState>(turnKey(ticketId))?.person ?? null;
    return { ...turnEnv(process.env), ...this.githubFor?.(person, live.dir)?.env };
  }

  /** Running work a restart of this server would kill: turns not in a unit or a container of their own, and other server children (hostJobs). */
  interruptible(): number {
    return [...this.turns.values()].filter((t) => !runningTurn(t).outlivesServer).length + (this.hostJobs?.() ?? 0);
  }

  /** The minions whose turns interruptible() counts (#584), by id: deploy.sh names them from the database, since /api/health answers without a login. */
  interruptibleTurns(): number[] {
    return [...this.turns].filter(([, t]) => !runningTurn(t).outlivesServer).map(([id]) => id);
  }

  /** Stop following turns, for a server shutting down; they keep running, and the next server re-attaches. */
  detachAll() {
    // The next server probes for the threads waiting on the network, and resumes the killed turns waiting for theirs.
    this.resumes.stop();
    this.turnLine.stop();
    this.detached = true;
    for (const t of this.turns.values()) {
      clearInterval(t.timer);
      this.unfollow(t);
      this.clock.clearTimeout(t.stopTimer);
      this.clock.clearTimeout(t.stopGraceTimer);
    }
    this.turns.clear();
  }

  queued(ticketId: number): number {
    return this.queue.size(ticketId);
  }

  /** Whether the minion's next turn still carries event `eventId`: queued or held mail, waits included, all in its one queue (the outbox, #1385; #1378). */
  holds(ticketId: number, eventId: number): boolean {
    return this.peekQueue(ticketId).some((m) => m.id === eventId);
  }

  /**
   * view() for a list's rows (#1029): what rows share (the scheme, the waits, the people) is read once, and every
   * row's properties in one query. Read per row, Citadel's ~1,000 dismissed minions held the server 0.4 s a page load.
   */
  views(tickets: Ticket[]) {
    // In one read scope (src/read-scope.ts, #1527): what every row reads per minion comes in one query per kind, and what
    // they all read (the chains, the waits, the people) is read once, so the count stops growing with the list.
    return readScope(this.store.db, () => {
      const memo = new Map<string, unknown>();
      const once = <T>(key: string, read: () => T): T => (memo.has(key) ? memo.get(key) : (memo.set(key, read()), memo.get(key))) as T;
      const ids = tickets.map((t) => t.id);
      const properties = this.store.props.forTargets('minion', ids);
      const open = tickets.filter((t) => t.status !== 'closed');
      this.store.warmSettings(tickets.flatMap((t) => [queueKey(t.id), previewKey(t.id), contextKey(t.id), windowKey(t.id), freshKey(t.id), sleepKey(t.id), budgetKey(t.id), startHoldKey(t.id)]));
      this.store.warmTurnTotals(ids);
      this.store.warmTouches(open);
      this.store.warmEvents(open.flatMap((t) => this.queue.heldMail(t.id).flatMap((m) => m.id ?? [])));
      for (const pid of new Set(open.map((t) => t.project_id)))
        this.store.warmOpenCards(
          pid,
          open.filter((t) => t.project_id === pid).map((t) => t.id),
        );
      return tickets.map((t) => this.view(t, { once, properties: properties.get(t.id)! }));
    });
  }

  /**
   * What view() reads from this thread's memory and the server's hooks, not the database (#1590): the one list of
   * them. The server posts each minion's copy to the reader threads (onLive, src/reader-live.ts), and a reader's
   * view() runs on that copy, so a field added here reaches the readers by itself; one read from memory anywhere
   * else in view() makes a reader's view throw, which sends the request to the main thread.
   */
  live(ticket: Ticket, ratio?: number) {
    const closed = ticket.status === 'closed';
    ratio ??= closed ? 1 : this.stepRatio(ticket.project_id);
    // A dismissed minion's row shows no steps, so its task list isn't rebuilt from its whole history for a
    // scheme's list: after a restart that read every dismissed minion's events, 16 s for 500 of them (#527).
    const p = closed ? null : this.progressFor(ticket.id);
    const { total, done } = p ? stepInfo(p) : { total: 0, done: 0 };
    // The running step's start and guessed seconds, so the list row's bar fills as the chat head's does (#573).
    const est = p && ticket.status === 'running' ? planEstimate(p, true, Date.now(), ratio) : null;
    return {
      // Whether a turn of its own is running, which view() reports as its status (#1618): a hidden keepalive is not
      // one of those (it never shows as running, above), and a dismissed minion has nothing live.
      // A launching turn's token is minted already (#1808): it counts, unless it's a keepalive's.
      turn_live: !closed && (this.turns.has(ticket.id) ? !this.keepalives.has(ticket.id) : !!this.launching.get(ticket.id) && !this.launching.get(ticket.id)!.keepalive),
      // Its turn waits for a worker (#1868): it shows as working, and its activity line says where it stands.
      worker_wait: closed ? null : this.turnLine.wait(ticket.id),
      // Who marked it Urgent, when and why (#1888).
      urgent: closed ? null : this.urgent.view(ticket.id),
      start_now: closed ? null : this.startNow.view(ticket.id),
      // What steps took against their guesses (#571), which both bars scale the guesses by: the one ratio steps.usual used.
      step_ratio: ratio,
      steps: total ? { done, total, ...(est && { since: est.since, usual: est.usual }) } : null,
      // The plan's segmented track for the list row (#630): each step's guess and whether it's done, underway or not started.
      step_track: total ? planTrack(p!) : null,
      closing: this.closing.has(ticket.id),
      // When the running turn started, so the page's timer needn't wait for the turn's first event.
      turnStartedAt: this.turnStartedAt(ticket.id),
      // What the running turn last did and whether it has gone quiet (#906): the chip's popover says so.
      activity: this.activityOf(ticket.id),
      // The running turn's unanswered spend alert (#723), for the list row's badge.
      spend_alert: this.spendAlert(ticket),
      approvals: this.approvals.waiting(ticket.id),
      // Its approval cards waiting on people, which open_cards lists among its stored cards.
      asks: closed
        ? []
        : this.approvals
            .pending()
            .filter((a) => a.ticketId === ticket.id)
            .map(({ at, card }) => ({ at, card })),
      // Sealed on start_after: what it waits for, for Start now.
      parked_for: this.heldFor(ticket.id),
      // Waiting on its start card (#1757): not sealed, not working either; its card is the person's to answer.
      start_hold: closed ? null : this.startHold(ticket.id),
      held_brief: closed ? null : this.heldBrief(ticket.id),
      // What wakes it by itself (start_after, wake_when_live, runners back): the list shows such a sealed minion as Waiting, not Sealed.
      wakes_on: ticket.state === 'parked' ? this.wakesOn(ticket.id) : null,
      // Everything it waits for, timed or on an event, for the list row's chip (ADR 0021 step 7).
      outbox_waits: closed ? [] : this.outboxWaits(ticket),
      ship: this.ship(ticket.id),
      wait: closed ? null : this.wait(ticket.id),
      // The server working for it while its own turn has ended (#727): the list and chat show it as working.
      server_work: closed ? null : this.serverWork(ticket.id),
      // The chat's size meter (#1193): the context as of the turn's latest API call (so it moves mid-turn and drops after a compaction), against the model's window.
      context_live: this.turns.has(ticket.id) ? (this.contextSizes.get(ticket.id) ?? null) : null,
      running_cost: this.turns.has(ticket.id) ? (this.store.getSetting<TurnState>(turnKey(ticket.id))?.spend?.usd ?? 0) : 0, // #1913: the running turn's estimate, not yet in `cost`
      // The running turn's compactions so far, beside the meter (#1920).
      compactions: this.turns.has(ticket.id) ? this.compactWatch.of(ticket.id) : null,
    };
  }

  /** Each view's live() on the main thread, for the readers' copy (src/reader-live.ts). */
  onLive: (ticketId: number, live: ReturnType<Runner['live']>) => void = () => {};

  /** A ticket as the API shows it: plus queued messages and its task-list steps. */
  view(ticket: Ticket, list?: { once: <T>(key: string, read: () => T) => T; properties: Record<string, string | number | string[]> }) {
    const once = list?.once ?? (<T>(_key: string, read: () => T) => read());
    const project = once(`project:${ticket.project_id}`, () => this.store.getProject(ticket.project_id));
    const limit = once(LIMIT_RESUMES, () => this.resumes.limit.all()).find((w) => w.ticket === ticket.id) ?? null;
    const closed = ticket.status === 'closed';
    // What steps took against their guesses (#571), which both bars scale the guesses by.
    const ratio = closed ? 1 : once(`ratio:${ticket.project_id}`, () => this.stepRatio(ticket.project_id));
    const live = this.live(ticket, ratio);
    this.onLive(ticket.id, live);
    const { asks, ...shown } = live;
    const cards = closed ? [] : this.store.openCardsOf(ticket.id);
    // Who is still in the scheme and their names, read once per list (#1449).
    const props = list?.properties ?? this.store.props.forTarget('minion', ticket.id);
    const user = (id: number) => once(`user:${id}`, () => this.store.getUser(id));
    const hears = (id: number, pid: number) => once(`hears:${id}:${pid}`, () => this.store.hearsScheme(id, pid, user(id)));
    const nameOf = (id: number | null) => (id == null ? null : (user(id)?.name ?? null));
    return {
      // A wait's held messages stay in the queue (src/minion-queue.ts): they go into its resume.
      ...ticket,
      replies: ticket.replies ? (JSON.parse(ticket.replies) as string[]) : [],
      queued: this.queued(ticket.id),
      held_ids: this.queue.heldMail(ticket.id).flatMap((m) => m.id ?? []),
      queued_ids: this.queue.msgs(ticket.id).flatMap((m) => m.id ?? []),
      ...shown,
      // The status from the live turn and the row together, never the row alone: the row's write waits in the queue
      // (src/db-writer.ts), so under load this called a minion idle whose turn had already started -- and a turn's
      // token, minted at that start, is the only one that still works, so anything acting on "idle, nothing queued"
      // got 401s from it (#1618). Combined here, not in live(), so a reader's own fresh row still has the say once the
      // turn has ended (its copy of live() is posted on each broadcast, src/reader-live.ts).
      status: shown.turn_live || shown.worker_wait ? 'running' : ticket.status,
      // Messages the loop guard holds for a person's Continue (#1067), for the row's badge and the chat's held-mail card.
      loop_hold: closed ? null : (once('loop-holds', () => loopHolds(this.store)).get(ticket.id) ?? null),
      held_mail: this.heldMail(ticket),
      // When it resumes by itself after the usage limit, if it waits for that.
      limit_resume_at: limit?.at ?? null,
      // With several accounts all limited, each one's reset (#819), for the banner.
      limit_accounts: limit?.accounts ?? null,
      // When its oldest question or plan card still waiting on a person was posted.
      pending_card_at: cards[0]?.created_at ?? null,
      // Its cards waiting on people with the links that open them, for read_ticket and list_tickets (#400).
      open_cards: this.cardLinks(ticket, false, cards, asks),
      properties: props,
      // Who touched it and hasn't left (#919): their Taskmasters hear its updates; the page offers them Leave.
      touched: ticket.kind === 'ticket' && !closed ? this.store.touchedBy(ticket, props, hears) : [],
      // Whose its cards are (#1449: the owner's once its assignee left the scheme), as push and Needs you count it; null for anyone's.
      assignee: ticket.kind === 'ticket' ? nameOf(this.store.minionPerson(ticket, 'assigned', props, hears)) : null,
      preview: !!this.store.getSetting(previewKey(ticket.id)),
      // Asleep (#1636): when and who, for the header's Wake, the list's moon and list_tickets; a Taskmaster never sleeps.
      asleep: closed || ticket.kind !== 'ticket' ? null : this.store.getSetting<Sleep>(sleepKey(ticket.id)),
      // What its turns have cost so far, at API prices.
      cost: this.store.ticketCost(ticket.id),
      // What its kind of work usually costs and its two marks (#1114), for the minion page's "$X of about $Y".
      budget: ticket.kind === 'ticket' && !closed ? this.budgetView(ticket, list?.properties) : null,
      // The server login's part of it, the share of its weekly limit the minions list shows (#468 S05-3).
      host_cost: this.store.ticketCost(ticket.id, true),
      // Whose Claude plan its last turn ran on (the minion's chip), and what re-reading its context costs a new payer.
      payer: once(`payer:${ticket.person_id}`, () => this.payerView(ticket.person_id, user)),
      context_tokens: this.store.getSetting<number>(contextKey(ticket.id)),
      context_window: this.store.getSetting<number>(windowKey(ticket.id)) ?? guessWindow(ticket.model || ticket.last_model),
      // When its last turn ended, for the composer's cold-wake hint (#413).
      last_turn_end: this.store.lastTurnEnd(ticket.id),
      // A Taskmaster's fresh start under way (#406), which hides the chat's Fresh session button.
      fresh_pending: !!this.store.getSetting<FreshState>(freshKey(ticket.id)),
      // What "Default" means in the composer: the effort a turn gets when the ticket has none of its own.
      default_effort: turnSettings({ ...ticket, effort: null }, project ?? { default_effort: '' }).effort,
      // What the composer's Plugins picker offers (#361): the scheme's optional plugin folders, for a minion.
      optional_plugin_dirs: ticket.kind === 'coordinator' ? [] : lines(project?.optional_plugin_dirs),
    };
  }

  // Dismissing a minion, what keeps it open, and its claims: src/closing.ts.

  holderShipped(ticketId: number) {
    return this.closer.holderShipped(ticketId);
  }

  claimPassed(projectId: number, passed: ({ from: Claim; to?: Claim } | { from?: undefined; to: Claim })[], why: string, author: string) {
    return this.closer.claimPassed(projectId, passed, why, author);
  }

  close(ticketId: number, text: string): Promise<void> {
    return this.closer.close(ticketId, text);
  }

  closedCleanup(ticketId: number, keepHeld = false) {
    return this.closer.closedCleanup(ticketId, keepHeld);
  }

  reopened(ticketId: number): Promise<void> {
    return this.closer.reopened(ticketId);
  }

  deployLive(ticketId: number): boolean {
    return this.closer.deployLive(ticketId);
  }

  personWrote(ticketId: number) {
    return this.closer.personWrote(ticketId);
  }

  deployPending(ticketId: number) {
    return this.closer.deployPending(ticketId);
  }

  keptOpen(ticketId: number, atCall = false): string | null {
    return this.closer.keptOpen(ticketId, atCall);
  }

  ciGreen(ticketId: number, text: string) {
    return this.closer.ciGreen(ticketId, text);
  }

  closeAfterTurn(ticketId: number, reason: string | null): boolean {
    return this.closer.closeAfterTurn(ticketId, reason);
  }

  closeIfSeen(ticketId: number, name: string): boolean {
    return this.closer.closeIfSeen(ticketId, name);
  }

  closeCancelled(ticketId: number, byOther = false): string | null {
    return this.closer.closeCancelled(ticketId, byOther);
  }

  /** True once an hour per account-error text; texts older than that hour are forgotten, so the map stays small. */
  firstAccountPush(text: string, now = Date.now()): boolean {
    const hour = 60 * 60 * 1000;
    for (const [k, at] of this.accountPushes) if (now - at > hour) this.accountPushes.delete(k);
    if (this.accountPushes.has(text)) return false;
    this.accountPushes.set(text, now);
    return true;
  }

  /** A closed minion's entries in the per-minion caches; each is rebuilt or set again if it is reopened (runner-turn-maps.test.ts says how). */
  forgetMaps(ticketId: number) {
    this.progress.delete(ticketId);
    this.mainModels.delete(ticketId);
    this.gateCounted.delete(ticketId);
    this.contextSizes.delete(ticketId);
    this.contextShown.delete(ticketId);
  }

  /** Clear dismissed minions' build output (src/dismissed-cleanup.ts): at boot and daily. */
  sweepBuildOutput() {
    return this.cleanup.sweepBuildOutput();
  }

  /**
   * The chat's last few entries before this turn's messages, oldest first, for a fresh session that lost its old one
   * (#899): people's messages and the minion's replies, each as `[author]: text`.
   */
  private chatDigest(ticketId: number, batch: QueuedMessage[]): string[] {
    const asked = new Set(batch.map((m) => m.text));
    const out: string[] = [];
    for (const e of this.store.chatTextEvents(ticketId, 0, LOST_DIGEST_ENTRIES + batch.length + 20).reverse()) {
      const d: ClaudeEvent & { text?: string; author?: string } = JSON.parse(e.data);
      if (e.kind === 'user_message' && typeof d.text === 'string' && !asked.has(d.text)) out.push(`[${d.author}]: ${d.text}`);
      else if (e.kind === 'claude') {
        const text = ((d.message?.content ?? []) as ContentBlock[])
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n');
        if (text.trim()) out.push(`[You]: ${text}`);
      }
      if (out.length === LOST_DIGEST_ENTRIES) break;
    }
    return out.reverse();
  }

  private restoreDir(ticket: Ticket, project: Project) {
    this.cleanup.restoreDir(ticket, project);
  }

  /** Remove dismissed minions' worktrees and leftover Grunt worktrees (src/dismissed-cleanup.ts): at boot and daily. */
  sweepWorktrees(now = Date.now()) {
    return this.cleanup.sweepWorktrees(now);
  }

  /**
   * The boot sweep's copy of an idle minion's session into the database (nothing pruned): on its lane,
   * so a turn that a message starts meanwhile waits for it. Null when the lane is busy (a turn runs).
   * A dismissed minion is skipped: its last turn's save has its state, and putting back rows the nightly
   * prune deleted, from the files still on disk, undid the prune on every boot (#1486).
   */
  saveIdleSession(ticketId: number, configDir: string): Promise<void> | null {
    if (this.lanes.busy(ticketId)) return null;
    return track(
      'session saves',
      this.lanes.run(ticketId, 'session sweep', () => {
        const ticket = this.store.getTicket(ticketId);
        const project = ticket && this.store.getProject(ticket.project_id);
        if (ticket?.session_id && ticket.status !== 'closed' && project) return this.saveSession(this.store, ticket, project, configDir, null);
      }),
    );
  }

  /**
   * #1074: why CI health keeps this minion open (a red's fix minion, until its workflow is green on the default branch
   * again), or null. Set by the server; CI health's ciGreen lets it go.
   */
  ciHold?: (ticketId: number) => string | null;

  /** #1741: true when this minion's live probe still has to run (LiveProbes.hold, which runs it and holds its dismissal). Set by the server. */
  probeHold?: (ticketId: number) => boolean;

  /**
   * After a server restart: re-attach to turns still running in their units (or that ended while the
   * server was down), and catch up on their output. Turns whose process died too were cut off: mark
   * them, and resume them a few seconds apart unless they were stopped, set to close, or already
   * resumed MAX_RESUMES times in a row. Messages queued behind a cut-off turn go into its resume (or,
   * for one not resumed, into a turn of their own). A turn that failed (the usage limit included)
   * ended before the restart, so it isn't 'running'.
   */
  recover() {
    // Up before the first turn, so it doesn't start in a wrapper for want of one (a deploy brings a new version).
    if (this.supervisor) ensureSupervisor(this.supervisorSpec());
    // Before any turn starts below: a turn the last server left running may still run in its folder (#1464).
    this.noteStrays();
    this.unsealStartHolds();
    // Taskmasters' starts; a minion's takes its place in the line (#1868).
    const later: (() => void)[] = [];
    this.turnLine.close();
    const start = (t: Ticket, via?: RetryKind, retries?: Retries) => {
      if (t.kind === 'coordinator') return void later.push(() => (via ? this.resume(t.id, via, retries!) : !this.isRunning(t.id) && this.next(t.id)));
      // A saved wait's messages go into its resume.
      if (via || !(this.limitWait(t.id) || this.netWait(t.id) || this.killWait(t.id) || cardHeld(this.store, t.id))) this.turnLine.enter(t.id, via);
    };
    this.restoreCards();
    for (const p of this.store.listProjects()) {
      for (const t of this.store.listTickets(p.id)) {
        // A minion dismissed with messages still in its queue: its chat says so. Its held mail stays: mail sent after a
        // dismissal waits for a reopen (#783). Read one by one: a key listing doesn't see the boot migration's rows
        // still queued on the write worker.
        if (t.status === 'closed' && Object.keys(this.queue.get(t.id)).some((k) => k !== 'held')) this.closedCleanup(t.id, true);
        // A keepalive cut off by a restart (#862) is dropped, not resumed: the next sweep sends another if it is still due.
        // What waited behind it waits for the save below, or starts a turn.
        const kept = t.status !== 'running' ? this.store.getSetting<TurnState>(turnKey(t.id)) : null;
        if (kept?.keepalive) {
          this.store.deleteSetting(turnKey(t.id));
          // Its unit outlives the server; killed first (pid.json is in its folder) so it can't race the next real turn on the session.
          if (kept.dir) this.signal({ dir: kept.dir, unit: kept.unit ?? null, container: kept.container ?? null }, 'SIGKILL');
          if (kept.dir) rmSync(kept.dir, { recursive: true, force: true });
        }
        // A save the last server didn't finish: redone first on the lane, from the config dir its turn used.
        const saving = this.store.getSetting<{ configDir: string }>(savingKey(t.id));
        if (saving) this.lanes.run(t.id, 'session save cut off by a restart', () => this.saveAfterTurn(t.id, saving.configDir, null));
        // A turn saved but not yet shown as running when the last server died (#1364) counts as cut off too.
        const cut = t.status === 'running' || (!!kept && !kept.keepalive);
        const owed = !cut && t.status !== 'closed' ? this.queue.owed(t.id) : undefined;
        if (!cut && t.status !== 'closed') {
          // A batch taken by a turn that never got as far as running (the server died in its start) goes back.
          if (!saving && this.queue.get(t.id).taken) this.queue.giveBack(t.id);
          // Messages that waited (for that save, say) start a turn once it is in; an owed resume takes them instead:
          // one turn, not a plain one and then the resume.
          if (!owed && this.queue.size(t.id)) start(t);
        }
        if (owed) {
          this.carryIn(t.id, owed.carry);
          start(t, owed.onAccount ? 'switch' : 'restart', owedRetries(owed));
        }
        if (cut) {
          let turn = this.store.getSetting<TurnState>(turnKey(t.id));
          // What the turn set and reads later (#1452): kept for a re-attached turn's end, or the resume that carries it on.
          if (turn?.from) this.turnFrom.set(t.id, turn.from);
          if (turn?.parkedAs) this.parkedAs.set(t.id, turn.parkedAs);
          // This turn's waiting cards come back: if it is still running, it still polls for them (#209).
          this.approvals.restore(t.id, this.store.eventsOfKinds(t.id, ['approval', 'approval_result']), turn?.startedAt);
          try {
            if (turn?.dir && this.reattach(t.id, turn)) continue;
          } catch (err) {
            console.error(`Ticket ${t.id}: could not re-attach to its turn, so it counts as interrupted:`, err);
          }
          // Its turn is gone, so nobody's click can count for them now.
          this.approvals.endTurn(t.id, 'The server restarted while this waited.');
          // Read again: a vanished turn's stream, read by reattach, may have saved its result and trailer (2A1).
          turn = this.store.getSetting<TurnState>(turnKey(t.id)) ?? turn;
          // Its trailer, as last saved: only its resume's end applies it.
          const status = turn?.status;
          this.statuses.delete(t.id);
          // With its record gone (a crash after the resume was owed), the owed resume's carry stands.
          const carry = turn ? { ...(turn.from ? { from: turn.from } : {}), ...(turn.parkedAs ? { parkedAs: turn.parkedAs } : {}), ...(status ? { status } : {}) } : (this.queue.owed(t.id)?.carry ?? {});
          // Steers it never passed on go back to the queue.
          this.queue.endSteers(t.id, turn?.dir ? unsentSteers({ steered: this.queue.steers(t.id), dir: turn.dir }) : []);
          // A line read, or output it never read, says claude had its prompt (#1364): that turn resumes with its batch.
          // One cut off before claude wrote a line may never have had it, so its batch goes back and runs again as a
          // plain turn, not a resume of a session that may lack it. Not a stopped turn's batch (the stop dropped it),
          // nor one whose turn ended and owes only its save.
          let wrote = !!turn?.offset;
          try {
            wrote ||= !!turn?.dir && statSync(join(turn.dir, 'stream.jsonl')).size > (turn.offset ?? 0);
          } catch {
            /* no stream: it never began */
          }
          const back = !turn?.stopped && !saving && !wrote;
          const rerun = back && !!this.queue.get(t.id).taken?.length;
          if (back) this.queue.giveBack(t.id, false, true);
          // The same rows as a watched turn's end (src/turn-outcome.ts), under the restart's own cap.
          const out = outcome({ turn, exit: null, stderr: [], closing: false, ran: { unit: false, container: false }, cut: { rerun } });
          const resumed = out.kind !== 'stopped' && !out.followUps.includes('rerun') ? out.retry : undefined;
          // Owed before the turn's record goes, so a crash between finds one of them, with what the resume carries on (#1452).
          // A kill resume's count rides along (RETRIES), so a kill after the restart still counts as the second in a row.
          if (resumed) this.queue.owe(t.id, { ...owedOf(resumed.via, resumed.retries), ...(out.kind === 'paused' ? { paused: true } : {}), ...(Object.keys(carry).length ? { carry } : {}) });
          this.store.deleteSetting(turnKey(t.id));
          this.keepKilled(t.id, turn, null);
          if (turn?.dir) rmSync(turn.dir, { recursive: true, force: true });
          this.setStatus(t.id, 'idle');
          // Stopped on purpose: it already says so, and no resume. What was queued before the stop went with it;
          // what came after waits for a turn of its own.
          if (out.kind === 'stopped' || out.kind === 'card') {
            this.queue.done(t.id);
            if (this.queue.size(t.id)) start(t);
            continue;
          }
          if (out.followUps.includes('rerun')) {
            start(t);
            continue;
          }
          if (!resumed) {
            const skipped = out.spent ? `It was not resumed: it had already been resumed ${out.spent.tries} times in a row.` : turn?.result && !turn.result.error ? 'Its reply was already in, so it was not resumed.' : 'It was set to be dismissed, so it was not resumed.';
            this.emit(t.id, 'note', { text: `The server restarted during this turn, so it was interrupted. ${skipped}` });
            this.queue.done(t.id);
            if (this.queue.size(t.id)) start(t);
          } else {
            this.carryIn(t.id, carry);
            start(t, resumed.via, resumed.retries);
          }
        }
        if (/^Using \w+$/.test(t.last_activity ?? '')) {
          // Reword lines saved before activity was described in plain words.
          const events = this.store.listEvents(t.id);
          for (let i = events.length - 1; i >= 0; i--) {
            const activity = events[i].kind === 'claude' ? describeActivity(JSON.parse(events[i].data)) : null;
            if (activity) {
              this.store.setLastActivity(t.id, activity);
              break;
            }
          }
        }
      }
    }
    later.forEach((start, i) => setTimeout(start, this.resumeGapMs * (i + 1)));
    this.turnLine.open(this.resumeGapMs);
    // Minions waiting on the usage limit keep waiting; the messages held for them wait in their queues.
    this.resumes.armLimitTimer();
    // Threads waiting on the network keep waiting: the probe starts over (#366).
    this.resumes.armNetProbe();
    // Killed turns waiting for their resume take their turns in the line again (#1364).
    this.resumes.armKillResumes();
    // Folders of turns nobody follows any more and whose process is gone.
    try {
      const followed = new Set([...this.turns.values()].map((t) => t.dir));
      // Container turns' folders sit one deeper, in their person's folder (ClaudeLink.turnsDir). Only what startTurn
      // names (<minion>-<ms>) is this sweep's: ultra reviews' clones (#508) and Codex reviews' folders sit there too,
      // are their own code's to clear, and may be in use across a restart.
      const dirs = readdirSync(this.turnsDir).flatMap((name) => {
        const dir = join(this.turnsDir, name);
        return (/^person-\d+$/.test(name) ? readdirSync(dir).map((n) => join(dir, n)) : [dir]).filter((d) => /^\d+-\d+$/.test(basename(d)));
      });
      // Gone for sure: its wrapper's pid is dead, or it never wrote one in the time a start takes. Not knowing isn't enough (#259).
      const gone = (dir: string) => {
        const alive = wrapperAlive(dir); // once: a stale heartbeat reads all of /proc
        return alive === false || (alive === null && Date.now() - statSync(dir).mtimeMs > START_GRACE_MS);
      };
      for (const dir of dirs) if (!followed.has(dir) && gone(dir)) void dropTurnDir(dir);
      void sweepDroppedTurnDirs(this.turnsDir); // a crash mid-delete (#1459)
    } catch {
      // No turns yet.
    }
    // Temp folders of minions dismissed or deleted while no server watched (or whose clearing failed).
    try {
      const gone = readdirSync(join(this.dataDir, 'projects'))
        .filter((name) => /^\d+$/.test(name))
        .flatMap((name) => {
          // Removed only on proof: the minion was dismissed, or its folder sits in another scheme's root. A
          // minion the database doesn't know (a restored backup, say) keeps its folder (#259).
          const keep = (id: number) => {
            const t = this.store.getTicket(id);
            return !t || this.turns.has(id) || this.lanes.busy(id) || (t.project_id === Number(name) && t.status !== 'closed');
          };
          return sweepTmpDirs(this.tmpRoot(Number(name)), keep);
        });
      if (gone.length) console.log(`Cleared the temp folders of ${gone.length} dismissed or deleted minion${gone.length === 1 ? '' : 's'}.`);
    } catch (err) {
      if (thrown(err).code !== 'ENOENT') console.error(`Could not sweep the temp folders: ${thrown(err).message}`);
    }
  }

  /** Follow a turn a previous server started, if it still runs or ended while no server watched it. */
  private reattach(ticketId: number, turn: TurnState): boolean {
    if (!runningTurn({ dir: turn.dir!, unit: turn.unit ?? null, container: turn.container ?? null }).reattachable()) return false;
    // Before following: what it wrote while no server read it may hold its result, which applies the trailer.
    if (turn.status) this.statuses.set(ticketId, turn.status);
    if (turn.sentBack) this.sentBack.add(ticketId);
    const live = this.follow(ticketId, turn);
    if (this.gone(live)) {
      // What it wrote while no server read it reaches the chat before recovery deletes its folder, as poll's does (C8, #1406).
      this.readStream(ticketId, live, true);
      clearInterval(live.timer);
      this.unfollow(live);
      this.turns.delete(ticketId);
      this.compactWatch.ended(ticketId);
      return false;
    }
    if ('closing' in turn) this.closing.set(ticketId, turn.closing ?? null);
    if (turn.deployed) this.deployedMidTurn.add(ticketId);
    // The calls it had open, in what the chat kept of this turn.
    for (const e of this.store.eventsOfKinds(ticketId, ['claude'], this.store.lastTurnEvent(ticketId))) if (e.created_at >= live.startedAt) noteCalls(live.calls, JSON.parse(e.data));
    this.lanes.run(ticketId, 're-attached turn', () =>
      this.turnLine.reattach(ticketId, () => {
        this.lendWorker(ticketId);
        return live.ended;
      }),
    );
    if (turn.card) this.endLive(live, ticketId);
    const { where } = runningTurn(live);
    console.log(`Ticket ${ticketId}: re-attached to its running turn${where ? ` in ${where}` : ''}.`);
    return true;
  }

  /** The shared turn supervisor for this server's pinned code (#1343). */
  private supervisorSpec(): SupervisorSpec {
    return (this.supSpec ??= supervisorSpec(this.turnsDir, this.unitTag, turnPins()));
  }

  /**
   * A turn handed to the supervisor whose shell isn't running yet, started in its wrapper unit instead when the
   * supervisor gave it back (its scope wouldn't start) or lost it (it died between taking the turn and starting it: its
   * claimed spec is left, its pid dead). Not a fallback: the wrapper unit has the turn's slice and limits, and a unit
   * that won't start is counted there (start). Armed too after a hand-off that timed out, as the supervisor may have
   * taken the turn after all, leaving the wrapper started meanwhile nothing to run.
   */
  private rescue(ticketId: number, live: LiveTurn, started: boolean) {
    if (!live.restart) return;
    const dir = live.dir;
    if (started) {
      live.restart = undefined;
      return;
    }
    let why: string | null = null;
    try {
      why = readFileSync(join(dir, 'handback'), 'utf8');
      rmSync(join(dir, 'handback'), { force: true });
    } catch {
      /* not given back */
    }
    if (why !== null) console.error(`Ticket ${ticketId}: its scope from the turn supervisor didn't start (${why}); it starts in its wrapper unit.`);
    else {
      // Nothing still names the folder: a systemd-run the dead supervisor left starting the turn's scope would run it yet.
      const lost = readdirSync(dir).find((n) => /^spec\.json\.\d+$/.test(n) && !alive(Number(n.slice(10))));
      if (!lost || argInProc(dir)) return;
      renameSync(join(dir, lost), join(dir, 'spec.json'));
    }
    const restart = live.restart;
    live.restart = undefined;
    restart();
  }

  /** Whether a followed turn's process may still be running: started, or still starting. */
  private running(live: LiveTurn): boolean {
    return runningTurn(live).alive() ?? Date.now() - live.startedAt < START_GRACE_MS;
  }

  /** A followed turn's process ended without writing exit.json. Liveness goes first: the wrapper writes exit.json, then exits. */
  private gone(live: LiveTurn): boolean {
    return !this.running(live) && !existsSync(join(live.dir, 'exit.json'));
  }

  /**
   * Start an auto-resume turn of kind `via` (a restart, a kill, the usage limit, a network outage, an account switch),
   * its turn starting with `retries`, with any messages that were queued behind the cut-off one.
   */
  private resume(ticketId: number, via: RetryKind, retries: Retries, onCodex = false): Promise<void> | undefined {
    const killLine = via === 'kill';
    const paused = !!this.queue.owed(ticketId)?.paused;
    // One limitResumeNext started: its wait stays saved until the turn takes it (startTurn), or this ends it below.
    const token = this.limitStarting.get(ticketId);
    const ours = () => !!token && this.limitStarting.get(ticketId) === token;
    // Someone's message got in first; its turn took the queue, and that is resume enough.
    if (this.isRunning(ticketId)) return void (ours() && this.resumes.cancelLimitWait(ticketId));
    // No worker free: it waits in the line, its wait or debt kept, and startLined starts it (#1868).
    if (!this.turnLine.enter(ticketId, via)) return;
    // After the last turn's save, if that is still under way: no turn here starts before it is in (#259). Nor beside a
    // turn still live by then (#1464): as above, that turn is resume enough.
    const step = () =>
      this.liveTurn(ticketId, () =>
        this.afterRestore(
          ticketId,
          (ticket, project) => this.turnPerson(ticket, project, this.waiting(ticketId), true),
          () => {
            const ticket = this.store.getTicket(ticketId);
            const project = ticket && this.store.getProject(ticket.project_id);
            if (!ticket || !project || ticket.status === 'closed') {
              if (killLine) this.resumes.cancelKillWait(ticketId);
              return this.queue.owe(ticketId, null);
            }
            // A network resume needs its wait still there: a person's message, a stop or an earlier resume took it.
            if (via === 'net' && !this.netWait(ticketId)) return;
            // So does one from the kill line (#1364).
            if (killLine && !this.killWait(ticketId)) return;
            // So does a limit resume: a stop or a person's message (which tries now) ended it meanwhile.
            if (token && !ours()) return;
            this.dropDisabled(ticketId);
            const person = this.turnPerson(ticket, project, this.waiting(ticketId), true);
            if (this.refused(ticketId, person)) {
              // Nothing it would have carried is dropped: the queue and held mail wait for the next turn (#468 S03-6).
              // A kill wait ends here, as the turn that would have taken it.
              if (killLine) this.resumes.cancelKillWait(ticketId);
              this.queue.owe(ticketId, null);
              return;
            }
            // An account switch's note went with the turn that stopped (endFailed); a kill resume's with the kill (one line).
            if (via !== 'switch' && !killLine)
              this.emit(ticketId, 'note', { text: onCodex ? 'Resumed on Codex: its person switched to Codex' : via === 'limit' ? 'Resumed after the usage limit reset' : via === 'net' ? 'Resumed after a network outage' : paused ? 'Resumed after the pause' : 'Resumed after a server restart' });
            const carriesOn = !this.queue.wakes(ticketId);
            // It carries on the interrupted turn, so it runs for that turn's person.
            return this.ranTurn(
              this.startTurn(
                project,
                ticket,
                [{ author: 'System', text: onCodex ? RESUME_CODEX_PROMPT : via === 'switch' ? RESUME_ACCOUNT_PROMPT : via === 'limit' ? RESUME_LIMIT_PROMPT : via === 'net' ? RESUME_NET_PROMPT : killLine ? RESUME_KILL_PROMPT : paused ? RESUME_PAUSE_PROMPT : RESUME_PROMPT, images: [] }, ...this.takeQueue(ticketId)],
                person,
                retries,
                carriesOn,
              ),
            );
          },
        ),
      );
    const ran = this.lanes.run(ticketId, 'resume', () => this.turnLine.hold(ticketId, step));
    // One that started no turn (dismissed, refused, a start that bailed) ends its wait here, as it did before it was kept.
    if (token) void ran.then(() => ours() && this.resumes.cancelLimitWait(ticketId));
    return ran;
  }

  /**
   * Run a lane's turn step once the minion's stored session is back in the config dir its turn will use
   * (restoreAhead: on a worker thread, as a 60 MB transcript held the event loop for seconds, #612). With nothing
   * to restore, as on most turns, the step runs at once, so a turn still counts as running as soon as it starts.
   * startTurn's own restore stays: it finds the files in place, and retries and reports a restore that failed here.
   * `person` guesses whose turn it is; a wrong guess only leaves the work to startTurn's restore.
   */
  private afterRestore(ticketId: number, person: (ticket: Ticket, project: Project) => number | null, step: () => unknown): unknown {
    let ahead: Promise<number> | null = null;
    try {
      const ticket = this.noTurns ? undefined : this.store.getTicket(ticketId);
      const project = ticket && this.store.getProject(ticket.project_id);
      // Nothing stored, nothing to restore: no need to ask whose Claude it runs on.
      if (ticket && project && ticket.status !== 'closed' && (this.store.listClaudeState(project.id, ticket.id).length || this.store.listClaudeState(project.id, null).length)) {
        const place = this.placeFor?.(person(ticket, project), warmKey(ticket)) ?? { host: true as const };
        if (!('refused' in place)) ahead = restoreAhead(this.store, ticket, project, place.host ? (place.configDir ?? claudeConfigDir(process.env)) : place.configDir);
      }
    } catch (err) {
      // The turn's start meets the same trouble itself, and says so.
      console.error(`Ticket ${ticketId}: could not check its session files before the turn: ${thrown(err).message}`);
    }
    if (!ahead) return step();
    return ahead
      .then(
        (n) => n && console.log(`Ticket ${ticketId}: restored the Claude session from the database off the event loop (${n} file${n === 1 ? '' : 's'}).`),
        (err) => console.error(`Ticket ${ticketId}: restoring the session off the event loop failed, so the turn's start tries again: ${err.message}`),
      )
      .then(() => {
        // Dismissed meanwhile, which a running turn would have refused: no turn; the dismissal's cleanup notes the queue.
        if (this.store.getTicket(ticketId)?.status !== 'closed') return step();
      });
  }

  /** What takeQueue would take, left where it is. */
  private peekQueue(ticketId: number): QueuedMessage[] {
    return this.queue.peek(ticketId);
  }

  /** The same, as what would wake the turn and the held mail riding along (turnPayer reads them apart, #1509). */
  private waiting(ticketId: number): { msgs: QueuedMessage[]; held: QueuedMessage[] } {
    return { msgs: this.queue.msgs(ticketId), held: this.queue.heldMail(ticketId) };
  }

  /**
   * A disabled person's own messages, queued or held, go with a chat line saying so (#1509): kept, they would pick
   * that person to pay for every later batch and refuse it, and no one else's login may run them (#1270 C3).
   */
  private dropDisabled(ticketId: number): number {
    const gone = this.queue.dropWhere(ticketId, (m) => !!disabledAuthor(this.store, m));
    for (const name of new Set(gone.map((m) => m.author))) {
      const n = gone.filter((m) => m.author === name).length;
      this.emit(ticketId, 'note', { text: `${name}'s login is disabled, so ${n === 1 ? 'their waiting message was' : `their ${n} waiting messages were`} dropped and Claude hasn't seen ${n === 1 ? 'it' : 'them'}.` });
    }
    if (gone.length) this.broadcastTicket(ticketId);
    return gone.length;
  }

  /** Whether `person`'s Claude can't run a turn now (Runner.placeFor); the chat says why. Asked before the queue is taken. */
  private refused(ticketId: number, person: number | null): boolean {
    const place = this.noTurns ? null : this.placeFor?.(person);
    if (!place || !('refused' in place)) return false;
    this.emit(ticketId, 'note', { text: place.refused });
    this.broadcastTicket(ticketId);
    return true;
  }

  /**
   * Everything queued for the minion's next turn, which starts now: it moves into the queue's taken batch (src/minion-queue.ts)
   * until the turn is durably done. A network or kill wait ends with it; held mail rides along after what woke the turn,
   * so the turn is still that message's.
   */
  private takeQueue(ticketId: number): QueuedMessage[] {
    this.wakeNow.delete(ticketId);
    this.resumes.cancelNetWait(ticketId);
    this.resumes.cancelKillWait(ticketId);
    this.carryIn(ticketId, { from: this.cardWaits.get(ticketId)?.from });
    return this.queue.take(ticketId);
  }

  /** The thread's network wait, if it has one. */
  netWait(ticketId: number): NetResume | null {
    return this.resumes.netWait(ticketId);
  }

  /** The minion's wait for its resume after a kill (#1364), if it has one. */
  killWait(ticketId: number): KillResume | null {
    return this.resumes.killWait(ticketId);
  }

  /**
   * A turn killed from outside joins the line of kill resumes, holding the messages queued behind it. One chat line says
   * so; no push: a kill wave costs minutes, not messages (#1364).
   */
  private waitForKillResume(ticketId: number, live: LiveTurn, retries: Retries, killed: string) {
    // What is left of it goes first: a claude whose wrapper alone was killed (no unit) would race its resume on the session.
    this.signal(live, 'SIGKILL');
    this.resumes.putKill(ticketId, retries);
    this.emit(ticketId, 'note', { text: `${killed}\nCitadel resumes it by itself in a moment, once: killed again, it stops for good. Messages queued behind it go into that resume.` });
    this.store.updateTicket(ticketId, { note: KILL_NOTE });
    this.resumes.armKillResumes();
  }

  /** A kill resume's start threw and its wait is gone: it stops with an error, and its held messages run next as a normal turn. */
  private killResumeFailed(ticketId: number) {
    const held = this.queue.size(ticketId);
    const text = `Its resume after the kill failed to start, so it stopped: ${held ? 'the messages queued behind it run next.' : 'send a message to carry on.'}`;
    const event = this.emit(ticketId, 'error', { text });
    this.setFailNote(ticketId, { note: 'Kill resume failed to start' });
    this.onTurnError(ticketId, text, event.id);
    // As a message arriving now would: next() leaves them for a busy lane and runs them on a free one.
    if (held) this.next(ticketId);
  }

  /** The minion's usage-limit wait, if it has one. */
  limitWait(ticketId: number): LimitResume | null {
    return this.resumes.limitWait(ticketId);
  }

  // Tests drive the limit line by hand.
  private limitResumeNext() {
    this.resumes.limitResumeNext();
  }
  private armLimitTimer() {
    this.resumes.armLimitTimer();
  }

  /** Stop waiting on the usage limit (a stop, a dismissal); true if it was waiting. */
  cancelLimitWait(ticketId: number): boolean {
    return this.resumes.cancelLimitWait(ticketId);
  }

  /**
   * A Claude turn on `payer`'s plan got through, so its limit has gone, whatever reset time Claude gave
   * (a reset, an upgrade, extra usage): every minion waiting on it resumes now, limitGapMs apart, and so
   * do those that gave up waiting (#477). Not one a person stopped: that waits for a message. Nor one whose
   * next turn runs on Codex (a Codex pick or its person's override): Claude working says nothing about Codex's limit.
   * Nor, when one turn's success is the proof (`model`, its model), one on another model: a cap on that model alone
   * would fail it again, and one that gave up would be revived, fail and push again on every success.
   */
  private limitCleared(payer: number | null, model?: string | null) {
    const list = this.resumes.limit.all();
    const gaveUp = this.store.limitedTickets().filter((t: Ticket) => t.status === 'error' && t.note?.startsWith('Usage limit: gave up') && !list.some((w) => w.ticket === t.id) && !this.isRunning(t.id));
    if (!list.length && !gaveUp.length) return;
    const onPlan = (id: number) => {
      const t = this.store.getTicket(id);
      const project = t && this.store.getProject(t.project_id);
      if (!t || !project) return false;
      const person = this.turnPerson(t, project, [], true);
      const its = turnSettings(t, project).model;
      const codex = isCodexModel(its) || (person !== null && !!this.store.getSetting<boolean>(codexSwitchKey(person)));
      return !codex && this.payerOf(person) === payer && (model === undefined || its === model);
    };
    const now = Date.now();
    const early = list.filter((w) => w.at > now && !w.codex && onPlan(w.ticket));
    for (const w of early) {
      w.at = now;
      w.proven = true;
    }
    const back = gaveUp.filter((t: Ticket) => onPlan(t.id)).map((t) => ({ ticket: t.id, at: now, tries: 1, proven: true as const }));
    if (early.length || back.length) this.resumes.saveLimits([...list, ...back]);
  }

  /** A cut-off turn's values (OwedResume.carry), back in memory for the resume that carries the turn on (#1452). */
  private carryIn(ticketId: number, carry: OwedResume['carry']) {
    if (carry?.from) this.turnFrom.set(ticketId, carry.from);
    if (carry?.parkedAs) this.parkedAs.set(ticketId, carry.parkedAs as { state: TicketState | null; note: string | null });
    if (carry?.status) this.statuses.set(ticketId, carry.status as StatusFields);
  }

  /** A running turn that only waits on approval cards has no worker until one is answered (#1916). */
  private lendWorker(ticketId: number) {
    const live = this.turns.get(ticketId);
    // A process ending for its card reads as having no call left, and stays without its worker.
    if (live) this.turnLine.setLent(ticketId, !!live.card || cardWait(live.calls, this.approvals.cards(ticketId)) !== 'working');
  }

  /**
   * Turns that have waited out their hold on one approval card, with nothing of theirs running, give their process back too. Josh, 2026-11-24:
   * "why cant we fully free a minion waiting on a card and then just resume it when the card is answered?" The card is kept; its answer resumes them.
   */
  endCardWaits(short: boolean, now = this.now()) {
    for (const [ticketId, live] of this.turns) {
      const cards = this.approvals.cards(ticketId);
      if (cardWait(live.calls, cards) !== 'end' || live.unread || live.card) continue;
      const [card] = cards;
      const ticket = this.store.getTicket(ticketId);
      const turn = this.store.getSetting<TurnState>(turnKey(ticketId));
      if (!ticket || !turn || ticket.kind === 'coordinator' || turn.stopped || turn.paused || turn.result || turn.fresh || turn.keepalive || turn.codex || turn.closing !== undefined) continue;
      const person = turn.person ?? null;
      if (now - card.at < (short || this.turnLine.stalledFor(person ?? 0) ? 0 : CARD_HOLD_MS)) continue;
      const call = callOf(card, ticket.cwd);
      // A person's words queued behind this turn stay there, as before #1916: the next turn's are theirs.
      if (!call || this.queue.msgs(ticketId).some((m) => m.own && !m.from)) continue;
      this.cardWaits.put({ ticket: ticketId, id: card.id, call, person, ...(turn.from ? { from: turn.from } : {}), at: card.at });
      this.approvals.keep(card.id);
      this.saveTurn(ticketId, { card: true });
      live.card = true;
      this.emit(ticketId, 'note', { text: 'Still waiting on the card, so this turn ended to free its memory. It carries on when the card is answered.' });
      this.endLive(live, ticketId);
    }
  }

  /** A kept card's answer: the minion resumes with it, first in its queue. */
  private cardAnswered(ticketId: number, id: string, allow: boolean, by: string) {
    const kept = this.cardWaits.get(ticketId);
    if (kept?.id !== id) return;
    const answered: KeptCard = { ...kept, answer: { allow, by } };
    // Queued before the card is marked answered: a crash between the two queues it twice, never not at all (restoreCards).
    // shortcut: runs as the ended turn's person but without their own saved secrets, as every resume; keep secretPerson if one ever needs them.
    this.queue.put(ticketId, { author: 'System', text: answerPrompt(answered), images: [], asker: kept.person, card: id }, true);
    this.cardWaits.put(answered);
    if (!this.isRunning(ticketId)) this.next(ticketId, true);
    this.broadcastTicket(ticketId);
  }

  /** Forget a kept card, answered or not; an unanswered one expires. */
  private dropCard(ticketId: number, reason: string): KeptCard | null {
    const kept = this.cardWaits.take(ticketId);
    if (kept && !kept.answer) this.approvals.expire(kept.id, reason);
    return kept;
  }

  /** After a server restart: the kept cards wait on, and one answered as the last server died has its answer. */
  private restoreCards() {
    for (const kept of this.cardWaits.all()) {
      if (kept.answer) continue;
      const events = this.store.eventsOfKinds(kept.ticket, ['approval', 'approval_result']).filter((e) => JSON.parse(e.data).id === kept.id);
      const result = events.find((e) => e.kind === 'approval_result');
      this.approvals.restore(kept.ticket, events);
      this.approvals.keep(kept.id);
      // A crash between keeping the card and marking its turn: that turn still ends.
      const turn = this.store.getSetting<TurnState>(turnKey(kept.ticket));
      if (turn && !turn.card && (turn.startedAt ?? Infinity) <= kept.at) this.saveTurn(kept.ticket, { card: true });
      const { state, by } = result ? JSON.parse(result.data) : { state: 'pending' };
      if (state === 'allowed' || state === 'denied') this.cardAnswered(kept.ticket, kept.id, state === 'allowed', by);
      else if (state !== 'pending' || !events.length) this.cardWaits.take(kept.ticket);
    }
  }

  /** Merge into the saved state of a ticket's running turn. */
  private saveTurn(ticketId: number, patch: Partial<TurnState>) {
    const turn = this.store.getSetting<TurnState>(turnKey(ticketId)) ?? {};
    this.store.setSetting(turnKey(ticketId), { ...turn, ...patch });
  }

  /**
   * Record a user message and run it now, or, mid-turn, with `steer` pass it into the running turn
   * (Claude reads it between tool calls) or else queue it behind the turn.
   * `extra` is stored with the message for the UI (e.g. which question card it answers), not sent
   * to Claude; a comment's file (`extra.comment.about`) is, in its "[Name on file]:" prefix.
   * `extra.from` is the thread that sent a relayed message, so it can strike_text it later.
   */
  /**
   * `hold` (#718): a message from a person, the Taskmaster or another minion, which a sealed minion with no turn
   * running keeps for its next turn instead of starting one ('parked'). Wakes (wake_when_live, a chained start,
   * runners back, a card's answer, GitHub) leave it off and start a turn as before.
   */
  send(
    ticketId: number,
    author: string,
    text: string,
    images: MessageImage[] = [],
    extra: { comment?: { about: string; path?: string }; from?: number; typed?: boolean; asker?: number | null; fyi?: boolean; light?: boolean; hold?: boolean; brief?: boolean; everyone?: boolean; ask?: object; answer?: object } & object = {},
    steer = false,
    files: MessageFile[] = [],
  ): { event: EventRow; parked?: true } {
    // Whose ask it is, when that isn't its author's or relay's now: a contraption's person, or a held relay's asker.
    const { asker: askedBy, fyi, light, hold, ...shown } = extra;
    extra = shown;
    if (!fyi) this.onMessage?.(ticketId);
    const ticket = this.store.getTicket(ticketId);
    const refused = ticket && this.refuseTurn?.(ticket, author, extra.from, askedBy);
    if (refused) {
      const event = this.emit(ticketId, 'user_message', { author, text: hideTokens(text), ...(images.length ? { images: images.map((i) => i.name) } : {}), ...extra });
      this.emit(ticketId, 'note', { text: refused });
      return { event };
    }
    const live = this.turns.get(ticketId);
    const turn = live && this.store.getSetting<TurnState>(turnKey(ticketId));
    // A turn from before steering (no steer.jsonl) can't take one; nor can one whose reply is already out,
    // nor one run for someone else: that message waits for a turn of its own, as its sender.
    const person = this.personOf?.(author, extra.from) ?? null;
    const asker = askedBy !== undefined ? askedBy : person;
    // Nor one someone else asked for (#255): a non-member's relay runs as the owner, whose message waits.
    // Nor one typed for by someone else (#295): its process carries their CITADEL_PERSON_ID, which can't change mid-turn.
    const otherPerson = !!(person && turn && ((turn.person !== undefined && turn.person !== person) || (turn.asker !== undefined && turn.asker !== asker) || (extra.typed && turn.typedBy && turn.typedBy !== person)));
    // Nor a Taskmaster's fresh-start step: what's said now goes to the fresh session. Nor a stopped turn, still dying: it would drop it.
    // Nor a low-effort turn (#951) something other than a success notice: it waits for a turn at the minion's own effort.
    const steers = !!(steer && live && turn && !turn.result && !turn.fresh && !turn.keepalive && !turn.stopped && !turn.card && !otherPerson && !(turn.light && !light) && existsSync(join(live.dir, 'steer.jsonl')));
    // A minion waiting on its start card (#1674) holds everything, wakes and its chained brief too, until a person answers it.
    const parked = !!(!live && ticket && ((hold && this.parked(ticket)) || (!('answer' in extra) && this.store.getSetting(startHoldKey(ticketId)))));
    // A person's words to a minion waiting on a kept card stand in for its answer (#1916). A question card's answer isn't about it.
    const replied = person && !extra.from && !('answer' in extra) && cardHeld(this.store, ticketId) ? this.dropCard(ticketId, `${author} replied instead, so this was not run.`) : null;
    if (replied) this.queue.put(ticketId, { author: 'System', text: repliedPrompt(replied, author), images: [] });
    // The message goes into the queue (or steer file) first, then its chat line (#1378): a crash between the two leaves a
    // message the next turn reads, never a line in the chat that no turn gets. Its id is the line's, handed out now.
    // The chat shows it masked; the turn still gets it as typed, for a key someone hands over on purpose.
    const id = this.store.reserveEventId();
    const line = () =>
      this.emit(
        ticketId,
        'user_message',
        {
          author,
          text: hideTokens(text),
          ...(images.length ? { images: images.map((i) => i.name) } : {}),
          ...(files.length ? { files: files.map(({ name, size, type }) => ({ name, size, type })) } : {}),
          ...extra,
          ...(steers ? { steered: true } : {}),
          ...(parked ? { mail: true, parked: true, ...(this.store.getSetting(startHoldKey(ticketId)) ? { startHold: true } : {}) } : {}),
        },
        id,
      );
    const msg: QueuedMessage = {
      author,
      text,
      images,
      ...(files.length ? { files } : {}),
      about: extra.comment?.about,
      id,
      ...(extra.from ? { from: extra.from } : {}),
      ...(extra.typed ? { typed: true } : {}),
      ...(extra.typed || 'answer' in extra ? { own: true } : {}),
      ...(fyi ? { fyi: true } : {}),
      ...(light ? { light: true as const } : {}),
      asker,
    };
    if (parked) {
      // With the held mail, in order: whatever next wakes it (Unseal, a wake, its chained start) reads it after its own message.
      this.queue.hold(ticketId, { ...msg, parked: new Date(this.now()).toISOString().slice(0, 16).replace('T', ' ') });
      const row = line();
      this.heard(ticketId, ticket, msg);
      this.broadcastTicket(ticketId);
      return { event: row, parked: true };
    }
    if (steers) {
      const file = join(live!.dir, 'steer.jsonl');
      appendFileSync(file, promptMessage([msg]));
      // A typed steer is a message the turn now answers too; a second person's leaves it no one's (#268).
      const typedBy = msg.typed && person && !extra.from ? (turn!.typedBy == null || turn!.typedBy === person ? person : 0) : turn!.typedBy;
      this.queue.steered(ticketId, { end: statSync(file).size, msg });
      const row = line();
      this.heard(ticketId, ticket, msg);
      live!.unread = this.now();
      this.saveTurn(ticketId, { typedBy, unread: live!.unread });
      // A person steering in speaks after the relay, so what the turn starts now is theirs.
      if (person && !extra.from && this.turnFrom.delete(ticketId)) this.saveTurn(ticketId, { from: undefined });
      return { event: row };
    }
    const limited = !!(ticket && this.limitWait(ticketId));
    // Waiting on its payer's usage limit, a message on another plan carries on now (sender pays): first, so the turn is its sender's.
    const project = ticket && this.store.getProject(ticket.project_id);
    const otherPlan = !!(person && limited && project && this.payerOf(person) !== this.payerOf(this.turnPerson(ticket!, project, [], true)));
    this.queue.put(ticketId, msg, otherPlan);
    const row = line();
    this.heard(ticketId, ticket, msg);
    // A person's own message tries now too: the reset time is only Claude's word, and a reset can come sooner. Still limited, it waits again (#477).
    if (otherPlan || (limited && person && !extra.from)) this.resumes.cancelLimitWait(ticketId);
    if (!this.isRunning(ticketId)) {
      // A network or kill wait's held messages go with it, in a turn that starts now.
      this.next(ticketId, true);
      const wait = this.limitWait(ticketId);
      if (wait) {
        this.emit(ticketId, 'note', { text: `Held for the resume at ${clockTime(wait.at)}, after the usage limit resets.` });
        this.broadcastTicket(ticketId);
      }
      return { event: row };
    }
    this.broadcastTicket(ticketId);
    return { event: row };
  }

  /** What a message sent to a minion sets off once its line is in the chat: a go it quotes, and its one-tap replies cleared. */
  private heard(ticketId: number, ticket: Ticket | null | undefined, msg: QueuedMessage) {
    // A person's typed "merge it" stands for the whole scheme until its PR merges (#260), whenever a turn reads it.
    // In the Taskmaster chat "#N" names minion N (#939).
    if (ticket)
      this.approvals.said(ticket.project_id, { id: ticket.id, number: ticket.number, branch: ticket.branch }, msg, (n) => {
        const m = this.store.getTicketByNumber(ticket.project_id, n);
        return m ? { id: m.id, number: m.number, branch: m.branch } : null;
      });
    // Anything said answers the one-tap replies; a steer or a held message starts no turn to clear them.
    if (this.store.getTicket(ticketId)?.replies) {
      this.store.updateTicket(ticketId, { replies: null });
      this.broadcastTicket(ticketId);
    }
  }

  /** Take back a message still queued for the next turn; false once it has gone to Claude. */
  unqueue(ticketId: number, eventId: number, by: string): boolean {
    // A wait's held messages are in the queue too (#468 S03-9).
    if (!this.queue.remove(ticketId, eventId)) return false;
    if (!this.queue.size(ticketId) && !this.fresh.freshStep(ticketId)) this.turnLine.leave(ticketId, true);
    const projectId = this.store.getTicket(ticketId)?.project_id;
    if (projectId !== undefined) this.approvals.unsaid(projectId, eventId);
    this.emit(ticketId, 'unqueued', { id: eventId, by });
    this.broadcastTicket(ticketId);
    return true;
  }

  relay(minionId: number, to: number, author: string, text: string, urgent = false, wake = true, need?: string, sender?: number) {
    return this.relays.relay(minionId, to, author, text, urgent, wake, need, sender);
  }

  relayMinion(from: number, to: number, author: string, text: string, urgent = false, wake = true, unparked = false) {
    return this.relays.relayMinion(from, to, author, text, urgent, wake, unparked);
  }

  relayTaskmaster(from: number, to: number, author: string, text: string, wake = true, attached = '', urgent = false, need?: string) {
    return this.relays.relayTaskmaster(from, to, author, text, wake, attached, urgent, need);
  }

  leaveMail(to: number, author: string, text: string) {
    this.relays.leaveMail(to, author, text);
  }

  // Held mail, seals, sleep and start cards: src/held-mail.ts.

  parked(t: TicketFields): boolean {
    return this.held.parked(t);
  }

  startHold(ticketId: number): { usd: number } | null {
    return this.held.startHold(ticketId);
  }

  startHeld(ticketId: number, author: string, how: string) {
    return this.held.startHeld(ticketId, author, how);
  }

  unsealStartHolds(): number {
    return this.held.unsealStartHolds();
  }

  heldCount(ticketId: number): number {
    return this.held.heldCount(ticketId);
  }

  sleep(ticketId: number, by: string, asleep: boolean): boolean {
    return this.held.sleep(ticketId, by, asleep);
  }

  unpark(ticketId: number, by: string, author: string, quiet = false): boolean {
    return this.held.unpark(ticketId, by, author, quiet);
  }

  coldSweep(now = this.now()) {
    return this.held.coldSweep(now);
  }

  releaseMail(t: Ticket, p: Project, by = ''): number {
    return this.held.releaseMail(t, p, by);
  }

  strike(by: number, quote: string, reason: string): { ticketId: number } {
    return this.held.strike(by, quote, reason);
  }

  continueLoops(ticketIds: number[], by: string): number {
    return this.held.continueLoops(ticketIds, by);
  }

  continueLoop(ticketId: number, by: string): number {
    return this.held.continueLoop(ticketId, by);
  }

  /**
   * The mail waiting for this chat's next turn (#1067), for its inbox card: held as a fyi or wake: false, for a cold session,
   * or for a sealed one. `until` is when a cold hold's cap sends it anyway. Null when nothing waits.
   */
  heldMail(t: Ticket): { until: number | null; items: { id: number | null; author: string; from: number | null; need: string | null; note: boolean; parked: boolean; at: number; text: string }[] } | null {
    const { held: mail, coldAt: since } = this.queue.get(t.id);
    if (!mail?.length) return null;
    const p = this.store.getProject(t.project_id);
    return {
      until: since && p ? since + msgSettings(p).holdH * 3_600_000 : null,
      items: mail.map((m) => {
        const e = m.id ? this.store.getEvent(m.id) : undefined;
        const d = e ? JSON.parse(e.data) : {};
        // The chat event's text, its tokens hidden as the log shows them, not the queue's raw copy.
        const text: string = typeof d.text === 'string' ? d.text : hideTokens(m.text);
        return { id: m.id ?? null, author: d.author ?? m.author.replace(/^Held mail from |, sent .*$/g, ''), from: m.from ?? d.from ?? null, need: d.need ?? null, note: !!d.note, parked: !!d.parked, at: e?.created_at ?? 0, text: text.length > 600 ? `${text.slice(0, 600)}…` : text };
      }),
    };
  }

  /** Waiting on a person (an approval or a card): its silence is theirs, not the turn's. */
  private waitsOnPerson(ticketId: number) {
    return this.approvals.waiting(ticketId) || this.store.openCardAt(ticketId) !== null;
  }

  /** Since when the turn has been quiet (src/quiet.ts), or null. */
  private quietSince(ticketId: number, live: LiveTurn, now = Date.now()): number | null {
    if (this.waitsOnPerson(ticketId)) return null;
    const at = quietAt(live.activity);
    return now >= at ? at : null;
  }

  /** Save and show a turn going quiet or talking again: the list's chip and the requester's Needs you read it. */
  private checkQuiet(ticketId: number, live: LiveTurn, now = Date.now()) {
    // The quiet clock restarts once the person answers: a tool held for approval starts then.
    if (this.waitsOnPerson(ticketId)) live.activity = { at: now, tools: live.activity.tools.map((t) => ({ ...t, started: now })) };
    const since = this.quietSince(ticketId, live, now);
    const turn = this.store.getSetting<TurnState>(turnKey(ticketId));
    if (!turn || (turn.quiet ?? null) === since) return;
    this.saveTurn(ticketId, { quiet: since ?? undefined });
    this.broadcastTicket(ticketId);
  }

  /** What a running turn last did (#906): its last output, the longest-open tool call, and since when it's quiet. */
  activityOf(ticketId: number) {
    const live = this.turns.get(ticketId);
    if (!live) return null;
    const tool = longestTool(live.activity);
    return { at: live.activity.at, tool: tool && { name: tool.name, label: tool.label, started: tool.started, limit: tool.limit }, quiet_since: this.quietSince(ticketId, live) };
  }

  /** "Is this still going?" (#906): a look at the running turn's process, read from /proc; no message, no model call. */
  async checkTurn(ticketId: number): Promise<ProcCheck | null> {
    const live = this.turns.get(ticketId);
    if (!live) return null;
    return runningTurn(live).look();
  }

  /** When the running turn started, or null: what a spend card names to act on its own turn only (#723). */
  turnStartedAt(ticketId: number): number | null {
    return this.turns.get(ticketId)?.startedAt ?? null;
  }

  /** Where its running turn is and whose, for a job it starts (#1890), or why that turn can't start one. */
  jobTurn(ticketId: number): { container: string | null; person: number | null } | { refuse: string } {
    const live = this.turns.get(ticketId);
    const turn = this.store.getSetting<TurnState>(turnKey(ticketId));
    if (!live || !turn) return { refuse: 'No turn of this minion is running' };
    if (this.store.getTicket(ticketId)?.kind !== 'ticket' || turn.codex || turn.keepalive) return { refuse: "This turn's jobs end with it" };
    return { container: live.container, person: turn.person ?? null };
  }

  stop(ticketId: number): boolean {
    const jobs = this.jobs?.stop(ticketId) ?? false;
    const queued = this.queue.msgs(ticketId).filter((m) => m.id != null);
    const stopped = this.stopTurn(ticketId);
    // The stop dropped these from the queue: the outbox must not read that as a send that failed, and send them again.
    // The ones it had handed (a chain's brief) stay as held mail: they start nothing, and ride with the next turn someone starts.
    if (stopped && queued.length) {
      const keep = new Set(
        this.onStop(
          ticketId,
          queued.map((m) => m.id!),
        ),
      );
      for (const m of queued) if (keep.has(m.id!)) this.queue.hold(ticketId, m);
    }
    if (jobs && !stopped) this.emit(ticketId, 'note', { text: "Stopped by user, with the job it waited for: it won't be woken." });
    return stopped || jobs;
  }

  private stopTurn(ticketId: number): boolean {
    const live = this.turns.get(ticketId);
    const card = this.dropCard(ticketId, 'The turn was stopped while this waited.');
    const launching = this.launching.get(ticketId);
    if (!live && launching) {
      // Its launch is still writing its files (#1808): it starts no turn, and as with a turn, its queue goes too.
      launching.stopped = true;
      // A resume launching ends its wait too: it won't start now.
      this.resumes.cancelKillWait(ticketId);
      this.resumes.cancelNetWait(ticketId);
      this.resumes.cancelLimitWait(ticketId);
      this.queue.drop(ticketId);
      this.wakeNow.delete(ticketId);
      this.emit(ticketId, 'note', { text: 'Stopped by user.' });
      this.broadcastTicket(ticketId);
      return true;
    }
    if (!live) {
      const lined = this.turnLine.leave(ticketId);
      // Waiting for its resume after a kill (#1364): likewise.
      if (this.resumes.cancelKillWait(ticketId)) {
        this.queue.drop(ticketId);
        this.wakeNow.delete(ticketId);
        this.setFailNote(ticketId, { note: 'Killed: stopped, send a message to carry on' });
        this.emit(ticketId, 'note', { text: "Stopped by user: it won't resume by itself." });
        this.broadcastTicket(ticketId);
        return true;
      }
      // Waiting on the network: a stop ends the wait, and as with a turn, its held messages go too.
      if (this.resumes.cancelNetWait(ticketId)) {
        this.queue.drop(ticketId);
        this.wakeNow.delete(ticketId);
        this.setFailNote(ticketId, { note: 'Network outage: stopped, send a message to carry on' });
        this.emit(ticketId, 'note', { text: "Stopped by user: it won't resume by itself." });
        this.broadcastTicket(ticketId);
        return true;
      }
      // Waiting on the usage limit: a stop ends the wait, and as with a turn, its held messages go too.
      const limited = this.resumes.cancelLimitWait(ticketId);
      if (!limited && !lined && !card) return false;
      this.queue.drop(ticketId);
      if (!limited) {
        // Waiting for a worker (#1868): as a running turn's stop, and a cut-off one's batch is done with.
        this.queue.done(ticketId);
        this.wakeNow.delete(ticketId);
        this.emit(ticketId, 'note', { text: 'Stopped by user.' });
        this.broadcastTicket(ticketId);
        return true;
      }
      this.setFailNote(ticketId, { note: 'Usage limit: stopped, send a message to carry on' });
      this.emit(ticketId, 'note', { text: "Stopped by user: it won't resume by itself." });
      this.broadcastTicket(ticketId);
      return true;
    }
    this.queue.drop(ticketId);
    this.wakeNow.delete(ticketId);
    this.saveTurn(ticketId, { stopped: true });
    this.emit(ticketId, 'note', { text: 'Stopped by user.' });
    this.endLive(live, ticketId);
    return true;
  }

  /** "Pause and stop running ones" (#1868): its queue stays, and its resume waits in the line. One about to end, or a fresh start's handoff, is left to. */
  private pauseTurn(ticketId: number) {
    const live = this.turns.get(ticketId);
    const turn = live && this.store.getSetting<TurnState>(turnKey(ticketId));
    if (!live || !turn || turn.paused || turn.stopped || turn.result || turn.fresh || turn.keepalive || turn.closing !== undefined) return;
    this.saveTurn(ticketId, { paused: true });
    this.emit(ticketId, 'note', { text: `${this.turnLine.paused()?.by ?? 'Someone'} paused all minions: this turn stops here and carries on after the pause.` });
    this.endLive(live, ticketId);
  }

  private endLive(live: LiveTurn, ticketId: number) {
    live.stopPending = !existsSync(join(live.dir, 'pid.json'));
    // claude has a pid: SIGINT first, so it writes its result (cost, usage) before it exits. Not yet: nothing to
    // interrupt, so as before (this stops its unit); poll sends the SIGINT chain once claude starts.
    if (live.stopPending) this.signal(live, 'SIGTERM');
    else this.stopSignals(live, ticketId);
    if (live.stopPending) runningTurn(live).endStart();
    // A turn that ignores the stop (or hadn't started claude yet) gets killed.
    if (live.stopPending) this.armKill(live, ticketId);
  }

  /** How long a stopped claude has after SIGINT to write its result before SIGTERM, and in all before SIGKILL (ms). */
  stopGraceMs = 5_000;
  stopKillMs = 15_000;
  /** The stop's grace and kill timers run on this; tests pass a fake one (test/fake-clock.ts). */
  clock: Clock = realClock;

  private armKill(live: LiveTurn, ticketId: number) {
    this.clock.clearTimeout(live.stopTimer);
    live.stopTimer = this.clock.setTimeout(() => this.turns.get(ticketId) === live && this.signal(live, 'SIGKILL'), this.stopKillMs);
    live.stopTimer.unref();
  }

  /**
   * A stop on a started claude: SIGINT, so it ends its turn with a result event (SIGTERM exits 143 with none, so the
   * turn's cost went unrecorded, AG-04); then SIGTERM after the grace period; then the SIGKILL retry.
   */
  private stopSignals(live: LiveTurn, ticketId: number) {
    if (live.stopGraceTimer) return; // a second Stop must not restart the grace period or push the SIGKILL out
    this.signal(live, 'SIGINT');
    this.clock.clearTimeout(live.stopGraceTimer);
    live.stopGraceTimer = this.clock.setTimeout(() => this.turns.get(ticketId) === live && this.signal(live, 'SIGTERM'), this.stopGraceMs);
    live.stopGraceTimer.unref();
    this.armKill(live, ticketId);
  }

  /** The folder of a minion's running turn, or null. */
  turnDir(ticketId: number): string | null {
    return this.turns.get(ticketId)?.dir ?? null;
  }

  /** Signal a turn's claude and, as it runs in its own process group, its tool subprocesses too. */
  signal(live: TurnAt, sig: NodeJS.Signals) {
    runningTurn(live).signal(sig);
  }

  // Fresh starts: src/fresh.ts.

  requestFresh(ticketId: number, why: string, auto = false): string | null {
    return this.fresh.requestFresh(ticketId, why, auto);
  }

  recordHandoff(ticketId: number, summary: string, carryOn = true): string | null {
    return this.fresh.recordHandoff(ticketId, summary, carryOn);
  }

  freshSweep(now = Date.now()) {
    return this.fresh.freshSweep(now);
  }

  /**
   * Keep the slash commands a turn loaded (Claude Code's init event lists them), for the composer's menu and its
   * check of what it sends (#937). Terminal-only ones and internal `__` ones are left out. Written only on a change.
   */
  private saveCommands(ticketId: number, ev: ClaudeEvent) {
    const terminal = new Set(Array.isArray(ev.terminal_slash_commands) ? ev.terminal_slash_commands : []);
    const names = [...new Set<string>(ev.slash_commands!.filter((n: unknown) => typeof n === 'string' && n && !n.startsWith('__') && !terminal.has(n)))];
    const plugins = (Array.isArray(ev.plugins) ? ev.plugins : []).filter((p) => typeof p?.name === 'string' && typeof p.path === 'string' && p.path.startsWith('/')).map((p) => ({ name: p.name, path: p.path }));
    const loaded: LoadedCommands = { names, plugins, cwd: typeof ev.cwd === 'string' ? ev.cwd : '' };
    const ticket = this.store.getTicket(ticketId);
    if (JSON.stringify(this.store.getSetting(commandsKey(ticketId))) !== JSON.stringify(loaded)) this.store.setSetting(commandsKey(ticketId), loaded);
    if (ticket && JSON.stringify(this.store.getSetting(schemeCommandsKey(ticket.project_id))) !== JSON.stringify(loaded)) this.store.setSetting(schemeCommandsKey(ticket.project_id), loaded);
  }

  /** Start due keepalives, weekly readout included (src/keepalive-run.ts). Run every minute. */
  keepaliveSweep(now = this.now()) {
    this.keepaliveRun.keepaliveSweep(now);
  }

  /** Whether its turn would run on Codex, which keeps no Claude cache. */
  private codexTurn(t: Ticket, p: Project, person: number | null): boolean {
    return isCodexModel(turnSettings(t, p).model) || (person !== null && !!this.store.getSetting<boolean>(codexSwitchKey(person))) || !!this.store.getSetting(codexThreadKey(t.id));
  }

  /** Whose plan and which account a turn of `t` for `person` would run on now (account 0: it couldn't run). */
  private accountOf(t: Ticket, person: number | null): OnAccount {
    return { payer: this.payerOf(person), account: person === null || !this.accountFor ? null : (this.accountFor(person, warmKey(t)) ?? 0) };
  }

  /** Each minion's counted due window: its last turn end, the day and the gate it was counted under. */
  private gateCounted = new Map<number, { ended: number; day: string; gate: string }>();

  /**
   * Start a turn with what waits in the queue, once the minion's lane is free. During a network or kill wait the queue
   * holds the messages for its resume: only `now` (a message or a release arriving) starts a turn that takes them sooner.
   */
  private next(ticketId: number, now = false) {
    if (!this.queue.size(ticketId) && !this.fresh.freshStep(ticketId) && !this.keepalivePending.has(ticketId)) return;
    // Waiting for the usage limit to reset: the messages go into the resume, not a turn that would fail at once.
    if (this.limitWait(ticketId)) return;
    // Nor while its card waits on a person: what came since goes into the turn that resumes it (#1916).
    if (cardHeld(this.store, ticketId)) return;
    if (this.netWait(ticketId) || this.killWait(ticketId)) {
      if (now) this.wakeNow.add(ticketId);
      else if (!this.wakeNow.has(ticketId)) return;
    }
    // A turn nothing here follows still runs (liveTurn): it calls next() once that turn has ended.
    if (this.strayWaits.has(ticketId)) return;
    // One step at a time per minion (src/lanes.ts): the lane calls next() again once it is free. Its last
    // turn's save above all: a turn on another login restores from that save (#250). The queue keeps the messages.
    if (this.lanes.busy(ticketId)) return;
    // A keepalive alone takes no worker; anything else waits in the line for one (#1868).
    const quiet = !this.queue.size(ticketId) && !this.fresh.freshStep(ticketId);
    // In line, only its keepalive runs (#1888): no worker, and its turn keeps its place.
    const keepalive = !quiet && !this.turnLine.enter(ticketId);
    if (keepalive && !this.keepalivePending.has(ticketId)) return;
    // Whose turn it will be, as below: a fresh-start step's is the minion's own, else the first queued message's.
    const person = (ticket: Ticket, project: Project) => this.turnPerson(ticket, project, this.fresh.freshStep(ticketId) ? [] : this.waiting(ticketId));
    // Nor beside a turn still live (#1464): the queue waits until it ends, then asks again.
    const step = () =>
      this.liveTurn(ticketId, () =>
        this.afterRestore(ticketId, person, () => {
          // A real message came in meanwhile: it needs a worker, so the keepalive is dropped and the free lane asks again.
          if (quiet && (this.queue.size(ticketId) || this.fresh.freshStep(ticketId))) return void this.keepalivePending.delete(ticketId);
          const ticket = this.store.getTicket(ticketId);
          const project = ticket && this.store.getProject(ticket.project_id);
          if (!ticket || !project) return;
          if (keepalive) return this.linedKeepalive(project, ticket);
          // A Taskmaster's fresh-start step runs first and alone; the queue waits for the fresh session
          // (but goes before a handoff Citadel asked for by itself: freshStep).
          // The keepalive or the queue's turn: after a fresh start that ran no turn, or at once.
          const rest = () => {
            // A real message that came in meanwhile goes first, and the keepalive is dropped: that turn re-reads the cache anyway.
            const skew = this.keepalivePending.get(ticketId);
            if (this.keepalivePending.delete(ticketId) && !this.queue.size(ticketId) && !this.netWait(ticketId) && !this.killWait(ticketId) && this.keepaliveRun.wantsKeepalive(ticket, project, this.now() + skew!)) {
              return this.ranTurn(this.startTurn(project, ticket, [{ author: 'System', text: KEEPALIVE_TEXT, images: [], keepalive: true }], this.turnPerson(ticket, project, [])));
            }
            // Everything queued while the last turn ran goes into one turn. Held mail alone wakes nothing, nor does a disabled person's message.
            this.dropDisabled(ticketId);
            if (!this.queue.size(ticketId)) return;
            const person = this.turnPerson(ticket, project, this.waiting(ticketId));
            if (this.refused(ticketId, person)) {
              // What woke it is refused, as in send(); held mail stays for the next turn (#468 S03-6). Not kept as held mail:
              // a refused person's message would pick them to pay for every later batch, and refuse it too (#1378 review).
              this.queue.refuse(ticketId);
              this.wakeNow.delete(ticketId);
              this.broadcastTicket(ticketId);
              return;
            }
            const carriesOn = !this.queue.wakes(ticketId);
            return this.ranTurn(this.startTurn(project, ticket, this.takeQueue(ticketId), person, {}, carriesOn));
          };
          const fresh = this.fresh.freshStep(ticketId);
          if (!fresh) return rest();
          // Its launch's stop mark (startTurn takes it on), so a stop before the turn is followed calls the fresh start off as a stop after does.
          const mark = { stopped: false };
          this.launching.set(ticketId, mark);
          return this.startTurn(project, ticket, [fresh], this.turnPerson(ticket, project, []))
            .catch((err) => {
              // Thrown out of the step with the fresh start still pending, the freed lane would ask again at once, for ever: give up as below.
              console.error(`Ticket ${ticketId}: its fresh start's turn could not start:`, err);
            })
            .then((started) => {
              // The queue waits behind this turn as behind any.
              if (this.isRunning(ticketId)) return started?.ended ?? this.turns.get(ticketId)?.ended;
              // No turn started (a preview, a refused place, a stop): drop it, or the idle lane would ask again at once,
              // and forget its size, or the idle check would ask again each minute.
              this.store.deleteSetting(freshKey(ticketId));
              this.store.deleteSetting(contextKey(ticketId));
              this.emit(ticketId, 'note', { text: mark.stopped ? `The handoff turn was stopped, so the fresh start is off: the ${roleWord(ticket)} keeps its session.` : 'The fresh start could not run a turn, so the Taskmaster keeps its session.' });
              return rest();
            });
        }),
      );
    this.lanes.run(ticketId, 'turn', quiet ? step : () => this.turnLine.hold(ticketId, step));
  }

  /** The keepalive of a minion in line (#1888), as the turn it waits for would run; whatever else waits stays in line. */
  private linedKeepalive(project: Project, ticket: Ticket): unknown {
    const skew = this.keepalivePending.get(ticket.id);
    if (!this.keepalivePending.delete(ticket.id) || !this.keepaliveRun.wantsKeepalive(ticket, project, this.now() + skew!)) return;
    return this.ranTurn(this.startTurn(project, ticket, [{ author: 'System', text: KEEPALIVE_TEXT, images: [], keepalive: true }], this.turnPerson(ticket, project, this.waiting(ticket.id))));
  }

  /** A turn a pause stopped waits in the line to carry on; one stopped before claude had its prompt runs its batch again. */
  private waitOutPause(ticketId: number, turn: TurnState, retry: { via: RetryKind; retries: Retries }) {
    const rerun = !turn.offset && this.queue.giveBack(ticketId, false, true).length > 0;
    if (!rerun) this.queue.owe(ticketId, { ...owedOf(retry.via, retry.retries), paused: true });
    // Never takes a worker here: the turn ending still holds its own, and a Resume may have come already.
    this.turnLine.join(ticketId, rerun ? undefined : retry.via);
  }

  /** A minion's status as people read it: one waiting for a worker is working. */
  shownStatus(ticket: Ticket): Ticket['status'] {
    return this.turnLine.has(ticket.id) ? 'running' : ticket.status;
  }

  private lineMoved = new Set<number>();

  /** Pages hear who started or stopped waiting, and everyone's place, at most every 200 ms: a burst shifts every place once. */
  private lineChanged(ids: number[]) {
    if (this.detached) return;
    if (!this.lineMoved.size) {
      setTimeout(() => {
        const moved = [...this.lineMoved];
        this.lineMoved.clear();
        if (this.detached) return;
        for (const id of moved) this.broadcastTicket(id);
        this.broadcast({ type: 'workers', line: this.turnLine.order(), paused: this.turnLine.paused()?.by ?? null });
      }, 200).unref();
    }
    for (const id of ids) this.lineMoved.add(id);
  }

  /** Start a turn the line gave a worker: the resume it waited for as it stands now, else its queue's turn. */
  private startLined({ ticket, via }: LineEntry) {
    const owed = this.queue.owed(ticket);
    if (via === 'kill' && this.resumes.startKill(ticket)) return;
    if (via === 'limit' && this.resumes.startLimit(ticket)) return;
    if (via === 'net' && this.netWait(ticket)) return this.resumes.netResume(ticket);
    if (via && owed) return void this.resume(ticket, via, owedRetries(owed));
    this.next(ticket, true);
  }

  /** Whose share a waiting turn counts in, and its place there (Waiting.rank). */
  private lineAsks(ticketId: number, via?: RetryKind): LinePlace {
    try {
      const ticket = this.store.getTicket(ticketId);
      const project = ticket && this.store.getProject(ticket.project_id);
      if (!ticket || !project) return { person: 0, rank: 2 };
      const fresh = this.fresh.freshStep(ticketId);
      const waiting = this.waiting(ticketId);
      const payer = this.turnPerson(ticket, project, fresh ? [] : waiting, !!via);
      const person = payer ?? 0;
      const place = this.places.place(ticket, () => (this.codexTurn(ticket, project, payer) ? null : this.accountOf(ticket, payer)));
      if (waiting.msgs.some((m) => m.own)) return { person, rank: 0, ...place };
      // A first turn a person or a minion asked for; a schedule's or Citadel's own has no asker.
      const asked = !ticket.session_id && waiting.msgs.some((m) => m.from || m.asker != null);
      const started = fresh || asked || via === 'restart' || via === 'switch' || waiting.msgs.some((m) => m.from && this.store.getTicket(m.from)?.kind === 'coordinator');
      return { person, rank: started ? 1 : 2, ...place };
    } catch (err) {
      // One minion's trouble doesn't hold the line up; its turn's start meets the same trouble and says so.
      console.error(`Minion ${ticketId}: its place in the line could not be worked out:`, err);
      return { person: 0, rank: 2 };
    }
  }

  /** The one person whose own typed message a ticket's running turn answers (TurnState.typedBy), else null. */
  typedBy(ticketId: number): number | null {
    return (this.turns.has(ticketId) && this.store.getSetting<TurnState>(turnKey(ticketId))?.typedBy) || null;
  }

  /** The people's own machines a ticket's running turn got at its start (TurnState.owned), else none. */
  ownedMachines(ticketId: number): number[] {
    return (this.turns.has(ticketId) && this.store.getSetting<TurnState>(turnKey(ticketId))?.owned) || [];
  }

  /** The minion that relayed the message the ticket's current (or last) turn answers, if a relay came before any person's message: whose minion a Taskmaster's new minion belongs to. */
  relayedBy(ticketId: number): number | null {
    return this.turnFrom.get(ticketId) ?? null;
  }

  /** Who a turn runs for (its GitHub login, and #177's Claude plan): src/access.ts turnPayer, the one rule (#1270). */
  private turnPerson(ticket: Ticket, project: Project, waiting: QueuedMessage[] | { msgs: QueuedMessage[]; held: QueuedMessage[] }, resuming = false): number | null {
    return turnPayer(this.store, ticket, project, waiting, (author, from) => this.personOf?.(author, from) ?? null, resuming);
  }

  /** Whether `ticket` is a split scheme's Overlord (#919, #921): the Taskmaster that is nobody's own, beside one per person. */
  isOverlord(ticket: TicketFields | undefined): boolean {
    return !!ticket && ticket.kind === 'coordinator' && ticket.coordinator_of == null && this.store.isSplit(ticket.project_id);
  }

  /**
   * An answer to an Overlord's card wakes only the Taskmaster that acts on it (`actor`: the Overlord, or the person's
   * Taskmaster that asked for everyone); every other Taskmaster in the scheme hears it as held mail (#921), but not the
   * answerer's own: talking to the Overlord from their chat, they answered it themselves, and the answer is on the settled card (#1630).
   */
  echoOverlordAnswer(overlord: TicketFields, by: string, text: string, actor = overlord.id, byUid?: number | null) {
    if (!this.isOverlord(overlord)) return;
    const mine = byUid ?? this.personOf?.(by) ?? null;
    const line = text.length > 600 ? text.slice(0, 600) + '…' : text;
    for (const tm of this.store.listCoordinators(overlord.project_id)) {
      if (tm.id !== actor && tm.id !== overlord.id && (mine == null || tm.coordinator_of !== mine)) this.leaveMail(tm.id, by, `(for your tracking; nothing to do) ${by} answered the Overlord's card:\n${line}`);
    }
  }

  /**
   * An everyone card carries the reply its turn wrote (#1581): the card shows in every member's Mine, but its writer's chat (a
   * person's Taskmaster) or the turn's words (the Overlord's) don't, so "steps in my reply above" pointed at text people couldn't see.
   * Called as a turn ends: the turn's last words go into each still-unreplied everyone card it asked, and `card_reply` tells open pages.
   */
  carryReply(ticketId: number) {
    const me = this.store.getTicket(ticketId);
    if (!me || me.kind !== 'coordinator') return;
    const chat = this.isOverlord(me) ? me : me.coordinator_of != null ? this.store.getOverlord(me.project_id) : undefined;
    if (!chat) return;
    const from = chat.id === me.id ? undefined : me.id;
    const started = this.turnStartedAt(ticketId);
    if (started == null) return; // no known turn start: never guess which cards were its own
    const cards = this.store.eventsOfKinds(chat.id, ['question', 'plan']).filter((e) => {
      const d = JSON.parse(e.data);
      return d.everyone === true && d.asker === from && d.reply == null && !d.settled && e.created_at >= started;
    });
    if (!cards.length) return;
    let reply = '';
    for (const w of this.store.wordsBy(ticketId, 6)) {
      const d: ClaudeEvent = JSON.parse(w.data);
      if (w.kind !== 'claude' || w.created_at < started) continue;
      reply = ((d.message?.content ?? []) as ContentBlock[])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n')
        .trim();
      if (reply) break;
    }
    if (!reply) return;
    for (const e of cards) {
      const d = JSON.parse(e.data);
      this.store.setEventData(e.id, { ...d, reply });
      this.emit(chat.id, 'card_reply', { event: e.id, id: d.id, reply, ...(d.asker != null ? { asker: d.asker } : {}) });
    }
    this.broadcastTicket(chat.id);
  }

  /**
   * A card's answer kept in its chat without waking it: a for-everyone card's answer wakes its asker instead (#921).
   * `held` is what the chat's own next turn reads of it, if it has one, from `by` (a Ship It the server shipped, #1930).
   */
  recordAnswer(ticketId: number, author: string, text: string, extra: object, held?: { by: string; text: string }) {
    // No event id: the chat's line is the person's answer, which people shouldn't read as not sent yet.
    if (held) this.queue.hold(ticketId, { author: held.by, text: held.text, images: [], fyi: true, asker: null });
    this.emit(ticketId, 'user_message', { author, text: hideTokens(text), ...extra });
    this.broadcastTicket(ticketId);
  }

  /**
   * Start a turn with `batch`. A start that runs no turn (a preview, a refused place, no folder, a launch that can't be
   * built, a throw) gives the queue's taken batch back as held mail (#1378): it rides along with the next turn, and asks
   * for none now, which would only fail the same way.
   */
  private async startTurn(...args: Parameters<Runner['launchTurn']>): ReturnType<Runner['launchTurn']> {
    const id = args[1].id;
    // Stopped while its launch awaited its files (#1808): stop() marks it, and the launch starts no turn.
    const mark = this.launching.get(id) ?? { stopped: false };
    this.launching.set(id, mark);
    if (args[2][0]?.keepalive) mark.keepalive = true;
    // Shown running from the send, as when the launch was all one step: a launch that runs no turn puts it back.
    // A crash meanwhile leaves it running with no turn saved: recover gives the batch back and runs it as a plain turn.
    const was = this.store.getTicket(id)?.status;
    const shown = !this.noTurns && !args[2][0]?.keepalive && was !== undefined && was !== 'running';
    if (shown) this.setStatus(id, 'running');
    try {
      return await this.launchTurn(...args);
    } finally {
      this.launching.delete(id);
      if (!this.turns.has(id)) {
        if (shown && this.store.getTicket(id)?.status === 'running') this.setStatus(id, was);
        // A resume that couldn't start pays its debt too, so the freed lane doesn't try it again at once.
        this.queue.owe(id, null);
        // A stop drops the taken batch, as it drops a running turn's queue: done, so neither recover nor the next take reruns it.
        if (mark.stopped) this.queue.done(id);
        else if (this.queue.giveBack(id, true).length) this.broadcastTicket(id);
        // A dismissal or live deploy that waited for this launch (isRunning counts it). A keepalive's acts now, as at its
        // end; a real launch that started no turn is a stopped or failed start, which leaves the minion open, as such a turn does.
        const closeReason = this.closing.get(id) ?? null;
        const closing = this.closing.delete(id);
        const deployed = this.deployedMidTurn.delete(id);
        this.actOnDeferred(id, closing, closeReason, deployed, mark.keepalive && !mark.stopped ? null : "its turn didn't start");
        if (closing) this.broadcastTicket(id);
      }
    }
  }

  /** A lane's turn step: it holds the lane until the turn it started has ended (a stand-in startTurn may return anything). */
  private ranTurn(started: unknown): Promise<void> {
    return Promise.resolve(started).then((s) => (s as { ended?: Promise<void> } | undefined)?.ended);
  }

  /**
   * Launch a turn: every file call awaited (#1808: on a busy disk a launch's sync calls held the server's thread ~1.2 s),
   * then, with nothing more to await, the minion's changes and follow() in one go. Until then it isn't running: a message
   * waits for the next turn, as behind afterRestore's restore.
   */
  private async launchTurn(project: Project, ticket: Ticket, batch: QueuedMessage[], person: number | null, retries: Retries = {}, carriesOn = false): Promise<{ ended: Promise<void> } | undefined> {
    // An account switch alone isn't a resume here: it carries on its person's own turn on another account.
    const resumed = !!(retries.restart || retries.limit || retries.net || retries.kill);
    // Before anything else here: restoring a worktree runs git in the real repo, and a turn is a real claude.
    if (this.noTurns) {
      this.emit(ticket.id, 'note', { text: 'This is a preview: it shows the app on a copy of the data, but it never runs turns.' });
      this.broadcastTicket(ticket.id);
      return;
    }
    // A hidden keepalive (#862): it re-reads the cached prefix and changes nothing of the minion's, the chat included.
    const keepalive = !!batch[0]?.keepalive;
    // Whose Claude it runs on (sender pays, #213): the host's login for its owner, else their own container.
    const claudePlace = this.placeFor?.(person, warmKey(ticket), ticket.kind === 'coordinator') ?? { host: true as const };
    if ('refused' in claudePlace) {
      if (keepalive) return;
      this.emit(ticket.id, 'note', { text: claudePlace.refused });
      this.broadcastTicket(ticket.id);
      return;
    }
    // The worktree sweep removes dismissed minions' worktrees; a reopened one gets its back.
    this.restoreDir(ticket, project);
    // With no folder it would run in the server's own (#899): the note above says why it can't.
    if (ticket.kind === 'ticket' && !ticket.cwd) {
      this.broadcastTicket(ticket.id);
      return;
    }
    // Each folder the turn gets, or null when it can't be made.
    const made = async (d: string | null) =>
      d &&
      mkdir(d, { recursive: true }).then(
        () => d,
        () => null,
      );
    const filesDir = await made(this.filesDir(ticket));
    const sharedDir = await made(this.sharedDir(project));
    // Claude Code keeps auto-memory under the main checkout's folder, shared by the project's worktrees.
    const memoryDir = await made(project.repo_dir && ticket.kind === 'coordinator' ? join(claudeConfigDir(process.env), 'projects', projectSlug(project.repo_dir), 'memory') : null);
    // Who asked for it (#255): its messages' askers, any non-admin of them if several, since a ride-along
    // ask is in the turn too; with none (GitHub, a notice), and on a resume, the last turn's carries on.
    const before = this.store.turnAsker(ticket.id);
    const askers = [...(resumed || keepalive ? [before] : []), ...batch.map((m) => (m.asker !== undefined ? m.asker : (this.personOf?.(m.author, m.from) ?? null)))].filter((a): a is number => a !== null);
    const asker = askers.find((a) => !this.store.isAdmin(this.store.getUser(a))) ?? askers[0] ?? before ?? person;
    // Threads (not the coordinator, which hands work off) get the tools of every machine online now and lent
    // to the scheme, and the asker's own (#306): the one person this batch (or the turn it resumes) answers, so
    // a turn no one asked for gets none, and a ride-along message doesn't bring its sender's machines.
    const machines = ticket.kind === 'coordinator' ? [] : this.machines(project, askers.length ? [asker!] : []);
    // Codex (#337): a Codex pick, or the sender's "Enable Codex override" (which maps a Claude pick by tier),
    // once their own container is signed in to Codex. Otherwise it runs on Claude, saying why. The server
    // login's Codex turns run in its own container, never on the host (#341): only there is Codex's hook.
    const { model: picked, effort: itsEffort } = turnSettings(ticket, project);
    const switched = person !== null && !!this.store.getSetting<boolean>(codexSwitchKey(person));
    const wantsCodex = isCodexModel(picked) || switched;
    let codexWhy = wantsCodex ? this.codexWhy(person) : null;
    const codexPlace = wantsCodex && !codexWhy && claudePlace.host && person !== null ? (this.codexPlaceFor?.(person) ?? null) : null;
    if (wantsCodex && !codexWhy && claudePlace.host && !codexPlace) codexWhy = "Codex's container isn't there yet (sign in to Codex in Settings → Your account)";
    const codex = wantsCodex && !codexWhy;
    const place: TurnPlace = codexPlace ?? claudePlace;
    if (codexWhy) {
      const name = CODEX_MODELS.find(([id]) => id === picked)?.[1];
      this.emit(ticket.id, 'note', { text: name ? `This minion is set to ${name}, but ${codexWhy}, so this turn runs on Claude's default model.` : `Codex is switched on, but ${codexWhy}, so this turn runs on Claude.` });
    }
    const model = isCodexModel(picked) && !codex ? turnSettings({ ...ticket, model: null }, project).model : picked;
    // A minion's turn whose whole batch is machine notices of success runs at low effort (#951): it relays news or
    // checks state. A person's or Taskmaster's message, a failure or a resume keeps its own. A keepalive replays
    // the effort of the turn whose cache it keeps warm, so its launch matches that turn's.
    const light = !codex && ticket.kind !== 'coordinator' && (keepalive ? !!this.store.getSetting<KeepaliveSeries>(keepaliveKey(ticket.id))?.light : !resumed && batch.length > 0 && batch.every((m) => m.light));
    const effort = light ? 'low' : itsEffort;
    // Saved secrets as env vars (#838): never in the prompt, so never in the turn's context unless it prints one.
    // A person's own only when they alone sent this turn's messages themselves and it runs as them: never on a
    // schedule, a wake, a relay or a batch mixing people, which fall back to someone who didn't ask.
    const own = new Set(batch.filter((m) => m.own && !m.from).map((m) => this.personOf?.(m.author) ?? null));
    const secretPerson = own.size === 1 && [...own][0] === person ? person : null;
    const secrets = this.secretsFor?.(project.id, secretPerson) ?? new Map<string, string>();
    this.turnSecrets.set(ticket.id, secrets);
    // Back on Claude after Codex turns: they come first, verbatim, and their thread goes once this turn succeeds.
    const codexThread = this.store.getSetting<CodexThread>(codexThreadKey(ticket.id));
    const handBack = !codex && codexThread ? [{ author: 'System', text: toClaudePreamble(fitLog(readParts(codexThread.log))), images: [] }] : [];
    // A Taskmaster's fresh-start step (#406): /compact must be the prompt's whole text for Claude Code to run it.
    const step = batch[0]?.fresh;
    // A fresh session's first turn starts from the old session's handoff.
    const handoff = !step && !ticket.session_id ? this.store.getSetting<string>(handoffKey(ticket.id)) : null;
    const cancelled = !step && !keepalive && this.store.getSetting<string>(closeCancelledKey(ticket.id));
    if (cancelled) this.store.deleteSetting(closeCancelledKey(ticket.id));
    const cancelledLine = cancelled ? [{ author: 'System', text: `Your close_self in your last turn was cancelled: ${cancelled}, so this minion is still open. Once nothing is left for people, call close_self again.`, images: [] }] : [];
    // What this scheme's other Taskmasters did since this one's last turn (#919), written by code, at most ten lines.
    const digest = ticket.kind === 'coordinator' && !step && !keepalive ? this.store.digestFor(ticket.id) : [];
    const digestLine = digest.length ? [{ author: 'System', text: `Since your last turn, this scheme's other ${AGENT_NAME}s:\n${digest.map((l: string) => `- ${l}`).join('\n')}`, images: [] }] : [];
    // Its minions and cards that have waited with nothing set to move them (#1506), only on a turn a person started: no wakes of its own.
    const stuck = ticket.kind === 'coordinator' && !step && !keepalive && batch.some((m) => m.own && !m.from) ? this.stuckText(ticket) : null;
    const stuckLine = stuck ? [{ author: 'System', text: stuck, images: [] }] : [];
    const typers = new Set(batch.filter((m) => m.typed && !m.from).map((m) => this.personOf?.(m.author) ?? null));
    const typedBy = typers.size === 1 ? [...typers][0] : typers.size ? 0 : null;
    // A Codex turn resumes its thread when it is this person's; otherwise a new one starts from the hand-over below.
    const same = codexThread?.person === person && codexThread.thread;
    if (!step && !keepalive && !codex) this.fresh.seamEnrol(ticket.id);
    // Only an ordinary minion's turn on Claude is ever placed on a machine (spec section 2): Taskmasters, Codex turns, keepalives and fresh-session steps run here.
    const worker = ticket.kind !== 'coordinator' && !codex && !keepalive && !step ? this.workerFor(ticket, person) : null;
    let built: Awaited<ReturnType<Runner['buildLaunch']>>;
    try {
      built = await this.buildLaunch(project, ticket, {
        place,
        person,
        asker,
        machines,
        model,
        effort,
        typedBy,
        secrets,
        name: `${ticket.id}-${Date.now()}`,
        folders: { files: filesDir, shared: sharedDir, memory: memoryDir },
        codex: codex ? { thread: same || null } : null,
        worker,
      });
    } catch (err) {
      // A launch that can't be built (a settings file past Claude Code's cap, #661; claude not on the PATH) fails the turn with its reason, in the chat.
      console.error(`Minion ${ticket.id}: its launch could not be built:`, err);
      const event = this.emit(ticket.id, 'error', { text: `Could not start the turn: ${thrown(err).message}` });
      const note = `Could not start: ${thrown(err).message}`;
      this.setFailNote(ticket.id, { note: note.length > 60 ? `${note.slice(0, 59)}…` : note });
      this.setStatus(ticket.id, 'error');
      this.onTurnError(ticket.id, thrown(err).message!, event.id);
      return;
    }
    const { plan, dir, system, parts, pins, github, unit, reviewAt, hold } = built;
    let { context } = built;
    if (reviewAt && !keepalive) this.wakeCodex?.(person!);
    const { command, args, env, configDir } = plan;
    // What its cached prefix is built from (#862), before --resume joins the arguments: a keepalive runs only while it is the
    // one its last real turn cached. A minion's alone: Taskmasters and Codex get no keepalives.
    const fpParts =
      ticket.kind === 'coordinator' || codex || !ticket.cwd
        ? null
        : prefixParts({
            dir,
            systemPrompt: system,
            args,
            files: plan.files,
            env,
            pinned: treeHash(pins.MCP_DIR),
            claude: claudeStamp(command, env.PATH),
            context: await contextText(
              ticket.cwd,
              configDir,
              [ticket.cwd, project.repo_dir].filter((d): d is string => !!d).map((d) => join(configDir, 'projects', projectSlug(d), 'memory', 'MEMORY.md')),
            ),
            date: turnDate(Date.now(), env.TZ),
          });
    const fp = fpParts && fingerprint(fpParts);
    if (keepalive) {
      const s = this.store.getSetting<KeepaliveSeries>(keepaliveKey(ticket.id));
      if (!fp || s?.fp !== fp) {
        console.log(`[keepalive] minion ${ticket.id}: its prompt changed since its last turn (${changedParts(s?.parts ?? {}, fpParts ?? {}).join(', ')}), so its keepalives stop`);
        this.keepaliveRun.stopSeries(ticket.id, 'dirty');
        await rm(dir, { recursive: true, force: true });
        this.turnSecrets.delete(ticket.id);
        return;
      }
    }
    const hashes = promptHashes(parts, plan.env, model, effort, this.payerOf(person), !!hold?.decision.held);
    // Written before anything of the minion's changes below, so a launch that can't be written leaves who it runs for as it was.
    for (const f of plan.files) await writeFile(join(dir, f.name), f.text, f.mode === undefined ? {} : { mode: f.mode });

    // The session's transcript, task list and memory live in the database too; put back anything this
    // config dir lacks (another account, a fresh machine) before resuming.
    let restoreFailed = false;
    let had: Set<string> | null = null;
    // A session that is gone for good: the fresh one starts from a short digest of the chat (#899).
    let lost: { text: string; entries: number } | null = null;
    try {
      const restored = await restoreSession(this.store, ticket, project, configDir);
      // Everything stored is back now, but for notes deleted since, so the end-of-turn save may prune what the turn deletes.
      had = storedPaths(this.store, ticket, project);
      if (restored) console.log(`Ticket ${ticket.id}: restored the Claude session from the database (${restored} file${restored === 1 ? '' : 's'}).`);
    } catch (err) {
      this.emit(ticket.id, 'note', { text: `Could not restore the session from the database: ${thrown(err).message}` });
      restoreFailed = true;
    }
    // With no copy of its transcript on this login or in the database, --resume would fail every turn from now on.
    // A restore that failed (disk full, say) still resumes and fails loudly: the database's copy may be fine.
    const transcript = ticket.session_id ? transcriptPath(configDir, ticket.cwd, ticket.session_id) : null;
    if (ticket.session_id && transcript && (restoreFailed || (await exists(transcript)))) {
      if (!codex) args.push('--resume', ticket.session_id);
    } else if (keepalive) {
      // No session to keep warm: its next real turn says so.
      this.keepaliveRun.stopSeries(ticket.id, 'failed');
      await rm(dir, { recursive: true, force: true });
      this.turnSecrets.delete(ticket.id);
      return;
    } else if (ticket.session_id) {
      lost = lostSessionText(ticket.session_id, ticket.note, this.chatDigest(ticket.id, batch));
      this.emit(ticket.id, 'note', {
        text: `This minion's conversation (session ${ticket.session_id}) isn't on this Claude login or in the database, so this turn starts a fresh session. Its branch, worktree and chat are all still here; Claude doesn't remember the earlier turns, so it starts from ${lost.entries ? `its status note and its last ${lost.entries} chat entries` : 'its status note'}.`,
      });
      this.store.updateTicket(ticket.id, { session_id: null });
    }
    // The Taskmaster's auto-memory moved to the repo memory (#98); bring its old notes along once.
    // shortcut: mergeMemory's own calls are sync, but a merge renames the old folder away, so after the first turn this off-thread look is all that runs.
    const oldMemory = memoryDir && join(configDir, 'projects', projectSlug(ticket.cwd), 'memory');
    if (memoryDir && oldMemory && (await exists(oldMemory))) {
      try {
        mergeTaskmasterMemory(this.store, ticket, oldMemory, memoryDir);
      } catch (err) {
        this.emit(ticket.id, 'note', { text: `Could not move the Taskmaster's old memory into ${memoryDir}: ${thrown(err).message}` });
      }
    }

    if (hold && !keepalive) {
      let d = hold.decision;
      // A session that turned out lost starts a new one. The held prompt and its note together are the current rules,
      // so it keeps both and the new session adopts the hold (ran fills in its id); only a note about going back is moot.
      if (lost) {
        d = { ...d, record: { ...d.record, session: null } };
        if (d.note && !d.held) {
          delete parts.turn.rulesChanged;
          context = promptText(parts.turn);
        }
      }
      // A /compact step carries no note, so it has delivered none.
      this.promptHolds.save(ticket.id, step ? { ...d, record: { ...d.record, pending: undefined } } : d);
      if (d.reload) console.log(`[prompt-hold] minion ${ticket.id}: takes the current prompt (${d.reload})`);
    }
    const prompt =
      step === 'compact'
        ? JSON.stringify({ type: 'user', message: { role: 'user', content: COMPACT_COMMAND } }) + '\n'
        : keepalive
          ? promptMessage(batch)
          : promptMessage([
              ...(context ? [{ author: 'System', text: context, images: [] }] : []),
              ...(github ? [{ author: 'System', text: github.line, images: [] }] : []),
              ...(handoff ? [{ author: 'System', text: freshStartText(handoff), images: [] }] : []),
              ...(lost ? [{ author: 'System', text: lost.text, images: [] }] : []),
              ...handBack,
              ...cancelledLine,
              ...digestLine,
              ...stuckLine,
              ...batch,
            ]);
    await writeFile(join(dir, 'prompt.jsonl'), prompt);
    for (const f of ['stream.jsonl', 'stderr.log', 'steer.jsonl']) await writeFile(join(dir, f), '');
    if (codex) {
      // The Claude conversation from its last compaction, then any Codex turns on another person's Codex, verbatim:
      // a new thread starts from it (the shim skips it when it resumes the thread).
      let claudeJsonl = '';
      try {
        if (transcript) claudeJsonl = await readFile(transcript, 'utf8');
      } catch {
        // No transcript: the hand-over is the Codex turns alone, if any.
      }
      await writeFile(join(dir, 'handover.md'), fitLog([...claudeParts(claudeJsonl), ...readParts(codexThread?.log ?? '')]));
      if (!same) this.store.setSetting(codexThreadKey(ticket.id), { thread: null, person: person!, log: codexThread?.log ?? '' });
    }
    // Holds the turn's token: private, and the wrapper deletes it once read.
    await writeFile(join(dir, 'spec.json'), JSON.stringify(wrapperSpec(plan, ticket.cwd)), { mode: 0o600 });
    if (plan.spawn.how === 'container') await containerFiles(dir, place as Extract<TurnPlace, { host: false }>);
    // Its `machine` file and first beat: the machine's agent fetches the folder and starts it (src/machine-turn.ts).
    if (plan.spawn.how === 'machine') await placeTurn(dir, worker!, { wrapper: plan.spawn.wrapper, cwd: ticket.cwd, home: env.HOME ?? '', roots: [dirname(dir), join(dirname(this.store.path), 'projects')] });
    // Nothing more to await: a stop or a dismissal meanwhile means no turn, and nothing of the minion's changed. A message
    // to a minion already dismissed does run its turn (it reopens it).
    const still = this.store.getTicket(ticket.id);
    if (this.launching.get(ticket.id)?.stopped || !still || (still.status === 'closed' && ticket.status !== 'closed') || this.noTurns) {
      this.turnSecrets.delete(ticket.id);
      void rm(dir, { recursive: true, force: true }).catch(() => {});
      return;
    }
    // A keepalive changes nothing of the minion's: who it runs for, its state, note and replies stay as the last real turn left them.
    if (!keepalive) {
      if (asker !== null && asker !== person) this.store.setSetting(askerKey(ticket.id), asker);
      else this.store.deleteSetting(askerKey(ticket.id));
      if (person !== ticket.person_id) {
        this.store.updateTicket(ticket.id, { person_id: person });
        const name = person && this.store.getUser(person)?.name;
        if (ticket.person_id && name) this.emit(ticket.id, 'note', { text: claudePlace.host ? `Turns now run for ${name}, on the server's Claude login.` : `Turns now run on ${name}'s Claude plan.` });
      }
      // A resume carries on the cut-off turn, so it answers that turn's relay, unless a person's message rides along (#1452).
      const first = batch.find((m) => m.from || this.personOf?.(m.author));
      const from = first ? first.from : resumed ? this.turnFrom.get(ticket.id) : undefined;
      if (from) this.turnFrom.set(ticket.id, from);
      else this.turnFrom.delete(ticket.id);
      // A state describes where the last turn left things; a new turn makes it stale. Pending-deploy
      // outlasts a stray turn (a GitHub ping), so the deploy still dismisses the minion unless the turn
      // sets another state or a person wrote to it (personWrote).
      // A limited minion's note is the server's, about the wait this turn ends; a complete one's says nothing is left (#547).
      // A minion sealed on start_after stays sealed through a turn that answers a message (#261).
      // One recover() put back is a cut-off turn's, from before that turn could change the state (#1452). A turn
      // after a resume that never started (a re-run batch, a person's message) keeps it: the minion is still held.
      const parkedAs = this.parkedAs.get(ticket.id);
      this.parkedAs.delete(ticket.id);
      // Any turn wakes an asleep minion (#1636; Cara picked "Anything that starts a turn", 2026-11-22): a card's answer, a message, a wake it asked for. A keepalive never gets here (its gate).
      if (this.store.getSetting(sleepKey(ticket.id))) {
        this.store.deleteSetting(sleepKey(ticket.id));
        this.emit(ticket.id, 'note', { text: 'Awake again: a new turn started.' });
      }
      // A trailer is its own turn's: a resume that never started leaves its carried one for nobody.
      if (!resumed) this.statuses.delete(ticket.id);
      if (this.heldFor(ticket.id)) this.parkedAs.set(ticket.id, parkedAs ?? { state: ticket.state, note: ticket.note });
      // A turn that only carries on a cut-off one wakes nobody: a seal set during that one stays (#1958), as it would at its end.
      // A handed-off land's outside is the server's (#962): LandHandoffs replaces it when the land ends.
      else if (ticket.state && ticket.state !== 'pending-deploy' && !(ticket.state === 'parked' && carriesOn) && !(ticket.state === 'outside' && this.serverWork(ticket.id, true)))
        this.store.updateTicket(ticket.id, ticket.state === 'limited' || ticket.state === 'complete' ? { state: null, note: null } : { state: null });
      this.resumes.cancelLimitWait(ticket.id);
      // A network wait ended when its held messages were taken (takeQueue); its note goes with it.
      if (ticket.note === NET_NOTE || ticket.note === KILL_NOTE) this.store.updateTicket(ticket.id, { note: null });
      // A Taskmaster's note is only ever the server's word on how its last turn failed or stopped: a new turn makes it stale (#428).
      else if (ticket.kind === 'coordinator' && ticket.note) this.store.updateTicket(ticket.id, { note: null });
      // One-tap replies answer the turn that offered them; a new turn makes them stale.
      if (ticket.replies) this.store.updateTicket(ticket.id, { replies: null });
    }
    const turn: TurnState = {
      ...(Object.keys(retries).length ? { retries } : {}),
      dir,
      unit,
      offset: 0,
      startedAt: Date.now(),
      configDir,
      chosenEffort: !!ticket.effort || codex || light,
      ...(light ? { light: true as const } : {}),
      ...(codex ? { codex: true as const } : {}),
      ...(handBack.length ? { handBack: true as const } : {}),
      ...(step ? { fresh: step } : {}),
      ...(handoff ? { handoff: true as const } : {}),
      person,
      asker,
      typedBy,
      hashes,
      ...(secretPerson ? { secretPerson } : {}),
      ...(github ? { github: github.login } : {}),
      ...(place.host || worker ? {} : { container: place.container }),
      ...(codex ? {} : { account: claudePlace.account ?? 1 }),
      ...(machines.some((m) => m.owner_id !== null) ? { owned: machines.filter((m) => m.owner_id !== null).map((m) => m.id) } : {}),
      ...(keepalive ? { keepalive: true as const } : {}),
      ...(fp ? { fp, fpParts: fpParts! } : {}),
      // A deploy or close_self that came while it launched (deployLive, closeAfterTurn) is saved with it, as for a running turn.
      ...(this.deployedMidTurn.has(ticket.id) ? { deployed: true as const } : {}),
      ...(this.closing.has(ticket.id) ? { closing: this.closing.get(ticket.id) } : {}),
      ...(!keepalive && this.turnFrom.has(ticket.id) ? { from: this.turnFrom.get(ticket.id) } : {}),
      ...(!keepalive && this.parkedAs.has(ticket.id) ? { parkedAs: this.parkedAs.get(ticket.id) } : {}),
    };
    const kept = keepalive ? null : this.cardWaits.get(ticket.id);
    // shortcut: a resumed turn that fails before the call loses its pass, so the call asks again; save it with the retry if that happens often.
    if (kept?.answer?.allow && batch.some((m) => m.card === kept.id)) turn.pass = { id: kept.id, by: kept.answer.by, call: kept.call };
    this.store.setSetting(turnKey(ticket.id), turn);
    if (kept) this.dropCard(ticket.id, 'The turn ended while this waited.');
    if (kept) this.approvals.resumed(ticket.id);
    const live = this.follow(ticket.id, turn);
    live.had = had;
    // A refresh of the scheme's snapshots since this one's was taken didn't know this turn: it gets the newest now.
    if ((this.refsSeq.get(project.id) ?? 0) !== built.refsSeq) {
      try {
        this.writeRefs(join(dir, 'scheme-refs.json'), ticket);
      } catch {
        // A stale snapshot only means a card goes unchecked.
      }
    }
    // A keepalive never shows as running: the list and the chat don't know it happened.
    if (keepalive) this.keepalives.add(ticket.id);
    else {
      this.setStatus(ticket.id, 'running');
      // The owed resume is paid once the turn is saved as running, not at the take (#1378): recover resumes a running
      // turn: from there, and a crash any sooner still owes it.
      this.queue.owe(ticket.id, null);
      // Saved with a running turn now, so recover() resumes it: the outbox's rows it carries are sent (#1385, ADR 0021 "Accepted means durable").
      try {
        this.onTurnStart(
          ticket.id,
          batch.flatMap((m) => (m.id == null ? [] : [m.id])),
        );
      } catch (err) {
        console.error(`onTurnStart for #${ticket.id} failed:`, err);
      }
    }
    // Its step on the lane lasts until it has ended and its session is saved (finish).
    // Nothing to spawn for a machine's turn: its agent has been told, and asks for what is its own.
    if (plan.spawn.how === 'machine') return { ended: live.ended };
    if (plan.spawn.how === 'container') {
      this.spawnInContainer(place as Exclude<TurnPlace, { host: true }>, dir, plan.spawn.wrapper, ticket.id);
      return { ended: live.ended };
    }
    const { wrapper } = plan.spawn;
    if (plan.spawn.how === 'child') {
      this.spawnWrapper(wrapper, dir);
      return { ended: live.ended };
    }
    const { systemdRun, scope } = plan.spawn;
    const inUnit = () =>
      execFile('systemd-run', systemdRun, (err, _out, stderr) => {
        if (!err) return fallbacks.started();
        fallbacks.record(ticket.id, 'A turn', String(stderr).trim() || err.message);
        live.unit = null;
        this.saveTurn(ticket.id, { unit: null });
        this.spawnWrapper(wrapper, dir);
      });
    // The scope keeps the unit's name, so stopping it by name (signal) reaches it either way.
    if (this.supervisor) {
      live.restart = inUnit;
      // Not taken: its wrapper unit starts now, and rescue stays armed until the turn's pid.json is there.
      void handTurn(this.supervisorSpec(), dir, scope).then((taken) => taken || inUnit());
    } else inUnit();
    return { ended: live.ended };
  }

  /** Which system prompt a turn runs with (src/prompt-hold.ts): the one its session last ran with while it is warm. */
  private holdFor(ticket: Ticket, current: PromptSections): HoldDecision {
    const record = this.promptHolds.record(ticket.id);
    return decideHold({ record, held: record && this.promptHolds.sections(record.hash), current, session: ticket.session_id, lastEnd: this.store.lastTurnEnd(ticket.id), now: this.now() });
  }

  /**
   * A launch from the facts a turn was given (src/turn-launch.ts), in a folder of its own named `name`. A side
   * question's fork (#932, src/side-ask.ts) builds its own here too, so its tools and prompt, the cached prefix,
   * are its minion's turn's. Throws, removing the folder, when the launch can't be built.
   */
  async buildLaunch(
    project: Project,
    ticket: Ticket,
    f: {
      place: TurnPlace;
      person: number | null;
      asker: number | null;
      machines: ReturnType<Runner['machines']>;
      model: string | null;
      effort: string | null;
      typedBy: number | null;
      secrets: Map<string, string>;
      name: string;
      folders: { files: string | null; shared: string | null; memory: string | null };
      codex: { thread: string | null } | null;
      github?: number | null;
      side?: boolean;
      /** The machine it is placed on (workerFor). */
      worker?: { id: number; name: string } | null;
    },
  ) {
    const { place, person, asker, machines, model, effort, codex } = f;
    const { files: filesDir, shared: sharedDir, memory: memoryDir } = f.folders;
    // The turn's folder, with its own copy of the pinned files: a restart sweeps the server's copy, and
    // the tripwire hook must still be there for a turn that outlives it.
    const dir = join(place.host ? this.turnsDir : place.turnsDir, f.name);
    const pin = join(dir, 'pin');
    // Every file call here goes through fs/promises (#1808): on a busy disk a launch's sync calls held the server's thread ~1.2 s.
    await mkdir(dir, { recursive: true });
    try {
      const pins = turnPins();
      await copyPinned(pins.MCP_DIR, pin, !!place.host);
      // Kit skills the scheme turned off on its Skills page (#1062) aren't in this turn's copy at all. Not for Codex:
      // codex-turn.ts installs this kit into the person's shared Codex home, so pruning here would cut it from their other schemes too.
      if (!codex) await pruneKit(join(pin, basename(pins.KIT)), offSkills(project));
      // Deploys, pending-deploy and previews only mean something in the scheme whose code this server runs.
      // Sticky once true (#1276): a `git cat-file` that fails under load would flip it off for one turn, and with it the system prompt.
      const deploys = ticket.kind !== 'coordinator' && !!project.repo_dir && (this.deploysRepos.has(project.repo_dir) || (runsRepo(project.repo_dir, this.liveHead()) && !!this.deploysRepos.add(project.repo_dir)));
      // A file, not an argument: in claude's argv, a turn's own `pkill -f <word from the prompt>` would match claude itself.
      // Builds (specs/build-branches.md): only once the scheme's land.sh can merge into one.
      const builds = landsBuilds(project.repo_dir);
      const build =
        builds && ticket.kind !== 'coordinator' && ticket.build
          ? {
              build: ticket.build,
              branch: buildBranch(project.repo_dir, ticket.build),
              owner: this.store.getSetting<number>(buildOwnerKey(project.id, ticket.build)) === ticket.id,
              // Only this server's own scheme has build previews (src/previews.ts).
              preview: deploys ? `${this.store.getSetting<string>('public_origin') ?? ''}/${buildPreviewPath(ticket.build)}` : null,
            }
          : null;
      // What the Citadel scheme's Taskmaster may read in every scheme this turn (#656): its prompt and its launch say the same.
      const everyScheme = this.everySchemeFor(project, ticket, asker);
      const everySchemeView = everyScheme && {
        data: everyScheme.data,
        schemes: this.store
          .listProjects()
          .filter((p) => p.id !== project.id)
          .map((p) => ({ id: p.id, name: p.name })),
        apps: this.store.listContraptions().map((c) => ({ name: c.name, folder: appFolder(c, homedir()) })),
      };
      // Two halves (#878): system-prompt.md, the same for every minion of the scheme, and the per-minion and volatile lines that open the turn message.
      // Machines a minion may queue jobs on (#857): lent to this scheme with a jobs block; the owner's go card is the gate.
      const jobMachines = ticket.kind === 'coordinator' ? [] : jobMachinesFor(this.store, project.id);
      const parts = promptParts(
        project,
        ticket.kind === 'ticket' ? { ...ticket, type: this.store.props.forTarget('minion', ticket.id).type } : ticket,
        filesDir,
        sharedDir,
        this.ticketsDir(project),
        memoryDir,
        machines,
        deploys,
        this.store.appInstructions().text,
        this.heldFor(ticket.id),
        ticket.kind === 'coordinator' && onboardingOpen(project) ? surveyReports(this.dataDir) : [],
        build,
        builds,
        everySchemeView,
        this.store.personalLayer(ticket),
        this.openPr(ticket.id),
        ticket.kind === 'coordinator' && this.store.isSplit(project.id) ? (ticket.coordinator_of == null ? 'overlord' : 'person') : null,
        jobMachines,
        ticket.kind === 'coordinator' && fableMeter(this.store).over,
      );
      // A warm session keeps the prompt it last ran with (#1276): a changed byte would re-write its whole cached conversation.
      // Codex has no such cache to keep.
      const current = parts.system;
      const hold = codex ? null : this.holdFor(ticket, current);
      if (hold) parts.system = hold.system;
      const system = promptText(parts.system);
      await writeFile(join(dir, 'system-prompt.md'), system);
      // The scheme's review set (Build 4), fresh each turn so a page edit or a kit starter fix reaches the next turn's critics.
      const reviewDir = join(dir, 'review-set');
      const reviews = withoutGoneAgents(this.store.reviews.list(project.id), readAgentFiles(project.repo_dir));
      // Phase 3: people's recorded verdicts, and the minion's ask for entries that read the requester's words.
      const verdicts = this.store.reviews.verdicts(project.id);
      const reviewFiles = new Map<string, string>();
      const reviewOn = renderSet(reviews, reviewDir, verdicts, reviews.some((e) => e.enabled && e.context.requester) ? this.store.reviews.requesterWords(ticket.id) : null, reviewFiles);
      // A scheme with no reviewers on gets no review-set line; the kit line says only what it changed from the kit's defaults.
      parts.turn.reviewSet = [reviewOn ? reviewSetLine(reviewDir, reviewOn, reviews) : '', kitLine(reviews, join(dir, 'review-kit'), verdicts, this.store.reviews.lessons(project.id), reviewFiles)].filter(Boolean);
      for (const [file, text] of reviewFiles) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text);
      }
      // Its budget (#1114) each turn: what its kind of work usually costs and what it has used.
      const budget = ticket.kind === 'ticket' ? budgetFor(this.store, ticket) : null;
      if (budget) parts.turn.budget = [turnLine(budget, this.store.ticketCost(ticket.id))];
      // The seam trial's fresh group (#1129), while its context is past the mark: hand off at a seam it picks.
      const seamSize = this.store.getSetting<number>(contextKey(ticket.id));
      const seamFresh = ticket.kind === 'ticket' && armOf(this.store.getSetting<SeamTrial>(SEAM_TRIAL_KEY), ticket.id) === 'fresh';
      if (seamFresh && seamSize && seamSize > SEAM_CONTEXT_TOKENS) parts.turn.seamTrial = [trialLine(seamSize)];
      const jobs = this.jobs?.turnLine(ticket.id);
      if (jobs) parts.turn.jobs = [jobs];
      // What changed since the held prompt, last in the turn's [System] note. A side question's fork gets the prompt, not the note.
      if (hold?.note) parts.turn.rulesChanged = [hold.note];
      const context = promptText(parts.turn);
      // Its own temp folder on disk, cleared on dismissal (#218). CLAUDE_CODE_TMPDIR moves Claude Code's
      // /tmp/claude-<uid>, which ignores TMPDIR. A command or script that sets its own TMPDIR still wins.
      let tmp: string | null = null;
      try {
        tmp = makeTmpDir(this.tmpRoot(project.id), ticket.id);
      } catch (err) {
        this.emit(ticket.id, 'note', { text: `Could not make this minion's temp folder, so it uses the shared one: ${thrown(err).message}` });
      }
      // The link check reads the reply against the folders the chat serves this turn's files from (ticketRoots).
      // A file, not an argument: a scheme's minion list outgrows a command line.
      // A refresh before follow() misses this turn: launchTurn rewrites it when one ran (refsSeq).
      const refsSeq = this.refsSeq.get(project.id) ?? 0;
      await writeFile(join(dir, 'scheme-refs.json'), this.refsText(ticket));
      // A host turn has no Codex hook, so the server login's Codex reviews run in its Codex container (#398): woken
      // (by the caller) if it stopped (a reboot) without replacing one a review may be running in.
      const codexAt = place.host && person !== null ? (this.codexPlaceFor?.(person) ?? null) : null;
      const reviewAt = codexAt && !codexAt.host ? codexAt : null;
      // CITADEL_, not COORDINATOR_: a warm turn's flag must not move the keepalive fingerprint (src/keepalive.ts).
      const coordinator = { ...this.coordinatorEnv(ticket), ...(hold?.warm ? { CITADEL_TOOL_HOLD: '1' } : {}) };
      const heavy = this.heavyEnv(ticket, person);
      // The person's own GitHub token (or none, so it can't push), and a line saying whose it is. Its empty gh folder made here, off the thread (#1808).
      const github = this.githubFor?.(f.github === undefined ? person : f.github, dir, true) ?? null;
      if (github?.env.GH_CONFIG_DIR) await mkdir(github.env.GH_CONFIG_DIR, { recursive: true, mode: 0o700 });
      const typer = f.typedBy ? this.store.getUser(f.typedBy) : undefined;
      const homeOf = this.store
        .listContraptions()
        .filter((c) => c.home_scheme === project.id)
        .map((c) => c.name);
      // A side question's fork runs as the server's child: it is short, and a restart loses it anyway.
      const unit = this.units && place.host && !f.side && !f.worker ? `citadel-turn-${this.unitTag}-${basename(dir)}` : null;
      // A host turn with no unit of its own (a side question) keeps its own helpers: a pool it started would live in the
      // server's cgroup and die on the next deploy restart, with every host turn's calls.
      // Everything the turn is launched with, from the facts chosen above (src/turn-launch.ts).
      const plan = launchPlan({
        project,
        ticket,
        dir,
        pins,
        place,
        machines,
        model,
        effort,
        deploys,
        unit,
        pool: this.pool && !codex && (!!f.worker || !(place.host && !unit && this.units)),
        machine: !!f.worker,
        folders: {
          files: filesDir,
          shared: sharedDir,
          memory: memoryDir,
          tmp,
          tickets: this.ticketsDir(project),
          data: dirname(this.store.path),
          // A Taskmaster's git rules cover only open minions' worktrees (coordinatorAccess).
          openTickets:
            ticket.kind === 'coordinator'
              ? this.store
                  .listTickets(project.id)
                  .filter((t) => t.kind !== 'coordinator' && t.status !== 'closed' && t.cwd)
                  .map((t) => t.cwd!)
              : undefined,
        },
        codex,
        codexReview: reviewAt ? { container: reviewAt.container, turnsDir: reviewAt.turnsDir, env: reviewAt.env } : null,
        env: { server: process.env, coordinator, heavy, github: github?.env ?? null, secrets: secretEnv(f.secrets) },
        memory: this.memoryScheme(project.id),
        media: !!this.mediaFor?.(person),
        // A Codex turn has image_gen itself; a host turn reaches Codex only through the person's Codex container.
        codexImages: !codex && ticket.kind !== 'coordinator' && !this.codexWhy(person) && (!place.host || !!reviewAt),
        typer: typer && !typer.disabled_at ? { id: typer.id, login: typer.login } : null,
        homeContraptions: homeOf,
        jobMachines,
        seamTrial: seamFresh,
        appTurnsRun: ticket.kind !== 'coordinator' && homeOf.length > 0 && isAppTurnsRun(this.store, ticket),
        everyScheme,
        claudeBin: this.claudeBin,
        ...(f.side ? { side: true } : {}),
      });
      return { plan, dir, system, parts, context, pins, github, unit, reviewAt, refsSeq, hold: hold && { decision: hold, current } };
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * Start a side question's fork (#932, src/side-ask.ts): the minion's own launch (buildLaunch, with the read-only
   * guard) on the asker's login, resuming `resume` (the minion's session, forked; or the fork, for a follow-up), with
   * `prompt` as its message. Nothing of the minion's changes: not its session, state or queue. Throws with a reason
   * people can read when it can't start.
   */
  async sideLaunch(ticketId: number, asker: number, prompt: string, resume: { id: string; fork: boolean }) {
    if (this.noTurns) throw new Error('This is a preview: it never runs turns.');
    const ticket = this.store.getTicket(ticketId);
    const project = ticket && this.store.getProject(ticket.project_id);
    if (!ticket || !project || ticket.kind === 'coordinator' || !ticket.cwd) throw new Error('Only a minion with a folder can be asked on the side.');
    // Sender pays (#213): the asker's own login, never the minion's person's. The minion's warm key, so its warm account wins when it is the asker's.
    const place = this.placeFor?.(asker, warmKey(ticket)) ?? { host: true as const };
    if ('refused' in place) throw new Error(place.refused);
    const { model, effort } = turnSettings(ticket, project);
    if (isCodexModel(model) || this.store.getSetting<CodexThread>(codexThreadKey(ticket.id))) throw new Error('This minion runs on Codex, so it has no Claude session to ask on the side.');
    // The tools come from the minion's own turn's people (its person and asker), so the fork's cached prefix is the turn's.
    const person = ticket.person_id;
    const turnAsker = this.store.turnAsker(ticket.id) ?? person;
    const machines = this.machines(project, turnAsker !== null ? [turnAsker] : []);
    const { plan, dir } = await this.buildLaunch(project, ticket, {
      place,
      person,
      asker: turnAsker,
      machines,
      model,
      effort,
      typedBy: null,
      secrets: new Map(),
      name: `side-${ticket.id}-${Date.now()}`,
      folders: { files: this.filesDir(ticket), shared: this.sharedDir(project), memory: null },
      codex: null,
      github: asker,
      side: true,
    });
    try {
      for (const f of plan.files) await writeFile(join(dir, f.name), f.text, f.mode === undefined ? {} : { mode: f.mode });
      // The asker's login may lack the minion's session: put back the database's copy, as of its last finished turn.
      // shortcut: mid-turn on another login, the fork sees the session as its last turn left it; copying the live transcript across would show the turn so far.
      if (resume.fork) await restoreSession(this.store, ticket, project, plan.configDir);
      if (!(await exists(transcriptPath(plan.configDir, ticket.cwd, resume.id)!))) throw new Error(resume.fork ? 'This minion has no session to ask yet.' : 'This side thread has ended; ask a new question.');
      plan.args.push('--resume', resume.id, ...(resume.fork ? ['--fork-session'] : []));
      await writeFile(join(dir, 'prompt.jsonl'), prompt);
      for (const f of ['stream.jsonl', 'stderr.log', 'steer.jsonl']) await writeFile(join(dir, f), '');
      await writeFile(join(dir, 'spec.json'), JSON.stringify(wrapperSpec(plan, ticket.cwd)), { mode: 0o600 });
      if (plan.spawn.how === 'container') await containerFiles(dir, place as Extract<TurnPlace, { host: false }>);
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
    if (plan.spawn.how === 'container') this.spawnInContainer(place as Extract<TurnPlace, { host: false }>, dir, plan.spawn.wrapper, ticket.id);
    else this.spawnWrapper(plan.spawn.wrapper, dir);
    return { dir, configDir: plan.configDir, cwd: ticket.cwd, account: place.account ?? 1, container: place.host ? null : place.container };
  }

  /**
   * Start a turn's wrapper in the person's container, detached. Rootless podman leaves an exec's conmon
   * in the caller's cgroup, so a restart of this server's unit SIGTERMs it (conmon passes that on to the
   * wrapper, which ignores it), waits out the stop timeout and SIGKILLs it (#258). So with units,
   * `podman exec` runs in a transient scope under the turns slice (a Taskmaster's under theirs), which the restart leaves alone and
   * which goes once the turn ends. The wrapper's pids are the container's, so the `container` file
   * tells wrapperAlive to go by its heartbeat instead, and on a stale one by whether the wrapper is still in /proc.
   */
  private spawnInContainer(place: Extract<TurnPlace, { host: false }>, dir: string, wrapper: string[], ticketId: number) {
    // Its `container` and first beat are written already (containerFiles); later beats go off the thread too (#1808).
    const beat = () => void writeFile(join(dir, 'beat'), '').catch(() => {});
    // Starting the container (building its image, the first time) can take minutes; it counts as running meanwhile.
    const starting = setInterval(beat, 5_000);
    // Both return as soon as the wrapper is started. One that hangs (a stuck podman lock) would keep the turn "running" for good.
    const run = ([cmd, ...args]: string[]) =>
      new Promise<void>((resolve, reject) => {
        execFile(cmd, args, { timeout: this.containerStartMs }, (err, _out, stderr) => (err ? reject(new Error(err.killed ? `${cmd} did not return within ${this.containerStartMs / 1000} s` : String(stderr).trim() || err.message)) : resolve()));
      });
    // Stopped while it started (stop() wrote exit.json), and maybe finished since: nothing more to start or to say.
    const over = async () => !(await exists(dir)) || exists(join(dir, 'exit.json'));
    const exec = ['podman', 'exec', '-d', place.container, ...wrapper];
    const scoped = ['systemd-run', '--user', '--scope', '--collect', '--quiet', `--unit=citadel-turn-${this.unitTag}-${basename(dir)}`, `--slice=${this.store.getTicket(ticketId)?.kind === 'coordinator' ? TASKMASTER_SLICE : TURN_SLICE}`, ...exec];
    place
      .ensure()
      // As with host turns, a failed systemd-run still runs the turn, though a restart then SIGKILLs its conmon.
      // Only an exec that then starts counts as a fallback: one that fails both ways was podman's trouble.
      .then(async () =>
        (await over())
          ? undefined
          : this.units
            ? run(scoped).then(
                () => fallbacks.started('scope'),
                (err) => run(exec).then(() => fallbacks.record(ticketId, `A turn in ${place.container}`, err.message, Date.now(), 'scope')),
              )
            : run(exec),
      )
      .catch(async (err) => !(await over()) && writeFile(join(dir, 'exit.json'), JSON.stringify({ code: null, signal: null, error: `${place.container}: ${err.message}` })))
      .catch((err) => console.error(`Minion ${ticketId}: could not write its turn's exit.json:`, err))
      .finally(() => clearInterval(starting));
  }

  /** Start a turn's wrapper as a detached child: no unit, so it dies when the service restarts. */
  private spawnWrapper([command, ...args]: string[], dir: string) {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => writeFileSync(join(dir, 'exit.json'), JSON.stringify({ code: null, signal: null, error: err.message })));
    child.unref();
  }

  /** Start tailing a turn's folder; the turn counts as running from here until finish(). */
  private follow(ticketId: number, turn: TurnState): LiveTurn {
    let end!: () => void;
    const ended = new Promise<void>((resolve) => (end = resolve));
    const live: LiveTurn = {
      dir: turn.dir!,
      unit: turn.unit ?? null,
      offset: turn.offset ?? 0,
      startedAt: turn.startedAt ?? Date.now(),
      configDir: turn.configDir ?? claudeConfigDir(process.env),
      chosenEffort: !!turn.chosenEffort,
      container: turn.container ?? null,
      ticks: 0,
      timer: setInterval(() => this.poll(ticketId), this.pollMs),
      ended,
      end,
      had: null,
      // After a restart the clock starts again: what ran before isn't known.
      activity: { at: Date.now(), tools: [] },
      calls: newCalls(turn.background),
      ...(turn.card ? { card: true } : {}),
      ...(turn.unread ? { unread: turn.unread } : {}),
    };
    // The server's listener keeps the process up; a Runner alone (a test) can exit with turns followed.
    live.timer.unref();
    this.turns.set(ticketId, live);
    return live;
  }

  private poll(ticketId: number) {
    const live = this.turns.get(ticketId);
    if (!live) return;
    try {
      // Checked before reading: once exit.json is there, everything claude wrote is in the stream. Only after the folder
      // changed (dirChanged), so a quiet tick makes no file-name lookup at all (#1562).
      // Once seen, it is looked for every tick until handled: a tick that failed on it can't leave the turn running.
      const exited = (live.exitSeen = (live.exitSeen || this.dirChanged(live)) && existsSync(join(live.dir, 'exit.json')));
      this.readStream(ticketId, live, exited);
      const exit = exited ? JSON.parse(readFileSync(join(live.dir, 'exit.json'), 'utf8')) : null;
      // Whether its claude has started (pid.json), looked up only while a stop or a rescue waits on it.
      const started = !!(live.stopPending || live.restart) && existsSync(join(live.dir, 'pid.json'));
      // stop()'s own exit.json, but claude has started since: the turn ends with its wrapper's, once the signal below lands.
      if (exit?.stopped && live.stopPending && started) rmSync(join(live.dir, 'exit.json'), { force: true });
      else if (exit) return this.finish(ticketId, live, exit);
      // Stopped while still starting: its claude has a pid now (#468 S03-2). The SIGKILL retry still follows.
      if (live.stopPending && started) {
        live.stopPending = false;
        this.stopSignals(live, ticketId);
      }
      if (live.ticks % 40 === 0) this.checkQuiet(ticketId, live);
      this.rescue(ticketId, live, started);
      // Gone without a word: killed with its unit (out of memory, say).
      if (++live.ticks % 20 === 0) {
        if (this.gone(live)) {
          this.readStream(ticketId, live, true);
          this.finish(ticketId, live, null);
        } else if (this.supervisor) runningTurn(live).keepUp(() => ensureSupervisor(this.supervisorSpec()));
      }
    } catch (err) {
      console.error(`Ticket ${ticketId}: following its turn failed:`, err);
    }
  }

  /**
   * Whether an entry in the turn's folder was made, renamed or removed since the last look (exit.json, pid.json): its
   * kept-open folder's mtime, by fstat. A change is looked at on that tick and the next, since a file's times are as
   * coarse as the kernel's tick and a second file made in the same tick leaves the mtime as it was. Until the folder
   * is open (opened off the thread), or when it can't be, every tick counts as a change, as every tick looked before.
   */
  private dirChanged(live: LiveTurn): boolean {
    if (live.dirFd === undefined) {
      live.dirFd = null;
      open(live.dir, 'r', (err, fd) => {
        if (err)
          live.dirFd = undefined; // tried again next tick
        else if (live.unfollowed) close(fd, () => {});
        else live.dirFd = fd;
      });
    }
    if (live.dirFd === null) return true;
    try {
      const at = fstatSync(live.dirFd).mtimeMs;
      if (at !== live.dirSeen) {
        live.dirSeen = at;
        live.dirAgain = true;
        return true;
      }
    } catch {
      return true;
    }
    if (!live.dirAgain) return false;
    live.dirAgain = false;
    return true;
  }

  /** Close what following a turn kept open (#1562): once it's no longer followed. */
  private unfollow(live: LiveTurn) {
    live.unfollowed = true;
    for (const fd of [live.streamFd, live.dirFd]) if (fd != null) close(fd, () => {});
    live.streamFd = live.dirFd = undefined;
  }

  /** The shared stream buffer, and whether a read is using it: a line's handling that reads a stream again gets its own. */
  private streamBuf?: Buffer;
  private streamBusy = false;

  /**
   * Handle the stream's new complete lines, and with `toEnd` a last line without its newline. The file stays open
   * (unfollow closes it) and its size is asked first, so a tick with nothing new reads nothing (#1562).
   */
  private readStream(ticketId: number, live: LiveTurn, toEnd: boolean) {
    if (live.streamFd === undefined) {
      try {
        live.streamFd = openSync(join(live.dir, 'stream.jsonl'), 'r');
      } catch {
        return;
      }
    }
    const fd = live.streamFd;
    if (fstatSync(fd).size <= live.offset) return;
    const busy = this.streamBusy;
    let buf = busy ? Buffer.allocUnsafe(STREAM_CHUNK) : (this.streamBuf ??= Buffer.allocUnsafe(STREAM_CHUNK));
    this.streamBusy = true;
    try {
      for (;;) {
        const size = buf.length;
        const n = readSync(fd, buf, 0, size, live.offset);
        if (!n) return;
        const atEnd = n < size;
        const end = buf.lastIndexOf(10, n - 1) + 1;
        if (!end && !atEnd) {
          buf = Buffer.allocUnsafe(size * 2); // one line longer than the buffer: this read's own, the shared one stays
          continue;
        }
        const take = toEnd && atEnd ? n : end;
        if (!take) return;
        const base = live.offset;
        for (let start = 0; start < take; ) {
          const nl = buf.indexOf(10, start);
          const stop = nl < 0 || nl >= take ? take : nl;
          const line = buf.toString('utf8', start, stop);
          start = stop + 1;
          try {
            this.handleLine(ticketId, line, (error, text) => this.saveTurn(ticketId, { result: { error, text } }));
          } catch (err) {
            this.emit(ticketId, 'note', { text: `Could not process output line: ${thrown(err).message}` });
          }
          // Saved per line, so a restart carries on from the next one: nothing shown twice or skipped.
          live.offset = base + Math.min(start, take);
          this.saveTurn(ticketId, { offset: live.offset });
        }
        if (atEnd) return;
      }
    } finally {
      this.streamBusy = busy;
    }
  }

  /** A turn's process has exited (exit is null when it was killed without recording how). */
  private finish(ticketId: number, live: LiveTurn, exit: { code: number | null; signal: string | null; error?: string } | null) {
    try {
      this.wrapUp(ticketId, live, exit);
    } catch (err) {
      // Whatever failed, the turn is over: its lane must free up, or no message starts a turn again.
      live.end();
      throw err;
    }
  }

  private wrapUp(ticketId: number, live: LiveTurn, exit: { code: number | null; signal: string | null; error?: string } | null) {
    clearInterval(live.timer);
    this.unfollow(live);
    this.clock.clearTimeout(live.stopTimer);
    this.clock.clearTimeout(live.stopGraceTimer);
    this.turns.delete(ticketId);
    this.spends.delete(ticketId);
    // Kept for the failure note below, which quotes its stderr.
    const secrets = this.secretsOfTurn(ticketId);
    this.turnSecrets.delete(ticketId);
    const turn = this.store.getSetting<TurnState>(turnKey(ticketId));
    const stopped = !!turn?.stopped;
    // Steers that came in as the turn's reply went out never reached claude: they start the next turn. Moved back into
    // the queue before the turn's record goes, which is what says which were passed on.
    const unsent = turn && !stopped ? unsentSteers({ steered: this.queue.steers(ticketId), dir: turn.dir }) : [];
    this.queue.endSteers(ticketId, unsent);
    // The save is owed before the turn's record goes, so a crash between finds one of them and never gives back the
    // batch this turn already answered (#1378): recover redoes the save, which takes it out of the queue.
    this.store.setSetting(savingKey(ticketId), { configDir: live.configDir });
    this.store.deleteSetting(turnKey(ticketId));
    // Its session's cache is warm on this account for the next hour (src/account-pick.ts): its next turn stays there.
    if (turn?.person && !turn.codex && turn.account) this.onRan?.(turn.person, `ticket:${ticketId}`, turn.account);
    if (this.keepalives.delete(ticketId)) return this.keepaliveRun.wrapUpKeepalive(ticketId, live, turn, exit);
    this.keepKilled(ticketId, turn, exit);
    if (unsent.length) {
      this.emit(ticketId, 'note', { text: `${unsent.length === 1 ? 'A message' : `${unsent.length} messages`} arrived as the turn ended, so the next turn picks ${unsent.length === 1 ? 'it' : 'them'} up.` });
    }
    // A Codex turn's log joins its thread's, for the way back to Claude (#337); the turn's folder goes below.
    if (turn?.codex) this.keepCodexLog(ticketId, live.dir);
    const code = exit?.code ?? null;
    const startError = exit?.error ? `Could not start claude: ${exit.error}` : null;
    if (startError && stopped) this.emit(ticketId, 'error', { text: startError });
    this.statuses.delete(ticketId);
    let stderr: string[] = [];
    try {
      stderr = readFileSync(join(live.dir, 'stderr.log'), 'utf8').split('\n').filter(Boolean);
    } catch {
      // No stderr.
    }
    this.approvals.endTurn(ticketId, stopped ? 'The turn was stopped while this waited.' : 'The turn ended while this waited.');
    const closing = this.closing.has(ticketId);
    const closeReason = this.closing.get(ticketId);
    this.closing.delete(ticketId);
    // What the ending means is src/turn-outcome.ts's (#1379); this carries it out.
    // A machine's turn ran in its worker's container, out of this server's reach: a kill there is never this server's restart.
    const onMachine = runningTurn(live) instanceof MachineTurn;
    const end: TurnEnd = { turn, exit, stderr, closing, ran: { unit: !!live.unit || onMachine, container: !!live.container || onMachine } };
    let out = outcome(end);
    // A row that outlives the chat's (#1325): kill waves (systemd-oomd's, most often) are counted from these.
    if (out.killed) {
      const at = Date.now(),
        how = exit?.signal ?? (exit ? 'SIGTERM (exit 143)' : 'its unit or process group was killed, no exit noted');
      const row = (oom: boolean) => this.store.addHealthEvent('turn-killed', at, null, `minion ${ticketId}${live.unit ? ` (${live.unit})` : ''}: ${oom ? 'out of memory, says the journal: ' : ''}${how}`);
      if (live.unit) void oomKilled(live.unit).then(row, () => row(false));
      else row(false);
    }
    const cleared = out.followUps.includes('cleared');
    const status: 'idle' | 'error' = cleared || out.kind === 'stopped' || out.kind === 'paused' || out.kind === 'card' ? 'idle' : 'error';
    if (out.kind === 'paused') this.waitOutPause(ticketId, turn!, out.retry!);
    if (status === 'error') {
      out = this.endFailed(ticketId, live, turn, end, out, hideSecrets(stderr.slice(-10).join('\n'), secrets), code);
      const said = out.killed && !exit ? this.store.eventsOfKinds(ticketId, ['note', 'error']).findLast((e) => JSON.parse(e.data).text?.startsWith(out.killed)) : undefined;
      if (said) this.killWaves.add(live.container, Date.now(), said);
    }
    // Claude has the Codex turns now.
    else if (cleared && turn?.handBack) this.store.deleteSetting(codexThreadKey(ticketId));
    // A hand-back turn that failed or was stopped may still have done work Codex's thread never saw: the next Codex turn starts a new one from the hand-over.
    const back = turn?.handBack ? this.store.getSetting<CodexThread>(codexThreadKey(ticketId)) : null;
    if (back?.thread) this.store.setSetting(codexThreadKey(ticketId), { ...back, thread: null });
    // A fresh session's handoff is in its transcript once the session exists (#406); then the fresh start's own step, if any.
    if (turn?.handoff && this.store.getTicket(ticketId)?.session_id) this.store.deleteSetting(handoffKey(ticketId));
    this.fresh.endFresh(ticketId, turn ?? null, cleared, stopped);
    // Still sealed after answering: the row stays sealed, whatever state the turn set. A failed turn keeps its error note.
    const parkedAs = this.parkedAs.get(ticketId);
    this.parkedAs.delete(ticketId);
    if (parkedAs && status !== 'error' && this.heldFor(ticketId)) this.store.updateTicket(ticketId, parkedAs);
    if (cleared) this.clearFailNote(ticketId);
    const ran = this.store.getTicket(ticketId);
    const ranIn = ran && this.store.getProject(ran.project_id);
    if (cleared && !turn?.codex && ran && ranIn) {
      if (turn?.person && turn.account) this.onCleared?.(turn.person, turn.account);
      this.limitCleared(this.payerOf(turn?.person), turnSettings(ran, ranIn).model);
    }
    // Checked again here: the turn may have posted a card or set try/ready after close_self.
    // A notice that needs no action (the PR it just merged, #619) doesn't count as a new message; it stays in the chat, unrun.
    const close = out.followUps.includes('close');
    const asks = this.queue.msgs(ticketId).some((m) => !m.fyi);
    const keep = close ? (asks ? 'a new message arrived' : this.keptOpen(ticketId)) : null;
    if (close && !keep) {
      this.close(ticketId, `Claude dismissed this minion${closeReason ? `: ${closeReason}` : '.'}`);
    } else {
      if (keep) this.emit(ticketId, 'note', { text: `Claude asked to dismiss this minion, but ${keep}, so it stays open.` });
      // The note is for people; the next turn hears it too, so the minion doesn't sit open unaware (#619).
      if (keep) this.store.setSetting(closeCancelledKey(ticketId), keep);
      this.setStatus(ticketId, status);
    }
    if (turn && out.followUps.includes('fresh')) this.fresh.freshAtTurnEnd(ticketId, turn);
    // A real turn that ended well starts a keepalive series from the prefix it cached (#862); anything else ends the series.
    if (turn?.fp && turn.fpParts && out.followUps.includes('keepalive')) this.store.setSetting(keepaliveKey(ticketId), { fp: turn.fp, parts: turn.fpParts, since: Date.now(), ...(turn.light ? { light: true as const } : {}) } satisfies KeepaliveSeries);
    else this.store.deleteSetting(keepaliveKey(ticketId));
    // A failed or stopped turn leaves it open; a queued message makes deployLive wait for that turn too.
    if (this.deployedMidTurn.delete(ticketId) && out.followUps.includes('deploy-note')) this.deployLive(ticketId);
    void dropTurnDir(live.dir); // renamed aside at once, deleted off the thread (#1459)
    this.onFilesMayChange(ticketId, true);
    // The emulator lease (#1128) ends with the turn that took it.
    const endedTicket = this.store.getTicket(ticketId);
    if (endedTicket) releaseEmulatorLease(join(this.dataDir, 'projects', '.heavy'), this.heavyEnv(endedTicket, endedTicket.person_id).CITADEL_HEAVY_WHO!);
    this.compactWatch.ended(ticketId);
    this.onTurnEnd(ticketId);
    // Re-read the ticket: the turn may have given it its first (or a new) session id.
    const after = this.store.getTicket(ticketId);
    const project = after && this.store.getProject(after.project_id);
    // Only a turn that ran on Claude Code's default effort says what "Default" means for this thread.
    const effort = after && !live.chosenEffort && lastEffort(after, live.configDir);
    if (after && effort && effort !== after.last_effort) {
      this.store.updateTicketQuietly(ticketId, { last_effort: effort });
      this.broadcastTicket(ticketId);
    }
    // The next turn may run on another person's login, which only has the session once this lands (#250):
    // the turn's step on its lane ends with the save, so the next step starts after it.
    if (!after || !project) {
      this.queue.done(ticketId);
      this.store.deleteSetting(savingKey(ticketId));
      return live.end();
    }
    // Messages queued during the turn wait in the queue for the save.
    this.saveAfterTurn(ticketId, live.configDir, live.had).then(live.end);
  }

  /**
   * A dismissal or live deploy that waited for a keepalive, or for a launch that started no turn (#1808): not running
   * now, so each acts as it would have on the idle minion; a message that came in meanwhile keeps it open.
   */
  private actOnDeferred(ticketId: number, closing: boolean, closeReason: string | null, deployed: boolean, kept: string | null = null) {
    if (closing) {
      const keep = kept ?? (this.queue.msgs(ticketId).some((m) => !m.fyi) ? 'a new message arrived' : this.keptOpen(ticketId));
      if (keep) this.emit(ticketId, 'note', { text: `${(closeReason ?? 'It was set to be dismissed.').replace(/,? so it dismissed this fix minion\.?$/, '.')} It stays open: ${keep}.` });
      else void this.close(ticketId, closeReason ?? 'Claude dismissed this minion.');
    }
    if (deployed && !kept) this.deployLive(ticketId);
  }

  /** Copy a minion's session into the database after its turn (or a restart cut that off); never rejects. Counted for settled() (#1437). */
  private saveAfterTurn(ticketId: number, configDir: string, had: Set<string> | null) {
    return track('session saves', this.saveAfterTurnNow(ticketId, configDir, had));
  }

  private async saveAfterTurnNow(ticketId: number, configDir: string, had: Set<string> | null) {
    try {
      const ticket = this.store.getTicket(ticketId);
      const project = ticket && this.store.getProject(ticket.project_id);
      if (ticket && project) await this.saveSession(this.store, ticket, project, configDir, had);
    } catch (err) {
      console.error(`Saving the session of ticket ${ticketId} failed:`, err);
    } finally {
      // The turn's batch is in its saved transcript now: out of the queue (#1378), in the same order a restart redoes it.
      this.queue.done(ticketId);
      this.store.deleteSetting(savingKey(ticketId));
    }
  }

  /** Write a note about a failure, remembered so the next turn that ends well can clear it. */
  private setFailNote(ticketId: number, fields: { note: string; state?: TicketState }) {
    this.store.updateTicket(ticketId, fields);
    this.store.setSetting(failNoteKey(ticketId), fields.note);
  }

  /** A turn ended well: the failure note goes, unless something (the agent, a person) has replaced it since. */
  private clearFailNote(ticketId: number) {
    const note = this.store.getSetting<string>(failNoteKey(ticketId));
    if (note === null) return;
    this.store.deleteSetting(failNoteKey(ticketId));
    if (this.store.getTicket(ticketId)?.note === note) this.store.updateTicket(ticketId, { note: null });
  }

  /**
   * Carry out a failed ending (`out`): its account's sign-in, a switch onto another of its person's accounts, the kill
   * line, or turnFailed's note, wait or error. `turn` is null only for one that never started. Returns the outcome
   * after the account pick.
   */
  private endFailed(ticketId: number, live: LiveTurn, turn: TurnState | null, end: TurnEnd, out: Outcome, stderr: string, code: number | null): Outcome {
    // A container's sign-in that stopped working: their messages wait until they link again.
    if (out.authFailed) this.onAuthFailure?.(turn!.person!, turn!.account);
    const payer = this.payerOf(turn?.person);
    const usage = this.store.getSetting<Usage>(accountUsageKey(payer, turn?.account));
    const codexReset = turn?.codex && turn.person ? codexResetAt(this.store.getSetting<CodexUsage>(codexUsageKey(turn.person))) : undefined;
    const limit = !!out.reason && USAGE_LIMIT.test(out.reason);
    let pick: ReturnType<Runner['pickAccount']> = null;
    if (out.askAccount) {
      pick = this.pickAccount(turn!, out.reason, usage, limit);
      out = outcome({ ...end, account: pick ? ('resetAt' in pick ? 'all-limited' : 'ready') : null });
    }
    if (out.kind === 'switch-account' && out.retry && pick && !('resetAt' in pick)) {
      const why = limit ? out.reason! : `This account's Claude sign-in expired: link it again in Settings → Your account.`;
      this.emit(ticketId, 'note', { text: `${why}\nCarrying on with ${pick.label} (account ${pick.n}): this turn picks up where it stopped.` });
      // Owed until its turn takes it (takeQueue): it waits behind this turn's save, and the turn's own record is gone,
      // so a restart meanwhile would otherwise leave nothing to say it carries on (A1, #1286).
      this.queue.owe(ticketId, owedOf('switch', out.retry.retries));
      this.resume(ticketId, 'switch', out.retry.retries);
      return out;
    }
    if (out.switchesSpent) this.emit(ticketId, 'note', { text: `It has already switched Claude accounts ${out.switchesSpent} times in a row, so it stops switching.` });
    if (out.authFailed) this.emit(ticketId, 'note', { text: `${this.store.getUser(turn!.person!)?.name ?? 'This person'}'s Claude sign-in expired. Link Claude again in Settings → Your account; their messages wait until then.` });
    // Killed from outside before it finished: the server resumes it once (#1364); a second kill in a row stops.
    if (out.kind === 'killed' && out.retry) this.waitForKillResume(ticketId, live, out.retry.retries, out.killed!);
    else this.turnFailed(ticketId, out, stderr, code, usage, codexReset, pick && 'resetAt' in pick ? pick : undefined);
    return out;
  }

  /**
   * Say why a turn failed, leading with Claude's own words (its result's error, else its last stderr
   * lines). A usage limit is a wait, not an error: no push, and it resumes after the reset. An account
   * problem needs a person: it blocks, never retries, and pushes once for everyone.
   */
  private turnFailed(ticketId: number, out: Outcome, stderr: string, code: number | null, usage = this.usage, codexReset?: number | null, allLimited?: AllLimited) {
    const reason = out.spent?.via === 'kill' ? `${out.reason}\nIt was already resumed once after a kill, so it stopped for good: send a message to carry on.` : out.reason;
    const exited = code ? `claude exited with code ${code}` : 'claude ended without finishing';
    const why = reason || stderr;
    const text = why ? `${why}${reason && stderr ? `\n${stderr}` : ''}\n(${exited})` : exited;
    const first = (why || exited).split('\n')[0];
    const short = (s: string) => (s.length > 60 ? s.slice(0, 59) + '…' : s);
    // A deploy still waiting to go live keeps its state, so the deploy can dismiss the minion.
    const keepState = this.store.getTicket(ticketId)?.state === 'pending-deploy';
    if (out.kind === 'limit' && reason) {
      if (out.spent) {
        const limitTries = out.spent.tries;
        this.emit(ticketId, 'note', { text: `${reason}\nIt has already resumed ${limitTries} times in a row after the usage limit, so it waits for a message now.` });
        if (!keepState) this.store.updateTicket(ticketId, { state: 'limited', note: `Usage limit: gave up after ${limitTries} tries, send a message` });
        this.onTurnError(ticketId, `Usage limit: gave up after ${limitTries} resumes in a row`);
        return;
      }
      // A Codex turn's limit (codexReset is set, maybe null) is Codex's own windows, never Claude's.
      // Every one of several accounts limited (#779): the first of them to reset.
      const resetAt = allLimited?.resetAt ?? this.limitResetAt(reason, usage, codexReset);
      const at = this.resumes.waitForLimit(ticketId, resetAt, out.retry!.retries.limit!, allLimited?.accounts);
      const tail = allLimited?.accounts.length ? allLimitedText(allLimited.accounts, at) : `It resumes by itself at ${clockTime(at)}, or sooner once a turn on this plan gets through (a reset, say); a person's message tries now.`;
      this.emit(ticketId, 'note', { text: `${reason}\n${tail}` });
      if (!keepState) this.store.updateTicket(ticketId, { state: 'limited', note: `Usage limit, resumes ${clockTime(at)}` });
      return;
    }
    if (out.kind === 'account-error') {
      this.emit(ticketId, 'error', { text: `${text}\nThis needs a person to sort out the Claude account; it won't retry by itself.` });
      if (!keepState) this.setFailNote(ticketId, { state: 'blocked', note: short(`Needs a person: ${first.replace(/^API Error: \d+ /, '')}`) });
      if (this.firstAccountPush(first)) {
        this.onTurnError(ticketId, first);
      }
      return;
    }
    // Unreachable network or API: one probe loop waits for it to come back, then resumes (#366). No push: an outage hits everyone at once.
    if (out.kind === 'net' && out.retry) {
      this.resumes.waitForNetwork(ticketId, out.retry.retries.net!);
      this.emit(ticketId, 'note', { text: `${text}\nThe network or the API was unreachable, so it resumes by itself once it's back; messages queued behind this turn go into that resume.` });
      this.store.updateTicket(ticketId, { note: NET_NOTE });
      return;
    }
    const netTries = out.kind === 'net' ? out.spent!.tries : 0;
    const event = this.emit(ticketId, 'error', { text: netTries ? `${text}\nIt has already resumed ${netTries} times in a row after a network outage, so it stopped retrying: send a message to carry on.` : text });
    this.setFailNote(ticketId, { note: netTries ? `Network: stopped retrying after ${netTries} resumes` : short(first) });
    this.onTurnError(ticketId, text, event.id);
  }

  /** When a turn's usage limit resets: the windows it hit, else the time Claude's words give, else a while from now. */
  private limitResetAt(reason: string, usage: Usage | null | undefined, codexReset?: number | null): number {
    // A Codex turn's limit (codexReset is set, maybe null) is Codex's own windows, never Claude's.
    const hit = codexReset !== undefined ? (codexReset ? [codexReset] : []) : [usage?.session, usage?.weekly].filter((w) => w?.status === 'rejected' && w.resetsAt && w.resetsAt > Date.now()).map((w) => w!.resetsAt!);
    return hit.length ? Math.max(...hit) : (parseResetTime(reason) ?? Date.now() + this.limitFallbackMs);
  }

  /**
   * The account pick for a Claude turn on one of its person's accounts that hit that account's usage limit (`limit`),
   * or else lost its sign-in (#779): the account is marked, and another that is ready is named. Else, on a limit with
   * several accounts, when the first of them resets; null otherwise.
   */
  private pickAccount(turn: TurnState, reason: string | null, usage: Usage | null, limit: boolean): { n: number; label: string } | AllLimited | null {
    const person = turn.person!;
    const several = (this.claudeAccounts?.(person)?.accounts.length ?? 0) > 1;
    if (limit) {
      const r = this.onLimit?.(person, turn.account!, this.limitResetAt(reason!, usage));
      if (!r) return null;
      if (r.next) return r.next;
      if (!several) return null;
      const kind = /weekly/i.test(reason!) ? 'weekly' : /(\d+)-hour/i.exec(reason!)?.[0].toLowerCase();
      const accounts = (r.limits ?? []).map((l) => ({ ...l, ...(l.n === turn.account ? { here: true, ...(kind ? { kind } : {}) } : {}) }));
      return { resetAt: r.resetAt, accounts };
    }
    const acc = this.claudeAccounts?.(person);
    const n = acc?.inUse;
    return (n && n !== turn.account ? acc!.accounts.find((a) => a.n === n) : null) ?? null;
  }

  /** The secrets of `ticketId`'s running turn: as launched, or (a turn followed after a restart) read now. */
  private secretsOfTurn(ticketId: number): Map<string, string> {
    let secrets = this.turnSecrets.get(ticketId);
    if (!secrets) {
      const t = this.store.getTicket(ticketId);
      const person = this.store.getSetting<TurnState>(turnKey(ticketId))?.secretPerson ?? null;
      secrets = t && this.secretsFor ? this.secretsFor(t.project_id, person) : new Map<string, string>();
      this.turnSecrets.set(ticketId, secrets);
    }
    return secrets;
  }

  private handleLine(ticketId: number, line: string, onResult: (isError: boolean, result: string | null) => void) {
    if (!line.trim()) return;
    let ev: ClaudeEvent;
    const secrets = this.secretsOfTurn(ticketId);
    try {
      ev = JSON.parse(line);
    } catch {
      this.emit(ticketId, 'note', { text: hideSecrets(line, secrets) });
      return;
    }
    if (!ev || typeof ev !== 'object') return;
    // A turn that prints a saved secret (#838) never puts it in the chat, its reply or its activity line.
    if (secrets.size) ev = hideSecretsIn(ev, secrets);
    if (ev.type === 'rate_limit_event') this.updateUsage(ev.rate_limit_info, ticketId);
    const live = this.turns.get(ticketId);
    if (live) {
      live.activity = noteEvent(live.activity, ev, Date.now());
      const pass = this.store.getSetting<TurnState>(turnKey(ticketId))?.pass;
      if (pass && losesPass(pass, live.calls, ev)) this.saveTurn(ticketId, { pass: undefined });
      noteCalls(live.calls, ev);
      if (live.unread && readsSteers(live.calls, ev) && this.now() - live.unread > STEER_LAG_MS) {
        live.unread = undefined;
        this.saveTurn(ticketId, { unread: undefined });
      }
      if (ev.type === 'system' && ev.subtype === 'background_tasks_changed') this.saveTurn(ticketId, { background: live.calls.background });
      this.lendWorker(ticketId);
      if (this.quietSince(ticketId, live) === null && this.store.getSetting<TurnState>(turnKey(ticketId))?.quiet) this.checkQuiet(ticketId, live);
    }
    // A keepalive (#862) shows nothing: only its session id and its cost are kept.
    if (this.keepalives.has(ticketId)) {
      if (validSessionId(ev.session_id) && ev.session_id !== this.store.getTicket(ticketId)?.session_id) this.store.updateTicket(ticketId, { session_id: ev.session_id });
      if (ev.type === 'result') onResult(!!ev.is_error, typeof ev.result === 'string' ? ev.result : null);
      if (ev.type === 'result' && typeof ev.total_cost_usd === 'number') void this.keepaliveRun.keepaliveResult(ticketId, ev).catch((e) => console.error(`[keepalive] minion ${ticketId}: ${(e as Error).message}`));
      return;
    }
    if (ev.type === 'codex_waiting') return this.emit(ticketId, 'note', { text: CODEX_WAITING });
    if (ev.type === 'codex_gate') return console.log(`[codex] minion ${ticketId}: login check waited ${Number(ev.waited_ms) || 0} ms${ev.refreshed ? ', refreshed the login' : ''}${ev.serial ? ', runs serial' : ''}`);
    if (ev.type === 'codex_rate_limits') return this.updateCodexUsage(ev.rate_limits, this.store.getSetting<TurnState>(turnKey(ticketId))?.person ?? null);
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.codex_thread === 'string') {
      const t = this.store.getSetting<CodexThread>(codexThreadKey(ticketId));
      if (t && t.thread !== ev.codex_thread) this.store.setSetting(codexThreadKey(ticketId), { ...t, thread: ev.codex_thread });
      if (ev.codex_resume_failed) this.emit(ticketId, 'note', { text: `Codex couldn't pick up its thread ${ev.codex_resume_failed}, so this turn starts a new one from the hand-over log.` });
    }
    if (ev.type === 'assistant' && !ev.parent_tool_use_id && Array.isArray(ev.message?.content)) this.countUse(ev.message.content);
    // Each main-thread API call re-reads the whole context: its input is the context's size.
    const u = ev.type === 'assistant' && !ev.parent_tool_use_id ? ev.message?.usage : null;
    if (u) {
      const size = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      const shown = this.contextShown.get(ticketId);
      this.contextSizes.set(ticketId, size);
      // The meter follows the turn (#1193), but a view() per API call is too many: a change of 1k or more, at most every 2 s.
      if (!shown || (Math.abs(size - shown.size) >= 1000 && Date.now() - shown.at >= 2000)) {
        this.contextShown.set(ticketId, { size, at: Date.now() });
        this.broadcastTicket(ticketId);
      }
    }
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string') this.mainModels.set(ticketId, ev.model);
    if (ev.type === 'result' && ev.modelUsage && typeof ev.modelUsage === 'object') {
      // Grunts' models are in modelUsage too: the window is the main model's.
      const main = this.mainModels.get(ticketId);
      const mu: ModelUsage | null = main ? (ev.modelUsage[main] ?? ev.modelUsage[main.replace(/\[1m\]$/i, '')]) : null;
      if (mu && Number(mu.contextWindow) > 0) this.store.setSetting(windowKey(ticketId), Number(mu.contextWindow));
    }
    if (ev.type === 'result') this.contextShown.delete(ticketId);
    if (ev.type === 'result' && this.contextSizes.has(ticketId)) {
      this.store.setSetting(contextKey(ticketId), this.contextSizes.get(ticketId));
      this.contextSizes.delete(ticketId);
    }
    if (ev.type === 'assistant') {
      // An alert is extra: a failure in it must not cost the line its place in the chat.
      try {
        this.meterSpend(ticketId, ev);
      } catch (err) {
        console.error(`[spend] minion ${ticketId}: metering failed:`, thrown(err).message);
      }
    }
    if (DROPPED_TYPES.has(ev.type)) return;
    // Joined into paths and passed to --resume later, and a container can write its stream: only what looks like an id.
    if (validSessionId(ev.session_id) && ev.session_id !== this.store.getTicket(ticketId)?.session_id) {
      this.store.updateTicket(ticketId, { session_id: ev.session_id });
    }
    if (this.compactWatch.observe(ticketId, ev)) this.broadcastTicket(ticketId);
    // The held prompt (#1276): a compaction summarises its note away, and a turn that ran has read the note it carried.
    if (ev.type === 'system' && ev.subtype === 'compact_boundary') this.promptHolds.compacted(ticketId);
    // Only a turn that ran has read its note: after an error the next turn carries it again.
    if (ev.type === 'result' && !ev.is_error) this.promptHolds.ran(ticketId, this.store.getTicket(ticketId)?.session_id ?? null);
    if (ev.type === 'result') onResult(!!ev.is_error, typeof ev.result === 'string' ? ev.result : null);
    if (ev.type === 'assistant' && !ev.parent_tool_use_id && Array.isArray(ev.message?.content)) ev = this.stripStatus(ticketId, ev);
    if (ev.type === 'result') {
      const status = this.statuses.get(ticketId);
      this.statuses.delete(ticketId);
      if (status && !ev.is_error) this.onStatusTrailer(ticketId, status);
      if (status) this.saveTurn(ticketId, { status: undefined });
    }
    // Likewise the model: remembered from turns that ran without one chosen.
    const t = ev.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string' ? this.store.getTicket(ticketId) : null;
    if (t && !t.model && ev.model !== t.last_model) {
      this.store.updateTicketQuietly(ticketId, { last_model: ev.model });
      this.broadcastTicket(ticketId);
    }
    if (ev.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.mcp_servers)) this.checkMcp(ticketId, ev.mcp_servers);
    if (ev.type === 'system' && ev.subtype === 'init') this.checkLoadErrors(ticketId, ev);
    if (ev.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.slash_commands)) this.saveCommands(ticketId, ev);
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.claude_code_version === 'string') {
      const hashes = this.store.getSetting<TurnState>(turnKey(ticketId))?.hashes;
      if (hashes) this.saveTurn(ticketId, { hashes: { ...hashes, claude: ev.claude_code_version } });
    }
    // A process ended for its card says the call was rejected and the turn failed; the chat shows it still waiting.
    if (live?.card && ev.type === 'user') return;
    if (live?.card && ev.type === 'result') ev = { ...ev, is_error: false, result: '' };
    const slim = slimEvent(ev);
    if (!slim) return;
    const progress = this.progressFor(ticketId);
    const row = this.emit(ticketId, 'claude', slim);
    try {
      this.onStreamEvent(ticketId, slim);
    } catch (err) {
      console.error(`[stall] minion ${ticketId}: counting failed:`, thrown(err).message);
    }
    // The stored event's own time, so a step's start matches what a replay of the events (history, the backfill) finds.
    applyEvent(progress, 'claude', slim, row.created_at);
    this.recordSteps(ticketId, progress);
    const activity = progress.tasks.length ? progressLine(progress, ev.type !== 'result') : describeActivity(ev);
    if (activity && activity !== this.store.getTicket(ticketId)?.last_activity) {
      this.store.updateTicket(ticketId, { last_activity: activity });
      // Keep the board's progress line live, not just on status changes.
      this.broadcastTicket(ticketId);
    }
    if (ev.type === 'result') this.savePlan(ticketId, progress, row.id);
    if (ev.type === 'result' && !ev.is_error) this.carryReply(ticketId);
    if (ev.type === 'user' && ((ev.message?.content ?? []) as ContentBlock[]).some?.((b) => typeof b?.text === 'string' && b.text.includes(SENT_BACK)) && !this.sentBack.has(ticketId)) {
      this.sentBack.add(ticketId);
      this.saveTurn(ticketId, { sentBack: true });
    }
    // shortcut: a turn stopped, or cut off and resumed, before the result keeps both versions (a re-attached one doesn't, #1452); rare, so left.
    if (ev.type === 'result' && this.sentBack.delete(ticketId)) this.replaceSentBack(ticketId, row.id);
    if (ev.type === 'result' && typeof ev.total_cost_usd === 'number') {
      const state = this.store.getSetting<TurnState>(turnKey(ticketId));
      this.keepTurn(ticketId, state, { event_id: row.id, ...turnOf(ev), ended_at: row.created_at });
      this.spends.get(ticketId)?.meter.settle();
      if (state?.spend?.open) this.saveTurn(ticketId, { spend: { ...state.spend, open: {} } });
    }
    if (ev.type === 'user' && Array.isArray(ev.message?.content) && (ev.message!.content as ContentBlock[]).some((b) => b?.type === 'tool_result')) {
      this.onFilesMayChange(ticketId, false);
    }
    // A reply that links a file shows it in the artifacts list as it lands (the scan's own test: replyTexts).
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content) && (ev.message!.content as ContentBlock[]).some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.includes(']('))) {
      this.onFilesMayChange(ticketId, true);
    }
    this.notePushes(ticketId, ev);
  }

  /** Record what a turn cost, from its result or, killed with none, its estimate. */
  private keepTurn(ticketId: number, state: TurnState | null | undefined, r: TurnResult) {
    void this.store
      .recordTurn(ticketId, { ...r, payer: this.payerOf(state?.person), hashes: state?.hashes ?? null, account: state?.account ?? null })
      .then((turn) => {
        this.broadcast({ type: 'turn', turn, projectId: this.store.getTicket(ticketId)?.project_id });
        this.recordGrunts(ticketId, turn.id, state, r.session_id);
        // The turn's real cost, for a Codex turn (unmetered) or one the estimate undercounted; its reply is out, so no steer.
        const ticket = this.store.getTicket(ticketId);
        if (ticket?.kind === 'ticket') this.checkBudget(ticketId, budgetFor(this.store, ticket), this.store.ticketCost(ticketId), false);
      })
      .catch((e) => console.error(`[turn] minion ${ticketId}: its turn's cost was not recorded: ${(e as Error).message}`));
  }

  /** A turn that died with no result to say what it cost (#1938). Called after its record is gone: a crash between loses the estimate, never counts it twice. */
  private keepKilled(ticketId: number, turn: TurnState | null | undefined, exit: Parameters<typeof killedSpend>[1]) {
    const estimate = killedSpend(turn, exit);
    if (estimate) this.keepTurn(ticketId, turn, { session_id: this.store.getTicket(ticketId)?.session_id, session_cost_usd: 0, ended_at: Date.now(), estimate });
  }

  /** Keep the turn's Grunts (#948), read from the turn's config dir (a container's home volume as the host sees it); behind the turn, and a failure only logs. */
  private recordGrunts(ticketId: number, turnId: number, state: TurnState | null | undefined, sessionId: unknown) {
    const ticket = this.store.getTicket(ticketId);
    if (!state?.configDir || !ticket?.cwd || !validSessionId(sessionId)) return;
    readGrunts(state.configDir, ticket.cwd, sessionId, state.startedAt)
      .then((rows) => rows.length && this.store.recordGrunts(turnId, rows))
      .catch((e) => console.error(`[grunts] minion ${ticketId}:`, e));
  }

  /**
   * Count an assistant message (main thread or Grunt) toward the turn's estimated cost, and post the alert card (and push)
   * when it passes a stage. Saved in the TurnState, so a restart carries on where it was; Codex turns aren't metered.
   */
  private meterSpend(ticketId: number, ev: ClaudeEvent) {
    const turn = this.store.getSetting<TurnState>(turnKey(ticketId));
    if (!turn?.startedAt || turn.codex) return;
    let spend = this.spends.get(ticketId);
    if (spend?.startedAt !== turn.startedAt) {
      const ticket = this.store.getTicket(ticketId);
      // Earlier turns' cost and the budget once a turn: this runs on every assistant message.
      const budget = ticket?.kind === 'ticket' ? budgetFor(this.store, ticket) : null;
      this.spends.set(ticketId, (spend = { startedAt: turn.startedAt, meter: new SpendMeter(turn.spend), prior: budget ? this.store.ticketCost(ticketId) : 0, budget }));
    }
    const { meter } = spend;
    if (!meter.add(ev)) return;
    const stage = meter.crossed(stagesFrom(this.store.getSetting(STAGES_SETTING)));
    this.saveTurn(ticketId, { spend: meter.state });
    this.checkBudget(ticketId, spend.budget, spend.prior + meter.usd, true);
    if (stage === null) return;
    const text = spendText(meter.usd, Date.now() - turn.startedAt);
    console.log(`[spend] minion ${ticketId}: passed $${stage}, about $${meter.usd.toFixed(2)}`);
    const row = this.emit(ticketId, 'spend', { text, usd: Math.round(meter.usd), stage, turn: turn.startedAt });
    meter.alert = { stage, event: row.id, at: row.created_at };
    this.saveTurn(ticketId, { spend: meter.state });
    this.broadcastTicket(ticketId); // the list row's badge and Needs you
    this.onSpendAlert(ticketId, text, row.id, turn.person ?? null);
  }

  /**
   * Tell the minion and its Taskmaster when its spend passes a budget mark (#1114), each mark once per minion. The ask goes
   * into the running turn (`steer`) when it can take one; otherwise the next turn's budget line carries it. Never stops anything.
   */
  private checkBudget(ticketId: number, budget: Budget | null, spent: number, steer: boolean) {
    if (!budget) return;
    const state = this.store.getSetting<BudgetState>(budgetKey(ticketId)) ?? {};
    const marks = passed(budget, spent, state);
    if (!marks.length) return;
    const now = this.now();
    const level = wakeLevel(budget, spent);
    this.store.setSetting(budgetKey(ticketId), {
      ...state,
      ...(marks.includes('ask') ? { asked: now } : {}),
      ...(marks.includes('wake') ? { woke: state.woke ?? now, wakes: level } : {}),
      ...(marks.includes('card') ? { carded: now } : {}),
    });
    console.log(`[budget] minion ${ticketId}: passed ${marks.join(' and ')} at about $${spent.toFixed(2)} (usual $${budget.usd.toFixed(2)})`);
    if (marks.includes('ask')) {
      const row = this.emit(ticketId, 'note', { text: chatNote(budget, spent) });
      if (steer) this.steerSystem(ticketId, askText(budget, spent), row.id);
    }
    // tellTaskmaster posts its own "Sent the Taskmaster" line in the chat.
    if (marks.includes('wake')) this.onBudgetWake(ticketId, wakeText(budget, spent, level, !!state.woke));
    if (marks.includes('card')) this.onBudgetCard(ticketId, budgetCard(budget, spent, this.costReason(ticketId)));
  }

  /** The minion's own "Costing more:" line since the ask (#1672), from its main thread's replies; null when it never said. */
  private costReason(ticketId: number): string | null {
    const ask = this.store.eventsOfKinds(ticketId, ['note']).findLast((e) => JSON.parse(e.data).text?.startsWith('Budget:'));
    const texts = this.store
      .eventsOfKinds(ticketId, ['claude'], ask?.id ?? 0)
      .filter((e) => e.data.includes(REASON))
      .flatMap((e) => {
        const d: ClaudeEvent = JSON.parse(e.data);
        return d.type === 'assistant' && !d.parent_tool_use_id && Array.isArray(d.message?.content) ? d.message.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text!) : [];
      });
    return costReason(texts);
  }

  /**
   * Pass a line from Citadel into the running turn, as a steer is, when it can take one. Not kept in `steered`: one the
   * turn never reads is dropped rather than queued to start a turn of its own.
   */
  private steerSystem(ticketId: number, text: string, id: number): boolean {
    const live = this.turns.get(ticketId);
    const turn = live && this.store.getSetting<TurnState>(turnKey(ticketId));
    if (!live || !turn || turn.result || turn.fresh || turn.keepalive || turn.stopped || turn.light) return false;
    const file = join(live.dir, 'steer.jsonl');
    if (!existsSync(file)) return false;
    appendFileSync(file, promptMessage([{ author: 'System', text, images: [], id }]));
    return true;
  }

  /** What the minion page shows of its budget (#1114), or null with too little history. */
  private budgetView(ticket: Ticket, props?: Record<string, unknown>) {
    const b = budgetFor(this.store, ticket, Date.now(), props);
    return b && { usd: b.usd, basis: b.basis, n: b.n, ask: markOf(b, ASK), wake: markOf(b, WAKE), card: markOf(b, CARD), ...(b.estimate ? { estimate: b.estimate } : {}) };
  }

  /** The running turn's unanswered spend alert (openSpend), or null; reads the saved turn only while one runs. */
  spendAlert(ticket: Ticket) {
    const spend = this.turns.has(ticket.id) ? openSpend(this.store.getSetting<TurnState>(turnKey(ticket.id))?.spend) : null;
    return spend && { ...spend, href: cardHref(ticket, spend.event) };
  }

  /** Keep going (#723): no more spend alerts for the running turn. False when no turn is running. */
  muteSpend(ticketId: number, by: string, startedAt: number): boolean {
    const turn = this.store.getSetting<TurnState>(turnKey(ticketId));
    // An earlier turn's card can't mute this one: it's refused unless it names the running turn's start.
    if (!this.turns.has(ticketId) || !turn?.startedAt || turn.startedAt !== startedAt) return false;
    if (turn.spend?.muted) return true;
    const spend = this.spends.get(ticketId);
    if (spend?.startedAt === turn.startedAt) spend.meter.muted = by;
    this.saveTurn(ticketId, { spend: { ...(turn.spend ?? { usd: 0, fired: 0 }), muted: by } });
    this.emit(ticketId, 'spend_muted', { turn: turn.startedAt, by });
    this.broadcastTicket(ticketId);
    return true;
  }

  /** A main-thread message without its status trailer, remembering the last good one for the turn's end; a bad one is noted once. */
  private stripStatus(ticketId: number, ev: ClaudeEvent): ClaudeEvent {
    let changed = false;
    let state = '';
    const content = (ev.message!.content as ContentBlock[]).flatMap((b): ContentBlock[] => {
      if (b?.type !== 'text' || typeof b.text !== 'string') return [b];
      const { text, status, bad } = takeStatus(b.text);
      if (text === b.text) return [b];
      changed = true;
      if (status) {
        this.statuses.set(ticketId, status);
        this.saveTurn(ticketId, { status });
        state = typeof status.state === 'string' ? status.state : '';
      }
      if (bad) {
        // A later reply's bad line (a sent-back reply's rewrite) doesn't let an earlier reply's line stand.
        if (this.statuses.delete(ticketId)) this.saveTurn(ticketId, { status: undefined });
        console.log(`[status] minion ${ticketId}: ignored a status trailer, ${bad}`);
        this.emit(ticketId, 'note', { text: `The reply's status line was ignored (${bad}), so the state stays as it was.` });
      }
      return text ? [{ ...b, text }] : [];
    });
    if (!changed) return ev;
    // The end it named stays on the stored event: the plan's last step is ticked by it, in every replay (progress.js, #1923).
    return { ...ev, message: { ...ev.message, content }, ...(state ? { turn_state: state } : {}) };
  }

  /**
   * A reply the link check sent back gives way to its rewrite once the turn ends (#281, Cara's pick
   * "Replace in place"): it's marked `replaced` in the stored history, which the chat skips, and a
   * `replaced` event takes it out of open chats. The rewrite is the last words after the send-back,
   * so narration on the way there doesn't count; with no words after it, or just KEEP, the first version stays.
   */
  private sentBack = new Set<number>(); // tickets whose running turn had a reply sent back

  private replaceSentBack(ticketId: number, resultId: number) {
    // A Grunt's words aren't the reply.
    const words = (data: ClaudeEvent) => data.type === 'assistant' && !data.parent_tool_use_id && ((data.message?.content ?? []) as ContentBlock[]).some((b) => b?.type === 'text' && b.text?.trim());
    const sentBack = (data: ClaudeEvent) => data.type === 'user' && Array.isArray(data.message?.content) && data.message.content.some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.includes(SENT_BACK));
    const swaps: { original: EventRow; rewrite?: EventRow }[] = [];
    let last: EventRow | null = null;
    for (const e of this.store.eventsPage(ticketId, resultId, 1).events) {
      if (e.kind !== 'claude') continue;
      const data: ClaudeEvent = JSON.parse(e.data);
      if (sentBack(data)) {
        if (last) swaps.push({ original: last });
      } else if (words(data)) {
        last = e;
        const open = swaps.at(-1);
        if (open && open.original !== e) open.rewrite = e;
      }
    }
    const text = (data: ClaudeEvent) =>
      (data.message!.content as ContentBlock[])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
    for (const { original, rewrite } of swaps) {
      if (!rewrite) continue;
      // A bare KEEP stands by the first version (#404): the KEEP is what gives way.
      const [gone, by] =
        text(JSON.parse(rewrite.data))
          .replace(/[*_.!]/g, '')
          .toUpperCase() === KEEP
          ? [rewrite, original]
          : [original, rewrite];
      const data: ClaudeEvent & { replaced?: number } = JSON.parse(gone.data);
      if (data.replaced) continue;
      this.store.setEventData(gone.id, { ...data, replaced: by.id });
      this.emit(ticketId, 'replaced', { event: gone.id, by: by.id });
    }
  }

  /** Counts each running turn's compactions and calls a burst out (#1920). */
  private compactWatch = new CompactWatch({
    ticket: (id) => this.store.getTicket(id),
    tell: (t, text, wake) => {
      const tm = this.store.ownerCoordinator(t);
      if (tm) this.relay(t.id, tm.id, APP_NAME, text, false, wake, wake ? 'decision' : 'fyi');
    },
    note: (id, text) => this.emit(id, 'note', { text }),
  });
  /** The running turn's latest context size, saved when it ends (contextKey). */
  private contextSizes = new Map<number, number>();
  /** What the last broadcast showed of a running turn's context size, and when (#1193). */
  private contextShown = new Map<number, { size: number; at: number }>();
  /** The model each running turn's init event named. */
  private mainModels = new Map<number, string>();

  /** The usage ledger (#1306): each tool, skill and Grunt type a main-thread message calls. Never throws. */
  private countUse(blocks: ContentBlock[]) {
    try {
      for (const b of blocks) {
        if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
        const m = /^mcp__(?:thread|coordinator)__(.+)$/.exec(b.name);
        if (m) this.store.usage.used('tool', m[1]);
        else if (b.name === 'Skill' && typeof b.input?.skill === 'string') this.store.usage.used('skill', b.input.skill);
        else if ((b.name === 'Agent' || b.name === 'Task') && typeof b.input?.subagent_type === 'string') this.store.usage.used('grunt', b.input.subagent_type);
      }
    } catch {
      /* counting never fails a turn */
    }
  }

  /** Bash calls that push or open a pull request, by tool_use id, until their result comes back. */
  private pushCalls = new Map<string, 'push' | 'pr'>();

  /** A note in the chat for each push or pull request, saying whose GitHub it went out as (Cara's pick: "only a chat note"). */
  private notePushes(ticketId: number, ev: ClaudeEvent) {
    const blocks: ContentBlock[] = Array.isArray(ev.message?.content) ? ev.message.content : [];
    for (const b of blocks) {
      if (ev.type === 'assistant' && b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string' && typeof b.id === 'string') {
        const kind = pushKind(b.input.command);
        if (kind) this.pushCalls.set(b.id, kind);
      }
      if (ev.type !== 'user' || b?.type !== 'tool_result' || !this.pushCalls.has(b.tool_use_id!)) continue;
      const kind = this.pushCalls.get(b.tool_use_id!)!;
      this.pushCalls.delete(b.tool_use_id!);
      const turn = this.store.getSetting<TurnState>(turnKey(ticketId));
      // Absent: GitHub linking isn't set up, and the box's own login pushes as before.
      if (turn?.github === undefined) continue;
      const who = turn.person ? (this.store.getUser(turn.person)?.name ?? 'Its person') : 'Nobody';
      if (turn.github && !b.is_error) this.emit(ticketId, 'note', { text: kind === 'pr' ? `Opened a pull request as @${turn.github} (${who}'s GitHub)` : `Pushed as @${turn.github} (${who}'s GitHub)` });
      else if (!turn.github && b.is_error) this.emit(ticketId, 'note', { text: `Couldn't ${kind === 'pr' ? 'open a pull request' : 'push'}: this turn runs for ${who}, who hasn't linked GitHub. Link it in Settings → Your account.` });
    }
  }

  /**
   * Say so in the chat (as an error, which pushes) when the turn's own MCP server didn't connect:
   * without it a minion can't set its status or ask questions, and a Taskmaster can't manage minions.
   */
  private checkMcp(ticketId: number, servers: NonNullable<ClaudeEvent['mcp_servers']>) {
    const role = this.store.getTicket(ticketId)?.kind === 'coordinator' ? 'coordinator' : 'thread';
    const status = servers.find((s) => s?.name === role)?.status;
    // Pending: still starting after Claude Code's startup wait; it may yet connect.
    if (status === 'connected' || status === 'pending') return;
    const text = `The ${role} MCP server is ${typeof status === 'string' ? status : 'missing'} in this turn, so its mcp__${role} tools are unavailable. Check the server log.`;
    console.error(`Ticket ${ticketId}: ${text}`);
    const event = this.emit(ticketId, 'error', { text });
    this.onTurnError(ticketId, text, event.id);
  }

  /**
   * A plugin or MCP server that fails to load is skipped and the turn still exits 0 (AG-03): say so in the chat as an error
   * and on the minion's note. It warns and doesn't end the turn: a missing thread/coordinator server already has checkMcp's error.
   */
  private checkLoadErrors(ticketId: number, ev: ClaudeEvent) {
    const line = (e: LoadError, kind: string) => {
      const name = typeof e === 'object' ? (e?.plugin ?? e?.name ?? e?.server) : null;
      const why = typeof e === 'string' ? e : (e?.error ?? e?.message ?? JSON.stringify(e));
      return `${name ? `${name} ` : ''}${kind}: ${why}`;
    };
    const role = this.store.getTicket(ticketId)?.kind === 'coordinator' ? 'coordinator' : 'thread';
    // The turn's own server already got checkMcp's error.
    const lines = [...(Array.isArray(ev.plugin_errors) ? ev.plugin_errors.map((e) => line(e, 'plugin')) : []), ...(Array.isArray(ev.mcp_server_errors) ? ev.mcp_server_errors.filter((e) => (typeof e === 'string' ? undefined : e?.name) !== role).map((e) => line(e, 'MCP server')) : [])];
    if (!lines.length) return;
    const text = `This turn started with load errors, so some of its skills, hooks or tools are missing: ${lines.join('; ')}`.slice(0, 1500);
    console.error(`Ticket ${ticketId}: ${text}`);
    const event = this.emit(ticketId, 'error', { text });
    this.setFailNote(ticketId, { note: `Load errors: ${lines.length} in this turn's init`.slice(0, 60) });
    this.onTurnError(ticketId, text, event.id);
  }

  /**
   * A minion's progress as a contraption may see it (#421): the readout's line ("Showing the rune cost… · 1 of 6 done") and step,
   * built from its task list and tool calls. Never last_activity, which can be the first line of its reply.
   */
  progressOf(ticket: Ticket) {
    const p = this.progressFor(ticket.id);
    const { total, done, current, step } = stepInfo(p, ticket.status === 'running');
    return {
      line: progressLine(p, ticket.status === 'running') || null,
      step: total ? { n: step, of: total, done, label: current ? current.activeForm || current.subject : null } : null,
    };
  }

  /**
   * Task-list state for a ticket, built the first time it is needed: from the state saved when its last
   * turn ended plus the events since, or from all its events when nothing usable is saved (#530: a
   * Taskmaster's 6,000 events took 0.6 s to read cold, on the first scheme open after every restart).
   */
  private progressFor(ticketId: number) {
    let p = this.progress.get(ticketId);
    if (!p) {
      const saved = unpackPlan(this.store.getSetting(planKey(ticketId)));
      const usable = saved != null;
      p = saved?.p ?? createProgress();
      const rows = this.store.planEvents(ticketId, undefined, saved?.upTo ?? 0);
      for (const row of rows) applyEvent(p, row.kind, JSON.parse(row.data), row.created_at);
      // Steps finishing from here on are recorded (#571); those before were, live or by backfillStepTimes.
      p.finished = [];
      this.progress.set(ticketId, p);
      // The full replay is paid once: an idle minion would otherwise pay it after every restart.
      if (!usable) this.savePlan(ticketId, p, rows.at(-1)?.id ?? 0);
    }
    return p;
  }

  /** Save a ticket's task-list state, which holds every event up to `upTo`. */
  private savePlan(ticketId: number, p: ReturnType<typeof createProgress>, upTo: number) {
    this.store.setSetting(planKey(ticketId), packPlan(p, upTo));
  }

  /** Write the steps a ticket's plan finished since the last call to step_times (#571). */
  private recordSteps(ticketId: number, p: ReturnType<typeof createProgress>) {
    if (!p.finished?.length) return;
    const t = this.store.getTicket(ticketId);
    try {
      // The effort it ran at: a low-effort turn's steps (#951) are low, whatever the minion's own.
      const light = this.store.getSetting<TurnState>(turnKey(ticketId))?.light;
      this.store.addStepTimes(ticketId, p.finished, light ? 'low' : (t?.last_effort ?? t?.effort ?? null));
      p.finished.length = 0;
    } catch (err) {
      // Kept for the next event's try: the backfill has run, so nothing else would record them.
      console.error(`Ticket ${ticketId}: could not record its finished steps, will retry:`, err);
    }
  }

  /**
   * The readout's ratio of what steps took to their guesses (#571), per scheme, read at most once a minute:
   * every minion's view carries it.
   */
  private stepRatio(projectId: number): number {
    const hit = this.stepRatios.get(projectId);
    if (hit && Date.now() - hit.at < 60_000) return hit.ratio;
    const ratio = this.store.stepRatio(projectId);
    this.stepRatios.set(projectId, { at: Date.now(), ratio });
    return ratio;
  }

  /**
   * Fill step_times once from every minion's stored events (#571), so the ratio has data from its first day.
   * One minion per tick, off the boot's hot path; a restart part way starts over, and rows already there stay.
   */
  async backfillStepTimes() {
    if (this.store.getSetting('step_times_backfilled')) return;
    for (const project of this.store.listProjects()) {
      for (const t of this.store.listTickets(project.id)) {
        const p = { ...createProgress(), finished: [] as FinishedStep[] };
        // shortcut: effort is the minion's now, not when each step ran; nothing reads it yet, and live rows are right.
        for (const row of this.store.planEvents(t.id)) applyEvent(p, row.kind, JSON.parse(row.data), row.created_at);
        this.store.addStepTimes(t.id, p.finished, t.last_effort ?? t.effort ?? null);
        await new Promise((r) => setImmediate(r));
      }
    }
    this.store.setSetting('step_times_backfilled', true);
  }

  get usage(): Usage | null {
    return this.store.getSetting<Usage>('usage');
  }

  /** Whose plan a person's turns run on: null for the server login (its owner's turns run on the host), else their own. */
  payerOf(uid: number | null | undefined): number | null {
    return uid && !this.store.getUser(uid)?.server_login ? uid : null;
  }

  /** A plan as the minion's chip names it: payerOf's id, and whose it is (the server login's owner for it). */
  private payerView(uid: number | null, user = (id: number) => this.store.getUser(id)): { id: number | null; name: string } | null {
    if (!uid) return null;
    const id = user(uid)?.server_login ? null : uid;
    const name = user(id ?? this.store.serverLoginOwner() ?? uid)?.name;
    return name ? { id, name } : null;
  }

  /** A turn is running with this Claude config folder now (#779: unlinking its account would end it on a 401). */
  turnIn(configDir: string): boolean {
    return [...this.turns.values()].some((t) => t.configDir === configDir);
  }

  /**
   * A person's own plan usage, for their top-bar meter: the server login's, or their container turns', of the
   * account in use. With several accounts (#779) it says which, and carries each account's.
   */
  usageOf(uid: number | null | undefined): (Usage & { account?: number; why?: string; pinned?: number; accounts?: { n: number; label: string; same?: string; usage: Usage | null }[] }) | null {
    const payer = this.payerOf(uid);
    const acc = uid ? this.claudeAccounts?.(uid) : null;
    const usage = this.store.getSetting<Usage>(accountUsageKey(payer, acc?.inUse ?? 1));
    if (!acc || acc.accounts.length < 2) return usage;
    // `account` is where a new or cold turn goes now, and `why` (#793): its week resets soonest, it's pinned, or every account is near full.
    return { ...(usage ?? { weekly: null, session: null, updatedAt: 0 }), account: acc.inUse ?? 1, ...(acc.why ? { why: acc.why } : {}), ...(acc.pinned ? { pinned: acc.pinned } : {}), accounts: acc.accounts.map((a) => ({ ...a, usage: this.store.getSetting<Usage>(accountUsageKey(payer, a.n)) })) };
  }

  /**
   * Why a person's turns can't run on Codex (#337), or null when they can: only in their own container, signed
   * in to Codex. The server login's owner has one for Codex alone (#341). Codex is always the person's own, never a payer's.
   */
  codexWhy(person: number | null): string | null {
    if (!person) return 'Codex runs only for a person';
    return this.codexReady ? this.codexReady(person) : "Codex isn't set up on this server";
  }

  /** What the usage bar shows of a person's Codex: whether they can use it, the switch and its windows. */
  codexView(uid: number | null | undefined): { ready: boolean; why: string | null; on: boolean; usage: CodexUsage | null } | null {
    if (!uid) return null;
    const why = this.codexWhy(uid);
    return { ready: !why, why, on: !!this.store.getSetting<boolean>(codexSwitchKey(uid)), usage: this.store.getSetting<CodexUsage>(codexUsageKey(uid)) };
  }

  /**
   * "Enable Codex override" (#337). Switching on resumes the person's minions waiting out a usage
   * limit right away (on Codex now); returns why it can't, or null.
   */
  setCodexSwitch(uid: number, on: boolean): string | null {
    if (on) {
      const why = this.codexWhy(uid);
      if (why) return why;
      this.store.setSetting(codexSwitchKey(uid), true);
    } else this.store.deleteSetting(codexSwitchKey(uid));
    this.broadcast({ type: 'codex', codex: this.codexView(uid), to: uid });
    if (!on) return null;
    const mine = (w: LimitResume) => {
      const t = this.store.getTicket(w.ticket);
      const p = t && this.store.getProject(t.project_id);
      return !!p && this.turnPerson(t!, p, [], true) === uid;
    };
    // Due now, on Codex, spaced limitGapMs apart like any limit resume.
    const list = this.resumes.limit.all();
    if (list.some(mine)) this.resumes.saveLimits(list.map((w) => (mine(w) ? { ...w, at: Date.now(), tries: 0, codex: true as const } : w)));
    return null;
  }

  /** Record a Codex turn's usage windows (account/rateLimits) as its person's, for their usage bar. */
  updateCodexUsage(l: unknown, person: number | null) {
    const w = (x: CodexWindow | null | undefined) => (x && typeof x.usedPercent === 'number' ? { usedPercent: x.usedPercent, windowDurationMins: typeof x.windowDurationMins === 'number' ? x.windowDurationMins : null, resetsAt: typeof x.resetsAt === 'number' ? x.resetsAt : null } : null);
    if (person === null || !l) return;
    this.store.setSetting(codexUsageKey(person), { primary: w((l as CodexLimits).primary), secondary: w((l as CodexLimits).secondary), updatedAt: Date.now() });
    this.broadcast({ type: 'codex', codex: this.codexView(person), to: person });
  }

  /** Add a finished Codex turn's log to its minion's Codex thread. */
  private keepCodexLog(ticketId: number, dir: string) {
    let log = '';
    try {
      log = readFileSync(join(dir, 'codex-log.jsonl'), 'utf8');
    } catch {
      return;
    }
    const t = this.store.getSetting<CodexThread>(codexThreadKey(ticketId));
    if (!t || !log) return;
    // Past what a hand-over can carry, the oldest turns go: fitLog would cut them to nothing anyway.
    let all = t.log + log;
    if (all.length > CODEX_LOG_MAX) all = all.slice(all.indexOf('\n', all.length - CODEX_LOG_MAX) + 1);
    this.store.setSetting(codexThreadKey(ticketId), { ...t, log: all });
  }

  /** Record a turn's plan usage: the server login's (the top bar's meter), or a container turn's payer's own (#213). */
  private updateUsage(info: unknown, ticketId?: number) {
    const turn = ticketId === undefined ? null : this.store.getSetting<TurnState>(turnKey(ticketId));
    this.recordUsage(info, turn?.container && turn.person ? turn.person : null, turn?.person ?? null, turn?.account);
  }

  /** Record a Claude turn's `rate_limit_info` on `account` of `payer` (null: the server login), a minion's or an app's (#793). */
  recordUsage(info: unknown, payer: number | null, person: number | null, account?: number) {
    const windows = (info as RateLimitInfo | null | undefined)?.unifiedWindows;
    if (!windows) return;
    const key = accountUsageKey(payer, account);
    const was = this.store.getSetting<Usage>(key);
    const now = Date.now();
    // An event may report one window: the other keeps its last reading until it resets, so the account pick still sees a nearly
    // spent week. Not its status: a stale 'rejected' would hold the next limit's turns until that window's reset.
    const kept = (w: Usage['weekly'] | undefined) => (w && w.resetsAt && w.resetsAt > now ? { ...w, status: null } : null);
    const usage: Usage = { weekly: usageWindow(windows.seven_day) ?? kept(was?.weekly), session: usageWindow(windows.five_hour) ?? kept(was?.session), updatedAt: now };
    if (!usage.weekly && !usage.session) return;
    this.store.setSetting(key, usage);
    // The plan's limit lifted (#477): every window that was hit now says otherwise, so what waits on it needn't wait for the reset time.
    const hit = (['session', 'weekly'] as const).filter((k) => was?.[k]?.status === 'rejected');
    if (hit.length && hit.every((k) => usage[k]?.status && usage[k]!.status !== 'rejected')) {
      if (person && account) this.onCleared?.(person, account);
      this.limitCleared(payer);
    }
    // Only the payer's own meter shows it (server.ts, broadcast): the account in use's, whichever account this turn ran on.
    this.broadcast({ type: 'usage', usage: person ? (this.usageOf(person) ?? usage) : usage, payer });
  }

  private setStatus(ticketId: number, status: Ticket['status']) {
    const progress = this.progressFor(ticketId);
    // Re-word the plan's line too, so a stopped or interrupted turn stops saying "Running tests… 3/7".
    const activity = progress.tasks.length ? progressLine(progress, status === 'running') : undefined;
    this.store.updateTicket(ticketId, activity ? { status, last_activity: activity } : { status });
    this.broadcastTicket(ticketId);
  }

  broadcastTicket(ticketId: number) {
    const ticket = this.store.getTicket(ticketId);
    if (ticket) this.broadcast({ type: 'ticket', ticket: this.view(ticket) });
  }

  emit(ticketId: number, kind: string, data: unknown, reserved?: number): EventRow {
    // A split scheme's Overlord asks for everyone (#921): its cards show in every member's chat (#920 reads the flag). A note is for
    // everyone only when its emitter says so (`everyone: true`, and only on the Overlord): most are one person's.
    const lord = (EVERYONES.has(kind) || (data as { everyone?: unknown } | null)?.everyone === true) && this.isOverlord(this.store.getTicket(ticketId));
    // The flag goes last, whatever order the caller wrote it in: the db's `data LIKE '{"text":…'` queries match a prefix.
    if (data && typeof data === 'object' && 'everyone' in data) {
      const { everyone: _, ...rest } = data as Record<string, unknown>;
      data = rest;
    }
    if (lord) data = { ...(data as object), everyone: true };
    const row = this.store.addEvent(ticketId, kind, data, reserved);
    this.broadcast({ type: 'event', event: row });
    if (CARD_KINDS.has(kind)) this.refreshRefs(ticketId, POSTED_KINDS.has(kind));
    return row;
  }

  /** A minion's cards waiting on people, oldest first, each with the link that opens it (#400); `placed` adds where each sits (CardLink.below). */
  cardLinks(ticket: Ticket, placed = false, open?: EventRow[], approvals?: { at: number; card: unknown }[]): CardLink[] {
    if (ticket.status === 'closed') return [];
    const minion = ticket.kind === 'coordinator' ? null : ticket.number;
    const link = (kind: CardLink['kind'], data: unknown, eventId: number): CardLink => ({
      minion,
      kind,
      what: cardWhat(kind, data),
      label: cardLabel(kind, data),
      href: cardHref(ticket, eventId),
      ...((data as { to?: string })?.to ? { to: (data as { to: string }).to } : {}),
      ...((data as { doc?: { path: string } })?.doc ? { doc: (data as { doc: { path: string } }).doc.path } : {}),
      // Only question and plan cards are held under the turn's words (public/thread.js heldCards).
      ...(placed ? { below: kind !== 'approval' && this.store.heldBelow(ticket.id, eventId) } : {}),
    });
    const asks = (approvals ?? this.approvals.pending().filter((a) => a.ticketId === ticket.id)).flatMap((a) => {
      const eventId = this.store.cardEventId(ticket.id, 'approval', (a.card as { id: string }).id);
      return eventId == null ? [] : [{ at: a.at, id: eventId, card: link('approval', a.card, eventId) }];
    });
    const stored = (open ?? this.store.openCardsOf(ticket.id)).map((e) => ({ at: e.created_at, id: e.id, card: link(e.kind as CardLink['kind'], JSON.parse(e.data), e.id) }));
    // Cards posted in the same millisecond keep the order they were posted in (their event ids).
    return [...asks, ...stored].sort((a, b) => a.at - b.at || a.id - b.id).map((c) => c.card);
  }

  /** The scheme's newest 500 cards that aren't in `open`, with what happened to each (#531). No time cutoff: a card asked weeks ago may be answered today. */
  private settledCards(projectId: number, open: Set<string>): SettledCard[] {
    return this.store.recentCards(projectId, 500).flatMap((r) => {
      const href = cardHref({ project_id: projectId, kind: r.tkind, number: r.number, id: r.ticket_id }, r.id);
      if (open.has(href)) return [];
      const kind = r.kind as CardLink['kind'];
      const data = JSON.parse(r.data);
      const minion = r.tkind === 'coordinator' ? null : r.number;
      const how = settledHow(kind, data, r.reply && JSON.parse(r.reply), r.result && JSON.parse(r.result), r.tstatus === 'closed' ? minion : null, (ms) => clockTime(ms));
      return [{ minion, kind, what: cardWhat(kind, data), label: cardLabel(kind, data), href, how, ...(data?.doc ? { doc: data.doc.path } : {}) }];
    });
  }

  /** Read each scheme's newest cards' rows into the store's memory in small steps, yielding between them, so the first
   * refsShared after a restart doesn't read 500 scattered rows in one go (Store.warmCardRows). Quits on its own errors. */
  async warmCards(chunk = 25, pauseMs = 5) {
    try {
      for (const p of this.store.listProjects()) {
        while (this.store.warmCardRows(p.id, 500, chunk) > 0) await sleep(pauseMs);
        await sleep(pauseMs);
      }
    } catch (err) {
      console.warn('warming card rows failed:', err);
    }
  }

  /**
   * What every turn's scheme-refs snapshot in a scheme shares, read once however many turns run there (#609). The
   * scheme's open cards come in one query, not one per minion (#1562).
   */
  refsShared(projectId: number) {
    const tickets = this.store.listTickets(projectId);
    const openOf = new Map<number, EventRow[]>(tickets.map((t) => [t.id, []]));
    for (const e of this.store.openCards(projectId)) openOf.get(e.ticket_id)?.push(e);
    const links = new Map(tickets.map((t) => [t.id, this.cardLinks(t, false, openOf.get(t.id))]));
    const open = new Set([...links.values()].flat().map((c) => c.href));
    return { project: this.store.getProject(projectId)!, projects: this.store.listProjects(), tickets, openOf, links, settled: this.settledCards(projectId, open) };
  }

  /**
   * Write a turn's scheme-refs snapshot (scheme-refs.ts) for `ticket`, with its scheme's cards waiting on people. `now`
   * writes it before returning (a launch: the turn reads it from its first reply); a refresh goes through putRefs.
   */
  private writeRefs(file: string, ticket: Ticket, shared = this.refsShared(ticket.project_id), now = false) {
    const text = this.refsText(ticket, shared);
    if (now) {
      // Whole or not at all: the link check may read it mid-turn.
      writeFileSync(`${file}.new`, text);
      renameSync(`${file}.new`, file);
      // A refresh still on its way to this file would put older text back: it writes this one last.
      const held = this.refsWrites.get(file);
      if (held) held.text = text;
    } else this.putRefs(file, text);
  }

  /** A turn's scheme-refs snapshot (scheme-refs.ts) as text: its scheme's minions and the cards waiting on people. */
  private refsText(ticket: Ticket, shared = this.refsShared(ticket.project_id)) {
    const { project, projects, tickets, openOf, links, settled } = shared;
    // Only the turn's own cards say where each sits (`placed`).
    const cards = { self: ticket.kind === 'coordinator' ? null : ticket.number, cards: tickets.flatMap((t) => (t.id === ticket.id ? this.cardLinks(t, true, openOf.get(t.id)) : links.get(t.id)!)) };
    return JSON.stringify({ ...schemeRefs(project, projects, tickets, cards), settled });
  }

  /** Per scheme: how many refreshes of its turns' snapshots have run, so a launch can tell it missed one (#1808). */
  private refsSeq = new Map<number, number>();

  /** Per snapshot file: the newest text still to write (null once taken), and its writes' end. */
  private refsWrites = new Map<string, { text: string | null; done: Promise<void> }>();

  /**
   * Writes a running turn's snapshot off the server's thread (#1768): on a busy disk the write and rename each held
   * every request for up to a second (Nov 24, six holds). One write per file at a time, the newest text winning, whole
   * or not at all, and only over a snapshot that is still there: a turn that ended took its folder with it.
   */
  private putRefs(file: string, text: string) {
    const held = this.refsWrites.get(file);
    if (held) {
      held.text = text;
      return;
    }
    const w = { text: text as string | null, done: Promise.resolve() };
    this.refsWrites.set(file, w);
    w.done = (async () => {
      try {
        while (w.text !== null) {
          const next = w.text;
          w.text = null;
          await access(file);
          await writeFile(`${file}.new`, next);
          await rename(`${file}.new`, file);
        }
      } catch {
        // A stale snapshot only means a card goes unchecked.
      } finally {
        this.refsWrites.delete(file);
      }
    })();
  }

  /** Resolves once every snapshot write under way has reached its file. */
  async refsWritten(): Promise<void> {
    while (this.refsWrites.size) await Promise.all([...this.refsWrites.values()].map((w) => w.done));
  }

  /** The least time between two refreshes of a scheme's snapshots (refreshRefs). */
  refsGapMs = 2_000;
  /** Per scheme: when its snapshots were last refreshed, and the refresh waiting for the gap to pass. */
  private refsLast = new Map<number, { at: number; due?: ClockTimer }>();

  /**
   * A card was posted or settled in `ticketId`'s chat: the running turns of its scheme get it in their snapshot, so the
   * link check knows it. At most once per refsGapMs per scheme (#1562): the first card refreshes at once, and the cards
   * after it within the gap share one refresh at its end. The card's own minion gets its snapshot at once either way:
   * its link check may read it before the gap ends, and a missing card there bounces its reply (cardlessChoices).
   * `posted` (the turn posted the card itself) writes that one snapshot before returning, so it is there when the
   * turn's tool call is answered; every other turn's goes off the server's thread (putRefs).
   */
  private refreshRefs(ticketId: number, posted = false) {
    const projectId = this.store.getTicket(ticketId)?.project_id;
    if (projectId === undefined) return;
    const last = this.refsLast.get(projectId);
    const wait = last ? last.at + this.refsGapMs - this.clock.now() : 0;
    const own = posted ? ticketId : undefined;
    if (!last?.due && wait <= 0) return this.writeSchemeRefs(projectId, undefined, own);
    this.writeSchemeRefs(projectId, ticketId, own);
    if (last?.due) return;
    const due = this.clock.setTimeout(() => {
      try {
        this.writeSchemeRefs(projectId);
      } catch (err) {
        console.error(`Scheme ${projectId}: refreshing its turns' snapshots failed:`, err);
      }
    }, wait);
    due.unref();
    this.refsLast.set(projectId, { at: last!.at, due });
  }

  /**
   * Rewrite the snapshot of every turn running in `projectId`, or only `only`'s, outside the gap (refreshRefs). `own`'s
   * is written before returning, the rest off the server's thread.
   */
  private writeSchemeRefs(projectId: number, only?: number, own?: number) {
    // The gap starts only once a refresh read something: a card in a scheme with no turn running costs nothing.
    if (only === undefined) this.refsLast.delete(projectId);
    this.refsSeq.set(projectId, (this.refsSeq.get(projectId) ?? 0) + 1);
    let shared: ReturnType<Runner['refsShared']> | undefined;
    for (const [id, turn] of this.turns) {
      if (only !== undefined && id !== only) continue;
      const t = this.store.getTicket(id);
      if (t?.project_id !== projectId) continue;
      if (!shared && only === undefined) this.refsLast.set(projectId, { at: this.clock.now() });
      try {
        const file = join(turn.dir, 'scheme-refs.json');
        // A turn that ended took its folder with it (putRefs checks the same, off the thread).
        if (id === own && !existsSync(file)) continue;
        this.writeRefs(file, t, (shared ??= this.refsShared(projectId)), id === own);
      } catch {
        // A stale snapshot only means a card goes unchecked.
      }
    }
  }
}
