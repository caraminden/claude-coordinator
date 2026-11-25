// A landing or deploy killed part way, and a restart waiting on running turns (#553).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { holds } from './holds.ts';
import { git, until, pipe, land, subjects, proc } from './land-recover-fixture.ts';
import { quietProc } from './quiet-proc.ts';

// The drill's worst (F2): with land.sh gone nothing put main back, and every later landing failed its own boot
// check on the stranded commit and was told to fix its own change.
test('a landing killed outright while its deploy checks a commit that breaks the boot does not leave that commit on main', { timeout: 300_000 }, async (t) => {
  for (const scope of ['land.sh alone', 'its whole process group']) {
    const p = await pipe(t, 2);
    const bad = p.commit(p.wts[0], 'BOOT_BAD', 'breaks the boot\n');
    p.commit(p.wts[1], 'b.txt', 'innocent\n');
    const mark = join(p.dir, 'boot-started');
    const gate = join(p.dir, 'boot-go');
    const first = p.start(land, p.wts[0], { BOOT_MARK: mark, BOOT_GATE: gate });
    await until('the boot check to start', () => existsSync(mark));
    process.kill(scope === 'land.sh alone' ? first.pid : -first.pid, 'SIGKILL');
    writeFileSync(gate, ''); // an orphaned deploy.sh goes on, fails its boot check and puts the checkout back
    await first.done; // ends once that orphan has let go of stderr
    await until('the lock to be free', p.lockFree);
    assert.equal(git(p.source, 'rev-parse', 'main'), bad, `${scope}: the killed landing had moved main`);

    const res = await p.run(land, p.wts[1]);
    assert.equal(res.status, 0, `${scope}: the next landing lands:\n${res.stderr}`);
    assert.match(res.stderr, /an earlier landing was killed .* main is back at/, scope);
    assert.deepEqual(subjects(p.source), ['b.txt: innocent', 'base'], `${scope}: main holds the innocent change and not the one that breaks the boot`);
    assert.equal(git(p.live, 'rev-parse', 'HEAD'), git(p.wts[1], 'rev-parse', 'HEAD'), scope);
    assert.deepEqual(await p.restarts(1), ['0'], scope);
  }
});

// Review of the fix: a restart queued by an earlier deploy restarts on whatever the checkout holds, the killed one's
// commit included. Once it has come up healthy there (last-good), taking that commit away would undo a live deploy.
test('a killed landing whose commit an earlier queued restart has since made live keeps the checkout and main', { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 2);
  const tip = p.commit(p.wts[0], 'a.txt', 'first\n');
  p.commit(p.wts[1], 'b.txt', 'innocent\n');
  const mark = join(p.dir, 'boot-started');
  const gate = join(p.dir, 'boot-go');
  const first = p.start(land, p.wts[0], { BOOT_MARK: mark, BOOT_GATE: gate });
  await until('the boot check to start', () => existsSync(mark));
  process.kill(-first.pid, 'SIGKILL');
  writeFileSync(gate, ''); // the boot check runs under timeout(1), in a process group of its own: it outlives the kill and ends by itself
  await first.done;
  await until('the lock to be free', p.lockFree);
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), tip, 'the killed deploy had pulled it');
  git(p.live, 'tag', '-f', 'last-good', tip); // what that restart does once the server stays healthy on it

  const res = await p.run(land, p.wts[1]);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /was killed/);
  assert.deepEqual(subjects(p.source), ['b.txt: innocent', 'a.txt: first', 'base']);
  assert.deepEqual(await p.restarts(1), ['0']);
});

// F9: the pull comes before the checks, and only a trap undid it. main_back took "the live checkout has it" for "deployed".
test('a deploy killed outright before its checks end leaves neither the live checkout nor main on the unchecked commit', { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 1);
  p.commit(p.wts[0], 'b.txt', 'mine\n');
  const mark = join(p.dir, 'boot-started');
  const gate = join(p.dir, 'boot-go');
  const landing = p.start(land, p.wts[0], { BOOT_MARK: mark, BOOT_GATE: gate });
  await until('the boot check to start', () => existsSync(mark));
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), git(p.wts[0], 'rev-parse', 'HEAD'), 'the live checkout had pulled it');
  // deploy.sh and any subshell of it between the boot check and land.sh.
  for (let pid = Number(readFileSync(mark, 'utf8')); ; ) {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!cmd.includes('deploy.sh')) break;
    const parent = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop()!.split(' ')[1]);
    process.kill(pid, 'SIGKILL');
    pid = parent;
  }
  writeFileSync(gate, '');
  const res = await landing.done;
  assert.equal(res.status, 1, res.stderr);
  assert.equal(git(p.live, 'rev-parse', 'HEAD'), p.base, `the live checkout is back:\n${res.stderr}`);
  assert.equal(git(p.source, 'rev-parse', 'main'), p.base, `main is back:\n${res.stderr}`);
  assert.match(res.stderr, /main is back at/);
  await until('the lock to be free', p.lockFree);
});

// F6: the landing said only "not live yet", then nothing for up to 2 h.
test('a restart waiting on running turns says so to the landing: how many, for how long at most, and how to skip the wait', { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 1);
  const tip = p.commit(p.wts[0], 'b.txt', 'innocent\n');
  writeFileSync(join(p.dir, 'interruptible'), '1');
  t.after(() => writeFileSync(join(p.dir, 'interruptible'), '0')); // a failed test leaves no restart waiting
  // The landing watches its whole live limit before it says so: the fixture's 20 s less 9 s of grace (#1615).
  const res = await p.run(land, p.wts[0], { DEPLOY_IDLE_POLL: '0.2', DEPLOY_IDLE_TRIES: '3000', DEPLOY_TEST_LIVE_GRACE: '1' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /not live yet: the restart is waiting for 1 running turn a restart would cut off to finish \(at most \d+ min more\).*tools\/deploy\.sh --now/);
  assert.match(p.restartLog(), /waiting for 1 running turn a restart would cut off/, 'the restart says so in its own log too');
  writeFileSync(join(p.dir, 'interruptible'), '0');
  assert.deepEqual(await p.restarts(1), ['0']);
  assert.equal(git(p.live, 'rev-parse', 'last-good'), tip);
});

// A server that hangs at its start took longer to fail than the deploy watched for: it shipped, and the roll back came after.
test('a restart still under way when the live watch runs out is waited for: one that then fails takes its commit off main', { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 1);
  p.commit(p.wts[0], 'RUN_BAD', 'hangs at start\n');
  const gate = join(p.dir, 'gives-up');
  t.after(() => writeFileSync(gate, '')); // a failed test leaves no restart hanging
  const landing = p.start(land, p.wts[0], { RUN_BAD_GATE: gate, DEPLOY_HEALTHY_WAIT: '1', DEPLOY_TEST_LIVE_GRACE: '0' });
  let over = false;
  void landing.done.then(() => (over = true));
  const phase = () => existsSync(join(p.state, 'restart')) && readFileSync(join(p.state, 'restart'), 'utf8');
  await until('the server to be restarting', () => /restarting/.test(phase() || ''));
  // The watch's limit is 2 s here.
  await holds('the landing waits for the verdict', () => !over, { ms: 4000 });
  writeFileSync(gate, '');
  const res = await landing.done;
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /the restart on .* failed and was rolled back/);
  assert.equal(git(p.source, 'rev-parse', 'main'), p.base, `main is back:\n${res.stderr}`);
  assert.deepEqual(await p.restarts(1), ['1']);
});

// The front's landing fails and takes the train off main; its riders go back in line and ship on their own (ADR 0020).
test("a restart rolled back while its deploy watches tells the deploy's own minion, and no rider whose ship is still under way", { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 1);
  const told: string[] = [];
  const api = createServer((req, res) => {
    told.push(`${req.headers.authorization} ${req.url}`);
    res.end('{}');
  });
  await new Promise<void>((ok) => api.listen(0, '127.0.0.1', ok));
  t.after(() => void api.close());
  const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const tip = p.commit(p.source, 'RUN_BAD', 'never comes up\n');
  const riders = join(p.dir, 'riders');
  writeFileSync(riders, `${url} tok8 8 ${tip}\n`);
  const res = await p.run(join(p.source, 'tools', 'deploy.sh'), p.source, { DEPLOY_RIDERS: riders, COORDINATOR_API: url, COORDINATOR_TICKET: '7', COORDINATOR_TOKEN: 'tok7', DEPLOY_SETTLE: '5', DEPLOY_TEST_LIVE_POLL: '0.1' });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /failed and was rolled back/);
  assert.deepEqual(await p.restarts(1), ['1']);
  assert.equal(told.length, 1, told.join('\n'));
  assert.match(told[0], /^Bearer tok7 .*\/7\//);
});

// #565: how long each phase of a landing took, and each queued restart, in the day's retro log.
test('a landing and its restart each leave a timing line in the retro log, landed or rolled back', { timeout: 200_000 }, async (t) => {
  const p = await pipe(t, 2);
  const shared = join(p.dir, 'shared');
  const lines = () => {
    const day = join(shared, 'retro-log');
    return existsSync(day)
      ? readFileSync(join(day, readdirSync(day)[0], 'land.md'), 'utf8')
          .split('\n')
          .filter((l) => / · (timing|restart) · /.test(l))
      : [];
  };
  const good = p.commit(p.wts[0], 'b.txt', 'fine\n');
  let res = await p.run(land, p.wts[0], { COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 0, res.stderr);
  await p.restarts(1);
  // Two processes write them, the restart and land.sh, so either can come first.
  const kind = (k: string, from = 0) =>
    lines()
      .slice(from)
      .filter((l) => l.includes(` · ${k} · `));
  assert.equal(lines().length, 2, lines().join('\n'));
  assert.match(kind('restart')[0], /^- \d\d:\d\d:\d\dZ · restart · [0-9a-f]{7} · idle-wait \d+ · backup \d+ · healthy \d+ · settle \d+ · restart · live$/);
  assert.ok(kind('restart')[0].includes(` · ${good.slice(0, 7)} · `), kind('restart')[0]);
  // LAND_CI=0 here: the suite ran on "perigee", after no wait for CI, and the CI fields are empty.
  assert.match(kind('timing')[0], /^- \d\d:\d\d:\d\dZ · timing · ticket\/1-x · line \d+ · rebase \d+ · ci-queue - · ci-run - · fallback \d+\+\d+ · deploy \d+ · live \d+ · landed$/);

  git(p.wts[1], 'rebase', '-q', 'main');
  p.commit(p.wts[1], 'RUN_BAD', 'never comes up\n');
  res = await p.run(land, p.wts[1], { COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1, res.stderr);
  await p.restarts(2);
  // It answered healthy at no point, so there was no settle check; land.sh's deploy saw no "live".
  const [restart, timing] = [kind('restart', 2), kind('timing', 2)];
  assert.equal(restart.length, 1, lines().join('\n'));
  assert.match(restart[0], /· restart · [0-9a-f]{7} · idle-wait \d+ · backup \d+ · healthy - · settle - · restart · rolled back$/);
  assert.equal(timing.length, 1, lines().join('\n'));
  assert.match(timing[0], /· timing · ticket\/2-x · line \d+ · rebase \d+ · ci-queue - · ci-run - · fallback \d+\+\d+ · deploy \d+ · live - · refused at deploy$/);
});

// #1833: the deploys here read the box's own CPU pressure, so on a CI desktop at 51% their restarts waited for it to
// ease and three files failed in main's run. They read the fixture's fake /proc: starved there, the restart says so.
test("a deploy here reads the fixture's pressure files, never the box's", { timeout: 120_000 }, async (t) => {
  const p = await pipe(t, 1);
  // Memory, not CPU: land.sh's quiet check and citadel-heavy read the CPU file, and would wait on it.
  writeFileSync(join(proc, 'pressure', 'memory'), 'some avg10=97.00 avg60=97.00 avg300=97.00 total=1\n');
  try {
    p.commit(p.wts[0], 'b.txt', 'mine\n');
    const res = await p.run(land, p.wts[0], { DEPLOY_PRESSURE_HOLD: '1' });
    await p.restarts(1);
    assert.match(`${res.stderr}\n${p.restartLog()}`, /starved \(memory pressure 97%\)/);
  } finally {
    quietProc(proc);
  }
});
