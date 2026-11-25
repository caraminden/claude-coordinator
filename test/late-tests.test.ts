// #1898: the list of load-sensitive test files CI runs after a suite's main wave, built from the retro log's flake lines.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseRetro } from '../src/land-reds.ts';
import { Store } from '../src/db.ts';
import { lateReadKey, lateTests, lateView, type LateFix } from '../src/late-tests.ts';
import { projectSharedDir } from '../src/workspace.ts';

const at = (iso: string) => Date.parse(`2026-11-${iso}:00Z`);
const NOW = at('24T12:00');
const log = (...lines: [day: string, line: string][]) => lines.flatMap(([day, line]) => parseRetro(`- ${line}\n`, `2026-11-${day}`));
const flake = (day: string, time: string, file: string, branch: string, load = '31.5'): [string, string] => [day, `${time}:00Z · flake · ${file} · load ${load} · ${branch} · in CI`];
const names = (l: { file: string }[]) => l.map((f) => f.file);
const fix = (state: LateFix['state'], patch: Partial<LateFix> = {}): LateFix => ({ file: 'test/a.test.ts', state, held_at: null, ticket_id: null, ...patch });

test('a file joins on sightings from two branches within three days, not on two from one branch, nor on smoke failures', () => {
  const lines = log(
    flake('23', '08:00', 'test/a.test.ts', 'ticket/1-x', '12.0'),
    flake('24', '09:00', 'test/a.test.ts', 'ticket/2-y', '40.2'),
    flake('24', '09:05', 'test/a.test.ts', 'ticket/2-y', '33.0'),
    flake('24', '10:00', 'test/once.test.ts', 'ticket/3-z'),
    flake('24', '10:30', 'test/once.test.ts', 'ticket/3-z'),
    ['24', '11:00:00Z · flake · test/boot.test.ts · smoke · ticket/4-w'],
    ['24', '11:01:00Z · flake · test/boot.test.ts · smoke · ticket/5-v'],
    ['24', '11:02:00Z · flake rerun · ticket/4-w · test/once.test.ts · green'],
  );
  assert.deepEqual(lateTests(lines, [], NOW), {
    listed: [{ file: 'test/a.test.ts', sightings: 3, branches: ['ticket/1-x', 'ticket/2-y'], last: at('24T09:05'), loads: [12, 40.2], fixing: null }],
    alone: [],
  });
});

test('a sighting written without its branch may be the same branch again, and a path that is no test file is never listed', () => {
  const lines = log(['24', '08:00:00Z · flake · test/a.test.ts · load 30.0'], flake('24', '09:00', 'test/a.test.ts', 'ticket/2-y'), flake('24', '09:00', '../x.sh', 'ticket/2-y'), flake('24', '09:01', '../x.sh', 'ticket/3-y'));
  assert.deepEqual(lateTests(lines, [], NOW).listed, []);
  assert.equal(lateTests([...lines, ...log(flake('24', '10:00', 'test/a.test.ts', 'ticket/3-z'))], [], NOW).listed[0].sightings, 3);
});

test('a file leaves three days after the sightings that put it on, and a held fix takes it off at once', () => {
  const lines = log(flake('21', '11:00', 'test/a.test.ts', 'ticket/1-x'), flake('22', '12:00', 'test/a.test.ts', 'ticket/2-y'));
  assert.deepEqual(names(lateTests(lines, [], at('24T10:59')).listed), ['test/a.test.ts']);
  assert.deepEqual(names(lateTests(lines, [], at('25T11:59')).listed), ['test/a.test.ts'], 'on until three days after the last sighting');
  assert.deepEqual(names(lateTests(lines, [], at('25T12:01')).listed), []);
  assert.deepEqual(names(lateTests(lines, [fix('held', { held_at: at('23T00:00') })], at('23T10:00')).listed), []);
  // Sighted again on two branches after the fix held: back on.
  const again = [...lines, ...log(flake('23', '08:00', 'test/a.test.ts', 'ticket/3-x'), flake('23', '09:00', 'test/a.test.ts', 'ticket/4-y'))];
  assert.equal(lateTests(again, [fix('held', { held_at: at('23T00:00') })], at('23T10:00')).listed[0].sightings, 2);
});

test('a file that also failed alone is kept off the list and marked, with where it did', () => {
  const on = (file: string) => [flake('24', '08:00', file, 'ticket/1-x'), flake('24', '09:00', file, 'ticket/2-y')];
  const U = 'https://github.com/o/r/actions/runs/9';
  const lines = log(
    ...['a', 'b', 'c', 'd'].flatMap((f) => on(`test/${f}.test.ts`)),
    ['24', '10:00:00Z · failed alone · test/a.test.ts · ticket/7-q · in CI'],
    ['24', `10:10:00Z · shipped through main's red · ticket/8-l · test/b.test.ts · ${U}`],
    ['24', `10:20:00Z · red on main too: not this ship's · ticket/10-k · test/c.test.ts · ${U}`],
    ['24', '10:30:00Z · failed alone · test/never-flaked.test.ts · ticket/7-q · in CI'],
  );
  const out = lateTests(lines, [], NOW);
  assert.deepEqual(names(out.listed), ['test/d.test.ts']);
  assert.deepEqual(
    out.alone.map((f) => [f.file, f.failedAlone, f.where]),
    [
      ['test/a.test.ts', at('24T10:00'), 'ticket/7-q'],
      ['test/b.test.ts', at('24T10:10'), 'main'],
      ['test/c.test.ts', at('24T10:20'), 'main'],
    ],
  );
  // It is listed again three days after it last failed alone, if it is still sighted.
  const later = lateTests([...lines, ...log(flake('26', '20:00', 'test/a.test.ts', 'ticket/3-z'))], [], at('27T11:00'));
  assert.deepEqual([names(later.listed), names(later.alone)], [['test/a.test.ts'], []]);
  // A fix that held after it settles both.
  assert.deepEqual(names(lateTests(lines, [fix('held', { held_at: at('24T11:00') })], NOW).alone), ['test/b.test.ts', 'test/c.test.ts']);
});

test('a file with an open fix stays listed and names the minion on it', () => {
  const lines = log(flake('24', '08:00', 'test/a.test.ts', 'ticket/1-x'), flake('24', '09:00', 'test/a.test.ts', 'ticket/2-y'));
  assert.equal(lateTests(lines, [fix('open', { ticket_id: 42 })], NOW).listed[0].fixing, 42);
});

test('the files sighted on the most branches come first', () => {
  const lines = log(flake('24', '08:00', 'test/a.test.ts', 'b1'), flake('24', '08:01', 'test/a.test.ts', 'b2'), flake('24', '08:02', 'test/z.test.ts', 'b1'), flake('24', '08:03', 'test/z.test.ts', 'b2'), flake('24', '08:04', 'test/z.test.ts', 'b3'));
  assert.deepEqual(names(lateTests(lines, [], NOW).listed), ['test/z.test.ts', 'test/a.test.ts']);
});

// tools/late-tests.ts, CI's own read of the list: a run token, the list into a file, and no way to fail the step.
async function fetchList(answer: (path: string) => { status?: number; body: unknown }, extra: Record<string, string> = {}) {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    asked.push(`${req.url} ${req.headers.authorization}`);
    const { status = 200, body } = answer(req.url!);
    res.statusCode = status;
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'late-tests-'));
  const out = join(dir, 'late');
  const env = { ...process.env, ACTIONS_ID_TOKEN_REQUEST_URL: `${url}/token?x=1`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'ask', CITADEL_STORE_URL: url, RUNNER_ENVIRONMENT: 'self-hosted', ...extra };
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'tools', 'late-tests.ts'), out], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  for (const s of [child.stdout, child.stderr]) s.on('data', (c) => (said += c));
  const code = await new Promise((r) => child.once('close', r));
  server.close();
  const list = existsSync(out) ? readFileSync(out, 'utf8') : null;
  rmSync(dir, { recursive: true, force: true }); // timing-ok: own temp dir
  return { code, said, list, asked };
}

test("CI's read writes the list a file a line, with the job's own run token", async () => {
  const r = await fetchList((path) => ({ body: path.startsWith('/token') ? { value: 'run-token' } : { files: ['test/a.test.ts', 'test/b.test.ts', '/etc/passwd', 7] } }));
  assert.deepEqual([r.code, r.list], [0, 'test/a.test.ts\ntest/b.test.ts\n'], r.said);
  assert.deepEqual(r.asked, ['/token?x=1&audience=citadel-ci-store Bearer ask', '/api/late-tests Bearer run-token']);
  assert.match(r.said, /2 load-sensitive test file\(s\) run after the main wave: test\/a\.test\.ts test\/b\.test\.ts/);
});

test('a Citadel that refuses, answers nonsense or a job with no token leaves no list, says so and never fails the step', async () => {
  for (const [answer, extra, why] of [
    [(p: string) => (p.startsWith('/token') ? { body: { value: 't' } } : { status: 503, body: 'busy' }), {}, /no list \(HTTP 503/],
    [(p: string) => ({ body: p.startsWith('/token') ? { value: 't' } : { files: 'x' } }), {}, /no list \(no list in the answer\)/],
    [() => ({ body: {} }), { ACTIONS_ID_TOKEN_REQUEST_URL: '' }, /no list \(no run token/],
    [() => ({ body: {} }), { RUNNER_ENVIRONMENT: 'github-hosted' }, /^$/],
  ] as const) {
    const r = await fetchList(answer, extra);
    assert.deepEqual([r.code, r.list], [0, null], r.said);
    assert.match(r.said, why);
  }
});

test("Test health shows a scheme's list once its CI has taken it, with each open fix's minion by number", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'late-view-'));
  const store = new Store(':memory:');
  const p = store.createProject('Peek Auras', null, null);
  const now = Date.now();
  const log = join(projectSharedDir(dir, p.id), 'retro-log', new Date(now).toISOString().slice(0, 10));
  mkdirSync(log, { recursive: true });
  writeFileSync(join(log, 'land.md'), ['1-x', '2-y'].map((b) => `- 00:00:00Z · flake · test/a.test.ts · load 30.1 · ticket/${b} · in CI\n`).join(''));
  assert.equal(await lateView({ store, dataDir: dir }, p.id), null, 'its CI never asked');
  store.setSetting(lateReadKey(p.id), now);
  const t = store.createTicket({ project_id: p.id, title: 'Fix', permission_mode: 'x', created_by: 'T' });
  store.addFlakeFix(p.id, 'test/a.test.ts', t.id, now);
  const view = await lateView({ store, dataDir: dir }, p.id);
  assert.equal(view?.readAt, now);
  assert.deepEqual(
    view?.listed.map((f) => [f.file, f.fixing]),
    [['test/a.test.ts', t.number]],
  );
  rmSync(dir, { recursive: true, force: true }); // timing-ok: own temp dir
});
