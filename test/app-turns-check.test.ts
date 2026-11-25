// The weekly app turns check (#844, kit/schedules/app-turns.md): added by itself once per app scheme, skipped free
// in a week with no turns, and its current run is the one minion that reads the turn audit.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { isAppTurnsRun, ScheduledRuns } from '../src/schedules.ts';
import { addAppTurnsCheck, addAppTurnsChecks } from '../src/standard-audits.ts';

const root = mkdtempSync(join(tmpdir(), 'app-turns-check-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function setup() {
  const store = new Store(join(root, `db-${++n}.sqlite`));
  const home = store.createProject('Voice', null);
  const plain = store.createProject('Plain', null);
  const app = store.createContraption({ name: `voice${n}`, title: 'Voice', icon: null, port: 9100 + n, home_scheme: home.id, open_paths: '[]', relay_paths: '[]', repo: null, branch: null, folder: null, default_model: null, turn_cap: null, identity_public: 'x', identity_private: 'x', key_hash: `h${n}`, keys_at: 0 });
  return { store, home, plain, app };
}
const checks = (store: Store, project: number) => store.schedules.list(project).filter((s) => s.template === 'app-turns');

test('a scheme home to an app gets the weekly check once, at boot or when it gets the app, and a deleted one stays deleted', () => {
  const { store, home, plain } = setup();
  assert.deepEqual(addAppTurnsChecks(store, '/data'), ['Voice: added "App turns check" (' + checks(store, home.id)[0].cron + ')']);
  assert.equal(checks(store, home.id).length, 1);
  assert.equal(checks(store, plain.id).length, 0, 'a scheme with no app');
  assert.match(checks(store, home.id)[0].brief, /Voice's app turns/);
  assert.deepEqual(addAppTurnsChecks(store, '/data'), [], 'the next boot adds nothing');
  store.schedules.remove(checks(store, home.id)[0].id);
  assert.equal(addAppTurnsCheck(store, '/data', home.id), null);
  assert.equal(checks(store, home.id).length, 0, 'someone deleted it: it stays deleted');
  // A scheme that gets its first app later gets it then.
  assert.match(addAppTurnsCheck(store, '/data', plain.id)!, /^Plain: added/);
  assert.equal(checks(store, plain.id).length, 1);
});

test('the check skips, with no minion, a stretch with no app turns, runs when there are some, and only its run reads the audit', async () => {
  const { store, home, app } = setup();
  const made: number[] = [];
  const runs = new ScheduledRuns({
    store,
    newMinion: async (project, m, by) => {
      const t = store.createTicket({ project_id: project.id, title: m.title, permission_mode: 'bypassPermissions', created_by: by });
      made.push(t.id);
      return { id: t.id, number: t.number! };
    },
    runner: { emit: () => {}, send: () => {}, limitWait: () => null, netWait: () => null, killWait: () => null } as any,
    broadcast: () => {},
    by: 'Citadel',
    dataDir: '/data',
  });
  const s = store.schedules.create({ project_id: home.id, name: 'App turns check', cron: '* * * * *', brief: '', type: 'research', template: 'app-turns', created_by: 'Cara' }, Date.now() - 120_000);
  await runs.runDue();
  assert.deepEqual(made, [], 'no turns: no minion');
  assert.match(store.schedules.get(s.id)!.last_skip!, /^Skipped .*: no app turns since /);

  const cara = store.createUser({ name: 'Cara', login: 'cara' });
  store.putTurnAudit(store.startContraptionTurn(app.id, cara.id, 'ex-1'), { model: null, blind: false, images: 0, system: 's', prompt: 'p', output: 'o' });
  store.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(Date.now() - 1, s.id);
  await runs.runDue();
  assert.equal(made.length, 1, 'a turn since the last run: the check runs');
  assert.equal(store.schedules.get(s.id)!.last_skip, null);

  const run = store.getTicket(made[0])!;
  const other = store.createTicket({ project_id: home.id, title: 'other', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  assert.equal(isAppTurnsRun(store, run), true);
  assert.equal(isAppTurnsRun(store, other), false, 'any other minion');
});
