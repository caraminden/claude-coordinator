/**
 * What an ended turn means (ADR 0024, seam 2): one pure function from how a turn ended to its kind and what follows,
 * which the runner's wrap-up and its restart recovery both call, so a killed turn is judged by the same rows with or
 * without a restart. A new way for a turn to end is a new row here, not another resume path in src/runner.ts.
 */
import { isAuthFailure } from './claude-link.ts';
import { USAGE_LIMIT } from './turn-launch.ts';
import type { AwayEnd } from './machine-turn.ts';

/** Claude's words for an account problem only a person can fix, like "API Error: 400 Identity verification is required to continue.": never retried. */
export const ACCOUNT_ERROR = /identity verification|credit balance|oauth token|invalid api key|run \/login|organization has been disabled/i;

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

export type Kind = 'ok' | 'stopped' | 'paused' | 'away' | 'card' | 'closing' | 'limit' | 'net' | 'switch-account' | 'account-error' | 'killed' | 'failed';

/**
 * What an ending sets off besides its kind. A turn that ended well: `cleared` (its failure note, the limits it proved
 * gone, a Codex hand-back's thread, its fresh step's end as done), and unless it closes: `fresh` (a Taskmaster past its
 * context mark starts fresh), `keepalive` (a series from its cached prefix) and
 * `deploy-note` (a deploy that went live mid-turn). `close` dismisses the minion; `rerun` runs the batch of a turn a
 * restart cut off before claude had it as a plain turn.
 */
export type FollowUp = 'cleared' | 'close' | 'fresh' | 'keepalive' | 'deploy-note' | 'rerun';

/** The ways the server carries a turn on by itself, each counted in a row. */
export type RetryKind = 'restart' | 'kill' | 'limit' | 'net' | 'switch';
/** Auto-resumes in a row that led to a turn, by kind; empty for a turn people or GitHub started. */
export type Retries = Partial<Record<RetryKind, number>>;

/**
 * Each retry's cap (resumes in a row before it waits for a person), and the other counts its resume carries on; the
 * rest start again from 0, as each path did before this table.
 */
export const RETRIES: Record<RetryKind, { cap: number; keeps: RetryKind[] }> = {
  // A turn a restart cut off, in case its own turn is what kills the server.
  restart: { cap: 2, keeps: ['kill'] },
  // Killed from outside (RL1, #1364). Cara, 2026-11-20: "So if it crashes again would it stop for good? I dont want to
  // get in restart loops": a second kill in a row stops for good. The restart count rides along, so the two caps together end a loop.
  kill: { cap: 1, keeps: ['restart'] },
  limit: { cap: 3, keeps: [] },
  net: { cap: 3, keeps: [] },
  // Onto another of its person's Claude accounts (#779): bounded only by a ready account until #1379. Three is one
  // turn round the most accounts a person links (MAX_ACCOUNTS) and back; past it, it waits as if none were ready.
  switch: { cap: 3, keeps: ['limit'] },
};

/** The counts a `kind` resume of a turn with `r` starts with. */
export function nextRetries(r: Retries, kind: RetryKind): Retries {
  const next: Retries = { [kind]: (r[kind] ?? 0) + 1 };
  for (const k of RETRIES[kind].keeps) if (r[k]) next[k] = r[k];
  return next;
}

/** The fields of a saved turn this reads. The four counters are rows saved before the retries record (#1379). */
export interface EndedTurn {
  stopped?: true;
  /** A pause stopped it to carry on later (#1868). */
  paused?: true;
  /** Ended while only its approval card waited: the answer resumes it (#1916). */
  card?: true;
  closing?: string | null;
  result?: { error: boolean; text: string | null };
  fresh?: string;
  keepalive?: true;
  fp?: string;
  fpParts?: Record<string, string>;
  person?: number | null;
  codex?: true;
  container?: string;
  account?: number;
  retries?: Retries;
  resumes?: number;
  limitTries?: number;
  netTries?: number;
  killTries?: number;
}

/** A saved turn's retries, read from its record or, on a row saved before it, its four counters. */
export function retriesOf(turn: EndedTurn | null | undefined): Retries {
  if (!turn) return {};
  if (turn.retries) return turn.retries;
  const r: Retries = {};
  if (turn.resumes) r.restart = turn.resumes;
  if (turn.limitTries) r.limit = turn.limitTries;
  if (turn.netTries) r.net = turn.netTries;
  if (turn.killTries) r.kill = turn.killTries;
  return r;
}

export interface TurnEnd {
  turn: EndedTurn | null;
  /** How its process exited; null when it was killed with no record of how. */
  exit: { code: number | null; signal: string | null; error?: string; away?: AwayEnd } | null;
  /** Its stderr, line by line. */
  stderr: string[];
  /** It asked to close after this turn (close_self). */
  closing: boolean;
  /** Where it ran, for the kill's words. */
  ran: { unit: boolean; container: boolean };
  /** A restart found its process gone (recover): `rerun` when its batch went back because claude never had it. */
  cut?: { rerun: boolean };
  /**
   * The account pick's answer, once asked (an outcome with `askAccount`): another account is ready, every one of
   * several is limited, or neither.
   */
  account?: 'ready' | 'all-limited' | null;
}

export interface Outcome {
  kind: Kind;
  followUps: FollowUp[];
  /** Why it failed: the kill, Claude's own error, or claude's start error. */
  reason: string | null;
  /** The kill's words, when it was killed from outside, or the crash's when claude aborted itself (SIGABRT). */
  killed: string | null;
  /** Its account's sign-in stopped working. */
  authFailed: boolean;
  /** Another account may carry it on: ask the account pick (which marks this one), then call again with `account`. */
  askAccount?: true;
  /** The resume this ending earns, with the counts its turn starts with. */
  retry?: { via: RetryKind; retries: Retries };
  /** The resume it would have earned, had it not already run `tries` of them in a row. */
  spent?: { via: RetryKind; tries: number };
  /** Another account was ready, but it had already switched this many times in a row, so it didn't. */
  switchesSpent?: number;
}

/** What claude's stderr says when it was refused a thread or process, or memory. */
const NO_THREADS = /pthread|resource temporarily|EAGAIN/i;
const NO_MEMORY = /out of memory|allocation failed/i;

/** What `end` means: its kind, what follows, and the resume it earns. Pure: the caller carries it out. */
export function outcome(end: TurnEnd): Outcome {
  const { turn, exit } = end;
  const r = retriesOf(turn);
  const stopped = !!turn?.stopped;
  const base = { reason: null, killed: null, authFailed: false };
  if (end.cut) return cutOutcome(turn, r, end.cut.rerun);
  if (stopped) return { kind: 'stopped', followUps: [], ...base };
  if (turn?.card) return { kind: 'card', followUps: [], ...base };
  // Not the turn's doing, so it counts towards no cap. Not one that had already finished (a good result, a clean exit): a
  // pause landing that late would run it again. An interrupted claude's result is an error, even on exit 0.
  const finished = !!turn?.result && !turn.result.error && exit?.code === 0 && !exit.signal;
  if (turn?.paused && !finished) return { kind: 'paused', followUps: [], ...base, retry: { via: 'restart', retries: r } };
  // Its machine was away too long (Build 7 T6): carried on elsewhere, from its last checkpoint, and counted towards no cap.
  if (exit?.away && !finished) return { kind: 'away', followUps: [], ...base, retry: { via: 'restart', retries: r } };
  const code = exit?.code ?? null;
  // Citadel never sends SIGABRT: claude raises it on itself when it can't go on (#1848: five turns whose container was refused threads).
  const abort = exit?.signal === 'SIGABRT';
  // The newest line that says why, in our words, never stderr's own: it can hold a secret, and this goes in the chat.
  const said = end.stderr.findLast((l) => NO_THREADS.test(l) || NO_MEMORY.test(l)) ?? '';
  const why = NO_THREADS.test(said) ? "it couldn't start a thread or a process" : said ? 'it ran out of memory' : null;
  // Citadel only signals claude on a stop, so any other signal (143 is claude's own exit on SIGTERM) came from outside.
  const killed = abort
    ? `Claude crashed with SIGABRT.\nIt stops itself this way when it can't go on: ${why ? `its last output says ${why}` : "most likely it couldn't start a thread or a process, or it ran out of memory"}.`
    : exit && (exit.signal || code === 143)
      ? `Killed by ${exit.signal ?? 'SIGTERM (exit 143)'} from outside Citadel.\nNobody pressed Stop and turns have no time limit, so most likely ${end.ran.unit ? '' : 'the server restarted (this turn ran without a unit of its own) or '}one of the turn's own commands (a kill or pkill) hit claude's process.`
      : // Its wrapper went too, with no record of how: nobody pressed Stop, so it failed (#468 S03-4).
        !exit
        ? `The turn's process was killed before it finished, with no record of how.\nNobody pressed Stop, so most likely its ${end.ran.container ? 'container' : end.ran.unit ? 'unit' : 'process group'} was killed from outside Citadel (out of memory, or stopped).`
        : null;
  const sawResult = !!turn?.result;
  const resultError = turn?.result?.error ? turn.result.text : null;
  if (!killed && sawResult && code === 0 && !turn?.result?.error) {
    if (end.closing) return { kind: 'closing', followUps: ['cleared', 'close'], ...base };
    const followUps: FollowUp[] = ['cleared', 'fresh', 'deploy-note'];
    if (turn?.fp && turn.fpParts) followUps.push('keepalive');
    return { kind: 'ok', followUps, ...base };
  }
  const startError = exit?.error ? `Could not start claude: ${exit.error}` : null;
  const reason = killed || resultError?.trim() || startError;
  // A container's sign-in that stopped working. Not a Codex turn's: its 401 is OpenAI's, and says nothing about the
  // Claude sign-in. A host turn on the server login's own account 1 has no sign-in of Citadel's to expire.
  const limit = !!reason && USAGE_LIMIT.test(reason);
  const authFailed = !!turn?.person && !turn.codex && (!!turn.container || (turn.account ?? 1) > 1) && isAuthFailure(`${resultError ?? ''}\n${end.stderr.join('\n')}`);
  // Another of its person's Claude accounts carries a limited or signed-out turn on, first of all.
  const switchable = !!turn?.person && !turn.codex && turn.account !== undefined && (limit || authFailed);
  if (switchable && end.account === undefined) return { kind: 'switch-account', followUps: [], reason, killed, authFailed, askAccount: true };
  const switches = r.switch ?? 0;
  if (switchable && end.account === 'ready' && switches < RETRIES.switch.cap) return { kind: 'switch-account', followUps: [], reason, killed, authFailed, retry: { via: 'switch', retries: nextRetries(r, 'switch') } };
  // An account was ready, but it had switched as often as it may: it goes on as if none were.
  const failed = { followUps: [] as FollowUp[], reason, killed, authFailed, ...(switchable && end.account === 'ready' ? { switchesSpent: switches } : {}) };
  // Killed from outside before it finished: resumed once; a fresh-start step or a turn set to close isn't carried on.
  if (killed && turn && !sawResult && !authFailed && !turn.fresh && turn.closing === undefined) return { kind: 'killed', ...failed, ...retry(r, 'kill') };
  if (killed) return { kind: 'killed', ...failed };
  if (limit) return { kind: 'limit', ...failed, ...retry(r, 'limit') };
  if (reason && ACCOUNT_ERROR.test(reason)) return { kind: 'account-error', ...failed };
  // Claude's own result words decide when it has them; its last stderr lines only when it has none.
  if (isNetworkFailure(reason || end.stderr.slice(-10).join('\n'))) return { kind: 'net', ...failed, ...retry(r, 'net') };
  return { kind: 'failed', ...failed };
}

/** A restart found the turn's process gone: resumed, under the restart cap, unless stopped, set to close or its reply in. */
function cutOutcome(turn: EndedTurn | null, r: Retries, rerun: boolean): Outcome {
  const base = { reason: null, killed: null, authFailed: false };
  if (turn?.stopped) return { kind: 'stopped', followUps: [], ...base };
  if (turn?.card) return { kind: 'card', followUps: [], ...base };
  if (rerun) return { kind: 'killed', followUps: ['rerun'], ...base };
  // Its reply is in (a kill after a good result line): ended as the watched path ends it, killed with no resume (2A1).
  // An error result (a limit, say) left the work undone, so it still resumes.
  if ((turn?.result && !turn.result.error) || turn?.closing !== undefined) return { kind: 'killed', followUps: [], ...base };
  // A pause stopped it, so its resume counts towards no cap here either.
  if (turn?.paused) return { kind: 'paused', followUps: [], ...base, retry: { via: 'restart', retries: r } };
  return { kind: 'killed', followUps: [], ...base, ...retry(r, 'restart') };
}

/** The resume `via` earns, or that its cap is spent. */
function retry(r: Retries, via: RetryKind): Pick<Outcome, 'retry' | 'spent'> {
  const tries = r[via] ?? 0;
  return tries < RETRIES[via].cap ? { retry: { via, retries: nextRetries(r, via) } } : { spent: { via, tries } };
}
