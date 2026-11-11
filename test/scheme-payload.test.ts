import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { bootServer, type Booted } from './helpers.ts';

// A scheme's page draws from its open minions and fetches the dismissed ones behind (#538), and a switch
// starts the Taskmaster's chat with the scheme, from the id the scheme list carries.
const root = mkdtempSync(join(tmpdir(), 'scheme-payload-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
const store = new Store(join(data, 'coordinator.db'));
const P = store.createProject('A', null);
const TM = store.createTicket({ project_id: P.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Cara' });
const minion = (title: string) => store.createTicket({ project_id: P.id, title, permission_mode: 'default', created_by: 'Cara' }).id;
const open = minion('still open'), gone = minion('dismissed one'), gone2 = minion('dismissed two');
store.updateTicket(gone, { status: 'closed' });
store.updateTicket(gone2, { status: 'closed' });
store.db.close();

let srv: Booted;
before(async () => { srv = await bootServer({ root }); });
after(async () => {
  await srv?.stop();
  rmSync(root, { recursive: true, force: true });
});

test('the scheme payload: everything, the open minions with a count of the dismissed, or only the dismissed', async () => {
  const ids = async (q: string) => {
    const { status, data } = await srv.call(`/api/projects/${P.id}${q}`);
    assert.equal(status, 200);
    assert.equal(data.coordinator.id, TM.id);
    assert.equal(data.dismissed, 2);
    return data.tickets.map((t: any) => t.id).sort();
  };
  assert.deepEqual(await ids(''), [open, gone, gone2].sort());
  assert.deepEqual(await ids('?tickets=open'), [open]);
  assert.deepEqual(await ids('?tickets=closed'), [gone, gone2].sort());
});

test('the scheme list names each scheme\'s Taskmaster', async () => {
  const { data } = await srv.call('/api/projects');
  assert.equal(data.find((p: any) => p.id === P.id).coordinator_id, TM.id);
});
