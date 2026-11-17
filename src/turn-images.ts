// Images on a contraption turn (#834): paths inside the app's own DATA_DIR, downscaled and sent as image
// content in the turn's first user message. Citadel keeps nothing beyond what the turn already does.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { HttpError } from './http.ts';

const run = promisify(execFile);

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

async function downscale(path: string): Promise<Buffer> {
  // `>` shrinks only; `[0]` takes the first frame of a GIF or a multi-page file.
  const args = [`${path}[0]`, '-auto-orient', '-resize', `${IMAGE_LONG_SIDE}x${IMAGE_LONG_SIDE}>`, '-background', 'white', '-flatten', '-quality', '85', 'jpeg:-'];
  try {
    const { stdout } = await run('magick', args, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
    return stdout;
  } catch {
    throw new HttpError(400, `${path.split(sep).pop()} isn't an image Citadel can read`);
  }
}
