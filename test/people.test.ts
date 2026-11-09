// Per-person logins and who sees what: signing in, invites, scheme owners and members, the live stream
// and push filtered by membership, and turns only for people allowed on the server's Claude login.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { lendsMachine, lendsMachines, mayReceive, messageScope, turnRefusal } from '../src/access.ts';
import { Auth, hashPassword } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { bootServer, PASSWORD, until, type Booted, stopTurns } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'people-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});

function world() {
  const store = new Store(':memory:');
  const auth = new Auth(PASSWORD, 'x'.repeat(40), undefined, store);
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const olive = store.createUser({ name: 'Olive', login: 'olive' });
  const citadel = store.createProject('Citadel', null, cara.id);
  const games = store.createProject('Games', null, josh.id);
  return { store, auth, cara, josh, olive, citadel, games };
}
const cookie = (auth: Auth, user: { id: number; name: string }) => ({ headers: { cookie: auth.issueCookie(user, false).split(';')[0] } }) as any;

test('people sign in with their own password; the shared one signs in an admin only', async () => {
  const { store, auth, josh } = world();
  store.updateUser(josh.id, { password_hash: await hashPassword('joshs-password') });
  assert.equal((await auth.signIn('ip', 'JOSH', 'joshs-password'))?.name, 'Josh');
  assert.equal(await auth.signIn('ip', 'josh', 'wrong-password'), null);
  // The shared password signs in only an admin, by their own login: never Josh, nor an unknown login.
  assert.equal((await auth.signIn('ip', 'josh', PASSWORD))?.name, undefined);
  assert.equal((await auth.signIn('ip', 'cara', PASSWORD))?.name, 'Cara');
  assert.equal(await auth.signIn('ip', 'boot-check', PASSWORD), null);
  // Disabled: no sign-in, and their cookie stops working at once.
  const before = cookie(auth, josh);
  store.updateUser(josh.id, { disabled_at: Date.now() });
  assert.equal(await auth.signIn('ip', 'josh', 'joshs-password'), null);
  assert.equal(auth.session(before), null);
});

test('a session takes its name and rights from the row; an old name-only cookie maps to its person', () => {
  const { store, auth, josh } = world();
  const s = auth.session(cookie(auth, josh));
  assert.deepEqual([s?.name, s?.uid, s?.admin], ['Josh', josh.id, false]);
  store.updateUser(josh.id, { name: 'Joshua' });
  assert.equal(auth.session(cookie(auth, josh))?.name, 'Joshua');
  // A cookie from the shared-password days has a name and no id.
  const payload = Buffer.from(JSON.stringify({ name: 'cara', exp: Date.now() + 60_000 })).toString('base64url');
  const sig = (auth as any).sign(payload);
  assert.equal(auth.session({ headers: { cookie: `cc_session=${payload}.${sig}` } } as any)?.admin, true);
  const stranger = Buffer.from(JSON.stringify({ name: 'Stranger', exp: Date.now() + 60_000 })).toString('base64url');
  assert.equal(auth.session({ headers: { cookie: `cc_session=${stranger}.${(auth as any).sign(stranger)}` } } as any), null);
});

test('an invite link works until it expires, and a new one replaces the old', () => {
  const { store, auth, josh } = world();
  const first = auth.newInvite(josh.id);
  assert.equal(auth.inviteUser('ip', first)?.id, josh.id);
  const second = auth.newInvite(josh.id);
  assert.equal(auth.inviteUser('ip', first), null);
  assert.equal(auth.inviteUser('ip', second)?.id, josh.id);
  store.updateUser(josh.id, { invite_expires: Date.now() - 1 });
  assert.equal(auth.inviteUser('ip', second), null);
});

test('a person sees the schemes they own or are in; an admin sees all', () => {
  const { store, cara, josh, olive, citadel, games } = world();
  const as = (u: typeof cara) => ({ uid: u.id, admin: !!u.admin });
  assert.equal(store.visibleProjects(as(cara)), null);
  assert.deepEqual([...store.visibleProjects(as(josh))!], [games.id]);
  assert.deepEqual([...store.visibleProjects(as(olive))!], []);
  store.addMember(games.id, olive.id);
  assert.ok(store.canSee(as(olive), games.id) && !store.canSee(as(olive), citadel.id));
  assert.deepEqual(store.listMembers(games.id).map((m) => [m.name, m.owner]), [['Josh', true], ['Olive', false]]);
  // Removing Josh hands his schemes to the admin; Olive's membership stays.
  store.deleteUser(josh.id, cara.id);
  assert.equal(store.getProject(games.id)?.owner_id, cara.id);
  assert.deepEqual(store.listMembers(games.id).map((m) => m.name), ['Cara', 'Olive']);
});

test("the stream carries a scheme's news to its people, and admin-only news to admins", () => {
  const { store, josh, olive, citadel, games } = world();
  const t = store.createTicket({ project_id: games.id, title: 'T', permission_mode: 'default', created_by: 'Josh' });
  const joshS = { name: 'Josh', uid: josh.id, exp: 0 };
  const oliveS = { name: 'Olive', uid: olive.id, exp: 0 };
  const scope = (msg: object) => messageScope(store, msg);
  assert.equal(scope({ type: 'event', event: { ticket_id: t.id } }), games.id);
  assert.equal(scope({ type: 'ticket', ticket: { project_id: citadel.id } }), citadel.id);
  assert.equal(scope({ type: 'branch', ticketId: t.id }), games.id);
  // The machines list goes to everyone, each cut to their own machines by server.ts broadcast (#306).
  assert.equal(scope({ type: 'machines', machines: [] }), null);
  assert.equal(scope({ type: 'properties', projectId: null }), null);
  assert.ok(mayReceive(store, joshS, games.id) && !mayReceive(store, oliveS, games.id));
  assert.ok(!mayReceive(store, joshS, citadel.id) && !mayReceive(store, joshS, 'admin') && mayReceive(store, oliveS, null));
});

test("turns run for people allowed on the server's login; anyone else's message waits", () => {
  const { store, josh, citadel, games } = world();
  const mine = store.createTicket({ project_id: citadel.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const his = store.createTicket({ project_id: games.id, title: 'T', permission_mode: 'default', created_by: 'Josh' });
  assert.equal(turnRefusal(store, mine, 'Cara'), null);
  assert.match(turnRefusal(store, his, 'Josh')!, /Turns for Josh start once they link their Claude account/);
  // No person (GitHub, a wake, another thread): the scheme owner's call.
  assert.equal(turnRefusal(store, mine, 'GitHub'), null);
  assert.match(turnRefusal(store, his, 'GitHub')!, /its owner, Josh,/);
  store.updateUser(josh.id, { server_login: 1 });
  assert.equal(turnRefusal(store, his, 'Josh'), null);
  // His own Claude (#213): linked runs, expired waits with its own words.
  store.updateUser(josh.id, { server_login: 0 });
  assert.equal(turnRefusal(store, his, 'Josh', (uid) => (uid === josh.id ? 'linked' : null)), null);
  assert.match(turnRefusal(store, his, 'Josh', (uid) => (uid === josh.id ? 'expired' : null))!, /Josh's Claude sign-in expired/);
  assert.match(turnRefusal(store, his, 'GitHub', () => null)!, /its owner, Josh, links/);
  // The connected machines are the admin's: only their schemes' minions get them.
  assert.ok(lendsMachines(store, citadel) && !lendsMachines(store, games));
});

test('a machine lent to chosen schemes goes to those, even a non-admin\'s, and an unscoped one follows lendsMachines (#303)', () => {
  const { store, citadel, games } = world();
  const vault = store.createMachine('vault', '', 'Cara');
  assert.ok(lendsMachine(store, vault, citadel) && !lendsMachine(store, vault, games));
  // #62's leftover rows don't count while the machine isn't scoped.
  store.db.prepare('INSERT INTO machine_projects (machine_id, project_id) VALUES (?, ?)').run(vault.id, games.id);
  assert.ok(!lendsMachine(store, store.getMachine(vault.id)!, games));
  store.setMachineProjects(vault.id, [games.id]);
  const scoped = store.getMachine(vault.id)!;
  assert.ok(lendsMachine(store, scoped, games) && !lendsMachine(store, scoped, citadel));
  assert.deepEqual(store.machineProjects(vault.id), [games.id]);
  store.setMachineProjects(vault.id, null);
  const back = store.getMachine(vault.id)!;
  assert.ok(lendsMachine(store, back, citadel) && !lendsMachine(store, back, games));
  assert.deepEqual(store.machineProjects(vault.id), [games.id], 'grants stay, unread');
});

// ---------- the real server ----------

const fakeClaude = join(root, 'claude-fake');
writeFileSync(fakeClaude, `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
  console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.41 } } } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`);
chmodSync(fakeClaude, 0o755);

let srv: Booted;
const people: Record<string, { id: number; cookie: string }> = {};
async function as(who: string, path: string, body?: unknown, method?: string) {
  const res = await fetch(srv.base + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Cookie: people[who].cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude } });
  people.Cara = { id: 1, cookie: srv.cookie };
  for (const name of ['Josh', 'Olive']) {
    const made = await as('Cara', '/api/people', { name });
    assert.equal(made.status, 201);
    const res = await fetch(`${srv.base}/api/invite/${made.data.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: `${name}-password` }) });
    assert.equal(res.status, 200);
    people[name] = { id: made.data.person.id, cookie: res.headers.get('set-cookie')!.split(';')[0] };
    // The link is used up.
    assert.equal((await fetch(`${srv.base}/api/invite/${made.data.token}`)).status, 404);
  }
});
after(() => srv?.stop());

test('people make their own schemes, add others to them, and see nothing else', async () => {
  const cara = (await as('Cara', '/api/projects', { name: 'Caras' })).data;
  const josh = await as('Josh', '/api/projects', { name: 'Joshs' });
  assert.equal(josh.status, 201);
  assert.deepEqual((await as('Josh', '/api/projects')).data.map((p: any) => [p.name, p.owner]), [['Joshs', 'Josh']]);
  assert.deepEqual((await as('Olive', '/api/projects')).data, []);
  assert.equal((await as('Olive', `/api/projects/${josh.data.id}`)).status, 404);
  assert.equal((await as('Josh', `/api/projects/${cara.id}`)).status, 404);
  // Only an admin starts a scheme from a folder on the server, or makes a repo on their GitHub account.
  assert.equal((await as('Josh', '/api/projects', { name: 'Peek', source: 'folder', folder: '/' })).status, 403);
  assert.equal((await as('Josh', '/api/projects', { name: 'Repo', source: 'new' })).status, 403);
  // Plugins load code from any folder on the server: an owner who isn't an admin can't set them.
  assert.equal((await as('Josh', `/api/projects/${josh.data.id}`, { plugin_dirs: '/home' }, 'PATCH')).status, 403);
  assert.equal((await as('Josh', `/api/projects/${josh.data.id}`, { plugin_dirs: '', approval_rules: 'Bash(rm:*)' }, 'PATCH')).status, 200);
  assert.equal((await as('Cara', `/api/projects/${josh.data.id}`, { plugin_dirs: 'tools/mods' }, 'PATCH')).status, 200);
  // The optional ones (#361) too: a minion picks only from what an admin registered.
  assert.equal((await as('Josh', `/api/projects/${josh.data.id}`, { optional_plugin_dirs: '/home' }, 'PATCH')).status, 403);
  assert.equal((await as('Cara', `/api/projects/${josh.data.id}`, { optional_plugin_dirs: 'tools/plugins/devtools' }, 'PATCH')).status, 200);
  assert.equal((await as('Josh', `/api/projects/${josh.data.id}`, { optional_plugin_dirs: 'tools/plugins/devtools' }, 'PATCH')).status, 200, 'unchanged is not a change');

  // Josh adds Olive: she sees it, but only its owner changes its settings or members.
  assert.equal((await as('Olive', `/api/projects/${josh.data.id}/members`, { person: people.Josh.id })).status, 404);
  assert.deepEqual((await as('Josh', `/api/projects/${josh.data.id}/members`, { person: people.Olive.id })).data.map((m: any) => m.name), ['Josh', 'Olive']);
  assert.deepEqual((await as('Olive', '/api/projects')).data.map((p: any) => p.name), ['Joshs']);
  assert.equal((await as('Olive', `/api/projects/${josh.data.id}`, { instructions: 'x' }, 'PATCH')).status, 403);
  assert.equal((await as('Josh', `/api/projects/${josh.data.id}`, { instructions: 'Be kind' }, 'PATCH')).status, 200);
  // Admin-only: People, the Citadel-wide instructions. Machines show each person their own (#306).
  assert.equal((await as('Josh', '/api/people', { name: 'Eve' })).status, 403);
  assert.deepEqual((await as('Josh', '/api/machines')).data, []);
  assert.equal((await as('Josh', '/api/app/instructions')).status, 403);
});

test('schema 17 leaves the server login to its owner, the first admin, once (#213)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-login-'));
  try {
    const path = join(dir, 'c.db');
    let store = new Store(path);
    const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
    const josh = store.createUser({ name: 'Josh', login: 'josh', server_login: true });
    const ann = store.createUser({ name: 'Ann', login: 'ann', admin: true, server_login: true });
    store.setSetting('schema_version', 16);
    store = new Store(path);
    assert.deepEqual([cara, josh, ann].map((u) => store.getUser(u.id)!.server_login), [1, 0, 0]);
    assert.equal(store.serverLoginOwner(), cara.id);
    // Only once: a later grant (by hand, in the DB) stays.
    store.updateUser(josh.id, { server_login: 1 });
    store = new Store(path);
    assert.equal(store.getUser(josh.id)!.server_login, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Josh's message waits until he links his own Claude; the server's login is Cara's alone (#213)", async () => {
  const p = (await as('Josh', '/api/projects')).data.find((x: any) => x.name === 'Joshs');
  const t = (await as('Josh', `/api/projects/${p.id}/tickets`, { message: 'build it', title: 'Build it' })).data;
  const notes = async () => (await as('Josh', `/api/tickets/${t.id}/events`)).data.events.filter((e: any) => e.kind === 'note').map((e: any) => JSON.parse(e.data).text);
  await until('the waiting note', async () => (await notes()).some((n: string) => /Turns for Josh start once/.test(n)));
  assert.notEqual((await as('Josh', `/api/tickets/${t.id}`)).data.ticket.status, 'running');

  assert.match((await notes()).find((n: string) => /Turns for Josh start once/.test(n)), /Settings → Your account/);
  const refused = await as('Cara', `/api/people/${people.Josh.id}`, { server_login: true }, 'PATCH');
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /Only the server login's owner/);
  const list = (await as('Cara', '/api/people')).data;
  assert.deepEqual(list.map((u: any) => [u.name, u.server_login, u.server_login_owner, u.claude]).filter(([n]: any) => n === 'Cara' || n === 'Josh'), [['Cara', true, true, null], ['Josh', false, false, null]]);
});

test("the stream doesn't carry other schemes' news; disabling someone ends theirs", async () => {
  const caras = (await as('Cara', '/api/projects')).data.find((x: any) => x.name === 'Caras');
  const ctl = new AbortController();
  const res = await fetch(`${srv.base}/api/stream`, { headers: { Cookie: people.Olive.cookie }, signal: ctl.signal });
  const reader = res.body!.getReader();
  let seen = '';
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      seen += new TextDecoder().decode(value);
    }
  })().catch(() => {});
  await until('hello', () => seen.includes('"hello"'));
  await as('Cara', `/api/projects/${caras.id}/tickets`, { message: 'secret plans', title: 'Secret' });
  const joshs = (await as('Josh', '/api/projects')).data.find((x: any) => x.name === 'Joshs');
  await as('Josh', `/api/projects/${joshs.id}/tickets`, { message: 'open plans', title: 'Open' });
  await until("Josh's scheme's news", () => seen.includes('open plans'));
  assert.ok(!seen.includes('secret plans'));
  // Disabled: the stream ends and the cookie stops working.
  await as('Cara', `/api/people/${people.Olive.id}`, { disabled: true }, 'PATCH');
  await reading;
  assert.equal((await as('Olive', '/api/projects')).status, 401);
  ctl.abort();
});

/** Read a person's live stream into a string until stopped. */
function listen(cookie: string) {
  const ctl = new AbortController();
  const out = { seen: '', stop: () => ctl.abort() };
  void fetch(`${srv.base}/api/stream`, { headers: { Cookie: cookie }, signal: ctl.signal }).then(async (res) => {
    const reader = res.body!.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      out.seen += new TextDecoder().decode(value);
    }
  }).catch(() => {});
  return out;
}

test("each person's meter shows their own plan: the stream's hello and usage news go to the payer alone (#219)", async () => {
  // Josh's plan's usage, as his container turns record it (src/runner.ts, usageKey).
  // The server is running and writes to this file too: wait out its write lock, as its own Store does
  // (src/db.ts), instead of failing at once with "database is locked" (#402).
  const db = new DatabaseSync(join(root, 'data', 'coordinator.db'), { timeout: 5000 });
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(`usage:user:${people.Josh.id}`, JSON.stringify({ weekly: { utilization: 0.22, resetsAt: null, status: 'allowed' }, session: null, updatedAt: 1 }));
  db.close();
  const cara = listen(people.Cara.cookie);
  const josh = listen(people.Josh.cookie);
  await until('both hellos', () => cara.seen.includes('"hello"') && josh.seen.includes('"hello"'));
  assert.match(josh.seen, /"hello".*"utilization":0\.22/);
  assert.doesNotMatch(cara.seen, /0\.22/);
  // A turn on the server login (Cara's): its usage goes to her meter, not Josh's.
  const caras = (await as('Cara', '/api/projects')).data.find((x: any) => x.name === 'Caras');
  await as('Cara', `/api/projects/${caras.id}/tickets`, { message: 'go', title: 'Meter' });
  await until("Cara's usage news", () => cara.seen.includes('"type":"usage"'));
  assert.match(cara.seen, /"type":"usage".*"utilization":0\.41/);
  assert.ok(!josh.seen.includes('"type":"usage"'));
  assert.equal((await as('Josh', '/api/me/claude')).data.usage.weekly.utilization, 0.22);
  assert.deepEqual((await as('Cara', '/api/people')).data.filter((u: any) => u.name === 'Cara' || u.name === 'Josh').map((u: any) => u.week?.utilization), [0.41, 0.22]);
  cara.stop();
  josh.stop();
});

test("Codex news goes to its own person, the server login's owner too, whose payer is the server's (#341)", async () => {
  const cara = listen(people.Cara.cookie);
  const josh = listen(people.Josh.cookie);
  await until('both hellos', () => cara.seen.includes('"hello"') && josh.seen.includes('"hello"'));
  assert.match(cara.seen, /"hello".*"codex":\{"ready":false/, 'the server login has a Codex to sign in to');
  await as('Cara', '/api/me/codex/switch', { on: false }, 'PUT');
  await until("Cara's Codex news", () => cara.seen.includes('"type":"codex"'));
  await as('Josh', '/api/me/codex/switch', { on: false }, 'PUT');
  await until("Josh's Codex news", () => josh.seen.includes('"type":"codex"'));
  assert.equal(cara.seen.split('"type":"codex"').length, 2, "Cara gets only her own");
  assert.equal(josh.seen.split('"type":"codex"').length, 2, "Josh gets only his own");
  cara.stop();
  josh.stop();
});
