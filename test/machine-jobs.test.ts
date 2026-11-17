import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { hoursOpen, kindHash, pacificClock, type JobKind } from '../src/machine-jobs.ts';
import { projectSharedDir } from '../src/workspace.ts';
import { bootServer, jsonLines, SECRET, stopProcs, stopTurns, until } from './helpers.ts';

// Jobs on a person's machine (#857, shared/project/specs/desktop-gpu-jobs.md): the real server, a stand-in `claude -p`
// that records each turn, and a fake machine agent on the real SSE stream that records the job messages it is sent.
const root = mkdtempSync(join(tmpdir(), 'machine-jobs-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
const procs: ChildProcess[] = [];
const agents: { close(): void }[] = [];
after(async () => {
  for (const a of agents) a.close();
  await stopProcs(procs);
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});

const fakeClaude = join(root, 'claude-fake');
writeFileSync(fakeClaude, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).once('line', (prompt) => {
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ prompt: JSON.parse(prompt), token: process.env.COORDINATOR_TOKEN, jobs: process.env.COORDINATOR_JOB_MACHINES ?? null }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`);
chmodSync(fakeClaude, 0o755);

// Before boot: the admin, the scheme, and two contraptions homed in it.
const pre = new Store(join(data, 'coordinator.db'));
const cara = pre.createUser({ name: 'Cara', login: 'cara', admin: true });
pre.updateUser(cara.id, { server_login: 1 }); // her turns run on the server's (stand-in) login
const scheme = pre.createProject('P', null, cara.id);
const keys = new Contraptions(pre, SECRET, join(data, 'contraptions'));
for (const name of ['appa', 'appb']) keys.register({ name, title: name.toUpperCase(), port: 9100, icon: null, home_scheme: scheme.id, open_paths: '[]', default_model: null, turn_cap: null });
const KEY = (name: string) => readFileSync(join(data, 'contraptions', name, 'contraption.key'), 'utf8');

let base = '';
const cookies: Record<string, string> = {};
let ticket: any;
let box: any;
let boxToken = '';
let agent: Agent;
const shared = projectSharedDir(data, scheme.id);

async function raw(path: string, opts: { method?: string; body?: unknown; who?: string; bearer?: string } = {}) {
  const auth = opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : opts.who === 'minion' ? { Authorization: `Bearer ${live()}` } : { Cookie: cookies[opts.who ?? 'Cara'] };
  return fetch(base + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...auth, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}
async function call(who: string, path: string, body?: unknown, method?: string) {
  const res = await raw(path, { who, body, method });
  const out = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${out.error}`);
  return out;
}
async function app(name: string, path: string, body?: unknown) {
  const res = await raw(path, { bearer: KEY(name), body });
  const out = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${out.error}`);
  return out;
}

const turns = () => jsonLines(join(root, 'turns.jsonl'));
const live = () => turns().filter((t) => t.token.startsWith(`${ticket.id}.`)).at(-1).token;
const idle = () => until('the turn to end', async () => (await call('Cara', `/api/tickets/${ticket.id}`)).ticket.status !== 'running');
const events = async (kind: string) => (await call('Cara', `/api/tickets/${ticket.id}/events?after=0`)).filter((e: any) => e.kind === kind).map((e: any) => JSON.parse(e.data));
const job = (id: number) => call('Josh', `/api/jobs/${id}`);

/** A fake machine agent: its stream's messages, and its own calls with the machine's key. */
interface Agent { msgs: any[]; jobs(type?: string): any[]; close(): void; post(path: string, body: unknown): Promise<Response> }
async function connect(token: string, info: object): Promise<Agent> {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/machines/connect?v=2&host=fake`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  const msgs: any[] = [];
  void (async () => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body as any) {
      buf += dec.decode(chunk, { stream: true });
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        if (line) msgs.push(JSON.parse(line.slice(6)));
      }
    }
  })().catch(() => {});
  await until('the hello', () => msgs.some((m) => m.hello));
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const a: Agent = { msgs, jobs: (type) => msgs.filter((m) => m.job && (!type || m.job.type === type)).map((m) => m.job), close: () => ctrl.abort(), post };
  agents.push(a);
  assert.equal((await post('/api/machines/info', { v: 2, found: [], workspaces: [], ...info })).status, 202);
  return a;
}
const OFFER = { jobs: { folders: ['models'], max_limit_h: 12, max_disk_gb: 100, gpu: true } };
const state = (id: number, s: string, extra: object = {}) => agent.post('/api/machines/job-state', { id, state: s, run_s: 5, gpu_busy_s: 3, gpu_pct: 90, vram_mb: 4000, log_tail: 'working', ...extra });

const IMAGE = (c: string) => `ghcr.io/example/whisperx@sha256:${c.repeat(64)}`;
const KIND = { name: 'whisperx', image: IMAGE('a'), command: ['align', '/in'], reads: ['models'], gpu: true, network: false, resumable: true, max_limit_h: 2 };
const queue = (body: object) => call('minion', `/api/tickets/${ticket.id}/jobs`, { machine: 'josh-gpu', kind: KIND, ...body });
/** Answer a job's go card in the chat as `who`. */
async function answer(who: string, jobId: number, label: string) {
  const card = (await events('question')).filter((q) => q.job === jobId).at(-1);
  assert.ok(card, `job #${jobId} has a go card`);
  return call(who, `/api/tickets/${ticket.id}/answer`, { questionId: card.id, answers: [{ selected: [label] }] });
}
const hhmm = (min: number) => { const m = ((min % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const hours = (open: boolean) => {
  const now = pacificClock(Date.now()).minutes;
  return call('Josh', `/api/machines/${box.id}/job-settings`, open ? { start: hhmm(now - 60), end: hhmm(now + 120) } : { start: hhmm(now + 120), end: hhmm(now + 180) }, 'PATCH');
};
/** Do something that wakes the minion, and wait for that turn to start and end: its token replaces the last one. */
async function wakes<T>(fn: () => Promise<T>): Promise<T> {
  const n = turns().length;
  const out = await fn();
  await until('the minion to be woken', () => turns().length > n);
  await idle();
  return out;
}
/** End a job as done, so the next test starts with the machine free; the minion is woken with its result. */
const finish = (id: number) => wakes(async () => {
  assert.equal((await state(id, 'done', { exit_code: 0 })).status, 202);
  await until(`job #${id} to end`, async () => (await job(id)).state === 'done');
});

before(async () => {
  const srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude, HOME: join(root, 'home') } });
  base = srv.base;
  cookies.Cara = srv.cookie;
  procs.push(srv.proc);
  for (const name of ['Josh', 'Dana']) {
    const made = await call('Cara', '/api/people', { name });
    const res = await fetch(`${base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: `${name}-password-1` }) });
    cookies[name] = res.headers.get('set-cookie')!.split(';')[0];
    await call('Cara', `/api/projects/${scheme.id}/members`, { person: made.person.id });
  }
  ({ machine: box, token: boxToken } = await call('Josh', '/api/machines', { name: 'josh-gpu' }));
  await call('Josh', `/api/machines/${box.id}`, { projects: [scheme.id] }, 'PATCH');
  agent = await connect(boxToken, OFFER);
  await hours(true);
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, 'chapter.wav'), 'RIFF fake audio');
  ticket = await call('Cara', `/api/projects/${scheme.id}/tickets`, { message: 'align chapter 4' });
  await until('the first turn', () => turns().length >= 1);
  await idle();
});

test('job hours wrap midnight, a one-off window opens them, and a kind\'s hash ignores its name', () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 10, 16, h + 8, m); // Pacific standard time is UTC-8 in November
  const night = { start: '23:00', end: '08:00', until: null, paused: false };
  assert.equal(hoursOpen(night, at(23, 30)), true);
  assert.equal(hoursOpen(night, at(7, 59)), true);
  assert.equal(hoursOpen(night, at(8, 0)), false);
  assert.equal(hoursOpen(night, at(12)), false);
  assert.equal(hoursOpen({ ...night, until: at(13) }, at(12)), true, 'the one-off window opens them');
  assert.equal(hoursOpen({ ...night, start: '09:00', end: '17:00' }, at(12)), true);
  const k: JobKind = { name: 'a', image: IMAGE('a'), command: ['x'], reads: [], gpu: true, network: false, resumable: false, max_limit_s: 3600 };
  assert.equal(kindHash(k), kindHash({ ...k, name: 'b' }));
  assert.notEqual(kindHash(k), kindHash({ ...k, image: IMAGE('b') }));
  assert.notEqual(kindHash(k), kindHash({ ...k, network: true }));
});

test('only a minion whose scheme has a machine with a jobs block gets the job tools', async () => {
  assert.equal(turns()[0].jobs, 'josh-gpu');
});

test('no job.start without its owner\'s go: someone else\'s answer is refused, the owner\'s starts it', async () => {
  const j = await queue({ inputs: [join(shared, 'chapter.wav')] });
  assert.equal(j.state, 'needs-go');
  const card = (await events('question')).find((q) => q.job === j.id);
  assert.equal(card.to, 'Josh', 'the card is the owner\'s');
  assert.deepEqual(card.questions[0].options.map((o: any) => o.label), ['Run in job hours', 'Run now', 'Always allow this kind', 'No']);
  assert.match(card.questions[0].question, /whisperx.*josh-gpu[\s\S]*Reads models; GPU yes; network no; limit 2 h[\s\S]*chapter\.wav/);
  await assert.rejects(answer('Dana', j.id, 'Run in job hours'), /403/);
  await assert.rejects(call('Dana', `/api/jobs/${j.id}/go`, { choice: 'now' }), /403/);
  await assert.rejects(raw(`/api/jobs/${j.id}/go`, { who: 'minion', body: { choice: 'now' } }).then((r) => { if (!r.ok) throw new Error(String(r.status)); }), /403/);
  assert.deepEqual(agent.jobs('job.start'), [], 'nothing starts without a go');
  await answer('Josh', j.id, 'Run in job hours');
  const [start] = await until('job.start', () => agent.jobs('job.start').length && agent.jobs('job.start'));
  assert.equal(start.id, j.id);
  assert.deepEqual(start.kind, { name: 'whisperx', image: IMAGE('a'), command: ['align', '/in'], reads: ['models'], gpu: true, network: false, resumable: true });
  assert.equal(start.limit_s, 7200);
  assert.equal(start.inputs[0].name, 'chapter.wav');
  // The input comes with the job's own token only.
  const input = (token: string) => fetch(`${base}/api/machines/job-input?job=${j.id}&name=chapter.wav`, { headers: { Authorization: `Bearer ${boxToken}`, 'X-Job-Token': token } });
  assert.equal((await input('wrong')).status, 403);
  assert.equal(await (await input(start.input_token)).text(), 'RIFF fake audio');
  assert.equal((await state(j.id, 'running')).status, 202);
  assert.equal((await job(j.id)).state, 'running');
});

test('one job at a time: a second one with its go waits behind the first', async () => {
  const [running] = (await call('Josh', `/api/machines/${box.id}/jobs`)).jobs.filter((x: any) => x.state === 'running');
  const j = await queue({});
  await call('Josh', `/api/jobs/${j.id}/go`, { choice: 'hours' });
  const view = await job(j.id);
  assert.equal(view.state, 'queued');
  assert.equal(view.waits, `behind job #${running.id}`);
  assert.equal(agent.jobs('job.start').length, 1);
  // The first ending starts the second; the minion is woken with the first's result.
  await finish(running.id);
  await until('the second job.start', () => agent.jobs('job.start').some((s) => s.id === j.id));
  assert.match(JSON.stringify(turns().at(-1).prompt), new RegExp(`Job #${running.id} \\(whisperx\\) on josh-gpu is done`));
  // A report on a job that ended here is refused, and the agent is told to stop it.
  assert.equal((await state(running.id, 'running')).status, 409);
  await until('job.stop for the ended job', () => agent.jobs('job.stop').some((s) => s.id === running.id));
  await state(j.id, 'running');
  await finish(j.id);
});

test('"Always allow" is a standing go for job hours; a changed digest asks again; outside hours it waits; now always asks', async () => {
  const first = await queue({});
  await answer('Josh', first.id, 'Always allow this kind');
  await until('job.start', () => agent.jobs('job.start').some((s) => s.id === first.id));
  await state(first.id, 'running');
  await finish(first.id);
  const cards = (await events('question')).length;
  // Same recipe, a new name: no card.
  const again = await queue({ kind: { ...KIND, name: 'whisperx-2' } });
  assert.equal(again.state, 'starting', 'the machine is free and in its hours: it starts at once');
  assert.equal(again.go, 'standing');
  assert.equal((await events('question')).length, cards);
  await until('job.start', () => agent.jobs('job.start').some((s) => s.id === again.id));
  await state(again.id, 'running');
  await finish(again.id);
  // A new digest is a new recipe.
  const changed = await queue({ kind: { ...KIND, image: IMAGE('b') } });
  assert.equal(changed.state, 'needs-go');
  await wakes(() => call('Josh', `/api/jobs/${changed.id}/go`, { choice: 'no' }));
  assert.equal((await job(changed.id)).state, 'refused');
  assert.match(JSON.stringify(turns().at(-1).prompt), new RegExp(`Job #${changed.id} \\(whisperx\\) on josh-gpu was refused by Josh`));
  // Outside job hours a standing go waits; asked for now, it takes a card.
  await hours(false);
  const waits = await queue({});
  assert.equal(waits.state, 'queued');
  assert.match(waits.waits, /^outside job hours \(opens \d\d:\d\d P[SD]T\)$/);
  await assert.rejects(queue({ when: 'now' }), /400 when "now" needs a reason/);
  const now = await queue({ when: 'now', reason: 'Cara wants chapter 4 tonight' });
  assert.equal(now.state, 'needs-go');
  assert.ok((await events('question')).some((q) => q.job === now.id));
  const started = agent.jobs('job.start').length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(agent.jobs('job.start').length, started, 'neither starts outside hours without a run-now');
  // Run now is the owner's: then it starts.
  await assert.rejects(call('Dana', `/api/jobs/${waits.id}/run-now`, {}), /403/);
  await call('Josh', `/api/jobs/${waits.id}/run-now`, {});
  await until('the run-now start', () => agent.jobs('job.start').some((s) => s.id === waits.id));
  await wakes(() => call('Josh', `/api/jobs/${now.id}/go`, { choice: 'no' }));
});

test('only the owner (or an admin) pauses, resumes and stops; paused time is the owner\'s', async () => {
  const [j] = (await call('Josh', `/api/machines/${box.id}/jobs`)).jobs.filter((x: any) => x.state === 'starting');
  await state(j.id, 'running');
  for (const action of ['pause', 'resume', 'stop']) await assert.rejects(call('Dana', `/api/jobs/${j.id}/${action}`, {}), /403/);
  await assert.rejects(raw(`/api/jobs/${j.id}/pause`, { who: 'minion', body: {} }).then((r) => { if (!r.ok) throw new Error(String(r.status)); }), /403/);
  assert.equal((await call('Josh', `/api/jobs/${j.id}/pause`, {})).state, 'paused');
  await until('job.pause', () => agent.jobs('job.pause').some((s) => s.id === j.id));
  assert.equal((await call('Cara', `/api/jobs/${j.id}/resume`, {})).state, 'running', 'an admin may too');
  await until('job.resume', () => agent.jobs('job.resume').some((s) => s.id === j.id));
  await call('Josh', `/api/jobs/${j.id}/stop`, {});
  await until('job.stop', () => agent.jobs('job.stop').some((s) => s.id === j.id));
  await wakes(() => state(j.id, 'stopped'));
  assert.equal((await job(j.id)).state, 'stopped');
});

test('results upload under the job\'s and the scheme\'s caps', async () => {
  await hours(true);
  const j = await queue({});
  await until('job.start', () => agent.jobs('job.start').some((s) => s.id === j.id));
  await state(j.id, 'running');
  const upload = (path: string, body: string | null, length?: number) => new Promise<number>((resolve, reject) => {
    const req = request(`${base}/api/machines/job-upload?job=${j.id}&path=${encodeURIComponent(path)}`, { method: 'POST', headers: { Authorization: `Bearer ${boxToken}`, ...(length !== undefined ? { 'Content-Length': String(length) } : {}) } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
      req.destroy();
    });
    req.on('error', (err: any) => (err.code === 'ECONNRESET' ? undefined : reject(err)));
    if (body !== null) req.end(body);
    else req.flushHeaders();
  });
  assert.equal(await upload('words/ch4.json', '{"ok":true}'), 201);
  assert.equal(readFileSync(join(shared, 'jobs', String(j.id), 'words', 'ch4.json'), 'utf8'), '{"ok":true}');
  assert.equal(await upload('../escape.json', 'x'), 400);
  assert.equal(await upload('big.bin', null, 2 * 1024 ** 3 + 1), 413, 'over 2 GB per job, refused on its length');
  // Fill the scheme to 10 bytes under its 20 GB: a file that grows past that while streaming is refused, and nothing is kept.
  const store = new Store(join(data, 'coordinator.db'));
  const other = await queue({});
  await wakes(() => call('Josh', `/api/jobs/${other.id}/stop`, {}));
  store.db.prepare('UPDATE machine_jobs SET upload_bytes = ? WHERE id = ?').run(20 * 1024 ** 3 - 11 - 11, other.id);
  assert.equal(await upload('fits.txt', 'x'.repeat(5)), 201);
  assert.equal(await upload('over.txt', 'x'.repeat(100)), 413);
  assert.equal(existsSync(join(shared, 'jobs', String(j.id), 'over.txt')), false);
  store.db.prepare('UPDATE machine_jobs SET upload_bytes = 0 WHERE id = ?').run(other.id);
  await finish(j.id);
  assert.match(JSON.stringify(turns().at(-1).prompt), new RegExp(`Job #${j.id} .*jobs/${j.id}/ in the scheme's shared folder`));
});

test('on reconnect the server reconciles: a lost job failed, one it ended is told to stop', async () => {
  const j = await queue({});
  await until('job.start', () => agent.jobs('job.start').some((s) => s.id === j.id));
  await state(j.id, 'running');
  agent.close();
  await until('the machine offline', async () => (await call('Josh', '/api/machines')).find((m: any) => m.id === box.id).status !== 'ready');
  // It comes back knowing nothing of the running job, and still running an old ended one.
  agent = await wakes(() => connect(boxToken, { ...OFFER, known_jobs: [{ id: 1, state: 'running' }] }));
  assert.equal((await job(j.id)).state, 'failed');
  assert.equal((await job(j.id)).error, 'the machine restarted');
  await until('job.stop for the old job', () => agent.jobs('job.stop').some((s) => s.id === 1));
});

test('a contraption queues on its home scheme\'s machine, and can\'t read or stop another app\'s job', async () => {
  const j = await app('appa', '/api/contraptions/jobs', { machine: 'josh-gpu', kind: KIND, when: 'now', reason: 'render tonight' });
  assert.equal(j.state, 'needs-go');
  assert.equal(j.asked_by, 'APPA');
  assert.equal((await app('appa', `/api/contraptions/jobs/${j.id}`)).id, j.id);
  await assert.rejects(app('appb', `/api/contraptions/jobs/${j.id}`), /404/);
  await assert.rejects(app('appb', `/api/contraptions/jobs/${j.id}/stop`, {}), /404/);
  await assert.rejects(app('appa', '/api/contraptions/jobs', { machine: 'josh-gpu', kind: KIND, inputs: ['/etc/passwd'] }), /400/);
  assert.equal((await app('appa', `/api/contraptions/jobs/${j.id}/stop`, {})).state, 'stopped');
});
