import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { TimerRun } from '../src/app-services.ts';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { alertTitle, redact, TimerAlerts } from '../src/timer-alerts.ts';

// A contraption's failed timer job is one Mandate alert, for admins and its home-scheme owner, cleared by a good run (#555).
const root = mkdtempSync(join(tmpdir(), 'timer-alerts-'));
after(() => rmSync(root, { recursive: true, force: true }));
const AT = Date.UTC(2026, 10, 11, 11, 0);

test('one item per failing job, to admins and the home-scheme owner with Mandate on, retried, cleared by the next good run', async () => {
  const store = new Store(join(root, 'coordinator.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const rachel = store.createUser({ name: 'Rachel', login: 'rachel', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const amy = store.createUser({ name: 'Amy', login: 'amy' });
  const scheme = store.createProject('Mandate', null, josh.id);
  const c = new Contraptions(store, 's'.repeat(40), join(root, 'keys'));
  const mandate = c.register({ name: 'mandate', title: 'Mandate', port: 9101, icon: '/icon.svg', home_scheme: scheme.id, open_paths: '[]', default_model: 'haiku', turn_cap: 200 });
  // Rachel, an admin, has no Mandate; Amy has it but neither runs Citadel nor owns the app's scheme.
  for (const u of [cara, josh, amy]) store.setContraptionUser(mandate.id, u.id, true, cara.id);

  let runs: TimerRun[] = [];
  const run = (active: string, unit = 'citadel-app-mandate-backup.service', job = 'backup'): TimerRun =>
    ({ app: store.getContraption('mandate')!, job, unit, active, result: active === 'failed' ? 'exit-code' : 'success', status: active === 'failed' ? '1' : '0', exitAt: AT });
  const calls: { who: string; key: string; title: string | null; from: string; link?: string }[] = [];
  let down = '';
  let journalReads = 0;
  const alerts = new TimerAlerts(store, {
    runs: async () => runs,
    journal: async () => (journalReads++, ['Copying data for 3 people', 'copy failed for josh: EACCES token=abc123', 'Backup failed: 1 of 3 files']),
    mandate: async (from, person, key, title, link) => (calls.push({ who: person.name, key, title, from: from.name, link }), person.name !== down),
  });

  runs = [run('inactive')];
  await alerts.tick(AT);
  assert.deepEqual(calls, [], 'a job that never failed tells no one');

  down = 'Josh';
  runs = [run('failed')];
  await alerts.tick(AT);
  assert.deepEqual(calls.map((x) => x.who).sort(), ['Cara', 'Josh']);
  assert.equal(calls[0].from, 'Mandate', "from the app's home scheme");
  assert.equal(calls[0].link, `/c/#/p/${scheme.id}`);
  assert.equal(calls[0].key, 'timer.citadel-app-mandate-backup');
  assert.match(calls[0].title!, /^Mandate's backup timer failed Nov 11, \d\d:00 PST \(exit 1\)\. Last lines: Copying data for 3 people \| copy failed for josh: EACCES token=\[hidden\] \| Backup failed: 1 of 3 files$/);

  down = '';
  calls.length = 0;
  await alerts.tick(AT + 300_000);
  await alerts.tick(AT + 600_000);
  assert.deepEqual(calls.map((x) => x.who), ['Josh'], "still failing: only Josh, whose Mandate didn't answer, is tried again, once");
  assert.equal(journalReads, 1, 'the words are fixed at the first failure: one item, not one per run');

  calls.length = 0;
  runs = [run('activating')];
  await alerts.tick(AT + 900_000);
  assert.deepEqual(calls, [], 'a run in progress settles nothing');

  down = 'Cara';
  runs = [run('inactive')];
  await alerts.tick(AT + 1_200_000);
  assert.deepEqual(calls.map((x) => [x.who, x.title]).sort(), [['Cara', null], ['Josh', null]], 'a good run clears it for everyone who has it');
  down = '';
  calls.length = 0;
  await alerts.tick(AT + 1_500_000);
  assert.deepEqual(calls.map((x) => [x.who, x.title]), [['Cara', null]], "Cara's clear Mandate missed is tried again");
  calls.length = 0;
  await alerts.tick(AT + 1_800_000);
  assert.deepEqual(calls, [], 'then nothing is left');

  runs = [run('failed'), run('failed', 'citadel-app-mandate-prune.service', 'prune')];
  await alerts.tick(AT + 2_100_000);
  assert.equal(new Set(calls.map((x) => x.key)).size, 2, 'each failing job is its own item');
  calls.length = 0;
  runs = [run('failed')];
  await alerts.tick(AT + 2_400_000);
  assert.deepEqual(calls.map((x) => [x.key, x.title]).sort(), [['timer.citadel-app-mandate-prune', null], ['timer.citadel-app-mandate-prune', null]], 'a job that is gone is cleared');

  calls.length = 0;
  runs = [run('unknown')];
  await alerts.tick(AT + 2_550_000);
  assert.deepEqual(calls, [], "a job whose state couldn't be read is neither raised nor cleared");
  calls.length = 0;
  alerts['deps'].runs = async () => { throw new Error('systemd is not answering'); };
  await assert.rejects(alerts.tick(AT + 2_700_000));
  assert.deepEqual(calls, [], 'a round that cannot read the runs clears nothing');
});

test('redact hides secret-looking values and the title keeps within 500 characters', () => {
  assert.equal(redact('PASSWORD=hunter2 api_key: "xyz" ok'), 'PASSWORD=[hidden] api_key: "[hidden]" ok');
  assert.equal(redact('Authorization: Bearer eyJhbGciOi.abc'), 'Authorization: [hidden] [hidden]');
  assert.equal(redact(`PASSWORD="correct horse battery staple" next`), 'PASSWORD="[hidden]" next', 'a quoted secret goes whole');
  assert.equal(redact(`{"session_id": 'a b c', "x": 1}`), `{"session_id": '[hidden]', "x": 1}`);
  assert.equal(redact('sent with Bearer eyJhbGciOi.abc'), 'sent with Bearer [hidden]');
  assert.equal(redact('fetch https://bob:pa55@host/x failed'), 'fetch https://[hidden]@host/x failed');
  assert.equal(redact(`key ${'a1'.repeat(20)} end`), 'key [hidden] end');
  assert.equal(redact('copy failed: ENOSPC on /data/josh/notes.db'), 'copy failed: ENOSPC on /data/josh/notes.db');
  assert.equal(redact('/home/cara/.local/share/mandate/backups/people_notes_archive_2026'), '/home/cara/.local/share/mandate/backups/people_notes_archive_2026', 'a path stays');
  const long = alertTitle({ app: { title: 'Mandate' }, job: 'backup', result: 'signal', status: '9', exitAt: AT } as TimerRun, Array(9).fill('copy failed '.repeat(25)), AT);
  assert.equal(long.length, 500);
  assert.match(long, /^Mandate's backup timer failed .* \(signal\)\. Last lines: (copy failed ){16}copy fai \|/, 'each line cut to 200 characters');
});
