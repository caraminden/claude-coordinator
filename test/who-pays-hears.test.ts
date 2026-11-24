// Which person a turn runs for and who hears a minion, worked out the same way everywhere (#1449, the seam review's
// P1 and P3): a contraption's ask runs on its asker's login, and a minion whose assignee left the scheme or was
// disabled is its scheme owner's, for push, the Needs-you list and the Taskmaster it reports to alike.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { messagePerson, turnPayer, turnRefusal } from '../src/access.ts';
import { Approvals } from '../src/approvals.ts';
import { replyToKey, tellTaskmaster } from '../src/ci-armed.ts';
import { Store, type Ticket } from '../src/db.ts';
import { inboxItems } from '../src/inbox.ts';
import { loadVapidKeys, Pusher } from '../src/push.ts';

const root = mkdtempSync(join(tmpdir(), 'who-pays-hears-'));
after(() => rmSync(root, { recursive: true, force: true }));

function world() {
  const store = new Store(':memory:');
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const olive = store.createUser({ name: 'Olive', login: 'olive' });
  const dana = store.createUser({ name: 'Dana', login: 'dana' });
  const scheme = store.createProject('Lanterns', null, cara.id);
  for (const u of [josh, olive]) store.addMember(scheme.id, u.id);
  return { store, cara, josh, olive, dana, scheme };
}

const askFrom = (who: { id: number; name: string }, member = true) => ({ author: `Contraption Peek, for ${who.name}, ${member ? 'a' : 'not a'} Lanterns member`, asker: who.id });

test("a contraption's ask to the Taskmaster runs on its asker's login, not the Taskmaster's last person's (P1)", () => {
  const { store, cara, josh, olive, dana, scheme } = world();
  const personOf = messagePerson(store);
  const tm = store.createTicket({ project_id: scheme.id, title: 'Coordinator', permission_mode: 'default', created_by: 'Cara', kind: 'coordinator' });
  store.updateTicket(tm.id, { person_id: olive.id });
  const project = store.getProject(scheme.id)!;
  // Not split: the one Taskmaster last ran for Olive.
  assert.equal(turnPayer(store, store.getTicket(tm.id)!, project, [askFrom(josh)], personOf), josh.id, 'a member pays for their own ask');
  // A non-member's ask runs on the owner's, as a non-member's relay does (#255), never on the last person's.
  assert.equal(turnPayer(store, store.getTicket(tm.id)!, project, [askFrom(dana, false)], personOf), cara.id);
  // The refusal checks the same person: Josh, who hasn't linked Claude, not Olive, who has.
  const linked = (uid: number) => (uid === olive.id ? ('linked' as const) : null);
  assert.match(turnRefusal(store, store.getTicket(tm.id)!, askFrom(josh).author, linked, undefined, josh.id) ?? '', /^Turns for Josh start once/);
  // Split, and Josh has no Taskmaster of his own: the Overlord takes his ask, on his login, not the owner's.
  store.splitScheme(scheme.id, olive.id);
  const overlord = store.getOverlord(scheme.id)!;
  assert.equal(turnPayer(store, overlord, project, [askFrom(josh)], personOf), josh.id);
  // His own Taskmaster, once he has one, runs it on his.
  const own = store.splitScheme(scheme.id, josh.id);
  assert.equal(turnPayer(store, own, project, [askFrom(josh)], personOf), josh.id);
  // A message with no person and no asker (GitHub, a Mandate hook) still falls to the Taskmaster's person.
  assert.equal(turnPayer(store, store.getTicket(tm.id)!, project, [{ author: 'GitHub', asker: null }], personOf), cara.id, "the old row is Cara's own since the split");
});

/** A minion assigned to `who`, with an open card. */
function assignedMinion(store: Store, projectId: number, who: string, title = 'Lantern rig') {
  const t = store.createTicket({ project_id: projectId, title, permission_mode: 'default', created_by: 'Cara' });
  store.props.set('minion', t.id, projectId, { assigned: who }, 'Cara');
  store.addEvent(t.id, 'question', { id: `q-${t.id}`, questions: [] });
  return store.getTicket(t.id)!;
}

test("a minion whose assignee left the scheme, or was disabled, is its owner's for push, Needs-you and its Taskmaster alike (P3)", async () => {
  const store = new Store(join(root, 'p3.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const olive = store.createUser({ name: 'Olive', login: 'olive' });
  const p = store.createProject('Lanterns', null, cara.id).id;
  for (const u of [josh, olive]) store.addMember(p, u.id);
  const approvals = new Approvals(() => {});
  const sent: string[] = [];
  const fakeFetch = (async (url: string) => (sent.push(url), new Response('', { status: 201 }))) as unknown as typeof fetch;
  const pusher = new Pusher(store, loadVapidKeys(root), fakeFetch);
  for (const name of ['Cara', 'Josh', 'Olive']) store.savePushSubscription(name, `https://push.example/${name}`, 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg');
  const pinged = async (t: Ticket) => {
    sent.length = 0;
    await pusher.notify(t, { kind: 'question', questions: [{ question: 'Which wick?' }] });
    return sent.map((u) => u.split('/').pop()).sort();
  };
  const told = async (t: Ticket) => {
    const out = { to: 0, mail: [] as number[] };
    const runner = { relay: (_f: number, to: number) => ((out.to = to), false), leaveMail: (to: number) => out.mail.push(to), emit: () => {} };
    await tellTaskmaster({ store, runner } as never, t, 'Done', false);
    return out;
  };
  const needsYou = (t: Ticket) => ['Cara', 'Josh', 'Olive'].filter((name) => inboxItems(store, approvals, p, name).some((i) => i.ticketId === t.id && i.kind === 'question'));
  // Josh has his own Taskmaster (the scheme is split), so his minion reports to it.
  store.createTicket({ project_id: p, title: 'Coordinator', permission_mode: 'default', created_by: 'Cara', kind: 'coordinator' });
  store.splitScheme(p, josh.id);
  const joshTm = store.coordinatorFor(p, josh.id)!;
  const caraTm = store.coordinatorFor(p, cara.id)!;
  assert.equal(joshTm.coordinator_of, josh.id);
  assert.equal(caraTm.coordinator_of, cara.id);

  const t = assignedMinion(store, p, 'Josh');
  assert.deepEqual(await pinged(t), ['Josh']);
  assert.deepEqual(needsYou(t), ['Josh']);
  assert.equal(store.ownerCoordinator(t)?.id, joshTm.id);

  for (const [how, undo] of [
    [
      'removed',
      () => {
        store.removeMember(p, josh.id);
        return () => store.addMember(p, josh.id);
      },
    ],
    [
      'disabled',
      () => {
        store.updateUser(josh.id, { disabled_at: Date.now() });
        return () => store.updateUser(josh.id, { disabled_at: null });
      },
    ],
  ] as const) {
    const back = undo();
    // Push, the Needs-you list and the routing all land on the owner, Cara: not everyone, not no one, and never Josh's Taskmaster.
    assert.deepEqual(await pinged(t), ['Cara'], `push, ${how}`);
    assert.deepEqual(needsYou(t), ['Cara'], `Needs-you, ${how}`);
    assert.equal(store.minionOwner(t), cara.id, `owner, ${how}`);
    assert.equal(store.ownerCoordinator(t)?.id, caraTm.id, `Taskmaster, ${how}`);
    // Nor does its message_coordinator leave held mail in his Taskmaster, or reply to it because it last wrote.
    assert.deepEqual(store.touchedBy(t), [], `touched, ${how}`);
    store.setSetting(replyToKey(t.id), joshTm.id);
    assert.deepEqual(await told(t), { to: caraTm.id, mail: [] }, `message_coordinator, ${how}`);
    back();
  }
  // Hiding a scheme doesn't take him out of it (#226): it stays his, only his devices go quiet.
  store.setProjectHidden(josh.id, p, true);
  assert.deepEqual(await pinged(t), []);
  assert.deepEqual(needsYou(t), ['Josh']);
  assert.equal(store.ownerCoordinator(t)?.id, joshTm.id);
  store.setProjectHidden(josh.id, p, false);
  store.setSetting(replyToKey(t.id), caraTm.id);
  assert.deepEqual(await told(t), { to: caraTm.id, mail: [joshTm.id] }, 'a live Taskmaster that last wrote still gets the reply');
  // Back in the scheme, it is his again.
  assert.deepEqual(await pinged(t), ['Josh']);
  assert.equal(store.ownerCoordinator(t)?.id, joshTm.id);
  // An assignee who is nobody here is the owner's too; a minion assigned to no one stays everyone's.
  const ghost = assignedMinion(store, p, 'Someone', 'Ghost');
  assert.deepEqual(await pinged(ghost), ['Cara']);
  assert.deepEqual(needsYou(ghost), ['Cara']);
  const open = store.createTicket({ project_id: p, title: 'Open', permission_mode: 'default', created_by: 'Cara' });
  store.addEvent(open.id, 'question', { id: 'q-open', questions: [] });
  assert.deepEqual(await pinged(store.getTicket(open.id)!), ['Cara', 'Josh', 'Olive']);
  assert.deepEqual(needsYou(store.getTicket(open.id)!), ['Cara', 'Josh', 'Olive']);
  // A requester who left: their minion reports to the owner's Taskmaster, not the gone requester's.
  const asked = store.createTicket({ project_id: p, title: 'Asked', permission_mode: 'default', created_by: 'Josh' });
  store.props.set('minion', asked.id, p, { requestedBy: 'Josh' }, 'Cara');
  assert.equal(store.ownerCoordinator(asked)?.id, joshTm.id);
  store.removeMember(p, josh.id);
  assert.equal(store.ownerCoordinator(asked)?.id, caraTm.id);
  store.db.close();
});
