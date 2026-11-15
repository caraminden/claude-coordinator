// Media tools on contraption turns (#732, shared/project/specs/media-tools-contraptions.md): a turn that
// asks for `media: true` gets generate_image, edit_image and generate_audio from an MCP server Citadel
// adds, named `citadel`, which runs them through src/openrouter.ts with the turn person's own key and cap.
// Files go to a media folder per contraption and person, which the app reads and clears with its key.
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { HttpError } from './http.ts';
import { mediaCode, MEDIA_TOOLS, type MediaTool, type OpenRouter } from './openrouter.ts';

/** The MCP server's name on the turn: its tools show as mcp__citadel__<tool>. */
export const MEDIA_SERVER = 'citadel';
/** Media files are kept this long from when they were written (overwriting one starts again). */
export const MEDIA_KEEP_MS = 30 * 86_400_000;
export const MEDIA_PLACE = 'your media folder';

export const MEDIA_TYPE: Record<string, string> = {
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json',
};

/** Where a contraption's files for one person go. */
export const mediaDir = (dataDir: string, contraption: string, person: number) => join(dataDir, 'contraption-media', contraption, String(person));

/** A file inside `dir` from a path the app sent, or a 400/404. */
export function mediaFile(dir: string, path: string): string {
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
    st = statSync(file);
  } catch {
    throw new HttpError(404, 'No such file');
  }
  if (!st.isFile()) throw new HttpError(404, 'No such file');
  return file;
}

/** The files in a media folder, newest first, their `.json` notes left out. */
export function listMedia(dir: string): { path: string; bytes: number; modified: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (name.endsWith('.json')) continue;
    const st = statSync(join(dir, name), { throwIfNoEntry: false });
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

const COMMON = 'Runs on Citadel with the OpenRouter key of the person this turn is for, booked against their monthly cap: a call that would pass the cap, or could cost over $0.50, is refused before anything is spent. Writes to your media folder with a `<file>.json` note (prompt, model, cost); the app shows it from there. A refusal starts with its code (openrouter_not_connected, over_cap, …): say what it means to the person rather than retrying. Spend like it is their own money, because it is: one take at the default first.';
const OUT = 'The file to write, a path inside your media folder like frost-alert.png or auras/frost-2.png (n over 1 numbers them: frost-1.png, frost-2.png)';
const MODEL = { type: 'string', description: 'Optional: an OpenRouter model id. Leave it out for the cheap default' };
const OVERWRITE = { type: 'boolean', description: 'Replace a file that already exists (default false: refused)' };
const IMAGE_MODELS = ' Models: leave model out for black-forest-labs/flux-3-image-klein (about $0.01 at 1K), or recraft/recraft-v4.1-vector when out ends in .svg. For an icon on a transparent background, bytedance-seed/seedream-5-0-flash (about $0.02, real transparency).';
const BACKGROUND = {
  type: 'string', enum: ['transparent'],
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
];

/** The turn a media call comes from, as ContraptionTurns.mediaTurn gives it. */
export interface MediaTurn {
  person: number;
  name: string;
  home: number | null;
  emit: (event: string, data: object) => void;
}

/** Run one tool for `turn`: the `media` event goes to the app's stream, the text to the agent. */
export async function runMediaTool(openrouter: OpenRouter, dataDir: string, turn: MediaTurn, tool: MediaTool, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const dir = mediaDir(dataDir, turn.name, turn.person);
  try {
    mkdirSync(dir, { recursive: true });
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
export async function mcpMessage(msg: any, call: (tool: MediaTool, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>): Promise<object | null> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send one JSON-RPC 2.0 message' } };
  }
  if (msg.id === undefined || msg.id === null) return null;
  const answer = (result: object) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return answer({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: MEDIA_SERVER, version: '1' },
      });
    case 'ping':
      return answer({});
    case 'tools/list':
      return answer({ tools: MEDIA_TOOL_LIST });
    case 'tools/call': {
      const name = msg.params?.name;
      if (!MEDIA_TOOLS.includes(name)) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `No tool ${String(name).slice(0, 60)}` } };
      const args = msg.params?.arguments && typeof msg.params.arguments === 'object' && !Array.isArray(msg.params.arguments) ? msg.params.arguments : {};
      const r = await call(name, args);
      return answer({ content: [{ type: 'text', text: r.text }], isError: r.isError });
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `No method ${msg.method.slice(0, 60)}` } };
  }
}
