import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { syncTurns, workerInfo } from '../src/machine-turn.ts';
import { accountDir as serverDir } from '../src/claude-link.ts';
import { accountDir, signedSlots, Worker } from '../public/machine-worker.mjs';
import { Store } from '../src/db.ts';
import type { MachinePools } from '../src/machine-pools.ts';
import { Runner } from '../src/runner.ts';
import { stopTurns, tempRoot } from './helpers.ts';
import { until } from './wait.ts';

// Each of a person's linked Claude accounts on their machine (#2061): signed in there in its own folder, said to the
// server by number and organization, and a turn the server picked for one runs from that one's folder.
const tmp = tempRoot('machine-accounts-');
after(() => tmp.teardown());
let n = 0;

test("the worker's account folders are named as the server's", () => {
  for (const k of [1, 2, 3]) assert.equal(accountDir(k), serverDir(k));
});

test('the worker says which accounts hold a sign-in there, and their organization, never what the sign-in is', () => {
  const home = join(tmp.dir, `home-${++n}`);
  const put = (file: string, text: string) => {
    mkdirSync(join(home, file, '..'), { recursive: true });
    writeFileSync(join(home, file), text);
  };
  assert.deepEqual(signedSlots(home), [], 'an empty home: none');
  // Account 1 signed in as `citadel-worker signin` makes it: .claude.json beside its folder.
  put('.claude/.credentials.json', '{"claudeAiOauth":{"accessToken":"secret"}}');
  put('.claude.json', JSON.stringify({ oauthAccount: { organizationUuid: 'org-one', emailAddress: 'c@x' } }));
  put('.claude-2/.credentials.json', '{"claudeAiOauth":{"accessToken":"secret"}}');
  put('.claude-2/.claude.json', JSON.stringify({ oauthAccount: { organizationUuid: 'org-two' } }));
  put('.claude-3/.credentials.json', '');
  put('.claude-3/.claude.json', JSON.stringify({ oauthAccount: { organizationUuid: 'org-three' } }));
  const slots = signedSlots(home);
  assert.deepEqual(slots, [
    { n: 1, org: 'org-one' },
    { n: 2, org: 'org-two' },
  ]);
  assert.doesNotMatch(JSON.stringify(slots), /secret|c@x/);
  put('.claude-2/.claude.json', '{"oauthAccount":{"organizationUuid":"not an id; rm -rf"}}');
  assert.deepEqual(signedSlots(home)[1], { n: 2, org: null }, 'an organization that is not an id is not said');
});

test("a turn picked for account 2 runs from account 2's folder there; account 1, or none said, from Claude Code's default", () => {
  const root = join(tmp.dir, `w-${++n}`);
  const w = new Worker({ config: { root, image: 'img' }, appUrl: 'http://127.0.0.1:9', token: 't' });
  const fit = (account?: number) => {
    const local = join(root, `turn-${++n}`);
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, 'spec.json'), JSON.stringify({ command: 'claude', env: { HOME: '/home/cara', TMPDIR: '/nowhere/tmp' } }));
    const launch = { wrapper: [], cwd: null, home: '/home/cara', roots: [], ...(account ? { account } : {}) };
    w.fitSpec({ dir: '/d', local, launch } as unknown as Parameters<Worker['fitSpec']>[0]);
    return JSON.parse(readFileSync(join(local, 'spec.json'), 'utf8')).env.CLAUDE_CONFIG_DIR;
  };
  assert.equal(fit(2), '/home/cara/.claude-2');
  assert.equal(fit(3), '/home/cara/.claude-3');
  assert.equal(fit(1), undefined);
  assert.equal(fit(), undefined, 'a one-account person, or a server from before: as it was');
  assert.equal(fit(9), undefined, 'an account number it has no folder for: the default');
});

test('the server keeps what a worker says of its accounts, checked', async () => {
  const id = 9000 + ++n;
  const accounts = [{ n: 1, org: 'org-one' }, { n: 2, org: 'bad id!' }, { n: 7, org: 'x' }, { n: 2, org: 'org-two' }, 'junk'];
  await syncTurns(id, { worker: { claude: '1', max: 1, signedIn: true, accounts }, turns: [] });
  assert.deepEqual(workerInfo(id)?.accounts, [
    { n: 1, org: 'org-one' },
    { n: 2, org: 'org-two' },
  ]);
  await syncTurns(id, { worker: { claude: '1', max: 1, signedIn: true }, turns: [] });
  assert.equal(workerInfo(id)?.accounts, null, 'an agent from before says nothing of them');
});

test('a turn the line put on a machine picks its account only among those signed in there (#2061)', async () => {
  const store = new Store(join(tmp.dir, 'runner.db'));
  const project = store.createProject('P', null);
  const cara = store.createUser({ name: 'Cara', login: 'cara' });
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, tmp.dir, null);
  const r = new Runner(
    store,
    () => {},
    () => ({}),
    '/bin/false',
  );
  r.personOf = () => cara.id;
  const asked: [number, number | null][] = [];
  const picked: (number[] | undefined)[] = [];
  // The line has it on machine 7, where only Cara's account 2 is signed in; the pick refuses, so the turn goes no further.
  (r.turnLine as { placeOf: (id: number) => number }).placeOf = () => 7;
  r.pools = { launch: (at: number) => ({ id: at, name: 'w1' }), accountsAt: (machine: number, person: number | null) => (asked.push([machine, person]), [2]), nameOf: () => 'w1' } as unknown as MachinePools;
  // The early "can their Claude run at all" check (Runner.refused) asks with no machine; the turn's own pick names one.
  r.placeFor = (...a) => {
    if (a.length < 4) return { host: true };
    picked.push(a[3]);
    return { refused: 'stop here' };
  };
  try {
    r.send(t.id, 'Cara', 'hi');
    await until('the account pick', () => picked.length > 0);
    assert.deepEqual(asked[0], [7, cara.id], "it asks the machine the line placed it on, for the turn's person");
    assert.deepEqual(picked[0], [2], 'and the pick gets only the account signed in there');
  } finally {
    await stopTurns(tmp.dir);
    store.db.close();
  }
});
