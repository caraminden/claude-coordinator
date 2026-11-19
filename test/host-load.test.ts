import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { hostLoad, parseHistory, readPressure, schemeOfWho } from '../src/host-load.ts';

const root = mkdtempSync(join(tmpdir(), 'host-load-'));
after(() => rmSync(root, { recursive: true, force: true }));

const line = (iso: string, who: string, wait: number) => `${iso}\t${who}\tnpm test\tslots\t${wait}\t10\t0\t12`;

test('who strings become schemes', () => {
  assert.equal(schemeOfWho('Citadel #544 (cara)'), 'Citadel');
  assert.equal(schemeOfWho('peek-auras deploy'), 'peek-auras');
  assert.equal(schemeOfWho('Delve'), 'Delve');
});

test('history: a week of waits per scheme, median and longest, bad lines and old lines skipped', () => {
  const now = Date.parse('2026-11-19T12:00:00-0800');
  const text = [
    line('2026-11-19T11:00:00-0800', 'Citadel #1 (cara)', 10),
    line('2026-11-18T11:00:00-0800', 'Citadel #2 (cara)', 30),
    line('2026-11-17T11:00:00-0800', 'Citadel #3 (cara)', 20),
    line('2026-11-19T10:00:00-0800', 'peek-auras deploy', 0),
    line('2026-11-01T10:00:00-0800', 'Citadel #9 (cara)', 999),
    'garbage',
    '2026-11-19T10:00:00-0800\tCitadel #4\tx\tnone\t\t\t\t',
  ].join('\n');
  assert.deepEqual(parseHistory(text, now - 7 * 24 * 3600_000), [
    { scheme: 'Citadel', jobs: 3, medianS: 20, longestS: 30 },
    { scheme: 'peek-auras', jobs: 1, medianS: 0, longestS: 0 },
  ]);
});

test('pressure and the whole read from a folder', () => {
  const psi = join(root, 'cpu');
  writeFileSync(psi, 'some avg10=1.00 avg60=63.40 avg300=2.00 total=1\nfull avg10=0 avg60=0 avg300=0 total=0\n');
  assert.equal(readPressure(psi), 63);
  assert.equal(readPressure(join(root, 'none')), null);
  writeFileSync(join(root, 'slots'), '3 # how many\n');
  writeFileSync(join(root, 'history'), `${line(new Date().toISOString(), 'Citadel #5 (cara)', 40)}\n`);
  const l = hostLoad(root, Date.now(), psi);
  assert.equal(l.slots, 3);
  assert.equal(l.pressure, 63);
  assert.equal(l.week[0].longestS, 40);
  assert.deepEqual(l.holders, []);
});
