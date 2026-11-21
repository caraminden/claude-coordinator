import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { cantStop, descendants, shipLines, shipRows, signalTree, StopRefused, stopInLine, stopMinionShip, stopShip } from '../src/ship-stop.ts';
import { CITADEL_TARGET } from '../src/releases.ts';
import { readQueue, type LandTicket } from '../src/waits.ts';
import { tempRoot, until } from './helpers.ts';

// #1168: the Status page's ship line and its "Stop this ship".
const scratch = tempRoot('ship-stop-');
const root = scratch.dir;
after(() => scratch.teardown());

const ticket = (o: Partial<LandTicket>): LandTicket => ({ seq: 1, proc: '1 1', got: 0, label: 'ticket/9-x', phase: 'waiting', mtime: 0, ...o });

test('a ship can be stopped until main moves; a lone deploy and a train rider never', () => {
  for (const phase of ['starting', 'rebasing onto main', 'waiting for CI since 12:01', 'running the tests since 12:03', 'boot check before CI since 12:00', 'waiting for CI on abc123 since 12:00', 'running the check since 12:00'])
    assert.equal(cantStop({ label: 'ticket/9-x', phase }), null, phase);
  for (const phase of ['deploying', 'deploying: running the tests since 12:05', 'deploying: going live', 'pushing main to origin', 'riding in #7\'s ship train'])
    assert.ok(cantStop({ label: 'ticket/9-x', phase }), phase);
  assert.match(cantStop({ label: 'tools/deploy.sh', phase: 'starting' })!, /deploy on its own/);
});

test('the rows give the holder its time held and its words, and the waiters their places', () => {
  const rows = shipRows([
    ticket({ seq: 3, got: 1_700_000_000, phase: 'waiting for CI since 12:01', mtime: 5 }),
    ticket({ seq: 4, label: 'ticket/10-y' }),
    ticket({ seq: 5, label: 'tools/deploy.sh' }),
  ], (label) => (label === 'ticket/9-x' ? { name: '#9', ticketId: 90 } : { name: label, ticketId: null }));
  assert.deepEqual(rows.map((r) => [r.name, r.place, r.stage, r.text, r.heldSince]), [
    ['#9', 'holds', 'test', 'waiting for CI', 1_700_000_000_000],
    ['ticket/10-y', 'next', 'line', 'waiting', null],
    ['tools/deploy.sh', '2nd', 'line', 'waiting', null],
  ]);
  assert.equal(rows[0].noStop, null);
  assert.ok(rows[2].noStop);
  // With nobody holding, the first waiter is next.
  assert.equal(shipRows([ticket({ seq: 4 })], () => ({ name: 'x', ticketId: null }))[0].place, 'next');
});

test('descendants walks each process\'s parent, names with spaces and all', () => {
  const proc = join(root, 'proc');
  const stat = (pid: number, ppid: number, comm = 'bash') => {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    writeFileSync(join(proc, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} 1 1 0`);
  };
  stat(10, 1); stat(11, 10, 'gh run (watch)'); stat(12, 11); stat(13, 10); stat(20, 1);
  mkdirSync(join(proc, 'self'), { recursive: true });
  assert.deepEqual(descendants(10, proc).sort(), [11, 12, 13]);
  assert.deepEqual(descendants(20, proc), []);
});

test('signalTree sends TERM to the ship first, then to what it started, each woken with CONT', () => {
  const sent: string[] = [];
  signalTree(10, (pid, sig) => { sent.push(`${pid} ${sig}`); if (pid === 12) throw new Error('ESRCH'); }, () => [11, 12]);
  assert.deepEqual(sent, ['10 SIGTERM', '10 SIGCONT', '11 SIGTERM', '11 SIGCONT', '12 SIGTERM', '12 SIGCONT']);
});

test('stopInLine reads the line afresh: a gone ticket and a deploying one are refused, never signalled', () => {
  const q = join(root, 'q1');
  mkdirSync(q, { recursive: true });
  writeFileSync(join(q, '0000000003'), '111 1\n1700000000\nticket/9-x\nwaiting for CI since 12:01\n');
  writeFileSync(join(q, '0000000004'), '222 1\n0\nticket/10-y\nwaiting\n');
  const signalled: number[] = [];
  const noted: number[] = [];
  const alive = () => true;
  const t = stopInLine(q, 4, 3, (x) => noted.push(x.seq), (pid) => signalled.push(pid), alive);
  assert.equal(t.label, 'ticket/9-x');
  assert.deepEqual([noted, signalled], [[3], [111]]);
  assert.throws(() => stopInLine(q, 4, 9, undefined, (pid) => signalled.push(pid), alive), (e) => e instanceof StopRefused && /no longer in line/.test(e.message));
  writeFileSync(join(q, '0000000003'), '111 1\n1700000000\nticket/9-x\ndeploying: going live\n');
  assert.throws(() => stopInLine(q, 4, 3, () => noted.push(0), (pid) => signalled.push(pid), alive), StopRefused);
  assert.deepEqual([noted, signalled], [[3], [111]], 'refused before the note and the signal');
});

test('a ship hung on the real line lets go of the lock and leaves the line when stopped, and what it started ends too', async () => {
  // A stand-in for land.sh: the line from tools/deploy-queue.sh, its trap, then a foreground sleep (a CI poll) that never ends.
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  const script = join(root, 'hung-land.sh');
  writeFileSync(script, `set -u\nsource ${JSON.stringify(resolve('tools/deploy-queue.sh'))}\nqueue_lock ${JSON.stringify(state)} ticket/9-hung || exit 1\ntrap 'queue_done; exec 9>&-' EXIT\nqueue_phase "waiting for CI since 12:00"\nsleep 300\n`);
  const land = scratch.spawn('bash', [script], { stdio: 'ignore' });
  const q = join(state, 'queue');
  let line: LandTicket[] = [];
  await until('the hung ship holds the line', () => (line = readQueue(q, 4)).some((t) => t.got > 0 && /waiting for CI/.test(t.phase)));
  const sleeper = descendants(land.pid!);
  assert.equal(sleeper.length, 1, 'its sleep runs under it');
  const ended = new Promise((r) => land.on('exit', (code, sig) => r(code ?? sig)));
  stopInLine(q, 4, line[0].seq);
  assert.equal(await ended, 'SIGTERM', 'it ended on the stop, not on its own');
  assert.deepEqual(readdirSync(q).filter((n) => /^\d+$/.test(n)), [], 'its EXIT trap ran: its ticket is gone');
  await until('its sleep is gone too', () => !existsSync(`/proc/${sleeper[0]}`) || /\) Z /.test(readFileSync(`/proc/${sleeper[0]}/stat`, 'utf8')));
  // The lock is free: the next one in line takes it at once.
  const next = scratch.spawn('bash', ['-c', `exec 9>${JSON.stringify(join(state, 'lock'))}; flock -n 9`], { stdio: 'ignore' });
  assert.equal(await new Promise((r) => next.on('exit', r)), 0, 'the lock is free');
});


// A fake app with two schemes: 1 ships on Citadel's own line (deploy-queue.sh, orderAt 4), 2 on its copy of the kit's
// land template (<repo>/.git/land-queue, orderAt 7). Line tickets name this test's own process, so they read as alive.
function fakeApp() {
  const dir = mkdtempSync(join(root, 'app-'));
  const own = join(dir, 'state', 'queue');
  const repo = join(dir, 'repo');
  mkdirSync(own, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one']);
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const kit = join(repo, '.git', 'land-queue');
  mkdirSync(kit, { recursive: true });
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const me = `${process.pid} ${stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]}`;
  const tickets: Record<number, { id: number; number: number; project_id: number; branch: string }> = {
    11: { id: 11, number: 7, project_id: 1, branch: 'ticket/11-own' },
    12: { id: 12, number: 8, project_id: 1, branch: 'ticket/12-rider' },
    21: { id: 21, number: 3, project_id: 2, branch: 'ticket/21-kit' },
  };
  const landing: Record<number, { output: string; code: number | null; pid?: number }> = {};
  const stopped: unknown[][] = [];
  const notes: [number, string][] = [];
  const app = {
    releases: { view: (f: (id: number) => boolean) => [1, 2].filter(f).map((id) => ({ targets: id === 1 ? [{ target: { id: CITADEL_TARGET } }] : [] })) },
    waits: {
      queue: own,
      ticketFor: (label: string) => Object.values(tickets).find((t) => t.branch === label)?.id ?? null,
    },
    store: {
      listProjects: () => [{ id: 1, name: 'Citadel' }, { id: 2, name: 'Other' }],
      getProject: (id: number) => (id === 2 ? { id, repo_dir: repo } : { id, repo_dir: null }),
      getTicket: (id: number) => tickets[id],
      ticketByBranch: () => undefined,
    },
    landings: {
      get: (id: number) => landing[id] ?? null,
      markStopped: (...a: unknown[]) => stopped.push(a),
      landPid: (id: number) => landing[id]?.pid ?? null,
    },
    runner: { emit: (id: number, _k: string, e: { text: string }) => notes.push([id, e.text]) },
  } as never;
  const put = (q: string, seq: number, lines: string[]) => writeFileSync(join(q, String(seq).padStart(10, '0')), `${me}\n${lines.join('\n')}\n`);
  return { app, own, kit, head, landing, stopped, notes, put, signalled: [] as number[] };
}

test("shipLines reads each scheme's line, names minions only in their own scheme, and stopShip says who stopped it", () => {
  const f = fakeApp();
  f.put(f.own, 3, ['1700000000', 'ticket/11-own', 'waiting for CI since 12:01', 'order']);
  f.put(f.own, 4, ['0', 'ticket/21-kit', 'waiting', 'order']); // scheme 2's minion's branch name, in Citadel's line
  const lines = shipLines(f.app, () => true);
  assert.deepEqual(lines.map((l) => [l.scheme, l.rows.map((r) => [r.name, r.ticketId])]), [['Citadel', [['#7', 11], ['ticket/21-kit', null]]]]);
  assert.deepEqual(shipLines(f.app, (id) => id === 2), [], 'a scheme you can\'t see is left out');
  f.landing[11] = { output: '', code: null };
  const sig: number[] = [];
  assert.equal(stopShip(f.app, 1, 3, 'Josh', (pid) => sig.push(pid)).name, '#7');
  assert.deepEqual(sig, [process.pid]);
  assert.equal(f.stopped.length, 1);
  assert.deepEqual([f.stopped[0][0], f.stopped[0][1], f.stopped[0][3]], [11, 'Josh', 'from the Status page']);
  assert.deepEqual(f.notes, [[11, 'Josh stopped this ship from the Status page: it leaves the line and main stays as it was.']]);
});

test('a train rider can be stopped while its train is tested, and not once the train has moved main', () => {
  const f = fakeApp();
  f.put(f.own, 3, ['1700000000', 'ticket/11-own', 'waiting for CI since 12:01', 'order']);
  f.put(f.own, 4, ['0', 'ticket/12-rider', "riding in #7's ship train", 'order']);
  const train = join(f.own, '..', 'train');
  mkdirSync(train, { recursive: true });
  writeFileSync(join(train, '0000000004'), 'moving abc\n');
  const sig: number[] = [];
  assert.throws(() => stopShip(f.app, 1, 4, 'Josh', (pid) => sig.push(pid)), (e) => e instanceof StopRefused && /moved main/.test(e.message));
  writeFileSync(join(train, '0000000004'), 'riding\n');
  stopShip(f.app, 1, 4, 'Josh', (pid) => sig.push(pid));
  assert.deepEqual(sig, [process.pid], 'only the riding one was signalled');
});

test("the kit's line refuses a ship whose commit main already holds (fast-forwarded, not yet pushing)", () => {
  const f = fakeApp();
  f.put(f.kit, 5, ['1700000000', 'ticket/21-kit', 'waiting for CI since 12:01', f.head, '', '', 'order']);
  const sig: number[] = [];
  assert.throws(() => stopShip(f.app, 2, 5, 'Josh', (pid) => sig.push(pid)), StopRefused);
  f.put(f.kit, 5, ['1700000000', 'ticket/21-kit', 'waiting for CI since 12:01', 'a'.repeat(40), '', '', 'order']);
  assert.equal(stopShip(f.app, 2, 5, 'Josh', (pid) => sig.push(pid)).name, '#3');
  assert.deepEqual(sig, [process.pid]);
});

test('stopping a minion stops its ship in line, or out of line before it joined, and never once main has moved', () => {
  const f = fakeApp();
  const sig: number[] = [];
  // In line: as the panel's stop, worded for the minion's stop.
  f.put(f.own, 3, ['1700000000', 'ticket/11-own', 'waiting for CI since 12:01', 'order']);
  f.landing[11] = { output: '', code: null, pid: 555 };
  assert.match(stopMinionShip(f.app, 11, 'Cara', (pid) => sig.push(pid))!, /stopped too/);
  assert.deepEqual([sig, f.stopped[0][3]], [[process.pid], 'by stopping its minion']);
  assert.match(f.notes[0][1], /^Cara stopped this ship by stopping its minion:/);
  // Out of line, after deploy.sh left the line to wait for live: it keeps running.
  rmSync(join(f.own, '0000000003'));
  f.landing[11] = { output: 'land: main is now at abc1234 "x"\ndeploy: going live\n', code: null, pid: 555 };
  assert.match(stopMinionShip(f.app, 11, 'Cara', (pid) => sig.push(pid))!, /keeps running: main has moved/);
  f.landing[11] = { output: "land: waiting outside the line for the restart of #7's ship train to be judged\n", code: null, pid: 555 };
  assert.match(stopMinionShip(f.app, 11, 'Cara', (pid) => sig.push(pid))!, /keeps running/);
  assert.deepEqual(sig, [process.pid], 'neither was signalled');
  // Out of line before it joined: stopped.
  f.landing[11] = { output: 'land: rebasing onto main\n', code: null, pid: 555 };
  assert.match(stopMinionShip(f.app, 11, 'Cara', (pid) => sig.push(pid))!, /before it joined the line/);
  assert.deepEqual(sig, [process.pid, 555]);
  // No landing running: nothing to say.
  f.landing[11] = { output: '', code: 0, pid: 555 };
  assert.equal(stopMinionShip(f.app, 11, 'Cara', (pid) => sig.push(pid)), null);
});
