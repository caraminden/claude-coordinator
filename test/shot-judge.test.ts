import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { BIG_CHANGE, problems, sameError, type AppNight, type Shot } from '../src/shot-judge.ts';
import { background, changed, flatShare, readPng, type Picture } from '../tools/app-shots/picture.ts';

// What counts as broken on a nightly contraption screenshot (#1783): "A blank page, an error page, a console error or a
// big layout change counts as broken. Small pixel noise doesn't."

/** A picture in one colour with boxes drawn on it. */
function picture(width: number, height: number, boxes: [x: number, y: number, w: number, h: number, shade: number][] = []): Picture {
  const rgb = new Uint8Array(width * height * 3).fill(255);
  for (const [x, y, w, h, shade] of boxes) for (let j = y; j < y + h; j++) rgb.fill(shade, (j * width + x) * 3, (j * width + x + w) * 3);
  return { width, height, rgb };
}

/** A PNG of `rows` (bytes after their filter), as Chromium lays one out. */
function png(width: number, colour: number, rows: number[][]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr.set([8, colour, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(rows.flat()))), chunk('IEND', Buffer.alloc(0))]);
}

const shot = (o: Partial<Shot> = {}): Shot => ({ page: '/', width: 1440, file: 'a.png', thumb: 'a.webp', status: 200, text: 'A page with something on it', errors: [], flat: 0.8, moved: 0, was: null, since: null, failed: null, ...o });
const night = (o: Partial<AppNight> = {}): AppNight => ({ app: 'demo', title: 'Demo', scheme: 2, head: 'abc', kit: null, skipped: null, unshot: null, boot: null, once: [], shots: [shot()], found: ['/'], gone: [], goneSince: null, called: [], ...o });
const kinds = (o: Partial<Shot>) => problems(night({ shots: [shot(o)] })).map((p) => p.kind);

test('a PNG is read with each of the five row filters, and its alpha is dropped', () => {
  // Every row decodes to (10,20,30) (40,50,60), each by another filter.
  const rows = [
    [0, 10, 20, 30, 40, 50, 60],
    [1, 10, 20, 30, 30, 30, 30],
    [2, 0, 0, 0, 0, 0, 0],
    [3, 5, 10, 15, 15, 15, 15],
    [4, 0, 0, 0, 0, 0, 0],
  ];
  const p = readPng(png(2, 2, rows));
  assert.deepEqual([p.width, p.height], [2, 5]);
  assert.deepEqual([...p.rgb], Array.from({ length: 5 }, () => [10, 20, 30, 40, 50, 60]).flat());
  assert.deepEqual([...readPng(png(1, 6, [[0, 1, 2, 3, 128]])).rgb], [1, 2, 3]);
});

test('a file that is no PNG, one cut short, or a kind this does not read throws', () => {
  assert.throws(() => readPng(Buffer.from('<html>')), /not a PNG/);
  assert.throws(() => readPng(png(2, 3, [[0, 1]])), /a PNG kind/);
  assert.throws(() => readPng(png(9, 2, [[0, 1, 2, 3]])), /cut short/);
});

test('a page in one colour is flat, and its background is the colour most of it is', () => {
  assert.equal(flatShare(picture(100, 100)), 1);
  const half = picture(100, 100, [[0, 0, 100, 40, 0]]);
  assert.ok(Math.abs(flatShare(half) - 0.6) < 0.02, String(flatShare(half)));
  assert.ok(Array.from(background(half)).every((v) => v > 250));
});

test('the same page is 0, small pixel noise stays far under a big change, a moved layout and a lost page are over it', () => {
  const rows: [number, number, number, number, number][] = Array.from({ length: 8 }, (_, i) => [40, 40 + i * 100, 900, 60, 60]);
  const page = picture(1440, 900, rows);
  assert.equal(changed(page, page), 0);
  const noisy = { ...page, rgb: page.rgb.map((v, i) => (i % 7 ? v : Math.max(0, v - 6))) };
  assert.equal(changed(page, noisy), 0);
  // One short label that reads differently.
  assert.ok(changed(page, picture(1440, 900, [...rows, [1000, 40, 60, 20, 0]])) < BIG_CHANGE / 4);
  assert.ok(
    changed(
      page,
      picture(
        1440,
        900,
        rows.map(([x, y, w, h, s]) => [x + 450, y + 50, w, h, s]),
      ),
    ) >= BIG_CHANGE,
  );
  assert.equal(changed(page, picture(1440, 900)), 1);
  assert.equal(changed(page, picture(390, 900)), 1);
});

test('a sparse page that loses all it shows is a big change, though that is a few percent of the page', () => {
  const sparse = picture(1440, 900, [[0, 0, 1440, 100, 40]]);
  assert.ok(changed(sparse, picture(1440, 900)) >= BIG_CHANGE);
});

test('a list that grew by a row below is no big change', () => {
  const list = (n: number) =>
    picture(
      390,
      n * 100,
      Array.from({ length: n }, (_, i) => [10, i * 100 + 10, 300, 70, 80]),
    );
  assert.ok(changed(list(9), list(10)) < BIG_CHANGE);
});

test('blank, error pages, console errors, big changes and pages that could not be drawn are broken; the rest is not', () => {
  assert.deepEqual(kinds({}), []);
  assert.deepEqual(kinds({ flat: 1, text: '  ' }), ['blank']);
  // A dark full-bleed page with words on it is not blank.
  assert.deepEqual(kinds({ flat: 0.999, text: 'Loading' }), []);
  assert.deepEqual(kinds({ status: 500, text: 'oops' }), ['error-page']);
  assert.deepEqual(kinds({ status: 200, text: 'Internal Server Error' }), ['error-page']);
  assert.deepEqual(kinds({ status: 200, text: '404 Not Found' }), ['error-page']);
  assert.deepEqual(kinds({ text: `Not found in your notes: ${'words '.repeat(60)}` }), []);
  assert.deepEqual(kinds({ errors: ['TypeError: x is undefined'] }), ['console']);
  assert.deepEqual(kinds({ moved: BIG_CHANGE }), ['layout']);
  assert.deepEqual(kinds({ moved: BIG_CHANGE - 0.01 }), []);
  assert.deepEqual(kinds({ moved: null }), []);
  assert.deepEqual(kinds({ failed: 'it took over 40 s', errors: ['x'] }), ['failed']);
});

test('a page that went blank or turned into an error page is said once, not as a layout change too', () => {
  assert.deepEqual(kinds({ flat: 1, text: '', moved: 1 }), ['blank']);
  assert.deepEqual(kinds({ status: 500, text: 'oops', moved: 1 }), ['error-page']);
});

test('one error under two ports or hashes is one problem, and what only one of two tries saw is none', () => {
  assert.equal(sameError('GET http://127.0.0.1:41233/a 500 (run 9f8e7d6c5b)'), sameError('GET http://127.0.0.1:50021/a 500 (run 0a1b2c3d4e)'));
  assert.deepEqual(kinds({ errors: ['boom at 12', 'boom at 13'] }), ['console']);
  const a = night({ shots: [shot({ errors: ['flaky'] }), shot({ page: '/list', flat: 1, text: '' })] });
  const [flake] = problems(a);
  assert.deepEqual(
    problems({ ...a, once: [flake.key] }).map((p) => p.key),
    ['demo|/list|1440|blank'],
  );
});

test('a main page whose link is gone is one problem, unless the front page is what broke or one try only saw it', () => {
  const a = night({ gone: ['/list'] });
  assert.deepEqual(
    problems(a).map((p) => [p.key, p.kind]),
    [['demo|/list|gone', 'gone']],
  );
  assert.deepEqual(problems({ ...a, once: ['demo|/list|gone'] }), []);
  assert.deepEqual(
    problems({ ...a, shots: [shot({ flat: 1, text: '' })] }).map((p) => p.kind),
    ['blank'],
  );
});

test('an app whose copy does not start is one problem; one skipped or that the run failed on has none', () => {
  const broken = [shot({ flat: 1, text: '' })];
  assert.deepEqual(
    problems(night({ boot: 'line one\nCannot find module x', shots: [] })).map((p) => [p.kind, p.text]),
    [['boot', "its copy didn't start: line one Cannot find module x"]],
  );
  assert.deepEqual(problems(night({ skipped: 'not deployed yet', shots: broken })), []);
  assert.deepEqual(problems(night({ unshot: 'no answer', shots: broken })), []);
});
