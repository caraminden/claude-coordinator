import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { appServerLimits } from '../src/codex-link.ts';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { codexHigh, codexLevel, codexTop, codexWindows, windowName } from '../public/codexusage.js';
import { procsUnder, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// Codex's usage bar (#342): each person's own windows, a bar under Claude's above 75%, and a read for Settings.
const root = mkdtempSync(join(tmpdir(), 'codex-usage-'));
after(() => rmSync(root, { recursive: true, force: true }));

const now = 1_800_000_000_000;
const win = (usedPercent: number, windowDurationMins: number, resetsAt: number | null = now / 1000 + 3600) => ({ usedPercent, windowDurationMins, resetsAt });

test('the bar under Claude shows only while either Codex window is above 75%', () => {
  assert.equal(codexHigh(null, now), false, 'no usage yet: no bar');
  assert.equal(codexHigh({ primary: win(75, 300), secondary: win(10, 10080) }, now), false, '75% is not above 75%');
  assert.equal(codexHigh({ primary: win(76, 300), secondary: win(10, 10080) }, now), true, 'the 5-hour window');
  assert.equal(codexHigh({ primary: win(5, 300), secondary: win(90, 10080) }, now), true, 'the weekly window');
  assert.equal(codexHigh({ primary: null, secondary: win(80, 10080) }, now), true, 'one window only');
  assert.equal(codexHigh({ primary: win(99, 300, now / 1000 - 1), secondary: win(10, 10080) }, now), false, 'a window past its reset counts as empty');
});

test('the windows come shortest first, clamped, with no usage as null rather than 0%', () => {
  assert.equal(codexTop(null, now), null);
  assert.equal(codexTop({ primary: null, secondary: null, updatedAt: now }, now), null);
  const ws = codexWindows({ primary: win(120, 10080), secondary: win(33.4, 300) }, now);
  assert.deepEqual(ws.map((w) => [w.windowDurationMins, w.pct]), [[300, 33], [10080, 100]]);
});

test("the bar's colour matches Claude's: plain under 75%, warn from 75%, error from 90%", () => {
  const rows: [number, string][] = [[0, ''], [74.9, ''], [75, 'warn'], [89, 'warn'], [90, 'error'], [100, 'error']];
  for (const [pct, want] of rows) assert.equal(codexLevel(pct), want, `${pct}%`);
});

test('a window is named by its length: the two Codex has by name, others in whole hours or days', () => {
  const rows: [number | null | undefined, string][] = [
    [300, '5-hour window'], [10080, 'Weekly'], [60, '1-hour window'], [720, '12-hour window'],
    [1440, '1-day window'], [4320, '3-day window'], [null, 'Window'], [undefined, 'Window'],
  ];
  for (const [mins, want] of rows) assert.equal(windowName(mins), want, String(mins));
});

test("each person's Codex usage is their own, the server login's included", () => {
  const store = new Store(join(root, 'test.db'));
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const amy = store.createUser({ name: 'Amy', login: 'amy' });
  const cara = store.createUser({ name: 'Cara', login: 'cara', server_login: true });
  const sent: any[] = [];
  const r = new Runner(store, (m) => sent.push(m), () => ({}), 'claude');
  r.codexReady = () => null;
  r.updateCodexUsage({ primary: win(80, 300), secondary: win(20, 10080) }, josh.id);
  assert.equal(r.codexView(josh.id)!.usage!.primary!.usedPercent, 80);
  assert.equal(r.codexView(amy.id)!.usage, null, "Amy doesn't see Josh's");
  assert.equal(r.codexView(cara.id)!.usage, null, "the server login's Codex (#341) is its own too");
  assert.equal(r.codexView(null), null, 'nobody signed in: no bar');
  assert.deepEqual(sent.map((m) => [m.type, m.to]), [['codex', josh.id]], 'only Josh is told');
});

test('Settings reads the windows from a codex app-server: the codex limit first, then the plain one', async () => {
  const fake = join(root, 'codex');
  writeFileSync(fake, `#!${process.execPath}
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'account/rateLimits/read') send({ id: m.id, result: { rateLimits: { primary: { usedPercent: 1 } }, rateLimitsByLimitId: process.env.PLAIN ? undefined : { codex: { primary: { usedPercent: 42 } } } } });
});
`);
  chmodSync(fake, 0o755);
  assert.deepEqual(await appServerLimits([fake]), { primary: { usedPercent: 42 } });
  process.env.PLAIN = '1';
  try {
    assert.deepEqual(await appServerLimits([fake]), { primary: { usedPercent: 1 } });
  } finally {
    delete process.env.PLAIN;
  }
  assert.equal(await appServerLimits([join(root, 'missing')]), null, "one that can't start says nothing");
  const silent = join(root, 'silent');
  // Ends with its stdin, as app-server does: under --test-force-exit this file exits before appServerLimits' 3 s kill (#564).
  writeFileSync(silent, `#!${process.execPath}\nprocess.stdin.resume().on('end', () => process.exit());\n`);
  chmodSync(silent, 0o755);
  assert.equal(await appServerLimits([silent], 200), null, "one that doesn't answer times out");
  await until('the silent server to end with its stdin', () => procsUnder([silent]).size === 0); // a slow start outlives the file (#1763)
});
