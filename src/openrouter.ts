// OpenRouter (#717): each person's own key and monthly cap, for the generate_image, edit_image,
// generate_audio and generate_speech (#808) tools, plus a text client nothing calls yet. Only the server talks to OpenRouter: the key
// never reaches a turn. Every call is a row in openrouter_calls, reserved at its worst-case price before
// the request goes out, so a call that could pass the person's cap is refused before any money moves.
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { resolveFile } from './artifacts.ts';
import type { Credentials } from './credentials.ts';
import type { OpenrouterCallKind, Store } from './db.ts';
import { HttpError } from './http.ts';
import { matteBlackOff } from './png-matte.ts';
import { pacific } from './pacific.ts';

type Fetch = typeof fetch;

export const DEFAULT_CAP_USD = 10;
/** No single call may cost more than this, whatever the cap says: a typo'd model or n can't eat a month. */
export const PER_CALL_LIMIT_USD = 0.5;
export const MAX_CAP_USD = 1000;
export const CONNECT = 'OpenRouter isn\'t connected for the person this turn runs for: connect it on the account page (Settings → Account), with a monthly cap.';
const DAY = 86_400_000;

export const MODELS = {
  image: 'black-forest-labs/flux-3-image-klein',
  vector: 'recraft/recraft-v4.1-vector',
  effect: 'bytedance-seed/seed-audio-1-0',
  music: 'google/lyria-3-clip-preview',
};

/** What the credential's meta keeps beside the sealed key: never OpenRouter's label, which shows bits of the key. */
export interface OpenRouterMeta {
  cap_usd: number;
  /** OpenRouter's own limit on the key, if its owner set one there, and when that resets. */
  or_limit: number | null;
  or_limit_reset: string | null;
  or_usage_monthly: number | null;
  checked_at: number;
  linked_at: number;
}

/** Megapixels per resolution tier, for a price per megapixel. */
const MEGAPIXELS: Record<string, number> = { '768': 0.59, '1k': 1.05, '1.5k': 2.36, '2k': 4.19, '4k': 16.8 };
// Worst-case token counts: an output image (gpt-image at high quality runs ~6k), an input image.
const OUTPUT_IMAGE_TOKENS = 8000;
const INPUT_IMAGE_TOKENS = 2000;
const INPUT_IMAGE_MEGAPIXELS = 4.2;
/** An effect is priced per second of audio, and no model is asked for more than a minute. */
const EFFECT_SECONDS = 60;
// The models list gives a speech model's price with no unit, and some are per token: only these are known per second.
const PER_SECOND_AUDIO = new Set([MODELS.effect]);
/** Seed Audio's documented ceilings (OpenRouter's TTS guide): 3,000 characters in, 120 seconds out. */
const SEED_INPUT_CHARS = 3000;
const SPEECH_SECONDS = 120;
/** The longest input any speech model on OpenRouter lists (Eleven Flash v2.5), for models that list none. */
const MAX_SPEECH_CHARS = 40_000;

interface PriceLine { billable: string; unit: string; cost_usd: number; variant?: string }
export interface ImageEndpoint { pricing?: PriceLine[]; supported_parameters?: Record<string, { type: string; values?: string[]; min?: number; max?: number }> }

/**
 * The most an image call could cost across `endpoints` (OpenRouter may route to any), or null when one
 * doesn't price its output images or prices by a unit this can't count. A price per variant uses the
 * asked resolution, or the dearest.
 */
export function imageEstimate(endpoints: ImageEndpoint[], o: { resolution?: string; n: number; refs: number; promptChars: number }): number | null {
  const res = o.resolution?.toLowerCase();
  let worst: number | null = null;
  for (const ep of endpoints) {
    const lines = (ep.pricing ?? []).filter((p) => Number.isFinite(Number(p.cost_usd)) && Number(p.cost_usd) >= 0);
    if (!lines.some((p) => p.billable === 'output_image')) return null;
    if (lines.some((p) => !['image', 'megapixel', 'token', 'request'].includes(p.unit))) return null;
    let total = 0;
    for (const billable of new Set(lines.map((p) => p.billable))) {
      let these = lines.filter((p) => p.billable === billable);
      if (res && these.some((p) => p.variant?.toLowerCase() === res)) these = these.filter((p) => p.variant?.toLowerCase() === res);
      const out = billable === 'output_image';
      const each = Math.max(...these.map((p) => {
        const mp = MEGAPIXELS[(p.variant ?? res ?? '4k').toLowerCase()] ?? MEGAPIXELS['4k'];
        const units = p.unit === 'megapixel' ? (out ? mp : INPUT_IMAGE_MEGAPIXELS)
          : p.unit === 'token' ? (out ? OUTPUT_IMAGE_TOKENS : billable === 'input_text' ? o.promptChars : INPUT_IMAGE_TOKENS)
          : 1;
        return Number(p.cost_usd) * units;
      }));
      total += each * (out ? o.n : billable === 'input_text' ? 1 : o.refs);
    }
    worst = Math.max(worst ?? 0, total);
  }
  return worst;
}

/** A model's price from the models list: per clip or song from its description (Lyria's are only there), else per request. */
export function perRequestPrice(model: { pricing?: Record<string, string>; description?: string }): number | null {
  const m = /\$(\d+(?:\.\d+)?) per (clip|song|request|track)/i.exec(model.description ?? '');
  if (m) return Number(m[1]);
  const req = Number(model.pricing?.request);
  return req > 0 ? req : null;
}

interface SpeechModel { id: string; pricing?: Record<string, string>; top_provider?: { max_completion_tokens?: number | null }; description?: string }

/**
 * The most a speech call could cost, or null when it can't be bounded. OpenRouter lists a speech model's
 * input price with no unit (per character, per UTF-8 byte or per token), so it's charged per UTF-8 byte,
 * which is never fewer than the characters or tokens. An output price is per token up to the model's
 * max_completion_tokens, or per second for a model known to price that way, up to its 120 s ceiling;
 * any other output price is refused.
 */
export function speechEstimate(m: SpeechModel, bytes: number): number | null {
  if (m.id.endsWith(':free')) return 0;
  const input = Number(m.pricing?.prompt ?? 0);
  const output = Number(m.pricing?.completion ?? 0);
  if (!(input >= 0) || !(output >= 0)) return null;
  const maxTokens = Number(m.top_provider?.max_completion_tokens ?? 0);
  const out = output === 0 ? 0 : PER_SECOND_AUDIO.has(m.id) ? output * SPEECH_SECONDS : maxTokens > 0 ? output * maxTokens : null;
  return out === null ? null : input * bytes + out;
}

/** How many characters a speech model takes: Seed's documented 3,000, a limit its description names, else the longest any model takes. */
export function speechLimit(m: SpeechModel): number {
  if (m.id === MODELS.effect) return SEED_INPUT_CHARS;
  const said = /([\d,]+)-character/.exec(m.description ?? '');
  const n = said ? Number(said[1].replace(/,/g, '')) : NaN;
  return n > 0 ? Math.min(n, MAX_SPEECH_CHARS) : MAX_SPEECH_CHARS;
}

/** An MP3's length in seconds from its first frame's bitrate. shortcut: assumes constant bitrate, read the Xing header if a VBR model shows up. */
export function mp3Seconds(buf: Buffer): number | null {
  let i = 0;
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') i = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f));
  for (; i + 4 <= buf.length; i++) if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) break;
  if (i + 4 > buf.length || ((buf[i + 1] >> 1) & 3) !== 1) return null; // Layer III only
  const mpeg1 = ((buf[i + 1] >> 3) & 3) === 3;
  const kbps = (mpeg1 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[buf[i + 2] >> 4];
  return kbps ? ((buf.length - i) * 8) / (kbps * 1000) : null;
}

/** The start of this month in UTC (OpenRouter's months), which the cap counts from. */
export const monthStart = (now = Date.now()) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

/** When the cap resets, in Pacific time: the next UTC month, which starts the afternoon before. */
export function resetsAt(now = Date.now()): string {
  const d = new Date(now);
  return pacific(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

const money = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

/** A media call's refusal as a stable code (#732), which contraption turns hand to their app. */
export type MediaCode = 'openrouter_not_connected' | 'openrouter_key_refused' | 'over_cap' | 'over_call_limit' | 'openrouter_refused' | 'codex_over_pace' | 'codex_not_ready' | 'bad_request' | 'failed';
export const refusal = (status: number, code: MediaCode, message: string) => Object.assign(new HttpError(status, message), { code });
/** The code for any error a media call threw: its own, else a bad argument (4xx) or a failure. */
export const mediaCode = (err: unknown): MediaCode => (err as { code?: MediaCode } | null)?.code ?? (err instanceof HttpError && err.status < 500 ? 'bad_request' : 'failed');
/** Asked of a model with no transparent background of its own, so the matte has black to take out. */
const BLACK_BACKGROUND = 'Background: plain solid pure black (#000000), nothing else behind the subject, no floor, no shadow on it.';

export interface ToolContext {
  userId: number | null;
  /** The minion and scheme it's booked to; null on a contraption turn (#732). */
  ticketId: number | null;
  projectId: number | null;
  /** Where the turn may write and read files: its working directory first (relative paths), then its shared folders. */
  roots: string[];
  /** What refusals call the roots (default: a minion's working directory or shared folders). */
  place?: string;
}
const MINION_PLACE = 'your working directory or a shared folder';

export const MEDIA_TOOLS = ['generate_image', 'edit_image', 'generate_audio', 'generate_speech'] as const;
export type MediaTool = (typeof MEDIA_TOOLS)[number];
const IMAGE_EXT = new Set(['.png', '.webp', '.svg']);
const AUDIO_EXT = new Set(['.mp3', '.wav']);
const SPEECH_FORMATS = ['mp3', 'wav', 'pcm'];
export const INPUT_IMAGE = (p: string) => (/\.(png|jpe?g|webp)$/i.test(p) ? 'image' : null);
const MEDIA_TYPES: Record<string, string> = { 'image/png': '.png', 'image/webp': '.webp', 'image/jpeg': '.jpg', 'image/svg+xml': '.svg' };
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

export class OpenRouter {
  private store: Store;
  private creds: Credentials;
  private fetch: Fetch;
  private base: string;
  private models: { at: number; byId: Map<string, any> } | null = null;
  private endpoints = new Map<string, { at: number; list: ImageEndpoint[] }>();

  constructor(store: Store, creds: Credentials, fetchFn: Fetch = globalThis.fetch, base = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1') {
    this.store = store;
    this.creds = creds;
    this.fetch = fetchFn;
    this.base = base.replace(/\/$/, '');
    // Calls in flight when the server stopped never settled: count them at their estimate.
    store.sweepOpenrouterCalls();
  }

  /** Whether `userId` can make calls now (connected, and OpenRouter hasn't refused the key). */
  connected(userId: number | null): boolean {
    const c = userId ? this.creds.get(userId, 'openrouter') : null;
    return !!c && !c.failed;
  }

  /** The account page's view: never the key. */
  status(userId: number) {
    const c = this.creds.get<OpenRouterMeta>(userId, 'openrouter');
    if (!c) return { connected: false, default_cap_usd: DEFAULT_CAP_USD };
    const spent = this.store.openrouterSpent(userId, monthStart());
    return {
      connected: true, failed: c.failed, cap_usd: c.meta.cap_usd, spent_usd: spent, left_usd: Math.max(0, c.meta.cap_usd - spent), resets: resetsAt(),
      or_limit: c.meta.or_limit, or_limit_reset: c.meta.or_limit_reset, linked_at: c.meta.linked_at,
    };
  }

  /** Check `key` with OpenRouter and keep it, sealed, with the person's cap. */
  async connect(userId: number, key: unknown, cap: unknown) {
    if (typeof key !== 'string' || !/^[\x21-\x7e]{16,256}$/.test(key.trim())) throw new HttpError(400, 'That doesn\'t look like an OpenRouter key (it starts sk-or-)');
    const capUsd = cap === undefined ? DEFAULT_CAP_USD : this.validCap(cap);
    const res = await this.request(key.trim(), 'GET', '/key').catch((err) => {
      throw err instanceof HttpError && err.status === 403 ? new HttpError(400, 'OpenRouter didn\'t accept that key') : err;
    });
    const data = (await res.json() as { data?: Record<string, any> }).data ?? {};
    const now = Date.now();
    this.creds.put(userId, 'openrouter', key.trim(), {
      cap_usd: capUsd, or_limit: typeof data.limit === 'number' ? data.limit : null, or_limit_reset: typeof data.limit_reset === 'string' ? data.limit_reset : null,
      or_usage_monthly: typeof data.usage_monthly === 'number' ? data.usage_monthly : null, checked_at: now, linked_at: now,
    } satisfies OpenRouterMeta);
    return this.status(userId);
  }

  setCap(userId: number, cap: unknown) {
    const c = this.creds.get<OpenRouterMeta>(userId, 'openrouter');
    if (!c?.secret) throw new HttpError(404, 'OpenRouter isn\'t connected');
    // put re-seals the same key and clears a failure: only a working key should get here, so keep failed ones failed.
    this.creds.put(userId, 'openrouter', c.secret, { ...c.meta, cap_usd: this.validCap(cap) });
    if (c.failed) this.creds.fail(userId, 'openrouter');
    return this.status(userId);
  }

  unlink(userId: number) {
    this.creds.remove(userId, 'openrouter');
  }

  private validCap(cap: unknown): number {
    const n = Number(cap);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_CAP_USD) throw new HttpError(400, `A monthly cap is a dollar amount above 0 and at most ${MAX_CAP_USD}`);
    return Math.round(n * 100) / 100;
  }

  /** The key for a call, or a refusal saying what to do. */
  private key(userId: number | null): { key: string; cap: number } {
    const c = userId ? this.creds.get<OpenRouterMeta>(userId, 'openrouter') : null;
    if (!c) throw refusal(403, 'openrouter_not_connected', CONNECT);
    if (c.failed || !c.secret) throw refusal(403, 'openrouter_key_refused', 'OpenRouter refused this person\'s key: connect it again on the account page.');
    return { key: c.secret, cap: c.meta.cap_usd };
  }

  /**
   * Book a call at its worst-case price, or refuse it. Synchronous from the spend sum to the insert, so
   * two calls at once can't both fit under the cap.
   */
  private reserve(userId: number, cap: number, ctx: ToolContext, kind: OpenrouterCallKind, model: string, estimate: number | null): number {
    if (estimate === null || (estimate <= 0 && !model.endsWith(':free'))) {
      throw new HttpError(400, `OpenRouter shows no price for ${model} that Citadel can read, so it can't be checked against the cap: pick another model.`);
    }
    if (estimate > PER_CALL_LIMIT_USD) throw refusal(400, 'over_call_limit', `This call could cost up to ${money(estimate)}, over the ${money(PER_CALL_LIMIT_USD)} limit per call: ask for fewer or smaller outputs, or a cheaper model.`);
    const spent = this.store.openrouterSpent(userId, monthStart());
    if (spent + estimate > cap) {
      throw refusal(402, 'over_cap', `This call could cost up to ${money(estimate)}, and ${money(spent)} of this month's ${money(cap)} OpenRouter cap is spent: it's refused. The cap resets ${resetsAt()}, or its owner can raise it on the account page.`);
    }
    return this.store.addOpenrouterCall({ user_id: userId, ticket_id: ctx.ticketId, project_id: ctx.projectId, model, kind, estimate_usd: estimate });
  }

  /** A request to OpenRouter; any refusal becomes an HttpError that names the cause, never the key. */
  private async request(key: string, method: string, path: string, body?: object, timeoutMs = 180_000): Promise<Response> {
    const res = await this.fetch(`${this.base}${path}`, {
      method, signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    let said = text;
    try {
      said = JSON.parse(text)?.error?.message ?? text;
    } catch {}
    said = String(said).slice(0, 300);
    if (res.status === 401) throw refusal(403, 'openrouter_key_refused', `OpenRouter refused the key${said ? ` (${said})` : ''}`);
    if (res.status === 402 || res.status === 403) throw refusal(402, 'openrouter_refused', `OpenRouter refused the call: the key is out of credit or past the limit set on OpenRouter${said ? ` (${said})` : ''}`);
    throw new HttpError(res.status === 400 || res.status === 404 || res.status === 413 ? 400 : 502, `OpenRouter answered ${res.status}${said ? `: ${said}` : ''}`);
  }

  /** Run a reserved call: settle it at its real cost, or as failed when OpenRouter refused it, or unknown when we can't tell. */
  private async settled<T>(userId: number, id: number, estimate: number, run: () => Promise<{ value: T; cost: number | null }>): Promise<{ value: T; cost: number }> {
    try {
      const { value, cost } = await run();
      const real = cost !== null && Number.isFinite(cost) && cost >= 0 ? cost : estimate;
      this.store.finishOpenrouterCall(id, 'ok', real);
      return { value, cost: real };
    } catch (err) {
      // An answer refusing the call cost nothing; a timeout or a dropped answer may have been billed.
      const refused = err instanceof HttpError && err.status < 500;
      this.store.finishOpenrouterCall(id, refused ? 'failed' : 'unknown', refused ? 0 : null);
      if (mediaCode(err) === 'openrouter_key_refused') this.creds.fail(userId, 'openrouter');
      throw err instanceof HttpError ? err : new HttpError(502, `OpenRouter call didn't finish: ${(err as Error).message}`);
    }
  }

  /** OpenRouter's record of a call's cost, when it has one. */
  private async generationCost(key: string, id: string | null | undefined): Promise<number | null> {
    if (!id) return null;
    try {
      const res = await this.request(key, 'GET', `/generation?id=${encodeURIComponent(id)}`, undefined, 15_000);
      const cost = (await res.json() as { data?: { total_cost?: number } }).data?.total_cost;
      return typeof cost === 'number' ? cost : null;
    } catch {
      return null;
    }
  }

  /** The models list (public), kept a day; refetched once for an id it doesn't know. */
  private async model(id: string): Promise<any> {
    for (const fresh of [false, true]) {
      if (fresh || !this.models || Date.now() - this.models.at > DAY) {
        const res = await this.fetch(`${this.base}/models?output_modalities=all`, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new HttpError(502, `OpenRouter's model list answered ${res.status}`);
        const list = (await res.json() as { data?: any[] }).data ?? [];
        this.models = { at: Date.now(), byId: new Map(list.map((m) => [m.id, m])) };
      }
      const m = this.models!.byId.get(id);
      if (m) return m;
    }
    throw new HttpError(400, `OpenRouter has no model ${id}`);
  }

  private async imageEndpoints(id: string): Promise<ImageEndpoint[]> {
    const hit = this.endpoints.get(id);
    if (hit && Date.now() - hit.at < DAY) return hit.list;
    const res = await this.fetch(`${this.base}/images/models/${id.split('/').map(encodeURIComponent).join('/')}/endpoints`, { signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) throw new HttpError(400, `OpenRouter has no image model ${id}`);
    if (!res.ok) throw new HttpError(502, `OpenRouter's image model list answered ${res.status}`);
    const list = (await res.json() as { endpoints?: ImageEndpoint[] }).endpoints ?? [];
    this.endpoints.set(id, { at: Date.now(), list });
    return list;
  }

  private left(userId: number, cap: number) {
    return Math.max(0, Math.round((cap - this.store.openrouterSpent(userId, monthStart())) * 1000) / 1000);
  }

  /**
   * A minion's tool call: check its arguments (they come from a turn), book it against the person's
   * cap, call OpenRouter, and write the file(s) with a `<file>.json` note of how each was made.
   */
  async tool(name: MediaTool, args: Record<string, any>, ctx: ToolContext) {
    const { key, cap } = this.key(ctx.userId);
    const userId = ctx.userId!;
    if (name === 'generate_speech') return this.speech(userId, key, cap, args, ctx);
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt || prompt.length > 8000) throw new HttpError(400, 'prompt is required, at most 8000 characters');
    if (args.model !== undefined && (typeof args.model !== 'string' || !/^[\w.-]+\/[\w.:-]+$/.test(args.model))) throw new HttpError(400, 'model is an OpenRouter model id, like black-forest-labs/flux-3-image-klein');
    const place = ctx.place ?? MINION_PLACE;
    const out = outPath(args.out, ctx.roots, name === 'generate_audio' ? AUDIO_EXT : IMAGE_EXT, place);
    const date = new Date().toISOString();
    if (name === 'generate_audio') {
      const kind = args.kind === 'music' ? 'music' : args.kind === 'effect' ? 'effect' : null;
      if (!kind) throw new HttpError(400, 'kind is effect or music');
      const seconds = args.seconds === undefined ? undefined : Number(args.seconds);
      if (seconds !== undefined && !(seconds > 0 && seconds <= EFFECT_SECONDS)) throw new HttpError(400, `seconds is between 0 and ${EFFECT_SECONDS}`);
      if (kind === 'effect' && extname(out).toLowerCase() !== '.mp3') throw new HttpError(400, 'Sound effects come as .mp3');
      const seed = args.seed;
      if (seed !== undefined && !(Number.isSafeInteger(seed) && seed >= 0)) throw new HttpError(400, 'seed is a whole number from 0');
      const file = target(out, 1, 0, args.overwrite === true);
      const model = args.model ?? MODELS[kind];
      // Only models that list seed take one (Lyria does; no effect model does today): refused before anything is spent.
      if (seed !== undefined && !(await this.model(model)).supported_parameters?.includes('seed')) throw new HttpError(400, `${model} takes no seed`);
      const { value: bytes, cost } = kind === 'effect'
        ? await this.effect(userId, key, cap, ctx, model, seconds ? `${prompt}\nLength: about ${seconds} seconds.` : prompt)
        : await this.music(userId, key, cap, ctx, model, prompt, extname(out).toLowerCase() === '.wav' ? 'wav' : 'mp3', seed);
      writeOutput(file, bytes, { tool: name, kind, prompt, model, cost_usd: cost, date, ...(seconds ? { seconds } : {}), ...(seed !== undefined ? { seed } : {}), licence: licence(model) });
      return { paths: [file], cost_usd: cost, left_usd: this.left(userId, cap), model };
    }
    const n = args.n === undefined ? 1 : Number(args.n);
    if (!Number.isInteger(n) || n < 1 || n > 4) throw new HttpError(400, 'n is 1 to 4');
    const inputs = [...(name === 'edit_image' ? [args.image] : []), ...(Array.isArray(args.refs) ? args.refs : args.refs === undefined ? [] : [args.refs])];
    if (name === 'edit_image' && typeof args.image !== 'string') throw new HttpError(400, 'image is the file to edit');
    if (inputs.length > 8) throw new HttpError(400, 'At most 8 reference images');
    const refs = await Promise.all(inputs.map((p) => inputImage(p, ctx.roots, place)));
    const svg = extname(out).toLowerCase() === '.svg';
    const model = args.model ?? (svg ? MODELS.vector : MODELS.image);
    const endpoints = await this.imageEndpoints(model);
    const params = endpoints[0]?.supported_parameters ?? {};
    for (const p of ['resolution', 'aspect_ratio'] as const) {
      const allowed = params[p]?.values;
      if (args[p] !== undefined && (typeof args[p] !== 'string' || (allowed && !allowed.includes(args[p])))) throw new HttpError(400, `${p} for ${model} is one of ${allowed?.join(', ') ?? 'nothing'}`);
    }
    if (params.n?.max !== undefined && n > params.n.max) throw new HttpError(400, `${model} makes at most ${params.n.max} image${params.n.max === 1 ? '' : 's'} per call: call it again for more`);
    if (refs.length > (params.input_references?.max ?? 0)) throw new HttpError(400, `${model} takes at most ${params.input_references?.max ?? 0} input image${params.input_references?.max === 1 ? '' : 's'}`);
    const format = extname(out).slice(1).toLowerCase();
    // A transparent background (#732): the model's own when every endpoint it may route to lists one, else a matte here over black.
    if (args.background !== undefined && args.background !== 'transparent') throw new HttpError(400, 'background is "transparent" or left out');
    const clear = args.background !== 'transparent' ? null
      : endpoints.length && endpoints.every((ep) => ep.supported_parameters?.background?.values?.includes('transparent')) ? 'native' : 'matte';
    if (clear === 'native' && format !== 'png' && format !== 'webp') throw new HttpError(400, 'A transparent background needs out to end in .png or .webp');
    if (clear === 'matte' && format !== 'png') throw new HttpError(400, `${model} has no transparent background of its own, so Citadel mattes it from black: out must end in .png (or pick a model with one, like bytedance-seed/seedream-5-0-flash)`);
    const files = Array.from({ length: n }, (_, i) => target(out, n, i, args.overwrite === true));
    const sent = clear === 'matte' ? `${prompt}\n\n${BLACK_BACKGROUND}` : prompt;
    const estimate = imageEstimate(endpoints, { resolution: args.resolution, n, refs: refs.length, promptChars: sent.length });
    const id = this.reserve(userId, cap, ctx, 'image', model, estimate);
    const { value: images, cost } = await this.settled(userId, id, estimate!, async () => {
      const res = await this.request(key, 'POST', '/images', {
        model, n, prompt: sent,
        ...(clear === 'native' ? { background: 'transparent' } : {}),
        ...(args.resolution ? { resolution: args.resolution } : {}),
        ...(args.aspect_ratio ? { aspect_ratio: args.aspect_ratio } : {}),
        ...(params.output_format?.values?.includes(format) ? { output_format: format } : {}),
        ...(refs.length ? { input_references: refs.map((url) => ({ type: 'image_url', image_url: { url } })) } : {}),
      });
      const body = await res.json() as { id?: string; data?: { b64_json?: string; media_type?: string }[]; usage?: { cost?: number } };
      const images = (body.data ?? []).filter((d) => typeof d.b64_json === 'string');
      if (!images.length) throw new Error('the answer had no images');
      return { value: images, cost: body.usage?.cost ?? await this.generationCost(key, body.id) };
    });
    const paths: string[] = [];
    const warnings: string[] = [];
    for (const [i, img] of images.slice(0, n).entries()) {
      const raw = Buffer.from(img.b64_json!, 'base64');
      // A worker that fails keeps the paid-for image as sent, with the warning below.
      const matted = clear === 'matte' ? await matteBlackOff(raw).catch(() => null) : null;
      if (clear === 'matte' && !matted) warnings.push(`${basename(files[i])} came back in a form the matte can't read (${img.media_type ?? 'unknown'}), so it keeps its black background`);
      // Write what came back under its own extension (a jpeg asked for as .png stays a jpeg); a matted one is a png.
      const got = matted ? '.png' : MEDIA_TYPES[img.media_type ?? ''];
      let file = files[i];
      try {
        if (got && got !== extname(file).toLowerCase()) file = target(file.slice(0, -extname(file).length) + got, 1, 0, args.overwrite === true);
      } catch {} // that name is taken: keep the paid-for image under the asked name rather than lose it
      writeOutput(file, matted ?? raw, {
        tool: name, prompt, model, cost_usd: Math.round((cost / images.length) * 10000) / 10000, date, licence: licence(model),
        ...(args.resolution ? { resolution: args.resolution } : {}), ...(args.aspect_ratio ? { aspect_ratio: args.aspect_ratio } : {}),
        ...(inputs.length ? { refs: inputs } : {}),
        ...(clear ? { background: clear === 'native' ? 'transparent (native)' : matted ? 'transparent (matte)' : 'black (the matte could not read it)' } : {}),
      });
      paths.push(file);
    }
    this.store.setOpenrouterCallPath(id, paths.join('\n'));
    return { paths, cost_usd: cost, left_usd: this.left(userId, cap), model, ...(warnings.length ? { warnings } : {}) };
  }

  /**
   * Text read aloud (#808). `input` goes to OpenRouter exactly as given (phoneme tags, SSML, IPA,
   * whitespace): never trimmed or rewritten, and refused rather than cut when it's over the model's limit.
   */
  private async speech(userId: number, key: string, cap: number, args: Record<string, any>, ctx: ToolContext) {
    const { input, voice, instructions, speed } = args;
    if (typeof args.model !== 'string' || !/^[\w.-]+\/[\w.:-]+$/.test(args.model)) throw new HttpError(400, 'model is required: an OpenRouter speech model id, like fish-audio/drama-3');
    if (typeof input !== 'string' || !input.trim()) throw new HttpError(400, 'input is required: the text to read');
    if (voice !== undefined && (typeof voice !== 'string' || !voice || voice.length > 200)) throw new HttpError(400, 'voice is the model\'s voice id, a string');
    if (instructions !== undefined && (typeof instructions !== 'string' || instructions.length > 8000)) throw new HttpError(400, 'instructions is a string, at most 8000 characters');
    if (speed !== undefined && !(typeof speed === 'number' && speed >= 0.25 && speed <= 4)) throw new HttpError(400, 'speed is a number from 0.25 to 4 (1 is normal)');
    const out = outPath(args.out, ctx.roots, new Set(SPEECH_FORMATS.map((f) => `.${f}`)), ctx.place ?? MINION_PLACE);
    const format = args.response_format ?? extname(out).slice(1).toLowerCase();
    if (!SPEECH_FORMATS.includes(format)) throw new HttpError(400, 'response_format is mp3, wav or pcm');
    if (extname(out).toLowerCase() !== `.${format}`) throw new HttpError(400, `out must end in .${format} for response_format ${format}`);
    const model = args.model;
    const m = await this.model(model);
    const chars = [...input].length;
    const limit = speechLimit(m);
    if (chars > limit) throw new HttpError(400, `input is ${chars.toLocaleString('en-US')} characters, over the ${limit.toLocaleString('en-US')} ${model} takes: split it and make one clip per part.`);
    const file = target(out, 1, 0, args.overwrite === true);
    const estimate = speechEstimate(m, Buffer.byteLength(input) + Buffer.byteLength(instructions ?? ''));
    const id = this.reserve(userId, cap, ctx, 'speech', model, estimate);
    const { value: bytes, cost } = await this.settled(userId, id, estimate!, async () => {
      const res = await this.request(key, 'POST', '/audio/speech', {
        model, input, response_format: format,
        ...(voice !== undefined ? { voice } : {}), ...(instructions !== undefined ? { instructions } : {}), ...(speed !== undefined ? { speed } : {}),
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length) throw new Error('the answer had no audio');
      return { value: bytes, cost: await this.generationCost(key, res.headers.get('x-generation-id')) };
    });
    writeOutput(file, bytes, {
      tool: 'generate_speech', input, model, response_format: format, cost_usd: cost, date: new Date().toISOString(), licence: licence(model),
      ...(voice !== undefined ? { voice } : {}), ...(instructions !== undefined ? { instructions } : {}), ...(speed !== undefined ? { speed } : {}),
    });
    this.store.setOpenrouterCallPath(id, file);
    return { paths: [file], cost_usd: cost, left_usd: this.left(userId, cap), model };
  }

  /** A sound effect through the speech endpoint: raw MP3 back, no cost in the answer. */
  private async effect(userId: number, key: string, cap: number, ctx: ToolContext, model: string, input: string) {
    const m = await this.model(model);
    const perSecond = PER_SECOND_AUDIO.has(model) ? Number(m.pricing?.completion) : 0;
    const estimate = model.endsWith(':free') ? 0 : perSecond > 0 ? perSecond * EFFECT_SECONDS : perRequestPrice(m);
    const id = this.reserve(userId, cap, ctx, 'effect', model, estimate);
    return this.settled(userId, id, estimate!, async () => {
      const res = await this.request(key, 'POST', '/audio/speech', { model, input, response_format: 'mp3' });
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length) throw new Error('the answer had no audio');
      const seconds = mp3Seconds(bytes);
      const cost = await this.generationCost(key, res.headers.get('x-generation-id')) ?? (perSecond > 0 && seconds !== null ? perSecond * seconds : null);
      return { value: bytes, cost };
    });
  }

  /** Music through chat completions with audio out, which OpenRouter only streams. */
  private async music(userId: number, key: string, cap: number, ctx: ToolContext, model: string, prompt: string, format: 'mp3' | 'wav', seed?: number) {
    const estimate = model.endsWith(':free') ? 0 : perRequestPrice(await this.model(model));
    const id = this.reserve(userId, cap, ctx, 'music', model, estimate);
    return this.settled(userId, id, estimate!, async () => {
      const res = await this.request(key, 'POST', '/chat/completions', {
        model, messages: [{ role: 'user', content: prompt }], modalities: ['text', 'audio'], audio: { format }, stream: true, stream_options: { include_usage: true },
        ...(seed !== undefined ? { seed } : {}),
      });
      let audio = '';
      let cost: number | null = null;
      let genId: string | null = null;
      for await (const event of sse(res)) {
        genId ??= event.id ?? null;
        for (const c of event.choices ?? []) if (typeof c.delta?.audio?.data === 'string') audio += c.delta.audio.data;
        if (typeof event.usage?.cost === 'number') cost = event.usage.cost;
        if (event.error) throw new HttpError(502, `OpenRouter: ${String(event.error.message ?? 'the stream failed').slice(0, 300)}`);
      }
      if (!audio) throw new Error('the answer had no audio');
      return { value: Buffer.from(audio, 'base64'), cost: cost ?? await this.generationCost(key, genId) };
    });
  }

  /**
   * A text completion, booked against the cap like the media tools. Nothing calls it yet: it's here for
   * a use someone picks later (Cara, 2026-11-14: "set it up so it could be used for text models").
   */
  async chat(ctx: ToolContext, model: string, messages: { role: string; content: string }[], maxTokens = 1000) {
    const { key, cap } = this.key(ctx.userId);
    const m = await this.model(model);
    const chars = messages.reduce((n, msg) => n + msg.content.length, 0);
    const estimate = model.endsWith(':free') ? 0 : Number(m.pricing?.prompt) * chars + Number(m.pricing?.completion) * maxTokens;
    const id = this.reserve(ctx.userId!, cap, ctx, 'text', model, Number.isFinite(estimate) ? estimate : null);
    const { value, cost } = await this.settled(ctx.userId!, id, estimate, async () => {
      const res = await this.request(key, 'POST', '/chat/completions', { model, messages, max_tokens: maxTokens });
      const body = await res.json() as { id?: string; choices?: { message?: { content?: string } }[]; usage?: { cost?: number } };
      return { value: body.choices?.[0]?.message?.content ?? '', cost: body.usage?.cost ?? await this.generationCost(key, body.id) };
    });
    return { text: value, cost_usd: cost, left_usd: this.left(ctx.userId!, cap) };
  }
}

/** The events of a server-sent event stream's `data:` lines, as JSON. */
async function* sse(res: Response): AsyncGenerator<any> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {}
    }
  }
}

/** Who may use what a model made, as far as OpenRouter's model ids tell: the sidecar says to check before shipping. */
const licence = (model: string) => `Made with ${model} through OpenRouter; check the provider's terms before shipping it.`;

/** Where an output goes: inside one of `roots` (relative to the first), with an extension from `exts`. */
export function outPath(out: unknown, roots: string[], exts: Set<string>, place = MINION_PLACE): string {
  if (typeof out !== 'string' || !out.trim() || out.includes('\0')) throw new HttpError(400, 'out is the file to write, like art/hero.png');
  const file = resolve(roots[0], out.trim());
  if (!exts.has(extname(file).toLowerCase())) throw new HttpError(400, `out ends in ${[...exts].join(', ')}`);
  const root = roots.find((r) => file.startsWith(resolve(r) + sep));
  if (!root) throw new HttpError(400, `out must be inside ${place}`);
  // Check the real folder (symlinks followed) is still inside, before making the missing part of it and after.
  const realRoot = realpathSync(root);
  const inside = (dir: string) => {
    const real = realpathSync(dir);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new HttpError(400, `out must be inside ${place}`);
    return real;
  };
  let have = dirname(file);
  while (!existsSync(have)) have = dirname(have);
  inside(have);
  mkdirSync(dirname(file), { recursive: true });
  return join(inside(dirname(file)), basename(file));
}

/** The i-th of n files for `out` (name-1.png, name-2.png when n > 1), refused if it or its .json note is there and overwrite isn't set, or is a link. */
export function target(out: string, n: number, i: number, overwrite: boolean): string {
  const ext = extname(out);
  const file = n > 1 ? `${out.slice(0, -ext.length)}-${i + 1}${ext}` : out;
  for (const f of [file, `${file}.json`]) {
    const st = (() => {
      try {
        return lstatSync(f);
      } catch {
        return null;
      }
    })();
    if (st && (st.isSymbolicLink() || !st.isFile())) throw new HttpError(400, `${f} is there and isn't a plain file`);
    if (st && !overwrite) throw new HttpError(409, `${f} is already there: pick another out, or pass overwrite: true`);
  }
  return file;
}

export function writeOutput(file: string, bytes: Buffer, note: object) {
  writeFileSync(file, bytes);
  writeFileSync(`${file}.json`, `${JSON.stringify(note, null, 2)}\n`);
}

/** An input image as a data URL: a png, jpeg or webp inside the roots. */
async function inputImage(path: unknown, roots: string[], place: string): Promise<string> {
  if (typeof path !== 'string') throw new HttpError(400, 'Images to read are file paths');
  const found = await resolveFile(path, roots[0], roots, INPUT_IMAGE);
  if (!found) throw new HttpError(400, `${path}: no png, jpeg or webp there inside ${place}`);
  if (found.size > MAX_INPUT_BYTES) throw new HttpError(400, `${path} is over 20 MB`);
  const ext = extname(found.file).slice(1).toLowerCase();
  return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${(await readFile(found.file)).toString('base64')}`;
}

export const _test = { outPath, target };
