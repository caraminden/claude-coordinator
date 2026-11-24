// The slow-load recorder's server side (#1752): what POST /api/slow-moments keeps from a page's report (slowRows), and
// the table's cap. The Server-Timing stamp on every answer is in test/front.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.ts';
import { SLOW_KEEP } from '../src/db/slow-moments.ts';
import { slowRows } from '../src/routes/app.ts';

const NOW = 1_800_000_000_000;
const moment = (over: Record<string, unknown> = {}) => ({ kind: 'request', what: 'GET /api/projects/2', page: '#/p/2/t/394', at: NOW - 5000, total: 20_100.4, server: 100, network: 200, tab: 19_800, ...over });

test('a report keeps checked, clipped rows and names the scheme from the page', () => {
  const rows = slowRows({ device: 'Windows · Edge · app', tab: 'ab12', moments: [moment()] }, 'Cara', 60, NOW);
  assert.deepEqual(rows, [{
    at: NOW - 5000, person: 'Cara', device: 'Windows · Edge · app', tab: 'ab12', kind: 'request', what: 'GET /api/projects/2',
    page: '#/p/2/t/394', project_id: 2, total_ms: 20_100, server_ms: 100, network_ms: 200, tab_ms: 19_800,
  }]);
});

test('malformed, stale, future and unknown moments are dropped; numbers are clamped; room caps the count', () => {
  const rows = slowRows({
    device: 'x\u0000'.repeat(100), tab: 7, moments: [
      moment({ kind: 'nap' }), moment({ total: 'long' }), moment({ at: NOW - 2 * 86_400_000 }), moment({ at: NOW + 3_600_000 }),
      moment({ kind: 'freeze', what: '', page: '#/', server: null, network: -5, total: 1e12, tab: Infinity }),
      moment(), moment(),
    ],
  }, 'Josh', 2, NOW);
  assert.equal(rows.length, 2);
  const [freeze] = rows;
  assert.equal(freeze.device, 'x'.repeat(60));
  assert.equal(freeze.tab, '');
  assert.equal(freeze.project_id, null);
  assert.equal(freeze.server_ms, null);
  assert.equal(freeze.network_ms, 0);
  assert.equal(freeze.total_ms, 10 * 60_000);
  assert.equal(freeze.tab_ms, 0);
  assert.deepEqual(slowRows({ moments: 'no' }, 'Josh', 60, NOW), []);
  assert.deepEqual(slowRows(null, 'Josh', 60, NOW), []);
});

test('the table keeps only the newest SLOW_KEEP rows and lists newest first', () => {
  const store = new Store(':memory:');
  const row = (i: number) => ({ at: NOW + i, person: 'Cara', device: 'd', tab: 't', kind: 'freeze', what: '', page: '#/', project_id: null, total_ms: 2500, server_ms: null, network_ms: 0, tab_ms: 2500 });
  for (let i = 0; i < SLOW_KEEP + 30; i += 10) store.addSlowMoments(Array.from({ length: 10 }, (_, j) => row(i + j)));
  const n = (store.db.prepare('SELECT COUNT(*) AS n FROM slow_moments').get() as { n: number }).n;
  assert.equal(n, SLOW_KEEP);
  const newest = store.slowMoments(0, 3);
  assert.deepEqual(newest.map((r) => r.at), [NOW + SLOW_KEEP + 29, NOW + SLOW_KEEP + 28, NOW + SLOW_KEEP + 27]);
  assert.deepEqual(store.slowMoments(NOW + SLOW_KEEP + 29), [newest[0]]);
});
