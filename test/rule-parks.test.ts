import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { mailParksUnderOldRule, rulePhrases } from '../src/rule-parks.ts';
import { bootServer, until, type Booted } from './helpers.ts';

// #1488: on Nov 21 Cara picked "Build in parallel" for the pipeline lane, but minions parked "waiting for pipeline
// lane", and the chains behind them, stayed parked until she asked why #1168 wasn't working.
const OLD = 'Intro line that stays the same for everyone here.\n\n**The pipeline lane**: minions that change the ship pipeline ship one at a time, in the order of the pipeline-lane claim.';
const NEW = 'Intro line that stays the same for everyone here.\n\n**The pipeline lane**: minions that change the ship pipeline build in parallel and ship one at a time.';

test('the phrases of a save are the word pairs of what changed, old wording and new, not the unchanged text', () => {
  const p = rulePhrases(OLD, NEW);
  assert.ok(p.has('pipeline lane') && p.has('lane claim') && p.has('build parallel') === false && p.has('parallel ship') === false);
  assert.ok(!p.has('intro line'), 'unchanged paragraphs give none');
  assert.equal(rulePhrases(OLD, OLD).size, 0);
});

test('parked minions whose note names the changed rule, and the chains behind them, go to their Taskmaster; others do not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rule-parks-'));
  try { // timing-ok: own temp dir
    const store = new Store(join(dir, 'db.sqlite'));
    const project = store.createProject('P', null);
    const tm = store.createTicket({ project_id: project.id, title: 'TM', permission_mode: 'default', created_by: 'x', kind: 'coordinator' });
    const make = (title: string, state: string | null, note: string) => {
      const t = store.createTicket({ project_id: project.id, title, permission_mode: 'default', created_by: 'x' });
      store.updateTicket(t.id, { state, note } as any);
      return store.getTicket(t.id)!;
    };
    const lane = make('Lane', 'parked', 'go given; waiting for pipeline lane (11th)');
    const chained = make('Chained', null, 'starts when #1 is live');
    const chained2 = make('Chained 2', null, 'starts when #2 is live');
    const other = make('Other', 'parked', 'waiting on Josh\'s GPU');
    const running = make('Running', null, 'waiting for pipeline lane');
    const chains = [{ ticket: chained.id, after: lane.id }, { ticket: chained2.id, after: chained.id }];
    const mail: { to: number; text: string }[] = [];
    const runner = { parked: (t: any) => t.state === 'parked' || chains.some((c) => c.ticket === t.id), leaveMail: (to: number, _a: string, text: string) => mail.push({ to, text }) };
    const app = { store, runner, waiters: { chains: () => chains } } as any;

    mailParksUnderOldRule(app, [store.getProject(project.id)!], OLD, NEW, 'scheme');
    assert.equal(mail.length, 1);
    assert.equal(mail[0].to, tm.id);
    assert.match(mail[0].text, /The scheme instructions just changed/);
    assert.match(mail[0].text, new RegExp(`#${lane.number} Lane: "go given; waiting for pipeline lane \\(11th\\)" \\(its note names "pipeline lane"\\)`));
    assert.match(mail[0].text, new RegExp(`#${chained.number} Chained: .*\\(chained behind #${lane.number}\\)`));
    assert.match(mail[0].text, new RegExp(`#${chained2.number} Chained 2: .*\\(chained behind #${chained.number}\\)`));
    assert.ok(!mail[0].text.includes('Other') && !mail[0].text.includes('Running'), mail[0].text);
    assert.match(mail[0].text, /unpark: true/);

    mail.length = 0;
    mailParksUnderOldRule(app, [store.getProject(project.id)!], 'Alpha rule with six words in it.', 'Alpha rule with seven words in it now.', 'scheme');
    assert.equal(mail.length, 0, 'a change no park note names sends nothing');
    void other; void running;
  } finally {
    rmSync(dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});

let srv: Booted;
before(async () => { srv = await bootServer(); });
after(() => srv?.stop());

test('through the server: a person\'s Settings save mails the Taskmaster about a minion parked under the old wording', async () => {
  const p = (await srv.call('/api/projects', { name: 'P' })).data;
  await srv.call(`/api/projects/${p.id}`, { instructions: OLD }, 'PATCH');
  const t = (await srv.call(`/api/projects/${p.id}/tickets`, { title: 'Lane', message: 'a lane change' })).data;
  // Its turn (CLAUDE_BIN is /bin/false) ends in error and writes its note: park it after that.
  await until('its turn to end', async () => (await srv.call(`/api/tickets/${t.id}`)).data.ticket.status !== 'running');
  const db = new DatabaseSync(join(srv.data, 'coordinator.db'));
  db.prepare("UPDATE tickets SET state = 'parked', note = 'waiting for pipeline lane' WHERE id = ?").run(t.id);
  db.close();
  const tm = (await srv.call(`/api/projects/${p.id}`)).data.coordinator; // reading the scheme makes its Taskmaster
  assert.equal((await srv.call(`/api/projects/${p.id}`, { instructions: NEW }, 'PATCH')).status, 200);
  await until('the mail in the Taskmaster\'s chat', async () => JSON.stringify((await srv.call(`/api/tickets/${tm.id}/events?after=0`)).data).includes('may be waiting under the old wording'));
  const events = JSON.stringify((await srv.call(`/api/tickets/${tm.id}/events?after=0`)).data);
  assert.ok(events.includes(`#${t.number} Lane`), events.slice(-2000));
});
