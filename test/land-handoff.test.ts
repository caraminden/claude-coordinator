import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { deployApps, LandHandoffs, landConflict, Landings, landPhase, landResult, outputTail, type DeployOps, type HandoffDeps } from '../src/land.ts';
import { agentToken, bootServer, until } from './helpers.ts';
import { git } from './git.ts';
import { withRealDeploy } from './land-fixture.ts';

// #706: a minion hands its land to the server and ends its turn. The server runs land.sh, and on a clean land posts
// the shipped line and dismisses or parks the minion with no model call; on a failure it wakes the minion with the
// end of land.sh's output.
const root = mkdtempSync(join(tmpdir(), 'land-handoff-'));
after(() => rmSync(root, { recursive: true, force: true }));

const H = { summary: 'Usage bar in the top bar.', risk: 'low' as const, reason: 'front end only' };
const LIVE = 'land: main is now at abc1234 "#9: usage bar"\ndeploy: live now: the server reloaded the front end (v2); open tabs reload when idle. No restart.\n';
const RESTART = 'land: main is now at def5678 "#9: server bit"\ndeploy: restart queued as citadel-restart: running turns carry on through it, and it reports here\ndeploy: not live yet after 75 s; the restart reports here when it is\n';

/** A Landings in a data dir of its own, a minion worktree whose land.sh prints `out` and exits `code`, and fake deps that record what the server did. */
function setup(name: string, opts: { owner?: number | null; ownerState?: string | null; running?: boolean; kept?: string | null; runners?: boolean; liveAlready?: boolean; liveAtWait?: boolean; apps?: string[]; deployOps?: DeployOps } = {}) {
  const data = join(root, name, 'data');
  const cwd = join(root, name, 'wt');
  mkdirSync(join(cwd, 'tools'), { recursive: true });
  const landings = new Landings(data);
  const ticket = { number: 7, title: 'Wake the owner', status: 'idle', state: 'outside' as string | null, note: 'landing: starting' as string | null };
  const did: string[] = [];
  const sent: string[] = [];
  const light: boolean[] = [];
  const notes: string[] = [];
  const owned: any[] = [];
  const waits: { commit: string | null; text: string }[] = [];
  const deps: HandoffDeps = {
    landings,
    store: { getTicket: (id: number) => (id === 1 ? ticket : { number: 9, title: 'The build', status: 'idle', state: opts.ownerState ?? null }), updateTicket: (_id, f) => { Object.assign(ticket, f); did.push(`state ${f.state}`); } },
    runner: {
      emit: (_id, _kind, data: any) => { notes.push(data.text); },
      send: (_id, _from, text, _images, extra) => { sent.push(text); light.push(!!extra?.light); },
      unpark: (id, by) => { did.push(`unpark ${id} by ${by}`); return true; },
      relayMinion: (from, to, author, text, urgent, wake, unparked) => { owned.push({ from, to, author, text, urgent, wake, unparked }); return false; },
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
    buildOwner: () => (opts.owner === undefined ? 2 : opts.owner),
    runnersBack: (_id, reason) => { did.push(`runnersBack: ${reason}`); return opts.runners ?? true; },
    liveAlready: async () => !!opts.liveAlready,
    wakeWhenLive: async (_id, commit, text) => { if (opts.liveAtWait) return false; waits.push({ commit, text }); return true; },
    ...(opts.deployOps ? { apps: () => opts.apps ?? [], deployOps: opts.deployOps } : {}),
  };
  const land = async (out: string, code = 0, h: object = H, args: string[] = []) => {
    writeFileSync(join(cwd, 'tools', 'land.sh'), `printf '%b' ${JSON.stringify(out)}\nexit ${code}\n`);
    assert.ok(landings.handOff(1, cwd, { PATH: process.env.PATH! }, args, { ...H, ...h }));
    await until('land.sh ends', () => landings.get(1)?.code !== null);
  };
  return { owned, waits, landings, ticket, did, sent, light, notes, deps, land, handoffs: new LandHandoffs(deps), data, cwd };
}

test('a clean land that is live now posts the shipped line and dismisses the minion, with no message to it', async () => {
  const s = setup('live');
  await s.land(LIVE);
  await s.handoffs.poll();
  assert.deepEqual(s.notes, ['Shipped abc1234 "#9: usage bar": Usage bar in the top bar. Risk low: front end only. Live now.']);
  assert.equal(s.sent.length, 0, 'no model call');
  assert.ok(s.did.some((d) => d.startsWith('close: Shipped and live')), s.did.join('\n'));
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

test('stay_open: a clean land still posts the shipped line but never dismisses, live now or after the restart (#909)', async () => {
  const live = setup('stay-live');
  await live.land(LIVE, 0, { stayOpen: true });
  await live.handoffs.poll();
  assert.match(live.notes[0], /^Shipped abc1234 .* Live now\./);
  assert.ok(!live.did.some((d) => d.startsWith('close')), live.did.join('\n'));
  assert.equal(live.ticket.state, 'ready');
  assert.deepEqual(live.landings.handoffs(), [], 'reported once');
  assert.equal(live.sent.length, 0, 'no model call');

  const restart = setup('stay-restart', { liveAlready: true });
  await restart.land(RESTART, 0, { stayOpen: true });
  await restart.handoffs.poll();
  assert.match(restart.notes[0], /Waiting for the restart\./);
  assert.ok(!restart.did.includes('deployPending'), 'pending-deploy would dismiss it once live');
  assert.ok(!restart.did.includes('deployLive'));
  assert.notEqual(restart.ticket.state, 'pending-deploy');
  assert.ok(!restart.did.some((d) => d.startsWith('close')));
});

test('stay_open with waiting_on: a clean land wakes the minion with the shipped line once its work is live, and never parks it (#942)', async () => {
  const live = setup('stay-waiting-live');
  await live.land(LIVE, 0, { stayOpen: true, waitingOn: 'Cara confirming on her phone' });
  await live.handoffs.poll();
  assert.notEqual(live.ticket.state, 'parked', 'nothing would wake a parked minion: its after-land steps never ran');
  assert.ok(!live.did.some((d) => d.startsWith('close')));
  assert.equal(live.sent.length, 1, 'woken once, at live');
  assert.match(live.sent[0], /abc1234 "#9: usage bar"/);
  assert.match(live.sent[0], /live now/i);
  assert.match(live.sent[0], /Cara confirming on her phone/);
  assert.deepEqual(live.light, [true], 'a land that landed is a success notice: its wake runs at low effort (#951)');

  // Waiting for the restart: woken by the live check (wake_when_live's waiter), not before, and not twice.
  const restart = setup('stay-waiting-restart');
  await restart.land(RESTART, 0, { stayOpen: true, waitingOn: 'the CI run' });
  await restart.handoffs.poll();
  assert.equal(restart.sent.length, 0, 'not live yet: no wake');
  assert.equal(restart.waits.length, 1);
  assert.equal(restart.waits[0].commit, 'def5678');
  assert.match(restart.waits[0].text, /def5678 "#9: server bit"/);
  assert.match(restart.waits[0].text, /the CI run/);
  assert.notEqual(restart.ticket.state, 'parked');
  assert.notEqual(restart.ticket.state, 'pending-deploy');
  assert.ok(!restart.did.includes('deployPending'));

  // Its restart already live (or the waiter finds it live at once): woken now.
  const early = setup('stay-waiting-early', { liveAlready: true });
  await early.land(RESTART, 0, { stayOpen: true, waitingOn: 'the CI run' });
  await early.handoffs.poll();
  assert.equal(early.sent.length, 1);
  assert.equal(early.waits.length, 0);
  assert.match(early.sent[0], /the CI run/);
  assert.notEqual(early.ticket.state, 'parked');

  // Live by the time the waiter is set: the waiter stores nothing, so the land wakes it now.
  const raced = setup('stay-waiting-raced', { liveAtWait: true });
  await raced.land(RESTART, 0, { stayOpen: true, waitingOn: 'the CI run' });
  await raced.handoffs.poll();
  assert.equal(raced.sent.length, 1);
  assert.match(raced.sent[0], /live now/);
  assert.equal(raced.ticket.state, null);
});

test('stay_open with a restart and a person who wrote in line: the message never says pending-deploy', async () => {
  const s = setup('stay-talked');
  await s.land(RESTART, 0, { stayOpen: true });
  s.landings.talked(1);
  assert.ok(s.landings.wasTalked(1));
  await s.handoffs.poll();
  assert.ok(!s.sent.some((m) => /pending-deploy/.test(m)), s.sent.join('\n'));
});

test('stay_open does not change a failed land: it wakes the minion with the output', async () => {
  const s = setup('stay-failed');
  await s.land('land: conflict\n', 1, { stayOpen: true });
  await s.handoffs.poll();
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /didn't go through/);
  assert.deepEqual(s.light, [false], "a failure keeps the minion's own effort (#951)");
  assert.equal(s.ticket.state, null);
  assert.ok(!s.did.some((d) => d.startsWith('close')));
});

test('a failed land leads its wake with the kind of red (#1013), and an unknown one keeps the plain text', async () => {
  const a = setup('kind-parse');
  await a.land("land: smoke: a .ts file does not parse, before the line (2 s), so nothing landed\n", 1);
  await a.handoffs.poll();
  assert.match(a.sent[0], /^Kind: parse error/);
  assert.match(a.sent[0], /Your handed-off land didn't go through/);
  const b = setup('kind-unknown');
  await b.land('land: something odd\n', 1);
  await b.handoffs.poll();
  assert.match(b.sent[0], /^Your handed-off land didn't go through/);
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

test('a land whose branch moved but whose push to origin failed says it landed locally and what to do, never that it did not go through (#911)', async () => {
  const s = setup('unpushed');
  const out = 'land: CI passed on d1a5c2f6\nland: master is now at d1a5c2f "#15: seed the tree"\nland: master moved, but the push to origin failed: remote: Repository not found.\nfatal: repository \'https://github.com/o/r.git/\' not found\nland: the next landing retries it; if origin\'s master moved on its own (rejected as non-fast-forward), a person merges it into /repo first\n';
  await s.land(out, 1);
  await s.handoffs.poll();
  assert.equal(s.sent.length, 1, 'woken once');
  assert.doesNotMatch(s.sent[0], /didn't go through|hand it off again with hand_off_land/);
  assert.match(s.sent[0], /master moved locally to d1a5c2f "#15: seed the tree"/);
  assert.match(s.sent[0], /push to origin failed: remote: Repository not found\.\nfatal: repository 'https:\/\/github\.com\/o\/r\.git\/' not found/);
  assert.match(s.sent[0], /git push origin master/, 'says how to push it now');
  assert.ok(s.notes.some((n) => n.startsWith('Shipped d1a5c2f "#15: seed the tree"') && /not pushed to origin/i.test(n)), 'the shipped line says it landed but is not pushed');
  assert.equal(s.ticket.state, null, 'left open for the minion to push');
  assert.ok(!s.did.some((d) => d.startsWith('close')), 'not dismissed');
  assert.equal(landResult('land: master moved, but the push to origin failed: error: one\n\nhint: two\n', 1).error, 'error: one\n\nhint: two', "a blank line in git's output doesn't cut it short");
  assert.deepEqual(landResult(out, 1), { kind: 'unpushed', commit: 'd1a5c2f', subject: '#15: seed the tree', branch: 'master', error: "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found" });
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
  assert.match(s.notes[0], /^Merged into build\/3: .* Merged into build\/3, not live until the build ships\.$/);
  assert.equal(s.ticket.note, 'merged into Build 3');
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
  // A server starting after it finds the file (the set is read from disk once, at start).
  await new LandHandoffs({ ...cut.deps, landings: new Landings(cut.data) }).poll();
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
  assert.deepEqual(s.notes, ['Shipped abc1234 "#9: aura fix": Usage bar in the top bar. Risk low: front end only. Shipped. Deployed peek-auras at abc1234ff, healthy.']);
  assert.equal(s.sent.length, 0, 'no model call');
  assert.ok(s.did.some((x) => x.startsWith('close: Shipped')), s.did.join('\n'));
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
  assert.match(s.notes[0], /Shipped\. peek-auras's deploy rolled back: Not healthy after 60s: \/health not answering$/);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /^Your handed-off land went through \(abc1234 "#9: aura fix", shipped\), but the deploy after it didn't go live:/);
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

// #1271: the lines above are copies; these are what the real tools/deploy.sh says, so a reworded line there that the
// server would read as merely landed (no live, no restart) fails here.
test("landResult reads the real deploy.sh's lines: live, already live, and a restart still to come", { timeout: 120_000 }, () => {
  let running = '';
  return withRealDeploy(async (r, run) => {
    const deploy = join(import.meta.dirname, '..', 'tools', 'deploy.sh');
    // Each status line on its own too, so one regex alternative can't stand in for another.
    const as = async (what: string, bin: string | null, lines: RegExp[], kind: string, extra: Record<string, string> = {}) => {
      r.commit(r.source, `${what}.txt`, `${what}\n`);
      const res = await run(deploy, r.source, { ...(bin && { PATH: `${bin}:${join(r.dir, 'bin')}:${process.env.PATH}` }), ...extra });
      assert.equal(landResult(res.stderr, 0).kind, kind, `${what}: ${res.stderr}`);
      for (const re of lines) {
        const line = res.stderr.split('\n').find((l) => re.test(l));
        assert.ok(line, `${what}: no line like ${re}: ${res.stderr}`);
        assert.equal(landResult(`${line}\n`, 0).kind, kind, `${what}: ${line}`);
      }
    };
    await as('restarted', null, [/^deploy: live now: the server restarted on/], 'live');
    const again = await run(deploy, r.source);
    assert.match(again.stderr, /^deploy: nothing to deploy: the server already runs/m);
    assert.equal(landResult(again.stderr, 0).kind, 'live');
    running = git(r.live, 'rev-parse', 'HEAD'); // from here the server stays on it, so each deploy has a change
    const fake = (name: string, script: string) => {
      const bin = join(r.dir, name);
      mkdirSync(bin);
      writeFileSync(join(bin, 'systemd-run'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      return bin;
    };
    await as('queued', fake('idle-bin', 'exit 0'), [/^deploy: restart queued as /, /^deploy: not live yet after 1 s/], 'restart', { DEPLOY_HEALTHY_WAIT: '0', DEPLOY_SETTLE: '0', DEPLOY_TEST_LIVE_GRACE: '1' });
    await as('joined', fake('joined-bin', 'echo "Failed to start transient service unit: Unit cc-restart-when-idle.service already exists." >&2; exit 1'), [/^deploy: a restart is already queued as/], 'restart');
  }, () => (running ? { commit: running } : {}));
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

test("landConflict reads only land.sh --check's exit 3 as a conflict: an older land.sh, a failure or a hang hands off as before (#770)", async () => {
  const cwd = mkdtempSync(join(root, 'check-'));
  mkdirSync(join(cwd, 'tools'));
  const script = (body: string) => writeFileSync(join(cwd, 'tools', 'land.sh'), body);
  const env = { PATH: process.env.PATH! };
  script('echo "land: $1 $2" >&2; echo "land: conflicted files: a.txt" >&2; exit 3\n');
  assert.equal(await landConflict(cwd, env, ['--into', 'build/2']), '--check --into\nconflicted files: a.txt', 'its lines, with --check before the land\'s own arguments');
  script('echo "land: takes no arguments" >&2; exit 1\n');
  assert.equal(await landConflict(cwd, env, []), null, 'a land.sh from before --check');
  script('exit 0\n');
  assert.equal(await landConflict(cwd, env, []), null);
  script('sleep 5; exit 3\n');
  assert.equal(await landConflict(cwd, env, [], 300), null, 'a hang is no verdict');
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
    // --check (#770): exit 3 with its refusal while the file "conflict" is there (untracked, so the worktree stays clean).
    writeFileSync(join(cwd, 'tools', 'land.sh'), `if [ "$1" = --check ]; then [ -e conflict ] || exit 0; echo "land: ticket/1-x won't rebase onto main cleanly, so nothing landed; conflicted files: a.txt. On conflicts: run git rebase main" >&2; exit 3; fi\nprintf '%b' ${JSON.stringify(LIVE)}\n`);
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
    store.setProjectSettings(project.id, { go_from: 'all' });
    const low = await handOff(body);
    assert.equal(low.status, 400, "a scheme whose every change needs a go refuses a low one without it (#1043)");
    assert.match((await low.json()).error, /every change ships only on a person's go/);
    assert.match((await (await handOff({ ...body, into: 'build/2', deploy: 'no' })).json()).error, /^deploy must be/, "a feeder's merge into its build is covered by the build's go card");
    store.setProjectSettings(project.id, { go_from: 'never' });
    assert.match((await (await handOff({ ...body, risk: 'high', deploy: 'no' })).json()).error, /^deploy must be/, 'with no go needed, a high one gets past the go check to the next one');
    store.setProjectSettings(project.id, { go_from: 'high', skills_off: 'self-review' });
    const unreviewed = await handOff(body);
    assert.equal(unreviewed.status, 400, 'with self-review off nothing labels the risk, so a low change needs a go too (#1062, Q10)');
    assert.match((await unreviewed.json()).error, /turned self-review off/);
    assert.match((await (await handOff({ ...body, go: 'Josh, 2026-11-19 10:00 PST', deploy: 'no' })).json()).error, /^deploy must be/, 'a named go gets it past');
    store.setProjectSettings(project.id, { skills_off: '' });

    const full = await handOff({ ...body, into: 'build/2', full: true });
    assert.equal(full.status, 400, "a build minion's take-in of main stays in its turn");
    assert.match((await full.json()).error, /--full yourself/);

    assert.equal((await handOff({ ...body, deploy: 'no' })).status, 400, 'deploy is true or false');
    assert.equal((await handOff({ ...body, stay_open: 'yes' })).status, 400, 'stay_open is true or false');
    assert.equal((await handOff({ ...body, waiting_on: 'x' })).status, 400, 'waiting_on goes with stay_open');
    writeFileSync(join(cwd, 'conflict'), '');
    const clash = await handOff(body);
    assert.equal(clash.status, 409, 'a branch that would conflict is sent back in the turn');
    assert.equal((await clash.json()).error, "Not handed off: ticket/1-x won't rebase onto main cleanly, so nothing landed; conflicted files: a.txt. On conflicts: run git rebase main");
    assert.equal(store.getTicket(minion.id)!.state, null, 'nothing was handed off');
    rmSync(join(cwd, 'conflict'));
    assert.equal((await handOff(body)).status, 202);
    assert.equal(store.getTicket(minion.id)!.state, 'outside');
    assert.equal(store.getTicket(minion.id)!.note, 'landing: starting', 'the list says it is landing (#962)');
    await until('the server reports the land', () => store.getTicket(minion.id)!.status === 'closed', 20_000);
    assert.ok(store.listEvents(minion.id).some((e) => String(e.data).includes('Shipped abc1234')), 'the shipped line is in its chat');

  } finally {
    await srv.stop();
  }
});

// #1398 (Cara, 2026-11-20, "Fixes ship; data still asks"): a high bug fix with its proof ships with no go and says so;
// no proof, not a bug, a red_on off main, or a diff that rewrites data is refused. Peek-like scheme (every-scheme skill).
test('a high bug fix with fix_proof ships without a go and its line says so; without proof, as a non-fix or touching data it is refused', async () => {
  const srv = await bootServer();
  try {
    const store = new Store(join(srv.data, 'coordinator.db'));
    const project = store.createProject('Peek', null);
    const minion = store.createTicket({ project_id: project.id, title: 'Fix the guard', permission_mode: 'default', created_by: 'Cara' });
    const cwd = join(srv.root, 'wt');
    mkdirSync(join(cwd, 'tools'), { recursive: true });
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'test'));
    writeFileSync(join(cwd, 'tools', 'land.sh'), `[ "$1" = --check ] && exit 0\nprintf '%b' ${JSON.stringify(LIVE)}\n`);
    writeFileSync(join(cwd, 'src', 'guard.ts'), 'export const ok = false;\n');
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'init');
    const main = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'checkout', '-q', '-b', 'ticket/1-fix');
    writeFileSync(join(cwd, 'src', 'guard.ts'), 'export const ok = true;\n');
    writeFileSync(join(cwd, 'test', 'guard.test.ts'), "// a fixture's SQL is not a migration: UPDATE tickets SET x = 1\n");
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'fix');
    store.setTicketDir(minion.id, cwd, null);
    const token = agentToken(srv.data, minion.id);
    const handOff = async (body: object) => {
      const res = await fetch(`${srv.base}/api/tickets/${minion.id}/land/handoff`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, error: res.status === 202 ? '' : String((await res.json()).error) };
    };
    const proof = { test: 'test/guard.test.ts', red_on: main, red_output: 'not ok 1 - the guard lets a fix through', review: 'clean: 0 findings' };
    const body = { summary: 'Guard fix', risk: 'high', risk_reason: 'guard file', fix_proof: proof };

    const notBug = await handOff(body);
    assert.equal(notBug.status, 400);
    assert.match(notBug.error, /type is unset, not bug/, 'a high non-fix is refused');
    store.props.set('minion', minion.id, project.id, { type: 'bug' }, 'Cara');
    const noProof = await handOff({ ...body, fix_proof: undefined });
    assert.equal(noProof.status, 400, 'a high fix with no proof still needs a go');
    assert.match(noProof.error, /ships only on a person's go.*fix_proof instead/);
    assert.match((await handOff({ ...body, fix_proof: { ...proof, red_on: git(cwd, 'rev-parse', 'HEAD') } })).error, /isn't on main/, 'red_on is a commit on main');
    assert.match((await handOff({ ...body, fix_proof: { ...proof, test: 'test/none.test.ts' } })).error, /isn't a file committed in your branch/);
    assert.match((await handOff({ ...body, fix_proof: { ...proof, test: '.' } })).error, /isn't a file committed in your branch/, 'a folder is no test');
    assert.match((await handOff({ ...body, fix_proof: { ...proof, test: 'tools/land.sh' } })).error, /neither changed by your branch nor a test file/, 'any file is no test');
    assert.match((await handOff({ ...body, fix_proof: { ...proof, review: '2 findings left' } })).error, /starts with "clean"/);
    assert.match((await handOff({ ...body, fix_proof: { ...proof, red_output: undefined } })).error, /red_output is required/);
    store.setProjectSettings(project.id, { go_from: 'all' });
    assert.match((await handOff(body)).error, /every change ships only on a person's go: name who gave it and when in go, or ask with a ship card \(kind ship\) first$/, 'where every change waits, a fix waits too');
    store.setProjectSettings(project.id, { go_from: 'high' });

    writeFileSync(join(cwd, 'src', 'store.ts'), "db.exec('DELETE FROM tickets WHERE closed');\n");
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'prune');
    const data = await handOff(body);
    assert.equal(data.status, 400, 'a fix that touches data is refused');
    assert.match(data.error, /src\/store\.ts adds `db\.exec\('DELETE FROM tickets.*data and auth changes always wait/);
    git(cwd, 'reset', '-q', '--hard', 'HEAD~1');
    writeFileSync(join(cwd, 'src', 'auth.ts'), 'export const x = 1;\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'auth');
    assert.match((await handOff(body)).error, /src\/auth\.ts, an auth file/, 'an auth change is refused');
    git(cwd, 'reset', '-q', '--hard', 'HEAD~1');

    assert.equal((await handOff(body)).status, 202, 'a high bug fix with its proof ships with no go');
    await until('the server reports the land', () => store.getTicket(minion.id)!.status === 'closed', 20_000);
    const line = `Shipped as a fix without a go: test/guard.test.ts (red on ${main.slice(0, 7)})`;
    assert.ok(store.listEvents(minion.id).some((e) => String(e.data).includes(line)), 'the shipped line says it shipped without a go');
    assert.ok(store.lastShippedNote(minion.id)?.includes(line), 'Releases reads the line from the newest shipped line');
  } finally {
    await srv.stop();
  }
});

// Fast mode (#1017): in a fast scheme a low or medium land gets LAND_FAST=1 and a high one doesn't; both get the
// scheme's known reds. Peek-like scheme, not Citadel (the every-scheme skill).
test('in a fast scheme the hand-off passes LAND_FAST for low and medium only, and the known-red ledger to every land', async () => {
  const srv = await bootServer();
  try {
    const store = new Store(join(srv.data, 'coordinator.db'));
    const project = store.createProject('Peek', null);
    store.setProjectSettings(project.id, { land_mode: 'fast' });
    store.setSetting(`fast-mode:${project.id}`, { reds: [{ ids: ['test/x.test.ts'], sha: 'abc1234', ticket: null, n: 41, at: 0 }], landed: {} });
    const landWith = async (name: string, body: object) => {
      const minion = store.createTicket({ project_id: project.id, title: name, permission_mode: 'default', created_by: 'Cara' });
      const cwd = join(srv.root, name);
      mkdirSync(join(cwd, 'tools'), { recursive: true });
      const dump = join(srv.root, `${name}.env`);
      writeFileSync(join(cwd, 'tools', 'land.sh'), `[ "$1" = --check ] && exit 0\nprintf 'fast=%s\\nknown=%s\\n' "\${LAND_FAST:-}" "\${LAND_KNOWN_RED:-}" >${JSON.stringify(dump)}\nprintf '%b' ${JSON.stringify(LIVE)}\n`);
      git(cwd, 'init', '-q');
      git(cwd, 'add', '.');
      git(cwd, 'commit', '-qm', 'init');
      store.setTicketDir(minion.id, cwd, null);
      const res = await fetch(`${srv.base}/api/tickets/${minion.id}/land/handoff`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken(srv.data, minion.id)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: name, risk_reason: 'r', ...body }) });
      assert.equal(res.status, 202, await res.text());
      await until(`${name} land.sh ran`, () => existsSync(dump), 20_000);
      return readFileSync(dump, 'utf8');
    };
    assert.equal(await landWith('low', { risk: 'low' }), 'fast=1\nknown=test/x.test.ts\t#41 is fixing it\n');
    assert.equal(await landWith('medium', { risk: 'medium' }), 'fast=1\nknown=test/x.test.ts\t#41 is fixing it\n');
    assert.equal(await landWith('high', { risk: 'high', go: 'Cara, 10:00 PST' }), 'fast=\nknown=test/x.test.ts\t#41 is fixing it\n', 'high keeps the full gate');
  } finally {
    await srv.stop();
  }
});

test("a feeder's merge into a build wakes the build's parked owner with one message, unparking it; no owner, the feeder itself, or a land on main sends nothing", async () => {
  const into = ['--into', 'build/3', 'test/a.test.ts'];
  const s = setup('owner', { ownerState: 'parked' });
  mkdirSync(join(s.cwd, 'test'), { recursive: true });
  writeFileSync(join(s.cwd, 'test', 'a.test.ts'), '');
  await s.land('land: merged into build/3\n', 0, H, into);
  await s.handoffs.poll();
  assert.equal(s.owned.length, 1);
  const m = s.owned[0];
  assert.deepEqual([m.from, m.to, m.urgent, m.wake, m.unparked], [1, 2, true, true, true], 'urgent and waking, so a cold owner still wakes');
  assert.equal(m.text, '#7 Wake the owner merged into build/3: Usage bar in the top bar. Risk low: front end only.');
  assert.ok(s.did.some((d) => d.startsWith('unpark 2 by #7')), 'unparked first');

  const none = setup('owner-none', { owner: null });
  mkdirSync(join(none.cwd, 'test'), { recursive: true });
  writeFileSync(join(none.cwd, 'test', 'a.test.ts'), '');
  await none.land('land: merged into build/3\n', 0, H, into);
  await none.handoffs.poll();
  const self = setup('owner-self', { owner: 1 });
  await self.land('land: merged into build/3\n', 0, H, into);
  await self.handoffs.poll();
  const main = setup('owner-main');
  await main.land(LIVE);
  await main.handoffs.poll();
  assert.deepEqual([none.owned.length, self.owned.length, main.owned.length], [0, 0, 0]);
});

// #962: while a handed-off land runs, the minions list shows it landing (state outside), whatever cleared the state
// meanwhile (the minion's own closing status line, a turn a person started, a restart), with the phase it is in; each
// way the land ends replaces that with its own end state, so none is left in outside.
test('landPhase reads the phase from land.sh\'s newest phase line', () => {
  assert.equal(landPhase(''), 'landing: starting');
  assert.equal(landPhase('queue: 2nd in line (ahead: #12 "x")\n'), 'landing: in line');
  assert.equal(landPhase('queue: 2nd in line (ahead: #12)\nqueue: got the deploy lock\nland: rebasing ticket/1-x onto main (abc "y")\n'), 'landing: rebasing');
  assert.equal(landPhase('land: rebasing a onto main\nland: running test/a.test.ts on abc1234\nok 1\n'), 'landing: running tests');
  assert.equal(landPhase('land: rebasing a onto main\nland: waiting for CI on abc1234: the full suite on Cara\'s desktop (at most 6 min, then it runs here)\n'), 'landing: waiting on CI');
  assert.equal(landPhase('land: waiting for CI on abc\nland: only flakes failed (x); running CI once more on abc, the land needs a fully green run\n'), 'landing: waiting on CI');
  assert.equal(landPhase('land: waiting for CI on abc\nland: CI FALLBACK: no runner. Running the full suite on perigee instead.\n'), 'landing: running tests');
  assert.equal(landPhase('land: waiting for CI on abc\nland: waiting for CI or a quiet perigee: CI: no runner, but perigee is busy (load 40.00 on 16 cores (quiet is under half)), so this keeps asking CI\n'), 'landing: waiting for CI or a quiet perigee');
  assert.equal(landPhase('land: waiting for CI on abc\nqueue: waiting for the restart ahead to have its verdict; main and the live checkout stay as they are until then\n'), 'landing: in line');
  assert.equal(landPhase('land: waiting for CI on abc\nland: main is now at abc1234 "#9"\ndeploy: restart queued as citadel-restart\n'), 'landing: deploying');
  assert.equal(landPhase('land: smoke: checking ticket/1-x before it queues\nland: smoke: running 5 test files\n'), 'landing: smoke check');
  assert.equal(landPhase('land: smoke: passed in 19 s\nqueue: 2nd in line (ahead: #12)\n'), 'landing: in line');
});

const SMOKE_RED = 'land: smoke: checking ticket/1-x before it queues\nland: smoke: ✖ test/prompt-budget.test.ts › budget\nland: smoke: tests failed (exit 1), before the line (21 s), so nothing landed and nobody waited on it. Fix it, re-test (citadel-test), commit, then run this again\n';

test('a smoke refusal (#1012) is a failed land that says it never got in line', async () => {
  assert.deepEqual(landResult(SMOKE_RED, 1), { kind: 'failed', smoke: true });
  assert.deepEqual(landResult('land: smoke: passed in 3 s\nland: the rebase onto main failed (see above), so nothing landed\n', 1), { kind: 'failed' }, 'a refusal after a passed smoke is a plain failure');
  const s = setup('smoke-red');
  await s.land(SMOKE_RED, 1);
  await s.handoffs.poll();
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /didn't go through: its smoke check refused it before it got in line, in seconds \(nothing landed, and it never waited on the line or CI\)\. Fix the cause/);
  assert.match(s.sent[0], /prompt-budget\.test\.ts › budget/);
});

test('while a handed-off land runs, each poll keeps the minion in outside with its phase, across a restart too', async () => {
  const s = setup('landing-state');
  writeFileSync(join(s.cwd, 'tools', 'land.sh'), `echo 'queue: 2nd in line (ahead: #12)' >&2\nwhile [ ! -e ci ]; do sleep 0.05; done\necho 'land: waiting for CI on abc1234' >&2\nwhile [ ! -e done ]; do sleep 0.05; done\nprintf '%b' ${JSON.stringify(LIVE)}\n`);
  assert.ok(s.landings.handOff(1, s.cwd, { PATH: process.env.PATH! }, [], H));
  await until('land.sh is in line', () => /queue:/.test(s.landings.get(1)?.output ?? ''));
  // The minion's closing status line, or a person's turn, cleared it.
  Object.assign(s.ticket, { state: null, note: null });
  await s.handoffs.poll();
  assert.deepEqual([s.ticket.state, s.ticket.note], ['outside', 'landing: in line']);
  writeFileSync(join(s.cwd, 'ci'), '');
  await until('land.sh waits on CI', () => /waiting for CI/.test(s.landings.get(1)?.output ?? ''));
  await s.handoffs.poll();
  assert.deepEqual([s.ticket.state, s.ticket.note], ['outside', 'landing: waiting on CI']);
  const writes = s.did.length;
  await s.handoffs.poll();
  assert.equal(s.did.length, writes, 'nothing is written while the phase stays the same');

  // The next server, on the same data dir, with the state lost meanwhile.
  Object.assign(s.ticket, { state: null, note: null });
  const next = new LandHandoffs({ ...s.deps, landings: new Landings(s.data) });
  await next.poll();
  assert.deepEqual([s.ticket.state, s.ticket.note], ['outside', 'landing: waiting on CI']);

  writeFileSync(join(s.cwd, 'done'), '');
  await until('land.sh ends', () => s.landings.get(1)?.code !== null);
  await next.poll();
  assert.equal(s.ticket.status, 'closed');
  assert.notEqual(s.ticket.state, 'outside');
});

test('every way a handed-off land ends replaces its outside state', async () => {
  const fail = 'land: conflict\n';
  const unpushed = 'land: master is now at d1a5c2f "#15"\nland: master moved, but the push to origin failed: remote: nope\n';
  const ends: [string, Parameters<typeof setup>[1], string, number, object, (s: ReturnType<typeof setup>) => void][] = [
    ['end-live', {}, LIVE, 0, {}, () => {}],
    ['end-restart', {}, RESTART, 0, {}, () => {}],
    ['end-restart-live', { liveAlready: true }, RESTART, 0, {}, () => {}],
    ['end-stay', {}, LIVE, 0, { stayOpen: true }, () => {}],
    ['end-stay-waiting', {}, LIVE, 0, { stayOpen: true, waitingOn: 'Cara' }, () => {}],
    ['end-failed', {}, fail, 1, {}, () => {}],
    ['end-no-ci', {}, 'land: CI gave no verdict\n', 75, {}, () => {}],
    ['end-no-ci-none', { runners: false }, 'land: CI gave no verdict\n', 75, {}, () => {}],
    ['end-unpushed', {}, unpushed, 1, {}, () => {}],
    ['end-kept', { kept: 'a question card is still waiting on people' }, LIVE, 0, {}, () => {}],
    ['end-busy', { running: true }, LIVE, 0, {}, () => {}],
    ['end-talked', {}, LIVE, 0, {}, (s) => s.landings.talked(1)],
    ['end-talked-restart', {}, RESTART, 0, {}, (s) => s.landings.talked(1)],
  ];
  for (const [name, opts, out, code, h, before] of ends) {
    const s = setup(name, opts);
    await s.land(out, code, { ...H, ...h });
    before(s);
    await s.handoffs.poll();
    assert.notEqual(s.ticket.state, 'outside', `${name}: left in outside (note ${s.ticket.note})`);
    assert.deepEqual(s.landings.handoffs(), [], `${name}: reported`);
  }
  // The one ending that stays outside on purpose (#942): landed, and the waiter wakes it once its restart is live.
  const waiting = setup('end-stay-waiting-restart');
  await waiting.land(RESTART, 0, { stayOpen: true, waitingOn: 'the CI run' });
  await waiting.handoffs.poll();
  assert.deepEqual([waiting.ticket.state, waiting.ticket.note], ['outside', 'shipped, wakes once live; waiting on: the CI run']);
});

test('handoffs() answers from memory: it does not read the landings folder again (#1210)', () => {
  const data = mkdtempSync(join(root, 'mem-'));
  const dir = join(data, 'run', 'landings');
  for (let i = 1; i <= 50; i++) mkdirSync(join(dir, String(i)), { recursive: true });
  writeFileSync(join(dir, '7', 'handoff.json'), '{}');
  const l = new Landings(data);
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(l.handoffs(), [7], 'found at start, then served from memory');
  l.settled(7);
  assert.deepEqual(l.handoffs(), []);
});
