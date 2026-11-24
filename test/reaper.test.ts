import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { folderOf, guardedCgroup, guardedPids, ownerOf, Reaper, REAPED, scanProcs, shownCommand, startOf, WRAPPER_MARKS, type Proc } from '../src/reaper.ts';
import { SHIM } from '../src/turn-run.mjs';
import { bootServer, tempRoot, until } from './helpers.ts';

const tmp = tempRoot('reaper-');
const root = tmp.dir;
const pids: number[] = [];
after(async () => {
  for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  await tmp.teardown();
});

const P = '/data/projects';
const proc = (o: Partial<Proc>): Proc => ({ pid: 1000, ppid: 1, start: '1', tty: 0, cwd: null, argv: ['node'], cgroup: '/user.slice/user-1002.slice/user@1002.service/citadel.slice/citadel-heavy.slice/run-x.scope', cpuS: 0, ageS: 0, ...o });

test('a process is a minion\'s by its working folder first, else by the one minion folder its command line names', () => {
  assert.deepEqual(folderOf(P, `${P}/2/tickets/2902`), { projectId: 2, ticketId: 2902 });
  assert.deepEqual(folderOf(P, `${P}/2/tmp/2902/dev-copy/data`), { projectId: 2, ticketId: 2902 });
  assert.equal(folderOf(P, `${P}/2/repo`), null); // a scheme's main checkout: a Taskmaster's
  assert.equal(folderOf(P, `${P}/2/tickets/29020x`), null);
  // Close removes the scratch folder before it reaps: a process still in it reads so in /proc.
  assert.deepEqual(folderOf(P, `${P}/2/tmp/2902 (deleted)`), { projectId: 2, ticketId: 2902 });
  assert.equal(folderOf(P, `${P}/.heavy/slots`), null);
  assert.equal(folderOf(P, '/home/cara/delve-godot'), null);

  assert.deepEqual(ownerOf(P, proc({ cwd: `${P}/2/tickets/7`, argv: ['cat', `${P}/2/tickets/8/x`] })), { projectId: 2, ticketId: 7 });
  assert.deepEqual(ownerOf(P, proc({ cwd: '/', argv: ['node', `--data=${P}/3/tmp/9/d`] })), { projectId: 3, ticketId: 9 });
  assert.equal(ownerOf(P, proc({ cwd: '/', argv: ['diff', `${P}/2/tickets/7/a`, `${P}/2/tickets/8/a`] })), null, 'two minions named: nobody\'s');
  assert.equal(ownerOf(P, proc({ cwd: `${P}/2/repo`, argv: ['git', '-C', `${P}/2/tickets/8`, 'log'] })), null, 'a Taskmaster\'s git -C');
  assert.equal(ownerOf(P, proc({ cwd: '/home/cara', argv: ['bash'] })), null);
});

test('people\'s sessions, terminals, ships, deploys, contraptions and the server\'s unit are guarded; dev copies and containers are not', () => {
  assert.ok(guardedCgroup('/user.slice/user-1002.slice/session-4.scope'));
  assert.ok(guardedCgroup('/user.slice/user-1002.slice/user@1002.service/citadel.slice/citadel-builds.slice/citadel-land-80e7ef5d-2902-1795.service'));
  assert.ok(guardedCgroup('/user.slice/user-1002.slice/user@1002.service/citadel.slice/citadel-turns.slice/citadel-ultrareview-12.service'));
  assert.ok(guardedCgroup('/user.slice/user-1002.slice/user@1002.service/citadel.slice/citadel-taskmasters.slice/citadel-mcp-pool-abc.service'));
  assert.ok(guardedCgroup('/user.slice/user-1002.slice/user@1002.service/app.slice/claude-coordinator.service'));
  assert.ok(guardedCgroup('/user.slice/user-1002.slice/user@1002.service/contraptions.slice/citadel-app-peek.service'));
  assert.ok(!guardedCgroup('/user.slice/user-1002.slice/user@1002.service/citadel.slice/citadel-heavy.slice/run-r1.scope'));
  assert.ok(!guardedCgroup('/user.slice/user-1002.slice/user@1002.service/citadel.slice/libpod-payload-e157cb57.scope'));
  assert.ok(!guardedCgroup('/user.slice/user-1002.slice/user@1002.service/citadel.slice/citadel-turns.slice/citadel-turn-80e7ef5d-2902-1.service'));
  assert.ok(!guardedCgroup(''));

  const procs = [
    proc({ pid: 10, ppid: 1, argv: ['node', '/pin/turn-wrapper.ts', '/turns/7'] }),
    proc({ pid: 11, ppid: 10, argv: ['claude'] }),
    proc({ pid: 12, ppid: 11, argv: ['bash', '-c', 'git -C x log'] }),
    proc({ pid: 20, ppid: 1, tty: 34816, argv: ['fish'] }),
    proc({ pid: 21, ppid: 20, argv: ['npm', 'run', 'dev'] }),
    proc({ pid: 30, ppid: 1, cgroup: '/u/citadel-builds.slice/citadel-land-x-1-2.service', argv: ['bash', 'tools/land.sh'] }),
    proc({ pid: 31, ppid: 30, argv: ['git', 'push'] }),
    proc({ pid: 40, ppid: 1, argv: ['node', 'server.ts'] }),
    proc({ pid: 41, ppid: 40, argv: ['node', 'preview'] }),
    proc({ pid: 50, ppid: 1, argv: ['node', '/w/server.ts'] }),
    proc({ pid: 51, ppid: 50, argv: ['esbuild'] }),
  ];
  const g = guardedPids(procs, { selfPid: 40, wrapperMark: '/turn-wrapper.ts', guardCgroup: guardedCgroup });
  assert.deepEqual([...g].sort((a, b) => a - b), [10, 11, 12, 20, 21, 30, 31, 40, 41]);
  // The wrapper is plain JS since #1343: a turn started before or after the deploy is guarded by the default marks.
  const turns = [
    proc({ pid: 60, ppid: 1, argv: ['node', '/pin/turn-wrapper.mjs', '/turns/8'] }),
    proc({ pid: 61, ppid: 60, argv: ['claude'] }),
    proc({ pid: 70, ppid: 1, argv: ['node', '/pin/turn-wrapper.ts', '/turns/9'] }),
    proc({ pid: 80, ppid: 1, argv: ['node', '/w/other.mjs', '/turns/10'] }),
    // A turn the shared supervisor started (#1343): its shell is the guard, not a node wrapper.
    proc({ pid: 90, ppid: 1, argv: ['/bin/sh', '-c', SHIM, '/turns/11', '5', 'claude', '-p'] }),
    proc({ pid: 91, ppid: 90, argv: ['claude', '-p'] }),
    proc({ pid: 92, ppid: 91, argv: ['git', '-C', '/closed/minion', 'log'] }),
    proc({ pid: 95, ppid: 1, argv: ['/bin/sh', '-c', 'sleep 1', '/turns/12'] }),
  ];
  const t = guardedPids(turns, { selfPid: 1, wrapperMark: WRAPPER_MARKS, guardCgroup: () => false });
  assert.deepEqual([...t].sort((a, b) => a - b), [60, 61, 70, 90, 91, 92]);
});

test('a command line shown to people has its secrets masked', () => {
  assert.equal(shownCommand(['curl', '-H', 'Authorization: Bearer abc.def', 'x']), 'curl -H Authorization: … … x');
  assert.equal(shownCommand(['node', 'x', '--token=hunter2']), 'node x --token=…');
  assert.match(shownCommand(['node', `KEY_${'a'.repeat(40)}`]), /…/);
  assert.equal(shownCommand(['git', 'clone', 'https://alice:shortpass@host/x']), 'git clone https://…@host/x');
  assert.equal(shownCommand(['node', '/w/server.ts']), 'node /w/server.ts');
});

/** A long-running process started from `cwd` the way tools/dev-copy.ts does it: a detached sh that starts it in the
 * background and exits, so it is re-parented away from this test. Its pid. */
async function detached(cwd: string, tag: string): Promise<number> {
  const pidFile = join(root, `${tag}.pid`);
  const sh: ChildProcess = tmp.spawn('sh', ['-c', `"$0" -e 'setInterval(() => {}, 1000)' ${tag} & echo $! > "$1"`, process.execPath, pidFile], { cwd, detached: true, stdio: 'ignore' });
  await new Promise((r) => sh.on('exit', r));
  for (let i = 0; i < 50; i++) {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (pid && (await startOf(pid))) return pids.push(pid), pid;
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${tag} did not start`);
}

const alive = async (pid: number) => !!(await startOf(pid));

function scheme(dir: string) {
  mkdirSync(dir, { recursive: true });
  const store = new Store(join(dir, 'db.sqlite'));
  const p = store.createProject('Reap', null);
  const mk = (title: string, kind: 'ticket' | 'coordinator' = 'ticket') => {
    const t = store.createTicket({ project_id: p.id, title, permission_mode: 'default', created_by: 'Cara', kind });
    for (const f of ['tickets', 'tmp']) mkdirSync(join(dir, 'projects', String(p.id), f, String(t.id)), { recursive: true });
    return t;
  };
  return { store, p, mk, folder: (id: number, f = 'tickets') => join(dir, 'projects', String(p.id), f, String(id)) };
}

test('closing reaps only the closed minion\'s processes; open minions, Taskmasters and other folders keep theirs', async () => {
  const dir = join(root, 'unit');
  const { store, mk, folder } = scheme(dir);
  const closed = mk('closed'), open = mk('open'), tm = mk('tm', 'coordinator'), other = mk('closed but not this one');
  const dev = await detached(folder(closed.id), 'dev');
  const scratch = await detached(folder(closed.id, 'tmp'), 'scratch');
  const mine = await detached(folder(open.id), 'open');
  const theirs = await detached(folder(tm.id, 'tmp'), 'tm');
  const outside = await detached(root, 'outside');
  const notThis = await detached(folder(other.id), 'other');
  // A person's shell in the closed minion's worktree: `script` holds its terminal and has none itself.
  // Started through `sh -c '… &'` so it is re-parented away from the test, which the reaper treats as the server.
  const sh = tmp.spawn('sh', ['-c', `script -qfc "exec \\"$0\\" -e 'setInterval(() => {}, 1000)' shell" /dev/null &`, process.execPath], { cwd: folder(closed.id), detached: true, stdio: 'ignore' });
  await new Promise((r) => sh.on('exit', r));
  const [termPid, shell] = await until('the shell under script', async () => {
    const procs = await scanProcs();
    const s = procs.find((p) => p.tty !== 0 && p.argv.includes('shell') && procs.find((q) => q.pid === p.ppid && q.argv[0] === 'script' && q.cwd === folder(closed.id)));
    return s && [s.ppid, s.pid];
  }, 10_000);
  pids.push(termPid, shell);
  for (const t of [closed, tm, other]) store.updateTicket(t.id, { status: 'closed' });
  rmSync(folder(closed.id, 'tmp'), { recursive: true }); // as close does before it reaps
  const rows: string[] = [];
  const reaper = new Reaper({ store, dataDir: dir, termWaitMs: 2000, log: () => {}, guardCgroup: () => false, wrapperMark: '/no-wrapper-here.ts' });
  store.addHealthEvent = (kind: string, _at: number, _c: string | null, detail: string) => rows.push(`${kind} ${detail}`);

  const reaped = await reaper.reap(closed.id);
  assert.deepEqual(reaped.map((r) => r.pid).sort(), [dev, scratch].sort());
  assert.ok(!(await alive(dev)) && !(await alive(scratch)), 'the closed minion\'s processes are gone');
  for (const pid of [mine, theirs, outside, notThis, termPid, shell]) assert.ok(await alive(pid), `pid ${pid} still runs`);
  assert.equal(rows.length, 2);
  assert.match(rows[0], new RegExp(`^${REAPED} \\{"ticket":${closed.id},"number":${closed.number}`));
  assert.match(rows[0], /"signal":"TERM"/);
  store.db.close();
});

test('the sweep reaps every closed minion\'s leftovers, skips one reopened while /proc was read, and KILLs what ignores TERM', async () => {
  const dir = join(root, 'sweep');
  const { store, mk, folder } = scheme(dir);
  const a = mk('a'), b = mk('reopened'), c = mk('stubborn');
  const pa = await detached(folder(a.id), 'a');
  const pb = await detached(folder(b.id), 'b');
  const pc = await detached(folder(c.id), 'c');
  for (const t of [a, b, c]) store.updateTicket(t.id, { status: 'closed' });
  const sent: string[] = [];
  const reaper = new Reaper({
    store, dataDir: dir, termWaitMs: 300, log: () => {}, guardCgroup: () => false, wrapperMark: '/no-wrapper-here.ts',
    // Reopened as the scan runs: it was closed when found, open at the kill.
    scan: async () => { const procs = await scanProcs(); store.updateTicket(b.id, { status: 'idle' }); return procs; },
    // c ignores TERM (nothing is sent); everything else is really signalled.
    kill: (pid, sig) => { sent.push(`${pid} ${sig}`); if (pid !== pc || sig === 'SIGKILL') process.kill(pid, sig); },
  });
  const reaped = await reaper.reap();
  assert.deepEqual(reaped.map((r) => [r.pid, r.signal]).sort(), [[pa, 'TERM'], [pc, 'KILL']].sort());
  assert.ok(await alive(pb), 'the reopened minion keeps its process');
  assert.ok(!sent.some((s) => s.startsWith(`${pb} `)));
  await until('the stubborn process to die of KILL', async () => !(await alive(pa)) && !(await alive(pc)), 5000);
  store.db.close();
});

/** A stand-in turn supervisor: its command line as supervisor-client starts one (`<node> <home>/turn-supervisor.mjs <home> <version>`). */
async function supervisor(home: string, tag: string): Promise<number> {
  mkdirSync(home, { recursive: true });
  // It says when it has loaded: a folder deleted before node reads the script would end it with "module not found".
  writeFileSync(join(home, 'turn-supervisor.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(root, `${tag}.ready`))}, '');\nsetInterval(() => {}, 1000);\n`);
  const pidFile = join(root, `${tag}.pid`);
  const sh: ChildProcess = tmp.spawn('sh', ['-c', `"$0" "$1/turn-supervisor.mjs" "$1" v1 & echo $! > "$2"`, process.execPath, home, pidFile], { detached: true, stdio: 'ignore' });
  await new Promise((r) => sh.on('exit', r));
  const pid = await until(`${tag} to run`, async () => {
    try {
      const p = Number(readFileSync(pidFile, 'utf8').trim());
      return p && existsSync(join(root, `${tag}.ready`)) ? p : null;
    } catch { return null; } // not written yet, or gone
  });
  pids.push(pid);
  return pid;
}

test('turn supervisors whose folder is gone or whose ship has ended are stopped with TERM (and the unit of one that ignores it); live ones and running ships\' keep theirs', async () => {
  const dir = join(root, 'supervisors');
  const { store } = scheme(dir);
  const landings = join(dir, 'run', 'landings');
  const sup = (...p: string[]) => join(...p, 'data', 'run', 'turns', '.supervisor', 'v1');
  const gone = await supervisor(sup(root, 'deleted-test'), 'gone');
  const live = await supervisor(sup(dir), 'live');
  const shipped = await supervisor(sup(landings, '7', 'tmp', 'boot-x'), 'shipped');
  const shipping = await supervisor(sup(landings, '8', 'tmp', 'boot-y'), 'shipping');
  const notOne = await detached(root, 'not-a-supervisor');
  rmSync(join(root, 'deleted-test'), { recursive: true }); // timing-ok: the folder going is the case under test
  writeFileSync(join(landings, '7', 'code'), '0'); // ship 7's land.sh ended; 8's still runs
  const sent: string[] = [];
  const units: string[] = [];
  const reaper = new Reaper({
    store, dataDir: dir, termWaitMs: 500, log: () => {},
    // This test's own processes only: the box's real supervisors are not the test's to stop. `shipped` runs in its unit.
    scan: async () => (await scanProcs()).filter((p) => pids.includes(p.pid)).map((p) => (p.pid === shipped ? { ...p, cgroup: '/user.slice/citadel-taskmasters.slice/citadel-supervisor-ab-v1.service' } : p)),
    // `shipped` ignores TERM, so it is KILLed, and its unit stopped so Restart=on-failure can't bring it back.
    kill: (pid, sig) => { sent.push(`${pid} ${sig}`); if (pid !== shipped || sig === 'SIGKILL') process.kill(pid, sig); },
    stopUnit: async (unit) => units.push(unit),
  });
  assert.deepEqual((await reaper.reapSupervisors()).sort(), [gone, shipped].sort());
  assert.deepEqual(sent.sort(), [`${gone} SIGTERM`, `${shipped} SIGTERM`, `${shipped} SIGKILL`].sort());
  assert.deepEqual(units, ['citadel-supervisor-ab-v1.service']);
  await until('both to exit', async () => !(await alive(gone)) && !(await alive(shipped)));
  for (const pid of [live, shipping, notOne]) assert.ok(await alive(pid), `pid ${pid} still runs`);
  store.db.close();
});

test('dismissing a minion stops the dev server it left running, and the host-load page lists it by minion first', async (t) => {
  // The live server's own guard keeps what runs in a login session, a ship (the smoke check's citadel-builds.slice) and
  // the like; a run from one can't show the close, as its dev server shares that guarded cgroup.
  const own = /^0::(.*)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1] ?? '';
  if (guardedCgroup(own)) return t.skip(`run from ${own.split('/').pop()}, whose processes the reaper never touches`);
  const srv = await bootServer({ root: join(root, 'boot') });
  try {
    const { data: p } = await srv.call('/api/projects', { name: 'Reaped' });
    const { data: m } = await srv.call(`/api/projects/${p.id}/tickets`, { message: 'start a dev server', properties: { type: 'chore' } });
    const wt = join(srv.data, 'projects', String(p.id), 'tickets', String(m.id));
    mkdirSync(wt, { recursive: true });
    const dev = await detached(wt, 'boot-dev');
    const listed = await srv.call('/api/host-load');
    const row = listed.data.minions.find((x: { ticket: number }) => x.ticket === m.id);
    assert.ok(row?.procs.some((x: { pid: number }) => x.pid === dev), JSON.stringify(listed.data.minions));
    assert.equal(row.status === 'closed', false);
    // Its first turn (CLAUDE_BIN is /bin/false) has to end before it can be dismissed.
    const res = await until('the minion to be dismissable', async () => { const r = await srv.call(`/api/tickets/${m.id}/status`, { status: 'closed' }); return r.status === 409 ? null : r; }, 10_000);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    await until('the dev server to be gone after the close', async () => !(await alive(dev)), 15_000);
    const reaped: { pid: number; number: number }[] = await until('the reaped row', async () => { const r = (await srv.call('/api/host-load')).data.reaped; return r.length ? r : null; }, 5000);
    assert.deepEqual(reaped.map((r) => [r.pid, r.number]), [[dev, m.number]]);
  } finally {
    await srv.stop();
  }
});
