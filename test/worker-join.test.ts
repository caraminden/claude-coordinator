// Joining a machine as a worker and its self-test (Build 7 T5): the rules of the server's side (src/worker-join.ts) on a
// clock of the test's, then the real program (public/worker-agent.mjs) against the real server, with a stand-in podman
// that runs the "container's" commands here. Real podman, WSL and Windows are not in it.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { agentConfig, interopOff, WorkerAgent } from '../public/worker-agent.mjs';
import { Worker } from '../public/machine-worker.mjs';
import type { Machine } from '../src/db.ts';
import { cleanCaps, WorkerJoin } from '../src/worker-join.ts';
import { bootServer, ok, tempRoot, until } from './helpers.ts';

const scratch = tempRoot('worker-join-');
const root = scratch.dir;
after(() => scratch.teardown());

const CAPS = { workers: 2, threads: 4, memory_gb: 8, disk_gb: 60 };

/** The server's side alone, with a clock and a worker that syncs when told. */
function joined() {
  const settings = new Map<string, unknown>();
  const machine = { id: 7, name: 'pc', owner_id: 1 } as Machine;
  const at = { now: 1_000_000, sync: 1_000_000, lends: true, ships: false, changed: 0, claude: '2.0.0 (Claude Code)' as string | null, signedIn: true as boolean | null };
  const join = new WorkerJoin({
    store: {
      getSetting: ((k: string, d: unknown) => settings.get(k) ?? d) as never,
      setSetting: ((k: string, v: unknown) => (v === null ? settings.delete(k) : settings.set(k, v))) as never,
      listMachines: () => [machine],
    },
    lends: () => at.lends,
    ships: () => at.ships,
    info: () => (at.sync ? { claude: at.claude, max: 2, at: at.sync, signedIn: at.signedIn } : null),
    claude: async () => '2.0.0 (Claude Code)',
    changed: () => void at.changed++,
    now: () => at.now,
  });
  const say = (over: Record<string, unknown> = {}) => join.report(machine, { boot: 'a', installed: 1, host: 'PC', wsl: true, caps: CAPS, image: { state: 'ready', text: 'x' }, github: true, disk_gb: 3, full: false, ...over });
  return { join, machine, at, say, settings };
}
const all = (id: string, over: Record<string, string> = {}, done = true) => ({ id, done, lines: ['image', 'folders', 'sync', 'process', 'link', 'tools', 'disk', 'programs', 'turn'].map((key) => ({ key, state: over[key] ?? 'ok', text: key })) });

test('a worker is here by its syncs; away, the row keeps its host and caps and nothing that may have changed', async () => {
  const { join, machine, at, say } = joined();
  await say({ pc: { threads: 32.9, memory_gb: 31 } });
  assert.deepEqual([join.view(machine).here, join.view(machine).signed_in, join.view(machine).github], [true, true, true]);
  assert.deepEqual(join.view(machine).pc, { threads: 32, memory_gb: 31 }, 'the PC size it reports reaches the row (#2250)');
  await say({ pc: { threads: 'lots', memory_gb: -1 } });
  assert.equal(join.view(machine).pc, null, 'a size that is not a count is dropped');
  at.now += 10_001;
  const away = join.view(machine);
  assert.deepEqual([away.here, away.seen, away.host, away.wsl], [false, at.sync, 'PC', true]);
  assert.deepEqual(away.caps, CAPS);
  assert.deepEqual([away.signed_in, away.github, away.image, away.disk_gb], [null, null, null, null]);
});

test('a worker says only whether a sign-in is there: anything else in its word is dropped', async () => {
  const { join, machine, say, settings } = joined();
  await say({ github: 'gho_secret', token: 'sk-secret', host: { a: 'secret' }, caps: { ...CAPS, key: 'secret' } });
  assert.equal(join.view(machine).github, null);
  assert.doesNotMatch(JSON.stringify([join.view(machine), [...settings]]), /secret/);
  assert.equal(cleanCaps({ ...CAPS, workers: -1 }), null);
  assert.equal(cleanCaps({ ...CAPS, workers: '6' }), null);
});

test('of two workers on one token the newest install has it, also after a reboot of the other; the old one ends its turns first', async () => {
  const { at, say, join, machine } = joined();
  assert.deepEqual(await say({ boot: 'old', installed: 10 }), { ...(await say({ boot: 'old', installed: 10 })), wait: false }, 'one alone has nothing to wait for');
  at.now += 2000;
  assert.equal(((await say({ boot: 'new', installed: 20 })) as { wait: boolean }).wait, true);
  assert.deepEqual(await say({ boot: 'old', installed: 10 }), { replaced: true });
  assert.equal(join.host(7), 'PC');
  assert.deepEqual([join.refuses(7, 'new'), join.refuses(7, 'old'), join.view(machine).twice], [false, true, false], "another boot of the program is refused, and isn't two workers");
  assert.deepEqual([join.refuses(7, undefined), join.view(machine).twice], [true, true], 'a sync with no header is an agent block');
  at.now += 10_000;
  assert.equal(((await say({ boot: 'new', installed: 20 })) as { wait: boolean }).wait, false);
  at.now += 3_600_000;
  assert.deepEqual(await say({ boot: 'old-rebooted', installed: 10 }), { replaced: true }, 'kept, with nothing live to compare');
  assert.equal('replaced' in (await say({ boot: 'new-rebooted', installed: 20 })), false);
  // A clock a year ahead is taken as now, so a later install elsewhere still wins.
  await say({ boot: 'ahead', installed: at.now + 365 * 86_400_000 });
  at.now += 1000;
  assert.equal('replaced' in (await say({ boot: 'later', installed: at.now })), false);
});

test('no turn until its self-test passes once, nor while it fails, its disk is full or its image is not there', async () => {
  const { join, machine, at, say } = joined();
  assert.equal(join.hold(7), null, 'one set up by hand has no self-test of this kind');
  await say();
  assert.match(join.hold(7)!, /not passed yet/);
  await say({ test: all(join.startTest(machine).id) });
  assert.equal(join.hold(7), null);
  await say({ full: true, disk_gb: 61 });
  assert.equal(join.hold(7), 'it is at its disk cap (61 of 60 GB)');
  await say({ image: { state: 'building', text: '' } });
  assert.match(join.hold(7)!, /being built/);
  await say({ image: { state: 'failed', text: '' } });
  assert.match(join.hold(7)!, /could not be built/);
  await say();
  await say({ test: all(join.startTest(machine).id, { link: 'fail' }) });
  assert.match(join.hold(7)!, /self-test failed/);
  at.ships = true;
  assert.equal(((await say()) as { ships: boolean }).ships, true, "its program hears that a ship's tests run there");
});

/** The self-test an answer asks for. */
const told = (answer: object) => ('test' in answer ? answer.test : null);

test('a self-test: its lines as they come, the last full pass kept over a failure and a restart', async () => {
  const { join, machine, at, say, settings } = joined();
  await say();
  const first = join.startTest(machine);
  assert.equal(told(await say()), first.id, 'its worker hears of it at its next word');
  await say({
    test: {
      id: first.id,
      done: false,
      lines: [
        { key: 'image', state: 'ok', text: 'claude 2' },
        { key: 'folders', state: 'running' },
        { key: 'made-up', state: 'ok' },
      ],
    },
  });
  assert.deepEqual(
    join
      .view(machine)
      .test!.lines.slice(0, 3)
      .map((l) => l.state),
    ['ok', 'running', 'waiting'],
  );
  await say({ test: all('some-other-test') });
  assert.equal(join.view(machine).test!.done, null, "another test's end is not this one's");
  at.now += 5000;
  at.sync = at.now;
  await say({ test: all(first.id) });
  assert.deepEqual([join.view(machine).test!.ok, join.view(machine).passed], [true, at.now]);
  const passed = at.now;
  const second = join.startTest(machine);
  await say({ test: all(second.id, { link: 'fail' }) });
  assert.deepEqual([join.view(machine).test!.ok, join.view(machine).passed], [false, passed]);
  // A server started again has only what was kept.
  assert.equal((settings.get('worker-join:7') as { passed: number }).passed, passed);
  join.forget(7);
  assert.equal(settings.size, 0);
});

test('a test cut off before every line passed is not a pass, and one whose worker left ends saying so', async () => {
  const { join, machine, at, say } = joined();
  await say();
  const t = join.startTest(machine);
  await say({ test: { id: t.id, done: true, lines: [{ key: 'image', state: 'ok' }] } });
  assert.deepEqual([join.view(machine).test!.ok, join.view(machine).passed], [false, null]);
  join.startTest(machine);
  at.now += 60_001;
  join.tick();
  assert.match(join.view(machine).test!.why!, /went away/);
  at.sync = at.now;
  join.startTest(machine);
  at.now += 20 * 60_000 + 1;
  at.sync = at.now;
  join.tick();
  assert.match(join.view(machine).test!.why!, /stopped reporting/);
});

test('people hear of a row only when something they see changed', async () => {
  const { join, at, say } = joined();
  await say();
  join.tick();
  const before = at.changed;
  at.now += 2000;
  at.sync = at.now;
  await say();
  join.tick();
  assert.equal(at.changed, before);
  await say({ github: false });
  join.tick();
  assert.equal(at.changed, before + 1);
});

test('the scratch repo has to come back with the answer on top of what was sent', async () => {
  const { join, machine, say } = joined();
  await say();
  assert.equal(await join.sendScratch(7), null, 'no test, no repo');
  join.startTest(machine);
  const { bundle } = (await join.sendScratch(7))!;
  assert.equal(await join.takeScratch(7, 'bm90IGEgYnVuZGxl'), 'what came back is not a git bundle');
  assert.equal(await join.takeScratch(7, bundle), 'what came back is not built on what was sent', 'the same repo, untouched');
});

test('the config is checked', () => {
  assert.deepEqual(agentConfig({ root: '/w', ...CAPS }).caps, CAPS);
  assert.throws(() => agentConfig({ root: 'w', ...CAPS }), /full path/);
  assert.throws(() => agentConfig({ root: '/w', ...CAPS, workers: 0 }), /workers must be/);
  assert.throws(() => agentConfig({ root: '/w', ...CAPS, disk_gb: undefined }), /disk_gb must be/);
});

/** A stand-in podman, and what it was asked: images it "built", a home volume in a folder, exec run here. */
function fakePodman(workRoot: string) {
  const asked: string[] = [];
  const built = new Set<string>();
  const home = join(workRoot, 'home-volume');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const state = { kb: 1_048_576, buildFails: false, breakSync: false, from: '' };
  const signedIn = () => existsSync(join(home, '.claude', '.credentials.json'));
  const run = (cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> => {
    const all = cmd === 'nice' ? args.slice(3) : args;
    const line = all.join(' ');
    if (cmd === 'findmnt') return Promise.resolve({ code: 0, out: 'shared\n', err: '' });
    asked.push(line);
    const said = (out: string, code = 0, err = '') => Promise.resolve({ code, out, err });
    if (all[0] === 'image' && all[1] === 'exists') return said('', built.has(all[2]) ? 0 : 1);
    if (all[0] === 'build') {
      if (state.buildFails) return said('', 1, 'step 3\nno space left on device');
      built.add(all[2]);
      return said('');
    }
    if (line.endsWith('claude --version')) return said('2.4.11 (Claude Code)\n');
    if (all[0] === 'unshare') return said(`5\t/a\n${state.kb}\ttotal\n`);
    if (all[0] === 'volume' && all[1] === 'inspect') return said(`${home}\n`);
    if (all[0] === 'volume' && all[1] === 'ls') return said('citadel-worker-home\n');
    if (line.includes('.credentials.json')) return said(signedIn() ? 'yes\n' : 'no\n');
    if (all[0] === 'container' && state.from) return said(`${state.from}\n`);
    if (all[0] === 'container') return said('', 1);
    if (all[0] !== 'exec') return said('');
    const detached = all[1] === '-d';
    // A container has no /mnt/c and no /run/WSL, whatever this PC has: CI's runner is itself a WSL distro.
    const sh = all[all.length - 1]
      .replaceAll('/citadel-self-test', join(workRoot, 'self-test', 'fs', 'citadel-self-test'))
      .replaceAll('/mnt/c', join(workRoot, 'not-in-the-container', 'mnt-c'))
      .replaceAll('/run/WSL', join(workRoot, 'not-in-the-container', 'run-WSL'));
    if (sh.includes('host-tools.ts')) return said(sh.includes('cd ') && existsSync(join(workRoot, 'self-test/fs/citadel-self-test/scratch/repo/deploy/host-tools.json')) ? 'all there\n' : '', 0);
    if (state.breakSync && sh.includes('git clone')) return said('', 1, 'fatal: no');
    return new Promise((done) => {
      const child = execFile('sh', ['-c', sh], (err, out, stderr) => (detached ? null : done({ code: err ? Number(err.code) || 1 : 0, out, err: stderr })));
      if (detached) {
        child.unref();
        done({ code: 0, out: '', err: '' });
      }
    });
  };
  return { run, asked, built, home, state };
}

test('the program joins: builds its image, says its sign-ins, holds the disk cap, and takes the self-test to green', async () => {
  const bin = join(root, 'claude');
  writeFileSync(bin, '#!/bin/sh\necho "2.4.11 (Claude Code)"\n');
  chmodSync(bin, 0o755);
  const srv = await bootServer({ root: join(root, 'srv'), env: { CLAUDE_BIN: bin } });
  let agent: WorkerAgent | null = null;
  try {
    const scheme = ok(await srv.call('/api/projects', { name: 'Delve' })).id;
    const { machine, token } = ok(await srv.call('/api/machines', { name: 'pc', mine: true }));
    const view = async () => (await srv.call('/api/machines')).data.find((m: { id: number }) => m.id === machine.id);
    const patch = (body: object, cookie?: string) => fetch(`${srv.base}/api/machines/${machine.id}`, { method: 'PATCH', headers: { cookie: cookie ?? srv.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    // The switch: off until its owner says so; another person can't turn it on.
    assert.equal((await view()).worker.on, false);
    const made = ok(await srv.call('/api/people', { name: 'Rin' }));
    const invited = await fetch(`${srv.base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-password' }) });
    const theirs = invited.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await patch({ worker: true }, theirs)).ok, false);
    assert.equal((await patch({ worker: 'yes' })).status, 400);
    assert.equal((await srv.call(`/api/machines/${machine.id}/self-test`, {})).status, 409, 'off, there is nothing to test');
    assert.equal((await patch({ worker: true })).status, 200);
    assert.equal((await patch({ projects: [scheme] })).status, 200);
    assert.equal((await srv.call(`/api/machines/${machine.id}/self-test`, {})).status, 409, 'nor with no worker there');

    // Its tick list saved afterwards, as the page saves it, keeps the switch.
    assert.equal((await patch({ lend: { server: null, workspaces: [], gpu_off: true } })).status, 200);
    assert.equal((await view()).worker.on, true);

    const work = join(root, 'work');
    mkdirSync(work);
    const pod = fakePodman(work);
    let left: number | null = null;
    const synced = new Set<string>();
    class Watched extends Worker {
      sync() {
        synced.add(this.cfg.container);
        return super.sync();
      }
    }
    const log: string[] = [];
    agent = new WorkerAgent({ config: { root: work, ...CAPS }, appUrl: srv.base, token, Worker: Watched, run: pod.run, log: (...a) => log.push(a.join(' ')), exit: (code) => void (left = code) });
    // As on a Linux PC, wherever the test runs (CI's runner is a WSL distro, whose own wsl.conf this would read).
    agent.wsl = false;
    assert.equal(agent.worker.cfg.max, 0, 'it takes no turn before it has an image');
    const going = agent.start();
    await until('its image', async () => (await view()).worker.image?.state === 'ready');
    assert.match(log.join('\n'), /^Connected to http/m, 'what the installer waits for');
    assert.equal(agent.worker.cfg.max, CAPS.workers);
    assert.deepEqual(readFileSync(join(work, 'image', 'Containerfile')), readFileSync(join(import.meta.dirname, '..', 'deploy', 'claude-container', 'Containerfile')), "the build files are the app's");
    assert.match(readFileSync(join(work, 'image-claude', 'Containerfile'), 'utf8'), /claude-code@2\.4\.11 /);
    assert.deepEqual(readFileSync(join(work, 'image', 'worker', 'Containerfile')), readFileSync(join(import.meta.dirname, '..', 'deploy', 'worker-image', 'Containerfile')), 'and the worker layer, under worker/');
    const builds = pod.asked.filter((a) => a.startsWith('build'));
    assert.equal(builds.length, 3, 'built once, in three steps');
    assert.match(builds[1], /^build -t localhost\/citadel-worker-tools:[0-9a-f]{12} -f \S+\/image\/worker\/Containerfile --build-arg BASE=localhost\/citadel-worker-base:[0-9a-f]{12} /, 'the worker layer on the base');
    assert.match(readFileSync(join(work, 'image-claude', 'Containerfile'), 'utf8'), /^FROM localhost\/citadel-worker-tools:/, 'claude on the worker layer');
    assert.ok(pod.built.has(readFileSync(join(work, 'image-tag'), 'utf8')));
    const here = (await view()).worker;
    assert.deepEqual(here.caps, CAPS);
    assert.deepEqual([here.here, here.disk_gb, here.full, here.claude_wanted], [true, 1, false, null]);

    // Sign-ins: that they are there.
    await until('no sign-in', async () => (await view()).worker.signed_in === false);
    writeFileSync(join(pod.home, '.claude', '.credentials.json'), '{"secret":"sk-worker-secret"}');
    mkdirSync(join(pod.home, '.config', 'gh'), { recursive: true });
    writeFileSync(join(pod.home, '.config', 'gh', 'hosts.yml'), 'oauth_token: gho_worker_secret');
    agent.at.signIn = 0;
    await until('both sign-ins', async () => {
      const w = (await view()).worker;
      return w.signed_in === true && w.github === true;
    });

    // The self-test, whole.
    ok(await srv.call(`/api/machines/${machine.id}/self-test`, {}));
    await until('the test', async () => (await view()).worker.test?.done);
    const test = (await view()).worker.test;
    assert.deepEqual(
      test.lines.filter((l: { state: string }) => l.state !== 'ok'),
      [],
      JSON.stringify(test),
    );
    assert.equal(test.ok, true);
    assert.match(test.lines.find((l: { key: string }) => l.key === 'link').text, /^\d+ Mbit\/s down, \d+ up, [\d.]+ ms$/);
    assert.ok((await view()).worker.passed);
    assert.equal(existsSync(join(work, 'self-test')), false, 'it leaves nothing');
    assert.deepEqual([...synced], ['citadel-worker'], "the test's own worker never asks for turns: it would be handed this machine's");

    // One that breaks says where; what depends on it says it wasn't tried.
    pod.state.breakSync = true;
    ok(await srv.call(`/api/machines/${machine.id}/self-test`, {}));
    await until('the failing test', async () => (await view()).worker.test?.ok === false && (await view()).worker.test?.done);
    const bad = Object.fromEntries((await view()).worker.test.lines.map((l: { key: string; state: string; text: string }) => [l.key, `${l.state}: ${l.text}`]));
    assert.equal(bad.sync, 'fail: git there: fatal: no');
    assert.match(bad.tools, /^fail: not tried/);
    assert.match(bad.process, /^ok/);

    // The disk cap: no new turn, and the row says so.
    pod.state.kb = 70 * 1_048_576;
    agent.at.disk = 0;
    await until('the disk cap', async () => (await view()).worker.full);
    assert.equal(agent.worker.cfg.max, 0);

    // An agent's worker block with this token: refused while this program is here, and the row says so.
    const second = await fetch(`${srv.base}/api/machines/turns`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ worker: { claude: '2.4.11 (Claude Code)', max: 2 }, turns: [] }) });
    assert.equal(second.status, 409);
    assert.match(((await second.json()) as { error: string }).error, /take the worker block out/);
    assert.equal((await view()).worker.twice, true);

    // A newer install with this machine's token: this one stops for good.
    const newer = await fetch(`${srv.base}/api/machines/worker`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ boot: 'newer', installed: Date.now() }) });
    assert.equal(newer.status, 200);
    await going;
    assert.equal(left, 64);
    assert.ok(pod.asked.includes('rm -f -t 0 citadel-worker'), 'its turns end with it: the other PC is handed them');

    // Switched off by its owner; the stored tick goes too.
    assert.equal((await patch({ worker: false })).status, 200);
    assert.equal((await view()).worker.on, false);
    assert.doesNotMatch(JSON.stringify(await view()) + log.join(), /secret/);
  } finally {
    agent?.stop();
    await srv.stop();
  }
});

test("Windows programs are off only when wsl.conf's own section says so", () => {
  assert.equal(interopOff('[automount]\nenabled=false\n[interop]\nenabled = false\n'), true);
  for (const on of ['', '[automount]\nenabled=false\n', '[interop]\nenabled=true\n', '[interop]\n# enabled=false\n']) assert.equal(interopOff(on), false, on);
});

test('a build that fails says why and is not tried again for a while; nothing is placed there meanwhile', async () => {
  const work = join(root, 'work-fail');
  mkdirSync(work);
  const pod = fakePodman(work);
  pod.state.buildFails = true;
  const agent = new WorkerAgent({ config: { root: work, ...CAPS }, appUrl: 'http://127.0.0.1:9', token: 't', Worker, run: pod.run });
  const want = { hash: 'abcdef12', files: [] };
  await agent.keepImage('2.4.11', want);
  assert.deepEqual(agent.image, { state: 'failed', text: 'no space left on device' });
  assert.equal(agent.worker.cfg.max, 0);
  await agent.keepImage('2.4.11', want);
  assert.equal(pod.asked.filter((a) => a.startsWith('build')).length, 1);
  pod.state.buildFails = false;
  agent.builtAt = 0;
  await agent.keepImage('2.4.11', { hash: 'abcdef12', files: ['../out'] });
  assert.match(agent.image!.text, /outside its folder/);
  agent.builtAt = 0;
  await agent.keepImage('2.4.11', want);
  assert.equal(agent.image!.state, 'ready');
  // Newer ones wait for the turns running in the old one: none starts meanwhile.
  const old = agent.worker.cfg.image;
  pod.state.from = old;
  agent.worker.turns.set('t', {} as never);
  await agent.keepImage('2.4.12', want);
  assert.deepEqual([agent.worker.cfg.image, agent.image!.state, agent.worker.cfg.max], [old, 'building', 0]);
  // A reboot took its container: the turns' next checkpoint makes it from the new image, at once.
  pod.state.from = '';
  agent.builtAt = 0;
  await agent.keepImage('2.4.13', want);
  assert.deepEqual([agent.worker.cfg.image, agent.image!.state], ['localhost/citadel-worker:abcdef12-2.4.13', 'ready']);
  agent.worker.turns.clear();
  agent.builtAt = 0;
  await agent.keepImage('2.4.12', want);
  assert.deepEqual([agent.worker.cfg.image, agent.image!.state], ['localhost/citadel-worker:abcdef12-2.4.12', 'ready']);
  // A claude or a hash that isn't one never reaches a build file.
  await agent.keepImage('2.4.12; rm -rf /', want);
  assert.equal(agent.worker.cfg.image, 'localhost/citadel-worker:abcdef12-2.4.12');
});
