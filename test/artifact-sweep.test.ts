// The weekly GitHub artifact sweep (src/artifact-sweep.ts, #657): which artifacts it deletes and which it never touches.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArtifactSweep, kindOf, plan, type Artifact } from '../src/artifact-sweep.ts';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const DAY = 24 * 3600_000;
let id = 1;
const art = (name: string, daysAgo: number, size = 1_048_576): Artifact => ({ id: id++, name, size_in_bytes: size, created_at: new Date(NOW - daysAgo * DAY).toISOString() });
const sha = (n: number) => String(n).padStart(40, 'a');

test('kindOf drops a commit hash or run numbers but keeps the name', () => {
  assert.equal(kindOf(`overlay-shots-${sha(1)}`), 'overlay-shots');
  assert.equal(kindOf('desktop-1794352990-2430038'), 'desktop');
  assert.equal(kindOf('stress-logs-43106171733'), 'stress-logs');
  assert.equal(kindOf(`dumps-windows-${sha(2)}-2`), 'dumps-windows');
  assert.equal(kindOf('mandate-release-apk'), 'mandate-release-apk');
});

test('plan keeps the newest three of each kind and anything under two days old', () => {
  const shots = [0, 1, 3, 4, 5, 6].map((d, i) => art(`overlay-shots-${sha(i)}`, d));
  const apk = [art('mandate-release-apk', 20)];
  const del = plan([...shots, ...apk], NOW);
  // 6 shots: newest 3 (0, 1, 3 days) stay; 4, 5, 6 days go. The lone old release APK is the newest of its kind, so it stays.
  assert.deepEqual(del.map((a) => a.id).sort(), shots.slice(3).map((a) => a.id).sort());
});

test('plan never deletes a young artifact even when it is not among the newest', () => {
  const burst = [0, 0.1, 0.2, 0.3, 0.4].map((d, i) => art(`peek-auras-${sha(i)}`, d));
  assert.deepEqual(plan(burst, NOW), []);
});

test('plan skips expired artifacts', () => {
  const list = [0, 5, 6, 7, 8].map((d, i) => ({ ...art(`e2e-logs-${sha(i)}`, d), expired: i === 4 }));
  assert.deepEqual(plan(list, NOW).map((a) => a.id), [list[3].id]);
});

test('the round deletes per repo with that scheme\'s login, counts bytes, and leaves a repo it cannot read', async () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => art(`peek-auras-${sha(i)}`, 3 + i, 2_097_152));
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
  assert.deepEqual(asked, ['repos/caraminden/peek-auras/actions/artifacts|tok-1', 'repos/friend/private/actions/artifacts|tok-2']);
  assert.deepEqual(deleted, peek.slice(3).map((a) => `repos/caraminden/peek-auras/actions/artifacts/${a.id}`));
});

test('tick waits a week after its first look, then runs once', async () => {
  const store: any = { s: new Map(), getSetting(k: string) { return this.s.get(k); }, setSetting(k: string, v: unknown) { this.s.set(k, v); }, listProjects: () => [] };
  const sweep = new ArtifactSweep(store, { as: () => undefined });
  assert.equal(await sweep.tick(NOW), null);
  assert.equal(await sweep.tick(NOW + 6 * DAY), null);
  assert.deepEqual(await sweep.tick(NOW + 7 * DAY), []);
  assert.equal(await sweep.tick(NOW + 8 * DAY), null);
});
