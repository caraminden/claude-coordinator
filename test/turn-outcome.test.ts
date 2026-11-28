// One table over every way a turn ends (ADR 0024, seam 2): the kind, its follow-ups and the resume it earns, with no
// process and no fake claude. The runner's own tests (auto-resume, kill-resume, usage-limit, network-resume) check it
// carries them out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRetries, outcome, RETRIES, retriesOf, type EndedTurn, type Retries, type TurnEnd } from '../src/turn-outcome.ts';

const ok = { error: false, text: 'done' };
const end = (over: Partial<TurnEnd> & { turn?: EndedTurn | null } = {}): TurnEnd => ({
  turn: { result: ok },
  exit: { code: 0, signal: null },
  stderr: [],
  closing: false,
  ran: { unit: true, container: false },
  ...over,
});
const LIMIT = "Claude AI usage limit reached: You've hit your session limit · resets 3pm";
const onAccount = (turn: EndedTurn = {}) => ({ person: 7, account: 2, result: { error: true, text: LIMIT }, ...turn });

const rows: [string, TurnEnd, Partial<ReturnType<typeof outcome>>][] = [
  ['ended well', end(), { kind: 'ok', followUps: ['cleared', 'fresh', 'deploy-note'] }],
  ['ended well with a cached prefix', end({ turn: { result: ok, fp: 'f', fpParts: { a: 'b' } } }), { kind: 'ok', followUps: ['cleared', 'fresh', 'deploy-note', 'keepalive'] }],
  ["a fresh step's turn ended well", end({ turn: { result: ok, fresh: 'handoff' } }), { kind: 'ok', followUps: ['cleared', 'fresh', 'deploy-note'] }],
  ['ended well after close_self', end({ closing: true }), { kind: 'closing', followUps: ['cleared', 'close'] }],
  ['stopped', end({ turn: { stopped: true }, exit: { code: null, signal: 'SIGTERM' } }), { kind: 'stopped', followUps: [] }],
  ['stopped, even after close_self', end({ turn: { stopped: true, result: ok }, closing: true }), { kind: 'stopped' }],
  ['a pause stopped it: resumes, and counts towards no cap', end({ turn: { paused: true, retries: { kill: 1 } }, exit: { code: null, signal: 'SIGINT' } }), { kind: 'paused', followUps: [], retry: { via: 'restart', retries: { kill: 1 } } }],
  ['a pause landed after it had finished: ended as any finished turn, not run again', end({ turn: { paused: true, result: ok } }), { kind: 'ok', followUps: ['cleared', 'fresh', 'deploy-note'], retry: undefined }],
  ['a pause landed after a turn set to close had finished: still closes', end({ turn: { paused: true, result: ok }, closing: true }), { kind: 'closing', followUps: ['cleared', 'close'], retry: undefined }],
  ['a pause interrupted it: claude exits 0 with an error result', end({ turn: { paused: true, result: { error: true, text: 'interrupted' } } }), { kind: 'paused', retry: { via: 'restart', retries: {} } }],
  ['a pause signalled it with its result in: still resumes', end({ turn: { paused: true, result: ok }, exit: { code: null, signal: 'SIGINT' } }), { kind: 'paused', retry: { via: 'restart', retries: {} } }],
  ['a person stopped it during the pause', end({ turn: { paused: true, stopped: true }, exit: { code: null, signal: 'SIGINT' } }), { kind: 'stopped', retry: undefined }],
  ['killed by a signal', end({ turn: {}, exit: { code: null, signal: 'SIGKILL' } }), { kind: 'killed', retry: { via: 'kill', retries: { kill: 1 } } }],
  ['killed with no record of how', end({ turn: {}, exit: null }), { kind: 'killed', retry: { via: 'kill', retries: { kill: 1 } } }],
  ['exit 143 is a kill', end({ turn: {}, exit: { code: 143, signal: null } }), { kind: 'killed', retry: { via: 'kill', retries: { kill: 1 } } }],
  ['killed again in a row: stops for good', end({ turn: { retries: { kill: 1, restart: 1 } }, exit: null }), { kind: 'killed', spent: { via: 'kill', tries: 1 } }],
  ['a kill carries the restart count', end({ turn: { retries: { restart: 1, limit: 2 } }, exit: null }), { retry: { via: 'kill', retries: { kill: 1, restart: 1 } } }],
  ['a killed fresh step is not resumed', end({ turn: { fresh: 'compact' }, exit: null }), { kind: 'killed', retry: undefined, spent: undefined }],
  ['a killed turn set to close is not resumed', end({ turn: { closing: null }, exit: null }), { kind: 'killed', retry: undefined }],
  ['killed after its result is not resumed', end({ turn: { result: ok }, exit: { code: null, signal: 'SIGKILL' } }), { kind: 'killed', retry: undefined }],
  ['usage limit', end({ turn: { result: { error: true, text: LIMIT } }, exit: { code: 1, signal: null } }), { kind: 'limit', reason: LIMIT, retry: { via: 'limit', retries: { limit: 1 } } }],
  ['usage limit, the third in a row', end({ turn: { result: { error: true, text: LIMIT }, limitTries: 3 } }), { kind: 'limit', spent: { via: 'limit', tries: 3 } }],
  ['a limit on a linked account asks the account pick', end({ turn: onAccount() }), { kind: 'switch-account', askAccount: true }],
  ['another account is ready', end({ turn: onAccount({ retries: { limit: 1, net: 2 } }), account: 'ready' }), { kind: 'switch-account', retry: { via: 'switch', retries: { switch: 1, limit: 1 } } }],
  ['every account limited', end({ turn: onAccount(), account: 'all-limited' }), { kind: 'limit', retry: { via: 'limit', retries: { limit: 1 } }, switchesSpent: undefined }],
  ['no other account', end({ turn: onAccount(), account: null }), { kind: 'limit', retry: { via: 'limit', retries: { limit: 1 } } }],
  [`switched ${RETRIES.switch.cap} times in a row: waits out the limit`, end({ turn: onAccount({ retries: { switch: RETRIES.switch.cap } }), account: 'ready' }), { kind: 'limit', switchesSpent: RETRIES.switch.cap, retry: { via: 'limit', retries: { limit: 1 } } }],
  ['a Codex limit never switches Claude accounts', end({ turn: onAccount({ codex: true }) }), { kind: 'limit', askAccount: undefined }],
  ['an expired sign-in on account 2 asks the account pick', end({ turn: { person: 7, account: 2, result: { error: true, text: 'API Error: 401 authentication_error' } } }), { kind: 'switch-account', authFailed: true, askAccount: true }],
  ['an expired sign-in with no other account fails', end({ turn: { person: 7, account: 2, result: { error: true, text: 'API Error: 401 authentication_error' } }, account: null }), { kind: 'failed', authFailed: true }],
  ['account 1 on the host has no sign-in of ours', end({ turn: { person: 7, account: 1, result: { error: true, text: 'API Error: 401 authentication_error' } } }), { kind: 'failed', authFailed: false }],
  ['account error', end({ turn: { result: { error: true, text: 'API Error: 400 Identity verification is required to continue.' } } }), { kind: 'account-error' }],
  ['network', end({ turn: { result: { error: true, text: "API Error: Can't reach the API server (EAI_AGAIN)" } } }), { kind: 'net', retry: { via: 'net', retries: { net: 1 } } }],
  ['network from stderr, with no words of its own', end({ turn: {}, exit: { code: 1, signal: null }, stderr: ['x', 'connect ECONNREFUSED'] }), { kind: 'net' }],
  ['network, the third in a row', end({ turn: { result: { error: true, text: 'stream disconnected' }, netTries: 3 } }), { kind: 'net', spent: { via: 'net', tries: 3 } }],
  ['a resume claude found no conversation for', end({ turn: { result: { error: true, text: 'No conversation found with session ID: fbebd8df-fae5' } } }), { kind: 'no-session', noSession: 'fbebd8df-fae5' }],
  ['the same words on stderr only', end({ turn: {}, exit: { code: 1, signal: null }, stderr: ['No conversation found with session ID: abc-1'] }), { kind: 'no-session', noSession: 'abc-1' }],
  ['a warm-up that found no conversation just fails', end({ turn: { keepalive: true, result: { error: true, text: 'No conversation found with session ID: abc-1' } } }), { kind: 'failed' }],
  ['a fresh start that found no conversation just fails', end({ turn: { fresh: 'step', result: { error: true, text: 'No conversation found with session ID: abc-1' } } }), { kind: 'failed' }],
  ['failed: retried once (#2258)', end({ turn: { result: { error: true, text: 'boom' } } }), { kind: 'failed', reason: 'boom', retry: { via: 'fail', retries: { fail: 1 } } }],
  ['exited with no result: retried once', end({ turn: {}, exit: { code: 0, signal: null } }), { kind: 'failed', retry: { via: 'fail', retries: { fail: 1 } } }],
  ['failed again after its retry: stops, spent', end({ turn: { result: { error: true, text: 'boom' }, retries: { fail: 1 } } }), { kind: 'failed', retry: undefined, spent: { via: 'fail', tries: 1 } }],
  ["a failed turn's retry carries the kill and restart counts", end({ turn: { result: { error: true, text: 'boom' }, retries: { kill: 1, restart: 1, net: 2 } } }), { retry: { via: 'fail', retries: { fail: 1, kill: 1, restart: 1 } } }],
  ['a failed Codex turn is not retried', end({ turn: { codex: true, result: { error: true, text: 'boom' } } }), { kind: 'failed', retry: undefined, spent: undefined }],
  ['a failed warm-up is not retried', end({ turn: { keepalive: true, result: { error: true, text: 'boom' } } }), { kind: 'failed', retry: undefined, spent: undefined }],
  ['a failed fresh step is not retried', end({ turn: { fresh: 'step', result: { error: true, text: 'boom' } } }), { kind: 'failed', retry: undefined, spent: undefined }],
  ['a failed turn set to close is not retried', end({ turn: { closing: 'done', result: { error: true, text: 'boom' } } }), { kind: 'failed', retry: undefined, spent: undefined }],
  ['an expired sign-in is not retried', end({ turn: { person: 7, account: 2, result: { error: true, text: 'API Error: 401 authentication_error' } }, account: null }), { kind: 'failed', authFailed: true, retry: undefined, spent: undefined }],
  ['a stopped turn is not retried', end({ turn: { stopped: true, result: { error: true, text: 'boom' } }, exit: { code: 1, signal: null } }), { kind: 'stopped', retry: undefined }],
  ['an account error is not retried', end({ turn: { result: { error: true, text: 'API Error: 400 Identity verification is required to continue.' } } }), { kind: 'account-error', retry: undefined }],
  ['could not start', end({ turn: null, exit: { code: null, signal: null, error: 'ENOENT' } }), { kind: 'failed', reason: 'Could not start claude: ENOENT', retry: undefined }],
  ['a restart cut it off', end({ turn: { resumes: 1, killTries: 1 }, cut: { rerun: false } }), { kind: 'killed', retry: { via: 'restart', retries: { restart: 2, kill: 1 } } }],
  ['a restart cut off a turn people started', end({ turn: null, cut: { rerun: false } }), { kind: 'killed', retry: { via: 'restart', retries: { restart: 1 } } }],
  ['a restart cut it off, twice in a row already', end({ turn: { retries: { restart: 2 } }, cut: { rerun: false } }), { kind: 'killed', spent: { via: 'restart', tries: 2 } }],
  ['a restart cut off a turn a pause stopped, at the cap', end({ turn: { paused: true, retries: { restart: 2 } }, cut: { rerun: false } }), { kind: 'paused', retry: { via: 'restart', retries: { restart: 2 } } }],
  ['a restart cut it off before claude had its prompt', end({ cut: { rerun: true } }), { kind: 'killed', followUps: ['rerun'], retry: undefined }],
  ['a restart cut off a stopped turn', end({ turn: { stopped: true }, cut: { rerun: true } }), { kind: 'stopped' }],
  ['a restart cut off a turn set to close', end({ turn: { closing: 'done' }, cut: { rerun: false } }), { kind: 'killed', retry: undefined, spent: undefined }],
  // 2A1: a kill after the result line, read by recover's reattach: ended as the watched path ends it, not resumed.
  ['a restart cut it off after its result', end({ turn: { result: ok }, cut: { rerun: false } }), { kind: 'killed', followUps: [], retry: undefined, spent: undefined }],
  ['a restart cut it off after an error result: still resumed', end({ turn: { result: { error: true, text: LIMIT } }, cut: { rerun: false } }), { kind: 'killed', retry: { via: 'restart', retries: { restart: 1 } } }],
];

for (const [name, input, want] of rows) {
  test(`outcome: ${name}`, () => {
    const got = outcome(input);
    for (const [k, v] of Object.entries(want)) assert.deepEqual((got as any)[k], v, `${k} of ${JSON.stringify(got)}`);
  });
}

test('every kind has a row', () => {
  const kinds = new Set(rows.map(([, input]) => outcome(input).kind));
  for (const k of ['ok', 'stopped', 'paused', 'closing', 'limit', 'net', 'switch-account', 'account-error', 'killed', 'no-session', 'failed']) assert.ok(kinds.has(k as any), k);
});

test("today's caps are unchanged, and an account switch has one", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(RETRIES).map(([k, v]) => [k, v.cap])), { restart: 2, kill: 1, limit: 3, net: 3, switch: 3, fail: 1 });
});

test('a resume carries only the counts its row keeps', () => {
  const r: Retries = { restart: 1, kill: 1, limit: 2, net: 1, switch: 1 };
  assert.deepEqual(nextRetries(r, 'restart'), { restart: 2, kill: 1 });
  assert.deepEqual(nextRetries(r, 'kill'), { kill: 2, restart: 1 });
  assert.deepEqual(nextRetries(r, 'limit'), { limit: 3 });
  assert.deepEqual(nextRetries(r, 'net'), { net: 2 });
  assert.deepEqual(nextRetries(r, 'switch'), { switch: 2, limit: 2 });
  assert.deepEqual(nextRetries({ ...r, fail: 1 }, 'fail'), { fail: 2, restart: 1, kill: 1 });
});

test('a row saved before the retries record reads its four counters', () => {
  assert.deepEqual(retriesOf({ resumes: 1, limitTries: 2, netTries: 0, killTries: 1 }), { restart: 1, limit: 2, kill: 1 });
  assert.deepEqual(retriesOf({ resumes: 0 }), {});
  assert.deepEqual(retriesOf({ retries: { net: 1 }, resumes: 2 }), { net: 1 });
});

test('a SIGABRT is put down to claude aborting itself, with the cause its stderr shows, not to a kill or a restart', () => {
  const killed = (stderr: string[], signal = 'SIGABRT') => String(outcome(end({ turn: {}, exit: { code: null, signal }, stderr, ran: { unit: true, container: true } })).killed);
  const quiet = killed([]);
  assert.match(quiet, /^Claude crashed with SIGABRT\./);
  assert.match(quiet, /couldn't start a thread or a process/);
  assert.doesNotMatch(quiet, /outside Citadel|pkill|server restarted/);
  const threads = killed(['x', 'panic: pthread_create at postgres://u:hunter2hunter2@h: Resource temporarily unavailable', 'y']);
  assert.match(threads, /its last output says it couldn't start a thread or a process\./);
  assert.doesNotMatch(threads, /hunter2|panic/, 'stderr can hold a secret, so none of it is quoted');
  // The newest telling line wins: an EAGAIN at launch isn't why the heap ran out later, nor the other way round.
  const eagain = "The shared tool server didn't start (spawn EAGAIN); this turn runs its own helpers.";
  const heap = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';
  assert.match(killed([eagain, heap, 'a trace']), /it ran out of memory\./);
  assert.match(killed([heap, eagain]), /it couldn't start a thread or a process\./);
  assert.match(killed(['FATAL ERROR: JavaScript heap out of memory']), /its last output says it ran out of memory\./);
  assert.match(killed([], 'SIGKILL'), /^Killed by SIGKILL from outside Citadel\./);
});
