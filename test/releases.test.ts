import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { Ship } from '../src/branch.ts';
import { Store } from '../src/db.ts';
import { CITADEL_TARGET, CitadelServer, previewCopies, Releases } from '../src/releases.ts';
import { Waits } from '../src/waits.ts';

// src/releases.ts (#625): the release monitor's data, Citadel's own server read from the land line, ship stages and wait-usual.
const root = mkdtempSync(join(tmpdir(), 'releases-'));
after(() => rmSync(root, { recursive: true, force: true }));

let now = 1_800_000_000_000;
let dirs = 0;

function world() {
  const store = new Store(join(root, `test-${++dirs}.db`));
  const citadel = store.createProject('Citadel', 'https://github.com/o/citadel');
  const state = join(root, `state-${dirs}`), heavy = join(root, `heavy-${dirs}`);
  mkdirSync(join(state, 'queue'), { recursive: true });
  mkdirSync(heavy, { recursive: true });
  const ships = new Map<number, Ship['stage']>();
  let turns = 0;
  const ship = (id: number): Ship | null => (ships.has(id) ? { stage: ships.get(id)!, text: `ship ${ships.get(id)}`, commit: 'abc1234' } : null);
  const waits = new Waits({ store, deployState: state, heavyDir: heavy, interruptible: () => turns, changed: () => {}, now: () => now, ship, alive: () => true, held: () => true });
  let head: string | null = 'live1';
  const server = new CitadelServer({
    store, scheme: () => store.getProject(citadel.id) ?? null, head: () => head, line: () => waits.line, ticketFor: (l) => waits.ticketFor(l),
    wait: waits.wait, ship, usual: waits.usual, interruptible: () => turns, now: () => now,
  });
  const minion = (title = 'T') => {
    const t = store.createTicket({ project_id: citadel.id, title, permission_mode: 'default', created_by: 'Cara' });
    store.setTicketDir(t.id, root, `ticket/${t.number}-x`);
    return { id: t.id, number: t.number!, branch: `ticket/${t.number}-x` };
  };
  /** A land-line ticket as tools/deploy-queue.sh writes it, last written `ago` s before now. */
  const land = (seq: number, label: string, got: number, phase: string, ago: number) => {
    const f = join(state, 'queue', String(seq).padStart(10, '0'));
    writeFileSync(f, `${seq}00 77\n${got}\n${label}\n${phase}\n`);
    utimesSync(f, (now - ago * 1000) / 1000, (now - ago * 1000) / 1000);
  };
  const clearLine = () => rmSync(join(state, 'queue'), { recursive: true, force: true }) ?? mkdirSync(join(state, 'queue'));
  return {
    store, citadel, waits, server, ships, minion, land, clearLine,
    setTurns: (n: number) => (turns = n), setHead: (h: string | null) => (head = h),
  };
}

const usuals = { 'land:rebase': [5], 'land:ci': [90, 100, 80], 'land:deploy': [10], restart: [40] };

test('the next release: the furthest-along change leads, with its stage, usual, the land line and an estimate', () => {
  const w = world();
  w.store.setSetting('wait-usual', usuals);
  const a = w.minion('Holder'), b = w.minion('Waiter');
  w.land(1, a.branch, now / 1000 - 40, 'waiting for CI since 14:02', 30);
  w.land(2, b.branch, 0, 'waiting', 20);
  w.waits.poll();
  const [t] = w.server.read();
  assert.equal(t.target.id, CITADEL_TARGET);
  assert.equal(t.target.projectId, w.citadel.id);
  assert.equal(t.target.name, 'Server');
  assert.deepEqual(t.current, { version: 'live1', link: 'https://github.com/o/citadel/commit/live1', changes: [], started: null, live: null, outcome: 'live', stages: {} }, 'no row yet: the live head alone');
  assert.deepEqual(t.line.map((e) => [e.name, e.holds, e.stage]), [[`#${a.number}`, true, 'test'], [`#${b.number}`, false, 'line']]);
  const n = t.next!;
  assert.deepEqual(n.stages, [
    { name: 'line', usual: null }, { name: 'rebase', usual: 5 }, { name: 'test', usual: 90 },
    { name: 'deploy', usual: 10 }, { name: 'restart', usual: 40 }, { name: 'live', usual: 0 },
  ]);
  assert.equal(n.stage, 'test');
  assert.equal(n.since, now - 30_000);
  assert.equal(n.usual, 90, "the median of land:ci's last lengths");
  assert.equal(n.waitingOn, null);
  assert.equal(n.eta, now - 30_000 + (90 + 10 + 40) * 1000);
  assert.deepEqual(n.changes.map((c) => [c.ticketId, c.stage]), [[a.id, 'test'], [b.id, 'line']]);
  assert.equal(n.changes[1].waitingOn, `2nd in line, behind #${a.number} (waiting for CI)`, 'the line is a wait: it says what it waits on');
  assert.equal(n.changes[1].usual, null);
});

test('the estimate: only when the current stage and every one after it have a usual time and nothing waits', () => {
  const w = world();
  w.store.setSetting('wait-usual', usuals);
  const a = w.minion();
  w.land(1, a.branch, now / 1000 - 10, 'deploying: boot check on a copy of the database', 4);
  w.waits.poll();
  let n = w.server.read()[0].next!;
  assert.equal(n.stage, 'deploy');
  assert.equal(n.usual, 10);
  assert.equal(n.eta, now - 4000 + (10 + 40 + 0) * 1000, 'deploy, then restart, then live');

  // Merged, pulled, waiting on the idle restart behind running turns: hatched, no estimate.
  w.clearLine();
  w.ships.set(a.id, 'deploying');
  w.setTurns(2);
  w.waits.poll();
  n = w.server.read()[0].next!;
  assert.equal(n.stage, 'restart');
  assert.equal(n.waitingOn, 'the restart waits for 2 running turns to end');
  assert.equal(n.eta, null);
  w.setTurns(0);
  n = w.server.read()[0].next!;
  assert.equal(n.waitingOn, null);
  assert.equal(n.usual, 40);
  assert.equal(n.eta, n.since + 40_000);

  // No usual time known for a stage ahead: no estimate.
  w.store.setSetting('wait-usual', { 'land:deploy': [10] });
  w.ships.delete(a.id);
  w.land(2, a.branch, now / 1000, 'deploying: running the tests', 1);
  w.waits.poll();
  assert.equal(w.server.read()[0].next!.eta, null);
});

test('on main with no deploy coming waits for one; a failed deploy says why; a branch not landing is not in it', () => {
  const w = world();
  const a = w.minion(), b = w.minion(), c = w.minion();
  w.ships.set(a.id, 'main');
  w.ships.set(b.id, 'failed');
  w.ships.set(c.id, 'branch');
  w.waits.poll();
  const n = w.server.read()[0].next!;
  assert.deepEqual(n.changes.map((x) => [x.ticketId, x.stage, x.waitingOn]).sort(), [[a.id, 'deploy', 'on main, waiting for a deploy'], [b.id, 'deploy', 'ship failed']].sort());
  const since = n.since;
  now += 5000;
  assert.equal(w.server.read()[0].next!.since, since, "a stage's start stays put between polls, so the event isn't re-sent every poll");

  // A deploy run alone carries what's on main.
  w.land(1, 'tools/deploy.sh', now / 1000, 'deploying: boot check', 2);
  w.waits.poll();
  const m = w.server.read()[0].next!;
  assert.equal(m.changes.find((x) => x.ticketId === a.id)!.waitingOn, null);
  assert.deepEqual(w.server.read()[0].line.map((e) => [e.name, e.ticketId]), [['tools/deploy.sh', null]]);
});

test('an idle target has no next release; no scheme yet, no target', () => {
  const w = world();
  w.waits.poll();
  assert.equal(w.server.read()[0].next, null);
  const none = new CitadelServer({ store: w.store, scheme: () => null, head: () => 'x', line: () => [], ticketFor: () => null, wait: () => null, ship: () => null, usual: () => null, interruptible: () => 0 });
  assert.deepEqual(none.read(), []);
});

const git = (cwd: string, args: string[], date?: number) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...(date && { GIT_COMMITTER_DATE: `@${Math.floor(date / 1000)} +0000`, GIT_AUTHOR_DATE: `@${Math.floor(date / 1000)} +0000` }) },
}).trim();

test('live writes one row per new head, with the minions whose branch tips landed and their stage times', async () => {
  const w = world();
  const repo = join(root, `repo-${dirs}`);
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'base'], Date.now() - 3_600_000);
  const base = git(repo, ['rev-parse', 'HEAD']);
  w.store.setProjectRepoDir(w.citadel.id, repo);
  // A minion created after base whose branch still sits at base: began there, no work of its own.
  const idle = w.minion('Idle');
  git(repo, ['branch', idle.branch, base]);

  w.setHead(base);
  await w.server.live(base);
  let rows = w.store.listReleases(w.citadel.id, CITADEL_TARGET, 10);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].changes), [], 'the first row: nothing to compare with');

  // A lands: tracked through its stages, its rebased tip on main.
  const a = w.minion('Feature A');
  w.store.setSetting('wait-usual', usuals);
  const t0 = now;
  w.land(1, a.branch, now / 1000, 'starting', 0);
  w.waits.poll();
  w.server.read();
  now += 20_000;
  w.land(1, a.branch, now / 1000 - 20, 'waiting for CI since 14:00', 0);
  w.waits.poll();
  w.server.read();
  now += 90_000;
  w.land(1, a.branch, now / 1000 - 110, 'deploying: boot check', 0);
  w.waits.poll();
  w.server.read();
  now += 10_000;
  w.clearLine();
  w.ships.set(a.id, 'deploying');
  w.waits.poll();
  w.server.read();
  git(repo, ['checkout', '-q', '-b', a.branch]);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'A'], Date.now());
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['merge', '-q', '--ff-only', a.branch]);
  const head = git(repo, ['rev-parse', 'HEAD']);

  // A new server (the restart) reads the stage times back from the setting.
  const again = new CitadelServer({ store: w.store, scheme: () => w.store.getProject(w.citadel.id) ?? null, head: () => head, line: () => [], ticketFor: () => null, wait: () => null, ship: () => null, usual: () => null, interruptible: () => 0, now: () => now + 40_000 });
  await Promise.all([again.live(head), again.live(head)]);
  rows = w.store.listReleases(w.citadel.id, CITADEL_TARGET, 10);
  assert.equal(rows.length, 2, 'the same head twice writes one row');
  const row = rows[0];
  assert.equal(row.version, head);
  assert.equal(row.outcome, 'live');
  assert.equal(row.started_at, t0);
  assert.equal(row.live_at, now + 40_000);
  assert.deepEqual(JSON.parse(row.changes).map((c: { ticketId: number }) => c.ticketId), [a.id], 'the idle branch at base is not a change');
  assert.deepEqual(JSON.parse(row.stages), { rebase: 20, test: 90, deploy: 10, restart: 40 });
  assert.equal(w.store.getSetting<Record<string, unknown>>('releases-tracking')?.[a.id], undefined, 'its tracking goes with the row');

  // The reader shows it as current, the first as recent.
  w.setHead(head);
  w.ships.set(a.id, 'live');
  w.waits.poll();
  const [t] = w.server.read();
  assert.equal(t.current!.version, head);
  assert.deepEqual(t.current!.changes, [{ ticketId: a.id, number: a.number, title: 'Feature A' }]);
  assert.deepEqual(t.recent.map((r) => r.version), [base]);
  assert.equal(t.next, null);
});

test('Releases: test copies go to the target whose code they run, else to the scheme; a change is sent once, per scheme', () => {
  const w = world();
  const delve = w.store.createProject('Delve', null);
  const mine = w.minion('Has a preview');
  const theirs = w.store.createTicket({ project_id: delve.id, title: 'Theirs', permission_mode: 'default', created_by: 'Cara' });
  w.store.setSetting(`preview:${mine.id}`, { at: now });
  w.store.setSetting(`preview:${theirs.id}`, { at: now });
  const sent: any[] = [];
  let builds = [7];
  const releases = new Releases({
    store: w.store, readers: [w.server], broadcast: (m) => sent.push(m),
    testCopies: () => previewCopies(w.store, { own: () => w.store.getProject(w.citadel.id) ?? null, running: (k) => (k === 'build-7' ? { commit: 'b7' } : null), builds: () => builds }),
  });
  const all = releases.view(() => true);
  const c = all.find((s) => s.projectId === w.citadel.id)!;
  assert.deepEqual(c.targets[0].testCopies.map((x) => [x.kind, x.path, x.running, x.commit]), [['preview', `preview/${mine.id}/`, false, null], ['build-preview', 'preview/build/7/', true, 'b7']]);
  assert.deepEqual(c.testCopies, []);
  const d = all.find((s) => s.projectId === delve.id)!;
  assert.deepEqual(d.targets, [], 'a scheme with no target still lists its test copies');
  assert.deepEqual(d.testCopies.map((x) => [x.ticketId, x.target]), [[theirs.id, null]]);
  assert.deepEqual(releases.view((id) => id === delve.id).map((s) => s.projectId), [delve.id]);

  releases.poll();
  assert.deepEqual(sent, [], 'the first poll sends nothing: pages ask when they open');
  releases.poll();
  assert.deepEqual(sent, []);
  builds = [];
  releases.poll();
  assert.deepEqual(sent.map((m) => [m.type, m.projectId]), [['releases', w.citadel.id]], "only the scheme whose part changed");
  w.store.deleteSetting(`preview:${theirs.id}`);
  releases.poll();
  assert.deepEqual(sent.at(-1), { type: 'releases', projectId: delve.id, releases: { projectId: delve.id, targets: [], testCopies: [] } }, 'a scheme left with nothing is sent empty');
});

test('memberSchemes: the schemes a person owns or is in, admin or not', () => {
  const w = world();
  const josh = w.store.createUser({ name: 'Josh', login: 'josh', admin: true });
  const other = w.store.createProject('Other', null, josh.id);
  const third = w.store.createProject('Third', null);
  w.store.addMember(w.citadel.id, josh.id);
  assert.deepEqual([...w.store.memberSchemes(josh.id)].sort(), [w.citadel.id, other.id].sort());
  assert.ok(!w.store.memberSchemes(josh.id).has(third.id));
});

test('the releases table: an older database gets it on open, and a row reads back', () => {
  const f = join(root, 'old.db');
  new Store(f).db.close();
  const raw = new DatabaseSync(f);
  raw.exec('DROP TABLE releases');
  raw.close();
  const store = new Store(f);
  const p = store.createProject('P', null);
  store.addRelease({ project_id: p.id, target: 't', version: 'v1', changes: '[]', started_at: null, live_at: 5, outcome: 'live', stages: '{}' });
  store.addRelease({ project_id: p.id, target: 't', version: 'v2', changes: '[]', started_at: 1, live_at: 6, outcome: 'live', stages: '{"deploy":3}' });
  assert.deepEqual(store.listReleases(p.id, 't', 1).map((r) => [r.version, r.stages]), [['v2', '{"deploy":3}']]);
  store.deleteProject(p.id);
  assert.deepEqual(store.listReleases(p.id, 't', 5), [], "a scheme's releases go with it");
});
