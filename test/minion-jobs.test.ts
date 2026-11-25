import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { JobRefused, MinionJobs, readFolder, wokenWaits, type JobDeps } from '../src/minion-jobs.ts';
import { waitsAlone } from '../tools/citadel-job.ts';
import { until } from './wait.ts';

const tools = join(import.meta.dirname, '..', 'tools');
const root = mkdtempSync(join(tmpdir(), 'minion-jobs-'));
after(() => rmSync(root, { recursive: true, force: true }));
let made = 0;

/** A fake server round minions 7 and 8 (two schemes' worth: nothing here knows a scheme), its jobs' commands never run unless `real`. */
function world(over: Partial<JobDeps> = {}) {
  const tmp = join(root, `t${++made}`);
  mkdirSync(tmp);
  const settings = new Map<string, string>();
  const w = {
    tmp,
    settings,
    now: 1_000_000_000_000,
    live: true,
    hold: 120_000,
    grunt: false,
    /** The server loses this ask's answer. */
    deaf: undefined as ((ask: { id: string; dir: string }) => boolean) | undefined,
    lastTurnEnd: null as number | null,
    container: null as string | null,
    refuse: '',
    units: true,
    open: true,
    ran: [] as string[][],
    woken: [] as { ticket: number; text: string }[],
    jobs: undefined as unknown as MinionJobs,
    reload: () => {
      w.jobs = new MinionJobs(deps);
    },
  };
  const deps: JobDeps = {
    store: {
      getSetting: <T>(k: string) => (settings.has(k) ? (JSON.parse(settings.get(k)!) as T) : undefined),
      setSetting: (k, v) => void settings.set(k, JSON.stringify(v)),
      deleteSetting: (k) => void settings.delete(k),
    },
    tmp: () => (w.open ? tmp : null),
    turn: () => (w.refuse ? { refuse: w.refuse } : { container: w.container }),
    live: () => w.live,
    hold: async () => w.hold,
    grunts: () => w.grunt,
    units: () => w.units,
    wake: (ticket, text) => void w.woken.push({ ticket, text }),
    changed: () => {},
    lastTurnEnd: () => w.lastTurnEnd,
    cacheMs: 3_600_000,
    now: () => w.now,
    run: async (argv) => void w.ran.push(argv),
    ...over,
  };
  w.reload();
  return w;
}
type World = ReturnType<typeof world>;

let ids = 0;
function folder(w: World) {
  const id = `mabc1234-${(++ids).toString(16).padStart(8, '0')}`;
  const dir = join(w.tmp, 'jobs', id);
  mkdirSync(dir, { recursive: true });
  cpSync(join(tools, 'citadel-job-run.sh'), join(dir, 'run.sh'));
  return { id, dir };
}
const begin = async (w: World, ticket = 7, over: Record<string, unknown> = {}) => {
  const f = folder(w);
  await w.jobs.start(ticket, { ...f, what: 'npm test', kind: 'job', ...over });
  return f;
};
const end = (dir: string, code = '0') => writeFileSync(join(dir, 'code'), `${code}\n`);
const beat = (w: World, dir: string) => (writeFileSync(join(dir, 'beat'), ''), utimesSync(join(dir, 'beat'), w.now / 1000, w.now / 1000));

test('a host job gets a unit of its own in the heavy slice, a container job stays in its container', async () => {
  const w = world();
  await begin(w);
  const host = w.ran[0].join(' ');
  assert.match(host, /^systemd-run --user --collect .*--slice=citadel-heavy\.slice .*-p OOMPolicy=continue .*run\.sh .*\/jobs\/\S+ 21600$/);
  assert.doesNotMatch(host, /BindsTo/, 'nothing ties it to the turn');
  w.container = 'citadel-person-2';
  const { dir } = await begin(w);
  assert.match(w.ran[1].join(' '), /--scope .*--slice=citadel-turns\.slice podman exec -d citadel-person-2 /);
  assert.ok(w.ran[1].includes(join(dir, 'run.sh')));
  assert.equal(w.jobs.inContainer('citadel-person-2'), 1);
  assert.equal(w.jobs.inContainer('citadel-person-1'), 0);
});

test('a job outlives its turn and its end wakes the minion once, with its result, across a restart', async () => {
  const w = world();
  const { dir } = await begin(w);
  w.live = false;
  beat(w, dir);
  await w.jobs.pump();
  assert.equal(w.woken.length, 0);
  assert.match(w.jobs.work(7)!.text, /^Waiting for npm test to finish$/);
  assert.match(w.jobs.turnLine(7)!, /still works on.*npm test.*spoils its result/s);
  w.reload();
  assert.equal(w.jobs.running(7).length, 1, 'the server restarted under it');
  w.now += 600_000;
  end(dir, '1');
  await w.jobs.pump();
  await w.jobs.pump();
  w.reload();
  await w.jobs.pump();
  assert.deepEqual(
    w.woken.map((x) => x.ticket),
    [7],
  );
  assert.match(w.woken.map((x) => x.text).join(), /`npm test` exited 1 after 10 min. Its output: .*output\.log/);
  assert.equal(w.jobs.work(7), null);
});

test('a wake goes ahead of new turns, until its turn starts', async () => {
  const w = world();
  const { dir } = await begin(w);
  w.live = false;
  end(dir);
  const store = { getSetting: <T>(k: string) => (w.settings.has(k) ? (JSON.parse(w.settings.get(k)!) as T) : undefined) };
  assert.equal(wokenWaits(store, 7), false);
  await w.jobs.pump();
  assert.equal(wokenWaits(store, 7), true);
  assert.equal(wokenWaits(store, 8), false);
  w.jobs.turnStarted(7);
  assert.equal(wokenWaits(store, 7), false);
});

test('the turn that started a short job reads its end itself: no wake', async () => {
  const w = world();
  const { dir } = await begin(w);
  end(dir);
  await w.jobs.pump();
  assert.equal(w.woken.length, 0, 'its turn is still there to read it');
  writeFileSync(join(dir, 'seen'), '');
  await w.jobs.pump();
  w.now += 60_000;
  await w.jobs.pump();
  assert.equal(w.woken.length, 0);
  // One a live turn never read is told to it after all, and is no wait that gave a worker back.
  const other = await begin(w);
  end(other.dir);
  await w.jobs.pump();
  w.now += 11_000;
  await w.jobs.pump();
  assert.equal(w.woken.length, 1);
  assert.deepEqual(w.jobs.stats(), []);
});

test('Stop, close and a time limit each end it; a stopped one wakes nobody', async () => {
  const w = world();
  const a = await begin(w);
  const b = await begin(w);
  const c = await begin(w, 8);
  w.live = false;
  assert.equal(w.jobs.stop(7), true);
  await until('both stops', () => existsSync(join(a.dir, 'stop')) && existsSync(join(b.dir, 'stop')));
  assert.ok(!existsSync(join(c.dir, 'stop')), "another minion's runs on");
  assert.equal(w.jobs.stop(7), false);
  assert.equal(w.jobs.work(7), null);
  for (const f of [a, b]) end(f.dir, '143');
  await w.jobs.pump();
  assert.equal(w.woken.length, 0);
  writeFileSync(join(c.dir, 'how'), 'timeout\n');
  end(c.dir, '143');
  await w.jobs.pump();
  assert.match(w.woken[0].text, /stopped at its time limit/);
  const d = await begin(w);
  w.open = false; // closed meanwhile
  end(d.dir);
  await w.jobs.pump();
  assert.equal(w.woken.length, 1);
});

test('Stop after the end: the wake still owed is dropped, and one in the line is no longer first', async () => {
  const w = world();
  const a = await begin(w);
  w.live = false;
  end(a.dir);
  const b = await begin(w);
  await w.jobs.pump();
  assert.equal(w.woken.length, 1);
  assert.ok(wokenWaits(w.jobs['d'].store, 7));
  w.jobs.stop(7, b.id);
  end(b.dir);
  assert.ok(wokenWaits(w.jobs['d'].store, 7), "stopping one job leaves another's wake");
  await w.jobs.pump();
  const c = await begin(w);
  w.live = true;
  end(c.dir); // ended while the turn is live, its wake owed at the turn's end
  assert.equal(w.jobs.stop(7), true);
  w.live = false;
  await w.jobs.pump();
  assert.equal(w.woken.length, 1);
  w.settings.set('minion-job-woken:7', 'true');
  assert.equal(w.jobs.stop(7), false, 'nothing runs');
  assert.ok(!w.settings.has('minion-job-woken:7'));
});

test('one whose beat stopped is called lost after ten minutes, and its folder going counts too', async () => {
  const w = world();
  const a = await begin(w);
  w.live = false;
  beat(w, a.dir);
  w.now += 9 * 60_000;
  await w.jobs.pump();
  assert.equal(w.woken.length, 0, 'frozen for memory relief, it may come back');
  w.now += 2 * 60_000;
  await w.jobs.pump();
  assert.match(w.woken[0].text, /cut off after 11 min, with no result/);
  const b = await begin(w);
  rmSync(b.dir, { recursive: true });
  await w.jobs.pump();
  assert.equal(w.woken.length, 2);
});

test('what the folder says is trusted for nothing but a small number, a word and an age', async () => {
  const w = world();
  const { dir } = folder(w);
  assert.deepEqual(await readFolder(dir), { code: null, how: null, beat: null, gone: false });
  symlinkSync('/etc/hostname', join(dir, 'code'));
  assert.equal((await readFolder(dir)).code, null);
  unlinkSync(join(dir, 'code'));
  writeFileSync(join(dir, 'code'), `0${' '.repeat(200)}`);
  assert.equal((await readFolder(dir)).code, null, 'too large');
  writeFileSync(join(dir, 'code'), 'rm -rf');
  assert.equal((await readFolder(dir)).code, null);
  writeFileSync(join(dir, 'how'), 'anything');
  assert.equal((await readFolder(dir)).how, null);
});

test("starts are refused: a turn that can't, a folder elsewhere or through a link, a second start, the seventh", async () => {
  const w = world();
  const bad = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof JobRefused && re.test(e.message));
  const f = folder(w);
  const ask = { ...f, what: 'npm test', kind: 'job' as const };
  w.refuse = 'A Taskmaster has no jobs';
  await bad(w.jobs.start(7, ask), /Taskmaster/);
  w.refuse = '';
  await bad(w.jobs.start(7, { ...ask, id: '../../x' }), /job id/);
  await bad(w.jobs.start(7, { ...ask, dir: join(root, 'elsewhere') }), /folder is in/);
  const linked = folder(w);
  const away = join(root, `away${made}`);
  cpSync(linked.dir, away, { recursive: true });
  rmSync(linked.dir, { recursive: true });
  symlinkSync(away, linked.dir);
  await bad(w.jobs.start(7, { ...ask, ...linked }), /not there/);
  await w.jobs.start(7, ask);
  await bad(w.jobs.start(7, ask), /started already/);
  for (let i = 0; i < 5; i++) await begin(w);
  await bad(begin(w), /6 of this minion's jobs/);
  await begin(w, 8);
});

test('a start that fails leaves nothing behind and can no longer run; one that claimed its folder did start', async () => {
  const w = world({ run: async () => Promise.reject(new Error('no bus')), units: () => true });
  w.container = 'citadel-person-2';
  const late = folder(w);
  await assert.rejects(w.jobs.start(7, { ...late, what: 'npm test', kind: 'job' }), /could not be started: no bus/);
  assert.equal(w.jobs.running(7).length, 0);
  writeFileSync(join(late.dir, 'env'), '');
  writeFileSync(join(late.dir, 'cmd'), `set -- touch ${join(w.tmp, 'twice')}\n`);
  assert.equal(spawnSync('bash', [join(late.dir, 'run.sh'), late.dir, '60']).status, 0);
  assert.ok(!existsSync(join(w.tmp, 'twice')) && !existsSync(join(late.dir, 'code')), 'the launch that came late ran nothing');
  const f = folder(w);
  mkdirSync(join(f.dir, 'claim'));
  await w.jobs.start(7, { ...f, what: 'npm test', kind: 'job' });
  assert.equal(w.jobs.running(7).length, 1);
});

test('a wait is taken over past the hold, at once when there is none, and again held for a Grunt that repeats it', async () => {
  const w = world();
  assert.deepEqual(await w.jobs.ask(7, 'gh run view', 0), { retryIn: 30 });
  assert.deepEqual(await w.jobs.ask(7, 'gh run view', 110), { retryIn: 10 });
  assert.deepEqual(await w.jobs.ask(7, 'gh run view', 120), { take: true });
  w.hold = 0;
  w.grunt = true;
  assert.deepEqual(await w.jobs.ask(7, 'gh run view', 500), { retryIn: 30 }, 'a Grunt works: the turn stays');
  w.grunt = false;
  assert.deepEqual(await w.jobs.ask(7, 'gh run view', 0), { take: true });
  const { dir } = await begin(w, 7, { kind: 'wait', what: 'gh run view', waited: 120 });
  assert.deepEqual(await w.jobs.ask(7, 'gh run view', 0), {});
  assert.deepEqual(await w.jobs.ask(8, 'gh run view', 0), { take: true }, "another minion's is its own");
  assert.equal(w.jobs.work(7)!.text, 'Waiting for gh run view');
  w.live = false;
  w.now += 60_000;
  end(dir);
  await w.jobs.pump();
  assert.match(w.woken[0].text, /What you waited for has happened, after 3 min: `gh run view`/);
});

test('a wait that ran out says so', async () => {
  const w = world();
  const { dir } = await begin(w, 7, { kind: 'wait', what: 'x' });
  w.live = false;
  end(dir, '124');
  await w.jobs.pump();
  assert.match(w.woken[0].text, /time limit.*hasn't happened/);
});

test('the numbers: how long each ran, and whether its wake found a cold cache', async () => {
  const w = world();
  for (const [gap, cold] of [
    [5 * 60_000, false],
    [2 * 3_600_000, true],
  ] as const) {
    const { dir } = await begin(w);
    w.live = false;
    w.lastTurnEnd = w.now;
    w.now += gap;
    end(dir);
    await w.jobs.pump();
    w.jobs.turnStarted(7);
    assert.equal(w.jobs.stats().at(-1)!.cold, cold);
    assert.equal(w.jobs.stats().at(-1)!.ms, gap);
    w.live = true;
  }
  w.now += 8 * 24 * 3_600_000;
  assert.deepEqual(w.jobs.stats(), [], 'a week of them');
});

// --- the real wrapper ----------------------------------------------------------------------------------------------

/** Jobs that really run, as the server's own child (no units). */
const real = () => {
  const w = world({ now: Date.now, units: () => false, run: undefined });
  return w;
};
async function run(w: World, cmd: string, minutes?: number) {
  const f = folder(w);
  writeFileSync(join(f.dir, 'env'), `export PATH=${JSON.stringify(process.env.PATH)} WHO=me\n`);
  writeFileSync(join(f.dir, 'cmd'), `cd ${w.tmp} && set -- bash -c '${cmd}'\n`);
  await w.jobs.start(7, { ...f, what: cmd, kind: 'job', minutes });
  w.live = false;
  return f.dir;
}
const pumped = (w: World) => async () => {
  await w.jobs.pump();
  return w.woken.length > 0;
};

test('real: the command runs with its env and folder, and its code and output come back', async () => {
  const w = real();
  const dir = await run(w, 'echo $WHO in $PWD; exit 3');
  await until('the wake', pumped(w));
  assert.match(w.woken[0].text, /exited 3/);
  assert.equal(readFileSync(join(dir, 'output.log'), 'utf8'), `me in ${w.tmp}\n`);
  assert.ok(!existsSync(join(dir, 'env')), 'the env file is gone once read');
});

test('real: a stop ends its whole tree, a process in its own session too', async () => {
  const w = real();
  const dir = await run(w, 'setsid sleep 300 & echo $! >pid; sleep 300');
  await until('the pid', () => existsSync(join(w.tmp, 'pid')) && readFileSync(join(w.tmp, 'pid'), 'utf8').trim() !== '');
  const pid = Number(readFileSync(join(w.tmp, 'pid'), 'utf8'));
  w.jobs.stop(7);
  await until('its end', () => existsSync(join(dir, 'code')));
  assert.equal(spawnSync('kill', ['-0', String(pid)]).status, 1);
  await w.jobs.pump();
  assert.equal(w.woken.length, 0);
});

test('real: its time limit ends it', async () => {
  const w = real();
  const f = folder(w);
  writeFileSync(join(f.dir, 'env'), '');
  writeFileSync(join(f.dir, 'cmd'), 'set -- sleep 300\n');
  const child = spawn('bash', [join(f.dir, 'run.sh'), f.dir, '1'], { stdio: 'ignore' });
  await new Promise((r) => child.on('close', r));
  assert.deepEqual([(await readFolder(f.dir)).how, (await readFolder(f.dir)).code], ['timeout', 143]);
});

test('real: its folder going ends it', async () => {
  const w = real();
  const dir = await run(w, 'echo $$ >pid; exec sleep 300');
  await until('the pid', () => existsSync(join(w.tmp, 'pid')) && readFileSync(join(w.tmp, 'pid'), 'utf8').trim() !== '');
  const pid = readFileSync(join(w.tmp, 'pid'), 'utf8').trim();
  rmSync(dir, { recursive: true });
  await until('it to stop', () => spawnSync('kill', ['-0', pid]).status === 1);
});

// --- the tool in a turn --------------------------------------------------------------------------------------------

/** The route, over a real MinionJobs, and a citadel-heavy that just runs its command. */
async function turn(w: World) {
  const asked: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const b of req) body += b;
    const ask = JSON.parse(body);
    asked.push(ask);
    if (w.deaf?.(ask)) return void req.socket.destroy();
    try {
      const out = ask.do === 'stop' ? { stopped: w.jobs.stop(7, ask.id) } : ask.do === 'ask' ? await w.jobs.ask(7, ask.what, ask.waited) : await w.jobs.start(7, ask);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
    }
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const bin = join(w.tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'citadel-heavy'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: w.tmp,
    TMPDIR: w.tmp,
    COORDINATOR_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    COORDINATOR_TOKEN: 'secret-token',
    COORDINATOR_TICKET: '7',
    CLAUDE_CODE_SESSION: 'x',
  };
  const job = (args: string[], more: NodeJS.ProcessEnv = {}, stdin: number | 'ignore' = 'ignore') =>
    new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(join(tools, 'citadel-job'), args, { env: { ...env, ...more }, cwd: w.tmp, stdio: [stdin, 'pipe', 'pipe'] });
      let out = '';
      child.stdout?.on('data', (b) => (out += b));
      child.stderr?.on('data', (b) => (out += b));
      child.on('close', (code) => done({ code, out }));
    });
  return { job, asked, env, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}

test('citadel-job: a short one prints its output and code here, and is no wake', async () => {
  const w = real();
  const t = await turn(w);
  const r = await t.job(['bash', '-c', 'echo hi; echo "[${COORDINATOR_TOKEN:-none}] [${CLAUDE_CODE_SESSION:-none}]"; exit 4']);
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /hi\n\[none\] \[none\]\n/, "the job has the turn's env, not its token or session");
  w.live = false;
  await w.jobs.pump();
  assert.equal(w.woken.length, 0);
  await t.close();
});

test('citadel-job: a long one is handed over, --watch waits for it, --stop stops it', async () => {
  const w = real();
  w.hold = 0;
  const t = await turn(w);
  const r = await t.job(['--minutes', '30', 'bash', '-c', 'while [ ! -e go ]; do sleep 0.1; done; echo went']);
  assert.equal(r.code, 75, r.out);
  assert.match(r.out, /handed over as (\S+)\..*End your turn now.*--watch/s);
  assert.equal(t.asked[0].minutes, 30);
  const id = /handed over as (\S+)\./.exec(r.out)![1];
  assert.equal((await t.job(['--watch', id], { CITADEL_WAIT_SECONDS: '1' })).code, 124);
  writeFileSync(join(w.tmp, 'go'), '');
  const seen = await t.job(['--watch', id]);
  assert.deepEqual([seen.code, seen.out], [0, 'went\n']);
  const other = /handed over as (\S+)\./.exec((await t.job(['sleep', '300'])).out)![1];
  assert.equal((await t.job(['--stop', other])).code, 0);
  await until('its end', () => existsSync(join(w.tmp, 'jobs', other, 'code')));
  await t.close();
});

test('citadel-job: with no server to start it, or refused, it runs in the turn once', async () => {
  const w = real();
  const t = await turn(w);
  const alone = await t.job(['sh', '-c', 'echo ran >>count; exit 5'], { COORDINATOR_TOKEN: '' });
  assert.equal(alone.code, 5);
  w.refuse = 'A side question has no jobs';
  const refused = await t.job(['sh', '-c', 'echo ran >>count']);
  assert.equal(refused.code, 0);
  assert.match(refused.out, /A side question has no jobs, so it runs in this turn/);
  assert.equal(readFileSync(join(w.tmp, 'count'), 'utf8'), 'ran\nran\n');
  await t.close();
});

test('citadel-job: a start whose answer is lost runs once: here if nothing claimed it, else there', async () => {
  const w = real();
  const t = await turn(w);
  w.deaf = () => true;
  const here = await t.job(['sh', '-c', 'echo ran >>count']);
  assert.match(here.out, /so it runs in this turn/);
  const dir = String(t.asked[0].dir);
  assert.ok(existsSync(join(dir, 'claim')) && !existsSync(join(dir, 'env')));
  spawnSync('bash', [join(dir, 'run.sh'), dir, '60']);
  assert.equal(readFileSync(join(w.tmp, 'count'), 'utf8'), 'ran\n', 'a launch after it runs nothing');
  w.deaf = (ask) => (spawn('bash', [join(ask.dir, 'run.sh'), ask.dir, '60'], { stdio: 'ignore' }), spawnSync('bash', ['-c', `until [ -e ${ask.dir}/claim ]; do sleep 0.05; done`]), true);
  const there = await t.job(['sh', '-c', 'echo ran >>count']);
  assert.doesNotMatch(there.out, /runs in this turn/);
  await until('its end', () => existsSync(join(String(t.asked[1].dir), 'code')));
  assert.equal(readFileSync(join(w.tmp, 'count'), 'utf8'), 'ran\nran\n');
  await t.close();
});

test('citadel-job: what is piped to it reaches the command, on the server or in the turn', async () => {
  const w = real();
  const t = await turn(w);
  writeFileSync(join(w.tmp, 'in'), 'one\ntwo\n');
  const from = async (more?: NodeJS.ProcessEnv) => {
    const fd = openSync(join(w.tmp, 'in'), 'r');
    const r = await t.job(['cat'], more, fd);
    closeSync(fd);
    return r.out;
  };
  assert.equal(await from(), 'one\ntwo\n');
  assert.match(await from({ COORDINATOR_TOKEN: '' }), /^one\ntwo$/m);
  const pipe = spawn('bash', ['-c', `(sleep 0.3; echo late) | ${join(tools, 'citadel-job')} cat`], { env: t.env, cwd: w.tmp, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  pipe.stdout.on('data', (b) => (out += b));
  await new Promise((r) => pipe.on('close', r));
  assert.equal(out, 'late\n');
  await t.close();
});

test('citadel-wait: a wait typed on its own hands over, then happens in the job', async () => {
  const w = real();
  w.hold = 0;
  const t = await turn(w);
  // The turn's shape: claude, its Bash tool's shell, citadel-wait. A pretend claude, whose shell names a snapshot.
  const snap = join(w.tmp, 'shell-snapshots.sh');
  writeFileSync(snap, `${JSON.stringify(join(tools, 'citadel-wait'))} file ${w.tmp}/ci-done; echo code $?\n`);
  const claude = join(w.tmp, 'claude.sh');
  writeFileSync(claude, `export CLAUDE_PID=$$\nbash ${snap}\nexit 0\n`);
  const cwd = mkdtempSync(join(root, 'cwd-'));
  const child = spawn('bash', [claude], { env: t.env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (out += b));
  await new Promise((r) => child.on('close', r));
  assert.match(out, /handed over: the server goes on waiting for .*ci-done to exist.*code 75/s);
  w.live = false;
  assert.match(w.jobs.work(7)!.text, /^Waiting for ci-done to exist$/);
  writeFileSync(join(w.tmp, 'ci-done'), '');
  await until('the wake', pumped(w));
  assert.match(w.woken[0].text, /What you waited for has happened/);
  await t.close();
});

test('citadel-wait: outside a turn, in a job, or with a short limit it asks nobody', async () => {
  const w = real();
  w.hold = 0;
  const t = await turn(w);
  const wait = (more: NodeJS.ProcessEnv) => new Promise<number | null>((r) => spawn(join(tools, 'citadel-wait'), ['file', join(w.tmp, 'never')], { env: { ...t.env, CITADEL_WAIT_SECONDS: '1', ...more }, stdio: 'ignore' }).on('close', r));
  assert.equal(await wait({ CLAUDE_PID: '1' }), 124, 'a short limit');
  assert.deepEqual(t.asked, []);
  const none = new Promise<number | null>((r) => spawn(join(tools, 'citadel-wait'), ['cmd', `echo >>${w.tmp}/tries; [ $(wc -l <${w.tmp}/tries) -ge 2 ]`], { env: { ...t.env, CLAUDE_PID: '1', CITADEL_WAIT_HANDOVER: '0' }, stdio: 'ignore' }).on('close', r));
  assert.equal(await none, 0);
  assert.deepEqual(t.asked, []);
  await t.close();
});

// --- what a wait may leave behind ----------------------------------------------------------------------------------

test('waitsAlone: only when ending the turn loses nothing', () => {
  const base: [number, number, string, string][] = [
    [1, 0, 'init', '/'],
    [50, 1, 'conmon', '/'],
    [100, 50, 'claude -p', '/w'],
    [110, 100, 'node mcp-server', '/w'],
    [200, 100, 'bash -c source /h/shell-snapshots/s.sh && citadel-wait', '/w'],
    [210, 200, 'bash /pin/bin/citadel-wait cmd x', '/w'],
    [220, 210, 'node citadel-job.ts --handover', '/w'],
  ];
  const ps = (more: [number, number, string, string][] = [], drop = -1) => new Map([...base, ...more].filter(([p]) => p !== drop).map(([p, ppid, cmd, cwd]) => [p, { ppid, cmd, cwd }]));
  const alone = (m: ReturnType<typeof ps>, self = 210) => waitsAlone(m, self, 100, ['/w', '/t']);
  assert.equal(alone(ps()), true);
  assert.equal(alone(ps([[300, 100, 'bash -c source /h/shell-snapshots/s.sh && npm test', '/w']])), false, 'another Bash command of the turn');
  assert.equal(alone(ps([[300, 200, 'npm test', '/w']])), false, 'a background job of the same command');
  assert.equal(alone(ps([[300, 1, 'npm test', '/t/x']])), false, 'one the turn left running');
  assert.equal(
    alone(
      ps([
        [300, 1, 'bash /t/jobs/mabc-1/run.sh /t/jobs/mabc-1 60', '/'],
        [301, 300, 'npm test', '/w'],
      ]),
    ),
    true,
    "a server's job is not the turn's",
  );
  assert.equal(alone(ps([[300, 1, 'someone else', '/w2']])), true);
  assert.equal(
    alone(
      ps([
        [230, 200, 'sh /w/script.sh', '/w'],
        [240, 230, 'bash citadel-wait', '/w'],
      ]),
      240,
    ),
    false,
    'inside a script that goes on after it',
  );
});
