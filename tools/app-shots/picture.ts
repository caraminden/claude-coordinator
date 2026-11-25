// The pictures of the nightly contraption screenshots (#1783): reading the PNG Chromium wrote, whether it is blank, and how
// much of it moved since the night before. Pure and slow (it unpacks whole pictures), so only tools run it, never the server.
import { inflateSync } from 'node:zlib';

export interface Picture {
  width: number;
  height: number;
  /** Three bytes a pixel. */
  rgb: Uint8Array;
}

/** An 8-bit RGB or RGBA PNG (what Page.captureScreenshot writes), its alpha dropped. Anything else throws. */
export function readPng(buf: Buffer): Picture {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const width = buf.readUInt32BE(16),
    height = buf.readUInt32BE(20),
    [depth, colour, , , interlace] = buf.subarray(24, 29);
  const bpp = colour === 2 ? 3 : colour === 6 ? 4 : 0;
  if (depth !== 8 || !bpp || interlace) throw new Error(`a PNG kind this doesn't read (depth ${depth}, colour ${colour})`);
  const parts: Buffer[] = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(at);
    if (buf.toString('latin1', at + 4, at + 8) === 'IDAT') parts.push(buf.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) throw new Error('the PNG is cut short');
  const rgb = new Uint8Array(width * height * 3);
  let prev = new Uint8Array(stride),
    cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const from = y * (stride + 1),
      filter = raw[from];
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0,
        b = prev[i],
        c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c,
          pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = raw[from + 1 + i] + add;
    }
    for (let x = 0; x < width; x++) rgb.set(cur.subarray(x * bpp, x * bpp + 3), (y * width + x) * 3);
    [prev, cur] = [cur, prev];
  }
  return { width, height, rgb };
}

/** The share of pixels in the picture's most common colour (to 8 levels a channel). */
export function flatShare(p: Picture): number {
  const n = new Uint32Array(512);
  for (let i = 0; i < p.rgb.length; i += 3) n[bucket(p.rgb, i)]++;
  return Math.max(...n) / (p.rgb.length / 3);
}

/** A pixel's colour to three bits a channel. */
const bucket = (rgb: Uint8Array, i: number) => ((rgb[i] >> 5) << 6) | ((rgb[i + 1] >> 5) << 3) | (rgb[i + 2] >> 5);

/** Cells per row the two pictures are cut into for a compare: small enough to see a missing bar, big enough that moved text is one cell's noise. */
const CELLS = 48;
/** A cell whose mean colour moved by less than this (of 255) is the same: antialiasing, a blinking caret, a changed digit. */
const CELL_DIFF = 10;
/** Content is never taken as less than this share of the page, so one toast on an empty page isn't all of it. */
const LEAST_CONTENT = 0.1;

/** The page's most common colour, as the mean of its pixels in the fullest bucket. */
export function background(p: Picture): number[] {
  const n = new Uint32Array(512),
    sum = new Float64Array(512 * 3);
  for (let i = 0; i < p.rgb.length; i += 3) {
    const k = bucket(p.rgb, i);
    n[k]++;
    for (let c = 0; c < 3; c++) sum[k * 3 + c] += p.rgb[i + c];
  }
  let top = 0;
  for (let k = 1; k < 512; k++) if (n[k] > n[top]) top = k;
  return [0, 1, 2].map((c) => sum[top * 3 + c] / (n[top] || 1));
}

function cells(p: Picture): { rows: number; mean: Float64Array } {
  const size = p.width / CELLS,
    rows = Math.max(1, Math.round(p.height / size));
  const mean = new Float64Array(CELLS * rows * 3),
    n = new Uint32Array(CELLS * rows);
  for (let y = 0; y < p.height; y++) {
    const r = Math.min(rows - 1, Math.floor(y / size));
    for (let x = 0; x < p.width; x++) {
      const c = r * CELLS + Math.min(CELLS - 1, Math.floor(x / size)),
        i = (y * p.width + x) * 3;
      n[c]++;
      for (let k = 0; k < 3; k++) mean[c * 3 + k] += p.rgb[i + k];
    }
  }
  for (let c = 0; c < n.length; c++) for (let k = 0; k < 3; k++) mean[c * 3 + k] /= n[c] || 1;
  return { rows, mean };
}

/** Whether cell c differs from a colour (or from the other picture's cell at `at`). */
const differs = (mean: Float64Array, c: number, from: ArrayLike<number>, at = 0) => [0, 1, 2].some((k) => Math.abs(mean[c * 3 + k] - from[at + k]) >= CELL_DIFF);

/**
 * How much of the page's content moved, 0 to 1: the cells whose colour changed, and the ones only one picture has, over the
 * cells either picture drew something in. A share of the content and not of the page, so a sparse page losing all it shows
 * is 1, not the few percent it filled.
 */
export function changed(a: Picture, b: Picture): number {
  if (a.width !== b.width) return 1;
  const [x, y] = [cells(a), cells(b)],
    [bgA, bgB] = [background(a), background(b)];
  const rows = Math.max(x.rows, y.rows);
  let moved = 0,
    content = 0;
  for (let c = 0; c < rows * CELLS; c++) {
    const inA = c < x.rows * CELLS,
      inB = c < y.rows * CELLS;
    const diff = inA && inB ? differs(x.mean, c, y.mean, c * 3) : (inA && differs(x.mean, c, bgA)) || (inB && differs(y.mean, c, bgB));
    if (diff) moved++;
    if (diff || (inA && differs(x.mean, c, bgA)) || (inB && differs(y.mean, c, bgB))) content++;
  }
  return moved / Math.max(content, rows * CELLS * LEAST_CONTENT);
}
