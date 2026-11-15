import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { decodePng, encodePng, matteBlack, matteBlackOff } from '../src/png-matte.ts';

// The black-to-alpha matte (#732): opacity from the brightest channel, colour divided back out.

/** An 8-bit RGB PNG with each row's own filter byte, built by hand (the rows are the filtered bytes). */
function rgbPng(width: number, rows: number[][]): Buffer {
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
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(rows.flat()))), chunk('IEND', Buffer.alloc(0))]);
}

test('RGBA pixels survive an encode and decode', () => {
  const rgba = Buffer.from([1, 2, 3, 4, 250, 251, 252, 253, 0, 0, 0, 0, 9, 8, 7, 255]);
  assert.deepEqual(decodePng(encodePng(2, 2, rgba)), { width: 2, height: 2, rgba });
});

test('an RGB PNG using every row filter decodes to the right pixels, opaque', () => {
  // Two pixels a row, all wanting (10,20,30) then (40,50,60).
  const png = rgbPng(2, [
    [0, 10, 20, 30, 40, 50, 60], // none
    [1, 10, 20, 30, 30, 30, 30], // sub: left + delta
    [2, 0, 0, 0, 0, 0, 0], // up
    [3, 5, 10, 15, 15, 15, 15], // average: floor((left + up) / 2)
    [4, 0, 0, 0, 0, 0, 0], // Paeth picks up on a flat column
  ]);
  const img = decodePng(png)!;
  assert.equal(img.height, 5);
  for (let y = 0; y < 5; y++) assert.deepEqual([...img.rgba.subarray(y * 8, y * 8 + 8)], [10, 20, 30, 255, 40, 50, 60, 255], `row ${y}`);
});

test('the matte: black goes clear, white stays, a dim colour becomes its bright self at part opacity', () => {
  const rgba = Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 128, 0, 0, 255, 64, 32, 0, 128]);
  const out = decodePng(matteBlack(encodePng(4, 1, rgba))!)!.rgba;
  assert.deepEqual([...out], [0, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 128, 255, 128, 0, 32]);
});

test('anything the matte cannot read is left for the caller to keep as sent', () => {
  assert.equal(matteBlack(Buffer.from('fake png bytes')), null);
  const ihdr16 = rgbPng(1, [[0, 1, 2, 3]]);
  ihdr16[24] = 16; // bit depth 16 (the CRC no longer matches; the reader doesn't check it)
  assert.equal(decodePng(ihdr16), null);
  const shortHeader = Buffer.concat([rgbPng(1, [[0, 1, 2, 3]]).subarray(0, 8), Buffer.from([0, 0, 0, 4]), Buffer.from('IHDR'), Buffer.alloc(8 + 21)]);
  assert.equal(decodePng(shortHeader), null, 'a broken header is unreadable, not a throw');
});

test('the matte off the server\'s thread gives the same pixels', async () => {
  const png = encodePng(2, 1, Buffer.from([0, 0, 0, 255, 128, 0, 0, 255]));
  assert.deepEqual(await matteBlackOff(png), matteBlack(png));
  assert.equal(await matteBlackOff(Buffer.from('nope')), null);
});
