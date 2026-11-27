import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { appOwners, hostLoad, jobOfWho, parseHistory, parsePlaces, readPressure, schemeOfWho } from '../src/host-load.ts';
import { readHeavyA } from '../src/waits.ts';

const root = mkdtempSync(join(tmpdir(), 'host-load-'));
after(() => rmSync(root, { recursive: true, force: true }));

const line = (iso: string, who: string, wait: number) => `${iso}\t${who}\tnpm test\tslots\t${wait}\t10\t0\t12`;

test('who strings become schemes', () => {
  assert.equal(schemeOfWho('Citadel #544 (cara)'), 'Citadel');
  assert.equal(schemeOfWho('peek-auras deploy'), 'peek-auras');
  assert.equal(schemeOfWho('Delve'), 'Delve');
});

test("an app's jobs count under its home scheme, and say which kind they were", () => {
  const owners = new Map([
    ['twireader', 'TWIReader'],
    ['twi reader', 'TWIReader'],
    ['peek-auras', 'Peek Auras'],
  ]);
  assert.deepEqual(jobOfWho('twireader deploy', owners), { scheme: 'TWIReader', label: 'twireader', kind: 'deploy' });
  assert.deepEqual(jobOfWho('TWI Reader APK build', owners), { scheme: 'TWIReader', label: 'TWI Reader', kind: 'apk' });
  assert.deepEqual(jobOfWho('peek-auras (app)', owners), { scheme: 'Peek Auras', label: 'peek-auras', kind: 'app' });
  assert.deepEqual(jobOfWho('TWIReader #12 (josh)', owners), { scheme: 'TWIReader', label: 'TWIReader', kind: 'turn' });
  // No home scheme: the app keeps its own name, still marked as an app's job.
  assert.deepEqual(jobOfWho('voice deploy', owners), { scheme: 'voice', label: 'voice', kind: 'deploy' });
});

test('history: one row per scheme with its turns and each app job split out', () => {
  const now = Date.parse('2026-11-19T12:00:00-0800');
  const owners = new Map([['twireader', 'TWIReader']]);
  const text = [line('2026-11-19T11:00:00-0800', 'TWIReader #1 (josh)', 10), line('2026-11-19T11:00:00-0800', 'TWIReader #2 (josh)', 50), line('2026-11-19T10:00:00-0800', 'twireader deploy', 70), line('2026-11-19T10:00:00-0800', 'Citadel #3 (cara)', 5)].join('\n');
  assert.deepEqual(parseHistory(text, now - 7 * 24 * 3600_000, owners), [
    {
      scheme: 'TWIReader',
      jobs: 3,
      medianS: 50,
      longestS: 70,
      parts: [
        { label: 'TWIReader', kind: 'turn', jobs: 2, medianS: 30, longestS: 50 },
        { label: 'twireader', kind: 'deploy', jobs: 1, medianS: 70, longestS: 70 },
      ],
    },
    { scheme: 'Citadel', jobs: 1, medianS: 5, longestS: 5 },
  ]);
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

test('history by place (#2109): perigee, each machine and each repo, with what their jobs waited on', () => {
  const now = Date.parse('2026-11-26T12:00:00-0800');
  const at = '2026-11-26T11:00:00-0800';
  const row = (place: string, wait: number, why?: string) => [at, 'Peek #1 (josh)', 'cargo test', place, wait, 10, 0, '-', '-', ...(why ? [why] : [])].join('\t');
  const text = [
    row('here', 40, 'slots'),
    row('here', 0, 'none'),
    row('here', 0, 'light'),
    // Written before #2109: what it waited on sat where the place is now.
    row('line', 20),
    row("on:Josh's PC", 30, 'room'),
    row("on:Josh's PC", 10),
    row('ci:o/r', 5, 'runner'),
    'garbage',
  ].join('\n');
  assert.deepEqual(parsePlaces(text, now - 7 * 24 * 3600_000), [
    {
      place: 'here',
      jobs: 4,
      medianS: 10,
      longestS: 40,
      on: [
        { why: 'slots', jobs: 1 },
        { why: 'line', jobs: 1 },
      ],
    },
    { place: "on:Josh's PC", jobs: 2, medianS: 20, longestS: 30, on: [{ why: 'room', jobs: 1 }] },
    { place: 'ci:o/r', jobs: 1, medianS: 5, longestS: 5, on: [{ why: 'runner', jobs: 1 }] },
  ]);
});

test('pressure and the whole read from a folder', async () => {
  const psi = join(root, 'cpu');
  writeFileSync(psi, 'some avg10=1.00 avg60=63.40 avg300=2.00 total=1\nfull avg10=0 avg60=0 avg300=0 total=0\n');
  assert.equal(readPressure(psi), 63);
  assert.equal(readPressure(join(root, 'none')), null);
  writeFileSync(join(root, 'slots'), '3 # how many\n');
  writeFileSync(join(root, 'history'), `${line(new Date().toISOString(), 'Citadel #5 (cara)', 40)}\n`);
  const l = await hostLoad(root, await readHeavyA(root), Date.now(), psi);
  assert.equal(l.slots, 3);
  assert.equal(l.pressure, 63);
  assert.equal(l.week[0].longestS, 40);
  assert.deepEqual(l.holders, []);
  writeFileSync(join(root, 'wait-1-2'), `Delve #4\na nested Claude session\n${Math.floor(Date.now() / 1000)}\nease\n`);
  writeFileSync(join(root, 'wait-3-4'), `Peek #2\nnpm test\n${Math.floor(Date.now() / 1000)}\nmemory\n`);
  assert.deepEqual(
    (await hostLoad(root, await readHeavyA(root))).waiters.map((w) => w.who),
    ['Peek #2'],
    "claude-pace's waits are no heavy job's line (#1748)",
  );
  rmSync(join(root, 'wait-1-2'));
  rmSync(join(root, 'wait-3-4'));
});

test('slot count follows citadel-heavy: no number is 2, a 0 is 1', async () => {
  writeFileSync(join(root, 'slots'), '# none\n');
  assert.equal((await hostLoad(root, await readHeavyA(root))).slots, 2);
  writeFileSync(join(root, 'slots'), '0\n');
  assert.equal((await hostLoad(root, await readHeavyA(root))).slots, 1);
});

test('an app counts under its home scheme only for a viewer who can see that scheme', () => {
  const apps = [
    { name: 'twireader', title: 'TWI Reader', home_scheme: 7 },
    { name: 'secret-app', title: 'Secret', home_scheme: 9 },
    { name: 'loose', title: 'Loose', home_scheme: null },
  ];
  const owners = appOwners(
    apps,
    (id) => id === 7,
    (id) => ({ 7: 'TWIReader', 9: 'Hidden' })[id],
  );
  assert.deepEqual(
    [...owners],
    [
      ['twireader', 'TWIReader'],
      ['twi reader', 'TWIReader'],
    ],
  );
  assert.equal(jobOfWho('secret-app deploy', owners).scheme, 'secret-app'); // its own name, not the hidden scheme's
});
