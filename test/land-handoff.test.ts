import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { LandHandoffs, Landings, landResult, outputTail, type HandoffDeps } from '../src/land.ts';
import { agentToken, bootServer, until } from './helpers.ts';

// #706: a minion hands its land to the server and ends its turn. The server runs land.sh, and on a clean land posts
// the shipped line and dismisses or parks the minion with no model call; on a failure it wakes the minion with the
// end of land.sh's output.
const root = mkdtempSync(join(tmpdir(), 'land-handoff-'));
after(() => rmSync(root, { recursive: true, force: true }));

const H = { summary: 'Usage bar in the top bar.', risk: 'low' as const, reason: 'front end only' };
const LIVE = 'land: main is now at abc1234 "#9: usage bar"\ndeploy: live now: the server reloaded the front end (v2); open tabs reload when idle. No restart.\n';
const RESTART = 'land: main is now at def5678 "#9: server bit"\ndeploy: restart queued as citadel-restart: running turns carry on through it, and it reports here\ndeploy: not live yet after 75 s; the restart reports here when it is\n';

/** A Landings in a data dir of its own, a minion worktree whose land.sh prints `out` and exits `code`, and fake deps that record what the server did. */
function setup(name: string, opts: { running?: boolean; kept?: string | null; runners?: boolean; liveAlready?: boolean } = {}) {
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
  };
  const land = async (out: string, code = 0, h: object = H) => {
    writeFileSync(join(cwd, 'tools', 'land.sh'), `printf '%s' ${JSON.stringify(out)}\nexit ${code}\n`);
    assert.ok(landings.handOff(1, cwd, { PATH: process.env.PATH! }, [], { ...H, ...h }));
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
  writeFileSync(join(s.cwd, 'tools', 'land.sh'), `sleep 0.3\nprintf '%s' ${JSON.stringify(LIVE)}\n`);
  assert.ok(s.landings.handOff(1, s.cwd, { PATH: process.env.PATH! }, [], H));
  assert.ok(!s.landings.handOff(1, s.cwd, { PATH: process.env.PATH! }, [], H), 'one landing at a time');
  s.landings.talked(1);
  await until('land.sh ends', () => s.landings.get(1)?.code !== null);
  await s.handoffs.poll();
  assert.equal(s.notes.length, 1, 'the shipped line still posts');
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /Someone wrote to you while it was in line/);
  assert.ok(!s.did.some((d) => d.startsWith('close')));
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

test('landResult reads deploy.sh\'s lines; outputTail keeps the last lines', () => {
  assert.deepEqual(landResult(LIVE, 0), { kind: 'live', commit: 'abc1234', subject: '#9: usage bar' });
  assert.equal(landResult(RESTART, 0).kind, 'restart');
  assert.equal(landResult(`${RESTART}deploy: live now: the server restarted on def5678 and stayed healthy\n`, 0).kind, 'live');
  assert.equal(landResult('land: deploy: nothing to deploy: the server already runs abc1234\n', 0).kind, 'live');
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
    writeFileSync(join(cwd, 'tools', 'land.sh'), `printf '%s' ${JSON.stringify(LIVE)}\n`);
    const git = (...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    store.setTicketDir(minion.id, cwd, null);
    const token = agentToken(srv.data, minion.id);
    const handOff = (body: object) => fetch(`${srv.base}/api/tickets/${minion.id}/land/handoff`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const body = { summary: 'Usage bar', risk: 'low', risk_reason: 'front end only' };

    writeFileSync(join(cwd, 'tools', 'land.sh'), `printf '%s' ${JSON.stringify(LIVE)}\n# edited\n`);
    const dirty = await handOff(body);
    assert.equal(dirty.status, 409);
    assert.match((await dirty.json()).error, /uncommitted changes/);
    git('checkout', '--', 'tools/land.sh');
    assert.equal((await handOff({ ...body, risk: undefined })).status, 400);
    const high = await handOff({ ...body, risk: 'high' });
    assert.equal(high.status, 400);
    assert.match((await high.json()).error, /go/);

    assert.equal((await handOff(body)).status, 202);
    assert.equal(store.getTicket(minion.id)!.state, 'outside');
    await until('the server reports the land', () => store.getTicket(minion.id)!.status === 'closed', 20_000);
    assert.ok(store.listEvents(minion.id).some((e) => String(e.data).includes('Shipped abc1234')), 'the shipped line is in its chat');
  } finally {
    await srv.stop();
  }
});
