// CI runner agent jobs (#328): the hub sends a job down the agent's stream and waits for its answer; RunnerJobs
// lets only members ask, picks the agent that may act for the scheme, checks GitHub shows the runners Idle,
// and notes every ask and outcome for the Taskmaster. GitHub and the agent are faked; nothing reaches either.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, test } from 'node:test';
import { runnerAsk, RunnerJobs, RunnerTokens } from '../src/ci-runner.ts';
import { Credentials } from '../src/credentials.ts';
import { Store } from '../src/db.ts';
import { GithubLink } from '../src/github-link.ts';
import { MachineRelay } from '../src/machines.ts';

/** An agent's event stream: what the hub writes to it, parsed. */
function stream() {
  const res = new EventEmitter() as EventEmitter & ServerResponse & { sent: any[] };
  res.sent = [];
  Object.assign(res, {
    writableLength: 0,
    writeHead() {},
    write(chunk: string) {
      for (const line of String(chunk).split('\n')) if (line.startsWith('data: ')) res.sent.push(JSON.parse(line.slice(6)));
      return true;
    },
    end() { res.emit('close'); },
  });
  return res;
}

/** GitHub: mints tokens for Cara and lists the repo's runners from `runners`. */
function fakeGithub() {
  const calls: string[] = [];
  const runners: { name: string; status: string; busy: boolean; labels: { name: string }[] }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = url.replace('https://api.github.com', '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (String((init?.headers as any)?.Authorization) !== 'Bearer gho_cara') return Response.json({ message: 'Bad credentials' }, { status: 401 });
    if (path.startsWith('/repos/caraminden/peek-auras/actions/runners?')) return Response.json({ total_count: runners.length, runners });
    return Response.json({ message: 'unfaked' }, { status: 500 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, runners };
}

// Each connected agent holds a ping timer until its stream closes.
const relays: { relay: MachineRelay; store: Store }[] = [];
afterEach(() => {
  for (const { relay, store } of relays.splice(0)) for (const m of store.listMachines()) relay.disconnect(m.id);
});

function world() {
  const store = new Store(':memory:');
  const creds = new Credentials(store, 'secret');
  const link = new GithubLink(store, creds, 'client', 'shh');
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const olive = store.createUser({ name: 'Olive', login: 'olive' });
  const scheme = store.createProject('Peek Auras', 'https://github.com/caraminden/peek-auras.git', cara.id);
  const other = store.createProject('Other', 'https://github.com/caraminden/other.git', cara.id);
  store.addMember(scheme.id, josh.id);
  creds.put(cara.id, 'github', 'gho_cara', { login: 'caraminden', id: 1, name: null });
  const gh = fakeGithub();
  const tokens = new RunnerTokens(store, link, true, gh.fetch);
  const relay = new MachineRelay(store, () => {});
  relays.push({ relay, store });
  const jobs = new RunnerJobs(store, tokens, relay, 200, 10);
  const notes: string[] = [];
  jobs.onNote = (p, words) => notes.push(`${p.name}: ${words}`);
  const pc = store.createMachine('cara-desktop-runners', 'x', 'Cara', cara.id, true);
  const agent = stream();
  relay.connectAgent(pc, agent, { host: 'DESKTOP-G248IJ8', command: 'citadel runner agent', runners: true });
  /** Answer the last job the agent got. */
  const answer = (ok: boolean, output: string) => {
    const job = agent.sent.filter((m) => m.runners).at(-1).runners;
    assert.equal(relay.runnerResult(pc, { id: job.id, ok, output }), true);
    return job;
  };
  return { store, cara, josh, olive, scheme, other, gh, relay, jobs, notes, pc, agent, answer };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('asks are checked: an op, and a count of 1 to 4 for add only', () => {
  assert.deepEqual(runnerAsk({ op: 'add' }), { op: 'add', count: 1 });
  assert.deepEqual(runnerAsk({ op: 'add', count: 4 }), { op: 'add', count: 4 });
  assert.deepEqual(runnerAsk({ op: 'list' }), { op: 'list', count: null });
  for (const bad of [{ op: 'run' }, {}, { op: 'add', count: 5 }, { op: 'add', count: 0 }, { op: 'add', count: 1.5 }, { op: 'add', count: '2' }, { op: 'remove', count: 1 }]) {
    assert.throws(() => runnerAsk(bad), { status: 400 }, JSON.stringify(bad));
  }
});

test('a runner agent is never offered to turns as an MCP machine, and whatever it says it offers is ignored', () => {
  const w = world();
  assert.deepEqual(w.relay.online(), []);
  w.relay.setInfo(w.pc, { servers: ['mcp', 'ws'] });
  assert.deepEqual(w.relay.online(), []);
  assert.deepEqual(w.relay.runnerMachines().map((m) => m.name), ['cara-desktop-runners']);
  assert.equal(w.relay.view(w.pc).runners, true);
});

test('a member\'s add goes to the agent, waits for GitHub to show the runners Idle, and both ends are noted', async () => {
  const w = world();
  const started = await w.jobs.start(w.scheme, w.josh.id, { op: 'add', count: 2 });
  assert.equal(started.ok, null);
  assert.equal(started.machine, 'cara-desktop-runners');
  assert.match(w.notes[0], /^Peek Auras: Josh asked the runner agent on cara-desktop-runners to add 2 CI runners for caraminden\/peek-auras \(label peek-auras-ci\)\.$/);
  const job = w.answer(true, 'Done: 2 runners');
  assert.deepEqual({ ...job, id: undefined }, { id: undefined, op: 'add', scheme: w.scheme.id, count: 2 });
  // GitHub lists them a moment later, one Idle, then both; another scheme's runner doesn't count.
  w.gh.runners.push({ name: 'DESKTOP-G248IJ8', status: 'online', busy: false, labels: [{ name: 'peek-auras-ci' }] }, { name: 'X', status: 'online', busy: false, labels: [{ name: 'delve-ci' }] });
  await tick();
  assert.equal((await w.jobs.wait(w.scheme.id, 0))!.ok, null, 'still waiting on the second');
  w.gh.runners.push({ name: 'DESKTOP-G248IJ8-2', status: 'online', busy: false, labels: [{ name: 'peek-auras-ci' }] });
  const done = (await w.jobs.wait(w.scheme.id, 1000))!;
  assert.equal(done.ok, true);
  assert.match(done.text, /Done: 2 runners\n\nOn GitHub \(label peek-auras-ci\): DESKTOP-G248IJ8 Idle, DESKTOP-G248IJ8-2 Idle$/);
  assert.match(w.notes[1], /^Peek Auras: Runner agent on cara-desktop-runners, add for Peek Auras \(asked by Josh\): done\./);
  assert.ok(w.gh.calls.every((c) => !/token/.test(c)), 'Citadel itself mints nothing: the scripts on the PC do');
});

test('an add whose runners never show Idle on GitHub fails, saying what GitHub showed', async () => {
  const w = world();
  await w.jobs.start(w.scheme, w.cara.id, { op: 'add', count: 1 });
  w.answer(true, 'Done');
  w.gh.runners.push({ name: 'DESKTOP-G248IJ8', status: 'offline', busy: false, labels: [{ name: 'peek-auras-ci' }] });
  const done = (await w.jobs.wait(w.scheme.id, 2000))!;
  assert.equal(done.ok, false);
  assert.match(done.text, /DESKTOP-G248IJ8 offline; fewer than 1 Idle after 0s/);
  assert.match(w.notes[1], /FAILED/);
});

test('only members ask; one job per scheme and per agent; a failed or lost job comes back as failed', async () => {
  const w = world();
  await assert.rejects(w.jobs.start(w.scheme, w.olive.id, { op: 'list', count: null }), { status: 403, message: /Only Peek Auras's members/ });
  await assert.rejects(w.jobs.start(w.scheme, null, { op: 'list', count: null }), { status: 403 });
  w.store.updateUser(w.josh.id, { disabled_at: Date.now() });
  await assert.rejects(w.jobs.start(w.scheme, w.josh.id, { op: 'list', count: null }), { status: 403 });
  assert.equal(w.notes.length, 0, 'a refused ask reaches neither the PC nor the chat');
  assert.equal(w.agent.sent.filter((m) => m.runners).length, 0);

  await w.jobs.start(w.scheme, w.cara.id, { op: 'remove', count: null });
  await assert.rejects(w.jobs.start(w.scheme, w.cara.id, { op: 'list', count: null }), { status: 409, message: /already has a runner job running/ });
  await assert.rejects(w.jobs.start(w.other, w.cara.id, { op: 'list', count: null }), { status: 409, message: /busy with another scheme's job/ });
  const job = w.answer(false, 'remove-runner: no runner of this scheme here');
  assert.deepEqual({ ...job, id: undefined }, { id: undefined, op: 'remove', scheme: w.scheme.id });
  const done = (await w.jobs.wait(w.scheme.id, 1000))!;
  assert.equal(done.ok, false);
  assert.match(done.text, /no runner of this scheme here/);

  // The agent drops mid-job: the job ends as failed instead of hanging.
  await w.jobs.start(w.other, w.cara.id, { op: 'list', count: null });
  w.relay.disconnect(w.pc.id);
  const lost = (await w.jobs.wait(w.other.id, 1000))!;
  assert.equal(lost.ok, false);
  assert.match(lost.text, /went offline/);
  await assert.rejects(w.jobs.start(w.other, w.cara.id, { op: 'list', count: null }), { status: 409, message: /No CI runner agent that may act for Other is online/ });
});

test('an agent only answers its own jobs, and a machine that may not act for the scheme is never picked', async () => {
  const w = world();
  await w.jobs.start(w.scheme, w.josh.id, { op: 'list', count: null });
  const job = w.agent.sent.find((m) => m.runners).runners;
  const stranger = w.store.createMachine('olive-pc', 'y', 'Olive', w.olive.id, true);
  assert.equal(w.relay.runnerResult(stranger, { id: job.id, ok: true, output: 'forged' }), false);
  assert.equal(w.relay.runnerResult(w.pc, { id: 'nope', ok: true, output: '' }), false);
  w.answer(true, 'actions.runner.x Running');
  assert.equal((await w.jobs.wait(w.scheme.id, 1000))!.ok, true);

  // Olive's own runner agent can't act for Peek Auras, so with Cara's gone there is none to pick.
  const w2 = world();
  w2.relay.disconnect(w2.pc.id);
  const olivePc = w2.store.createMachine('olive-pc', 'y', 'Olive', w2.olive.id, true);
  w2.relay.connectAgent(olivePc, stream(), { host: 'h', command: 'c', runners: true });
  await assert.rejects(w2.jobs.start(w2.scheme, w2.josh.id, { op: 'list', count: null }), { status: 409, message: /No CI runner agent/ });
});

test('a scheme with no repo or no owner GitHub link fails before the PC is asked', async () => {
  const w = world();
  const bare = w.store.createProject('Bare', null, w.cara.id);
  await assert.rejects(w.jobs.start(bare, w.cara.id, { op: 'add', count: 1 }), { status: 409, message: /no GitHub repo/ });
  assert.equal(w.agent.sent.filter((m) => m.runners).length, 0);
});
