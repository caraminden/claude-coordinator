// A Taskmaster's fresh Claude session (#406): the handoff turn, the reset, the fresh session's first
// prompt, the /compact fallback, Stop, and the idle sweep that starts it by itself.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { FRESH_CONTEXT_TOKENS, FRESH_IDLE_MS, Runner } from '../src/runner.ts';
import { transcriptPath } from '../src/sessions.ts';
import { stopTurns } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'fresh-session-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const calls = join(root, 'calls.jsonl');
// A stand-in for `claude -p`: logs its argv and prompt, says which session it runs (the one it resumes,
// else a new one), reports a context size, then ends the turn once the release file says ok or error.
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
  console.log(JSON.stringify({ type: 'assistant', session_id: session, message: { content: [], usage: { input_tokens: 10, cache_read_input_tokens: 20000 } } }));
});
const wait = setInterval(() => {
  const release = ${JSON.stringify(join(root, 'release'))};
  if (!existsSync(release)) return;
  clearInterval(wait);
  const outcome = readFileSync(release, 'utf8');
  unlinkSync(release); // one turn's release, never the next turn's too
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: outcome === 'error', result: 'done', session_id: session }));
  process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const runner = new Runner(store, () => {}, () => ({}), fake);

let n = 0;
/** A Taskmaster with a session whose transcript is on this login, so its turns resume it. */
function taskmaster(session = 'old') {
  const project = store.createProject(`P${++n}`, null);
  const t = store.createTicket({ project_id: project.id, title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara', kind: 'coordinator' });
  const cwd = join(root, `tm${n}`);
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  store.updateTicket(t.id, { session_id: session, status: 'idle' });
  const file = transcriptPath(process.env.CLAUDE_CONFIG_DIR!, cwd, session);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{}\n');
  return t.id;
}

async function started(id: number) {
  while (!runner.isRunning(id)) await new Promise((r) => setTimeout(r, 20));
}

/** End the running turn; returns once the server has handled its end, though a queued turn may have started since. */
async function endTurn(id: number, outcome: 'ok' | 'error') {
  const turn = () => store.getSetting<{ startedAt: number }>(`turn:${id}`)?.startedAt;
  const was = turn();
  writeFileSync(join(root, 'release'), outcome);
  while (turn() === was) await new Promise((r) => setTimeout(r, 20));
}

/** The last turn's argv and prompt, once the fake has logged it. */
async function lastCall(count: number) {
  for (;;) {
    const all = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    if (all.length > count) return all[all.length - 1] as { args: string[]; prompt: any };
    await new Promise((r) => setTimeout(r, 20));
  }
}
const callCount = () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0);
const promptText = (p: any) => (typeof p === 'string' ? p : p.map((b: any) => b.text).join('\n'));
const notes = (id: number) => store.listEvents(id).filter((e) => e.kind === 'note').map((e) => JSON.parse(e.data).text as string);
const waitIdle = async (id: number) => {
  while (runner.isRunning(id) || store.getTicket(id)!.status === 'running') await new Promise((r) => setTimeout(r, 20));
};

test('only a Taskmaster with a session can start fresh', () => {
  const project = store.createProject('Minions', null);
  const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  assert.equal(runner.requestFresh(minion.id, 'test'), 'Only a Taskmaster starts fresh sessions');
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
  for (const [id, size, ended] of [[due, FRESH_CONTEXT_TOKENS + 1, now - FRESH_IDLE_MS], [small, FRESH_CONTEXT_TOKENS, now - FRESH_IDLE_MS], [recent, FRESH_CONTEXT_TOKENS + 1, now - FRESH_IDLE_MS + 60_000]]) {
    store.setSetting(`context:${id}`, size);
    store.recordTurn(id, { event_id: null, session_id: 'old', ended_at: ended, session_cost_usd: 0, duration_ms: 1, usage: {} } as any);
  }
  runner.freshSweep(now);
  assert.equal(runner.view(store.getTicket(due)!).fresh_pending, true);
  assert.match(notes(due).at(-1)!, /idle 55 minutes with 150k tokens of context/);
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
  store.setSetting(`context:${id}`, FRESH_CONTEXT_TOKENS + 1);
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
