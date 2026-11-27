import assert from 'node:assert/strict';
import { type SpawnOptions, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadConfig, startProgram } from '../public/machine-agent.mjs';
import { boxOf, Worker } from '../public/machine-worker.mjs';
import { folderPath, HOST_SRC, hostFolders, hostMounts, mountedFolders } from '../public/worker-agent.mjs';
import { HostStarts, hostReach, writesLine } from '../src/host-reach.ts';

// Host reach (Build 7 T8): a minion marked for a machine, on its owner's turn, gets the owner's folders at /host/<name>
// and may start the owner's programs; every other turn gets neither. The route's refusal of every other caller is in
// test/access-matrix.snapshot.json (POST /api/machines/run-on-host), and the tripwire's rule in test/tripwire.test.ts.
const root = mkdtempSync(join(tmpdir(), 'host-reach-'));
// timing-ok: own temp dir
after(() => rmSync(root, { recursive: true, force: true }));

test("only a minion marked for this machine, on its owner's turn, reaches its host", () => {
  const box = { id: 7, owner_id: 3 };
  assert.equal(hostReach({ machine: 7 }, box, 3), true);
  assert.equal(hostReach({ machine: 7 }, box, 4), false, "another person's turn");
  assert.equal(hostReach({ machine: 7 }, box, null), false, 'a turn no person asked for');
  assert.equal(hostReach({ machine: 7, once: true }, box, 3), false, 'its next turn runs at perigee, picked on its card');
  assert.equal(hostReach({ machine: 8 }, box, 3), false, 'marked for another machine');
  assert.equal(hostReach({ machine: null }, box, 3), false, 'marked to run anywhere');
  assert.equal(hostReach(null, box, 3), false, 'not marked');
  assert.equal(hostReach({ machine: 7 }, { id: 7, owner_id: null }, 3), false, 'a shared machine has no owner');
});

/** A worker whose podman is recorded, not run, and a start that stops once its container is up. */
function worker(host: { src: string; dst: string; ro: boolean }[]) {
  const calls: string[][] = [];
  const w = new Worker({
    config: { root: join(root, `w${Math.random()}`), image: 'img', max: 2, host },
    appUrl: 'http://127.0.0.1:9',
    token: 't',
    run: async (_cmd: string, args: string[]) => {
      calls.push(args);
      return { code: args[0] === 'container' ? 1 : 0, out: '', err: '' };
    },
  });
  // The app's copy of the turn's folder, as fetchFolder makes it.
  w.fetchFolder = async (t: { local: string }) => {
    mkdirSync(t.local, { recursive: true });
    writeFileSync(join(t.local, 'spec.json'), '{}');
  };
  w.fitSpec = () => {};
  w.save = () => {};
  return { w, calls, runs: () => calls.filter((a) => a[0] === 'run') };
}
const mounts = (args: string[]) => args.filter((_, i) => args[i - 1] === '--mount');
const launch = (host?: boolean) => ({ wrapper: ['node', 'x'], cwd: null, home: '/home/worker', roots: ['/data/turns'], ...(host ? { host: true } : {}) });

test("a marked minion's turn runs in its own container with the owner's folders; an unmarked one's has none", async () => {
  const host = [
    { src: `${HOST_SRC}/docs`, dst: '/host/docs', ro: true },
    { src: `${HOST_SRC}/art`, dst: '/host/art', ro: false },
  ];
  const plain = worker(host);
  await plain.w.begin('/data/turns/1-1', launch());
  const [run] = plain.runs();
  assert.equal(run[run.indexOf('--name') + 1], 'citadel-worker');
  assert.deepEqual(
    mounts(run).filter((m) => m.includes('dst=/host')),
    [],
    'no /host in an unmarked turn',
  );
  assert.ok(!mounts(run).some((m) => m.includes('/mnt/')), 'nor any Windows drive');
  assert.ok(
    plain.calls.some((a) => a[0] === 'exec' && a[1] === '-d' && a[a.indexOf('--user') + 2] === 'citadel-worker'),
    'its turn runs in the plain container',
  );

  const marked = worker(host);
  await marked.w.begin('/data/turns/1-2', launch(true));
  const [hostRun] = marked.runs();
  assert.equal(hostRun[hostRun.indexOf('--name') + 1], 'citadel-worker-host');
  assert.deepEqual(
    mounts(hostRun).filter((m) => m.includes('dst=/host')),
    [`type=bind,src=${HOST_SRC}/docs,dst=/host/docs,ro`, `type=bind,src=${HOST_SRC}/art,dst=/host/art`],
  );
  assert.ok(hostRun.includes('citadel-worker-home:/home/worker:U'), 'the same home volume: the same sign-in');
  assert.ok(
    marked.calls.some((a) => a[0] === 'exec' && a[1] === '-d' && a[a.indexOf('--user') + 2] === 'citadel-worker-host'),
    'its turn runs in that container',
  );
  assert.equal(boxOf({ container: 'c' }, { host: false }), 'c');
});

test("the owner's folders: full paths only, never a drive's root, read-only unless they say write", () => {
  for (const p of ['C:\\Users\\me\\Art', 'D:\\Projects\\game', '/home/me/art']) assert.ok(folderPath(p), p);
  for (const p of ['C:\\', 'C:', 'C:\\Users\\..\\Windows', 'relative\\x', '/', '/home/me/', '/home/../etc', 'C:\\a,b', '/srv/a\tb', 'C:\\a\rb', 'C:\\Users\\me\\Art\\']) assert.ok(!folderPath(p), p);
  const { folders, problems } = hostFolders({ art: { path: 'C:\\Users\\me\\Art' }, docs: { path: 'C:\\Users\\me\\Docs', write: true }, 'Bad Name': { path: 'C:\\x' }, root: { path: 'C:\\' }, odd: { path: 'C:\\y', write: 'yes' } });
  assert.deepEqual(folders, [
    { name: 'art', path: 'C:\\Users\\me\\Art', write: false },
    { name: 'docs', path: 'C:\\Users\\me\\Docs', write: true },
  ]);
  assert.equal(problems.length, 3);
  // Only what is mounted in the distro now is given to a turn.
  const table = `36 25 0:31 / ${HOST_SRC}/art rw,relatime - 9p drvfs rw\n37 25 0:32 / /mnt/wsl rw - tmpfs none rw`;
  assert.deepEqual([...mountedFolders(table)], ['art']);
  assert.deepEqual(hostMounts(folders, mountedFolders(table)), [{ src: `${HOST_SRC}/art`, dst: '/host/art', ro: true }]);
});

test("root's copy of the folder check in citadel-worker agrees with the worker's, and imports nothing from its home", () => {
  const script = readFileSync(join(import.meta.dirname, '../tools/worker/citadel-worker'), 'utf8');
  const js = /^FOLDERS_JS='([^']*)'$/m.exec(script)?.[1];
  assert.ok(js, 'FOLDERS_JS is in the script');
  assert.doesNotMatch(script, /import\(|\$home\/app/, "root runs no code from the worker user's home");
  const raw = {
    art: { path: 'C:\\Users\\me\\Art' },
    docs: { path: 'C:\\Users\\me\\Docs', write: true },
    lin: { path: '/srv/x' },
    'Bad Name': { path: 'C:\\x' },
    root: { path: 'C:\\' },
    up: { path: 'C:\\a\\..\\b' },
    slash: { path: '/srv/x/' },
    odd: { path: 'C:\\y', write: 'yes' },
    comma: { path: 'C:\\a,b' },
    tab: { path: '/srv/a\tb' },
  };
  const out = spawnSync(process.execPath, ['-e', `${js}\nconsole.log(JSON.stringify(hostFolders(cfg.folders)))`], { env: { ...process.env, CFG: JSON.stringify({ folders: raw }) }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), hostFolders(raw));
});

test("a host turn's end counts what changed in each read-write folder, and its chat gets one line", async () => {
  const { w, calls } = worker([
    { src: `${HOST_SRC}/docs`, dst: '/host/docs', ro: true },
    { src: `${HOST_SRC}/art`, dst: '/host/art', ro: false },
  ]);
  await w.begin('/data/turns/2-1', launch(true));
  const t = w.turns.get('/data/turns/2-1')!;
  assert.equal(w.counted(t), false, 'its end waits for the count');
  w.exec = async (_cmd: string, args: string[]) => {
    calls.push(args);
    return { code: 0, out: '3 1\n', err: '' };
  };
  w.poke = () => {};
  await w.countWrites(t);
  const finds = calls.filter((a) => a.includes('-c') && a.some((s) => s.includes('find')));
  assert.deepEqual(
    finds.map((a) => a[a.length - 2]),
    ['/host/art'],
    'only read-write folders are counted',
  );
  assert.equal(w.counted(t), true);
  const got = JSON.parse(readFileSync(join(t.local, 'host-writes.json'), 'utf8'));
  assert.deepEqual(got, { folders: [{ name: 'art', files: 3, dirs: true }] });
  assert.equal(await writesLine(t.local, 'desk'), "Changed in desk's folders during this turn: /host/art (3 files new or changed). Citadel can't roll those back.");
  writeFileSync(join(t.local, 'host-writes.json'), JSON.stringify({ folders: [{ name: 'art', files: 0, dirs: true }] }));
  assert.equal(await writesLine(t.local, 'desk'), "Changed in desk's folders during this turn: /host/art (something removed or renamed). Citadel can't roll those back.");

  // The count itself, run by a real sh and find: a turn that only deletes still shows.
  const sh = finds[0][finds[0].indexOf('-c') + 1];
  const box = join(root, 'count');
  mkdirSync(join(box, 'sub'), { recursive: true });
  writeFileSync(join(box, 'sub', 'old.txt'), '');
  writeFileSync(join(box, 'keep.txt'), '');
  const mark = join(root, 'count-began');
  writeFileSync(mark, '');
  const past = new Date(Date.now() - 60_000);
  for (const p of [join(box, 'sub', 'old.txt'), join(box, 'keep.txt'), join(box, 'sub'), box, mark]) utimesSync(p, past, past);
  const count = () => spawnSync('sh', ['-c', sh, 'sh', box, mark], { encoding: 'utf8' }).stdout.trim();
  assert.equal(count(), '0 0', 'nothing changed since the mark');
  rmSync(join(box, 'sub', 'old.txt'));
  assert.equal(count(), '0 1', 'a delete shows as its folder changing');
  writeFileSync(join(box, 'keep.txt'), 'x');
  assert.equal(count(), '1 1');

  writeFileSync(join(t.local, 'host-writes.json'), JSON.stringify({ folders: [] }));
  assert.equal(await writesLine(t.local, 'desk'), null, 'nothing written, no line');
  writeFileSync(join(t.local, 'host-writes.json'), JSON.stringify({ folders: [], error: 'counting /host/art failed: exit 1' }));
  assert.match((await writesLine(t.local, 'desk')) ?? '', /couldn't be counted: counting \/host\/art failed/);
  assert.equal(await writesLine(join(root, 'none'), 'desk'), null);
});

test("starts go to the machine's agent by name and wait for its word; a wrong machine's answer, a gone agent and silence fail", async () => {
  const sent: { machine: number; id: string; program: string; args: string[] }[] = [];
  let connected = true;
  const starts = new HostStarts((machine, msg) => (sent.push({ machine, ...msg }), connected), 50);
  const one = starts.start(7, 'notepad', ['a.txt']);
  assert.deepEqual(
    sent.map((s) => [s.machine, s.program, s.args]),
    [[7, 'notepad', ['a.txt']]],
  );
  assert.equal(starts.answer(8, { id: sent[0].id, ok: true, pid: 1 }), false, "another machine can't answer it");
  assert.equal(starts.answer(7, { id: sent[0].id, ok: true, pid: 42 }), true);
  assert.deepEqual(await one, { ok: true, pid: 42 });

  const refused = starts.start(7, 'cmd', []);
  starts.answer(7, { id: sent[1].id, ok: false, error: '"cmd" isn\'t one of the programs' });
  assert.deepEqual(await refused, { ok: false, error: '"cmd" isn\'t one of the programs' });

  const gone = starts.start(7, 'notepad', []);
  starts.dropped(7);
  assert.equal((await gone).ok, false);
  const quiet = await starts.start(7, 'notepad', []);
  assert.match(quiet.ok ? '' : quiet.error, /didn't answer/, 'silence ends in a refusal');

  connected = false;
  assert.deepEqual(await starts.start(7, 'notepad', []), { ok: false, error: "the machine's agent isn't connected" });
  assert.equal((await starts.start(7, '../cmd.exe', [])).ok, false, 'a path is not a name');
  assert.equal((await starts.start(7, 'notepad', Array(21).fill('x'))).ok, false);
});

test("the agent starts only its owner's listed programs, by name, never through a shell", async () => {
  const exe = join(root, 'tool.exe');
  writeFileSync(exe, '');
  const file = join(root, 'machine-agent.json');
  writeFileSync(file, JSON.stringify({ programs: { tool: { path: exe, about: 'A tool' }, wide: { path: exe, args: true }, 'bad name!': { path: exe }, rel: { path: 'tool.exe' }, gone: { path: join(root, 'gone.exe') } } }));
  const { programs, problems } = loadConfig(file);
  assert.deepEqual([...programs.keys()], ['tool', 'wide', 'gone']);
  assert.equal(problems.length, 2);

  const spawned: { path: string; args: string[]; opts: SpawnOptions }[] = [];
  const run = (path: string, args: string[], opts: SpawnOptions) => {
    spawned.push({ path, args, opts });
    const child = Object.assign(new EventEmitter(), { pid: 99, unref() {} });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const own = [join(root, 'agent')];
  const ask = (a: { program: string; args?: string[] }) => ({ ...a, writable: [] as string[] });
  assert.equal(await startProgram(programs, ask({ program: 'tool' }), own, run), 99);
  assert.deepEqual(spawned[0], { path: exe, args: [], opts: { cwd: root, detached: true, stdio: 'ignore', shell: false, windowsHide: false } });
  assert.equal(await startProgram(programs, ask({ program: 'wide', args: ['--open', 'a b'] }), own, run), 99);
  assert.deepEqual(spawned[1].args, ['--open', 'a b']);

  assert.throws(() => startProgram(programs, ask({ program: 'cmd' }), own, run), /"cmd" isn't one of the programs .* They are: tool, wide, gone\./);
  assert.throws(() => startProgram(programs, ask({ program: 'tool', args: ['x'] }), own, run), /takes no arguments/);
  assert.throws(() => startProgram(programs, ask({ program: 'gone' }), own, run), /isn't there any more/);
  assert.throws(() => startProgram(new Map(), ask({ program: 'tool' }), own, run), /They list none/);
  // A folder minions can write to that holds the agent, its list or the program: nothing starts.
  assert.throws(() => startProgram(programs, { program: 'tool' }, own, run), /didn't say which of this PC's folders/);
  assert.throws(() => startProgram(programs, { program: 'tool', writable: [root] }, own, run), /This agent and its list of programs are in .* starts nothing/);
  assert.throws(() => startProgram(programs, { program: 'tool', writable: [join(root, 'agent', 'data')] }, own, run), /This agent and its list/, "a writable folder inside the agent's too");
  assert.throws(() => startProgram(programs, { program: 'tool', writable: [root] }, [join(tmpdir(), 'elsewhere')], run), /tool is in .* inside a folder minions .* can write to/);
  assert.equal(await startProgram(programs, { program: 'tool', writable: [join(root, 'agent2'), join(root, 'too')] }, own, run), 99, 'a sibling folder whose name starts the same is not inside');
  assert.equal(spawned.length, 3, 'nothing else was started');
});
