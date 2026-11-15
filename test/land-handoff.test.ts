import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { deployApps, LandHandoffs, Landings, landResult, outputTail, type DeployOps, type HandoffDeps } from '../src/land.ts';
import { agentToken, bootServer, until } from './helpers.ts';
import { git } from './git.ts';

// #706: a minion hands its land to the server and ends its turn. The server runs land.sh, and on a clean land posts
// the shipped line and dismisses or parks the minion with no model call; on a failure it wakes the minion with the
// end of land.sh's output.
const root = mkdtempSync(join(tmpdir(), 'land-handoff-'));
after(() => rmSync(root, { recursive: true, force: true }));

const H = { summary: 'Usage bar in the top bar.', risk: 'low' as const, reason: 'front end only' };
const LIVE = 'land: main is now at abc1234 "#9: usage bar"\ndeploy: live now: the server reloaded the front end (v2); open tabs reload when idle. No restart.\n';
const RESTART = 'land: main is now at def5678 "#9: server bit"\ndeploy: restart queued as citadel-restart: running turns carry on through it, and it reports here\ndeploy: not live yet after 75 s; the restart reports here when it is\n';

/** A Landings in a data dir of its own, a minion worktree whose land.sh prints `out` and exits `code`, and fake deps that record what the server did. */
function setup(name: string, opts: { running?: boolean; kept?: string | null; runners?: boolean; liveAlready?: boolean; apps?: string[]; deployOps?: DeployOps } = {}) {
  const data = join(root, name, 'data');
  const cwd = join(root, name, 'wt');
  mkdirSync(join(cwd, 'tools'), { recursive: true });
  const landings = new Landings(data);
  const ticket = { status: 'idle', state: 'outside' as string | null, note: 'landing: handed to the server' as string | null };
  const did: string[] = [];
  const sent: string[] = [];
  const notes: string[] = [];
  const deps: HandoffDeps = {
    landings,
    store: { getTicket: () => ticket, updateTicket: (_id, f) => { Object.assign(ticket, f); did.push(`state ${f.state}`); } },
    runner: {
      emit: (_id, _kind, data: any) => { notes.push(data.text); },
      send: (_id, _from, text) => { sent.push(text); },
      close: async (_id, text) => { ticket.status = 'closed'; did.push(`close: ${text}`); },
      closeAfterTurn: () => { did.push('closeAfterTurn'); return true; },
      keptOpen: () => opts.kept ?? null,
      isRunning: () => !!opts.running,
      queued: () => 0,
      deployPending: () => { did.push('deployPending'); },
      deployLive: () => { did.push('deployLive'); return true; },
      broadcastTicket: () => {},
    },
    from: 'Citadel',
    runnersBack: (_id, reason) => { did.push(`runnersBack: ${reason}`); return opts.runners ?? true; },
    liveAlready: async () => !!opts.liveAlready,
    ...(opts.deployOps ? { apps: () => opts.apps ?? [], deployOps: opts.deployOps } : {}),
  };
  const land = async (out: string, code = 0, h: object = H, args: string[] = []) => {
    writeFileSync(join(cwd, 'tools', 'land.sh'), `printf '%b' ${JSON.stringify(out)}\nexit ${code}\n`);
    assert.ok(landings.handOff(1, cwd, { PATH: process.env.PATH! }, args, { ...H, ...h }));
    await until('land.sh ends', () => landings.get(1)?.code !== null);
  };
  return { landings, ticket, did, sent, notes, deps, land, handoffs: new LandHandoffs(deps), data, cwd };
}

test('a clean land that is live now posts the shipped line and dismisses the minion, with no message to it', async () => {
  const s = setup('live');
  await s.land(LIVE);
  await s.handoffs.poll();
  assert.deepEqual(s.notes, ['Shipped abc1234 "#9: usage bar": Usage bar in the top bar. Risk low: front end only. Live now.']);
  assert.equal(s.sent.length, 0, 'no model call');
  assert.ok(s.did.some((d) => d.startsWith('close: Landed and live')), s.did.join('\n'));
  assert.deepEqual(s.landings.handoffs(), [], 'reported once');
  await s.handoffs.poll();
  assert.equal(s.notes.length, 1, 'a second poll reports nothing again');
});

test('a clean land waiting for the restart sets pending-deploy, and a restart already live dismisses it at once', async () => {
  const s = setup('restart');
  await s.land(RESTART);
  await s.handoffs.poll();
  assert.match(s.notes[0], /^Shipped def5678 "#9: server bit": .* Waiting for the restart\.$/);
  assert.equal(s.ticket.state, 'pending-deploy');
  assert.ok(s.did.includes('deployPending'));
  assert.ok(!s.did.some((d) => d.startsWith('close')), 'the restart dismisses it, not this');
  assert.ok(!s.did.includes('deployLive'), 'not live yet');
  assert.equal(s.sent.length, 0);

  const early = setup('restart-early', { liveAlready: true });
  await early.land(RESTART);
  await early.handoffs.poll();
  assert.ok(early.did.includes('deployLive'), 'its restart went live before land.sh ended: no report will come, so it is dismissed now');
});

test('a high-risk land carries its go in the shipped line', async () => {
  const s = setup('high');
  await s.land(LIVE, 0, { risk: 'high', reason: 'touches the land pipeline', go: 'Cara, 3:05 PM PST' });
  await s.handoffs.poll();
  assert.match(s.notes[0], /Risk high: touches the land pipeline\. Go: Cara, 3:05 PM PST\. Live now\.$/);
});

test('each kind of failed land wakes the minion with the end of its output, and leaves it open', async () => {
  const kinds = {
    conflict: 'land: rebasing onto main\nland: the rebase onto main hit a conflict in src/land.ts; nothing landed. Rebase by hand and land again\n',
    'red test': `${'ok - a passing test\n'.repeat(200)}not ok 3 - the hand-off reports\nland: the full suite failed on CI; main untouched\n`,
    preflight: 'land: deploy has been refusing since 10:02: the boot check failed on abc1234. Fix that first\n',
    'failed deploy': 'land: main is now at abc1234 "#9"\ndeploy: boot check failed; nothing deployed\nland: the deploy failed after main moved; main keeps abc1234\n',
  };
  for (const [kind, out] of Object.entries(kinds)) {
    const s = setup(`fail-${kind.replace(' ', '-')}`);
    await s.land(out, 1);
    await s.handoffs.poll();
    assert.equal(s.sent.length, 1, `${kind}: woken once`);
    assert.match(s.sent[0], /tools\/land\.sh exited 1/, kind);
    assert.match(s.sent[0], /hand it off again with hand_off_land/, kind);
    const last = out.trimEnd().split('\n').pop()!;
    assert.ok(s.sent[0].includes(last), `${kind}: carries land.sh's last line`);
    assert.ok(s.sent[0].length < 8000, `${kind}: the tail, not the whole log (${s.sent[0].length})`);
    assert.ok(s.sent[0].includes(s.landings.log(1)), `${kind}: says where the whole output is`);
    assert.equal(s.notes.length, 0, `${kind}: no shipped line`);
    assert.equal(s.ticket.state, null, `${kind}: the hand-off's outside state is cleared`);
    assert.ok(!s.did.some((d) => d.startsWith('close')), `${kind}: not dismissed`);
    assert.deepEqual(s.landings.handoffs(), [], `${kind}: reported`);
  }
});

test('exit 75 (no CI verdict) parks the minion until the runners are back, or wakes it when there are none to watch', async () => {
  const s = setup('no-ci');
  await s.land('land: CI gave no verdict\n', 75);
  await s.handoffs.poll();
  assert.equal(s.ticket.state, 'parked');
  assert.ok(s.did.some((d) => d.startsWith('runnersBack: ') && d.includes('hand_off_land')));
  assert.equal(s.sent.length, 0);

  const none = setup('no-ci-none', { runners: false });
  await none.land('land: CI gave no verdict\n', 75);
  await none.handoffs.poll();
  assert.equal(none.sent.length, 1);
  assert.match(none.sent[0], /exited 75/);
});

test('a person who wrote while the land was in line keeps the minion open: it is told, not dismissed', async () => {
  const s = setup('talked');
  writeFileSync(join(s.cwd, 'tools', 'land.sh'), `sleep 0.3\nprintf '%b' ${JSON.stringify(LIVE)}\n`);
  assert.ok(s.landings.handOff(1, s.cwd, { PATH: process.env.PATH! }, [], H));
  assert.ok(!s.landings.handOff(1, s.cwd, { PATH: process.env.PATH! }, [], H), 'one landing at a time');
  // A relay or a person's message (runner.send calls talked for any message but an fyi notice).

  s.landings.talked(1);
  await until('land.sh ends', () => s.landings.get(1)?.code !== null);
  await s.handoffs.poll();
  assert.equal(s.notes.length, 1, 'the shipped line still posts');
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /Someone wrote to you while it was in line/);
  assert.ok(!s.did.some((d) => d.startsWith('close')));
});

test("a feeder's merge into its build dismisses it as folded in; an unreported hand-off is never wiped by the next", async () => {
  const s = setup('into');
  mkdirSync(join(s.cwd, 'test'), { recursive: true });
  writeFileSync(join(s.cwd, 'test', 'a.test.ts'), '');
  writeFileSync(join(s.cwd, 'tools', 'land.sh'), "echo 'land: merged into build/3'\n");
  assert.ok(s.landings.handOff(1, s.cwd, { PATH: process.env.PATH! }, ['--into', 'build/3', 'test/a.test.ts'], H));
  await until('land.sh ends', () => s.landings.get(1)?.code !== null);
  assert.ok(!s.landings.handOff(1, s.cwd, { PATH: process.env.PATH! }, [], H), 'ended but not reported: refused, not wiped');
  assert.equal(s.landings.start(1, s.cwd, { PATH: process.env.PATH! }).code, 0, 'the land tool reads that one instead of starting afresh');
  await s.handoffs.poll();
  assert.match(s.notes[0], /^Shipped into build\/3: .* Merged into build\/3, not live until the build lands\.$/);
  assert.equal(s.ticket.note, 'folded into Build 3');
  assert.ok(s.did.some((d) => d.startsWith('close')));
});

test('a clean land with a card still open, or a turn running, is not dismissed out from under it', async () => {
  const card = setup('card', { kept: 'a question card is still waiting on people' });
  await card.land(LIVE);
  await card.handoffs.poll();
  assert.ok(!card.did.some((d) => d.startsWith('close')));
  assert.ok(card.notes.some((n) => /stays open/.test(n)));

  const busy = setup('busy', { running: true });
  await busy.land(LIVE);
  await busy.handoffs.poll();
  assert.ok(busy.did.includes('closeAfterTurn'), 'dismissed once its turn ends');
});

test('a land that ended across a restart is reported by the next server, and one a restart cut off is reported as failed, never lost', async () => {
  const s = setup('across');
  await s.land(LIVE);
  // The next server: a new Landings and reporter on the same data dir.
  const next = new LandHandoffs({ ...s.deps, landings: new Landings(s.data) });
  await next.poll();
  assert.equal(s.notes.length, 1);
  assert.ok(s.did.some((d) => d.startsWith('close')));

  // A landing whose wrapper died with no exit code (a restart cut off a child): started long ago, no pid, no code.
  const cut = setup('cut');
  const dir = join(cut.data, 'run', 'landings', '1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'started'), String(Date.now() - 600_000));
  writeFileSync(join(dir, 'output.log'), 'land: rebasing onto main\n');
  writeFileSync(join(dir, 'handoff.json'), JSON.stringify({ ...H, args: [] }));
  await cut.handoffs.poll();
  assert.equal(cut.sent.length, 1);
  assert.match(cut.sent[0], /ended without an exit code/);
});

// #712: in a scheme that owns contraptions, a clean land on main deploys them and waits, and the shipped line says how it went.
const APP_LAND = 'land: main is now at abc1234 "#9: aura fix"\nland: pushed main to origin\n';

/** Fake contraption deploys: each start becomes the app's last deploy, ending as `outcome` says (state, and the commit it went to). */
function fakeDeploys(outcome: (name: string) => { state: string; to: string | null; said?: string[] }, busy: Record<string, number> = {}) {
  const started: string[] = [];
  const last: Record<string, any> = {};
  const ops: DeployOps = {
    running: (name) => (busy[name] ?? 0) > 0,
    start: async (name, id) => {
      if ((busy[name] ?? 0) > 0) throw new Error(`${name} is being installed or deployed already`);
      started.push(`${name} for ${id}`);
      const o = outcome(name);
      last[name] = { said: ['Fetched', 'Built'], log: `/logs/${name}.log`, tail: 'build output', ...o };
    },
    last: async (name) => last[name] ?? null,
    sleep: async () => {
      for (const k of Object.keys(busy)) busy[k]--;
    },
  };
  return { ops, started };
}

test('a clean land in a scheme with an app deploys it, waits, and says it went live in the shipped line before dismissing', async () => {
  const d = fakeDeploys(() => ({ state: 'deployed', to: 'abc1234ffff0000' }));
  const s = setup('app-live', { apps: ['peek-auras'], deployOps: d.ops });
  await s.land(APP_LAND);
  await s.handoffs.poll();
  assert.deepEqual(d.started, ['peek-auras for 1']);
  assert.deepEqual(s.notes, ['Shipped abc1234 "#9: aura fix": Usage bar in the top bar. Risk low: front end only. Landed. Deployed peek-auras at abc1234ff, healthy.']);
  assert.equal(s.sent.length, 0, 'no model call');
  assert.ok(s.did.some((x) => x.startsWith('close: Landed')), s.did.join('\n'));
});

test('deploy: false, a merge into a build, or a scheme with no app deploys nothing', async () => {
  for (const [name, h, args, apps] of [['app-off', { deploy: false }, [], ['peek-auras']], ['app-build', {}, ['--into', 'build/3', 'test/a.test.ts'], ['peek-auras']], ['app-none', {}, [], []]] as const) {
    const d = fakeDeploys(() => ({ state: 'deployed', to: 'abc1234' }));
    const s = setup(name, { apps: [...apps], deployOps: d.ops });
    await s.land(APP_LAND, 0, h, [...args]);
    await s.handoffs.poll();
    assert.deepEqual(d.started, [], name);
    assert.doesNotMatch(s.notes[0], /Deployed/, name);
    assert.ok(s.did.some((x) => x.startsWith('close: ')), name);
  }
});

test('a deploy that rolls back after a clean land posts the shipped line, then wakes the minion with its log and leaves it open', async () => {
  const d = fakeDeploys(() => ({ state: 'rolled back', to: 'abc1234', said: ['Fetching o/peek main.', 'Failed: Not healthy after 60s: /health not answering', 'Rolling back to 0ld0ld0.', 'Rolled back: 0ld0ld0 runs again.'] }));
  const s = setup('app-fail', { apps: ['peek-auras'], deployOps: d.ops });
  await s.land(APP_LAND);
  await s.handoffs.poll();
  assert.match(s.notes[0], /Landed\. peek-auras's deploy rolled back: Not healthy after 60s: \/health not answering$/);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /^Your handed-off land went through \(abc1234 "#9: aura fix", landed\), but the deploy after it didn't go live:/);
  assert.match(s.sent[0], /didn't go live:\n\n.*\nLog: \/logs\/peek-auras\.log\nLast lines of the log:\nbuild output\n/, 'the log tail once, not its lines twice');
  assert.equal(s.ticket.state, null, 'open for the minion to fix');
  assert.ok(!s.did.some((x) => x.startsWith('close')), s.did.join('\n'));
});

test('deployApps waits behind a running deploy, retries a refused start once, and fails a deploy of another commit', async () => {
  // An auto-deploy of the older main runs for two checks: this one starts after it, so the landed commit goes out.
  const behind = fakeDeploys(() => ({ state: 'deployed', to: 'abc1234aaaa' }), { app: 2 });
  assert.deepEqual(await deployApps(5, ['app'], 'abc1234', behind.ops), [{ name: 'app', ok: true, line: 'Deployed app at abc1234aa, healthy.' }]);
  assert.deepEqual(behind.started, ['app for 5']);

  // Auto-deploy holds its start (409) before its deploy shows as running: the refused start waits, then starts once more.
  const raced: string[] = [];
  let deployed: any = null;
  const race: DeployOps = {
    running: () => false,
    start: async (name) => {
      if (!raced.length) {
        raced.push('refused');
        throw new Error(`${name} is being deployed already`);
      }
      raced.push('started');
      deployed = { state: 'deployed', to: 'abc1234', said: [], log: '' };
    },
    last: async () => deployed,
    sleep: async () => {},
  };
  assert.equal((await deployApps(5, ['app'], 'abc1234', race))[0].ok, true);
  assert.deepEqual(raced, ['refused', 'started']);

  // GitHub's main was behind (land.sh's push failed): the deploy went to the older commit, which isn't a ship.
  const stale = fakeDeploys(() => ({ state: 'deployed', to: '0ld0ld0aaaa' }));
  stale.ops.has = async () => false;
  const [r] = await deployApps(5, ['app'], 'abc1234', stale.ops);
  assert.equal(r.ok, false);
  assert.match(r.line, /deployed 0ld0ld0aa, which doesn't hold the landed abc1234: GitHub's main didn't have it yet/);

  // A start refused for good (no repo, services off) fails after its one retry, with its reason.
  const refused: DeployOps = { running: () => false, start: async () => { throw new Error('Mandate has no repo set'); }, last: async () => null, sleep: async () => {} };
  assert.deepEqual(await deployApps(5, ['mandate'], 'abc1234', refused), [{ name: 'mandate', ok: false, line: "mandate's deploy couldn't start: Mandate has no repo set" }]);
});

test('deployApps counts a deploy of a newer main as shipped, and skips an app already running a commit that holds the land', async () => {
  // Another land pushed past this one before its deploy fetched: the newer commit holds it, so it shipped.
  const newer = fakeDeploys(() => ({ state: 'deployed', to: 'ccc9999aaaa' }));
  const asked: string[] = [];
  newer.ops.has = async (name, landed, to) => (asked.push(`${name} ${landed} in ${to}`), landed === 'abc1234' && to === 'ccc9999aaaa');
  assert.deepEqual(await deployApps(5, ['app'], 'abc1234', newer.ops), [{ name: 'app', ok: true, line: 'Deployed app at ccc9999aa, healthy.' }]);
  assert.ok(asked.includes('app abc1234 in ccc9999aaaa'), asked.join('\n'));

  // A batch's lands share one commit: the first deploys it, the rest find it running and start nothing.
  const batch = fakeDeploys(() => ({ state: 'deployed', to: 'abc1234ffff' }));
  for (const id of [5, 6, 7]) assert.equal((await deployApps(id, ['app'], 'abc1234', batch.ops))[0].line, 'Deployed app at abc1234ff, healthy.');
  assert.deepEqual(batch.started, ['app for 5'], 'one deploy for the batch');

  // A last deploy that rolled back (or ran an older commit) is no reason to skip.
  const after = fakeDeploys(() => ({ state: 'deployed', to: 'abc1234ffff' }));
  await after.ops.start('app', 1);
  (await after.ops.last('app'))!.state = 'rolled back';
  await deployApps(5, ['app'], 'abc1234', after.ops);
  assert.deepEqual(after.started, ['app for 1', 'app for 5']);
});

test('landResult reads deploy.sh\'s lines; outputTail keeps the last lines', () => {
  assert.deepEqual(landResult(LIVE, 0), { kind: 'live', commit: 'abc1234', subject: '#9: usage bar' });
  assert.equal(landResult(RESTART, 0).kind, 'restart');
  assert.equal(landResult(`${RESTART}deploy: live now: the server restarted on def5678 and stayed healthy\n`, 0).kind, 'live');
  assert.equal(landResult('deploy: nothing to deploy: the server already runs abc1234\n', 0).kind, 'live');
  assert.equal(landResult('land: main is now at abc1234 "#9: say live now: in the chat"\ndeploy: not live yet after 75 s\n', 0).kind, 'restart', 'a subject saying the words is not deploy.sh saying them');
  assert.equal(landResult('restart queued by our own deploy\n', 0).kind, 'landed', "another scheme's land.sh saying the words");
  assert.deepEqual(landResult('merged\n', 0), { kind: 'landed' }, "another scheme's land.sh");
  assert.equal(landResult(LIVE, 1).kind, 'failed');
  assert.equal(landResult('', 75).kind, 'no-ci');
  const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  assert.ok(outputTail(long).endsWith('line 499'));
  assert.ok(!outputTail(long).includes('line 400\n'));
});

// The route: what it refuses before the minion ends its turn, and a clean land end to end through a real server.
test('the hand-off route refuses uncommitted work, a missing label and a high risk with no go, and reports a clean land', async () => {
  const srv = await bootServer();
  try {
    const store = new Store(join(srv.data, 'coordinator.db'));
    const project = store.createProject('P', null);
    const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
    const cwd = join(srv.root, 'wt');
    mkdirSync(join(cwd, 'tools'), { recursive: true });
    writeFileSync(join(cwd, 'tools', 'land.sh'), `printf '%b' ${JSON.stringify(LIVE)}\n`);
    git(cwd, 'init', '-q');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'init');
    store.setTicketDir(minion.id, cwd, null);
    const token = agentToken(srv.data, minion.id);
    const handOff = (body: object) => fetch(`${srv.base}/api/tickets/${minion.id}/land/handoff`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const body = { summary: 'Usage bar', risk: 'low', risk_reason: 'front end only' };

    writeFileSync(join(cwd, 'tools', 'land.sh'), `printf '%b' ${JSON.stringify(LIVE)}\n# edited\n`);
    const dirty = await handOff(body);
    assert.equal(dirty.status, 409);
    assert.match((await dirty.json()).error, /uncommitted changes/);
    git(cwd, 'checkout', '--', 'tools/land.sh');
    assert.equal((await handOff({ ...body, risk: undefined })).status, 400);
    const high = await handOff({ ...body, risk: 'high' });
    assert.equal(high.status, 400);
    assert.match((await high.json()).error, /go/);

    const full = await handOff({ ...body, into: 'build/2', full: true });
    assert.equal(full.status, 400, "a build minion's take-in of main stays in its turn");
    assert.match((await full.json()).error, /--full yourself/);

    assert.equal((await handOff({ ...body, deploy: 'no' })).status, 400, 'deploy is true or false');
    assert.equal((await handOff(body)).status, 202);
    assert.equal(store.getTicket(minion.id)!.state, 'outside');
    await until('the server reports the land', () => store.getTicket(minion.id)!.status === 'closed', 20_000);
    assert.ok(store.listEvents(minion.id).some((e) => String(e.data).includes('Shipped abc1234')), 'the shipped line is in its chat');

  } finally {
    await srv.stop();
  }
});
