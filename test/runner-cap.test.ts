// One Peek build while Citadel ships (#1902): the spare runners' label goes off and always comes back. GitHub is faked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CapDeps, RunnerCap, RUNNER_CAP_MS, runnersBeside } from '../src/runner-cap.ts';
import { RunnerTokens, type Listed } from '../src/ci-runner.ts';
import { Credentials } from '../src/credentials.ts';
import { Store } from '../src/db.ts';
import { GithubLink } from '../src/github-link.ts';

const L = 'peek-auras-ci';
const MIN = 60_000;

function world(names = ['DESK', 'DESK-2', 'DESK-3', 'DESK-4']) {
  const store = new Store(':memory:');
  const runners: Listed[] = names.map((name, i) => ({ id: i + 1, name, status: 'online', busy: false, labels: [L, 'extra'] }));
  runners.push({ id: 90, name: 'DESK-heavy', status: 'online', busy: false, labels: ['peek-auras-heavy'] }, { id: 91, name: 'OTHER', status: 'online', busy: false, labels: [L] });
  const w = { store, runners, why: null as string | null, down: false, unknown: false, ops: [] as string[], reports: [] as string[], beforeDrop: () => {} };
  const boot = (o: Partial<CapDeps> = {}) =>
    new RunnerCap({
      project: () => store.getProject(1) ?? null,
      label: () => L,
      why: () => w.why,
      here: () => (w.unknown ? null : (n) => n.startsWith('DESK')),
      store,
      report: (_p, text) => w.reports.push(text),
      log: () => {},
      tokens: {
        listed: async () => {
          w.ops.push('list');
          if (w.down) throw new Error('GitHub is down');
          return runners.map((r) => ({ ...r, labels: [...r.labels] }));
        },
        dropLabel: async (_p, id, label) => {
          w.beforeDrop();
          const r = runners.find((x) => x.id === id);
          if (r) r.labels = r.labels.filter((l) => l !== label);
        },
        addLabel: async (_p, id, label) => {
          if (w.down) throw new Error('GitHub is down');
          const r = runners.find((x) => x.id === id);
          if (r && !r.labels.includes(label)) r.labels.push(label);
          return !!r;
        },
      },
      ...o,
    });
  const user = store.createUser({ name: 'Cara', login: 'cara' });
  store.createProject('Peek Auras', null, user.id);
  return Object.assign(w, { boot, can: () => runners.filter((r) => r.labels.includes(L)).map((r) => r.name) });
}
const ALL = ['DESK', 'DESK-2', 'DESK-3', 'DESK-4', 'OTHER'];

test('while a ship is in line one build runner on that PC keeps the label; the rest get it back after, other labels untouched', async () => {
  const w = world();
  const cap = w.boot();
  await cap.tick(0);
  assert.deepEqual(w.ops, [], 'GitHub is not asked with no ship and nothing off');
  w.why = 'a ship is in line';
  await cap.tick(15_000);
  assert.deepEqual(w.can(), ['DESK', 'OTHER']);
  assert.deepEqual(w.runners[1].labels, ['extra']);
  assert.match(cap.text(() => true)!, /Peek Auras builds one at a time \(3 runners paused\)/);
  assert.equal(
    cap.text(() => false),
    null,
    'who cannot see the scheme is not told of it',
  );
  assert.deepEqual([cap.owes(2, L), cap.owes(2, 'extra'), cap.owes(1, L)], [true, false, false]);
  w.why = null;
  await cap.tick(30_000);
  assert.deepEqual(w.can(), ALL);
  assert.deepEqual(w.runners[4].labels, ['peek-auras-heavy']);
  assert.equal(
    cap.text(() => true),
    null,
  );
});

test("main's own cap: the label stays only on a runner main can take, busy or not, in a setting of its own, for its own limit (Josh, 2026-11-25)", async () => {
  const w = world();
  w.runners[0].busy = true; // a ship's run, finishing
  w.runners[2].labels.push('side');
  w.why = "main's run goes first";
  const cap = w.boot({ key: 'runner-cap-main', capMs: 60 * MIN, keepOn: (x) => x.labels.includes('side') });
  await cap.tick(0);
  assert.deepEqual(w.can(), ['DESK-3', 'OTHER']);
  assert.deepEqual(w.store.getSetting('runner-cap'), null, "not the Peek cap's setting");
  assert.equal((w.store.getSetting('runner-cap-main') as { off: unknown[] }).off.length, 3);
  await cap.tick(61 * MIN);
  assert.deepEqual(w.can(), ALL, 'past its own limit the labels go back');
  w.runners[2].status = 'offline';
  await w.boot({ key: 'runner-cap-x', keepOn: (x) => x.labels.includes('side') }).tick(0);
  assert.deepEqual(w.can(), ALL, 'no runner main can take: nothing comes off');
});

test('the runner with a build on it keeps the label', async () => {
  const w = world();
  w.runners[2].busy = true;
  w.why = 'a ship is in line';
  await w.boot().tick(0);
  assert.deepEqual(w.can(), ['DESK-3', 'OTHER']);
});

test('two builds running when a ship joins: neither runner is let take another but the one kept', async () => {
  const w = world();
  w.runners[1].busy = w.runners[2].busy = true;
  w.why = 'a ship is in line';
  await w.boot().tick(0);
  assert.deepEqual(w.can(), ['DESK-2', 'OTHER']);
});

test('labels that could not go back keep the 4 hours of the ships that took them off', async () => {
  const w = world();
  const cap = w.boot();
  w.why = 'a ship is in line';
  await cap.tick(0);
  w.why = null;
  w.down = true;
  for (let m = 180; m < 195; m++) await cap.tick(m * MIN);
  assert.equal(w.reports.length, 1);
  w.why = 'a ship is in line';
  w.down = false;
  await cap.tick(200 * MIN);
  await cap.tick(RUNNER_CAP_MS + MIN);
  assert.deepEqual(w.can(), ALL);
});

test('each label is written down before GitHub is asked to take it off', async () => {
  const w = world();
  const seen: number[] = [];
  w.beforeDrop = () => void seen.push(w.store.getSetting<{ off: unknown[] }>('runner-cap')!.off.length);
  w.why = 'a ship is in line';
  await w.boot().tick(0);
  assert.deepEqual(seen, [1, 2, 3]);
});

test('a server that restarts puts back what the last one took off', async () => {
  const w = world();
  w.why = 'a ship is in line';
  await w.boot().tick(0);
  w.why = null;
  await w.boot().tick(MIN);
  assert.deepEqual(w.can(), ALL);
});

test('a restarted server that does not know the PC yet leaves the runners alone', async () => {
  const w = world();
  w.why = 'a ship is in line';
  await w.boot().tick(0);
  w.unknown = true;
  await w.boot().tick(MIN);
  assert.deepEqual(w.can(), ['DESK', 'OTHER']);
});

test('a label taken off by a server handing over while the next puts labels back is not forgotten', async () => {
  const w = world(['DESK', 'DESK-2']);
  const next = w.boot();
  let between: Promise<void> | undefined;
  w.beforeDrop = () => {
    w.why = null;
    between ??= next.tick(1);
  };
  w.why = 'a ship is in line';
  const old = w.boot();
  await old.tick(0);
  await between;
  await next.tick(2 * MIN);
  await next.tick(4 * MIN);
  assert.deepEqual(w.can(), ['DESK', 'DESK-2', 'OTHER']);
});

test('after 4 hours of ships without a break the labels go back until the line is clear', async () => {
  const w = world();
  const cap = w.boot();
  w.why = 'a ship is in line';
  await cap.tick(0);
  await cap.tick(RUNNER_CAP_MS - 1);
  assert.deepEqual(w.can(), ['DESK', 'OTHER']);
  await cap.tick(RUNNER_CAP_MS);
  assert.deepEqual(w.can(), ALL);
  await cap.tick(RUNNER_CAP_MS + 10 * MIN);
  assert.deepEqual(w.can(), ALL);
  w.why = null;
  await cap.tick(RUNNER_CAP_MS + 11 * MIN);
  w.why = 'a ship is in line';
  await cap.tick(RUNNER_CAP_MS + 12 * MIN);
  assert.deepEqual(w.can(), ['DESK', 'OTHER']);
});

test('the kept runner going offline hands the label to one that is online', async () => {
  const w = world();
  const cap = w.boot();
  w.why = 'a ship is in line';
  await cap.tick(0);
  w.runners[0].status = 'offline';
  await cap.tick(MIN);
  assert.deepEqual(w.can(), ['DESK-2', 'OTHER']);
  for (const r of w.runners) r.status = 'offline';
  await cap.tick(2 * MIN);
  assert.deepEqual(w.can(), ALL, 'with none online, nothing is capped');
});

test('the kept runner going offline while GitHub still calls it busy hands the label on (2026-11-27, DESKTOP-G248IJ8)', async () => {
  const w = world();
  const cap = w.boot();
  w.why = 'a ship is in line';
  await cap.tick(0);
  Object.assign(w.runners[0], { status: 'offline', busy: true });
  await cap.tick(MIN);
  assert.deepEqual(w.can(), ['DESK-2', 'OTHER']);
});

test('a label that cannot be put back is tried every minute and told to the Taskmaster once', async () => {
  const w = world();
  const cap = w.boot();
  w.why = 'a ship is in line';
  await cap.tick(0);
  w.why = null;
  w.down = true;
  for (let m = 1; m < 30; m++) await cap.tick(m * MIN);
  assert.equal(w.reports.length, 1);
  assert.match(w.reports[0], /DESK-2, DESK-3, DESK-4.*GitHub is down/);
  assert.match(cap.text(() => true)!, /still off 3 runners: putting it back failed/);
  w.down = false;
  await cap.tick(31 * MIN);
  assert.deepEqual(w.can(), ALL);
});

test('one runner that cannot be found again keeps no other from its label, and is forgotten', async () => {
  const w = world();
  const cap = w.boot();
  w.why = 'a ship is in line';
  await cap.tick(0);
  w.runners.splice(1, 1);
  w.why = null;
  await cap.tick(MIN);
  assert.deepEqual(w.can(), ['DESK', 'DESK-3', 'DESK-4', 'OTHER']);
  assert.equal(
    cap.text(() => true),
    null,
  );
  assert.deepEqual(w.reports, []);
});

test('GitHub unreadable when a ship joins changes nothing', async () => {
  const w = world();
  w.down = true;
  w.why = 'a ship is in line';
  await w.boot().tick(0);
  assert.deepEqual(w.can(), ALL);
});

test("only runners on a PC that hosts Citadel's own count, and none while that is unknown", () => {
  const pcs = new Map([
    ['desk', new Set(['o/citadel/desk-linux', 'o/peek/desk-2'])],
    ['other', new Set(['o/peek/other'])],
    ['desk-9', new Set(['o/peek/desk-9'])],
  ]);
  const on = runnersBeside(pcs, 'O/Citadel', 'o/peek')!;
  assert.deepEqual(['DESK', 'DESK-2', 'DESK-9', 'OTHER', 'DESKTOP'].map(on), [true, true, false, false, false]);
  assert.equal(runnersBeside(new Map(), 'o/citadel', 'o/peek'), null);
  assert.equal(runnersBeside(pcs, null, 'o/peek'), null);
});

test("GitHub's label calls go out as the scheme's owner, name only that label, and read a gone runner as false", async () => {
  const store = new Store(':memory:');
  const creds = new Credentials(store, 'secret');
  const link = new GithubLink(store, creds, 'client', 'shh');
  const cara = store.createUser({ name: 'Cara', login: 'cara' });
  creds.put(cara.id, 'github', 'gho_cara', { login: 'caraminden', id: 1, name: null });
  const p = store.createProject('Peek Auras', 'https://github.com/o/peek.git', cara.id);
  const calls: string[] = [];
  let status = 200;
  const tokens = new RunnerTokens(store, link, true, (async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url.replace('https://api.github.com', '')} ${init.body ?? ''}`.trim());
    return Response.json({}, { status });
  }) as typeof fetch);
  await tokens.dropLabel(p, 7, L);
  assert.equal(await tokens.addLabel(p, 7, L), true);
  assert.deepEqual(calls, [`DELETE /repos/o/peek/actions/runners/7/labels/${L}`, `POST /repos/o/peek/actions/runners/7/labels {"labels":["${L}"]}`]);
  status = 404;
  assert.equal(await tokens.addLabel(p, 7, L), false);
  status = 500;
  await assert.rejects(tokens.addLabel(p, 7, L), /500/);
});
