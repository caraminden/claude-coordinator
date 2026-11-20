import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Approvals } from '../src/approvals.ts';
import { Store } from '../src/db.ts';
import { inboxCount, inboxItems } from '../src/inbox.ts';
import { addMention, clearMentions, MAX_MENTIONS, mentionedIn } from '../src/mentions.ts';

const root = mkdtempSync(join(tmpdir(), 'mentions-'));
after(() => rmSync(root, { recursive: true, force: true }));

const members = [{ name: 'Cara', login: 'cara-gh' }, { name: 'Josh', login: 'katz' }, { name: 'Cara Lee', login: 'clee' }];

test('mentionedIn: members by name or login, any case, once each, never the sender (#1149)', () => {
  assert.deepEqual(mentionedIn('@Josh can you look at this', members, 'Cara'), ['Josh']);
  assert.deepEqual(mentionedIn('ping @KATZ and (@cara-gh), and @josh again', members, 'Someone'), ['Cara', 'Josh']);
  assert.deepEqual(mentionedIn('@Cara Lee, then @Cara.', members, 'Josh'), ['Cara', 'Cara Lee'], 'the longest name wins, and punctuation ends one');
  assert.deepEqual(mentionedIn('@Josh, me: @Cara', members, 'cara'), ['Josh'], 'not the sender');
  assert.deepEqual(mentionedIn('mail josh@x.com, @Joshua, @nobody, @', members, 'Cara'), [], 'an address, a longer word and a non-member are no one');
});

test('a mention is in its person\'s Needs you and counts, whoever the minion is assigned to, until they open the chat (#1149)', () => {
  const store = new Store(join(root, 'db.sqlite'));
  store.typedHandlesUpTo = 0;
  const approvals = new Approvals(() => {});
  const p = store.createProject('Seeded', null).id;
  const other = store.createProject('Other', null).id;
  const t = store.createTicket({ project_id: p, title: 't', permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  const gone = store.createTicket({ project_id: p, title: 'gone', permission_mode: 'bypassPermissions', created_by: 'Cara' }).id;
  store.props.set('minion', t, p, { assigned: 'Cara' }, 'Cara');
  const e = store.addEvent(t, 'user_message', { author: 'Cara', text: '@Josh look', mentions: ['Josh'] });
  addMention(store, 'Josh', { ticketId: t, projectId: p, eventId: e.id, at: e.created_at, by: 'Cara', text: '@Josh look' });
  const g = store.addEvent(gone, 'user_message', { author: 'Cara', text: '@Josh old' });
  addMention(store, 'josh', { ticketId: gone, projectId: p, eventId: g.id, at: g.created_at, by: 'Cara', text: '@Josh old' });
  store.updateTicket(gone, { status: 'closed' });

  const items = inboxItems(store, approvals, p, 'Josh').filter((i) => i.kind === 'mention');
  assert.deepEqual(items.map((i) => [i.ticketId, i.eventId, (i.card as any).by]), [[t, e.id, 'Cara']], 'a dismissed minion\'s is gone');
  assert.equal(inboxCount(store, approvals, p, 'Josh', store.seenTimes('Josh', p)), 1);
  assert.deepEqual(inboxItems(store, approvals, other, 'Josh').filter((i) => i.kind === 'mention'), [], 'only in its own scheme');
  assert.deepEqual(inboxItems(store, approvals, p, 'Cara').filter((i) => i.kind === 'mention'), []);

  // Opening the chat clears it, by its seen time even before the list is tidied.
  store.markSeen('Josh', t);
  assert.deepEqual(inboxItems(store, approvals, p, 'Josh').filter((i) => i.kind === 'mention'), []);
  clearMentions(store, 'Josh', t);
  assert.deepEqual(store.getSetting<unknown[]>('mentions:josh')!.map((m: any) => m.ticketId), [gone]);

  // The list keeps the newest MAX_MENTIONS.
  for (let i = 0; i < MAX_MENTIONS + 5; i++) addMention(store, 'Josh', { ticketId: t, projectId: p, eventId: 1000 + i, at: Date.now() + 10_000, by: 'Cara', text: 'x'.repeat(1000) });
  const kept = store.getSetting<{ eventId: number; text: string }[]>('mentions:josh')!;
  assert.equal(kept.length, MAX_MENTIONS);
  assert.equal(kept.at(-1)!.eventId, 1000 + MAX_MENTIONS + 4);
  assert.equal(kept[0].text.length, 300);
});
