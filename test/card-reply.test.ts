// An everyone card carries the reply it belongs to (#1581): the card shows in every member's Mine, the turn's words don't,
// so "steps in my reply above" pointed at text only the writer's own chat held.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';

const root = mkdtempSync(join(tmpdir(), 'card-reply-'));
const say = (r: Runner, id: number, text: string) => r.emit(id, 'claude', { type: 'assistant', message: { content: [{ type: 'text', text }] } });
const ask = (r: Runner, id: number, extra: object = {}) => r.emit(id, 'question', { id: 'c1', questions: [{ question: 'Back?', options: [] }], ...extra });
const setup = (name: string) => {
  const s = new Store(join(root, `${name}.db`));
  const cara = s.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = s.createUser({ name: 'Josh', login: 'josh' });
  const p = s.createProject('Shared', null, cara.id);
  s.addMember(p.id, josh.id);
  s.createTicket({ project_id: p.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Taskmaster' });
  s.splitScheme(p.id, josh.id);
  const r = new Runner(s, () => {}, () => ({}), '/bin/false');
  return { s, r, p, lord: s.getOverlord(p.id)!, josh: s.coordinatorFor(p.id, josh.id)! };
};
const mine = (s: Store, id: number) => s.eventsBetween(id, 0, Number.MAX_SAFE_INTEGER, true);

test("the Overlord's everyone card carries its turn's reply, and the update shows in Mine", () => {
  const { s, r, lord } = setup('lord');
  const card = ask(r, lord.id);
  say(r, lord.id, 'Restart them with:\n\n```powershell\nStart-Service x\n```');
  (r as any).carryReply(lord.id);
  assert.match(JSON.parse(s.getEvent(card.id)!.data).reply, /Start-Service x/);
  assert.ok(mine(s, lord.id).some((e) => e.kind === 'card_reply'), 'live viewers get the update in Mine');
  s.db.close();
});

test("a person's Taskmaster asking for everyone: the Overlord's card carries the asker's reply", () => {
  const { s, r, lord, josh } = setup('asker');
  const card = ask(r, lord.id, { asker: josh.id });
  say(r, josh.id, 'Steps are above the card.');
  (r as any).carryReply(josh.id);
  assert.equal(JSON.parse(s.getEvent(card.id)!.data).reply, 'Steps are above the card.');
  s.db.close();
});

test("a card from another turn or a one-person card gets no reply", () => {
  const { s, r, lord, josh } = setup('other');
  const card = ask(r, lord.id, { asker: josh.id });
  const own = ask(r, josh.id, { id: 'c2' });
  say(r, lord.id, 'Unrelated Overlord words');
  (r as any).carryReply(lord.id); // the Overlord's turn didn't ask josh's card
  say(r, josh.id, 'Hello');
  (r as any).carryReply(josh.id);
  assert.equal(JSON.parse(s.getEvent(own.id)!.data).reply, undefined, "Josh's own card is only in his chat");
  assert.equal(JSON.parse(s.getEvent(card.id)!.data).reply, 'Hello');
  s.db.close();
});
