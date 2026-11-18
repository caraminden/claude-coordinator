// Minions' marks on pictures (#960): the size read from a picture's bytes, the marks title both ways, the overlay
// the chat draws, the mark-image route's checks, and the line that tells a turn where a pasted picture is.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { imageSize } from '../src/image-size.ts';
import { marksTitle, parseMarks } from '../public/ui/marks.js';
import { renderMarkdown } from '../public/ui/markdown.js';
import { markImage } from '../src/routes/files.ts';
import { promptMessage } from '../src/prompts.ts';

// 37x21 gradients made by ImageMagick: lossy WebP (VP8), lossless (VP8L) and lossy with alpha (VP8X).
const IMAGES: Record<string, string> = {
  'img.png': 'iVBORw0KGgoAAAANSUhEUgAAACUAAAAVEAIAAAAeFmy6AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRP///////wlY99wAAAAHdElNRQfqCxIJEii0W9/nAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTExLTE4VDA5OjE4OjQwKzAwOjAw6dtIRgAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0xMS0xOFQwOToxODo0MCswMDowMJiG8PoAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMTEtMThUMDk6MTg6NDArMDA6MDDPk9ElAAAAZ0lEQVRYw+2YwQkAIQwEJ3DP2Ixn/xWc1SR/rwoJLk4FO8goaGshjEUHn9UzdvHEgCas90L7qmfs1RM/PV29HNpXy23vXNT1Uv/d89vemcjrabeXt71zkdeTbs98QvTqGdv0AHT/W35/fSpCG/HUMQAAAABJRU5ErkJggg==',
  'img.jpg': '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAVACUDAREAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAYI/8QAGhAAAgIDAAAAAAAAAAAAAAAAABUDFFFhYv/EABcBAQEBAQAAAAAAAAAAAAAAAAAIBgn/xAAZEQADAQEBAAAAAAAAAAAAAAAAFmIEFVH/2gAMAwEAAhEDEQA/AMvttmcTJOh7bQbbCZIbaDbYTJDbQbbCZIbaDbYTJDbRGteitkuSYW2g16CXIbaDXoJchtoNeglyG2g16CXIbaJG7NkqTg5fCb+3oF2bI4OXwdvQLs2Rwcvg7egXZsjg5fB29AuzZHBy+Dt6D//Z',
  'img.gif': 'R0lGODlhJQAVAPQAAP8AAPIADeYAGtkAJswAM78AQLMATaYAWZkAZowAc3MAjGYAmVkApk0As0AAvzMAzCYA2RoA5g0A8gAA/4AAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACH5BAAAAAAALAAAAAAlABUAAAWvICCOZGmeKBCsbOu+cBwIdG3feK4LQ+//wKBwOCAYj8ikcskkFJ7QqHRKrRYM2Kx2y+16DYeweEwum88HhHrNbrvfcERiTq/b7/h8gsLv+/+AgYIUCoWGh4iJiosKC46PkJGSk5QLDJeYmZqbnJ0MDaChoqOkpaYNDqmqq6ytrq8OD7KztLW2t7gPELu8vb6/wMEQEcTFxsfIycoREs3Oz9DR0tMSE9bX2Nna29wTIQA7',
  'img.webp': 'UklGRnoAAABXRUJQVlA4IG4AAABQBQCdASolABUAPpE+mkk/IyKhJWzL4BIJaADOK4H5B+JPCBF/+0AAVo35K3H8RvRr8oAA/vCzr+e0PhJeUCpOn1azV//65zfnOXHvKf4Q6XB1M8Xmq8Kc3ZXnvLjZ+gZ9DzroIOKyCbelAAAAAA==',
  'imgl.webp': 'UklGRjwAAABXRUJQVlA4TC8AAAAvJAAFALmM6H/sIqL/ASFBwv/pRpOQgPD/Lp1AIIUBfAgJCBJTDBJ5g25gUSy3AQA=',
  'imga.webp': 'UklGRp4AAABXRUJQVlA4WAoAAAAQAAAAJAAAFAAAQUxQSAoAAAABB1DAiAhERP8DVlA4IG4AAABQBQCdASolABUAPpE+mkk/IyKhJWzL4BIJaADOK4H5B+JPCBF/+0AAVo35K3H8RvRr8oAA/vCzr+e0PhJeUCpOn1azV//65zfnOXHvKf4Q6XB1M8Xmq8Kc3ZXnvLjZ+gZ9DzroIOKyCbelAAAAAA==',
};
const bytes = (name: string) => Buffer.from(IMAGES[name], 'base64');

test('a picture\'s size comes from its bytes, for each kind people paste', () => {
  for (const name of Object.keys(IMAGES)) assert.deepEqual(imageSize(bytes(name)), { w: 37, h: 21 }, name);
  for (const junk of ['', 'hello', '<svg width="5" height="5"/>']) assert.equal(imageSize(Buffer.from(junk)), null);
  assert.equal(imageSize(bytes('img.png').subarray(0, 20)), null);
});

const TITLE = 'marks 1000x500: box 10 20 30 40; arrow yellow 50 50 60 10; pin 2 70 80; label 5 90 Click here';

test('a marks title reads into marks in pixels and writes back the same', () => {
  const p = parseMarks(TITLE);
  assert.deepEqual(p, {
    w: 1000, h: 500, marks: [
      { tool: 'box', colour: 'red', pts: [{ x: 100, y: 100 }, { x: 300, y: 200 }] },
      { tool: 'arrow', colour: 'yellow', pts: [{ x: 500, y: 250 }, { x: 600, y: 50 }] },
      { tool: 'pin', colour: 'red', pts: [{ x: 700, y: 400 }], n: 2 },
      { tool: 'label', colour: 'red', pts: [{ x: 50, y: 450 }], text: 'Click here' },
    ],
  });
  assert.equal(marksTitle(p!.w, p!.h, p!.marks), TITLE);
});

test('a title with any mark it can\'t read is no marks at all', () => {
  for (const bad of ['A screenshot', 'marks 0x5: box 1 1 2 2', 'marks 10x10:', 'marks 10x10: circle 1 1 2 2', 'marks 10x10: box 1 1 2',
    'marks 10x10: box 1 1 2 2 3', 'marks 10x10: box 1 1 2 101', 'marks 10x10: arrow 1 -1 2 2', 'marks 10x10: pin 1.5 2 2',
    'marks 10x10: pin 100 2 2', 'marks 10x10: label 1 1', `marks 10x10: label 1 1 ${'x'.repeat(41)}`, 'marks 10x10: box 1 x 2 2',
    `marks 10x10: ${Array(21).fill('pin 1 5 5').join('; ')}`]) assert.equal(parseMarks(bad), null, bad);
});

test('a marked picture in markdown gets the overlay and a Marks toggle; a plain title stays a title', () => {
  const image = (href: string, alt: string, title: string | null) => `<a href="${href}"><img src="${href}" alt="${alt}"${title ? ` title="${title}"` : ''}></a>`;
  const html = renderMarkdown(`![Settings](/s/a.png "${TITLE}")`, { image });
  assert.match(html, /<span class="cui-marked" data-marks="marks 1000x500: box/);
  assert.match(html, /<span class="cui-marked-pic"><img src="\/s\/a.png" alt="Settings"><svg class="cui-marks" viewBox="0 0 1000 500"/);
  assert.match(html, /<label class="cui-marks-toggle"><input type="checkbox" checked> Marks<\/label>/);
  assert.match(html, />Click here<\/text>/);
  assert.doesNotMatch(html, /cui-marks-draw/);
  assert.match(renderMarkdown(`![s](/s/a.png "${TITLE}")`, { image, drawMarks: true }), /<button type="button" class="cui-marks-draw">/);
  const plain = renderMarkdown('![s](/s/a.png "Just a title")', { image });
  assert.equal(plain, '<p><a href="/s/a.png"><img src="/s/a.png" alt="s" title="Just a title"></a></p>');
  // A label can't break out of the SVG.
  assert.doesNotMatch(renderMarkdown('![s](/s/a.png "marks 10x10: label 5 5 <b>hi</b>")', { image }), /<b>/);
});

// A minion's folders: a pasted picture in the scheme's uploads, and a screenshot in its working directory.
const root = mkdtempSync(join(tmpdir(), 'marks-'));
after(() => rmSync(root, { recursive: true, force: true }));
const app = { dataDir: root, sharedDir: (t: { id: number }) => join(root, 'projects/2/shared', String(t.id)) } as never;
const ticket = { id: 77, project_id: 2, cwd: join(root, 'work') } as never;
const pasted = join(root, 'projects/2/uploads/77/0123456789abcdef01234567.png');
mkdirSync(join(root, 'projects/2/uploads/77'), { recursive: true });
mkdirSync(join(root, 'work'), { recursive: true });
writeFileSync(pasted, bytes('img.png'));
writeFileSync(join(root, 'work/shot.webp'), bytes('imga.webp'));
writeFileSync(join(root, 'work/fake.png'), 'not a picture');
const marks = [{ kind: 'box', at: [10, 20], to: [30, 40] }, { kind: 'arrow', at: [50, 50], to: [60, 10], colour: 'yellow' }, { kind: 'pin', at: [70, 80] }, { kind: 'label', at: [5, 90], text: ' Click   here ' }];

test('mark_image copies a pasted picture to the minion\'s files folder and returns its marked line', async () => {
  const r = await markImage(app, ticket, { image: pasted, alt: 'Settings', marks });
  const copy = join(root, 'projects/2/shared/77/0123456789abcdef01234567.png');
  assert.deepEqual(r, { markdown: `![Settings](${copy} "marks 37x21: box 10 20 30 40; arrow yellow 50 50 60 10; pin 1 70 80; label 5 90 Click here")`, path: copy, w: 37, h: 21 });
  assert.deepEqual(readFileSync(copy), bytes('img.png'));
  // A file in its folders is linked where it is.
  const own = await markImage(app, ticket, { image: 'shot.webp', marks: [{ kind: 'pin', at: [1, 2], n: 7 }] });
  assert.equal(own.markdown, `![Marked picture](${join(root, 'work/shot.webp')} "marks 37x21: pin 7 1 2")`);
});

test('mark_image refuses marks it can\'t draw and pictures it can\'t reach, saying why', async () => {
  const refused = async (body: object, why: RegExp) => assert.rejects(markImage(app, ticket, { image: pasted, marks, ...body }), (e: any) => e.status >= 400 && why.test(e.message));
  await refused({ marks: [] }, /at least one/);
  await refused({ marks: Array(21).fill({ kind: 'pin', at: [1, 1] }) }, /At most 20/);
  await refused({ marks: [{ kind: 'circle', at: [1, 1] }] }, /box, arrow, pin or label/);
  await refused({ marks: [{ kind: 'box', at: [1, 1] }] }, /to must be \[x, y\]/);
  await refused({ marks: [{ kind: 'box', at: [1, 1], to: [120, 5] }] }, /off the picture.*37x21/);
  await refused({ marks: [{ kind: 'pin', at: [1, 1], colour: 'blue' }] }, /red or yellow/);
  await refused({ marks: [{ kind: 'pin', at: [1, 1], n: 100 }] }, /0 to 99/);
  await refused({ marks: [{ kind: 'label', at: [1, 1], text: 'a; b' }] }, /no ; or "/);
  await refused({ marks: [{ kind: 'label', at: [1, 1], text: 'x'.repeat(41) }] }, /1 to 40/);
  await refused({ alt: 'a]b' }, /square brackets/);
  await refused({ image: 'fake.png' }, /PNG, JPEG, GIF or WebP/);
  await refused({ image: join(root, 'projects/2/uploads/77/ffffffffffffffffffffffff.png') }, /No pasted picture/);
  await refused({ image: join(root, 'projects/2/uploads/78/0123456789abcdef01234567.png') }, /pasted in this chat/);
  await refused({ image: '../projects/2/uploads/77/0123456789abcdef01234567.png' }, /pasted in this chat/);
});

test('a pasted picture reaches the turn with its path and size, for mark_image', () => {
  const prompt = JSON.parse(promptMessage([{ author: 'Cara', text: 'Where is it?', images: [{ path: pasted, mediaType: 'image/png', name: 'a.png' }] } as never]));
  assert.deepEqual(prompt.message.content.map((c: any) => c.type === 'image' ? c.source.media_type : c.text), ['[Cara]: Where is it?', 'image/png', `(Cara's picture, 37x21: ${pasted})`]);
});
