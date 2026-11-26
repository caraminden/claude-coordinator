// Media tools on contraption turns (#732, shared/project/specs/media-tools-contraptions.md): a turn that
// asks for `media: true` gets generate_image, edit_image, generate_audio and generate_speech from an MCP server Citadel
// adds, named `citadel`, which runs them through src/openrouter.ts with the turn person's own key and cap.
// Files go to a media folder per contraption and person, which the app reads and clears with its key.
// When the person has Codex, it also gets generate_image_codex (#733's tool): a PNG from Codex's image_gen on
// their own ChatGPT login, run in their container by codexImage() below.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, copyFileSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { resolveFile } from './artifacts.ts';
import { copyPinned } from './codex-review.ts';
import { HttpError } from './http.ts';
import { INPUT_IMAGE, mediaCode, outPath, refusal, target, writeOutput, type MediaTool, type OpenRouter } from './openrouter.ts';

/** The MCP server's name on the turn: its tools show as mcp__citadel__<tool>. */
import { MEDIA_SERVER } from './contraption-args.ts';
export { MEDIA_SERVER };
/** Media files are kept this long from when they were written (overwriting one starts again). */
export const MEDIA_KEEP_MS = 30 * 86_400_000;
export const MEDIA_PLACE = 'your media folder';

export const MEDIA_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pcm': 'audio/pcm',
  '.json': 'application/json',
};

/** Where a contraption's files for one person go. */
export const mediaDir = (dataDir: string, contraption: string, person: number) => join(dataDir, 'contraption-media', contraption, String(person));

/** A file inside `dir` from a path the app sent, or a 400/404. */
export async function mediaFile(dir: string, path: string): Promise<string> {
  let rel: string;
  try {
    rel = decodeURIComponent(path);
  } catch {
    throw new HttpError(400, 'Not a file path');
  }
  const file = resolve(dir, rel);
  if (rel.includes('\0') || !file.startsWith(resolve(dir) + sep)) throw new HttpError(400, 'Not a file path inside the media folder');
  let st;
  try {
    st = await stat(file);
  } catch {
    throw new HttpError(404, 'No such file');
  }
  if (!st.isFile()) throw new HttpError(404, 'No such file');
  return file;
}

/** The files in a media folder, newest first, their `.json` notes left out. */
export async function listMedia(dir: string): Promise<{ path: string; bytes: number; modified: number }[]> {
  let names: string[];
  try {
    names = (await readdir(dir, { recursive: true })) as string[];
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (name.endsWith('.json')) continue;
    const st = await stat(join(dir, name)).catch(() => null);
    if (st?.isFile()) files.push({ path: name.split(sep).join('/'), bytes: st.size, modified: st.mtimeMs });
  }
  return files.sort((a, b) => b.modified - a.modified);
}

/** Remove every media file written more than MEDIA_KEEP_MS ago (notes go with their age too), under `root`. */
export function sweepMedia(root: string, now = Date.now()): number {
  let names: string[];
  try {
    names = readdirSync(root, { recursive: true }) as string[];
  } catch {
    return 0;
  }
  let gone = 0;
  for (const name of names) {
    const file = join(root, name);
    const st = statSync(file, { throwIfNoEntry: false });
    if (st?.isFile() && now - st.mtimeMs > MEDIA_KEEP_MS) {
      rmSync(file, { force: true });
      gone++;
    }
  }
  return gone;
}

const COMMON =
  'Runs on Citadel with the OpenRouter key of the person this turn is for, booked against their monthly cap: a call that would pass the cap, or could cost over $0.50, is refused before anything is spent. Writes to your media folder with a `<file>.json` note (prompt, model, cost); the app shows it from there. A refusal starts with its code (openrouter_not_connected, over_cap, …): say what it means to the person rather than retrying. Spend like it is their own money, because it is: one take at the default first.';
const OUT = 'The file to write, a path inside your media folder like frost-alert.png or auras/frost-2.png (n over 1 numbers them: frost-1.png, frost-2.png)';
const MODEL = { type: 'string', description: 'Optional: an OpenRouter model id. Leave it out for the cheap default' };
const OVERWRITE = { type: 'boolean', description: 'Replace a file that already exists (default false: refused)' };
const IMAGE_MODELS = ' Models: leave model out for black-forest-labs/flux-3-image-klein (about $0.01 at 1K), or recraft/recraft-v4.1-vector when out ends in .svg. For an icon on a transparent background, bytedance-seed/seedream-5-0-flash (about $0.02, real transparency).';
const BACKGROUND = {
  type: 'string',
  enum: ['transparent'],
  description: 'Optional: "transparent" for a see-through background (out must be .png). Models with real transparency (seedream, gpt-image-1) make it; on others Citadel asks for black and takes the black out, which suits glows and spell effects but turns dark parts see-through.',
};
const IMAGE_PROPS = {
  prompt: { type: 'string', maxLength: 8000, description: 'What to draw' },
  out: { type: 'string', description: `${OUT}. .png or .webp, or .svg for a vector model` },
  model: MODEL,
  background: BACKGROUND,
  resolution: { type: 'string', description: "Optional: one of the model's sizes, like 1K (an unknown one is refused with the list)" },
  aspect_ratio: { type: 'string', description: 'Optional: like 1:1 or 16:9 (an unknown one is refused with the list)' },
  n: { type: 'integer', minimum: 1, maximum: 4, description: 'How many takes (default 1)' },
  refs: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Optional: reference images already in your media folder, for style or subject' },
  overwrite: OVERWRITE,
};

/** The tools as tools/list gives them. */
export const MEDIA_TOOL_LIST = [
  { name: 'generate_image', description: `Make an image from a prompt. ${COMMON}${IMAGE_MODELS}`, inputSchema: { type: 'object', properties: IMAGE_PROPS, required: ['prompt', 'out'] } },
  {
    name: 'edit_image',
    description: `Change an image in your media folder as the prompt says (the result goes to out; the original stays). ${COMMON}${IMAGE_MODELS}`,
    inputSchema: { type: 'object', properties: { image: { type: 'string', description: 'The image to edit, in your media folder' }, ...IMAGE_PROPS }, required: ['image', 'prompt', 'out'] },
  },
  {
    name: 'generate_audio',
    description: `Make a sound effect or a short music clip from a prompt. ${COMMON} Models: effects default to bytedance-seed/seed-audio-1-0 (priced by the second), music to google/lyria-3-clip-preview (about $0.04 a clip). No model takes a clip to continue or vary: change the prompt, and for music keep the seed.`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['effect', 'music'], description: 'effect: a short sound (.mp3); music: a clip of about 30 seconds (.mp3 or .wav)' },
        prompt: { type: 'string', maxLength: 8000, description: 'What it should sound like' },
        out: { type: 'string', description: 'The file to write, a path inside your media folder. .mp3, or .wav for music' },
        seconds: { type: 'number', description: 'Optional, effects: roughly how long, up to 60' },
        seed: { type: 'integer', minimum: 0, description: 'Optional, music: the same seed with a tweaked prompt keeps more of the last clip (models without one refuse it)' },
        model: MODEL,
        overwrite: OVERWRITE,
      },
      required: ['kind', 'prompt', 'out'],
    },
  },
  {
    name: 'generate_speech',
    description: `Read text aloud with a text-to-speech model (#808). ${COMMON} The cost is checked from the input's length in UTF-8 bytes before the call.`,
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'An OpenRouter speech model id, like fish-audio/drama-3, elevenlabs/eleven-v3 or google/gemini-3.8-flash-tts' },
        input: { type: 'string', description: "The text to read. Sent byte for byte: inline pronunciation markup the model takes (Fish's <|phoneme_start|>klˈɛbkɪtʃ<|phoneme_end|>, SSML, IPA) goes through untouched. Over the model's limit is refused, never cut: split long text" },
        voice: { type: 'string', description: "Optional: the model's voice id (some models need one)" },
        response_format: { type: 'string', enum: ['mp3', 'wav', 'pcm'], description: "Optional: taken from out's extension. OpenRouter lists mp3 and pcm; some models give only one (Gemini and HeyGen only pcm), and the rest are refused for free" },
        instructions: { type: 'string', description: 'Optional: how to read it (tone, pace); only some models (OpenAI, Gemini, Fish) heed it' },
        speed: { type: 'number', minimum: 0.25, maximum: 4, description: 'Optional: 1 is normal' },
        out: { type: 'string', description: 'The file to write, a path inside your media folder. .mp3, .wav or .pcm, matching response_format' },
        overwrite: OVERWRITE,
      },
      required: ['model', 'input', 'out'],
    },
  },
];

export const CODEX_TOOL = 'generate_image_codex';
/** Offered only to a turn whose person has Codex (MediaTurn.codex), after the three above. */
export const CODEX_TOOL_DEF = {
  name: CODEX_TOOL,
  description:
    "Make or edit a PNG with Codex's built-in image generation (OpenAI gpt-image) on the ChatGPT plan of the person this turn is for, with no per-image charge. For a PNG use this one first; SVG, WebP and sound go to generate_image and generate_audio, and so does a PNG when this refuses with codex_over_pace (it reads their 5-hour and weekly Codex limits first and leaves the rest for their own work). To edit, pass the image in refs and say what to change. No size or aspect setting: say the shape you want in the prompt. Writes to your media folder with a `<file>.json` note; the app shows it from there. Takes a minute or two. A refusal starts with its code (codex_over_pace, codex_not_ready, …): say what it means to the person rather than retrying. One take first; more only when asked or when it misses.",
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', maxLength: 8000, description: 'What to draw, or for an edit what to change' },
      out: { type: 'string', description: `${OUT}. .png` },
      refs: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Optional: images in your media folder (png, jpg or webp) to edit or to take style or subject from' },
      background: { type: 'string', enum: ['transparent'], description: 'Optional: "transparent" for a see-through background, made by the model itself' },
      overwrite: OVERWRITE,
    },
    required: ['prompt', 'out'],
  },
};

/** Where a person's Codex runs for a media call: their own container, or the server login's Codex container (#341). */
export interface CodexAt {
  container: string;
  /** The person's turns folder, mounted in the container at the same path: each call's files go in a folder there. */
  turnsDir: string;
  /** The container turns' environment (HOME, PATH, ...). */
  env: Record<string, string>;
  /** The tripwire config Codex's managed hook reads, as a contraption Codex turn writes it. */
  tripwire: unknown;
  ensure: () => Promise<void>;
  podman: string;
}

/** The turn a media call comes from, as ContraptionTurns.mediaTurn gives it. */
export interface MediaTurn {
  person: number;
  name: string;
  home: number | null;
  emit: (event: string, data: object) => void;
  /** Where generate_image_codex runs, or null: the person has no Codex a turn can reach. */
  codex: CodexAt | null;
}

/** The tools a turn's tools/list gives. */
export const mediaTools = (turn: MediaTurn) => (turn.codex ? [...MEDIA_TOOL_LIST, CODEX_TOOL_DEF] : MEDIA_TOOL_LIST);

const PNG = new Set(['.png']);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** gpt-image's largest PNGs are a few MB. */
const MAX_CODEX_PNG = 50 * 1024 * 1024;

/**
 * The PNG a run left in its folder. The container can write there, so it's opened without following a link
 * and must be a plain PNG file of a sane size: the server must never copy one of its own files into the folder the app serves.
 */
function readPng(file: string): Buffer {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Error('Codex said it was done but left no picture');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_CODEX_PNG) throw new Error("Codex left something that isn't a PNG file");
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (!n) break;
      got += n;
    }
    if (got < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error("Codex left something that isn't a PNG file");
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}
/** podman exec's own failures: 125 podman (no such container), 126 and 127 the command. */
const PODMAN_FAILED = new Set([125, 126, 127]);

/**
 * generate_image_codex for a contraption turn: one `citadel-codex-review --image-gen` run in the person's
 * container, in a folder of its own under their turns folder (refs copied in), whose PNG is copied to `out` in
 * the media folder with a note. The driver there checks the hook, the sign-in and the person's Codex pace itself.
 */
export async function codexImage(at: CodexAt, dir: string, args: Record<string, unknown>): Promise<{ path: string; usage: string | null }> {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt || prompt.length > 8000) throw new HttpError(400, 'prompt is required, at most 8000 characters');
  if (args.background !== undefined && args.background !== 'transparent') throw new HttpError(400, 'background is "transparent", or leave it out');
  const refs: unknown = args.refs ?? [];
  if (!Array.isArray(refs) || refs.length > 5 || refs.some((r) => typeof r !== 'string' || !r)) throw new HttpError(400, 'refs is a list of up to 5 image paths in your media folder');
  const file = target(outPath(args.out, [dir], PNG, MEDIA_PLACE), 1, 0, args.overwrite === true);
  const found = [];
  for (const r of refs as string[]) {
    const f = await resolveFile(r, dir, [dir], INPUT_IMAGE);
    if (!f) throw new HttpError(400, `${r}: no png, jpeg or webp there inside ${MEDIA_PLACE}`);
    found.push(f.file);
  }
  await at.ensure();
  mkdirSync(at.turnsDir, { recursive: true });
  const job = mkdtempSync(join(at.turnsDir, 'media-codex-'));
  try {
    // The driver and what it imports, and the tripwire Codex's hook loads, as inContainer copies them for a host turn's review.
    const driver = join(job, 'codex-review.ts');
    copyPinned(join(import.meta.dirname, 'codex-review.ts'), job);
    copyPinned(join(import.meta.dirname, 'tripwire.ts'), job);
    const cfg = join(job, 'codex-tripwire.json');
    writeFileSync(cfg, JSON.stringify({ script: join(job, 'tripwire.ts'), config: at.tripwire }), { mode: 0o444 });
    const images = found.flatMap((f, i) => {
      const name = `ref-${i}${extname(f).toLowerCase()}`;
      // EXCL: never through a link the container put there meanwhile.
      copyFileSync(f, join(job, name), constants.COPYFILE_EXCL);
      return ['--image', name];
    });
    const env = { ...at.env, CITADEL_CODEX_TRIPWIRE: cfg };
    const argv = ['exec', '-i', '-w', job, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), at.container, process.execPath, driver, '--image-gen', '--timeout', '600', '--out', 'out.png', ...(args.background === 'transparent' ? ['--transparent'] : []), ...images];
    const r = await new Promise<{ code: number | null; err: string }>((done) => {
      const child = spawn(at.podman, argv, { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      // The driver's own limit is 600 s, but its wait for the person's Codex lock isn't: past 15 minutes, stop it in the container too.
      // shortcut: a canceled turn doesn't stop a run already going; pass the turn's end down if runs pile up.
      const timer = setTimeout(() => {
        spawnSync(at.podman, ['exec', at.container, 'pkill', '-f', '--', driver], { stdio: 'ignore', timeout: 10_000 });
        child.kill('SIGTERM');
      }, 900_000);
      child.stderr!.on('data', (b) => (err = (err + b).slice(-4000)));
      child.on('error', (e) => {
        clearTimeout(timer);
        done({ code: null, err: e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done({ code, err });
      });
      child.stdin!.on('error', () => {});
      child.stdin!.end(prompt);
    });
    const usage = /^Codex usage: (.*)$/m.exec(r.err)?.[1] ?? null;
    const why =
      r.err
        .replace(/^Codex usage: .*$/m, '')
        .replace(/^citadel-codex-review: /gm, '')
        .trim() || 'no reason given';
    if (r.code === 4) throw refusal(429, 'codex_over_pace', `${why} Use generate_image for this one.`);
    if (r.code === 3) throw refusal(503, 'codex_not_ready', why);
    if (r.code === null || PODMAN_FAILED.has(r.code)) throw new Error(`Couldn't run Codex in this person's container (${at.container}): ${why}`);
    if (r.code !== 0) throw new Error(`Codex couldn't make the image (exit ${r.code}): ${why}`);
    writeOutput(file, readPng(join(job, 'out.png')), { tool: CODEX_TOOL, prompt, model: 'codex image_gen', cost_usd: 0, date: new Date().toISOString(), ...(args.background ? { background: args.background } : {}), ...(refs.length ? { refs } : {}) });
    return { path: file, usage };
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
}

/** Run one tool for `turn`: the `media` event goes to the app's stream, the text to the agent. */
export async function runMediaTool(openrouter: OpenRouter, dataDir: string, turn: MediaTurn, tool: MediaTool | typeof CODEX_TOOL, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const dir = mediaDir(dataDir, turn.name, turn.person);
  try {
    mkdirSync(dir, { recursive: true });
    if (tool === CODEX_TOOL) {
      if (!turn.codex) throw refusal(503, 'codex_not_ready', 'This person has no Codex a turn can reach');
      const r = await codexImage(turn.codex, dir, args);
      const path = relative(dir, r.path).split(sep).join('/');
      turn.emit('media', { tool, ok: true, files: [{ path, bytes: statSync(r.path).size, type: 'image/png' }], model: 'codex image_gen', cost_usd: 0 });
      return { text: `Wrote ${path} with Codex on this person's ChatGPT plan, no charge.${r.usage ? ` Codex usage: ${r.usage}.` : ''}`, isError: false };
    }
    const r = await openrouter.tool(tool, args, { userId: turn.person, ticketId: null, projectId: turn.home, roots: [dir], place: MEDIA_PLACE });
    const files = r.paths.map((p) => ({ path: relative(dir, p).split(sep).join('/'), bytes: statSync(p).size, type: MEDIA_TYPE[extname(p).toLowerCase()] ?? 'application/octet-stream' }));
    turn.emit('media', { tool, ok: true, files, model: r.model, cost_usd: r.cost_usd, left_usd: r.left_usd, ...(r.warnings ? { warnings: r.warnings } : {}) });
    const warn = r.warnings ? `\n${r.warnings.join('\n')}` : '';
    return { text: `Wrote ${files.map((f) => f.path).join(', ')} with ${r.model} for $${Number(r.cost_usd).toFixed(4)}; $${Number(r.left_usd).toFixed(2)} left this month.${warn}`, isError: false };
  } catch (err) {
    const code = mediaCode(err);
    const message = err instanceof HttpError ? err.message : `The call didn't finish: ${(err as Error).message}`;
    turn.emit('media', { tool, ok: false, code, message });
    return { text: `${code}: ${message}`, isError: true };
  }
}

/**
 * One JSON-RPC message to the `citadel` MCP server (streamable HTTP, JSON answers only): the answer to
 * send, or null for a notification (202, no body).
 */
export async function mcpMessage(message: unknown, tools: { name: string }[], call: (tool: MediaTool | typeof CODEX_TOOL, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>): Promise<object | null> {
  const msg = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { protocolVersion?: unknown; name?: unknown; arguments?: Record<string, unknown> | null } | null } | null;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send one JSON-RPC 2.0 message' } };
  }
  if (msg.id === undefined || msg.id === null) return null;
  const answer = (result: object) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return answer({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: MEDIA_SERVER, version: '1' },
      });
    case 'ping':
      return answer({});
    case 'tools/list':
      return answer({ tools });
    case 'tools/call': {
      const name = msg.params?.name;
      if (!tools.some((t) => t.name === name)) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `No tool ${String(name).slice(0, 60)}` } };
      const args = msg.params?.arguments && typeof msg.params.arguments === 'object' && !Array.isArray(msg.params.arguments) ? msg.params.arguments : {};
      const r = await call(name as MediaTool | typeof CODEX_TOOL, args); // one of `tools`, checked just above
      return answer({ content: [{ type: 'text', text: r.text }], isError: r.isError });
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `No method ${msg.method.slice(0, 60)}` } };
  }
}
