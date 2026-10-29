// Files people attach in the composer: streamed into a thread's files folder under uploads/.
import { mkdir, open, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { HttpError } from './http.ts';

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_UPLOADS = 20;

/** Kept close to the original, but safe on disk, in a shell and in a Markdown link: no slashes, dots up front or brackets. */
export function safeFileName(raw: string): string {
  const base = basename(String(raw).replace(/\\/g, '/'))
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\p{M} ._()+,=@-]/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|\s+$/g, '');
  if (!base) return 'file';
  const ext = extname(base).slice(0, 20);
  const chars = Array.from(base); // by code point, so a cut never splits a letter in two
  return chars.length <= 150 ? base : chars.slice(0, 150 - Array.from(ext).length).join('').trimEnd() + ext;
}

/** Whether a name could have come from safeFileName (or its " (2)" de-duplicates): one plain name inside the folder. */
export const isUploadName = (name: string) => /^[\p{L}\p{N}\p{M}_()+,=@][\p{L}\p{N}\p{M} ._()+,=@-]{0,199}$/u.test(name);

/** Image and PDF uploads open in the browser; everything else only downloads (never rendered: an upload may be HTML or SVG). */
const INLINE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.pdf']);
export const opensInline = (name: string) => INLINE.has(extname(name).toLowerCase());

export class UploadTooLarge extends HttpError {
  constructor() {
    super(413, 'Files must be under 200 MB');
  }
}

/**
 * Stream `body` into `dir` under the safe form of `rawName`, never overwriting: a second
 * sprite.png lands as "sprite (2).png". Over `max` bytes, or if the upload breaks off, the
 * partial file is removed.
 */
export async function saveUpload(dir: string, rawName: string, body: AsyncIterable<Buffer>, max = MAX_UPLOAD_BYTES) {
  await mkdir(dir, { recursive: true });
  const name = safeFileName(rawName);
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let path = '';
  let file;
  for (let n = 1; !file; n++) {
    path = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    try {
      file = await open(path, 'wx');
    } catch (err: any) {
      if (err.code !== 'EEXIST' || n > 999) throw err;
    }
  }
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.length;
      if (size > max) throw new UploadTooLarge();
      await file.write(chunk);
    }
  } catch (err) {
    await file.close();
    await rm(path, { force: true });
    throw err;
  }
  await file.close();
  return { name: basename(path), path, size };
}
