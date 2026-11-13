// The weekly GitHub artifact sweep (src/artifact-sweep.ts, #657): which artifacts it deletes and which it never touches.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArtifactSweep, MAX_DELETES, kindOf, plan, type Artifact } from '../src/artifact-sweep.ts';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const DAY = 24 * 3600_000;
let id = 1;
const art = (name: string, daysAgo: number, size = 1_048_576, branch = 'main'): Artifact => ({ id: id++, name, size_in_bytes: size, created_at: new Date(NOW - daysAgo * DAY).toISOString(), workflow_run: { head_branch: branch } });
const sha = (n: number) => String(n).padStart(40, 'a');

test('kindOf drops a commit hash or run numbers but keeps the name', () => {
  assert.equal(kindOf(`overlay-shots-${sha(1)}`), 'overlay-shots');
  assert.equal(kindOf('desktop-1794352990-2430038'), 'desktop');
  assert.equal(kindOf('stress-logs-43106171733'), 'stress-logs');
  assert.equal(kindOf(`dumps-windows-${sha(2)}-2`), 'dumps-windows');
  assert.equal(kindOf('mandate-release-apk'), 'mandate-release-apk');
});

test('plan keeps the newest three of each kind and anything under two days old', () => {
  const shots = [0, 1, 3, 4, 5, 6].map((d, i) => art(`overlay-shots-${sha(i)}`, d, undefined, 'land/x'));
  const apk = [art('mandate-release-apk', 20)];
  const del = plan([...shots, ...apk], NOW);
  // 6 shots: newest 3 (0, 1, 3 days) stay; 4, 5, 6 days go. The lone old release APK is the newest of its kind, so it stays.
  assert.deepEqual(del.map((a) => a.id).sort(), shots.slice(3).map((a) => a.id).sort());
});

test('builds of the default branch keep twelve, and land branches cannot push them out', () => {
  const main = Array.from({ length: 14 }, (_, i) => art(`peek-auras-${sha(i)}`, 3 + i));
  const lands = Array.from({ length: 6 }, (_, i) => art(`peek-auras-${sha(100 + i)}`, 3 + i, undefined, 'land/y'));
  const del = plan([...main, ...lands], NOW).map((a) => a.id).sort();
  assert.deepEqual(del, [...main.slice(12), ...lands.slice(3)].map((a) => a.id).sort());
});

test('plan never deletes a young artifact even when it is not among the newest', () => {
  const burst = [0, 0.1, 0.2, 0.3, 0.4].map((d, i) => art(`peek-auras-${sha(i)}`, d));
  assert.deepEqual(plan(burst, NOW), []);
});

test('plan skips expired artifacts', () => {
  const list = [0, 5, 6, 7, 8].map((d, i) => ({ ...art(`e2e-logs-${sha(i)}`, d, undefined, 'land/e'), expired: i === 4 }));
  assert.deepEqual(plan(list, NOW).map((a) => a.id), [list[3].id]);
});

test('the round deletes per repo with that scheme\'s login, counts bytes, and leaves a repo it cannot read', async () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => art(`peek-auras-${sha(i)}`, 3 + i, 2_097_152, 'land/q'));
  const peek = mk(5);
  const asked: string[] = [];
  const deleted: string[] = [];
  const store: any = {
    settings: new Map<string, unknown>(),
    getSetting(k: string) { return this.settings.get(k); },
    setSetting(k: string, v: unknown) { this.settings.set(k, v); },
    listProjects: () => [
      { id: 1, name: 'Peek', repo_url: 'https://github.com/caraminden/peek-auras.git', repo_dir: '/a' },
      { id: 2, name: 'Other', repo_url: 'https://github.com/friend/private.git', repo_dir: '/b' },
      { id: 3, name: 'Dup', repo_url: 'https://github.com/caraminden/peek-auras', repo_dir: '/c' },
    ],
  };
  const sweep = new ArtifactSweep(store, {
    as: (p) => ({ GH_TOKEN: `tok-${p.id}` }),
    get: async (path, _e, as) => {
      asked.push(`${path.split('?')[0]}|${as?.GH_TOKEN}`);
      return path.includes('friend/') ? { status: 404, etag: null, body: null } : { status: 200, etag: null, body: { artifacts: peek } };
    },
    del: async (path) => (deleted.push(path), { status: 204 }),
  });
  const out = await sweep.sweepAll(NOW);
  assert.deepEqual(out.map((r) => [r.repo, r.deleted, r.bytes, r.error ?? null]), [
    ['caraminden/peek-auras', 2, 4_194_304, null],
    ['friend/private', 0, 0, 'GitHub answered 404'],
  ]);
  assert.deepEqual(asked, ['repos/caraminden/peek-auras/actions/artifacts|tok-1', 'repos/caraminden/peek-auras|tok-1', 'repos/friend/private/actions/artifacts|tok-2']);
  assert.deepEqual(deleted, peek.slice(3).map((a) => `repos/caraminden/peek-auras/actions/artifacts/${a.id}`));
});

function oneRepo(artifacts: Artifact[], status: number) {
  const deleted: number[] = [];
  const store: any = { s: new Map(), getSetting() { return undefined; }, setSetting() {}, listProjects: () => [{ id: 1, name: 'P', repo_url: 'https://github.com/o/r', repo_dir: '/a' }] };
  const sweep = new ArtifactSweep(store, {
    as: () => undefined,
    get: async (path) => (path.endsWith('/r') ? { status: 200, etag: null, body: { default_branch: 'main' } } : { status: 200, etag: null, body: { artifacts } }),
    del: async (path) => (deleted.push(Number(path.split('/').pop())), { status }),
  });
  return { sweep, deleted };
}

test('a refused delete ends that repo\'s round at once, and counts nothing freed', async () => {
  const { sweep, deleted } = oneRepo(Array.from({ length: 8 }, (_, i) => art(`x-${sha(i)}`, 5 + i, 100, 'land/z')), 403);
  const [r] = await sweep.sweepAll(NOW);
  assert.equal(deleted.length, 1);
  assert.deepEqual([r.deleted, r.bytes, r.failed, r.error], [0, 0, 1, 'GitHub answered 403 to a delete']);
});

test('an artifact already gone (404) is not counted as freed', async () => {
  const { sweep, deleted } = oneRepo(Array.from({ length: 5 }, (_, i) => art(`x-${sha(i)}`, 5 + i, 100, 'land/z')), 404);
  const [r] = await sweep.sweepAll(NOW);
  assert.equal(deleted.length, 2);
  assert.deepEqual([r.deleted, r.bytes, r.failed], [0, 0, 0]);
});

test('one round deletes at most MAX_DELETES from a repo', async () => {
  const { sweep, deleted } = oneRepo(Array.from({ length: MAX_DELETES + 50 }, (_, i) => art(`x-${sha(i)}`, 5 + i / 1000, 1, 'land/z')), 204);
  const [r] = await sweep.sweepAll(NOW);
  assert.equal(deleted.length, MAX_DELETES);
  assert.equal(r.deleted, MAX_DELETES);
});

test('a later page that fails still sweeps what page one listed', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => art(`x-${sha(i)}`, 5 + i / 100, 1, 'land/z'));
  const deleted: number[] = [];
  const store: any = { getSetting() {}, setSetting() {}, listProjects: () => [{ id: 1, name: 'P', repo_url: 'https://github.com/o/r', repo_dir: '/a' }] };
  const sweep = new ArtifactSweep(store, {
    as: () => undefined,
    get: async (path) => (path.endsWith('/r') ? { status: 200, etag: null, body: {} } : path.endsWith('&page=1') ? { status: 200, etag: null, body: { artifacts: page1 } } : { status: 502, etag: null, body: null }),
    del: async (path) => (deleted.push(1), { status: 204 }),
  });
  const [r] = await sweep.sweepAll(NOW);
  assert.equal(r.deleted, 97);
});

test('tick waits a week after its first look, then runs once', async () => {
  const store: any = { s: new Map(), getSetting(k: string) { return this.s.get(k); }, setSetting(k: string, v: unknown) { this.s.set(k, v); }, listProjects: () => [] };
  const sweep = new ArtifactSweep(store, { as: () => undefined });
  assert.equal(await sweep.tick(NOW), null);
  assert.equal(await sweep.tick(NOW + 6 * DAY), null);
  assert.deepEqual(await sweep.tick(NOW + 7 * DAY), []);
  assert.equal(await sweep.tick(NOW + 8 * DAY), null);
});
