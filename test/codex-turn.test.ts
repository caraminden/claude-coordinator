import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { claudeLog, codexModelFor, fitLog } from '../src/codex.ts';
import { codexInput, installSkills, limitWords, mcpServers, parseArgs } from '../src/codex-turn.ts';
import { jsonLines, tempRoot } from './helpers.ts';

// Codex turns (#337): src/codex-turn.ts drives `codex app-server` and speaks Claude's stream-json both
// ways, so the runner, steering, stop and the UI work unchanged. Here against a stand-in app-server.
const tmp = tempRoot('codex-turn-');
const root = tmp.dir;
after(() => tmp.teardown());
const SHIM = join(import.meta.dirname, '..', 'src', 'codex-turn.ts');

test("a Claude pick maps to the Codex model of the same tier, a Codex pick stays, none is Codex's default", () => {
  assert.equal(codexModelFor(null), 'gpt-6.1-sol');
  assert.equal(codexModelFor('claude-opus-5-5'), 'gpt-6-astra');
  assert.equal(codexModelFor('claude-fable-5-1'), 'gpt-6-astra');
  assert.equal(codexModelFor('opus'), 'gpt-6-astra');
  assert.equal(codexModelFor('claude-sonnet-5-5'), 'gpt-6.1-sol');
  assert.equal(codexModelFor('claude-haiku-5-5'), 'gpt-6-luna');
  assert.equal(codexModelFor('gpt-6-luna'), 'gpt-6-luna');
});

test("Claude's argv reads as flags and their values, -p and all", () => {
  const f = parseArgs(['-p', '--input-format', 'stream-json', '--add-dir', '/a', '/b', '--model', 'x', '--tools', '', '--verbose']);
  assert.deepEqual(f.get('--add-dir'), ['/a', '/b']);
  assert.deepEqual(f.get('--model'), ['x']);
  assert.deepEqual(f.get('--tools'), ['']);
  assert.deepEqual(f.get('--verbose'), []);
});

test('MCP servers go to Codex with their secrets moved into the environment, named, never in its config', () => {
  const m = mcpServers(
    {
      mcpServers: {
        thread: { type: 'stdio', command: 'node', args: ['mcp.ts'], timeout: 86_400_000 },
        box: { type: 'stdio', command: 'node', args: ['m.ts'], env: { COORDINATOR_TOKEN: 'sekrit' } },
        app: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer apptoken' } },
        'bad name!': { command: 'x' },
      },
    },
    { COORDINATOR_TOKEN: 't', COORDINATOR_TICKET: '9', GH_TOKEN: 'gh', PATH: '/bin' },
    600,
  );
  assert.deepEqual(m.names, ['thread', 'box', 'app']);
  assert.deepEqual(m.config['mcp_servers.thread'], { command: 'node', args: ['mcp.ts'], env_vars: ['COORDINATOR_TOKEN', 'COORDINATOR_TICKET'], tool_timeout_sec: 86_400 });
  assert.equal(JSON.stringify(m.config).includes('sekrit') || JSON.stringify(m.config).includes('apptoken'), false, 'no secret in the config');
  assert.equal(m.env.COORDINATOR_TOKEN, 'sekrit');
  const app: any = m.config['mcp_servers.app'];
  assert.equal(m.env[app.env_http_headers.Authorization], 'Bearer apptoken');
  assert.equal(app.tool_timeout_sec, 600);
});

test("a user line's text and images become Codex input", () => {
  assert.deepEqual(codexInput('hi'), [{ type: 'text', text: 'hi', text_elements: [] }]);
  assert.deepEqual(
    codexInput([
      { type: 'text', text: 'a' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QQ==' } },
    ]),
    [
      { type: 'text', text: 'a', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,QQ==' },
    ],
  );
});

test("Codex's usage limit reads as Claude's, with the reset of the window that's full", () => {
  const now = Date.UTC(2026, 10, 5, 12, 0);
  const w = limitWords({ primary: { usedPercent: 100, resetsAt: (now + 90 * 60_000) / 1000 }, secondary: { usedPercent: 40, resetsAt: (now + 5 * 86_400_000) / 1000 } }, now, 'UTC');
  assert.equal(w, "You've hit your Codex usage limit · resets 1:30pm (UTC)");
  assert.match(limitWords({ secondary: { usedPercent: 100, resetsAt: (now + 3 * 86_400_000) / 1000 } }, now, 'UTC'), /resets Nov 8, 12:00pm \(UTC\)/);
  assert.equal(limitWords(null, now), "You've hit your Codex usage limit");
});

test('the hand-over log starts at the last compaction, keeps the summary and every output, and skips thinking and Grunts', () => {
  const l = (o: object) => JSON.stringify(o);
  const jsonl = [
    l({ type: 'user', message: { role: 'user', content: 'before the compaction' } }),
    l({ type: 'system', subtype: 'compact_boundary' }),
    l({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'SUMMARY of earlier' } }),
    l({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '[Josh]: fix it' },
          { type: 'image', source: {} },
        ],
      },
    }),
    l({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    }),
    l({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok 1 pass' }] }] } }),
    l({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'GRUNT inner step' }] } }),
    l({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/x' } }] } }),
    'not json',
  ].join('\n');
  const log = claudeLog(jsonl);
  assert.equal(log, '[Summary of the conversation before this point]\nSUMMARY of earlier\n[Message] [Josh]: fix it\n[Message] [image]\n[Claude] On it.\n[Bash] npm test\nok 1 pass\n[Read] {"file_path":"/x"}');
});

test('a hand-over too big for the guard cuts its biggest outputs first, keeping their head and tail', () => {
  const parts = [{ text: 'said' }, { text: 'a'.repeat(100), output: true }, { text: `${'b'.repeat(500)}END`, output: true }];
  assert.equal(fitLog(parts, 10_000), parts.map((p) => p.text).join('\n'));
  const cut = fitLog(parts, 400);
  assert.ok(cut.length <= 400, `${cut.length}`);
  assert.match(cut, /^said\na{100}\nb+\n\[… \d+ characters cut to fit the hand-over …\]\nb*END$/);
});

// A stand-in for `codex app-server`: logs what it gets, and plays the turn FAKE names.
const fakeLog = join(root, 'fake.jsonl');
const fake = join(root, 'codex');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const log = (m) => appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify(m) + '\\n');
log({ argv: process.argv.slice(2), env: { COORDINATOR_TOKEN: process.env.COORDINATOR_TOKEN ?? null } });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const note = (method, params) => send({ method, params: { threadId: 'th1', turnId: 'tu1', ...params } });
const mode = process.env.FAKE;
let turns = 0;
// An approval request holds the turn until the shim answers, as in Codex: ending first raced its reply
// against the shim's SIGTERM, so a loaded fake could exit before reading the decline.
let onApproval = null;
process.on('SIGTERM', () => { log({ signal: 'SIGTERM' }); process.exit(0); });
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.id === 77 && !m.method && onApproval) return onApproval();
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'account/rateLimits/read') send({ id: m.id, result: { rateLimits: { primary: { usedPercent: 20, resetsAt: 2000000000, windowDurationMins: 300 }, secondary: null } } });
  if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'th1' } } });
  if (m.method === 'thread/resume') send(m.params.threadId === 'gone' ? { id: m.id, error: { message: 'no rollout' } } : { id: m.id, result: { thread: { id: m.params.threadId } } });
  if (m.method === 'turn/steer' && mode === 'late-steer') {
    // The turn ends just before the steer reaches it: Codex refuses a steer for a finished turn.
    note('turn/completed', { turn: { id: 'tu1', status: 'completed' } });
    // Its refusal comes after the shim has printed the result and its input has ended (#564), as turn-wrapper ends it.
    const refuse = () => require('node:fs').existsSync(process.env.HOME + '/input-ended') ? setTimeout(() => send({ id: m.id, error: { message: 'no active turn to steer' } }), 50) : setTimeout(refuse, 10);
    return refuse();
  }
  if (m.method === 'turn/steer') {
    send({ id: m.id, result: { turnId: 'tu1' } });
    note('turn/completed', { turn: { id: 'tu1', status: 'completed' } });
  }
  if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); note('turn/completed', { turn: { id: 'tu1', status: 'interrupted' } }); }
  if (m.method !== 'turn/start') return;
  turns++;
  send({ id: m.id, result: { turn: { id: 'tu' + turns } } });
  if (mode === 'hang' || (mode === 'steer' || mode === 'late-steer') && turns === 1) return;
  if (mode === 'limit') {
    note('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, secondary: null } });
    return note('turn/completed', { turn: { id: 'tu1', status: 'failed', error: { message: 'usage limit', codexErrorInfo: 'usageLimitExceeded' } } });
  }
  if (mode === 'image') {
    const f = process.env.HOME + '/gen.png';
    require('node:fs').writeFileSync(f, 'PNG');
    note('item/started', { item: { type: 'imageGeneration', id: 'g1', status: 'inProgress', revisedPrompt: 'a red dot' } });
    note('item/completed', { item: { type: 'imageGeneration', id: 'g1', status: 'completed', revisedPrompt: 'a red dot', savedPath: f, result: '' } });
    note('item/completed', { item: { type: 'imageGeneration', id: 'g2', status: 'completed', result: Buffer.from('B64').toString('base64') } });
    note('item/completed', { item: { type: 'imageGeneration', id: 'g3', status: 'failed' } });
    return note('turn/completed', { turn: { id: 'tu1', status: 'completed' } });
  }
  note('item/started', { item: { type: 'agentMessage', id: 'm1', text: '' } });
  note('item/agentMessage/delta', { itemId: 'm1', delta: 'Look' });
  note('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Looking.' } });
  note('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'npm test', status: 'inProgress' } });
  note('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'npm test', aggregatedOutput: 'FULL OUTPUT', exitCode: 1, status: 'completed' } });
  note('item/completed', { item: { type: 'fileChange', id: 'f1', changes: [{ path: '/w/a.ts', kind: { type: 'update' }, diff: '-a\\n+b' }], status: 'completed' } });
  note('item/completed', { item: { type: 'mcpToolCall', id: 'p1', server: 'thread', tool: 'set_thread_status', arguments: { note: 'x' }, result: { content: [{ type: 'text', text: 'ok' }] } } });
  note('hook/completed', { run: { status: 'blocked', entries: [{ kind: 'feedback', text: '[tripwire] no' }] } });
  note('turn/plan/updated', { plan: [{ step: 'Fix it', status: 'inProgress' }, { step: 'Test it', status: 'pending' }] });
  note('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 0, outputTokens: 7 } } });
  const n = turns;
  onApproval = () => {
    onApproval = null;
    note('item/completed', { item: { type: 'agentMessage', id: 'm2', text: 'Done ' + n + '.' } });
    note('turn/completed', { turn: { id: 'tu' + n, status: 'completed' } });
  };
  send({ id: 77, method: 'item/commandExecution/requestApproval', params: {} });
});
`,
);
chmodSync(fake, 0o755);

type Run = { code: number | null; events: any[]; calls: any[] };
/** Run the shim with Claude's args; `input` lines go to stdin, the last after the first result unless `keepOpen`. */
function run(args: string[], opts: { cwd?: string; fake?: string; lines?: object[]; steer?: object; sigterm?: boolean; env?: object; lockedMs?: number; lockPid?: string; killAfterMs?: number } = {}): Promise<Run> {
  rmSync(fakeLog, { force: true });
  const home = join(root, `home-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home);
  // Another Codex turn of this person's (this test process) holds the lock until `lockedMs` after the shim
  // says it waits: a timer from here would let go before a shim slow to start had looked (#470). The
  // 30 s is for a shim that never says so: it then runs and the test fails on what it printed.
  const lock = join(home, '.codex', 'citadel-turn.lock');
  const letGo = (ms: number) => setTimeout(() => rmSync(lock, { recursive: true, force: true }), ms);
  let giveUp: NodeJS.Timeout | undefined;
  if (opts.lockedMs) {
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), String(process.pid));
    giveUp = letGo(30_000);
  }
  if (opts.lockPid) {
    // A lock left by a shim that died without its exit handler, its pid file as written.
    const lock = join(home, '.codex', 'citadel-turn.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), opts.lockPid);
  }
  const child = tmp.spawn(process.execPath, [SHIM, ...args], { cwd: opts.cwd ?? root, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'), CITADEL_CODEX_BIN: fake, FAKE: opts.fake ?? '', COORDINATOR_TOKEN: 'tok', ...opts.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const events: any[] = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const ev = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      events.push(ev);
      if (ev.type === 'codex_waiting' && opts.lockedMs) letGo(opts.lockedMs);
      if (ev.type === 'system' && opts.steer) setTimeout(() => child.stdin.write(JSON.stringify(opts.steer) + '\n'), 200);
      if (ev.type === 'system' && opts.sigterm) setTimeout(() => child.kill('SIGTERM'), 200);
      if (ev.type === 'result') child.stdin.end(() => writeFileSync(join(home, 'input-ended'), ''));
    }
  });
  for (const l of opts.lines ?? [{ type: 'user', message: { role: 'user', content: '[Josh]: go' } }]) child.stdin.write(JSON.stringify(l) + '\n');
  if (opts.killAfterMs) setTimeout(() => child.kill('SIGKILL'), opts.killAfterMs).unref();
  // 'close', not 'exit': the shim's last lines can still be in its stdout pipe when it exits.
  return new Promise((resolve) =>
    child.on('close', (code) => {
      clearTimeout(giveUp);
      const calls = jsonLines(fakeLog); // the fake may still be logging its SIGTERM as the shim exits
      resolve({ code, events, calls });
    }),
  );
}

test('a Codex turn reads as a Claude turn: init, words, Bash, patches, MCP, tripwire blocks, a plan and the result', async () => {
  const dir = join(root, 't1');
  mkdirSync(dir);
  writeFileSync(join(dir, 'system.md'), 'CITADEL SYSTEM PROMPT');
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { thread: { type: 'stdio', command: 'node', args: ['mcp.ts'] } } }));
  const logFile = join(dir, 'codex-log.jsonl');
  const r = await run(['-p', '--verbose', '--model', 'claude-opus-5-5', '--effort', 'xhigh', '--append-system-prompt-file', join(dir, 'system.md'), '--mcp-config', join(dir, 'mcp.json'), '--include-partial-messages', '--permission-mode', 'bypassPermissions', '--codex-log', logFile]);
  assert.equal(r.code, 0);
  const init = r.events.find((e) => e.type === 'system');
  assert.deepEqual([init.type, init.subtype, init.model, init.codex_thread, init.session_id], ['system', 'init', 'gpt-6-astra', 'th1', undefined]);
  assert.deepEqual(init.mcp_servers, [{ name: 'thread', status: 'connected' }]);
  // The rate-limit read races the thread's start, so its line can come anywhere.
  const types = r.events.filter((e) => e.type !== 'codex_rate_limits').map((e) => (e.type === 'assistant' ? `a:${e.message.content.map((b: any) => b.name ?? b.type).join()}` : e.type === 'user' ? `u:${e.message.content[0].is_error}` : e.type));
  assert.deepEqual(types, ['system', 'stream_event', 'stream_event', 'a:text', 'a:Bash', 'u:true', 'a:apply_patch', 'u:false', 'a:mcp__thread__set_thread_status', 'u:false', 'a:Tripwire', 'u:true', 'a:TodoWrite', 'a:text', 'result']);
  assert.equal(r.events.filter((e) => e.type === 'codex_rate_limits').length, 1);
  const bash = r.events.find((e) => e.message?.content?.[0]?.name === 'Bash');
  assert.deepEqual(bash.message.content[0].input, { command: 'npm test' });
  const todo = r.events.find((e) => e.message?.content?.[0]?.name === 'TodoWrite').message.content[0].input.todos;
  assert.deepEqual(
    todo.map((t: any) => t.status),
    ['in_progress', 'pending'],
  );
  const result = r.events.at(-1);
  assert.deepEqual([result.is_error, result.result, result.usage.input_tokens, result.usage.cache_read_input_tokens, result.total_cost_usd], [false, 'Done 1.', 40, 60, undefined]);
  // Codex got the system prompt and the Codex note as developer instructions, the servers in config, the token by name only.
  const start = r.calls.find((c) => c.method === 'thread/start').params;
  assert.match(start.developerInstructions, /^CITADEL SYSTEM PROMPT\n\n## Running on Codex/);
  assert.deepEqual(start.config['mcp_servers.thread'].env_vars, ['COORDINATOR_TOKEN']);
  assert.equal([start.approvalPolicy, start.sandbox].join(), 'never,danger-full-access');
  const turn = r.calls.find((c) => c.method === 'turn/start').params;
  assert.deepEqual([turn.model, turn.effort, turn.input[0].text], ['gpt-6-astra', 'xhigh', '[Josh]: go']);
  assert.ok(
    r.calls.some((c) => c.id === 77 && c.result?.decision === 'decline'),
    'an approval request is declined',
  );
  const argv = r.calls[0].argv.join(' ');
  assert.match(argv, /project_doc_fallback_filenames=\["CLAUDE.md"\]/);
  assert.match(argv, /features\.goals=false/);
  // The way back: every part in full, for Claude's next turn.
  const parts = jsonLines(logFile);
  assert.deepEqual(parts.slice(0, 4), [{ text: '[Message] [Josh]: go' }, { text: '[Codex] Looking.' }, { text: '[Bash] npm test' }, { text: 'FULL OUTPUT', output: true }]);
});

test('a message mid-turn steers it, and one replayed comes back marked as taken', async () => {
  const r = await run(['--replay-user-messages'], { fake: 'steer', steer: { type: 'user', uuid: 'u2', message: { role: 'user', content: 'also this' } }, lines: [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } }], sigterm: false });
  const steer = r.calls.find((c) => c.method === 'turn/steer');
  assert.deepEqual([steer.params.threadId, steer.params.expectedTurnId, steer.params.input[0].text], ['th1', 'tu1', 'also this']);
  assert.deepEqual(
    r.events.filter((e) => e.isReplay).map((e) => e.uuid),
    ['u1', 'u2'],
  );
});

test('a steer refused because the turn just ended starts the next turn, rather than waiting out the quiet timer (#468 S04-2)', async () => {
  const r = await run([], { fake: 'late-steer', env: { CITADEL_CODEX_QUIET_MS: '3000' }, steer: { type: 'user', message: { role: 'user', content: 'also this' } } });
  const starts = r.calls.filter((c) => c.method === 'turn/start');
  assert.deepEqual(
    starts.map((c) => c.params.input.at(-1).text),
    ['[Josh]: go', 'also this'],
  );
  assert.equal(r.code, 0);
  const last = r.events.at(-1);
  assert.deepEqual([last.type, last.is_error, last.result], ['result', false, 'Done 2.']);
});

test("stopping a Codex turn interrupts it; Codex's usage limit ends it in Claude's words", async () => {
  const stopped = await run([], { fake: 'hang', sigterm: true });
  assert.ok(stopped.calls.some((c) => c.method === 'turn/interrupt'));
  assert.equal(stopped.code, 143);
  assert.ok(!stopped.events.some((e) => e.type === 'result'));
  const limited = await run([], { fake: 'limit' });
  const result = limited.events.at(-1);
  assert.equal(result.is_error, true);
  assert.match(result.result, /^You've hit your Codex usage limit · resets \d/);
  assert.ok(limited.events.some((e) => e.type === 'codex_rate_limits' && e.rate_limits.primary.usedPercent === 100));
});

test('a Codex turn that goes quiet is stopped with an error', async () => {
  const r = await run([], { fake: 'hang', env: { CITADEL_CODEX_QUIET_MS: '300' } });
  assert.match(r.events.at(-1).result, /Codex sent nothing/);
  assert.equal(r.code, 1);
});

test("a Codex turn that waits a while for the person's Codex lock says so, then runs", async () => {
  const r = await run(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json'], { lockedMs: 1500, env: { CITADEL_CODEX_WAIT_NOTE_MS: '200' } });
  assert.equal(r.events[0].type, 'codex_waiting');
  assert.equal(r.events.filter((e) => e.type === 'codex_waiting').length, 1, 'said once');
  assert.equal(r.events.at(-1).type, 'result');
  assert.equal(r.events.at(-1).is_error, false);
});

test('a lock whose pid now belongs to another process (a reused pid) is stale, and the turn runs (#468 S04-7)', async () => {
  // This test process stands in for the unrelated process that got the dead shim's pid: alive, but started at another time.
  const r = await run([], { lockPid: `${process.pid} 1`, killAfterMs: 8000 });
  assert.equal(r.events.filter((e) => e.type === 'codex_waiting').length, 0, 'not waiting on it');
  assert.equal(r.events.at(-1)?.type, 'result');
  assert.equal(r.code, 0);
});

test('a stored Codex thread resumes without the hand-over; one that is gone starts fresh with it', async () => {
  const handover = join(root, 'handover.md');
  writeFileSync(handover, '[Message] earlier');
  const resumed = await run(['--codex-thread', 'th9', '--codex-handover', handover]);
  assert.equal(resumed.events.find((e) => e.type === 'system').codex_thread, 'th9');
  assert.equal(resumed.calls.find((c) => c.method === 'turn/start').params.input.length, 1);
  const fresh = await run(['--codex-thread', 'gone', '--codex-handover', handover]);
  assert.equal(fresh.events.find((e) => e.type === 'system').codex_resume_failed, 'gone');
  const input = fresh.calls.find((c) => c.method === 'turn/start').params.input;
  assert.match(input[0].text, /taking over this conversation from Claude[\s\S]*<conversation>\n\[Message\] earlier\n<\/conversation>/);
  assert.equal(input[1].text, '[Josh]: go');
});

test("a contraption's Codex turn has no shell, no patches, no kit and no Codex note, and web search only when asked", async () => {
  const r = await run(['--codex-mode', 'contraption', '--tools', '']);
  const argv = r.calls[0].argv.join(' ');
  assert.match(argv, /features\.shell_tool=false/);
  assert.match(argv, /web_search="disabled"/);
  assert.doesNotMatch(r.calls.find((c) => c.method === 'thread/start').params.developerInstructions, /Running on Codex/);
  const web = await run(['--codex-mode', 'contraption', '--tools', 'WebSearch,WebFetch']);
  assert.match(web.calls[0].argv.join(' '), /web_search="live"/);
});

test("the kit's skills install once: a turn starting beside another leaves an installed kit alone, and a new kit replaces it (#636)", () => {
  const kit = join(root, 'kit-skills');
  const home = join(root, 'skills-home');
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(kit, 'skills', name, 'refs'), { recursive: true });
    writeFileSync(join(kit, 'skills', name, 'SKILL.md'), `# ${name}`);
    writeFileSync(join(kit, 'skills', name, 'refs', 'a.md'), 'v1');
  }
  mkdirSync(join(kit, 'skills', 'not-a-skill'), { recursive: true });
  installSkills(kit, home);
  const skills = join(home, 'skills');
  assert.deepEqual(readdirSync(skills).sort(), ['.citadel-kit', 'citadel-alpha', 'citadel-beta']);
  assert.equal(readFileSync(join(skills, 'citadel-alpha', 'refs', 'a.md'), 'utf8'), 'v1');
  // The same kit again: nothing is touched under a turn that is reading it.
  writeFileSync(join(skills, 'citadel-alpha', 'in-use'), '');
  installSkills(kit, home);
  assert.ok(existsSync(join(skills, 'citadel-alpha', 'in-use')), 'left alone');
  // A new kit (a deploy): changed files replaced, a dropped skill removed, nothing left over.
  writeFileSync(join(kit, 'skills', 'alpha', 'refs', 'a.md'), 'v2');
  rmSync(join(kit, 'skills', 'beta'), { recursive: true });
  installSkills(kit, home);
  assert.deepEqual(readdirSync(skills).sort(), ['.citadel-kit', 'citadel-alpha']);
  assert.equal(readFileSync(join(skills, 'citadel-alpha', 'refs', 'a.md'), 'utf8'), 'v2');
  assert.equal(existsSync(join(skills, 'citadel-alpha', 'in-use')), false);
});

test("Codex's generated images show as GenerateImage and are copied into the worktree's generated/ folder", async () => {
  const dir = join(root, 'img');
  mkdirSync(dir);
  const r = await run(['-p'], { fake: 'image', cwd: dir } as any);
  const uses = r.events.filter((e) => e.message?.content?.[0]?.name === 'GenerateImage');
  assert.deepEqual(
    uses.map((e) => e.message.content[0].input.prompt),
    ['a red dot', '', ''],
  );
  const results = r.events.filter((e) => e.message?.content?.[0]?.type === 'tool_result').map((e) => e.message.content[0]);
  assert.deepEqual(
    results.map((x) => x.is_error),
    [false, false, true],
  );
  assert.match(results[0].content, /generated\/gen\.png$/);
  assert.equal(readFileSync(join(dir, 'generated', 'gen.png'), 'utf8'), 'PNG');
  assert.equal(readFileSync(join(dir, 'generated', 'g2.png'), 'utf8'), 'B64');
});
