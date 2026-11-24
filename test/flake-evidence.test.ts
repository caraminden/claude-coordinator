import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { ciEvidence, classifyFlake, failureIn, scrubSecrets } from '../src/flake-evidence.ts';
import { FlakeFixes } from '../src/flake-fixes.ts';
import { flakeBrief } from '../src/flakes.ts';

// Flake sightings keep their error (#1438).
const root = mkdtempSync(join(tmpdir(), 'flake-ev-'));
after(() => rmSync(root, { recursive: true, force: true }));
const T = '2026-11-21T09:08:32.69Z ';

test('each message gets one class; the rules are in one function', () => {
  const cases: [string, string][] = [
    ['Error: Timed out waiting for the server to answer', 'timed out waiting'],
    ['AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal', 'wrong value'],
    ['Error: server exited with code 1 before it listened', 'child or server exit'],
    ["Error: ENOTEMPTY: directory not empty, rmdir '/tmp/x'", 'folder not empty'],
    ['Error: listen EADDRINUSE: address already in use :::8123', 'address in use'],
    ['SqliteError: database is locked', 'database busy'],
    ['test timed out after 30000ms', 'test timeout'],
    ['TypeError: x is not a function', 'other'],
  ];
  for (const [msg, cls] of cases) assert.equal(classifyFlake(msg), cls, msg);
});

test('an error line quoting a secret keeps no secret', () => {
  const out = scrubSecrets('GITHUB_TOKEN=abc123def456 failed; Bearer abcdefghijklmnop1234; ghp_abcdefghijklmnopqrstuv; at file.ts:3');
  assert.doesNotMatch(out, /abc123def456|abcdefghijklmnop1234|ghp_abcdef/);
  assert.match(out, /at file\.ts:3/);
});

const LOG = [
  'run-tests: 2 test file(s) failed',
  '✔ fine (1ms)',
  '✖ failing tests:',
  '',
  'test at test/other.test.ts:5:1',
  '✖ other case (3ms)',
  '  Error: nope',
  '      at X (file:///w/_work/r/r/test/other.test.ts:6:1)',
  '',
  'test at test/citadel-heavy.test.ts:324:1',
  '✖ a job that ran appends one line (2684.7ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:',
  '  + actual - expected',
  '',
  "    +   '1',",
  "    -   '0',",
  '      at TestContext.<anonymous> (file:///w/_work/r/r/test/citadel-heavy.test.ts:334:10)',
  '    code: ERR_ASSERTION',
  'run-tests: after',
]
  .map((l) => T + l)
  .join('\n');

test('a CI log gives the failing test of the file, its first error lines and no stack', () => {
  const f = failureIn(LOG, 'test/citadel-heavy.test.ts')!;
  assert.equal(f.name, 'a job that ran appends one line');
  assert.match(f.message, /^AssertionError \[ERR_ASSERTION\]: Expected values/);
  assert.match(f.message, /-   '0'/);
  assert.doesNotMatch(f.message, /TestContext|_work/);
  assert.ok(f.message.length <= 600);
  assert.equal(failureIn(LOG, 'test/none.test.ts'), null);
});

test('the evidence comes from the newest red run before the flake line, its failed job', async () => {
  const asked: string[] = [];
  const get = async (path: string) => {
    asked.push(path);
    if (path.includes('/runs?branch=land'))
      return JSON.stringify({
        workflow_runs: [
          { id: 9, created_at: '2026-11-21T09:30:00Z', conclusion: 'failure' },
          { id: 8, created_at: '2026-11-21T09:00:00Z', conclusion: 'failure' },
        ],
      });
    if (path.includes('/runs?')) return '{}';
    if (path.endsWith('/runs/8/jobs')) return JSON.stringify({ jobs: [{ id: 80, conclusion: 'failure' }] });
    if (path.endsWith('/jobs/80/logs')) return LOG;
    return null;
  };
  const found = await ciEvidence('o/r', undefined, 'ticket/1-x', 'test/citadel-heavy.test.ts', Date.parse('2026-11-21T09:09:03Z'), get);
  assert.match(found!.message, /AssertionError/);
  assert.ok(!asked.some((p) => p.includes('/runs/9/')), 'a run created after the flake line is not read');
  assert.equal(await ciEvidence('o/r', undefined, 'b', 'test/x.test.ts', 1, async () => null), null);
});

test('ingest stores the message and class of a CI sighting, none for others, and counts and the brief show them', async () => {
  const dir = mkdtempSync(join(root, 'ing-'));
  const st = new Store(join(dir, 'c.db'));
  const project = st.createProject('P', null);
  const at = Date.now() - 3_600_000;
  const d = new Date(at).toISOString();
  mkdirSync(join(dir, 'shared', 'retro-log', d.slice(0, 10)), { recursive: true });
  writeFileSync(
    join(dir, 'shared', 'retro-log', d.slice(0, 10), 'land.md'),
    [`- ${d.slice(11, 19)}Z · flake · test/a.test.ts · load 9.0 · ticket/1-x · in CI`, `- ${d.slice(11, 19)}Z · flake · test/b.test.ts · load 9.0 · ticket/1-x · in CI`, `- ${d.slice(11, 19)}Z · flake · test/c.test.ts · smoke · ticket/1-x`].join('\n') + '\n',
  );
  const fx = new FlakeFixes({
    store: st,
    sharedDir: () => join(dir, 'shared'),
    start: async () => ({ id: 0 }),
    runs: async () => [],
    jobs: async () => [],
    evidence: async (_p, _b, file) => (file === 'test/a.test.ts' ? { name: 'case', message: 'Timed out waiting for x' } : null),
  });
  await fx.ingest(project, Date.now());
  const rows = st.db.prepare('SELECT file, test_name, message, class FROM flake_events ORDER BY file').all() as any[];
  assert.deepEqual(
    rows.map((r) => [r.file, r.message, r.class]),
    [
      ['test/a.test.ts', 'Timed out waiting for x', 'timed out waiting'],
      ['test/b.test.ts', '', ''],
      ['test/c.test.ts', '', ''],
    ],
  );
  const m = st.flakeMessages(project.id, 'test/a.test.ts', 0);
  assert.deepEqual(
    m.messages.map((x) => [x.count, x.cls, x.test]),
    [[1, 'timed out waiting', 'case']],
  );
  assert.equal(st.flakeMessages(project.id, 'test/b.test.ts', 0).none, 1, 'a sighting with no message is counted as "no message kept"');
  assert.match(flakeBrief('test/a.test.ts', 1, [], m.messages).message, /Timed out waiting for x/);
});
