// Images on a contraption turn (#834): paths inside the app's own DATA_DIR, downscaled and sent as image
// content in the turn's first user message. Citadel keeps nothing beyond what the turn already does.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { HttpError } from './http.ts';

export const MAX_IMAGES = 8;
/** The files' total size on disk, before downscaling. */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
export const IMAGE_LONG_SIDE = 1568;

export interface ImageBlock {
  media_type: 'image/jpeg';
  data: string;
}

/** Check `paths` against the app's data folder and the caps, then return each image as a 1568 px JPEG in base64. */
export async function loadImages(paths: unknown, dataDir: string, caps: { maxBytes?: number } = {}): Promise<ImageBlock[]> {
  if (!Array.isArray(paths)) throw new HttpError(400, 'images must be a list of paths');
  if (paths.length > MAX_IMAGES) throw new HttpError(413, `Too many images: the count cap is ${MAX_IMAGES}, you sent ${paths.length}`);
  const root = await fs.realpath(dataDir).catch(() => null);
  if (!root) throw new HttpError(400, 'The app has no data folder to read images from');
  const files: { path: string; size: number }[] = [];
  let total = 0;
  for (const p of paths) {
    if (typeof p !== 'string' || !p || p.includes('\0')) throw new HttpError(400, 'Each image must be a path (text)');
    // Resolve symlinks and `..` first; only then ask whether it is inside.
    const real = await fs.realpath(isAbsolute(p) ? p : join(root, p)).catch(() => null);
    if (real === null) {
      // Missing: still refuse a path that would be outside, so the answer doesn't reveal what exists elsewhere.
      const lexical = isAbsolute(p) ? p : join(root, p);
      if (!lexical.startsWith(root + sep)) throw new HttpError(400, `${p} is outside the app's data folder`);
      throw new HttpError(400, `No image at ${p}`);
    }
    if (!real.startsWith(root + sep)) throw new HttpError(400, `${p} is outside the app's data folder`);
    const st = await fs.stat(real);
    if (!st.isFile()) throw new HttpError(400, `${p} isn't a file`);
    total += st.size;
    files.push({ path: real, size: st.size });
  }
  const max = caps.maxBytes ?? MAX_IMAGE_BYTES;
  if (total > max) throw new HttpError(413, `Images too big: the total size cap is ${max} bytes, you sent ${total}`);
  const out: ImageBlock[] = [];
  for (const f of files) out.push({ media_type: 'image/jpeg', data: (await downscale(f.path)).toString('base64') });
  return out;
}

/** The decoder to force, by the file's first bytes: magick otherwise picks one from the content (SVG and MVG can read other files). */
function sniff(b: Buffer): string | null {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b.subarray(0, 2).toString('latin1') === 'BM') return 'bmp';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)) return 'tiff';
  return null;
}

// Two at a time: magick is heavy and the box is shared.
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  while (running >= 2) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function downscale(path: string): Promise<Buffer> {
  const name = path.split(sep).pop();
  const bytes = await fs.readFile(path);
  const fmt = sniff(bytes);
  if (!fmt) throw new HttpError(400, `${name} isn't a PNG, JPEG, GIF, WebP, BMP or TIFF image`);
  // The bytes go in on stdin with the decoder named, so a file name's brackets or wildcards mean nothing to magick.
  // `>` shrinks only; `[0]` takes the first frame.
  const args = ['-limit', 'area', '100MP', '-limit', 'memory', '512MiB', '-limit', 'disk', '1GiB', `${fmt}:-[0]`, '-auto-orient', '-resize', `${IMAGE_LONG_SIDE}x${IMAGE_LONG_SIDE}>`, '-background', 'white', '-flatten', '-quality', '85', 'jpeg:-'];
  return slot(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        const fail = () => reject(new HttpError(400, `${name} isn't an image Citadel can read`));
        const child = spawn('magick', args, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 30_000 });
        const out: Buffer[] = [];
        child.stdout.on('data', (d) => out.push(d));
        child.on('error', fail);
        child.stdin.on('error', () => {});
        child.on('close', (code) => (code === 0 && out.length ? resolve(Buffer.concat(out)) : fail()));
        child.stdin.end(bytes);
      }),
  );
}
