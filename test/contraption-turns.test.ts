// The turn API (src/contraption-turns.ts, the brief's section 4): who a turn runs for and on whose
// Claude, what the turn can reach (read off the real claude invocation), sessions, busy, caps, cancel,
// and that Citadel keeps no turn text.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { bootServer, until, stopTurns } from './helpers.ts';

// The runner (which the turn module borrows from) pins files under $DATA_DIR/run when it loads.
const root = mkdtempSync(join(tmpdir(), 'contraption-turns-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
const data = join(root, 'data');
process.env.DATA_DIR = data;
const { ContraptionTurns, parseTurn, TurnError } = await import('../src/contraption-turns.ts');

// A stand-in for claude: logs what it was started with (argv, cwd, env, and the settings and MCP config
// files it was pointed at, read while it runs), keeps a transcript file like claude does, and replies
// according to its prompt.
const log = join(root, 'claude.jsonl');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const read = (f) => f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const session = opt('--resume') ?? opt('--session-id');
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
    argv, cwd: process.cwd(), env: process.env, prompt, pid: process.pid, cwdFiles: fs.readdirSync(process.cwd()),
    settings: read(opt('--settings')), mcp: read(opt('--mcp-config')), system: read(opt('--append-system-prompt-file')),
  }) + '\\n');
  const out = (o) => console.log(JSON.stringify(o));
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, session + '.jsonl'), JSON.stringify({ prompt }) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: session, tools: [] });
  if (prompt.includes('slow')) return setInterval(() => {}, 1000);
  if (prompt.includes('plan limit')) { out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your 5-hour limit · resets 3pm" }); process.exit(1); }
  if (prompt.includes('expired')) { out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 401 authentication_error OAuth token has expired' }); process.exit(1); }
  if (prompt.includes('crash')) { process.stderr.write('boom\\n'); process.exit(3); }
  if (prompt.includes('grunts')) {
    // As Claude Code 2.1.316 streams it: a Grunt's events carry its Agent call's id; one it starts shows only as its Agent call.
    const g = 'ag1', p = { parent_tool_use_id: g };
    out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'Asking. ' }, { type: 'tool_use', id: g, name: 'Agent', input: { prompt: 'look' } }] } });
    out({ type: 'user', ...p, message: { content: [{ type: 'text', text: 'GRUNT PROMPT' }] } });
    out({ type: 'stream_event', ...p, event: { type: 'message_start', message: { id: 'g1' } } });
    out({ type: 'stream_event', ...p, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'GRUNT STREAMED' } } });
    out({ type: 'assistant', ...p, message: { id: 'g1', content: [{ type: 'text', text: 'GRUNT SAID' }, { type: 'tool_use', id: 'gt1', name: 'mcp__mandate__list', input: {} }] } });
    out({ type: 'user', ...p, message: { content: [{ type: 'tool_result', tool_use_id: 'gt1', is_error: true, content: 'x' }] } });
    out({ type: 'assistant', ...p, message: { id: 'g2', content: [{ type: 'tool_use', id: 'ag2', name: 'Agent', input: { prompt: 'deeper' } }] } });
    out({ type: 'user', ...p, message: { content: [{ type: 'tool_result', tool_use_id: 'ag2', content: 'x' }] } });
    out({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: g, content: 'x' }] } });
    out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'text', text: 'Done.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'Done.', usage: {} });
    return;
  }
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Moved ' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'it' } } });
  out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Moved it' }] } });
  out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__mandate__move', input: { to: 'Thursday' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'SECRET TOOL OUTPUT' }] } });
  out({ type: 'system', subtype: 'compact_boundary' });
  // No partial stream for this message: its text still arrives, once.
  out({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: ' to Thursday.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'Moved it to Thursday.',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } });
});
`,
);
chmodSync(fake, 0o755);
const runs = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastRun = () => runs().at(-1);
const argAfter = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

// podman, for container turns: `exec -i -w <dir> -e K=V… <container> <cmd…>` runs the command here (it
// logs its own argv), with the container's ~/.citadel (in the person's volume) at vol-josh's; `exec <container> kill …` too.
const podmanLog = join(root, 'podman.jsonl');
const podman = join(root, 'podman-fake');
writeFileSync(
  podman,
  `#!${process.execPath}
const fs = require('node:fs'), { spawn } = require('node:child_process');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(podmanLog)}, JSON.stringify(a) + '\\n');
const home = ${JSON.stringify(homedir())}, vol = ${JSON.stringify(join(root, 'vol-josh'))};
const m = (s) => (s.startsWith(home + '/.citadel/') ? vol + s.slice(home.length) : s);
let i = 1, env = { ...process.env }, cwd;
if (a[i] === '-i') i++;
if (a[i] === '-w') { cwd = m(a[i + 1]); i += 2; }
while (a[i] === '-e') { const [k, ...v] = a[i + 1].split('='); env[k] = v.join('='); i += 2; }
const child = spawn(a[i + 1], a.slice(i + 2).map(m), { env, cwd, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
`,
);
chmodSync(podman, 0o755);

const claudeDir = join(root, 'claude');
const store = new Store(join(data, 'coordinator.db'));
const contraptions = new Contraptions(store, 's'.repeat(40), join(root, 'keys'));
const fields = { title: 'Mandate', port: 9101, icon: null, home_scheme: null, open_paths: '[]', default_model: 'haiku', turn_cap: null };
const mandate = contraptions.register({ name: 'mandate', ...fields });
const peek = contraptions.register({ name: 'peek-auras', ...fields, title: 'Peek Auras', default_model: null });
const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
const josh = store.createUser({ name: 'Josh', login: 'josh' });
const olive = store.createUser({ name: 'Olive', login: 'olive' });
for (const c of [mandate, peek]) for (const u of [cara, josh, olive]) store.setContraptionUser(c.id, u.id, true, cara.id);

// Cara runs on the host (the server login); Josh in his container; Olive has linked nothing.
const vol = join(root, 'vol-josh');
const expired: number[] = [];
const places = {
  place(uid: number | null) {
    if (uid === cara.id) return { host: true as const };
    if (uid === josh.id) {
      return { host: false as const, container: 'citadel-claude-t-2', configDir: join(vol, '.claude'), turnsDir: join(root, 'run', 'turns', 'person-2'), env: { HOME: homedir(), CLAUDE_CONFIG_DIR: join(vol, '.claude'), DISABLE_AUTOUPDATER: '1' }, ensure: async () => {} };
    }
    return null;
  },
  expire: (uid: number) => expired.push(uid),
};
// The server's own environment: what must and mustn't reach a turn.
const serverEnv = {
  PATH: process.env.PATH, HOME: homedir(), CLAUDE_CONFIG_DIR: claudeDir, ANTHROPIC_API_KEY: 'server-key', COORDINATOR_TOKEN: 'service-token',
  SESSION_SECRET: 'nope', SSH_AUTH_SOCK: '/tmp/agent.sock', LANG: 'C.UTF-8',
};
const turns = new ContraptionTurns(store, contraptions, places, { dataDir: data, claudeBin: fake, podman, env: serverEnv });

type Ev = { event: string; data: any };
async function turn(c: typeof mandate, body: object): Promise<Ev[]> {
  const evs: Ev[] = [];
  try {
    await turns.run(c, parseTurn({ person: cara.id, session: 'acolyte', prompt: 'Move my dentist to Thursday.', ...body }, c), (event, data) => evs.push({ event, data }));
  } catch (err) {
    if (!(err instanceof TurnError)) throw err;
    evs.push({ event: 'error', data: { code: err.code } });
  }
  return evs;
}
const errorOf = (evs: Ev[]) => evs.find((e) => e.event === 'error')?.data.code;

test('a turn has only the contraption\'s MCP and no built-in tools, settings, CLAUDE.md or memory of anyone\'s', async () => {
  const evs = await turn(mandate, {
    system: 'You are the Acolyte.', mcp: [{ name: 'mandate', path: '/mcp', headers: { Authorization: 'Bearer per-turn-token' } }],
  });
  const run = lastRun();
  // Built-in tools: none. Only these settings, MCP config and permissions, in an empty scratch folder.
  assert.equal(argAfter(run.argv, '--tools'), '');
  assert.equal(argAfter(run.argv, '--setting-sources'), '');
  assert.ok(run.argv.includes('--strict-mcp-config'));
  assert.ok(run.argv.includes('--disable-slash-commands'));
  assert.equal(argAfter(run.argv, '--permission-mode'), 'dontAsk');
  assert.equal(argAfter(run.argv, '--model'), 'haiku', 'the registry\'s default model');
  for (const flag of ['--plugin-dir', '--add-dir', '--dangerously-skip-permissions', '--allowedTools', '--allowed-tools']) assert.ok(!run.argv.includes(flag), flag);
  assert.equal(run.argv.filter((a: string) => a === '--mcp-config').length, 1);
  assert.deepEqual(JSON.parse(run.mcp), { mcpServers: { mandate: { type: 'http', url: 'http://127.0.0.1:9101/mcp', headers: { Authorization: 'Bearer per-turn-token' } } } });
  const settings = JSON.parse(run.settings);
  assert.deepEqual(settings.permissions, { allow: ['mcp__mandate'], defaultMode: 'dontAsk' });
  assert.equal(settings.hooks, undefined, 'no hooks without agents');
  assert.equal(settings.autoCompactWindow, 40_000);
  assert.equal(settings.autoMemoryEnabled, false);
  assert.equal(run.system, 'You are the Acolyte.');
  assert.equal(run.cwd, join(data, 'contraption-scratch', 'mandate', String(cara.id)));
  assert.deepEqual(run.cwdFiles, []);
  assert.equal(run.prompt, 'Move my dentist to Thursday.', 'the prompt goes on stdin, never in argv');
  assert.ok(!run.argv.some((a: string) => a.includes('dentist')));
  // The server login's owner keeps the server's Claude login; nothing else of the server's.
  assert.equal(run.env.ANTHROPIC_API_KEY, 'server-key');
  assert.equal(run.env.CLAUDE_CONFIG_DIR, claudeDir);
  for (const k of ['COORDINATOR_TOKEN', 'SESSION_SECRET', 'SSH_AUTH_SOCK']) assert.equal(run.env[k], undefined, k);
  assert.equal(run.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(run.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');

  // The reply: start, streamed text (each piece once), the tool call and whether it worked, compaction, end.
  const start = evs[0];
  assert.equal(start.event, 'start');
  assert.equal(start.data.session, 'acolyte');
  assert.match(start.data.claudeSession, /^[0-9a-f-]{36}$/);
  assert.equal(evs.filter((e) => e.event === 'text').map((e) => e.data.delta).join(''), 'Moved it to Thursday.');
  // Each piece names its message, streamed or not, so an app can split "Moved it" from " to Thursday.".
  assert.deepEqual(evs.filter((e) => e.event === 'text').map((e) => [e.data.message, e.data.delta]), [['m1', 'Moved '], ['m1', 'it'], ['m2', ' to Thursday.']]);
  assert.deepEqual(evs.filter((e) => e.event !== 'start' && e.event !== 'text'), [
    { event: 'tool', data: { id: 'tu1', name: 'mcp__mandate__move', input: { to: 'Thursday' }, parent: null } },
    { event: 'tool_result', data: { id: 'tu1', ok: true, parent: null } },
    { event: 'compacted', data: {} },
    { event: 'end', data: { stop: 'end_turn', usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 } } },
  ]);
  // The turn's folder (prompt, system prompt, MCP token) is gone once it ends.
  assert.deepEqual(readdirSync(join(data, 'run', 'contraption-turns')), []);
  // The meter: who, which session, tokens and time.
  const row = store.getContraptionTurn(start.data.turn)!;
  assert.deepEqual({ ...row, started_at: 0, ended_at: 0 }, {
    id: start.data.turn, contraption_id: mandate.id, user_id: cara.id, session: 'acolyte', started_at: 0, ended_at: 0, outcome: 'end',
    input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, cache_write_tokens: 20,
  });
});

test('with agents allowed, the turn gets Agent and nothing more, its model, and the cap\'s hook', async () => {
  await turn(mandate, { session: 'agents', agents: { max: 2, model: 'haiku' }, model: 'sonnet', compactWindow: 90_000, mcp: [{ name: 'mandate', path: '/mcp' }] });
  const run = lastRun();
  assert.equal(argAfter(run.argv, '--tools'), 'Agent');
  assert.equal(argAfter(run.argv, '--model'), 'sonnet');
  assert.equal(run.env.CLAUDE_CODE_SUBAGENT_MODEL, 'haiku');
  assert.equal(run.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1', 'an Agent call waits for its agent, so the hook can count');
  const settings = JSON.parse(run.settings);
  assert.deepEqual(settings.permissions.allow, ['mcp__mandate', 'Agent']);
  assert.equal(settings.autoCompactWindow, 90_000);
  for (const on of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
    assert.equal(settings.hooks[on][0].matcher, '^(Agent|Task)$');
    assert.match(settings.hooks[on][0].hooks[0].command, / '2'$/);
  }
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['PostToolUse', 'PostToolUseFailure', 'PreToolUse']);
});

test('a Grunt\'s tool calls and results carry its Agent call\'s id, the top level\'s carry null, and its words never stream', async () => {
  const evs = await turn(mandate, { session: 'grunts', prompt: 'Use grunts.', agents: { max: 2 }, mcp: [{ name: 'mandate', path: '/mcp' }] });
  assert.deepEqual(evs.filter((e) => e.event === 'tool' || e.event === 'tool_result' || e.event === 'text'), [
    { event: 'text', data: { delta: 'Asking. ', parent: null, message: 'm1' } },
    { event: 'tool', data: { id: 'ag1', name: 'Agent', input: { prompt: 'look' }, parent: null } },
    { event: 'tool', data: { id: 'gt1', name: 'mcp__mandate__list', input: {}, parent: 'ag1' } },
    { event: 'tool_result', data: { id: 'gt1', ok: false, parent: 'ag1' } },
    { event: 'tool', data: { id: 'ag2', name: 'Agent', input: { prompt: 'deeper' }, parent: 'ag1' } },
    { event: 'tool_result', data: { id: 'ag2', ok: true, parent: 'ag1' } },
    { event: 'tool_result', data: { id: 'ag1', ok: true, parent: null } },
    { event: 'text', data: { delta: 'Done.', parent: null, message: 'm2' } },
  ]);
  assert.ok(!JSON.stringify(evs).includes('GRUNT'), 'no Grunt prompt or words');
});

test('the Agent cap lets `max` agents run at once, nested ones included, and frees a slot when one ends', () => {
  const slots = join(root, 'slots');
  mkdirSync(slots);
  const hook = (event: string, id: string) =>
    execFileSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'contraption-agent-cap.ts'), slots, '2'], { input: JSON.stringify({ hook_event_name: event, tool_name: 'Agent', tool_use_id: id }) }).toString();
  assert.equal(hook('PreToolUse', 'a'), '');
  assert.equal(hook('PreToolUse', 'b'), '');
  assert.equal(JSON.parse(hook('PreToolUse', 'c')).hookSpecificOutput.permissionDecision, 'deny');
  hook('PostToolUse', 'a');
  assert.equal(hook('PreToolUse', 'c'), '');
  hook('PostToolUseFailure', 'b');
  hook('PostToolUse', 'c');
  assert.deepEqual(readdirSync(slots), []);
});

test('a turn for someone the contraption isn\'t enabled for is refused, and so is one with no linked plan', async () => {
  const before = store.contraptionTurnsSince(mandate.id, josh.id, 0);
  store.setContraptionUser(mandate.id, josh.id, false, cara.id);
  assert.equal(errorOf(await turn(mandate, { person: josh.id })), 'not_enabled');
  store.setContraptionUser(mandate.id, josh.id, true, cara.id);
  assert.equal(store.contraptionTurnsSince(mandate.id, josh.id, 0), before, 'a refused turn isn\'t metered');
  // No fallback to anyone else's plan.
  const n = runs().length;
  assert.equal(errorOf(await turn(mandate, { person: olive.id })), 'no_plan');
  assert.equal(runs().length, n, 'claude never started');
  assert.equal(errorOf(await turn(mandate, { person: 999 })), 'not_enabled');
});

test('a name resumes its own Claude session; fresh starts another; other contraptions and people never share it', async () => {
  const first = (await turn(mandate, { session: 'resume-me' }))[0].data.claudeSession;
  assert.equal(argAfter(lastRun().argv, '--session-id'), first);
  const again = (await turn(mandate, { session: 'resume-me' }))[0].data.claudeSession;
  assert.equal(again, first);
  assert.equal(argAfter(lastRun().argv, '--resume'), first);
  const fresh = (await turn(mandate, { session: 'resume-me', fresh: true }))[0].data.claudeSession;
  assert.notEqual(fresh, first);
  assert.equal(argAfter(lastRun().argv, '--session-id'), fresh);
  assert.equal(store.contraptionSession(mandate.id, cara.id, 'resume-me')!.claude_session, fresh);
  const caraMandate = join(claudeDir, 'projects', join(data, 'contraption-scratch', 'mandate', String(cara.id)).replace(/[^a-zA-Z0-9]/g, '-'));
  assert.ok(!existsSync(join(caraMandate, `${first}.jsonl`)), 'the session it left can\'t be resumed again, so its transcript is gone');
  assert.ok(existsSync(join(caraMandate, `${fresh}.jsonl`)));
  // The same name in another contraption, or for another person, is another session in another folder.
  const peeks = (await turn(peek, { session: 'resume-me' }))[0].data.claudeSession;
  assert.ok(lastRun().argv.includes('--session-id'));
  assert.notEqual(peeks, fresh);
  assert.equal(lastRun().cwd, join(data, 'contraption-scratch', 'peek-auras', String(cara.id)));
  assert.ok(!lastRun().argv.includes('--model'), 'no model in the registry or the request: claude\'s default');
  const joshs = (await turn(mandate, { person: josh.id, session: 'resume-me' }))[0].data.claudeSession;
  assert.ok(![first, fresh, peeks].includes(joshs));
  // A transcript that's gone (a relinked Claude) starts afresh under the same name.
  rmSync(join(claudeDir, 'projects'), { recursive: true });
  const lost = (await turn(mandate, { session: 'resume-me' }))[0].data.claudeSession;
  assert.notEqual(lost, fresh);
  assert.ok(lastRun().argv.includes('--session-id'));
});

test('two names run at once, a second turn on a busy name gets busy, and cancel stops a turn', async () => {
  const evs: Ev[] = [];
  const slow = turns.run(mandate, parseTurn({ person: cara.id, session: 'aura-1', prompt: 'slow' }, mandate), (event, data) => evs.push({ event, data }));
  const started = await until('the slow turn', () => evs.find((e) => e.event === 'start'));
  await until('claude to start', () => runs().some((r) => r.prompt === 'slow'));
  assert.equal(errorOf(await turn(mandate, { session: 'aura-1' })), 'busy');
  const other = await turn(mandate, { session: 'aura-2' });
  assert.equal(other.at(-1)!.event, 'end', 'another name runs meanwhile');
  assert.deepEqual(turns.sessions(mandate.id, cara.id).filter((s) => s.name.startsWith('aura-')).map((s) => [s.name, s.busy]).sort(), [['aura-1', true], ['aura-2', false]]);
  assert.equal(turns.deleteSession(mandate, cara.id, 'aura-1'), 'busy');
  assert.equal(turns.cancel(peek.id, started.data.turn), false, 'another contraption can\'t cancel it');
  assert.equal(turns.running(), 1);
  assert.equal(turns.cancel(mandate.id, started.data.turn), true);
  await slow;
  assert.equal(errorOf(evs), 'canceled');
  assert.equal(turns.running(), 0);
  assert.equal(store.getContraptionTurn(started.data.turn)!.outcome, 'canceled');
  assert.equal(turns.sessions(mandate.id, cara.id).find((s) => s.name === 'aura-1')!.busy, false);
});

test('a turn past its timeout is stopped', async () => {
  const evs = await turn(mandate, { session: 'slowpoke', prompt: 'slow', timeoutSec: 1 });
  assert.equal(errorOf(evs), 'timeout');
});

test('the turn_cap and the plan\'s own limit both answer limit; a crash says failed', async () => {
  store.updateContraption('peek-auras', { turn_cap: 2 });
  const capped = store.getContraption('peek-auras')!;
  const used = store.contraptionTurnsSince(capped.id, josh.id, 0);
  for (let i = used; i < 2; i++) assert.equal((await turn(capped, { person: josh.id, session: `cap-${i}` })).at(-1)!.event, 'end');
  assert.equal(errorOf(await turn(capped, { person: josh.id, session: 'cap-3' })), 'limit');
  store.updateContraption('peek-auras', { turn_cap: null });
  assert.equal(errorOf(await turn(mandate, { session: 'limits', prompt: 'plan limit' })), 'limit');
  const crash = await turn(mandate, { session: 'crash', prompt: 'crash' });
  assert.equal(errorOf(crash), 'failed');
  assert.match(crash.at(-1)!.data.message, /exit 3.*boom/);
});

test('a container turn runs in the person\'s own container, on their own sign-in, at its own scratch folder', async () => {
  rmSync(podmanLog, { force: true });
  await turn(mandate, { person: josh.id, session: 'in-container', mcp: [{ name: 'mandate', path: '/mcp' }] });
  const call = JSON.parse(readFileSync(podmanLog, 'utf8').split('\n')[0]);
  assert.deepEqual(call.slice(0, 4), ['exec', '-i', '-w', join(homedir(), '.citadel', 'contraption-scratch', 'mandate')]);
  const envs = call.filter((_: string, i: number) => call[i - 1] === '-e');
  assert.ok(envs.includes(`CLAUDE_CONFIG_DIR=${join(vol, '.claude')}`));
  assert.ok(!envs.some((e: string) => e.startsWith('ANTHROPIC_API_KEY=')), 'never the server\'s login');
  assert.ok(!envs.some((e: string) => e.startsWith('COORDINATOR_')));
  assert.ok(call.includes('citadel-claude-t-2'));
  assert.ok(existsSync(join(vol, '.citadel', 'contraption-scratch', 'mandate')), 'made in the person\'s volume');
  assert.equal(argAfter(lastRun().argv, '--tools'), '');
  // Its private files sit in the person's own volume, never under run/turns (every container mounts that).
  const mcpFile = argAfter(call, '--mcp-config');
  assert.ok(mcpFile.startsWith(join(homedir(), '.citadel', 'contraption-turns') + '/'), mcpFile);
  assert.match(lastRun().mcp, /127\.0\.0\.1:9101\/mcp/);
  assert.ok(lastRun().settings);
  assert.deepEqual(readdirSync(join(vol, '.citadel', 'contraption-turns')), [], 'gone once the turn ends');
  // A refused sign-in: they link again, and no one else's plan steps in.
  assert.equal(errorOf(await turn(mandate, { person: josh.id, session: 'in-container', prompt: 'expired' })), 'no_plan');
  assert.deepEqual(expired, [josh.id]);
});

test('deleting a session forgets the name and deletes its transcript', async () => {
  const id = (await turn(mandate, { session: 'aura-gone' }))[0].data.claudeSession;
  const file = join(claudeDir, 'projects', join(data, 'contraption-scratch', 'mandate', String(cara.id)).replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
  assert.ok(existsSync(file));
  assert.equal(turns.deleteSession(mandate, cara.id, 'aura-gone'), 'deleted');
  assert.ok(!existsSync(file));
  assert.equal(store.contraptionSession(mandate.id, cara.id, 'aura-gone'), undefined);
  assert.equal(turns.deleteSession(mandate, cara.id, 'aura-gone'), 'missing');
});

test('requests are checked before anything runs', () => {
  const bad = (body: object) => assert.throws(() => parseTurn({ person: 1, session: 's', prompt: 'p', ...body }, mandate), (e: any) => e.code === 'bad_request');
  bad({ person: 'one' });
  bad({ session: 'has spaces' });
  bad({ prompt: '' });
  bad({ model: 'haiku; rm -rf /' });
  bad({ mcp: [{ name: 'a b', path: '/mcp' }] });
  bad({ mcp: [{ name: 'a', path: 'http://elsewhere/mcp' }] });
  bad({ mcp: [{ name: 'a', path: '/mcp', headers: { 'X-A': 'one\r\nX-B: two' } }] });
  bad({ mcp: [{ name: 'a', path: '/mcp' }, { name: 'a', path: '/other' }] });
  bad({ agents: { max: 50 } });
  bad({ compactWindow: 5 });
  bad({ timeoutSec: 0 });
  bad({ timeoutSec: 901 }); // a running turn holds back Citadel's restarts
  assert.equal(parseTurn({ person: 1, session: 's', prompt: 'p', agents: false }, mandate).agents, false);
  assert.deepEqual(parseTurn({ person: 1, session: 's', prompt: 'p', agents: { max: 3 } }, mandate).agents, { max: 3, model: null });
});

test('Citadel\'s database holds no turn text afterwards', () => {
  const words = ['dentist', 'Acolyte', 'per-turn-token', 'Moved it', 'Thursday', 'SECRET TOOL OUTPUT'];
  const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
  for (const t of tables) {
    const rows = JSON.stringify(store.db.prepare(`SELECT * FROM "${t}"`).all());
    for (const w of words) assert.ok(!rows.includes(w), `${t} holds "${w}"`);
  }
  // Nor its files on disk, the write-ahead log included.
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  for (const f of readdirSync(data).filter((n) => n.startsWith('coordinator.db'))) {
    const bytes = readFileSync(join(data, f)).toString('latin1');
    for (const w of words) assert.ok(!bytes.includes(w), `${f} holds "${w}"`);
  }
  assert.ok(store.contraptionTurnsSince(mandate.id, cara.id, 0) > 0, 'the meter did record turns');
});

test('the API is only for a contraption\'s own server on this machine, with its key, and streams events', { timeout: 60_000 }, async () => {
  const srv = await bootServer({ env: { CLAUDE_BIN: fake } });
  after(() => srv.stop());
  const made = await srv.call('/api/contraptions', { name: 'mandate', title: 'Mandate', port: 9101, default_model: 'haiku' });
  assert.equal(made.status, 201);
  const key = readFileSync(join(made.data.keys_dir, 'contraption.key'), 'utf8');
  const me = (await srv.call('/api/me')).data;
  const api = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    fetch(srv.base + path, { ...init, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers } });
  const body = JSON.stringify({ person: me.id, session: 'acolyte', prompt: 'hello' });
  assert.equal((await api('/api/contraptions/turns', { method: 'POST', body, headers: { 'X-Forwarded-For': '100.64.0.1' } })).status, 403, 'not through Caddy');
  assert.equal((await api('/api/contraptions/turns', { method: 'POST', body, headers: { Cookie: srv.cookie } })).status, 403, 'not from a browser');
  assert.equal((await api('/api/contraptions/turns', { method: 'POST', body, headers: { Authorization: 'Bearer ck_nope' } })).status, 401);
  // Not enabled yet: an error event.
  let res = await api('/api/contraptions/turns', { method: 'POST', body });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /^text\/event-stream/);
  assert.match(await res.text(), /^event: error\ndata: \{"code":"not_enabled"/);
  assert.equal((await srv.call(`/api/contraptions/mandate/people/${me.id}`, { enabled: true }, 'PUT')).status, 200);
  res = await api('/api/contraptions/turns', { method: 'POST', body });
  const events = (await res.text()).trim().split('\n\n').map((b) => b.split('\n')[0].replace('event: ', ''));
  assert.deepEqual(events.filter((e) => e !== 'text'), ['start', 'tool', 'tool_result', 'compacted', 'end']);
  const sessions = await (await api(`/api/contraptions/sessions?person=${me.id}`)).json();
  assert.deepEqual(sessions.map((s: any) => [s.name, s.busy]), [['acolyte', false]]);
  assert.equal((await api('/api/contraptions/sessions?person=999')).status, 403);
  assert.equal((await api('/api/contraptions/turns/12345/cancel', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await api(`/api/contraptions/sessions/acolyte?person=${me.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await (await api(`/api/contraptions/sessions?person=${me.id}`)).json(), []);
  // Turns run in the server's own process: the health check counts them for a restart to wait on.
  assert.equal((await (await fetch(`${srv.base}/api/health`)).json()).interruptible, 0);
});
