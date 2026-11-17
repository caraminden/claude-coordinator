// The turn API (src/contraption-turns.ts, the brief's section 4): who a turn runs for and on whose
// Claude, what the turn can reach (read off the real claude invocation), sessions, busy, caps, cancel,
// and that Citadel keeps no turn text outside the 14-day audit (#844).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { TurnPlace } from '../src/claude-link.ts';
import { codexSwitchKey } from '../src/codex.ts';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { bootServer, jsonLines, until, stopTurns, testPins } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'contraption-turns-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
const data = join(root, 'data');
process.env.DATA_DIR = data;
testPins(data);
const { ContraptionTurns, parseTurn, TOOL_ERROR_MAX, TurnError } = await import('../src/contraption-turns.ts');

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
// stream-json in, one message a line; with --replay-user-messages each is echoed (with its uuid) as it's taken in.
const out = (o) => console.log(JSON.stringify(o));
const waiting = [];
let wake = null;
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  if (!l.trim()) return;
  waiting.push(JSON.parse(l));
  wake?.();
});
const take = () => new Promise((resolve) => {
  const go = () => {
    wake = null;
    const m = waiting.shift();
    if (argv.includes('--replay-user-messages')) out({ ...m, isReplay: true, parent_tool_use_id: null, uuid: m.uuid ?? 'r' + Math.random() });
    resolve(m);
  };
  waiting.length ? go() : (wake = go);
});
const textOf = (m) => m.message.content.map((b) => b.text).join('');
let prompt = '';
take().then((m) => {
  prompt = textOf(m);
  const session = opt('--resume') ?? opt('--session-id');
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
    argv, cwd: process.cwd(), env: process.env, prompt, pid: process.pid, cwdFiles: fs.readdirSync(process.cwd()),
    settings: read(opt('--settings')), mcp: read(opt('--mcp-config')), system: read(opt('--append-system-prompt-file') ?? opt('--system-prompt-file')),
  }) + '\\n');
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, session + '.jsonl'), JSON.stringify({ prompt }) + '\\n');
  // claude's init names the model it runs in full (#409).
  out({ type: 'system', subtype: 'init', session_id: prompt.includes('odd session id') ? '../../victim' : session, tools: [], model: 'claude-' + (opt('--model') ?? 'default') + '-test' });
  if (prompt.includes('slow')) return setInterval(() => {}, 1000);
  // Ignores SIGTERM, so only the SIGKILL ends it.
  if (prompt.includes('stubborn')) { process.on('SIGTERM', () => {}); return setInterval(() => {}, 1000); }
  // Its reply is out, but it takes a while to exit.
  if (prompt.includes('linger')) {
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', usage: {} });
    out({ type: 'assistant', message: { id: 'm8', content: [{ type: 'text', text: 'Bye.' }] } });
    return setTimeout(() => process.exit(0), 1500);
  }
  // As claude does with a message that arrives mid-reply: finishes the reply, then answers it as a query of its own.
  if (prompt.includes('steer me')) {
    return take().then((m) => {
      out({ type: 'result', subtype: 'success', is_error: false, result: 'First.', usage: { input_tokens: 1, output_tokens: 2 } });
      out({ type: 'assistant', message: { id: 'm9', content: [{ type: 'text', text: 'Heard: ' + textOf(m) }] } });
      out({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'Heard.', usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5 } });
    });
  }
  if (prompt.includes('meter me')) out({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.42, status: 'allowed' } } } });
  // Limited on the first account only (#785): the second one's folder ends in claude2.
  if (prompt.includes('first account limited') && !process.env.CLAUDE_CONFIG_DIR.endsWith('claude2')) { out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your 5-hour limit · resets 3pm" }); process.exit(1); }
  // Text first, then the limit: the app has seen output, so it mustn't be run again on another account (#785).
  if (prompt.includes('limited after text')) { out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'ml' } } }); out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Half' } } }); out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your 5-hour limit · resets 3pm" }); process.exit(1); }
  if (prompt.includes('plan limit')) { out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your 5-hour limit · resets 3pm" }); process.exit(1); }
  if (prompt.includes('expired')) { out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 401 authentication_error OAuth token has expired' }); process.exit(1); }
  if (prompt.includes('crash')) { process.stderr.write('boom\\n'); process.exit(3); }
  if (prompt.includes('refused')) {
    // A call refused before it reached the app (#624): the error the agent saw, as a string or as text blocks.
    out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'r1', name: 'mcp__mandate__list', input: {} }, { type: 'tool_use', id: 'r2', name: 'mcp__mandate__list', input: {} }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', is_error: true, content: 'MCP error -32001: Request timed out' + 'y'.repeat(5000) }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r2', is_error: true, content: [{ type: 'text', text: 'No such tool available: mcp__mandate__list' }] }] } });
    out({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: '', usage: {} });
    return;
  }
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
  if (prompt.includes('draw')) {
    // A media turn (#732): calls Citadel's media server as claude would, with the URL and token it was given.
    const srv = JSON.parse(read(opt('--mcp-config'))).mcpServers.citadel;
    const rpc = (body) => fetch(srv.url, { method: 'POST', headers: { ...srv.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', ...body }) });
    out({ type: 'assistant', message: { id: 'm0', content: [{ type: 'tool_use', id: 'img1', name: 'mcp__citadel__generate_image', input: {} }] } });
    return rpc({ method: 'notifications/initialized' })
      .then((r) => rpc({ id: 1, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 'a frost glow', out: 'frost.png' } } }).then((c) => c.json()).then((c) => [r.status, c]))
      .then(([note, c]) => {
        out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'img1', is_error: c.result.isError, content: c.result.content }] } });
        out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: note + ' ' + c.result.content[0].text }] } });
        out({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: '', usage: {} });
      });
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
const runs = () => jsonLines(log);
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
let i = 1, env = { ...process.env }, cwd;
if (a[i] === '-i') i++;
if (a[i] === '-w') { cwd = a[i + 1]; i += 2; }
while (a[i] === '-e') { const [k, ...v] = a[i + 1].split('='); env[k] = v.join('='); i += 2; }
// Each container's ~/.citadel is in its own volume: Cara's Codex-only one (#341), else Josh's.
const home = ${JSON.stringify(homedir())}, vol = a[i] === 'citadel-claude-t-cara' ? ${JSON.stringify(join(root, 'vol-cara'))} : ${JSON.stringify(join(root, 'vol-josh'))};
const m = (s) => (s.startsWith(home + '/.citadel/') ? vol + s.slice(home.length) : s);
if (cwd) cwd = m(cwd);
env.FAKE_VOL = vol;
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
let caraCodex: TurnPlace | null = null;
// Cara's second Claude account (#785): which one turns run on, and what the link was told about limits.
let caraOn = 1;
let caraLimits: { n: number; until: number }[] = [];
let caraSpare = false;
const places = {
  place(uid: number | null) {
    if (uid === cara.id && caraOn === 2) return { host: true as const, account: 2, configDir: join(root, 'claude2'), env: { CLAUDE_CONFIG_DIR: join(root, 'claude2') } };
    if (uid === cara.id) return { host: true as const };
    if (uid === josh.id) {
      return { host: false as const, container: 'citadel-claude-t-2', configDir: join(vol, '.claude'), home: vol, turnsDir: join(root, 'run', 'turns', 'person-2'), env: { HOME: homedir(), CLAUDE_CONFIG_DIR: join(vol, '.claude'), DISABLE_AUTOUPDATER: '1' }, ensure: async () => {} };
    }
    return null;
  },
  // Cara's Codex-only container (#341), once a test gives her one.
  codexPlace: (uid: number) => (uid === cara.id ? caraCodex : null),
  expire: (uid: number) => expired.push(uid),
  configDirs: (uid: number) => (uid === cara.id ? [claudeDir, join(root, 'claude2')] : []),
  limitedView(_uid: number, n: number, until: number) {
    caraLimits.push({ n, until });
    const next = n === 1 && caraSpare ? { n: 2, label: 'account 2' } : null;
    if (next) caraOn = 2;
    return { next, resetAt: next ? until : until - 3_600_000 };
  },
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
  // The app's own text, then the tools' full names (#763): a bare name, as apps' prompts write them, is no tool.
  assert.equal(run.system, 'You are the Acolyte.\n\nYour tools\' full names are mcp__mandate__<tool>. Where these instructions name a tool without that prefix, such as `x`, call it by its full name (mcp__mandate__x): a bare name fails with "No such tool available".');
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
  assert.equal(start.data.provider, 'claude');
  assert.equal(start.data.model, 'haiku', 'what it runs, as asked: here the registry\'s default');
  assert.equal(evs.filter((e) => e.event === 'text').map((e) => e.data.delta).join(''), 'Moved it to Thursday.');
  // Each piece names its message, streamed or not, so an app can split "Moved it" from " to Thursday.".
  assert.deepEqual(evs.filter((e) => e.event === 'text').map((e) => [e.data.message, e.data.delta]), [['m1', 'Moved '], ['m1', 'it'], ['m2', ' to Thursday.']]);
  assert.deepEqual(evs.filter((e) => e.event !== 'start' && e.event !== 'text'), [
    { event: 'tool', data: { id: 'tu1', name: 'mcp__mandate__move', input: { to: 'Thursday' }, parent: null } },
    { event: 'tool_result', data: { id: 'tu1', ok: true, parent: null } },
    { event: 'compacted', data: {} },
    { event: 'end', data: { stop: 'end_turn', usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 }, provider: 'claude', model: 'claude-haiku-test' } },
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

test('webSearch: true adds WebSearch and WebFetch to the tools and the allow list, alongside Agent if asked (#332)', async () => {
  await turn(mandate, { session: 'search', webSearch: true, mcp: [{ name: 'mandate', path: '/mcp' }] });
  let run = lastRun();
  assert.equal(argAfter(run.argv, '--tools'), 'WebSearch,WebFetch');
  assert.deepEqual(JSON.parse(run.settings).permissions.allow, ['mcp__mandate', 'WebSearch', 'WebFetch']);
  assert.equal(JSON.parse(run.settings).hooks, undefined, 'no Agent cap without agents');
  await turn(mandate, { session: 'search', webSearch: true, agents: { max: 1 }, mcp: [{ name: 'mandate', path: '/mcp' }] });
  run = lastRun();
  assert.equal(argAfter(run.argv, '--tools'), 'Agent,WebSearch,WebFetch');
  assert.deepEqual(JSON.parse(run.settings).permissions.allow, ['mcp__mandate', 'Agent', 'WebSearch', 'WebFetch']);
  await turn(mandate, { session: 'search', webSearch: false });
  assert.equal(argAfter(lastRun().argv, '--tools'), '', 'false is the default: no built-in tools');
});

test('a failed tool call\'s result carries the error the agent saw, cut to TOOL_ERROR_MAX (#624), and goes to the error digest with its tool (#835)', async () => {
  const digest: string[] = [];
  turns.onToolError = (c, tool, error) => digest.push(`${c.name} ${tool} ${error.slice(0, 40)}`);
  const evs = await turn(mandate, { session: 'refused', prompt: 'Get refused.', mcp: [{ name: 'mandate', path: '/mcp' }] });
  turns.onToolError = () => {};
  assert.deepEqual(digest, ['mandate mcp__mandate__list MCP error -32001: Request timed outyyyyy', 'mandate mcp__mandate__list No such tool available: mcp__mandate__li']);
  const results = evs.filter((e) => e.event === 'tool_result').map((e) => e.data);
  assert.equal(results.length, 2);
  assert.deepEqual({ ...results[0], error: undefined }, { id: 'r1', ok: false, parent: null, error: undefined });
  assert.equal(results[0].error.length, TOOL_ERROR_MAX);
  assert.ok(results[0].error.startsWith('MCP error -32001: Request timed out'));
  assert.deepEqual(results[1], { id: 'r2', ok: false, parent: null, error: 'No such tool available: mcp__mandate__list' });
});

test('a Grunt\'s tool calls and results carry its Agent call\'s id, the top level\'s carry null, and its words never stream', async () => {
  const evs = await turn(mandate, { session: 'grunts', prompt: 'Use grunts.', agents: { max: 2 }, mcp: [{ name: 'mandate', path: '/mcp' }] });
  assert.deepEqual(evs.filter((e) => e.event === 'tool' || e.event === 'tool_result' || e.event === 'text'), [
    { event: 'text', data: { delta: 'Asking. ', parent: null, message: 'm1' } },
    { event: 'tool', data: { id: 'ag1', name: 'Agent', input: { prompt: 'look' }, parent: null } },
    { event: 'tool', data: { id: 'gt1', name: 'mcp__mandate__list', input: {}, parent: 'ag1' } },
    { event: 'tool_result', data: { id: 'gt1', ok: false, parent: 'ag1', error: 'x' } },
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

test('a turn whose start can\'t be recorded leaves its name free, not busy until a restart (#468 S04-8)', async () => {
  const start = store.startContraptionTurn;
  store.startContraptionTurn = () => {
    throw new Error('database is locked');
  };
  try {
    await assert.rejects(turn(mandate, { session: 'unrecorded' }), /database is locked/);
  } finally {
    store.startContraptionTurn = start;
  }
  assert.notEqual(errorOf(await turn(mandate, { session: 'unrecorded' })), 'busy');
  assert.ok(!turns.sessions(mandate.id, cara.id).find((s) => s.name === 'unrecorded')?.busy);
});

test('a name resumes its own Claude session; fresh starts another; other contraptions and people never share it', async () => {
  const first = (await turn(mandate, { session: 'resume-me' }))[0].data.claudeSession;
  assert.equal(argAfter(lastRun().argv, '--session-id'), first);
  const again = (await turn(mandate, { session: 'resume-me' }))[0].data.claudeSession;
  assert.equal(again, first);
  assert.equal(argAfter(lastRun().argv, '--resume'), first);
  // Claude Code replays a resumed session's first system prompt unless told not to (#618): this turn's own is sent.
  assert.equal(argAfter(lastRun().argv, '--system-prompt-snapshot'), 'off');
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

test('a turn names its session to the account pick when it resumes one, and says where it ran (#793)', async () => {
  const asked: (string | undefined)[] = [];
  const ran: [number, string, number][] = [];
  const place = places.place;
  places.place = (uid: number | null, warm?: string) => (asked.push(warm), place(uid));
  (places as any).ran = (uid: number, key: string, n: number) => void ran.push([uid, key, n]);
  try {
    await turn(mandate, { session: 'warm-793' });
    await turn(mandate, { session: 'warm-793' });
    await turn(mandate, { session: 'warm-793', fresh: true });
    assert.deepEqual(asked, [undefined, `app:${mandate.id}:warm-793`, undefined], 'a new or fresh session goes where new work goes');
    assert.deepEqual(ran, Array(3).fill([cara.id, `app:${mandate.id}:warm-793`, 1]));
  } finally {
    places.place = place;
    delete (places as any).ran;
  }
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

test('a stopped turn that ignores SIGTERM is killed and frees its session within a few seconds (#319)', async () => {
  const evs: Ev[] = [];
  const stubborn = turns.run(mandate, parseTurn({ person: cara.id, session: 'stub', prompt: 'stubborn' }, mandate), (event, data) => evs.push({ event, data }));
  const started = await until('the stubborn turn', () => evs.find((e) => e.event === 'start'));
  await until('claude to start', () => runs().some((r) => r.prompt === 'stubborn'));
  const t0 = Date.now();
  turns.cancel(mandate.id, started.data.turn);
  await stubborn;
  assert.ok(Date.now() - t0 < 3500, `freed after ${Date.now() - t0} ms`);
  assert.equal(errorOf(evs), 'canceled');
  assert.equal(turns.sessions(mandate.id, cara.id).find((s) => s.name === 'stub')!.busy, false);
});

test('a drain waits for the contraption\'s running turns, holds its new ones until released, and leaves others alone (#319)', async () => {
  const lingering: Ev[] = [];
  const first = turns.run(mandate, parseTurn({ person: cara.id, session: 'drain-1', prompt: 'linger' }, mandate), (event, data) => lingering.push({ event, data }));
  await until('the lingering turn', () => lingering.find((e) => e.event === 'start'));
  const drained = turns.drain(mandate.id, 10_000);
  const held: Ev[] = [];
  const second = turns.run(mandate, parseTurn({ person: cara.id, session: 'drain-2', prompt: 'Move my dentist to Thursday.' }, mandate), (event, data) => held.push({ event, data }));
  assert.equal((await turn(peek, { session: 'drain-3' })).at(-1)!.event, 'end', 'another contraption\'s turns run meanwhile');
  const { said, release } = await drained;
  await first;
  assert.match(said!, /^Waited \d+ s for 1 running turn to end\.$/);
  assert.equal(lingering.at(-1)!.event, 'end', 'the running turn finished, not cut');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(held, [], 'the new turn waits for the restart');
  assert.equal(turns.running(), 0);
  release();
  await second;
  assert.equal(held[0].event, 'start');
  assert.equal(held.at(-1)!.event, 'end', 'and runs once released');
});

test('a drain stops waiting at its cap and names the turns it will cut; with none running it doesn\'t wait (#319)', async () => {
  const t0 = Date.now();
  const idle = await turns.drain(mandate.id, 10_000);
  assert.equal(idle.said, null);
  assert.ok(Date.now() - t0 < 100, 'no wait with nothing running');
  idle.release();
  const evs: Ev[] = [];
  const slow = turns.run(mandate, parseTurn({ person: cara.id, session: 'cap-1', prompt: 'slow' }, mandate), (event, data) => evs.push({ event, data }));
  const started = await until('the slow turn', () => evs.find((e) => e.event === 'start'));
  const capped = await turns.drain(mandate.id, 300);
  assert.match(capped.said!, new RegExp(`^Waited \\d+ s for 1 running turn: restarting anyway, which cuts off turn ${started.data.turn} \\(person ${cara.id}, session cap-1\\)\\.$`));
  // A turn asked for meanwhile whose app hangs up (the restart takes the app down) never starts.
  const gone = new AbortController();
  const dropped: Ev[] = [];
  const asked = turns.run(mandate, parseTurn({ person: cara.id, session: 'cap-2', prompt: 'hi' }, mandate), (event, data) => dropped.push({ event, data }), gone.signal);
  gone.abort();
  turns.cancel(mandate.id, started.data.turn);
  await slow;
  capped.release();
  await asked;
  assert.deepEqual(dropped.map((e) => [e.event, e.data.code]), [['error', 'canceled']]);
  assert.ok(!runs().some((r) => r.prompt === 'hi'), 'its claude never ran');
});

test('a running turn takes a message from its own person, says when claude took it in, and counts what it cost', async () => {
  const evs: Ev[] = [];
  const running = turns.run(mandate, parseTurn({ person: cara.id, session: 'steered', prompt: 'steer me' }, mandate), (event, data) => evs.push({ event, data }));
  const id = (await until('the turn to start', () => evs.find((e) => e.event === 'start'))).data.turn;
  assert.equal(turns.steer(peek.id, id, cara.id, 'Hi.'), null, 'another contraption has no such turn');
  assert.equal(turns.steer(mandate.id, id, josh.id, 'Hi.'), 'other_person');
  const out = turns.steer(mandate.id, id, cara.id, 'Make it Friday.');
  assert.ok(out && typeof out === 'object' && out.steered);
  await running;
  const taken = evs.findIndex((e) => e.event === 'taken');
  assert.deepEqual(evs[taken].data, { id: out.id }, 'one taken event, for the message');
  assert.equal(evs.filter((e) => e.event === 'taken').length, 1, 'not for the prompt');
  assert.ok(evs.findIndex((e) => e.event === 'text' && e.data.delta === 'Heard: Make it Friday.') > taken, 'claude read it after taking it in');
  assert.deepEqual(evs.at(-1), { event: 'end', data: { stop: 'end_turn', usage: { input: 4, output: 6, cacheRead: 5, cacheWrite: 0 }, provider: 'claude', model: 'claude-haiku-test' } }, 'both replies\' usage');
  assert.deepEqual(turns.steer(mandate.id, id, cara.id, 'Too late.'), { steered: false, reason: 'ended' });
  assert.equal(turns.steer(mandate.id, id, josh.id, 'Too late.'), 'other_person');
  assert.equal(turns.steer(mandate.id, 99_999, cara.id, 'Hi.'), null);
});

test('every turn leaves an audit row (#844): the system text and prompt as claude got them, steers, the reply, model and blind; no tool calls', async () => {
  const evs = await turn(mandate, { session: 'audited', system: 'You are the Acolyte.', mcp: [{ name: 'mandate', path: '/mcp' }] });
  const id = evs[0].data.turn;
  const row = store.turnAudit(id)!;
  assert.equal(row.system, lastRun().system, 'the whole system text Citadel sent, its tool-names line included');
  assert.match(row.system, /^You are the Acolyte\.\n\n.*mcp__mandate__/s);
  assert.equal(row.prompt, 'Move my dentist to Thursday.');
  assert.equal(row.output, 'Moved it to Thursday.', 'top-level text only, each message once');
  assert.equal(row.model, 'claude-haiku-test'); // the model that ran, from claude's init, not the alias asked for
  assert.equal(row.blind, 0);
  assert.equal(row.verdict, null);
  assert.ok(!JSON.stringify(row).includes('SECRET TOOL OUTPUT'));
  // A steer is part of what the model got.
  const steered: Ev[] = [];
  const running = turns.run(mandate, parseTurn({ person: cara.id, session: 'steered-audit', prompt: 'steer me' }, mandate), (event, data) => steered.push({ event, data }));
  const sid = (await until('the turn to start', () => steered.find((e) => e.event === 'start'))).data.turn;
  turns.steer(mandate.id, sid, cara.id, 'Make it Friday.');
  await running;
  assert.match(store.turnAudit(sid)!.prompt, /^steer me\n\n.*Make it Friday\.$/s);
  assert.match(store.turnAudit(sid)!.output, /Heard: Make it Friday\./);
  // A blind turn says so.
  const blind = await turn(mandate, { session: 'audit-blind', blind: true, system: 'Neutral.' });
  assert.deepEqual([store.turnAudit(blind[0].data.turn)!.blind, store.turnAudit(blind[0].data.turn)!.system], [1, 'Neutral.']);
});

test('an audit row goes with its session, and every row goes once its days are up (#844)', async () => {
  const id = (await turn(mandate, { session: 'audit-gone' }))[0].data.turn;
  const keep = (await turn(mandate, { session: 'audit-stays' }))[0].data.turn;
  assert.ok(store.turnAudit(id));
  assert.equal(turns.deleteSession(mandate, cara.id, 'audit-gone'), 'deleted');
  assert.equal(store.turnAudit(id), undefined);
  assert.ok(store.turnAudit(keep), "another session's stays");
  store.sweepTurnAudit(Date.now() - 60_000);
  assert.ok(store.turnAudit(keep), 'a minute old is inside its days');
  assert.ok(store.getContraptionTurn(keep), 'and the meter row is never touched');
});

test('a turn whose reply is out takes no message', async () => {
  const evs: Ev[] = [];
  const running = turns.run(mandate, parseTurn({ person: cara.id, session: 'lingering', prompt: 'linger' }, mandate), (event, data) => evs.push({ event, data }));
  const id = (await until('the turn to start', () => evs.find((e) => e.event === 'start'))).data.turn;
  await until('its reply', () => evs.some((e) => e.event === 'text'));
  assert.equal(turns.running(), 1, 'claude is still running');
  assert.deepEqual(turns.steer(mandate.id, id, cara.id, 'One more thing.'), { steered: false, reason: 'replied' });
  await running;
  assert.equal(evs.at(-1)!.event, 'end');
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
  const lim = await turn(mandate, { session: 'limits', prompt: 'plan limit' }); assert.equal(errorOf(lim), 'limit', JSON.stringify(lim.at(-1)));
  const crash = await turn(mandate, { session: 'crash', prompt: 'crash' });
  assert.equal(errorOf(crash), 'failed');
  assert.match(crash.at(-1)!.data.message, /exit 3.*boom/);
});

test('a container turn runs in the person\'s own container, on their own sign-in, at its own scratch folder', async () => {
  rmSync(podmanLog, { force: true });
  await turn(mandate, { person: josh.id, session: 'in-container', mcp: [{ name: 'mandate', path: '/mcp' }] });
  const call = jsonLines(podmanLog)[0];
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

// A blind turn (VoiceAnalyzer #26): nothing in what the model is started with names the person, the login, the home or the app.
// The test's own temp folder (root) may sit under any home, so it's masked: the server's real config dir is the one thing a blind turn keeps, for its sign-in.
const leaks = (what: object, names: string[]) => names.filter((n) => JSON.stringify(what).replaceAll(root, '<root>').includes(n));
test('a blind turn runs in a neutral folder with the app\'s text as the whole system prompt, and nothing names who or which app', async () => {
  store.setSetting(codexSwitchKey(cara.id), true); // the Codex override doesn't move a blind turn
  const evs = await turn(mandate, { blind: true, session: 'blind-h', system: 'Word feedback neutrally.', mcp: [{ name: 'tools', path: '/mcp' }] });
  store.deleteSetting(codexSwitchKey(cara.id));
  assert.equal(evs.at(-1)!.event, 'end');
  assert.equal(evs[0].data.provider, 'claude');
  const run = lastRun();
  const { PATH: _path, ...env } = run.env; // PATH is the server's; the model sees no environment without a shell
  const named = ['cara', 'Cara', 'Mandate', 'mandate', homedir(), data];
  assert.deepEqual(leaks({ argv: run.argv, cwd: run.cwd, env, system: run.system, settings: run.settings, mcp: run.mcp, prompt: run.prompt }, named), []);
  assert.match(run.cwd, /^\/tmp\/t-[A-Za-z0-9]{6}\/w$/);
  assert.deepEqual(run.cwdFiles, []);
  assert.equal(argAfter(run.argv, '--system-prompt-file') && !run.argv.includes('--append-system-prompt-file'), true, 'the whole prompt, not an addition');
  assert.match(run.system, /^Word feedback neutrally\./);
  assert.equal(argAfter(run.argv, '--tools'), '');
  assert.equal(env.HOME, join(run.cwd, '..'));
  for (const k of ['USER', 'LOGNAME', 'SHELL']) assert.equal(env[k], undefined, k);
  assert.ok(!existsSync(join(run.cwd, '..')), 'its folder is gone once the turn ends');
  assert.deepEqual(existsSync(join(claudeDir, 'projects', run.cwd.replace(/[^a-zA-Z0-9]/g, '-'))), false, 'and its transcript');
  assert.equal(store.contraptionSession(mandate.id, cara.id, 'blind-h'), undefined, 'no session kept');
});

test('a blind turn is always fresh, never carries the person\'s machines, and refuses a Codex model', async () => {
  assert.throws(() => parseTurn({ person: 1, session: 's', prompt: 'x', blind: true, model: 'gpt-6-astra' }, mandate), /Claude only/);
  assert.throws(() => parseTurn({ person: 1, session: 's', prompt: 'x', blind: 'yes' }, mandate), /blind must be true or false/);
  const r = parseTurn({ person: 1, session: 's', prompt: 'x', blind: true, machines: true, fresh: false }, mandate);
  assert.deepEqual([r.fresh, r.machines, r.blind], [true, false, true]);
  assert.equal(parseTurn({ person: 1, session: 's', prompt: 'x' }, mandate).blind, false);
});

test('a blind turn in a container makes its random folder inside it', async () => {
  rmSync(podmanLog, { force: true });
  await turn(mandate, { person: josh.id, session: 'blind-c', blind: true, system: 'Neutral.' });
  const call = jsonLines(podmanLog)[0];
  assert.deepEqual(call.slice(0, 4), ['exec', '-i', '-w', '/tmp']);
  const folder = call.find((a: string) => /^\/tmp\/t-[0-9a-f]{12}$/.test(a));
  assert.ok(folder, 'the folder it makes and runs in');
  rmSync(folder, { recursive: true, force: true }); // the fake podman ran the wrapper for real
  assert.ok(call.some((a: string) => a.includes('mkdir -p')));
  assert.ok(!call.includes(join(homedir(), '.citadel', 'contraption-scratch', 'mandate')));
  assert.ok(argAfter(call, '--system-prompt-file'));
});

test("a stream's session id that isn't one is never stored, and one stored before never reaches a path (C1)", async () => {
  const mine = (await turn(mandate, { session: 'odd', prompt: 'odd session id' }))[0].data.claudeSession;
  assert.equal(store.contraptionSession(mandate.id, cara.id, 'odd')!.claude_session, mine, "the stream's ../ id was not taken");
  // A row from before the check: dropping "its transcript" would delete a folder two levels up.
  const victim = join(claudeDir, 'victim');
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, 'keep'), 'x');
  store.putContraptionSession(mandate.id, cara.id, 'odd', '../../victim');
  const next = (await turn(mandate, { session: 'odd' }))[0].data.claudeSession;
  assert.match(next, /^[0-9a-f-]{36}$/, 'the name starts a new session');
  assert.ok(existsSync(join(victim, 'keep')));
  assert.equal(turns.deleteSession(mandate, cara.id, 'odd'), 'deleted');
});

// Kept chats (#836): an app's `keep: true` turns, the session's first KEEP_TURNS, in its home scheme's shared folder.
test('a kept turn writes the prompt, tool calls and reply to the home scheme\'s .replay folder, first five turns only', async () => {
  const home = store.createProject('Peek', null);
  const app = contraptions.register({ name: 'kept-app', ...fields, home_scheme: home.id });
  store.setContraptionUser(app.id, cara.id, true, cara.id);
  const dir = join(data, 'projects', String(home.id), 'shared', 'project', '.replay', 'kept-app');
  await turn(app, { session: 'k1', system: 'Be an aura.', keep: true });
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{12}-k1-[0-9a-f]{8}\.jsonl$/, 'named by a hashed person, the session and its Claude session');
  const [t] = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(t.n, 1);
  assert.equal(typeof t.turn, 'number', 'the turn id, the key #844\'s audit rows share');
  assert.equal(t.prompt, 'Move my dentist to Thursday.');
  assert.deepEqual(t.calls, [{ name: 'mcp__mandate__move', input: { to: 'Thursday' }, ok: true, result: 'SECRET TOOL OUTPUT' }]);
  assert.match(t.text, /Moved it[\s\S]*to Thursday\./);
  assert.equal(t.system.length, 64, 'a hash of the system text, not the text');
  for (let i = 0; i < 6; i++) await turn(app, { session: 'k1', system: 'Be an aura.', keep: true });
  assert.equal(readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').length, 5, 'only the first five');
  // Without keep, on an app with no home scheme, or for a person who opted out: nothing.
  await turn(app, { session: 'k2' });
  await turn(mandate, { session: 'k3', keep: true });
  store.setSetting(`replay_optout:${cara.id}`, true);
  await turn(app, { session: 'k4', keep: true });
  store.setSetting(`replay_optout:${cara.id}`, false);
  assert.deepEqual(readdirSync(dir), files);
  assert.ok(!existsSync(join(data, 'projects', 'null')));
  // Deleting the session deletes what was kept of it.
  assert.equal(turns.deleteSession(app, cara.id, 'k1'), 'deleted');
  assert.deepEqual(readdirSync(dir), []);
  assert.throws(() => parseTurn({ person: 1, session: 's', prompt: 'x', keep: true, blind: true }, mandate), /not both/);
  assert.throws(() => parseTurn({ person: 1, session: 's', prompt: 'x', keep: 'yes' }, mandate), /keep must be true or false/);
});

test('a person who opts out while a kept turn runs has nothing of it kept', async () => {
  const home = store.createProject('Peek race', null);
  const app = contraptions.register({ name: 'kept-race', ...fields, home_scheme: home.id });
  store.setContraptionUser(app.id, cara.id, true, cara.id);
  const dir = join(data, 'projects', String(home.id), 'shared', 'project', '.replay', 'kept-race');
  const seen = () => readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('linger then opt out')).length;
  const before = seen();
  const running = turn(app, { session: 'r1', keep: true, prompt: 'linger then opt out' });
  while (seen() === before) await new Promise((r) => setTimeout(r, 20));
  store.setSetting(`replay_optout:${cara.id}`, true); // its reply is out; claude is still exiting
  await running;
  store.setSetting(`replay_optout:${cara.id}`, false);
  assert.ok(!existsSync(dir) || readdirSync(dir).length === 0, 'nothing kept after the opt-out');
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

test("a Codex pick the person can't run falls back to the app's default, or Claude's own, and start says so (#409)", async () => {
  // codexWhy says Codex isn't set up, as it does by default here.
  const start = (evs: Ev[]) => [evs[0].data.provider, evs[0].data.model];
  assert.deepEqual(start(await turn(mandate, { person: josh.id, session: 'no-codex', model: 'gpt-6-luna' })), ['claude', 'haiku']);
  const own = await turn(peek, { person: josh.id, session: 'no-codex', model: 'gpt-6-luna' });
  assert.deepEqual(start(own), ['claude', null], "no model: the account's default");
  assert.equal(own.at(-1)!.data.model, 'claude-default-test', 'end names it in full, from claude');
});

test('a turn gets the person\'s online machines and a note on them, unless it asks for machines: false (#306, #409)', async () => {
  turns.machines = () => [{ id: 7, name: 'perigee-godot', token_hash: '', created_by: 'Cara', created_at: 0, last_seen_at: 0, notes: 'Never restart it.', workspace_tools: 0, scoped: 0 }];
  try {
    await turn(mandate, { session: 'with-machines', system: 'You grade.', mcp: [{ name: 'mandate', path: '/mcp' }] });
    let run = lastRun();
    assert.deepEqual(Object.keys(JSON.parse(run.mcp).mcpServers), ['mandate', 'perigee-godot']);
    assert.deepEqual(JSON.parse(run.settings).permissions.allow, ['mcp__mandate', 'mcp__perigee-godot']);
    assert.match(run.system, /^You grade\.\n\nYour tools' full names are mcp__mandate__<tool>, mcp__perigee-godot__<tool>\. [^\n]*\(mcp__mandate__x\)[^\n]*\n\nConnected machines: perigee-godot[\s\S]*Never restart it\./);

    await turn(mandate, { session: 'blind', system: 'You grade.', mcp: [{ name: 'mandate', path: '/mcp' }], machines: false });
    run = lastRun();
    assert.deepEqual(Object.keys(JSON.parse(run.mcp).mcpServers), ['mandate']);
    assert.deepEqual(JSON.parse(run.settings).permissions.allow, ['mcp__mandate']);
    assert.match(run.system, /^You grade\.\n\nYour tools' full names are mcp__mandate__<tool>\. [^\n]*$/);
  } finally {
    turns.machines = () => [];
  }
});

test('a turn that asks for media (#732) gets Citadel\'s own media server with its turn token; others never see it', async () => {
  turns.apiUrl = () => 'http://127.0.0.1:4321'; // server.ts sets Citadel's own address
  await turn(mandate, { session: 'media', mcp: [{ name: 'mandate', path: '/mcp' }], media: true, machines: false });
  turns.apiUrl = () => '';
  let run = lastRun();
  const servers = JSON.parse(run.mcp).mcpServers;
  assert.deepEqual(Object.keys(servers), ['mandate', 'citadel']);
  assert.equal(servers.citadel.url, 'http://127.0.0.1:4321/api/contraption-media/mcp');
  assert.match(servers.citadel.headers.Authorization, /^Bearer cmt_/);
  assert.deepEqual(JSON.parse(run.settings).permissions.allow, ['mcp__mandate', 'mcp__citadel']);
  // The token only works while its turn runs.
  assert.equal(turns.mediaTurn(servers.citadel.headers.Authorization.slice(7)), null);

  await turn(mandate, { session: 'media', mcp: [{ name: 'mandate', path: '/mcp' }], machines: false });
  run = lastRun();
  assert.deepEqual(Object.keys(JSON.parse(run.mcp).mcpServers), ['mandate']);
  assert.deepEqual(JSON.parse(run.settings).permissions.allow, ['mcp__mandate']);
});

test('a media turn offers Codex images only where the person\'s Codex can run: their container, or the server login\'s Codex container', () => {
  const at = (uid: number) => (turns as any).codexAt(uid, places.place(uid));
  assert.equal(at(josh.id), null, "codexWhy says Codex isn't set up");
  turns.codexWhy = () => null;
  try {
    const j = at(josh.id);
    assert.deepEqual({ ...j, ensure: typeof j.ensure, tripwire: j.tripwire.project }, { container: 'citadel-claude-t-2', turnsDir: join(root, 'run', 'turns', 'person-2'), env: places.place(josh.id)!.env, tripwire: 0, ensure: 'function', podman });
    assert.equal(j.tripwire.claudeConfig, join(vol, '.claude'));
    assert.equal(at(cara.id), null, 'a host person with no Codex container');
    caraCodex = { host: false, container: 'citadel-claude-codex-1', configDir: join(root, 'cc'), home: join(root, 'ch'), turnsDir: join(root, 'run', 'turns', 'person-1'), env: {}, ensure: async () => {} };
    assert.equal(at(cara.id).container, 'citadel-claude-codex-1');
  } finally {
    turns.codexWhy = () => "Codex isn't set up on this server";
    caraCodex = null;
  }
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
  bad({ webSearch: 'yes' });
  bad({ machines: 'no' });
  bad({ media: 'yes' });
  bad({ media: true, mcp: [{ name: 'citadel', path: '/mcp' }] }); // the name media takes
  bad({ compactWindow: 5 });
  bad({ timeoutSec: 0 });
  bad({ timeoutSec: 901 }); // a running turn holds back Citadel's restarts
  assert.equal(parseTurn({ person: 1, session: 's', prompt: 'p', agents: false }, mandate).agents, false);
  assert.equal(parseTurn({ person: 1, session: 's', prompt: 'p' }, mandate).webSearch, false, 'off unless asked');
  assert.equal(parseTurn({ person: 1, session: 's', prompt: 'p' }, mandate).machines, true, 'on unless turned off');
  assert.equal(parseTurn({ person: 1, session: 's', prompt: 'p' }, mandate).media, false, 'off unless asked');
  assert.equal(parseTurn({ person: 1, session: 's', prompt: 'p', mcp: [{ name: 'citadel', path: '/mcp' }] }, mandate).mcp.length, 1, 'an app server may be called citadel without media');
  assert.deepEqual(parseTurn({ person: 1, session: 's', prompt: 'p', agents: { max: 3 } }, mandate).agents, { max: 3, model: null });
});

// #844 reverses the old rule (Cara, 2026-11-16, VoiceAnalyzer #41's "Build (C4)"): turn text is kept, in the audit
// table only, for AUDIT_DAYS. Outside it there is none, and once the audit is swept there is none anywhere, files included.
test('Citadel\'s database holds no turn text outside the audit, and none at all once the audit is swept', () => {
  const audit = JSON.stringify(store.db.prepare('SELECT * FROM contraption_turn_audit').all());
  assert.ok(audit.includes('dentist') && !audit.includes('SECRET TOOL OUTPUT'), 'the audit holds prompts, never tool output');
  for (const t of ['contraption_turns', 'contraption_sessions']) assert.ok(!JSON.stringify(store.db.prepare(`SELECT * FROM ${t}`).all()).includes('dentist'), t);
  store.sweepTurnAudit(Date.now() + 1);
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
  const steer = (body: object) => api('/api/contraptions/turns/12345/messages', { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await steer({ person: me.id, text: 'Hi.' })).status, 404);
  assert.equal((await steer({ person: me.id, text: ' ' })).status, 400);
  assert.equal((await steer({ text: 'Hi.' })).status, 400);
  assert.equal((await api(`/api/contraptions/sessions/acolyte?person=${me.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await (await api(`/api/contraptions/sessions?person=${me.id}`)).json(), []);
  // Media (#732): a person with no OpenRouter gets the coded refusal in the stream and the agent's text; nothing is written.
  res = await api('/api/contraptions/turns', { method: 'POST', body: JSON.stringify({ person: me.id, session: 'artist', prompt: 'draw', media: true }) });
  const blocks = (await res.text()).trim().split('\n\n').map((b) => ({ event: b.split('\n')[0].replace('event: ', ''), data: JSON.parse(b.split('\n')[1].replace('data: ', '')) }));
  const media = blocks.filter((b) => b.event === 'media');
  assert.equal(media.length, 1);
  assert.deepEqual(blocks.map((b) => b.event).filter((e) => e === 'media' || e === 'tool_result'), ['media', 'tool_result'], 'the app hears of the call before its result');
  assert.equal(media[0].data.ok, false);
  assert.equal(media[0].data.code, 'openrouter_not_connected');
  assert.match(blocks.filter((b) => b.event === 'text').map((b) => b.data.delta).join(''), /^202 openrouter_not_connected: /);
  assert.deepEqual(await (await api(`/api/contraptions/media?person=${me.id}`)).json(), { files: [] });
  assert.equal((await api(`/api/contraptions/media/frost.png?person=${me.id}`)).status, 404);
  const folder = join(srv.data, 'contraption-media', 'mandate', String(me.id), 'auras');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'glow.png'), 'GLOW');
  writeFileSync(join(folder, 'glow.png.json'), '{"model":"m"}');
  assert.deepEqual((await (await api(`/api/contraptions/media?person=${me.id}`)).json()).files.map((f: any) => f.path), ['auras/glow.png']);
  const got = await api(`/api/contraptions/media/auras/glow.png?person=${me.id}`);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(await got.text(), 'GLOW');
  assert.deepEqual(await (await api(`/api/contraptions/media/auras/glow.png.json?person=${me.id}`)).json(), { model: 'm' });
  assert.equal((await api(`/api/contraptions/media/auras/glow.png?person=${me.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(readdirSync(folder), [], 'the file and its note');
  assert.equal((await api(`/api/contraptions/media/..%2F..%2Fcoordinator.db?person=${me.id}`)).status, 400);
  assert.equal((await api('/api/contraptions/media?person=999')).status, 403);
  const standing = () => api(`/api/contraptions/openrouter?person=${me.id}`).then((r) => r.json());
  assert.deepEqual(await standing(), { connected: false, account_url: null }, 'no scheme yet to hold an account page');
  const scheme = (await srv.call('/api/projects', { name: 'Peek', source: 'none' })).data;
  assert.deepEqual(await standing(), { connected: false, account_url: `/c/#/p/${scheme.id}/account` });
  // The media server takes only a running media turn's token.
  const mcp = (headers: Record<string, string>) => fetch(srv.base + '/api/contraption-media/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal((await mcp({})).status, 401);
  assert.equal((await mcp({ Authorization: 'Bearer cmt_nope' })).status, 401);
  assert.equal((await mcp({ Authorization: `Bearer ${key}` })).status, 401, 'nor the contraption key');
  // Turns run in the server's own process: the health check counts them for a restart to wait on.
  assert.equal((await (await fetch(`${srv.base}/api/health`)).json()).interruptible, 0);
});

// A fake codex app-server, for Codex turns (#337): it logs the hook config it got and its requests.
const codexLog = join(root, 'codex.jsonl');
const codexBin = join(root, 'codex-fake');
writeFileSync(codexBin, `#!${process.execPath}
const fs = require('node:fs');
const record = (m) => fs.appendFileSync(${JSON.stringify(codexLog)}, JSON.stringify(m) + '\\n');
// The fake podman maps the container's ~/.citadel in argv only.
const inVol = (f) => f.replace(${JSON.stringify(homedir() + '/.citadel/')}, process.env.FAKE_VOL + '/.citadel/');
record({ tripwire: JSON.parse(fs.readFileSync(inVol(process.env.CITADEL_CODEX_TRIPWIRE), 'utf8')), argv: process.argv.slice(2) });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const note = (method, params) => send({ method, params: { threadId: 'cth', turnId: 'tu1', ...params } });
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'thread/start' || m.method === 'thread/resume') { record({ method: m.method, params: m.params }); return send({ id: m.id, result: { thread: { id: 'cth' } } }); }
  if (m.method !== 'turn/start') return send({ id: m.id, result: {} });
  record({ method: m.method, params: m.params });
  send({ id: m.id, result: { turn: { id: 'tu1' } } });
  note('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'CODEX MOVED IT' } });
  note('turn/completed', { turn: { id: 'tu1', status: 'completed' } });
});
`);
chmodSync(codexBin, 0o755);

test("on Codex (#337) a contraption turn runs the shim in its own mode with only the app's tools, and its Codex turns go back to Claude, never through Citadel's database", async () => {
  rmSync(codexLog, { force: true });
  // Into the container's environment as the person's own (a turn's env never takes the server's CITADEL_*).
  const place = places.place;
  places.place = (uid) => {
    const p = place(uid);
    return p && !p.host ? { ...p, env: { ...p.env, CITADEL_CODEX_BIN: codexBin, CODEX_HOME: join(root, 'codex-home') } } : p;
  };
  turns.codexWhy = () => null;
  store.setSetting(codexSwitchKey(josh.id), true);
  try {
    const evs = await turn(mandate, { person: josh.id, session: 'on-codex', prompt: 'CODEX ASK one', mcp: [{ name: 'mandate', path: '/mcp' }] });
    assert.equal(evs.at(-1)!.event, 'end', JSON.stringify(evs));
    // The override turned the app's haiku into Codex, and start and end say so (#409).
    assert.deepEqual([evs[0].data.provider, evs[0].data.model], ['codex', 'gpt-6-luna']);
    assert.deepEqual([evs.at(-1)!.data.provider, evs.at(-1)!.data.model], ['codex', 'gpt-6-luna']);
    assert.ok(evs.some((e) => e.event === 'text' && e.data.delta.includes('CODEX MOVED IT')));
    const calls = jsonLines(codexLog);
    assert.equal(calls[0].tripwire.mode, 'contraption');
    assert.deepEqual(calls[0].tripwire.mcp, ['mandate']);
    assert.ok(calls[0].argv.includes('features.shell_tool=false'), 'no shell for an app turn');
    assert.equal(calls.find((c) => c.method === 'thread/start').params.model, 'gpt-6-luna', "the app's haiku maps to Codex's fast model");
    // Again on the same name: the thread carries on.
    await turn(mandate, { person: josh.id, session: 'on-codex', prompt: 'CODEX ASK two', mcp: [{ name: 'mandate', path: '/mcp' }] });
    assert.ok(readFileSync(codexLog, 'utf8').includes('"thread/resume"'));

    store.deleteSetting(codexSwitchKey(josh.id));
    await turn(mandate, { person: josh.id, session: 'on-codex', prompt: 'back on claude', mcp: [{ name: 'mandate', path: '/mcp' }] });
    assert.match(lastRun().prompt, /<codex-turns>[\s\S]*CODEX ASK one[\s\S]*CODEX MOVED IT[\s\S]*CODEX ASK two[\s\S]*<\/codex-turns>[\s\S]*back on claude/);
    assert.equal(store.getSetting(`codex:contraption:${mandate.id}:${josh.id}:on-codex`), null, 'Claude has them now');
    // The audit (#844) keeps prompts and replies by design; the handover itself must never pass through the database.
    store.sweepTurnAudit(Date.now() + 1);
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const f of readdirSync(data).filter((n) => n.startsWith('coordinator.db'))) {
      const bytes = readFileSync(join(data, f)).toString('latin1');
      for (const w of ['CODEX ASK', 'CODEX MOVED IT']) assert.ok(!bytes.includes(w), `${f} holds "${w}"`);
    }
  } finally {
    store.deleteSetting(codexSwitchKey(josh.id));
    turns.codexWhy = () => "Codex isn't set up on this server";
    places.place = place;
  }
});

test("the server login's Codex app turns run in its own Codex-only container, handing over with its Claude turns on the host both ways (#341)", async () => {
  rmSync(codexLog, { force: true });
  const volCara = join(root, 'vol-cara');
  caraCodex = {
    host: false, container: 'citadel-claude-t-cara', configDir: claudeDir, home: volCara, turnsDir: join(root, 'run', 'turns', `person-${cara.id}`),
    env: { HOME: homedir(), CLAUDE_CONFIG_DIR: join(volCara, '.claude'), DISABLE_AUTOUPDATER: '1', CITADEL_CODEX_BIN: codexBin, CODEX_HOME: join(root, 'codex-home') }, ensure: async () => {},
  };
  turns.codexWhy = () => null;
  const ask = { person: cara.id, session: 'cara-codex', mcp: [{ name: 'mandate', path: '/mcp' }] };
  try {
    // On Claude first, on the host; its transcript is in the host's Claude folder.
    await turn(mandate, { ...ask, prompt: 'HOST ASK' });
    assert.ok(!readFileSync(podmanLog, 'utf8').includes('citadel-claude-t-cara'));
    const { claude_session } = store.contraptionSession(mandate.id, cara.id, 'cara-codex')!;
    const transcript = join(claudeDir, 'projects', join(data, 'contraption-scratch', 'mandate', String(cara.id)).replace(/[^a-zA-Z0-9]/g, '-'), `${claude_session}.jsonl`);
    appendFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'HOST CLAUDE ASK' } }) + '\n');

    store.setSetting(codexSwitchKey(cara.id), true);
    const evs = await turn(mandate, { ...ask, prompt: 'CODEX ASK cara' });
    assert.equal(evs.at(-1)!.event, 'end', JSON.stringify(evs));
    const exec = jsonLines(podmanLog).at(-1);
    assert.ok(exec.includes('citadel-claude-t-cara'), 'in her own container');
    assert.ok(!exec.some((a: string) => a.startsWith('ANTHROPIC_API_KEY=')), "never the server's Claude key");
    const calls = jsonLines(codexLog);
    assert.equal(calls[0].tripwire.mode, 'contraption');
    const said = calls.find((c) => c.method === 'turn/start').params.input.map((i: any) => i.text).join('\n');
    assert.match(said, /HOST CLAUDE ASK/, 'the hand-over is her Claude conversation on the host');

    store.deleteSetting(codexSwitchKey(cara.id));
    await turn(mandate, { ...ask, prompt: 'back on the host' });
    assert.equal(lastRun().cwd, join(data, 'contraption-scratch', 'mandate', String(cara.id)));
    assert.match(lastRun().prompt, /<codex-turns>[\s\S]*CODEX ASK cara[\s\S]*CODEX MOVED IT[\s\S]*<\/codex-turns>[\s\S]*back on the host/);
  } finally {
    store.deleteSetting(codexSwitchKey(cara.id));
    turns.codexWhy = () => "Codex isn't set up on this server";
    caraCodex = null;
  }
});

test('a session that moved to account 2 and carried on there brings its newer transcript back to account 1 (#793)', async () => {
  const transcriptIn = (dir: string) => {
    const { claude_session } = store.contraptionSession(mandate.id, cara.id, 'there-and-back')!;
    return join(dir, 'projects', join(data, 'contraption-scratch', 'mandate', String(cara.id)).replace(/[^a-zA-Z0-9]/g, '-'), `${claude_session}.jsonl`);
  };
  caraOn = 1;
  await turn(mandate, { session: 'there-and-back', prompt: 'hello from one' });
  caraOn = 2;
  await turn(mandate, { session: 'there-and-back', prompt: 'carried on in two' });
  assert.doesNotMatch(readFileSync(transcriptIn(claudeDir), 'utf8'), /carried on in two/, 'account 1 still holds the old copy');
  caraOn = 1;
  await turn(mandate, { session: 'there-and-back', prompt: 'back on one' });
  const text = readFileSync(transcriptIn(claudeDir), 'utf8');
  assert.match(text, /carried on in two/, 'the move back resumes the conversation as it is now');
  assert.match(text, /back on one/);
  // Account 1's copy is the newest now, so a turn there keeps it as it is.
  await turn(mandate, { session: 'there-and-back', prompt: 'again on one' });
  assert.match(readFileSync(transcriptIn(claudeDir), 'utf8'), /back on one[\s\S]*again on one/);
});

test("an app turn's plan meter goes to the account it ran on (#793)", async () => {
  const got: unknown[][] = [];
  turns.onUsage = (...a) => got.push(a);
  try {
    caraOn = 2;
    await turn(mandate, { session: 'metered', prompt: 'meter me' });
    assert.deepEqual(got, [[{ unifiedWindows: { seven_day: { utilization: 0.42, status: 'allowed' } } }, null, cara.id, 2]], 'a host turn: the server login pays');
  } finally {
    turns.onUsage = () => {};
    caraOn = 1;
  }
});

test('a limit on the first Claude account marks it and the turn finishes on the second, session and all (#785)', async () => {
  caraOn = 1; caraLimits = []; caraSpare = true;
  await turn(mandate, { session: 'move', prompt: 'hello' });
  const evs = await turn(mandate, { session: 'move', prompt: 'first account limited' });
  assert.deepEqual(evs.map((e) => e.event).filter((e) => e === 'start' || e === 'error' || e === 'end'), ['start', 'end'], 'one start, no error');
  assert.deepEqual(caraLimits.map((l) => l.n), [1]);
  // The first turn's transcript came along, so the resumed session on account 2 still has it.
  const dirs = readdirSync(join(root, 'claude2', 'projects'));
  const text = dirs.flatMap((d) => readdirSync(join(root, 'claude2', 'projects', d)).map((f) => readFileSync(join(root, 'claude2', 'projects', d, f), 'utf8'))).join('');
  assert.match(text, /hello/);
  assert.match(text, /first account limited/);
  caraOn = 1; caraSpare = false;
});

test('every Claude account limited: the turn fails with limit and says which resets first (#785)', async () => {
  caraOn = 1; caraLimits = []; caraSpare = false;
  const evs = await turn(mandate, { session: 'all-limited', prompt: 'first account limited' });
  assert.equal(errorOf(evs), 'limit');
  assert.match(evs.at(-1)!.data.message, /Another of this person's Claude accounts resets first/);
  assert.equal(caraLimits.length, 1);
});

test('a limit after output is marked but not retried: the app never sees a reply twice; the next turn resumes on the other account (#785)', async () => {
  caraOn = 1; caraLimits = []; caraSpare = true;
  await turn(mandate, { session: 'half', prompt: 'hello again' });
  const evs = await turn(mandate, { session: 'half', prompt: 'limited after text' });
  assert.equal(errorOf(evs), 'limit');
  assert.equal(evs.filter((e) => e.event === 'start').length, 1);
  assert.equal(evs.filter((e) => e.event === 'text').length, 1);
  assert.equal(caraOn, 2, 'turns moved on');
  const next = await turn(mandate, { session: 'half', prompt: 'carry on' });
  assert.equal(next.at(-1)!.event, 'end');
  const text = readdirSync(join(root, 'claude2', 'projects')).flatMap((d) => readdirSync(join(root, 'claude2', 'projects', d)).map((f) => readFileSync(join(root, 'claude2', 'projects', d, f), 'utf8'))).join('');
  assert.match(text, /hello again/, 'the session came along');
  caraOn = 1; caraSpare = false;
});
