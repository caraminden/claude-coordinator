// An Android app's release step (src/apk-deploy.ts, #1838), on stand-ins: no server boot, no GitHub.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { apkDeployer, publisher } from '../src/apk-deploy.ts';
import { OldApk, OtherKey } from '../src/apk-release.ts';
import type { CiFile, Project } from '../src/db.ts';
import { HttpError } from '../src/http.ts';
import { ROLLBACK_BRANCH, type ApkReader } from '../src/release-readers.ts';
import type { Found } from '../src/release-targets.ts';
import type { Run } from '../src/ci-view.ts';

const P = { id: 7, repo_dir: '/repo', repo_url: 'https://github.com/o/mandate.git' } as Project;
const T = { projectId: 7, id: 'apk:mandate', kind: 'apk', name: 'Mandate Android', branch: 'main', workflow: '.github/workflows/release.yml', contraption: 'mandate' } as Found;
const RUN = { id: 42, head_branch: 'main' } as Run;
type Pending = ReturnType<ApkReader['pending']>;
const PUBLISH: Pending = { step: 'publish', run: RUN, current: 5, main: { code: 6, name: '1.6' } };
const DISPATCH: Pending = { step: 'dispatch', head: 'abc' };

function deployer(pending: Pending, o: { project?: Partial<Project> | null; published?: number | Error; dispatchFails?: Error } = {}) {
  const did: unknown[][] = [];
  const d = apkDeployer({
    store: { getProject: (id) => (id === 7 && o.project !== null ? ({ ...P, ...o.project } as Project) : undefined) as Project },
    apkReader: {
      pending: () => pending,
      started: (t) => void did.push(['started', t.id]),
      tooOld: (id) => void did.push(['tooOld', id]),
    },
    githubOf: (dir) => ({ GH: dir }),
    publishRun: async (t, run, current, main, by, uid) => {
      did.push(['publishRun', t.id, run.id, current, main, by, uid]);
      if (o.published instanceof Error) throw o.published;
      return o.published ?? 6;
    },
    refresh: () => void did.push(['refresh']),
    dispatch: async (...a) => {
      did.push(['dispatch', ...a]);
      if (o.dispatchFails) throw o.dispatchFails;
    },
  });
  return { d, did };
}
const RELEASE = [
  ['dispatch', 'o/mandate', 'release.yml', 'main', { GH: '/repo' }],
  ['started', 'apk:mandate'],
];

test('it waits and names its head by what is pending', async () => {
  const none = deployer(null).d;
  assert.equal(none.waits(T, {} as never), false);
  assert.equal(await none.head(T), null);
  assert.equal(deployer(DISPATCH).d.waits(T, {} as never), true);
  assert.equal(await deployer(DISPATCH).d.head(T), 'dispatch:abc');
  assert.equal(await deployer(PUBLISH).d.head(T), 'publish:42');
});

test('a bumped version starts its release workflow, says so, and reads the releases again', async () => {
  const { d, did } = deployer(DISPATCH);
  assert.match(String(await d.start(T, 'Cara', 3)), /release run of main \(\.github\/workflows\/release\.yml\)/);
  assert.deepEqual(did, [...RELEASE, ['refresh']]);
});

test('a signed run is published, with no new release run', async () => {
  const { d, did } = deployer(PUBLISH);
  assert.equal(await d.start(T, '#12', 3), "Published mandate's Android build 6 from release.yml run 42: installed phones see the update now.");
  assert.deepEqual(did, [['publishRun', 'apk:mandate', 42, 5, { code: 6, name: '1.6' }, '#12', 3], ['refresh']]);
});

test('an APK signed before the version bump is marked too old and main is signed instead', async () => {
  const { d, did } = deployer(PUBLISH, { published: new OldApk('old') });
  assert.match(String(await d.start(T, 'Cara', 3)), /release run of main/);
  assert.deepEqual(did.slice(1), [['tooOld', 42], ...RELEASE, ['refresh']]);
});

test('an APK with another key is refused, and nothing else is done', async () => {
  const { d, did } = deployer(PUBLISH, { published: new OtherKey('other key') });
  await assert.rejects(
    async () => d.start(T, 'Cara', 3),
    (e: unknown) => e instanceof HttpError && e.status === 409 && e.message === 'other key',
  );
  assert.deepEqual(
    did.map((x) => x[0]),
    ['publishRun'],
  );
});

test('any other failure comes out as it is, with no release run and the releases not re-read', async () => {
  const boom = new Error('gh broke');
  const a = deployer(PUBLISH, { published: boom });
  await assert.rejects(async () => a.d.start(T, 'Cara', 3), boom);
  assert.deepEqual(
    a.did.map((x) => x[0]),
    ['publishRun'],
  );
  const b = deployer(DISPATCH, { dispatchFails: boom });
  await assert.rejects(async () => b.d.start(T, 'Cara', 3), boom);
  assert.deepEqual(
    b.did.map((x) => x[0]),
    ['dispatch'],
    'a run that did not start is not marked started',
  );
});

test('with nothing waiting, or no repo, app or workflow, it is refused and nothing is done', async () => {
  const cases: [Pending, Partial<Project> | null, Partial<Found>][] = [
    [null, {}, {}],
    [DISPATCH, null, {}],
    [DISPATCH, { repo_dir: null }, {}],
    [DISPATCH, { repo_url: null }, {}],
    [DISPATCH, {}, { workflow: undefined }],
    [DISPATCH, {}, { contraption: undefined }],
  ];
  for (const [pending, project, t] of cases) {
    const { d, did } = deployer(pending, { project });
    await assert.rejects(
      async () => d.start({ ...T, ...t }, 'Cara', 3),
      (e: unknown) => e instanceof HttpError && e.status === 409 && /nothing to release/.test(e.message),
    );
    assert.deepEqual(did, []);
  }
});

function publishing(o: { stored?: CiFile; plain?: string | null; project?: Partial<Project> | null; refuse?: Error } = {}) {
  const did: unknown[][] = [];
  const run = publisher({
    store: {
      getProject: () => (o.project === null ? undefined : ({ ...P, ...o.project } as Project)) as Project,
      getUser: (id) => (id === 3 ? { name: 'Cara' } : null) as never,
      publishCiFile: (id, to) => void did.push(['publishCiFile', id, to]),
      recordApkPublish: (r) => void did.push(['record', r]),
    },
    ciStore: { releaseApk: (p, r) => (p === 7 && r === 42 ? o.stored : undefined), plain: async () => o.plain ?? null },
    home: '/home/x',
    githubOf: (dir) => ({ GH: dir }),
    tellHome: (id, text) => void did.push(['tell', id, text]),
    publish: async (a) => {
      did.push(['publish', a]);
      if (o.refuse) throw o.refuse;
      return 6;
    },
  });
  return { run, did };
}
const WITH = { slug: 'o/mandate', runId: 42, feedFile: join('/home/x', '.local/share', 'mandate', 'android', 'latest.json'), current: 5, main: { code: 6, name: '1.6' }, as: { GH: '/repo' } };
const RECORD = { projectId: 7, contraption: 'mandate', versionCode: 6, runId: 42 };

test("a run's APK in the CI store is published from there, marked published, recorded and told", async () => {
  const { run, did } = publishing({ stored: { id: 9 } as CiFile, plain: '/tmp/m.apk' });
  assert.equal(await run(T, RUN, 5, { code: 6, name: '1.6' }, 'Cara', 3), 6);
  assert.deepEqual(did, [
    ['publish', { ...WITH, stored: '/tmp/m.apk' }],
    ['publishCiFile', 9, 'mandate/android'],
    ['record', { ...RECORD, by: 'Cara', uid: 3 }],
    ['tell', 7, "Cara published mandate's Android build 6 from release.yml run 42."],
  ]);
});

test('without one, GitHub has the APK: none marked published; and a stored file that will not open falls back too', async () => {
  const none = publishing();
  await none.run(T, RUN, 5, { code: 6, name: '1.6' }, 'Cara', 3);
  assert.deepEqual(none.did[0], ['publish', { ...WITH, stored: undefined }]);
  assert.deepEqual(
    none.did.map((x) => x[0]),
    ['publish', 'record', 'tell'],
  );
  const shut = publishing({ stored: { id: 9 } as CiFile, plain: null });
  await shut.run(T, RUN, 5, { code: 6, name: '1.6' }, 'Cara', 3);
  assert.deepEqual(shut.did[0], ['publish', { ...WITH, stored: undefined }]);
  assert.deepEqual(shut.did[1], ['publishCiFile', 9, 'mandate/android']);
});

test("the note says who: a minion's person, a person, or a roll back", async () => {
  const tell = async (by: string, uid: number | null, branch = 'main') => {
    const s = publishing();
    await s.run(T, { ...RUN, head_branch: branch }, 5, { code: 6, name: '1.6' }, by, uid);
    return s.did.at(-1)![2];
  };
  assert.match(String(await tell('#12', 3)), /^#12 \(for Cara\) published/);
  assert.match(String(await tell('#12', 99)), /^#12 \(for someone\) published/);
  assert.match(String(await tell('#12', null)), /^#12 published/);
  assert.match(String(await tell('a roll back', null, ROLLBACK_BRANCH)), / run 42 \(last green, rolled back on citadel\/rollback\)\.$/);
});

test('a refused publish records and tells nothing; no repo or app is refused before anything', async () => {
  const s = publishing({ stored: { id: 9 } as CiFile, plain: '/tmp/m.apk', refuse: new OtherKey('k') });
  await assert.rejects(s.run(T, RUN, 5, { code: 6, name: null }, 'Cara', 3), OtherKey);
  assert.deepEqual(
    s.did.map((x) => x[0]),
    ['publish'],
  );
  for (const [project, t] of [
    [null, {}],
    [{ repo_dir: null }, {}],
    [{ repo_url: null }, {}],
    [{}, { contraption: undefined }],
  ] as [Partial<Project> | null, Partial<Found>][]) {
    const r = publishing({ project });
    await assert.rejects(r.run({ ...T, ...t }, RUN, 5, { code: 6, name: null }, 'Cara', 3), /no repo or app to publish into/);
    assert.deepEqual(r.did, []);
  }
});
