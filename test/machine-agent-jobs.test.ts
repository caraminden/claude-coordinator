import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from './wait.ts';
import { after, before, test } from 'node:test';
import { jsonLines } from './helpers.ts';
import { holds } from './holds.ts';
// @ts-ignore: a plain .mjs the agent's computers download
import { JobRunner, loadConfig, outFiles, podmanRunArgs } from '../public/machine-agent.mjs';

// The machine agent's GPU job runner (#858) against a fake podman, a fake nvidia-smi and a stand-in for the app's
// three job routes. The fake podman keeps each container as a file; a test ends one by writing that file.
const root = mkdtempSync(join(tmpdir(), 'machine-agent-jobs-'));
after(() => rmSync(root, { recursive: true, force: true }));
const node = process.execPath;
const fakes = join(root, 'fakes');
mkdirSync(fakes);
const fakePodman = join(root, 'podman.mjs');
writeFileSync(fakePodman, `
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, cmd, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'argv.log'), JSON.stringify([cmd, ...args]) + '\\n');
const box = (name) => join(dir, name + '.json');
const read = (name) => (existsSync(box(name)) ? JSON.parse(readFileSync(box(name), 'utf8')) : null);
// Written whole and renamed in, so a wait or inspect running at the same time never reads half a file.
const set = (name, s) => (writeFileSync(box(name) + '.new', JSON.stringify(s)), renameSync(box(name) + '.new', box(name)));
const name = args[args.length - 1];
if (cmd === 'run') {
  if (args.some((a) => a.includes('fail-run'))) { console.error('Error: image not known'); process.exit(125); }
  set(args[args.indexOf('--name') + 1], { status: 'running' });
} else if (cmd === 'wait') {
  const tick = () => {
    const s = read(name);
    if (!s) { console.error('no such container'); process.exit(125); }
    // Fails once and takes its own flag down, so a test never has to clear it while a later wait may be reading it.
    if (s.waitFails) { set(name, { ...s, waitFails: false }); console.error('Error: wait interrupted'); process.exit(125); }
    if (s.status === 'exited' || s.status === 'removed') { console.log(s.code); process.exit(0); }
    setTimeout(tick, 30);
  };
  tick();
} else if (cmd === 'inspect') {
  const s = read(name);
  if (!s || s.status === 'removed') { console.error('no such object'); process.exit(125); }
  console.log(args.join(' ').includes('ExitCode') ? s.status + ' ' + (s.code ?? 0) : s.status);
} else if ((cmd === 'rm' || cmd === 'stop') && read(name)?.stuck) {
  console.error('Error: container state improper'); process.exit(125);
} else if (cmd === 'rm') {
  const s = read(name);
  if (s && s.status !== 'removed') set(name, { status: 'removed', code: s.status === 'exited' ? s.code : 137 });
} else if (cmd === 'stop') {
  if (read(name)?.status === 'running') set(name, { status: 'exited', code: 143 });
} else if (cmd === 'pause') {
  set(name, { status: 'paused' });
} else if (cmd === 'unpause') {
  set(name, { status: 'running' });
}
`);
const fakeSmi = join(root, 'nvidia-smi.mjs');
writeFileSync(fakeSmi, `console.log('42, 5120\\n');`);

const box = (id: number) => join(fakes, `citadel-job-${id}.json`);
const container = (id: number) => (existsSync(box(id)) ? JSON.parse(readFileSync(box(id), 'utf8')) : null);
const setBox = (id: number, s: object) => (writeFileSync(`${box(id)}.new`, JSON.stringify(s)), renameSync(`${box(id)}.new`, box(id)));
const exitContainer = (id: number, code: number) => setBox(id, { status: 'exited', code });
const stickContainer = (id: number, stuck: boolean) => setBox(id, { ...container(id), stuck });
const podmanCalls = () => jsonLines(join(fakes, 'argv.log'));

// ---------- the app's side ----------
type State = { id: number; state: string; run_s: number; error?: string; outputs?: { path: string; size: number; uploaded: boolean }[]; exit_code?: number; held_vram_mb?: number; log_tail?: string };
const app = {
  states: [] as State[],
  uploads: new Map<string, Buffer>(),
  logs: new Map<number, string>(),
  inputs: new Map<string, Buffer>(),
  stateStatus: 202,
  uploadStatus: 201,
  rejected: 0,
};
const inputFlaky = new Map<string, { left: number; data: Buffer }>();
let appUrl = '';
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const send = (status: number, obj: object) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
  if (req.headers.authorization !== 'Bearer machine-key') return send(401, { error: 'key' });
  if (url.pathname === '/api/machines/job-input') {
    if (req.headers['x-job-token'] !== 'tok') return send(403, { error: 'bad token' });
    const flaky = inputFlaky.get(`${url.searchParams.get('job')}/${url.searchParams.get('name')}`);
    if (flaky) return flaky.left-- > 0 ? send(502, { error: 'bad gateway' }) : res.writeHead(200).end(flaky.data);
    const data = app.inputs.get(`${url.searchParams.get('job')}/${url.searchParams.get('name')}`);
    return data ? res.writeHead(200).end(data) : send(404, { error: 'no such input' });
  }
  if (url.pathname === '/api/machines/job-state') {
    app.states.push(JSON.parse(body.toString()));
    return send(app.stateStatus, { ok: true });
  }
  if (url.pathname === '/api/machines/job-upload') {
    const job = Number(url.searchParams.get('job'));
    if (url.searchParams.get('log')) return app.logs.set(job, body.toString()), send(201, { ok: true });
    const path = url.searchParams.get('path') ?? '';
    if (path.startsWith('huge')) return send(413, { error: 'over the cap' });
    if (app.uploadStatus !== 201) { app.rejected++; return send(app.uploadStatus, { error: 'the app is restarting' }); }
    app.uploads.set(`${job}/${path}`, body);
    return send(201, { ok: true });
  }
  send(404, { error: 'no route' });
});
before(() => new Promise<void>((done) => server.listen(0, '127.0.0.1', () => ((appUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`), done()))));
after(() => new Promise<void>((done) => server.close(() => done())));

const statesOf = (id: number) => app.states.filter((s) => s.id === id);
const lastState = (id: number) => statesOf(id).at(-1);
const statesTail = () => `states: ${JSON.stringify(app.states.slice(-4))}`;

// ---------- the owner's block ----------
const jobsDir = join(root, 'jobs');
const voice = join(root, 'voice notes');
const outside = join(root, 'outside');
for (const d of [jobsDir, voice, outside]) mkdirSync(d);
writeFileSync(join(outside, 'secret.txt'), 'never leaves');
const block = (over: object = {}) => ({ dir: jobsDir, folders: new Map([['voice', voice]]), max_limit_h: 12, max_disk_gb: 5, gpu: true, ...over });

const runners: any[] = [];
after(() => runners.forEach((r) => r.close()));
function runner(b: object | null = block(), log: (line: string) => void = () => {}) {
  const r = new JobRunner({ block: b, appUrl, token: 'machine-key', podman: [node, fakePodman, fakes], nvidiaSmi: [node, fakeSmi], tickMs: 60, graceS: 1, log });
  runners.push(r);
  return r;
}

const IMAGE = `ghcr.io/example/whisperx@sha256:${'a'.repeat(64)}`;
let nextId = 100;
function start(over: object = {}, kind: object = {}) {
  const id = nextId++;
  const data = Buffer.from(`audio for ${id}`);
  app.inputs.set(`${id}/clip.wav`, data);
  return {
    type: 'job.start', id, limit_s: 3600, input_token: 'tok', resume: false,
    inputs: [{ name: 'clip.wav', size: data.length, sha256: createHash('sha256').update(data).digest('hex') }],
    kind: { name: 'whisperx', image: IMAGE, command: ['whisperx', '/in/clip.wav'], gpu: true, network: false, reads: ['voice'], resumable: false, ...kind },
    ...over,
  };
}

// ---------- the block ----------

test('loadConfig reads the jobs block, leaves bad folders out, and turns jobs off for a broken one', () => {
  const file = join(root, 'machine-agent.json');
  writeFileSync(file, JSON.stringify({ jobs: { dir: jobsDir, folders: { voice, 'bad name!': voice, gone: join(root, 'nope') }, max_disk_gb: 40, gpu: true } }));
  const c = loadConfig(file, {});
  assert.deepEqual([...c.jobs.folders], [['voice', voice]]);
  assert.equal(c.jobs.max_limit_h, 12);
  assert.equal(c.jobs.gpu, true);
  assert.equal(c.problems.length, 2);

  for (const [jobs, why] of [
    [{ dir: jobsDir, folders: {} }, /max_disk_gb/],
    [{ dir: join(root, 'nope'), max_disk_gb: 1 }, /dir/],
    [{ dir: jobsDir, max_disk_gb: 1, max_limit_h: 100 }, /max_limit_h/],
    [{ dir: jobsDir, max_disk_gb: 1, gpu: 'yes' }, /gpu/],
    ['on', /must be/],
  ] as const) {
    writeFileSync(file, JSON.stringify({ jobs }));
    const broken = loadConfig(file, {});
    assert.equal(broken.jobs, null, JSON.stringify(jobs));
    assert.match(broken.problems.join('\n'), why);
    assert.match(broken.problems.join('\n'), /jobs are off/);
  }
  const comma = join(root, 'a,b');
  mkdirSync(comma);
  writeFileSync(file, JSON.stringify({ jobs: { dir: comma, max_disk_gb: 1 } }));
  assert.equal(loadConfig(file, {}).jobs, null);
  writeFileSync(file, JSON.stringify({ workspaces: {} }));
  assert.equal(loadConfig(file, {}).jobs, null);
});

test('the info offers folder names, never their paths', () => {
  const r = runner();
  assert.deepEqual(r.offer(), { folders: ['voice'], max_limit_h: 12, max_disk_gb: 5, gpu: true });
  assert.equal(runner(null).offer(), null);
});

// ---------- the wall ----------

test('the podman argv: the whole wall, for a GPU kind and a plain one', () => {
  const job = { id: '7', kind: { name: 'whisper x', image: IMAGE, command: ['whisperx', '/in/a.wav'], gpu: true, network: false, reads: ['voice'] } };
  const d = join(jobsDir, '7');
  assert.deepEqual(podmanRunArgs(job, block(), false), [
    'run', '-d', '--name', 'citadel-job-7', '--label', 'citadel.job=7',
    '--cap-drop', 'all', '--security-opt', 'no-new-privileges', '--security-opt', 'label=disable',
    '--userns', 'keep-id', '-e', 'HOME=/tmp', '-e', 'XDG_CACHE_HOME=/cache',
    '--network', 'none',
    '--device', 'nvidia.com/gpu=all',
    '--log-driver', 'k8s-file', '--log-opt', `path=${d}/job.log`,
    '--mount', `type=bind,src=${d}/in,dst=/in,ro`,
    '--mount', `type=bind,src=${d}/out,dst=/out`,
    '--mount', `type=bind,src=${d}/state,dst=/state`,
    '--mount', `type=bind,src=${jobsDir}/cache/whisper_x,dst=/cache`,
    '--mount', `type=bind,src=${voice},dst=/private/voice,ro`,
    IMAGE, 'whisperx', '/in/a.wav',
  ]);
  // A kind with the network, no GPU and no folders, resumed; and a GPU kind on a block that withholds the GPU.
  const plain = podmanRunArgs({ id: '8', kind: { ...job.kind, gpu: false, network: true, reads: [] } }, block(), true);
  assert.ok(!plain.includes('--network') && !plain.includes('--device') && !plain.some((a: string) => a.includes('/private/')));
  assert.deepEqual(plain.slice(plain.indexOf('CITADEL_JOB_RESUME=1') - 1, plain.indexOf('CITADEL_JOB_RESUME=1') + 1), ['-e', 'CITADEL_JOB_RESUME=1']);
  assert.ok(!podmanRunArgs(job, block({ gpu: false }), false).includes('--device'));
  for (const args of [podmanRunArgs(job, block(), false), plain]) assert.ok(!args.some((a: string) => /privileged|cap-add|host/.test(a)));
});

test('every refusal reports failed with why, and makes no folder and no container', async () => {
  const r = runner();
  const two = Buffer.alloc(10);
  const cases: [string, object, object?, RegExp?][] = [
    ['an image not pinned by digest', {}, { image: 'ghcr.io/example/whisperx:latest' }, /pinned by digest/],
    ['a command that is a string', {}, { command: 'whisperx /in/a.wav' }, /command/],
    ['an empty command', {}, { command: [] }, /command/],
    ['a folder the owner does not offer', {}, { reads: ['voice', 'photos'] }, /photos/],
    ['no time limit', { limit_s: 0 }, {}, /time limit/],
    ['a fractional time limit', { limit_s: 1.5 }, {}, /time limit/],
    ['a time limit over the block', { limit_s: 12 * 3600 + 1 }, {}, /over this machine's 12 h/],
    ['an input path', { inputs: [{ name: '../escape.wav', size: 1, sha256: 'a'.repeat(64) }] }, {}, /plain file name/],
    ['a hidden input', { inputs: [{ name: '.bashrc', size: 1, sha256: 'a'.repeat(64) }] }, {}, /plain file name/],
    ['a duplicate input', { inputs: [{ name: 'a.wav', size: 1, sha256: 'a'.repeat(64) }, { name: 'a.wav', size: 1, sha256: 'a'.repeat(64) }] }, {}, /plain file name/],
    ['an input with no sha256', { inputs: [{ name: 'a.wav', size: 1, sha256: 'x' }] }, {}, /sha256/],
    ['inputs over 2 GB', { inputs: [{ name: 'a.wav', size: 2 ** 31 + 1, sha256: 'a'.repeat(64) }] }, {}, /2 GB/],
    ['no input token', { input_token: '' }, {}, /token/],
    ['no kind', { kind: null }, undefined, /kind/],
  ];
  for (const [what, over, kind = {}, why] of cases) {
    const msg = start(over, kind);
    if ('kind' in over) msg.kind = over.kind as any;
    await r.handle(msg);
    const s = lastState(msg.id);
    assert.equal(s?.state, 'failed', what);
    assert.match(s?.error ?? '', /^Refused by the machine: /, what);
    if (why) assert.match(s?.error ?? '', why, what);
    assert.ok(!existsSync(join(jobsDir, String(msg.id))), `${what}: made a folder`);
  }
  // A GPU kind on a block that withholds the GPU.
  const noGpu = runner(block({ gpu: false }));
  const g = start();
  await noGpu.handle(g);
  assert.match(lastState(g.id)?.error ?? '', /GPU/);
  // Over the disk cap: the inputs alone don't fit.
  const small = runner(block({ max_disk_gb: two.length / 1024 ** 3 }));
  const big = start();
  await small.handle(big);
  assert.match(lastState(big.id)?.error ?? '', /would go over/);
  // An id that isn't the app's: not even a report.
  const before = app.states.length;
  await r.handle({ ...start(), id: '../1' });
  await r.handle({ ...start(), id: -3 });
  assert.equal(app.states.length, before);
  assert.ok(!podmanCalls().some(([cmd]) => cmd === 'run'), 'a refused job reached podman');
});

test('nothing runs without a jobs block', async () => {
  const r = runner(null);
  const msg = start();
  await r.handle(msg);
  assert.match(lastState(msg.id)?.error ?? '', /no jobs block/);
  assert.ok(!existsSync(join(jobsDir, String(msg.id))));
  assert.ok(!podmanCalls().some(([cmd, ...a]) => cmd === 'run' && a.includes(`citadel-job-${msg.id}`)));
});

// ---------- a run ----------

test('a job runs, reports, and only what stays inside /out uploads; a symlink out is listed, not read', async () => {
  const r = runner();
  const msg = start();
  await r.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  const d = join(jobsDir, String(msg.id));
  assert.equal(readFileSync(join(d, 'in', 'clip.wav'), 'utf8'), `audio for ${msg.id}`);
  const run = podmanCalls().find(([cmd, ...a]) => cmd === 'run' && a.includes(`citadel-job-${msg.id}`));
  assert.deepEqual(run, podmanRunArgs({ id: String(msg.id), kind: msg.kind }, block(), false));
  // The input token is never written down.
  assert.ok(!readFileSync(join(d, 'job.json'), 'utf8').includes('tok'));
  // A second job waits for the GPU slot.
  const second = start();
  await r.handle(second);
  assert.match(lastState(second.id)?.error ?? '', /GPU slot/);

  const out = join(d, 'out');
  writeFileSync(join(out, 'clip.json'), '{"text":"hi"}');
  mkdirSync(join(out, 'parts'));
  writeFileSync(join(out, 'parts', 'one.txt'), 'one');
  symlinkSync(join(out, 'clip.json'), join(out, 'same.json'));
  symlinkSync(join(outside, 'secret.txt'), join(out, 'secret.txt'));
  symlinkSync(outside, join(out, 'outside-dir'));
  writeFileSync(join(out, 'half.part'), 'x');
  writeFileSync(join(out, 'huge.bin'), 'x'.repeat(100));
  writeFileSync(join(d, 'job.log'), '2026-11-17T10:00:00.000000000-08:00 stdout F loading model\n2026-11-17T10:00:01.000000000-08:00 stderr F done\n');
  await until('a run-time report with GPU numbers', () => statesOf(msg.id).some((s: any) => s.state === 'running' && s.gpu_pct === 42 && s.vram_mb === 5120), 6000, statesTail);
  exitContainer(msg.id, 0);
  await until('done', () => lastState(msg.id)?.state === 'done', 6000, statesTail);
  const done = lastState(msg.id)!;
  assert.equal(done.exit_code, 0);
  assert.deepEqual([...app.uploads.keys()].filter((k) => k.startsWith(`${msg.id}/`)).sort(), [`${msg.id}/clip.json`, `${msg.id}/parts/one.txt`, `${msg.id}/same.json`]);
  const listed = Object.fromEntries(done.outputs!.map((o) => [o.path, o.uploaded]));
  assert.deepEqual(listed, { 'clip.json': true, 'half.part': false, 'huge.bin': false, 'outside-dir': false, 'parts/one.txt': true, 'same.json': true, 'secret.txt': false });
  assert.ok(![...app.uploads.values()].some((b) => b.toString().includes('never leaves')));
  assert.equal(app.logs.get(msg.id), 'loading model\ndone\n');
  assert.ok(statesOf(msg.id).some((s) => s.state === 'uploading'));
  assert.equal(container(msg.id).status, 'removed');
  // The app has the report before the runner has its answer, so the job leaves known() a moment after 'done' shows.
  await until('the runner hears the app took its last report', () => !r.known().some((k: any) => k.id === msg.id), 6000, statesTail);
});

test('a result the app refused is reported with why, and its folder is listed for the owner, never deleted (MA3)', async () => {
  const r = runner();
  let told = 0;
  r.onLeftover = () => told++;
  const msg = start();
  await r.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  writeFileSync(join(jobsDir, String(msg.id), 'out', 'huge.bin'), 'x'.repeat(100));
  exitContainer(msg.id, 0);
  await until('done', () => lastState(msg.id)?.state === 'done', 6000, statesTail);
  const huge = lastState(msg.id)!.outputs!.find((o) => o.path === 'huge.bin') as any;
  assert.equal(huge.uploaded, false);
  assert.match(huge.why ?? '', /413|cap/);
  await until('the owner is told', () => told > 0, 6000, statesTail);
  const lines = r.leftover();
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`\\b${msg.id}\\b`));
  assert.match(lines[0], /never deleted/);
  assert.ok(existsSync(join(jobsDir, String(msg.id), 'out', 'huge.bin')));
});

test('outFiles never follows a folder link, and lists a broken link', () => {
  const out = mkdtempSync(join(root, 'out-'));
  symlinkSync(join(root, 'missing'), join(out, 'broken'));
  symlinkSync(root, join(out, 'up'));
  assert.deepEqual(outFiles(out).map((f: any) => [f.path, f.why]), [['broken', 'a broken link'], ['up', 'a link to outside /out']]);
});

test('a failed input check fails the job and deletes the file', async () => {
  const r = runner();
  const msg = start();
  msg.inputs[0].sha256 = 'b'.repeat(64);
  await r.handle(msg);
  await until('failed', () => lastState(msg.id)?.state === 'failed', 6000, statesTail);
  assert.match(lastState(msg.id)!.error!, /doesn't match its sha256/);
  assert.deepEqual(readdirSync(join(jobsDir, String(msg.id), 'in')), []);
  assert.ok(!podmanCalls().some(([cmd, ...a]) => cmd === 'run' && a.includes(`citadel-job-${msg.id}`)));
});

test('a non-zero exit fails the job with its code', async () => {
  const r = runner();
  const msg = start();
  await r.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  exitContainer(msg.id, 3);
  await until('failed', () => lastState(msg.id)?.state === 'failed', 6000, statesTail);
  assert.equal(lastState(msg.id)!.exit_code, 3);
  assert.match(lastState(msg.id)!.error!, /code 3/);
});

test('podman run failing fails the job', async () => {
  const r = runner();
  const msg = start({}, { image: `ghcr.io/example/fail-run@sha256:${'c'.repeat(64)}` });
  await r.handle(msg);
  await until('failed', () => lastState(msg.id)?.state === 'failed', 6000, statesTail);
  assert.match(lastState(msg.id)!.error!, /podman run failed: Error: image not known/);
});

// ---------- the limit, pause, resume, stop ----------

test('the time limit stops a job, and paused time does not count', async () => {
  const r = runner();
  const msg = start({ limit_s: 1 });
  await r.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  await r.handle({ type: 'job.pause', id: msg.id });
  await until('paused', () => lastState(msg.id)?.state === 'paused', 6000, statesTail);
  assert.equal(container(msg.id).status, 'paused');
  assert.equal(lastState(msg.id)!.held_vram_mb, 5120);
  // Paused for well over the whole limit: still paused.
  await holds('paused time does not count: still paused', () => lastState(msg.id)!.state === 'paused', { ms: 2500 });
  assert.equal(lastState(msg.id)!.state, 'paused');
  await r.handle({ type: 'job.resume', id: msg.id });
  assert.equal(container(msg.id).status, 'running');
  await until('stopped at the limit', () => lastState(msg.id)?.state === 'failed', 6000, statesTail);
  // Its running time reached the limit; the 2.5 s paused would have made it 3 or more.
  const runS = lastState(msg.id)!.run_s;
  assert.ok(runS >= 1 && runS <= 2, `run_s ${runS}`);
  assert.match(lastState(msg.id)!.error!, /time limit/);
  assert.equal(container(msg.id).status, 'removed');
});

test('a resumable job pauses by stopping, frees its container, and resumes with CITADEL_JOB_RESUME', async () => {
  const r = runner();
  const msg = start({}, { resumable: true });
  await r.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  writeFileSync(join(jobsDir, String(msg.id), 'state', 'checkpoint'), '41%');
  await r.handle({ type: 'job.pause', id: msg.id });
  await until('paused', () => lastState(msg.id)?.state === 'paused', 6000, statesTail);
  const name = `citadel-job-${msg.id}`;
  assert.ok(podmanCalls().some((c) => c.join(' ') === `stop -t 1 ${name}`));
  assert.equal(container(msg.id).status, 'removed');
  assert.equal(lastState(msg.id)!.held_vram_mb, undefined);
  await r.handle({ type: 'job.resume', id: msg.id });
  await until('running again', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  const runs = podmanCalls().filter(([cmd, ...a]) => cmd === 'run' && a.includes(name));
  assert.equal(runs.length, 2);
  assert.ok(!runs[0].includes('CITADEL_JOB_RESUME=1') && runs[1].includes('CITADEL_JOB_RESUME=1'));
  assert.equal(readFileSync(join(jobsDir, String(msg.id), 'state', 'checkpoint'), 'utf8'), '41%');
  await r.handle({ type: 'job.stop', id: msg.id });
  await until('stopped', () => lastState(msg.id)?.state === 'stopped', 6000, statesTail);
});

test('a stop while paused ends the job and still uploads /out', async () => {
  const r = runner();
  const msg = start({}, { resumable: true });
  await r.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  writeFileSync(join(jobsDir, String(msg.id), 'out', 'partial.txt'), 'so far');
  await r.handle({ type: 'job.pause', id: msg.id });
  await until('paused', () => lastState(msg.id)?.state === 'paused', 6000, statesTail);
  await r.handle({ type: 'job.stop', id: msg.id });
  await until('stopped', () => lastState(msg.id)?.state === 'stopped', 6000, statesTail);
  assert.equal(app.uploads.get(`${msg.id}/partial.txt`)?.toString(), 'so far');
});

test('the app saying it ended the job stops it here', async () => {
  const r = runner();
  const msg = start();
  await r.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  app.stateStatus = 409;
  try {
    await until('removed', () => container(msg.id)?.status === 'removed', 6000, statesTail);
  } finally {
    app.stateStatus = 202;
  }
  await until('reported stopped', () => lastState(msg.id)?.state === 'stopped', 6000, statesTail);
});

// ---------- restarts ----------

test('a new agent re-attaches to a running job, and fails one whose container is gone', async () => {
  const first = runner();
  const msg = start();
  await first.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  first.close();
  // A job the machine lost while the agent was down.
  const lost = start();
  const ld = join(jobsDir, String(lost.id));
  mkdirSync(join(ld, 'out'), { recursive: true });
  writeFileSync(join(ld, 'job.json'), JSON.stringify({ id: String(lost.id), kind: lost.kind, limit_s: 3600, inputs: [], state: 'running', run_ms: 0, since: Date.now(), gpu_busy_s: 0, paused: null, outputs: [], final: null, final_sent: false }));

  const second = runner();
  await second.ready;
  assert.deepEqual(second.known().filter((k: any) => [msg.id, lost.id].includes(k.id)).sort((a: any, b: any) => a.id - b.id), [{ id: msg.id, state: 'running' }, { id: lost.id, state: 'running' }]);
  await second.connected();
  await until('the lost one failed', () => lastState(lost.id)?.state === 'failed', 6000, statesTail);
  assert.match(lastState(lost.id)!.error!, /machine restarted/);
  writeFileSync(join(jobsDir, String(msg.id), 'out', 'after.txt'), 'made while the agent was away');
  exitContainer(msg.id, 0);
  await until('done', () => lastState(msg.id)?.state === 'done', 6000, statesTail);
  assert.equal(app.uploads.get(`${msg.id}/after.txt`)?.toString(), 'made while the agent was away');
});

test('a job that ended while the agent was down is finished on connect', async () => {
  const first = runner();
  const msg = start();
  await first.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  first.close();
  exitContainer(msg.id, 0);
  const second = runner();
  await second.connected();
  await until('done', () => lastState(msg.id)?.state === 'done', 6000, statesTail);
});

// ---------- review fixes ----------

test('a container that will not go keeps the job running and /out unread, then stops once it goes', async () => {
  const r = runner();
  const msg = start({ limit_s: 1 });
  await r.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  writeFileSync(join(jobsDir, String(msg.id), 'out', 'result.txt'), 'done');
  stickContainer(msg.id, true);
  await until('rm tried twice', () => podmanCalls().filter((c) => c.join(' ') === `rm -f citadel-job-${msg.id}`).length >= 2, 4000, statesTail);
  assert.equal(container(msg.id).status, 'running');
  assert.equal(lastState(msg.id)!.state, 'running');
  assert.ok(!app.uploads.has(`${msg.id}/result.txt`), '/out was read while the container was still there');
  stickContainer(msg.id, false);
  await until('stopped at the limit', () => lastState(msg.id)?.state === 'failed', 6000, statesTail);
  assert.equal(app.uploads.get(`${msg.id}/result.txt`)?.toString(), 'done');
});

test('a failed pause leaves the job running, and its time limit still counts', async () => {
  const lines: string[] = [];
  const r = runner(block(), (l) => lines.push(l));
  const msg = start({ limit_s: 1 }, { resumable: true });
  await r.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  stickContainer(msg.id, true);
  await r.handle({ type: 'job.pause', id: msg.id });
  // Waits for the runner to hear the stop failed, not for the stop in argv.log: the fake logs its argv before it reads
  // the stuck flag, so un-sticking on the log line let a slow stop succeed and really pause the job (#1208).
  await until('the stop failed', () => lines.some((l) => l.startsWith(`Job ${msg.id}: podman stop failed, still running`)), 6000, statesTail);
  stickContainer(msg.id, false);
  await until('stopped at the limit', () => lastState(msg.id)?.state === 'failed', 4000, statesTail);
  assert.match(lastState(msg.id)!.error!, /time limit/);
});

test('with the block taken away, a running job still ticks and stops at its limit', async () => {
  const lines: string[] = [];
  const r = runner(block(), (l) => lines.push(l));
  const msg = start({ limit_s: 1 });
  await r.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  await r.setBlock(null);
  await until('stopped at the limit', () => lastState(msg.id)?.state === 'failed', 6000, statesTail);
  assert.match(lastState(msg.id)!.error!, /time limit/);
  assert.ok(!lines.some((l) => /Cannot read|TypeError/.test(l)), lines.join('\n'));
});

test('a running job that fills the jobs folder past its cap is stopped', async () => {
  const dir = mkdtempSync(join(root, 'capped-'));
  const r = runner(block({ dir, max_disk_gb: 4096 / 1024 ** 3 }));
  const msg = start();
  await r.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  writeFileSync(join(dir, String(msg.id), 'out', 'big.bin'), Buffer.alloc(8192));
  await until('stopped', () => lastState(msg.id)?.state === 'failed', 4000, statesTail);
  assert.match(lastState(msg.id)!.error!, /went over/);
});

test('room for a new job deletes the oldest finished folders only, and none when that would not be enough', async () => {
  const dir = mkdtempSync(join(root, 'room-'));
  const done = (id: number, ended: number, bytes: number) => {
    mkdirSync(join(dir, String(id), 'out'), { recursive: true });
    writeFileSync(join(dir, String(id), 'out', 'r.bin'), Buffer.alloc(bytes));
    writeFileSync(join(dir, String(id), 'job.json'), JSON.stringify({ id: String(id), kind: { name: 'k' }, state: 'done', final: { state: 'done' }, final_sent: true, ended_at: ended, outputs: [] }));
  };
  done(1, 100, 3000);
  done(2, 200, 3000);
  done(3, 300, 3000);
  // About 9 KB used under a 12 KB cap.
  const r = runner(block({ dir, max_disk_gb: 12_000 / 1024 ** 3 }));
  await r.ready;
  // Needs 40 KB: even deleting all three wouldn't do it, so none goes.
  assert.equal(r.makeRoom(40_000), false);
  assert.deepEqual(['1', '2', '3'].filter((id) => existsSync(join(dir, id))), ['1', '2', '3']);
  // Needs 5 KB: the oldest one is enough.
  assert.equal(r.makeRoom(5000), true);
  assert.deepEqual(['1', '2', '3'].filter((id) => existsSync(join(dir, id))), ['2', '3']);
});

test('an upload the app answers with a 5xx is tried again without a reconnect', async () => {
  const r = runner();
  const msg = start();
  await r.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  writeFileSync(join(jobsDir, String(msg.id), 'out', 'result.txt'), 'words');
  app.uploadStatus = 503;
  try {
    exitContainer(msg.id, 0);
    await until('uploading', () => lastState(msg.id)?.state === 'uploading', 6000, statesTail);
    const before = app.rejected;
    await until('a second rejected upload attempt', () => app.rejected >= before + 2, 6000, statesTail);
    assert.notEqual(lastState(msg.id)!.state, 'done');
  } finally {
    app.uploadStatus = 201;
  }
  await until('done', () => lastState(msg.id)?.state === 'done', 4000, statesTail);
  assert.equal(app.uploads.get(`${msg.id}/result.txt`)?.toString(), 'words');
});

test('an input the app answers with a 5xx is fetched again', async () => {
  const r = runner();
  const msg = start();
  const data = app.inputs.get(`${msg.id}/clip.wav`)!;
  app.inputs.delete(`${msg.id}/clip.wav`);
  inputFlaky.set(`${msg.id}/clip.wav`, { left: 1, data });
  await r.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 8000, statesTail);
  assert.equal(readFileSync(join(jobsDir, String(msg.id), 'in', 'clip.wav')).toString(), data.toString());
  // The GPU slot is free for the next test's runner, which reads the same jobs folder.
  await r.handle({ type: 'job.stop', id: msg.id });
  await until('stopped', () => lastState(msg.id)?.state === 'stopped', 6000, statesTail);
});

test('podman wait failing while the container still runs does not end the job', async () => {
  const r = runner();
  const msg = start();
  await r.handle(msg);
  await until('running', () => lastState(msg.id)?.state === 'running', 6000, statesTail);
  setBox(msg.id, { status: 'running', waitFails: true });
  // One wait runs at a time and the failing one takes the flag down, so a second wait with the flag down is the new
  // attempt. Clearing the flag from here raced the fake: a wait logs its argv before it reads the flag.
  const waits = () => podmanCalls().filter((c) => c.join(' ') === `wait citadel-job-${msg.id}`).length;
  await until('another wait attempt after the failed one', () => container(msg.id).waitFails === false && waits() >= 2, 6000, statesTail);
  assert.equal(lastState(msg.id)!.state, 'running');
  exitContainer(msg.id, 0);
  await until('done', () => lastState(msg.id)?.state === 'done', 6000, statesTail);
});
