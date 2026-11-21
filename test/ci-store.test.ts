import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AUDIENCE, CiStore, ISSUER, RULES, RunTokens, sweepPlan, uploadAsk } from '../src/ci-store.ts';
import { Store } from '../src/db.ts';
import { publish } from '../src/apk-release.ts';
import { bootServer, freePort, until } from './helpers.ts';

// The CI store (#658, src/ci-store.ts): who may upload (GitHub's run token), what an upload leaves on disk and in
// ci_files, what the rules delete and never delete, and how members read it back.
const root = mkdtempSync(join(tmpdir(), 'ci-store-'));
after(() => rmSync(root, { recursive: true, force: true }));

const github = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = [{ ...github.publicKey.export({ format: 'jwk' }), kid: 'k1' }];
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const SHA = 'a'.repeat(40);

/** A run token as GitHub would sign it for a job in `repo`, with `over` laid over its claims. */
function runToken(over: Record<string, unknown> = {}, o: { key?: KeyObject; head?: Record<string, unknown> } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: ISSUER, aud: AUDIENCE, exp: now + 300, nbf: now - 300, repository: 'caraminden/mandate', run_id: '4349', run_attempt: '1', sha: SHA,
    ref: 'refs/heads/main', workflow_ref: 'caraminden/mandate/.github/workflows/android.yml@refs/heads/main', ...over,
  };
  const body = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...o.head })}.${b64(claims)}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), o.key ?? github.privateKey).toString('base64url')}`;
}

test('a run token is taken only when GitHub signed it for this store and it has not run out', async () => {
  const tokens = new RunTokens(async () => jwks);
  assert.deepEqual(await tokens.check(runToken()), { repository: 'caraminden/mandate', workflow: 'android.yml', runId: 4349, runAttempt: 1, sha: SHA, ref: 'refs/heads/main' });
  const refused = async (token: string, why: RegExp) => assert.rejects(tokens.check(token), (err: any) => err.status === 401 && why.test(err.message), String(why));
  await refused(runToken({}, { key: other.privateKey }), /signature doesn't match/);
  await refused(runToken({ aud: 'https://github.com/caraminden' }), /another audience/);
  await refused(runToken({ iss: 'https://evil.example' }), /not issued by GitHub/);
  await refused(runToken({ exp: Math.floor(Date.now() / 1000) - 600 }), /run out/);
  await refused(runToken({}, { head: { kid: 'k9' } }), /key GitHub doesn't list/);
  await refused(runToken({ workflow_ref: 'caraminden/mandate/.github/workflows/../../x@refs/heads/main' }), /names no repo/);
  await refused(runToken({ run_id: '../7' }), /names no repo/);
  // The header never picks the algorithm: an unsigned token and one "signed" with the public key as an HMAC secret.
  const [h, c] = runToken().split('.');
  await refused(`${b64({ alg: 'none', kid: 'k1' })}.${c}.`, /not signed the way GitHub signs/);
  await refused(`${b64({ alg: 'HS256', kid: 'k1' })}.${c}.AAAA`, /not signed the way GitHub signs/);
  // A payload changed after signing.
  await refused(`${h}.${b64({ ...JSON.parse(Buffer.from(c, 'base64url').toString()), repository: 'caraminden/peek-auras' })}.${runToken().split('.')[2]}`, /signature doesn't match/);
  await refused('nonsense', /not a JWT/);
});

test('a run token checked while GitHub\'s keys can\'t be read is a retryable 503 that blames the read, and the read is tried again soon', async () => {
  // #846: a fresh process whose first read of the keys timed out refused a real token as "a key GitHub doesn't list".
  let t = Date.now(), reads = 0;
  const answers: (() => Promise<any>)[] = [async () => { throw new Error('The operation was aborted due to timeout'); }, async () => [], async () => jwks];
  const tokens = new RunTokens(() => (reads++, answers.shift()!()), () => t);
  const unread = (why: RegExp) => assert.rejects(tokens.check(runToken()), (err: any) => err.status === 503 && /couldn't read GitHub's signing keys/.test(err.message) && why.test(err.message) && !/Not a GitHub run token/.test(err.message));
  await unread(/aborted due to timeout/);
  t += 10_000;
  // An empty list is no better than none.
  await unread(/no keys/);
  t += 10_000;
  assert.equal((await tokens.check(runToken())).runId, 4349);
  assert.equal(reads, 3);
});

test('an upload\'s name, kind and target are checked before anything is written', () => {
  assert.deepEqual(uploadAsk('mandate-7.apk', new URLSearchParams('kind=release')), { name: 'mandate-7.apk', kind: 'release', target: '' });
  for (const name of ['', '.hidden', '..', 'a/b', 'a\\b', 'x'.repeat(151), 'a b']) assert.throws(() => uploadAsk(name, new URLSearchParams('kind=build')), /name is/, name);
  assert.throws(() => uploadAsk('a.zip', new URLSearchParams('kind=secret')), /kind must be/);
  assert.throws(() => uploadAsk('a.zip', new URLSearchParams('kind=build&target=../x')), /target is/);
});

const DAY = 24 * 60 * 60_000;
const NOW = 1_800_000_000_000;
let nextId = 1;
const row = (o: Partial<Parameters<typeof sweepPlan>[0][number]>) => ({ id: nextId++, project_id: 1, workflow: 'w.yml', run_id: nextId, kind: 'build', target: '', size: 10, created_at: NOW, published_to: null, published_at: null, ...o });

test('the rules: reports by age, builds and releases by count, and the newest and the published never', () => {
  const oldReport = row({ kind: 'report', created_at: NOW - 8 * DAY });
  const newReport = row({ kind: 'report', created_at: NOW - 6 * DAY });
  // Seven runs of builds, oldest first; run 3 uploaded two files.
  const builds = [1, 2, 3, 3, 4, 5, 6, 7].map((run, i) => row({ run_id: run, created_at: NOW - (20 - i) * DAY }));
  // Another target of the same workflow keeps its own newest, however old.
  const win = row({ target: 'windows', created_at: NOW - 400 * DAY });
  // Twelve releases: the two oldest are past 180 days, but one of them is what the feed links to.
  const releases = Array.from({ length: 12 }, (_, i) => row({ kind: 'release', run_id: 100 + i, created_at: NOW - (i < 2 ? 200 - i : 30 - i) * DAY }));
  releases[0].published_to = 'mandate/android';
  releases[0].published_at = NOW - 190 * DAY;
  const gone = sweepPlan([oldReport, newReport, ...builds, win, ...releases], NOW).sort((a, b) => a - b);
  assert.deepEqual(gone, [oldReport.id, builds[0].id, builds[1].id, releases[1].id], 'the report past 7 days, the builds of runs beyond the newest 5, and the one old unpublished release beyond the newest 10');
  // Once a newer release is published to the same place, the old one's protection lapses.
  releases[5].published_to = 'mandate/android';
  releases[5].published_at = NOW;
  assert.ok(sweepPlan([...releases], NOW).includes(releases[0].id));
  // A run kept by name (a CI package's last green or pinned build, ADR 0012) stays, its reports don't.
  const report = row({ kind: 'report', run_id: builds[0].run_id, created_at: NOW - 8 * DAY });
  assert.deepEqual(sweepPlan([...builds, report], NOW, RULES, new Set([`1/${builds[0].run_id}`])).sort((a, b) => a - b), [builds[1].id, report.id]);
});

test('the caps take the oldest unprotected first, reports then builds then releases, and never a protected file', () => {
  const rules = { ...RULES, schemeBytes: 45, totalBytes: 70 };
  const a = [row({ kind: 'release', run_id: 1, created_at: NOW - 3 * DAY }), row({ kind: 'release', run_id: 2, created_at: NOW - 2 * DAY }), row({ run_id: 3, created_at: NOW - 2 * DAY }), row({ run_id: 4, created_at: NOW - DAY }),
    row({ kind: 'report', created_at: NOW - 2 * DAY }), row({ kind: 'report', created_at: NOW - DAY })];
  // 60 bytes against 45: both reports go before any build; the newest build and release are never candidates.
  assert.deepEqual(sweepPlan(a, NOW, rules).sort((x, y) => x - y), [a[4].id, a[5].id]);
  // 30 bytes over with no reports: the older build, then the older release.
  assert.deepEqual(sweepPlan(a.slice(0, 4), NOW, { ...rules, schemeBytes: 20 }).sort((x, y) => x - y), [a[0].id, a[2].id]);
  // Another scheme under its own cap still gives up its spare files when all schemes together are over.
  const b = [row({ project_id: 2, run_id: 1, created_at: NOW - 5 * DAY }), row({ project_id: 2, run_id: 2, created_at: NOW - 4 * DAY }), row({ project_id: 2, run_id: 3, created_at: NOW })].map((r) => ({ ...r, size: 15 }));
  const gone = sweepPlan([...a, ...b], NOW, rules);
  assert.ok(gone.includes(b[0].id) && !gone.includes(b[2].id), 'the other scheme\'s oldest spare build goes, its newest stays');
  // Only protected files left: nothing more to take, however far over.
  assert.deepEqual(sweepPlan([row({ size: 1000 })], NOW, rules), []);
});

/** A request as the upload handler reads it. */
function request(body: Buffer | string, token: string | null, headers: Record<string, string> = {}): any {
  const req: any = Readable.from([Buffer.from(body)]);
  req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-length': String(Buffer.byteLength(body)), ...headers };
  return req;
}

test('an upload lands under its scheme and run with a row, replaces itself, and leaves nothing behind when refused', async () => {
  const data = join(root, 'unit');
  const store = new Store(join(root, 'unit.db'));
  const mandate = store.createProject('Mandate', 'https://github.com/caraminden/mandate.git', null);
  store.createProject('Peek Auras', 'https://github.com/caraminden/peek-auras', null);
  const ci = new CiStore(store, data, new RunTokens(async () => jwks), { ...RULES, fileBytes: 100, schemeBytes: 250 });
  const notes: string[] = [];
  ci.onFull = (p, words) => notes.push(`${p.name}: ${words}`);

  const f = await ci.upload(request('signed apk', runToken()), { name: 'mandate-7.apk', kind: 'release', target: '' });
  assert.equal(ci.path(f), join(data, 'projects', String(mandate.id), 'ci-store', 'android.yml', '4349-1', 'mandate-7.apk'));
  assert.equal(readFileSync(ci.path(f), 'utf8'), 'signed apk');
  assert.deepEqual({ ...f, id: 0, created_at: 0 }, {
    id: 0, project_id: mandate.id, workflow: 'android.yml', run_id: 4349, run_attempt: 1, sha: SHA, ref: 'refs/heads/main', name: 'mandate-7.apk', kind: 'release', target: '',
    size: 10, sha256: createHash('sha256').update('signed apk').digest('hex'), created_at: 0, published_to: null, published_at: null,
  });

  // The same run and name again replaces the file and its row.
  const again = await ci.upload(request('signed apk, rebuilt', runToken()), { name: 'mandate-7.apk', kind: 'release', target: '' });
  assert.equal(again.id, f.id);
  assert.equal(readFileSync(ci.path(f), 'utf8'), 'signed apk, rebuilt');
  assert.equal(store.ciFiles(mandate.id).length, 1);

  const refused = async (req: any, status: number, why: RegExp) => assert.rejects(ci.upload(req, { name: 'x.zip', kind: 'build', target: '' }), (err: any) => err.status === status && why.test(err.message), String(why));
  await refused(request('x', null), 401, /run token/);
  await refused(request('x', runToken({ repository: 'someone/else' })), 403, /No scheme has the repo someone\/else/);
  await refused(request('x'.repeat(101), runToken()), 413, /limited to/);
  // A body longer than it declared is caught as it streams, not trusted.
  await refused(request('x'.repeat(101), runToken(), { 'content-length': '5' }), 400, /longer than its Content-Length/);
  await refused(request('xx', runToken(), { 'content-length': '5' }), 400, /stopped part-way/);
  await refused(request('', runToken()), 411, /empty/);
  await refused(request('x', runToken(), { 'content-length': '' }), 411, /Content-Length/);
  assert.deepEqual(readdirSync(join(data, 'projects', String(mandate.id), 'ci-store', 'android.yml', '4349-1')), ['mandate-7.apk'], 'no part file, no refused file');
  assert.equal(store.ciFiles().length, 1);

  // A token for another scheme's repo writes to that scheme only.
  const peek = await ci.upload(request('exe', runToken({ repository: 'CaraMinden/Peek-Auras', workflow_ref: 'caraminden/peek-auras/.github/workflows/windows.yml@refs/heads/main' })), { name: 'peek.zip', kind: 'build', target: '' });
  assert.notEqual(peek.project_id, mandate.id);
  assert.equal(store.ciFiles(mandate.id).length, 1);

  // Full of protected files: each target's newest build is kept, so a third target finds no room and is refused, told
  // once. The refusal is decided before anything is deleted: the report the rules could give up for room is still there.
  await ci.upload(request('y'.repeat(100), runToken({ run_id: '5001' })), { name: 'a.zip', kind: 'build', target: 'a' });
  await ci.upload(request('y'.repeat(100), runToken({ run_id: '5002' })), { name: 'b.zip', kind: 'build', target: 'b' });
  const report = await ci.upload(request('r'.repeat(20), runToken({ run_id: '5002' })), { name: 'report.txt', kind: 'report', target: '' });
  await refused(request('y'.repeat(100), runToken({ run_id: '5003' })), 507, /at its .* limit/);
  await refused(request('y'.repeat(100), runToken({ run_id: '5004' })), 507, /at its .* limit/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^Mandate: The CI store refused x\.zip from android\.yml/);
  assert.ok(!existsSync(join(data, 'projects', String(mandate.id), 'ci-store', 'android.yml', '5003-1')), 'the refused upload is gone from disk');
  assert.equal(readFileSync(ci.path(report), 'utf8'), 'r'.repeat(20), 'a refused upload costs the scheme nothing it had');
  assert.equal(ci.usage(mandate.id).scheme, 19 + 200 + 20);
  // An upload that fits once the rules' spare files go takes their room: target a's newer build replaces its older one and the report.
  const a2 = await ci.upload(request('z'.repeat(100), runToken({ run_id: '5005' })), { name: 'a.zip', kind: 'build', target: 'a' });
  assert.equal(readFileSync(ci.path(a2), 'utf8'), 'z'.repeat(100));
  assert.deepEqual(store.ciFiles(mandate.id).map((r) => `${r.run_id} ${r.name}`).sort(), ['4349 mandate-7.apk', '5002 b.zip', '5005 a.zip']);
  assert.ok(!existsSync(ci.path(report)) && !existsSync(join(data, 'projects', String(mandate.id), 'ci-store', 'android.yml', '5001-1')));
  assert.equal(ci.releaseApk(mandate.id, 4349)?.id, f.id);
  assert.equal(ci.releaseApk(mandate.id, 5005), undefined, 'a build is not a release');

  // The sweep deletes only plain files in the store: a row whose file is a symlink out of it keeps both.
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'keep me');
  const old = store.putCiFile({ project_id: mandate.id, workflow: 'android.yml', run_id: 1, run_attempt: 1, sha: SHA, ref: '', name: 'report.txt', kind: 'report', target: '', size: 1, sha256: '', created_at: Date.now() - 30 * DAY });
  mkdirSync(join(data, 'projects', String(mandate.id), 'ci-store', 'android.yml', '1-1'), { recursive: true });
  symlinkSync(outside, ci.path(old));
  await ci.sweep();
  assert.equal(readFileSync(outside, 'utf8'), 'keep me');
  await assert.rejects(ci.plain(old), /not a plain file/, 'nor is it served or published');
  assert.ok(store.getCiFile(old.id), 'its row stays, for a person to look at');
  store.deleteCiFile(old.id);
  // A row whose file is already gone is dropped.
  const lost = store.putCiFile({ project_id: mandate.id, workflow: 'android.yml', run_id: 2, run_attempt: 1, sha: SHA, ref: '', name: 'lost.txt', kind: 'report', target: '', size: 1, sha256: '', created_at: Date.now() - 30 * DAY });
  await ci.sweep();
  assert.equal(store.getCiFile(lost.id), undefined);

  // What a restart mid-upload leaves (a part file, a file with no row) goes once it is an hour old; a fresh one may be an upload still running.
  const dir = join(data, 'projects', String(mandate.id), 'ci-store', 'android.yml', '4349-1');
  const hourAgo = new Date(Date.now() - 61 * 60_000);
  for (const name of ['.aa.part', 'no-row.zip', '.fresh.part']) writeFileSync(join(dir, name), 'x');
  for (const name of ['.aa.part', 'no-row.zip']) utimesSync(join(dir, name), hourAgo, hourAgo);
  utimesSync(join(dir, 'mandate-7.apk'), hourAgo, hourAgo);
  await ci.sweep(true);
  assert.deepEqual(readdirSync(dir).sort(), ['.fresh.part', 'mandate-7.apk']);
});

test('uploads streaming in together are bounded, and ones that arrive while GitHub\'s keys are read wait for them', async () => {
  const store = new Store(join(root, 'busy.db'));
  store.createProject('Mandate', 'https://github.com/caraminden/mandate', null);
  let reads = 0;
  const tokens = new RunTokens(async () => (reads++, await new Promise((r) => setTimeout(r, 30)), jwks));
  const ci = new CiStore(store, join(root, 'busy'), tokens, { ...RULES, fileBytes: 100 });
  const slow = (run: string) => {
    const req: any = new Readable({ read() {} });
    req.headers = { authorization: `Bearer ${runToken({ run_id: run })}`, 'content-length': '100' };
    return { req, done: ci.upload(req, { name: 'a.zip', kind: 'build', target: '' }) };
  };
  // Two cold-start uploads share one read of the keys and both get in.
  const one = slow('1'), two = slow('2');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(reads, 1);
  await assert.rejects(ci.upload(request('x', runToken({ run_id: '3' })), { name: 'a.zip', kind: 'build', target: '' }), (err: any) => err.status === 503);
  for (const { req } of [one, two]) (req.push('y'.repeat(100)), req.push(null));
  assert.deepEqual((await Promise.all([one.done, two.done])).map((f) => f.size), [100, 100]);
  // Their room is free again.
  assert.equal((await ci.upload(request('x', runToken({ run_id: '3' })), { name: 'a.zip', kind: 'build', target: '' })).size, 1);
});

test('a job reading the store is told who it is by its run token alone: 401 without a good one, 503 when GitHub\'s keys can\'t be read', async () => {
  // #1266: the runner read path checks the token exactly as an upload does.
  const store = new Store(join(root, 'reader.db'));
  const mandate = store.createProject('Mandate', 'https://github.com/caraminden/mandate', null);
  const ci = new CiStore(store, join(root, 'reader'), new RunTokens(async () => jwks));
  const job = (token: string | null) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} }) as any;
  const { project, claims } = await ci.caller(job(runToken()));
  assert.deepEqual([project.id, claims.sha, claims.workflow], [mandate.id, SHA, 'android.yml']);
  await assert.rejects(ci.caller(job(null)), (err: any) => err.status === 401);
  await assert.rejects(ci.caller(job(runToken({}, { key: other.privateKey }))), (err: any) => err.status === 401);
  await assert.rejects(ci.caller(job(runToken({ repository: 'someone/else' }))), (err: any) => err.status === 403 && /No scheme has the repo/.test(err.message));
  const unread = new CiStore(store, join(root, 'reader'), new RunTokens(async () => { throw new Error('The operation was aborted due to timeout'); }));
  await assert.rejects(unread.caller(job(runToken())), (err: any) => err.status === 503 && /couldn't read GitHub's signing keys/.test(err.message));
});

test('publish takes the APK from the store when the run put one there, and never asks GitHub', async () => {
  const dir = join(root, 'android');
  mkdirSync(dir, { recursive: true });
  const stored = join(root, 'mandate-9.apk');
  writeFileSync(stored, 'from the store');
  writeFileSync(join(dir, 'latest.json'), JSON.stringify({ versionCode: 8, apk: 'mandate-8.apk' }));
  // PATH has no gh that would work: a call to it would throw.
  const code = await publish({ slug: 'caraminden/mandate', runId: 1, feedFile: join(dir, 'latest.json'), current: 8, main: { code: 9, name: '1.9' }, as: { env: { PATH: '/nonexistent' }, login: null } as any, stored });
  assert.equal(code, 9);
  assert.equal(readFileSync(join(dir, 'mandate-9.apk'), 'utf8'), 'from the store');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')), { versionCode: 9, apk: 'mandate-9.apk', versionName: '1.9' });
});

test('over HTTP: a job uploads at the machines address only, and the scheme\'s members list, find the latest and download', async () => {
  const keys = createServer((_req, res) => res.end(JSON.stringify({ keys: jwks }))).listen(0, '127.0.0.1');
  await new Promise((r) => keys.once('listening', r));
  const srv = await bootServer({ env: { CITADEL_CI_STORE_KEYS: `http://127.0.0.1:${(keys.address() as any).port}/` } });
  try {
    const made = await srv.call('/api/projects', { name: 'Mandate', source: 'none' });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const id = made.data.id ?? made.data.project?.id;
    const db = new DatabaseSync(join(srv.data, 'coordinator.db'));
    db.prepare('UPDATE projects SET repo_url = ? WHERE id = ?').run('https://github.com/caraminden/mandate', id);
    db.close();

    const put = (name: string, query: string, body: string, token = runToken()) => fetch(`${srv.base}/api/ci-store/${name}?${query}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body });
    assert.equal((await put('mandate-7.apk', 'kind=release', 'apk', 'not.a.token')).status, 401);
    assert.equal((await put('mandate-7.apk', 'kind=nope', 'apk')).status, 400);
    const up = await put('mandate-7.apk', 'kind=release', 'apk seven');
    assert.equal(up.status, 201, await up.clone().text());
    const { file } = await up.json();
    assert.equal(file.url, `/api/projects/${id}/ci-files/${file.id}/mandate-7.apk`);
    await put('reports.tar.gz', 'kind=report', 'reports', runToken({ run_id: '4400' }));
    await put('mandate-8.apk', 'kind=release', 'apk eight', runToken({ run_id: '4400' }));

    const list = await srv.call(`/api/projects/${id}/ci-files`);
    assert.deepEqual(list.data.files.map((f: any) => f.name).sort(), ['mandate-7.apk', 'mandate-8.apk', 'reports.tar.gz']);
    assert.equal(list.data.usage.scheme, 9 + 7 + 9);
    assert.deepEqual((await srv.call(`/api/projects/${id}/ci-files?run=4349`)).data.files.map((f: any) => f.name), ['mandate-7.apk']);
    const latest = await fetch(`${srv.base}/api/projects/${id}/ci-files/latest?workflow=android.yml&kind=release`, { headers: { Cookie: srv.cookie } });
    assert.equal(await latest.text(), 'apk eight', 'the redirect leads to the newest release');
    assert.match(latest.headers.get('content-disposition') ?? '', /attachment; filename\*=UTF-8''mandate-8\.apk/);
    assert.equal((await srv.call(`/api/projects/${id}/ci-files/latest?kind=build`)).status, 404);
    // The kit's upload script, as a job runs it: it asks "GitHub" for the run token, then sends a file and a folder.
    const SCRIPT = join(import.meta.dirname, '..', 'kit', 'skills', 'ci-store', 'ci-upload.sh');
    const asked: string[] = [];
    let tokenRun = '4500';
    const githubSays = createServer((req, res) => {
      asked.push(`${req.headers.authorization} ${req.url}`);
      res.end(JSON.stringify({ count: 1, value: runToken({ run_id: tokenRun }) }));
    }).listen(0, '127.0.0.1');
    await new Promise((r) => githubSays.once('listening', r));
    const work = join(root, 'job');
    mkdirSync(join(work, 'reports', 'sub'), { recursive: true });
    writeFileSync(join(work, 'reports', 'sub', 'index.html'), '<p>red</p>');
    writeFileSync(join(work, 'app.apk'), 'apk from the script');
    // Not spawnSync: the stand-in servers answer from this process.
    const job = (args: string[], env: Record<string, string> = {}) => new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const p = spawn('bash', [SCRIPT, ...args], {
        cwd: work,
        env: { PATH: process.env.PATH!, RUNNER_TEMP: work, CITADEL_STORE_URL: srv.base, ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${(githubSays.address() as any).port}/token?api-version=2`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'job-secret', ...env },
      });
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      p.on('close', (status) => done({ status, stdout, stderr }));
    });
    const sent = (await job(['--kind', 'release', '--name', 'mandate-9.apk', 'app.apk']));
    assert.equal(sent.status, 0, sent.stdout + sent.stderr);
    assert.deepEqual(asked, ['Bearer job-secret /token?api-version=2&audience=citadel-ci-store']);
    assert.match(sent.stdout, /^::add-mask::/m, 'the run token is masked in the job\'s log');
    const folder = (await job(['--kind', 'report', 'reports']));
    assert.equal(folder.status, 0, folder.stdout + folder.stderr);
    const fromScript = (await srv.call(`/api/projects/${id}/ci-files?run=4500`)).data.files;
    assert.deepEqual(fromScript.map((f: any) => `${f.kind} ${f.name}`).sort(), ['release mandate-9.apk', 'report reports.tar.gz']);
    assert.equal(readFileSync(fromScript.find((f: any) => f.kind === 'release').path, 'utf8'), 'apk from the script');
    assert.match(spawnSync('tar', ['-tzf', fromScript.find((f: any) => f.kind === 'report').path], { encoding: 'utf8' }).stdout, /^reports\/sub\/index\.html$/m);
    assert.deepEqual(readdirSync(work).sort(), ['app.apk', 'reports'], 'nothing left in the runner\'s temp folder');
    // A store that can't be reached, or no run token: a report warns and passes, a build fails the step.
    const down = { CITADEL_STORE_URL: 'http://127.0.0.1:1' };
    assert.equal((await job(['--kind', 'report', 'reports'], down)).status, 0);
    assert.match((await job(['--kind', 'report', 'reports'], down)).stdout, /^::warning::ci-upload: the store at .* didn't answer/m);
    assert.equal((await job(['--kind', 'build', 'app.apk'], down)).status, 1);
    assert.match((await job(['--kind', 'build', 'app.apk'], { ACTIONS_ID_TOKEN_REQUEST_URL: '' })).stdout, /^::error::ci-upload: no run token: the job needs 'permissions: id-token: write'/m);
    // A name the store won't take is refused before anything is sent; the store's own refusal is passed on.
    assert.match((await job(['--kind', 'build', '--name', 'bad name.apk', 'app.apk'])).stdout, /^::error::ci-upload: the name 'bad name\.apk' has more than/m);
    assert.match((await job(['--kind', 'build', 'app.apk'], { ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${(keys.address() as any).port}/?x=1` })).stdout, /^::error::ci-upload: GitHub didn't hand out a run token/m);
    const bad = await fetch(`${srv.base}/api/ci-store/%zz?kind=build`, { method: 'PUT', headers: { Authorization: `Bearer ${runToken()}` }, body: 'x' });
    assert.equal(bad.status, 400);
    const hosted = (await job(['--kind', 'release', 'app.apk'], { RUNNER_ENVIRONMENT: 'github-hosted' }));
    assert.equal(hosted.status, 0);
    assert.match(hosted.stdout, /skipped, a GitHub-hosted runner/);

    // CI numbers (#1369): the kit's ci-numbers.sh sends a run's numbers in one line; a deliberate slowdown, run by run,
    // shows on the Numbers tab's series as a step once it has held for three runs.
    const NUMBERS = join(import.meta.dirname, '..', 'kit', 'skills', 'ci-store', 'ci-numbers.sh');
    const numbers = (args: string[]) => new Promise<{ status: number | null; stdout: string }>((done) => {
      const p = spawn('bash', [NUMBERS, ...args], { cwd: work, env: { PATH: process.env.PATH!, RUNNER_TEMP: work, CITADEL_STORE_URL: srv.base, ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${(githubSays.address() as any).port}/token?api-version=2`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'job-secret' } });
      let stdout = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.on('close', (status) => done({ status, stdout }));
    });
    const runs = [16.0, 16.1, 15.9, 16.0, 16.2, 15.8, 16.0, 16.1, 15.9, 16.0, 17.6, 17.7, 17.6];
    for (const [i, v] of runs.entries()) {
      tokenRun = String(5000 + i);
      const r = await numbers([`frame-p95=${v}ms`, 'binary=31.5MB']);
      assert.equal(r.status, 0, r.stdout);
      assert.doesNotMatch(r.stdout, /::warning::/, r.stdout);
    }
    writeFileSync(join(work, 'bench.txt'), '# from a bench run\nstartup 412 ms\nmemory 88.2 MB\n');
    tokenRun = '5013';
    assert.match((await numbers(['--file', 'bench.txt'])).stdout, /sent 2 numbers/);
    const charted = (await srv.call(`/api/projects/${id}/ci-numbers`)).data;
    assert.deepEqual(charted.series.map((s: any) => `${s.name} ${s.points.length} ${s.unit}`), ['binary 13 MB', 'frame-p95 13 ms', 'memory 1 MB', 'startup 1 ms']);
    const frame = charted.series.find((s: any) => s.name === 'frame-p95');
    assert.deepEqual(frame.steps.map((s: any) => `${s.run_id} ${s.baseline} ${s.level}`), ['5010 16 17.6']);
    assert.equal(frame.points[10].sha, SHA);
    // Odd input and a missing token warn and never fail the job; the route refuses what the script would never send.
    const odd = await numbers(['frame p95=12']);
    assert.equal(odd.status, 0);
    assert.match(odd.stdout, /^::warning::ci-numbers: 'frame p95=12' isn't name=value/m);
    const big = await fetch(`${srv.base}/api/ci-numbers`, { method: 'POST', headers: { Authorization: `Bearer ${runToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ numbers: [{ name: 'x', value: 1, unit: 'y'.repeat(20000) }] }) });
    assert.equal(big.status, 413);
    assert.equal((await fetch(`${srv.base}/api/ci-numbers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.deepEqual(readdirSync(work).sort(), ['app.apk', 'bench.txt', 'reports'], 'nothing left in the runner\'s temp folder');
    githubSays.close();

    // Not signed in, another scheme's id, or a name that isn't the file's: nothing.
    assert.equal((await fetch(`${srv.base}${file.url}`)).status, 401);
    assert.equal((await srv.call(`/api/projects/${id + 1}/ci-files`)).status, 404);
    assert.equal((await srv.call(`/api/projects/${id}/ci-files/${file.id}/other.apk`)).status, 404);

    // A contraption reads its home scheme's files with its key (#665), and no other scheme's.
    const elsewhere = (await srv.call('/api/projects', { name: 'Elsewhere', source: 'none' })).data;
    const register = async (name: string, home: number) => {
      const r = await srv.call('/api/contraptions', { name, title: name, port: await freePort(), home_scheme: home });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      return { Authorization: `Bearer ${readFileSync(join(srv.data, 'contraptions', name, 'contraption.key'), 'utf8')}` };
    };
    const mandateApp = await register('mandate-app', id);
    const otherApp = await register('other-app', elsewhere.id ?? elsewhere.project?.id);
    const own = await fetch(`${srv.base}/api/projects/${id}/ci-files?kind=release`, { headers: mandateApp });
    assert.equal(own.status, 200);
    assert.deepEqual((await own.json()).files.map((f: any) => f.name).sort(), ['mandate-7.apk', 'mandate-8.apk', 'mandate-9.apk']);
    const newest = await fetch(`${srv.base}/api/projects/${id}/ci-files/latest?workflow=android.yml&kind=release&json=1`, { headers: mandateApp });
    assert.equal((await newest.json()).file.name, 'mandate-9.apk');
    // The redirect's stable URL takes the key too, so a plain fetch follows it to the bytes.
    assert.equal(await (await fetch(`${srv.base}/api/projects/${id}/ci-files/latest?workflow=android.yml&kind=release`, { headers: mandateApp })).text(), 'apk from the script');
    // The builds a roll back holds its CI packages at (ADR 0012): its app's updater reads them with its key.
    assert.deepEqual((await (await fetch(`${srv.base}/api/projects/${id}/ci-files/pins`, { headers: mandateApp })).json()).pins, []);
    const pinDb = new DatabaseSync(join(srv.data, 'coordinator.db'));
    pinDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('last-green:pins', JSON.stringify({
      [`${id}/ci:android:build`]: { sha: 'a'.repeat(40), from: 'b'.repeat(40), at: 5, by: 'Cara', build: { run: 4500, sha: 'c'.repeat(40), workflow: 'android.yml' } },
      [`${id}/app:mandate`]: { sha: 'a'.repeat(40), from: 'b'.repeat(40), at: 5, by: 'Cara' },
      [`${id + 1}/ci:android:build`]: { sha: 'a'.repeat(40), from: 'b'.repeat(40), at: 5, by: 'Cara', build: { run: 4500, sha: 'c'.repeat(40), workflow: 'android.yml' } },
    }));
    pinDb.close();
    const pins = (await (await fetch(`${srv.base}/api/projects/${id}/ci-files/pins`, { headers: mandateApp })).json()).pins;
    assert.deepEqual(pins.map((p: any) => [p.target, p.workflow, p.run_id, p.by, p.files.map((f: any) => f.name)]), [['ci:android:build', 'android.yml', 4500, 'Cara', ['mandate-9.apk']]], 'only its own scheme\'s held builds, with their files and no reports');
    assert.equal(await (await fetch(`${srv.base}${pins[0].files[0].url}`, { headers: mandateApp })).text(), 'apk from the script');
    for (const path of ['ci-files', 'ci-files/latest?kind=release', `ci-files/${file.id}/mandate-7.apk`, 'ci-files/pins']) {
      const theirs = await fetch(`${srv.base}/api/projects/${id}/${path}`, { headers: otherApp });
      assert.equal(theirs.status, 403, `another scheme's contraption: ${path}`);
      assert.match((await theirs.json()).error, /only read its own home scheme/);
      assert.equal((await fetch(`${srv.base}/api/projects/${id}/${path}`)).status, 401, `no key: ${path}`);
      assert.equal((await fetch(`${srv.base}/api/projects/${id}/${path}`, { headers: { Authorization: `Bearer ck_${'x'.repeat(43)}` } })).status, 401, `a key no contraption has: ${path}`);
    }
    // Through the web (Caddy adds X-Forwarded-For) the key is refused, as on the turn API.
    assert.equal((await fetch(`${srv.base}/api/projects/${id}/ci-files`, { headers: { ...mandateApp, 'X-Forwarded-For': '100.64.0.9' } })).status, 403);
    // The key is only for reading: an upload with it is still a run token's job.
    assert.equal((await fetch(`${srv.base}/api/ci-store/x.zip?kind=build`, { method: 'PUT', headers: mandateApp, body: 'x' })).status, 401);
    // A job reads its own scheme's files for its own commit, from any workflow (#1266: Peek's desktop e2e job takes
    // the build windows.yml made of the same commit), at the address it uploads to, with its run token.
    const peekMade = (await srv.call('/api/projects', { name: 'Peek', source: 'none' })).data;
    const repoDb = new DatabaseSync(join(srv.data, 'coordinator.db'));
    repoDb.prepare('UPDATE projects SET repo_url = ? WHERE id = ?').run('https://github.com/caraminden/peek-auras', peekMade.id ?? peekMade.project?.id);
    repoDb.close();
    const LATER = 'b'.repeat(40);
    const laterUp = await put('later.zip', 'kind=build&target=windows', 'a later commit', runToken({ run_id: '4600', sha: LATER, workflow_ref: 'caraminden/mandate/.github/workflows/windows.yml@refs/heads/main' }));
    const later = (await laterUp.json()).file;
    const peekFile = (await (await put('peek.zip', 'kind=build', 'peek build', runToken({ repository: 'caraminden/peek-auras', run_id: '9000' }))).json()).file;
    const desktopJob = runToken({ run_id: '4700', workflow_ref: 'caraminden/mandate/.github/workflows/desktop.yml@refs/heads/main' });
    const asJob = (path: string, token: string | null = desktopJob) => fetch(`${srv.base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const releases = await asJob(`/api/ci-store?commit=${SHA}&workflow=android.yml&kind=release`);
    assert.equal(releases.status, 200, await releases.clone().text());
    const ownFiles = (await releases.json()).files;
    assert.deepEqual(ownFiles.map((f: any) => f.name), ['mandate-9.apk', 'mandate-8.apk', 'mandate-7.apk'], 'newest first, another workflow\'s files');
    const seven = ownFiles.find((f: any) => f.name === 'mandate-7.apk');
    assert.equal(seven.url, `/api/ci-store/${seven.id}/mandate-7.apk`, 'a URL the job can fetch with its token');
    const got = await asJob(seven.url);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), 'apk seven');
    // No commit asked: the token's own. Never another commit's file, nor another scheme's.
    assert.deepEqual((await (await asJob('/api/ci-store')).json()).files.map((f: any) => f.name).sort(), ['mandate-7.apk', 'mandate-8.apk', 'mandate-9.apk', 'reports.tar.gz', 'reports.tar.gz']);
    assert.deepEqual((await (await asJob(`/api/ci-store?commit=${SHA.slice(0, 7)}&name=mandate-8.apk`)).json()).files.map((f: any) => f.name), ['mandate-8.apk'], 'a short SHA of its own commit');
    const otherCommit = await asJob(`/api/ci-store?commit=${LATER}`);
    assert.equal(otherCommit.status, 403, 'another commit, by query');
    assert.match((await otherCommit.json()).error, /its own commit/);
    assert.equal((await asJob(`/api/ci-store/${later.id}/later.zip`)).status, 403, 'another commit, by file');
    assert.equal(await (await asJob(`/api/ci-store/${later.id}/later.zip`, runToken({ sha: LATER }))).text(), 'a later commit', 'that commit\'s own job reads it');
    assert.equal((await asJob(`/api/ci-store/${peekFile.id}/peek.zip`)).status, 403, 'another scheme\'s file');
    assert.equal((await asJob(seven.url, runToken({ repository: 'caraminden/peek-auras' }))).status, 403, 'another scheme\'s job');
    assert.deepEqual((await (await asJob('/api/ci-store', runToken({ repository: 'caraminden/peek-auras' }))).json()).files.map((f: any) => f.name), ['peek.zip']);
    assert.equal((await asJob(`/api/ci-store/${seven.id}/other.apk`)).status, 404, 'a name that isn\'t the file\'s');
    assert.equal((await asJob(`/api/ci-store/999999/x.zip`)).status, 404);
    assert.equal((await asJob('/api/ci-store?kind=nope')).status, 400);
    for (const path of ['/api/ci-store', seven.url]) {
      assert.equal((await asJob(path, null)).status, 401, `no token: ${path}`);
      assert.equal((await asJob(path, 'not.a.token')).status, 401, `not a token: ${path}`);
      assert.equal((await asJob(path, runToken({}, { key: other.privateKey }))).status, 401, `signed by someone else: ${path}`);
      assert.equal((await asJob(path, runToken({ aud: 'https://github.com/caraminden' }))).status, 401, `another audience: ${path}`);
      assert.equal((await fetch(`${srv.base}${path}`, { headers: mandateApp })).status, 401, `a contraption key: ${path}`);
    }

    // The kit's download script, as a job runs it: by name, the newest match, a list, and the store's refusals passed on.
    const DOWNLOAD = join(import.meta.dirname, '..', 'kit', 'skills', 'ci-store', 'ci-download.sh');
    const tokenAsked: string[] = [];
    const tokens = createServer((req, res) => (tokenAsked.push(req.url!), res.end(JSON.stringify({ count: 1, value: desktopJob })))).listen(0, '127.0.0.1');
    await new Promise((r) => tokens.once('listening', r));
    const pullDir = join(root, 'pull');
    mkdirSync(pullDir, { recursive: true });
    const pull = (args: string[], env: Record<string, string> = {}) => new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const p = spawn('bash', [DOWNLOAD, ...args], {
        cwd: pullDir,
        env: { PATH: process.env.PATH!, RUNNER_TEMP: pullDir, CITADEL_STORE_URL: srv.base, CI_DOWNLOAD_WAIT: '0', ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${(tokens.address() as any).port}/token?api-version=2`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'job-secret', ...env },
      });
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      p.on('close', (status) => done({ status, stdout, stderr }));
    });
    try {
      const byName = await pull(['--workflow', 'android.yml', '--name', 'mandate-7.apk', '--out', 'got/seven.apk']);
      assert.equal(byName.status, 0, byName.stdout + byName.stderr);
      assert.equal(readFileSync(join(pullDir, 'got', 'seven.apk'), 'utf8'), 'apk seven');
      assert.deepEqual(tokenAsked, ['/token?api-version=2&audience=citadel-ci-store']);
      assert.match(byName.stdout, /^::add-mask::/m, 'the run token is masked in the job\'s log');
      const newest = await pull(['--commit', SHA, '--workflow', 'android.yml', '--kind', 'release']);
      assert.equal(newest.status, 0, newest.stdout + newest.stderr);
      assert.equal(readFileSync(join(pullDir, 'mandate-9.apk'), 'utf8'), 'apk from the script', 'no --name: the newest match, under its own name');
      const listed = await pull(['--list', '--kind', 'release']);
      assert.equal(listed.status, 0, listed.stdout + listed.stderr);
      assert.deepEqual(listed.stdout.trim().split('\n').filter((l) => !l.startsWith('::')), ['mandate-9.apk android.yml run 4500 release', 'mandate-8.apk android.yml run 4400 release', 'mandate-7.apk android.yml run 4349 release']);
      assert.equal((await pull(['--name', 'later.zip'])).status, 1, 'another commit\'s file is not there for it');
      assert.match((await pull(['--name', 'nothing.zip'])).stdout, /^::error::ci-download: nothing in the store matches/m);
      const refused = await pull(['--commit', LATER]);
      assert.equal(refused.status, 1);
      assert.match(refused.stdout, /^::error::ci-download: the store refused .*HTTP 403.*its own commit/m);
      assert.match((await pull(['--kind', 'nope'])).stderr, /--kind build, report or release/);
      assert.match((await pull(['--name', 'mandate-7.apk', '--out', 'got'])).stderr, /not a folder/);
      // A + in a name reaches the store as a +, not a space.
      await put('app+debug.zip', 'kind=build', 'plus build');
      const plus = await pull(['--name', 'app+debug.zip']);
      assert.equal(plus.status, 0, plus.stdout + plus.stderr);
      assert.equal(readFileSync(join(pullDir, 'app+debug.zip'), 'utf8'), 'plus build');
      assert.match((await pull(['--name', 'x.zip'], { ACTIONS_ID_TOKEN_REQUEST_URL: '' })).stdout, /^::error::ci-download: no run token: the job needs 'permissions: id-token: write'/m);
      assert.match((await pull(['--name', 'x.zip'], { CITADEL_STORE_URL: 'http://127.0.0.1:1' })).stdout, /^::error::ci-download: the store at .* didn't answer/m);
      // A 503 (the store couldn't read GitHub's keys yet) is tried again, for the list and for the bytes.
      let busy = 0;
      const flaky = createServer((req, res) => {
        if (busy++ % 2 === 0) return (res.statusCode = 503, res.end('{"error":"try again in a minute"}'));
        if (req.url!.startsWith('/api/ci-store?')) return res.end(JSON.stringify({ files: [{ name: 'x.zip', workflow: 'windows.yml', run_id: 1, kind: 'build', target: '', url: '/api/ci-store/5/x.zip' }] }));
        res.end('x bytes');
      }).listen(0, '127.0.0.1');
      await new Promise((r) => flaky.once('listening', r));
      const retried = await pull(['--name', 'x.zip'], { CITADEL_STORE_URL: `http://127.0.0.1:${(flaky.address() as any).port}` });
      flaky.close();
      assert.equal(retried.status, 0, retried.stdout + retried.stderr);
      assert.equal(busy, 4);
      assert.equal(readFileSync(join(pullDir, 'x.zip'), 'utf8'), 'x bytes');
      assert.deepEqual(readdirSync(pullDir).sort(), ['app+debug.zip', 'got', 'mandate-9.apk', 'x.zip'], 'nothing left in the runner\'s temp folder, and no file from a refusal');
    } finally {
      tokens.close();
    }
  } finally {
    await srv.stop();
    keys.close();
  }

  // With a machines address, uploads go there and the app's own address refuses them.
  const agentBase = `http://127.0.0.1:${await freePort()}`;
  const split = await bootServer({ env: { MACHINES_URL: agentBase } });
  try {
    await until('the machines listener', () => fetch(`${agentBase}/machine-agent.mjs`).then((r) => r.ok).catch(() => false));
    const at = (base: string) => fetch(`${base}/api/ci-store/a.zip?kind=build`, { method: 'PUT', headers: { Authorization: 'Bearer x.y.z' }, body: 'x' });
    assert.equal((await at(split.base)).status, 403);
    assert.equal((await at(agentBase)).status, 401, 'served there, and still wants a real run token');
    assert.equal((await fetch(`${agentBase}/api/projects/1/ci-files`, { headers: { Cookie: split.cookie } })).status, 404, 'reading is not served on the machines address');
    // A job reads where it uploads (#1266): there, not here.
    for (const path of ['/api/ci-store', '/api/ci-store/1/a.zip']) {
      assert.equal((await fetch(`${split.base}${path}`, { headers: { Authorization: 'Bearer x.y.z' } })).status, 403, `a job's read on the app's own address: ${path}`);
      assert.equal((await fetch(`${agentBase}${path}`, { headers: { Authorization: 'Bearer x.y.z' } })).status, 401, `served on the machines address: ${path}`);
    }
  } finally {
    await split.stop();
  }
});
