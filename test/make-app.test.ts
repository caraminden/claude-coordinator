import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { freeAppPort, schemeRunner } from '../src/make-app.ts';
import { bootServer, PASSWORD, REPO, SECRET, type Booted } from './helpers.ts';

// make_app (#1136): a scheme's Taskmaster, on a member's turn, makes an app in a folder of its own repo, with a
// minion whose branch holds the generated app, registered and on for the scheme's members.
const root = mkdtempSync(join(tmpdir(), 'make-app-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
function repo(name: string, runner?: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), name);
  if (runner) writeFileSync(join(dir, '.github', 'workflows', 'tests.yml'), `jobs:\n  t:\n    runs-on: [self-hosted, ${runner}]\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'start');
  return dir;
}

const store = new Store(join(data, 'coordinator.db'));
const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
const josh = store.createUser({ name: 'Josh', login: 'josh' });
const olive = store.createUser({ name: 'Olive', login: 'olive' });
const Trips = store.createProject('Trips', 'https://github.com/o/trips.git', josh.id);
store.setProjectRepoDir(Trips.id, repo('trips', 'trips-ci'));
store.addMember(Trips.id, cara.id);
const Plain = store.createProject('Plain', 'https://github.com/o/plain', cara.id);
store.setProjectRepoDir(Plain.id, repo('plain'));
const Local = store.createProject('Local', null, cara.id);
store.setProjectRepoDir(Local.id, repo('local'));
const tm = (p: { id: number }, person: number) => {
  const t = store.createTicket({ project_id: p.id, kind: 'coordinator', title: 'TM', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(t.id, { person_id: person });
  return t;
};
const TripsTM = tm(Trips, josh.id);
const PlainTM = tm(Plain, cara.id);
const LocalTM = tm(Local, cara.id);
store.db.close();

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});
after(async () => {
  await srv?.stop();
  rmSync(root, { recursive: true, force: true });
});

async function tool(t: { id: number; project_id: number }, name: string, args: object): Promise<{ isError: boolean; text: string }> {
  const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: { ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: tokens.agentToken(t.id), COORDINATOR_PROJECT: String(t.project_id), COORDINATOR_TICKET: String(t.id), COORDINATOR_ROLE: 'coordinator' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const reply = new Promise<any>((ok) => createInterface({ input: child.stdout }).once('line', (l) => ok(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const r = (await reply).result;
    return { isError: !!r.isError, text: r.content[0].text };
  } finally {
    child.kill();
  }
}
const db = () => new Store(join(srv.data, 'coordinator.db'));
/** Trips' Taskmaster on a turn for `person`. */
async function turnFor<T>(person: number, work: () => Promise<T>): Promise<T> {
  const set = (id: number) => { const s = db(); try { s.updateTicket(TripsTM.id, { person_id: id }); } finally { s.db.close(); } };
  set(person);
  try { return await work(); } finally { set(josh.id); }
}

test('make_app: one call starts a minion whose branch holds the app, registers it in its folder and turns it on for the members', async () => {
  const r = await tool(TripsTM, 'make_app', { name: 'trip-notes', title: 'Trip Notes', idea: 'Notes for each trip,\nshared with the group.' });
  assert.equal(r.isError, false, r.text);
  const n = Number(/#(\d+) ships it/.exec(r.text)?.[1]);
  assert.ok(n, r.text);
  assert.match(r.text, /its CI workflow included/);
  const s = db();
  try {
    const c = s.getContraption('trip-notes')!;
    assert.equal(c.home_scheme, Trips.id);
    assert.deepEqual([c.repo, c.branch, c.subdir, c.folder, c.title], ['o/trips', null, 'apps/trip-notes', null, 'Trip Notes']);
    assert.ok(c.port >= 7350 && c.port <= 7999, String(c.port));
    assert.ok(existsSync(join(srv.data, 'contraptions', 'trip-notes', 'identity.pub')), 'its keys are written');
    assert.deepEqual(s.contraptionUsers(c.id).sort(), [cara.id, josh.id].sort(), 'on for the owner and the members, no one else');
    const m = s.listTickets(Trips.id).find((t) => t.number === n)!;
    assert.equal(m.title, 'New app: Trip Notes');
    assert.equal(s.props.forTarget('minion', m.id).assigned, 'Josh');
    // Its branch's first commit is the app, and the brief carries the idea in the asker's words.
    assert.match(git(m.cwd!, 'log', '-1', '--format=%an %s'), /^Citadel New app trip-notes/);
    const files = git(m.cwd!, 'show', '--name-only', '--format=', 'HEAD').split('\n');
    assert.ok(files.includes('apps/trip-notes/server.ts') && files.includes('.github/workflows/app-trip-notes.yml'), files.join(' '));
    assert.equal(git(m.cwd!, 'status', '--porcelain'), '', 'nothing left uncommitted');
    assert.match(readFileSync(join(m.cwd!, '.github/workflows/app-trip-notes.yml'), 'utf8'), /trips-ci/);
    const brief = s.listEvents(m.id).map((e) => e.data).join('\n');
    assert.match(brief, /> shared with the group\./);
  } finally {
    s.db.close();
  }
  // Taken now: the name, and its folder.
  const again = await tool(TripsTM, 'make_app', { name: 'trip-notes', title: 'Again', idea: 'x' });
  assert.ok(again.isError && /already an app called trip-notes/.test(again.text), again.text);
});

test('make_app refuses a turn for someone outside the scheme, a bad name or title, and a scheme with no GitHub repo; no runner, no workflow', async () => {
  const outsider = await turnFor(olive.id, () => tool(TripsTM, 'make_app', { name: 'olives', title: 'Olives', idea: 'x' }));
  assert.ok(outsider.isError && /member of Trips/.test(outsider.text), outsider.text);
  for (const [args, says] of [[{ name: 'Bad Name', title: 'T', idea: 'x' }, /short slug/], [{ name: 'relay', title: 'T', idea: 'x' }, /short slug/], [{ name: 'ok', title: '<b>', idea: 'x' }, /title/], [{ name: 'ok', title: 'T', idea: '' }, /idea/]] as const) {
    const r = await tool(TripsTM, 'make_app', args);
    assert.ok(r.isError && says.test(r.text), r.text);
  }
  const local = await tool(LocalTM, 'make_app', { name: 'local-app', title: 'Local', idea: 'x' });
  assert.ok(local.isError && /no GitHub repo/.test(local.text), local.text);
  const plain = await tool(PlainTM, 'make_app', { name: 'plain-app', title: 'Plain', idea: 'x' });
  assert.match(plain.text, /no CI workflow/);
  const s = db();
  try {
    assert.equal(s.getContraption('olives'), undefined);
    assert.equal(s.getContraption('local-app'), undefined);
    assert.equal(s.listTickets(Local.id).filter((t) => t.kind === 'ticket').length, 0, 'a refusal leaves no minion behind');
  } finally {
    s.db.close();
  }
});

test("set_app_person: a scheme's Taskmaster switches its own apps for a person, on a member's turn, and no one else's", async () => {
  await tool(TripsTM, 'make_app', { name: 'packing', title: 'Packing', idea: 'Who brings what.' });
  const on = await tool(TripsTM, 'set_app_person', { name: 'packing', login: 'olive', enabled: true });
  assert.equal(on.isError, false, on.text);
  assert.match(on.text, /olive/);
  const off = await tool(TripsTM, 'set_app_person', { name: 'packing', login: 'cara', enabled: false });
  assert.ok(!/cara/.test(off.text.split('on for:')[1]), off.text);
  const other = await tool(PlainTM, 'set_app_person', { name: 'packing', login: 'cara', enabled: true });
  assert.ok(other.isError && /isn't one of Plain's apps/.test(other.text), other.text);
  const outsider = await turnFor(olive.id, () => tool(TripsTM, 'set_app_person', { name: 'packing', login: 'olive', enabled: false }));
  assert.ok(outsider.isError && /member of Trips/.test(outsider.text), outsider.text);
});

test('freeAppPort skips taken and listening ports; schemeRunner reads the label its workflows use', async () => {
  // Both ports come from the OS (#1225): a port next to a busy one may be held by a parallel suite, so the free one
  // is one this test bound and let go of. The lower is kept listening; every other port in the range is `taken`.
  const listen = async () => {
    const s = createServer().listen(0, '127.0.0.1');
    await new Promise((ok) => s.once('listening', ok));
    return s;
  };
  const pair = [await listen(), await listen()].sort((a, b) => (a.address() as { port: number }).port - (b.address() as { port: number }).port);
  const [busy, freed] = pair;
  const [at, free] = pair.map((s) => (s.address() as { port: number }).port);
  await new Promise((ok) => freed.close(ok));
  const taken = new Set([at - 1]);
  for (let p = at + 1; p < free; p++) taken.add(p);
  try {
    assert.equal(await freeAppPort(taken, [at - 1, free]), free);
  } finally {
    busy.close();
  }
  assert.equal(schemeRunner({ name: 'Trips' }, join(root, 'trips')), 'trips-ci');
  assert.equal(schemeRunner({ name: 'Plain' }, join(root, 'plain')), null);
});

// adopt_app (#1624): an app already on the scheme's main branch, registered and deployed with no minion and no new files.
const MANIFEST_JSON = JSON.stringify({ start: ['node', 'server.ts'], health: '/health' });
const commit = (dir: string, file: string, text: string) => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', `add ${file}`);
};

test('adopt_app: registers an app at the repo root or in a folder, on for the members, with no minion, and reports its deploy', async () => {
  commit(join(root, 'trips'), 'apps/old-trips/citadel-app.json', JSON.stringify({ start: ['node', 'server.ts'] }));
  commit(join(root, 'trips'), 'apps/old-trips/public/icon.svg', '<svg/>');
  commit(join(root, 'plain'), 'docs/icon.svg', '<svg/>'); // not where an app serves one: no icon
  commit(join(root, 'plain'), 'citadel-app.json', MANIFEST_JSON);
  const s0 = db();
  const before = s0.listTickets(Trips.id).length;
  s0.db.close();
  const r = await tool(TripsTM, 'adopt_app', { name: 'old-trips', title: 'Old Trips', folder: 'apps/old-trips/' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Adopted old-trips: registered on port \d+, deployed from apps\/old-trips/);
  assert.match(r.text, /It did not deploy: Only the live Citadel manages app services[^]*stays registered/);
  const root1 = await tool(PlainTM, 'adopt_app', { name: 'whole-repo', title: 'Whole Repo', folder: '.', repo: 'o/plain' });
  assert.equal(root1.isError, false, root1.text);
  const s = db();
  try {
    const c = s.getContraption('old-trips')!;
    assert.deepEqual([c.repo, c.branch, c.subdir, c.folder, c.icon, c.home_scheme], ['o/trips', null, 'apps/old-trips', null, '/icon.svg', Trips.id]);
    assert.ok(c.port >= 7350 && c.port <= 7999, String(c.port));
    assert.deepEqual(s.contraptionUsers(c.id).sort(), [cara.id, josh.id].sort());
    const w = s.getContraption('whole-repo')!;
    assert.deepEqual([w.subdir, w.icon, w.home_scheme, w.repo], [null, '', Plain.id, 'o/plain']);
    assert.notEqual(w.port, c.port);
    assert.equal(s.listTickets(Trips.id).length, before, 'adopting starts no minion');
  } finally {
    s.db.close();
  }
});

test('adopt_app refuses a non-member turn, a taken name, no manifest on main, another repo, a bad folder and a scheme with no repo', async () => {
  const refused = async (t: { id: number; project_id: number }, args: object, says: RegExp) => {
    const r = await tool(t, 'adopt_app', args);
    assert.ok(r.isError && says.test(r.text), r.text);
  };
  const outsider = await turnFor(olive.id, () => tool(TripsTM, 'adopt_app', { name: 'olives', title: 'Olives', folder: 'apps/old-trips' }));
  assert.ok(outsider.isError && /member of Trips/.test(outsider.text), outsider.text);
  await refused(TripsTM, { name: 'old-trips', title: 'Again', folder: 'apps/old-trips' }, /already an app called old-trips/);
  await refused(TripsTM, { name: 'packing', title: 'Again', folder: 'apps/old-trips' }, /already an app called packing/);
  await refused(TripsTM, { name: 'nothing-here', title: 'Nothing', folder: 'apps/nothing' }, /No apps\/nothing\/citadel-app\.json on main/);
  await refused(TripsTM, { name: 'no-root', title: 'No Root', folder: '' }, /No citadel-app\.json on main/);
  await refused(TripsTM, { name: 'elsewhere', title: 'Elsewhere', folder: 'apps/old-trips', repo: 'o/other' }, /isn't Trips's repo/);
  await refused(TripsTM, { name: 'escape', title: 'Escape', folder: '../trips/apps/old-trips' }, /inside the repo/);
  await refused(TripsTM, { name: 'Bad Name', title: 'T', folder: '' }, /short slug/);
  await refused(LocalTM, { name: 'local-adopt', title: 'Local', folder: '' }, /no GitHub repo/);
  // On another branch only: not on main.
  const dir = join(root, 'trips');
  git(dir, 'checkout', '-qb', 'side');
  commit(dir, 'apps/side-only/citadel-app.json', MANIFEST_JSON);
  git(dir, 'checkout', '-q', 'main');
  await refused(TripsTM, { name: 'side-only', title: 'Side', folder: 'apps/side-only' }, /No apps\/side-only\/citadel-app\.json on main/);
  const s = db();
  try {
    for (const n of ['olives', 'nothing-here', 'no-root', 'elsewhere', 'escape', 'local-adopt', 'side-only']) assert.equal(s.getContraption(n), undefined, n);
  } finally {
    s.db.close();
  }
});
