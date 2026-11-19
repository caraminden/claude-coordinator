// A Taskmaster's fresh Claude session (#406): the handoff turn, the reset, the fresh session's first
// prompt, the /compact fallback, Stop, and the idle sweep and turn end (#423) that start it by itself.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { FRESH_CONTEXT_TOKENS, FRESH_IDLE_CONTEXT_TOKENS, FRESH_IDLE_MS, Runner } from '../src/runner.ts';
import { transcriptPath } from '../src/sessions.ts';
import { jsonLines, lines, stopTurns, testPins, until } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'fresh-session-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const calls = join(root, 'calls.jsonl');
// A stand-in for `claude -p`: logs its argv and prompt, says which session it runs (the one it resumes,
// else a new one), reports a context size (20k, or the size file's), then, once it has its prompt, ends the turn when its folder's release file says ok or error.
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, unlinkSync } = require('node:fs');
const args = process.argv.slice(2);
const r = args.indexOf('--resume');
const session = r >= 0 ? args[r + 1] : 'new-' + Date.now();
let input = '';
process.stdin.on('data', (d) => {
  if (input.includes('\\n')) return;
  input += d;
  if (!input.includes('\\n')) return;
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, prompt: JSON.parse(input.split('\\n')[0]).message.content }) + '\\n');
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }));
  const sizeFile = ${JSON.stringify(join(root, 'size'))};
  const size = existsSync(sizeFile) ? Number(readFileSync(sizeFile, 'utf8')) - 10 : 20000;
  console.log(JSON.stringify({ type: 'assistant', session_id: session, message: { content: [], usage: { input_tokens: 10, cache_read_input_tokens: size } } }));
  waitForRelease();
});
// The release file is in the turn's folder, so a turn a failed test left running can't take the next test's.
// Only once the prompt is logged: tests write release right after the turn starts, often before this
// process has read its stdin, and a turn ended first would log no call and report no size (#470).
const waitForRelease = () => { const wait = setInterval(() => {
  const release = 'release';
  if (!existsSync(release)) return;
  clearInterval(wait);
  const outcome = readFileSync(release, 'utf8');
  unlinkSync(release); // one turn's release, never the next turn's too
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: outcome === 'error', result: outcome.startsWith('ok:') ? outcome.slice(3) : 'done', session_id: session }));
  process.exit(0);
}, 20); };
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const runner = new Runner(store, () => {}, () => ({}), fake);

let n = 0;
/** A Taskmaster (or a minion) with a session whose transcript is on this login, so its turns resume it. */
function taskmaster(session = 'old', kind: 'coordinator' | null = 'coordinator') {
  const project = store.createProject(`P${++n}`, null);
  const t = store.createTicket({ project_id: project.id, title: kind ? 'Taskmaster' : 'Minion', permission_mode: 'default', created_by: 'Cara', ...(kind ? { kind } : {}) });
  const cwd = join(root, `tm${n}`);
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  store.updateTicket(t.id, { session_id: session, status: 'idle' });
  const file = transcriptPath(process.env.CLAUDE_CONFIG_DIR!, cwd, session);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{}\n');
  return t.id;
}

// The waits give up (helpers' until, 30 s): they, not a limit per test, fail a turn that never comes. Each turn costs
// two node starts, so on a starved box a six-turn test takes 20 s and more without anything being wrong (#470).
async function started(id: number) {
  await until('the turn to start', () => runner.isRunning(id));
}

/** End the running turn; returns once the server has handled its end, though a queued turn may have started since. */
async function endTurn(id: number, outcome: 'ok' | 'error' | `ok:${string}`) {
  const turn = () => store.getSetting<{ startedAt: number }>(`turn:${id}`)?.startedAt;
  const was = turn();
  writeFileSync(join(store.getTicket(id)!.cwd, 'release'), outcome);
  await until('the turn to end', () => turn() !== was);
}

/** The last turn's argv and prompt, once the fake has logged it. */
async function lastCall(count: number) {
  const all = await until('the fake to log its call', () => { const a = jsonLines(calls); return a.length > count && a; });
  return all[all.length - 1] as { args: string[]; prompt: any };
}
const callCount = () => lines(calls).length;
const promptText = (p: any) => (typeof p === 'string' ? p : p.map((b: any) => b.text).join('\n'));
const notes = (id: number) => store.listEvents(id).filter((e) => e.kind === 'note').map((e) => JSON.parse(e.data).text as string);
const waitIdle = async (id: number) => {
  await until('the turn to go idle', () => !runner.isRunning(id) && store.getTicket(id)!.status !== 'running');
};

test('only a chat with a session, and not a dismissed minion, can start fresh', () => {
  const project = store.createProject('Minions', null);
  const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  assert.equal(runner.requestFresh(minion.id, 'test'), 'Its session is already fresh');
  store.updateTicket(minion.id, { session_id: 'old', status: 'closed' });
  assert.match(runner.requestFresh(minion.id, 'test')!, /^A dismissed minion keeps its session/);
  // A minion has no fresh_session: its handoff is its reply (#937).
  store.updateTicket(minion.id, { status: 'idle' });
  assert.equal(runner.recordHandoff(minion.id, 'x'), 'Only a Taskmaster starts fresh sessions');
  const id = taskmaster();
  store.updateTicket(id, { session_id: null });
  assert.equal(runner.requestFresh(id, 'test'), 'Its session is already fresh');
  assert.equal(runner.recordHandoff(id, 'x'), 'Only a running turn can hand off');
});

test('the handoff turn resumes the old session; the next turn starts a new one from the handoff', async () => {
  const id = taskmaster();
  let count = callCount();
  assert.equal(runner.requestFresh(id, 'Cara asked for it'), null);
  assert.equal(runner.requestFresh(id, 'again'), 'A fresh start is already under way');
  assert.equal(runner.view(store.getTicket(id)!).fresh_pending, true);
  await started(id);
  const handoffTurn = await lastCall(count);
  assert.deepEqual(handoffTurn.args.slice(handoffTurn.args.indexOf('--resume'), handoffTurn.args.indexOf('--resume') + 2), ['--resume', 'old']);
  assert.match(promptText(handoffTurn.prompt), /Cara asked for it[\s\S]*Call fresh_session/);
  // A message sent meanwhile waits for the fresh session rather than steering into the old one.
  runner.send(id, 'Cara', 'what is open?', [], {}, true);
  assert.equal(runner.queued(id), 1);
  assert.equal(runner.recordHandoff(id, 'Open: #12 waits on a pick from Cara.'), null);
  count = callCount();
  await endTurn(id, 'ok');
  // The reset: the session goes, the chat gets its marker, and the queued message starts the new session.
  const fresh = store.listEvents(id).filter((e) => e.kind === 'fresh').map((e) => JSON.parse(e.data));
  assert.deepEqual(fresh, [{ summary: 'Open: #12 waits on a pick from Cara.', why: 'Cara asked for it' }]);
  await started(id);
  const first = await lastCall(count);
  assert.ok(!first.args.includes('--resume'), 'a new session, not a resume');
  assert.match(promptText(first.prompt), /fresh Claude session[\s\S]*Open: #12 waits on a pick from Cara\.[\s\S]*\[Cara\]: what is open\?/);
  assert.equal(runner.view(store.getTicket(id)!).fresh_pending, false);
  count = callCount();
  await endTurn(id, 'ok');
  const session = store.getTicket(id)!.session_id!;
  assert.match(session, /^new-/);
  writeFileSync(transcriptPath(process.env.CLAUDE_CONFIG_DIR!, store.getTicket(id)!.cwd, session), '{}\n');
  // Once the new session exists, the handoff is in its transcript and isn't sent again.
  runner.send(id, 'Cara', 'thanks');
  await started(id);
  const second = await lastCall(count);
  assert.ok(second.args.includes('--resume'));
  assert.doesNotMatch(promptText(second.prompt), /Open: #12/);
  await endTurn(id, 'ok');
});

test('a message queued when a manual fresh start\'s handoff turn starts is in that turn\'s record, so a restart keeps it (#468 S03-3)', async () => {
  const id = taskmaster();
  const before = callCount();
  runner.send(id, 'Cara', 'first');
  await started(id);
  await lastCall(before);
  runner.send(id, 'Cara', 'm1 queued');
  assert.equal(runner.requestFresh(id, 'test'), null);
  const count = callCount();
  await endTurn(id, 'ok');
  await started(id);
  const handoff = await lastCall(count);
  assert.match(promptText(handoff.prompt), /Call fresh_session/);
  assert.doesNotMatch(promptText(handoff.prompt), /m1 queued/);
  // What reattach and recover read back after a restart.
  assert.deepEqual(store.getSetting<any>(`turn:${id}`)?.queued?.map((m: any) => m.text), ['m1 queued']);
  assert.equal(store.getSetting(`waiting:${id}`), null, 'no stale wait left for the next turn to drop');
  assert.equal(runner.queued(id), 1);
  assert.equal(runner.recordHandoff(id, 'Nothing open.'), null);
  await endTurn(id, 'ok');
  await started(id);
  assert.match(promptText((await lastCall(count + 1)).prompt), /m1 queued/);
  await endTurn(id, 'ok');
  await waitIdle(id);
});

test("a minion's /fresh (#937): its handoff turn's reply, status line left out, is what its fresh session starts from", async () => {
  const id = taskmaster('old', null);
  let count = callCount();
  assert.equal(runner.requestFresh(id, 'Cara asked for it'), null);
  await started(id);
  const handoffTurn = await lastCall(count);
  assert.ok(handoffTurn.args.includes('--resume'));
  assert.match(promptText(handoffTurn.prompt), /Cara asked for it[\s\S]*reply with your handoff/);
  assert.doesNotMatch(promptText(handoffTurn.prompt), /fresh_session/);
  count = callCount();
  await endTurn(id, 'ok:Branch ticket/9 has the fix committed; Cara picked tabs.\n\n<!-- status: {"state":null} -->');
  await waitIdle(id);
  const fresh = store.listEvents(id).filter((e) => e.kind === 'fresh').map((e) => JSON.parse(e.data));
  assert.deepEqual(fresh, [{ summary: 'Branch ticket/9 has the fix committed; Cara picked tabs.', why: 'Cara asked for it' }]);
  assert.equal(store.getTicket(id)!.session_id, null);
  assert.ok(notes(id).some((t) => /the minion writes its handoff first/.test(t)));
  runner.send(id, 'Cara', 'carry on');
  await started(id);
  const first = await lastCall(count);
  assert.ok(!first.args.includes('--resume'));
  assert.match(promptText(first.prompt), /fresh Claude session[\s\S]*Cara picked tabs\.[\s\S]*carry on/);
  await endTurn(id, 'ok');
});

test('a Taskmaster that hands off on its own resets when its turn ends', async () => {
  const id = taskmaster();
  runner.send(id, 'Cara', 'tidy up your context');
  await started(id);
  assert.equal(runner.recordHandoff(id, 'Nothing open.'), null);
  await endTurn(id, 'ok');
  await waitIdle(id);
  assert.equal(store.getTicket(id)!.session_id, null);
  assert.deepEqual(store.listEvents(id).filter((e) => e.kind === 'fresh').map((e) => JSON.parse(e.data).why), ['the Taskmaster asked for it']);
});

test('no handoff falls back on /compact, alone as the whole prompt, and keeps the session', async () => {
  const id = taskmaster();
  const count = callCount();
  runner.requestFresh(id, 'test');
  await started(id);
  await lastCall(count);
  const before = callCount();
  await endTurn(id, 'error');
  // The compaction starts by itself once the handoff turn ends.
  await started(id);
  const compact = await lastCall(before);
  assert.equal(typeof compact.prompt, 'string');
  assert.match(compact.prompt, /^\/compact /);
  assert.ok(compact.args.includes('--resume'));
  await endTurn(id, 'ok');
  await waitIdle(id);
  assert.equal(store.getTicket(id)!.session_id, 'old');
  assert.equal(runner.view(store.getTicket(id)!).fresh_pending, false);
  assert.ok(notes(id).some((t) => /No handoff came back \(the turn failed\)/.test(t)));
  assert.ok(notes(id).includes("Compacted the Taskmaster's session instead of a fresh start."));
  assert.equal(store.listEvents(id).filter((e) => e.kind === 'fresh').length, 0);
});

test('stopping the handoff turn calls the fresh start off', async () => {
  const id = taskmaster();
  runner.requestFresh(id, 'test');
  await started(id);
  runner.stop(id);
  await waitIdle(id);
  assert.equal(store.getTicket(id)!.session_id, 'old');
  assert.equal(runner.view(store.getTicket(id)!).fresh_pending, false);
  assert.ok(notes(id).some((t) => /stopped, so the fresh start is off/.test(t)));
});

test('the idle sweep starts fresh only past the idle time and the context size', async () => {
  const now = Date.now();
  const due = taskmaster();
  const small = taskmaster();
  const recent = taskmaster();
  for (const [id, size, ended] of [[due, FRESH_IDLE_CONTEXT_TOKENS + 1, now - FRESH_IDLE_MS], [small, FRESH_IDLE_CONTEXT_TOKENS, now - FRESH_IDLE_MS], [recent, FRESH_IDLE_CONTEXT_TOKENS + 1, now - FRESH_IDLE_MS + 60_000]]) {
    store.setSetting(`context:${id}`, size);
    store.recordTurn(id, { event_id: null, session_id: 'old', ended_at: ended, session_cost_usd: 0, duration_ms: 1, usage: {} } as any);
  }
  runner.freshSweep(now);
  assert.equal(runner.view(store.getTicket(due)!).fresh_pending, true);
  assert.match(notes(due).at(-1)!, /idle 55 m with 60k context/);
  assert.equal(runner.view(store.getTicket(small)!).fresh_pending, false);
  assert.equal(runner.view(store.getTicket(recent)!).fresh_pending, false);
  // Let it run out: no handoff, then the compaction.
  await started(due);
  await endTurn(due, 'ok');
  await started(due);
  await endTurn(due, 'ok');
  await waitIdle(due);
});

test('a fresh start that cannot run a turn gives up once, not every minute', async () => {
  const id = taskmaster();
  const now = Date.now();
  store.setSetting(`context:${id}`, FRESH_IDLE_CONTEXT_TOKENS + 1);
  store.recordTurn(id, { event_id: null, session_id: 'old', ended_at: now - FRESH_IDLE_MS, session_cost_usd: 0, duration_ms: 1, usage: {} } as any);
  runner.placeFor = () => ({ refused: 'No Claude login for this turn.' });
  try {
    runner.freshSweep(now);
    await new Promise((r) => setTimeout(r, 50)); // its lane frees up
    runner.freshSweep(now + 60_000);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    runner.placeFor = undefined;
  }
  assert.equal(runner.isRunning(id), false);
  assert.equal(runner.view(store.getTicket(id)!).fresh_pending, false);
  assert.equal(notes(id).filter((t) => t.startsWith('Starting a fresh session')).length, 1);
  assert.ok(notes(id).includes('The fresh start could not run a turn, so the Taskmaster keeps its session.'));
});

test('a fresh start whose turn throws as it starts gives up, and does not spin the server (C2)', async () => {
  const id = taskmaster();
  let calls = 0;
  let timerFired = false;
  let spun = false;
  // Stands in for any synchronous throw in startTurn (a full disk, say): placeFor is its first call. The lane
  // frees in a microtask and asks again, so unfixed this never lets a timer run; the cap ends the test's loop.
  runner.placeFor = () => {
    if (++calls > 1 && !timerFired) spun = true;
    if (calls > 500) return { refused: 'cap' };
    throw new Error('ENOSPC (simulated)');
  };
  setTimeout(() => (timerFired = true), 0);
  const was = console.error;
  console.error = () => {};
  try {
    try {
      runner.requestFresh(id, 'test');
    } catch {
      // Whether the caller hears of it is not the point.
    }
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    runner.placeFor = undefined;
    console.error = was;
  }
  assert.equal(spun, false, `asked ${calls} times before a timer could fire`);
  assert.equal(timerFired, true);
  assert.equal(calls, 1);
  assert.equal(store.getSetting(`fresh:${id}`), null);
  assert.equal(runner.isRunning(id), false);
  assert.ok(notes(id).includes('The fresh start could not run a turn, so the Taskmaster keeps its session.'));
});

/** Every turn's reported context size from now on (the fake reads it as the turn starts). */
const contextSize = (tokens: number | null) => (tokens === null ? rmSync(join(root, 'size'), { force: true }) : writeFileSync(join(root, 'size'), String(tokens)));
const freshNotes = (id: number) => notes(id).filter((t) => t.startsWith('Starting a fresh session'));
/** The prompts of the turns started since count, once there are want of them. */
async function prompts(count: number, want: number) {
  await until('the fake to log its calls', () => callCount() >= count + want);
  return jsonLines(calls).slice(count).map((l) => promptText(l.prompt));
}

test('61k of context: an idle Taskmaster hands off, one whose turn just ended does not (Cara 2026-11-15)', async () => {
  assert.equal(FRESH_IDLE_CONTEXT_TOKENS, 60_000);
  try {
    const working = taskmaster();
    contextSize(61_000);
    runner.send(working, 'Cara', 'hi');
    await started(working);
    await endTurn(working, 'ok');
    await waitIdle(working);
    // Its save, after which a fresh start would run: a worker thread that takes most of a second on a loaded box.
    await until('its save', () => store.getSetting(`saving:${working}`) == null);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(runner.isRunning(working), false);
    assert.equal(runner.view(store.getTicket(working)!).fresh_pending, false);
    // The same 61k, once it has sat idle, does hand off.
    store.recordTurn(working, { event_id: null, session_id: 'old', ended_at: Date.now(), session_cost_usd: 0, duration_ms: 1, usage: {} } as any);
    runner.freshSweep(Date.now() + FRESH_IDLE_MS + 1000);
    assert.equal(runner.view(store.getTicket(working)!).fresh_pending, true);
    await started(working);
    await endTurn(working, 'ok');
    await started(working);
    await endTurn(working, 'ok');
    await waitIdle(working);
  } finally {
    contextSize(null);
  }
});

test('a Taskmaster turn that ends past 150k hands off at once; one at 150k does not (#423)', async () => {
  try {
    const small = taskmaster();
    contextSize(FRESH_CONTEXT_TOKENS);
    runner.send(small, 'Cara', 'hi');
    await started(small);
    await endTurn(small, 'ok');
    await waitIdle(small);
    await until('its save', () => store.getSetting(`saving:${small}`) == null); // after which a fresh start would run
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(runner.isRunning(small), false);
    assert.equal(runner.view(store.getTicket(small)!).fresh_pending, false);

    const big = taskmaster();
    contextSize(FRESH_CONTEXT_TOKENS + 1);
    const count = callCount();
    runner.send(big, 'Cara', 'hi');
    await started(big);
    await endTurn(big, 'ok');
    await started(big);
    assert.match((await prompts(count, 2))[1], /150k tokens of context at the end of a turn[\s\S]*Call fresh_session/);
    assert.deepEqual(freshNotes(big), ['Starting a fresh session (150k tokens of context at the end of a turn): the Taskmaster writes its handoff first.']);
    assert.equal(runner.recordHandoff(big, 'Nothing open.'), null);
    await endTurn(big, 'ok');
    await waitIdle(big);
    assert.equal(store.getTicket(big)!.session_id, null);
  } finally {
    contextSize(null);
  }
});

test("a minion's turn past 150k never hands off", async () => {
  const project = store.createProject(`Minion ${++n}`, null);
  const t = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(root, `m${n}`);
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  try {
    contextSize(FRESH_CONTEXT_TOKENS + 1);
    runner.send(t.id, 'Cara', 'hi');
    await started(t.id);
    await endTurn(t.id, 'ok');
    await waitIdle(t.id);
    await until('its save', () => store.getSetting(`saving:${t.id}`) == null); // after which a fresh start would run
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(runner.isRunning(t.id), false);
    assert.equal(store.getSetting(`fresh:${t.id}`), null);
  } finally {
    contextSize(null);
  }
});

test('messages queued during a big turn run first, and the last of their turns hands off', async () => {
  const id = taskmaster();
  try {
    contextSize(FRESH_CONTEXT_TOKENS + 1);
    const count = callCount();
    runner.send(id, 'Cara', 'first');
    await started(id);
    runner.send(id, 'Josh', 'waiting');
    assert.equal(runner.queued(id), 1);
    await endTurn(id, 'ok');
    await started(id);
    assert.match((await prompts(count, 2))[1], /\[Josh\]: waiting/);
    assert.equal(runner.view(store.getTicket(id)!).fresh_pending, false);
    await endTurn(id, 'ok');
    await started(id);
    assert.match((await prompts(count, 3))[2], /end of a turn[\s\S]*Call fresh_session/);
    // Let it run out: no handoff, then the compaction.
    await endTurn(id, 'ok');
    await started(id);
    await endTurn(id, 'ok');
    await waitIdle(id);
  } finally {
    contextSize(null);
  }
});

test('a message that arrives once a fresh start Citadel asked for is pending still goes first', async () => {
  const id = taskmaster();
  const count = callCount();
  runner.send(id, 'Cara', 'first');
  await started(id);
  // As the idle sweep or a turn's end asks: the message queued meanwhile isn't held behind the handoff.
  assert.equal(runner.requestFresh(id, 'test', true), null);
  runner.send(id, 'Josh', 'waiting');
  await endTurn(id, 'ok');
  await started(id);
  assert.match((await prompts(count, 2))[1], /\[Josh\]: waiting/);
  await endTurn(id, 'ok');
  await started(id);
  assert.match((await prompts(count, 3))[2], /Call fresh_session/);
  assert.equal(runner.recordHandoff(id, 'Nothing open.'), null);
  await endTurn(id, 'ok');
  await waitIdle(id);
  assert.equal(store.getTicket(id)!.session_id, null);
});

test('a message sent during an automatic handoff turn that writes none goes before the compaction', async () => {
  const id = taskmaster();
  const count = callCount();
  assert.equal(runner.requestFresh(id, 'test', true), null);
  await started(id);
  runner.send(id, 'Josh', 'waiting');
  await endTurn(id, 'ok');
  await started(id);
  assert.match((await prompts(count, 2))[1], /\[Josh\]: waiting/);
  await endTurn(id, 'ok');
  await started(id);
  assert.match((await prompts(count, 3))[2], /^\/compact /);
  await endTurn(id, 'ok');
  await waitIdle(id);
  assert.equal(runner.view(store.getTicket(id)!).fresh_pending, false);
});

test('a handoff and compaction that leave it big do not loop; the next real turn hands off again', async () => {
  const id = taskmaster();
  try {
    contextSize(FRESH_CONTEXT_TOKENS + 1);
    const count = callCount();
    runner.send(id, 'Cara', 'hi');
    await started(id);
    await endTurn(id, 'ok');
    // The handoff turn writes no handoff, so the compaction; both still report a big context.
    await started(id);
    await endTurn(id, 'ok');
    await started(id);
    await endTurn(id, 'ok');
    await waitIdle(id);
    await until('its save', () => store.getSetting(`saving:${id}`) == null); // after which another fresh start would run
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(runner.isRunning(id), false);
    assert.equal(callCount(), count + 3, 'the turn, the handoff and the compaction, and nothing after');
    assert.equal(runner.view(store.getTicket(id)!).fresh_pending, false);
    assert.equal(freshNotes(id).length, 1);
    // The idle check doesn't ask again either: the compaction left its size unknown.
    runner.freshSweep(Date.now() + FRESH_IDLE_MS);
    assert.equal(runner.view(store.getTicket(id)!).fresh_pending, false);
    // A real turn that still ends big hands off again.
    runner.send(id, 'Cara', 'more');
    await started(id);
    await endTurn(id, 'ok');
    await started(id);
    assert.equal(freshNotes(id).length, 2);
    await endTurn(id, 'ok');
    await started(id);
    await endTurn(id, 'ok');
    await waitIdle(id);
  } finally {
    contextSize(null);
  }
});
