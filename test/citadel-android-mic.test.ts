import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Http2ServerRequest } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { audioFrame, inject, parseWav, peak, play, recording, toneWav, WORKLET } from '../tools/citadel-android-mic.ts';

// tools/citadel-android-mic.ts (#843): the emulator's synthetic mic, without an emulator.
const root = mkdtempSync(join(tmpdir(), 'android-mic-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** A WAV header and data chunk with the given fields, for the refusals. */
function wav(o: { format?: number; channels?: number; rate?: number; bits?: number; riff?: string; extra?: Buffer; data?: Buffer }) {
  const data = o.data ?? Buffer.alloc(400);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(o.format ?? 1, 0); fmt.writeUInt16LE(o.channels ?? 1, 2); fmt.writeUInt32LE(o.rate ?? 48000, 4);
  fmt.writeUInt16LE(o.bits ?? 16, 14);
  const chunk = (id: string, body: Buffer) => { const h = Buffer.alloc(8); h.write(id, 0); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), o.extra ?? Buffer.alloc(0), chunk('data', data)]);
  const head = Buffer.alloc(8); head.write(o.riff ?? 'RIFF', 0); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

test('a tone round-trips through parseWav and peak hears its frequency', () => {
  const pcm = parseWav(toneWav(1000, 0.25));
  assert.deepEqual([pcm.rate, pcm.channels, pcm.data.length], [48000, 1, 0.25 * 48000 * 2]);
  const samples = Float32Array.from({ length: pcm.data.length / 2 }, (_, i) => pcm.data.readInt16LE(i * 2) / 32768);
  const { hz, dbfs } = peak(samples, 48000);
  assert.equal(hz, 1000);
  assert.ok(Math.abs(dbfs - -9) < 0.5, `half scale is about -9 dBFS RMS, got ${dbfs}`);
  assert.equal(peak(Float32Array.from({ length: 22050 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 44100)), 44100).hz, 440);
});

test('parseWav takes what the emulator can play and says what to change otherwise', () => {
  const pad = Buffer.from('LIST\x03\x00\x00\x00abc\x00', 'latin1'); // an odd-sized chunk before data, padded to even
  assert.equal(parseWav(wav({ channels: 2, rate: 8000, extra: pad })).channels, 2);
  const ext = Buffer.alloc(40);
  ext.writeUInt16LE(0xfffe, 0); ext.writeUInt16LE(1, 2); ext.writeUInt32LE(16000, 4); ext.writeUInt16LE(16, 14); ext.writeUInt16LE(1, 24);
  const extensible = Buffer.concat([wav({}).subarray(0, 12), Buffer.from('fmt '), Buffer.from([40, 0, 0, 0]), ext, wav({}).subarray(36)]);
  assert.equal(parseWav(extensible).rate, 16000);
  assert.throws(() => parseWav(wav({ riff: 'RIFX' })), /not a WAV/);
  assert.throws(() => parseWav(wav({ bits: 24 })), /16-bit PCM.*24-bit/);
  assert.throws(() => parseWav(wav({ format: 3, bits: 32 })), /16-bit PCM \(it is format 3/);
  assert.throws(() => parseWav(wav({ channels: 3 })), /mono or stereo \(it has 3/);
  assert.throws(() => parseWav(wav({ rate: 96000 })), /8000 to 48000 Hz \(the WAV is 96000/);
  assert.throws(() => parseWav(wav({ data: Buffer.alloc(1) })), /no audio/);
});

test('recording() reads whether an app has the mic open from dumpsys audio', () => {
  // Shaped like Android 16's `dumpsys audio`, recording and not.
  const active = 'Audio routes\n\nRecordActivityMonitor dump time: 8:52:53 PM\nriid 247; active? true\n  session:257 -- source client=CAMCORDER -- pack:com.android.chrome\n\n\nEvents log: recording activity received by AudioService\n';
  const stopped = 'RecordActivityMonitor dump time: 8:52:12 PM\n\n\nEvents log: recording activity received by AudioService\n11-16 20:47:58:555 rec start riid:223 uid:10160 pack:com.android.chrome\n';
  assert.equal(recording(active), true);
  assert.equal(recording(stopped), false);
  assert.equal(recording(active.replace('active? true', 'active? false')), false);
  assert.equal(recording(stopped + 'riid 1; active? true\n'), false, 'only inside the RecordActivityMonitor section');
});

/** The gRPC messages a request carried, each split into its protobuf fields (tag -> bytes). */
function messages(body: Buffer) {
  const out: Map<number, Buffer>[] = [];
  const varint = (b: Buffer, at: number) => { let n = 0, m = 1, x; do { x = b[at++]; n += (x & 127) * m; m *= 128; } while (x & 128); return [n, at]; };
  for (let at = 0; at < body.length; ) {
    assert.equal(body[at], 0, 'not compressed');
    const len = body.readUInt32BE(at + 1), msg = body.subarray(at + 5, at + 5 + len), fields = new Map<number, Buffer>();
    for (let i = 0; i < msg.length; ) {
      const [tag, a] = varint(msg, i), [n, b] = varint(msg, a);
      fields.set(tag, msg.subarray(b, b + n)); i = b + n;
    }
    out.push(fields); at += 5 + len;
  }
  return out;
}

/** A stand-in for the emulator's gRPC server, answering injectAudio with `status`. */
async function emulator(status: number) {
  const got: { path?: string; type?: string; body: Buffer } = { body: Buffer.alloc(0) };
  const server = createServer((req: Http2ServerRequest, res) => {
    got.path = req.url; got.type = String(req.headers['content-type']);
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c)).on('end', () => {
      got.body = Buffer.concat(parts);
      res.writeHead(200, { 'content-type': 'application/grpc' });
      res.addTrailers({ 'grpc-status': String(status), ...(status ? { 'grpc-message': 'Sample%20rate%20too%20high' } : {}) });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { got, port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(r)) };
}

test('inject streams AudioPackets: the format on the first only, the audio looped to fill the seconds', async () => {
  const emu = await emulator(0);
  try {
    const data = Buffer.alloc(8000 * 2 * 2 / 10); // 0.1 s of 8 kHz stereo
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    await inject({ rate: 8000, channels: 2, data }, 0.25, emu.port);
    assert.equal(emu.got.path, '/android.emulation.control.EmulatorController/injectAudio');
    assert.equal(emu.got.type, 'application/grpc');
    const msgs = messages(emu.got.body);
    // AudioFormat { samplingRate: 8000, channels: Stereo (1), format: AUD_FMT_S16 (1) }
    assert.deepEqual([...msgs[0].get(0x0a)!], [0x08, 0xc0, 0x3e, 0x10, 1, 0x18, 1]);
    assert.ok(msgs.slice(1).every((m) => !m.has(0x0a)));
    const audio = Buffer.concat(msgs.map((m) => m.get(0x1a)!));
    assert.equal(audio.length, 0.25 * 8000 * 2 * 2);
    assert.deepEqual(audio, Buffer.concat([data, data, data.subarray(0, data.length / 2)]));
    assert.ok(msgs.every((m) => m.get(0x1a)!.length <= (8000 / 20) * 2 * 2), 'no packet over 50 ms');
  } finally { await emu.close(); }
});

test('inject sends whole 16-bit samples at odd rates: every packet an even byte count', async () => {
  for (const rate of [22050, 11025]) {
    const emu = await emulator(0);
    try {
      const data = Buffer.alloc(rate * 2 / 5); // 0.2 s mono
      await inject({ rate, channels: 1, data }, 0, emu.port);
      const sizes = messages(emu.got.body).map((m) => m.get(0x1a)?.length ?? 0);
      assert.ok(sizes.every((n) => n % 2 === 0), `${rate} Hz sent odd packet sizes: ${sizes.join(',')}`);
      assert.equal(sizes.reduce((a, b) => a + b, 0), data.length);
    } finally { await emu.close(); }
  }
});

test('inject fails with the emulator\'s reason, or when nothing listens', async () => {
  const emu = await emulator(3);
  try {
    await assert.rejects(inject(parseWav(toneWav(440, 0.05)), 0, emu.port), /refused the audio: grpc-status 3 Sample rate too high/);
  } finally { await emu.close(); }
  await assert.rejects(inject(parseWav(toneWav(440, 0.05)), 0, emu.port), /no emulator microphone on 127\.0\.0\.1:\d+/);
  assert.equal(audioFrame(Buffer.alloc(4), null).readUInt32BE(1), 6, 'a frame\'s length counts the message only');
});

test('play never feeds the mic before an app records, and stops when adb fails', async () => {
  // A stub adb whose `dumpsys audio` is a file the test writes; play runs it from $ANDROID_HOME.
  const sdk = join(root, 'play-sdk'), dumpsys = join(sdk, 'dumpsys');
  mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
  writeFileSync(join(sdk, 'platform-tools', 'adb'), `#!/bin/sh\n[ -e '${sdk}/fail' ] && { echo 'device offline' >&2; exit 1; }\ncat '${dumpsys}'\n`);
  chmodSync(join(sdk, 'platform-tools', 'adb'), 0o755);
  const home = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = sdk;
  const emu = await emulator(0);
  const pcm = parseWav(toneWav(440, 0.1));
  try {
    writeFileSync(dumpsys, 'RecordActivityMonitor dump time: 9:00:00 PM\n\n\nEvents log: recording activity received by AudioService\n');
    await assert.rejects(play(pcm, 0, 1, undefined, emu.port), /nothing on the emulator opened the mic in 1 s/);
    const cancelled = new AbortController();
    cancelled.abort();
    await play(pcm, 0, 1, cancelled.signal, emu.port);
    assert.equal(emu.got.path, undefined, 'nothing reached the mic');
    writeFileSync(join(sdk, 'fail'), '');
    await assert.rejects(play(pcm, 0, 1, undefined, emu.port), /adb couldn't reach the phone \(device offline\)/);
    rmSync(join(sdk, 'fail'));
    writeFileSync(dumpsys, 'RecordActivityMonitor dump time: 9:00:00 PM\nriid 7; active? true\n  session:1 -- pack:com.android.chrome\n\nEvents log: recording activity received by AudioService\n');
    await play(pcm, 0, 1, undefined, emu.port);
    assert.equal(Buffer.concat(messages(emu.got.body).map((m) => m.get(0x1a)!)).length, pcm.data.length);
  } finally {
    await emu.close();
    if (home === undefined) delete process.env.ANDROID_HOME; else process.env.ANDROID_HOME = home;
  }
});

/** Runs the check page's AudioWorklet on 128-sample blocks, as Web Audio would, and returns what it posted. */
function worklet(blocks: Float32Array[], o: { settle: number; giveUp: number; keep: number }) {
  let Processor: any;
  new Function('registerProcessor', 'AudioWorkletProcessor', WORKLET)((_: string, c: unknown) => (Processor = c), class { port = { postMessage: (m: Float32Array) => posted.push(m) }; });
  const posted: Float32Array[] = [];
  const p = new Processor({ processorOptions: o });
  for (const b of blocks) assert.equal(p.process([[b]]), true);
  return posted;
}

test('the check page waits for the tone, lets it settle, then keeps its window; silence if it never comes', () => {
  const silence = (n: number) => Array.from({ length: n }, () => new Float32Array(128));
  const tone = (n: number) => Array.from({ length: n }, (_, k) => Float32Array.from({ length: 128 }, (_, i) => 0.5 * Math.sin((k * 128 + i) / 5)));
  const [got] = worklet([...silence(50), ...tone(20)], { settle: 256, giveUp: 48000, keep: 1024 });
  assert.equal(got.length, 1024);
  assert.ok(got.every((x) => Math.abs(x) <= 0.5) && got.some((x) => Math.abs(x) > 0.4), 'the window is all tone, after the settle');
  assert.deepEqual(worklet([...silence(10)], { settle: 256, giveUp: 48000, keep: 1024 }), [], 'nothing posted while waiting');
  // The page's own numbers: a settle of 48000 / 4 isn't a whole number of Chrome's 128-sample blocks.
  assert.equal(worklet([...silence(5), ...tone(200)], { settle: 12000, giveUp: 960000, keep: 1024 }).length, 1, 'a settle that ends mid-block still records');
  const [quiet] = worklet(silence(20), { settle: 256, giveUp: 1024, keep: 512 });
  assert.ok(quiet && quiet.every((x) => x === 0), 'posts silence once it gives up');
});

test('citadel-android tone writes a WAV, and mic refuses a missing file without touching the emulator', () => {
  const helper = join(import.meta.dirname, '..', 'tools', 'citadel-android');
  const env = { ...process.env, ANDROID_HOME: join(root, 'no-sdk'), CITADEL_ANDROID_STARTER: '1', CITADEL_HEAVY_DIR: join(root, 'locks') };
  const out = join(root, 't.wav');
  assert.equal(spawnSync(helper, ['tone', '500', '0.1', out, '16000'], { env }).status, 0);
  assert.equal(parseWav(readFileSync(out)).rate, 16000);
  assert.equal(spawnSync(helper, ['tone', '9000', '1', out, '16000'], { env }).status, 2, 'above half the rate');
  const r = spawnSync(helper, ['mic', join(root, 'missing.wav')], { env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr + r.stdout, /usage: citadel-android mic <file\.wav>/);
  assert.ok(!existsSync(join(root, 'locks')), 'took no lock');
});
