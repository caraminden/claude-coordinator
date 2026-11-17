import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { bootServer, PASSWORD, SECRET, type Booted, stopTurns, testPins } from './helpers.ts';
testPins();

// Per-person Taskmasters (#919, Build 3): a scheme splits the first time a second member writes to its
// Taskmaster (Cara's R3, "From the second person"), the old row becomes the owner's (R2), a fresh Overlord
// takes the NULL row, a minion reports to its owner's Taskmaster and every other touched person's gets held mail.
const root = mkdtempSync(join(tmpdir(), 'tm-sessions-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});

const coordinator = (store: Store, projectId: number) => {
  const t = store.createTicket({ project_id: projectId, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Taskmaster' });
  store.setTicketDir(t.id, root, null);
  return store.getTicket(t.id)!;
};
const minion = (store: Store, projectId: number, props: Record<string, string> = {}) => {
  const t = store.createTicket({ project_id: projectId, title: 'Work', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  if (Object.keys(props).length) store.props.set('minion', t.id, projectId, props, 'Cara');
  return store.getTicket(t.id)!;
};

function people(file: string) {
  const store = new Store(join(root, file));
  const Cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const Josh = store.createUser({ name: 'Josh', login: 'josh' });
  const Rachel = store.createUser({ name: 'Rachel', login: 'rachel' });
  const Lee = store.createUser({ name: 'Lee', login: 'lee' });
  return { store, Cara, Josh, Rachel, Lee };
}

test('a one-person scheme keeps its one Taskmaster, which every lookup returns', () => {
  const { store, Cara, Josh } = people('solo.db');
  const p = store.createProject('Solo', null, Cara.id);
  const tm = coordinator(store, p.id);
  assert.equal(tm.coordinator_of, null);
  assert.equal(store.isSplit(p.id), false);
  for (const t of [store.getCoordinator(p.id), store.getOverlord(p.id), store.coordinatorFor(p.id, Cara.id), store.coordinatorFor(p.id, Josh.id), store.coordinatorFor(p.id, null)]) {
    assert.equal(t?.id, tm.id);
  }
  assert.deepEqual(store.listCoordinators(p.id).map((t) => t.id), [tm.id]);
});

test('the split: the old row becomes the owner\'s with its session, a fresh Overlord and the writer\'s, exactly once', () => {
  const { store, Cara, Josh, Rachel } = people('split.db');
  const p = store.createProject('Shared', null, Cara.id);
  const old = coordinator(store, p.id);
  store.updateTicket(old.id, { session_id: 'cara-session' });
  const before = store.listTickets(p.id).length;

  const josh = store.splitScheme(p.id, Josh.id);
  assert.equal(josh.coordinator_of, Josh.id);
  assert.equal(josh.kind, 'coordinator');
  assert.equal(josh.cwd, old.cwd);
  assert.equal(store.listTickets(p.id).length, before + 2, 'the split makes exactly two rows');
  const owner = store.getTicket(old.id)!;
  assert.equal(owner.coordinator_of, Cara.id, "today's Taskmaster becomes the owner's (R2)");
  assert.equal(owner.session_id, 'cara-session');
  const overlord = store.getOverlord(p.id)!;
  assert.notEqual(overlord.id, old.id);
  assert.equal(overlord.coordinator_of, null);
  assert.equal(overlord.session_id, null, 'the Overlord starts fresh');
  assert.equal(store.isSplit(p.id), true);

  // Again for Josh: nothing new. A third member: one row.
  assert.equal(store.splitScheme(p.id, Josh.id).id, josh.id);
  assert.equal(store.listTickets(p.id).length, before + 2);
  const rachel = store.splitScheme(p.id, Rachel.id);
  assert.equal(store.listTickets(p.id).length, before + 3);

  assert.equal(store.getCoordinator(p.id)!.id, old.id, 'getCoordinator stays the owner\'s (backup.ts)');
  assert.equal(store.coordinatorFor(p.id, Josh.id)!.id, josh.id);
  assert.equal(store.coordinatorFor(p.id, Rachel.id)!.id, rachel.id);
  assert.equal(store.coordinatorFor(p.id, 9999)!.id, overlord.id, 'no Taskmaster of their own: the Overlord');
  assert.deepEqual(store.listCoordinators(p.id).map((t) => t.id), [old.id, overlord.id, josh.id, rachel.id]);
  // The index still keeps one per person and one Overlord.
  assert.throws(() => store.db.prepare("INSERT INTO tickets (project_id, kind, title, status, cwd, permission_mode, created_by, created_at, updated_at, coordinator_of) VALUES (?, 'coordinator', 'x', 'new', '', 'default', 'x', 0, 0, ?)").run(p.id, Josh.id));
  assert.throws(() => store.db.prepare("INSERT INTO tickets (project_id, kind, title, status, cwd, permission_mode, created_by, created_at, updated_at, coordinator_of) VALUES (?, 'coordinator', 'x', 'new', '', 'default', 'x', 0, 0, NULL)").run(p.id));
});

test('a database with the old one-per-scheme index gets the per-person one, and no row changes', () => {
  const file = join(root, 'old-index.db');
  const { store, Cara } = (() => {
    const s = new Store(file);
    return { store: s, Cara: s.createUser({ name: 'Cara', login: 'cara', admin: true }) };
  })();
  const p = store.createProject('Old', null, Cara.id);
  const tm = coordinator(store, p.id);
  store.db.exec("DROP INDEX one_coordinator; CREATE UNIQUE INDEX one_coordinator ON tickets(project_id) WHERE kind = 'coordinator'");
  store.db.close();
  const raw = new DatabaseSync(file);
  const rowsBefore = raw.prepare('SELECT * FROM tickets ORDER BY id').all();
  raw.close();
  const again = new Store(file);
  assert.deepEqual(again.db.prepare('SELECT * FROM tickets ORDER BY id').all(), rowsBefore, 'the migration changes no row (R3)');
  assert.match(String((again.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'one_coordinator'").get() as any).sql), /coordinator_of/);
  const josh = again.createUser({ name: 'Josh', login: 'josh' });
  again.splitScheme(p.id, josh.id);
  assert.equal(again.listCoordinators(p.id).length, 3);
  assert.equal(again.getCoordinator(p.id)!.id, tm.id);
});

test("a minion's owner: assigned, else requestedBy, else nobody; its touched set only grows until someone leaves", () => {
  const { store, Cara, Josh, Rachel, Lee } = people('owner.db');
  const p = store.createProject('Shared', null, Cara.id);
  coordinator(store, p.id);
  const assigned = minion(store, p.id, { requestedBy: 'Cara', assigned: 'Josh' });
  const requested = minion(store, p.id, { requestedBy: 'Rachel' });
  const nobody = minion(store, p.id);
  assert.equal(store.minionOwner(assigned), Josh.id);
  assert.equal(store.minionOwner(requested), Rachel.id);
  assert.equal(store.minionOwner(nobody), null);

  const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);
  assert.deepEqual(sorted(store.touchedBy(assigned)), sorted([Cara.id, Josh.id]));
  store.touch(assigned.id, Lee.id);
  assert.deepEqual(sorted(store.touchedBy(assigned)), sorted([Cara.id, Josh.id, Lee.id]));
  // A handover keeps the old owner touched once it was recorded.
  store.touch(assigned.id, Josh.id);
  store.props.set('minion', assigned.id, p.id, { assigned: 'Rachel' }, 'Cara');
  assert.deepEqual(sorted(store.touchedBy(assigned)), sorted([Cara.id, Josh.id, Lee.id, Rachel.id]));
  // Leaving takes a person out, the requester included; touching again rejoins.
  store.leaveTouched(assigned.id, Cara.id);
  store.leaveTouched(assigned.id, Lee.id);
  assert.deepEqual(sorted(store.touchedBy(assigned)), sorted([Josh.id, Rachel.id]));
  store.touch(assigned.id, Lee.id);
  assert.deepEqual(sorted(store.touchedBy(assigned)), sorted([Josh.id, Lee.id, Rachel.id]));

  // The Taskmaster each reports to: its owner's own, else the Overlord.
  const josh = store.splitScheme(p.id, Josh.id);
  const assignedJosh = minion(store, p.id, { assigned: 'Josh' });
  assert.equal(store.ownerCoordinator(assignedJosh)!.id, josh.id);
  assert.equal(store.ownerCoordinator(requested)!.id, store.getOverlord(p.id)!.id, 'Rachel has no Taskmaster here yet');
  assert.equal(store.ownerCoordinator(nobody)!.id, store.getOverlord(p.id)!.id);
});

test('the digest: up to ten lines other Taskmasters logged since this one last read, never its own', () => {
  const { store, Cara, Josh } = people('digest.db');
  const p = store.createProject('Shared', null, Cara.id);
  const cara = coordinator(store, p.id);
  const josh = store.splitScheme(p.id, Josh.id);
  const other = store.createProject('Other', null, Cara.id);
  const elsewhere = coordinator(store, other.id);
  assert.deepEqual(store.digestFor(cara.id), []);
  store.noteDigest(p.id, josh.id, "Josh's Taskmaster started #4 Lairs");
  store.noteDigest(p.id, cara.id, 'Cara\'s own line');
  store.noteDigest(other.id, elsewhere.id, 'another scheme');
  assert.deepEqual(store.digestFor(cara.id), ["Josh's Taskmaster started #4 Lairs"]);
  assert.deepEqual(store.digestFor(cara.id), [], 'read once');
  assert.deepEqual(store.digestFor(josh.id), ["Cara's own line"]);
  for (let i = 0; i < 14; i++) store.noteDigest(p.id, josh.id, `line ${i}`);
  const ten = store.digestFor(cara.id);
  assert.equal(ten.length, 10);
  assert.equal(ten.at(-1), 'line 13', 'the newest ten, oldest first');
});

test("a personal Taskmaster's turns run for its person; a card answer from someone else runs on theirs (R5)", () => {
  const { store, Cara, Josh } = people('turn-person.db');
  const p = store.createProject('Shared', null, Cara.id);
  coordinator(store, p.id);
  const josh = store.splitScheme(p.id, Josh.id);
  const runner = new Runner(store, () => {}, () => ({}), '/bin/false');
  runner.personOf = (author) => store.findUser('name', author)?.id ?? null;
  const turnPerson = (t: any, batch: any[]) => (runner as any).turnPerson(t, store.getProject(p.id), batch);
  assert.equal(turnPerson(josh, []), Josh.id);
  assert.equal(turnPerson(josh, [{ author: 'Cara', text: 'hi', images: [], typed: true, own: true }]), Josh.id, "someone else's words are content");
  assert.equal(turnPerson(josh, [{ author: '#4 Work', text: 'done', images: [], from: 12 }]), Josh.id);
  assert.equal(turnPerson(josh, [{ author: 'Cara', text: 'My answers', images: [], own: true }]), Cara.id);
});

// Through the server: a person's message, message_coordinator, a handover and message_taskmaster.
describeServer();

function describeServer() {
  const dir = join(root, 'server');
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const store = new Store(join(data, 'coordinator.db'));
  const Cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const Josh = store.createUser({ name: 'Josh', login: 'josh' });
  const Rachel = store.createUser({ name: 'Rachel', login: 'rachel' });
  const Shared = store.createProject('Shared', null, Cara.id);
  const Solo = store.createProject('Solo', null, Cara.id);
  const Delve = store.createProject('Delve', null, Cara.id);
  for (const u of [Josh, Rachel]) store.addMember(Shared.id, u.id);
  store.addMember(Delve.id, Josh.id);
  const sharedTm = coordinator(store, Shared.id);
  const soloTm = coordinator(store, Solo.id);
  const delveTm = coordinator(store, Delve.id);
  const work = minion(store, Shared.id, { requestedBy: 'Cara', assigned: 'Cara' });
  const soloWork = minion(store, Solo.id, { requestedBy: 'Cara', assigned: 'Cara' });
  store.db.close();

  const tokens = new Auth(PASSWORD, SECRET);
  const cookies = (u: { id: number; name: string }) => tokens.issueCookie(u, false).split(';')[0];
  let srv: Booted;
  let db: Store;
  before(async () => {
    srv = await bootServer({ root: dir });
    db = new Store(join(data, 'coordinator.db'));
  });
  after(async () => {
    await srv?.stop();
  });
  const post = async (path: string, body: object, auth: { cookie?: string; bearer?: string }) => {
    const res = await fetch(srv.base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth.cookie ? { Cookie: auth.cookie } : {}), ...(auth.bearer ? { Authorization: `Bearer ${auth.bearer}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) as any };
  };
  const said = (ticketId: number, text: string) => db.listEvents(ticketId).filter((e) => e.kind === 'user_message').map((e) => JSON.parse(e.data)).find((m) => String(m.text).includes(text));

  test("a second member's first message splits the scheme and lands in their own Taskmaster", async () => {
    const r = await post(`/api/tickets/${sharedTm.id}/messages`, { text: 'hello from Josh', after: true }, { cookie: cookies(Josh) });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    const josh = db.coordinatorFor(Shared.id, Josh.id)!;
    assert.equal(josh.coordinator_of, Josh.id);
    assert.equal(r.data.id, josh.id, 'the reply is the Taskmaster it went to');
    assert.ok(said(josh.id, 'hello from Josh'));
    assert.equal(said(sharedTm.id, 'hello from Josh'), undefined);
    assert.equal(db.getTicket(sharedTm.id)!.coordinator_of, Cara.id);
    assert.equal(db.listCoordinators(Shared.id).length, 3);
    // Cara writing into Josh's goes to her own (R5); anyone can write to the Overlord.
    await post(`/api/tickets/${josh.id}/messages`, { text: 'Cara into Josh', after: true }, { cookie: cookies(Cara) });
    assert.ok(said(sharedTm.id, 'Cara into Josh'));
    const overlord = db.getOverlord(Shared.id)!;
    await post(`/api/tickets/${overlord.id}/messages`, { text: 'for the Overlord', after: true }, { cookie: cookies(Josh) });
    assert.ok(said(overlord.id, 'for the Overlord'));
  });

  test('in a one-person scheme a message to the Taskmaster changes nothing', async () => {
    await post(`/api/tickets/${soloTm.id}/messages`, { text: 'solo hello', after: true }, { cookie: cookies(Cara) });
    assert.ok(said(soloTm.id, 'solo hello'));
    assert.equal(db.listCoordinators(Solo.id).length, 1);
    assert.equal(db.getTicket(soloTm.id)!.coordinator_of, null);
    const r = await post(`/api/tickets/${soloWork.id}/coordinator`, { text: 'solo report', need: 'ask' }, { bearer: tokens.agentToken(soloWork.id) });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    assert.ok(said(soloTm.id, 'solo report'));
  });

  test("message_coordinator reaches the owner's Taskmaster; every other touched person's gets held mail", async () => {
    // Josh touches the minion by writing in its chat; Rachel never does.
    await post(`/api/tickets/${work.id}/messages`, { text: 'Josh chimes in', after: true }, { cookie: cookies(Josh) });
    assert.ok(db.touchedBy(db.getTicket(work.id)!).includes(Josh.id));
    const rachel = (await post(`/api/tickets/${sharedTm.id}/messages`, { text: 'Rachel here', after: true }, { cookie: cookies(Rachel) }), db.coordinatorFor(Shared.id, Rachel.id)!);
    const r = await post(`/api/tickets/${work.id}/coordinator`, { text: 'status: tests green', need: 'ask' }, { bearer: tokens.agentToken(work.id) });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    const josh = db.coordinatorFor(Shared.id, Josh.id)!;
    const toOwner = said(sharedTm.id, 'status: tests green');
    assert.ok(toOwner, "the owner's Taskmaster gets it");
    const toJosh = said(josh.id, 'status: tests green');
    assert.ok(toJosh, "Josh's Taskmaster gets it too");
    assert.equal(toJosh.mail, true, 'as held mail');
    assert.equal(said(rachel.id, 'status: tests green'), undefined, 'Rachel never touched it');
    assert.equal(said(db.getOverlord(Shared.id)!.id, 'status: tests green'), undefined);
  });

  test('handing a minion over leaves a held-mail line in both owners\' Taskmasters, and its reports follow', async () => {
    const res = await fetch(`${srv.base}/api/tickets/${work.id}/properties`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookies(Cara) }, body: JSON.stringify({ properties: { assigned: 'Josh' } }),
    });
    assert.equal(res.status, 200, await res.text());
    const josh = db.coordinatorFor(Shared.id, Josh.id)!;
    const line = (id: number) => db.listEvents(id).map((e) => JSON.parse(e.data)).find((d) => d.mail && /handed #\d+ to Josh/.test(String(d.text)));
    assert.ok(line(sharedTm.id), "Cara's Taskmaster gets the handover line");
    assert.ok(line(josh.id), "Josh's Taskmaster gets the handover line");
    await post(`/api/tickets/${work.id}/coordinator`, { text: 'after handover', need: 'ask' }, { bearer: tokens.agentToken(work.id) });
    assert.notEqual(said(josh.id, 'after handover')?.mail, true, "the new owner's is the one it reports to");
    assert.equal(said(sharedTm.id, 'after handover')?.mail, true, 'Cara stays touched, so held mail');
  });

  test("a Taskmaster's message to a minion: the minion's next report answers it, once; leaving stops the held mail", async () => {
    const rachel = db.coordinatorFor(Shared.id, Rachel.id)!;
    const josh = db.coordinatorFor(Shared.id, Josh.id)!;
    let r = await post(`/api/tickets/${work.id}/messages`, { text: 'Rachel asks: status?' }, { bearer: tokens.agentToken(rachel.id) });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    assert.ok(db.touchedBy(db.getTicket(work.id)!).includes(Rachel.id), "the asking Taskmaster's person touches it");
    await post(`/api/tickets/${work.id}/coordinator`, { text: 'answer for Rachel', need: 'ask' }, { bearer: tokens.agentToken(work.id) });
    assert.notEqual(said(rachel.id, 'answer for Rachel')?.mail, true, 'it wakes the one that asked');
    assert.equal(said(josh.id, 'answer for Rachel')?.mail, true, 'the owner hears it as held mail');
    await post(`/api/tickets/${work.id}/coordinator`, { text: 'next report', need: 'ask' }, { bearer: tokens.agentToken(work.id) });
    assert.notEqual(said(josh.id, 'next report')?.mail, true, 'back to the owner');
    assert.equal(said(rachel.id, 'next report')?.mail, true);
    r = await post(`/api/tickets/${work.id}/leave`, {}, { cookie: cookies(Rachel) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await post(`/api/tickets/${work.id}/coordinator`, { text: 'after Rachel left', need: 'ask' }, { bearer: tokens.agentToken(work.id) });
    assert.equal(said(rachel.id, 'after Rachel left'), undefined);
  });

  test('message_taskmaster "for" a member reaches theirs, else the Overlord; with no one, the sender\'s person', async () => {
    const josh = db.coordinatorFor(Shared.id, Josh.id)!;
    const overlord = db.getOverlord(Shared.id)!;
    let r = await post('/api/taskmaster', { scheme: 'Shared', text: 'for josh only', need: 'fyi', person: 'Josh' }, { bearer: tokens.agentToken(delveTm.id) });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    assert.ok(said(josh.id, 'for josh only'));
    r = await post('/api/taskmaster', { scheme: 'Shared', text: 'for a stranger', need: 'fyi', person: 'Nobody' }, { bearer: tokens.agentToken(delveTm.id) });
    assert.equal(r.status, 400, 'a name that is no one is refused');
    // Delve's only Taskmaster last ran for nobody: the Overlord.
    r = await post('/api/taskmaster', { scheme: 'Shared', text: 'for no one in particular', need: 'fyi' }, { bearer: tokens.agentToken(delveTm.id) });
    assert.ok(said(overlord.id, 'for no one in particular'));
    // Josh's Taskmaster writes to Delve (unsplit): its only one. Delve's reply goes back to the one that wrote.
    await post('/api/taskmaster', { scheme: 'Delve', text: 'from josh', need: 'fyi' }, { bearer: tokens.agentToken(josh.id) });
    assert.ok(said(delveTm.id, 'from josh'));
    await post('/api/taskmaster', { scheme: 'Shared', text: 'reply to josh', need: 'fyi' }, { bearer: tokens.agentToken(delveTm.id) });
    assert.ok(said(josh.id, 'reply to josh'), 'a reply returns to the Taskmaster that sent');
  });
}
