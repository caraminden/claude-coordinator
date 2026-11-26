import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { deployApps, LandHandoffs, landConflict, Landings, landPhase, landResult, NO_CODE, outputTail, prepConflict, prepMessage, type DeployOps, type HandoffDeps } from '../src/land.ts';
import { addReview, agentToken, bootServer, until } from './helpers.ts';
import { signalTree } from '../src/ship-stop.ts';
import type { App } from '../src/http.ts';
import { brokenTest, requeueShip, sameChange } from '../src/ship-handoff.ts';
import { git } from './git.ts';
import { spawnSync } from 'node:child_process';
import { tripwire, type TripwireConfig } from '../src/tripwire.ts';
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
function setup(name: string, opts: { owner?: number | null; ownerState?: string | null; running?: boolean; kept?: string | null; runners?: boolean; liveAlready?: boolean; liveAtWait?: boolean; apps?: string[]; deployOps?: DeployOps; requeue?: HandoffDeps['requeue'] } = {}) {
  const data = join(root, name, 'data');
  const cwd = join(root, name, 'wt');
  mkdirSync(join(cwd, 'tools'), { recursive: true });
  const landings = new Landings(data);
  const ticket = { number: 7, title: 'Wake the owner', status: 'idle', state: 'outside' as string | null, note: 'landing: starting' as string | null };
  const did: string[] = [];
  const sent: string[] = [];
  const light: boolean[] = [];
  const fyi: boolean[] = [];
  const notes: string[] = [];
  const owned: any[] = [];
  const waits: { commit: string | null; text: string }[] = [];
  const deps: HandoffDeps = {
    landings,
    store: {
      getTicket: (id: number) => (id === 1 ? ticket : { number: 9, title: 'The build', status: 'idle', state: opts.ownerState ?? null }),
      updateTicket: (_id, f) => {
        Object.assign(ticket, f);
        did.push(`state ${f.state}`);
      },
    },
    runner: {
      emit: (_id, _kind, data: any) => {
        notes.push(data.text);
      },
      send: (_id, _from, text, _images, extra) => {
        sent.push(text);
        light.push(!!extra?.light);
        fyi.push(!!extra?.fyi);
      },
      unpark: (id, by) => {
        did.push(`unpark ${id} by ${by}`);
        return true;
      },
      relayMinion: (from, to, author, text, urgent, wake, unparked) => {
        owned.push({ from, to, author, text, urgent, wake, unparked });
        return false;
      },
      close: async (_id, text) => {
        ticket.status = 'closed';
        did.push(`close: ${text}`);
      },
      closeAfterTurn: () => {
        did.push('closeAfterTurn');
        return true;
      },
      keptOpen: () => opts.kept ?? null,
      isRunning: () => !!opts.running,
      queued: () => 0,
      deployPending: () => {
        did.push('deployPending');
      },
      deployLive: () => {
        did.push('deployLive');
        return true;
      },
      broadcastTicket: () => {},
    },
    from: 'Citadel',
    buildOwner: () => (opts.owner === undefined ? 2 : opts.owner),
    runnersBack: (_id, reason) => {
      did.push(`runnersBack: ${reason}`);
      return opts.runners ?? true;
    },
    liveAlready: async () => !!opts.liveAlready,
    wakeWhenLive: async (_id, commit, text) => {
      if (opts.liveAtWait) return false;
      waits.push({ commit, text });
      return true;
    },
    ...(opts.deployOps ? { apps: () => opts.apps ?? [], deployOps: opts.deployOps } : {}),
    ...(opts.requeue ? { requeue: opts.requeue } : {}),
  };
  const land = async (out: string, code = 0, h: object = H, args: string[] = []) => {
    writeFileSync(join(cwd, 'tools', 'land.sh'), `printf '%b' ${JSON.stringify(out)}\nexit ${code}\n`);
    assert.ok(landings.handOff(1, cwd, { PATH: process.env.PATH! }, args, { ...H, ...h }));
    await until('land.sh ends', () => landings.get(1)?.code !== null);
  };
  return { owned, waits, landings, ticket, did, sent, light, fyi, notes, deps, land, handoffs: new LandHandoffs(deps), data, cwd };
}

test('a ship let through on known flakes says so in its shipped line (#1419)', async () => {
  const s = setup('live');
  await s.land(LIVE.replace('\n', '\nland: shipped past known flakes test/x.test.ts (seen on 4 other branches in 14 days, fix #12)\n'));
  await s.handoffs.poll();
  assert.deepEqual(s.notes, ['Shipped abc1234 "#9: usage bar": Usage bar in the top bar. Risk low: front end only. Shipped past known flakes test/x.test.ts (seen on 4 other branches in 14 days, fix #12). Live now.']);
});

test('a ship land.sh formatted says so in its shipped line (#1885)', async () => {
  const s = setup('live');
  await s.land(`land: format: formatted 2 of this ship's files in abc1230 (a.ts, b.ts)\n${LIVE}`);
  await s.handoffs.poll();
  assert.deepEqual(s.notes, ['Shipped abc1234 "#9: usage bar": Usage bar in the top bar. Risk low: front end only. The ship script formatted 2 of its files in a commit of its own (a.ts, b.ts). Live now.']);
});

test("a ship let through main's red names main's red test in its shipped line (#1478)", async () => {
  const s = setup('live');
  await s.land(LIVE.replace('\n', "\nland: shipped through main's red on test/x.test.ts\n"));
  await s.handoffs.poll();
  assert.deepEqual(s.notes, ['Shipped abc1234 "#9: usage bar": Usage bar in the top bar. Risk low: front end only. Shipped through main\'s red on test/x.test.ts: main still needs a fix for it. Live now.']);
});

test('a clean land that is live now posts the shipped line and dismisses the minion, with no message to it', async () => {
  const s = setup('live');
  await s.land(LIVE);
  await s.handoffs.poll();
  assert.deepEqual(s.notes, ['Shipped abc1234 "#9: usage bar": Usage bar in the top bar. Risk low: front end only. Live now.']);
  assert.equal(s.sent.length, 0, 'no model call');
  assert.ok(
    s.did.some((d) => d.startsWith('close: Shipped and live')),
    s.did.join('\n'),
  );
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

// #1417: a restart held for a starved box says when it expects to be live, in the shipped line and the minion's note.
test('a land whose restart is held for a starved box says when it expects to be live, and still waits for the restart', async () => {
  const s = setup('restart-held');
  await s.land(
    'land: main is now at def5678 "#9: server bit"\ndeploy: restart queued as citadel-restart: running turns carry on through it, and it reports here\ndeploy: not live yet: the box is starved (CPU pressure 63%), so the restart waits for it to ease, live by about 14:05 PST at the latest, and reports here when it is live\n',
  );
  await s.handoffs.poll();
  assert.match(s.notes[0], /^Shipped def5678 "#9: server bit": .* Waiting for the restart, held while the box is starved \(CPU pressure 63%\): live by about 14:05 PST at the latest\.$/);
  assert.equal(s.ticket.state, 'pending-deploy', 'dismissed only once its restart is live');
  assert.equal(s.ticket.note, 'deployed, starved box: live by about 14:05 PST');
  assert.ok(!s.did.some((d) => d.startsWith('close')), s.did.join('\n'));
  assert.ok(!s.did.includes('deployLive'), 'not live yet');
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
  await a.land('land: smoke: a .ts file does not parse, before the line (2 s), so nothing landed\n', 1);
  await a.handoffs.poll();
  assert.match(a.sent[0], /^Kind: parse error/);
  assert.match(a.sent[0], /Your handed-off land didn't go through/);
  const b = setup('kind-unknown');
  await b.land('land: something odd\n', 1);
  await b.handoffs.poll();
  assert.match(b.sent[0], /^Your handed-off land didn't go through/);
});

// #2030 (Josh, 2026-11-25, "Yes, re-queue it"): a refusal on load alone goes back in line with no turn, once a hand-off.
const ALONE =
  'run-tests: test/b.test.ts: failed in the full run, passed alone: likely load, not your change (1-minute load 44.13)\nland: tests failed on the rebased branch in CI again (https://github.com/o/r/actions/runs/1), on the one fresh run after a red whose files all passed alone (test/a.test.ts), so main is untouched. A second red refuses whatever its labels say\n';

test('a passed-alone refusal goes back in line by itself with a note and no wake; refused again, the minion is woken as before (#2030)', async () => {
  const asked: { requeued?: true }[] = [];
  const s = setup('requeue', {
    requeue: async (_id, h) => {
      asked.push(h);
      s.landings.settled(1); // as the server's hand-off does, so the next one can start
      return null;
    },
  });
  await s.land(ALONE, 1);
  await s.handoffs.poll();
  assert.equal(asked.length, 1, 'the server put it back in line');
  assert.deepEqual(s.sent, [], 'no wake, so no turn');
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0], /put this ship back in line by itself/);
  assert.notEqual(s.ticket.state, null, 'still shipping, not idle');
  // The re-queued hand-off carries its mark: refused again, the minion hears of it.
  await s.land(ALONE, 1, { requeued: true });
  await s.handoffs.poll();
  assert.equal(asked.length, 1, 'once per hand-off');
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /^Kind: the failed files failed in the full run but passed alone/);
  assert.equal(s.ticket.state, null);
});

test("a passed-alone refusal the server can't put back in line wakes the minion, saying why (#2030)", async () => {
  const s = setup('requeue-no', { requeue: async () => 'your branch moved since the hand-off' });
  await s.land(ALONE, 1);
  await s.handoffs.poll();
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /It wasn't put back in line by itself: your branch moved since the hand-off\./);
  assert.deepEqual(s.landings.handoffs(), [], 'reported');
});

test('only a passed-alone refusal goes back by itself: failed again alone, burn-in, own test, a broken test or two keeps already wake the minion (#2030)', async () => {
  const kinds = {
    'failed again alone': `${ALONE}run-tests: test/c.test.ts: failed again alone\n`,
    'burn-in': `${ALONE}land: test/d.test.ts failed its burn-in in CI\n`,
    'own test': '✖ test/e.test.ts › it breaks\nland: tests failed on the rebased branch in CI (https://github.com/o/r/actions/runs/2), so main is untouched\n',
    'broken test': `land: broken test, not a flake: test/b.test.ts red in 6 of the last 10 runs\n${ALONE}`,
    'kept twice': `land: only flakes failed again (test/b.test.ts), but it has kept its place 2 times already, so it is refused this time\n${ALONE}`,
    'leak guard': `The tests left 2 process(es) running after they ended\n${ALONE}`,
  };
  for (const [kind, out] of Object.entries(kinds)) {
    let asked = 0;
    const s = setup(`requeue-${kind.replace(/ /g, '-')}`, {
      requeue: async () => {
        asked++;
        return null;
      },
    });
    await s.land(out, 1);
    await s.handoffs.poll();
    assert.equal(asked, 0, `${kind}: not put back in line`);
    assert.equal(s.sent.length, 1, `${kind}: woken at once`);
    assert.equal(s.notes.length, 0, kind);
  }
});

// #2051 (#2031's audit, candidate 6): refusals the box or the pipeline caused go back the same way, once.
const BOX = {
  'cut off by a restart': `land: smoke: checking ticket/1-x before it queues\n${NO_CODE}`,
  'boot-check copy': 'Error: database is locked\ndeploy: boot check failed; nothing deployed\n',
  'hung on perigee': "run-tests: the tests ran past 600s and were stopped: a test hung\nland: the suite on perigee ran out of its time limit and no test is known to be ticket/1-x's own failure (full log: /x.log): that is no answer, so main is untouched. Run this again\n",
  'second red':
    "run-tests: test/c.test.ts: rerun alone stopped after 150s, when CI's answer was due: counts as a real failure\nland: tests failed on the rebased branch in CI again (https://github.com/o/r/actions/runs/1), on the one fresh run after a red whose files all passed alone (test/a.test.ts), so main is untouched. A second red refuses whatever its labels say\n",
};

/** One landing ended with `out`, polled. An `out` ending in NO_CODE is a wrapper a restart cut off: no pid, no code. */
async function ended(s: ReturnType<typeof setup>, out: string, h: object = {}) {
  if (!out.endsWith(NO_CODE)) {
    await s.land(out, 1, h);
    return s.handoffs.poll();
  }
  const dir = join(s.data, 'run', 'landings', '1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'started'), String(Date.now() - 600_000));
  writeFileSync(join(dir, 'output.log'), out.slice(0, -NO_CODE.length));
  writeFileSync(join(dir, 'handoff.json'), JSON.stringify({ ...H, args: [], ...h }));
  const landings = new Landings(s.data);
  await new LandHandoffs({ ...s.deps, landings }).poll();
}

test('a refusal the box caused goes back in line once with no turn, and the next one wakes the minion (#2051)', async () => {
  for (const [kind, out] of Object.entries(BOX)) {
    let asked = 0;
    const s = setup(`box-${kind.replace(/ /g, '-')}`, {
      requeue: async () => {
        asked++;
        new Landings(s.data).settled(1);
        return null;
      },
    });
    await ended(s, out);
    assert.equal(asked, 1, `${kind}: put back in line`);
    assert.deepEqual(s.sent, [], `${kind}: no wake`);
    assert.match(s.notes[0], /put this ship back in line by itself/, kind);
    await ended(s, out, { requeued: true });
    assert.equal(asked, 1, `${kind}: once per hand-off`);
    assert.equal(s.sent.length, 1, `${kind}: then woken`);
  }
});

test("a box refusal that deploy's refusing note, a skipped test or the ship's own cause is part of wakes the minion (#2051)", async () => {
  const kinds = {
    'refusing deploy, cut off': `land: deploy has been refusing since Nov 25 10:00 PST (boot): running its boot check on abc1234 before a CI run is spent on it\n${NO_CODE}`,
    'refusing deploy, boot copy': 'land: deploy has been refusing since Nov 25 10:00 PST: boot, and abc1234 fails the same check here (its output is above) while main passes it\nland: abc1234 fails the same check here: database is locked\n',
    'second red, skipped test': `land: 1 tests were skipped in CI (x)\n${BOX['second red']}`,
    'second red, a file failed again alone': `run-tests: test/c.test.ts: failed again alone\n${BOX['second red']}`,
    'second red, burn-in': `land: test/d.test.ts failed its burn-in in CI\n${BOX['second red']}`,
    'second red, kept twice': `land: only flakes failed again (test/b.test.ts), but it has kept its place 2 times already, so it is refused this time\n${BOX['second red']}`,
    'out of time, own failure': 'run-tests: the tests ran past 600s and were stopped: a test hung\nland: tests failed on the rebased branch: the suite ran out of time, and test/a.test.ts fails alone here and passes on main (full log: /x.log), so main is untouched\n',
  };
  for (const [kind, out] of Object.entries(kinds)) {
    let asked = 0;
    const s = setup(`box-no-${kind.replace(/[ ,']+/g, '-')}`, {
      requeue: async () => {
        asked++;
        return null;
      },
    });
    await ended(s, out);
    assert.equal(asked, 0, `${kind}: not put back in line`);
    assert.equal(s.sent.length, 1, `${kind}: woken`);
  }
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
  const out =
    "land: CI passed on d1a5c2f6\nland: master is now at d1a5c2f \"#15: seed the tree\"\nland: master moved, but the push to origin failed: remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found\nland: the next landing retries it; if origin's master moved on its own (rejected as non-fast-forward), a person merges it into /repo first\n";
  await s.land(out, 1);
  await s.handoffs.poll();
  assert.equal(s.sent.length, 1, 'woken once');
  assert.doesNotMatch(s.sent[0], /didn't go through|so hand it off again/, 'not a failure, and not "ship again now": it would fail the same way');
  assert.match(s.sent[0], /Once they say it's fixed, hand it off again with hand_off_land/);
  assert.match(s.sent[0], /master moved locally to d1a5c2f "#15: seed the tree"/);
  assert.match(s.sent[0], /push to origin failed: remote: Repository not found\.\nfatal: repository 'https:\/\/github\.com\/o\/r\.git\/' not found/);
  assert.doesNotMatch(s.sent[0], /git push/, 'never tells it to push the main branch: the guard, pre-push and the tripwire refuse that (KT1)');
  assert.match(s.sent[0], /tell a person/i, 'a lasting failure goes to a person');
  assert.match(s.sent[0], /fails the same way/, 'says shipping again would not help');
  assert.ok(
    s.notes.some((n) => n.startsWith('Shipped d1a5c2f "#15: seed the tree"') && /not pushed to origin/i.test(n)),
    'the shipped line says it landed but is not pushed',
  );
  assert.equal(s.ticket.state, null, 'left open for the minion to push');
  assert.ok(!s.did.some((d) => d.startsWith('close')), 'not dismissed');
  assert.equal(landResult('land: master moved, but the push to origin failed: error: one\n\nhint: two\n', 1).error, 'error: one\n\nhint: two', "a blank line in git's output doesn't cut it short");
  assert.deepEqual(landResult(out, 1), { kind: 'unpushed', commit: 'd1a5c2f', subject: '#15: seed the tree', branch: 'master', error: "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found" });
});

test('a passing push failure says to hand it off again; a lasting one (login, access, non-fast-forward) says to tell a person (KT1)', async () => {
  const at = 'land: CI passed on d1a5c2f6\nland: master is now at d1a5c2f "#15: seed the tree"\n';
  const passing = [
    "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
    'error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502',
    '', // timeout 60 killed it: no output
  ];
  const lasting = [
    "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
    "remote: Permission to o/r.git denied to someone.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    " ! [rejected]        master -> master (non-fast-forward)\nerror: failed to push some refs to 'https://github.com/o/r.git'",
    'remote: error: GH006: Protected branch update failed for refs/heads/master.',
  ];
  for (const [i, err] of [...passing, ...lasting].entries()) {
    const s = setup(`unpushed-kind-${i}`);
    await s.land(`${at}land: master moved, but the push to origin failed: ${err}\nland: the next landing retries it\n`, 1);
    await s.handoffs.poll();
    assert.equal(s.sent.length, 1, err);
    assert.doesNotMatch(s.sent[0], /git push/, err);
    if (passing.includes(err)) {
      assert.match(s.sent[0], /hand it off again with hand_off_land/, `passing: ${err}`);
      assert.doesNotMatch(s.sent[0], /won't clear by itself/, `passing: ${err}`);
    } else {
      assert.match(s.sent[0], /won't clear by itself/, `lasting: ${err}`);
      assert.match(s.sent[0], /tell a person/i, `lasting: ${err}`);
    }
    if (err) assert.ok(s.sent[0].includes(err.split('\n')[0]), `quotes the error: ${err}`);
  }
});

// The class behind KT1 (#1519): a wake that quotes a command the guards refuse strands the minion. Every command any
// ship wake quotes in backticks must get past Citadel's tripwire and the kit's guard.sh (the hook kit schemes run).
test('every command a ship wake quotes gets past the tripwire and the kit guard (KT1)', async () => {
  const fail = 'land: conflict\n';
  const unpushed = (err: string) => `land: master is now at d1a5c2f "#15"\nland: master moved, but the push to origin failed: ${err}\n`;
  const ends: [string, Parameters<typeof setup>[1], string, number][] = [
    ['q-failed', {}, fail, 1],
    ['q-smoke', {}, 'land: smoke: tests failed, before the line (3 s), so nothing landed\n', 1],
    ['q-no-ci-none', { runners: false }, 'land: CI gave no verdict\n', 75],
    ['q-unpushed-passing', {}, unpushed('fatal: unable to access: Could not resolve host: github.com'), 1],
    ['q-unpushed-lasting', {}, unpushed('remote: Repository not found.'), 1],
    ['q-unpushed-nff', {}, unpushed(' ! [rejected] master -> master (non-fast-forward)'), 1],
  ];
  const texts: string[] = [];
  for (const [name, opts, out, code] of ends) {
    const s = setup(name, opts);
    await s.land(out, code);
    await s.handoffs.poll();
    texts.push(...s.sent);
  }
  // A stopped ship's wake, which names git commands too.
  const st = setup('q-stopped');
  st.landings.stopped = () => ({ by: 'Cara', at: Date.now(), via: 'from the Status page' }) as any;
  await st.land('land: master is now at d1a5c2f "#15"\n', 1);
  await st.handoffs.poll();
  texts.push(...st.sent);
  const commands = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/`([^`\n]+)`/g)) if (/^(git|tools\/|bash|npm|node)\b/.test(m[1])) commands.add(m[1]);
  assert.ok(commands.size >= 2, `found the quoted commands: ${[...commands].join(' | ')}`);
  const home = '/home/u',
    data = `${home}/.local/share/claude-coordinator`;
  const cfg: TripwireConfig = { home, data, checkout: `${home}/claude-coordinator`, project: 2, claudeConfig: `${home}/.claude`, deployScript: false, env: { TMPDIR: `${data}/projects/2/tmp/9`, PATH: '/usr/bin:/bin' } };
  const worktree = `${data}/projects/2/tickets/9`;
  const guard = join(process.cwd(), 'kit/skills/scheme-setup/templates/guard.sh');
  const repo = mkdtempSync(join(root, 'guard-repo-'));
  git(repo, 'init', '-q', '-b', 'ticket/9-x');
  for (const command of commands) {
    assert.equal(tripwire({ tool_name: 'Bash', tool_input: { command, description: '' }, cwd: worktree }, cfg)?.reason ?? null, null, `the tripwire blocks a command a wake quotes: ${command}`);
    const r = spawnSync('bash', [guard, '--hook', 'bash'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo }), cwd: repo, env: { ...process.env, CLAUDE_PROJECT_DIR: repo }, encoding: 'utf8' });
    assert.equal(r.status, 0, `the kit's guard.sh blocks a command a wake quotes: ${command}\n${r.stderr}`);
  }
  // The check can fail: the old wake's push of main is refused by both.
  assert.ok(tripwire({ tool_name: 'Bash', tool_input: { command: 'git push origin master', description: '' }, cwd: worktree }, cfg), 'the tripwire refuses a push of master');
  const old = spawnSync('bash', [guard, '--hook', 'bash'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin master' }, cwd: repo }), cwd: repo, env: { ...process.env, CLAUDE_PROJECT_DIR: repo }, encoding: 'utf8' });
  assert.equal(old.status, 2, "the kit's guard.sh refuses a push of master");
});

test('the ship note finds the commit on any default branch, not only main (KT2)', () => {
  assert.deepEqual(landResult('land: CI passed\nland: master is now at d1a5c2f "#15: seed the tree"\nland: pushed master to origin\n', 0), { kind: 'landed', commit: 'd1a5c2f', subject: '#15: seed the tree' });
  assert.deepEqual(landResult('land: trunk is now at abc1234 "#2: x"\n', 0), { kind: 'landed', commit: 'abc1234', subject: '#2: x' });
  assert.deepEqual(landResult(LIVE, 0), { kind: 'live', commit: 'abc1234', subject: '#9: usage bar' });
  assert.deepEqual(landResult('land: main is now at abc1234 "#9: x", in ticket/3-y\'s ship train\n', 0), { kind: 'landed', commit: 'abc1234', subject: '#9: x' }, "Citadel's train line");
  assert.deepEqual(landResult('land: landed d1a5c2f "#15: seed" in a batch with ticket/3-y, on ticket/3-y\'s CI run (master is now 0123456789ab)\n', 0), { kind: 'landed', commit: 'd1a5c2f', subject: '#15: seed' }, "a batch member's own commit (KT3)");
  // A merge into a build names the build, not the default branch: no commit for the shipped line (it says "into build/3").
  assert.deepEqual(landResult('land: build/3 is now at abc1234 "#9: x"; master is untouched\n', 0), { kind: 'landed' });
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
  assert.ok(
    s.did.some((x) => x.startsWith('close: Shipped')),
    s.did.join('\n'),
  );
});

test('deploy: false, a merge into a build, or a scheme with no app deploys nothing', async () => {
  for (const [name, h, args, apps] of [
    ['app-off', { deploy: false }, [], ['peek-auras']],
    ['app-build', {}, ['--into', 'build/3', 'test/a.test.ts'], ['peek-auras']],
    ['app-none', {}, [], []],
  ] as const) {
    const d = fakeDeploys(() => ({ state: 'deployed', to: 'abc1234' }));
    const s = setup(name, { apps: [...apps], deployOps: d.ops });
    await s.land(APP_LAND, 0, h, [...args]);
    await s.handoffs.poll();
    assert.deepEqual(d.started, [], name);
    assert.doesNotMatch(s.notes[0], /Deployed/, name);
    assert.ok(
      s.did.some((x) => x.startsWith('close: ')),
      name,
    );
  }
});

// #1741: a ship's live probe runs once it is live (now, after the restart, or nowhere this server serves); a fail keeps it open.
test('a ship with a live probe hands it over with when it is live, and a fail keeps the minion open', async () => {
  const probe = { kind: 'http' as const, path: '/api/skills', status: 200 };
  const calls: string[] = [];
  const cases = [
    ['probe-live', LIVE, [], undefined, 'live'],
    ['probe-restart', RESTART, [], undefined, 'later'],
    ['probe-app', APP_LAND, [], ['peek-auras'], 'live'],
    ['probe-landed', APP_LAND, [], [], 'nowhere'],
  ] as const;
  for (const [name, out, args, apps, when] of cases) {
    const s = setup(name, apps ? { apps: [...apps], deployOps: fakeDeploys(() => ({ state: 'deployed', to: 'abc1234ffff0000' })).ops } : {});
    s.deps.probe = async (id, p, commit, w) => {
      calls.push(`${name}: ${id} ${p.kind} ${commit} ${w}`);
      return false;
    };
    await s.land(out, 0, { probe }, [...args]);
    await s.handoffs.poll();
    assert.equal(calls.at(-1)?.split(' ').at(-1), when, name);
    assert.ok(
      s.did.some((x) => x.startsWith(when === 'later' ? 'deployPending' : 'close: ')),
      `${name}: a pass changes nothing: ${s.did.join(', ')}`,
    );
  }
  assert.deepEqual(calls.slice(0, 2), ['probe-live: 1 http abc1234 live', 'probe-restart: 1 http def5678 later']);

  const into = setup('probe-into');
  into.deps.probe = async () => {
    calls.push('into');
    return false;
  };
  writeFileSync(join(into.cwd, 'tools', 'land.sh'), "echo 'land: merged into build/3'\n");
  assert.ok(into.landings.handOff(1, into.cwd, { PATH: process.env.PATH! }, ['--into', 'build/3', 'test/a.test.ts'], { ...H, probe }));
  await until('land.sh ends', () => into.landings.get(1)?.code !== null);
  await into.handoffs.poll();
  assert.ok(!calls.includes('into'), 'a merge into a build is not live: no probe');

  const failed = setup('probe-fail');
  failed.deps.probe = async () => true;
  await failed.land(LIVE, 0, { probe });
  await failed.handoffs.poll();
  assert.equal(failed.notes.length, 1, 'the shipped line still posts');
  assert.ok(!failed.did.some((x) => x.startsWith('close')), `the probe's wake keeps it open: ${failed.did.join(', ')}`);
  assert.deepEqual(failed.landings.handoffs(), [], 'reported once');
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
  const refused: DeployOps = {
    running: () => false,
    start: async () => {
      throw new Error('Mandate has no repo set');
    },
    last: async () => null,
    sleep: async () => {},
  };
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
  return withRealDeploy(
    async (r, run) => {
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
      // The seconds are counted on a whole-second clock and the box may be slow, so any count is right (#1998): the words are what is read.
      await as('queued', fake('idle-bin', 'exit 0'), [/^deploy: restart queued as /, /^deploy: not live yet after [1-9]\d* s; the restart reports here when it is/], 'restart', { DEPLOY_HEALTHY_WAIT: '0', DEPLOY_SETTLE: '0', DEPLOY_TEST_LIVE_GRACE: '1' });
      await as('joined', fake('joined-bin', 'echo "Failed to start transient service unit: Unit cc-restart-when-idle.service already exists." >&2; exit 1'), [/^deploy: a restart is already queued as/], 'restart');
      // #1417: a restart held for a starved box (its note in <state>/hold) says when it expects to go, in the words the
      // shipped line reads (src/land.ts's held).
      const hold = join(r.live, '.git', 'cc-deploy', 'hold');
      await as('held', fake('held-bin', `echo "$(( $(date +%s) + 600 )) CPU pressure 63%" >'${hold}'; exit 0`), [/^deploy: not live yet: the box is starved \(CPU pressure 63%\), so the restart waits for it to ease, live by about \d\d?:\d\d P[SD]T at the latest/], 'restart');
      // An urgent fix's deploy (the land tool's outage: true) marks the restart it queues or rides to skip the hold.
      rmSync(hold);
      const urgent = join(r.live, '.git', 'cc-deploy', 'urgent');
      assert.equal(existsSync(urgent), false);
      await as('urgent', fake('urgent-bin', 'exit 0'), [/^deploy: restart queued as /], 'restart', { LAND_URGENT: '1', DEPLOY_HEALTHY_WAIT: '0', DEPLOY_SETTLE: '0', DEPLOY_TEST_LIVE_GRACE: '1' });
      assert.equal(existsSync(urgent), true, 'LAND_URGENT marks the restart');
    },
    () => (running ? { commit: running } : {}),
  );
});

test("landResult reads deploy.sh's lines; outputTail keeps the last lines", () => {
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

// #1320: the kit template's last line decides when it is there; without it (Citadel's land.sh for now), the lines above.
test('landResult reads the ship line when there is one: its own commit, the subject only from a line naming that commit, refused as failed', () => {
  assert.deepEqual(landResult('land: main is now at abc1234 "#9: usage bar"\nship: landed abc1234def0 batch 1 of 1 deploy none\n', 0), { kind: 'landed', commit: 'abc1234def0', subject: '#9: usage bar' });
  assert.deepEqual(landResult('land: landed in a batch with ticket/1-x, on its own CI run (main is now 999999999999)\nship: landed abc1234def0 batch 2 of 2 deploy none\n', 0), { kind: 'landed', commit: 'abc1234def0' }, 'a batch member: its own commit, which no subject line names');
  assert.deepEqual(landResult(`${LIVE}ship: landed abc1234def0 batch 1 of 1 deploy none\n`, 0), { kind: 'landed', commit: 'abc1234def0', subject: '#9: usage bar' }, 'the ship line, not prose, says what deployed');
  assert.equal(landResult('ship: landed abc1234def0 batch 1 of 1 deploy live\n', 0).kind, 'live');
  assert.equal(landResult('ship: landed abc1234def0 batch 1 of 1 deploy restart\n', 0).kind, 'restart');
  assert.deepEqual(landResult('ship: refused abc1234def0 batch 1 of 3 deploy none\n', 0), { kind: 'failed' });
  assert.deepEqual(landResult('ship: refused - batch 1 of 1 deploy none\n', 1), { kind: 'failed' });
  assert.equal(landResult('ship: refused abc1234def0 batch 1 of 1 deploy none\n', 75).kind, 'no-ci', 'exit 75 tells a park apart');
  assert.equal(landResult('land: main moved, but the push to origin failed: nope\nship: landed abc1234def0 batch 1 of 1 deploy none\n', 1).kind, 'unpushed');
  assert.deepEqual(landResult('land: main is now at abc1234 "#9: x"\nland: ship: landed fff batch 1 of 1 deploy live\n', 0), { kind: 'landed', commit: 'abc1234', subject: '#9: x' }, 'only a line of its own');
});

test("landConflict reads only land.sh --check's exit 3 as a conflict: an older land.sh, a failure or a hang hands off as before (#770)", async () => {
  const cwd = mkdtempSync(join(root, 'check-'));
  mkdirSync(join(cwd, 'tools'));
  const script = (body: string) => writeFileSync(join(cwd, 'tools', 'land.sh'), body);
  const env = { PATH: process.env.PATH! };
  script('echo "land: $1 $2" >&2; echo "land: conflicted files: a.txt" >&2; exit 3\n');
  assert.equal(await landConflict(cwd, env, ['--into', 'build/2']), '--check --into\nconflicted files: a.txt', "its lines, with --check before the land's own arguments");
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
    assert.equal(low.status, 400, 'a scheme whose every change needs a go refuses a low one without it (#1043)');
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
    const unread = await handOff(body);
    assert.equal(unread.status, 400, 'no reviewer has read it (#1938)');
    assert.match(await unread.text(), /no reviewer has read this change/);
    addReview(store, minion.id);
    const clash = await handOff(body);
    assert.equal(clash.status, 409, 'a branch that would conflict is sent back in the turn');
    assert.equal((await clash.json()).error, "Not handed off: ticket/1-x won't rebase onto main cleanly, so nothing landed; conflicted files: a.txt. On conflicts: run git rebase main");
    assert.equal(store.getTicket(minion.id)!.state, null, 'nothing was handed off');
    rmSync(join(cwd, 'conflict'));
    assert.equal((await handOff(body)).status, 202);
    assert.equal(store.getTicket(minion.id)!.state, 'outside');
    assert.equal(store.getTicket(minion.id)!.note, 'landing: starting', 'the list says it is landing (#962)');
    await until('the server reports the land', () => store.getTicket(minion.id)!.status === 'closed', 20_000);
    assert.ok(
      store.listEvents(minion.id).some((e) => String(e.data).includes('Shipped abc1234')),
      'the shipped line is in its chat',
    );
  } finally {
    await srv.stop();
  }
});

test('the server puts a passed-alone refusal back in line with no turn, and wakes the minion when the same commit is refused again (#2030)', async () => {
  const srv = await bootServer();
  try {
    const store = new Store(join(srv.data, 'coordinator.db'));
    const project = store.createProject('P', null);
    const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
    const cwd = join(srv.root, 'wt-again');
    const runs = join(srv.root, 'runs');
    mkdirSync(join(cwd, 'tools'), { recursive: true });
    writeFileSync(join(cwd, 'tools', 'land.sh'), `[ "$1" = --check ] && exit 0\necho run >>${JSON.stringify(runs)}\nprintf '%b' ${JSON.stringify(ALONE)}\nexit 1\n`);
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'init');
    git(cwd, 'checkout', '-qb', 'ticket/1-m');
    git(cwd, 'commit', '-qm', 'mine', '--allow-empty');
    store.setTicketDir(minion.id, cwd, null);
    addReview(store, minion.id);
    const res = await fetch(`${srv.base}/api/tickets/${minion.id}/land/handoff`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken(srv.data, minion.id)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: 'Usage bar', risk: 'low', risk_reason: 'front end only' }) });
    assert.equal(res.status, 202);
    const said = () => store.listEvents(minion.id).map((e) => String(e.data));
    await until('the refusal after the re-queue wakes the minion', () => said().some((d) => d.includes("didn't go through")));
    assert.equal(readFileSync(runs, 'utf8'), 'run\nrun\n', 'land.sh ran twice: the hand-off and the one re-queue');
    assert.equal(said().filter((d) => d.includes('put this ship back in line by itself')).length, 1, 'one note for the re-queue');
    assert.equal(said().filter((d) => d.includes("didn't go through")).length, 1, 'one wake, only after the second refusal');
  } finally {
    await srv.stop();
  }
});

test('a re-queue never ships commits already on main, nor from a worktree off its branch (#2051)', async () => {
  const cwd = join(root, 'on-main');
  mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  writeFileSync(join(cwd, 'a.txt'), '1\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'base');
  git(cwd, 'checkout', '-qb', 'ticket/1-x');
  const ticket = { id: 1, kind: 'ticket', cwd, status: 'idle' };
  const app = { store: { getTicket: () => ticket }, runner: { parked: () => false, busy: () => false }, landings: { wasTalked: () => false } } as unknown as App;
  const again = () => requeueShip(app, 1, { summary: 's', risk: 'low', reason: 'r', args: [], head: git(cwd, 'rev-parse', 'HEAD').trim() }, '');
  assert.equal(await again(), 'your commits are already on main, so check what is left to do');
  git(cwd, 'checkout', '-q', '--detach');
  assert.match((await again())!, /not on its branch/);
});

test("brokenTest asks known-flakes.ts about every passed-alone file, the fresh run's too (#2030, #1487)", async () => {
  const shared = join(root, 'broken', 'shared');
  // 3 reds of 11 runs in the last hours: broken (test/known-flakes.test.ts's fixture), each line in its own day's file.
  const log = (ago: number, rest: string) => {
    const t = new Date(Date.now() - ago * 60_000).toISOString();
    mkdirSync(join(shared, 'retro-log', t.slice(0, 10)), { recursive: true });
    writeFileSync(join(shared, 'retro-log', t.slice(0, 10), 'land.md'), `- ${t.slice(11, 19)}Z · ${rest}\n`, { flag: 'a' });
  };
  for (let i = 0; i < 10; i++) log(i + 1, `timing · ticket/${100 + i}-r · line 0 · rebase 1 · ci-queue 8 · ci-run 107 · fallback - · deploy 7 · live 42 · landed`);
  for (let i = 0; i < 3; i++) log(i + 1, `flake · test/x.test.ts · load 3 · ticket/${10 + i}-o · in CI`);
  const env = { PATH: process.env.PATH!, COORDINATOR_SHARED_DIR: shared, LAND_FLAKE_DB: join(root, 'broken', 'none.db'), COORDINATOR_TICKET: '1' };
  assert.equal(await brokenTest(['test/a.test.ts', 'test/x.test.ts'], 'ticket/1-me', env), 'test/x.test.ts');
  assert.equal(await brokenTest(['test/a.test.ts'], 'ticket/1-me', env), '', 'a flake that is not broken');
  assert.equal(await brokenTest(['test/a.test.ts'], 'ticket/1-me', env, join(root, 'no-such.ts')), null, 'no answer is no go');
});

test('sameChange: the same commit or a rebase of it is no move; a commit added or edited is (#2030)', () => {
  const cwd = join(root, 'same-change');
  mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  writeFileSync(join(cwd, 'a.txt'), '1\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'base');
  git(cwd, 'checkout', '-qb', 'ticket/1-x');
  writeFileSync(join(cwd, 'b.txt'), 'mine\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'mine');
  const head = git(cwd, 'rev-parse', 'HEAD').trim();
  return (async () => {
    assert.equal(await sameChange(cwd, head), true, 'the same commit');
    git(cwd, 'checkout', '-q', 'main');
    writeFileSync(join(cwd, 'c.txt'), 'theirs\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'theirs');
    git(cwd, 'checkout', '-q', 'ticket/1-x');
    git(cwd, 'rebase', '-q', 'main');
    assert.notEqual(git(cwd, 'rev-parse', 'HEAD').trim(), head);
    assert.equal(await sameChange(cwd, head), true, "land.sh's rebase of it");
    const rebased = git(cwd, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(cwd, 'b.txt'), 'mine \n');
    git(cwd, 'commit', '-q', '--amend', '-am', 'mine');
    assert.equal(await sameChange(cwd, head), false, 'a whitespace edit is a move too');
    git(cwd, 'reset', '-q', '--hard', rebased);
    writeFileSync(join(cwd, 'b.txt'), 'mine, fixed\n');
    git(cwd, 'commit', '-qam', 'fix');
    assert.equal(await sameChange(cwd, head), false, 'a commit added');
    git(cwd, 'reset', '-q', '--soft', 'HEAD~2');
    git(cwd, 'commit', '-qm', 'squashed and edited');
    assert.equal(await sameChange(cwd, head), false, 'a commit edited');
  })();
});

// #1741: a ship to main of 600 lines or more names a live probe; the route checks it, and the server runs it once live.
test('the hand-off route makes a 600-line ship name a probe, refuses one that is not plain data, and runs it once live', async () => {
  const srv = await bootServer();
  try {
    const store = new Store(join(srv.data, 'coordinator.db'));
    const project = store.createProject('P', null);
    const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
    const cwd = join(srv.root, 'wt');
    mkdirSync(join(cwd, 'tools'), { recursive: true });
    writeFileSync(join(cwd, 'tools', 'land.sh'), `[ "$1" = --check ] && exit 0\nprintf '%b' ${JSON.stringify(LIVE)}\n`);
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'init');
    git(cwd, 'checkout', '-q', '-b', 'ticket/1-big');
    writeFileSync(join(cwd, 'big.txt'), Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n') + '\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'big');
    store.setTicketDir(minion.id, cwd, null);
    addReview(store, minion.id);
    const token = agentToken(srv.data, minion.id);
    const handOff = async (body: object) => {
      const res = await fetch(`${srv.base}/api/tickets/${minion.id}/land/handoff`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, error: res.status === 202 ? '' : String((await res.json()).error) };
    };
    const body = { summary: 'Big one', risk: 'low', risk_reason: 'test' };

    const none = await handOff(body);
    assert.equal(none.status, 400);
    assert.match(none.error, /^Not handed off: this change is 600 lines \(600 or more\), so it names one check .* probe is one of: /);
    assert.match((await handOff({ ...body, probe: { kind: 'shell', cmd: 'rm -rf /' } })).error, /^probe\.kind must be http, timing, sql or none\. probe is one of/);
    assert.match((await handOff({ ...body, probe: { kind: 'http', path: '//elsewhere.example/' } })).error, /not a valid path/);
    assert.match((await handOff({ ...body, into: 'build/2', files: ['test/a.test.ts'], probe: { kind: 'none', reason: 'x' } })).error, /goes with a ship to main/);
    assert.equal(store.getTicket(minion.id)!.state, null, 'nothing was handed off');

    assert.equal((await handOff({ ...body, probe: { kind: 'http', path: '/api/health', text: 'ok' } })).status, 202);
    await until('the server reports the land', () => store.getTicket(minion.id)!.status === 'closed');
    const said = store.listEvents(minion.id).map((e) => String(e.data));
    assert.ok(
      said.some((d) => d.includes('Live probe passed: GET /api/health answers 200 with \\"ok\\"')),
      said.join('\n'),
    );
    assert.match(readFileSync(join(srv.data, 'live-probes.jsonl'), 'utf8'), /"kind":"http","result":"pass"/, "the trial's log has the row");

    // Another scheme (its repo doesn't hold the code this server runs): asked only while it has an app this ship deploys.
    const other = join(srv.root, 'other');
    mkdirSync(join(other, 'tools'), { recursive: true });
    writeFileSync(join(other, 'tools', 'land.sh'), `[ "$1" = --check ] && exit 0\nprintf '%b' ${JSON.stringify(LIVE)}\n`);
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'init');
    git(other, 'checkout', '-q', '-b', 'ticket/2-big');
    writeFileSync(join(other, 'big.txt'), Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n') + '\n');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'big');
    const scheme = store.createProject('Other', null);
    store.db.prepare('UPDATE projects SET repo_dir = ? WHERE id = ?').run(other, scheme.id);
    const theirs = store.createTicket({ project_id: scheme.id, title: 'M2', permission_mode: 'default', created_by: 'Cara' });
    store.setTicketDir(theirs.id, other, null);
    addReview(store, theirs.id);
    const theirToken = agentToken(srv.data, theirs.id);
    const theirHandOff = async (b: object) => {
      const res = await fetch(`${srv.base}/api/tickets/${theirs.id}/land/handoff`, { method: 'POST', headers: { Authorization: `Bearer ${theirToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      return { status: res.status, error: res.status === 202 ? '' : String((await res.json()).error) };
    };
    assert.match((await theirHandOff({ ...body, probe: { kind: 'sql', query: 'SELECT count(*) FROM tickets', min: 1 } })).error, /reads this server's own database/);
    store.createContraption({ name: 'voice', title: 'Voice', icon: null, port: 9, home_scheme: scheme.id, open_paths: '[]', relay_paths: '[]', repo: other, branch: 'main', folder: null, default_model: null, turn_cap: null, identity_public: 'x', identity_private: 'x', key_hash: 'h', keys_at: 0 });
    assert.match((await theirHandOff(body)).error, /^Not handed off: this change is 600 lines/, 'an app this ship deploys is served here');
    store.updateContraption('voice', { branch: 'dev' });
    assert.equal((await theirHandOff(body)).status, 202, 'an app on another branch is not deployed by this ship: nothing served, not asked');
    await until('their land is reported', () => store.getTicket(theirs.id)!.status === 'closed');
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
    addReview(store, minion.id);
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
    assert.match((await handOff({ ...body, summary: undefined })).error, /Summary is required: call hand_off_land again with summary .*risk_reason/, 'a missing summary names the fix (#1820)');
    assert.match((await handOff({ ...body, risk_reason: undefined })).error, /Risk reason is required: call hand_off_land again with risk_reason/, 'a missing risk reason names the fix (#1820)');
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
    assert.ok(
      store.listEvents(minion.id).some((e) => String(e.data).includes(line)),
      'the shipped line says it shipped without a go',
    );
    assert.ok(store.lastShippedNote(minion.id)?.includes(line), 'Releases reads the line from the newest shipped line');
  } finally {
    await srv.stop();
  }
});

// Fast mode (#1017): in a fast scheme a low or medium land gets LAND_FAST=1 and a high one doesn't; both get the
// scheme's known reds. Peek-like scheme, not Citadel (the every-scheme skill).
test('in a fast scheme the hand-off passes LAND_FAST for low and medium only, and the known-red ledger and its risk label to every land', async () => {
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
      // Written whole, then renamed in: a bare redirect creates the file empty first, and the wait below saw it that way under load.
      writeFileSync(join(cwd, 'tools', 'land.sh'), `[ "$1" = --check ] && exit 0\nprintf 'fast=%s\\nknown=%s\\nrisk=%s\\n' "\${LAND_FAST:-}" "\${LAND_KNOWN_RED:-}" "\${LAND_RISK:-}" >${JSON.stringify(dump + '.part')}\nmv ${JSON.stringify(dump + '.part')} ${JSON.stringify(dump)}\nprintf '%b' ${JSON.stringify(LIVE)}\n`);
      git(cwd, 'init', '-q');
      git(cwd, 'add', '.');
      git(cwd, 'commit', '-qm', 'init');
      store.setTicketDir(minion.id, cwd, null);
      addReview(store, minion.id);
      const res = await fetch(`${srv.base}/api/tickets/${minion.id}/land/handoff`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken(srv.data, minion.id)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: name, risk_reason: 'r', ...body }) });
      assert.equal(res.status, 202, await res.text());
      await until(`${name} land.sh ran`, () => existsSync(dump), 20_000);
      return readFileSync(dump, 'utf8');
    };
    assert.equal(await landWith('low', { risk: 'low' }), 'fast=1\nknown=test/x.test.ts\t#41 is fixing it\nrisk=low\n');
    assert.equal(await landWith('medium', { risk: 'medium' }), 'fast=1\nknown=test/x.test.ts\t#41 is fixing it\nrisk=medium\n');
    assert.equal(await landWith('high', { risk: 'high', go: 'Cara, 10:00 PST' }), 'fast=\nknown=test/x.test.ts\t#41 is fixing it\nrisk=high\n', 'high keeps the full gate');
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
  assert.ok(
    s.did.some((d) => d.startsWith('unpark 2 by #7')),
    'unparked first',
  );

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
test("landPhase reads the phase from land.sh's newest phase line", () => {
  assert.equal(landPhase(''), 'landing: starting');
  assert.equal(landPhase('queue: 2nd in line (ahead: #12 "x")\n'), 'landing: in line');
  assert.equal(landPhase("queue: 2nd in line\nland: riding in ticket/3-a's ship train: waiting for CI on the train\nland: pulled off ticket/3-a's ship train on a guess, red in test/a.test.ts: waiting for CI on the train without it\n"), 'landing: pulled off its train');
  assert.equal(landPhase('land: CI passed\nland: master is now at d1a5c2f "x"\n'), 'landing: deploying', 'any default branch (KT2)');
  assert.equal(landPhase('land: waiting for CI on abc\nland: build/3 is now at d1a5c2f "x"; master is untouched\n'), 'landing: waiting on CI', 'a build merge is not a deploy');
  for (const lock of ['deploy', 'land']) assert.equal(landPhase(`queue: 2nd in line (ahead: #12)\nqueue: got the ${lock} lock\n`), 'landing: starting'); // land-core.sh's lock is the land lock
  assert.equal(landPhase('queue: 2nd in line (ahead: #12)\nqueue: got the deploy lock\nland: rebasing ticket/1-x onto main (abc "y")\n'), 'landing: rebasing');
  assert.equal(landPhase('land: rebasing a onto main\nland: running test/a.test.ts on abc1234\nok 1\n'), 'landing: running tests');
  assert.equal(landPhase("land: rebasing a onto main\nland: waiting for CI on abc1234: the full suite on Cara's desktop (at most 6 min, then it runs here)\n"), 'landing: waiting on CI');
  assert.equal(landPhase('land: waiting for CI on abc\nland: failed in the full run but passed alone (x); running CI once more on abc, the land needs a fully green run\n'), 'landing: waiting on CI');
  assert.equal(landPhase('land: waiting for CI on abc\nland: CI FALLBACK: no runner. Running the full suite on perigee instead.\n'), 'landing: running tests');
  assert.equal(landPhase('land: waiting for CI on abc\nland: waiting for CI or a quiet perigee: CI: no runner, but perigee is busy (load 40.00 on 16 cores (quiet is under half)), so this keeps asking CI\n'), 'landing: waiting for CI or a quiet perigee');
  assert.equal(landPhase('land: waiting for CI on abc\nqueue: waiting for the restart ahead to have its verdict; main and the live checkout stay as they are until then\n'), 'landing: in line');
  assert.equal(landPhase('land: waiting for CI on abc\nland: main is now at abc1234 "#9"\ndeploy: restart queued as citadel-restart\n'), 'landing: deploying');
  assert.equal(landPhase('land: smoke: checking ticket/1-x before it queues\nland: smoke: running 5 test files\n'), 'landing: smoke check');
  assert.equal(landPhase('land: smoke: passed in 19 s\nqueue: 2nd in line (ahead: #12)\n'), 'landing: in line');
  assert.equal(landPhase('land: smoke: passed in 19 s\nland: own check: its CI runs now on the check runner, on abc1234\n'), 'landing: own check', '#1567');
  // A rider (#1166) says which train it rides in (#1366, for #1303), and is in line again once it goes back.
  assert.equal(landPhase("queue: 2nd in line (ahead: #12)\nland: riding in ticket/12-usage-bar's ship train: waiting for CI on the train\n"), "landing: riding in #12's train");
  assert.equal(landPhase("queue: 3rd in line\nland: riding in build/3's ship train: waiting for CI on the train\n"), "landing: riding in build/3's train");
  assert.equal(landPhase("land: riding in ticket/12-x's ship train: waiting\nland: back in line on its own: the ship train went without ticket/7-x\n"), 'landing: in line');
});

const SMOKE_RED = 'land: smoke: checking ticket/1-x before it queues\nland: smoke: ✖ test/prompt-budget.test.ts › budget\nland: smoke: tests failed (exit 1), before the line (21 s), so nothing landed and nobody waited on it. Fix it, re-test (citadel-test), commit, then run this again\n';

test('a smoke refusal (#1012) is a failed land that says it never got in line', async () => {
  assert.deepEqual(landResult(SMOKE_RED, 1), { kind: 'failed', smoke: true });
  assert.deepEqual(landResult('land: smoke: passed in 3 s\nland: the rebase onto main failed (see above), so nothing landed\n', 1), { kind: 'failed' }, 'a refusal after a passed smoke is a plain failure');
  const s = setup('smoke-red');
  await s.land(SMOKE_RED, 1);
  await s.handoffs.poll();
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /didn't go through: its smoke check refused it before it got in line \(nothing landed, and it never waited on the line or CI\)\. Fix the cause/);
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

test('handoffs() answers from memory: it does not read the landings folder again (#1210)', async () => {
  const data = mkdtempSync(join(root, 'mem-'));
  const dir = join(data, 'run', 'landings');
  for (let i = 1; i <= 50; i++) mkdirSync(join(dir, String(i)), { recursive: true });
  writeFileSync(join(dir, '7', 'handoff.json'), '{}');
  const l = new Landings(data);
  await l.scanned;
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(l.handoffs(), [7], 'found at start, then served from memory');
  l.settled(7);
  assert.deepEqual(l.handoffs(), []);
});

// Conflict prep (#1366): land.sh says a ship waiting in line will conflict once the train ahead ships; the server wakes
// its minion once per train top with the steps to record the fix (git rerere in a scratch worktree), and leaves its land running.
test('a prep line from a running land wakes the minion once, with the scratch-worktree steps, and the land keeps running', async () => {
  const top = 'a'.repeat(40),
    base = 'b'.repeat(40),
    head = 'c'.repeat(40);
  const line = `land: prep: ticket/7-x will conflict with ticket/3-y once ticket/2-z's ship train ships; conflicted files: a.txt, src/b.ts; record the fix against ${top} from ${base} to ${head}`;
  assert.deepEqual(prepConflict(`queue: 2nd in line\n${line}\n`), { branch: 'ticket/7-x', cause: 'ticket/3-y', front: 'ticket/2-z', files: 'a.txt, src/b.ts', top, base, head, train: true });
  // The kit's template (#1571): the one ship ahead, no train, and its own "resolves it" line.
  const tpl = `land: prep: ticket/7-x will conflict with ticket/6-y once ticket/6-y ships; conflicted files: a.txt; record the fix against ${top} from ${base} to ${head}`;
  assert.deepEqual(prepConflict(`${tpl}\n`), { branch: 'ticket/7-x', cause: 'ticket/6-y', front: 'ticket/6-y', files: 'a.txt', top, base, head, train: false });
  assert.match(prepMessage(prepConflict(tpl)!), /once ticket\/6-y ships, your rebase/);
  assert.doesNotMatch(prepMessage(prepConflict(tpl)!), /ship train|the train/);
  assert.equal(prepConflict(`${tpl}\nland: prep: ticket/7-x conflicts with 1234567 by its rebase, but the fix recorded ahead of time (git rerere) resolves it\n`), null);
  assert.equal(prepConflict(`${line}\nland: prep: ticket/7-x conflicts with ticket/3-y on ticket/2-z's ship train (a.txt), but the fix recorded ahead of time (git rerere) resolves it, so its rebase goes through once that train ships\n`), null, 'recorded already');
  const s = setup('prep');
  const gate = join(s.cwd, 'gate');
  writeFileSync(join(s.cwd, 'tools', 'land.sh'), `echo 'queue: 2nd in line (ahead: #2)' >&2\necho ${JSON.stringify(line)} >&2\nuntil [ -e ${JSON.stringify(gate)} ]; do sleep 0.05; done\nexit 1\n`);
  assert.ok(s.landings.handOff(1, s.cwd, { PATH: process.env.PATH! }, [], H));
  await until('the prep line', () => /land: prep:/.test(s.landings.get(1)?.output ?? ''));
  await s.handoffs.poll();
  await s.handoffs.poll();
  assert.equal(s.sent.length, 1, 'once per train top');
  assert.match(s.sent[0], /conflict with ticket\/3-y in a\.txt, src\/b\.ts/);
  assert.match(s.sent[0], new RegExp(`git worktree add --detach "\\$TMPDIR/train-prep" ${top}`));
  assert.match(s.sent[0], new RegExp(`-c rerere\\.enabled=true cherry-pick ${base}\\.\\.${head}`));
  assert.match(s.sent[0], /Don't hand it off again/);
  assert.match(s.sent[0], /cherry-pick --skip/, "and what to do when the fix keeps the train's side whole");
  assert.deepEqual(s.fyi, [true], "not someone writing while it waits in line: a clean ship still closes it (Runner.send's onMessage → Landings.talked)");
  assert.equal(s.ticket.state, 'outside', 'still landing');
  assert.deepEqual(s.landings.handoffs(), [1]);
  writeFileSync(gate, '');
  await until('land.sh ends', () => s.landings.get(1)?.code !== null);
});

test('a land stopped from the Status page says who stopped it and that nothing landed, not "fix the cause", and counts no failure (#1168)', async () => {
  const s = setup('stopped');
  const failed: number[] = [];
  s.deps.failed = (id) => {
    failed.push(id);
  };
  writeFileSync(join(s.cwd, 'tools', 'land.sh'), `echo 'land: rebasing onto main'\nsleep 300\n`);
  assert.ok(s.landings.handOff(1, s.cwd, { PATH: process.env.PATH! }, [], H));
  let pid: number | null = null;
  await until('land.sh runs', () => (pid = s.landings.landPid(1)) !== null);
  const cmd = (p: number) => (p === 5 ? 'mv\0pid.tmp\0pid' : 'bash\0tools/land.sh\0');
  assert.equal(
    s.landings.landPid(1, () => '5\n', cmd),
    null,
    "the wrapper's mv, just after its pid file appears, is not the ship",
  );
  assert.equal(
    s.landings.landPid(1, () => '5 6\n', cmd),
    6,
  );
  s.landings.markStopped(1, 'Josh', Date.UTC(2026, 10, 20, 21, 5));
  signalTree(pid!);
  await until('land.sh ends', () => s.landings.get(1)?.code !== null);
  assert.equal(s.landings.get(1)?.code, 143);
  assert.equal(s.landings.landPid(1), null, 'nothing runs any more');
  await s.handoffs.poll();
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /stopped by Josh from the Status page at \w{3} \d+, 1:05 PM PST\. Nothing landed and main is untouched\./);
  assert.doesNotMatch(s.sent[0], /didn't go through|Fix the cause/);
  assert.deepEqual(failed, [], 'not counted as a failed ship');
  assert.equal(s.ticket.note, 'ship stopped');
  assert.deepEqual(s.landings.handoffs(), [], 'reported');
});

test('a stop marked on a land that went red by itself, or past main moving, is told as it was (#1168)', async () => {
  const s = setup('stopped-moved');
  await s.land('land: main is now at abc1234 "#9"\nland: deploy failed\n', 143);
  s.landings.markStopped(1, 'Cara', Date.now(), 'by stopping its minion');
  await s.handoffs.poll();
  assert.match(s.sent[0], /stopped by Cara by stopping its minion.*main had already moved/s);
});

test('a ship that kept its place after reds of flakes only says how many in its shipped line (#1419 part 2)', async () => {
  const s = setup('live');
  const keep = (n: number) => `land: refused on flakes only (test/a.test.ts, then test/a.test.ts on the fresh run), not your change: keeping its place in line and riding the next train (${n} of 2)\n`;
  await s.land(LIVE.replace('\n', `\n${keep(1)}${keep(2)}`));
  await s.handoffs.poll();
  assert.deepEqual(s.notes, ['Shipped abc1234 "#9: usage bar": Usage bar in the top bar. Risk low: front end only. Kept its place in line after 2 reds of flakes only. Live now.']);
});

// C2 (#1406): a report cut off after its shipped line (a throw here, a kill in a drill) is finished by the next poll or
// server, and each step it already did (flakes, lines, the landed mark, app deploys, the shipped line) isn't done again.
test('a report cut off after its shipped line finishes once: no second line, deploy, flake or lesson row (C2)', async () => {
  const d = fakeDeploys(() => ({ state: 'deployed', to: 'abc1234ffff0000' }));
  const s = setup('settle-once', { apps: ['peek-auras'], deployOps: d.ops });
  const counts = { flakes: 0, learned: 0, landed: 0 };
  let cut = true;
  const getTicket = s.deps.store.getTicket;
  const deps: HandoffDeps = {
    ...s.deps,
    flakes: () => {
      counts.flakes++;
    },
    learned: () => {
      counts.learned++;
    },
    landed: () => {
      counts.landed++;
    },
    // The first read after the shipped line throws, as a kill there would stop it.
    store: {
      ...s.deps.store,
      getTicket: (id: number) => {
        if (id === 1 && cut && s.notes.length) {
          cut = false;
          throw new Error('cut off');
        }
        return getTicket(id);
      },
    },
  };
  await s.land(APP_LAND);
  await new LandHandoffs(deps).poll();
  assert.equal(s.notes.length, 1, 'the shipped line went out before the cut');
  assert.deepEqual(s.landings.handoffs(), [1], 'and the hand-off is still unreported');
  await new LandHandoffs({ ...deps, landings: new Landings(s.data) }).poll();
  assert.equal(s.notes.length, 1, `C2: the shipped line was posted ${s.notes.length} times`);
  assert.deepEqual(d.started, ['peek-auras for 1'], 'the app deployed once');
  assert.deepEqual(counts, { flakes: 1, learned: 1, landed: 1 }, 'one flake, lesson and landed mark each');
  assert.ok(
    s.did.some((x) => x.startsWith('close: Shipped')),
    s.did.join('\n'),
  );
  // The next hand-off starts afresh: its report runs every step again.
  s.ticket.status = 'idle';
  await s.land(APP_LAND);
  await new LandHandoffs({ ...deps, landings: s.landings }).poll();
  assert.equal(s.notes.length, 2, "the next ship's line goes out");
  assert.deepEqual(counts, { flakes: 2, learned: 2, landed: 2 }, 'and its flakes, lines and landed mark');
});

test('polls that overlap report a land once (#1463: the poll reads off the thread, so the next can start mid-read)', async () => {
  const s = setup('overlap');
  await s.land(LIVE);
  await Promise.all([s.handoffs.poll(), s.handoffs.poll(), s.handoffs.poll()]);
  assert.equal(s.notes.length, 1, 'one shipped line');
  assert.equal(s.did.filter((d) => d.startsWith('close')).length, 1, 'one dismissal');
  assert.deepEqual(s.landings.handoffs(), []);
});

test('the start reads no landing folder before it returns, and the daily prune keeps an unreported hand-off (#1463)', async () => {
  const data = mkdtempSync(join(root, 'prune-'));
  const dir = join(data, 'run', 'landings');
  const old = Date.now() - 30 * 24 * 3600_000;
  for (const id of ['3', '4', '5']) {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, 'code'), '0');
  }
  writeFileSync(join(dir, '4', 'handoff.json'), '{}');
  for (const id of ['3', '4']) utimesSync(join(dir, id, 'code'), old / 1000, old / 1000);
  const l = new Landings(data);
  assert.deepEqual(l.handoffs(), [], 'nothing yet: the scan runs off the thread');
  assert.ok(l.hasHandoff(4), 'one minion asked while it scans: a stat on its own folder');
  assert.deepEqual(await l.pending(), [4], 'the hand-off left by the last server');
  await l.prune(Date.now());
  assert.deepEqual(readdirSync(dir).sort(), ['4', '5'], 'the old finished folder goes; the old unreported one and the recent one stay');
});

test("a last run's folder a restart left mid-delete is no hand-off, and the daily prune drops it whatever its age (#1734)", async () => {
  const data = mkdtempSync(join(root, 'prune-old-'));
  const dir = join(data, 'run', 'landings');
  mkdirSync(join(dir, '6.old-1700000000000'), { recursive: true });
  writeFileSync(join(dir, '6.old-1700000000000', 'handoff.json'), '{}');
  mkdirSync(join(dir, '6'));
  writeFileSync(join(dir, '6', 'handoff.json'), '{}');
  const l = new Landings(data);
  assert.deepEqual(await l.pending(), [6], 'the renamed folder is not read as a minion');
  await l.prune(Date.now());
  assert.deepEqual(readdirSync(dir), ['6']);
});

test('a land settled while the start scans is not added back by the scan (#1463)', async () => {
  const data = mkdtempSync(join(root, 'scan-race-'));
  mkdirSync(join(data, 'run', 'landings', '8'), { recursive: true });
  writeFileSync(join(data, 'run', 'landings', '8', 'handoff.json'), '{}');
  const l = new Landings(data);
  l.settled(8);
  assert.deepEqual(await l.pending(), []);
  assert.ok(!l.hasHandoff(8));
});
