// CI runner agent jobs (#328): the hub sends a job down the agent's stream and waits for its answer; RunnerJobs
// lets only members ask, picks the agent that may act for the scheme, checks GitHub shows the runners Idle,
// and notes each add's or remove's outcome for the Taskmaster, once (#339); a list notes nothing. GitHub and the agent are faked; nothing reaches either.
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

function world(idleMs = 10_000) {
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
  const jobs = new RunnerJobs(store, tokens, relay, idleMs, 10);
  const notes: string[] = [];
  const details: string[] = [];
  jobs.onNote = (p, words, detail) => { notes.push(`${p.name}: ${words}`); details.push(detail); };
  const pc = store.createMachine('cara-desktop-runners', 'x', 'Cara', cara.id);
  const agent = stream();
  relay.connectAgent(pc, agent, { host: 'DESKTOP-G248IJ8', command: 'citadel runner agent', runners: true });
  /** Answer the last job the agent got. */
  const answer = (ok: boolean, output: string) => {
    const job = agent.sent.filter((m) => m.runners).at(-1).runners;
    assert.equal(relay.runnerResult(pc, { id: job.id, ok, output }), true);
    return job;
  };
  return { store, cara, josh, olive, scheme, other, gh, relay, jobs, notes, details, pc, agent, answer };
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

test('a member\'s add goes to the agent, waits for GitHub to show the runners Idle, and posts one note when it ends', async () => {
  const w = world();
  const started = await w.jobs.start(w.scheme, w.josh.id, { op: 'add', count: 2 });
  assert.equal(started.ok, null);
  assert.equal(started.machine, 'cara-desktop-runners');
  assert.equal(w.notes.length, 0, 'no note for the ask itself');
  const job = w.answer(true, 'Done: 2 runners');
  assert.deepEqual({ ...job, id: undefined }, { id: undefined, op: 'add', scheme: w.scheme.id, count: 2 });
  // GitHub lists them a moment later, one Idle, then both; another scheme's runner doesn't count.
  w.gh.runners.push({ name: 'DESKTOP-G248IJ8', status: 'online', busy: false, labels: [{ name: 'peek-auras-ci' }] }, { name: 'X', status: 'online', busy: false, labels: [{ name: 'delve-ci' }] });
  await tick();
  assert.equal((await w.jobs.wait(w.scheme.id, 0))!.ok, null, 'still waiting on the second');
  w.gh.runners.push({ name: 'DESKTOP-G248IJ8-2', status: 'online', busy: false, labels: [{ name: 'peek-auras-ci' }] });
  const done = (await w.jobs.wait(w.scheme.id, 5000))!;
  assert.equal(done.ok, true);
  assert.match(done.text, /Done: 2 runners\n\nOn GitHub \(label peek-auras-ci\): DESKTOP-G248IJ8 Idle, DESKTOP-G248IJ8-2 Idle$/);
  assert.deepEqual(w.notes, ['Peek Auras: ✓ Josh added 2 CI runners for Peek Auras on cara-desktop-runners']);
  assert.equal(w.details[0], done.text, 'the output goes under the note, line breaks kept');
  assert.ok(w.gh.calls.every((c) => !/token/.test(c)), 'Citadel itself mints nothing: the scripts on the PC do');
});

test('an add whose runners never show Idle on GitHub fails, saying what GitHub showed', async () => {
  const w = world(200);
  await w.jobs.start(w.scheme, w.cara.id, { op: 'add', count: 1 });
  w.answer(true, 'Done');
  w.gh.runners.push({ name: 'DESKTOP-G248IJ8', status: 'offline', busy: false, labels: [{ name: 'peek-auras-ci' }] });
  const done = (await w.jobs.wait(w.scheme.id, 2000))!;
  assert.equal(done.ok, false);
  assert.match(done.text, /DESKTOP-G248IJ8 offline; fewer than 1 Idle after 0s/);
  assert.deepEqual(w.notes, ['Peek Auras: ✗ Cara tried to add 1 CI runner for Peek Auras on cara-desktop-runners, and it failed: On GitHub (label peek-auras-ci): DESKTOP-G248IJ8 offline; fewer than 1 Idle after 0s']);
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
  const stranger = w.store.createMachine('olive-pc', 'y', 'Olive', w.olive.id);
  assert.equal(w.relay.runnerResult(stranger, { id: job.id, ok: true, output: 'forged' }), false);
  assert.equal(w.relay.runnerResult(w.pc, { id: 'nope', ok: true, output: '' }), false);
  w.answer(true, 'actions.runner.x Running');
  assert.equal((await w.jobs.wait(w.scheme.id, 1000))!.ok, true);

  // Olive's own runner agent can't act for Peek Auras, so with Cara's gone there is none to pick.
  const w2 = world();
  w2.relay.disconnect(w2.pc.id);
  const olivePc = w2.store.createMachine('olive-pc', 'y', 'Olive', w2.olive.id);
  w2.relay.connectAgent(olivePc, stream(), { host: 'h', command: 'c', runners: true });
  await assert.rejects(w2.jobs.start(w2.scheme, w2.josh.id, { op: 'list', count: null }), { status: 409, message: /No CI runner agent/ });
});

test('a scheme with no repo or no owner GitHub link fails before the PC is asked', async () => {
  const w = world();
  const bare = w.store.createProject('Bare', null, w.cara.id);
  await assert.rejects(w.jobs.start(bare, w.cara.id, { op: 'add', count: 1 }), { status: 409, message: /no GitHub repo/ });
  assert.equal(w.agent.sent.filter((m) => m.runners).length, 0);
});

test('a list notes nothing; a remove notes once, failed or not; a token its scripts fetch goes under its note', async () => {
  const w = world();
  await w.jobs.start(w.scheme, w.josh.id, { op: 'list', count: null });
  w.answer(true, 'actions.runner.a Running\nactions.runner.b Running');
  assert.equal((await w.jobs.wait(w.scheme.id, 1000))!.ok, true);
  assert.deepEqual(w.notes, [], 'a list changes nothing, and the caller already has its output');

  await w.jobs.start(w.scheme, w.josh.id, { op: 'remove', count: null });
  // The PC's remove script fetches a removal token with the agent's key while the job runs: no note of its own.
  assert.equal(w.jobs.absorb(w.scheme, w.pc, 'Machine cara-desktop-runners fetched a CI runner removal token'), true);
  const stranger = w.store.createMachine('olive-pc', 'y', 'Olive', w.olive.id);
  assert.equal(w.jobs.absorb(w.scheme, stranger, 'other'), false, 'another machine\'s token is noted as before');
  assert.equal(w.jobs.absorb(w.other, w.pc, 'other'), false, 'so is one for a scheme with no job running');
  w.answer(true, 'Removed actions.runner.a\nRemoved actions.runner.b');
  await w.jobs.wait(w.scheme.id, 1000);
  assert.deepEqual(w.notes, ["Peek Auras: ✓ Josh removed Peek Auras's CI runners on cara-desktop-runners"]);
  assert.equal(w.details[0], 'Machine cara-desktop-runners fetched a CI runner removal token\nRemoved actions.runner.a\nRemoved actions.runner.b');
  assert.equal(w.jobs.absorb(w.scheme, w.pc, 'later'), false, 'once the job ends, tokens are noted as before');

  await w.jobs.start(w.scheme, w.cara.id, { op: 'remove', count: null });
  w.answer(false, Array.from({ length: 70 }, (_, i) => `line ${i + 1}`).join('\n'));
  await w.jobs.wait(w.scheme.id, 1000);
  assert.equal(w.notes[1], "Peek Auras: ✗ Cara tried to remove Peek Auras's CI runners on cara-desktop-runners, and it failed: line 70");
  const kept = w.details[1].split('\n');
  assert.deepEqual([kept[0], kept[1], kept.at(-1), kept.length], ['(10 earlier lines left out)', 'line 11', 'line 70', 61]);
});
