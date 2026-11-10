import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { codexSwitchKey, codexThreadKey, codexUsageKey, type CodexThread } from '../src/codex.ts';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { stopTurns, testPins } from './helpers.ts';
testPins();

// Codex fallback (#337) through the runner: a Codex pick or the person's switch runs the turn on the shim
// (src/codex-turn.ts) in their container, with the Claude conversation handed over verbatim; the first
// Claude turn after gets the Codex turns, then their thread goes. A fake claude and a fake codex app-server.
const root = mkdtempSync(join(tmpdir(), 'codex-runner-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'host-claude');
const bin = join(root, 'bin');
mkdirSync(bin);
// A fake podman whose exec runs on the host, as in person-switch-session.test.ts.
writeFileSync(join(bin, 'podman'), `#!${process.execPath}
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] !== 'exec') process.exit(0);
require('node:fs').appendFileSync(${JSON.stringify(join(root, 'seen.jsonl'))}, JSON.stringify({ who: 'podman', args }) + '\\n');
const [cmd, ...rest] = args.slice(3);
spawn(cmd === 'node' ? process.execPath : cmd, rest, { detached: true, stdio: 'ignore' }).unref();
`);
chmodSync(join(bin, 'podman'), 0o755);

// What each turn got: claude's args and prompt, codex's requests.
const seen = join(root, 'seen.jsonl');
const mode = join(root, 'mode');
const record = (who: string) => `(m) => require('node:fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ who: ${JSON.stringify(who)}, ...m }) + '\\n')`;
const claude = join(root, 'claude-fake');
writeFileSync(claude, `#!${process.execPath}
const { appendFileSync, existsSync, mkdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const record = ${record('claude')};
const args = process.argv.slice(2);
const at = args.indexOf('--resume');
const resume = at >= 0 ? args[at + 1] : null;
const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
require('node:readline').createInterface({ input: process.stdin }).once('line', (line) => {
  const text = JSON.parse(line).message.content.map((b) => b.text ?? '').join('\\n');
  const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : null;
  // The turn's Codex config, which names the container a host turn's Codex review runs in (#398).
  const codex = process.env.CITADEL_CODEX_TRIPWIRE ? JSON.parse(readFileSync(process.env.CITADEL_CODEX_TRIPWIRE, 'utf8')) : null;
  record({ resume, model, text, codex });
  if (existsSync(${JSON.stringify(mode)}) && readFileSync(${JSON.stringify(mode)}, 'utf8') === 'claude-limit') {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit · resets 3pm (UTC)" }));
    process.exit(1);
  }
  const id = resume ?? 'sess-1';
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, id + '.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\\n' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'CLAUDE REPLY' }] } }) + '\\n');
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id, model: 'claude-opus-5-5' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: id }));
  process.exit(0);
});
`);
chmodSync(claude, 0o755);
writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const { existsSync, readFileSync } = require('node:fs');
const record = ${record('codex')};
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const note = (method, params) => send({ method, params: { threadId: 'th1', turnId: 'tu1', ...params } });
const limited = existsSync(${JSON.stringify(mode)}) && readFileSync(${JSON.stringify(mode)}, 'utf8') === 'codex-limit';
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method && m.id !== undefined && !['initialize', 'account/rateLimits/read'].includes(m.method)) record({ method: m.method, params: m.params });
  if (m.id === undefined) return;
  if (m.method === 'thread/start' || m.method === 'thread/resume') return send({ id: m.id, result: { thread: { id: m.params.threadId ?? 'th1' } } });
  if (m.method === 'account/rateLimits/read') return send({ id: m.id, result: { rateLimits: { primary: { usedPercent: 20, resetsAt: 2000000000, windowDurationMins: 300 }, secondary: null } } });
  if (m.method !== 'turn/start') return send({ id: m.id, result: {} });
  send({ id: m.id, result: { turn: { id: 'tu1' } } });
  if (limited) {
    note('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 7200, windowDurationMins: 300 }, secondary: null } });
    return note('turn/completed', { turn: { id: 'tu1', status: 'failed', error: { message: 'usage limit', codexErrorInfo: 'usageLimitExceeded' } } });
  }
  note('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'npm test', aggregatedOutput: 'CODEX OUTPUT', exitCode: 0, status: 'completed' } });
  note('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'CODEX REPLY' } });
  note('turn/completed', { turn: { id: 'tu1', status: 'completed' } });
});
`);
chmodSync(join(bin, 'codex'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const josh = store.createUser({ name: 'Josh', login: 'josh' });
const cara = store.createUser({ name: 'Cara', login: 'cara', server_login: true });
const volume = join(root, 'josh-volume');
mkdirSync(join(volume, '.claude'), { recursive: true });
const joshPlace = { host: false as const, container: 'citadel-claude-test-2', configDir: join(volume, '.claude'), home: volume, turnsDir: join(root, 'run', 'turns', `person-${josh.id}`), env: { HOME: volume, CLAUDE_CONFIG_DIR: join(volume, '.claude') }, ensure: async () => {} };
let signedIn = true;
// The server login's Codex-only container (#341): Claude's config is the host's, where her sessions are.
const caraVolume = join(root, 'cara-volume');
const caraPlace = { host: false as const, container: 'citadel-claude-test-cara', configDir: process.env.CLAUDE_CONFIG_DIR!, home: caraVolume, turnsDir: join(root, 'run', 'turns', `person-${cara.id}`), env: { HOME: caraVolume, CLAUDE_CONFIG_DIR: join(caraVolume, '.claude') }, ensure: async () => {} };
let caraContainer = true;

function runner() {
  const r = new Runner(store, () => {}, () => ({ COORDINATOR_TOKEN: 'secret' }), claude);
  r.pollMs = 10;
  r.limitDelayMs = 0;
  r.personOf = (author) => (author === 'Josh' ? josh.id : author === 'Cara' ? cara.id : null);
  r.placeFor = (uid) => (uid === josh.id ? joshPlace : { host: true });
  r.codexReady = () => (signedIn ? null : 'you are not signed in to Codex');
  r.codexPlaceFor = (uid) => (uid === cara.id && caraContainer ? caraPlace : null);
  return r;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), 'timed out');
}
const calls = () => (existsSync(seen) ? readFileSync(seen, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const notes = (id: number) => store.listEvents(id).filter((e) => e.kind === 'note').map((e) => JSON.parse(e.data).text as string);
const turnStarts = () => calls().filter((c) => c.who === 'claude' || c.method === 'turn/start');
function minion(n: number) {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Josh' });
  const cwd = join(root, `wt-${n}`);
  mkdirSync(cwd);
  store.setTicketDir(t.id, cwd, null);
  return t;
}
const idle = (id: number) => () => store.getTicket(id)!.status !== 'running' && !store.getSetting(`saving:${id}`);

test('the switch moves a minion to Codex with its Claude conversation, keeps the thread, and hands the Codex turns back to Claude', async () => {
  rmSync(seen, { force: true });
  rmSync(mode, { force: true });
  const t = minion(1);
  store.updateTicket(t.id, { model: 'claude-opus-5-5' });
  const r = runner();
  r.send(t.id, 'Josh', 'first ask');
  await until(() => turnStarts().length === 1 && idle(t.id)());

  assert.equal(r.setCodexSwitch(josh.id, true), null);
  r.send(t.id, 'Josh', 'second ask');
  await until(() => turnStarts().length === 2 && idle(t.id)());
  const start = calls().find((c) => c.method === 'thread/start');
  assert.equal(start.params.model, 'gpt-6-astra', 'Opus maps to the frontier Codex model');
  const first = calls().filter((c) => c.method === 'turn/start')[0].params;
  const said = first.input.map((i: any) => i.text).join('\n');
  assert.match(said, /<conversation>[\s\S]*\[Message\] \[Josh\]: first ask[\s\S]*\[Claude\] CLAUDE REPLY[\s\S]*<\/conversation>/);
  assert.match(said, /second ask/);
  const kept = store.getSetting<CodexThread>(codexThreadKey(t.id))!;
  assert.equal(kept.thread, 'th1');
  assert.equal(kept.person, josh.id);
  assert.match(kept.log, /CODEX OUTPUT/);
  assert.equal(store.getTicket(t.id)!.session_id, 'sess-1', "the Claude session stays the minion's");
  assert.ok(store.getSetting(codexUsageKey(josh.id)), "Codex's usage is kept for the bar");

  r.send(t.id, 'Josh', 'third ask');
  await until(() => turnStarts().length === 3 && idle(t.id)());
  const resumed = calls().filter((c) => c.method === 'thread/resume');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].params.threadId, 'th1');
  const third = calls().filter((c) => c.method === 'turn/start')[1].params.input.map((i: any) => i.text).join('\n');
  assert.doesNotMatch(third, /<conversation>/, 'a resumed thread needs no hand-over');

  assert.equal(r.setCodexSwitch(josh.id, false), null);
  r.send(t.id, 'Josh', 'fourth ask');
  await until(() => turnStarts().length === 4 && idle(t.id)());
  const back = calls().filter((c) => c.who === 'claude')[1];
  assert.equal(back.resume, 'sess-1');
  assert.equal(back.model, 'claude-opus-5-5');
  assert.match(back.text, /<codex-turns>[\s\S]*second ask[\s\S]*CODEX OUTPUT[\s\S]*CODEX REPLY[\s\S]*third ask[\s\S]*<\/codex-turns>[\s\S]*fourth ask/);
  assert.equal(store.getSetting(codexThreadKey(t.id)), null, 'Claude has the Codex turns now');
});

test("a hand-back Claude turn that fails keeps the Codex turns but not their thread, so Codex starts afresh from the hand-over", async () => {
  rmSync(seen, { force: true });
  rmSync(mode, { force: true });
  const t = minion(4);
  const r = runner();
  assert.equal(r.setCodexSwitch(josh.id, true), null);
  r.send(t.id, 'Josh', 'on codex');
  await until(() => turnStarts().length === 1 && idle(t.id)());
  assert.equal(store.getSetting<CodexThread>(codexThreadKey(t.id))!.thread, 'th1');

  r.setCodexSwitch(josh.id, false);
  writeFileSync(mode, 'claude-limit');
  r.send(t.id, 'Josh', 'back on claude');
  await until(() => turnStarts().length === 2 && idle(t.id)());
  const kept = store.getSetting<CodexThread>(codexThreadKey(t.id))!;
  assert.equal(kept.thread, null, "its thread never saw the Claude turn");
  assert.match(kept.log, /on codex/);
  r.cancelLimitWait(t.id);

  rmSync(mode, { force: true });
  r.setCodexSwitch(josh.id, true);
  r.send(t.id, 'Josh', 'codex again');
  await until(() => turnStarts().length === 3 && idle(t.id)());
  assert.equal(calls().filter((c) => c.method === 'thread/resume').length, 0);
  assert.equal(calls().filter((c) => c.method === 'thread/start').length, 2);
  const said = calls().filter((c) => c.method === 'turn/start')[1].params.input.map((i: any) => i.text).join('\n');
  assert.match(said, /<conversation>[\s\S]*on codex[\s\S]*<\/conversation>[\s\S]*codex again/);
  r.setCodexSwitch(josh.id, false);
});

test("a Codex pick by someone without Codex runs on Claude's default, saying why", async () => {
  rmSync(seen, { force: true });
  signedIn = false;
  const t = minion(2);
  store.updateTicket(t.id, { model: 'gpt-6-luna' });
  const r = runner();
  r.send(t.id, 'Josh', 'go');
  await until(() => turnStarts().length === 1 && idle(t.id)());
  signedIn = true;
  assert.equal(turnStarts()[0].who, 'claude');
  assert.equal(turnStarts()[0].model, null, "no Codex model reaches claude");
  assert.ok(notes(t.id).some((n) => n.includes('set to GPT-6 Luna, but you are not signed in to Codex')));
});

test('the server login runs its Codex turns in its own container, from its Claude conversation on the host, and its Claude turns stay on the host (#341)', async () => {
  rmSync(seen, { force: true });
  rmSync(mode, { force: true });
  const t = minion(10);
  const r = runner();
  r.send(t.id, 'Cara', 'first ask');
  await until(() => turnStarts().length === 1 && idle(t.id)());
  assert.ok(!calls().some((c) => c.who === 'podman'), 'her Claude turn runs on the host');

  assert.equal(r.setCodexSwitch(cara.id, true), null);
  assert.equal(r.codexView(cara.id)?.on, true);
  r.send(t.id, 'Cara', 'second ask');
  await until(() => turnStarts().length === 2 && idle(t.id)());
  const exec = calls().find((c) => c.who === 'podman')!.args;
  assert.deepEqual(exec.slice(0, 3), ['exec', '-d', caraPlace.container]);
  assert.ok(exec.at(-1).startsWith(caraPlace.turnsDir + '/'), `its turn folder is the one her container mounts: ${exec.at(-1)}`);
  const said = calls().find((c) => c.method === 'turn/start').params.input.map((i: any) => i.text).join('\n');
  assert.match(said, /\[Message\] \[Cara\]: first ask[\s\S]*\[Claude\] CLAUDE REPLY/, 'the hand-over is her host Claude conversation');

  r.setCodexSwitch(cara.id, false);
  r.send(t.id, 'Cara', 'third ask');
  await until(() => turnStarts().length === 3 && idle(t.id)());
  assert.equal(calls().filter((c) => c.who === 'podman').length, 1, 'back on Claude, on the host');
  assert.match(calls().filter((c) => c.who === 'claude').at(-1).text, /CODEX REPLY/);
});

test("the server login's Codex turn runs on Claude, saying why, until its container is there; never Codex on the host", async () => {
  rmSync(seen, { force: true });
  const t = minion(11);
  const r = runner();
  caraContainer = false;
  try {
    assert.equal(r.setCodexSwitch(cara.id, true), null);
    r.send(t.id, 'Cara', 'go');
    await until(() => turnStarts().length === 1 && idle(t.id)());
    assert.equal(turnStarts()[0].who, 'claude');
    assert.ok(!calls().some((c) => c.who === 'podman'));
    assert.ok(notes(t.id).some((n) => /Codex's container isn't there yet/.test(n)));
  } finally {
    caraContainer = true;
    r.setCodexSwitch(cara.id, false);
  }
});

test("switching on carries a minion waiting out Claude's limit on at once, on Codex; Codex's own limit waits for Codex's reset", async () => {
  rmSync(seen, { force: true });
  writeFileSync(mode, 'claude-limit');
  const t = minion(3);
  const r = runner();
  r.setCodexSwitch(josh.id, false);
  r.send(t.id, 'Josh', 'go');
  await until(() => store.getTicket(t.id)!.state === 'limited' && idle(t.id)());
  assert.ok(r.limitWait(t.id));

  writeFileSync(mode, 'codex-limit');
  assert.equal(r.setCodexSwitch(josh.id, true), null);
  await until(() => calls().some((c) => c.method === 'turn/start') && idle(t.id)() && store.getTicket(t.id)!.state === 'limited');
  const said = calls().find((c) => c.method === 'turn/start').params.input.map((i: any) => i.text).join('\n');
  assert.match(said, /switched to Codex/);
  assert.ok(notes(t.id).includes('Resumed on Codex: its person switched to Codex'));
  // Codex's window resets in two hours (the fake's), not Claude's 3pm.
  const w = r.limitWait(t.id)!;
  assert.ok(Math.abs(w.at - (Date.now() + 7_200_000)) < 120_000, `waits for Codex's reset, ${new Date(w.at).toISOString()}`);
  r.cancelLimitWait(t.id);
  r.setCodexSwitch(josh.id, false);
  rmSync(mode, { force: true });
});

test("the server login's host turns name its Codex container for their Codex reviews and wake it; nobody else's turn does (#398)", async () => {
  rmSync(seen, { force: true });
  rmSync(mode, { force: true });
  const r = runner();
  const woken: number[] = [];
  r.wakeCodex = (uid) => woken.push(uid);
  const t = minion(12);
  r.send(t.id, 'Cara', 'review this');
  await until(() => turnStarts().length === 1 && idle(t.id)());
  const host = calls().find((c) => c.who === 'claude');
  assert.deepEqual(host.codex.container, { name: caraPlace.container, turnsDir: caraPlace.turnsDir, env: caraPlace.env });
  assert.equal(host.codex.mode, undefined, 'the review-mode config, as container turns get it');
  assert.deepEqual(woken, [cara.id]);

  caraContainer = false;
  try {
    r.send(t.id, 'Cara', 'again, before her Codex sign-in');
    await until(() => turnStarts().length === 2 && idle(t.id)());
    assert.equal(calls().filter((c) => c.who === 'claude')[1].codex.container, undefined);
  } finally {
    caraContainer = true;
  }

  const j = minion(13);
  r.send(j.id, 'Josh', 'his turn, in his own container');
  await until(() => turnStarts().length === 3 && idle(j.id)());
  assert.equal(calls().filter((c) => c.who === 'claude')[2].codex.container, undefined);
  assert.deepEqual(woken, [cara.id]);
});

test('every Codex model can be picked for a minion', async () => {
  const { MODELS } = await import('../src/db.ts');
  const { CODEX_MODELS } = await import('../src/codex.ts');
  for (const [id] of CODEX_MODELS) assert.ok((MODELS as readonly string[]).includes(id), id);
});
