import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { azureCost, azureSpeech, billedChars, buildSsml, formatExt, type AzureDeps } from '../src/azure-speech.ts';
import type { SpendInput } from '../src/outside-spend.ts';

// generate_speech with provider azure (#842), against a mocked Azure.
const root = mkdtempSync(join(tmpdir(), 'azure-speech-'));
after(() => rmSync(root, { recursive: true, force: true }));
const KEY = 'sekrit-key-123';

function setup(status = 200) {
  const calls: { url: string; init: { body: string; method: string; headers: Record<string, string> } }[] = [];
  const booked: SpendInput[] = [];
  const deps: AzureDeps = {
    secret: (n) => ({ AZURE_SPEECH_KEY: KEY, AZURE_SPEECH_REGION: 'westus2' })[n] ?? null,
    book: (s) => {
      booked.push(s);
      return { month_usd: 1, cap_usd: null, over_cap: false };
    },
    fetch: (async (url: string | URL | Request, init: RequestInit) => {
      calls.push({ url: String(url), init: init as (typeof calls)[number]['init'] });
      return new Response(status === 200 ? Buffer.from('MP3DATA') : 'nope ' + KEY, { status });
    }) as typeof fetch,
  };
  return { calls, booked, deps };
}
const SSML = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="en-US-Ava:DragonHDLatestNeural">Hi <phoneme alphabet="ipa" ph="kləbkɪtʃ">Klebkitsch</phoneme><break time="200ms"/></voice><voice name="en-US-AndrewNeural"><prosody rate="slow">Bye</prosody></voice></speak>';

test('a whole SSML document goes to the regional endpoint untouched, with the key and the chosen format', async () => {
  const { calls, booked, deps } = setup();
  const r = await azureSpeech({ input: SSML, out: 'a.mp3' }, { roots: [root] }, deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://westus2.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(calls[0].init.body, SSML);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Ocp-Apim-Subscription-Key'], KEY);
  assert.equal(calls[0].init.headers['content-type'], 'application/ssml+xml');
  assert.equal(calls[0].init.headers['X-Microsoft-OutputFormat'], 'audio-24khz-48kbitrate-mono-mp3');
  assert.equal(readFileSync(join(root, 'a.mp3'), 'utf8'), 'MP3DATA');
  assert.equal(booked.length, 1);
  assert.equal(booked[0].service, 'azure-speech');
  assert.equal(booked[0].units, billedChars(SSML));
  assert.ok(Math.abs(booked[0].usd - (billedChars(SSML) * 30) / 1e6) < 1e-12, 'one HD voice prices the call at the HD rate');
  assert.equal(r.cost_usd, booked[0].usd);
  assert.ok(!readFileSync(join(root, 'a.mp3.json'), 'utf8').includes(KEY), 'the key is never written');
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('a fragment is wrapped, in a voice when one is given; another output format picks the extension', async () => {
  assert.match(buildSsml('Hi', 'en-US-Ava:DragonHDLatestNeural', 'en-US'), /^<speak [^>]*xml:lang="en-US"><voice name="en-US-Ava:DragonHDLatestNeural">Hi<\/voice><\/speak>$/);
  assert.match(buildSsml('<voice name="x">Hi</voice>', undefined, 'en-GB'), /xml:lang="en-GB"><voice name="x">Hi<\/voice><\/speak>$/);
  assert.equal(formatExt('riff-24khz-16bit-mono-pcm'), '.wav');
  assert.equal(formatExt('ogg-24khz-16bit-mono-opus'), '.ogg');
  const { calls, deps } = setup();
  await azureSpeech({ input: 'Hi', voice: 'en-US-AvaNeural', output_format: 'riff-24khz-16bit-mono-pcm', out: 'b.wav' }, { roots: [root] }, deps);
  assert.equal(calls[0].init.headers['X-Microsoft-OutputFormat'], 'riff-24khz-16bit-mono-pcm');
  await assert.rejects(azureSpeech({ input: 'Hi', out: 'c.wav' }, { roots: [root] }, deps), /must end in|ends in \.mp3/);
});

test('cost counts text only, neural vs HD', () => {
  assert.equal(billedChars('<speak><voice name="v">Hello you</voice></speak>'), 'Hello you'.length);
  assert.equal(billedChars('<speak><voice name="v">Hi<break time="1s"/></voice></speak>'), 'Hi<break time="1s"/>'.length, 'other markup is billed');
  assert.equal(billedChars('<voice name="v">你好a</voice>'), 5, 'a CJK character counts twice');
  assert.equal(azureCost('<voice name="en-US-AvaNeural">x</voice>', 1_000_000), 15);
  assert.equal(azureCost('<voice name="en-US-Ava:DragonHDLatestNeural">x</voice>', 1_000_000), 30);
});

test('no key: refused before any call; a refusal from Azure never echoes the key and books nothing', async () => {
  const s = setup();
  s.deps.secret = () => null;
  await assert.rejects(azureSpeech({ input: 'Hi', out: 'd.mp3' }, { roots: [root] }, s.deps), /no Azure Speech key.*AZURE_SPEECH_KEY/);
  assert.equal(s.calls.length, 0);
  const f = setup(401);
  await assert.rejects(azureSpeech({ input: 'Hi', out: 'e.mp3' }, { roots: [root] }, f.deps), (e: Error) => !e.message.includes(KEY) && /401/.test(e.message));
  assert.equal(f.booked.length, 0);
  assert.ok(!existsSync(join(root, 'e.mp3')));
});
