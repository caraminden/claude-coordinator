import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { citadelUrl, HttpError, readJson } from '../src/http.ts';

const body = (text: string) => Readable.from([Buffer.from(text)]) as unknown as IncomingMessage;

test('readJson parses a body, treats an empty one as {}, and refuses bad or oversized ones', async () => {
  assert.deepEqual(await readJson(body('{"a":1}')), { a: 1 });
  assert.deepEqual(await readJson(body('')), {});
  await assert.rejects(readJson(body('{nope')), (e) => e instanceof HttpError && e.status === 400);
  await assert.rejects(readJson(body('x'.repeat(20)), 10), (e) => e instanceof HttpError && e.status === 413);
});

test('citadelUrl reads CITADEL_URL, and only a development run may go without it', () => {
  const saved = { url: process.env.CITADEL_URL, node: process.env.NODE_ENV };
  try {
    process.env.CITADEL_URL = 'http://citadel.test/';
    assert.equal(citadelUrl(), 'http://citadel.test');
    delete process.env.CITADEL_URL;
    process.env.NODE_ENV = 'production';
    assert.throws(() => citadelUrl(), /CITADEL_URL is not set/);
    process.env.NODE_ENV = 'development';
    assert.match(citadelUrl(), /^http:\/\//);
  } finally {
    for (const [k, v] of [['CITADEL_URL', saved.url], ['NODE_ENV', saved.node]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});
