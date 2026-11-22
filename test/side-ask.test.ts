// Side questions (#932): a read-only fork of a minion's session answers on the side, mid-turn too, and nothing of it
// reaches the minion's own session, history or next turn.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { transcriptPath } from '../src/sessions.ts';
import { SIDE_LIMIT_MS, SideAsks } from '../src/side-ask.ts';
import { jsonLines, stopTurns, testPins, until } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'side-ask-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
const config = join(root, 'claude');
process.env.CLAUDE_CONFIG_DIR = config;
const seen = join(root, 'seen.jsonl');
const release = join(root, 'release');
// A claude that keeps transcripts as the real one does: --resume appends to one, --fork-session copies it to a new id
// first. It logs each run's args, prompt and settings; a prompt with "WAIT" runs until the release file appears.
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const at = args.indexOf('--resume');
const resume = at >= 0 ? args[at + 1] : null;
const fork = args.includes('--fork-session');
const settings = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
require('node:readline').createInterface({ input: process.stdin }).once('line', (prompt) => {
  // Try a write and a read through every PreToolUse hook, as Claude Code would before running the tool.
  const hooks = (settings.hooks?.PreToolUse ?? []).flatMap((h) => h.hooks.map((x) => x.command));
  const tryTool = (input) => hooks.map((c) => require('node:child_process').spawnSync('sh', ['-c', c], { input: JSON.stringify(input), encoding: 'utf8' }))
    .map((r) => ({ status: r.status, stderr: r.stderr }));
  const write = tryTool({ tool_name: 'Write', tool_input: { file_path: join(process.cwd(), 'x'), content: 'x' } });
  const rm = tryTool({ tool_name: 'Bash', tool_input: { command: 'rm -rf ' + process.cwd() } });
  const read = tryTool({ tool_name: 'Bash', tool_input: { command: 'git log --oneline -3' } });
  appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ resume, fork, prompt, hooks, write, rm, read }) + '\\n');
  if (resume && !existsSync(join(dir, resume + '.jsonl'))) {
    console.log(JSON.stringify({ type: 'result', is_error: true, result: 'No conversation found with session ID: ' + resume }));
    process.exit(1);
  }
  const id = !resume || fork ? 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) : resume;
  mkdirSync(dir, { recursive: true });
  if (fork) copyFileSync(join(dir, resume + '.jsonl'), join(dir, id + '.jsonl'));
  appendFileSync(join(dir, id + '.jsonl'), prompt + '\\n');
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id }));
  const done = () => {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'answer to ' + JSON.parse(prompt).message.content[0].text.slice(-20), session_id: id, total_cost_usd: 0.25, duration_ms: 5 }));
    process.exit(0);
  };
  if (!prompt.includes('WAIT')) return done();
  const wait = setInterval(() => existsSync(${JSON.stringify(release)}) && (clearInterval(wait), done()), 20);
});
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const cara = store.createUser({ name: 'Cara', login: 'cara', server_login: true });
const josh = store.createUser({ name: 'Josh', login: 'josh' });
const sent: any[] = [];
const runner = new Runner(store, (m) => sent.push(m), () => ({}), fake);
runner.resumeGapMs = 10;
runner.pollMs = 10;
runner.personOf = (author) => (author === 'Cara' ? cara.id : author === 'Josh' ? josh.id : null);
runner.placeFor = () => ({ host: true });
const sides = new SideAsks(store, runner, (m) => sent.push(m), 10);

const runs = () => jsonLines(seen);
const answers = (id: number) => store.listEvents(id).filter((e) => e.kind === 'side_answer').map((e) => JSON.parse(e.data));

async function minion() {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(root, `wt-${t.id}`);
  mkdirSync(cwd);
  store.setTicketDir(t.id, cwd, null);
  runner.send(t.id, 'Cara', 'build the thing');
  await until('it', () => store.getTicket(t.id)!.status === 'idle' && !!store.getTicket(t.id)!.session_id);
  return { id: t.id, cwd, session: store.getTicket(t.id)!.session_id! };
}

test("a side question leaves the minion's session, history and next turn untouched", async () => {
  rmSync(seen, { force: true });
  const m = await minion();
  const main = transcriptPath(config, m.cwd, m.session)!;
  const before = readFileSync(main, 'utf8');
  const events = store.listEvents(m.id).filter((e) => !e.kind.startsWith('side')).length;

  const ev = sides.ask(m.id, josh.id, 'Josh', 'what is going on?');
  await until('it', () => answers(m.id).length === 1);
  const [a] = answers(m.id);
  assert.equal(a.ok, true, a.text);
  assert.equal(a.thread, ev.thread);
  assert.equal(readFileSync(main, 'utf8'), before, "the minion's transcript is byte for byte as it was");
  const fork = runs().at(-1);
  assert.equal(fork.resume, m.session);
  assert.equal(fork.fork, true, 'the minion\'s session is forked, never resumed');
  assert.match(fork.prompt, /\[Josh\]: .*side question.*what is going on\?/s);

  assert.equal(store.getTicket(m.id)!.session_id, m.session);
  assert.equal(store.listEvents(m.id).filter((e) => !e.kind.startsWith('side')).length, events, 'no chat entry but the side thread\'s own');

  // Its cost is Josh's, marked as a side question, and kept out of the minion's own turns.
  const row = store.db.prepare('SELECT * FROM turns WHERE ticket_id = ? AND side = 1').get(m.id) as any;
  assert.equal(row.payer, josh.id);
  assert.equal(row.cost_usd, 0.25);
  assert.notEqual(row.session_id, m.session);

  // The minion's next turn resumes its own session, and its prompt carries nothing of the side question.
  runner.send(m.id, 'Cara', 'carry on');
  await until('it', () => runs().length === 3 && store.getTicket(m.id)!.status === 'idle');
  const next = runs().at(-1);
  assert.equal(next.resume, m.session);
  assert.equal(next.fork, false);
  assert.doesNotMatch(next.prompt, /what is going on|side question|answer to/);
  assert.doesNotMatch(readFileSync(main, 'utf8'), /what is going on/);
});

test('a follow-up resumes the fork, only its asker may send one, and an ended thread deletes the fork', async () => {
  rmSync(seen, { force: true });
  const m = await minion();
  const ev = sides.ask(m.id, cara.id, 'Cara', 'first?');
  await until('it', () => answers(m.id).length === 1);
  const forkId = (store.db.prepare('SELECT session_id FROM turns WHERE ticket_id = ? AND side = 1').get(m.id) as any).session_id;
  assert.throws(() => sides.ask(m.id, josh.id, 'Josh', 'me too?', ev.thread), /Only the person who started/);
  sides.ask(m.id, cara.id, 'Cara', 'and then?', ev.thread);
  await until('it', () => answers(m.id).length === 2);
  const follow = runs().at(-1);
  assert.equal(follow.resume, forkId);
  assert.equal(follow.fork, false);
  assert.doesNotMatch(follow.prompt, /side question/, 'the preamble is in the fork already');
  // A restart ends every thread and deletes its fork; the minion's own transcript stays.
  const forkFile = transcriptPath(config, m.cwd, forkId)!;
  assert.ok(existsSync(forkFile));
  new SideAsks(store, runner, () => {}, 10).recover();
  assert.ok(!existsSync(forkFile), 'the fork is deleted');
  assert.ok(existsSync(transcriptPath(config, m.cwd, m.session)!), "the minion's own transcript is kept");
});

test('it answers while the minion is mid-turn, and the fork runs with the read-only guard that refuses a write', async () => {
  rmSync(seen, { force: true });
  rmSync(release, { force: true });
  const m = await minion();
  runner.send(m.id, 'Cara', 'WAIT on the long job');
  await until('it', () => runs().length === 2);
  assert.equal(store.getTicket(m.id)!.status, 'running');
  sides.ask(m.id, cara.id, 'Cara', 'is it stuck?');
  await until('it', () => answers(m.id).length === 1);
  assert.equal(store.getTicket(m.id)!.status, 'running', 'the answer came before the turn ended');
  assert.equal(answers(m.id)[0].ok, true, answers(m.id)[0].text);
  writeFileSync(release, '');
  await until('it', () => store.getTicket(m.id)!.status === 'idle');

  // The fork's own hooks refuse a write, as Claude Code runs them; the minion's turns run without the guard.
  const fork = runs().find((r) => r.fork);
  // Every PreToolUse check runs in one process (src/hook-run.ts, #1296): the side guard is on when its config says side.
  const side = /"side":true/;
  assert.ok(fork.hooks.some((c: string) => side.test(c)), 'the fork runs with the side guard');
  assert.ok(!runs().filter((r) => !r.fork).some((r) => r.hooks.some((c: string) => side.test(c))));
  const refused = (results: { status: number; stderr: string }[]) => results.find((r) => r.status === 2);
  assert.match(refused(fork.write)?.stderr ?? '', /\[side question\].*read-only/, JSON.stringify(fork.write));
  assert.ok(refused(fork.rm), JSON.stringify(fork.rm));
  assert.ok(fork.read.every((r: any) => r.status === 0), JSON.stringify(fork.read));
  assert.ok(!existsSync(join(m.cwd, 'x')));
});
test('refuses a minion with no session, a thread that ended, and a second ask while one is answering', () => {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  assert.throws(() => sides.ask(t.id, cara.id, 'Cara', 'hi'), /no session/);
  store.updateTicket(t.id, { session_id: 'sess-x' });
  assert.throws(() => sides.ask(t.id, cara.id, 'Cara', 'hi', 999999), /ended/);
});

test("an answer that lands between the tick's two looks is not lost (#1619)", async () => {
  const m = await minion();
  const hand: any = new SideAsks(store, runner, (msg) => sent.push(msg), 60_000); // polled by hand below
  const ev = hand.ask(m.id, cara.id, 'Cara', 'who is asking?');
  const dir: string = hand.threads.get(ev.thread).run.dir;
  const stream = join(dir, 'stream.jsonl');
  const exit = join(dir, 'exit.json');
  await until('the fork to exit', () => existsSync(exit));
  const printed = readFileSync(stream, 'utf8');
  // Back to the moment before claude printed anything. This time its answer and its exit land in the gap between the
  // tick's read of the stream and its look for exit.json, where a loaded box can leave the tick for whole milliseconds;
  // and its last line has no newline, as a stream that ends with the process can.
  writeFileSync(stream, '');
  rmSync(exit);
  let gaps = 0;
  const read = hand.read.bind(hand);
  hand.read = (t: any, toEnd: boolean) => {
    read(t, toEnd);
    if (gaps++) return;
    writeFileSync(stream, printed.trimEnd());
    writeFileSync(exit, '{"code":0,"signal":null}');
  };
  hand.poll();
  hand.poll();
  assert.ok(gaps >= 1, 'the gap was never exercised: a tick no longer reads the stream');
  const a = answers(m.id).at(-1)!;
  assert.equal(a.ok, true, a.text);
  assert.match(a.text, /answer to/);
});

test('an answer printed just before the deadline counts, not a timeout (#1619)', async () => {
  const m = await minion();
  const hand: any = new SideAsks(store, runner, (msg) => sent.push(msg), 60_000); // polled by hand below
  const ev = hand.ask(m.id, cara.id, 'Cara', 'who is asking?');
  const run = hand.threads.get(ev.thread).run;
  await until('the fork to exit', () => existsSync(join(run.dir, 'exit.json')));
  // The answer is in the stream, but the shell has not written exit.json yet and the ask is past its limit: it is
  // killed, and the answer it did give is the answer, not "it took longer than 15 minutes".
  rmSync(join(run.dir, 'exit.json'));
  run.startedAt = Date.now() - SIDE_LIMIT_MS - 1;
  hand.poll();
  const a = answers(m.id).at(-1)!;
  assert.equal(a.ok, true, a.text);
  assert.match(a.text, /answer to/);
});
