import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { adminAlert, adminClear, Fallbacks } from '../src/fallbacks.ts';

// A job systemd-run couldn't put in a unit of its own is loud (#519): counted, and one alert per cause a day.
const root = mkdtempSync(join(tmpdir(), 'fallbacks-'));
after(() => rmSync(root, { recursive: true, force: true }));
const settle = () => new Promise((r) => setImmediate(r));
const DAY = Date.UTC(2026, 10, 10, 23, 32);

test('one alert per cause, whatever the unit names, again on a failed alert or a new day', async () => {
  const f = new Fallbacks();
  const alerts: string[] = [];
  let answer: boolean | Error = true;
  f.alert = async (_cause, job) => {
    alerts.push(job);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  f.record(1, 'A turn', 'Unit citadel-turn-ab12-1-1794388868572.service: Unit citadel-turns.slice not found.', DAY);
  f.record(2, 'A turn', 'Unit citadel-turn-ab12-2-1794388869999.service: Unit citadel-turns.slice not found.', DAY);
  await settle();
  assert.deepEqual(alerts, ['A turn'], 'nine turns failing the same way are one alert');
  f.record(3, 'tools/land.sh for minion 3', 'Failed to connect to bus', DAY);
  await settle();
  assert.equal(alerts.length, 2, 'another cause is another alert');

  answer = false;
  f.record(4, 'A turn', 'Out of memory', DAY);
  await settle();
  answer = new Error('Mandate is down');
  f.record(5, 'A turn', 'Out of memory', DAY);
  await settle();
  answer = true;
  f.record(6, 'A turn', 'Out of memory', DAY);
  f.record(7, 'A turn', 'Out of memory', DAY);
  await settle();
  assert.equal(alerts.length, 5, 'an alert that reached no one, or threw, is tried again on the next fallback, until it goes');

  f.record(8, 'A turn', 'Failed to connect to bus', DAY + 24 * 3600_000);
  await settle();
  assert.equal(alerts.length, 6, 'trouble still there the next day alerts again');
  assert.equal(f.count, 8, 'every fallback counts');
});

test("the alert goes to every admin with Mandate on, from the job's scheme and linking its minion; true only once each has it", async () => {
  const store = new Store(join(root, 'coordinator.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh', admin: true });
  const rachel = store.createUser({ name: 'Rachel', login: 'rachel', admin: true });
  const amy = store.createUser({ name: 'Amy', login: 'amy' });
  const c = new Contraptions(store, 's'.repeat(40), join(root, 'keys'));
  const mandate = c.register({ name: 'mandate', title: 'Mandate', port: 9101, icon: '/icon.svg', home_scheme: null, open_paths: '[]', default_model: 'haiku', turn_cap: 200 });
  // Rachel, an admin, has no Mandate; Amy has it but isn't an admin.
  for (const u of [cara, josh, amy]) store.setContraptionUser(mandate.id, u.id, true, cara.id);
  const project = store.createProject('Citadel', null, cara.id);
  const ticket = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });

  const puts: { who: string; key: string; title: string; link: string; from: string }[] = [];
  let down = 'Josh';
  const alert = adminAlert(store, async (p, person, key, title, link) => {
    puts.push({ who: person.name, key, title, link, from: p.name });
    return person.name !== down;
  });
  assert.equal(await alert('2026-11-10 Unit citadel-turns.slice not found.', 'A turn', 'Unit citadel-turns.slice not found.', ticket.id), false, "Josh's Mandate didn't answer, so the cause stays open");
  assert.deepEqual(puts.map((p) => p.who).sort(), ['Cara', 'Josh']);
  assert.equal(puts[0].from, 'Citadel');
  assert.equal(puts[0].link, `/c/#/p/${project.id}/t/${ticket.number}`);
  assert.match(puts[0].title, new RegExp(`^A turn for #${ticket.number} ran inside the server.*systemd-run failed \\(Unit citadel-turns\\.slice not found\\.\\)$`));
  assert.match(puts[0].key, /^fallback\.[0-9a-f]{16}$/);
  down = '';
  puts.length = 0;
  assert.equal(await alert('2026-11-10 Unit citadel-turns.slice not found.', 'A turn', 'Unit citadel-turns.slice not found.', ticket.id), true);
  assert.equal(new Set(puts.map((p) => p.key)).size, 1, 'the retry puts the same item, so Cara gets no second one');
  assert.equal(await alert('x', 'A turn', 'x', 999_999), false, 'a job whose minion is gone tells no one, and is tried again');
});

test('the alerts out are cleared once a job gets its own unit again, and what Mandate refused is tried on the next one (#532)', async () => {
  const store = new Store(join(root, 'clear.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh', admin: true });
  const c = new Contraptions(store, 's'.repeat(40), join(root, 'clear-keys'));
  const mandate = c.register({ name: 'mandate', title: 'Mandate', port: 9101, icon: '/icon.svg', home_scheme: null, open_paths: '[]', default_model: 'haiku', turn_cap: 200 });
  for (const u of [cara, josh]) store.setContraptionUser(mandate.id, u.id, true, cara.id);
  const project = store.createProject('Citadel', null, cara.id);
  const ticket = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });

  const f = new Fallbacks();
  let joshDown = true;
  f.alert = adminAlert(store, async (_p, person) => !(joshDown && person.name === 'Josh'));
  const cleared: string[] = [];
  f.clear = adminClear(store, async (p, person, key) => {
    assert.equal(p.id, project.id);
    cleared.push(`${person.name} ${key}`);
    return !(joshDown && person.name === 'Josh');
  });
  f.started();
  await settle();
  assert.deepEqual(cleared, [], 'nothing out, nothing cleared');

  f.record(ticket.id, 'A turn', 'Unit citadel-turns.slice not found.', DAY);
  await settle();
  f.started();
  await settle();
  assert.equal(cleared.length, 1, "only Cara had it: Josh's put didn't land");
  assert.match(cleared[0], /^Cara fallback\.[0-9a-f]{16}$/);

  joshDown = false;
  f.record(ticket.id, 'A turn', 'Unit citadel-turns.slice not found.', DAY);
  await settle();
  assert.equal(cleared.length, 1, 'the cause was retried (Josh missed it), but nothing cleared on a fallback');
  joshDown = true;
  f.started();
  await settle();
  assert.deepEqual(cleared.slice(1).sort(), [`Cara ${cleared[0].split(' ')[1]}`, `Josh ${cleared[0].split(' ')[1]}`]);
  joshDown = false;
  f.started();
  await settle();
  assert.deepEqual(cleared.slice(3), [`Josh ${cleared[0].split(' ')[1]}`], "Josh's refused clear is tried again, Cara's isn't");
  f.started();
  await settle();
  assert.equal(cleared.length, 4, 'all cleared: nothing more to do');
});
