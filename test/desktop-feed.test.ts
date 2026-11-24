// Desktop apps' update feeds (#1148): publishing builds, the open feed routes, the first-install zip, the launcher
// build and CI's auto-publish.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ciPublisher, DesktopError, DesktopFeeds, desktopTargetOf, KEEP } from '../src/desktop-feed.ts';
import { LAUNCHER_SOURCES, Launchers } from '../src/desktop-launcher.ts';
import { desktopRoutes } from '../src/routes/desktop.ts';

let root: string;
before(async () => (root = await mkdtemp(join(tmpdir(), 'desktop-feed-'))));
after(() => rm(root, { recursive: true, force: true }));

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const zipNames = (file: string) => execFileSync('python3', ['-I', '-c', 'import sys,zipfile;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', file], { encoding: 'utf8' }).trim().split('\n');

/** A build folder `files` zipped (under a top folder when `top`), or tarred when the name ends .tgz. */
async function build(name: string, files: Record<string, string>, top = 'App'): Promise<string> {
  const dir = await mkdtemp(join(root, 'src-'));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(dir, top, path, '..'), { recursive: true });
    await writeFile(join(dir, top, path), body);
  }
  const out = join(dir, name);
  if (name.endsWith('.tgz')) execFileSync('tar', ['-czf', out, top], { cwd: dir });
  else execFileSync('python3', ['-I', '-m', 'zipfile', '-c', out, top], { cwd: dir });
  return out;
}

test('a build gets the next number, a feed with its SHA-256, and its zip without the top folder', async () => {
  const feeds = new DesktopFeeds(join(root, 'd1'));
  const one = await feeds.publish({ projectId: 7, app: 'testapp', file: await build('b.zip', { 'TestApp.exe': 'v1', 'label.txt': 'one' }), title: 'Test app' });
  assert.equal(one.build.build, 1);
  assert.equal(one.build.exe, 'TestApp.exe', 'the one .exe at its top is found');
  assert.equal(one.build.started, 'file');
  assert.equal(one.feed, '/api/desktop/7/testapp/feed.json');
  const zip = (await feeds.zip(7, 'testapp', 'testapp-1.zip'))!;
  const bytes = await readFile(zip);
  assert.equal(one.build.sha256, sha(bytes));
  assert.equal(one.build.size, bytes.length);
  assert.deepEqual(zipNames(zip).sort(), ['TestApp.exe', 'label.txt']);
  const two = await feeds.publish({ projectId: 7, app: 'testapp', file: await build('b.tgz', { 'TestApp.exe': 'v2' }), version: '1.1' });
  assert.equal(two.build.build, 2, 'a .tgz is taken too');
  const feed = DesktopFeeds.feed((await feeds.index(7, 'testapp'))!, { path: '/x', version: 3, sha256: 'a'.repeat(64), size: 9 })!;
  assert.deepEqual({ build: feed.build, zip: feed.zip, title: feed.title, version: feed.version, launcher: feed.launcher }, { build: 2, zip: 'testapp-2.zip', title: 'Test app', version: '1.1', launcher: { version: 3, file: 'launcher.exe', sha256: 'a'.repeat(64), size: 9 } });
});

test(`it keeps the newest ${KEEP} builds and deletes the rest`, async () => {
  const feeds = new DesktopFeeds(join(root, 'd2'));
  for (let i = 1; i <= KEEP + 2; i++) await feeds.publish({ projectId: 1, app: 'app', file: await build('b.zip', { 'A.exe': `v${i}` }) });
  const index = (await feeds.index(1, 'app'))!;
  assert.equal(index.current, KEEP + 2);
  assert.deepEqual(
    index.builds.map((b) => b.build),
    [5, 4, 3],
  );
  assert.deepEqual((await readdir(join(root, 'd2/projects/1/desktop/app'))).filter((n) => n.endsWith('.zip')).sort(), ['app-3.zip', 'app-4.zip', 'app-5.zip']);
  assert.equal(await feeds.zip(1, 'app', 'app-1.zip'), null);
});

test('a build without its exe, with two exes and no choice, or holding a link is refused and changes nothing', async () => {
  const feeds = new DesktopFeeds(join(root, 'd3'));
  await feeds.publish({ projectId: 1, app: 'app', file: await build('b.zip', { 'A.exe': 'v1' }) });
  await assert.rejects(feeds.publish({ projectId: 1, app: 'app', file: await build('b.zip', { 'A.exe': 'v2' }), exe: 'B.exe' }), /no B\.exe/);
  await assert.rejects(feeds.publish({ projectId: 1, app: 'app', file: await build('b.zip', { 'A.exe': '', 'B.exe': '' }) }), /2 \.exe files/);
  await assert.rejects(feeds.publish({ projectId: 1, app: 'app', file: await build('b.zip', { 'A.exe': '' }), exe: '../A.exe' }), DesktopError);
  const dir = await mkdtemp(join(root, 'link-'));
  await mkdir(join(dir, 'App'));
  await writeFile(join(dir, 'App/A.exe'), 'x');
  await symlink('/etc/passwd', join(dir, 'App/secret'));
  execFileSync('tar', ['-czf', 'b.tgz', 'App'], { cwd: dir });
  await assert.rejects(feeds.publish({ projectId: 1, app: 'app', file: join(dir, 'b.tgz') }), /link or special file/);
  await assert.rejects(feeds.publish({ projectId: 1, app: 'Bad Name', file: join(dir, 'b.tgz') }), /lower case/);
  const index = (await feeds.index(1, 'app'))!;
  assert.deepEqual([index.current, index.builds.length], [1, 1]);
  assert.deepEqual((await readdir(join(root, 'd3/projects/1/desktop/app'))).sort(), ['app-1.zip', 'feed.json'], 'no leftovers');
});

test('a CI run is published once; publishing an older one again (a roll back) points the feed back at it', async () => {
  const feeds = new DesktopFeeds(join(root, 'd4'));
  const a = await feeds.publish({ projectId: 1, app: 'app', file: await build('b.zip', { 'A.exe': 'v1' }), source: 'ci:100' });
  await feeds.publish({ projectId: 1, app: 'app', file: await build('b.zip', { 'A.exe': 'v2' }), source: 'ci:101' });
  const again = await feeds.publish({ projectId: 1, app: 'app', file: '/nonexistent.zip', source: 'ci:100' });
  assert.equal(again.already, true);
  assert.equal(again.build.build, a.build.build);
  assert.equal((await feeds.index(1, 'app'))!.current, 1, 'the feed names build 1 again, so PCs go back to it');
});

test('publishing a source again by hand applies a new title and names the settings it ignored (#1522)', async () => {
  const feeds = new DesktopFeeds(join(root, 'd4b'));
  await feeds.publish({ projectId: 1, app: 'app', file: await build('b.zip', { 'A.exe': 'v1', 'B.exe': '' }), exe: 'A.exe', version: '1.0', source: 'ci:100' });
  const same = await feeds.publish({ projectId: 1, app: 'app', file: '/nonexistent.zip', exe: 'A.exe', version: '1.0', source: 'ci:100' });
  assert.equal(same.ignored, undefined, 'the same settings again ignore nothing');
  const again = await feeds.publish({ projectId: 1, app: 'app', file: '/nonexistent.zip', exe: 'B.exe', started: 'alive', version: '1.1', title: 'New name', source: 'ci:100' });
  assert.equal(again.already, true);
  assert.deepEqual(again.ignored, ['exe', 'started', 'version'], 'the build is already made: its exe, start signal and version stay');
  const index = (await feeds.index(1, 'app'))!;
  assert.equal(index.title, 'New name', "the title is the feed's, so it applies");
  assert.deepEqual([index.builds[0].exe, index.builds[0].started, index.builds[0].version], ['A.exe', 'file', '1.0']);
});

test('the publish_desktop tool says PCs switch on the start after next (#1522)', async () => {
  const src = await readFile(new URL('../src/mcp.ts', import.meta.url), 'utf8');
  const desc = src.slice(src.indexOf("name: 'publish_desktop'"), src.indexOf("name: 'publish_desktop'") + 1500);
  assert.match(desc, /switch on the start after next/);
  assert.doesNotMatch(desc, /switch on their next start/);
});

test('the first-install zip holds the launcher as <app>.exe, its config and the current build unpacked', async () => {
  const feeds = new DesktopFeeds(join(root, 'd5'));
  await feeds.publish({ projectId: 2, app: 'app', file: await build('b.zip', { 'bin/App.exe': 'v1', 'bin/data.txt': 'd' }), exe: 'bin/App.exe', started: 'alive', title: 'App' });
  const launcher = join(root, 'launcher.exe');
  await writeFile(launcher, 'MZlauncher');
  const l = { path: launcher, version: 1, sha256: sha(Buffer.from('MZlauncher')), size: 10 };
  const zip = (await feeds.install(2, 'app', 'http://citadel.test/api/desktop/2/app/feed.json', l))!;
  assert.deepEqual(
    zipNames(zip)
      .filter((n) => !n.endsWith('/'))
      .sort(),
    ['app/app.exe', 'app/launcher.json', 'app/state.json', 'app/versions/1/bin/App.exe', 'app/versions/1/bin/data.txt'],
  );
  const out = await mkdtemp(join(root, 'inst-'));
  execFileSync('python3', ['-I', '-m', 'zipfile', '-e', zip, out]);
  assert.deepEqual(JSON.parse(await readFile(join(out, 'app/launcher.json'), 'utf8')), { app: 'app', feed: 'http://citadel.test/api/desktop/2/app/feed.json', title: 'App' });
  assert.deepEqual(JSON.parse(await readFile(join(out, 'app/state.json'), 'utf8')), { current: { id: 1, exe: 'bin/App.exe', started: 'alive' }, failed: [] });
  assert.equal(await feeds.install(2, 'app', 'http://citadel.test/api/desktop/2/app/feed.json', l), zip, 'made once');
});

test('the launcher is built once per source, with its version from the source; a failed build is not retried at once', async () => {
  const src = await mkdtemp(join(root, 'lsrc-'));
  await writeFile(join(src, 'Launcher.cs'), 'public const int Version = 4;');
  await writeFile(join(src, 'Launcher.csproj'), '<Project/>');
  await writeFile(join(src, 'Trial.cs'), '// rules');
  let builds = 0;
  let fail = false;
  const launchers = new Launchers({
    src,
    cache: join(root, 'lcache'),
    dotnet: 'dotnet',
    build: async (_d, dir, out) => {
      assert.equal(await readFile(join(dir, 'Trial.cs'), 'utf8'), '// rules', 'every source is copied into the build folder');
      builds++;
      if (fail) throw new Error('no sdk');
      await mkdir(out, { recursive: true });
      await writeFile(join(out, 'launcher.exe'), `exe${builds}`);
    },
  });
  const [x, y] = await Promise.all([launchers.get(), launchers.get()]);
  assert.equal(builds, 1);
  assert.deepEqual(x, y);
  assert.equal(x!.version, 4);
  assert.equal(x!.sha256, sha(Buffer.from('exe1')));
  await launchers.get();
  assert.equal(builds, 1, 'kept');
  await writeFile(join(src, 'Launcher.cs'), 'public const int Version = 5;');
  fail = true;
  assert.equal(await launchers.get(), null);
  assert.equal(await launchers.get(), null);
  assert.equal(builds, 2, 'not retried at once');
});

test('the launcher build copies every file Launcher.csproj compiles', async () => {
  const proj = await readFile(join(import.meta.dirname, '../kit/desktop-launcher/Launcher.csproj'), 'utf8');
  const compiled = [...proj.matchAll(/<Compile Include="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(compiled.length >= 2);
  for (const f of compiled) assert.ok(LAUNCHER_SOURCES.includes(f), `${f} is in SOURCES`);
});

test("CI's publisher publishes a run's build once and tells the Taskmaster, waits for a missing file, and reports a failure once", async () => {
  const feeds = new DesktopFeeds(join(root, 'd6'));
  const told: string[] = [];
  const files = new Map<number, string>([
    [11, await build('b.zip', { 'A.exe': 'v1' })],
    [12, await build('b.zip', { 'A.exe': 'x', 'B.exe': 'y' })],
  ]);
  let asked = 0;
  const publish = ciPublisher({ feeds, tell: (_p, t) => told.push(t), file: async (_p, run) => (asked++, files.get(run) ?? null) });
  const t = { projectId: 3, name: 'Windows', desktop: { app: 'app' } };
  await publish(t, { id: 10, sha: 'abc' });
  assert.deepEqual([told.length, asked], [0, 1], 'no file in the store yet: nothing, and it asks again later');
  await publish(t, { id: 10, sha: 'abc' });
  assert.equal(asked, 2);
  await publish(t, { id: 11, sha: 'def0123456' });
  await publish(t, { id: 11, sha: 'def0123456' });
  assert.equal(told.length, 1);
  assert.match(told[0], /published desktop build 1 of app from CI run 11/);
  assert.match(told[0], /PCs switch to it on the start after next/, 'a start downloads it; only the start after tries it (#1522)');
  assert.equal((await feeds.index(3, 'app'))!.builds[0].commit, 'def0123456');
  await publish(t, { id: 12, sha: 'f' });
  await publish(t, { id: 12, sha: 'f' });
  assert.equal(told.length, 2);
  assert.match(told[1], /couldn't publish CI run 12's build/);
  assert.equal((await feeds.index(3, 'app'))!.current, 1, 'PCs keep build 1');
  files.set(13, await build('b.zip', { 'A.exe': 'v2' }));
  await publish(t, { id: 13, sha: 'g' });
  assert.equal((await feeds.index(3, 'app'))!.current, 2);
  await publish(t, { id: 11, sha: 'def0123456' });
  assert.equal((await feeds.index(3, 'app'))!.current, 1, 'a roll back pins run 11 again: the feed goes back to its build');
  await publish(t, { id: 13, sha: 'g' });
  assert.equal((await feeds.index(3, 'app'))!.current, 2, 'clearing the pin follows the newest run again');
  await feeds.publish({ projectId: 3, app: 'app', file: await build('b.zip', { 'A.exe': 'by hand' }) });
  const restarted = ciPublisher({ feeds, tell: (_p, t) => told.push(t), file: async (_p, run) => files.get(run) ?? null });
  await restarted(t, { id: 13, sha: 'g' });
  assert.equal((await feeds.index(3, 'app'))!.current, 3, 'a by-hand publish stands after a restart while CI still names the run it followed');
  assert.equal(told.length, 3, 'run 13 was news once; following it again, and the restart, were not');
});

test("a ci target's desktop settings are kept only when well formed", () => {
  assert.deepEqual(desktopTargetOf({ app: 'peek', exe: 'Peek.exe', started: 'alive', title: ' Peek ' }), { app: 'peek', exe: 'Peek.exe', started: 'alive', title: 'Peek' });
  assert.deepEqual(desktopTargetOf({ app: 'peek', exe: '../x.exe', started: 'soon' }), { app: 'peek' });
  assert.equal(desktopTargetOf({ app: 'Peek!' }), null);
  assert.equal(desktopTargetOf('peek'), null);
});

test('the open routes serve the feed, a kept build and the install zip, and 404 anything else', async () => {
  const dataDir = join(root, 'd7');
  const feeds = new DesktopFeeds(dataDir);
  await feeds.publish({ projectId: 5, app: 'app', file: await build('b.zip', { 'A.exe': 'v1' }) });
  const exe = join(root, 'l7.exe');
  await writeFile(exe, 'MZ');
  const launchers = { get: async () => ({ path: exe, version: 2, sha256: sha(Buffer.from('MZ')), size: 2 }) } as unknown as Launchers;
  const app = { desktop: { feeds, launchers }, store: { getProject: (id: number) => (id === 5 ? { id } : undefined) } };
  const route = desktopRoutes.find((r) => r.path === '/api/desktop/:project/:app/:file')!;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const [, , , project, name, file] = url.pathname.split('/');
    try {
      await route.handler({ req, res, url, app, params: { project, app: name, file } } as never);
    } catch (err) {
      res.writeHead((err as { status?: number }).status ?? 500).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/desktop`;
  try {
    const feed = await (await fetch(`${base}/5/app/feed.json`)).json();
    assert.equal(feed.build, 1);
    assert.equal(feed.launcher.file, 'launcher.exe');
    const zip = Buffer.from(await (await fetch(`${base}/5/app/${feed.zip}`)).arrayBuffer());
    assert.equal(sha(zip), feed.sha256, 'what the launcher downloads matches the feed');
    assert.equal((await fetch(`${base}/5/app/launcher.exe`)).status, 200);
    const inst = await fetch(`${base}/5/app/install.zip`);
    assert.equal(inst.status, 200);
    assert.equal(inst.headers.get('content-type'), 'application/zip');
    // The desktop folder sits on a mount minions' containers can write: a link planted there is never served.
    const dir = join(dataDir, 'projects', '5', 'desktop', 'app');
    await symlink(join(dataDir, 'secret'), join(dir, 'app-9.zip'));
    await writeFile(join(dataDir, 'secret'), 'secret');
    const index = JSON.parse(await readFile(join(dir, 'feed.json'), 'utf8'));
    index.builds.push({ ...index.builds[0], build: 9, zip: 'app-9.zip' });
    await writeFile(join(dir, 'feed.json'), JSON.stringify(index));
    for (const path of ['5/app/app-9.zip', '5/app/feed.json.tmp', '5/app/app-2.zip', '5/app/..%2Ffeed.json', '6/app/feed.json', '5/other/feed.json', '5/BAD/feed.json', 'x/app/feed.json']) {
      assert.equal((await fetch(`${base}/${path}`)).status, 404, path);
    }
  } finally {
    server.close();
  }
});
