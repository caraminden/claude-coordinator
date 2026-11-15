import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { listMedia, mcpMessage, MEDIA_KEEP_MS, MEDIA_TOOL_LIST, mediaDir, mediaFile, runMediaTool, sweepMedia } from '../src/contraption-media.ts';
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
  const turn = { person: 3, name: 'peek', home: 9, emit: (e: string, d: object) => events.push([e, d]) };
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
  const rpc = (m: object) => mcpMessage({ jsonrpc: '2.0', ...m }, call as any) as Promise<any>;
  const init = await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.deepEqual(init.result, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'citadel', version: '1' } });
  assert.equal(await rpc({ method: 'notifications/initialized' }), null);
  assert.deepEqual((await rpc({ id: 2, method: 'tools/list' })).result.tools.map((t: any) => t.name), ['generate_image', 'edit_image', 'generate_audio']);
  assert.ok(MEDIA_TOOL_LIST.every((t) => t.description.includes('openrouter_not_connected')));
  assert.deepEqual((await rpc({ id: 3, method: 'tools/call', params: { name: 'generate_image', arguments: { out: 'a.png' } } })).result, { content: [{ type: 'text', text: 'done' }], isError: false });
  assert.deepEqual(calls, [['generate_image', { out: 'a.png' }]]);
  assert.equal((await rpc({ id: 4, method: 'tools/call', params: { name: 'rm_rf' } })).error.code, -32602);
  assert.equal((await rpc({ id: 5, method: 'resources/list' })).error.code, -32601);
  assert.equal((await mcpMessage([{ jsonrpc: '2.0', id: 6, method: 'ping' }], call as any) as any).error.code, -32600, 'no batches');
  assert.equal(calls.length, 1);
});
