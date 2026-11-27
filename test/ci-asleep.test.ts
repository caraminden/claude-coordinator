// #2239 (Cara, 2026-11-27: "What is going on here?"): a PC's runner agent stops the runners Citadel's plan has no room
// for (Build 7 M6b), GitHub lists them offline, and the CI page said "3 offline" in red while its footer said "Fine".
// Asleep runners read asleep; a runner offline for real turns the footer's word.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runsOnWord } from '../public/ci-desktop.js';
import { sleptOf } from '../src/ci-load.ts';
import { asleepRunners } from '../src/ci-problems.ts';

const use = (name: string, repo: string) => ({ name, repo, dir: '', cpu: 0, mem: 0 });

test('sleptOf counts, per repo, the runners an agent may wake less the ones up now', () => {
  const s = {
    host: 'DESKTOP-G248IJ8',
    os: 'linux' as const,
    // Four of Citadel's, one of Cantrips'; one Citadel runner and the Cantrips one are up.
    wakeable: ['caraminden/claude-coordinator', 'caraminden/claude-coordinator', 'caraminden/claude-coordinator', 'caraminden/claude-coordinator', 'caraminden/cantrips'],
    runners: [use('DESKTOP-G248IJ8-linux', 'caraminden/claude-coordinator'), use('DESKTOP-G248IJ8-linux', 'caraminden/cantrips')],
  };
  assert.deepEqual(sleptOf(s), [{ host: 'DESKTOP-G248IJ8', os: 'linux', repo: 'caraminden/claude-coordinator', n: 3 }]);
  assert.deepEqual(sleptOf({ ...s, wakeable: undefined }), [], 'an agent from before M6b says nothing of sleep');
});

test('asleepRunners takes up to n offline runners named after the PC, Linux ones for the Linux agent only', () => {
  const runners = [
    { name: 'DESKTOP-G248IJ8-linux', status: 'online' },
    { name: 'DESKTOP-G248IJ8-linux-2', status: 'offline' },
    { name: 'DESKTOP-G248IJ8-linux-3', status: 'offline' },
    { name: 'DESKTOP-G248IJ8-linux-4', status: 'offline' },
    { name: 'DESKTOP-G248IJ8-2', status: 'offline' },
    { name: 'OTHER-PC-linux', status: 'offline' },
    // A PC whose name only starts with this one's isn't this one.
    { name: 'DESKTOP-G248IJ80-linux', status: 'offline' },
  ];
  assert.deepEqual([...asleepRunners(runners, [{ host: 'DESKTOP-G248IJ8', os: 'linux', n: 3 }])], ['DESKTOP-G248IJ8-linux-2', 'DESKTOP-G248IJ8-linux-3', 'DESKTOP-G248IJ8-linux-4']);
  // Only two asleep: the third offline one is offline for real.
  assert.equal(asleepRunners(runners, [{ host: 'DESKTOP-G248IJ8', os: 'linux', n: 2 }]).size, 2);
  assert.deepEqual([...asleepRunners(runners, [{ host: 'DESKTOP-G248IJ8', os: 'windows', n: 5 }])], ['DESKTOP-G248IJ8-2']);
  assert.equal(asleepRunners(runners, []).size, 0, 'no agent says so: every offline runner is offline');
});

test("the Runs on line doesn't say Fine while the scheme's runners on that PC are offline, and asleep ones don't count", () => {
  const pc = { host: 'DESKTOP-G248IJ8', verdict: { kind: 'fine' }, now: { cpu: 10, mem_total: 100, mem_free: 80 }, seen: true };
  const r = (name: string, status: string, asleep?: true) => ({ name, status, busy: false, labels: [], job: null, offlineSince: null, ...(asleep && { asleep }) });
  // The screenshot's state: one idle, three offline.
  const shot = [r('DESKTOP-G248IJ8-linux', 'online'), r('DESKTOP-G248IJ8-linux-2', 'offline'), r('DESKTOP-G248IJ8-linux-3', 'offline'), r('DESKTOP-G248IJ8-linux-4', 'offline')];
  assert.deepEqual(runsOnWord(pc, shot), ['danger', '3 runners offline']);
  assert.deepEqual(runsOnWord(pc, [shot[0], r('DESKTOP-G248IJ8-linux-2', 'offline', true), shot[2]]), ['danger', '1 runner offline'], 'asleep is not offline');
  assert.deepEqual(runsOnWord(pc, [shot[0], r('OTHER-PC', 'offline')]), ['ok', 'Fine'], "another PC's runner isn't this one's");
  assert.deepEqual(runsOnWord(pc, [r('DESKTOP-G248IJ80-linux', 'offline')]), ['ok', 'Fine'], 'a PC named longer is another PC');
  assert.deepEqual(runsOnWord(pc, null), ['ok', 'Fine']);
});
