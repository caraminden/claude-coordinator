// Holding a warm session's prompt (#1276): a warm session keeps the system prompt it last ran with, what changed
// reaches its turn message as a note, and it takes the new prompt whole once cold. Unit tests for the decision, then
// real turns through a stand-in `claude -p` that keeps each turn's message and system prompt.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { BACK_NOTE, changeNote, decideHold, HOLD_CAP_MS, HOLD_WARM_MS, NOTE_MAX, promptHash, type HoldRecord } from '../src/prompt-hold.ts';
import { Runner } from '../src/runner.ts';
import { readout } from '../tools/prompt-hold-readout.ts';
import { transcriptPath } from '../src/sessions.ts';
import { jsonLines, stopTurns, testPins, until } from './helpers.ts';
testPins();

const old = { base: ['# Rules', 'Ship it with hand_off_land.', 'Keep notes short.'], files: ['Link files by path.'] };
const now = 10 * HOLD_CAP_MS;
const recordOf = (sections = old, extra: Partial<HoldRecord> = {}): HoldRecord => ({ hash: promptHash(sections), since: now - 60_000, session: 's', sent: promptHash(sections), ...extra });
const decide = (current: typeof old, o: Partial<Parameters<typeof decideHold>[0]> = {}) =>
  decideHold({ record: recordOf(), held: old, current, session: 's', lastEnd: now - 60_000, now, ...o });
const edited = { ...old, base: ['# Rules', 'Ship it with hand_off_land, risk label and all.', 'Keep notes short.'] };

test('a warm session keeps its held prompt and gets the changed lines once', () => {
  const d = decide(edited);
  assert.equal(d.held, true);
  assert.deepEqual(d.system, old);
  assert.match(d.note!, /Under "# Rules":\nShip it with hand_off_land, risk label and all\./);
  assert.match(d.note!, /No longer in force[^\n]*\n- "Ship it with hand_off_land\."/);
  assert.doesNotMatch(d.note!, /Keep notes short/, 'unchanged lines stay out of the note');
  assert.equal(d.record.pending, promptHash(edited));
  // Once a turn has read it (sent moves to the new hash), the next warm turn holds without repeating it.
  const again = decide(edited, { record: recordOf(old, { sent: promptHash(edited) }) });
  assert.equal(again.held, true);
  assert.equal(again.note, null);
});

test('it takes the current prompt when cold, past the cap, on a new session, or when the note would be too long', () => {
  const take = (o: Partial<Parameters<typeof decideHold>[0]>, current = edited) => decide(current, o);
  assert.equal(take({ lastEnd: now - HOLD_WARM_MS }).reload, 'cold');
  assert.equal(take({ lastEnd: null }).reload, 'cold');
  assert.equal(take({ record: recordOf(old, { since: now - HOLD_CAP_MS }) }).reload, 'cap');
  assert.equal(take({ session: 'other' }).reload, 'session');
  assert.equal(take({ held: null }).reload, 'cold', 'its file is gone');
  const longer = { ...old, base: [...old.base, 'x'.repeat(NOTE_MAX)] };
  const long = take({}, longer);
  assert.equal(long.reload, 'too-long');
  for (const [d, want] of [[take({ lastEnd: null }), edited], [long, longer]] as const) {
    assert.equal(d.held, false);
    assert.deepEqual(d.system, want);
    assert.equal(d.note, null);
    assert.equal(d.record.since, now, 'the cap counts from the new take');
  }
  // Changed and changed back: a session that read the note hears it no longer applies, once.
  const back = decide(old, { record: recordOf(old, { sent: promptHash(edited) }) });
  assert.equal(back.held, false);
  assert.equal(back.note, BACK_NOTE);
  assert.equal(back.record.pending, promptHash(old));
  // A second edit's note is the whole change from the held prompt, and says it replaces the first.
  const second = decide({ ...old, base: ['# Rules', 'Ship it with hand_off_land.', 'Keep notes very short.'] }, { record: recordOf(old, { sent: promptHash(edited) }) });
  assert.match(second.note!, /replaces the earlier note/);
  assert.doesNotMatch(second.note!, /risk label and all/);
  assert.doesNotMatch(decide(edited).note!, /replaces the earlier note/, 'not on the first');
  // No change: nothing held, nothing to say.
  const same = decide(old);
  assert.equal(same.held, false);
  assert.equal(same.note, null);
  assert.equal(same.reload, null);
});

test('the note lists a new section and a dropped one', () => {
  const note = changeNote(old, { base: old.base, approval: ['Ask first on high risk.'] });
  assert.match(note, /New or reworded:\nAsk first on high risk\./);
  assert.match(note, /- "Link files by path\."/);
});

test('the readout counts warm turns, the ones on a changed system prompt and the held ones, per Pacific day', () => {
  const at = Date.UTC(2026, 10, 20, 20); // 12:00 PST
  const row = (ticket_id: number, ended_at: number, system: object, extra = {}, session = 's') => ({ ticket_id, session_id: session, ended_at, duration_ms: 1000, cache_write_tokens: 500, prompt_digest: JSON.stringify({ system, ...extra }) });
  const ping = (ticket_id: number, ended_at: number) => ({ ticket_id, session_id: 's', ended_at, duration_ms: 1000, cache_write_tokens: 0, prompt_digest: null, keepalive: 1 });
  const [day] = readout([
    row(1, at, { base: 'a' }),
    row(1, at + 60_000, { base: 'b' }), // warm, changed
    row(1, at + 120_000, { base: 'b' }, { held: true }), // warm, held
    row(1, at + 3 * 3600_000, { base: 'c' }), // cold: not counted
    row(1, at + 3 * 3600_000 + 60_000, { base: 'd' }, {}, 'new'), // a new session: cold, not counted
    row(2, at, { base: 'a' }),
    ping(2, at + 55 * 60_000),
    row(2, at + 100 * 60_000, { base: 'a' }), // warm through its keepalive, unchanged
  ]);
  assert.deepEqual(day, { day: '2026-11-20', warm: 3, sysChanged: 1, held: 1, changedWrites: 500 });
});

const root = mkdtempSync(join(tmpdir(), 'prompt-hold-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');

const seen = join(root, 'seen.jsonl');
const fake = join(root, 'claude-fake');
writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const system = fs.readFileSync(process.argv[process.argv.indexOf('--append-system-prompt-file') + 1], 'utf8');
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ input: JSON.parse(input), system, resumed: process.argv.includes('--resume') }) + '\\n');
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess', claude_code_version: '9.9.9' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));
  process.exit(0);
});
`);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const runner = new Runner(store, () => {}, () => ({}), fake);
const project = store.createProject('P', null);

async function turn(id: number, text: string) {
  const before = jsonLines(seen).length;
  const turns = store.promptHashes(id, 99).length;
  runner.send(id, 'Cara', text);
  await until('the turn', async () => jsonLines(seen).length > before && !runner.isRunning(id) && store.promptHashes(id, 99).length > turns);
  const t = jsonLines(seen).at(-1);
  return { ...t, message: t.input.message.content.map((c: any) => c.text).join('\n'), hashes: store.promptHashes(id)[0].hashes };
}

test('a Settings edit reaches the next warm turn as a note on the same system prompt, and the first cold turn whole', async () => {
  store.setAppInstructions('## Old rule\nReply in English.', 'Cara');
  const t = store.createTicket({ project_id: project.id, title: 'A', permission_mode: 'default', created_by: 'Cara', kind: 'ticket' });
  const cwd = join(root, `t${t.id}`);
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);

  const first = await turn(t.id, 'hello');
  assert.equal(first.resumed, false);
  assert.match(first.system, /Reply in English\./);
  const file = transcriptPath(process.env.CLAUDE_CONFIG_DIR!, cwd, 'sess');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{}\n');

  store.setAppInstructions('## Old rule\nReply in English.\nSay it in Pacific time.', 'Cara');
  const warm = await turn(t.id, 'next');
  assert.equal(warm.resumed, true);
  assert.equal(warm.system, first.system, 'the warm turn runs on the system prompt it last ran with');
  assert.match(warm.message, /Your instructions changed[\s\S]*Under "## Old rule":\nSay it in Pacific time\./);
  assert.equal(warm.hashes.held, true);

  const quiet = await turn(t.id, 'and again');
  assert.equal(quiet.system, first.system);
  assert.doesNotMatch(quiet.message, /Your instructions changed/, 'the note goes once');

  runner.now = () => Date.now() + HOLD_WARM_MS + 60_000;
  try {
    const cold = await turn(t.id, 'later');
    assert.equal(cold.resumed, true);
    assert.match(cold.system, /Reply in English\.\nSay it in Pacific time\./, 'the first cold turn takes the whole new prompt');
    assert.doesNotMatch(cold.message, /Your instructions changed/);
    assert.equal(cold.hashes.held, undefined);
  } finally {
    runner.now = () => Date.now();
  }
});
