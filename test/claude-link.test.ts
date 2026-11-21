// ClaudeLink's sign-in (link()): what a person sees when two starts overlap, when no link shows in time,
// and when the sign-in ends while waiting for their code (#468 S02-7, S02-8). A fake `podman` on PATH
// stands in for `podman exec … claude auth login`; how it behaves is the FAKE_PODMAN env var.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { accountUsageKey } from '../src/account-pick.ts';
import { ClaudeLink, type ClaudeAccount } from '../src/claude-link.ts';
import { Containers, type RunCmd } from '../src/containers.ts';
import { Credentials } from '../src/credentials.ts';
import { Store } from '../src/db.ts';
import { until, holds } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'claude-link-'));
after(() => rmSync(root, { recursive: true, force: true }));
const bin = join(root, 'bin');
mkdirSync(bin);
const execs = join(root, 'execs.log');
writeFileSync(execs, '');
writeFileSync(join(bin, 'podman'), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(execs)}, process.argv.slice(2).join(' ') + '\\n');
const mode = process.env.FAKE_PODMAN;
if (mode === 'silent') setInterval(() => {}, 1000);
if (mode === 'link-then-exit') {
  console.log('Open https://claude.ai/oauth/authorize?x=1 to sign in');
  setTimeout(() => process.exit(0), 100);
}
`);
chmodSync(join(bin, 'podman'), 0o755);
writeFileSync(join(bin, 'claude'), '', { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;

const store = new Store(join(root, 'test.db'));
const fakeRun: RunCmd = async () => ({ code: 0, stdout: '', stderr: '' });
let n = 0;
function newLink() {
  const user = store.createUser({ name: `P${++n}`, login: `p${n}` });
  const link = new ClaudeLink(store, new Credentials(store, 'x'.repeat(40)), join(root, 'data'), join(bin, 'claude'), new Containers(fakeRun), `citadel-claude-l${n}-`);
  return { link, uid: user.id };
}
const execCount = () => readFileSync(execs, 'utf8').split('\n').filter(Boolean).length;

test('a sign-in started again while the container starts leaves no orphan sign-in behind (#468 S02-7)', async () => {
  process.env.FAKE_PODMAN = 'link-then-exit';
  const before = execCount();
  const { link, uid } = newLink();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  link.ensure = async () => {
    if (++calls === 1) await gate;
  };
  const first = link.link(uid);
  await new Promise((r) => setImmediate(r));
  const second = await link.link(uid).finally(release);
  assert.equal(second.state, 'waiting for code', second.error);
  await first;
  assert.equal(execCount() - before, 1, 'only the newer start ran claude auth login');
});

test('a sign-in that shows no link in 60 seconds says so, and the exit after its kill keeps that (#468 S02-8)', async (t) => {
  process.env.FAKE_PODMAN = 'silent';
  const { link, uid } = newLink();
  link.ensure = async () => {};
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = link.link(uid);
  // until() would wait on the mocked setTimeout.
  while (!readFileSync(execs, 'utf8').includes(`citadel-claude-l${n}-${uid} `)) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(60_000);
  const status = await started;
  assert.match(status.error ?? '', /didn't show a link within 60 seconds/);
  t.mock.timers.reset();
  await holds('the exit after the kill keeps the error', () => /didn't show a link within 60 seconds/.test(link.status(uid).error ?? ''), { ms: 200 });
  assert.match(link.status(uid).error ?? '', /didn't show a link within 60 seconds/);
});

test('a sign-in that ends while waiting for the code says so instead of waiting on (#468 S02-8)', async () => {
  process.env.FAKE_PODMAN = 'link-then-exit';
  const { link, uid } = newLink();
  link.ensure = async () => {};
  assert.equal((await link.link(uid)).state, 'waiting for code');
  const status = await until('the sign-in to end', () => {
    const s = link.status(uid);
    return s.state !== 'waiting for code' && s;
  }, 5000);
  assert.equal(status.state, 'not linked');
  assert.match(status.error ?? '', /ended/);
});

// Several Claude accounts (#779): which account turns run on, and how a limit, an expiry and a pin move it.
const acct = (n: number, extra: Partial<ClaudeAccount> = {}): ClaudeAccount => ({ n, linkedAt: 1, ...extra });

function linkedPerson(accounts: ClaudeAccount[], inUse = accounts[0].n) {
  const { link, uid } = newLink();
  const creds = new Credentials(store, 'x'.repeat(40));
  creds.put(uid, 'claude_runner', link.name(uid), { container: link.name(uid), home: join(root, `home-${uid}`), linkedAt: 1, accounts, inUse });
  return { link, uid, creds };
}

test('a row from before #779 reads as account 1 alone, expired with the row (#779)', () => {
  const { link, uid } = newLink();
  const creds = new Credentials(store, 'x'.repeat(40));
  creds.put(uid, 'claude_runner', link.name(uid), { container: link.name(uid), home: '/h', email: 'a@x', linkedAt: 1 });
  assert.deepEqual(link.accounts(uid), { accounts: [{ n: 1, email: 'a@x', plan: undefined, linkedAt: 1 }], inUse: 1 });
  const place = link.place(uid);
  assert.ok(place && !place.host);
  assert.equal(place.account, 1);
  assert.equal(place.configDir, '/h/.claude');
  assert.equal(place.env.CLAUDE_CONFIG_DIR.endsWith('/.claude'), true);
  creds.fail(uid, 'claude_runner');
  assert.ok(link.accounts(uid)!.accounts[0].expired);
  assert.equal(link.place(uid), null);
});

test('a limit moves turns to the next ready account, a turn that gets through clears it, and a pin moves them back (#779)', () => {
  const { link, uid } = linkedPerson([acct(1, { email: 'one@x' }), acct(2, { email: 'two@x' }), acct(3, { email: 'three@x' })]);
  const view = link.limitedView(uid, 1, Date.now() + 60_000);
  assert.deepEqual(view?.next, { n: 2, label: 'two@x' });
  const place = link.place(uid);
  assert.ok(place && !place.host);
  assert.equal(place.account, 2);
  assert.match(place.env.CLAUDE_CONFIG_DIR, /\/\.claude-2$/);
  assert.equal(link.status(uid).inUse, 2);
  assert.equal(link.status(uid).accounts.find((a) => a.n === 1)?.ready, false);
  link.cleared(uid, 1);
  assert.equal(link.status(uid).accounts.find((a) => a.n === 1)?.ready, true);
  assert.equal(link.place(uid)?.account, 2, 'sticky: a cleared account does not pull turns back');
  link.use(uid, 1);
  assert.equal(link.place(uid)?.account, 1);
});

test('turns go where the week resets soonest, a warm session stays put, and a pin wins until it is unpinned (#793)', () => {
  const { link, uid } = linkedPerson([acct(1), acct(2)]);
  const H = 3600_000;
  const meter = (utilization: number, resetsIn: number) => ({ weekly: { utilization, resetsAt: Date.now() + resetsIn, status: 'allowed' }, session: null, updatedAt: Date.now() });
  store.setSetting(accountUsageKey(uid, 1), meter(0.95, 100 * H));
  store.setSetting(accountUsageKey(uid, 2), meter(0.05, 20 * H));
  // A minion that ran on 1 a moment ago keeps its warm cache there; a new one goes to 2, whose week ends first.
  link.ran(uid, 'ticket:7', 1);
  assert.equal(link.place(uid, 'ticket:7')?.account, 1);
  assert.equal(link.place(uid)?.account, 2);
  assert.equal(link.place(uid, 'ticket:8')?.account, 2, 'a session with no record is cold');
  assert.equal(link.accounts(uid)?.inUse, 2, 'next-up is saved');
  assert.deepEqual([link.status(uid).inUse, link.status(uid).why], [2, 'soonest']);
  // A pin takes cold turns, never a warm one; unpinned, they go back to the soonest reset.
  link.use(uid, 1);
  assert.equal(link.place(uid)?.account, 1);
  link.ran(uid, 'ticket:8', 2);
  assert.equal(link.place(uid, 'ticket:8')?.account, 2);
  assert.deepEqual([link.status(uid).inUse, link.status(uid).why, link.status(uid).pinned], [1, 'pinned', 1]);
  // Limited, the pin falls over to the other account; it comes back once its limit has passed.
  assert.equal(link.limitedView(uid, 1, Date.now() + 60_000)?.next?.n, 2);
  assert.equal(link.place(uid)?.account, 2);
  link.cleared(uid, 1);
  assert.equal(link.place(uid)?.account, 1);
  link.use(uid, null);
  assert.equal(link.status(uid).pinned, undefined);
  assert.equal(link.place(uid)?.account, 2);
});

test('a warm record lasts under an hour, and old ones are dropped as new ones are written (#793)', (t) => {
  const { link, uid } = linkedPerson([acct(1), acct(2)]);
  const start = Date.now();
  // Account 2's week ends first, so a cold turn goes there.
  store.setSetting(accountUsageKey(uid, 1), { weekly: { utilization: 0.5, resetsAt: start + 100 * 3600_000, status: 'allowed' }, session: null, updatedAt: start });
  store.setSetting(accountUsageKey(uid, 2), { weekly: { utilization: 0.1, resetsAt: start + 20 * 3600_000, status: 'allowed' }, session: null, updatedAt: start });
  t.mock.timers.enable({ apis: ['Date'], now: start });
  link.ran(uid, 'ticket:1', 1);
  t.mock.timers.setTime(start + 54 * 60_000);
  assert.equal(link.place(uid, 'ticket:1')?.account, 1, 'warm');
  t.mock.timers.setTime(start + 56 * 60_000);
  assert.equal(link.place(uid, 'ticket:1')?.account, 2, 'cold');
  link.ran(uid, 'ticket:2', 2);
  assert.deepEqual(Object.keys(store.getSetting<object>(`claude_warm:${uid}`)!), ['ticket:2']);
});

test('when every account is limited, turns stay put and the earliest reset is when they resume (#779)', () => {
  const { link, uid } = linkedPerson([acct(1), acct(2)]);
  const soon = Date.now() + 60_000;
  assert.equal(link.limitedView(uid, 1, soon + 60_000)?.next?.n, 2);
  const view = link.limitedView(uid, 2, soon + 120_000);
  assert.equal(view?.next, null);
  assert.equal(view?.resetAt, soon + 60_000, 'account 1 resets first');
  assert.equal(link.linked(uid), 'linked', 'limited is not signed out: messages still start turns that wait');
});

test('an expired account moves turns on; the person reads as expired only once every account has (#779)', () => {
  const { link, uid } = linkedPerson([acct(1), acct(2)]);
  link.expire(uid, 1);
  assert.equal(link.linked(uid), 'linked');
  assert.equal(link.place(uid)?.account, 2);
  assert.throws(() => link.use(uid, 1), /needs linking again/);
  link.expire(uid, 2);
  assert.equal(link.linked(uid), 'expired');
  assert.equal(link.place(uid), null);
});

test('unlinking one of several accounts removes its sign-in and meters, keeps the rest, and waits for a turn on it (#779)', async () => {
  const { link, uid } = linkedPerson([acct(1), acct(2), acct(3)], 2);
  const home = join(root, `home-${uid}`);
  for (const d of ['.claude', '.claude-2']) {
    mkdirSync(join(home, d), { recursive: true });
    writeFileSync(join(home, d, '.credentials.json'), '{}');
  }
  writeFileSync(join(home, '.claude', 'settings.json'), '{}');
  store.setSetting(`usage:user:${uid}:account:2`, { weekly: null, session: null, updatedAt: 1 });
  let busy = join(home, '.claude-2');
  link.turnOn = (dir) => dir === busy;
  await assert.rejects(link.unlink(uid, 2), /turn is running on this account/);
  assert.ok(existsSync(join(home, '.claude-2', '.credentials.json')), 'refused: nothing removed');
  busy = '';
  // The container isn't running (fake podman says nothing): the sign-in still goes, from the host side.
  await link.unlink(uid, 2);
  assert.equal(existsSync(join(home, '.claude-2')), false);
  assert.equal(store.getSetting(`usage:user:${uid}:account:2`) ?? null, null);
  assert.deepEqual(link.accounts(uid)?.accounts.map((a) => a.n), [1, 3]);
  assert.equal(link.accounts(uid)?.inUse, 1, 'turns move off the account that went');
  // Account 1's meter keeps the key it had before there were several (account-pick.ts accountUsageKey), and goes too (#1270 C4).
  store.setSetting(`usage:user:${uid}`, { weekly: null, session: null, updatedAt: 1 });
  await link.unlink(uid, 1);
  assert.equal(store.getSetting(`usage:user:${uid}`) ?? null, null, "account 1's meter goes with it");
  assert.equal(existsSync(join(home, '.claude', '.credentials.json')), false, "account 1's login goes");
  assert.ok(existsSync(join(home, '.claude', 'settings.json')), "the container's other Claude files stay");
  assert.deepEqual(link.accounts(uid)?.accounts.map((a) => a.n), [3]);
});

test("unlinking every account clears each one's meter, so a fresh account linked in its place starts at zero (#1270 C4)", async () => {
  // Account 1 went before this fix, its meter left behind: the full unlink clears it too, as a new link starts at account 1.
  const { link, uid } = linkedPerson([acct(2)]);
  store.setSetting(`usage:user:${uid}`, { weekly: null, session: null, updatedAt: 1 });
  store.setSetting(`usage:user:${uid}:account:2`, { weekly: null, session: null, updatedAt: 1 });
  await link.unlink(uid);
  assert.equal(link.linked(uid), null);
  assert.equal(store.getSetting(`usage:user:${uid}`) ?? null, null);
  assert.equal(store.getSetting(`usage:user:${uid}:account:2`) ?? null, null);
});

test("the server login's extra account runs on the host with its own config folder; account 1 is the host's (#779)", () => {
  const user = store.createUser({ name: 'Host', login: `host${++n}`, server_login: true });
  const link = new ClaudeLink(store, new Credentials(store, 'x'.repeat(40)), join(root, 'data'), join(bin, 'claude'), new Containers(fakeRun), `citadel-claude-h${n}-`);
  assert.deepEqual(link.place(user.id), { host: true });
  store.setSetting(`claude_accounts:${user.id}`, { accounts: [acct(1), acct(2, { email: 'two@x' })], inUse: 1 });
  link.limitedView(user.id, 1, Date.now() + 60_000);
  const dir = join(root, 'data', 'claude-accounts', String(user.id), '2');
  assert.deepEqual(link.place(user.id), { host: true, account: 2, configDir: dir, env: { CLAUDE_CONFIG_DIR: dir } });
  assert.equal(link.status(user.id).state, 'linked');
  assert.throws(() => link.linkSlot(user.id, 1));
});

test('two account folders signed in to one Claude organization say so; one email in two organizations does not (#1461)', async () => {
  const user = store.createUser({ name: 'Twin', login: `twin${++n}`, server_login: true });
  const link = new ClaudeLink(store, new Credentials(store, 'x'.repeat(40)), join(root, 'data'), join(bin, 'claude'), new Containers(fakeRun), `citadel-claude-t${n}-`);
  const was = process.env.CLAUDE_CONFIG_DIR;
  const one = join(root, `twin-host-${n}`);
  const two = join(root, 'data', 'claude-accounts', String(user.id), '2');
  mkdirSync(one, { recursive: true });
  mkdirSync(two, { recursive: true });
  const signIn = (dir: string, org: string) => writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'cara@x', accountUuid: 'u1', organizationUuid: org } }));
  process.env.CLAUDE_CONFIG_DIR = one;
  try {
    store.setSetting(`claude_accounts:${user.id}`, { accounts: [acct(1), acct(2, { email: 'cara@x' })], inUse: 1 });
    signIn(one, 'org-a');
    signIn(two, 'org-a');
    // Read behind the answer (the server's one thread, #1463): the note shows on a later call.
    const accounts = () => link.accountList(user.id)?.accounts;
    await until('the same organization is noted', () => accounts()?.[1]?.same);
    assert.deepEqual(accounts(), [{ n: 1, label: "the server's own login" }, { n: 2, label: 'cara@x', same: "the server's own login" }]);
    signIn(two, 'org-b');
    await until('a re-login is read again', () => accounts()?.[1] && !accounts()![1].same);
    assert.deepEqual(accounts(), [{ n: 1, label: "the server's own login" }, { n: 2, label: 'cara@x' }]);
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = was;
  }
});
