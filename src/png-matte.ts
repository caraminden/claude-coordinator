// The black-to-alpha matte (#732) for image models with no transparent background of their own: the
// model draws on plain black, and each pixel's opacity becomes its brightest channel, its colour divided
// back out, so the result laid over black is the picture the model sent. Right for glows and spell
// effects; dark parts of a subject go see-through, which is why models with real alpha are used first.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Past this many pixels (about 4K square) it's left alone rather than hold hundreds of MB. */
const MAX_PIXELS = 4096 * 4096;

/** An 8-bit RGB or RGBA, non-interlaced PNG's pixels as RGBA, or null for anything else. */
export function decodePng(buf: Buffer): { width: number; height: number; rgba: Buffer } | null {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
  let width = 0, height = 0, channels = 0;
  const idat: Buffer[] = [];
  for (let i = 8; i + 12 <= buf.length;) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colour, , , interlace] = data.subarray(8, 13);
      channels = colour === 2 ? 3 : colour === 6 ? 4 : 0;
      if (depth !== 8 || !channels || interlace !== 0 || !width || !height || width * height > MAX_PIXELS) return null;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  if (!channels || !idat.length) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[out + x - channels] : 0;
      const b = y ? px[out - stride + x] : 0;
      const c = y && x >= channels ? px[out - stride + x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1
        : filter === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : -1;
      if (pred < 0) return null;
      px[out + x] = (line[x] + pred) & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: px };
  const rgba = Buffer.alloc(width * height * 4, 0xff);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) px.copy(rgba, j, i, i + 3);
  return { width, height, rgba };
}

/** RGBA pixels as a PNG (filter 0 on every row; zlib does the rest). */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** `png` with black taken out as transparency, or null when it isn't a PNG this reads (it's then kept as sent). */
export function matteBlack(png: Buffer): Buffer | null {
  const img = decodePng(png);
  if (!img) return null;
  const px = img.rgba;
  for (let i = 0; i < px.length; i += 4) {
    const m = Math.max(px[i], px[i + 1], px[i + 2]);
    if (m) for (let k = 0; k < 3; k++) px[i + k] = Math.round((px[i + k] * 255) / m);
    px[i + 3] = Math.round((m * px[i + 3]) / 255);
  }
  return encodePng(img.width, img.height, px);
}
