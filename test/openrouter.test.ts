import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { Credentials } from '../src/credentials.ts';
import { Store } from '../src/db.ts';
import { HttpError } from '../src/http.ts';
import { agentToken, bootServer } from './helpers.ts';
import { imageEstimate, mediaCode, monthStart, mp3Seconds, OpenRouter, perRequestPrice, resetsAt, speechEstimate, speechLimit } from '../src/openrouter.ts';
import { decodePng, encodePng } from '../src/png-matte.ts';

// OpenRouter (#717): each person's own key and monthly cap. Every call is booked at its worst case
// before the request, so a call that could pass the cap never reaches OpenRouter, and the key never
// leaves the server.
const root = mkdtempSync(join(tmpdir(), 'openrouter-'));
after(() => rmSync(root, { recursive: true, force: true }));

const store = new Store(join(root, 'test.db'));
const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
const josh = store.createUser({ name: 'Josh', login: 'josh', server_login: true });
const creds = new Credentials(store, 'secret one');
const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

const KLEIN = [{
  supported_parameters: { resolution: { type: 'enum', values: ['768', '1K', '1.5K', '2K', '4K'] }, n: { type: 'range', min: 1, max: 1 }, input_references: { type: 'range', min: 0, max: 10 }, output_format: { type: 'enum', values: ['jpeg', 'png'] } },
  pricing: [
    { billable: 'output_image', unit: 'image', cost_usd: 0.008, variant: '768' },
    { billable: 'output_image', unit: 'image', cost_usd: 0.009, variant: '1k' },
    { billable: 'output_image', unit: 'image', cost_usd: 0.036, variant: '4k' },
  ],
}];
const GPT_IMAGE = [{
  supported_parameters: { n: { type: 'range', min: 1, max: 10 }, input_references: { type: 'range', min: 0, max: 16 } },
  pricing: [
    { billable: 'input_image', unit: 'token', cost_usd: 8e-6 },
    { billable: 'input_text', unit: 'token', cost_usd: 5e-6 },
    { billable: 'output_image', unit: 'token', cost_usd: 3e-5 },
  ],
}];
const MODEL_LIST = [
  { id: 'bytedance-seed/seed-audio-1-0', pricing: { prompt: '0', completion: '0.0025' }, description: 'Seed Audio' },
  { id: 'google/lyria-3-clip-preview', pricing: { prompt: '0', completion: '0' }, description: '30 second duration clips are priced at $0.04 per clip. Lyria 3...', supported_parameters: ['seed'] },
  { id: 'nobody/unpriced', pricing: { prompt: '0', completion: '0' }, description: 'No price here' },
  { id: 'google/some-tts', pricing: { prompt: '0.000001', completion: '0.000009' }, description: 'Speech, priced per token' },
  // Speech models as OpenRouter's list gives them on 2026-11-16: a price with no unit, and a limit only in some descriptions.
  { id: 'fish-audio/drama-3', pricing: { prompt: '0.00001', completion: '0' }, top_provider: { context_length: 0, max_completion_tokens: 0 }, description: 'Drama 3 is a text-to-speech model from Fish Audio...' },
  { id: 'google/gemini-3.8-flash-tts', pricing: { prompt: '0.0000005', completion: '0.000009' }, top_provider: { context_length: 32768, max_completion_tokens: 16384 }, description: 'Gemini TTS' },
  { id: 'elevenlabs/eleven-v3', pricing: { prompt: '0.00008', completion: '0' }, top_provider: { max_completion_tokens: 0 }, description: 'It supports 70+ languages, and has a 5,000-character request limit.' },
  { id: 'minimax/speech-2.8-hd', pricing: { prompt: '0.0001', completion: '0' }, top_provider: { max_completion_tokens: 0 }, description: 'MiniMax speech' },
  { id: 'fish-audio/s2.1-pro-free:free', pricing: { prompt: '0', completion: '0' }, description: 'free' },
];
// 128 kbps MPEG-1 Layer III: 16000 bytes is one second.
const MP3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(15996)]);
const PNG = Buffer.from('fake png bytes');

/** OpenRouter, faked. `hold` delays POST /images until released; `answer` overrides a path's response. */
function fakeOpenRouter(answer: Record<string, () => Response | Promise<Response>> = {}) {
  const calls: { url: string; method: string; auth: string | null; body: any; raw: string | null }[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace('https://or.test/api/v1', '');
    calls.push({ url: path, method: init.method ?? 'GET', auth: new Headers(init.headers).get('authorization'), body: init.body ? JSON.parse(String(init.body)) : null, raw: init.body ? String(init.body) : null });
    const auth = new Headers(init.headers).get('authorization');
    for (const [p, fn] of Object.entries(answer)) if (path === p) return fn();
    if (path === '/key') return auth === `Bearer ${KEY}` ? Response.json({ data: { label: 'sk-or-v1-012...def', limit: 20, limit_reset: 'monthly', usage_monthly: 1.5 } }) : Response.json({ error: { message: 'No auth' } }, { status: 401 });
    if (path.startsWith('/models')) return Response.json({ data: MODEL_LIST });
    if (path === '/images/models/black-forest-labs/flux-3-image-klein/endpoints') return Response.json({ endpoints: KLEIN });
    if (path === '/images/models/openai/gpt-image-2/endpoints') return Response.json({ endpoints: GPT_IMAGE });
    if (path.startsWith('/images/models/')) return new Response('not found', { status: 404 });
    if (path === '/images') return Response.json({ id: 'gen-1', data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.0091 } });
    if (path === '/audio/speech') return new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } });
    if (path === '/chat/completions') {
      const audio = Buffer.from('fake music bytes').toString('base64');
      const events = [
        { id: 'gen-m', choices: [{ delta: { audio: { data: audio.slice(0, 7) } } }] },
        { id: 'gen-m', choices: [{ delta: { audio: { data: audio.slice(7) } } }] },
        { id: 'gen-m', choices: [], usage: { cost: 0.04 } },
      ];
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('?', { status: 500 });
  }) as typeof fetch;
  return { fetch, calls };
}

let n = 0;
/** A fresh minion folder and an OpenRouter over a fresh fake, with `user` connected at `cap`. */
async function setup(opts: { cap?: number; user?: number; answer?: Record<string, () => Response | Promise<Response>> } = {}) {
  const user = opts.user ?? cara.id;
  store.deleteCredential(user, 'openrouter');
  const fake = fakeOpenRouter(opts.answer);
  const or = new OpenRouter(store, creds, fake.fetch, 'https://or.test/api/v1');
  await or.connect(user, KEY, opts.cap ?? 10);
  const cwd = join(root, `minion-${++n}`);
  const shared = join(root, `shared-${n}`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(shared, { recursive: true });
  // Each test spends from a clean month: old rows move to last month.
  (store as any).db.prepare('UPDATE openrouter_calls SET created_at = ? WHERE user_id = ?').run(monthStart() - 1, user);
  fake.calls.length = 0;
  return { or, fake, cwd, ctx: { userId: user, ticketId: 7, projectId: 2, roots: [cwd, shared] } };
}

const rows = (user = cara.id) => (store as any).db.prepare('SELECT * FROM openrouter_calls WHERE user_id = ? AND created_at >= ? ORDER BY id').all(user, monthStart()) as any[];

test('connecting checks the key with OpenRouter and seals it; the meta keeps the cap, never the key or its label', async () => {
  const fake = fakeOpenRouter();
  const or = new OpenRouter(store, creds, fake.fetch, 'https://or.test/api/v1');
  await assert.rejects(or.connect(josh.id, 'sk-or-v1-wrongwrongwrongwrong', 5), (e: HttpError) => e.status === 400 && /didn't accept/.test(e.message));
  assert.equal(store.getCredential(josh.id, 'openrouter'), undefined);
  await assert.rejects(or.connect(josh.id, 'short', 5), /doesn't look like/);
  await assert.rejects(or.connect(josh.id, KEY, 0), /monthly cap/);
  const s = await or.connect(josh.id, KEY, 5);
  assert.equal(s.connected, true);
  assert.equal(s.cap_usd, 5);
  assert.equal(s.or_limit, 20);
  const row = store.getCredential(josh.id, 'openrouter')!;
  assert.ok(!row.secret.includes(KEY) && !row.meta.includes('sk-or'), 'neither the sealed secret nor the meta shows the key');
  assert.ok(!JSON.stringify(or.status(josh.id)).includes('sk-or'));
  assert.equal(or.setCap(josh.id, 12.345).cap_usd, 12.35);
  or.unlink(josh.id);
  assert.equal(or.status(josh.id).connected, false);
});

test('a person who has not connected gets the connect answer, before any request', async () => {
  const fake = fakeOpenRouter();
  const or = new OpenRouter(store, creds, fake.fetch, 'https://or.test/api/v1');
  for (const userId of [josh.id, null]) {
    await assert.rejects(or.tool('generate_image', { prompt: 'a cat', out: 'cat.png' }, { userId, ticketId: 1, projectId: 2, roots: [root] }), (e: HttpError) => e.status === 403 && /connect it on the account page/.test(e.message));
  }
  assert.equal(fake.calls.length, 0);
  assert.equal(or.connected(josh.id), false);
});

test('an image is written with a note of how it was made, and the ledger keeps its real cost', async () => {
  const { or, fake, cwd, ctx } = await setup();
  const r = await or.tool('generate_image', { prompt: 'a knight, pixel art', out: 'art/knight.png', resolution: '1K' }, ctx);
  assert.deepEqual(r.paths, [join(cwd, 'art/knight.png')]);
  assert.deepEqual(readFileSync(r.paths[0]), PNG);
  const note = JSON.parse(readFileSync(`${r.paths[0]}.json`, 'utf8'));
  assert.equal(note.prompt, 'a knight, pixel art');
  assert.equal(note.model, 'black-forest-labs/flux-3-image-klein');
  assert.equal(r.cost_usd, 0.0091);
  assert.equal(r.left_usd, 9.991);
  const post = fake.calls.find((c) => c.url === '/images')!;
  assert.equal(post.auth, `Bearer ${KEY}`);
  assert.equal(post.body.output_format, 'png');
  assert.deepEqual(rows().map((x) => [x.status, x.estimate_usd, x.cost_usd, x.kind, x.ticket_id]), [['ok', 0.009, 0.0091, 'image', 7]]);
  // The same name again is refused before anything is spent, unless overwrite is set.
  await assert.rejects(or.tool('generate_image', { prompt: 'again', out: 'art/knight.png' }, ctx), (e: HttpError) => e.status === 409);
  assert.equal(rows().length, 1);
  await or.tool('generate_image', { prompt: 'again', out: 'art/knight.png', overwrite: true, resolution: '768' }, ctx);
  assert.equal(rows().length, 2);
});

test('a call that could pass the cap is refused before any request, and two at once cannot both fit', async () => {
  const { or, fake, ctx } = await setup({ cap: 0.01 });
  await assert.rejects(or.tool('generate_image', { prompt: 'big', out: 'a.png', resolution: '4K' }, ctx), (e: HttpError) => e.status === 402 && /cap/.test(e.message));
  assert.ok(!fake.calls.some((c) => c.url === '/images'));
  // Each 768 image could cost $0.008: the first books it, the second would make $0.016.
  const both = await Promise.allSettled([
    or.tool('generate_image', { prompt: 'one', out: 'one.png', resolution: '768' }, ctx),
    or.tool('generate_image', { prompt: 'two', out: 'two.png', resolution: '768' }, ctx),
  ]);
  assert.deepEqual(both.map((b) => b.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(fake.calls.filter((c) => c.url === '/images').length, 1);
});

test('no single call may cost more than the per-call limit, and a model with no price is refused', async () => {
  const { or, fake, ctx } = await setup({ cap: 100 });
  // gpt-image-2 prices output by the token: 4 images at a worst case of 8000 tokens is $0.96.
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'x.png', model: 'openai/gpt-image-2', n: 4 }, ctx), /over the \$0\.500 limit per call/);
  await assert.rejects(or.tool('generate_audio', { kind: 'music', prompt: 'x', out: 'x.mp3', model: 'nobody/unpriced' }, ctx), /no price/);
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'x.png', n: 2 }, ctx), /at most 1 image/);
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'x.png', resolution: '8K' }, ctx), /resolution/);
  assert.ok(!fake.calls.some((c) => c.method === 'POST'));
  assert.equal(rows().length, 0);
});

test('OpenRouter refusing the key marks it failed; its own limit reads as the cap on OpenRouter; a dropped call counts at its estimate', async () => {
  let { or, ctx } = await setup({ answer: { '/images': () => Response.json({ error: { message: 'User not found' } }, { status: 401 }) } });
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'x.png', resolution: '1K' }, ctx), (e: HttpError) => e.status === 403 && /refused the key/.test(e.message));
  assert.equal(or.connected(cara.id), false);
  assert.equal(or.status(cara.id).failed, true);
  assert.deepEqual(rows().map((r) => [r.status, r.cost_usd]), [['failed', 0]]);
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'y.png' }, ctx), /connect it again/);

  ({ or, ctx } = await setup({ answer: { '/images': () => Response.json({ error: { message: 'Key limit exceeded' } }, { status: 403 }) } }));
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'x.png', resolution: '1K' }, ctx), (e: HttpError) => e.status === 402 && /limit set on OpenRouter/.test(e.message));
  assert.equal(or.connected(cara.id), true);

  ({ or, ctx } = await setup({ answer: { '/images': () => Promise.reject(new TypeError('fetch failed')) } }));
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'x.png', resolution: '1K' }, ctx), (e: HttpError) => e.status === 502);
  assert.deepEqual(rows().map((r) => r.status), ['unknown']);
  assert.equal(or.status(cara.id).spent_usd, 0.009);
});

test('calls still pending when the server stopped count at their estimate', async () => {
  const id = store.addOpenrouterCall({ user_id: josh.id, ticket_id: 1, project_id: 2, model: 'm/x', kind: 'image', estimate_usd: 0.2 });
  new OpenRouter(store, creds, fakeOpenRouter().fetch, 'https://or.test/api/v1');
  assert.equal(rows(josh.id).find((r) => r.id === id).status, 'unknown');
  assert.equal(store.openrouterSpent(josh.id, monthStart()), 0.2);
});

test('a sound effect is costed by its length; music comes from the stream with its cost', async () => {
  const { or, fake, cwd, ctx } = await setup();
  const fx = await or.tool('generate_audio', { kind: 'effect', prompt: 'a door creaks', out: 'sfx/door.mp3', seconds: 2 }, ctx);
  assert.deepEqual(readFileSync(fx.paths[0]), MP3);
  assert.equal(fx.cost_usd, 0.0025);
  assert.equal(fake.calls.find((c) => c.url === '/audio/speech')!.body.input, 'a door creaks\nLength: about 2 seconds.');
  assert.equal(rows()[0].estimate_usd, 0.15);
  await assert.rejects(or.tool('generate_audio', { kind: 'effect', prompt: 'x', out: 'x.wav' }, ctx), /\.mp3/);

  const song = await or.tool('generate_audio', { kind: 'music', prompt: 'calm village theme', out: join(cwd, 'music/village.mp3') }, ctx);
  assert.equal(readFileSync(song.paths[0], 'utf8'), 'fake music bytes');
  assert.equal(song.cost_usd, 0.04);
  assert.equal(fake.calls.find((c) => c.url === '/chat/completions')!.body.stream, true);
  assert.deepEqual(rows().map((r) => [r.kind, r.status, r.estimate_usd]), [['effect', 'ok', 0.15], ['music', 'ok', 0.04]]);
});

test('a speech model priced per token is refused; a clip longer than a minute is booked at its full length', async () => {
  const long = Buffer.concat(Array.from({ length: 90 }, () => MP3));
  const { or, fake, ctx } = await setup({ answer: { '/audio/speech': () => new Response(long, { headers: { 'content-type': 'audio/mpeg' } }) } });
  await assert.rejects(or.tool('generate_audio', { kind: 'effect', prompt: 'hello', out: 'hi.mp3', model: 'google/some-tts' }, ctx), /price/);
  assert.ok(!fake.calls.some((c) => c.url === '/audio/speech'));
  const fx = await or.tool('generate_audio', { kind: 'effect', prompt: 'a long storm', out: 'storm.mp3' }, ctx);
  assert.ok(Math.abs(fx.cost_usd - 0.225) < 1e-9);
});

test('outputs and inputs stay inside the minion\'s folders', async () => {
  const { or, cwd, ctx } = await setup();
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: '../escape.png' }, ctx), /inside your working directory/);
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'x.exe' }, ctx), /out ends in/);
  symlinkSync(tmpdir(), join(cwd, 'link'));
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'link/x.png' }, ctx), /inside your working directory/);
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'link/or-new-dir/x.png' }, ctx), /inside your working directory/);
  assert.ok(!existsSync(join(tmpdir(), 'or-new-dir')));
  mkdirSync(join(cwd, 'sub'));
  symlinkSync(join(tmpdir(), 'or-note-escape.json'), join(cwd, 'sub/n.png.json'));
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'sub/n.png' }, ctx), /isn't a plain file/);
  writeFileSync(join(cwd, 'old.png.json'), '{}');
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'old.png' }, ctx), /already there/);
  await assert.rejects(or.tool('edit_image', { prompt: 'x', out: 'e.png', image: '/etc/hostname' }, ctx), /no png, jpeg or webp/);
  writeFileSync(join(cwd, 'base.png'), PNG);
  const r = await or.tool('edit_image', { prompt: 'make it night', out: 'night.png', image: 'base.png', resolution: '1K' }, ctx);
  assert.ok(existsSync(r.paths[0]));
  assert.equal(rows().length, 1);
});

test('worst-case prices: per image by resolution, per token, per clip; an MP3\'s length from its frames', () => {
  assert.equal(imageEstimate(KLEIN, { resolution: '1K', n: 1, refs: 0, promptChars: 10 }), 0.009);
  assert.equal(imageEstimate(KLEIN, { n: 1, refs: 0, promptChars: 10 }), 0.036);
  assert.ok(Math.abs(imageEstimate(GPT_IMAGE, { n: 1, refs: 2, promptChars: 100 })! - (0.24 + 0.032 + 0.0005)) < 1e-9);
  assert.equal(imageEstimate([{ pricing: [{ billable: 'input_text', unit: 'token', cost_usd: 1 }] }], { n: 1, refs: 0, promptChars: 1 }), null);
  assert.ok(Math.abs(imageEstimate([{ pricing: [{ billable: 'output_image', unit: 'megapixel', cost_usd: 0.01 }] }], { resolution: '2K', n: 2, refs: 0, promptChars: 1 })! - 0.0838) < 1e-9);
  // A unit this can't count, or one endpoint OpenRouter might route to with no image price, is no price at all.
  assert.equal(imageEstimate([{ pricing: [{ billable: 'output_image', unit: 'second', cost_usd: 0.1 }] }], { n: 1, refs: 0, promptChars: 1 }), null);
  assert.equal(imageEstimate([...KLEIN, { pricing: [] }], { n: 1, refs: 0, promptChars: 1 }), null);
  assert.equal(imageEstimate([{ pricing: [{ billable: 'output_image', unit: 'request', cost_usd: 0.02 }] }], { n: 2, refs: 0, promptChars: 1 }), 0.04);
  assert.equal(perRequestPrice(MODEL_LIST[1]), 0.04);
  assert.equal(perRequestPrice({ description: 'Full songs at $0.08 per song.' }), 0.08);
  assert.equal(perRequestPrice(MODEL_LIST[2]), null);
  assert.equal(mp3Seconds(MP3), 1);
  const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 10]), Buffer.alloc(10), MP3]);
  assert.equal(mp3Seconds(id3), 1);
  assert.equal(mp3Seconds(Buffer.from('not audio')), null);
  assert.match(resetsAt(Date.UTC(2026, 10, 14)), /^Nov 30, 16:00 PST$/);
});

test('through the server: a person connects on their account page and their minion makes an image with the MCP tool', async () => {
  // OpenRouter faked over HTTP, answering as the fake above.
  const fake = fakeOpenRouter();
  const orServer = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const r = await fake.fetch(`https://or.test${req.url}`, { method: req.method, headers: { authorization: req.headers.authorization ?? '' }, body: body || undefined });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' }).end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((ok) => orServer.listen(0, '127.0.0.1', ok));
  after(() => orServer.close());

  const boot = mkdtempSync(join(tmpdir(), 'openrouter-boot-'));
  const data = join(boot, 'data');
  const wt = join(boot, 'wt');
  mkdirSync(data, { recursive: true });
  mkdirSync(wt);
  const s = new Store(join(data, 'coordinator.db'));
  const scheme = s.createProject('Art', null);
  const owner = s.createUser({ name: 'Cara', login: 'cara', admin: true });
  const minion = s.createTicket({ project_id: scheme.id, kind: 'ticket', title: 'Art', permission_mode: 'default', created_by: 'Cara' });
  s.setTicketDir(minion.id, wt, null);
  s.updateTicket(minion.id, { person_id: owner.id });
  s.db.close();

  const srv = await bootServer({ root: boot, env: { OPENROUTER_BASE_URL: `http://127.0.0.1:${(orServer.address() as { port: number }).port}/api/v1` } });
  const mcp = async (media: boolean, method: string, params: object = {}) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.ts')], {
      env: { ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: agentToken(data, minion.id), COORDINATOR_PROJECT: String(scheme.id), COORDINATOR_TICKET: String(minion.id), COORDINATOR_ROLE: 'thread', COORDINATOR_MEDIA: media ? '1' : '', COORDINATOR_CODEX_IMAGES: '', COORDINATOR_MEMORY: '' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    try {
      const reply = new Promise<any>((ok) => createInterface({ input: child.stdout }).once('line', (l) => ok(JSON.parse(l))));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
      return (await reply).result;
    } finally {
      child.kill();
    }
  };
  try {
    assert.equal((await srv.call('/api/me/openrouter')).data.connected, false);
    assert.equal((await srv.call('/api/me/openrouter', { key: 'sk-or-v1-wrong', cap: 5 })).status, 400);
    const linked = await srv.call('/api/me/openrouter', { key: KEY, cap: 5 });
    assert.equal(linked.status, 200);
    assert.equal(linked.data.cap_usd, 5);
    assert.equal((await srv.call('/api/me/openrouter', { cap: 3 }, 'PATCH')).data.cap_usd, 3);
    assert.ok(!JSON.stringify((await srv.call('/api/me/openrouter')).data).includes(KEY.slice(-12)), 'the key never comes back out');

    const names = async (media: boolean) => (await mcp(media, 'tools/list')).tools.map((t: any) => t.name);
    assert.deepEqual((await names(true)).filter((n: string) => /^(generate_image|edit_image|generate_audio|generate_speech)$/.test(n)), ['generate_image', 'edit_image', 'generate_audio', 'generate_speech']);
    // Listed whatever the turn's person has, so one scheme's minions share a tool list (#878); the call refuses instead.
    assert.deepEqual(await names(false), await names(true));
    const unlinked = await mcp(false, 'tools/call', { name: 'generate_image', arguments: { prompt: 'a cat', out: 'art/cat.png' } });
    assert.ok(unlinked.isError);
    assert.match(unlinked.content[0].text, /hasn't connected OpenRouter/);
    const made = await mcp(true, 'tools/call', { name: 'generate_image', arguments: { prompt: 'a cat', out: 'art/cat.png', resolution: '1K' } });
    assert.match(made.content[0].text, /^Wrote .*art\/cat\.png with black-forest-labs\/flux-3-image-klein for \$0\.0091; \$2\.99 left this month\.$/);
    assert.deepEqual(readFileSync(join(wt, 'art', 'cat.png')), PNG);
    assert.equal((await srv.call(`/api/tickets/${minion.id}/openrouter`, { tool: 'generate_image', args: { prompt: 'x', out: 'y.png' } })).status, 403, 'a person can\'t call it as the minion');

    await srv.call('/api/me/openrouter', undefined, 'DELETE');
    const gone = await mcp(true, 'tools/call', { name: 'generate_image', arguments: { prompt: 'a dog', out: 'dog.png' } });
    assert.ok(gone.isError);
    assert.match(gone.content[0].text, /OpenRouter/);
  } finally {
    await srv.stop();
  }
});

// A transparent background (#732): native where every endpoint lists it, else a matte over black.
const SEEDREAM = [{ ...KLEIN[0], supported_parameters: { ...KLEIN[0].supported_parameters, background: { type: 'enum', values: ['transparent', 'opaque'] } } }];
const realPng = () => encodePng(2, 1, Buffer.from([0, 0, 0, 255, 128, 0, 0, 255]));
const imageAnswer = (bytes: Buffer) => () => Response.json({ id: 'gen-1', data: [{ b64_json: bytes.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.0091 } });

test('transparent on a model without it: black is asked for and taken out on the server; the note says so', async () => {
  const { or, fake, cwd, ctx } = await setup({ answer: { '/images': imageAnswer(realPng()) } });
  const r = await or.tool('generate_image', { prompt: 'a frost glow', out: 'glow.png', background: 'transparent' }, ctx);
  const sent = fake.calls.find((c) => c.url === '/images')!.body;
  assert.match(sent.prompt, /^a frost glow\n\n.*black/s);
  assert.equal(sent.background, undefined);
  assert.deepEqual([...decodePng(readFileSync(join(cwd, 'glow.png')))!.rgba], [0, 0, 0, 0, 255, 0, 0, 128]);
  assert.equal(JSON.parse(readFileSync(join(cwd, 'glow.png.json'), 'utf8')).background, 'transparent (matte)');
  assert.equal(r.warnings, undefined);
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'x.webp', background: 'transparent' }, ctx), (e: HttpError) => e.status === 400 && /\.png/.test(e.message));
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'x.png', background: 'white' }, ctx), /"transparent" or left out/);
  assert.equal(fake.calls.filter((c) => c.url === '/images').length, 1);
});

test('transparent on a model without it whose answer the matte cannot read keeps the image and warns', async () => {
  const { or, cwd, ctx } = await setup();
  const r = await or.tool('generate_image', { prompt: 'x', out: 'x.png', background: 'transparent' }, ctx);
  assert.deepEqual(readFileSync(join(cwd, 'x.png')), PNG);
  assert.match(r.warnings![0], /keeps its black background/);
  assert.equal(JSON.parse(readFileSync(join(cwd, 'x.png.json'), 'utf8')).background, 'black (the matte could not read it)');
});

test('transparent on a model with it is passed through, untouched', async () => {
  const { or, fake, cwd, ctx } = await setup({ answer: { '/images/models/bytedance-seed/seedream-5-0-flash/endpoints': () => Response.json({ endpoints: SEEDREAM }) } });
  await or.tool('generate_image', { prompt: 'an ice shard icon', out: 'ice.png', model: 'bytedance-seed/seedream-5-0-flash', background: 'transparent' }, ctx);
  const sent = fake.calls.find((c) => c.url === '/images')!.body;
  assert.equal(sent.prompt, 'an ice shard icon');
  assert.equal(sent.background, 'transparent');
  assert.deepEqual(readFileSync(join(cwd, 'ice.png')), PNG);
  assert.equal(JSON.parse(readFileSync(join(cwd, 'ice.png.json'), 'utf8')).background, 'transparent (native)');
});

test('a music seed goes to a model that lists one; an effect model or a bad seed is refused before anything is spent', async () => {
  const { or, fake, cwd, ctx } = await setup();
  await or.tool('generate_audio', { kind: 'music', prompt: 'calm', out: 'calm.mp3', seed: 42 }, ctx);
  assert.equal(fake.calls.find((c) => c.url === '/chat/completions')!.body.seed, 42);
  assert.equal(JSON.parse(readFileSync(join(cwd, 'calm.mp3.json'), 'utf8')).seed, 42);
  await assert.rejects(or.tool('generate_audio', { kind: 'effect', prompt: 'x', out: 'x.mp3', seed: 1 }, ctx), /takes no seed/);
  await assert.rejects(or.tool('generate_audio', { kind: 'music', prompt: 'x', out: 'y.mp3', seed: -1 }, ctx), /whole number/);
  await assert.rejects(or.tool('generate_audio', { kind: 'music', prompt: 'x', out: 'z.mp3', seed: 1.5 }, ctx), /whole number/);
  assert.ok(!fake.calls.some((c) => c.url === '/audio/speech'));
  assert.equal(fake.calls.filter((c) => c.url === '/chat/completions').length, 1);
});

test('refusals carry a stable code for apps; a call with no minion or scheme is still booked', async () => {
  const code = (p: Promise<unknown>) => p.then(() => 'ok', mediaCode);
  const fake = fakeOpenRouter();
  const loose = new OpenRouter(store, creds, fake.fetch, 'https://or.test/api/v1');
  store.deleteCredential(josh.id, 'openrouter');
  assert.equal(await code(loose.tool('generate_image', { prompt: 'x', out: 'x.png' }, { userId: josh.id, ticketId: null, projectId: null, roots: [root] })), 'openrouter_not_connected');

  let { or, ctx } = await setup({ cap: 0.01 });
  assert.equal(await code(or.tool('generate_image', { prompt: 'x', out: 'x.png', resolution: '4K' }, ctx)), 'over_cap');
  ({ or, ctx } = await setup({ cap: 100 }));
  assert.equal(await code(or.tool('generate_image', { prompt: 'x', out: 'x.png', model: 'openai/gpt-image-2', n: 4 }, ctx)), 'over_call_limit');
  assert.equal(await code(or.tool('generate_image', { prompt: 'x', out: '../x.png' }, ctx)), 'bad_request');
  ({ or, ctx } = await setup({ answer: { '/images': () => Response.json({ error: { message: 'Insufficient credits' } }, { status: 402 }) } }));
  assert.equal(await code(or.tool('generate_image', { prompt: 'x', out: 'x.png' }, ctx)), 'openrouter_refused');
  ({ or, ctx } = await setup({ answer: { '/images': () => Promise.reject(new TypeError('fetch failed')) } }));
  assert.equal(await code(or.tool('generate_image', { prompt: 'x', out: 'x.png' }, ctx)), 'failed');
  ({ or, ctx } = await setup({ answer: { '/images': () => Response.json({ error: { message: 'User not found' } }, { status: 401 }) } }));
  assert.equal(await code(or.tool('generate_image', { prompt: 'x', out: 'x.png' }, ctx)), 'openrouter_key_refused');

  ({ or, ctx } = await setup());
  await or.tool('generate_image', { prompt: 'x', out: 'x.png' }, { ...ctx, ticketId: null, projectId: null });
  assert.deepEqual(rows().map((r) => [r.ticket_id, r.project_id, r.status]), [[null, null, 'ok']]);
});

// generate_speech (#808): text read aloud, for TWIReader's voice bake-off and its server.
const PHONEMES = 'Then  <|phoneme_start|>klˈɛbkɪtʃ<|phoneme_end|> said: <speak><phoneme alphabet="ipa" ph="ˈɹɛ.lən">Relc</phoneme> &amp; "quotes"</speak>\t— 日本 🐉\n';

test('speech input reaches OpenRouter byte for byte: phoneme tags, SSML, IPA and whitespace untouched', async () => {
  const { or, fake, ctx } = await setup({ answer: {
    '/audio/speech': () => new Response(MP3, { headers: { 'content-type': 'audio/mpeg', 'x-generation-id': 'gen-s' } }),
    '/generation?id=gen-s': () => Response.json({ data: { total_cost: 0.0012 } }),
  } });
  const r = await or.tool('generate_speech', { model: 'fish-audio/drama-3', input: PHONEMES, voice: 'narrator-1', instructions: 'calm, low', speed: 0.9, out: 'voice/klebkitch.mp3' }, ctx);
  const sent = fake.calls.find((c) => c.url === '/audio/speech')!;
  assert.equal(sent.body.input, PHONEMES);
  assert.ok(sent.raw!.includes('<|phoneme_start|>klˈɛbkɪtʃ<|phoneme_end|>'), 'sent as UTF-8, not escaped');
  assert.ok(sent.raw!.includes('<phoneme alphabet=\\"ipa\\" ph=\\"ˈɹɛ.lən\\">Relc</phoneme> &amp;'));
  assert.deepEqual({ ...sent.body, input: undefined }, { model: 'fish-audio/drama-3', input: undefined, voice: 'narrator-1', response_format: 'mp3', instructions: 'calm, low', speed: 0.9 });
  assert.deepEqual(readFileSync(r.paths[0]), MP3);
  const note = JSON.parse(readFileSync(`${r.paths[0]}.json`, 'utf8'));
  assert.equal(note.input, PHONEMES);
  assert.equal(note.tool, 'generate_speech');
  assert.equal(r.cost_usd, 0.0012);
  // Booked at its worst case first: Fish's $10/M per UTF-8 byte, never fewer than the characters.
  assert.deepEqual(rows().map((x) => [x.kind, x.model, x.status, x.cost_usd]), [['speech', 'fish-audio/drama-3', 'ok', 0.0012]]);
  assert.ok(Math.abs(rows()[0].estimate_usd - Buffer.byteLength(PHONEMES + 'calm, low') * 1e-5) < 1e-12);
});

test('a speech price with no unit is bounded per UTF-8 byte; output per token up to the cap, per second up to 120 s, else refused', () => {
  const bytes = Buffer.byteLength(PHONEMES);
  assert.ok(bytes > [...PHONEMES].length);
  const model = (id: string) => MODEL_LIST.find((m) => m.id === id)!;
  assert.ok(Math.abs(speechEstimate(model('fish-audio/drama-3'), bytes)! - bytes * 1e-5) < 1e-12);
  assert.ok(Math.abs(speechEstimate(model('google/gemini-3.8-flash-tts'), bytes)! - (bytes * 5e-7 + 16384 * 9e-6)) < 1e-12);
  assert.ok(Math.abs(speechEstimate(model('bytedance-seed/seed-audio-1-0'), bytes)! - 0.3) < 1e-12);
  assert.equal(speechEstimate(model('google/some-tts'), bytes), null, 'an output price with no token cap and no known per-second rate');
  assert.equal(speechEstimate(model('nobody/unpriced'), bytes), 0);
  assert.equal(speechEstimate(model('fish-audio/s2.1-pro-free:free'), bytes), 0);
  assert.equal(speechEstimate({ id: 'x/no-output-price', pricing: { prompt: '0.00001' } }, bytes), null, 'a missing price is unreadable, not free');
  assert.equal(speechEstimate({ id: 'x/variable', pricing: { prompt: '-1', completion: '0' } }, bytes), null);
});

test('a speech model\'s input limit comes from what OpenRouter documents, else the longest any model takes', () => {
  const model = (id: string) => MODEL_LIST.find((m) => m.id === id)!;
  assert.equal(speechLimit(model('elevenlabs/eleven-v3')), 5000);
  assert.equal(speechLimit({ id: 'x/y', description: 'and has a 40,000-character request limit.' }), 40000);
  assert.equal(speechLimit(model('bytedance-seed/seed-audio-1-0')), 3000);
  assert.equal(speechLimit(model('fish-audio/drama-3')), 40000);
});

test('generate_speech refuses over the model\'s limit, over $0.50 and unpriced models before anything is sent', async () => {
  const { or, fake, ctx } = await setup();
  const said = (n: number) => 'a'.repeat(n);
  await assert.rejects(or.tool('generate_speech', { model: 'bytedance-seed/seed-audio-1-0', input: said(3001), out: 'a.mp3' }, ctx),
    (e: HttpError) => e.status === 400 && /3,001 characters/.test(e.message) && /3,000/.test(e.message) && /split/.test(e.message));
  await assert.rejects(or.tool('generate_speech', { model: 'elevenlabs/eleven-v3', input: '🐉'.repeat(5001), out: 'a.mp3' }, ctx), /5,000/);
  await assert.rejects(or.tool('generate_speech', { model: 'minimax/speech-2.8-hd', input: said(6000), out: 'a.mp3' }, ctx), (e: HttpError) => mediaCode(e) === 'over_call_limit');
  await assert.rejects(or.tool('generate_speech', { model: 'google/some-tts', input: 'hi', out: 'a.mp3' }, ctx), /no price/);
  assert.ok(!fake.calls.some((c) => c.url === '/audio/speech'));
  assert.deepEqual(rows(), []);
  // Seed takes 3,000 exactly, booked at its 120-second ceiling.
  await or.tool('generate_speech', { model: 'bytedance-seed/seed-audio-1-0', input: said(3000), out: 'b.mp3' }, ctx);
  assert.ok(Math.abs(rows()[0].estimate_usd - 0.3) < 1e-12);
});

test('generate_speech checks its arguments: model and input required, the format matches out', async () => {
  const { or, fake, ctx } = await setup();
  const go = (args: object) => or.tool('generate_speech', { model: 'fish-audio/drama-3', input: 'hello', out: 'a.mp3', ...args }, ctx);
  await assert.rejects(go({ model: undefined }), /model is required/);
  await assert.rejects(go({ input: '   ' }), /input is required/);
  await assert.rejects(go({ input: 7 }), /input is required/);
  await assert.rejects(go({ out: 'a.ogg' }), /out ends in/);
  await assert.rejects(go({ response_format: 'flac' }), /mp3, wav or pcm/);
  await assert.rejects(go({ response_format: 'wav' }), /\.wav/);
  await assert.rejects(go({ speed: 9 }), /speed/);
  await assert.rejects(go({ voice: 3 }), /voice/);
  assert.ok(!fake.calls.some((c) => c.url === '/audio/speech'));
  const r = await go({ out: 'raw/a.pcm' });
  assert.equal(fake.calls.find((c) => c.url === '/audio/speech')!.body.response_format, 'pcm');
  assert.ok(!('voice' in fake.calls.find((c) => c.url === '/audio/speech')!.body), 'no voice sent when none was asked: the provider\'s default');
  assert.match(r.paths[0], /raw\/a\.pcm$/);
});
