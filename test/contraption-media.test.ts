import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CODEX_TOOL, listMedia, mcpMessage, MEDIA_KEEP_MS, MEDIA_TOOL_LIST, mediaDir, mediaFile, mediaTools, runMediaTool, sweepMedia, type CodexAt } from '../src/contraption-media.ts';
import { HttpError } from '../src/http.ts';

// The media folder and the `citadel` MCP server on contraption turns (#732). The OpenRouter side is
// test/openrouter.test.ts; the turn and its routes are test/contraption-turns.test.ts.
const root = mkdtempSync(join(tmpdir(), 'contraption-media-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('the folder hands out only files inside it, and lists them newest first without their notes', () => {
  const dir = mediaDir(root, 'peek', 3);
  mkdirSync(join(dir, 'auras'), { recursive: true });
  writeFileSync(join(dir, 'a.png'), 'aa');
  writeFileSync(join(dir, 'a.png.json'), '{}');
  writeFileSync(join(dir, 'auras', 'b.mp3'), 'bbb');
  utimesSync(join(dir, 'a.png'), 1000, 1000);
  assert.deepEqual(listMedia(dir).map((f) => [f.path, f.bytes]), [['auras/b.mp3', 3], ['a.png', 2]]);
  assert.deepEqual(listMedia(join(root, 'nobody')), []);
  assert.equal(mediaFile(dir, 'auras%2Fb.mp3'), join(dir, 'auras', 'b.mp3'));
  const status = (path: string) => { try { mediaFile(dir, path); return 200; } catch (e) { return (e as HttpError).status; } };
  assert.equal(status('../3/a.png'), 200, 'back inside is still inside');
  assert.equal(status('../4/a.png'), 400, 'another person\'s folder');
  assert.equal(status('..%2F..%2Fpeek'), 400);
  assert.equal(status('%E0%A4%A'), 400);
  assert.equal(status('auras'), 404, 'a folder is not a file');
  assert.equal(status('gone.png'), 404);
});

test('the sweep takes files older than the keep, notes too, and leaves the rest', () => {
  const dir = join(root, 'sweep', 'peek', '3');
  mkdirSync(dir, { recursive: true });
  for (const f of ['old.png', 'old.png.json', 'new.png']) writeFileSync(join(dir, f), 'x');
  const now = Date.now();
  const old = (now - MEDIA_KEEP_MS - 60_000) / 1000;
  utimesSync(join(dir, 'old.png'), old, old);
  utimesSync(join(dir, 'old.png.json'), old, old);
  assert.equal(sweepMedia(join(root, 'sweep'), now), 2);
  assert.deepEqual(listMedia(dir).map((f) => f.path), ['new.png']);
  assert.ok(!existsSync(join(dir, 'old.png.json')));
  assert.equal(sweepMedia(join(root, 'none')), 0);
});

test('a tool call writes to the turn person\'s folder on their account, tells the app with a media event, and the agent with text', async () => {
  const events: [string, any][] = [];
  const turn = { person: 3, name: 'peek', home: 9, emit: (e: string, d: object) => events.push([e, d]), codex: null };
  let ctx: any;
  const ok = {
    tool: async (_: string, args: any, c: any) => {
      ctx = c;
      const p = join(c.roots[0], args.out);
      writeFileSync(p, 'png!');
      return { paths: [p], cost_usd: 0.0091, left_usd: 9.4, model: 'm/klein', warnings: ['frost.png kept black'] };
    },
  };
  const r = await runMediaTool(ok as any, root, turn, 'generate_image', { prompt: 'x', out: 'frost.png' });
  assert.deepEqual({ ...ctx, roots: ctx.roots }, { userId: 3, ticketId: null, projectId: 9, roots: [mediaDir(root, 'peek', 3)], place: 'your media folder' });
  assert.deepEqual(events, [['media', { tool: 'generate_image', ok: true, files: [{ path: 'frost.png', bytes: 4, type: 'image/png' }], model: 'm/klein', cost_usd: 0.0091, left_usd: 9.4, warnings: ['frost.png kept black'] }]]);
  assert.deepEqual(r, { text: 'Wrote frost.png with m/klein for $0.0091; $9.40 left this month.\nfrost.png kept black', isError: false });

  events.length = 0;
  const capped = { tool: async () => { throw Object.assign(new HttpError(402, 'That would pass your cap.'), { code: 'over_cap' }); } };
  assert.deepEqual(await runMediaTool(capped as any, root, turn, 'generate_audio', {}), { text: 'over_cap: That would pass your cap.', isError: true });
  assert.deepEqual(events, [['media', { tool: 'generate_audio', ok: false, code: 'over_cap', message: 'That would pass your cap.' }]]);
  const broke = { tool: async () => { throw new Error('socket hang up'); } };
  assert.match((await runMediaTool(broke as any, root, turn, 'edit_image', {})).text, /^failed: The call didn't finish: socket hang up/);
});

test('the MCP server answers the handshake, lists its tools, ignores notifications and refuses what it lacks', async () => {
  const calls: unknown[] = [];
  const call = async (tool: string, args: unknown) => { calls.push([tool, args]); return { text: 'done', isError: false }; };
  const rpc = (m: object) => mcpMessage({ jsonrpc: '2.0', ...m }, MEDIA_TOOL_LIST, call as any) as Promise<any>;
  const init = await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.deepEqual(init.result, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'citadel', version: '1' } });
  assert.equal(await rpc({ method: 'notifications/initialized' }), null);
  assert.deepEqual((await rpc({ id: 2, method: 'tools/list' })).result.tools.map((t: any) => t.name), ['generate_image', 'edit_image', 'generate_audio']);
  assert.ok(MEDIA_TOOL_LIST.every((t) => t.description.includes('openrouter_not_connected')));
  assert.deepEqual((await rpc({ id: 3, method: 'tools/call', params: { name: 'generate_image', arguments: { out: 'a.png' } } })).result, { content: [{ type: 'text', text: 'done' }], isError: false });
  assert.deepEqual(calls, [['generate_image', { out: 'a.png' }]]);
  assert.equal((await rpc({ id: 4, method: 'tools/call', params: { name: 'rm_rf' } })).error.code, -32602);
  assert.equal((await rpc({ id: 5, method: 'resources/list' })).error.code, -32601);
  assert.equal((await mcpMessage([{ jsonrpc: '2.0', id: 6, method: 'ping' }], MEDIA_TOOL_LIST, call as any) as any).error.code, -32600, 'no batches');
  assert.equal((await rpc({ id: 7, method: 'tools/call', params: { name: CODEX_TOOL, arguments: {} } })).error.code, -32602, 'not offered, not callable');
  assert.equal(calls.length, 1);
});

// A stand-in for podman: it records how it was run, and plays citadel-codex-review --image-gen from the prompt's first word.
const FAKE_PODMAN = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const job = argv[argv.indexOf('-w') + 1];
const prompt = fs.readFileSync(0, 'utf8');
const env = argv.flatMap((a, i) => (argv[i - 1] === '-e' ? [a] : []));
const cfg = JSON.parse(fs.readFileSync(env.find((e) => e.startsWith('CITADEL_CODEX_TRIPWIRE=')).split('=')[1], 'utf8'));
fs.writeFileSync(process.env.FAKE_PODMAN_LOG, JSON.stringify({ argv, prompt, env, cfg, files: fs.readdirSync(job).sort(), refs: fs.readdirSync(job).filter((f) => f.startsWith('ref-')).map((f) => fs.readFileSync(path.join(job, f), 'utf8')) }));
if (prompt.startsWith('pace')) { process.stderr.write('citadel-codex-review: Skipped: your Codex use is over pace (5-hour 90%).\\n'); process.exit(4); }
if (prompt.startsWith('unsigned')) { process.stderr.write("citadel-codex-review: This person hasn't signed in to Codex in their container yet.\\n"); process.exit(3); }
if (prompt.startsWith('gone')) { process.stderr.write('Error: no container with name or ID found\\n'); process.exit(125); }
if (prompt.startsWith('broke')) { process.stderr.write('citadel-codex-review: Codex timed out\\n'); process.exit(124); }
const out = path.join(job, argv[argv.indexOf('--out') + 1]);
if (prompt.startsWith('link')) fs.symlinkSync(process.env.FAKE_PODMAN_SECRET, out);
else if (prompt.startsWith('text')) fs.writeFileSync(out, 'not a png');
else if (!prompt.startsWith('blank')) fs.writeFileSync(out, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(prompt.startsWith('again') ? 'again' : 'codex png')]));
process.stderr.write('Codex usage: 5-hour 12%, weekly 30%\\n');
`;

test('generate_image_codex runs the driver in the person\'s container and copies its PNG to the media folder; refusals come back as codes', async () => {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'podman'), FAKE_PODMAN);
  chmodSync(join(bin, 'podman'), 0o755);
  const log = join(root, 'podman.json');
  process.env.FAKE_PODMAN_LOG = log;
  const turnsDir = join(root, 'turns', '3');
  let woke = 0;
  const codex: CodexAt = { container: 'citadel-claude-3', turnsDir, env: { HOME: '/home/x', PATH: '/bin' }, tripwire: { project: 0 }, ensure: async () => void woke++, podman: join(bin, 'podman') };
  const events: [string, any][] = [];
  const turn = { person: 3, name: 'codexy', home: 9, emit: (e: string, d: object) => events.push([e, d]), codex };
  assert.deepEqual(mediaTools(turn).map((t) => t.name), ['generate_image', 'edit_image', 'generate_audio', CODEX_TOOL]);
  assert.deepEqual(mediaTools({ ...turn, codex: null }).map((t) => t.name), ['generate_image', 'edit_image', 'generate_audio']);
  const dir = mediaDir(root, 'codexy', 3);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'base.png'), 'base');

  const r = await runMediaTool(null as any, root, turn, CODEX_TOOL, { prompt: 'a frost rune', out: 'auras/frost.png', refs: ['base.png'], background: 'transparent' });
  assert.deepEqual(r, { text: "Wrote auras/frost.png with Codex on this person's ChatGPT plan, no charge. Codex usage: 5-hour 12%, weekly 30%.", isError: false });
  assert.equal(readFileSync(join(dir, 'auras', 'frost.png')).subarray(8).toString(), 'codex png');
  const note = JSON.parse(readFileSync(join(dir, 'auras', 'frost.png.json'), 'utf8'));
  assert.deepEqual({ ...note, date: 'd' }, { tool: CODEX_TOOL, prompt: 'a frost rune', model: 'codex image_gen', cost_usd: 0, date: 'd', background: 'transparent', refs: ['base.png'] });
  assert.deepEqual(events, [['media', { tool: CODEX_TOOL, ok: true, files: [{ path: 'auras/frost.png', bytes: 17, type: 'image/png' }], model: 'codex image_gen', cost_usd: 0 }]]);
  const ran = JSON.parse(readFileSync(log, 'utf8'));
  const job = ran.argv[ran.argv.indexOf('-w') + 1];
  assert.ok(job.startsWith(join(turnsDir, 'media-codex-')), 'its own folder in the person\'s turns folder, which the container sees at the same path');
  assert.deepEqual(ran.argv.slice(ran.argv.indexOf('citadel-claude-3')), ['citadel-claude-3', process.execPath, join(job, 'codex-review.ts'), '--image-gen', '--timeout', '600', '--out', 'out.png', '--transparent', '--image', 'ref-0.png']);
  assert.equal(ran.prompt, 'a frost rune');
  assert.deepEqual(ran.env, ['HOME=/home/x', 'PATH=/bin', `CITADEL_CODEX_TRIPWIRE=${join(job, 'codex-tripwire.json')}`]);
  assert.deepEqual(ran.cfg, { script: join(job, 'tripwire.ts'), config: { project: 0 } });
  assert.deepEqual(ran.files, ['codex-lock.ts', 'codex-review.ts', 'codex-tripwire.json', 'codex.ts', 'ref-0.png', 'tripwire.ts'], "the driver and everything it imports");
  assert.deepEqual(ran.refs, ['base']);
  assert.equal(woke, 1);
  assert.deepEqual(readdirSync(turnsDir), [], 'the folder goes once it ends');

  events.length = 0;
  const call = (prompt: string, more = {}) => runMediaTool(null as any, root, turn, CODEX_TOOL, { prompt, out: 'x.png', ...more });
  assert.match((await call('pace please')).text, /^codex_over_pace: Skipped: your Codex use is over pace \(5-hour 90%\)\. Use generate_image for this one\.$/);
  assert.match((await call('unsigned')).text, /^codex_not_ready: This person hasn't signed in/);
  assert.match((await call('gone')).text, /^failed: The call didn't finish: Couldn't run Codex in this person's container \(citadel-claude-3\): Error: no container/);
  assert.match((await call('broke')).text, /^failed: The call didn't finish: Codex couldn't make the image \(exit 124\): Codex timed out$/);
  assert.match((await call('blank')).text, /^failed: .*left no picture/);
  assert.match((await call('text')).text, /^failed: .*isn't a PNG file/);
  // A link the container left at out.png is never followed: the server's own files stay out of the media folder.
  const secret = join(root, 'server-only.png');
  writeFileSync(secret, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('SERVER SECRET')]));
  process.env.FAKE_PODMAN_SECRET = secret;
  assert.match((await call('link')).text, /^failed: .*left no picture/);
  assert.deepEqual(events.map(([, d]) => d.code), ['codex_over_pace', 'codex_not_ready', 'failed', 'failed', 'failed', 'failed', 'failed']);
  assert.ok(!existsSync(join(dir, 'x.png')), 'nothing written on a refusal');
  assert.deepEqual(readdirSync(turnsDir), []);

  // Bad arguments are refused before Codex runs.
  const runs = woke;
  assert.match((await call('a', { out: 'x.webp' })).text, /^bad_request: out ends in \.png/);
  assert.match((await call('a', { out: '../../elsewhere.png' })).text, /^bad_request: out must be inside your media folder/);
  assert.match((await call('a', { out: 'auras/frost.png' })).text, /^bad_request: .*already there/);
  assert.match((await call('a', { refs: ['nope.png'] })).text, /^bad_request: nope\.png: no png/);
  assert.match((await call('a', { refs: ['../../../../etc/passwd.png'] })).text, /^bad_request: /);
  assert.match((await call('a', { background: 'white' })).text, /^bad_request: background/);
  assert.match((await call('')).text, /^bad_request: prompt is required/);
  assert.equal(woke, runs);
  assert.equal((await call('again', { out: 'auras/frost.png', overwrite: true })).isError, false);
  assert.equal(readFileSync(join(dir, 'auras', 'frost.png')).subarray(8).toString(), 'again');
  assert.match((await runMediaTool(null as any, root, { ...turn, codex: null }, CODEX_TOOL, { prompt: 'a', out: 'y.png' })).text, /^codex_not_ready: /);
});
