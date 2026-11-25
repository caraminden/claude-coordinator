// Keeping a waiting minion's prompt cache warm (#862): the working-hours window, the cache fingerprint that
// marks a series dirty, the measured backstop, the week's readout, and the runner's keepalive turn (it fires
// at 55 minutes, hides from the chat, leaves state alone, and is dropped when a real wake comes first).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import {
  changedParts,
  claudeStamp,
  countGate,
  fingerprint,
  inWindow,
  KEEPALIVE_AFTER_MS,
  KEEPALIVE_GATES_KEY,
  KEEPALIVE_OFF_KEY,
  KEEPALIVE_REPORT_KEY,
  KEEPALIVE_TEXT,
  keepaliveKey,
  missed,
  prefixParts,
  SERIES_CAP_MS,
  tooManyMisses,
  WEEK_MS,
  weekReport,
  type KeepaliveSeries,
  type KeepaliveRow,
} from '../src/keepalive.ts';
import { sleepKey } from '../src/needs.ts';
import { Runner } from '../src/runner.ts';
import { transcriptPath } from '../src/sessions.ts';
import { jsonLines, lines, stopTurns, testPins, until, runnerInsides } from './helpers.ts';
testPins();

/** A Pacific wall-clock time on 2026-11-16 (PST, UTC-8) as ms. */
const pst = (hh: number, mm = 0) => Date.UTC(2026, 10, 16, hh + 8, mm);

test('the window is 11:00 to midnight Pacific, in winter and summer time', () => {
  assert.equal(inWindow(pst(10, 59)), false);
  assert.equal(inWindow(pst(11, 0)), true);
  assert.equal(inWindow(pst(23, 59)), true);
  assert.equal(inWindow(pst(24, 0)), false, 'midnight ends it');
  assert.equal(inWindow(pst(3, 0)), false);
  // 2026-07-01 is PDT (UTC-7): 11:00 PDT is 18:00 UTC, 10:30 PDT is 17:30 UTC.
  assert.equal(inWindow(Date.UTC(2026, 6, 1, 18, 0)), true);
  assert.equal(inWindow(Date.UTC(2026, 6, 1, 17, 30)), false);
});

test('the claude stamp skips the claude-pace link and stamps the real CLI', () => {
  const d = mkdtempSync(join(tmpdir(), 'stamp-'));
  try {
    const real = join(d, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'claude'), '#!/bin/sh\n');
    const turn = (n: string) => {
      const bin = join(d, n, 'bin', 'heavy');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(d, n, 'bin', 'claude-pace'), `#!/bin/sh\n# ${n}\n`);
      symlinkSync('../claude-pace', join(bin, 'claude'));
      return `${bin}:${real}`;
    };
    assert.equal(claudeStamp('claude', turn('t1')), claudeStamp('claude', turn('t2')));
    assert.match(claudeStamp('claude', turn('t3')), /real\/claude/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('the fingerprint ignores the per-turn folder and names the part that moved', () => {
  const base = {
    dir: '/run/turns/5-111',
    systemPrompt: 'You are a minion.',
    args: ['-p', '--settings', '/run/turns/5-111/settings.json', '--model', 'opus'],
    files: [
      { name: 'mcp.json', text: '{"a":"/run/turns/5-111/pin/mcp.ts"}' },
      { name: 'settings.json', text: '{"hooks":"/run/turns/5-111/pin/x"}' },
    ],
    env: { COORDINATOR_APPROVALS: '1', COORDINATOR_TOKEN: 'secret-1', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', GITHUB_TOKEN: 'g', PATH: '/run/turns/5-111/pin/bin:/usr/bin' },
    pinned: 'kit-hash',
    claude: 'claude-2.1',
    context: 'claude.md',
    date: '2026-11-16',
  };
  const a = prefixParts(base);
  // Another turn's folder, token and secrets: the same prefix.
  const b = prefixParts({ ...base, dir: '/run/turns/5-999', args: base.args.map((s) => s.replace('5-111', '5-999')), files: base.files.map((f) => ({ ...f, text: f.text.replace('5-111', '5-999') })), env: { ...base.env, COORDINATOR_TOKEN: 'secret-2', GITHUB_TOKEN: 'h', CITADEL_SECRET_X: 'y' } });
  assert.equal(fingerprint(a), fingerprint(b));
  assert.deepEqual(changedParts(a, b), []);
  // A prompt edit, a tool flag, a model, the kit, CLAUDE.md or the date each make it dirty, and say which.
  assert.deepEqual(changedParts(a, prefixParts({ ...base, systemPrompt: 'You are a minion!' })), ['system']);
  assert.deepEqual(changedParts(a, prefixParts({ ...base, env: { ...base.env, COORDINATOR_MEDIA: '1' } })), ['env']);
  assert.deepEqual(changedParts(a, prefixParts({ ...base, args: [...base.args.slice(0, -1), 'sonnet'] })), ['args']);
  assert.deepEqual(changedParts(a, prefixParts({ ...base, pinned: 'kit-hash-2' })), ['pinned']);
  assert.deepEqual(changedParts(a, prefixParts({ ...base, context: 'claude.md v2' })), ['context']);
  assert.deepEqual(changedParts(a, prefixParts({ ...base, date: '2026-11-17' })), ['date']);
  assert.notEqual(fingerprint(a), fingerprint(prefixParts({ ...base, systemPrompt: 'x' })));
});

test('a keepalive that writes more than 5k tokens missed; a fifth of a day missing turns them off', () => {
  assert.equal(missed({ cache_creation_input_tokens: 4_000, cache_read_input_tokens: 90_000 }), false);
  assert.equal(missed({ cache_creation_input_tokens: 6_000, cache_read_input_tokens: 90_000 }), true);
  assert.equal(missed(null), false);
  assert.equal(tooManyMisses(4, 4), false, 'too few to judge');
  assert.equal(tooManyMisses(10, 2), false, 'exactly a fifth');
  assert.equal(tooManyMisses(10, 3), true);
});

test('the week readout counts warm and cold wakes and the reload a warm one saved', () => {
  const H = 3_600_000;
  const t0 = pst(12);
  const row = (ticket_id: number, end: number, extra: Partial<KeepaliveRow> = {}): KeepaliveRow => ({
    ticket_id,
    ended_at: end,
    duration_ms: 60_000,
    cost_usd: 1,
    input_tokens: 10,
    output_tokens: 500,
    cache_read_tokens: 100_000,
    cache_write_tokens: 2_000,
    keepalive: 0,
    ...extra,
  });
  // A ping: 100k read at 0.1 and a few tokens, $0.05 in all, so a unit is 0.05 / (10 + 10_000 + 0 + 10) per token.
  const ping = (ticket_id: number, end: number) => row(ticket_id, end, { keepalive: 1, cost_usd: 0.05, input_tokens: 10, output_tokens: 2, cache_read_tokens: 100_000, cache_write_tokens: 0, duration_ms: 3000 });
  const rows = [
    // Minion 1: a turn, a ping 55 min later, then a person's answer 30 min after the ping: a warm wake.
    row(1, t0),
    ping(1, t0 + 55 * 60_000),
    row(1, t0 + 85 * 60_000 + 60_000),
    // Minion 2: a turn and an answer three hours later with no ping: a cold wake.
    row(2, t0),
    row(2, t0 + 3 * H + 60_000),
    // Minion 3: back within the hour: no wait at all.
    row(3, t0),
    row(3, t0 + 30 * 60_000),
  ];
  const r = weekReport(rows, t0 - H, t0 + 24 * H);
  assert.equal(r.pings, 1);
  assert.equal(r.misses, 0);
  assert.equal(r.warm, 1);
  assert.equal(r.cold, 1);
  assert.ok(Math.abs(r.pingUsd - 0.05) < 1e-9);
  const unit = 0.05 / (10 + 0.1 * 100_000 + 5 * 2);
  assert.ok(Math.abs(r.savedUsd - 100_000 * 1.9 * unit) < 1e-6, `saved ${r.savedUsd}`);
  assert.ok(Math.abs(r.netUsd - (r.savedUsd - r.pingUsd)) < 1e-9);
});

// ---- The runner's keepalive turn, against a stand-in for claude ----

const root = mkdtempSync(join(tmpdir(), 'keepalive-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const calls = join(root, 'calls.jsonl');
// Logs its prompt, then ends on its folder's release file (or at once for a keepalive, as claude would, unless a hold file is there), with a
// result carrying a running cost and the usage in usage.json (a warm read by default).
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const r = args.indexOf('--resume');
const session = r >= 0 ? args[r + 1] : 'new-' + Date.now();
let input = '';
process.stdin.on('data', (d) => {
  if (input.includes('\\n')) return;
  input += d;
  if (!input.includes('\\n')) return;
  const prompt = JSON.parse(input.split('\\n')[0]).message.content;
  const system = readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8');
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, prompt, system }) + '\\n');
  const usageFile = ${JSON.stringify(join(root, 'usage.json'))};
  const usage = existsSync(usageFile) ? JSON.parse(readFileSync(usageFile, 'utf8')) : { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0 };
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }));
  console.log(JSON.stringify({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text: '.' }], usage } }));
  const text = JSON.stringify(prompt);
  const end = () => {
    const costFile = ${JSON.stringify(join(root, 'cost'))};
    const cost = (existsSync(costFile) ? Number(readFileSync(costFile, 'utf8')) : 0) + 0.05;
    writeFileSync(costFile, String(cost));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '.', session_id: session, total_cost_usd: cost, duration_ms: 1000, usage }));
    process.exit(0);
  };
  // A keepalive ends at once, unless a test holds it open (hold-keepalive): then it waits for its release file too.
  if (text.includes('Keepalive') && !existsSync(${JSON.stringify(join(root, 'hold-keepalive'))})) return end();
  const wait = setInterval(() => {
    if (!existsSync('release')) return;
    clearInterval(wait);
    unlinkSync('release');
    end();
  }, 20);
});
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const runner = new Runner(
  store,
  () => {},
  () => ({}),
  fake,
);

let n = 0;
/** A minion with a session whose transcript is on this login, so its turns resume it. */
function minion() {
  const project = store.createProject(`K${++n}`, null);
  const t = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(root, `m${n}`);
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  store.updateTicket(t.id, { session_id: 'sess', status: 'idle' });
  const file = transcriptPath(process.env.CLAUDE_CONFIG_DIR!, cwd, 'sess');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{}\n');
  return t.id;
}

const callCount = () => lines(calls).length;
const promptText = (p: any) => (typeof p === 'string' ? p : p.map((b: any) => b.text).join('\n'));
const series = (id: number) => store.getSetting<KeepaliveSeries>(keepaliveKey(id));
const turnsOf = (id: number) => store.listTurns(id);
const notesOf = (id: number) =>
  store
    .listEvents(id)
    .filter((e) => e.kind === 'note')
    .map((e) => JSON.parse(e.data).text as string);
const idle = (id: number) => until('the lane to go idle', () => !runner.isRunning(id) && !(runner as any).lanes.busy(id));

/** Run a real turn to its end, then move its end (and its series' start) to `end`, so a sweep's clock can be Pacific noon. */
async function realTurn(id: number, end: number) {
  const before = callCount();
  runner.send(id, 'Cara', 'please wait for my answer');
  await until('the turn to start', () => runner.isRunning(id));
  await until('the fake to log its call', () => callCount() > before);
  writeFileSync(join(store.getTicket(id)!.cwd, 'release'), 'ok');
  await idle(id);
  const last = turnsOf(id).at(-1)!;
  (store as any).db.prepare('UPDATE turns SET ended_at = ? WHERE id = ?').run(end, last.id);
  const s = series(id);
  assert.ok(s?.fp, 'a real turn that ended well starts a series with its fingerprint');
  store.setSetting(keepaliveKey(id), { ...s, since: end });
}

test('a waiting minion gets one hidden keepalive 55 minutes after its turn, which leaves its state alone', async () => {
  const id = minion();
  const end = pst(13);
  await realTurn(id, end);
  store.updateTicket(id, { state: 'ready', note: 'needs a pick', replies: JSON.stringify(['Merge it']) });
  const events = store.listEvents(id).length;
  const before = callCount();
  runner.keepaliveSweep(end + 54 * 60_000);
  await idle(id);
  assert.equal(callCount(), before, 'not before 55 minutes');
  runner.keepaliveSweep(end + KEEPALIVE_AFTER_MS);
  await until('the keepalive to run', () => callCount() > before);
  await idle(id);
  const call = jsonLines(calls).at(-1) as { args: string[]; prompt: any };
  assert.ok(promptText(call.prompt).includes(KEEPALIVE_TEXT));
  assert.ok(call.args.includes('--resume'), 'it resumes the session, or there is no cache to keep');
  const t = store.getTicket(id)!;
  assert.equal(t.state, 'ready');
  assert.equal(t.note, 'needs a pick');
  assert.equal(t.replies, JSON.stringify(['Merge it']));
  assert.equal(t.status, 'idle');
  assert.equal(store.listEvents(id).length, events, 'nothing in the chat');
  const turns = turnsOf(id);
  assert.equal(turns.at(-1)!.keepalive, 1, 'costed apart');
  assert.equal(series(id)!.stopped, undefined);
  // The next sweep in the same minute doesn't ping again: the ping is the last turn now.
  runner.keepaliveSweep(end + KEEPALIVE_AFTER_MS + 30_000);
  await idle(id);
  assert.equal(callCount(), before + 1);
});

test('a prompt change marks the series dirty: no keepalive, and none after', async () => {
  const id = minion();
  const end = pst(14);
  await realTurn(id, end);
  // The scheme's CLAUDE.md in the worktree changes after the turn: the cached prefix would be re-written anyway.
  writeFileSync(join(store.getTicket(id)!.cwd, 'CLAUDE.md'), '# new rules\n');
  const before = callCount();
  runner.keepaliveSweep(end + KEEPALIVE_AFTER_MS);
  await until('the series to stop', () => series(id)?.stopped);
  await idle(id);
  assert.equal(series(id)!.stopped, 'dirty');
  assert.equal(callCount(), before, 'no ping went out');
  runner.keepaliveSweep(end + KEEPALIVE_AFTER_MS + 60_000);
  await idle(id);
  assert.equal(callCount(), before);
  assert.equal(store.getTicket(id)!.status, 'idle');
});

test('a Settings edit keeps the series: the keepalive runs on the prompt its warm session holds (#1276)', async () => {
  const id = minion();
  const end = pst(15);
  await realTurn(id, end);
  const real = jsonLines(calls).at(-1) as { system: string };
  store.setAppInstructions('## A new rule\nSay times in Pacific.', 'Cara');
  const before = callCount();
  // The hold reads the runner's clock: the ping comes 55 minutes after the turn, inside the cache's hour.
  runner.now = () => end + KEEPALIVE_AFTER_MS;
  try {
    runner.keepaliveSweep(end + KEEPALIVE_AFTER_MS);
    await until('the keepalive to run', () => callCount() > before);
    await idle(id);
  } finally {
    runner.now = () => Date.now();
    store.setAppInstructions('', 'Cara');
  }
  const ping = jsonLines(calls).at(-1) as { system: string; prompt: any };
  assert.ok(promptText(ping.prompt).includes(KEEPALIVE_TEXT));
  assert.equal(ping.system, real.system, 'the system prompt its session cached, not the edited one');
  assert.doesNotMatch(ping.system, /Say times in Pacific/);
  assert.equal(series(id)!.stopped, undefined);
});

test('a real wake that arrives while a keepalive waits goes first, and the keepalive is dropped', async () => {
  const id = minion();
  const end = pst(15);
  await realTurn(id, end);
  // Something else holds the minion's lane (a save, say) when the sweep fires.
  let free!: () => void;
  void (runner as any).lanes.run(id, 'hold', () => new Promise<void>((r) => (free = r)));
  const before = callCount();
  runner.keepaliveSweep(end + KEEPALIVE_AFTER_MS);
  runner.send(id, 'Cara', 'here is my answer');
  free();
  await until('the real turn to start', () => callCount() > before);
  const call = jsonLines(calls).at(-1) as { prompt: any };
  assert.ok(promptText(call.prompt).includes('here is my answer'));
  assert.ok(!promptText(call.prompt).includes(KEEPALIVE_TEXT));
  writeFileSync(join(store.getTicket(id)!.cwd, 'release'), 'ok');
  await idle(id);
  assert.equal(callCount(), before + 1, 'no keepalive behind it');
  assert.ok(!turnsOf(id).some((t) => t.keepalive));
});

// 2A2 (#1510): a keepalive sweep that lands between recover() and its staggered resumes leaves the owed resume alone,
// whether the keepalive would have run (and taken the resume's place) or backed out (and held the cut turn's batch as mail).
for (const [name, dirty] of [
  ['would run', false],
  ['would back out on a changed prompt', true],
] as const) {
  test(`no keepalive on a minion with a restart's resume owed: one that ${name}`, async () => {
    const id = minion();
    const end = pst(15);
    await realTurn(id, end);
    if (dirty) writeFileSync(join(store.getTicket(id)!.cwd, 'CLAUDE.md'), '# new rules\n');
    // A restart cut its next turn off after claude read its batch: the batch stays taken, and the resume is owed.
    runner.queue.put(id, { author: 'Josh', text: 'the cut turn read this', images: [] });
    runner.queue.take(id);
    runner.queue.owe(id, { resumes: 1 });
    try {
      const before = callCount();
      runner.keepaliveSweep(end + KEEPALIVE_AFTER_MS);
      await idle(id);
      assert.equal(callCount(), before, 'no keepalive ran');
      assert.deepEqual(runner.queue.owed(id), { resumes: 1 }, 'the resume is still owed');
      const q = runner.queue.get(id);
      assert.deepEqual(
        q.taken?.map((m) => m.text),
        ['the cut turn read this'],
        'its batch is still taken, for the resume',
      );
      assert.equal(q.held, undefined, 'not turned into held mail');
      assert.equal(series(id)!.stopped, undefined);
    } finally {
      runner.queue.owe(id, null);
      runner.queue.clear(id);
    }
  });
}

// 2A3 (#1510): a dismissal or a live deploy that comes while a hidden keepalive runs waits for it, as for any turn, and
// the keepalive's end carries it out, leaving no mark behind for the next real turn's end.
async function duringKeepalive(id: number, end: number, mid: () => void) {
  writeFileSync(join(root, 'hold-keepalive'), '');
  try {
    const before = callCount();
    const pings = turnsOf(id).filter((t) => t.keepalive).length;
    runner.keepaliveSweep(end + KEEPALIVE_AFTER_MS);
    await until('the keepalive to run', () => callCount() > before && runner.isRunning(id));
    mid();
    writeFileSync(join(store.getTicket(id)!.cwd, 'release'), 'ok');
    // Its end, not the lane's: a message that came meanwhile runs next.
    await until('the keepalive to end', () => turnsOf(id).filter((t) => t.keepalive).length > pings);
    await until('its session save', () => !(runner as any).keepalives.has(id) && !store.getSetting(`saving:${id}`));
  } finally {
    rmSync(join(root, 'hold-keepalive'), { force: true });
  }
  assert.equal((runner as any).closing.has(id), false, 'no dismissal mark left');
  assert.equal((runner as any).deployedMidTurn.has(id), false, 'no deploy mark left');
}

test('a fix minion whose red goes green during a keepalive is dismissed when it ends (2A3)', async () => {
  const id = minion();
  const end = pst(15);
  await realTurn(id, end);
  await duringKeepalive(id, end, () => runner.ciGreen(id, 'CI on main is green again, so it dismissed this fix minion.'));
  await until('it is dismissed', () => store.getTicket(id)!.status === 'closed');
  assert.ok(notesOf(id).includes('CI on main is green again, so it dismissed this fix minion.'));
});

test('a dismissal during a keepalive is not carried out past a message that came meanwhile (2A3)', async () => {
  const id = minion();
  const end = pst(15);
  await realTurn(id, end);
  await duringKeepalive(id, end, () => {
    runner.ciGreen(id, 'CI on main is green again, so it dismissed this fix minion.');
    runner.send(id, 'Cara', 'one more thing');
  });
  assert.ok(notesOf(id).includes('CI on main is green again. It stays open: a new message arrived.'));
  writeFileSync(join(store.getTicket(id)!.cwd, 'release'), 'ok');
  await idle(id);
  assert.notEqual(store.getTicket(id)!.status, 'closed', "the message's turn ending well doesn't dismiss it with the old reason");
});

test('a deploy that goes live during a keepalive is handled when it ends (2A3)', async () => {
  const id = minion();
  const end = pst(15);
  await realTurn(id, end);
  // Waiting on its deploy, with a card open (the only way a keepalive runs in pending-deploy).
  store.updateTicket(id, { state: 'pending-deploy' });
  store.addEvent(id, 'question', { id: 'q1', questions: [] });
  await duringKeepalive(id, end, () => assert.equal(runner.deployLive(id), false, 'it waits for the running turn'));
  assert.ok(notesOf(id).includes('The deploy is live, but a question card is still open, so this minion stays open.'));
});

test('a minion waiting on its ship gets a keepalive too, and a ship that ends during it still dismisses it (#1274)', async () => {
  const id = minion();
  const end = pst(14, 5);
  await realTurn(id, end);
  store.updateTicket(id, { state: 'outside', note: 'landing: in line' });
  // The ship goes through while the ping runs: src/land.ts asks for the dismissal at the turn's end.
  await duringKeepalive(id, end, () => {
    assert.equal(store.getTicket(id)!.state, 'outside', 'its state stays');
    assert.ok(runner.closeAfterTurn(id, 'Shipped.'));
  });
  await until('the minion to be dismissed', () => store.getTicket(id)!.status === 'closed');
  assert.equal(turnsOf(id).at(-1)!.keepalive, 1);
});

test('a ship that ends while a keepalive is still launching dismisses the minion, even when the launch starts no turn (#1808)', async () => {
  const id = minion();
  const end = pst(14, 40);
  await realTurn(id, end);
  store.updateTicket(id, { state: 'outside', note: 'landing: in line' });
  const launching = runnerInsides(runner).launching;
  const set = launching.set;
  let asked: boolean | null = null;
  // The ship ends as the keepalive launches, and the launch then starts no turn (a preview's noTurns stands in for any such end).
  launching.set = (lid, mark) => {
    set.call(launching, lid, mark);
    if (lid === id && asked === null) {
      asked = runner.closeAfterTurn(id, 'Shipped.');
      runner.noTurns = true;
    }
    return launching;
  };
  try {
    runner.keepaliveSweep(end + KEEPALIVE_AFTER_MS);
    await until('the launch to end', () => asked !== null && !runner.isRunning(id));
  } finally {
    launching.set = set;
    runner.noTurns = false;
  }
  assert.equal(asked, true, 'the dismissal waits for the launch');
  await until('the minion to be dismissed', () => store.getTicket(id)!.status === 'closed');
  assert.equal(turnsOf(id).filter((t) => t.keepalive).length, 0, 'no keepalive ran');
});

test("a deploy that goes live during a keepalive dismisses its pending-deploy minion at the keepalive's end (#1274)", async () => {
  const id = minion();
  const end = pst(14, 20);
  await realTurn(id, end);
  store.updateTicket(id, { state: 'outside', note: 'landing: in line' });
  // The ship needed a restart, and the deploy went live while the ping ran.
  await duringKeepalive(id, end, () => {
    store.updateTicket(id, { state: 'pending-deploy', note: null });
    assert.equal(runner.deployLive(id), false, 'not while the ping runs');
  });
  await until('the minion to be dismissed', () => store.getTicket(id)!.status === 'closed');
});

test('an asleep minion (#1636) gets no keepalive; a message to it starts its turn as normal and wakes it', async () => {
  const id = minion();
  const end = pst(13);
  await realTurn(id, end);
  store.updateTicket(id, { state: 'ready' });
  assert.ok(runner.sleep(id, 'Cara', true));
  assert.equal(runner.sleep(id, 'Cara', true), false, 'already asleep');
  const before = callCount();
  runner.keepaliveSweep(end + KEEPALIVE_AFTER_MS);
  await idle(id);
  assert.equal(callCount(), before, 'turned away at its gate');
  assert.ok(store.getSetting(sleepKey(id)), 'still asleep');

  await realTurn(id, end + 2 * KEEPALIVE_AFTER_MS);
  assert.equal(callCount(), before + 1, 'the message ran a turn');
  assert.equal(store.getSetting(sleepKey(id)), null, 'the turn woke it');
  assert.ok(notesOf(id).includes('Cara put this minion to sleep.'));
  assert.ok(notesOf(id).includes('Awake again: a new turn started.'));
});

test('no keepalive outside the window or past the 8-hour cap', async () => {
  const id = minion();
  const end = pst(23, 30);
  await realTurn(id, end);
  const before = callCount();
  runner.keepaliveSweep(end + KEEPALIVE_AFTER_MS); // 00:25 Pacific
  await idle(id);
  assert.equal(callCount(), before);
  // In the window, but the series began over 8 hours ago.
  const late = pst(20);
  (store as any).db.prepare('UPDATE turns SET ended_at = ? WHERE ticket_id = ?').run(late, id);
  store.setSetting(keepaliveKey(id), { ...series(id)!, since: late + KEEPALIVE_AFTER_MS - SERIES_CAP_MS });
  runner.keepaliveSweep(late + KEEPALIVE_AFTER_MS);
  await idle(id);
  assert.equal(callCount(), before);
});

test('a keepalive that missed the cache stops its series', async () => {
  const id = minion();
  const end = pst(16);
  await realTurn(id, end);
  writeFileSync(join(root, 'usage.json'), JSON.stringify({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 80_000 }));
  try {
    const before = callCount();
    runner.keepaliveSweep(end + KEEPALIVE_AFTER_MS);
    await until('the keepalive to run', () => callCount() > before);
    await idle(id);
    assert.equal(series(id)!.stopped, 'missed');
  } finally {
    rmSync(join(root, 'usage.json'), { force: true });
  }
});

test('a keepalive turn left by a restart is killed and dropped, not resumed', async () => {
  const id = minion();
  // Its process outlives the restart (a unit): recover kills it.
  const orphan = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  mkdirSync(join(root, 'gone-turn'), { recursive: true });
  writeFileSync(join(root, 'gone-turn', 'pid.json'), JSON.stringify({ claude: orphan.pid }));
  const gone = new Promise((resolve) => orphan.once('exit', resolve));
  store.setSetting(`turn:${id}`, { resumes: 0, keepalive: true, dir: join(root, 'gone-turn'), startedAt: Date.now() });
  const r = new Runner(
    store,
    () => {},
    () => ({}),
    fake,
  );
  r.recover();
  assert.equal(await Promise.race([gone.then(() => 'killed'), new Promise((res) => setTimeout(res, 3000, 'alive'))]), 'killed');
  assert.equal(store.getSetting(`turn:${id}`), null);
  assert.equal(existsSync(join(root, 'gone-turn')), false);
  assert.equal(r.isRunning(id), false, 'no resume started');
  assert.equal(store.getSetting<any>(`minion-queue:${id}`)?.owed ?? null, null);
});

test('the weekly readout switches keepalives off when they cost more than they saved', async () => {
  const id = minion();
  const now = pst(12);
  store.setSetting(KEEPALIVE_REPORT_KEY, now - WEEK_MS + 60_000);
  runner.keepaliveSweep(now);
  assert.equal(store.getSetting(KEEPALIVE_REPORT_KEY), now - WEEK_MS + 60_000, 'not before a week');
  // One keepalive in the week and no wake it kept warm: all cost, nothing saved.
  store.recordTurn(id, { session_id: 'sess', ended_at: now - 3_600_000, session_cost_usd: 0.05, duration_ms: 1000, usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 }, keepalive: true });
  try {
    runner.keepaliveSweep(now + 60_000);
    assert.equal(store.getSetting(KEEPALIVE_REPORT_KEY), now + 60_000);
    assert.ok(store.getSetting(KEEPALIVE_OFF_KEY), 'net below zero turns them off');
    const before = callCount();
    runner.keepaliveSweep(now + 120_000);
    await idle(id);
    assert.equal(callCount(), before);
  } finally {
    store.deleteSetting(KEEPALIVE_OFF_KEY);
  }
});

test('countGate adds one to a gate on a day, moves one away, and keeps the last 14 days', () => {
  let c = countGate(null, '2026-11-01', 'passed');
  c = countGate(c, '2026-11-01', 'passed');
  c = countGate(c, '2026-11-01', 'state complete');
  assert.deepEqual(c, { '2026-11-01': { passed: 2, 'state complete': 1 } });
  c = countGate(c, '2026-11-01', 'state complete', -1);
  assert.deepEqual(c, { '2026-11-01': { passed: 2 } }, 'a gate counted to nothing goes');
  for (let d = 2; d <= 20; d++) c = countGate(c, `2026-11-${String(d).padStart(2, '0')}`, 'hours');
  assert.equal(Object.keys(c).length, 14);
  assert.ok(!c['2026-11-06'] && c['2026-11-07'] && c['2026-11-20'], 'the oldest days go');
});

test('each due minion counts once under the gate that last turned it away in its window, or as passed (#1274)', async () => {
  store.deleteSetting(KEEPALIVE_GATES_KEY);
  const ready = minion();
  const done = minion();
  const later = minion();
  const night = minion();
  const end = pst(17);
  for (const id of [ready, done, later]) await realTurn(id, end);
  await realTurn(night, pst(23, 30));
  store.updateTicket(ready, { state: 'ready' });
  store.updateTicket(done, { state: 'complete' });
  store.updateTicket(later, { state: 'complete' });
  store.updateTicket(night, { state: 'ready' });
  const before = callCount();
  runner.keepaliveSweep(end + 54 * 60_000);
  assert.equal(store.getSetting(KEEPALIVE_GATES_KEY), null, 'not due yet: nothing counted');
  runner.keepaliveSweep(end + KEEPALIVE_AFTER_MS);
  await until('the keepalive to run', () => callCount() > before);
  await idle(ready);
  assert.deepEqual(store.getSetting(KEEPALIVE_GATES_KEY), { '2026-11-16': { passed: 1, 'state complete': 2 } });
  // A minute later in the same window: the complete one isn't counted again; the one now waiting on a person moves to passed.
  store.updateTicket(later, { state: 'ready' });
  runner.keepaliveSweep(end + KEEPALIVE_AFTER_MS + 60_000);
  await until('the second keepalive to run', () => callCount() > before + 1);
  await idle(later);
  runner.keepaliveSweep(pst(23, 30) + KEEPALIVE_AFTER_MS); // 00:25 Pacific, the next day
  await idle(night);
  assert.deepEqual(store.getSetting(KEEPALIVE_GATES_KEY), {
    '2026-11-17': { hours: 1 },
    '2026-11-16': { passed: 2, 'state complete': 1 },
  });
  assert.equal(callCount(), before + 2, 'only the minions waiting on a person in hours were pinged');
});
