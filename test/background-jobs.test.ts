// The background jobs moved out of server.ts (docs/adr/0002-background-jobs-out-of-server.md), tested
// without booting a server: scheduled runs, memory indexing, artifact scans and ship status.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ArtifactScanner } from '../src/artifact-scan.ts';
import type { BranchStatus } from '../src/branch.ts';
import { Store } from '../src/db.ts';
import { MemoryIndexer } from '../src/memory.ts';
import { DEPLOY_FAILURE } from '../src/routes/tickets.ts';
import { ScheduledRuns } from '../src/schedules.ts';
import { PR_TTL_MS, ShipStatus } from '../src/ship-status.ts';
import { projectSharedDir } from '../src/workspace.ts';

const root = mkdtempSync(join(tmpdir(), 'background-jobs-'));
after(() => rmSync(root, { recursive: true, force: true }));
let dbs = 0;
function setup() {
  const store = new Store(join(root, `db-${++dbs}.sqlite`));
  const project = store.createProject(`p${dbs}`, null);
  const sent: object[] = [];
  return { store, project, sent, broadcast: (m: object) => void sent.push(m) };
}
const minion = (store: Store, projectId: number, title = 'work', by = 'Cara') =>
  store.createTicket({ project_id: projectId, title, permission_mode: 'bypassPermissions', created_by: by });

// ---------- scheduled runs ----------

function scheduled() {
  const s = setup();
  const notes: unknown[] = [];
  const sends: { id: number; from: string; text: string }[] = [];
  const made: string[] = [];
  const waits = { limit: new Set<number>(), net: new Set<number>() };
  const runs = new ScheduledRuns({
    store: s.store,
    newMinion: async (project, m, by) => {
      if (m.title === 'broken') throw new Error('no worktree');
      made.push(m.title);
      const t = minion(s.store, project.id, m.title, by);
      return { id: t.id, number: t.number! };
    },
    runner: { emit: (id: number, kind: string, data: unknown) => void notes.push({ id, kind, data }), send: (id: number, from: string, text: string) => void sends.push({ id, from, text }),
      limitWait: (id: number) => (waits.limit.has(id) ? { ticket: id, at: 0, tries: 1 } : null), netWait: (id: number) => (waits.net.has(id) ? { ticket: id, tries: 1 } : null) } as any,
    broadcast: s.broadcast,
    by: 'Citadel',
  });
  return { ...s, runs, notes, sends, made, waits };
}

test('a due schedule starts one minion with its brief, records the run and tells the page', async () => {
  const { store, project, runs, sends, made, sent } = scheduled();
  const now = Date.now();
  const sch = store.schedules.create({ project_id: project.id, name: 'Nightly check', cron: '* * * * *', brief: 'Check the thing.', type: 'chore', created_by: 'Cara' }, now - 120_000);
  await runs.runDue();
  assert.deepEqual(made, ['Nightly check']);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].from, 'Citadel');
  assert.match(sends[0].text, /Check the thing\./);
  const after = store.schedules.get(sch.id)!;
  assert.equal(after.last_ticket_id, sends[0].id);
  assert.ok(after.next_run_at! > now - 1000, 'the next run is in the future');
  assert.ok(sent.some((m: any) => m.type === 'schedules' && m.projectId === project.id));
  // Not due again until its next run.
  assert.ok(!store.schedules.due(after.next_run_at! - 1).some((x) => x.id === sch.id));
});

test('a slot is skipped while the last run still works, and a start that throws is recorded, not thrown', async () => {
  const { store, project, runs, made } = scheduled();
  const busy = minion(store, project.id, 'last run');
  store.updateTicket(busy.id, { status: 'running' });
  const sch = store.schedules.create({ project_id: project.id, name: 'Hourly', cron: '* * * * *', brief: 'b', type: 'chore', created_by: 'Cara' });
  store.schedules.ran(sch.id, { ticketId: busy.id });
  await runs.run(store.schedules.get(sch.id)!);
  assert.deepEqual(made, []);
  assert.match(store.schedules.get(sch.id)!.last_error ?? '', /was still working, so this slot was skipped/);

  const broken = store.schedules.create({ project_id: project.id, name: 'broken', cron: '* * * * *', brief: 'b', type: 'chore', created_by: 'Cara' });
  await runs.run(broken);
  assert.equal(store.schedules.get(broken.id)!.last_error, 'no worktree');
});

test('a slot is skipped while the last run waits on a usage limit or the network, but not once it gave up (C4)', async () => {
  const { store, project, runs, made, waits } = scheduled();
  const last = minion(store, project.id, 'last run');
  // As a limited turn leaves it: status error, state limited, and the runner holding its resume.
  store.updateTicket(last.id, { status: 'error', state: 'limited' });
  const sch = store.schedules.create({ project_id: project.id, name: 'Hourly', cron: '* * * * *', brief: 'b', type: 'chore', created_by: 'Cara' });
  store.schedules.ran(sch.id, { ticketId: last.id });
  waits.limit.add(last.id);
  await runs.run(store.schedules.get(sch.id)!);
  assert.deepEqual(made, [], 'a usage-limit wait is still working');
  assert.match(store.schedules.get(sch.id)!.last_error ?? '', /was still working, so this slot was skipped/);
  waits.limit.clear();
  waits.net.add(last.id);
  await runs.run(store.schedules.get(sch.id)!);
  assert.deepEqual(made, [], 'so is a network wait');
  // Gave up: still state limited, but nothing will resume it, so the schedule carries on.
  waits.net.clear();
  await runs.run(store.schedules.get(sch.id)!);
  assert.deepEqual(made, ['Hourly']);
});

// The activity gate (#745): a due slot spends a minion only when enough happened since the last real run.
const DAY = 86_400_000;
/** A gated schedule made `daysAgo` days back, due now. */
function gated(store: Store, projectId: number, extra: object = {}, daysAgo = 7) {
  const t0 = Date.now() - daysAgo * DAY;
  return store.schedules.create({ project_id: projectId, name: 'Weekly audit', cron: '* * * * *', brief: 'b', type: 'chore', created_by: 'Cara', min_minions: 3, ...extra }, t0);
}
/** A person's minion made at `at`. */
function madeAt(store: Store, projectId: number, at: number) {
  const t = minion(store, projectId);
  store.db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run(at, t.id);
}

test('the activity gate skips a quiet slot at no cost, then runs once enough minions were made since the last real run', async () => {
  const { store, project, runs, made, sends, notes } = scheduled();
  const sch = gated(store, project.id);
  minion(store, project.id);
  minion(store, project.id);
  const now = Date.now();
  await runs.run(store.schedules.get(sch.id)!, now);
  let s = store.schedules.get(sch.id)!;
  assert.deepEqual([made, sends.length, notes.length], [[], 0, 0], 'no minion, no brief, no note');
  assert.deepEqual([s.last_run_at, s.last_ticket_id], [null, null]);
  assert.ok(s.next_run_at! > now, 'the next slot counts from now');
  assert.match(s.last_skip ?? '', /^Skipped .+ P[SD]T: 2 minions since .+ \(needs 3\)$/);
  assert.equal(s.last_error, null, 'a skip is not a failure');

  // The third minion reaches the threshold: it runs, clears the skip, and its brief carries the window.
  minion(store, project.id);
  await runs.run(store.schedules.get(sch.id)!, now + 60_000);
  s = store.schedules.get(sch.id)!;
  assert.deepEqual(made, ['Weekly audit']);
  assert.deepEqual([s.last_skip, s.last_run_at], [null, now + 60_000]);
  assert.match(sends[0].text, /\nLast real run: never \(scheduled .+ P[SD]T\); since then 3 minions in this scheme\.\n/);

  // The next window opens at that run: a skip later doesn't move it, so minions made before the skip still count.
  madeAt(store, project.id, now + 90_000);
  await runs.run(store.schedules.get(sch.id)!, now + 120_000);
  assert.match(store.schedules.get(sch.id)!.last_skip ?? '', /: 1 minion since/);
  assert.equal(store.schedules.get(sch.id)!.last_run_at, now + 60_000, 'a skip leaves the last real run');
  madeAt(store, project.id, now + 150_000);
  madeAt(store, project.id, now + 160_000);
  await runs.run(store.schedules.get(sch.id)!, now + 180_000);
  assert.deepEqual(made, ['Weekly audit', 'Weekly audit'], 'the minion from before the skip counts toward the run after it');
  assert.match(sends[1].text, new RegExp(`Last real run: .+ P[SD]T \\(#${store.getTicket(s.last_ticket_id!)!.number}\\); since then 3 minions in this scheme`));
});

test("the gate doesn't count Taskmasters or minions Citadel started, and counts other schemes only with gate_scope all", async () => {
  const { store, project, runs, made } = scheduled();
  const other = store.createProject('elsewhere', null);
  for (const p of [project.id, other.id]) store.createTicket({ project_id: p, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  for (let i = 0; i < 3; i++) {
    minion(store, project.id, 'scheduled run', 'Citadel');
    minion(store, other.id);
  }
  const own = gated(store, project.id, { min_minions: 1 });
  await runs.run(own);
  assert.deepEqual(made, []);
  assert.match(store.schedules.get(own.id)!.last_skip ?? '', /: 0 minions since/);
  const sweep = gated(store, project.id, { gate_scope: 'all' });
  // 3 minions elsewhere, not 4 or 5: neither Taskmaster counts.
  await runs.run(gated(store, project.id, { gate_scope: 'all', min_minions: 4 }));
  assert.deepEqual(made, []);
  await runs.run(sweep);
  assert.deepEqual(made, ['Weekly audit'], "the other scheme's three minions count for a sweep");
});

test('a schedule with no gate runs as before, and a one-off pauses after its real run but not after a skip', async () => {
  const { store, project, runs, made } = scheduled();
  await runs.run(gated(store, project.id, { min_minions: null }));
  assert.deepEqual(made, ['Weekly audit'], 'no gate, no count needed');

  const once = gated(store, project.id, { once: true, name: 'Read-back' }, 0.001);
  await runs.run(store.schedules.get(once.id)!);
  let s = store.schedules.get(once.id)!;
  assert.deepEqual([s.paused, s.last_skip != null], [0, true], 'a skip is not its run');
  assert.ok(s.next_run_at);
  for (let i = 0; i < 3; i++) minion(store, project.id);
  await runs.run(s);
  s = store.schedules.get(once.id)!;
  assert.deepEqual([made.at(-1), s.paused, s.next_run_at], ['Read-back', 1, null]);
  assert.ok(s.last_ticket_id, 'its last run stays visible');
});

test("a run's turns are its maker's while they're around, and the owner's (nobody's) once they're disabled or gone (C3)", async () => {
  const { store, project, runs, sends } = scheduled();
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const sch = store.schedules.create({ project_id: project.id, name: 'Nightly', cron: '* * * * *', brief: 'b', type: 'chore', created_by: 'Josh' });
  await runs.run(sch);
  assert.equal(store.getTicket(sends[0].id)!.person_id, josh.id);
  store.updateUser(josh.id, { disabled_at: Date.now() });
  await runs.run(store.schedules.get(sch.id)!);
  assert.equal(store.getTicket(sends[1].id)!.person_id, null, 'a disabled maker would have the brief refused');
});

test('runDue does not start a second pass while one is running', async () => {
  const { store, project } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let starts = 0;
  const runs = new ScheduledRuns({
    store,
    newMinion: async (p) => {
      starts++;
      await gate;
      const t = minion(store, p.id);
      return { id: t.id, number: t.number! };
    },
    runner: { emit() {}, send() {} } as any,
    broadcast() {},
    by: 'Citadel',
  });
  store.schedules.create({ project_id: project.id, name: 'slow', cron: '* * * * *', brief: 'b', type: 'chore', created_by: 'Cara' }, Date.now() - 120_000);
  const first = runs.runDue();
  await new Promise((r) => setImmediate(r));
  await runs.runDue(); // returns at once: the first pass holds the flag
  release();
  await first;
  assert.equal(starts, 1);
});

// ---------- memory indexing ----------

test('memory indexing drains each indexed scheme, skips the rest, and logs an outage once', async () => {
  const calls: number[] = [];
  let left = 3;
  let fail = false;
  const store = {
    listProjects: () => [{ id: 1 }, { id: 2 }],
    memory: { index: async (id: number) => { if (fail) throw new Error('down'); calls.push(id); return left-- > 0 ? 1 : 0; } },
  };
  const indexer = new MemoryIndexer(store as any, async () => [], 'model', (id) => id === 1);
  await indexer.run();
  assert.deepEqual(calls, [1, 1, 1, 1], 'scheme 1 until nothing is left; scheme 2 never');

  const errors: unknown[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    fail = true;
    await indexer.run();
    await indexer.run();
  } finally {
    console.error = was;
  }
  assert.equal(errors.length, 1, 'one line per outage, not one per minute');
});

test('one scheme that fails sits out the pass without stopping the others (#488)', async () => {
  const calls: number[] = [];
  let left = 2;
  const store = {
    listProjects: () => [{ id: 1 }, { id: 2 }],
    memory: { index: async (id: number) => { calls.push(id); if (id === 1) throw new Error('refused'); return left-- > 0 ? 1 : 0; } },
  };
  const was = console.error;
  console.error = () => {};
  try {
    await new MemoryIndexer(store as any, async () => [], 'model', () => true).run();
  } finally {
    console.error = was;
  }
  assert.deepEqual(calls, [1, 2, 2, 2], 'scheme 1 is tried once; scheme 2 drains');
});

// ---------- artifact scans ----------

function reply(store: Store, ticketId: number, text: string) {
  store.addEvent(ticketId, 'claude', { type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

test('a scan lists only the files a reply linked, and the shared folder broadcasts only after its first look', async () => {
  const { store, project, sent, broadcast } = setup();
  const dataDir = join(root, `data-${dbs}`);
  const cwd = join(root, `cwd-${dbs}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'report.md'), '# Report');
  writeFileSync(join(cwd, 'scratch.md'), '# Scratch');
  const t = minion(store, project.id);
  store.setTicketDir(t.id, cwd, null);
  const scanner = new ArtifactScanner(store, dataDir, broadcast, 0);
  assert.equal(scanner.sharedDir(store.getTicket(t.id)!), join(dataDir, 'projects', String(project.id), 'shared', String(t.id)));

  reply(store, t.id, `Here it is: [the report](${join(cwd, 'report.md')})`);
  await scanner.scan(t.id);
  assert.deepEqual(store.listArtifacts(project.id).map((a) => a.path), ['report.md']);
  assert.equal(sent.filter((m: any) => m.type === 'artifacts').length, 1, 'the new artifact, not the first shared-folder look');

  sent.length = 0;
  const shared = projectSharedDir(dataDir, project.id);
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, 'spec.md'), '# Spec');
  await scanner.scan(t.id);
  assert.deepEqual(sent, [{ type: 'artifacts', projectId: project.id }], 'a change in the shared folder tells open pages');
  assert.deepEqual((await scanner.sharedFiles(project.id)).map((f) => f.path), ['spec.md']);
});

test('a scan reads only the replies since the last one, a page at a time, and keeps what earlier ones linked (#609)', async () => {
  const { store, project, broadcast } = setup();
  const cwd = join(root, `cwd-${dbs}`);
  mkdirSync(cwd, { recursive: true });
  for (const f of ['a.md', 'b.md', 'c.md']) writeFileSync(join(cwd, f), `# ${f}`);
  const t = minion(store, project.id);
  store.setTicketDir(t.id, cwd, null);
  const scanner = new ArtifactScanner(store, join(root, `data-${dbs}`), broadcast, 0);
  reply(store, t.id, `[a](${join(cwd, 'a.md')})`);
  for (let i = 0; i < 450; i++) reply(store, t.id, `step ${i}, no link`); // past two pages
  reply(store, t.id, `[b](${join(cwd, 'b.md')})`);
  const reads: number[] = [];
  const read = store.replyTexts.bind(store);
  store.replyTexts = (id, after, limit) => {
    reads.push(after ?? 0);
    return read(id, after, limit);
  };
  await scanner.scan(t.id);
  assert.deepEqual(store.listArtifacts(project.id).map((a) => a.path).sort(), ['a.md', 'b.md']);
  assert.equal(reads.length, 3, `452 events read 200 at a time: ${reads}`);
  reads.length = 0;
  reply(store, t.id, `[c](${join(cwd, 'c.md')})`);
  await scanner.scan(t.id);
  assert.deepEqual(store.listArtifacts(project.id).map((a) => a.path).sort(), ['a.md', 'b.md', 'c.md'], 'the earlier links stay');
  assert.equal(reads.length, 1);
  assert.ok(reads[0] > 0, 'it starts after the last event read');
});

test('scans of one minion run one at a time, and schedule() coalesces calls within its delay', async () => {
  const { store, project } = setup();
  const cwd = join(root, `cwd-${dbs}`);
  mkdirSync(cwd, { recursive: true });
  const t = minion(store, project.id);
  store.setTicketDir(t.id, cwd, null);
  // A scan reads the ticket first and syncs its rows after the awaits: count scans between the two.
  let inside = 0;
  let most = 0;
  const get = store.getTicket.bind(store);
  store.getTicket = (id) => {
    most = Math.max(most, ++inside);
    return get(id);
  };
  const sync = store.syncArtifacts.bind(store);
  store.syncArtifacts = (ticket, found) => {
    inside--;
    return sync(ticket, found);
  };
  const scanner = new ArtifactScanner(store, join(root, `data-${dbs}`), () => {}, 0);
  await Promise.all([scanner.scan(t.id), scanner.scan(t.id), scanner.scan(t.id)]);
  assert.equal(most, 1);

  let scans = 0;
  scanner.scan = async () => void scans++;
  scanner.schedule(t.id);
  scanner.schedule(t.id);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(scans, 1);
});

// ---------- ship status ----------

const merged = (live: boolean): BranchStatus => ({
  branch: 'ticket/1-x', tip: 'abcdef1234', base: 'main', ahead: 0, merged: true, empty: false, pr: null, deploy: { pulled: true, live },
});

function ships() {
  const s = setup();
  s.store.setProjectRepoDir(s.project.id, '/repo');
  const t = minion(s.store, s.project.id);
  s.store.setTicketDir(t.id, '/repo/wt', 'ticket/1-x');
  const lookups: boolean[] = [];
  const worktrees: (string | null | undefined)[] = [];
  const rows: number[] = [];
  let next: BranchStatus = { ...merged(false), merged: false, ahead: 2, deploy: null };
  const ship = new ShipStatus({
    store: s.store,
    runner: { interruptible: () => 0, broadcastTicket: (id: number) => void rows.push(id), isRunning: () => false } as any,
    broadcast: s.broadcast,
    liveHead: () => 'head1',
    checkoutDir: '/checkout',
    status: async (_repo, _branch, _at, withPr, _live, _build, worktree) => {
      lookups.push(withPr);
      worktrees.push(worktree);
      return structuredClone(next);
    },
    delayMs: 0,
  });
  return { ...s, t, ship, lookups, worktrees, rows, set: (b: BranchStatus) => (next = b) };
}

test('ship status re-sends a minion only when its line changes, and looks up the PR at most once a minute', async () => {
  const { t, ship, lookups, rows, sent, set } = ships();
  await ship.branch(t.id);
  assert.equal(ship.ship(t.id)?.stage, 'branch');
  assert.deepEqual(rows, [t.id]);
  await ship.branch(t.id);
  assert.deepEqual(rows, [t.id], 'same line: no re-send');
  assert.deepEqual(lookups, [true, false], 'the PR is cached for PR_TTL_MS');
  assert.equal(sent.filter((m: any) => m.type === 'branch').length, 0);

  set(merged(false));
  await ship.branch(t.id, 0);
  assert.deepEqual(lookups, [true, false, true], 'maxPrAge 0 looks again');
  assert.equal(ship.ship(t.id)?.stage, 'deploying');
  assert.equal(rows.length, 2);
  assert.equal(sent.filter((m: any) => m.type === 'branch').length, 1, 'a changed status is broadcast');
  assert.ok(PR_TTL_MS >= 60_000);
});

// #632: uncommitted work in its worktree takes a live minion back to its branch, so the read looks there.
test("ship status reads the minion's worktree, and a live line goes back to its branch while it has uncommitted work", async () => {
  const { t, ship, worktrees, rows, set } = ships();
  set(merged(true));
  await ship.branch(t.id);
  assert.deepEqual(worktrees, ['/repo/wt']);
  assert.equal(ship.ship(t.id)?.stage, 'live');
  set({ ...merged(true), uncommitted: 2 });
  await ship.branch(t.id);
  assert.equal(ship.ship(t.id)?.stage, 'branch');
  assert.equal(rows.length, 2, 'the row is re-sent');
});

test('the poll re-reads only merged work that is not live, and a failed deploy shows while the server runs its head', async () => {
  const { store, t, ship, lookups, set } = ships();
  set(merged(false));
  await ship.branch(t.id);
  const before = lookups.length;
  await ship.poll();
  assert.equal(lookups.length, before + 1, 'merged, not live: looked at again');

  set(merged(true));
  await ship.poll();
  assert.equal(ship.ship(t.id)?.stage, 'live');
  const settled = lookups.length;
  await ship.poll();
  assert.equal(lookups.length, settled, 'live: no git');

  set(merged(false));
  await ship.branch(t.id);
  store.setSetting(DEPLOY_FAILURE, { text: 'boot check failed', head: 'head1' });
  assert.equal(ship.ship(t.id)?.stage, 'failed');
  store.setSetting(DEPLOY_FAILURE, { text: 'old', head: 'other' });
  assert.notEqual(ship.ship(t.id)?.stage, 'failed');
});

// Build branches (#592): a feeder folded into its build closes then, so the poll keeps reading it until the build lands.
test('the poll re-reads a dismissed feeder folded into its build until its chip turns live', async () => {
  const { store, t, ship, lookups, set } = ships();
  set({ ...merged(false), merged: false, deploy: null, build: { n: 7, merged: true, ahead: 0 } });
  await ship.branch(t.id);
  assert.equal(ship.ship(t.id)?.stage, 'build');
  store.updateTicket(t.id, { status: 'closed' });
  const before = lookups.length;
  set({ ...merged(true), build: { n: 7, merged: true, ahead: 0 } });
  await ship.poll();
  assert.equal(lookups.length, before + 1, 'folded and dismissed: looked at again');
  assert.equal(ship.ship(t.id)?.stage, 'live');
  await ship.poll();
  assert.equal(lookups.length, before + 1, 'live and dismissed: left alone');
});

test('a check after a turn looks up the PR again unless the minion is still running', async () => {
  const { t, ship, lookups } = ships();
  await ship.branch(t.id);
  let running = true;
  (ship as any).d.runner.isRunning = () => running;
  ship.scheduleCheck(t.id);
  ship.scheduleCheck(t.id); // coalesced
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(lookups, [true, false], 'running: the cached PR stands');
  running = false;
  ship.scheduleCheck(t.id);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(lookups, [true, false, true], 'turn over: the PR is looked up now');
});

test('the startup sweep looks at open minions with a branch only', async () => {
  const { store, project, t, ship, lookups } = ships();
  const closed = minion(store, project.id, 'done');
  store.setTicketDir(closed.id, '/repo/wt2', 'ticket/2-y');
  store.updateTicket(closed.id, { status: 'closed' });
  minion(store, project.id, 'no branch');
  await ship.sweep();
  assert.equal(lookups.length, 1);
  assert.ok(ship.ship(t.id));
});
