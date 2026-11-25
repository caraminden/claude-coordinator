import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { ALERT_MS, FrozenShips, noteFrozen, resetFrozen } from '../src/frozen-ships.ts';
import { landWaits, readQueue, readQueueA } from '../src/waits.ts';

// A ship whose cgroup was frozen (systemctl freeze, 2026-11-24 17:02 PST) is shown as frozen and raises one alert (#1881).
const root = mkdtempSync(join(tmpdir(), 'frozen-ships-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir
const AT = Date.UTC(2026, 10, 24, 19, 0);

/** A fake /proc and cgroup tree: process 4242 is in `land-9.service`, frozen or not. */
function fixture(frozen: boolean) {
  const cg = '/user.slice/user-1000.slice/user@1000.service/land-9.service';
  mkdirSync(join(root, 'proc/4242'), { recursive: true });
  writeFileSync(join(root, 'proc/4242/cgroup'), `0::${cg}\n`);
  mkdirSync(join(root, 'cg', cg), { recursive: true });
  writeFileSync(join(root, 'cg', cg, 'cgroup.events'), `populated 1\nfrozen ${frozen ? 1 : 0}\n`);
  mkdirSync(join(root, 'queue'), { recursive: true });
  writeFileSync(join(root, 'queue/0000000001'), '4242 99\n0\nticket/9-thing\nwaiting\norder\n\n');
  process.env.CITADEL_PROC_DIR = join(root, 'proc');
  process.env.CITADEL_CGROUP_DIR = join(root, 'cg');
}

test('a frozen waiter reads as frozen in the line and its wait, sync and async, and an unfrozen one does not', async () => {
  resetFrozen();
  fixture(false);
  assert.equal((await readQueueA(join(root, 'queue'), 4, () => true))[0].frozen, undefined);
  fixture(true);
  assert.equal(readQueue(join(root, 'queue'), 4, () => true)[0].frozen, undefined, 'the sync reader reads no file: it knows only what an async look found');
  await readQueueA(join(root, 'queue'), 4, () => true);
  const [t] = readQueue(join(root, 'queue'), 4, () => true);
  assert.equal(t.frozen?.unit, 'land-9.service');
  assert.equal(t.frozen?.thaw, 'systemctl --user thaw land-9.service');
  assert.equal((await readQueueA(join(root, 'queue'), 4, () => true))[0].frozen?.since, t.frozen?.since);
  const w = landWaits(
    [t],
    [],
    AT,
    () => null,
    (l) => l,
  ).get('ticket/9-thing')!;
  assert.match(w.chip, /^frozen since /);
  assert.match(w.text, /thaw it with: systemctl --user thaw land-9\.service/);
});

test('frozen over 5 minutes is one alert for the scheme owner and a health event pair; it clears when it thaws', async () => {
  resetFrozen();
  fixture(true);
  const store = new Store(join(root, 'coordinator.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const scheme = store.createProject('Peek Auras', null, josh.id); // not Citadel's: the alert goes to its own owner
  const c = new Contraptions(store, 's'.repeat(40), join(root, 'keys'));
  const mandate = c.register({ name: 'mandate', title: 'Mandate', port: 9101, icon: '/icon.svg', home_scheme: scheme.id, open_paths: '[]', default_model: 'haiku', turn_cap: 200 } as unknown as Parameters<typeof c.register>[0]);
  store.setContraptionUser(mandate.id, josh.id, true, cara.id);
  const calls: { who: string; key: string; title: string | null; from: string }[] = [];
  const ships = new FrozenShips(store, {
    mandate: async (from, person, key, title) => (calls.push({ who: person.name, key, title, from: from.name }), true),
    schemeOf: () => ({ id: scheme.id, name: scheme.name }),
    fallback: () => null,
  });
  const cg = '/user.slice/user-1000.slice/user@1000.service/land-9.service';
  const sight = (at: number) => noteFrozen('ticket/9-thing', cg, at); // what a line read notes
  const T0 = AT;
  sight(T0);
  await ships.tick(T0 + 60_000);
  assert.equal(calls.length, 0, 'frozen a minute: not yet');
  assert.equal(store.healthEventsSince(['ship-frozen'], 0).length, 1, 'the freeze is recorded at once, naming the unit');
  assert.match(store.healthEventsSince(['ship-frozen'], 0)[0].detail, /ticket\/9-thing: land-9\.service frozen since/);
  // The ship stays frozen past the limit: one alert, however many rounds.
  for (const k of [1, 2, 3]) {
    const at = T0 + ALERT_MS + 60_000 * k;
    sight(at);
    await ships.tick(at);
  }
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].who, calls[0].from], ['Josh', 'Peek Auras']);
  assert.match(calls[0].title!, /ticket\/9-thing is frozen: land-9\.service since .*systemctl --user thaw land-9\.service/);
  // It thaws: nothing lists it frozen any more, the item clears and the thaw is recorded.
  await ships.tick(T0 + 3 * ALERT_MS); // nothing has seen it since
  assert.equal(calls.length, 2);
  assert.equal(calls[1].title, null);
  assert.equal(store.healthEventsSince(['ship-thawed'], 0).length, 1);
});
