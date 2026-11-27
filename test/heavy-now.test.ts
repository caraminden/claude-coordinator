import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MachineJob } from '../src/db.ts';
import { heavyNow } from '../src/heavy-now.ts';

const job = (id: number, over: Partial<MachineJob>) => ({ id, machine_id: 1, project_id: 5, go: 'builds', state: 'running', reason: 'cargo test', kind: JSON.stringify({ threads: 8 }), kind_name: 'cargo', ...over }) as MachineJob;

test('each place lists its heavy jobs, running first, with what a waiting one waits on (#2109)', () => {
  const now = heavyNow({
    perigee: {
      holders: [{ who: 'Citadel #4 (cara)', what: 'npm test', since: 1 }],
      waiters: [
        { who: 'Citadel #5 (cara)', what: 'npm run build', since: 2, reason: 'slots' },
        { who: 'Citadel #6 (cara)', what: 'claude', since: 3, reason: 'ease' },
      ],
    },
    machines: [
      { id: 1, name: "Josh's PC" },
      { id: 2, name: 'idle' },
    ],
    jobs: [job(10, { state: 'queued', reason: 'cargo build' }), job(11, {}), job(12, { go: 'now', kind_name: 'train', project_id: 6 })],
    balanced: (id) =>
      id === 1
        ? [
            { key: 'build:11', label: 'cargo build 11', size: 8, since: 1, running: true },
            { key: 'gpu:12', label: 'GPU job 12', size: 4, since: 2, running: true },
            { key: 'ci:o/r:9', label: 'APK build in o/r', size: 6, since: 3 },
          ]
        : [],
    waits: () => 'waiting for room',
    scheme: (id) => (id === 5 ? 'Peek Auras' : 'Delve'),
  });
  assert.deepEqual(now.home, [
    { scheme: 'Citadel', what: 'npm test', threads: null, waiting: null },
    { scheme: 'Citadel', what: 'npm run build', threads: null, waiting: 'all slots busy' },
  ]);
  assert.deepEqual(now.machines, [
    {
      id: 1,
      name: "Josh's PC",
      jobs: [
        { scheme: 'Peek Auras', what: 'cargo test', threads: 8, waiting: null },
        { scheme: 'Delve', what: 'train (GPU job)', threads: 4, waiting: null },
        { scheme: 'Peek Auras', what: 'cargo build', threads: 8, waiting: 'no room yet' },
        { scheme: '', what: 'APK build in o/r', threads: 6, waiting: 'no room yet' },
      ],
    },
  ]);
});
