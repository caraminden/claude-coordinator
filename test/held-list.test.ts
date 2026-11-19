// Message settings and the Held list (#1059): a scheme's own loop-guard and cold numbers change behaviour inside their
// bounds, the list shows what is held and Continue / Deliver now send it, and no number is typed into tool text.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { cleanMsgSettings, coldToolText, heldToolText, MSG_BOUNDS, MSG_COLUMNS, MSG_DEFAULTS, msgEnv, msgFromEnv, msgSettings } from '../src/msg-settings.ts';
import { Runner } from '../src/runner.ts';
import { transcriptPath } from '../src/sessions.ts';
import { stopTurns, testPins, until } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'held-list-'));
after(async () => {
  await stopTurns(root);
  await until('every session save to end', async () => ![...Array(500).keys()].some((id) => (runner as any).lanes.busy(id)));
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
writeFileSync(fake, `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
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
/** A scheme with `msg` settings, its Taskmaster and one minion idle `idleMs` (a session it can resume). */
function scheme(msg: Record<string, number>, idleMs = 0) {
  const project = store.createProject(`Held${++n}`, null);
  store.setProjectSettings(project.id, msg);
  const mk = (kind: 'coordinator' | 'ticket', idle: number) => {
    const t = store.createTicket({ project_id: project.id, title: kind === 'coordinator' ? 'Taskmaster' : `M${n}`, permission_mode: 'default', created_by: 'Cara', kind });
    const cwd = join(root, `t${t.id}`);
    mkdirSync(cwd, { recursive: true });
    store.setTicketDir(t.id, cwd, null);
    store.updateTicket(t.id, { session_id: `s${t.id}`, status: 'idle' });
    const file = transcriptPath(process.env.CLAUDE_CONFIG_DIR!, cwd, `s${t.id}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{}\n');
    store.recordTurn(t.id, { session_id: `s${t.id}`, ended_at: NOW - idle, session_cost_usd: 0 });
    return store.getTicket(t.id)!;
  };
  return { project: store.getProject(project.id)!, tm: mk('coordinator', 0), minion: mk('ticket', idleMs) };
}

test('the defaults are what the constants were, and a scheme with none set reads them', () => {
  assert.deepEqual(MSG_DEFAULTS, { loopLimit: 6, loopMin: 10, coldMin: 55, holdH: 3 });
  const { project } = scheme({});
  assert.deepEqual(msgSettings(project), MSG_DEFAULTS);
  assert.equal(msgEnv(msgSettings(project)), undefined, 'the defaults add no env var, so the prompt hash stays put');
});

test('the bounds: each edge saves, one past refuses, and out-of-range stored values read as the default', () => {
  for (const [k, [lo, hi]] of Object.entries(MSG_BOUNDS)) {
    const col = MSG_COLUMNS[k as keyof typeof MSG_COLUMNS];
    for (const v of [lo, hi]) assert.deepEqual(cleanMsgSettings({ [col]: v }), { [col]: v });
    for (const v of [lo - 1, hi + 1, 1.5, '5', null, NaN]) assert.throws(() => cleanMsgSettings({ [col]: v }), /whole number/, `${col}=${String(v)}`);
    assert.equal(msgSettings({ [col]: hi + 1 })[k as keyof typeof MSG_BOUNDS], MSG_DEFAULTS[k as keyof typeof MSG_BOUNDS]);
  }
  assert.equal(MSG_BOUNDS.coldMin[1], 55, 'cold stays at or under 55 minutes: the prompt cache lapses past an hour');
  const client = readFileSync(new URL('../public/minion-rules.js', import.meta.url), 'utf8');
  const cols = Object.values(MSG_COLUMNS);
  const bounds = Object.entries(MSG_BOUNDS).map(([k, b]) => `${MSG_COLUMNS[k as keyof typeof MSG_COLUMNS]}: [${b.join(", ")}]`).join(', ');
  const defaults = Object.entries(MSG_DEFAULTS).map(([k, v]) => `${MSG_COLUMNS[k as keyof typeof MSG_COLUMNS]}: ${v}`).join(', ');
  assert.ok(client.includes(`{ ${bounds} }`) && client.includes(`{ ${defaults} }`) && cols.length === 4, "public/minion-rules.js's copy of the bounds and defaults matches");
});

test('the settings reach the tool text through the turn env, and no number is typed into it', () => {
  const s = { loopLimit: 4, loopMin: 20, coldMin: 30, holdH: 8 };
  assert.deepEqual(msgFromEnv(msgEnv(s)), s);
  assert.deepEqual(msgFromEnv(undefined), MSG_DEFAULTS);
  assert.match(coldToolText(s, 'x'), /idle over 30 minutes.*within 8 hours/);
  assert.match(heldToolText(s, 'x'), /\(4 messages in 20 minutes\)/);
  const src = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /idle over \d+ minutes|within \d+ hours|After \d+ messages|in \d+ minutes, the next|allows in \d+ minutes/);
});

test("a scheme's own loop count and window hold the next message, and Continue sends it", () => {
  const { tm, minion } = scheme({ msg_loop_limit: 3, msg_loop_min: 5 });
  for (let i = 0; i < 3; i++) assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', `go ${i}`, false, false), 'mail');
  assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', 'one too many'), true, 'the fourth is held at a count of 3');
  const list = runner.heldList(store.getProject(minion.project_id)!);
  const held = list.filter((i) => i.kind === 'loop');
  assert.equal(held.length, 1);
  assert.match(held[0].why, /3 messages in 5 minutes/);
  assert.equal(held[0].ticket, minion.id);
  assert.equal(runner.continueLoop(held[0].ticket, 'Cara'), 1);
  assert.equal(runner.heldList(store.getProject(minion.project_id)!).filter((i) => i.kind === 'loop').length, 0);
  assert.ok(tm.id);
});

test("a scheme's cold time decides who is cold, and the list shows cold mail until Deliver now sends it", async () => {
  const { project, minion } = scheme({ msg_cold_min: 10 }, 20 * 60_000);
  assert.equal(runner.cold(minion.id), true, '20 minutes idle is cold at 10, though not at the default 55');
  assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', 'rebase onto main'), 'cold');
  const item = runner.heldList(project).find((i) => i.kind === 'cold')!;
  assert.equal(item.to, `#${minion.number}`);
  assert.match(item.why, /idle over 10 minutes/);
  assert.match(item.delivers, /next turn, or by .*PST/);
  assert.equal(runner.releaseMail(store.getTicket(minion.id)!, project, 'Cara'), 1);
  await until('the delivered turn', async () => !runner.isRunning(minion.id) && !runner.heldList(project).length);
  const other = scheme({}, 20 * 60_000);
  assert.equal(runner.cold(other.minion.id), false, 'the same idle time is warm in a scheme left at the default');
});
