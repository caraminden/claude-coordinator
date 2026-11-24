// A picture's width and height from its first bytes (#960): PNG, JPEG, GIF and WebP, the kinds people paste.

/** { w, h } of a PNG, JPEG, GIF or WebP, or null when the bytes aren't one it can read. */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') return ok(b.readUInt32BE(16), b.readUInt32BE(20));
  if (b.length >= 10 && b.toString('latin1', 0, 4) === 'GIF8') return ok(b.readUInt16LE(6), b.readUInt16LE(8));
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return ok(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return ok(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
    }
    if (kind === 'VP8 ') return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the segments to the first start-of-frame (SOF0-SOF15, but not DHT, JPG or DAC).
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

const ok = (w: number, h: number) => (w > 0 && h > 0 ? { w, h } : null);
