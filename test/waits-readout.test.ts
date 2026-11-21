// The list chip's waits (ADR 0021 step 7, #1387): timed rows show a Pacific time, a wait on another minion its number,
// anything else "event"; dropped rows stay 7 days, greyed; a Taskmaster's own rows are its own.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { DROPPED_SHOWN_MS, waitsFor } from '../src/waits-readout.ts';
import { testPins } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'waits-readout-'));
after(() => rmSync(root, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 10, 14, 20, 0); // 12:00 PST

test('chips: a time, another minion, an event; dropped rows age out after 7 days', () => {
  const store = new Store(join(root, 'a.db'));
  const p = store.createProject('P', null);
  const mk = () => store.createTicket({ project_id: p.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const a = mk(), b = mk();
  const add = (d: any) => store.addDelivery({ project_id: p.id, kind: 'k', to_kind: 'minion', to_id: a.id, set_by: 'minion:1', when_kind: 'at', ...d }, NOW);
  add({ when_arg: NOW + 14 * 3_600_000, due: NOW + 14 * 3_600_000, payload: { note: 'check' } }); // 02:00 next day PST
  add({ when_kind: 'live', when_arg: { ticket: b.id } });
  add({ when_kind: 'ci', when_arg: { sha: 'abc' } });
  const old = add({ when_kind: 'ci', state: 'dropped', reason: 'cancelled' });
  store.updateDelivery(old.id, { reason: 'cancelled' }, undefined, NOW - DROPPED_SHOWN_MS - 1);
  const gone = add({ when_kind: 'ci', state: 'dropped', reason: 'minion dismissed' });
  const rows = waitsFor(store, store.getTicket(a.id)!, () => [{ kind: 'chain', chip: '⇢ #9', what: 'x', set_by: 'c', since: null }], NOW);
  assert.deepEqual(rows.slice(1).map((r) => r.chip), [`⇢ #${b.number}`, '⇢ event', '⇢ #9', '⇢ event']);
  assert.match(rows[0].chip, /^⏱ (\w{3} )?\d\d:\d\d$/);
  assert.ok(rows[0].cancellable && !rows[3].cancellable, 'old-key waits have no Cancel');
  assert.equal(rows.at(-1)!.id, gone.id);
  assert.equal(rows.at(-1)!.reason, 'minion dismissed');
});

test('a chain row (its held brief) shows its leader and has no Cancel: Start now or dismiss instead', () => {
  const store = new Store(join(root, 'c.db'));
  const p = store.createProject('P', null);
  const mk = () => store.createTicket({ project_id: p.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const a = mk(), lead = mk();
  store.addDelivery({ project_id: p.id, kind: 'chain', to_kind: 'minion', to_id: a.id, set_by: 'Taskmaster', when_kind: 'merged', when_arg: { after: lead.id }, payload: { message: 'go', reason: 'its work' } }, NOW);
  const [row] = waitsFor(store, store.getTicket(a.id)!, () => [], NOW);
  assert.deepEqual([row.chip, row.what, row.cancellable], [`⇢ #${lead.number}`, 'its work', false]);
});
