// The first-day welcome (#1151): who gets it, each step ticking from what the server knows, and gone for good once
// done or dismissed.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { CARD_OPTIONS, welcomeAct, welcomeView } from '../src/welcome.ts';

const root = mkdtempSync(join(tmpdir(), 'welcome-'));
const store = new Store(join(root, 'coordinator.db'));
after(() => {
  store.db.close();
  rmSync(root, { recursive: true, force: true });
});
const p = store.createProject('Scheme', null);
const chat = store.createTicket({ project_id: p.id, title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
const say = (name: string) => store.addEvent(chat.id, 'user_message', { author: name, text: 'hi' });

test('someone who has written before never gets it, even after a scheme recap counted them as never', () => {
  const old = store.createUser({ name: 'Old', login: 'old' });
  say('Old');
  assert.equal(welcomeView(store, old, true), null);
  // recap writes at = 0 for a person who never acted in a scheme: that is not having written.
  const quiet = store.createUser({ name: 'Quiet', login: 'quiet' });
  store.recap('Quiet', p.id);
  assert.ok(welcomeView(store, quiet, false));
});

test('a new person: password done, the rest tick from Claude, a push subscription, a message and the card', () => {
  const u = store.createUser({ name: 'New', login: 'new' });
  assert.deepEqual(welcomeView(store, u, false), { steps: { password: true, claude: false, phone: false, hi: false, card: false }, card: null, done: false });
  store.savePushSubscription('New', 'https://push.example/new', 'k', 'a');
  say('New');
  // Writing after it first showed doesn't make them a veteran: the step ticks and the welcome stays.
  assert.deepEqual(welcomeView(store, u, true)?.steps, { password: true, claude: true, phone: true, hi: true, card: false });
  welcomeAct(store, u.id, { card: CARD_OPTIONS[0] });
  const last = welcomeView(store, u, true);
  assert.equal(last?.done, true, 'the look that finds every step done still answers, once, so the panel can say so');
  assert.equal(last?.card, CARD_OPTIONS[0]);
  assert.equal(welcomeView(store, u, true), null, 'then it is gone for good');
});

test('dismissed is gone for good, and acting on a finished welcome changes nothing', () => {
  const u = store.createUser({ name: 'Busy', login: 'busy' });
  assert.ok(welcomeView(store, u, false));
  welcomeAct(store, u.id, { dismiss: true });
  assert.equal(welcomeView(store, u, false), null);
  welcomeAct(store, u.id, { card: CARD_OPTIONS[1] });
  assert.equal(welcomeView(store, u, false), null);
});
