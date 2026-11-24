// The standing checks (#1415, src/standing-checks.ts): each check sees its broken promise built in a scratch store, a
// clean store gives no findings, and a run confirms, keeps and rows them once.
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { CHECKS, HEALTH_KIND, integrityDue, keptChecks, runChecks, StandingChecks, standingStatus, type Snapshot } from '../src/standing-checks.ts';

const root = mkdtempSync(join(tmpdir(), 'standing-checks-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const NOW = Date.now();
const MIN = 60_000;

function setup() {
  const dataDir = join(root, `data-${++n}`);
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(dataDir, 'db.sqlite'));
  const project = store.createProject(`p${n}`, null);
  const minion = (title = 'work') => store.createTicket({ project_id: project.id, title, permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const sql = (q: string, ...args: (string | number | null)[]) => store.db.prepare(q).run(...args);
  return { store, project, dataDir, minion, sql };
}
const snap = (s: Partial<Snapshot> = {}): Snapshot => ({ at: NOW, queued: {}, appTurns: [], procs: [], ...s });
const check = (store: Store, dataDir: string, s: Partial<Snapshot> = {}, integrity = false) => runChecks({ db: store.db, dataDir, now: NOW, snap: snap(s), integrity });
const only = (found: { check: string }[], name: string) => found.filter((f) => f.check === name);

test('the named list holds the eight checks', () => {
  assert.deepEqual(
    CHECKS.map((c) => c.name),
    ['turn-record', 'one-place', 'fired-once', 'handoff-process', 'shipped-live', 'app-turn-ended', 'closed-processes', 'db-integrity'],
  );
});

test('a clean store gives no findings, the weekly integrity check included', () => {
  const { store, dataDir, minion } = setup();
  const t = minion();
  store.addEvent(t.id, 'user_message', { author: 'Cara', text: 'hi' });
  assert.deepEqual(check(store, dataDir, {}, true), []);
});

test('1: a running minion with no turn record, or a gone folder, is named', () => {
  const { store, dataDir, minion } = setup();
  const [a, b, c] = [minion('a'), minion('b'), minion('c')];
  for (const t of [a, b, c]) store.updateTicket(t.id, { status: 'running' });
  const dir = join(dataDir, 'turn-c');
  mkdirSync(dir);
  store.setSetting(`turn:${b.id}`, { resumes: 0, dir: join(dataDir, 'gone') });
  store.setSetting(`turn:${c.id}`, { resumes: 0, dir });
  const found = only(check(store, dataDir), 'turn-record');
  assert.deepEqual(found.map((f) => f.ticket).sort(), [a.id, b.id].sort());
  assert.match(found.find((f) => f.ticket === a.id)!.text, /^#\d+ \(p\d+\) shows running but has no turn record\.$/);
});

test('2: a message queued twice, and a delivery the runner keeps losing, are named', () => {
  const { store, project, dataDir, minion, sql } = setup();
  const t = minion();
  const d = store.addDelivery({ project_id: project.id, kind: 'wake_at', to_kind: 'minion', to_id: t.id, when_kind: 'at', set_by: 'minion:1', due: NOW + 5 * MIN });
  sql('UPDATE deliveries SET attempts = 3, last_error = ? WHERE id = ?', 'the runner dropped it before its turn started', d.id);
  const found = only(check(store, dataDir, { queued: { [t.id]: [7, 8, 7] } }), 'one-place');
  assert.equal(found.length, 2);
  assert.match(found[0].text, /message 7 waits 2 times/);
  assert.match(found[1].text, new RegExp(`delivery #${d.id} was handed to the runner and lost before its turn started, 3 times`));
  // Once each, and one lost send, is normal.
  sql('UPDATE deliveries SET attempts = 1 WHERE id = ?', d.id);
  assert.deepEqual(only(check(store, dataDir, { queued: { [t.id]: [7, 8] } }), 'one-place'), []);
});

test('3: a due wake not fired, one given up on, one fired twice, and a schedule late or twice, are named', () => {
  const { store, project, dataDir, minion, sql } = setup();
  const t = minion();
  const late = store.addDelivery({ project_id: project.id, kind: 'wake_at', to_kind: 'minion', to_id: t.id, when_kind: 'at', set_by: 'x', due: NOW - 20 * MIN });
  store.addDelivery({ project_id: project.id, kind: 'wake_at', to_kind: 'minion', to_id: t.id, when_kind: 'at', set_by: 'x', due: NOW - 5 * MIN }); // late, not that late
  const failed = store.addDelivery({ project_id: project.id, kind: 'wake_at', to_kind: 'minion', to_id: t.id, when_kind: 'at', set_by: 'x', state: 'failed' }, NOW - MIN);
  const twice = store.addDelivery({ project_id: project.id, kind: 'wake_at', to_kind: 'minion', to_id: t.id, when_kind: 'at', set_by: 'x', state: 'sent' }, NOW - 2 * 3600_000);
  const once = store.addDelivery({ project_id: project.id, kind: 'wake_at', to_kind: 'minion', to_id: t.id, when_kind: 'at', set_by: 'x', state: 'sent' }, NOW - 2 * 3600_000);
  for (const text of [`wake\n\n(delivery #${twice.id})`, `wake\n\n(delivery #${twice.id})`, `wake\n\n(delivery #${once.id})`, `wake\n\n(The server restarted while sending this, so it may repeat delivery #${once.id}.)`]) {
    store.addEvent(t.id, 'user_message', { author: 'Citadel', text });
  }
  const s = store.schedules.create({ project_id: project.id, name: 'Nightly', cron: '0 3 * * *', brief: 'b', type: 'chore', created_by: 'Cara' }, NOW);
  sql('UPDATE schedules SET next_run_at = ? WHERE id = ?', NOW - 30 * MIN, s.id);
  // A start that crashed before its slot was marked has no brief; its retry is the second minion (schedules.ts).
  const [x, y] = [minion('Nightly'), minion('Nightly')];
  store.addEvent(y.id, 'user_message', { author: 'Cara', text: 'brief', schedule: 'Nightly' });
  sql('UPDATE tickets SET created_at = ? WHERE id = ?', NOW - 3 * MIN, x.id);
  // A start that failed moved next_run_at on: the missed slot is only in last_error.
  const f = store.schedules.create({ project_id: project.id, name: 'Weekly', cron: '0 4 * * 1', brief: 'b', type: 'chore', created_by: 'Cara' }, NOW);
  sql('UPDATE schedules SET last_error = ?, next_run_at = ? WHERE id = ?', 'its template is gone', NOW + 3600_000, f.id);
  // Every 5 minutes: two minions 5 minutes apart are two slots.
  store.schedules.create({ project_id: project.id, name: 'Pulse', cron: '*/5 * * * *', brief: 'b', type: 'chore', created_by: 'Cara' }, NOW);
  const [p1, p2] = [minion('Pulse'), minion('Pulse')];
  sql('UPDATE tickets SET created_at = ? WHERE id = ?', NOW - 6 * MIN, p1.id);
  sql('UPDATE tickets SET created_at = ? WHERE id = ?', NOW - MIN, p2.id);
  const found = only(check(store, dataDir), 'fired-once').map((f) => f.text);
  assert.equal(found.length, 6, found.join('\n'));
  assert.match(found[0], new RegExp(`delivery #${late.id} \\(wake_at\\) was due 20 min ago and is still waiting`));
  assert.match(found[1], new RegExp(`delivery #${failed.id} \\(wake_at\\) never arrived`));
  assert.match(found[2], new RegExp(`delivery #${twice.id} arrived 2 times`));
  assert.match(found[3], /The schedule "Nightly" \(p\d+\) was due 30 min ago and hasn't run/);
  assert.match(found[4], /The schedule "Weekly" \(p\d+\): its last slot didn't start \(its template is gone\)/);
  assert.match(found[5], /The schedule "Nightly" started #\d+ \(p\d+\) and #\d+ \(p\d+\) 3 min apart: one slot fired twice/);
});

test('4: a hand-off with no ship process, or a result never reported, is named', () => {
  const { store, dataDir, minion } = setup();
  const [a, b, c] = [minion('a'), minion('b'), minion('c')];
  const dir = (t: { id: number }) => join(dataDir, 'run', 'landings', String(t.id));
  for (const t of [a, b, c]) {
    mkdirSync(dir(t), { recursive: true });
    writeFileSync(join(dir(t), 'handoff.json'), '{}');
  }
  writeFileSync(join(dir(a), 'started'), String(NOW - 10 * MIN));
  writeFileSync(join(dir(a), 'pid'), '999999999'); // no such process
  writeFileSync(join(dir(b), 'code'), '0');
  utimesSync(join(dir(b), 'code'), new Date(NOW - 20 * MIN), new Date(NOW - 20 * MIN));
  writeFileSync(join(dir(c), 'started'), String(NOW - 10_000)); // still starting
  const found = only(check(store, dataDir), 'handoff-process');
  assert.deepEqual(
    found.map((f) => f.ticket),
    [a.id, b.id],
  );
  assert.match(found[0].text, /no ship process runs and none has ended/);
  assert.match(found[1].text, /its ship ended 20 min ago and was never reported/);
});

test('5: "shipped, not live yet" for over an hour with nothing said is named', () => {
  const { store, dataDir, minion, sql } = setup();
  const [old, fresh, chatty, told] = [minion('old'), minion('fresh'), minion('chatty'), minion('told')];
  for (const t of [old, fresh, chatty, told]) {
    store.updateTicket(t.id, { state: 'pending-deploy' });
    store.addEvent(t.id, 'note', { text: 'Shipped abc.' });
  }
  sql('UPDATE events SET created_at = ? WHERE ticket_id IN (?, ?, ?)', NOW - 2 * 3600_000, old.id, chatty.id, told.id);
  // Talk after the ship doesn't reset its clock; Runner.deployLive's note says it went live and why it stays open.
  store.addEvent(chatty.id, 'user_message', { author: 'Cara', text: 'how is it going?' });
  store.addEvent(told.id, 'note', { text: 'The deploy is live, but a question card is still open, so this minion stays open.' });
  const found = only(check(store, dataDir), 'shipped-live');
  assert.deepEqual(
    found.map((f) => f.ticket),
    [old.id, chatty.id],
  );
  assert.match(found[0].text, /has waited 120 min for its ship to go live/);
});

test('6: an app turn row left open with no process is named', () => {
  const { store, project, dataDir } = setup();
  const user = store.createUser({ name: 'Cara', login: `cara${n}` });
  const app = store.createContraption({ name: `voice${n}`, title: 'Voice', icon: null, port: 9100 + n, home_scheme: project.id, open_paths: '[]', relay_paths: '[]', repo: null, branch: null, folder: null, default_model: null, turn_cap: null, identity_public: 'x', identity_private: 'x', key_hash: `h${n}`, keys_at: 0 });
  const [gone, live, young] = [store.startContraptionTurn(app.id, user.id, 'a'), store.startContraptionTurn(app.id, user.id, 'b'), store.startContraptionTurn(app.id, user.id, 'c')];
  store.db.prepare('UPDATE contraption_turns SET started_at = ? WHERE id IN (?, ?)').run(NOW - 5 * MIN, gone, live);
  store.db.prepare('UPDATE contraption_turns SET started_at = ? WHERE id = ?').run(NOW - 10_000, young);
  const found = only(check(store, dataDir, { appTurns: [live] }), 'app-turn-ended');
  assert.deepEqual(
    found.map((f) => f.key),
    [`app-turn-ended:${gone}`],
  );
  assert.match(found[0].text, new RegExp(`App turn ${gone} \\(voice${n}\\) is still open, but no process runs it`));
});

test("7: a process in a closed minion's folders is named; an open minion's is not", () => {
  const { store, project, dataDir, minion } = setup();
  const [closed, open] = [minion('closed'), minion('open')];
  store.updateTicket(closed.id, { status: 'closed' });
  const procs = [
    { pid: 4242, ticketId: closed.id, projectId: project.id, command: 'npm run dev' },
    { pid: 4343, ticketId: open.id, projectId: project.id, command: 'vite' },
  ];
  const found = only(check(store, dataDir, { procs }), 'closed-processes');
  assert.equal(found.length, 1);
  assert.match(found[0].text, /is closed, but pid 4242 still runs in its folders: npm run dev/);
});

test('8: a database that fails quick_check is named, only on an integrity pass', () => {
  const file = join(root, 'broken.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = DELETE; CREATE TABLE t (a TEXT); CREATE INDEX t_a ON t(a);');
  const ins = db.prepare('INSERT INTO t VALUES (?)');
  db.exec('BEGIN'); // one commit, not 2,000 fsyncs (17 s on btrfs)
  for (let i = 0; i < 2000; i++) ins.run(`row ${i} ${'x'.repeat(50)}`);
  db.exec('COMMIT');
  db.close();
  // Scribble over a page in the middle: the table and its index no longer agree.
  const fd = openSync(file, 'r+');
  writeSync(fd, Buffer.alloc(3000, 0x41), 0, 3000, 4096 * 20 + 100);
  closeSync(fd);
  const broken = new DatabaseSync(file, { readOnly: true });
  const c = CHECKS.find((x) => x.name === 'db-integrity')!;
  const env = { db: broken, dataDir: root, now: NOW, snap: snap(), integrity: true };
  let found: { check: string; text: string }[];
  try {
    found = c.run(env, String);
  } catch (err) {
    found = [{ check: 'db-integrity', text: String(err) }];
  }
  assert.equal(found.length, 1);
  assert.match(found[0].text, /quick_check|malformed/);
  assert.deepEqual(c.run({ ...env, integrity: false }, String), []);
  broken.close();
});

test('the integrity check is due at night Pacific, weekly', () => {
  const at = (iso: string) => Date.parse(iso);
  assert.equal(integrityDue(at('2026-11-20T03:30:00-08:00'), null), true);
  assert.equal(integrityDue(at('2026-11-20T12:00:00-08:00'), null), false);
  assert.equal(integrityDue(at('2026-11-20T03:30:00-08:00'), at('2026-11-19T03:30:00-08:00')), false);
  assert.equal(integrityDue(at('2026-11-20T04:30:00-08:00'), at('2026-11-13T03:30:00-08:00')), true);
});

test('a run confirms in a worker, writes one health row per broken promise, keeps it once and drops it when fixed', async () => {
  const { store, dataDir, minion, sql } = setup();
  const t = minion();
  store.updateTicket(t.id, { state: 'pending-deploy' });
  store.addEvent(t.id, 'note', { text: 'Shipped abc.' });
  sql('UPDATE events SET created_at = ? WHERE ticket_id = ?', NOW - 2 * 3600_000, t.id);
  // A message queued twice in the first pass only: a turn in flight, not a broken promise.
  let calls = 0;
  const checks = new StandingChecks({ store, dataDir, commit: 'abc', queued: () => (++calls === 1 ? { [t.id]: [5, 5] } : {}), appTurns: () => [], procs: async () => [], now: () => NOW + 1, wait: async () => {} });
  const rows = () => store.healthEventsSince([HEALTH_KIND], 0);
  await checks.run();
  await checks.settled();
  assert.deepEqual(
    keptChecks(store)!.findings.map((f) => f.check),
    ['shipped-live'],
  );
  assert.equal(rows().length, 1);
  assert.match(rows()[0].detail, /^shipped-live\n#\d+ \(p\d+\) has waited/);
  await checks.run();
  await checks.settled();
  assert.equal(rows().length, 1, 'a promise still broken is one row');
  assert.equal(keptChecks(store)!.findings[0].since, NOW + 1);
  store.updateTicket(t.id, { state: null });
  await checks.run();
  await checks.settled();
  assert.deepEqual(keptChecks(store)!.findings, []);
  assert.equal(keptChecks(store)!.error, null);
});

test("the Status tile shows a viewer only their schemes' findings, and Citadel's own only in Citadel's (ADR 0015)", () => {
  const { store, project, minion } = setup();
  const other = store.createProject(`other${n}`, null);
  const mine = minion('mine');
  const theirs = store.createTicket({ project_id: other.id, title: 'theirs', permission_mode: 'bypassPermissions', created_by: 'Josh' });
  const f = (check: string, ticket: number | null, projectId?: number) => ({ check, key: `${check}:${ticket}:${projectId}`, ticket, project: projectId ?? null, text: check, since: NOW });
  store.setSetting('standing-checks', { ranAt: NOW, integrityAt: null, error: 'boom', findings: [f('shipped-live', mine.id), f('shipped-live', theirs.id), f('fired-once', null, other.id), f('db-integrity', null)] });
  const seen = (citadel: boolean) => standingStatus(store, (id) => id === project.id, citadel).last!;
  assert.deepEqual(
    seen(false).findings.map((x) => x.ticket),
    [mine.id],
  );
  assert.equal(seen(false).error, null);
  assert.deepEqual(
    seen(true).findings.map((x) => x.check),
    ['shipped-live', 'db-integrity'],
  );
  assert.equal(seen(true).error, 'boom');
});
