import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { jsonLines } from '../src/json-lines.ts';

test('jsonLines gives each JSON line once, however the chunks fall, and skips the rest', async () => {
  const stream = new PassThrough();
  const got: unknown[] = [];
  jsonLines(stream, (m) => got.push(m));
  const bytes = Buffer.from('{"a":"é b"}\r\n\nnot json\n[1]\n{"cut":');
  for (const b of bytes) stream.write(Buffer.from([b]));
  stream.end();
  await new Promise((done) => stream.once('end', done));
  assert.deepEqual(got, [{ a: 'é b' }, [1]]);
});
