// The shared emulator's synthetic microphone (#843), run by tools/citadel-android (beside it in a turn's pin/bin):
//   tone <hz> <seconds> <out.wav> [rate]   write a sine tone, 16-bit mono PCM (rate 48000 by default)
//   play <file.wav> [seconds]              once an app records, feed the WAV into the emulator's mic, looped to fill <seconds>
//   check [hz]                             smoke check: a page on the emulator records the mic while a tone plays
// The emulator takes the audio over its gRPC port (`-grpc`, only injectAudio open: serve's allow list), which the
// desktop's tunnel puts on perigee's loopback like the console. Synthetic audio only: never a real voice.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:http2';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const GRPC_PORT = Number(process.env.CITADEL_ANDROID_GRPC || 18591);
const MAX_RATE = 48000; // the emulator refuses more (INVALID_ARGUMENT)
const adbRun = (...a: string[]) => spawnSync(join(process.env.ANDROID_HOME || join(process.env.HOME!, '.local/share/android-sdk'), 'platform-tools', 'adb'), ['-s', `emulator-${process.env.CITADEL_ANDROID_PORT || 5554}`, ...a], { encoding: 'utf8', timeout: 15000 });

/** Whether an app on the emulator has the mic open, from `dumpsys audio`'s RecordActivityMonitor section. */
const adb = (...a: string[]) => {
  const r = adbRun(...a);
  if (r.error || r.status !== 0) throw new Error(`adb couldn't reach the phone (${(r.error?.message || r.stderr || `exit ${r.status}`).trim()}): is it up?`);
  return r.stdout;
};

export const recording = (dumpsys: string) => /^RecordActivityMonitor[^\n]*\n(?:(?!Events log)[^\n]*\n)*?riid \d+; active\? true/m.test(dumpsys);

export type Pcm = { rate: number; channels: 1 | 2; data: Buffer };

/** A sine tone as a 16-bit mono WAV file, at half of full scale. */
export function toneWav(hz: number, seconds: number, rate = MAX_RATE): Buffer {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(16383 * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** The PCM in a WAV the emulator can take: 16-bit PCM, mono or stereo, at most 48 kHz. Throws a message that says what to change. */
export function parseWav(buf: Buffer): Pcm {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file (no RIFF/WAVE header)');
  let fmt: Buffer | undefined, data: Buffer | undefined;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString('latin1', at, at + 4),
      size = buf.readUInt32LE(at + 4);
    const body = buf.subarray(at + 8, Math.min(buf.length, at + 8 + size));
    if (id === 'fmt ') fmt = body;
    else if (id === 'data') data = body;
    at += 8 + size + (size & 1);
  }
  if (!fmt || fmt.length < 16 || !data) throw new Error('the WAV has no fmt or data chunk');
  const format = fmt.readUInt16LE(0),
    channels = fmt.readUInt16LE(2),
    rate = fmt.readUInt32LE(4),
    bits = fmt.readUInt16LE(14);
  // 0xFFFE (extensible) is still PCM when its sub-format says so; its first two bytes hold the plain format code.
  const pcm = format === 1 || (format === 0xfffe && fmt.length >= 26 && fmt.readUInt16LE(24) === 1);
  if (!pcm || bits !== 16) throw new Error(`the WAV must be 16-bit PCM (it is format ${format}, ${bits}-bit): ffmpeg -i in.wav -c:a pcm_s16le out.wav`);
  if (channels !== 1 && channels !== 2) throw new Error(`the WAV must be mono or stereo (it has ${channels} channels)`);
  if (rate < 8000 || rate > MAX_RATE) throw new Error(`the emulator takes 8000 to ${MAX_RATE} Hz (the WAV is ${rate} Hz)`);
  const whole = data.length - (data.length % (2 * channels));
  if (!whole) throw new Error('the WAV has no audio');
  return { rate, channels, data: data.subarray(0, whole) };
}

const varint = (n: number) => {
  const b: number[] = [];
  for (; n > 127; n = Math.floor(n / 128)) b.push((n % 128) | 128);
  b.push(n);
  return Buffer.from(b);
};
const field = (tag: number, body: Buffer) => Buffer.concat([varint(tag), varint(body.length), body]);

/** One gRPC message of android.emulation.control.AudioPacket: the format (S16, MODE_UNSPECIFIED) on the first one only. */
export function audioFrame(chunk: Buffer, pcm: Pick<Pcm, 'rate' | 'channels'> | null): Buffer {
  const parts: Buffer[] = [];
  // AudioFormat: samplingRate = 1, channels = 2 (Mono 0, Stereo 1), format = 3 (AUD_FMT_S16 1).
  if (pcm) parts.push(field(0x0a, Buffer.concat([varint(0x08), varint(pcm.rate), varint(0x10), varint(pcm.channels - 1), varint(0x18), varint(1)])));
  parts.push(field(0x1a, chunk)); // audio = 3
  const msg = Buffer.concat(parts),
    head = Buffer.alloc(5);
  head.writeUInt32BE(msg.length, 1);
  return Buffer.concat([head, msg]);
}

/**
 * Streams the PCM into the emulator's mic, looped until `seconds` (once through when 0), and resolves when the
 * emulator has taken it. The emulator pulls the audio at its own pace, so HTTP/2 flow control paces the writes.
 */
export function inject(pcm: Pcm, seconds = 0, port = GRPC_PORT, stop?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(`http://127.0.0.1:${port}`);
    const done = (err?: Error) => {
      client.close();
      err ? reject(err) : resolve();
    };
    let connected = false;
    const unreachable = (e: Error) => new Error(`no emulator microphone on 127.0.0.1:${port} (${e.message}): is the emulator up, and has its desktop been set up again since #843?`);
    client.on('connect', () => (connected = true));
    client.on('error', (e) => done(unreachable(e)));
    const req = client.request({ ':method': 'POST', ':path': '/android.emulation.control.EmulatorController/injectAudio', 'content-type': 'application/grpc', te: 'trailers' });
    let status = '',
      message = '';
    req.on('response', (h) => {
      status = String(h['grpc-status'] ?? status);
      message = String(h['grpc-message'] ?? message);
    });
    req.on('trailers', (h) => {
      status = String(h['grpc-status'] ?? status);
      message = decodeURIComponent(String(h['grpc-message'] ?? message));
    });
    req.on('error', (e) => done(connected ? e : unreachable((e.cause as Error) ?? e)));
    stop?.addEventListener('abort', () => req.close());
    req.on('close', () => done(status === '0' || stop?.aborted ? undefined : new Error(`the emulator refused the audio: grpc-status ${status || 'none'} ${message}`.trim())));
    req.resume();
    const step = Math.round(pcm.rate / 20) * 2 * pcm.channels; // 50 ms, well under the emulator's ~300 ms buffer
    const total = seconds > 0 ? Math.round(seconds * pcm.rate) * 2 * pcm.channels : pcm.data.length;
    (async () => {
      for (let sent = 0; sent < total && !stop?.aborted; ) {
        const at = sent % pcm.data.length,
          n = Math.min(step, pcm.data.length - at, total - sent);
        if (!req.write(audioFrame(pcm.data.subarray(at, at + n), sent === 0 ? pcm : null))) await new Promise((r) => req.once('drain', r));
        sent += n;
      }
      req.end();
    })().catch(done);
  });
}

/**
 * Waits up to `wait` seconds for an app to open the mic, then injects. The emulator (37.2) crashes if audio arrives
 * while nothing records, so this never injects before. Gives up `seconds` (or the WAV's length) plus 10 s after it
 * starts, since the emulator stops pulling audio, and the stream stalls, once the app stops recording.
 */
export async function play(pcm: Pcm, seconds = 0, wait = 120, cancel?: AbortSignal, port = GRPC_PORT): Promise<void> {
  const t0 = Date.now();
  while (!recording(adb('shell', 'dumpsys', 'audio'))) {
    if (cancel?.aborted) return;
    if (Date.now() - t0 > wait * 1000) throw new Error(`nothing on the emulator opened the mic in ${wait} s; start recording in the app, then run it again (or start mic first and record within ${wait} s)`);
    await sleep(500);
  }
  if (cancel?.aborted) return;
  const stop = new AbortController();
  cancel?.addEventListener('abort', () => stop.abort());
  let cut = false;
  const limit = setTimeout(
    () => {
      cut = true;
      stop.abort();
    },
    ((seconds || pcm.data.length / (2 * pcm.channels * pcm.rate)) + 10) * 1000,
  );
  try {
    await inject(pcm, seconds, port, stop.signal);
  } finally {
    clearTimeout(limit);
  }
  if (cut) throw new Error('the phone stopped taking the audio before the end: did the app stop recording?');
}

/** The strongest frequency between 50 Hz and 8 kHz, in 5 Hz steps (Goertzel), and the level in dBFS. */
export function peak(samples: Float32Array, rate: number): { hz: number; dbfs: number } {
  let best = 0,
    bestHz = 0,
    sq = 0;
  for (const s of samples) sq += s * s;
  for (let hz = 50; hz <= Math.min(8000, rate / 2 - 50); hz += 5) {
    const c = 2 * Math.cos((2 * Math.PI * hz) / rate);
    let s1 = 0,
      s2 = 0;
    for (const x of samples) {
      const s0 = x + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const p = s1 * s1 + s2 * s2 - c * s1 * s2;
    if (p > best) {
      best = p;
      bestHz = hz;
    }
  }
  return { hz: bestHz, dbfs: 10 * Math.log10(sq / samples.length || 1e-12) };
}

// The page the check opens: it asks for the mic with the browser's voice processing off, records 1.5 s through an
// AudioWorklet from a quarter second after the first sound (silence if none comes in 20 s), and posts what it got. localhost (through adb reverse) is a secure context.
const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>mic check</title><body style="font:20px sans-serif;padding:24px">
<p id=s>asking for the microphone…</p><script type=module>
const say = (t) => (document.getElementById('s').textContent = t);
const post = (o) => fetch('/result', { method: 'POST', body: JSON.stringify(o) });
try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/worklet.js');
  const node = new AudioWorkletNode(ctx, 'grab', { processorOptions: { settle: ctx.sampleRate / 4, giveUp: ctx.sampleRate * 20, keep: ctx.sampleRate * 1.5 } });
  ctx.createMediaStreamSource(stream).connect(node);
  // Chrome holds an AudioContext made without a tap; citadel-android up lifts that rule, an older Chrome flags file may not.
  if (ctx.state !== 'running') await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 3000))]);
  if (ctx.state !== 'running') throw new Error('the AudioContext stayed ' + ctx.state + ' (Chrome wants a tap first): run citadel-android down, then up');
  await fetch('/started', { method: 'POST' });
  say('recording…');
  const samples = await new Promise((r) => (node.port.onmessage = (e) => r(e.data)));
  const settings = stream.getAudioTracks()[0].getSettings();
  stream.getTracks().forEach((t) => t.stop());
  const bytes = new Uint8Array(samples.buffer);
  let bin = ''; for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
  await post({ sampleRate: ctx.sampleRate, settings, samples: btoa(bin) });
  say('done');
} catch (e) { say(String(e)); post({ error: String(e) }); }
</script>`;
export const WORKLET = `registerProcessor('grab', class extends AudioWorkletProcessor {
  constructor(o) { super(); Object.assign(this, o.processorOptions); this.buf = new Float32Array(this.keep); this.at = 0; this.skip = -1; }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch || this.at >= this.buf.length) return true;
    // The tone starts a moment after the page opens the mic (later on a busy box): wait for it, then let it settle.
    if (this.skip < 0) { this.giveUp -= ch.length; if (ch.some((x) => Math.abs(x) > 0.01)) this.skip = this.settle; else if (this.giveUp > 0) return true; else this.skip = 0; }
    if (this.skip > 0) { this.skip = Math.max(0, this.skip - ch.length); return true; }
    const n = Math.min(ch.length, this.buf.length - this.at);
    this.buf.set(ch.subarray(0, n), this.at); this.at += n;
    if (this.at >= this.buf.length) this.port.postMessage(this.buf);
    return true;
  }
});`;

type Result = { error?: string; sampleRate?: number; settings?: Record<string, unknown>; samples?: string };

/** The smoke check: plays a tone into the mic, has Chrome on the emulator record it, and says whether it heard it. */
async function check(hz: number): Promise<number> {
  const me = join(import.meta.dirname, 'citadel-android');
  const step = (...a: string[]) => spawnSync(me, a, { stdio: ['ignore', 'inherit', 'inherit'] }).status === 0;
  if (!step('up')) return 1;
  let got: (r: Result) => void = () => {},
    started = () => {};
  const opened = new Promise<void>((r) => (started = r));
  const result = new Promise<Result>((r) => (got = r));
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/started') {
      started();
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && req.url === '/result') {
      const parts: Buffer[] = [];
      req
        .on('data', (c) => parts.push(c))
        .on('end', () => {
          res.end('ok');
          try {
            got(JSON.parse(Buffer.concat(parts).toString()));
          } catch {
            got({ error: 'the page sent something that is not JSON' });
          }
        });
      return;
    }
    res.setHeader('content-type', req.url === '/worklet.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/worklet.js' ? WORKLET : PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const stop = new AbortController();
  let playing: Promise<unknown> = Promise.resolve();
  try {
    adbRun('reverse', `tcp:${port}`, `tcp:${port}`);
    // Chrome needs the Android mic permission, and a fresh start so it reads `up`'s flags (no permission prompt).
    adbRun('shell', 'pm grant com.android.chrome android.permission.RECORD_AUDIO; am force-stop com.android.chrome');
    if (!step('open', `http://localhost:${port}/?t=${Date.now()}`)) return 1;
    // The tone starts once the page has the mic open: the emulator has no input stream to feed before that.
    // A minute at most; it stops as soon as the page has its recording.
    opened.then(() => (playing = play(parseWav(toneWav(hz, 1)), 60, 10, stop.signal).catch((e: Error) => got({ error: e.message }))));
    const r = await Promise.race([result, new Promise<Result>((ok) => setTimeout(() => ok({ error: 'the page sent nothing in 45 s (citadel-android shot to see why)' }), 45000))]);
    if (r.error || !r.samples || !r.sampleRate) {
      console.error(`mic check: FAIL: ${r.error || 'no recording'}`);
      return 1;
    }
    const b = Buffer.from(r.samples, 'base64');
    const { hz: heard, dbfs } = peak(new Float32Array(b.buffer, b.byteOffset, b.length / 4), r.sampleRate);
    const ok = Math.abs(heard - hz) <= Math.max(10, hz * 0.02) && dbfs > -50;
    console.log(`mic check: ${ok ? 'PASS' : 'FAIL'}: played ${hz} Hz, heard ${heard} Hz at ${dbfs.toFixed(1)} dBFS; AudioContext ${r.sampleRate} Hz; track ${JSON.stringify(r.settings)}`);
    // Seen on a busy host (load 40+): the emulator's sound card falls behind and Android records the silence it fills in.
    if (dbfs < -100) console.log("mic check: only silence came through. If `adb logcat -d | grep 'inserting.*silence'` shows lines, the emulator's computer was too busy to keep up its sound card; try again when it is quieter.");
    return ok ? 0 : 1;
  } finally {
    stop.abort();
    await playing;
    adbRun('reverse', '--remove', `tcp:${port}`);
    server.close();
  }
}

if (import.meta.main) {
  const [cmd, ...a] = process.argv.slice(2);
  const fail = (m: string, code = 1) => {
    console.error(`citadel-android: ${m}`);
    process.exit(code);
  };
  try {
    if (cmd === 'tone' && a.length >= 3) {
      const [hz, s, out, rate] = [Number(a[0]), Number(a[1]), a[2], Number(a[3] || MAX_RATE)];
      if (!(hz > 0 && hz < rate / 2 && s > 0 && s <= 600 && rate >= 8000 && rate <= MAX_RATE)) fail('tone <hz below half the rate> <seconds up to 600> <out.wav> [rate 8000-48000]', 2);
      writeFileSync(out, toneWav(hz, s, rate));
    } else if (cmd === 'play' && a.length >= 1) {
      const s = Number(a[1] || 0);
      if (!(s >= 0 && s <= 600)) fail('mic <file.wav> [seconds up to 600]', 2);
      await play(parseWav(readFileSync(a[0])), s);
    } else if (cmd === 'check') {
      const hz = Number(a[0] || 1000);
      if (!(hz >= 50 && hz <= 8000)) fail('mic-check [hz from 50 to 8000]', 2);
      process.exit(await check(hz));
    } else fail('usage: citadel-android tone <hz> <seconds> <out.wav> [rate] | mic <file.wav> [seconds] | mic-check [hz]', 2);
  } catch (e) {
    fail((e as Error).message);
  }
}
