// generate_speech with provider "azure" (#842): raw SSML to Azure Speech's REST endpoint, on the scheme's own key from the
// secret store (#838: AZURE_SPEECH_KEY and AZURE_SPEECH_REGION, saved as scheme secrets), cost booked to the scheme as
// outside spend (#839). The key goes only into the request header: never into the answer, a note file or a log.
import { extname } from 'node:path';
import { HttpError } from './http.ts';
import { outPath, target, writeOutput } from './openrouter.ts';
import type { SpendInput } from './outside-spend.ts';

export const AZURE_KEY = 'AZURE_SPEECH_KEY';
export const AZURE_REGION = 'AZURE_SPEECH_REGION';
export const DEFAULT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
/** Azure's list prices per million characters (pay as you go): neural voices, and the HD ones that cost twice as much. */
export const NEURAL_USD_PER_M = 15;
export const HD_USD_PER_M = 30;
/** A runaway input is refused before it is billed; Azure itself stops a clip at 10 minutes of audio. */
const MAX_SSML_CHARS = 100_000;

/** The file extension each output format family writes. */
export function formatExt(format: string): string {
  if (/mp3/.test(format)) return '.mp3';
  if (/^riff-/.test(format)) return '.wav';
  if (/^ogg-/.test(format)) return '.ogg';
  if (/^webm-/.test(format)) return '.webm';
  if (/^raw-/.test(format)) return '.pcm';
  if (/^amr-|^g722-/.test(format)) return '.bin';
  throw new HttpError(400, `output_format ${format}: Azure's output formats start with audio-, riff-, raw-, ogg- or webm- (like ${DEFAULT_FORMAT})`);
}

/** The characters Azure bills: the text between the tags (a break or a voice tag adds none). */
export function billedChars(ssml: string): number {
  return [...ssml.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '')].length;
}

/** What the call costs: HD voices if any voice in it is one (`...:DragonHDLatestNeural`), else neural. */
export function azureCost(ssml: string, chars: number): number {
  const hd = [...ssml.matchAll(/<voice\b[^>]*\bname\s*=\s*["']([^"']*)["']/gi)].some((m) => /HD/i.test(m[1]));
  return (chars * (hd ? HD_USD_PER_M : NEURAL_USD_PER_M)) / 1_000_000;
}

/** A whole `<speak>` document goes through byte for byte; anything else is wrapped in one (and in `<voice>` when a voice is given). */
export function buildSsml(input: string, voice: string | undefined, lang: string): string {
  if (/^\s*<speak[\s>]/i.test(input)) return input;
  const body = voice ? `<voice name="${voice.replace(/"/g, '&quot;')}">${input}</voice>` : input;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">${body}</speak>`;
}

export interface AzureDeps {
  secret(name: string): string | null;
  book(s: SpendInput): { month_usd: number; cap_usd: number | null; over_cap: boolean };
  fetch?: typeof fetch;
}
export interface AzureContext { roots: string[]; place?: string }

export async function azureSpeech(args: Record<string, any>, ctx: AzureContext, deps: AzureDeps) {
  const { input, voice } = args;
  if (typeof input !== 'string' || !input.trim()) throw new HttpError(400, 'input is required: the SSML (a whole <speak> document, or its inside) to read');
  if (voice !== undefined && (typeof voice !== 'string' || !/^[\w.:-]{1,200}$/.test(voice))) throw new HttpError(400, 'voice is an Azure voice name, like en-US-Ava:DragonHDLatestNeural');
  const lang = args.lang ?? 'en-US';
  if (typeof lang !== 'string' || !/^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) throw new HttpError(400, 'lang is a language tag, like en-US');
  const format = args.output_format ?? DEFAULT_FORMAT;
  if (typeof format !== 'string' || !/^[a-z0-9-]{1,80}$/.test(format)) throw new HttpError(400, `output_format is one of Azure's output format names, like ${DEFAULT_FORMAT}`);
  const ext = formatExt(format);
  const out = outPath(args.out, ctx.roots, new Set([ext]), ctx.place);
  if (extname(out).toLowerCase() !== ext) throw new HttpError(400, `out must end in ${ext} for ${format}`);
  const key = deps.secret(AZURE_KEY);
  const region = deps.secret(AZURE_REGION);
  if (!key || !region) throw new HttpError(400, `This scheme has no Azure Speech key: a member saves ${AZURE_KEY} and ${AZURE_REGION} (like westus2) as scheme secrets in Settings → Your account, or with a secret card.`);
  if (!/^[a-z0-9]+$/i.test(region.trim())) throw new HttpError(400, `${AZURE_REGION} is a region name like westus2`);
  const ssml = buildSsml(input, voice, lang);
  const chars = billedChars(ssml);
  if (chars > MAX_SSML_CHARS) throw new HttpError(400, `input is ${chars.toLocaleString('en-US')} characters of text, over the ${MAX_SSML_CHARS.toLocaleString('en-US')} one call takes: split it and make one clip per part.`);
  const file = target(out, 1, 0, args.overwrite === true);
  const r = await (deps.fetch ?? fetch)(`https://${region.trim()}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key.trim(), 'content-type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': format, 'user-agent': 'citadel' },
    body: ssml,
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) {
    // Never the request or the answer's text: the status and Azure's reason phrase say enough, and the key is in the request.
    throw new HttpError(r.status === 401 || r.status === 403 ? 400 : r.status === 429 ? 429 : 502, `Azure Speech answered ${r.status}${r.status === 401 || r.status === 403 ? ': the key or region saved for this scheme is refused' : r.status === 400 ? ': it refused the SSML (check the voice name and tags)' : ''}`);
  }
  const bytes = Buffer.from(await r.arrayBuffer());
  if (!bytes.length) throw new HttpError(502, 'Azure Speech answered with no audio');
  const cost = azureCost(ssml, chars);
  writeOutput(file, bytes, { tool: 'generate_speech', provider: 'azure', ssml, output_format: format, chars, cost_usd: cost, date: new Date().toISOString() });
  const booked = deps.book({ service: 'azure-speech', usd: cost, units: chars, note: `generate_speech ${file.split('/').pop()}` });
  return { paths: [file], cost_usd: cost, month_usd: booked.month_usd, cap_usd: booked.cap_usd, over_cap: booked.over_cap, model: 'azure-speech' };
}
