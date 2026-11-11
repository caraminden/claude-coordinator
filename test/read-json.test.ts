// readJson: what a write route's body may be. A body that isn't a JSON object is the caller's mistake, a 400,
// not a TypeError on `body.x` that answers 500 "Internal error" (#468 S07-5).
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { HttpError, readJson } from '../src/http.ts';

const req = (body: string) => Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage;

test('readJson takes an object, and an empty body as one', async () => {
  assert.deepEqual(await readJson(req('{"a":1}')), { a: 1 });
  assert.deepEqual(await readJson(req('')), {});
});

test('readJson answers 400 for a body that is JSON but no object', async () => {
  for (const body of ['null', '[]', '[1]', '3', '"x"', 'true']) {
    await assert.rejects(readJson(req(body)), (err: unknown) => err instanceof HttpError && err.status === 400 && /Expected a JSON object/.test(err.message), body);
  }
  await assert.rejects(readJson(req('{')), /Invalid JSON/);
});
