import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { FIRST_WEEK_NAME } from '../src/first-week.ts';

test('setup reaching done books one first-week run, seven days out, once only, in a scheme that is not Citadel (#1101)', () => {
  const store = new Store(':memory:');
  const p = store.createProject('Other scheme', null).id;
  store.setProjectSettings(p, { onboarding: 'interview' });
  assert.equal(store.schedules.list(p).length, 0, 'nothing while setup is open');
  const t0 = Date.now();
  store.setProjectSettings(p, { onboarding: 'done' });
  const [s] = store.schedules.list(p);
  assert.equal(s.name, FIRST_WEEK_NAME);
  assert.equal(s.once, 1);
  assert.equal(s.model, 'claude-sonnet-5-5');
  const days = (s.next_run_at! - t0) / 86_400_000;
  assert.ok(days > 6 && days < 8, `due in ${days} days`);
  assert.equal(store.schedules.due(t0 + 3 * 86_400_000).length, 0);
  assert.equal(store.schedules.due(s.next_run_at!).length, 1, 'comes due a week on');
  // Saving done again, or reopening and finishing, doesn't book a second one.
  store.setProjectSettings(p, { onboarding: 'done' });
  store.setProjectSettings(p, { onboarding: 'tune-up' as any });
  store.setProjectSettings(p, { onboarding: 'done' });
  assert.equal(store.schedules.list(p).length, 1);
  // Another scheme getting done gets its own.
  const q = store.createProject('Third', null).id;
  store.setProjectSettings(q, { onboarding: 'interview' });
  store.setProjectSettings(q, { onboarding: 'done' });
  assert.equal(store.schedules.list(q).length, 1);
});

test('the brief booked in a non-Citadel scheme sends its kit gaps by relay_when_live to Citadel, not message_coordinator (A1)', () => {
  const store = new Store(':memory:');
  const p = store.createProject('Other scheme', null).id;
  store.setProjectSettings(p, { onboarding: 'interview' });
  store.setProjectSettings(p, { onboarding: 'done' });
  const [s] = store.schedules.list(p);
  assert.match(s.brief, /relay_when_live/);
  assert.match(s.brief, /to: "Citadel"/);
  assert.doesNotMatch(s.brief, /message_coordinator/);
});
