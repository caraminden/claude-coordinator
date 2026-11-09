// Cold hold (#413): a machine message (minion↔Taskmaster, Taskmaster↔Taskmaster) to a session idle over
// COLD_MS waits as held mail for its next turn, unless urgent, and wakes it after COLD_HOLD_MAX_MS.
// A stand-in `claude -p` writes each turn's prompt to prompts.jsonl and ends.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { COLD_HOLD_MAX_MS, COLD_MS, Runner } from '../src/runner.ts';
import { transcriptPath } from '../src/sessions.ts';
import { stopTurns, until } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'cold-mail-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');

const prompts = join(root, 'prompts.jsonl');
const fake = join(root, 'claude-fake');
writeFileSync(fake, `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  require('node:fs').appendFileSync(${JSON.stringify(prompts)}, input + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`);
chmodSync(fake, 0o755);

const NOW = Date.UTC(2026, 10, 8, 14, 5);
const store = new Store(join(root, 'test.db'));
const runner = new Runner(store, () => {}, () => ({}), fake);
runner.now = () => NOW;

let n = 0;
/** A ticket whose last turn ended `idleMs` ago, on a session this login can resume (none with idleMs null). */
function ticket(kind: 'coordinator' | 'ticket', idleMs: number | null, projectId?: number) {
  const project = projectId ?? store.createProject(`P${++n}`, null).id;
  const t = store.createTicket({ project_id: project, title: kind === 'coordinator' ? 'Taskmaster' : `M${n}`, permission_mode: 'default', created_by: 'Cara', kind });
  const cwd = join(root, `t${t.id}`);
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  if (idleMs !== null) {
    store.updateTicket(t.id, { session_id: `s${t.id}`, status: 'idle' });
    const file = transcriptPath(process.env.CLAUDE_CONFIG_DIR!, cwd, `s${t.id}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{}\n');
    store.recordTurn(t.id, { session_id: `s${t.id}`, ended_at: NOW - idleMs, session_cost_usd: 0 });
  }
  return store.getTicket(t.id)!;
}

const lastMessage = (id: number) => JSON.parse(store.listEvents(id).filter((e) => e.kind === 'user_message').at(-1)!.data);
const promptCount = () => (existsSync(prompts) ? readFileSync(prompts, 'utf8').trim().split('\n').length : 0);
const lastPrompt = () => JSON.parse(readFileSync(prompts, 'utf8').trim().split('\n').at(-1)!).message.content.map((c: any) => c.text);
async function idle(id: number) {
  await until('the turn to end', async () => !runner.isRunning(id));
}

test('cold: a session past COLD_MS with no turn running; a fresh one or one without a session is not', () => {
  assert.equal(runner.cold(ticket('coordinator', COLD_MS + 60_000).id), true);
  assert.equal(runner.cold(ticket('coordinator', COLD_MS - 60_000).id), false);
  assert.equal(runner.cold(ticket('coordinator', null).id), false, 'no session: nothing cached to lose');
});

test("a minion's message to a cold Taskmaster is held as mail and rides along with the next person's message", async () => {
  const tm = ticket('coordinator', 2 * 3_600_000);
  const minion = ticket('ticket', 0, tm.project_id);
  assert.equal(runner.relay(minion.id, tm.id, `#${minion.number} M`, 'please start #9 from its handoff'), 'cold');
  const shown = lastMessage(tm.id);
  assert.equal(shown.mail, true);
  assert.equal(shown.cold, true);
  assert.equal(runner.isRunning(tm.id), false, 'a cold Taskmaster must not wake for it');
  assert.equal(runner.queued(tm.id), 0);
  assert.equal(store.getSetting(`cold:${tm.id}`), NOW);

  const before = promptCount();
  runner.send(tm.id, 'Cara', 'anything new?');
  await until('the turn', async () => promptCount() > before);
  assert.deepEqual(lastPrompt(), ['[Cara]: anything new?', `[Held mail from #${minion.number} M, sent 2026-11-08 14:05 UTC]: please start #9 from its handoff`]);
  await idle(tm.id);
  assert.equal(store.getSetting(`cold:${tm.id}`), null, 'delivered: the cap has nothing left to wake');
});

test("the Taskmaster's message to a cold minion is held; urgent wakes it, the held one along", async () => {
  const tm = ticket('coordinator', 0);
  const minion = ticket('ticket', 90 * 60_000, tm.project_id);
  assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', '#12 shipped, FYI'), 'cold');
  assert.equal(runner.isRunning(minion.id), false);

  const before = promptCount();
  assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', 'Cara says merge it', true), false);
  await until('the turn', async () => promptCount() > before);
  assert.deepEqual(lastPrompt(), ['[Taskmaster]: Cara says merge it', '[Held mail from Taskmaster, sent 2026-11-08 14:05 UTC]: #12 shipped, FYI']);
  await idle(minion.id);
});

test('a warm session gets machine messages at once, as before', async () => {
  const tm = ticket('coordinator', 0);
  const minion = ticket('ticket', 20 * 60_000, tm.project_id);
  const before = promptCount();
  assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', 'rebase onto main'), false);
  assert.equal(lastMessage(minion.id).mail, undefined);
  await until('the turn', async () => promptCount() > before);
  await idle(minion.id);
});

test("another scheme's Taskmaster: cold holds a waking message, urgent wakes, wake: false stays plain news with no cap", async () => {
  const a = ticket('coordinator', 0);
  const b = ticket('coordinator', 4 * 3_600_000);
  assert.deepEqual(runner.relayTaskmaster(a.id, b.id, 'Taskmaster of P', 'please look at #4'), { held: false, left: 5, cold: true });
  assert.equal(runner.isRunning(b.id), false);

  const c = ticket('coordinator', 4 * 3_600_000);
  assert.deepEqual(runner.relayTaskmaster(a.id, c.id, 'Taskmaster of P', '#388 is live', false), { held: false, left: 5 });
  assert.equal(lastMessage(c.id).cold, undefined);
  assert.equal(store.getSetting(`cold:${c.id}`), null, 'asked-for held mail waits for a turn, however long');

  const before = promptCount();
  assert.equal(runner.relayTaskmaster(a.id, c.id, 'Taskmaster of P', 'blocked on you', true, '', true).cold, undefined);
  await until('the turn', async () => promptCount() > before);
  await idle(c.id);
  // b's held mail is still waiting; settle it so its sweep below starts from a clean slate.
  store.deleteSetting(`mail:${b.id}`);
  store.deleteSetting(`cold:${b.id}`);
});

test('the sweep wakes a cold session once its held mail has waited COLD_HOLD_MAX_MS, not before', async () => {
  const tm = ticket('coordinator', 2 * 3_600_000);
  const minion = ticket('ticket', 0, tm.project_id);
  runner.relay(minion.id, tm.id, `#${minion.number} M`, 'my PR is up');
  const before = promptCount();
  runner.coldSweep(NOW + COLD_HOLD_MAX_MS - 60_000);
  assert.equal(runner.isRunning(tm.id), false);
  assert.ok(store.getSetting(`mail:${tm.id}`));

  runner.coldSweep(NOW + COLD_HOLD_MAX_MS);
  await until('the turn', async () => promptCount() > before);
  assert.deepEqual(lastPrompt(), [`[Held mail from #${minion.number} M, sent 2026-11-08 14:05 UTC]: my PR is up`]);
  assert.ok(store.listEvents(tm.id).some((e) => e.kind === 'note' && JSON.parse(e.data).text.includes('waited 3 hours')));
  await idle(tm.id);
  assert.equal(store.getSetting(`cold:${tm.id}`), null);
  assert.equal(store.getSetting(`mail:${tm.id}`), null);
});

test('the sweep delivers held mail at once to a session that went fresh meanwhile', async () => {
  const tm = ticket('coordinator', 2 * 3_600_000);
  const minion = ticket('ticket', 0, tm.project_id);
  runner.relay(minion.id, tm.id, `#${minion.number} M`, 'done');
  store.updateTicket(tm.id, { session_id: null });
  const before = promptCount();
  runner.coldSweep(NOW + 60_000);
  await until('the turn', async () => promptCount() > before);
  await idle(tm.id);
});

test('a dismissed minion is never cold: a message reopens it as before; one dismissed after its mail was held is not reopened by the cap', async () => {
  const tm = ticket('coordinator', 0);
  const gone = ticket('ticket', 5 * 3_600_000, tm.project_id);
  store.updateTicket(gone.id, { status: 'closed' });
  assert.equal(runner.cold(gone.id), false);

  const minion = ticket('ticket', 2 * 3_600_000, tm.project_id);
  assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', '#12 shipped, FYI'), 'cold');
  store.updateTicket(minion.id, { status: 'closed' });
  const before = promptCount();
  runner.coldSweep(NOW + COLD_HOLD_MAX_MS);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(promptCount(), before, 'the cap must not reopen a dismissed minion');
  assert.equal(runner.isRunning(minion.id), false);
  assert.ok(store.getSetting(`mail:${minion.id}`), 'its mail waits for a person');
  assert.equal(store.getSetting(`cold:${minion.id}`), null);
});

test("cold mail keeps its sender's person, so a turn the cap starts runs as the relay would have", () => {
  const tm = ticket('coordinator', 2 * 3_600_000);
  const minion = ticket('ticket', 0, tm.project_id);
  const seen: [string, number | undefined][] = [];
  runner.personOf = (author, from) => (seen.push([author, from]), from === minion.id ? 42 : null);
  try {
    runner.relay(minion.id, tm.id, `#${minion.number} M`, 'my PR is up');
    const [held] = store.getSetting<{ from?: number; asker?: number | null }[]>(`mail:${tm.id}`)!;
    assert.equal(held.from, minion.id);
    assert.equal(held.asker, 42);
  } finally {
    runner.personOf = undefined;
    store.deleteSetting(`mail:${tm.id}`);
    store.deleteSetting(`cold:${tm.id}`);
  }
});
