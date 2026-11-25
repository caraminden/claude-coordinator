import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { DEFAULT_SETTINGS, MachineJobs, type JobKind } from '../src/machine-jobs.ts';
import type { AgentJobMessage } from '../src/machine-jobs.ts';
import { tempRoot } from './helpers.ts';

// Where a job's state on the server and on its machine could part (#1956, 2MA3 to 2MA9), with the server's queue alone.
const tmp = tempRoot('machine-jobs-state');
const stores: Store[] = [];
after(async () => {
  for (const s of stores) s.db.close();
  await tmp.teardown();
});
let n = 0;
function world() {
  const dir = tmp.path(`w${n++}`);
  mkdirSync(dir);
  const store = new Store(join(dir, 'coordinator.db'));
  stores.push(store);
  const owner = store.createUser({ name: 'Owner', login: 'owner' });
  const who = { uid: owner.id, name: 'Owner', admin: false };
  const p = store.createProject('U', null, owner.id);
  const box = store.createMachine('gpu-box', 'x', 'Owner', owner.id).id;
  store.updateMachine(box, { jobs: JSON.stringify({ folders: [], max_limit_h: 12, max_disk_gb: null, gpu: true }) });
  const clock = { t: Date.now() };
  const sent: AgentJobMessage[] = [];
  const woke: string[] = [];
  const cards: object[] = [];
  const settled: string[] = [];
  const jobs = new MachineJobs({
    store,
    send: (_m, msg) => (sent.push(msg), true),
    online: () => true,
    broadcast() {},
    postCard: (_j, c) => (cards.push(c), { ticket: 1, question: `q${cards.length}` }),
    settleCard: (_c, _by, text) => void settled.push(text),
    wake: (_t, text) => void woke.push(text),
    note() {},
    resultsDir: (j) => join(dir, 'jobs', String(j.id)),
    now: () => clock.t,
  });
  const ticket = store.createTicket({ project_id: p.id, title: 'asker', permission_mode: 'default', created_by: 'owner' } as Parameters<Store['createTicket']>[0]).id;
  const m = () => store.getMachine(box)!;
  const kind: JobKind = { name: 'k', image: `docker.io/x/y@sha256:${'a'.repeat(64)}`, command: ['run'], reads: [], gpu: true, network: false, resumable: false, max_limit_s: 3600 };
  const queue = (when: 'now' | 'hours' = 'now') => jobs.queue({ machine: m(), projectId: p.id, ticketId: ticket, contraptionId: null, askedBy: 'test', kind, inputs: [], limitS: 600, when, reason: 'test' }).id;
  const running = () => {
    const id = queue();
    jobs.decide(id, 'now', who);
    jobs.report(m(), { id, state: 'running', run_s: 0 });
    return id;
  };
  const job = (id: number) => store.getMachineJob(id)!;
  // The whole day, or (closed) a minute that is never now.
  const settings = (s: object) => store.updateMachine(box, { job_settings: JSON.stringify({ ...DEFAULT_SETTINGS, ...s }) });
  return { store, jobs, sent, woke, cards, settled, clock, who, m, queue, running, job, settings };
}

test('a "paused" the agent sent before it acted on a resume is answered with the resume, not believed; a second one is (2MA3)', () => {
  const w = world();
  const id = w.running();
  w.jobs.pause(id, w.who);
  w.jobs.resume(id, w.who);
  w.sent.length = 0;
  w.jobs.report(w.m(), { id, state: 'paused', run_s: 1 });
  assert.equal(w.job(id).state, 'running');
  assert.deepEqual(w.sent, [{ type: 'job.resume', id }]);
  w.clock.t += 5_000;
  w.jobs.report(w.m(), { id, state: 'paused', run_s: 1 });
  assert.equal(w.job(id).state, 'running', 'it may still be acting on it');
  w.clock.t += 15_000;
  w.jobs.report(w.m(), { id, state: 'paused', run_s: 1 });
  assert.equal(w.job(id).state, 'paused', 'it did not take: shown as it is');
  assert.equal(w.sent.length, 1);
});

test('on reconnect, a lost resume and a pause lost while starting are sent again (2MA3, 2MA7)', () => {
  const w = world();
  const id = w.running();
  w.sent.length = 0;
  w.jobs.reconcile(w.m(), [{ id, state: 'paused' }], w.clock.t);
  assert.deepEqual(w.sent, [{ type: 'job.resume', id }]);
  w.jobs.pause(id, w.who);
  w.sent.length = 0;
  w.jobs.reconcile(w.m(), [{ id, state: 'starting' }], w.clock.t);
  assert.deepEqual(w.sent, [{ type: 'job.pause', id }]);
});

test('taking back "Always allow" asks again for the jobs queued on it, and the line behind moves (2MA4)', () => {
  const w = world();
  const first = w.queue('hours');
  w.jobs.decide(first, 'always', w.who);
  const standing = w.queue('hours');
  assert.equal(w.job(standing).go, 'standing');
  const behind = w.queue();
  w.jobs.decide(behind, 'now', w.who);
  const asked = w.cards.length;
  w.jobs.forgetKind(w.m(), w.job(first).kind_hash, w.who);
  assert.deepEqual([w.job(standing).state, w.job(standing).go], ['needs-go', null]);
  assert.equal(w.cards.length, asked + 1);
  w.jobs.report(w.m(), { id: w.job(first).state === 'starting' ? first : behind, state: 'running', run_s: 0 });
  const active = [first, behind].find((id) => w.job(id).state === 'running')!;
  w.jobs.report(w.m(), { id: active, state: 'done', run_s: 1, exit_code: 0 });
  assert.ok([first, behind].every((id) => w.job(id).state !== 'queued' || w.job(id).go !== 'standing'));
  assert.equal(w.job(behind).state, active === behind ? 'done' : 'starting');
});

test("unticking the machine's Pause outside job hours leaves the job to the hours, and starts nothing (2MA8)", () => {
  const w = world();
  // No hours of its own matter until it runs: allowed for hours, inside a one-off window.
  w.settings({ until: w.clock.t + 3600_000 });
  const id = w.queue('hours');
  w.jobs.decide(id, 'hours', w.who);
  w.jobs.report(w.m(), { id, state: 'running', run_s: 0 });
  w.settings({ until: w.clock.t + 3600_000, paused: true });
  w.jobs.pump(w.m().id);
  assert.equal(w.job(id).paused_by, 'machine');
  w.sent.length = 0;
  const closed = new Date(w.clock.t + 6 * 3600_000).toTimeString().slice(0, 5);
  const later = new Date(w.clock.t + 7 * 3600_000).toTimeString().slice(0, 5);
  w.settings({ start: closed, end: later });
  w.jobs.pump(w.m().id);
  assert.deepEqual([w.sent, w.job(id).state, w.job(id).paused_by], [[], 'paused', 'hours']);
  w.settings({ until: w.clock.t + 3600_000 });
  w.jobs.pump(w.m().id);
  assert.deepEqual(w.sent, [{ type: 'job.resume', id }]);
});

test('dropping jobs stops the one on the machine, settles the waiting one’s card, and tells both minions (2MA9)', () => {
  const w = world();
  const on = w.running();
  const waits = w.queue();
  w.sent.length = 0;
  w.jobs.drop(w.m().id, 'gpu-box was removed from Citadel', () => true);
  assert.deepEqual(w.sent, [{ type: 'job.stop', id: on }]);
  assert.deepEqual([w.job(on).state, w.job(waits).state], ['stopped', 'stopped']);
  assert.ok(w.settled.some((s) => s.includes(`#${waits}`)));
  assert.deepEqual(
    [on, waits].map((id) => w.woke.some((t) => t.includes(`Job #${id}`) && t.includes('removed from Citadel'))),
    [true, true],
  );
});
