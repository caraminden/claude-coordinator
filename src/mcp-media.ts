// The generative media tools (#717, #733), split out of mcp.ts: their descriptions, schemas and the Codex image call.
import { spawn } from 'node:child_process';

export const MEDIA_COMMON =
  'The server makes the call with the key of the person this turn runs for and books it against their monthly cap; a call that would pass the cap, or costs over $0.50, is refused before anything is spent. Writes the file(s) inside your worktree or shared folders with a `<file>.json` note (prompt, model, cost). Returns the paths, what it cost and what is left this month. One take at the default first; more takes or a dearer model only when asked or when the first misses.';
export const IMAGE_MODELS = ' Models: leave model out for black-forest-labs/flux-3-image-klein, or recraft/recraft-v4.1-vector when out ends in .svg. For readable text in the image or careful edits, google/gemini-nano-banana-2.1 or openai/gpt-image-2, which cost several times more.';
export const MEDIA_OUT = 'Where to write it, inside your worktree or a shared folder (relative paths start in your worktree). With n over 1 the files are numbered: art-1.png, art-2.png';
export const MEDIA_MODEL = { type: 'string', description: 'Optional: an OpenRouter model id. Leave it out for the cheap default' };
export const MEDIA_OVERWRITE = { type: 'boolean', description: 'Replace a file that already exists (default false: refused)' };
export const IMAGE_PROPS = {
  prompt: { type: 'string', maxLength: 8000, description: 'What to draw' },
  out: { type: 'string', description: `${MEDIA_OUT}. .png or .webp, or .svg for a vector model` },
  model: MEDIA_MODEL,
  resolution: { type: 'string', description: "Optional: one of the model's sizes, like 1K or 2K (an unknown one is refused with the list)" },
  aspect_ratio: { type: 'string', description: 'Optional: like 1:1, 16:9 or 9:16 (an unknown one is refused with the list)' },
  n: { type: 'integer', minimum: 1, maximum: 4, description: 'How many takes (default 1)' },
  background: { type: 'string', enum: ['transparent'], description: 'Optional: "transparent" for a see-through background (.png out). Models with their own (seedream, gpt-image-1) make real alpha; on others the server asks for black and takes it out, which suits glows but turns dark parts see-through' },
  refs: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Optional: reference images (png, jpeg or webp paths) for style or subject' },
  overwrite: MEDIA_OVERWRITE,
};
/**
 * Every generative media tool opens with this (Cara, 2026-11-14: "image via code should ABSOLUTELY be the default
 * unless using a system (like I described for making spell alerts) or explicitly asking for a generative model").
 * test/media-tools.test.ts pins it. Since #1576 it is the one home of the rule that was the Citadel-wide "Images by code"
 * section: make images and sounds with code; a generative tool (generate_image_codex too) only when a person asks for
 * one or a scheme system uses one (src/rule-homes.ts, id images-by-code).
 */
export const NOT_DEFAULT = "Only on a person's explicit ask or a scheme system's call; otherwise draw with code.";
export const NOT_DEFAULT_AUDIO = "Only on a person's explicit ask or a scheme system's call; otherwise make sound with code.";
/** Which generative tool makes what (Cara, 2026-11-14, "Codex for raster images"). */
export const IMAGE_ROUTING = "Raster images (PNG) go to generate_image_codex, on the person's ChatGPT plan; use this tool for SVG (Recraft), and for a PNG only when generate_image_codex refuses (no Codex login, or a Codex limit is near).";
export const MEDIA_TOOL_LIST = [
  { name: 'generate_image', description: `${NOT_DEFAULT} Then: make an image from a prompt through OpenRouter. ${IMAGE_ROUTING} ${MEDIA_COMMON}${IMAGE_MODELS}`, inputSchema: { type: 'object', properties: IMAGE_PROPS, required: ['prompt', 'out'] } },
  {
    name: 'edit_image',
    description: `${NOT_DEFAULT} Then: change an existing image as the prompt says, through OpenRouter (the result goes to out; the original stays). ${IMAGE_ROUTING} ${MEDIA_COMMON}${IMAGE_MODELS}`,
    inputSchema: { type: 'object', properties: { image: { type: 'string', description: 'The image to edit: a png, jpeg or webp path' }, ...IMAGE_PROPS }, required: ['image', 'prompt', 'out'] },
  },
  {
    name: 'generate_audio',
    description: `${NOT_DEFAULT_AUDIO} Then: make a sound effect or a short music clip from a prompt through OpenRouter. ${MEDIA_COMMON} Models: effects default to bytedance-seed/seed-audio-1-0 (priced by the second), music to google/lyria-3-clip-preview.`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['effect', 'music'], description: 'effect: a short sound (.mp3); music: a clip of about 30 seconds (.mp3 or .wav)' },
        prompt: { type: 'string', maxLength: 8000, description: 'What it should sound like' },
        out: { type: 'string', description: `${MEDIA_OUT.replace(/\. With n.*/, '')}. .mp3, or .wav for music` },
        seconds: { type: 'number', description: 'Optional, effects: roughly how long, up to 60' },
        seed: { type: 'integer', minimum: 0, description: 'Optional, music: the same seed with a tweaked prompt keeps more of the last clip (models without one refuse it)' },
        model: MEDIA_MODEL,
        overwrite: MEDIA_OVERWRITE,
      },
      required: ['kind', 'prompt', 'out'],
    },
  },
  {
    name: 'generate_speech',
    description: `${NOT_DEFAULT_AUDIO} Then: read text aloud with a text-to-speech model through OpenRouter (#808). ${MEDIA_COMMON} The cost is checked from the input's length in UTF-8 bytes before the call, since OpenRouter lists speech prices per character, byte or token without saying which.`,
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ['openrouter', 'azure'],
          description:
            "Optional, default openrouter. azure: Azure Speech on this scheme's own key (scheme secrets AZURE_SPEECH_KEY and AZURE_SPEECH_REGION); input is raw SSML (<phoneme> IPA, <prosody>, <break>, several <voice> elements, HD voices like en-US-Ava:DragonHDLatestNeural), model and response_format aren't used, and the cost (about $15 per million characters of text, $30 for HD voices) is booked to the scheme's outside spend",
        },
        output_format: { type: 'string', description: 'azure only, optional: the Azure output format, default audio-24khz-48kbitrate-mono-mp3; out must end in the extension it makes (.mp3, .wav for riff-*, .ogg, .webm, .pcm for raw-*)' },
        lang: { type: 'string', description: 'azure only, optional: xml:lang when input is not a whole <speak> document, default en-US' },
        model: { type: 'string', description: 'An OpenRouter speech model id, like fish-audio/drama-3, elevenlabs/eleven-v3 or google/gemini-3.8-flash-tts. Required unless provider is azure' },
        input: { type: 'string', description: "The text to read. Sent byte for byte: inline pronunciation markup the model takes (Fish's <|phoneme_start|>klˈɛbkɪtʃ<|phoneme_end|>, SSML, IPA) goes through untouched. Over the model's limit is refused, never cut: split long text" },
        voice: { type: 'string', description: "Optional: the model's voice id (some models need one)" },
        response_format: { type: 'string', enum: ['mp3', 'wav', 'pcm'], description: "Optional: taken from out's extension. OpenRouter lists mp3 and pcm; some models give only one (Gemini and HeyGen only pcm), and the rest are refused for free" },
        instructions: { type: 'string', description: 'Optional: how to read it (tone, pace); only some models (OpenAI, Gemini, Fish) heed it' },
        speed: { type: 'number', minimum: 0.25, maximum: 4, description: 'Optional: 1 is normal' },
        out: { type: 'string', description: `${MEDIA_OUT.replace(/\. With n.*/, '')}. .mp3, .wav or .pcm, matching response_format` },
        overwrite: MEDIA_OVERWRITE,
      },
      required: ['input', 'out'],
    },
  },
];

/** A PNG through Codex's built-in image_gen on the person's own ChatGPT login (#733): listed for every minion, refused on a turn whose person has no Codex login it can reach (#878, mcp.ts). */
export const CODEX_IMAGE_TOOL = {
  name: 'generate_image_codex',
  description: `${NOT_DEFAULT} Then: make or edit a PNG with Codex's built-in image generation (OpenAI gpt-image) on the ChatGPT plan of the person this turn runs for, with no per-image charge. For a raster image this is the generative tool to use; SVG and sound go to OpenRouter's generate_image and generate_audio, and so does a PNG when this one refuses because a Codex limit is near (it reads their 5-hour and weekly limits first and refuses at 80% of either, leaving the rest for their own work). To edit, pass the image in refs and say what to change. No size or aspect setting: say the shape you want in the prompt. Writes the .png and returns its absolute path: link it as ![caption](/abs/path). Takes a minute or two. One take first; more only when asked or when it misses.`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', maxLength: 8000, description: 'What to draw, or for an edit what to change' },
      out: { type: 'string', description: 'Where to write it, a .png inside your worktree or a shared folder (relative paths start in your worktree)' },
      refs: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Optional: images (png, jpg, gif or webp paths in your worktree or the shared folders) to edit or to take style or subject from' },
      transparent: { type: 'boolean', description: 'Optional: a transparent background (default false)' },
      overwrite: MEDIA_OVERWRITE,
    },
    required: ['prompt', 'out'],
  },
};

/** generate_image_codex: one --image-gen run of citadel-codex-review (src/codex-review.ts), which reaches the person's Codex as their reviews do, in the calling turn's env and folder. */
export async function codexImage(args: Record<string, unknown>, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt is required');
  if (typeof args.out !== 'string' || !args.out) throw new Error('out is required: a .png path');
  const refs = args.refs ?? [];
  if (!Array.isArray(refs) || refs.some((r: unknown) => typeof r !== 'string' || !r)) throw new Error('refs must be a list of image paths');
  const argv = ['--image-gen', '--timeout', '600', '--out', args.out, ...(args.transparent === true ? ['--transparent'] : []), ...(args.overwrite === true ? ['--overwrite'] : []), ...refs.flatMap((r: string) => ['--image', r])];
  const r = await new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const child = spawn('citadel-codex-review', argv, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err = (err + b).slice(-4000)));
    child.on('error', (e) => done({ code: null, out, err: e.message }));
    child.on('close', (code) => done({ code, out, err }));
    child.stdin.on('error', () => {});
    child.stdin.end(args.prompt);
  });
  const usage = /^Codex usage: .*$/m.exec(r.err)?.[0];
  const why = r.err
    .replace(/^Codex usage: .*$/m, '')
    .replace(/^citadel-codex-review: /gm, '')
    .trim();
  if (r.code === 0) return `${r.out.trim()} with Codex on this person's ChatGPT plan.${usage ? ` ${usage}.` : ''}`;
  if (r.code === 4) throw new Error(`${why} Use generate_image (OpenRouter) for this one; it refuses too when the person has no OpenRouter key.`);
  throw new Error(`Codex couldn't make the image${r.code === null ? '' : ` (exit ${r.code})`}: ${why || 'no reason given'}`);
}
