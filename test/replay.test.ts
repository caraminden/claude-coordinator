// citadel-replay (#836, src/replay.ts): the stub answers a replay's tool calls from the kept chat, and a run reruns each
// chat with the old and new prompt, writes blind X/Y outcomes with the key outside the critic's folder, deletes the
// transcripts it made, and refuses more than TURN_CAP turns unless told.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import { answer, run, type Kept } from '../src/replay.ts';

const root = mkdtempSync(join(tmpdir(), 'replay-'));
after(() => rmSync(root, { recursive: true, force: true }));

const turn = (n: number, calls: Kept['calls'], prompt = `turn ${n}`): Kept => ({ n, prompt, images: 0, system: 'x', model: null, servers: ['app'], agents: false, webSearch: false, compactWindow: 40_000, calls, text: `reply ${n}` });

test('the stub gives a repeat call its recorded results in order, the same tool its most alike call, and an unknown one an error', () => {
  const chat = [
    turn(1, [
      { name: 'mcp__app__get', input: { id: 1 }, ok: true, result: 'first' },
      { name: 'mcp__app__get', input: { id: 1 }, ok: true, result: 'second' },
      { name: 'mcp__app__save', input: { id: 1, color: 'red' }, ok: false, result: 'nope' },
    ]),
    turn(2, [{ name: 'mcp__app__get', input: { id: 2 }, ok: true, result: 'two' }, { name: 'mcp__app__find', input: { q: 'a' }, ok: true, result: 'in turn 2' }]),
    turn(3, [{ name: 'mcp__app__find', input: { q: 'b' }, ok: true, result: 'in turn 3' }]),
  ];
  const used = new Set<object>();
  assert.deepEqual(answer(chat, 1, 'mcp__app__get', { id: 1 }, used), { ok: true, text: 'first' });
  assert.deepEqual(answer(chat, 1, 'mcp__app__get', { id: 1 }, used), { ok: true, text: 'second' });
  assert.deepEqual(answer(chat, 1, 'mcp__app__get', { id: 1 }, used), { ok: true, text: 'second' }, 'past the recording: the last again');
  assert.deepEqual(answer(chat, 1, 'mcp__app__get', { id: 2 }, used), { ok: true, text: 'two' });
  assert.deepEqual(answer(chat, 1, 'mcp__app__save', { id: 1, color: 'blue' }, used), { ok: false, text: 'nope' }, 'other arguments: the closest call, error and all');
  assert.equal(answer(chat, 3, 'mcp__app__find', { q: 'z' }, new Set()).text, 'in turn 3', 'equally unlike: the replayed turn\'s own');
  assert.equal(answer(chat, 2, 'mcp__app__find', { q: 'z' }, new Set()).text, 'in turn 2');
  const none = answer(chat, 1, 'mcp__app__delete', {}, used);
  assert.equal(none.ok, false);
  assert.match(none.text, /Not available in replay/);
});

// A stand-in for claude: reads the turn's system text and MCP config as the real one would, calls the stub's get
// tool over stdio, and replies with what it got. It keeps a transcript where claude does, for the run to delete.
const fake = join(root, 'claude-fake');
writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const argv = process.argv.slice(2), opt = (k) => { const i = argv.indexOf(k); return i < 0 ? undefined : argv[i + 1]; };
const system = fs.readFileSync(opt('--append-system-prompt-file'), 'utf8');
const sid = opt('--resume') ?? opt('--session-id');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
let input = '';
process.stdin.on('data', (d) => {
  input += d;
  if (!input.includes('\\n')) return;
  const prompt = JSON.parse(input.split('\\n')[0]).message.content.at(-1).text;
  fs.appendFileSync(path.join(dir, sid + '.jsonl'), prompt + '\\n');
  const s = JSON.parse(fs.readFileSync(opt('--mcp-config'), 'utf8')).mcpServers.app;
  const stub = spawn(s.command, s.args, { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  stub.on('exit', () => {
    if (buf.split('\\n').filter(Boolean).length >= 3) return;
    out({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'app', status: 'failed' }] });
    out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0 });
  });
  stub.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\\n').filter(Boolean).map((l) => JSON.parse(l));
    if (lines.length < 3) return;
    stub.kill();
    const tools = lines[1].result.tools.map((t) => t.name).join(',');
    const r = lines[2].result;
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__app__get', input: { id: 1 } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: r.isError, content: r.content }] } });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: system.split('\\n')[0] + ' | ' + prompt + ' | tools ' + tools + ' | resumed ' + !!opt('--resume') }] } });
    out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01 });
  });
  const rpc = (m) => stub.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  rpc({ id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  rpc({ method: 'notifications/initialized' });
  rpc({ id: 1, method: 'tools/list' });
  rpc({ id: 2, method: 'tools/call', params: { name: 'get', arguments: { id: 1 } } });
});
process.stdin.on('end', () => process.exit(0));
`);
chmodSync(fake, 0o755);

test('a run reruns each kept chat on the old and new prompt, writes X and Y with the key outside, and leaves no transcripts', { timeout: 60_000 }, async () => {
  const chats = join(root, 'chats');
  mkdirSync(chats);
  const lines = (t: Kept[]) => t.map((x) => JSON.stringify({ v: 1, at: 0, turn: 1, ...x })).join('\n') + '\n';
  const call = (n: number) => [{ name: 'mcp__app__get', input: { id: 1 }, ok: true, result: `recorded ${n}` }];
  writeFileSync(join(chats, 'a-s1-aaaaaaaa.jsonl'), lines([turn(1, call(1), 'Make my aura blue.'), turn(2, call(2), 'Brighter.')]));
  writeFileSync(join(chats, 'b-s2-bbbbbbbb.jsonl'), lines([turn(1, call(1), 'Hi')]));
  writeFileSync(join(root, 'old.md'), 'OLD PROMPT\nrest');
  writeFileSync(join(root, 'new.md'), 'NEW PROMPT\nrest');
  const config = join(root, 'config');
  process.env.CLAUDE_CONFIG_DIR = config;
  const out = join(root, 'out');
  // A relative --chats: the stub runs in claude's work folder, so the run must hand it absolute paths.
  const base = { chats: relative(process.cwd(), chats), old: join(root, 'old.md'), new: join(root, 'new.md'), out, model: null, tools: null, toolsNew: null, mcp: new Map(), parallel: 2, overCap: false, claude: fake };
  await run({ ...base, count: 5 });
  assert.deepEqual(readdirSync(out).sort(), ['chat-1.md', 'chat-2.md']);
  const key = JSON.parse(readFileSync(`${out}.key.json`, 'utf8'));
  for (const [chat, k] of Object.entries(key) as [string, { X: string; Y: string; file: string }][]) {
    assert.deepEqual([k.X, k.Y].sort(), ['new', 'old']);
    const md = readFileSync(join(out, `${chat}.md`), 'utf8');
    const x = md.split('### X')[1].split('### Y')[0];
    const y = md.split('### Y')[1].split('### Originally')[0];
    assert.match(x, k.X === 'new' ? /NEW PROMPT/ : /OLD PROMPT/);
    assert.match(y, k.Y === 'new' ? /NEW PROMPT/ : /OLD PROMPT/);
    assert.doesNotMatch(md.replace(/(NEW|OLD) PROMPT/g, ''), /\b(old|new)\b/i, 'nothing but the fake\'s echo says which side is which');
    assert.match(x, /tools get \| resumed false/);
    if (k.file.startsWith('a-')) {
      assert.match(md, /Make my aura blue\.[\s\S]*Brighter\./);
      assert.match(md.split('## Turn 2')[1], /recorded 2[\s\S]*resumed true/, "turn 2 resumes and gets turn 2's recorded result");
    }
  }
  assert.deepEqual(readdirSync(join(config, 'projects')), [], 'the transcripts are gone');
  // Over the cap: refused before any turn runs, unless asked.
  const many = join(root, 'many');
  mkdirSync(many);
  writeFileSync(join(many, 'c-s3-cccccccc.jsonl'), lines(Array.from({ length: 31 }, (_, i) => turn(i + 1, []))));
  await assert.rejects(run({ ...base, chats: many, count: 5, out: join(root, 'capped') }), /62 turns is over the 60-turn cap/);
  assert.ok(!existsSync(join(root, 'capped')));
});
