import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CacheSampler, dbCold, parseCounters, parseFincore, rates } from '../src/cache-health.ts';
import { Store } from '../src/db.ts';
import { StatusPage } from '../src/status-page.ts';

const root = mkdtempSync(join(tmpdir(), 'cache-health-'));
after(() => rmSync(root, { recursive: true, force: true }));
const GB = 1024 ** 3;

const vm = (k: number) => `pgpgin ${1000 * k}\npgsteal_kswapd ${600 * k}\nworkingset_refault_file ${300 * k}\nthp_fault_fallback ${30 * k}\nother 5\n`;

test('parses /proc/vmstat, the server group and fincore', () => {
  assert.deepEqual(parseCounters(vm(1), 'anon 1\nworkingset_refault_file 77\n'), { kswapd: 600, refault: 300, serverRefault: 77, pgpgin: 1000, thpFallback: 30 });
  assert.equal(parseCounters('pgpgin 1\n'), null);
  assert.deepEqual(parseFincore('60911616 2085335040\n'), { cached: 60911616, size: 2085335040 });
  assert.equal(parseFincore('fincore: cannot open\n'), null);
});

test('rates are per second, and empty after a counter goes backwards or on the first reading', () => {
  const a = parseCounters(vm(1))!,
    b = parseCounters(vm(2))!;
  assert.deepEqual(rates(a, b, 10_000), { kswapd_rate: 60, refault_rate: 30, server_refault_rate: null, pgpgin_rate: 100, thp_fallback_rate: 3 });
  assert.equal(rates(null, b, 10_000).kswapd_rate, null);
  assert.equal(rates(b, a, 10_000).kswapd_rate, null);
});

test('the sampler gives no rates the first time and rates the second', async () => {
  let k = 1;
  const s = new CacheSampler({ dbPath: 'x', vmstat: async () => vm(k++), serverStat: async () => null, fincore: async () => '100 400\n' });
  const first = await s.read(0);
  assert.equal(first.kswapd_rate, null);
  assert.equal(first.db_cached, 100);
  assert.equal((await s.read(10_000)).kswapd_rate, 60);
  const broken = new CacheSampler({
    dbPath: 'x',
    vmstat: async () => {
      throw new Error('no');
    },
    fincore: async () => {
      throw new Error('no');
    },
  });
  assert.deepEqual(await broken.read(0), { db_cached: null, db_size: null, kswapd_rate: null, refault_rate: null, server_refault_rate: null, pgpgin_rate: null, thp_fallback_rate: null });
});

test('the alert needs three cold readings in a row with memory to spare', () => {
  const row = (cached: number, avail = 8 * GB) => ({ db_cached: cached, db_size: 2 * GB, mem_avail: avail });
  const cold = row(0.1 * GB);
  assert.equal(dbCold([cold, cold, cold]), true);
  assert.equal(dbCold([cold, cold]), false);
  assert.equal(dbCold([cold, row(1.5 * GB), cold]), false);
  assert.equal(dbCold([cold, cold, row(0.1 * GB, 2 * GB)]), false, 'the box is short of memory too: not the cache');
  assert.equal(dbCold([cold, cold, { db_cached: null, db_size: null, mem_avail: 8 * GB }]), false);
  assert.equal(dbCold([row(0.5 * GB), row(0.5 * GB), row(0.5 * GB)]), false, 'exactly a quarter is not under it');
});

test('a sample stores the columns, three cold ones fire one event, and the page shows the tile data and a verdict reason', async () => {
  const store = new Store(join(root, 'a.db'));
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  store.createProject('Other', null, josh.id);
  const citadel = store.createProject('Citadel', null, josh.id);
  let now = Date.now();
  const page = new StatusPage({
    store,
    dataDir: root,
    bootAt: now - 1000,
    commit: 'abc',
    ownScheme: () => citadel.id,
    now: () => now,
    home: root,
    unitStates: async () => [],
    mem: async () => ({ total: 16 * GB, avail: 8 * GB }),
    disk: async () => ({ total: 100, free: 50 }),
    cache: async () => ({ db_cached: 0.1 * GB, db_size: 2 * GB, kswapd_rate: 100, refault_rate: 50, server_refault_rate: 5, pgpgin_rate: 2048, thp_fallback_rate: 1 }),
  });
  for (let i = 0; i < 3; i++) {
    await page.sample();
    now += 5 * 60_000;
  }
  const rows = store.hostSamples(0);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].db_size, 2 * GB);
  assert.equal(rows[0].kswapd_rate, 100);
  assert.equal(store.healthEventsSince(['cache-cold'], 0).length, 1);
  await page.sample();
  assert.equal(store.healthEventsSince(['cache-cold'], 0).length, 1, 'one event per spell');
  const data = await page.build({ canSee: () => true, admin: true, key: 'k' });
  assert.equal(data.citadel.host.cache.length > 0, true);
  assert.equal(data.citadel.host.cache[0][1], 5);
  assert.match(data.citadel.verdict.reasons.join('|'), /database fell out of memory/);
});
