// Runs ticket turns as headless `claude -p` processes, one turn per process. Each runs through
// src/turn-wrapper.ts in a transient systemd unit of its own (or, without units, a detached child),
// with its input and output in a turn folder the server tails, so a server restart doesn't stop it.
import { execFile, spawn } from 'node:child_process';
import { jobMachinesFor } from './machine-jobs.ts';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { AGENT_NAME } from './auth.ts';
import { Relay, clip, coldKey, loopKey, mailKey, MINION_PAIRS, minionPairKey, pairKey, LOOP_LIMIT, LOOP_WINDOW_MS, type LoopState } from './minion-relay.ts';
export { LOOP_LIMIT, LOOP_WINDOW_MS };
import { askerKey, buildOwnerKey, onboardingOpen, planKey, type EventRow, type FinishedStep, type Project, type Store, type Ticket } from './db.ts';
import { Approvals, lines, type Go } from './approvals.ts';
import type { TurnGithub } from './github-link.ts';
import { KEEP, SENT_BACK } from './link-check.ts';
import type { SchemeRefs } from './scheme-refs.ts';
import { cardHref, cardLabel, cardText, cardWhat, settledHow, type CardLink, type SettledCard } from './card-links.ts';
import type { Ship } from './branch.ts';
import type { Wait } from './waits.ts';
import { claudeConfigDir, lastEffort, mergeMemory, projectSlug, restoreAhead, restoreSession, saveSession, storedPaths, transcriptPath, validSessionId } from './sessions.ts';
import { Lanes } from './lanes.ts';
import { buildBranch, landsBuilds, projectDir, recoverTicketDir, restoreTicketDir, surveyReports } from './workspace.ts';
import { buildPreviewPath, previewKey } from './previews.ts';
import { accountUsageKey, usageKey } from './account-pick.ts';
import { isAuthFailure, type TurnPlace } from './claude-link.ts';
import { asData } from './quote.ts';
import { runsRepo } from './wake.ts';
import { clearTmpDirLater, makeTmpDir, sweepTmpDirs } from './turn-tmp.ts';
import { clearBuildOutput, size, ticketWorktree } from './build-output.ts';
import { clearTrash, GRACE_MS, GRUNT_AGE_MS, isGrunt, madeAt, ownCheckout, removeWorktree, saveWork, savedRef, worktrees, type Worktree } from './worktree-sweep.ts';
import { claudeParts, codexResetAt, codexSwitchKey, codexThreadKey, codexUsageKey, fitLog, isCodexModel, readParts, toClaudePreamble, CODEX_MODELS, CODEX_WAITING, HANDOVER_MAX, type CodexThread, type CodexUsage } from './codex.ts';
import { promptHashes, type PromptHashes } from './prompt-hashes.ts';
import { COMPACT_COMMAND, freshStartText, handoffPrompt, LOST_DIGEST_ENTRIES, minionHandoffPrompt, lostSessionText, promptMessage, promptParts, promptText, RESUME_CODEX_PROMPT, RESUME_PROMPT, TASKMASTER_LOOP_LIMIT, TASKMASTER_LOOP_WINDOW_MS, type TurnMachine } from './prompts.ts';
import { fallbacks } from './fallbacks.ts';
import { alive, launchPlan, type EveryScheme, type LaunchPlan, TURN_BUILD_JOBS, TURN_SLICE, turnEnv, turnPins, turnSettings, USAGE_LIMIT } from './turn-launch.ts';
import { hideTokens } from './hide-tokens.ts';
import { hideSecrets, hideSecretsIn, secretEnv } from './secrets.ts';
import { takeStatus, type StatusFields } from './status-trailer.ts';
import { appFolder, slotsOf } from './app-services.ts';
import { DEFAULT_CONTRAPTIONS_DIR } from './contraptions.ts';
import { GLOBAL_OWNER } from './properties.ts';
import { CACHE_TTL_MS, KEEPALIVE_AFTER_MS, KEEPALIVE_OFF_KEY, KEEPALIVE_REPORT_KEY, KEEPALIVE_TEXT, SERIES_CAP_MS, WEEK_MS, changedParts, claudeStamp, contextText, fingerprint, inWindow, keepaliveKey, missed, prefixParts, reportText, tooManyMisses, treeHash, turnDate, weekReport, type KeepaliveSeries } from './keepalive.ts';
import { homedir } from 'node:os';
import { checkProcess, longestTool, noteEvent, quietAt, type Activity, type ProcCheck } from './quiet.ts';
import { activityLabel, applyEvent, createProgress, isWorkTool, planEstimate, planTrack, progressLine, stepInfo } from '../public/progress.js';
import { packPlan, unpackPlan } from './history.ts';
import { readGrunts } from './grunts.ts';
import { openSpend, SpendMeter, type SpendState, spendText, STAGES_SETTING, stagesFrom } from './spend-alert.ts';
import { isAppTurnsRun } from './schedules.ts';
import { clockTime, pacific, parseResetTime } from './pacific.ts';

const MAX_TOOL_OUTPUT = 20_000;
/** How many of a thread's newest replies and messages strike_text searches for the quote (#622). */
const STRIKE_SEARCH = 500;
/** The most of a minion's Codex log kept for the way back, as characters (twice what a hand-over carries). */
const CODEX_LOG_MAX = 2 * HANDOVER_MAX;

/** The scheme-refs snapshot for a turn of `project`: its name, the other schemes' names and its minions, plus its cards waiting on people (card-links.ts). */
export function schemeRefs(project: Project, projects: Project[], tickets: Ticket[], cards?: { self: number | null; cards: CardLink[] }): SchemeRefs {
  const minions: SchemeRefs['minions'] = {};
  for (const t of tickets) if (t.number != null) minions[t.number] = { title: t.title, closed: t.status === 'closed' };
  return { scheme: project.name, others: projects.filter((p) => p.id !== project.id).map((p) => p.name), minions, ...cards };
}

/** The chat event kinds that post or settle a card waiting on people (a person's message answers one). */
const CARD_KINDS = new Set(['question', 'question_more', 'plan', 'approval', 'question_result', 'plan_result', 'approval_result', 'user_message']);
const EVERYONES = new Set(['question', 'plan', 'approval']);

// Stream events that carry no information for the ticket view.
const DROPPED_TYPES = new Set(['rate_limit_event', 'stream_event']);

export type Broadcast = (msg: object) => void;

interface UsageWindow {
  utilization: number; // 0..1 of the plan's limit
  resetsAt: number | null; // epoch ms
  status: string | null;
}

/** The Claude account's plan usage, as last reported by a turn. */
export interface Usage {
  weekly: UsageWindow | null;
  session: UsageWindow | null; // the rolling five-hour window
  updatedAt: number;
}

function usageWindow(w: any): UsageWindow | null {
  if (!w || typeof w.utilization !== 'number') return null;
  return {
    utilization: w.utilization,
    resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
    status: typeof w.status === 'string' ? w.status : null,
  };
}

export interface MessageImage {
  name: string;
  path: string;
  mediaType: string;
}

/** A file people attached, saved in the thread's files folder (src/uploads.ts). */
export interface MessageFile {
  name: string;
  path: string;
  size: number;
  type: string;
}

export interface QueuedMessage {
  author: string;
  text: string;
  images: MessageImage[];
  files?: MessageFile[];
  about?: string; // the file a comment is on
  id?: number; // its user_message event, for taking it back while queued
  from?: number; // the minion or Taskmaster that relayed it, whose turn's person it carries
  typed?: boolean; // a signed-in person sent it from the chat; only these can be a go to merge (#201)
  own?: boolean; // a person sent it themselves: typed, or a card's answer; only these carry their own secrets (#838)
  asker?: number | null; // whose ask it is (Store.turnAsker), taken when it was sent; null for no person's
  fresh?: 'handoff' | 'compact'; // a Taskmaster's fresh-start step (#406), which runs alone
  fyi?: boolean; // a notice that needs no action (its PR merged, CI passed): it doesn't cancel a pending close_self (#619)
  parked?: string; // held for a parked minion (#718): when it was sent, "2026-11-14 18:02" UTC
  keepalive?: true; // a hidden keepalive (#862, src/keepalive.ts): no chat, no state, nothing of the minion's changes
  light?: true; // a machine's notice of success (a land that landed, CI passed, a job done): a turn of only these runs at low effort (#951)
}

/**
 * What a running turn's restart recovery needs, kept in the settings table under `turn:<ticket id>`
 * from the turn's start until the server has handled its end. A restart re-attaches to the turn from
 * this, or resumes it if its process died too.
 */
interface TurnState {
  /** Auto-resumes in a row that led to this turn; 0 for a turn people or GitHub started. */
  resumes: number;
  stopped?: true;
  /** Present (a reason or null) once the thread asked to close after this turn. */
  closing?: string | null;
  queued?: QueuedMessage[];
  /** Messages appended to its steer.jsonl, with where each ends there; those past steer.sent never reached claude. */
  steered?: { end: number; msg: QueuedMessage }[];
  /** The turn's folder (see src/turn-wrapper.ts); absent for turns from before they had one. */
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
  /** Usage-limit resumes in a row that led to this turn. */
  limitTries?: number;
  /** Network-outage resumes in a row that led to this turn (#366). */
  netTries?: number;
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
}

/** A turn this server follows: its folder, read up to `offset`. */
interface LiveTurn {
  dir: string;
  unit: string | null;
  offset: number;
  startedAt: number;
  configDir: string;
  chosenEffort: boolean;
  container: string | null;
  timer: NodeJS.Timeout;
  ticks: number;
  stopTimer?: NodeJS.Timeout;
  /** A stop's SIGINT-to-SIGTERM wait. */
  stopGraceTimer?: NodeJS.Timeout;
  /** What it last did and the tool calls still open (#906): when it counts as quiet. */
  activity: Activity;
  /** Stopped before its claude had started (no pid.json): signalled once it has. */
  stopPending?: boolean;
  /** Resolves once the turn has ended and its session is saved: its step on the minion's lane. */
  ended: Promise<void>;
  end: () => void;
  /** What the config dir held when the turn started, which its save may prune (null: nothing; a re-attached turn doesn't know). */
  had: Set<string> | null;
}

/** A minion's context size at its last turn's last API call (tokens), for what switching its payer costs. */
const contextKey = (ticketId: number) => `context:${ticketId}`;

/**
 * A Taskmaster's fresh start (#406): asked for (why), its handoff once the old session wrote it with
 * fresh_session, and `compact` once the handoff failed and a /compact turn falls back on. `auto`: Citadel
 * asked for it by itself (turn end or idle), so a message queued meanwhile goes first.
 */
export interface FreshState { why: string; summary?: string; compact?: true; auto?: true }
const freshKey = (ticketId: number) => `fresh:${ticketId}`;
/** The handoff a fresh session's first turn starts from, kept until that session exists. */
const handoffKey = (ticketId: number) => `handoff:${ticketId}`;
/** What a fresh start's notes call the chat's agent. */
const roleWord = (t: Ticket) => (t.kind === 'coordinator' ? 'Taskmaster' : 'minion');
/** The slash commands a chat's last turn loaded (its init event, #937), and the scheme's newest, for a chat with no turn yet. */
export interface LoadedCommands { names: string[]; plugins: { name: string; path: string }[]; cwd: string }
export const commandsKey = (ticketId: number) => `commands:${ticketId}`;
export const schemeCommandsKey = (projectId: number) => `commands-scheme:${projectId}`;
/** The note the server last wrote about a failed or stopped turn, which the next turn that ends well clears (#428). */
const failNoteKey = (ticketId: number) => `failnote:${ticketId}`;
/** Why a minion's close_self was cancelled at its turn's end, told to its next turn (#619). */
const closeCancelledKey = (ticketId: number) => `close-cancelled:${ticketId}`;
/** Idle this long, a Taskmaster's prompt cache (1 hour) is still warm, so its handoff turn reads it cheaply. */
export const FRESH_IDLE_MS = 55 * 60_000;
/** Past this much context (tokens), a Taskmaster whose turn just ended starts fresh by itself (#423), so a long working session isn't cut mid-flow. */
export const FRESH_CONTEXT_TOKENS = 150_000;
/** Past this much context (tokens), an idle Taskmaster starts fresh (#406): its next cold wake would re-read all of it at full price. Cara 2026-11-15: 60k, not 150k. */
export const FRESH_IDLE_CONTEXT_TOKENS = 60_000;
const HANDOFF_MAX = 20_000;

// Kept in src/account-pick.ts, which claude-link.ts reads them from too (#793).
export { accountUsageKey, usageKey };

/** A turn whose wrapper hasn't said it runs (no pid.json or beat yet) counts as still starting for this long. */
const START_GRACE_MS = 60_000;

/** A container turn's wrapper beat (src/turn-wrapper.ts) longer ago than this is gone. */
const BEAT_STALE_MS = 30_000;

/**
 * A turn's wrapper still runs: its pid is alive and is that turn's wrapper, not a reused pid. In a
 * container (the `container` file) its pids are the container's, so its heartbeat says instead.
 */
export function wrapperAlive(dir: string): boolean | null {
  if (existsSync(join(dir, 'container'))) {
    try {
      return Date.now() - statSync(join(dir, 'beat')).mtimeMs < BEAT_STALE_MS;
    } catch {
      return null;
    }
  }
  let pid: number;
  try {
    pid = JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8')).wrapper;
  } catch {
    return null; // not started yet, or never will be
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(dir);
  } catch {
    return existsSync('/proc/self') ? false : alive(pid);
  }
}

/** A turn's steers its wrapper never passed to claude (see src/turn-wrapper.ts). */
export function unsentSteers(turn: Pick<TurnState, 'steered' | 'dir'>): QueuedMessage[] {
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

const turnKey = (ticketId: number) => `turn:${ticketId}`;
/** A minion's session as the account pick knows it (#793): only one it resumes can be warm, so a fresh start goes where new work goes. */
const warmKey = (ticket: Ticket) => (ticket.session_id ? `ticket:${ticket.id}` : undefined);
// A scheme's standing gos to merge (#260), kept in settings so they outlive turns and restarts.
const goesKey = (projectId: number) => `merge_goes:${projectId}`;
/** Set when a person writes to a minion waiting in pending-deploy: its deploy then leaves it open. */
const talkedKey = (ticketId: number) => `talked-since-deploy:${ticketId}`;
/** A turn's end-of-turn session save that hasn't finished yet: the config dir it reads, so a restart redoes it (#259). */
const savingKey = (ticketId: number) => `saving:${ticketId}`;
/** Messages waiting for a minion's lane while no turn runs (its last turn's save), so a restart doesn't lose them (#259). */
const waitingKey = (ticketId: number) => `waiting:${ticketId}`;
/** A restart's resume of a cut-off turn not started yet, with what it carries, so a second restart still owes it (#468 S03-8). */
const owedKey = (ticketId: number) => `resume-owed:${ticketId}`;
/** Idle this long, a session's prompt cache (1 hour) is about to lapse, so a machine message to it waits (#413). */
export const COLD_MS = 55 * 60_000;
/** The longest a message held for a cold session waits before it wakes the session anyway. */
export const COLD_HOLD_MAX_MS = 3 * 3600_000;

/** Claude's words for an account problem only a person can fix, like "API Error: 400 Identity verification is required to continue.": never retried. */
export const ACCOUNT_ERROR = /identity verification|credit balance|oauth token|invalid api key|run \/login|organization has been disabled/i;
/** Usage-limit resumes in a row before a minion waits for a person. */
export const MAX_LIMIT_RESUMES = 3;
const LIMIT_RESUMES = 'limit-resumes';
/** One linked Claude account's limit: `here` is the one this minion's turn hit, `kind` what Claude called it ('weekly', '5-hour'). */
export interface LimitedAccount { n: number; label: string; until: number; here?: boolean; kind?: string }

/** Minions waiting for the usage limit to reset, in the settings table so the wait outlives a restart. */
interface LimitResume {
  ticket: number;
  /** When it resumes (ms): a while after the reset, spaced from the others. */
  at: number;
  /** Limit resumes in a row this one will be. */
  tries: number;
  /** Messages people sent while it waited; they go into the resume. */
  queued?: QueuedMessage[];
  /** Several accounts all limited (#819): each one's reset, so the banner says which limit is which. */
  accounts?: LimitedAccount[];
  /** Its person switched to Codex: it resumes on Codex now (#337). */
  codex?: true;
  /** A turn on its plan got through, so the limit is gone: it resumes limitProvenGapMs after the last, not limitGapMs. */
  proven?: true;
}

/** The usage-limit wait to resume next, and when: each wait is due at its own time or, if later, its gap after the last resume. */
export function nextLimitResume(list: LimitResume[], lastResume: number, gap: number, provenGap: number): { wait: LimitResume; due: number } | null {
  let best: { wait: LimitResume; due: number } | null = null;
  for (const wait of list) {
    const due = Math.max(wait.at, lastResume + (wait.proven ? provenGap : gap));
    if (!best || due < best.due || (due === best.due && wait.at < best.wait.at)) best = { wait, due };
  }
  return best;
}
const RESUME_ACCOUNT_PROMPT =
  `Your last turn stopped at a Claude account's usage limit (or its sign-in ran out), so this turn carries on with another of your person's Claude accounts. Check the state of your work (files, git, background jobs) and continue where you left off. Don't redo finished steps.`;

const RESUME_LIMIT_PROMPT =
  `Your last turn stopped at the account's usage limit, which has now reset. Check the state of your work (files, git, background jobs) and continue where you left off. Don't redo finished steps.`;

/** Every one of a person's accounts is limited (#779): when the first resets, and (#819) each one's own limit. */
export interface AllLimited { resetAt: number; accounts: LimitedAccount[] }

/** The note for a minion whose accounts are all limited: which one is out until when, and which reset it waits for. */
export function allLimitedText(accounts: LimitedAccount[], at: number): string {
  const out = (a: LimitedAccount) => `${a.here ? `This account (${a.label})` : a.label} is out until ${clockTime(a.until)}${a.kind ? ` (${a.kind})` : ''}.`;
  const first = accounts.reduce((m, a) => (a.until < m.until ? a : m));
  const when = accounts.length > 1 ? `when ${first.label}'s limit resets` : 'when it resets';
  return `${[...accounts].sort((a, b) => Number(!!b.here) - Number(!!a.here) || a.until - b.until).map(out).join(' ')} This minion carries on at ${clockTime(at)}, ${when} (or sooner once a turn gets through); a person's message tries now.`;
}

/**
 * Words for a turn that died because the network or the model's API was unreachable (#366): Claude
 * Code's "API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)" and
 * "Connection error.", Node's socket and DNS codes, and Codex's "stream disconnected" / "error sending request".
 */
const NETWORK_ERROR = /\b(EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b|can['’]t reach the api server|unable to connect to api|API Error: (Connection error|Request timed out)|stream disconnected|error sending request|failed to lookup address|dns error/i;
/** Whether a failed turn's words say the network or the API was unreachable. An HTTP status means the server answered ("stream disconnected … unexpected status 401"): not an outage. */
export function isNetworkFailure(text: string): boolean {
  return NETWORK_ERROR.test(text) && !isAuthFailure(text) && !/\b(status|API Error:) [1-5]\d\d\b/i.test(text);
}
/** Network-outage resumes in a row before a thread is left in error for a person. */
export const MAX_NET_RESUMES = 3;
const NET_RESUMES = 'net-resumes';
/** Threads waiting for the network to come back, in the settings table so the wait outlives a restart. */
interface NetResume {
  ticket: number;
  /** Network resumes in a row this one will be. */
  tries: number;
  /** Messages queued behind the turn that died; they go into the resume. */
  queued?: QueuedMessage[];
}
/** The minion's note while it waits: cleared by the next turn's start. */
const NET_NOTE = 'Network outage: resumes once it is back';
const RESUME_NET_PROMPT =
  `Your last turn died because the network or the model's API was unreachable; it is reachable again now. A command may have half-run when the connection dropped (a land, a push, a deploy, a fetch), so check the state of your work (git first, then files and background jobs) before you continue where you left off. Don't redo finished steps.`;

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
export const MAX_RESUMES = 2;

function truncate(s: string): string {
  return s.length > MAX_TOOL_OUTPUT ? s.slice(0, MAX_TOOL_OUTPUT) + `\n… [truncated ${s.length - MAX_TOOL_OUTPUT} chars]` : s;
}

/**
 * Shrink a stream-json event before storing it, keeping only what the chat, the progress readout
 * and the coordinator's transcript read: thinking, usage, ids and background-task echoes are most
 * of a long thread's history and none of them are shown. Returns null for events not worth keeping.
 * `stored` is for events already in the database, whose tool output was capped when it was saved.
 */
export function slimEvent(ev: any, stored = false): any {
  if (ev.type === 'system') {
    return ev.subtype === 'init'
      ? { type: 'system', subtype: 'init', session_id: ev.session_id, model: ev.model, cwd: ev.cwd }
      : null;
  }
  if ((ev.type === 'assistant' || ev.type === 'user') && Array.isArray(ev.message?.content)) {
    const content = ev.message.content.flatMap((block: any) => {
      if (block?.type === 'thinking' || block?.type === 'redacted_thinking') return [];
      if (block?.type === 'text' && typeof block.text === 'string') return [{ ...block, text: hideTokens(block.text) }];
      if (block?.type !== 'tool_result' || stored) return [block];
      let content = block.content;
      if (Array.isArray(content)) {
        content = content.map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
      }
      return [{ ...block, content: truncate(hideTokens(String(content ?? ''))) }];
    });
    if (!content.length) return null;
    const slim: any = { type: ev.type, message: { role: ev.message.role, content } };
    if (ev.parent_tool_use_id) slim.parent_tool_use_id = ev.parent_tool_use_id;
    return slim;
  }
  if (ev.type === 'result') {
    const { subtype, is_error, duration_ms, num_turns, total_cost_usd } = ev;
    // A successful turn's result repeats its last message; only a failure's says something new.
    return { type: 'result', subtype, is_error, duration_ms, num_turns, total_cost_usd, ...(ev.is_error ? { result: ev.result } : {}) };
  }
  return null;
}

/** Whether a shell command pushes to GitHub or opens a pull request (for the chat note), by its words. */
export function pushKind(command: string): 'push' | 'pr' | null {
  // Quoted words are messages and arguments (git commit -m "then git push"), not commands.
  command = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  if (/\bgh\s+pr\s+create\b/.test(command)) return 'pr';
  return /\bgit\b(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+push\b/.test(command) ? 'push' : null;
}

function describeActivity(ev: any): string | null {
  if (ev.type !== 'assistant') return null;
  const blocks: any[] = ev.message?.content ?? [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    // A Grunt's report (a subagent's words) isn't what the minion is doing; its tool calls are.
    if (b?.type === 'text' && !ev.parent_tool_use_id && typeof b.text === 'string' && b.text.trim()) return b.text.trim().split('\n')[0].replace(/\*\*|`/g, '').slice(0, 160);
    // The same plain words as the readout ("Ran the tests", "Edited app.js"), not "Using Bash".
    if (b.type === 'tool_use' && isWorkTool(b.name)) return activityLabel(b);
  }
  return null;
}

/** How a turn's MCP server reaches the API; without `token` it mints the ticket's next turn token, which retires the one before. */
export type CoordinatorEnv = (ticket: Ticket, token?: string) => Record<string, string>;

export class Runner {
  private turns = new Map<number, LiveTurn>();
  /** Each minion's lifecycle steps, one at a time (src/lanes.ts): a turn and its session save, a resume, a dismissal's cleanup. */
  private lanes = new Lanes();
  private queues = new Map<number, QueuedMessage[]>();
  /** Tickets that asked to close when their current turn ends, with the reason they gave. */
  private closing = new Map<number, string | null>();
  /** Minions whose deploy went live mid-turn: dismissed when that turn ends, if still pending-deploy. */
  private deployedMidTurn = new Set<number>();
  private progress = new Map<number, ReturnType<typeof createProgress>>();
  private stepRatios = new Map<number, { at: number; ratio: number }>();
  /** The minion whose relayed message started each ticket's current turn, when a relay came before any person's message. */
  private turnFrom = new Map<number, number>();
  /** A parked minion's state and note when a turn answering a message started: put back at its end, while still parked (#261). */
  private parkedAs = new Map<number, { state: string | null; note: string | null }>();
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
  private limitTimer?: NodeJS.Timeout;
  private lastLimitResume = 0;
  /** Whether the model's API can be reached; one probe for the whole server while any thread waits on the network (#366). */
  netProbe: () => Promise<boolean> = apiReachable;
  /** The first wait before probing, doubling after each failed probe up to netProbeMaxMs. */
  netProbeMs = 30_000;
  netProbeMaxMs = 5 * 60_000;
  /** The wait before the next probe; null for netProbeMs, a fresh outage's first. */
  netDelay: number | null = null;
  private netTimer?: NodeJS.Timeout;
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
  /** Where turn folders go: beside the database, so a test's or dev copy's never mix with the live ones. */
  turnsDir: string;
  /** The data dir this runner's turns use (beside the database), so a test's or dev copy's stay apart. */
  private dataDir: string;
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
  /** A folder outside the repo where a ticket can put files it fetched or made to show people. */
  filesDir: (ticket: Ticket) => string | null = () => null;
  /** The folder every thread and the coordinator of a project can read and write, for handoffs and notes. */
  sharedDir: (project: Project) => string | null = () => null;
  /** The folder that holds a project's ticket folders, which the coordinator may read. */
  ticketsDir: (project: Project) => string = (project) => join(project.repo_dir ?? '.', '..', 'tickets');
  /** Machines online now and lent to this scheme (access.ts lendsMachine); a thread's turn gets each one's MCP tools. */
  /** The online machines a turn in this scheme gets, for these askers (#306: their own machines). */
  machines: (project: Project, askers: number[]) => TurnMachine[] = () => [];
  /** Called after each tool result and at the end of each turn, when files on disk may have changed. */
  onFilesMayChange: (ticketId: number) => void = () => {};
  /** Where the minion's change is, branch to live (src/branch.ts), for its bar and its row's badge. */
  ship: (ticketId: number) => Ship | null = () => null;
  /** What it waits on now: the land line, a heavy slot, the restart (src/waits.ts), for its row's badge and bar. */
  wait: (ticketId: number) => Wait | null = () => null;
  /** What the server is doing for it with no turn of its own (#727): today its handed-off land (src/land.ts), set by the server. */
  serverWork: (ticketId: number, fresh?: boolean) => { kind: string } | null = () => null;
  /** Called when a turn's process has exited, however the turn ended. */
  onTurnEnd: (ticketId: number) => void = () => {};
  /** What a minion parked on start_after waits for, or null (LiveWaiters.heldFor, set by the server). */
  heldFor: (ticketId: number) => string | null = () => null;
  /** The brief a chained minion holds, shown read-only in its chat (LiveWaiters.heldBrief, set by the server). */
  heldBrief: (ticketId: number) => { text: string; from: string; leader: number; when: 'live' | 'merged' } | null = () => null;
  /** What wakes a parked minion by itself (an unheld start_after, wake_when_live, wake_when_runners_back), or null (set by the server). */
  wakesOn: (ticketId: number) => string | null = () => null;
  /** Approve / Deny cards waiting on people, for projects with approval rules. */
  approvals: Approvals;
  private relays: Relay;
  /** Where a turn for a person runs (#213, src/claude-link.ts): the host, their own container, or why it can't run at all. */
  placeFor?: (person: number | null, warm?: string) => TurnPlace | { refused: string };
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
  claudeAccounts?: (person: number) => { inUse: number | null; why?: string; pinned?: number; accounts: { n: number; label: string }[] } | null;
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
  hostEnv(ticket: Ticket, token: string): Record<string, string> {
    const project = this.store.getProject(ticket.project_id);
    // land.sh's retro_log and run-tests.sh's log_flake write there, as they do from a turn.
    const shared = project && this.sharedDir(project);
    // Its pushes and gh calls go out as the person the minion's turns run for, as from the turn (#911): the box's gh
    // login can't see a member's private repo. Its gh folder is the person's, since the land outlives the turn's folder.
    const person = (this.turns.has(ticket.id) ? this.store.getSetting<TurnState>(turnKey(ticket.id))?.person : null) ?? ticket.person_id;
    const github = this.githubFor?.(person, join(this.dataDir, 'people', String(person ?? 'nobody')))?.env;
    return { ...turnEnv(process.env), ...github, ...this.coordinatorEnv(ticket, token), ...this.heavyEnv(ticket, ticket.person_id), COORDINATOR_ROLE: 'thread', COORDINATOR_TICKET: String(ticket.id), ...(shared ? { COORDINATOR_SHARED_DIR: shared } : {}) };
  }

  /** citadel-heavy's slots (#325), in the projects folder every person's container mounts at the same path, and who a job runs for. */
  private heavyEnv(ticket: Ticket, person: number | null): Record<string, string> {
    const payer = person ? this.store.getUser(person)?.login : undefined;
    const who = `${this.store.getProject(ticket.project_id)?.name ?? '?'} #${ticket.number}${payer ? ` (${payer})` : ''}`;
    return { CARGO_BUILD_JOBS: TURN_BUILD_JOBS, CITADEL_HEAVY_DIR: join(this.dataDir, 'projects', '.heavy'), CITADEL_HEAVY_WHO: who };
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
  refuseTurn?: (ticket: Ticket, author: string, from?: number) => string | null;
  /** The person a message speaks for: its author, or for a relay (`from`), the sending turn's person. */
  personOf?: (author: string, from?: number) => number | null;
  /** A turn's GitHub env and prompt line for its person (src/github-link.ts forTurn); null with linking not set up. */
  githubFor?: (person: number | null, turnDir: string) => TurnGithub | null;
  /** The secrets a turn of `project` running as `person` gets (src/secrets.ts, #838): its env vars, and the values its output hides. */
  secretsFor?: (project: number, person: number | null) => Map<string, string>;
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
      gitDirs: [...new Set(others.flatMap((p) => [p.repo_dir!, ...this.store.listTickets(p.id).filter((t) => t.status !== 'closed' && t.cwd).map((t) => t.cwd!)]))],
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
  private spends = new Map<number, { startedAt: number; meter: SpendMeter }>();
  /** Applies a turn's status trailer (src/status-trailer.ts) as set_thread_status would; the server wires it to the PATCH route's checks. */
  onStatusTrailer: (ticketId: number, fields: StatusFields) => void = () => {};
  /** The running turn's last status trailer, applied when its result comes in. */
  private statuses = new Map<number, StatusFields>();

  constructor(store: Store, broadcast: Broadcast, coordinatorEnv: CoordinatorEnv, claudeBin = 'claude') {
    this.store = store;
    this.broadcast = broadcast;
    this.approvals = new Approvals((ticketId, kind, data) => {
      this.emit(ticketId, kind, data);
      // The threads list shows which threads are waiting on an approval.
      this.broadcastTicket(ticketId);
    }, { get: (p) => store.getSetting<Go[]>(goesKey(p)) ?? [], set: (p, goes) => store.setSetting(goesKey(p), goes) });
    this.relays = new Relay({ store, approvals: this.approvals, emit: (id, kind, data) => this.emit(id, kind, data), now: () => this.now(), isRunning: (id) => this.isRunning(id), send: (id, author, text, images, extra, steer) => this.send(id, author, text, images, extra, steer), personOf: () => this.personOf, broadcastTicket: (id) => this.broadcastTicket(id), cold: (id) => this.cold(id), parked: (t) => this.parked(t) });
    this.coordinatorEnv = coordinatorEnv;
    this.claudeBin = claudeBin;
    // Messages that arrived while a step ran start a turn once the minion's lane is free.
    this.lanes.onIdle = (ticketId) => this.next(ticketId);
    this.turnsDir = join(dirname(store.path), 'run', 'turns');
    this.dataDir = resolve(dirname(store.path));
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

  isRunning(ticketId: number): boolean {
    return this.turns.has(ticketId);
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
    return [...this.turns.values()].filter((t) => !t.unit && !t.container).length + (this.hostJobs?.() ?? 0);
  }

  /** The minions whose turns interruptible() counts (#584), by id: deploy.sh names them from the database, since /api/health answers without a login. */
  interruptibleTurns(): number[] {
    return [...this.turns].filter(([, t]) => !t.unit && !t.container).map(([id]) => id);
  }

  /** Stop following turns, for a server shutting down; they keep running, and the next server re-attaches. */
  detachAll() {
    // The next server probes for the threads waiting on the network.
    clearTimeout(this.netTimer);
    for (const t of this.turns.values()) {
      clearInterval(t.timer);
      clearTimeout(t.stopTimer);
      clearTimeout(t.stopGraceTimer);
    }
    this.turns.clear();
  }

  queued(ticketId: number): number {
    return this.queues.get(ticketId)?.length ?? 0;
  }

  /** A ticket as the API shows it: plus queued messages and its task-list steps. */
  view(ticket: Ticket) {
    const closed = ticket.status === 'closed';
    // A dismissed minion's row shows no steps, so its task list isn't rebuilt from its whole history for a
    // scheme's list: after a restart that read every dismissed minion's events, 16 s for 500 of them (#527).
    const p = closed ? null : this.progressFor(ticket.id);
    const { total, done } = p ? stepInfo(p) : { total: 0, done: 0 };
    // What steps took against their guesses (#571), which both bars scale the guesses by.
    const ratio = closed ? 1 : this.stepRatio(ticket.project_id);
    // The running step's start and guessed seconds, so the list row's bar fills as the chat head's does (#573).
    const est = p && ticket.status === 'running' ? planEstimate(p, true, Date.now(), ratio) : null;
    const cards = closed ? [] : this.store.openCardsOf(ticket.id);
    return {
      // A network wait's held messages are queued too: they go first into its resume (takeQueue).
      ...ticket, replies: ticket.replies ? JSON.parse(ticket.replies) as string[] : [], queued: this.queued(ticket.id) + (this.netWait(ticket.id)?.queued?.length ?? 0), held_ids: (this.store.getSetting<QueuedMessage[]>(mailKey(ticket.id)) ?? []).flatMap((m) => m.id ?? []), queued_ids: [...(this.netWait(ticket.id)?.queued ?? []), ...(this.queues.get(ticket.id) ?? [])].flatMap((m) => m.id ?? []), steps: total ? { done, total, ...(est && { since: est.since, usual: est.usual }) } : null,
      // The plan's segmented track for the list row (#630): each step's guess and whether it's done, underway or not started.
      step_track: total ? planTrack(p!) : null, closing: this.closing.has(ticket.id),
      // When the running turn started, so the page's timer needn't wait for the turn's first event.
      turnStartedAt: this.turnStartedAt(ticket.id),
      // What the running turn last did and whether it has gone quiet (#906): the chip's popover says so.
      activity: this.activityOf(ticket.id),
      // The running turn's unanswered spend alert (#723), for the list row's badge.
      spend_alert: this.spendAlert(ticket),
      step_ratio: ratio,
      // When it resumes by itself after the usage limit, if it waits for that.
      limit_resume_at: this.limitWait(ticket.id)?.at ?? null,
      // With several accounts all limited, each one's reset (#819), for the banner.
      limit_accounts: this.limitWait(ticket.id)?.accounts ?? null,
      approvals: this.approvals.waiting(ticket.id),
      // Parked on start_after: what it waits for, for Start now.
      parked_for: this.heldFor(ticket.id),
      held_brief: closed ? null : this.heldBrief(ticket.id),
      // What wakes it by itself (start_after, wake_when_live, runners back): the list shows such a parked minion as Waiting, not Parked.
      wakes_on: ticket.state === 'parked' ? this.wakesOn(ticket.id) : null,
      // When its oldest question or plan card still waiting on a person was posted.
      pending_card_at: cards[0]?.created_at ?? null,
      // Its cards waiting on people with the links that open them, for read_ticket and list_tickets (#400).
      open_cards: this.cardLinks(ticket, false, cards),
      properties: this.store.props.forTarget('minion', ticket.id),
      // Who touched it and hasn't left (#919): their Taskmasters hear its updates; the page offers them Leave.
      touched: ticket.kind === 'ticket' && !closed ? this.store.touchedBy(ticket) : [],
      preview: !!this.store.getSetting(previewKey(ticket.id)),
      ship: this.ship(ticket.id),
      wait: closed ? null : this.wait(ticket.id),
      // The server working for it while its own turn has ended (#727): the list and chat show it as working.
      server_work: closed ? null : this.serverWork(ticket.id),
      // What its turns have cost so far, at API prices.
      cost: this.store.ticketCost(ticket.id),
      // The server login's part of it, the share of its weekly limit the minions list shows (#468 S05-3).
      host_cost: this.store.ticketCost(ticket.id, true),
      // Whose Claude plan its last turn ran on (the minion's chip), and what re-reading its context costs a new payer.
      payer: this.payerView(ticket.person_id),
      context_tokens: this.store.getSetting<number>(contextKey(ticket.id)),
      // When its last turn ended, for the composer's cold-wake hint (#413).
      last_turn_end: this.store.lastTurnEnd(ticket.id),
      // A Taskmaster's fresh start under way (#406), which hides the chat's Fresh session button.
      fresh_pending: !!this.store.getSetting<FreshState>(freshKey(ticket.id)),
      // What "Default" means in the composer: the effort a turn gets when the ticket has none of its own.
      default_effort: turnSettings({ ...ticket, effort: null }, this.store.getProject(ticket.project_id) ?? { default_effort: '' }).effort,
      // What the composer's Plugins picker offers (#361): the scheme's optional plugin folders, for a minion.
      optional_plugin_dirs: ticket.kind === 'coordinator' ? [] : lines(this.store.getProject(ticket.project_id)?.optional_plugin_dirs),
    };
  }

  /** A dismissed minion's claims (#921) free themselves; whoever keeps the scheme's claims hears so as held mail. */
  private freeClaims(ticketId: number) {
    const freed = this.store.claims.releaseHeldBy(ticketId);
    const minion = this.store.getTicket(ticketId);
    const keeper = minion && freed.length ? this.store.getOverlord(minion.project_id) : undefined;
    if (!keeper) return;
    for (const c of freed) this.leaveMail(keeper.id, `#${minion!.number} ${minion!.title}`, `(nothing to do unless something waits on it) ${c.name} is free: #${minion!.number}, its holder, was dismissed.`);
    this.broadcast({ type: 'claims', projectId: minion!.project_id });
  }

  /**
   * Close a ticket that is not running. Its worktree and branch are kept. Its temp folder, preview and
   * build output (#336) go on its lane, after its last turn's save; resolves once they are gone.
   */
  close(ticketId: number, text: string): Promise<void> {
    if (this.cancelLimitWait(ticketId)) this.queues.delete(ticketId);
    this.cancelNetWait(ticketId);
    this.store.deleteSetting(closeCancelledKey(ticketId));
    // A reopened minion shouldn't offer the go-ahead it had when dismissed.
    if (this.store.getTicket(ticketId)?.replies) this.store.updateTicket(ticketId, { replies: null });
    this.setStatus(ticketId, 'closed');
    this.emit(ticketId, 'note', { text });
    this.freeClaims(ticketId);
    // A split scheme's Taskmasters read it in their next turn's digest (#919's noteDigest).
    const gone = this.store.getTicket(ticketId);
    if (gone && gone.kind !== 'coordinator' && this.store.isSplit(gone.project_id)) this.store.noteDigest(gone.project_id, 0, `#${gone.number} ${gone.title} was dismissed`);
    return this.lanes.run(ticketId, 'dismissal cleanup', async () => {
      const ticket = this.store.getTicket(ticketId);
      // Reopened while this waited (the status route): its temp folder is in use again.
      if (ticket?.status === 'closed') {
        try {
          await clearTmpDirLater(this.tmpRoot(ticket.project_id), ticketId);
        } catch (err: any) {
          console.error(`Ticket ${ticketId}: could not clear its temp folder: ${err.message}`);
        }
      }
      await this.onClose(ticketId);
      // Read again: it may have been reopened while its preview stopped.
      const still = this.store.getTicket(ticketId);
      if (still?.status === 'closed') {
        await this.clearBuild(still).then(
          (r) => r?.dirs && console.log(`Ticket ${ticketId}: cleared ${size(r.bytes)} of build output on dismissal.`),
          (err) => console.error(`Ticket ${ticketId}: could not clear its build output: ${err.message}`),
        );
      }
    });
  }

  /**
   * Remove a dismissed minion's build output (src/build-output.ts), if its worktree is where a minion's
   * belongs and is a git checkout: never a Taskmaster's (it works in the scheme's main checkout), nor a
   * preview's (its copied rows point at the live worktrees). Null when there is nothing to look at.
   */
  private clearBuild(ticket: Ticket) {
    const dir = ticketWorktree(this.dataDir, ticket.project_id, ticket.id);
    if (ticket.kind === 'coordinator' || resolve(ticket.cwd) !== dir || !existsSync(join(dir, '.git'))) return Promise.resolve(null);
    return clearBuildOutput(dir);
  }

  private sweepingBuild = false;

  /**
   * Clear the build output of minions dismissed before #336, or whose clearing failed: at boot and
   * daily (server.ts). One worktree at a time, each on its lane so a reopen waits for it, and only on
   * proof the minion is dismissed and idle, as the temp sweep (#259). Returns what it freed.
   */
  async sweepBuildOutput(): Promise<{ worktrees: number; bytes: number }> {
    const freed = { worktrees: 0, bytes: 0 };
    if (this.sweepingBuild) return freed;
    this.sweepingBuild = true;
    try {
      for (const p of this.store.listProjects()) {
        for (const t of this.store.listTickets(p.id)) {
          if (t.status !== 'closed' || this.turns.has(t.id) || this.lanes.busy(t.id)) continue;
          await this.lanes.run(t.id, 'build output sweep', async () => {
            const now = this.store.getTicket(t.id);
            if (now?.status !== 'closed' || this.turns.has(t.id)) return;
            const r = await this.clearBuild(now);
            if (r?.dirs) {
              freed.worktrees++;
              freed.bytes += r.bytes;
            }
          });
        }
      }
    } finally {
      this.sweepingBuild = false;
    }
    if (freed.worktrees) console.log(`Cleared ${size(freed.bytes)} of build output from ${freed.worktrees} dismissed minion${freed.worktrees === 1 ? "'s worktree" : "s' worktrees"}.`);
    return freed;
  }

  /**
   * The chat's last few entries before this turn's messages, oldest first, for a fresh session that lost its old one
   * (#899): people's messages and the minion's replies, each as `[author]: text`.
   */
  private chatDigest(ticketId: number, batch: QueuedMessage[]): string[] {
    const asked = new Set(batch.map((m) => m.text));
    const out: string[] = [];
    for (const e of this.store.chatTextEvents(ticketId, 0, LOST_DIGEST_ENTRIES + batch.length + 20).reverse()) {
      const d = JSON.parse(e.data);
      if (e.kind === 'user_message' && typeof d.text === 'string' && !asked.has(d.text)) out.push(`[${d.author}]: ${d.text}`);
      else if (e.kind === 'claude') {
        const text = (d.message?.content ?? []).filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
        if (text.trim()) out.push(`[You]: ${text}`);
      }
      if (out.length === LOST_DIGEST_ENTRIES) break;
    }
    return out.reverse();
  }

  /** Recreate a minion's worktree from its branch if the sweep removed it, with the work it saved (#660). */
  private restoreDir(ticket: Ticket, project: Project) {
    if (ticket.kind === 'ticket' && !ticket.cwd) {
      try {
        const { cwd, branch } = recoverTicketDir(this.dataDir, project.id, project.repo_dir, ticket.id, ticket.number, ticket.title);
        this.store.setTicketDir(ticket.id, cwd, branch);
        // The caller's copy too: the turn about to start runs in it.
        Object.assign(ticket, { cwd, branch });
        this.emit(ticket.id, 'note', { text: `This minion had no worktree on record (its creation was cut off, #899), so it now uses ${cwd}${branch ? ` on branch ${branch}` : ''}.` });
      } catch (err: any) {
        this.emit(ticket.id, 'note', { text: `This minion has no worktree on record and Citadel could not make one: ${err.message}` });
      }
      return;
    }
    try {
      const note = restoreTicketDir(ticket.cwd, project.repo_dir, ticket.branch, savedRef(String(ticket.id)));
      if (note) this.emit(ticket.id, 'note', { text: note });
    } catch (err: any) {
      this.emit(ticket.id, 'note', { text: `Could not recreate the worktree: ${err.message}` });
    }
  }

  /** A reopened minion gets its worktree back now, not at its next turn, so its files and preview are there (#660). */
  reopened(ticketId: number): Promise<void> {
    return this.lanes.run(ticketId, 'worktree restore', () => {
      const ticket = this.store.getTicket(ticketId);
      const project = ticket && this.store.getProject(ticket.project_id);
      if (ticket && ticket.status !== 'closed' && project) this.restoreDir(ticket, project);
    });
  }

  private sweepingWorktrees = false;

  /**
   * Remove dismissed minions' worktrees once their latest dismissal is GRACE_MS old, and Grunt worktrees no
   * running turn can be using (src/worktree-sweep.ts), in every scheme: at boot and daily, with the build
   * output sweep. Branches stay; work not on them is saved to a ref first. Each removal is a note in the
   * minion's chat, and each scheme's Taskmaster gets one note listing them. Returns what it did per scheme.
   */
  async sweepWorktrees(now = Date.now()): Promise<Map<number, { removed: string[]; kept: string[]; bytes: number }>> {
    const done = new Map<number, { removed: string[]; kept: string[]; bytes: number }>();
    if (this.sweepingWorktrees) return done;
    this.sweepingWorktrees = true;
    try {
      for (const p of this.store.listProjects()) {
        // Only a repo in this data folder: a dev copy's rows point at the live repos, whose turns it can't see.
        if (!p.repo_dir || resolve(p.repo_dir) !== join(projectDir(this.dataDir, p.id), 'repo') || !existsSync(p.repo_dir)) continue;
        const log = { removed: [] as string[], kept: [] as string[], bytes: 0 };
        const keep = (what: string, why: string) => {
          const key = `worktree-kept:${what}`;
          if (this.store.getSetting<string>(key) !== why) log.kept.push(`${what} (${why})`);
          this.store.setSetting(key, why);
        };
        const removed = (what: string, bytes: number, extra = '') => {
          this.store.deleteSetting(`worktree-kept:${what}`);
          log.removed.push(`${what}, ${size(bytes)}${extra}`);
          log.bytes += bytes;
        };
        // What a removal that failed or was cut short left behind.
        for (const parent of [join(projectDir(this.dataDir, p.id), 'tickets'), join(p.repo_dir, '.claude', 'worktrees')]) {
          const trash = await clearTrash(parent).catch((err) => ({ bytes: 0, stuck: [`${parent}: ${err.message}`] }));
          if (trash.bytes) removed(`folders earlier removals left in ${relative(projectDir(this.dataDir, p.id), parent)}`, trash.bytes);
          for (const stuck of trash.stuck) keep(relative(projectDir(this.dataDir, p.id), stuck.slice(0, stuck.indexOf(': '))), `can't delete: ${stuck.slice(stuck.indexOf(': ') + 2)}`);
        }
        const listed = await worktrees(p.repo_dir).catch(() => null);
        if (!listed) continue;
        await this.sweepGrunts(p, now, listed.filter(isGrunt), keep, removed);
        for (const t of this.store.listTickets(p.id)) {
          if (t.kind === 'coordinator' || t.status !== 'closed' || !t.branch || t.updated_at > now - GRACE_MS || this.turns.has(t.id) || this.lanes.busy(t.id)) continue;
          const dir = ticketWorktree(this.dataDir, p.id, t.id);
          if (resolve(t.cwd) !== dir || !existsSync(dir)) continue;
          await this.lanes.run(t.id, 'worktree sweep', async () => {
            const now2 = this.store.getTicket(t.id);
            // updated_at only moves on: a reopen and a new dismissal restart the clock.
            if (now2?.status !== 'closed' || this.turns.has(t.id) || now2.updated_at > now - GRACE_MS) return;
            const what = `#${t.number} (${relative(projectDir(this.dataDir, p.id), dir)})`;
            if (listed.find((w) => w.path === dir)?.locked) return keep(what, 'locked');
            try {
              // Half a folder, its .git gone: a removal by the first version of this sweep that failed or was cut short.
              if (!existsSync(join(dir, '.git'))) return removed(what, await removeWorktree(p.repo_dir!, dir), ', left half-removed earlier');
              if (!(await ownCheckout(dir))) return;
              const ref = savedRef(String(t.id));
              const s = await saveWork(dir, ref, t.branch, `Citadel: #${t.number}'s work not on its branch, saved before its worktree was removed`);
              if ('kept' in s) return keep(what, s.kept);
              const bytes = await removeWorktree(p.repo_dir!, dir);
              removed(what, bytes, s.saved ? `, its uncommitted work saved in ${ref}` : '');
              this.emit(t.id, 'note', { text: `Removed this dismissed minion's worktree (${size(bytes)}). Its branch ${t.branch} stays, and a reopen brings the folder back${s.saved ? ` with its uncommitted work, saved meanwhile in ${ref}` : ''}.` });
            } catch (err: any) {
              keep(what, `could not remove: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
            }
          });
        }
        if (!log.removed.length && !log.kept.length) continue;
        done.set(p.id, log);
        const text = [
          log.removed.length ? `Removed ${log.removed.length} worktree${log.removed.length === 1 ? '' : 's'} of dismissed minions and leftover Grunts, ${size(log.bytes)} freed (branches kept; a reopen brings a minion's back):` : '',
          ...log.removed.map((r) => `- ${r}`),
          log.kept.length ? 'Kept:' : '',
          ...log.kept.map((k) => `- ${k}`),
        ].filter(Boolean).join('\n');
        console.log(`${p.name}: ${text}`);
        const coordinator = this.store.getOverlord(p.id);
        if (coordinator) this.emit(coordinator.id, 'note', { text, everyone: true });
      }
    } finally {
      this.sweepingWorktrees = false;
    }
    return done;
  }

  /**
   * The scheme's Grunt worktrees that no turn can be using: made over GRUNT_AGE_MS ago, and every turn of the
   * scheme running now started after it was made (a Grunt lives inside its turn's claude process).
   */
  private async sweepGrunts(p: Project, now: number, grunts: Worktree[], keep: (what: string, why: string) => void, removed: (what: string, bytes: number, extra?: string) => void) {
    const top = projectDir(this.dataDir, p.id) + '/';
    for (const g of grunts) {
      if (!g.path.startsWith(top)) continue;
      const made = await madeAt(g.path);
      if (made === null || made > now - GRUNT_AGE_MS) continue;
      const inUse = [...this.turns].some(([id, turn]) => this.store.getTicket(id)?.project_id === p.id && turn.startedAt <= made);
      if (inUse) continue;
      const name = g.path.slice(g.path.lastIndexOf('/') + 1);
      const what = `Grunt ${name} (${relative(projectDir(this.dataDir, p.id), g.path)})`;
      if (g.locked) {
        keep(what, 'locked');
        continue;
      }
      try {
        const ref = savedRef(`grunt/${name}`);
        const s = await saveWork(g.path, ref, g.branch, `Citadel: Grunt ${name}'s work not on its branch, saved before its worktree was removed`);
        if ('kept' in s) {
          keep(what, s.kept);
          continue;
        }
        removed(what, await removeWorktree(p.repo_dir!, g.path), s.saved ? `, its uncommitted work saved in ${ref}` : '');
      } catch (err: any) {
        keep(what, `could not remove: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
      }
    }
  }

  /**
   * The boot sweep's copy of an idle minion's session into the database (nothing pruned): on its lane,
   * so a turn that a message starts meanwhile waits for it. Null when the lane is busy (a turn runs).
   */
  saveIdleSession(ticketId: number, configDir: string): Promise<void> | null {
    if (this.lanes.busy(ticketId)) return null;
    return this.lanes.run(ticketId, 'session sweep', () => {
      const ticket = this.store.getTicket(ticketId);
      const project = ticket && this.store.getProject(ticket.project_id);
      if (ticket?.session_id && project) return this.saveSession(this.store, ticket, project, configDir, null);
    });
  }

  /**
   * A deploy this minion queued is live (tools/deploy.sh reported ok). A minion waiting on it in state
   * pending-deploy is dismissed, unless something is still open: a question card, a failed last turn,
   * or a person who wrote to it since it went into pending-deploy.
   * Mid-turn or with messages queued (approval cards only exist mid-turn), it waits for the last of
   * those turns to end. Returns whether it was dismissed.
   */
  deployLive(ticketId: number): boolean {
    if (this.isRunning(ticketId) || this.queued(ticketId)) {
      this.deployedMidTurn.add(ticketId);
      if (this.isRunning(ticketId)) this.saveTurn(ticketId, { deployed: true });
      return false;
    }
    const t = this.store.getTicket(ticketId);
    // shortcut: also takes the interim "outside" + "pending deploy" note, for minions that deployed before this state existed; drop it once none are left.
    const pending = t?.state === 'pending-deploy' || (t?.state === 'outside' && /pending deploy/i.test(t.note ?? ''));
    if (!t || t.status === 'closed' || t.status === 'error' || !pending) return false;
    if (this.store.getSetting(talkedKey(ticketId))) {
      this.store.deleteSetting(talkedKey(ticketId));
      this.store.updateTicket(ticketId, { state: null });
      this.broadcastTicket(ticketId);
      this.emit(ticketId, 'note', { text: 'The deploy is live, but someone wrote to this minion after it deployed, so it stays open.' });
      return false;
    }
    if (this.store.openCards(t.project_id).some((e) => e.ticket_id === ticketId && e.kind === 'question')) {
      this.emit(ticketId, 'note', { text: 'The deploy is live, but a question card is still open, so this minion stays open.' });
      return false;
    }
    this.store.updateTicket(ticketId, { state: null });
    this.close(ticketId, 'The deploy is live, so it dismissed this minion.');
    return true;
  }

  /** A person wrote to this minion (a message, a comment or a card answer). */
  personWrote(ticketId: number) {
    if (this.store.getTicket(ticketId)?.state === 'pending-deploy') this.store.setSetting(talkedKey(ticketId), true);
  }

  /** The minion went into pending-deploy: a new deploy to wait on, so earlier talk no longer counts. */
  deployPending(ticketId: number) {
    this.store.deleteSetting(talkedKey(ticketId));
  }

  /**
   * Why close_self must leave this minion open for people, or null: a question, plan or approval card still
   * waiting on them, or a state (try, ready, complete) that tells them something is theirs to do. The deploy's
   * own dismissal (deployLive) has its own checks. `atCall`, for close_self's own answer: the card
   * reason carries the card's link, and ready doesn't count, since a finished minion sets it by habit
   * before close_self (closeAfterTurn clears it, #480). At the turn end it does count: a ready set
   * after close_self is the minion changing its mind.
   */
  keptOpen(ticketId: number, atCall = false): string | null {
    if (this.store.openCardAt(ticketId) !== null || this.approvals.waiting(ticketId)) {
      const card = atCall && this.cardLinks(this.store.getTicket(ticketId)!)[0];
      return card ? `${card.kind === 'approval' ? 'an' : 'a'} ${cardText(card)} is still waiting on people` : 'a question, plan or approval card is still waiting on people';
    }
    const state = this.store.getTicket(ticketId)?.state;
    if (state === 'try' || (state === 'ready' && !atCall)) return `its state is ${state}, which tells people something is waiting for them`;
    // Complete is finished work kept open on purpose (#547): a report to read, or a person's close.
    if (state === 'complete') return 'its state is complete: it closes once a member has seen it';
    return null;
  }

  /**
   * Close a running ticket once its current turn finishes cleanly. A turn that fails or is
   * stopped, or a message that arrives during it, leaves the ticket open instead. A state ready
   * is cleared here (keptOpen's atCall).
   */
  closeAfterTurn(ticketId: number, reason: string | null): boolean {
    if (!this.isRunning(ticketId) || this.keptOpen(ticketId, true)) return false;
    if (this.store.getTicket(ticketId)?.state === 'ready') this.store.updateTicket(ticketId, { state: null });
    this.closing.set(ticketId, reason);
    this.saveTurn(ticketId, { closing: reason });
    this.broadcastTicket(ticketId);
    return true;
  }

  /**
   * Close a finished minion once a member has read it (#811): its state is complete, no turn is running or queued,
   * no card waits, and `name` had it open at its latest update (seen_at is at least updated_at, the sidebar's own
   * isSeen). Called when they leave it, so nobody is closed out from under their reading. Try, ready and by-hand
   * work are never complete, so they stay open. A message to the closed minion reopens it as before.
   */
  closeIfSeen(ticketId: number, name: string): boolean {
    const t = this.store.getTicket(ticketId);
    if (!t || t.state !== 'complete' || t.status === 'closed' || t.status === 'running' || this.isRunning(ticketId)) return false;
    if (this.queues.get(ticketId)?.length || this.store.openCardAt(ticketId) !== null || this.approvals.waiting(ticketId)) return false;
    if (this.store.seenAt(name, ticketId) < t.updated_at) return false;
    void this.close(ticketId, `Closed: ${name} saw its result`);
    return true;
  }

  /**
   * A state set after close_self that keeps the minion open (complete, try, ready) cancels the pending close
   * there and then (#604), so the view and the state tool's reply stop promising a dismissal the turn end
   * would refuse. Returns why it was cancelled, or null when nothing was. `byOther`: a person (not the
   * minion's own state call, whose reply says so) set it, so the next turn is told (#619).
   */
  closeCancelled(ticketId: number, byOther = false): string | null {
    if (!this.closing.has(ticketId)) return null;
    const kept = this.keptOpen(ticketId);
    if (!kept?.startsWith('its state')) return null;
    this.closing.delete(ticketId);
    const { closing: _, ...turn } = this.store.getSetting<TurnState>(turnKey(ticketId)) ?? { resumes: 0 };
    this.store.setSetting(turnKey(ticketId), turn);
    this.emit(ticketId, 'note', { text: `Claude's close_self was cancelled: ${kept}, so it stays open.` });
    if (byOther) this.store.setSetting(closeCancelledKey(ticketId), kept);
    this.broadcastTicket(ticketId);
    return kept;
  }

  /**
   * After a server restart: re-attach to turns still running in their units (or that ended while the
   * server was down), and catch up on their output. Turns whose process died too were cut off: mark
   * them, and resume them a few seconds apart unless they were stopped, set to close, or already
   * resumed MAX_RESUMES times in a row. Messages queued behind a cut-off turn go into its resume (or,
   * for one not resumed, into a turn of their own). A turn that failed (the usage limit included)
   * ended before the restart, so it isn't 'running'.
   */
  recover() {
    const later: (() => void)[] = [];
    for (const p of this.store.listProjects()) {
      for (const t of this.store.listTickets(p.id)) {
        // A keepalive cut off by a restart (#862) is dropped, not resumed: the next sweep sends another if it is still due.
        // What waited behind it waits for the save below, or starts a turn.
        const kept = t.status !== 'running' ? this.store.getSetting<TurnState>(turnKey(t.id)) : null;
        if (kept?.keepalive) {
          this.store.deleteSetting(turnKey(t.id));
          // Its unit outlives the server; killed first (pid.json is in its folder) so it can't race the next real turn on the session.
          if (kept.dir) this.signal({ dir: kept.dir, unit: kept.unit ?? null, container: kept.container ?? null }, 'SIGKILL');
          if (kept.dir) rmSync(kept.dir, { recursive: true, force: true });
          if (kept.queued?.length) this.store.setSetting(waitingKey(t.id), [...(this.store.getSetting<QueuedMessage[]>(waitingKey(t.id)) ?? []), ...kept.queued]);
        }
        // A save the last server didn't finish: redone first on the lane, from the config dir its turn used.
        const saving = this.store.getSetting<{ configDir: string }>(savingKey(t.id));
        if (saving) this.lanes.run(t.id, 'session save cut off by a restart', () => this.saveAfterTurn(t.id, saving.configDir, null));
        // Messages that waited for that save start a turn once it is in.
        const waiting = this.store.getSetting<QueuedMessage[]>(waitingKey(t.id));
        if (waiting?.length && t.status !== 'running') {
          this.queues.set(t.id, [...waiting]);
          later.push(() => this.next(t.id));
        }
        const owed = t.status !== 'running' ? this.store.getSetting<{ resumes: number; queued?: QueuedMessage[] }>(owedKey(t.id)) : null;
        if (owed) {
          if (owed.queued?.length) this.queues.set(t.id, [...owed.queued]);
          later.push(() => this.resume(t.id, owed.resumes));
        }
        if (t.status === 'running') {
          const turn = this.store.getSetting<TurnState>(turnKey(t.id));
          // This turn's waiting cards come back: if it is still running, it still polls for them (#209).
          this.approvals.restore(t.id, this.store.eventsOfKinds(t.id, ['approval', 'approval_result']), turn?.startedAt);
          try {
            if (turn?.dir && this.reattach(t.id, turn)) continue;
          } catch (err: any) {
            console.error(`Ticket ${t.id}: could not re-attach to its turn, so it counts as interrupted:`, err);
          }
          // Its turn is gone, so nobody's click can count for them now.
          this.approvals.endTurn(t.id, 'The server restarted while this waited.');
          this.store.deleteSetting(turnKey(t.id));
          const unsent = turn ? unsentSteers(turn) : [];
          if (turn?.dir) rmSync(turn.dir, { recursive: true, force: true });
          this.setStatus(t.id, 'idle');
          // Stopped on purpose: it already says so, and no resume. What was queued before the stop went with it;
          // what came after waits for a turn of its own.
          if (turn?.stopped) {
            if (turn.queued?.length) {
              this.queues.set(t.id, [...turn.queued]);
              this.store.setSetting(waitingKey(t.id), turn.queued);
              later.push(() => !this.isRunning(t.id) && this.next(t.id));
            }
            continue;
          }
          const queued = [...(turn?.queued ?? []), ...unsent];
          if (queued.length) this.queues.set(t.id, [...queued]);
          const resumes = turn?.resumes ?? 0;
          let skipped: string | null = null;
          if (turn && 'closing' in turn) skipped = 'It was set to be dismissed, so it was not resumed.';
          else if (resumes >= MAX_RESUMES) skipped = `It was not resumed: it had already been resumed ${resumes} times in a row.`;
          if (skipped) {
            this.emit(t.id, 'note', { text: `The server restarted during this turn, so it was interrupted. ${skipped}` });
            if (queued.length) {
              this.store.setSetting(waitingKey(t.id), queued);
              later.push(() => !this.isRunning(t.id) && this.next(t.id));
            }
          } else {
            this.store.setSetting(owedKey(t.id), { resumes: resumes + 1, ...(queued.length ? { queued } : {}) });
            later.push(() => this.resume(t.id, resumes + 1));
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
    // Minions waiting on the usage limit keep waiting, with the messages held for them.
    for (const w of this.limitResumes()) if (w.queued?.length) this.queues.set(w.ticket, [...w.queued]);
    this.armLimitTimer();
    // Threads waiting on the network keep waiting: the probe starts over (#366).
    this.armNetProbe();
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
      const gone = (dir: string) => wrapperAlive(dir) === false || (wrapperAlive(dir) === null && Date.now() - statSync(dir).mtimeMs > START_GRACE_MS);
      for (const dir of dirs) if (!followed.has(dir) && gone(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // No turns yet.
    }
    // Temp folders of minions dismissed or deleted while no server watched (or whose clearing failed).
    try {
      const gone = readdirSync(join(this.dataDir, 'projects')).filter((name) => /^\d+$/.test(name)).flatMap((name) => {
        // Removed only on proof: the minion was dismissed, or its folder sits in another scheme's root. A
        // minion the database doesn't know (a restored backup, say) keeps its folder (#259).
        const keep = (id: number) => {
          const t = this.store.getTicket(id);
          return !t || this.turns.has(id) || this.lanes.busy(id) || (t.project_id === Number(name) && t.status !== 'closed');
        };
        return sweepTmpDirs(this.tmpRoot(Number(name)), keep);
      });
      if (gone.length) console.log(`Cleared the temp folders of ${gone.length} dismissed or deleted minion${gone.length === 1 ? '' : 's'}.`);
    } catch (err: any) {
      if (err.code !== 'ENOENT') console.error(`Could not sweep the temp folders: ${err.message}`);
    }
  }

  /** Follow a turn a previous server started, if it still runs or ended while no server watched it. */
  private reattach(ticketId: number, turn: TurnState): boolean {
    const live = this.follow(ticketId, turn);
    if (this.gone(live)) {
      clearInterval(live.timer);
      this.turns.delete(ticketId);
      return false;
    }
    if (turn.queued?.length) this.queues.set(ticketId, turn.queued);
    if ('closing' in turn) this.closing.set(ticketId, turn.closing ?? null);
    if (turn.deployed) this.deployedMidTurn.add(ticketId);
    this.lanes.run(ticketId, 're-attached turn', () => live.ended);
    console.log(`Ticket ${ticketId}: re-attached to its running turn${live.unit ? ` in ${live.unit}` : ''}.`);
    return true;
  }

  /** Whether a followed turn's process may still be running: started, or still starting. */
  private running(live: LiveTurn): boolean {
    return wrapperAlive(live.dir) ?? Date.now() - live.startedAt < START_GRACE_MS;
  }

  /** A followed turn's process ended without writing exit.json. Liveness goes first: the wrapper writes exit.json, then exits. */
  private gone(live: LiveTurn): boolean {
    return !this.running(live) && !existsSync(join(live.dir, 'exit.json'));
  }

  /**
   * Start an auto-resume turn, after a restart or (limitTries > 0) the usage limit, with any messages
   * that were queued behind the cut-off one.
   */
  private resume(ticketId: number, resumes: number, limitTries = 0, onCodex = false, netTries = 0, onAccount = false) {
    // Someone's message got in first; its turn took the queue, and that is resume enough.
    if (this.isRunning(ticketId)) return;
    // After the last turn's save, if that is still under way: no turn here starts before it is in (#259).
    this.lanes.run(ticketId, 'resume', () => this.afterRestore(ticketId, (ticket, project) => ticket.person_id ?? this.turnPerson(ticket, project, this.peekQueue(ticketId)), () => {
      const ticket = this.store.getTicket(ticketId);
      const project = ticket && this.store.getProject(ticket.project_id);
      if (!ticket || !project || ticket.status === 'closed') return this.store.deleteSetting(owedKey(ticketId));
      // A network resume needs its wait still there: a person's message, a stop or an earlier resume took it.
      if (netTries && !this.netWait(ticketId)) return;
      const person = ticket.person_id ?? this.turnPerson(ticket, project, this.peekQueue(ticketId));
      if (this.refused(ticketId, person)) {
        // Nothing it would have carried is dropped: the queue, held mail and a network wait wait for the next turn (#468 S03-6).
        const q = this.queues.get(ticketId);
        if (q?.length) this.store.setSetting(waitingKey(ticketId), q);
        this.store.deleteSetting(owedKey(ticketId));
        return;
      }
      // An account switch's note went with the turn that stopped (switchAccount).
      if (!onAccount) this.emit(ticketId, 'note', { text: onCodex ? 'Resumed on Codex: its person switched to Codex' : limitTries ? 'Resumed after the usage limit reset' : netTries ? 'Resumed after a network outage' : 'Resumed after a server restart' });
      // It carries on the interrupted turn, so it runs for that turn's person.
      return this.startTurn(project, ticket, [{ author: 'System', text: onCodex ? RESUME_CODEX_PROMPT : onAccount ? RESUME_ACCOUNT_PROMPT : limitTries ? RESUME_LIMIT_PROMPT : netTries ? RESUME_NET_PROMPT : RESUME_PROMPT, images: [] }, ...this.takeQueue(ticketId)], person, resumes, limitTries, netTries);
    }));
  }

  /**
   * Run a lane's turn step once the minion's stored session is back in the config dir its turn will use
   * (restoreAhead: on a worker thread, as a 60 MB transcript held the event loop for seconds, #612). With nothing
   * to restore, as on most turns, the step runs at once, so a turn still counts as running as soon as it starts.
   * startTurn's own restore stays: it finds the files in place, and retries and reports a restore that failed here.
   * `person` guesses whose turn it is; a wrong guess only leaves the work to startTurn's restore. `keepQueue`
   * saves the queue while it waits, as next() does behind a busy lane (a resume's is in its owed record).
   */
  private afterRestore(ticketId: number, person: (ticket: Ticket, project: Project) => number | null, step: () => unknown, keepQueue = false): unknown {
    let ahead: Promise<number> | null = null;
    try {
      const ticket = this.noTurns ? undefined : this.store.getTicket(ticketId);
      const project = ticket && this.store.getProject(ticket.project_id);
      // Nothing stored, nothing to restore: no need to ask whose Claude it runs on.
      if (ticket && project && ticket.status !== 'closed' && (this.store.listClaudeState(project.id, ticket.id).length || this.store.listClaudeState(project.id, null).length)) {
        const place = this.placeFor?.(person(ticket, project), warmKey(ticket)) ?? { host: true as const };
        if (!('refused' in place)) ahead = restoreAhead(this.store, ticket, project, place.host ? place.configDir ?? claudeConfigDir(process.env) : place.configDir);
      }
    } catch (err: any) {
      // The turn's start meets the same trouble itself, and says so.
      console.error(`Ticket ${ticketId}: could not check its session files before the turn: ${err.message}`);
    }
    if (!ahead) return step();
    // No turn record holds the queue until the turn starts: a restart meanwhile starts it from here, as after a save.
    const q = this.queues.get(ticketId);
    if (keepQueue && q?.length) this.store.setSetting(waitingKey(ticketId), q);
    return ahead.then(
      (n) => n && console.log(`Ticket ${ticketId}: restored the Claude session from the database off the event loop (${n} file${n === 1 ? '' : 's'}).`),
      (err) => console.error(`Ticket ${ticketId}: restoring the session off the event loop failed, so the turn's start tries again: ${err.message}`),
    ).then(() => {
      if (this.store.getTicket(ticketId)?.status !== 'closed') return step();
      // Dismissed meanwhile, which a running turn would have refused: no turn, now or once the lane is free.
      this.queues.delete(ticketId);
      this.store.deleteSetting(waitingKey(ticketId));
    });
  }

  /** What takeQueue would take, left where it is. */
  private peekQueue(ticketId: number): QueuedMessage[] {
    return [...(this.netWait(ticketId)?.queued ?? []), ...(this.queues.get(ticketId) ?? []), ...(this.store.getSetting<QueuedMessage[]>(mailKey(ticketId)) ?? [])];
  }

  /** Whether `person`'s Claude can't run a turn now (Runner.placeFor); the chat says why. Asked before the queue is taken. */
  private refused(ticketId: number, person: number | null): boolean {
    const place = this.noTurns ? null : this.placeFor?.(person);
    if (!place || !('refused' in place)) return false;
    this.emit(ticketId, 'note', { text: place.refused });
    this.broadcastTicket(ticketId);
    return true;
  }

  /** Everything queued for the minion's next turn, which starts now: a network wait's held messages first, as that wait ends. */
  private takeQueue(ticketId: number): QueuedMessage[] {
    this.store.deleteSetting(waitingKey(ticketId));
    this.store.deleteSetting(owedKey(ticketId));
    const held = this.cancelNetWait(ticketId)?.queued ?? [];
    // Held mail rides along after what woke the turn, so the turn is still that message's.
    const mail = this.store.getSetting<QueuedMessage[]>(mailKey(ticketId)) ?? [];
    if (mail.length) this.store.deleteSetting(mailKey(ticketId));
    this.store.deleteSetting(coldKey(ticketId));
    return [...held, ...(this.queues.get(ticketId)?.splice(0) ?? []), ...mail];
  }

  private netResumes(): NetResume[] {
    return this.store.getSetting<NetResume[]>(NET_RESUMES) ?? [];
  }

  /** The thread's network wait, if it has one. */
  netWait(ticketId: number): NetResume | null {
    return this.netResumes().find((w) => w.ticket === ticketId) ?? null;
  }

  /** Wait for the network, holding the messages queued behind the turn that died; one probe loop serves every waiting thread. */
  private waitForNetwork(ticketId: number, tries: number) {
    const list = this.netResumes().filter((w) => w.ticket !== ticketId);
    const queued = this.queues.get(ticketId)?.splice(0);
    list.push({ ticket: ticketId, tries, ...(queued?.length ? { queued } : {}) });
    this.store.setSetting(NET_RESUMES, list);
    this.armNetProbe();
  }

  /** End the thread's network wait (a resume, a person's message, a stop, a dismissal); returns the wait it had. */
  private cancelNetWait(ticketId: number): NetResume | null {
    const list = this.netResumes();
    const w = list.find((x) => x.ticket === ticketId);
    if (!w) return null;
    const rest = list.filter((x) => x !== w);
    if (rest.length) this.store.setSetting(NET_RESUMES, rest);
    else this.store.deleteSetting(NET_RESUMES);
    return w;
  }

  /** Probe after netDelay, unless a probe is already due or under way, or nobody waits. */
  private armNetProbe() {
    if (this.netTimer || !this.netResumes().length) return;
    this.netTimer = setTimeout(() => this.probeNet(), this.netDelay ?? this.netProbeMs);
    this.netTimer.unref();
  }

  /** Still down: wait twice as long, up to netProbeMaxMs. Back: resume every waiting thread, resumeGapMs apart. */
  private async probeNet() {
    let up = false;
    try {
      up = await this.netProbe();
    } catch {
      // A probe that throws is a probe that failed.
    }
    this.netTimer = undefined;
    const waiting = this.netResumes();
    if (!up && waiting.length) {
      this.netDelay = Math.min((this.netDelay ?? this.netProbeMs) * 2, this.netProbeMaxMs);
      return this.armNetProbe();
    }
    this.netDelay = null;
    // Each keeps its place in the list until its own resume's turn starts, so a restart mid-stagger loses none.
    waiting.forEach((w, i) => setTimeout(() => this.netResume(w.ticket), this.resumeGapMs * i).unref());
  }

  /** The wait stays saved until the resume's turn takes it (takeQueue), so a restart during the last turn's save still resumes. */
  private netResume(ticketId: number) {
    const w = this.netWait(ticketId);
    if (w) this.resume(ticketId, 0, 0, false, w.tries);
  }

  private limitResumes(): LimitResume[] {
    return this.store.getSetting<LimitResume[]>(LIMIT_RESUMES) ?? [];
  }

  /** The minion's usage-limit wait, if it has one. */
  limitWait(ticketId: number): LimitResume | null {
    return this.limitResumes().find((w) => w.ticket === ticketId) ?? null;
  }

  private saveLimitResumes(list: LimitResume[]) {
    if (list.length) this.store.setSetting(LIMIT_RESUMES, list);
    else this.store.deleteSetting(LIMIT_RESUMES);
    this.armLimitTimer();
  }

  /** Wait for the limit to reset, a while after `resetAt` and spaced from the minions already waiting; returns when it resumes. */
  private waitForLimit(ticketId: number, resetAt: number, tries: number, accounts?: LimitedAccount[]): number {
    const list = this.limitResumes().filter((w) => w.ticket !== ticketId);
    let at = resetAt + this.limitDelayMs;
    for (const w of [...list].sort((a, b) => a.at - b.at)) if (Math.abs(w.at - at) < this.limitGapMs) at = w.at + this.limitGapMs;
    const queued = this.queues.get(ticketId);
    list.push({ ticket: ticketId, at, tries, ...(queued?.length ? { queued } : {}), ...(accounts?.length ? { accounts } : {}) });
    this.saveLimitResumes(list);
    return at;
  }

  /** Stop waiting on the usage limit (a stop, a dismissal); true if it was waiting. */
  cancelLimitWait(ticketId: number): boolean {
    const list = this.limitResumes();
    if (!list.some((w) => w.ticket === ticketId)) return false;
    this.saveLimitResumes(list.filter((w) => w.ticket !== ticketId));
    return true;
  }

  /** Hold the minion's queued messages for its usage-limit resume, if it waits for one. */
  private holdForLimit(ticketId: number): boolean {
    const list = this.limitResumes();
    const w = list.find((x) => x.ticket === ticketId);
    if (!w) return false;
    w.queued = [...(this.queues.get(ticketId) ?? [])];
    this.store.setSetting(LIMIT_RESUMES, list);
    return true;
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
    const list = this.limitResumes();
    const gaveUp = this.store.limitedTickets().filter((t) => t.status === 'error' && t.note?.startsWith('Usage limit: gave up') && !list.some((w) => w.ticket === t.id) && !this.isRunning(t.id));
    if (!list.length && !gaveUp.length) return;
    const onPlan = (id: number) => {
      const t = this.store.getTicket(id);
      const project = t && this.store.getProject(t.project_id);
      if (!t || !project) return false;
      const person = t.person_id ?? project.owner_id;
      const its = turnSettings(t, project).model;
      const codex = isCodexModel(its) || (person !== null && !!this.store.getSetting<boolean>(codexSwitchKey(person)));
      return !codex && this.payerOf(person) === payer && (model === undefined || its === model);
    };
    const now = Date.now();
    const early = list.filter((w) => w.at > now && !w.codex && onPlan(w.ticket));
    for (const w of early) { w.at = now; w.proven = true; }
    const back = gaveUp.filter((t) => onPlan(t.id)).map((t) => ({ ticket: t.id, at: now, tries: 1, proven: true as const }));
    if (early.length || back.length) this.saveLimitResumes([...list, ...back]);
  }

  /** Time the next usage-limit resume: the earliest due, and never sooner than a gap after the last (limitGapMs, or limitProvenGapMs for waits a turn getting through released). */
  private armLimitTimer() {
    clearTimeout(this.limitTimer);
    const list = this.limitResumes();
    if (!list.length) return;
    const due = nextLimitResume(list, this.lastLimitResume, this.limitGapMs, this.limitProvenGapMs)!.due;
    // setTimeout overflows past 24.8 days; a weekly limit is at most 7.
    this.limitTimer = setTimeout(() => this.limitResumeNext(), Math.min(Math.max(0, due - Date.now()), 2 ** 31 - 1));
    this.limitTimer.unref();
  }

  private limitResumeNext() {
    const list = this.limitResumes();
    const next = nextLimitResume(list, this.lastLimitResume, this.limitGapMs, this.limitProvenGapMs);
    const w = next?.wait;
    if (!w || next.due > Date.now()) return this.armLimitTimer();
    this.lastLimitResume = Date.now();
    this.saveLimitResumes(list.filter((x) => x !== w));
    // No turn runs while it waits: starting one ends the wait (startTurn).
    this.resume(w.ticket, 0, w.tries, !!w.codex);
  }

  /** Merge into the saved state of a ticket's running turn. */
  private saveTurn(ticketId: number, patch: Partial<TurnState>) {
    const turn = this.store.getSetting<TurnState>(turnKey(ticketId)) ?? { resumes: 0 };
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
   * `hold` (#718): a message from a person, the Taskmaster or another minion, which a parked minion with no turn
   * running keeps for its next turn instead of starting one ('parked'). Wakes (wake_when_live, a chained start,
   * runners back, a card's answer, GitHub) leave it off and start a turn as before.
   */
  send(ticketId: number, author: string, text: string, images: MessageImage[] = [], extra: { comment?: { about: string }; from?: number; typed?: boolean; asker?: number | null; fyi?: boolean; light?: boolean; hold?: boolean } & object = {}, steer = false, files: MessageFile[] = []): 'parked' | void {
    // Whose ask it is, when that isn't its author's or relay's now: a contraption's person, or a held relay's asker.
    const { asker: askedBy, fyi, light, hold, ...shown } = extra;
    extra = shown;
    if (!fyi) this.onMessage?.(ticketId);
    const ticket = this.store.getTicket(ticketId);
    const refused = ticket && this.refuseTurn?.(ticket, author, extra.from);
    if (refused) {
      this.emit(ticketId, 'user_message', { author, text: hideTokens(text), ...(images.length ? { images: images.map((i) => i.name) } : {}), ...extra });
      this.emit(ticketId, 'note', { text: refused });
      return;
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
    const steers = !!(steer && live && turn && !turn.result && !turn.fresh && !turn.keepalive && !turn.stopped && !otherPerson && !(turn.light && !light) && existsSync(join(live.dir, 'steer.jsonl')));
    const parked = !!(hold && !live && ticket && this.parked(ticket));
    // The chat shows it masked; the turn still gets it as typed, for a key someone hands over on purpose.
    const row = this.emit(ticketId, 'user_message', {
      author, text: hideTokens(text), ...(images.length ? { images: images.map((i) => i.name) } : {}),
      ...(files.length ? { files: files.map(({ name, size, type }) => ({ name, size, type })) } : {}), ...extra, ...(steers ? { steered: true } : {}), ...(parked ? { mail: true, parked: true } : {}),
    });
    const msg: QueuedMessage = { author, text, images, ...(files.length ? { files } : {}), about: extra.comment?.about, id: row.id, ...(extra.from ? { from: extra.from } : {}), ...(extra.typed ? { typed: true } : {}), ...(extra.typed || 'answer' in extra ? { own: true } : {}), ...(fyi ? { fyi: true } : {}), ...(light ? { light: true as const } : {}), asker };
    // A person's typed "merge it" stands for the whole scheme until its PR merges (#260), whenever a turn reads it.
    // In the Taskmaster chat "#N" names minion N (#939).
    if (ticket) this.approvals.said(ticket.project_id, { id: ticket.id, number: ticket.number, branch: ticket.branch }, msg, (n) => {
      const m = this.store.getTicketByNumber(ticket.project_id, n);
      return m ? { id: m.id, number: m.number, branch: m.branch } : null;
    });
    // Anything said answers the one-tap replies; a steer or a held message starts no turn to clear them.
    if (this.store.getTicket(ticketId)?.replies) {
      this.store.updateTicket(ticketId, { replies: null });
      this.broadcastTicket(ticketId);
    }
    if (parked) {
      // With the held mail, in order: whatever next wakes it (Unpark, a wake, its chained start) reads it after its own message.
      const list = this.store.getSetting<QueuedMessage[]>(mailKey(ticketId)) ?? [];
      list.push({ ...msg, parked: new Date(this.now()).toISOString().slice(0, 16).replace('T', ' ') });
      this.store.setSetting(mailKey(ticketId), list);
      this.broadcastTicket(ticketId);
      return 'parked';
    }
    if (steers) {
      const line = promptMessage([msg]);
      const file = join(live!.dir, 'steer.jsonl');
      appendFileSync(file, line);
      // A typed steer is a message the turn now answers too; a second person's leaves it no one's (#268).
      const typedBy = msg.typed && person && !extra.from ? (turn!.typedBy == null || turn!.typedBy === person ? person : 0) : turn!.typedBy;
      this.saveTurn(ticketId, { steered: [...(turn!.steered ?? []), { end: statSync(file).size, msg }], typedBy });
      // A person steering in speaks after the relay, so what the turn starts now is theirs.
      if (person && !extra.from) this.turnFrom.delete(ticketId);
      return;
    }
    const q = this.queues.get(ticketId) ?? [];
    const limited = !!(ticket && this.limitWait(ticketId));
    // Waiting on its payer's usage limit, a message on another plan carries on now (sender pays): first, so the turn is its sender's.
    const otherPlan = !!(person && limited && this.payerOf(person) !== this.payerOf(ticket!.person_id ?? this.store.getProject(ticket!.project_id)?.owner_id));
    if (otherPlan) q.unshift(msg);
    else q.push(msg);
    // A person's own message tries now too: the reset time is only Claude's word, and a reset can come sooner. Still limited, it waits again (#477).
    if (otherPlan || (limited && person && !extra.from)) this.cancelLimitWait(ticketId);
    this.queues.set(ticketId, q);
    if (!this.isRunning(ticketId)) {
      this.next(ticketId);
      const wait = this.limitWait(ticketId);
      if (wait) {
        this.emit(ticketId, 'note', { text: `Held for the resume at ${clockTime(wait.at)}, after the usage limit resets.` });
        this.broadcastTicket(ticketId);
      }
      return;
    }
    this.saveTurn(ticketId, { queued: q });
    this.broadcastTicket(ticketId);
  }

  /** Take back a message still queued for the next turn; false once it has gone to Claude. */
  unqueue(ticketId: number, eventId: number, by: string): boolean {
    const q = this.queues.get(ticketId);
    const i = q?.findIndex((m) => m.id === eventId) ?? -1;
    if (i < 0) return this.unqueueHeld(ticketId, eventId, by);
    q!.splice(i, 1);
    const projectId = this.store.getTicket(ticketId)?.project_id;
    if (projectId !== undefined) this.approvals.unsaid(projectId, eventId);
    if (this.isRunning(ticketId)) this.saveTurn(ticketId, { queued: q });
    else if (!this.holdForLimit(ticketId) && this.store.getSetting(waitingKey(ticketId))) this.store.setSetting(waitingKey(ticketId), q);
    this.emit(ticketId, 'unqueued', { id: eventId, by });
    this.broadcastTicket(ticketId);
    return true;
  }

  /** Take back a message a network wait holds for its resume (#468 S03-9). */
  private unqueueHeld(ticketId: number, eventId: number, by: string): boolean {
    const list = this.netResumes();
    const w = list.find((x) => x.ticket === ticketId);
    const i = w?.queued?.findIndex((m) => m.id === eventId) ?? -1;
    if (i < 0) return false;
    w!.queued!.splice(i, 1);
    if (!w!.queued!.length) delete w!.queued;
    this.store.setSetting(NET_RESUMES, list);
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

  /**
   * Cold (#413): the session has a prompt cache to lose (a session, no turn running, waiting or queued)
   * and its last turn ended over COLD_MS ago, so waking it re-writes its whole context. A dismissed
   * minion never is: a message to one is follow-up work, which reopens it as before.
   */
  cold(ticketId: number): boolean {
    const t = this.store.getTicket(ticketId);
    if (!t?.session_id || t.status === 'closed' || this.isRunning(ticketId) || this.queued(ticketId) || this.lanes.busy(ticketId) || this.limitWait(ticketId) || this.netWait(ticketId)) return false;
    const ended = this.store.lastTurnEnd(ticketId);
    return !!ended && this.now() - ended > COLD_MS;
  }

  /** Parked (#718): on hold on purpose (state parked) or waiting on start_after, and not dismissed. A message to it is held. */
  parked(t: Ticket): boolean {
    return t.kind !== 'coordinator' && t.status !== 'closed' && (t.state === 'parked' || !!this.heldFor(t.id));
  }

  /** Messages held for this minion's next turn (#718's parked ones and held mail). */
  heldCount(ticketId: number): number {
    return this.store.getSetting<QueuedMessage[]>(mailKey(ticketId))?.length ?? 0;
  }

  /**
   * Unpark a minion in state parked (#718): the state clears now, and unless `quiet` (a message wakes it instead) a
   * turn starts that reads what was held for it, with a message from `author` (a person's name runs it as them, as a
   * card's answer does). A chained minion starts with its brief instead (routes/tickets.ts unparkTicket). False when
   * it isn't in state parked.
   */
  unpark(ticketId: number, by: string, author: string, quiet = false): boolean {
    const t = this.store.getTicket(ticketId);
    if (!t || t.kind === 'coordinator' || t.status === 'closed' || t.state !== 'parked') return false;
    this.store.updateTicket(ticketId, { state: null });
    this.emit(ticketId, 'note', { text: `${by} unparked this minion.` });
    this.broadcastTicket(ticketId);
    if (quiet || this.isRunning(ticketId)) return true;
    const n = this.heldCount(ticketId);
    const held = n ? `${n === 1 ? 'The message' : `The ${n} messages`} left for you while you were parked ${n === 1 ? 'follows' : 'follow'}.` : 'Nothing was left for you while you were parked.';
    this.send(ticketId, author, `${author === by ? 'Unparked' : `${by} unparked`} you. ${held} Pick up where you left off.`);
    return true;
  }

  /**
   * Mail held for a cold session wakes it once the first has waited COLD_HOLD_MAX_MS, or at once if the
   * session went fresh meanwhile (nothing left to re-read), but never a dismissed minion. A person's
   * message takes it sooner. Run every minute.
   */
  coldSweep(now = this.now()) {
    if (this.noTurns) return;
    for (const p of this.store.listProjects()) {
      for (const t of this.store.listTickets(p.id)) {
        const since = this.store.getSetting<number>(coldKey(t.id));
        if (!since || (t.session_id && now - since < COLD_HOLD_MAX_MS)) continue;
        // A parked minion's mail waits for its unpark or wake, however long (#718).
        if (this.parked(t)) continue;
        if (this.isRunning(t.id) || this.lanes.busy(t.id)) continue;
        const mail = this.store.getSetting<QueuedMessage[]>(mailKey(t.id)) ?? [];
        this.store.deleteSetting(coldKey(t.id));
        // A dismissed minion isn't reopened by the cap: its mail waits for a person's message.
        if (!mail.length || t.status === 'closed') continue;
        // Nor while its Claude can't run a turn: the mail waits for the next one that can (#468 S03-6).
        if (this.refused(t.id, this.turnPerson(t, p, mail))) continue;
        this.store.deleteSetting(mailKey(t.id));
        this.emit(t.id, 'note', { text: t.session_id ? `Held mail has waited ${COLD_HOLD_MAX_MS / 3_600_000} hours, so it runs now.` : 'Held mail runs now: the session is fresh, so waking it is cheap.' });
        this.queues.set(t.id, [...(this.queues.get(t.id) ?? []), ...mail]);
        this.next(t.id);
      }
    }
  }

  /**
   * strike_text: thread `by` was proven wrong, so `quote` (its own words, verbatim) is struck through
   * where it shows: in the newest of its replies, or of its messages to another thread, that contains
   * it. A note with the reason goes in that chat, and in `by`'s own if that's another one.
   */
  strike(by: number, quote: string, reason: string): { ticketId: number } {
    const texts = (e: EventRow, data: any): string[] =>
      e.kind === 'claude' ? (data.type === 'assistant' ? (data.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text) : []) : [data.text ?? ''];
    let e: EventRow | undefined;
    let data: any;
    // Find it first: leaving the loop closes the read before anything is written.
    for (const w of this.store.wordsBy(by, STRIKE_SEARCH)) {
      data = JSON.parse(w.data);
      if (texts(w, data).some((t) => t.includes(quote))) {
        e = w;
        break;
      }
    }
    if (!e) throw new Error(`None of your newest ${STRIKE_SEARCH} replies or messages contains that text. Quote it exactly as you wrote it, Markdown and all, from a single message.`);
    const strikes: { text: string; reason: string; at: number }[] = data.strikes ?? [];
    if (strikes.some((s) => s.text === quote)) throw new Error('That text is struck through already');
    strikes.push({ text: quote, reason, at: this.now() });
    this.store.setEventData(e.id, { ...data, strikes });
    this.emit(e.ticket_id, 'strike', { event: e.id, strikes });
    // `strike` lets the chat draw the quote struck through; `chat` (another chat's note only) is where the message shows.
    const where = this.store.getTicket(e.ticket_id)!;
    const words = clip(quote.replace(/[*`~]/g, ''));
    for (const id of new Set([e.ticket_id, by])) {
      const chat = id === e.ticket_id ? null : { project: where.project_id, number: where.number };
      const place = chat ? ` in ${where.number == null ? `the ${AGENT_NAME}'s chat` : `#${where.number}`}` : '';
      this.emit(id, 'note', { text: `Struck through as wrong${place}: "${words}". ${reason}`, strike: { quote: words, reason, chat } });
    }
    return { ticketId: e.ticket_id };
  }

  /**
   * A person continued a minion paused by the loop guard, or wrote into its chat or its Taskmaster's:
   * the held messages go through in order and its count starts again. For a Taskmaster, the same for
   * each of its exchanges with other schemes' Taskmasters. Returns how many were held.
   */
  continueLoop(ticketId: number, by: string): number {
    const ticket = this.store.getTicket(ticketId);
    if (!ticket) return 0;
    const loops: { key: string; chats: number[]; pair?: true }[] = ticket.kind === 'coordinator'
      ? this.store.listProjects().flatMap((p) => this.store.listCoordinators(p.id)).filter((c) => c && c.id !== ticketId)
        .map((c) => ({ key: pairKey(ticketId, c!.id), chats: [ticketId, c!.id] }))
      : [{ key: loopKey(ticketId), chats: this.relays.loopChats(ticket) },
        // Its direct exchanges with the scheme's other minions (#783).
        ...this.store.settingKeys(MINION_PAIRS).map((key) => key.slice(MINION_PAIRS.length).split(':').map(Number)).filter((ids) => ids.includes(ticketId))
          .map(([a, b]) => ({ key: minionPairKey(a, b), chats: [ticketId, a === ticketId ? b : a], pair: true as const }))];
    let total = 0;
    for (const { key, chats, pair } of loops) {
      const loop = this.store.getSetting<LoopState>(key);
      if (!loop) continue;
      this.store.deleteSetting(key);
      const n = loop.held.length;
      if (!n) continue;
      const text = `${by} continued, so ${n === 1 ? 'the held message' : `the ${n} held messages`} went through.`;
      // A minion's note is keyed by the minion in both chats; a Taskmasters' or two minions' note by each chat's own.
      for (const id of chats) this.emit(id, 'loop_continued', { minion: ticket.kind === 'coordinator' || pair ? id : ticketId, by, text });
      // Only the Taskmaster's messages to its minion steer; Taskmasters' and minions' to each other queue.
      for (const m of loop.held) {
        if (pair) this.relays.copyToTaskmaster(m.to, m.author, m.text);
        // A minion dismissed since never reopens for another minion's message (#783): it waits as mail.
        if (m.mail || (pair && this.store.getTicket(m.to)?.status === 'closed')) this.relays.mail(m.to, m.author, m.text, m.from);
        else if (pair) this.send(m.to, m.author, m.text, [], { from: m.from, hold: true, ...(m.asker !== undefined ? { asker: m.asker } : {}) }, false);
        else this.send(m.to, m.author, m.text, [], { from: m.from, hold: true, ...(m.asker !== undefined ? { asker: m.asker } : {}) }, ticket.kind !== 'coordinator' && m.to === ticketId);
      }
      total += n;
    }
    return total;
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
    if (live.container) return { verdict: 'unknown', text: "This turn runs in a container, so the server can't look at its process." };
    let pid: number | null = null;
    try {
      pid = Number(JSON.parse(readFileSync(join(live.dir, 'pid.json'), 'utf8')).claude) || null;
    } catch { /* not started yet */ }
    return checkProcess(pid);
  }

  /** When the running turn started, or null: what a spend card names to act on its own turn only (#723). */
  turnStartedAt(ticketId: number): number | null {
    return this.turns.get(ticketId)?.startedAt ?? null;
  }

  stop(ticketId: number): boolean {
    const live = this.turns.get(ticketId);
    if (!live) {
      // Waiting on the network: a stop ends the wait, and as with a turn, its held messages go too.
      if (this.cancelNetWait(ticketId)) {
        this.setFailNote(ticketId, { note: 'Network outage: stopped, send a message to carry on' });
        this.emit(ticketId, 'note', { text: 'Stopped by user: it won\'t resume by itself.' });
        this.broadcastTicket(ticketId);
        return true;
      }
      // Waiting on the usage limit: a stop ends the wait, and as with a turn, its held messages go too.
      if (!this.cancelLimitWait(ticketId)) return false;
      this.queues.delete(ticketId);
      this.setFailNote(ticketId, { note: 'Usage limit: stopped, send a message to carry on' });
      this.emit(ticketId, 'note', { text: 'Stopped by user: it won\'t resume by itself.' });
      this.broadcastTicket(ticketId);
      return true;
    }
    this.queues.delete(ticketId);
    this.saveTurn(ticketId, { stopped: true, queued: [], steered: [] });
    this.emit(ticketId, 'note', { text: 'Stopped by user.' });
    live.stopPending = !existsSync(join(live.dir, 'pid.json'));
    // claude has a pid: SIGINT first, so it writes its result (cost, usage) before it exits. Not yet: nothing to
    // interrupt, so as before (this stops its unit); poll sends the SIGINT chain once claude starts.
    if (live.stopPending) this.signal(live, 'SIGTERM');
    else this.stopSignals(live, ticketId);
    // A container turn with no claude yet has no pid or unit to signal, and a start that hangs never gets one:
    // this ends it at the next poll. `stopped` tells poll it is not the wrapper's, should claude start after all.
    if (live.stopPending && live.container) writeFileSync(join(live.dir, 'exit.json'), JSON.stringify({ code: null, signal: null, stopped: true }));
    // A turn that ignores the stop (or hadn't started claude yet) gets killed.
    if (live.stopPending) this.armKill(live, ticketId);
    return true;
  }

  /** How long a stopped claude has after SIGINT to write its result before SIGTERM, and in all before SIGKILL (ms). */
  stopGraceMs = 5_000;
  stopKillMs = 15_000;

  private armKill(live: LiveTurn, ticketId: number) {
    clearTimeout(live.stopTimer);
    live.stopTimer = setTimeout(() => this.turns.get(ticketId) === live && this.signal(live, 'SIGKILL'), this.stopKillMs);
    live.stopTimer.unref();
  }

  /**
   * A stop on a started claude: SIGINT, so it ends its turn with a result event (SIGTERM exits 143 with none, so the
   * turn's cost went unrecorded, AG-04); then SIGTERM after the grace period; then the SIGKILL retry.
   */
  private stopSignals(live: LiveTurn, ticketId: number) {
    this.signal(live, 'SIGINT');
    clearTimeout(live.stopGraceTimer);
    live.stopGraceTimer = setTimeout(() => this.turns.get(ticketId) === live && this.signal(live, 'SIGTERM'), this.stopGraceMs);
    live.stopGraceTimer.unref();
    this.armKill(live, ticketId);
  }

  /** Signal a turn's claude and, as it runs in its own process group, its tool subprocesses too. */
  signal(live: Pick<LiveTurn, 'dir' | 'unit' | 'container'>, sig: NodeJS.Signals) {
    let pid = 0;
    try {
      pid = JSON.parse(readFileSync(join(live.dir, 'pid.json'), 'utf8')).claude;
    } catch {
      // Not started yet.
    }
    // A container's pids mean nothing here: signal its process group from inside.
    if (pid && live.container) {
      const s = sig.replace(/^SIG/, '');
      execFile('podman', ['exec', live.container, 'sh', '-c', `kill -${s} -${pid} 2>/dev/null || kill -${s} ${pid}`], () => {});
      return;
    }
    if (pid) {
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          process.kill(pid, sig);
        } catch {
          // Already gone.
        }
      }
    }
    // A unit's other processes (claude not started yet, or something it left behind) go with the unit.
    if (live.unit && (!pid || sig === 'SIGKILL')) execFile('systemctl', ['--user', 'stop', live.unit], () => {});
  }

  /**
   * Start a Taskmaster, or a minion (its composer's /fresh, #937), on a fresh Claude session (#406): a handoff
   * turn on the old session first (once any running turn ends), then the next turn starts a new session from
   * that handoff. A Taskmaster hands off with fresh_session; a minion's handoff is that turn's reply. Returns
   * why it can't, or null.
   */
  requestFresh(ticketId: number, why: string, auto = false): string | null {
    const ticket = this.store.getTicket(ticketId);
    if (!ticket) return 'No such minion';
    if (ticket.status === 'closed') return 'A dismissed minion keeps its session: send it a message first';
    if (!ticket.session_id) return 'Its session is already fresh';
    if (this.store.getSetting<FreshState>(freshKey(ticketId))) return 'A fresh start is already under way';
    this.store.setSetting(freshKey(ticketId), { why, ...(auto ? { auto: true as const } : {}) });
    this.emit(ticketId, 'note', { text: `Starting a fresh session (${why}): the ${roleWord(ticket)} writes its handoff first${this.isRunning(ticketId) ? ', once this turn ends' : ''}.` });
    if (!this.isRunning(ticketId)) this.next(ticketId);
    this.broadcastTicket(ticketId);
    return null;
  }

  /** The handoff a Taskmaster's running turn wrote (fresh_session): its session resets as the turn ends. */
  recordHandoff(ticketId: number, summary: string): string | null {
    const ticket = this.store.getTicket(ticketId);
    if (ticket?.kind !== 'coordinator') return 'Only a Taskmaster starts fresh sessions';
    if (!this.isRunning(ticketId)) return 'Only a running turn can hand off';
    const was = this.store.getSetting<FreshState>(freshKey(ticketId));
    this.store.setSetting(freshKey(ticketId), { why: was?.why ?? 'the Taskmaster asked for it', summary: summary.slice(0, HANDOFF_MAX) });
    return null;
  }

  /**
   * Keep the slash commands a turn loaded (Claude Code's init event lists them), for the composer's menu and its
   * check of what it sends (#937). Terminal-only ones and internal `__` ones are left out. Written only on a change.
   */
  private saveCommands(ticketId: number, ev: any) {
    const terminal = new Set(Array.isArray(ev.terminal_slash_commands) ? ev.terminal_slash_commands : []);
    const names = [...new Set<string>(ev.slash_commands.filter((n: unknown) => typeof n === 'string' && n && !n.startsWith('__') && !terminal.has(n)))];
    const plugins = (Array.isArray(ev.plugins) ? ev.plugins : [])
      .filter((p: any) => typeof p?.name === 'string' && typeof p.path === 'string' && p.path.startsWith('/'))
      .map((p: any) => ({ name: p.name, path: p.path }));
    const loaded: LoadedCommands = { names, plugins, cwd: typeof ev.cwd === 'string' ? ev.cwd : '' };
    const ticket = this.store.getTicket(ticketId);
    if (JSON.stringify(this.store.getSetting(commandsKey(ticketId))) !== JSON.stringify(loaded)) this.store.setSetting(commandsKey(ticketId), loaded);
    if (ticket && JSON.stringify(this.store.getSetting(schemeCommandsKey(ticket.project_id))) !== JSON.stringify(loaded)) this.store.setSetting(schemeCommandsKey(ticket.project_id), loaded);
  }

  /** A fresh start's next step, if it needs a turn of its own: the handoff ask, or the /compact fallback. */
  private freshStep(ticketId: number): QueuedMessage | null {
    const f = this.store.getSetting<FreshState>(freshKey(ticketId));
    // After a network outage, its resume (holding any queued messages) goes first: a step now would fail too and replace that wait.
    if (!f || f.summary || this.netWait(ticketId)) return null;
    // A message queued for a fresh start Citadel asked for by itself goes first, before its handoff or
    // its /compact fallback; the step follows that turn (#423).
    if (f.auto && this.queued(ticketId)) return null;
    const minion = this.store.getTicket(ticketId)?.kind !== 'coordinator';
    return f.compact ? { author: 'System', text: COMPACT_COMMAND, images: [], fresh: 'compact' } : { author: 'System', text: (minion ? minionHandoffPrompt : handoffPrompt)(f.why), images: [], fresh: 'handoff' };
  }

  /**
   * A fresh-start step's turn ended (wrapUp). A handoff resets the session; a handoff turn without one
   * falls back on compaction, unless it was stopped; a compaction ends the fresh start either way.
   */
  private endFresh(ticketId: number, turn: TurnState | null, ok: boolean, stopped: boolean) {
    let f = this.store.getSetting<FreshState>(freshKey(ticketId));
    if (!f) return;
    const ticket = this.store.getTicket(ticketId);
    const who = ticket ? roleWord(ticket) : 'Taskmaster';
    // A minion has no fresh_session: its handoff turn's reply is its handoff (#937), the status line left out.
    const reply = ticket?.kind !== 'coordinator' && turn?.fresh === 'handoff' && ok && !stopped && !turn.result?.error
      ? (turn.result?.text ?? '').replace(/<!--\s*status:[\s\S]*?-->/g, '').trim() : '';
    if (!f.summary && reply) f = { ...f, summary: reply.slice(0, HANDOFF_MAX) };
    if (f.summary) {
      this.store.deleteSetting(freshKey(ticketId));
      this.store.setSetting(handoffKey(ticketId), f.summary);
      this.store.deleteSetting(contextKey(ticketId));
      this.store.updateTicket(ticketId, { session_id: null });
      this.emit(ticketId, 'fresh', { summary: f.summary, why: f.why });
    } else if (turn?.fresh === 'handoff' && stopped) {
      this.store.deleteSetting(freshKey(ticketId));
      this.emit(ticketId, 'note', { text: `The handoff turn was stopped, so the fresh start is off: the ${who} keeps its session.` });
    } else if (turn?.fresh === 'handoff') {
      this.store.setSetting(freshKey(ticketId), { ...f, compact: true });
      this.emit(ticketId, 'note', { text: `No handoff came back${ok ? '' : ' (the turn failed)'}, so the ${who} compacts its session instead.` });
    } else if (turn?.fresh === 'compact') {
      this.store.deleteSetting(freshKey(ticketId));
      // Its size is unknown until its next turn, which keeps the idle check from asking again meanwhile.
      this.store.deleteSetting(contextKey(ticketId));
      this.emit(ticketId, 'note', { text: ok ? `Compacted the ${who}'s session instead of a fresh start.` : `Compacting failed too, so the ${who} keeps its session as it was.` });
    }
  }

  /**
   * Taskmasters idle FRESH_IDLE_MS with more than FRESH_IDLE_CONTEXT_TOKENS of context start fresh (#406),
   * while their prompt cache is still warm. One that missed that window (a restart) still does: its
   * next wake would re-read the whole context anyway. Run every minute.
   */
  freshSweep(now = Date.now()) {
    if (this.noTurns) return;
    for (const p of this.store.listProjects()) {
      for (const t of this.store.listTickets(p.id)) {
        if (t.kind !== 'coordinator' || !t.session_id || t.status !== 'idle' || this.isRunning(t.id) || this.queued(t.id) || this.lanes.busy(t.id) || this.limitWait(t.id) || this.netWait(t.id)) continue;
        const size = this.store.getSetting<number>(contextKey(t.id));
        const ended = this.store.lastTurnEnd(t.id);
        if (!size || size <= FRESH_IDLE_CONTEXT_TOKENS || !ended || now - ended < FRESH_IDLE_MS) continue;
        this.requestFresh(t.id, `idle ${Math.round((now - ended) / 60_000)} minutes with ${Math.round(size / 1000)}k tokens of context`, true);
      }
    }
  }

  /**
   * Keep waiting minions' prompt caches warm (#862, src/keepalive.ts): a hidden one-line turn 55 minutes after the last
   * one ended, in working hours, while the prefix it would re-read is still the one cached. Also sends the week's
   * readout to the Citadel Taskmaster, and switches keepalives off when they cost more than they saved. Run every minute.
   */
  keepaliveSweep(now = this.now()) {
    if (this.noTurns || this.store.getSetting(KEEPALIVE_OFF_KEY)) return;
    const reported = this.store.getSetting<number>(KEEPALIVE_REPORT_KEY);
    if (!reported) this.store.setSetting(KEEPALIVE_REPORT_KEY, now);
    else if (now - reported >= WEEK_MS) {
      this.store.setSetting(KEEPALIVE_REPORT_KEY, now);
      // A wait's real turn ends up to a long turn after it starts: the rows reach back a little before the week.
      const r = weekReport(this.store.minionTurnsSince(now - WEEK_MS - 9 * 3_600_000), now - WEEK_MS, now);
      const off = r.pings > 0 && r.netUsd < 0;
      if (off) this.store.setSetting(KEEPALIVE_OFF_KEY, { reason: 'they cost more than they saved last week', at: now });
      this.tellCitadel(reportText(r, off));
      if (off) return;
    }
    if (!inWindow(now)) return;
    for (const p of this.store.listProjects()) {
      for (const t of this.store.listTickets(p.id)) {
        // A busy lane (its last save, say) runs it once free, if it still qualifies then.
        if (t.kind === 'coordinator' || t.status !== 'idle' || this.keepalivePending.has(t.id) || !this.wantsKeepalive(t, p, now)) continue;
        this.keepalivePending.set(t.id, now - this.now());
        this.next(t.id);
      }
    }
  }

  /** Whether a minion is waiting on a person with a warm cache that a keepalive would keep (keepaliveSweep). */
  private wantsKeepalive(t: Ticket, p: Project, now: number): boolean {
    if (t.kind === 'coordinator' || !t.session_id || !t.cwd || t.status !== 'idle' || this.isRunning(t.id) || this.queued(t.id)) return false;
    if (this.limitWait(t.id) || this.netWait(t.id) || this.parked(t) || this.store.getSetting(freshKey(t.id))) return false;
    if (!(t.state === null || t.state === 'ready' || t.state === 'try' || this.store.openCardsOf(t.id).length)) return false;
    if (!inWindow(now)) return false;
    // Codex keeps no Claude cache.
    const person = t.person_id ?? p.owner_id;
    if (isCodexModel(turnSettings(t, p).model) || (person !== null && this.store.getSetting<boolean>(codexSwitchKey(person))) || this.store.getSetting(codexThreadKey(t.id))) return false;
    const s = this.store.getSetting<KeepaliveSeries>(keepaliveKey(t.id));
    if (!s || s.stopped || now - s.since >= SERIES_CAP_MS) return false;
    const ended = this.store.lastTurnEnd(t.id);
    return !!ended && now - ended >= KEEPALIVE_AFTER_MS && now - ended < CACHE_TTL_MS;
  }

  /** Mark a minion's keepalive series stopped, with why. */
  private stopSeries(ticketId: number, why: NonNullable<KeepaliveSeries['stopped']>) {
    const s = this.store.getSetting<KeepaliveSeries>(keepaliveKey(ticketId));
    if (s && !s.stopped) this.store.setSetting(keepaliveKey(ticketId), { ...s, stopped: why });
  }

  /** Held mail to the Citadel scheme's Taskmaster about keepalives. */
  private tellCitadel(text: string) {
    const tm = this.store.getOverlord(GLOBAL_OWNER);
    if (tm) this.leaveMail(tm.id, 'Citadel (keepalives)', text);
  }

  /** A keepalive's result: costed apart, and its miss stops its series; too many misses in a day switch keepalives off. */
  private keepaliveResult(ticketId: number, ev: any) {
    this.store.recordTurn(ticketId, {
      session_id: typeof ev.session_id === 'string' ? ev.session_id : null, ended_at: Date.now(), session_cost_usd: ev.total_cost_usd,
      duration_ms: ev.duration_ms, usage: ev.usage, payer: this.payerOf(this.store.getSetting<TurnState>(turnKey(ticketId))?.person), keepalive: true,
      account: this.store.getSetting<TurnState>(turnKey(ticketId))?.account ?? null, modelUsage: ev.modelUsage,
    });
    if (!missed(ev.usage)) return;
    this.stopSeries(ticketId, 'missed');
    console.log(`[keepalive] minion ${ticketId}: its keepalive wrote ${ev.usage?.cache_creation_input_tokens} tokens to the cache, so its series stops`);
    const day = this.store.minionTurnsSince(Date.now() - 24 * 3_600_000).filter((r) => r.keepalive);
    const misses = day.filter((r) => missed({ cache_creation_input_tokens: r.cache_write_tokens })).length;
    if (!tooManyMisses(day.length, misses) || this.store.getSetting(KEEPALIVE_OFF_KEY)) return;
    this.store.setSetting(KEEPALIVE_OFF_KEY, { reason: `${misses} of ${day.length} keepalives missed the cache in a day`, at: Date.now() });
    this.tellCitadel(`Keepalives are off: ${misses} of the last day's ${day.length} keepalives missed the cache (more than 1 in 5), so something in minions' prompts keeps changing between turns. Find it, then delete the \`${KEEPALIVE_OFF_KEY}\` setting to switch them back on.`);
  }

  /**
   * A Taskmaster whose turn ended past FRESH_CONTEXT_TOKENS starts fresh at once (#423), not only once idle.
   * Not while messages wait (the last of their turns hands off) or on a usage-limit or network wait, and
   * never after a fresh-start step's own turn: one that leaves it big waits for the next real turn.
   */
  private freshAtTurnEnd(ticketId: number, turn: TurnState) {
    if (turn.fresh || this.queued(ticketId) || this.limitWait(ticketId) || this.netWait(ticketId)) return;
    const t = this.store.getTicket(ticketId);
    const size = this.store.getSetting<number>(contextKey(ticketId));
    if (t?.kind !== 'coordinator' || !t.session_id || !size || size <= FRESH_CONTEXT_TOKENS) return;
    this.requestFresh(ticketId, `${Math.round(size / 1000)}k tokens of context at the end of a turn`, true);
  }

  private next(ticketId: number) {
    const q = this.queues.get(ticketId);
    if (!q?.length && !this.freshStep(ticketId) && !this.keepalivePending.has(ticketId)) return;
    // Waiting for the usage limit to reset: the messages go into the resume, not a turn that would fail at once.
    if (this.holdForLimit(ticketId)) return;
    // One step at a time per minion (src/lanes.ts): the lane calls next() again once it is free. Its last
    // turn's save above all: a turn on another login restores from that save (#250).
    if (this.lanes.busy(ticketId)) {
      // A running turn keeps its queue in its own record; in the gap after it, they're kept here (#259).
      if (!this.isRunning(ticketId) && q?.length) this.store.setSetting(waitingKey(ticketId), q);
      return;
    }
    // Whose turn it will be, as below: a fresh-start step's is the minion's own, else the first queued message's.
    const person = (ticket: Ticket, project: Project) => this.turnPerson(ticket, project, this.freshStep(ticketId) ? [] : this.peekQueue(ticketId));
    this.lanes.run(ticketId, 'turn', () => this.afterRestore(ticketId, person, () => {
      const ticket = this.store.getTicket(ticketId);
      const project = ticket && this.store.getProject(ticket.project_id);
      if (!ticket || !project) return;
      // A Taskmaster's fresh-start step runs first and alone; the queue waits for the fresh session
      // (but goes before a handoff Citadel asked for by itself: freshStep).
      const fresh = this.freshStep(ticketId);
      if (fresh) {
        let ended: Promise<void> | void;
        try {
          ended = this.startTurn(project, ticket, [fresh], this.turnPerson(ticket, project, []));
        } catch (err) {
          // Thrown out of the step with the fresh start still pending, the freed lane would ask again in a
          // microtask, for ever, and nothing else on the server would run: give up as below.
          console.error(`Ticket ${ticketId}: its fresh start's turn could not start:`, err);
          ended = this.turns.get(ticketId)?.ended;
        }
        if (this.isRunning(ticketId)) {
          // The queue waits behind this turn as behind any: in its record, so a restart keeps it.
          const q = this.queues.get(ticketId);
          if (q?.length) this.saveTurn(ticketId, { queued: q });
          this.store.deleteSetting(waitingKey(ticketId));
          return ended;
        }
        // No turn started (a preview, a refused place): drop it, or the idle lane would ask again at once,
        // and forget its size, or the idle check would ask again each minute.
        this.store.deleteSetting(freshKey(ticketId));
        this.store.deleteSetting(contextKey(ticketId));
        this.emit(ticketId, 'note', { text: 'The fresh start could not run a turn, so the Taskmaster keeps its session.' });
      }
      // A real message that came in meanwhile goes first, and the keepalive is dropped: that turn re-reads the cache anyway.
      const skew = this.keepalivePending.get(ticketId);
      if (this.keepalivePending.delete(ticketId) && !this.queues.get(ticketId)?.length && !this.netWait(ticketId) && this.wantsKeepalive(ticket, project, this.now() + skew!)) {
        return this.startTurn(project, ticket, [{ author: 'System', text: KEEPALIVE_TEXT, images: [], keepalive: true }], this.turnPerson(ticket, project, []));
      }
      // Everything queued while the last turn ran goes into one turn.
      const waiting = this.peekQueue(ticketId);
      if (!waiting.length) return;
      const person = this.turnPerson(ticket, project, waiting);
      if (this.refused(ticketId, person)) {
        // What woke it is refused, as in send(); held mail and a network wait's messages stay for the next turn (#468 S03-6).
        this.queues.delete(ticketId);
        this.store.deleteSetting(waitingKey(ticketId));
        return;
      }
      return this.startTurn(project, ticket, this.takeQueue(ticketId), person);
    }, true));
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

  /**
   * Who a turn runs for (its GitHub login, and #177's Claude plan): the first person in its messages
   * (a relay counts as its sender's), else the minion's last person, else the scheme's owner. A relay
   * from someone outside this scheme (a non-member's ask to Citadel) runs as the scheme's owner (#211).
   * A split scheme's Overlord has no last person (Cara's R4, "Starter, else owner", #921): it is nobody's own.
   */
  private turnPerson(ticket: Ticket, project: Project, batch: QueuedMessage[]): number | null {
    // A person's own Taskmaster (#919) runs for its person, but never on someone else's request: a turn another person
    // starts there (a card answer, R5, a plan verdict, a file comment, /backup) runs on their login. Relays and held mail
    // name no person, so they leave it on the owner's.
    if (ticket.kind === 'coordinator' && ticket.coordinator_of != null) {
      const starter = batch.find((m) => !m.from && this.personOf?.(m.author));
      const p = (starter && this.personOf?.(starter.author)) || ticket.coordinator_of;
      // #211: someone taken out of the scheme (or deleted) no longer pays for its turns; its owner does.
      const user = this.store.getUser(p);
      return user && this.store.canSee({ uid: user.id, admin: !!user.admin }, project.id) ? p : project.owner_id;
    }
    for (const m of batch) {
      const p = this.personOf?.(m.author, m.from);
      if (!p) continue;
      const user = m.from ? this.store.getUser(p) : null;
      return user && !this.store.canSee({ uid: user.id, admin: !!user.admin }, project.id) ? project.owner_id : p;
    }
    return (this.isOverlord(ticket) ? null : ticket.person_id) ?? project.owner_id;
  }

  /** Whether `ticket` is a split scheme's Overlord (#919, #921): the Taskmaster that is nobody's own, beside one per person. */
  isOverlord(ticket: Ticket | undefined): boolean {
    return !!ticket && ticket.kind === 'coordinator' && ticket.coordinator_of == null && this.store.isSplit(ticket.project_id);
  }

  /**
   * An answer to an Overlord's card wakes only the Taskmaster that acts on it (`actor`: the Overlord, or the person's
   * Taskmaster that asked for everyone); every other Taskmaster in the scheme hears it as held mail (#921).
   */
  echoOverlordAnswer(overlord: Ticket, by: string, text: string, actor = overlord.id) {
    if (!this.isOverlord(overlord)) return;
    const line = text.length > 600 ? text.slice(0, 600) + '…' : text;
    for (const tm of this.store.listCoordinators(overlord.project_id)) {
      if (tm.id !== actor && tm.id !== overlord.id) this.leaveMail(tm.id, by, `(for your tracking; nothing to do) ${by} answered the Overlord's card:\n${line}`);
    }
  }

  /** A card's answer kept in its chat without waking it: a for-everyone card's answer wakes its asker instead (#921). */
  recordAnswer(ticketId: number, author: string, text: string, extra: object) {
    this.emit(ticketId, 'user_message', { author, text: hideTokens(text), ...extra });
    this.broadcastTicket(ticketId);
  }

  private startTurn(project: Project, ticket: Ticket, batch: QueuedMessage[], person: number | null, resumes = 0, limitTries = 0, netTries = 0) {
    // Before anything else here: restoring a worktree runs git in the real repo, and a turn is a real claude.
    if (this.noTurns) {
      this.emit(ticket.id, 'note', { text: 'This is a preview: it shows the app on a copy of the data, but it never runs turns.' });
      return this.broadcastTicket(ticket.id);
    }
    // A hidden keepalive (#862): it re-reads the cached prefix and changes nothing of the minion's, the chat included.
    const keepalive = !!batch[0]?.keepalive;
    // Whose Claude it runs on (sender pays, #213): the host's login for its owner, else their own container.
    const claudePlace = this.placeFor?.(person, warmKey(ticket)) ?? { host: true as const };
    if ('refused' in claudePlace) {
      if (keepalive) return;
      this.emit(ticket.id, 'note', { text: claudePlace.refused });
      return this.broadcastTicket(ticket.id);
    }
    // The worktree sweep removes dismissed minions' worktrees; a reopened one gets its back.
    this.restoreDir(ticket, project);
    // With no folder it would run in the server's own (#899): the note above says why it can't.
    if (ticket.kind === 'ticket' && !ticket.cwd) return this.broadcastTicket(ticket.id);
    let filesDir = this.filesDir(ticket);
    try {
      if (filesDir) mkdirSync(filesDir, { recursive: true });
    } catch {
      filesDir = null;
    }
    let sharedDir = this.sharedDir(project);
    try {
      if (sharedDir) mkdirSync(sharedDir, { recursive: true });
    } catch {
      sharedDir = null;
    }
    // Claude Code keeps auto-memory under the main checkout's folder, shared by the project's worktrees.
    let memoryDir = project.repo_dir && ticket.kind === 'coordinator' ? join(claudeConfigDir(process.env), 'projects', projectSlug(project.repo_dir), 'memory') : null;
    try {
      if (memoryDir) mkdirSync(memoryDir, { recursive: true });
    } catch {
      memoryDir = null;
    }
    // Who asked for it (#255): its messages' askers, any non-admin of them if several, since a ride-along
    // ask is in the turn too; with none (GitHub, a notice), and on a resume, the last turn's carries on.
    const before = this.store.turnAsker(ticket.id);
    const askers = [...(resumes || limitTries || netTries || keepalive ? [before] : []), ...batch.map((m) => (m.asker !== undefined ? m.asker : this.personOf?.(m.author, m.from) ?? null))].filter((a): a is number => a !== null);
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
    const codexPlace = wantsCodex && !codexWhy && claudePlace.host && person !== null ? this.codexPlaceFor?.(person) ?? null : null;
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
    const light = !codex && ticket.kind !== 'coordinator' && (keepalive
      ? !!this.store.getSetting<KeepaliveSeries>(keepaliveKey(ticket.id))?.light
      : !resumes && !limitTries && !netTries && batch.length > 0 && batch.every((m) => m.light));
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
    const digestLine = digest.length ? [{ author: 'System', text: `Since your last turn, this scheme's other ${AGENT_NAME}s:\n${digest.map((l) => `- ${l}`).join('\n')}`, images: [] }] : [];
    const typers = new Set(batch.filter((m) => m.typed && !m.from).map((m) => this.personOf?.(m.author) ?? null));
    const typedBy = typers.size === 1 ? [...typers][0] : typers.size ? 0 : null;
    // A Codex turn resumes its thread when it is this person's; otherwise a new one starts from the hand-over below.
    const same = codexThread?.person === person && codexThread.thread;
    let built: ReturnType<Runner['buildLaunch']>;
    try {
      built = this.buildLaunch(project, ticket, {
        place, person, asker, machines, model, effort, typedBy, secrets, name: `${ticket.id}-${Date.now()}`,
        folders: { files: filesDir, shared: sharedDir, memory: memoryDir }, codex: codex ? { thread: same || null } : null,
      });
    } catch (err: any) {
      // A launch that can't be built (a settings file past Claude Code's cap, #661; claude not on the PATH) fails the turn with its reason, in the chat.
      console.error(`Minion ${ticket.id}: its launch could not be built:`, err);
      const event = this.emit(ticket.id, 'error', { text: `Could not start the turn: ${err.message}` });
      const note = `Could not start: ${err.message}`;
      this.setFailNote(ticket.id, { note: note.length > 60 ? `${note.slice(0, 59)}…` : note });
      this.setStatus(ticket.id, 'error');
      this.onTurnError(ticket.id, err.message, event.id);
      return;
    }
    const { plan, dir, system, parts, context, pins, github, unit, reviewAt } = built;
    if (reviewAt && !keepalive) this.wakeCodex?.(person!);
    const { command, args, env, configDir } = plan;
    // What its cached prefix is built from (#862), before --resume joins the arguments: a keepalive runs only while it is the
    // one its last real turn cached. A minion's alone: Taskmasters and Codex get no keepalives.
    const fpParts = ticket.kind === 'coordinator' || codex || !ticket.cwd ? null : prefixParts({
      dir, systemPrompt: system, args, files: plan.files, env, pinned: treeHash(pins.MCP_DIR), claude: claudeStamp(command, env.PATH),
      context: contextText(ticket.cwd, configDir, [ticket.cwd, project.repo_dir].filter((d): d is string => !!d).map((d) => join(configDir, 'projects', projectSlug(d), 'memory', 'MEMORY.md'))),
      date: turnDate(Date.now(), env.TZ),
    });
    const fp = fpParts && fingerprint(fpParts);
    if (keepalive) {
      const s = this.store.getSetting<KeepaliveSeries>(keepaliveKey(ticket.id));
      if (!fp || s?.fp !== fp) {
        console.log(`[keepalive] minion ${ticket.id}: its prompt changed since its last turn (${changedParts(s?.parts ?? {}, fpParts ?? {}).join(', ')}), so its keepalives stop`);
        this.stopSeries(ticket.id, 'dirty');
        rmSync(dir, { recursive: true, force: true });
        this.turnSecrets.delete(ticket.id);
        return;
      }
    }
    const hashes = promptHashes(parts, plan.env, model, effort, this.payerOf(person));
    // Written before anything of the minion's changes below, so a launch that can't be written leaves who it runs for as it was.
    for (const f of plan.files) writeFileSync(join(dir, f.name), f.text, f.mode === undefined ? {} : { mode: f.mode });
    // A keepalive changes nothing of the minion's: who it runs for, its state, note and replies stay as the last real turn left them.
    if (!keepalive) {
      if (asker !== null && asker !== person) this.store.setSetting(askerKey(ticket.id), asker);
      else this.store.deleteSetting(askerKey(ticket.id));
      if (person !== ticket.person_id) {
        this.store.updateTicket(ticket.id, { person_id: person });
        const name = person && this.store.getUser(person)?.name;
        if (ticket.person_id && name) this.emit(ticket.id, 'note', { text: claudePlace.host ? `Turns now run for ${name}, on the server's Claude login.` : `Turns now run on ${name}'s Claude plan.` });
      }
      const from = batch.find((m) => m.from || this.personOf?.(m.author))?.from;
      if (from) this.turnFrom.set(ticket.id, from);
      else this.turnFrom.delete(ticket.id);
      // A state describes where the last turn left things; a new turn makes it stale. Pending-deploy
      // outlasts a stray turn (a GitHub ping), so the deploy still dismisses the minion unless the turn
      // sets another state or a person wrote to it (personWrote).
      // A limited minion's note is the server's, about the wait this turn ends; a complete one's says nothing is left (#547).
      // A minion parked on start_after stays parked through a turn that answers a message (#261).
      if (this.heldFor(ticket.id)) this.parkedAs.set(ticket.id, { state: ticket.state, note: ticket.note });
      // A handed-off land's outside is the server's (#962): LandHandoffs replaces it when the land ends.
      else if (ticket.state && ticket.state !== 'pending-deploy' && !(ticket.state === 'outside' && this.serverWork(ticket.id, true))) this.store.updateTicket(ticket.id, ticket.state === 'limited' || ticket.state === 'complete' ? { state: null, note: null } : { state: null });
      this.cancelLimitWait(ticket.id);
      // A network wait ended when its held messages were taken (takeQueue); its note goes with it.
      if (ticket.note === NET_NOTE) this.store.updateTicket(ticket.id, { note: null });
      // A Taskmaster's note is only ever the server's word on how its last turn failed or stopped: a new turn makes it stale (#428).
      else if (ticket.kind === 'coordinator' && ticket.note) this.store.updateTicket(ticket.id, { note: null });
      // One-tap replies answer the turn that offered them; a new turn makes them stale.
      if (ticket.replies) this.store.updateTicket(ticket.id, { replies: null });
    }

    // The session's transcript, task list and memory live in the database too; put back anything this
    // config dir lacks (another account, a fresh machine) before resuming.
    let restoreFailed = false;
    let had: Set<string> | null = null;
    // A session that is gone for good: the fresh one starts from a short digest of the chat (#899).
    let lost: { text: string; entries: number } | null = null;
    try {
      const restored = restoreSession(this.store, ticket, project, configDir);
      // Everything stored is in the config dir now, so the end-of-turn save may prune what the turn deletes.
      had = storedPaths(this.store, ticket, project);
      if (restored) console.log(`Ticket ${ticket.id}: restored the Claude session from the database (${restored} file${restored === 1 ? '' : 's'}).`);
    } catch (err: any) {
      this.emit(ticket.id, 'note', { text: `Could not restore the session from the database: ${err.message}` });
      restoreFailed = true;
    }
    // With no copy of its transcript on this login or in the database, --resume would fail every turn from now on.
    // A restore that failed (disk full, say) still resumes and fails loudly: the database's copy may be fine.
    const transcript = ticket.session_id ? transcriptPath(configDir, ticket.cwd, ticket.session_id) : null;
    if (ticket.session_id && transcript && (restoreFailed || existsSync(transcript))) {
      if (!codex) args.push('--resume', ticket.session_id);
    } else if (keepalive) {
      // No session to keep warm: its next real turn says so.
      this.stopSeries(ticket.id, 'failed');
      rmSync(dir, { recursive: true, force: true });
      this.turnSecrets.delete(ticket.id);
      return;
    } else if (ticket.session_id) {
      lost = lostSessionText(ticket.session_id, ticket.note, this.chatDigest(ticket.id, batch));
      this.emit(ticket.id, 'note', { text: `This minion's conversation (session ${ticket.session_id}) isn't on this Claude login or in the database, so this turn starts a fresh session. Its branch, worktree and chat are all still here; Claude doesn't remember the earlier turns, so it starts from ${lost.entries ? `its status note and its last ${lost.entries} chat entries` : 'its status note'}.` });
      this.store.updateTicket(ticket.id, { session_id: null });
    }
    // The Taskmaster's auto-memory moved to the repo memory (#98); bring its old notes along once.
    if (memoryDir) {
      try {
        mergeMemory(join(configDir, 'projects', projectSlug(ticket.cwd), 'memory'), memoryDir);
      } catch (err: any) {
        this.emit(ticket.id, 'note', { text: `Could not move the Taskmaster's old memory into ${memoryDir}: ${err.message}` });
      }
    }

    const prompt = step === 'compact' ? JSON.stringify({ type: 'user', message: { role: 'user', content: COMPACT_COMMAND } }) + '\n'
      : keepalive ? promptMessage(batch)
      : promptMessage([...(context ? [{ author: 'System', text: context, images: [] }] : []), ...(github ? [{ author: 'System', text: github.line, images: [] }] : []), ...(handoff ? [{ author: 'System', text: freshStartText(handoff), images: [] }] : []), ...(lost ? [{ author: 'System', text: lost.text, images: [] }] : []), ...handBack, ...cancelledLine, ...digestLine, ...batch]);
    writeFileSync(join(dir, 'prompt.jsonl'), prompt);
    for (const f of ['stream.jsonl', 'stderr.log', 'steer.jsonl']) writeFileSync(join(dir, f), '');
    if (codex) {
      // The Claude conversation from its last compaction, then any Codex turns on another person's Codex, verbatim:
      // a new thread starts from it (the shim skips it when it resumes the thread).
      let claudeJsonl = '';
      try {
        if (transcript) claudeJsonl = readFileSync(transcript, 'utf8');
      } catch {
        // No transcript: the hand-over is the Codex turns alone, if any.
      }
      writeFileSync(join(dir, 'handover.md'), fitLog([...claudeParts(claudeJsonl), ...readParts(codexThread?.log ?? '')]));
      if (!same) this.store.setSetting(codexThreadKey(ticket.id), { thread: null, person: person!, log: codexThread?.log ?? '' });
    }
    // Holds the turn's token: private, and the wrapper deletes it once read.
    writeFileSync(join(dir, 'spec.json'), JSON.stringify({ command, args, cwd: ticket.cwd, env }), { mode: 0o600 });
    const turn: TurnState = { resumes, dir, unit, offset: 0, startedAt: Date.now(), configDir, chosenEffort: !!ticket.effort || codex || light, ...(light ? { light: true as const } : {}), ...(limitTries ? { limitTries } : {}), ...(netTries ? { netTries } : {}), ...(codex ? { codex: true as const } : {}), ...(handBack.length ? { handBack: true as const } : {}), ...(step ? { fresh: step } : {}), ...(handoff ? { handoff: true as const } : {}), person, asker, typedBy, hashes, ...(secretPerson ? { secretPerson } : {}), ...(github ? { github: github.login } : {}), ...(place.host ? {} : { container: place.container }), ...(codex ? {} : { account: claudePlace.account ?? 1 }),
      ...(machines.some((m) => m.owner_id !== null) ? { owned: machines.filter((m) => m.owner_id !== null).map((m) => m.id) } : {}),
      ...(keepalive ? { keepalive: true as const } : {}), ...(fp ? { fp, fpParts: fpParts! } : {}) };
    this.store.setSetting(turnKey(ticket.id), turn);
    const live = this.follow(ticket.id, turn);
    live.had = had;
    // A keepalive never shows as running: the list and the chat don't know it happened.
    if (keepalive) this.keepalives.add(ticket.id);
    else this.setStatus(ticket.id, 'running');
    // Its step on the lane lasts until it has ended and its session is saved (finish).
    if (plan.spawn.how === 'container') {
      this.spawnInContainer(place as Exclude<TurnPlace, { host: true }>, dir, plan.spawn.wrapper, ticket.id);
      return live.ended;
    }
    const { wrapper } = plan.spawn;
    if (plan.spawn.how === 'child') {
      this.spawnWrapper(wrapper, dir);
      return live.ended;
    }
    execFile('systemd-run', plan.spawn.systemdRun, (err, _out, stderr) => {
      if (!err) return fallbacks.started();
      fallbacks.record(ticket.id, 'A turn', String(stderr).trim() || err.message);
      live.unit = null;
      this.saveTurn(ticket.id, { unit: null });
      this.spawnWrapper(wrapper, dir);
    });
    return live.ended;
  }

  /**
   * A launch from the facts a turn was given (src/turn-launch.ts), in a folder of its own named `name`. A side
   * question's fork (#932, src/side-ask.ts) builds its own here too, so its tools and prompt, the cached prefix,
   * are its minion's turn's. Throws, removing the folder, when the launch can't be built.
   */
  buildLaunch(project: Project, ticket: Ticket, f: {
    place: TurnPlace; person: number | null; asker: number | null; machines: ReturnType<Runner['machines']>; model: string | null; effort: string | null;
    typedBy: number | null; secrets: Map<string, string>; name: string; folders: { files: string | null; shared: string | null; memory: string | null };
    codex: { thread: string | null } | null; github?: number | null; side?: boolean;
  }) {
    const { place, person, asker, machines, model, effort, codex } = f;
    const { files: filesDir, shared: sharedDir, memory: memoryDir } = f.folders;
    // The turn's folder, with its own copy of the pinned files: a restart sweeps the server's copy, and
    // the tripwire hook must still be there for a turn that outlives it.
    const dir = join(place.host ? this.turnsDir : place.turnsDir, f.name);
    const pin = join(dir, 'pin');
    mkdirSync(dir, { recursive: true });
    try {
      const pins = turnPins();
      cpSync(pins.MCP_DIR, pin, { recursive: true });
      // Deploys, pending-deploy and previews only mean something in the scheme whose code this server runs.
      const deploys = ticket.kind !== 'coordinator' && runsRepo(project.repo_dir, this.liveHead());
      // A file, not an argument: in claude's argv, a turn's own `pkill -f <word from the prompt>` would match claude itself.
      // Builds (specs/build-branches.md): only once the scheme's land.sh can merge into one.
      const builds = landsBuilds(project.repo_dir);
      const build = builds && ticket.kind !== 'coordinator' && ticket.build
        ? {
          build: ticket.build, branch: buildBranch(project.repo_dir, ticket.build), owner: this.store.getSetting<number>(buildOwnerKey(project.id, ticket.build)) === ticket.id,
          // Only this server's own scheme has build previews (src/previews.ts).
          preview: deploys ? `${this.store.getSetting<string>('public_origin') ?? ''}/${buildPreviewPath(ticket.build)}` : null,
        }
        : null;
      // What the Citadel scheme's Taskmaster may read in every scheme this turn (#656): its prompt and its launch say the same.
      const everyScheme = this.everySchemeFor(project, ticket, asker);
      const everySchemeView = everyScheme && { data: everyScheme.data, schemes: this.store.listProjects().filter((p) => p.id !== project.id).map((p) => ({ id: p.id, name: p.name })), apps: this.store.listContraptions().map((c) => ({ name: c.name, folder: appFolder(c, homedir()) })) };
      // Two halves (#878): system-prompt.md, the same for every minion of the scheme, and the per-minion and volatile lines that open the turn message.
      // Machines a minion may queue jobs on (#857): lent to this scheme with a jobs block; the owner's go card is the gate.
      const jobMachines = ticket.kind === 'coordinator' ? [] : jobMachinesFor(this.store, project.id);
      const parts = promptParts(project, ticket, filesDir, sharedDir, this.ticketsDir(project), memoryDir, machines, deploys, this.store.appInstructions().text, this.heldFor(ticket.id), ticket.kind === 'coordinator' && onboardingOpen(project) ? surveyReports(this.dataDir) : [], build, builds, everySchemeView, this.store.personalLayer(ticket), this.openPr(ticket.id), ticket.kind === 'coordinator' && this.store.isSplit(project.id) ? (ticket.coordinator_of == null ? 'overlord' : 'person') : null, jobMachines);
      const system = promptText(parts.system);
      writeFileSync(join(dir, 'system-prompt.md'), system);
      const context = promptText(parts.turn);
      // Its own temp folder on disk, cleared on dismissal (#218). CLAUDE_CODE_TMPDIR moves Claude Code's
      // /tmp/claude-<uid>, which ignores TMPDIR. A command or script that sets its own TMPDIR still wins.
      let tmp: string | null = null;
      try {
        tmp = makeTmpDir(this.tmpRoot(project.id), ticket.id);
      } catch (err: any) {
        this.emit(ticket.id, 'note', { text: `Could not make this minion's temp folder, so it uses the shared one: ${err.message}` });
      }
      // The link check reads the reply against the folders the chat serves this turn's files from (ticketRoots).
      // A file, not an argument: a scheme's minion list outgrows a command line.
      const refsFile = join(dir, 'scheme-refs.json');
      this.writeRefs(refsFile, ticket);
      // A host turn has no Codex hook, so the server login's Codex reviews run in its Codex container (#398): woken
      // (by the caller) if it stopped (a reboot) without replacing one a review may be running in.
      const codexAt = place.host && person !== null ? this.codexPlaceFor?.(person) ?? null : null;
      const reviewAt = codexAt && !codexAt.host ? codexAt : null;
      const coordinator = this.coordinatorEnv(ticket);
      const heavy = this.heavyEnv(ticket, person);
      // The person's own GitHub token (or none, so it can't push), and a line saying whose it is.
      const github = this.githubFor?.(f.github === undefined ? person : f.github, dir) ?? null;
      const typer = f.typedBy ? this.store.getUser(f.typedBy) : undefined;
      const homeOf = this.store.listContraptions().filter((c) => c.home_scheme === project.id).map((c) => c.name);
      // A side question's fork runs as the server's child: it is short, and a restart loses it anyway.
      const unit = this.units && place.host && !f.side ? `citadel-turn-${this.unitTag}-${basename(dir)}` : null;
      // Everything the turn is launched with, from the facts chosen above (src/turn-launch.ts).
      const plan = launchPlan({
        project, ticket, dir, pins, place, machines, model, effort, deploys, unit,
        folders: { files: filesDir, shared: sharedDir, memory: memoryDir, tmp, tickets: this.ticketsDir(project), data: dirname(this.store.path),
          // A Taskmaster's git rules cover only open minions' worktrees (coordinatorAccess).
          openTickets: ticket.kind === 'coordinator' ? this.store.listTickets(project.id).filter((t) => t.kind !== 'coordinator' && t.status !== 'closed' && t.cwd).map((t) => t.cwd!) : undefined },
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
        appTurnsRun: ticket.kind !== 'coordinator' && homeOf.length > 0 && isAppTurnsRun(this.store, ticket),
        everyScheme,
        claudeBin: this.claudeBin,
        ...(f.side ? { side: true } : {}),
      });
      return { plan, dir, system, parts, context, pins, github, unit, reviewAt };
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * Start a side question's fork (#932, src/side-ask.ts): the minion's own launch (buildLaunch, with the read-only
   * guard) on the asker's login, resuming `resume` (the minion's session, forked; or the fork, for a follow-up), with
   * `prompt` as its message. Nothing of the minion's changes: not its session, state or queue. Throws with a reason
   * people can read when it can't start.
   */
  sideLaunch(ticketId: number, asker: number, prompt: string, resume: { id: string; fork: boolean }) {
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
    const { plan, dir } = this.buildLaunch(project, ticket, {
      place, person, asker: turnAsker, machines, model, effort, typedBy: null, secrets: new Map(), name: `side-${ticket.id}-${Date.now()}`,
      folders: { files: this.filesDir(ticket), shared: this.sharedDir(project), memory: null }, codex: null, github: asker, side: true,
    });
    try {
      for (const f of plan.files) writeFileSync(join(dir, f.name), f.text, f.mode === undefined ? {} : { mode: f.mode });
      // The asker's login may lack the minion's session: put back the database's copy, as of its last finished turn.
      // shortcut: mid-turn on another login, the fork sees the session as its last turn left it; copying the live transcript across would show the turn so far.
      if (resume.fork) restoreSession(this.store, ticket, project, plan.configDir);
      if (!existsSync(transcriptPath(plan.configDir, ticket.cwd, resume.id))) throw new Error(resume.fork ? 'This minion has no session to ask yet.' : 'This side thread has ended; ask a new question.');
      plan.args.push('--resume', resume.id, ...(resume.fork ? ['--fork-session'] : []));
      writeFileSync(join(dir, 'prompt.jsonl'), prompt);
      for (const f of ['stream.jsonl', 'stderr.log', 'steer.jsonl']) writeFileSync(join(dir, f), '');
      writeFileSync(join(dir, 'spec.json'), JSON.stringify({ command: plan.command, args: plan.args, cwd: ticket.cwd, env: plan.env }), { mode: 0o600 });
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
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
   * `podman exec` runs in a transient scope under the turns slice, which the restart leaves alone and
   * which goes once the turn ends. The wrapper's pids are the container's, so the `container` file
   * tells wrapperAlive to go by its heartbeat instead.
   */
  private spawnInContainer(place: Extract<TurnPlace, { host: false }>, dir: string, wrapper: string[], ticketId: number) {
    writeFileSync(join(dir, 'container'), place.container);
    const beat = () => writeFileSync(join(dir, 'beat'), '');
    beat();
    // Starting the container (building its image, the first time) can take minutes; it counts as running meanwhile.
    const starting = setInterval(beat, 5_000);
    // Both return as soon as the wrapper is started. One that hangs (a stuck podman lock) would keep the turn "running" for good.
    const run = ([cmd, ...args]: string[]) => new Promise<void>((resolve, reject) => {
      execFile(cmd, args, { timeout: this.containerStartMs }, (err, _out, stderr) => (err ? reject(new Error(err.killed ? `${cmd} did not return within ${this.containerStartMs / 1000} s` : String(stderr).trim() || err.message)) : resolve()));
    });
    // Stopped while it started (stop() wrote exit.json), and maybe finished since: nothing more to start or to say.
    const over = () => !existsSync(dir) || existsSync(join(dir, 'exit.json'));
    const exec = ['podman', 'exec', '-d', place.container, ...wrapper];
    const scoped = ['systemd-run', '--user', '--scope', '--collect', '--quiet', `--unit=citadel-turn-${this.unitTag}-${basename(dir)}`, `--slice=${TURN_SLICE}`, ...exec];
    place.ensure()
      // As with host turns, a failed systemd-run still runs the turn, though a restart then SIGKILLs its conmon.
      // Only an exec that then starts counts as a fallback: one that fails both ways was podman's trouble.
      .then(() => (over() ? undefined : this.units ? run(scoped).then(() => fallbacks.started('scope'), (err) => run(exec).then(() => fallbacks.record(ticketId, `A turn in ${place.container}`, err.message, Date.now(), 'scope'))) : run(exec)))
      .catch((err) => !over() && writeFileSync(join(dir, 'exit.json'), JSON.stringify({ code: null, signal: null, error: `${place.container}: ${err.message}` })))
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
      dir: turn.dir!, unit: turn.unit ?? null, offset: turn.offset ?? 0, startedAt: turn.startedAt ?? Date.now(),
      configDir: turn.configDir ?? claudeConfigDir(process.env), chosenEffort: !!turn.chosenEffort, container: turn.container ?? null, ticks: 0,
      timer: setInterval(() => this.poll(ticketId), this.pollMs), ended, end, had: null,
      // After a restart the clock starts again: what ran before isn't known.
      activity: { at: Date.now(), tools: [] },
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
      // Checked before reading: once exit.json is there, everything claude wrote is in the stream.
      const exited = existsSync(join(live.dir, 'exit.json'));
      this.readStream(ticketId, live, exited);
      const exit = exited ? JSON.parse(readFileSync(join(live.dir, 'exit.json'), 'utf8')) : null;
      // stop()'s own exit.json, but claude has started since: the turn ends with its wrapper's, once the signal below lands.
      if (exit?.stopped && live.stopPending && existsSync(join(live.dir, 'pid.json'))) rmSync(join(live.dir, 'exit.json'), { force: true });
      else if (exit) return this.finish(ticketId, live, exit);
      // Stopped while still starting: its claude has a pid now (#468 S03-2). The SIGKILL retry still follows.
      if (live.stopPending && existsSync(join(live.dir, 'pid.json'))) {
        live.stopPending = false;
        this.stopSignals(live, ticketId);
      }
      if (live.ticks % 40 === 0) this.checkQuiet(ticketId, live);
      // Gone without a word: killed with its unit (out of memory, say).
      if (++live.ticks % 20 === 0 && this.gone(live)) {
        this.readStream(ticketId, live, true);
        this.finish(ticketId, live, null);
      }
    } catch (err: any) {
      console.error(`Ticket ${ticketId}: following its turn failed:`, err);
    }
  }

  /** Handle the stream's new complete lines, and with `toEnd` a last line without its newline. */
  private readStream(ticketId: number, live: LiveTurn, toEnd: boolean) {
    let fd: number;
    try {
      fd = openSync(join(live.dir, 'stream.jsonl'), 'r');
    } catch {
      return;
    }
    try {
      let size = 1 << 20;
      for (;;) {
        const buf = Buffer.alloc(size);
        const n = readSync(fd, buf, 0, size, live.offset);
        if (!n) return;
        const atEnd = n < size;
        const end = buf.lastIndexOf(10, n - 1) + 1;
        if (!end && !atEnd) {
          size *= 2; // one line longer than the buffer
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
          } catch (err: any) {
            this.emit(ticketId, 'note', { text: `Could not process output line: ${err.message}` });
          }
          // Saved per line, so a restart carries on from the next one: nothing shown twice or skipped.
          live.offset = base + Math.min(start, take);
          this.saveTurn(ticketId, { offset: live.offset });
        }
        if (atEnd) return;
      }
    } finally {
      closeSync(fd);
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
    clearTimeout(live.stopTimer);
    clearTimeout(live.stopGraceTimer);
    this.turns.delete(ticketId);
    this.spends.delete(ticketId);
    // Kept for the failure note below, which quotes its stderr.
    const secrets = this.secretsOfTurn(ticketId);
    this.turnSecrets.delete(ticketId);
    const turn = this.store.getSetting<TurnState>(turnKey(ticketId));
    this.store.deleteSetting(turnKey(ticketId));
    const stopped = !!turn?.stopped;
    // Its session's cache is warm on this account for the next hour (src/account-pick.ts): its next turn stays there.
    if (turn?.person && !turn.codex && turn.account) this.onRan?.(turn.person, `ticket:${ticketId}`, turn.account);
    if (this.keepalives.delete(ticketId)) return this.wrapUpKeepalive(ticketId, live, turn, exit);
    // Steers that came in as the turn's reply went out never reached claude: they start the next turn.
    const unsent = turn && !stopped ? unsentSteers(turn) : [];
    if (unsent.length) {
      this.queues.set(ticketId, [...(this.queues.get(ticketId) ?? []), ...unsent]);
      this.emit(ticketId, 'note', { text: `${unsent.length === 1 ? 'A message' : `${unsent.length} messages`} arrived as the turn ended, so the next turn picks ${unsent.length === 1 ? 'it' : 'them'} up.` });
    }
    // A Codex turn's log joins its thread's, for the way back to Claude (#337); the turn's folder goes below.
    if (turn?.codex) this.keepCodexLog(ticketId, live.dir);
    const code = exit?.code ?? null;
    const signal = exit ? exit.signal : 'SIGKILL';
    const startError = exit?.error ? `Could not start claude: ${exit.error}` : null;
    if (startError && stopped) this.emit(ticketId, 'error', { text: startError });
    this.statuses.delete(ticketId);
    const sawResult = !!turn?.result;
    const resultIsError = !!turn?.result?.error;
    const resultError = turn?.result?.error ? turn.result.text : null;
    let stderr: string[] = [];
    try {
      stderr = readFileSync(join(live.dir, 'stderr.log'), 'utf8').split('\n').filter(Boolean);
    } catch {
      // No stderr.
    }
    this.approvals.endTurn(ticketId, stopped ? 'The turn was stopped while this waited.' : 'The turn ended while this waited.');
    let status: 'idle' | 'error' = 'idle';
    // Citadel only signals claude on a stop, so any other signal (143 is claude's own exit on SIGTERM) came from outside.
    const killed = !stopped && exit && (exit.signal || code === 143)
      ? `Killed by ${exit.signal ?? 'SIGTERM (exit 143)'} from outside Citadel.\nNobody pressed Stop and turns have no time limit, so most likely ${live.unit ? '' : 'the server restarted (this turn ran without a unit of its own) or '}one of the turn's own commands (a kill or pkill) hit claude's process.`
      // Its wrapper went too, with no record of how: nobody pressed Stop, so it failed (#468 S03-4).
      : !stopped && !exit
        ? `The turn's process was killed before it finished, with no record of how.\nNobody pressed Stop, so most likely its ${live.container ? 'container' : live.unit ? 'unit' : 'process group'} was killed from outside Citadel (out of memory, or stopped).`
        : null;
    if (stopped || (signal && !killed)) {
      // Stopped by the user; leave it waiting for the next message.
    } else if (killed || !sawResult || code !== 0 || resultIsError) {
      status = 'error';
      // A container's sign-in that stopped working: their messages wait until they link again.
      // Not a Codex turn's: its 401 is OpenAI's, and says nothing about the Claude sign-in.
      // A host turn on the server login's own account 1 has no sign-in of Citadel's to expire.
      const authFailed = !!turn?.person && !turn.codex && (!!turn.container || (turn.account ?? 1) > 1) && isAuthFailure(`${resultError ?? ''}\n${stderr.join('\n')}`);
      if (authFailed) this.onAuthFailure?.(turn!.person!, turn!.account);
      const payer = this.payerOf(turn?.person);
      const usage = this.store.getSetting<Usage>(accountUsageKey(payer, turn?.account));
      const codexReset = turn?.codex && turn.person ? codexResetAt(this.store.getSetting<CodexUsage>(codexUsageKey(turn.person))) : undefined;
      const reason = killed || resultError?.trim() || startError;
      const switched = turn ? this.switchAccount(ticketId, turn, reason, usage, authFailed) : null;
      if (authFailed && switched !== true) this.emit(ticketId, 'note', { text: `${this.store.getUser(turn!.person!)?.name ?? 'This person'}'s Claude sign-in expired. Link Claude again in Settings → Your account; their messages wait until then.` });
      if (switched !== true) this.turnFailed(ticketId, reason, hideSecrets(stderr.slice(-10).join('\n'), secrets), code, turn?.limitTries ?? 0, usage, codexReset, turn?.netTries ?? 0, switched ?? undefined);
    } else if (turn?.handBack) {
      // Claude has the Codex turns now.
      this.store.deleteSetting(codexThreadKey(ticketId));
    }
    // A hand-back turn that failed or was stopped may still have done work Codex's thread never saw: the next Codex turn starts a new one from the hand-over.
    const back = turn?.handBack ? this.store.getSetting<CodexThread>(codexThreadKey(ticketId)) : null;
    if (back?.thread) this.store.setSetting(codexThreadKey(ticketId), { ...back, thread: null });
    // A fresh session's handoff is in its transcript once the session exists (#406); then the fresh start's own step, if any.
    if (turn?.handoff && this.store.getTicket(ticketId)?.session_id) this.store.deleteSetting(handoffKey(ticketId));
    this.endFresh(ticketId, turn ?? null, status === 'idle' && !stopped && !signal, stopped);
    // Still parked after answering: the row stays parked, whatever state the turn set. A failed turn keeps its error note.
    const parkedAs = this.parkedAs.get(ticketId);
    this.parkedAs.delete(ticketId);
    if (parkedAs && status !== 'error' && this.heldFor(ticketId)) this.store.updateTicket(ticketId, parkedAs);
    if (status === 'idle' && !stopped && !signal) this.clearFailNote(ticketId);
    const ran = this.store.getTicket(ticketId);
    const ranIn = ran && this.store.getProject(ran.project_id);
    if (status === 'idle' && !stopped && !signal && !turn?.codex && ran && ranIn) {
      if (turn?.person && turn.account) this.onCleared?.(turn.person, turn.account);
      this.limitCleared(this.payerOf(turn?.person), turnSettings(ran, ranIn).model);
    }
    const closing = this.closing.has(ticketId);
    const reason = this.closing.get(ticketId);
    this.closing.delete(ticketId);
    // Checked again here: the turn may have posted a card or set try/ready after close_self.
    // A notice that needs no action (the PR it just merged, #619) doesn't count as a new message; it stays in the chat, unrun.
    const asks = this.queues.get(ticketId)?.some((m) => !m.fyi);
    const keep = closing && status === 'idle' && !stopped && !signal ? (asks ? 'a new message arrived' : this.keptOpen(ticketId)) : null;
    if (closing && status === 'idle' && !stopped && !signal && !keep) {
      this.queues.delete(ticketId);
      this.close(ticketId, `Claude dismissed this minion${reason ? `: ${reason}` : '.'}`);
    } else {
      if (keep) this.emit(ticketId, 'note', { text: `Claude asked to dismiss this minion, but ${keep}, so it stays open.` });
      // The note is for people; the next turn hears it too, so the minion doesn't sit open unaware (#619).
      if (keep) this.store.setSetting(closeCancelledKey(ticketId), keep);
      this.setStatus(ticketId, status);
    }
    if (turn && status === 'idle' && !stopped && !signal && !closing) this.freshAtTurnEnd(ticketId, turn);
    // A real turn that ended well starts a keepalive series from the prefix it cached (#862); anything else ends the series.
    if (turn?.fp && turn.fpParts && status === 'idle' && !stopped && !signal && !closing) this.store.setSetting(keepaliveKey(ticketId), { fp: turn.fp, parts: turn.fpParts, since: Date.now(), ...(turn.light ? { light: true as const } : {}) } satisfies KeepaliveSeries);
    else this.store.deleteSetting(keepaliveKey(ticketId));
    // A failed or stopped turn leaves it open; a queued message makes deployLive wait for that turn too.
    if (this.deployedMidTurn.delete(ticketId) && status === 'idle' && !stopped && !signal && !closing) this.deployLive(ticketId);
    rmSync(live.dir, { recursive: true, force: true });
    this.onFilesMayChange(ticketId);
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
    if (!after || !project) return live.end();
    this.store.setSetting(savingKey(ticketId), { configDir: live.configDir });
    // Messages queued during the turn wait for the save now; a usage-limit wait keeps its own.
    const q = this.queues.get(ticketId);
    if (q?.length && !this.limitWait(ticketId)) this.store.setSetting(waitingKey(ticketId), q);
    this.saveAfterTurn(ticketId, live.configDir, live.had).then(live.end);
  }

  /** A keepalive's end (#862): nothing in the chat or the minion's row; a failure stops its series. Its session is saved as any turn's. */
  private wrapUpKeepalive(ticketId: number, live: LiveTurn, turn: TurnState | null, exit: { code: number | null; signal: string | null; error?: string } | null) {
    this.statuses.delete(ticketId);
    if (turn?.stopped || !exit || exit.signal || exit.code !== 0 || !turn?.result || turn.result.error) {
      console.log(`[keepalive] minion ${ticketId}: its keepalive failed (${exit?.error ?? turn?.result?.text ?? `exit ${exit?.code ?? exit?.signal ?? 'unknown'}`}), so its series stops`);
      this.stopSeries(ticketId, 'failed');
    }
    rmSync(live.dir, { recursive: true, force: true });
    if (!this.store.getTicket(ticketId)) return live.end();
    this.store.setSetting(savingKey(ticketId), { configDir: live.configDir });
    // A message that came in meanwhile waited behind it, as behind any turn.
    const q = this.queues.get(ticketId);
    if (q?.length && !this.limitWait(ticketId)) this.store.setSetting(waitingKey(ticketId), q);
    this.saveAfterTurn(ticketId, live.configDir, live.had).then(live.end);
  }

  /** Copy a minion's session into the database after its turn (or a restart cut that off); never rejects. */
  private async saveAfterTurn(ticketId: number, configDir: string, had: Set<string> | null) {
    try {
      const ticket = this.store.getTicket(ticketId);
      const project = ticket && this.store.getProject(ticket.project_id);
      if (ticket && project) await this.saveSession(this.store, ticket, project, configDir, had);
    } catch (err) {
      console.error(`Saving the session of ticket ${ticketId} failed:`, err);
    } finally {
      this.store.deleteSetting(savingKey(ticketId));
    }
  }

  /** Write a note about a failure, remembered so the next turn that ends well can clear it. */
  private setFailNote(ticketId: number, fields: { note: string; state?: string }) {
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
   * Say why a turn failed, leading with Claude's own words (its result's error, else its last stderr
   * lines). A usage limit is a wait, not an error: no push, and it resumes after the reset. An account
   * problem needs a person: it blocks, never retries, and pushes once for everyone.
   */
  private turnFailed(ticketId: number, reason: string | null, stderr: string, code: number | null, limitTries: number, usage = this.usage, codexReset?: number | null, netTries = 0, allLimited?: AllLimited) {
    const exited = code ? `claude exited with code ${code}` : 'claude ended without finishing';
    const why = reason || stderr;
    const text = why ? `${why}${reason && stderr ? `\n${stderr}` : ''}\n(${exited})` : exited;
    const first = (why || exited).split('\n')[0];
    const short = (s: string) => (s.length > 60 ? s.slice(0, 59) + '…' : s);
    // A deploy still waiting to go live keeps its state, so the deploy can dismiss the minion.
    const keepState = this.store.getTicket(ticketId)?.state === 'pending-deploy';
    if (reason && USAGE_LIMIT.test(reason)) {
      if (limitTries >= MAX_LIMIT_RESUMES) {
        this.emit(ticketId, 'note', { text: `${reason}\nIt has already resumed ${limitTries} times in a row after the usage limit, so it waits for a message now.` });
        if (!keepState) this.store.updateTicket(ticketId, { state: 'limited', note: `Usage limit: gave up after ${limitTries} tries, send a message` });
        this.onTurnError(ticketId, `Usage limit: gave up after ${limitTries} resumes in a row`);
        return;
      }
      // A Codex turn's limit (codexReset is set, maybe null) is Codex's own windows, never Claude's.
      // Every one of several accounts limited (#779): the first of them to reset.
      const resetAt = allLimited?.resetAt ?? this.limitResetAt(reason, usage, codexReset);
      const at = this.waitForLimit(ticketId, resetAt, limitTries + 1, allLimited?.accounts);
      const tail = allLimited?.accounts.length ? allLimitedText(allLimited.accounts, at) : `It resumes by itself at ${clockTime(at)}, or sooner once a turn on this plan gets through (a reset, say); a person's message tries now.`;
      this.emit(ticketId, 'note', { text: `${reason}\n${tail}` });
      if (!keepState) this.store.updateTicket(ticketId, { state: 'limited', note: `Usage limit, resumes ${clockTime(at)}` });
      return;
    }
    if (reason && ACCOUNT_ERROR.test(reason)) {
      this.emit(ticketId, 'error', { text: `${text}\nThis needs a person to sort out the Claude account; it won't retry by itself.` });
      if (!keepState) this.setFailNote(ticketId, { state: 'blocked', note: short(`Needs a person: ${first.replace(/^API Error: \d+ /, '')}`) });
      const last = this.accountPushes.get(first);
      if (last === undefined || Date.now() - last > 60 * 60 * 1000) {
        this.accountPushes.set(first, Date.now());
        this.onTurnError(ticketId, first);
      }
      return;
    }
    // Unreachable network or API: one probe loop waits for it to come back, then resumes (#366). No push: an outage hits everyone at once.
    // Claude's own result words decide when it has them (why); stderr only when it has none.
    const netDown = isNetworkFailure(why);
    if (netDown && netTries < MAX_NET_RESUMES) {
      this.waitForNetwork(ticketId, netTries + 1);
      this.emit(ticketId, 'note', { text: `${text}\nThe network or the API was unreachable, so it resumes by itself once it's back; messages queued behind this turn go into that resume.` });
      this.store.updateTicket(ticketId, { note: NET_NOTE });
      return;
    }
    const event = this.emit(ticketId, 'error', { text: netDown ? `${text}\nIt has already resumed ${netTries} times in a row after a network outage, so it stopped retrying: send a message to carry on.` : text });
    this.setFailNote(ticketId, { note: netDown ? `Network: stopped retrying after ${netTries} resumes` : short(first) });
    this.onTurnError(ticketId, text, event.id);
  }

  /** When a turn's usage limit resets: the windows it hit, else the time Claude's words give, else a while from now. */
  private limitResetAt(reason: string, usage: Usage | null | undefined, codexReset?: number | null): number {
    // A Codex turn's limit (codexReset is set, maybe null) is Codex's own windows, never Claude's.
    const hit = codexReset !== undefined ? (codexReset ? [codexReset] : []) : [usage?.session, usage?.weekly].filter((w) => w?.status === 'rejected' && w.resetsAt && w.resetsAt > Date.now()).map((w) => w!.resetsAt!);
    return hit.length ? Math.max(...hit) : parseResetTime(reason) ?? Date.now() + this.limitFallbackMs;
  }

  /**
   * A Claude turn on one of its person's accounts hit that account's usage limit, or lost its sign-in (#779): the
   * account is marked, and when another is ready the turn carries on with it now, a switch that isn't one of
   * MAX_LIMIT_RESUMES (true). Else, on a limit with several accounts, when the first of them resets; null otherwise.
   */
  private switchAccount(ticketId: number, turn: TurnState, reason: string | null, usage: Usage | null, authFailed: boolean): true | AllLimited | null {
    const person = turn.person;
    if (!person || turn.codex || turn.account === undefined || turn.stopped) return null;
    const limit = !!reason && USAGE_LIMIT.test(reason);
    if (!limit && !authFailed) return null;
    const several = (this.claudeAccounts?.(person)?.accounts.length ?? 0) > 1;
    let next: { n: number; label: string } | null = null;
    if (limit) {
      const r = this.onLimit?.(person, turn.account, this.limitResetAt(reason!, usage));
      if (!r) return null;
      if (!r.next) {
        if (!several) return null;
        const kind = /weekly/i.test(reason!) ? 'weekly' : /(\d+)-hour/i.exec(reason!)?.[0].toLowerCase();
        const accounts = (r.limits ?? []).map((l) => ({ ...l, ...(l.n === turn.account ? { here: true, ...(kind ? { kind } : {}) } : {}) }));
        return { resetAt: r.resetAt, accounts };
      }
      next = r.next;
    } else {
      const acc = this.claudeAccounts?.(person);
      const n = acc?.inUse;
      next = n && n !== turn.account ? acc!.accounts.find((a) => a.n === n) ?? null : null;
      if (!next) return null;
    }
    const why = limit ? reason! : `This account's Claude sign-in expired: link it again in Settings → Your account.`;
    this.emit(ticketId, 'note', { text: `${why}\nCarrying on with ${next.label} (account ${next.n}): this turn picks up where it stopped.` });
    this.resume(ticketId, 0, turn.limitTries ?? 0, false, 0, true);
    return true;
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
    let ev: any;
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
      if (this.quietSince(ticketId, live) === null && this.store.getSetting<TurnState>(turnKey(ticketId))?.quiet) this.checkQuiet(ticketId, live);
    }
    // A keepalive (#862) shows nothing: only its session id and its cost are kept.
    if (this.keepalives.has(ticketId)) {
      if (validSessionId(ev.session_id) && ev.session_id !== this.store.getTicket(ticketId)?.session_id) this.store.updateTicket(ticketId, { session_id: ev.session_id });
      if (ev.type === 'result') onResult(!!ev.is_error, typeof ev.result === 'string' ? ev.result : null);
      if (ev.type === 'result' && typeof ev.total_cost_usd === 'number') this.keepaliveResult(ticketId, ev);
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
    // Each main-thread API call re-reads the whole context: its input is the context's size.
    const u = ev.type === 'assistant' && !ev.parent_tool_use_id ? ev.message?.usage : null;
    if (u) this.contextSizes.set(ticketId, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
    if (ev.type === 'result' && this.contextSizes.has(ticketId)) {
      this.store.setSetting(contextKey(ticketId), this.contextSizes.get(ticketId));
      this.contextSizes.delete(ticketId);
    }
    if (ev.type === 'assistant') {
      // An alert is extra: a failure in it must not cost the line its place in the chat.
      try {
        this.meterSpend(ticketId, ev);
      } catch (err: any) {
        console.error(`[spend] minion ${ticketId}: metering failed:`, err.message);
      }
    }
    if (DROPPED_TYPES.has(ev.type)) return;
    // Joined into paths and passed to --resume later, and a container can write its stream: only what looks like an id.
    if (validSessionId(ev.session_id) && ev.session_id !== this.store.getTicket(ticketId)?.session_id) {
      this.store.updateTicket(ticketId, { session_id: ev.session_id });
    }
    if (ev.type === 'result') onResult(!!ev.is_error, typeof ev.result === 'string' ? ev.result : null);
    if (ev.type === 'assistant' && !ev.parent_tool_use_id && Array.isArray(ev.message?.content)) ev = this.stripStatus(ticketId, ev);
    if (ev.type === 'result') {
      const status = this.statuses.get(ticketId);
      this.statuses.delete(ticketId);
      if (status && !ev.is_error) this.onStatusTrailer(ticketId, status);
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
    const slim = slimEvent(ev);
    if (!slim) return;
    const progress = this.progressFor(ticketId);
    const row = this.emit(ticketId, 'claude', slim);
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
    if (ev.type === 'user' && (ev.message?.content ?? []).some?.((b: any) => typeof b?.text === 'string' && b.text.includes(SENT_BACK))) this.sentBack.add(ticketId);
    // shortcut: a turn stopped, or the server restarted, before the result keeps both versions; rare, so left.
    if (ev.type === 'result' && this.sentBack.delete(ticketId)) this.replaceSentBack(ticketId, row.id);
    if (ev.type === 'result' && typeof ev.total_cost_usd === 'number') {
      const state = this.store.getSetting<TurnState>(turnKey(ticketId));
      const turn = this.store.recordTurn(ticketId, {
        event_id: row.id, session_id: typeof ev.session_id === 'string' ? ev.session_id : null, ended_at: row.created_at,
        session_cost_usd: ev.total_cost_usd, duration_ms: ev.duration_ms, usage: ev.usage,
        payer: this.payerOf(state?.person), hashes: state?.hashes ?? null,
        account: state?.account ?? null, modelUsage: ev.modelUsage,
      });
      this.broadcast({ type: 'turn', turn, projectId: this.store.getTicket(ticketId)?.project_id });
      this.recordGrunts(ticketId, turn.id, state, ev.session_id);
    }
    if (ev.type === 'user' && Array.isArray(ev.message?.content) && ev.message.content.some((b: any) => b?.type === 'tool_result')) {
      this.onFilesMayChange(ticketId);
    }
    this.notePushes(ticketId, ev);
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
  private meterSpend(ticketId: number, ev: any) {
    const turn = this.store.getSetting<TurnState>(turnKey(ticketId));
    if (!turn?.startedAt || turn.codex) return;
    let spend = this.spends.get(ticketId);
    if (spend?.startedAt !== turn.startedAt) this.spends.set(ticketId, spend = { startedAt: turn.startedAt, meter: new SpendMeter(turn.spend) });
    const { meter } = spend;
    if (!meter.add(ev)) return;
    const stage = meter.crossed(stagesFrom(this.store.getSetting(STAGES_SETTING)));
    this.saveTurn(ticketId, { spend: meter.state });
    if (stage === null) return;
    const text = spendText(meter.usd, Date.now() - turn.startedAt);
    console.log(`[spend] minion ${ticketId}: passed $${stage}, about $${meter.usd.toFixed(2)}`);
    const row = this.emit(ticketId, 'spend', { text, usd: Math.round(meter.usd), stage, turn: turn.startedAt });
    meter.alert = { stage, event: row.id, at: row.created_at };
    this.saveTurn(ticketId, { spend: meter.state });
    this.broadcastTicket(ticketId); // the list row's badge and Needs you
    this.onSpendAlert(ticketId, text, row.id, turn.person ?? null);
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
  private stripStatus(ticketId: number, ev: any): any {
    let changed = false;
    const content = ev.message.content.flatMap((b: any) => {
      if (b?.type !== 'text' || typeof b.text !== 'string') return [b];
      const { text, status, bad } = takeStatus(b.text);
      if (text === b.text) return [b];
      changed = true;
      if (status) this.statuses.set(ticketId, status);
      if (bad) {
        // A later reply's bad line (a sent-back reply's rewrite) doesn't let an earlier reply's line stand.
        this.statuses.delete(ticketId);
        console.log(`[status] minion ${ticketId}: ignored a status trailer, ${bad}`);
        this.emit(ticketId, 'note', { text: `The reply's status line was ignored (${bad}), so the state stays as it was.` });
      }
      return text ? [{ ...b, text }] : [];
    });
    return changed ? { ...ev, message: { ...ev.message, content } } : ev;
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
    const words = (data: any) => data.type === 'assistant' && !data.parent_tool_use_id && (data.message?.content ?? []).some((b: any) => b?.type === 'text' && b.text?.trim());
    const sentBack = (data: any) => data.type === 'user' && Array.isArray(data.message?.content)
      && data.message.content.some((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.includes(SENT_BACK));
    const swaps: { original: EventRow; rewrite?: EventRow }[] = [];
    let last: EventRow | null = null;
    for (const e of this.store.eventsPage(ticketId, resultId, 1).events) {
      if (e.kind !== 'claude') continue;
      const data = JSON.parse(e.data);
      if (sentBack(data)) {
        if (last) swaps.push({ original: last });
      } else if (words(data)) {
        last = e;
        const open = swaps.at(-1);
        if (open && open.original !== e) open.rewrite = e;
      }
    }
    const text = (data: any) => data.message.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('').trim();
    for (const { original, rewrite } of swaps) {
      if (!rewrite) continue;
      // A bare KEEP stands by the first version (#404): the KEEP is what gives way.
      const [gone, by] = text(JSON.parse(rewrite.data)).replace(/[*_.!]/g, '').toUpperCase() === KEEP ? [rewrite, original] : [original, rewrite];
      const data = JSON.parse(gone.data);
      if (data.replaced) continue;
      this.store.setEventData(gone.id, { ...data, replaced: by.id });
      this.emit(ticketId, 'replaced', { event: gone.id, by: by.id });
    }
  }

  /** The running turn's latest context size, saved when it ends (contextKey). */
  private contextSizes = new Map<number, number>();

  /** Bash calls that push or open a pull request, by tool_use id, until their result comes back. */
  private pushCalls = new Map<string, 'push' | 'pr'>();

  /** A note in the chat for each push or pull request, saying whose GitHub it went out as (Cara's pick: "only a chat note"). */
  private notePushes(ticketId: number, ev: any) {
    const blocks: any[] = Array.isArray(ev.message?.content) ? ev.message.content : [];
    for (const b of blocks) {
      if (ev.type === 'assistant' && b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string' && typeof b.id === 'string') {
        const kind = pushKind(b.input.command);
        if (kind) this.pushCalls.set(b.id, kind);
      }
      if (ev.type !== 'user' || b?.type !== 'tool_result' || !this.pushCalls.has(b.tool_use_id)) continue;
      const kind = this.pushCalls.get(b.tool_use_id)!;
      this.pushCalls.delete(b.tool_use_id);
      const turn = this.store.getSetting<TurnState>(turnKey(ticketId));
      // Absent: GitHub linking isn't set up, and the box's own login pushes as before.
      if (turn?.github === undefined) continue;
      const who = turn.person ? this.store.getUser(turn.person)?.name ?? 'Its person' : 'Nobody';
      if (turn.github && !b.is_error) this.emit(ticketId, 'note', { text: kind === 'pr' ? `Opened a pull request as @${turn.github} (${who}'s GitHub)` : `Pushed as @${turn.github} (${who}'s GitHub)` });
      else if (!turn.github && b.is_error) this.emit(ticketId, 'note', { text: `Couldn't ${kind === 'pr' ? 'open a pull request' : 'push'}: this turn runs for ${who}, who hasn't linked GitHub. Link it in Settings → Your account.` });
    }
  }

  /**
   * Say so in the chat (as an error, which pushes) when the turn's own MCP server didn't connect:
   * without it a minion can't set its status or ask questions, and a Taskmaster can't manage minions.
   */
  private checkMcp(ticketId: number, servers: any[]) {
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
  private checkLoadErrors(ticketId: number, ev: any) {
    const line = (e: any, kind: string) => {
      const name = typeof e === 'object' ? e?.plugin ?? e?.name ?? e?.server : null;
      const why = typeof e === 'string' ? e : e?.error ?? e?.message ?? JSON.stringify(e);
      return `${name ? `${name} ` : ''}${kind}: ${why}`;
    };
    const role = this.store.getTicket(ticketId)?.kind === 'coordinator' ? 'coordinator' : 'thread';
    // The turn's own server already got checkMcp's error.
    const lines = [
      ...(Array.isArray(ev.plugin_errors) ? ev.plugin_errors.map((e: any) => line(e, 'plugin')) : []),
      ...(Array.isArray(ev.mcp_server_errors) ? ev.mcp_server_errors.filter((e: any) => e?.name !== role).map((e: any) => line(e, 'MCP server')) : []),
    ];
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
      this.store.addStepTimes(ticketId, p.finished, light ? 'low' : t?.last_effort ?? t?.effort ?? null);
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
  private payerView(uid: number | null): { id: number | null; name: string } | null {
    if (!uid) return null;
    const id = this.payerOf(uid);
    const name = this.store.getUser(id ?? this.store.serverLoginOwner() ?? uid)?.name;
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
  usageOf(uid: number | null | undefined): (Usage & { account?: number; why?: string; pinned?: number; accounts?: { n: number; label: string; usage: Usage | null }[] }) | null {
    const payer = this.payerOf(uid);
    const acc = uid ? this.claudeAccounts?.(uid) : null;
    const usage = this.store.getSetting<Usage>(accountUsageKey(payer, acc?.inUse ?? 1));
    if (!acc || acc.accounts.length < 2) return usage;
    // `account` is where a new or cold turn goes now, and `why` (#793): its week resets soonest, it's pinned, or every account is near full.
    return { ...(usage ?? { weekly: null, session: null, updatedAt: 0 }), account: acc.inUse ?? 1, ...(acc.why ? { why: acc.why } : {}), ...(acc.pinned ? { pinned: acc.pinned } : {}),
      accounts: acc.accounts.map((a) => ({ ...a, usage: this.store.getSetting<Usage>(accountUsageKey(payer, a.n)) })) };
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
      return !!t && (t.person_id ?? this.store.getProject(t.project_id)?.owner_id) === uid;
    };
    // Due now, on Codex, spaced limitGapMs apart like any limit resume.
    const list = this.limitResumes();
    if (list.some(mine)) this.saveLimitResumes(list.map((w) => (mine(w) ? { ...w, at: Date.now(), tries: 0, codex: true as const } : w)));
    return null;
  }

  /** Record a Codex turn's usage windows (account/rateLimits) as its person's, for their usage bar. */
  updateCodexUsage(l: any, person: number | null) {
    const w = (x: any) => (x && typeof x.usedPercent === 'number' ? { usedPercent: x.usedPercent, windowDurationMins: typeof x.windowDurationMins === 'number' ? x.windowDurationMins : null, resetsAt: typeof x.resetsAt === 'number' ? x.resetsAt : null } : null);
    if (person === null || !l) return;
    this.store.setSetting(codexUsageKey(person), { primary: w(l.primary), secondary: w(l.secondary), updatedAt: Date.now() });
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
  private updateUsage(info: any, ticketId?: number) {
    const turn = ticketId === undefined ? null : this.store.getSetting<TurnState>(turnKey(ticketId));
    this.recordUsage(info, turn?.container && turn.person ? turn.person : null, turn?.person ?? null, turn?.account);
  }

  /** Record a Claude turn's `rate_limit_info` on `account` of `payer` (null: the server login), a minion's or an app's (#793). */
  recordUsage(info: any, payer: number | null, person: number | null, account?: number) {
    const windows = info?.unifiedWindows;
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
    this.broadcast({ type: 'usage', usage: person ? this.usageOf(person) ?? usage : usage, payer });
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

  emit(ticketId: number, kind: string, data: unknown): EventRow {
    // A split scheme's Overlord asks for everyone (#921): its cards show in every member's chat (#920 reads the flag). A note is for
    // everyone only when its emitter says so (`everyone: true`, and only on the Overlord): most are one person's.
    const lord = (EVERYONES.has(kind) || (data as { everyone?: unknown } | null)?.everyone === true) && this.isOverlord(this.store.getTicket(ticketId));
    // The flag goes last, whatever order the caller wrote it in: the db's `data LIKE '{"text":…'` queries match a prefix.
    if (data && typeof data === 'object' && 'everyone' in data) { const { everyone: _, ...rest } = data as Record<string, unknown>; data = rest; }
    if (lord) data = { ...(data as object), everyone: true };
    const row = this.store.addEvent(ticketId, kind, data);
    this.broadcast({ type: 'event', event: row });
    if (CARD_KINDS.has(kind)) this.refreshRefs(ticketId);
    return row;
  }

  /** A minion's cards waiting on people, oldest first, each with the link that opens it (#400); `placed` adds where each sits (CardLink.below). */
  cardLinks(ticket: Ticket, placed = false, open?: EventRow[]): CardLink[] {
    if (ticket.status === 'closed') return [];
    const minion = ticket.kind === 'coordinator' ? null : ticket.number;
    const link = (kind: CardLink['kind'], data: unknown, eventId: number): CardLink => ({
      minion, kind, what: cardWhat(kind, data), label: cardLabel(kind, data), href: cardHref(ticket, eventId), ...((data as { to?: string })?.to ? { to: (data as { to: string }).to } : {}),
      ...((data as { doc?: { path: string } })?.doc ? { doc: (data as { doc: { path: string } }).doc.path } : {}),
      // Only question and plan cards are held under the turn's words (public/thread.js heldCards).
      ...(placed ? { below: kind !== 'approval' && this.store.heldBelow(ticket.id, eventId) } : {}),
    });
    const asks = this.approvals.pending().filter((a) => a.ticketId === ticket.id).flatMap((a) => {
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

  /**
   * Read each scheme's newest cards' rows into the store's memory in small steps, yielding between them, so the first
   * refsShared after a restart doesn't read 500 scattered rows in one go (Store.warmCardRows). Quits on its own errors.
   */
  async warmCards(chunk = 25, pauseMs = 5) {
    try {
      for (const p of this.store.listProjects()) {
        while (this.store.warmCardRows(p.id, 500, chunk) > 0) await new Promise((r) => setTimeout(r, pauseMs));
        await new Promise((r) => setTimeout(r, pauseMs));
      }
    } catch (err) {
      console.warn('warming card rows failed:', err);
    }
  }

  /** What every turn's scheme-refs snapshot in a scheme shares, read once however many turns run there (#609). */
  refsShared(projectId: number) {
    const tickets = this.store.listTickets(projectId);
    const links = new Map(tickets.map((t) => [t.id, this.cardLinks(t)]));
    const open = new Set([...links.values()].flat().map((c) => c.href));
    return { project: this.store.getProject(projectId)!, projects: this.store.listProjects(), tickets, links, settled: this.settledCards(projectId, open) };
  }

  /** Write a turn's scheme-refs snapshot (scheme-refs.ts) for `ticket`, with its scheme's cards waiting on people. */
  private writeRefs(file: string, ticket: Ticket, shared = this.refsShared(ticket.project_id)) {
    const { project, projects, tickets, links, settled } = shared;
    // Only the turn's own cards say where each sits (`placed`).
    const cards = { self: ticket.kind === 'coordinator' ? null : ticket.number, cards: tickets.flatMap((t) => t.id === ticket.id ? this.cardLinks(t, true) : links.get(t.id)!) };
    const refs = { ...schemeRefs(project, projects, tickets, cards), settled };
    // Whole or not at all: the link check may read it mid-turn.
    writeFileSync(`${file}.new`, JSON.stringify(refs));
    renameSync(`${file}.new`, file);
  }

  /** A card was posted or settled in `ticketId`'s chat: the running turns of its scheme get it in their snapshot, so the link check knows it. */
  private refreshRefs(ticketId: number) {
    const projectId = this.store.getTicket(ticketId)?.project_id;
    let shared: ReturnType<Runner['refsShared']> | undefined;
    for (const [id, turn] of this.turns) {
      const t = this.store.getTicket(id);
      const file = join(turn.dir, 'scheme-refs.json');
      if (t?.project_id !== projectId || !existsSync(file)) continue;
      try {
        this.writeRefs(file, t, shared ??= this.refsShared(projectId));
      } catch {
        // A stale snapshot only means a card goes unchecked.
      }
    }
  }
}
