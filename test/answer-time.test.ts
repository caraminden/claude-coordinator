// The answer-time probe (#1559): the window's numbers, the alert's three-in-a-row rule, and a real probe against a real server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { until } from './wait.ts';
import { AnswerProbe, summarize, alertStep, percentile, parseWindow, type AnswerWindow, type ProbeMessage } from '../src/answer-time.ts';

const msg = (ms: number | null, over: Partial<ProbeMessage> = {}): ProbeMessage => ({ ms, run: 0, wait: 0, samples: 0, blocked: 0, wallMs: 1000, ...over });

test('percentiles are nearest rank; a failed probe counts as the worst answer', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  const w = summarize(
    [...Array(98).fill(10), 600, null].map((x) => msg(x as number | null)),
    20,
    5,
  )!;
  assert.equal(w.n, 99);
  assert.equal(w.fail, 1);
  assert.equal(w.p50, 10);
  assert.equal(w.max, 60_000);
  assert.equal(w.over, 0.02);
  assert.equal(summarize([], 1, 1), null);
});

test('the thread split sums CPU, waiting, blocked and idle to the window', () => {
  const w = summarize([msg(5, { run: 300e6, wait: 200e6, samples: 50, blocked: 5 }), msg(5, { run: 100e6, wait: 0, samples: 50, blocked: 5 })], 1, 1)!;
  assert.deepEqual(w.split, { cpu: 400, wait: 200, blocked: 200, idle: 1200 });
});

const win = (p95: number, p99 = 0, load = 10, turns = 5): AnswerWindow => ({ v: 1, n: 300, fail: 0, p50: 1, p95, p99, max: p99, over: 0, split: null, load, turns });
const line = { p95: 250, p99: 1000 };

test('three windows outside the line raise once; three inside clear, busy windows included', () => {
  assert.equal(alertStep([win(300), win(300)], line, false), null);
  assert.equal(alertStep([win(10), win(300), win(10, 2000), win(300)], line, false), 'slow');
  assert.equal(alertStep([win(300), win(300), win(300)], line, true), null);
  assert.equal(alertStep([win(300), win(10), win(10), win(10)], line, true), 'ok');
  assert.equal(alertStep([win(9000, 0, 150), win(9000, 0, 150), win(9000, 0, 150)], line, false), 'slow');
  assert.equal(parseWindow('{"v":1,"p95":3}')?.p95, 3);
  assert.equal(parseWindow('nope'), null);
});

test('the probe makes a real request on a fresh connection each time, and a slow answer does not delay the next probe', async () => {
  const sockets = new Set<unknown>();
  let hits = 0;
  const server = createServer((req, res) => {
    sockets.add(req.socket);
    if (++hits === 1) return void setTimeout(() => res.end('ok'), 700); // the first answer is slow
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const probe = new AnswerProbe({ everyMs: 100, lookMs: 20 });
  probe.start((server.address() as { port: number }).port);
  await new Promise((r) => setTimeout(r, 1200)); // timing-ok: the probe's own clock (every 100 ms) is what is measured
  const w = probe.take(1, 1)!;
  probe.stop();
  server.close();
  server.closeAllConnections();
  assert.ok(hits >= 8, `probes kept coming while one was slow: ${hits}`);
  assert.equal(sockets.size, hits, 'one connection per probe');
  assert.ok(w.max >= 650, `the slow one is the worst: ${w.max}`);
  assert.ok(w.p50 < 100, `the rest were quick: ${w.p50}`);
});

test('behind the front thread it also times a reader: its time when a reader answered, null when main did (#1628)', async () => {
  let reader = true;
  const server = createServer((req, res) => {
    if (req.url === '/r' && reader) res.setHeader('X-Citadel-Answered', 'reader');
    res.writeHead(req.url === '/r' ? 401 : 200).end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const probe = new AnswerProbe({ everyMs: 50, lookMs: 20 });
  try {
    probe.start((server.address() as { port: number }).port, '127.0.0.1', '/r');
    await until('a reader reading', () => probe.readerMs != null);
    assert.ok(probe.readerMs! >= 0);
    reader = false; // no reader alive: the front passed it to main
    await until('the reading drops', () => probe.readerMs == null);
    assert.ok(probe.lastMs != null, 'main is still timed');
  } finally {
    probe.stop();
    server.close();
    server.closeAllConnections();
  }
});
