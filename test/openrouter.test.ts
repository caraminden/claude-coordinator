import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Credentials } from '../src/credentials.ts';
import { Store } from '../src/db.ts';
import { HttpError } from '../src/http.ts';
import { imageEstimate, monthStart, mp3Seconds, OpenRouter, perRequestPrice, resetsAt } from '../src/openrouter.ts';

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
  { id: 'google/lyria-3-clip-preview', pricing: { prompt: '0', completion: '0' }, description: '30 second duration clips are priced at $0.04 per clip. Lyria 3...' },
  { id: 'nobody/unpriced', pricing: { prompt: '0', completion: '0' }, description: 'No price here' },
];
// 128 kbps MPEG-1 Layer III: 16000 bytes is one second.
const MP3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(15996)]);
const PNG = Buffer.from('fake png bytes');

/** OpenRouter, faked. `hold` delays POST /images until released; `answer` overrides a path's response. */
function fakeOpenRouter(answer: Record<string, () => Response | Promise<Response>> = {}) {
  const calls: { url: string; method: string; auth: string | null; body: any }[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace('https://or.test/api/v1', '');
    calls.push({ url: path, method: init.method ?? 'GET', auth: new Headers(init.headers).get('authorization'), body: init.body ? JSON.parse(String(init.body)) : null });
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

test('outputs and inputs stay inside the minion\'s folders', async () => {
  const { or, cwd, ctx } = await setup();
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: '../escape.png' }, ctx), /inside your working directory/);
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'x.exe' }, ctx), /out ends in/);
  symlinkSync(tmpdir(), join(cwd, 'link'));
  await assert.rejects(or.tool('generate_image', { prompt: 'x', out: 'link/x.png' }, ctx), /inside your working directory/);
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
  assert.equal(perRequestPrice(MODEL_LIST[1]), 0.04);
  assert.equal(perRequestPrice({ description: 'Full songs at $0.08 per song.' }), 0.08);
  assert.equal(perRequestPrice(MODEL_LIST[2]), null);
  assert.equal(mp3Seconds(MP3), 1);
  const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 10]), Buffer.alloc(10), MP3]);
  assert.equal(mp3Seconds(id3), 1);
  assert.equal(mp3Seconds(Buffer.from('not audio')), null);
  assert.match(resetsAt(Date.UTC(2026, 10, 14)), /^Nov 30, 4 PM PST$/);
});
