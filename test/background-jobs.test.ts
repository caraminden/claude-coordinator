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
const minion = (store: Store, projectId: number, title = 'work') =>
  store.createTicket({ project_id: projectId, title, permission_mode: 'bypassPermissions', created_by: 'Cara' });

// ---------- scheduled runs ----------

function scheduled() {
  const s = setup();
  const notes: unknown[] = [];
  const sends: { id: number; from: string; text: string }[] = [];
  const made: string[] = [];
  const runs = new ScheduledRuns({
    store: s.store,
    newMinion: async (project, m) => {
      if (m.title === 'broken') throw new Error('no worktree');
      made.push(m.title);
      const t = minion(s.store, project.id, m.title);
      return { id: t.id, number: t.number! };
    },
    runner: { emit: (id: number, kind: string, data: unknown) => void notes.push({ id, kind, data }), send: (id: number, from: string, text: string) => void sends.push({ id, from, text }) } as any,
    broadcast: s.broadcast,
    by: 'Citadel',
  });
  return { ...s, runs, notes, sends, made };
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
  // Not due again this minute: a second pass starts nothing.
  await runs.runDue();
  assert.equal(made.length, 1);
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
  const rows: number[] = [];
  let next: BranchStatus = { ...merged(false), merged: false, ahead: 2, deploy: null };
  const ship = new ShipStatus({
    store: s.store,
    runner: { interruptible: () => 0, broadcastTicket: (id: number) => void rows.push(id), isRunning: () => false } as any,
    broadcast: s.broadcast,
    liveHead: () => 'head1',
    checkoutDir: '/checkout',
    status: async (_repo, _branch, _at, withPr) => {
      lookups.push(withPr);
      return structuredClone(next);
    },
    delayMs: 0,
  });
  return { ...s, t, ship, lookups, rows, set: (b: BranchStatus) => (next = b) };
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
