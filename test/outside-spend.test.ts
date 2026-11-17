import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { monthStart } from '../src/openrouter.ts';
import { OutsideSpend, parseSpend } from '../src/outside-spend.ts';
import { bootServer, SECRET, stopTurns } from './helpers.ts';

// Spend on outside APIs (#839): contraptions and minions report it, the bill is per scheme and service
// by month beside OpenRouter's own calls, and a scheme's optional cap warns once without stopping anything.
const root = mkdtempSync(join(tmpdir(), 'outside-spend-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});

const store = new Store(join(data, 'coordinator.db'));
const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
const josh = store.createUser({ name: 'Josh', login: 'josh' });
const twi = store.createProject('TWIReader', null, cara.id);
const fresh = store.createProject('Fresh', null, cara.id);
const other = store.createProject('Other', null, cara.id);
store.addMember(twi.id, josh.id);
const keys = new Contraptions(store, SECRET, join(data, 'contraptions'));
keys.register({ name: 'twireader', title: 'TWIReader', port: 9103, icon: null, home_scheme: fresh.id, open_paths: '[]', default_model: null, turn_cap: null });
const KEY = readFileSync(join(data, 'contraptions', 'twireader', 'contraption.key'), 'utf8');

test('parseSpend: a service and a positive amount; units and note optional', () => {
  assert.deepEqual(parseSpend({ service: ' azure-speech ', usd: 1.5, units: 120000, note: 'chapter 4' }), { service: 'azure-speech', usd: 1.5, units: 120000, note: 'chapter 4' });
  assert.deepEqual(parseSpend({ service: 'a', usd: 0.01 }), { service: 'a', usd: 0.01, units: null, note: null });
  for (const bad of [null, {}, { service: '', usd: 1 }, { service: 'a', usd: 0 }, { service: 'a', usd: -1 }, { service: 'a', usd: '2' }, { service: 'a', usd: Infinity }, { service: 'a', usd: 1e9 }, { service: 'a'.repeat(65), usd: 1 }, { service: 'a', usd: 1, units: -1 }, { service: 'a', usd: 1, note: 5 }]) {
    assert.throws(() => parseSpend(bad), /service|usd|units|note|object/, JSON.stringify(bad));
  }
});

test('the monthly bill sums per scheme and service, with OpenRouter beside it, and leaves last month out', () => {
  const spend = new OutsideSpend(store);
  const now = Date.UTC(2026, 10, 16, 12);
  const thisMonth = monthStart(now);
  store.db.prepare('INSERT INTO outside_spend (project_id, service, usd, units, note, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(twi.id, 'azure-speech', 40, null, null, 'contraption:twireader', thisMonth - 1000);
  spend.record(twi.id, { service: 'azure-speech', usd: 30, units: 100, note: null }, 'contraption:twireader', now);
  spend.record(twi.id, { service: 'azure-speech', usd: 7.25, units: null, note: null }, 'minion:#12', now);
  spend.record(twi.id, { service: 'elevenlabs', usd: 2, units: null, note: null }, 'minion:#12', now);
  spend.record(other.id, { service: 'azure-speech', usd: 1, units: null, note: null }, 'minion:#3', now);
  const id = store.addOpenrouterCall({ user_id: cara.id, ticket_id: null, project_id: twi.id, model: 'x/y', kind: 'image', estimate_usd: 0.5 });
  store.finishOpenrouterCall(id, 'ok', 0.25);
  store.db.prepare('UPDATE openrouter_calls SET created_at = ? WHERE id = ?').run(now, id);
  const bill = spend.bill(now);
  const mine = bill.find((b) => b.project_id === twi.id)!;
  assert.equal(mine.name, 'TWIReader');
  assert.equal(mine.month_usd, 39.5);
  assert.deepEqual(mine.services, [{ service: 'azure-speech', usd: 37.25 }, { service: 'elevenlabs', usd: 2 }, { service: 'openrouter', usd: 0.25 }]);
  assert.equal(bill.find((b) => b.project_id === other.id)!.month_usd, 1);
  assert.equal(mine.cap_usd, null);
});

test('a cap warns once a month when crossed, and refuses nothing', () => {
  const spend = new OutsideSpend(store);
  const warned: number[] = [];
  spend.onCap = (projectId, total, cap) => warned.push(projectId, total, cap);
  const now = Date.UTC(2027, 0, 10);
  spend.setCap(other.id, 10);
  assert.equal(spend.record(other.id, { service: 's', usd: 9, units: null, note: null }, 'x', now).over, false);
  assert.deepEqual(warned, []);
  assert.equal(spend.record(other.id, { service: 's', usd: 2, units: null, note: null }, 'x', now).over, true);
  assert.deepEqual(warned, [other.id, 11, 10]);
  spend.record(other.id, { service: 's', usd: 5, units: null, note: null }, 'x', now); // still booked, no second warning
  assert.equal(warned.length, 3);
  assert.equal(spend.bill(now).find((b) => b.project_id === other.id)!.month_usd, 16);
  // The next month warns again.
  spend.record(other.id, { service: 's', usd: 11, units: null, note: null }, 'x', Date.UTC(2027, 1, 2));
  assert.equal(warned.length, 6);
  spend.setCap(other.id, null);
  assert.equal(spend.bill(now).find((b) => b.project_id === other.id)!.cap_usd, null);
  assert.throws(() => spend.setCap(other.id, -3), /cap/);
});

test('POST /api/contraptions/spend books to the contraption\'s home scheme; the bill shows on the scheme route', { timeout: 60_000 }, async () => {
  const srv = await bootServer({ root });
  try {
    const post = async (body: unknown, key: string | null = KEY) => {
      const res = await fetch(`${srv.base}/api/contraptions/spend`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() as any };
    };
    assert.equal((await post({ service: 'azure-speech', usd: 1 }, null)).status, 401);
    assert.equal((await post({ service: 'azure-speech', usd: -1 })).status, 400);
    const ok = await post({ service: 'azure-speech', usd: 2.5, units: 5000, note: 'ch 1' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.month_usd, 2.5);
    const capped = await srv.call(`/api/projects/${fresh.id}/spend`, { cap_usd: 3 }, 'PUT');
    assert.equal(capped.status, 200);
    const over = await post({ service: 'azure-speech', usd: 1 });
    assert.equal(over.body.over_cap, true);
    const bill = await srv.call(`/api/projects/${fresh.id}/spend`);
    assert.equal(bill.status, 200);
    assert.equal(bill.data.month_usd, 3.5);
    assert.equal(bill.data.cap_usd, 3);
    assert.deepEqual(bill.data.services, [{ service: 'azure-speech', usd: 3.5 }]);
  } finally {
    await srv.stop({ keepTurns: false });
  }
});
