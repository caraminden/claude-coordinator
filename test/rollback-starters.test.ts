// The ways back (src/rollback-starters.ts), each on stand-ins: what it starts, and every refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceError } from '../src/app-services.ts';
import { HttpError } from '../src/http.ts';
import { CITADEL_TARGET, type TargetView } from '../src/releases.ts';
import { rollbackStarters, type RollbackStarterDeps } from '../src/rollback-starters.ts';

const TO = 'a'.repeat(40);
const BAD = 'b'.repeat(40);
const DEPLOY = { DEPLOY_LIVE: 'l', DEPLOY_SOURCE: 's', DEPLOY_URL: 'u', DEPLOY_DB: 'd', DEPLOY_SERVICE: 'v', DEPLOY_UNIT: 'n' };
const KEY = { GH_TOKEN: 'x' };

type Job = ReturnType<RollbackStarterDeps['jobs']['state']>;
function world(over: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const dir = '/data/run/rollback';
  const s = {
    project: { id: 3, repo_dir: '/repo', repo_url: 'https://github.com/o/r' } as { id: number; repo_dir: string | null; repo_url: string } | undefined,
    own: 3,
    row: { name: 'peek', home_scheme: 3 } as object | undefined,
    apks: [
      { projectId: 4, id: 'apk:peek', contraption: 'other', workflow: null },
      { projectId: 3, id: 'apk:nope', contraption: 'nope', workflow: null },
      { projectId: 3, id: 'apk:peek', contraption: 'peek', workflow: 'release.yml' },
    ] as { projectId: number; id: string; contraption: string | null; workflow: string | null }[],
    pin: { sha: TO } as { sha: string } | null,
    job: null as Job,
    runningApps: [] as string[],
  };
  const call =
    (name: string, ret?: unknown) =>
    (...a: unknown[]) => (calls.push([name, ...a]), ret);
  const deps = {
    store: { getContraption: (n: string) => (n === 'peek' ? s.row : undefined), getProject: (id: number) => (id === 3 ? s.project : undefined) },
    lastGreen: { pinned: (id: number, t: string) => (id === 3 && t === CITADEL_TARGET ? s.pin : null) },
    finder: { list: (kind: string) => (kind === 'apk' ? s.apks : []) },
    ciPackages: { greenBuild: (id: number, t: string) => (id === 3 && t === 'ci:kit' ? { run: 7, sha: TO, workflow: 'w' } : null) },
    apk: { published: (id: number, t: string) => (id === 3 && t === 'apk:peek' ? 41 : null), rollingBack: (id: number, t: string) => id === 3 && t === 'apk:peek', started: call('started') },
    services: { running: (n: string) => (s.runningApps.includes(n) ? {} : null) },
    jobs: { state: (d: string, tail: number) => (calls.push(['state', d, tail]), s.job), start: call('job') },
    dir,
    clear: call('clear'),
    copy: false,
    deployLive: false,
    env: { PATH: '/bin', ...DEPLOY, DEPLOY_OTHER: 'no', DEPLOY_UNITS: 'no', MY_DEPLOY_DB: 'no' },
    ownScheme: () => (s.own === 3 ? s.project : { id: s.own }),
    githubOf: (d: string) => ({ ...KEY, dir: d }),
    startDeploy: call('deploy'),
    refresh: call('refresh'),
    failed: call('failed'),
    rollBackApk: async (...a: unknown[]) => (calls.push(['apk', ...a]), 42),
    ...over,
  };
  const r = rollbackStarters(deps as unknown as RollbackStarterDeps);
  return { s, r, dir, calls, named: (n: string) => calls.filter((c) => c[0] === n) };
}
type TV = Omit<TargetView, 'testCopies'>;
const tv = (kind: string, id: string, o: { projectId?: number; version?: string } = {}) => ({ target: { id, projectId: o.projectId ?? 3, name: 'Peek', kind, link: null }, current: { version: o.version ?? BAD, number: 41 }, next: null, line: [], recent: [] }) as unknown as TV;
const refused = (status: number, about: RegExp) => (e: unknown) => e instanceof HttpError && e.status === status && about.test(e.message);
const ended = (code: number, output = ''): Job => ({ code, output }) as unknown as Job;

test('an app goes back through its own deploy, as the person who pressed', async () => {
  const w = world();
  await w.r.starters.contraption(tv('contraption', 'app:peek'), TO, 'Cara', 9);
  assert.deepEqual(w.calls, [['deploy', w.s.row, 'Cara', 9, TO]]);
});

test("another scheme's app, an unknown one and a target that isn't an app are refused", () => {
  const w = world();
  for (const t of [tv('contraption', 'app:peek', { projectId: 4 }), tv('contraption', 'app:gone'), tv('contraption', 'peek')]) assert.throws(() => w.r.starters.contraption(t, TO, 'Cara', 9), refused(404, /Peek/));
  assert.deepEqual(w.calls, []);
});

test("a deploy's refusal keeps its status; any other error passes through", () => {
  const go = (err: Error) => () =>
    world({
      startDeploy: () => {
        throw err;
      },
    }).r.starters.contraption(tv('contraption', 'app:peek'), TO, 'Cara', 9);
  assert.throws(go(new ServiceError(423, 'busy now')), refused(423, /busy now/));
  const other = new Error('disk');
  assert.throws(go(other), (e) => e === other);
});

test('a CI package is held at its green build, or refused without one', async () => {
  const w = world();
  assert.deepEqual(await w.r.starters.ci(tv('ci', 'ci:kit'), TO, 'Cara', 9), { build: { run: 7, sha: TO, workflow: 'w' } });
  assert.throws(() => w.r.starters.ci(tv('ci', 'ci:other'), TO, 'Cara', 9), refused(409, /Peek/));
});

test("an APK's release is started at last green, then followed", async () => {
  const w = world({ copy: true });
  assert.deepEqual(await w.r.starters.apk(tv('apk', 'apk:peek'), TO, 'Cara', 9), { code: 42 });
  assert.deepEqual(w.calls, [['apk', { name: 'Peek', workflow: 'release.yml', slug: 'o/r', current: 41, copy: true, as: { ...KEY, dir: '/repo' }, branch: 'citadel/rollback' }, TO], ['started', w.s.apks[2]], ['refresh']]);
});

test('an APK off a copy is released for real, and one with no workflow passes null', async () => {
  const w = world();
  w.s.apks[2].workflow = null;
  await w.r.starters.apk(tv('apk', 'apk:peek'), TO, 'Cara', 9);
  const o = w.calls[0][1] as { copy: boolean; workflow: unknown };
  assert.equal(o.copy, false);
  assert.equal(o.workflow, null);
});

test('an APK with no target, app or repo is refused and starts nothing', async () => {
  const cases: ((w: ReturnType<typeof world>) => void)[] = [(w) => (w.s.apks = []), (w) => (w.s.apks[2].contraption = null), (w) => (w.s.project!.repo_dir = null), (w) => (w.s.project = undefined)];
  for (const set of cases) {
    const w = world();
    set(w);
    await assert.rejects(async () => w.r.starters.apk(tv('apk', 'apk:peek'), TO, 'Cara', 9), refused(409, /Peek/));
    assert.deepEqual(w.calls, []);
  }
});

test('an APK whose start fails is not followed', async () => {
  const w = world({
    rollBackApk: async () => {
      throw new HttpError(409, 'no input');
    },
  });
  await assert.rejects(async () => w.r.starters.apk(tv('apk', 'apk:peek'), TO, 'Cara', 9), refused(409, /no input/));
  assert.deepEqual(w.calls, []);
});

test("Citadel's server goes back in a job of its own, with only deploy.sh's own paths added", async () => {
  const w = world();
  await w.r.starters[CITADEL_TARGET](tv(CITADEL_TARGET, CITADEL_TARGET), TO, 'Cara', 9);
  const j = w.named('job')[0][1] as Record<string, unknown>;
  const env = j.env as Record<string, string>;
  assert.equal(j.dir, w.dir);
  assert.equal(j.cwd, '/repo');
  assert.deepEqual(j.argv, ['bash', 'tools/deploy.sh', '--to', TO]);
  assert.equal(env.PATH, '/bin');
  assert.deepEqual(Object.fromEntries(Object.entries(env).filter(([k]) => k.includes('DEPLOY'))), DEPLOY);
  assert.match(String(j.unit), /^citadel-rollback-\d+$/);
  assert.equal(j.ticketId, 0);
});

test('an empty deploy.sh path is left to its default', async () => {
  const w = world({ env: { DEPLOY_LIVE: '/scratch', DEPLOY_DB: '' } });
  await w.r.starters[CITADEL_TARGET](tv(CITADEL_TARGET, CITADEL_TARGET), TO, 'Cara', 9);
  const { env } = w.named('job')[0][1] as { env: Record<string, string> };
  assert.equal(env.DEPLOY_LIVE, '/scratch');
  assert.ok(!('DEPLOY_DB' in env));
});

test('only the scheme this server runs, with a clone, can roll Citadel back', () => {
  const cases: ((w: ReturnType<typeof world>) => void)[] = [(w) => (w.s.own = 5), (w) => (w.s.project = undefined), (w) => (w.s.project!.repo_dir = null)];
  for (const set of cases) {
    const w = world();
    set(w);
    assert.throws(() => w.r.starters[CITADEL_TARGET](tv(CITADEL_TARGET, CITADEL_TARGET), TO, 'Cara', 9), refused(404, /scheme/));
    assert.deepEqual(w.calls, []);
  }
});

test('a copy rolls Citadel back only when it was given a checkout', () => {
  const go = (deployLive: boolean) => {
    const w = world({ copy: true, deployLive });
    return [w, () => w.r.starters[CITADEL_TARGET](tv(CITADEL_TARGET, CITADEL_TARGET), TO, 'Cara', 9)] as const;
  };
  const [no, start] = go(false);
  assert.throws(start, refused(409, /copy/));
  assert.deepEqual(no.calls, []);
  const [yes, ok] = go(true);
  ok();
  assert.equal(yes.named('job').length, 1);
});

test("Citadel's roll back runs until its job ends", () => {
  const w = world();
  const t = tv(CITADEL_TARGET, CITADEL_TARGET);
  assert.equal(w.r.running(t), false);
  assert.equal(w.named('clear').length, 0);
  w.s.job = { code: null, output: '' } as unknown as Job;
  assert.equal(w.r.running(t), true);
  assert.equal(w.named('clear').length, 0);
  assert.deepEqual(w.named('state')[0], ['state', w.dir, 2000]);
  assert.equal(w.named('failed').length, 0);
});

test('a failed job is reported with its last lines and cleared', () => {
  const w = world();
  w.s.job = ended(1, 'one\ntwo\nthree\nfour\n');
  assert.equal(w.r.running(tv(CITADEL_TARGET, CITADEL_TARGET)), false);
  const [, ...a] = w.named('failed')[0];
  assert.deepEqual(a.slice(0, 3), [3, CITADEL_TARGET, TO]);
  assert.match(String(a[3]), /two three four$/);
  assert.doesNotMatch(String(a[3]), /one/);
  assert.equal(w.named('clear').length, 1);
});

test('a failed job that said nothing is reported by its exit code', () => {
  const w = world();
  w.s.job = ended(7);
  w.r.running(tv(CITADEL_TARGET, CITADEL_TARGET));
  assert.match(String(w.named('failed')[0][4]), /\b7$/);
});

test('a job that went live, exited 0, or has no pin or scheme is cleared without a report', () => {
  const cases: ((w: ReturnType<typeof world>) => TV)[] = [
    (w) => ((w.s.job = ended(1)), tv(CITADEL_TARGET, CITADEL_TARGET, { version: TO })),
    (w) => ((w.s.job = ended(0)), tv(CITADEL_TARGET, CITADEL_TARGET)),
    (w) => ((w.s.job = ended(1)), (w.s.pin = null), tv(CITADEL_TARGET, CITADEL_TARGET)),
    (w) => ((w.s.job = ended(1)), (w.s.project = undefined), tv(CITADEL_TARGET, CITADEL_TARGET)),
  ];
  for (const set of cases) {
    const w = world();
    const t = set(w);
    assert.equal(w.r.running(t), false);
    assert.equal(w.named('failed').length, 0);
    assert.equal(w.named('clear').length, 1);
  }
});

test('an app or an APK runs as its own reader says', () => {
  const w = world();
  assert.equal(w.r.running(tv('contraption', 'app:peek')), false);
  w.s.runningApps = ['peek'];
  assert.equal(w.r.running(tv('contraption', 'app:peek')), true);
  assert.equal(w.r.running(tv('contraption', 'peek')), false);
  assert.equal(w.r.running(tv('apk', 'apk:peek')), true);
  assert.equal(w.r.running(tv('apk', 'apk:peek', { projectId: 4 })), false);
});

test("an APK Citadel builds follows its app; one its CI signs, and any other kind, doesn't", () => {
  const w = world();
  assert.equal(w.r.follows(tv('apk', 'apk:peek')), null);
  w.s.apks[2].workflow = null;
  assert.equal(w.r.follows(tv('apk', 'apk:peek')), 'app:peek');
  assert.equal(w.r.follows(tv('contraption', 'apk:peek')), null);
  w.s.apks[2].contraption = null;
  assert.equal(w.r.follows(tv('apk', 'apk:peek')), null);
  assert.equal(w.r.published(tv('apk', 'apk:peek')), 41);
  assert.equal(w.r.published(tv('ci', 'apk:peek')), null);
});
